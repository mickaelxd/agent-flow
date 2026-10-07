import type { AgentEvent } from './bridge-types'

export function agentIdentity(sessionId: string, name: string): string {
  return name.startsWith('session:') ? name : `session:${sessionId}:${name}`
}

/** Every reference is scoped, including parent/child links and tool owners. */
export function unifiedEvent(event: AgentEvent): AgentEvent {
  if (!event.sessionId) return event
  const payload = { ...event.payload }
  for (const field of ['name', 'agent', 'parent', 'child', 'from', 'to']) {
    if (typeof payload[field] === 'string') payload[field] = agentIdentity(event.sessionId, payload[field])
  }
  if (event.type === 'agent_spawn' && !payload.displayName) payload.displayName = event.payload.name
  return { ...event, payload }
}
