import type { AgentEvent, SessionInfo } from '../extension/src/protocol'

type Data = Record<string, any>

// The desktop IPC protocol is versioned independently of the public app-server API.
// Keep this adapter isolated; it observes state and never starts/resumes a turn.
export function conversationTurns(state: Data): Data[] {
  const history = state.turnHistory?.history
  if (history) {
    return (history.islands ?? []).flatMap((island: Data) =>
      (island.entries ?? []).map((entry: Data) => history.entitiesByKey[entry.value]).filter(Boolean))
  }
  return state.turns ?? []
}

export function applyDesktopPatches(state: Data, patches: Data[]): Data {
  for (const patch of patches) {
    const keys = patch.path
    if (!Array.isArray(keys) || keys.length === 0 || keys.some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) {
      throw new Error('Unsupported desktop patch path')
    }
    let target: any = state
    for (const key of keys.slice(0, -1)) {
      if (target == null || !Object.hasOwn(target, key)) throw new Error('Desktop patch target missing')
      target = target[key]
    }
    const key = keys[keys.length - 1]
    if (Array.isArray(target)) {
      if (!Number.isInteger(key) || key < 0 || key > target.length) throw new Error('Invalid desktop array index')
      if (patch.op === 'add') target.splice(key, 0, patch.value)
      else if (patch.op === 'remove') target.splice(key, 1)
      else if (patch.op === 'replace') target[key] = patch.value
      else throw new Error('Unsupported desktop patch operation')
    } else if (patch.op === 'remove') delete target[key]
    else if (patch.op === 'add' || patch.op === 'replace') target[key] = patch.value
    else throw new Error('Unsupported desktop patch operation')
  }
  return state
}

export class DesktopProjector {
  readonly sessions = new Map<string, SessionInfo>()
  private seen = new Map<string, Set<string>>()
  private signatures = new Map<string, string>()
  private parents = new Map<string, string>()
  private childLabels = new Map<string, string>()
  constructor(
    private emit: (event: AgentEvent) => void,
    private lifecycle: (type: 'started' | 'ended' | 'updated', id: string, label: string) => void,
    private follow: (id: string, hostId: string) => void,
  ) {}

  project(id: string, hostId: string, state: Data) {
    const turns = conversationTurns(state)
    const latest = turns.at(-1)
    const active = state.threadRuntimeStatus?.type === 'active' || latest?.status === 'inProgress'
    const status = active ? 'active' : 'completed'
    const label = state.agentNickname || this.childLabels.get(id) || state.title || `Codex ${id.slice(0, 8)}`
    const previous = this.sessions.get(id)
    const info: SessionInfo = {
      id, label, status,
      startTime: state.createdAt ?? Date.now(), lastActivityTime: state.updatedAt ?? Date.now(),
    }
    this.sessions.set(id, info)
    const send = (type: AgentEvent['type'], payload: Data) => this.emit({ time: 0, type, payload, sessionId: id })
    const spawnSignature = JSON.stringify([label, state.latestModel, this.parents.get(id), status])
    if (this.signatures.get(id) !== spawnSignature) {
      this.signatures.set(id, spawnSignature)
      send('agent_spawn', {
        name: 'orchestrator', displayName: label, isMain: !this.parents.has(id),
        parent: this.parents.has(id) ? `session:${this.parents.get(id)}:orchestrator` : undefined,
        task: state.title || label, runtime: 'codex', model: state.latestModel,
      })
      this.lifecycle(previous ? (active ? 'started' : 'updated') : 'started', id, label)
    }
    const seen = this.seen.get(id) ?? new Set<string>()
    this.seen.set(id, seen)
    // Historical catch-up is bounded, while newly arriving items stay incremental.
    const items = turns.flatMap(t => t.items ?? []).slice(-800)
    for (const item of items) {
      const key = `${item.id}:${item.status ?? ''}:${item.kind ?? ''}`
      if (seen.has(key)) continue
      // Don't publish partial text repeatedly as duplicate messages.
      if (item.type === 'agentMessage') {
        const done = turns.some(t => t.agentMessageCompletedAtMsById?.[item.id] != null || (t.status !== 'inProgress' && (t.items ?? []).some((i: Data) => i.id === item.id)))
        if (!done) continue
      }
      seen.add(key)
      if (item.type === 'subAgentActivity' && item.agentThreadId) {
        const child = item.agentThreadId
        this.parents.set(child, id)
        this.childLabels.set(child, item.agentPath?.split('/').at(-1) || 'Subagente')
        this.follow(child, hostId)
        if (item.kind === 'started') send('agent_spawn', {
          name: `session:${child}:orchestrator`, displayName: item.agentPath?.split('/').at(-1) || 'Subagente',
          parent: 'orchestrator', runtime: 'codex', task: item.agentPath,
        })
        if (item.kind === 'completed') send('agent_complete', { name: `session:${child}:orchestrator` })
        continue
      }
      let content = ''
      let role = 'assistant'
      if (item.type === 'agentMessage') content = item.text ?? ''
      if (item.type === 'userMessage') {
        content = (item.content ?? []).filter((i: Data) => i.type === 'text').map((i: Data) => i.text).join('\n')
        role = 'user'
      }
      if (item.type === 'reasoning') {
        content = (item.summary ?? []).map((s: unknown) => typeof s === 'string' ? s : (s as Data)?.text ?? '').join('\n')
        role = 'thinking'
      }
      if (content) send('message', { agent: 'orchestrator', role, content: content.slice(0, 12000) })
      const tool = item.type === 'commandExecution' ? 'Bash'
        : item.type === 'mcpToolCall' ? item.tool
        : item.type === 'webSearch' ? 'WebSearch'
        : item.type === 'fileChange' ? 'Edit' : null
      if (tool) {
        const startKey = `start:${item.id}`
        if (!seen.has(startKey)) {
          seen.add(startKey)
          send('tool_call_start', { agent: 'orchestrator', tool, callId: item.id,
            args: String(item.command ?? item.query ?? JSON.stringify(item.arguments ?? item.changes ?? '')).slice(0, 2000) })
        }
        if (item.status && item.status !== 'inProgress' || item.type === 'webSearch') {
          send('tool_call_end', { agent: 'orchestrator', tool, callId: item.id,
            result: String(item.aggregatedOutput ?? JSON.stringify(item.result ?? item.results ?? 'Done')).slice(0, 12000),
            isError: item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0) })
        }
      }
    }
    const usage = state.latestTokenUsageInfo
    const usageKey = JSON.stringify(usage)
    if (usage && this.signatures.get(`tokens:${id}`) !== usageKey) {
      this.signatures.set(`tokens:${id}`, usageKey)
      send('context_update', { agent: 'orchestrator', tokens: usage.last?.totalTokens ?? 0, tokensMax: usage.modelContextWindow })
    }
    if (!active && (previous?.status !== 'completed' || !previous)) {
      send('agent_complete', { name: 'orchestrator' })
      this.lifecycle('ended', id, label)
    }
  }
}
