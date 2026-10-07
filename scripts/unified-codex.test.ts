import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DesktopProjector, applyDesktopPatches, conversationTurns } from './codex-desktop-projector'
import { unifiedEvent } from '../web/lib/unified-events'
import { initialRootPosition } from '../web/lib/unified-layout'
import type { AgentEvent } from '../extension/src/protocol'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexDesktopWatcher, encodeDesktopFrame } from './codex-desktop-watcher'

test('independent orchestrators and parent links cannot collide', () => {
  const a = unifiedEvent({ time: 0, type: 'agent_spawn', sessionId: 'a', payload: { name: 'orchestrator', parent: 'worker' } })
  const b = unifiedEvent({ time: 0, type: 'agent_spawn', sessionId: 'b', payload: { name: 'orchestrator', parent: 'worker' } })
  assert.notEqual(a.payload.name, b.payload.name)
  assert.equal(a.payload.parent, 'session:a:worker')
  const cross = unifiedEvent({ time: 0, type: 'agent_spawn', sessionId: 'child', payload: { name: 'orchestrator', parent: 'session:a:orchestrator' } })
  assert.equal(cross.payload.parent, a.payload.name)
  assert.equal(unifiedEvent(a).payload.name, a.payload.name)
})

test('ten session roots start separated without exploding the camera bounds', () => {
  const roots = Array.from({ length: 10 }, (_, i) => initialRootPosition(i))
  for (let i = 0; i < roots.length; i++) {
    assert.ok(Math.hypot(roots[i].x, roots[i].y) < 2000)
    for (let j = i + 1; j < roots.length; j++) assert.ok(Math.hypot(roots[i].x - roots[j].x, roots[i].y - roots[j].y) > 500)
  }
})

test('canonical island ordering and desktop patches preserve turn order', () => {
  const state = { turnHistory: { history: { islands: [{ entries: [{ value: 'b' }, { value: 'a' }] }], entitiesByKey: { a: { items: [] }, b: { items: [{ id: 'one' }] } } } } }
  assert.equal(conversationTurns(state)[0].items[0].id, 'one')
  applyDesktopPatches(state, [{ op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'b', 'items', 1], value: { id: 'two' } }])
  assert.equal(conversationTurns(state)[0].items[1].id, 'two')
  assert.throws(() => applyDesktopPatches(state, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]))
  assert.throws(() => applyDesktopPatches(state, [{ op: 'replace', path: ['missing', 'field'], value: true }]))
})

