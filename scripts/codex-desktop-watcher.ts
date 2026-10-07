import * as net from 'net'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { AgentEvent } from '../extension/src/protocol'
import { DesktopProjector, applyDesktopPatches } from './codex-desktop-projector'

type Data = Record<string, any>
const MAX_FRAME = 48 * 1024 * 1024
export function encodeDesktopFrame(message: Data): Buffer {
  const body = Buffer.from(JSON.stringify(message))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

/** Read-only desktop follower. Only initialize and following broadcasts are sent.
 * No thread/start, resume, turn/start, interrupt or approval commands. */
export class CodexDesktopWatcher {
  private socket: net.Socket | null = null
  private input = Buffer.alloc(0)
  private clientId = 'initializing-client'
  private subscribed = new Set<string>()
  private states = new Map<string, { revision: number; state: Data }>()
  private reconnect: ReturnType<typeof setTimeout> | null = null
  private scan: ReturnType<typeof setInterval> | null = null
  private disposed = false
  readonly projector: DesktopProjector
  constructor(private options: {
    emit: (event: AgentEvent) => void
    lifecycle: (type: 'started' | 'ended' | 'updated', id: string, label: string) => void
    status: (connected: boolean) => void
    home?: string
    seedFile?: string
  }) {
    this.projector = new DesktopProjector(options.emit, options.lifecycle, (id, host) => this.follow(id, host))
  }
  private get home() { return this.options.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex') }
  start() { this.connect(); this.scan = setInterval(() => this.discover(), 15000) }
  private connect() {
    if (this.disposed) return
    const socketPath = process.env.AGENT_FLOW_DESKTOP_SOCKET ?? path.join(this.home, 'ipc', 'ipc.sock')
    // Connect only to an existing private socket; never create a router or alter permissions.
    try {
      const stat = fs.lstatSync(socketPath)
      if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unavailable desktop socket')
    } catch { this.scheduleReconnect(); return }
    const socket = net.createConnection(socketPath)
    this.socket = socket
    socket.on('connect', () => this.send({ type: 'request', requestId: randomUUID(), sourceClientId: this.clientId,
      version: 0, method: 'initialize', params: { clientType: 'agent-flow-monitor' } }))
    socket.on('data', chunk => {
      this.input = Buffer.concat([this.input, chunk])
      while (this.input.length >= 4) {
        const length = this.input.readUInt32LE(0)
        if (length === 0 || length > MAX_FRAME) { socket.destroy(); return }
        if (this.input.length < length + 4) return
        const body = this.input.subarray(4, length + 4)
        this.input = this.input.subarray(length + 4)
        try { this.handle(JSON.parse(body.toString('utf8'))) } catch { socket.destroy(); return }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null; this.input = Buffer.alloc(0); this.clientId = 'initializing-client'; this.subscribed.clear()
      this.options.status(false); this.scheduleReconnect()
    })
  }
  private scheduleReconnect() {
    if (this.disposed || this.reconnect) return
    this.reconnect = setTimeout(() => { this.reconnect = null; this.connect() }, 3000)
  }
  private send(message: Data) { if (this.socket?.writable) this.socket.write(encodeDesktopFrame(message)) }
  private follow(id: string, hostId: string, force = false) {
    if (this.clientId === 'initializing-client' || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return
    const key = `${hostId}:${id}`
    if (!force && this.subscribed.has(key)) return
    this.subscribed.add(key)
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId, version: 1,
      params: { conversationId: id, hostId, following: true } })
  }
  private discover() {
    if (this.clientId === 'initializing-client') return
    // Optional private seed inventory exported from list_threads. Contains IDs only.
    const file = this.options.seedFile ?? process.env.AGENT_FLOW_DESKTOP_SESSIONS
    if (file) {
      try { for (const s of JSON.parse(fs.readFileSync(file, 'utf8'))) this.follow(s.id, s.hostId ?? 'durable') } catch {}
    }
    try {
      const global = JSON.parse(fs.readFileSync(path.join(this.home, '.codex-global-state.json'), 'utf8'))
      const recent = Date.now() - 3 * 86400000
      for (const id of global['projectless-thread-ids'] ?? []) {
        if (parseInt(id.replaceAll('-', '').slice(0, 12), 16) < recent) continue
        this.follow(id, 'local'); this.follow(id, 'durable')
      }
    } catch {}
  }
  private handle(message: Data) {
    if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }); return
    }
    if (message.type === 'response' && message.method === 'initialize' && message.resultType === 'success') {
      this.clientId = message.result.clientId; this.options.status(true); this.discover(); return
    }
    if (message.type !== 'broadcast' || message.sourceClientId === this.clientId) return
    const p = message.params
    if (!p) return
    if (message.method === 'thread-stream-following-changed' && p.following) {
      this.follow(p.conversationId, p.hostId); return
    }
    if (message.method === 'thread-queued-followups-changed') {
      this.follow(p.conversationId, p.hostId); return
    }
    if (message.method === 'thread-stream-following-status-requested') {
      for (const key of this.subscribed) {
        const separator = key.indexOf(':'); this.follow(key.slice(separator + 1), key.slice(0, separator), true)
      }
      return
    }
    if (message.method !== 'thread-stream-state-changed') return
    if (message.version !== 11) { this.options.status(false); return }
    const { conversationId: id, hostId, change } = p
    const key = `${hostId}:${id}`
    let saved = this.states.get(key)
    if (change?.type === 'snapshot') {
      saved = { revision: change.revision, state: change.conversationState }
      this.states.set(key, saved)
    } else if (change?.type === 'patches') {
      if (!saved || saved.revision !== change.baseRevision) { this.follow(id, hostId, true); return }
      try { applyDesktopPatches(saved.state, change.patches); saved.revision = change.revision }
      catch { this.states.delete(key); this.follow(id, hostId, true); return }
    } else return
    if (saved) this.projector.project(id, hostId, saved.state)
    this.follow(id, hostId)
  }
  getSessions() { return [...this.projector.sessions.values()] }
  hasSession(id: string) { return this.projector.sessions.has(id) }
  dispose() {
    this.disposed = true
    if (this.reconnect) clearTimeout(this.reconnect)
    if (this.scan) clearInterval(this.scan)
    this.socket?.destroy(); this.socket = null
  }
}