test('snapshot catch-up, tools, child discovery and repeated snapshots are incremental', () => {
  const events: AgentEvent[] = [], follows: string[] = [], lifecycle: string[] = []
  const projector = new DesktopProjector(e => events.push(e), t => lifecycle.push(t), id => follows.push(id))
  const state = {
    title: 'MAD', latestModel: 'chosen-model', threadRuntimeStatus: { type: 'active' },
    turns: [{ status: 'inProgress', items: [
      { id: 'tool', type: 'commandExecution', command: 'test', status: 'inProgress' },
      { id: 'child', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-id', agentPath: '/root/custos' },
    ] }],
  }
  projector.project('mad', 'durable', state)
  assert.equal(events[0].payload.runtime, 'codex')
  assert.equal(events[0].payload.model, 'chosen-model')
  assert.equal(events[0].payload.displayName, 'MAD')
  assert.deepEqual(follows, ['child-id'])
  assert.equal(events.filter(e => e.type === 'tool_call_start').length, 1)
  projector.project('mad', 'durable', state)
  assert.equal(events.filter(e => e.type === 'tool_call_start').length, 1)
  state.turns[0].items[0].status = 'completed'
  projector.project('mad', 'durable', state)
  assert.equal(events.filter(e => e.type === 'tool_call_end').length, 1)
  projector.project('child-id', 'durable', { title: 'Custos', turns: [] })
  const child = events.find(e => e.type === 'agent_spawn' && e.sessionId === 'child-id')!
  assert.equal(child.payload.parent, 'session:mad:orchestrator')
  assert.equal(projector.sessions.get('mad')?.status, 'active')
})

test('idle transition is reported once and reconnect does not duplicate tool results', () => {
  const events: AgentEvent[] = [], lifecycle: string[] = []
  const projector = new DesktopProjector(e => events.push(e), type => lifecycle.push(type), () => {})
  const state = { title: 'MAD', threadRuntimeStatus: { type: 'active' }, turns: [{ status: 'inProgress', items: [{ id: 'tool', type: 'commandExecution', status: 'completed' }] }] }
  projector.project('mad', 'durable', state)
  state.threadRuntimeStatus.type = 'idle'; state.turns[0].status = 'completed'
  projector.project('mad', 'durable', state)
  projector.project('mad', 'durable', structuredClone(state))
  assert.equal(projector.sessions.get('mad')?.status, 'completed')
  assert.equal(lifecycle.filter(t => t === 'ended').length, 1)
  assert.equal(events.filter(e => e.type === 'tool_call_end').length, 1)
})

test('desktop follower receives fragmented snapshots, updates and requests catch-up after a revision gap', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-ipc-'))
  fs.mkdirSync(path.join(home, 'ipc'))
  const id = '00000000-0000-7000-8000-000000000001'
  const seeds = path.join(home, 'sessions.json')
  fs.writeFileSync(seeds, JSON.stringify([{ id, hostId: 'durable' }]))
  const commands: string[] = []
  let following = 0
  let socket: net.Socket | undefined
  const server = net.createServer(client => {
    socket = client
    let buffer = Buffer.alloc(0)
    const publish = (change: object) => client.write(encodeDesktopFrame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'desktop', version: 11, params: { conversationId: id, hostId: 'durable', change } }))
    client.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0)
        if (buffer.length < length + 4) return
        const message = JSON.parse(buffer.subarray(4, length + 4).toString())
        buffer = buffer.subarray(length + 4)
        commands.push(message.method)
        if (message.method === 'initialize') client.write(encodeDesktopFrame({ type: 'response', method: 'initialize', resultType: 'success', requestId: message.requestId, result: { clientId: 'monitor' } }))
        else if (message.method === 'thread-stream-following-changed') {
          following++
          if (following === 1) {
            const frame = encodeDesktopFrame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'desktop', version: 11, params: { conversationId: id, hostId: 'durable', change: { type: 'snapshot', revision: 1, conversationState: { title: 'MAD', threadRuntimeStatus: { type: 'active' }, turns: [] } } } })
            client.write(frame.subarray(0, 2)); client.write(frame.subarray(2))
            publish({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['title'], value: 'MAD live' }] })
            publish({ type: 'patches', baseRevision: 99, revision: 100, patches: [] })
          } else publish({ type: 'snapshot', revision: 100, conversationState: { title: 'MAD caught up', threadRuntimeStatus: { type: 'active' }, turns: [] } })
        }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path.join(home, 'ipc', 'ipc.sock'), resolve))
  const events: AgentEvent[] = []
  let finish: () => void = () => {}
  const finished = new Promise<void>(resolve => { finish = resolve })
  const watcher = new CodexDesktopWatcher({ home, seedFile: seeds, emit: event => {
    events.push(event)
    if (event.payload.displayName === 'MAD caught up') finish()
  }, lifecycle: () => {}, status: () => {} })
  t.after(() => { watcher.dispose(); socket?.destroy(); server.close(); fs.rmSync(home, { recursive: true, force: true }) })
  watcher.start()
  let deadline: ReturnType<typeof setTimeout>
  try { await Promise.race([finished, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Desktop test timed out')), 3000) })]) }
  finally { clearTimeout(deadline!) }
  assert.equal(watcher.getSessions()[0].label, 'MAD caught up')
  assert.ok(events.some(e => e.payload.displayName === 'MAD live'))
  assert.equal(following, 2)
  assert.ok(commands.every(m => m === 'initialize' || m === 'thread-stream-following-changed'))
})
