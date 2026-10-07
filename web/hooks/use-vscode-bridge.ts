'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { vscodeBridge, type ConnectionStatus, type AgentEvent, type SessionInfo } from '@/lib/vscode-bridge'
import { SimulationEvent } from '@/lib/agent-types'
import { unifiedEvent } from '@/lib/unified-events'

interface BridgeHookResult {
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** Events received from VS Code extension, converted to SimulationEvent format */
  pendingEvents: readonly SimulationEvent[]
  /** Call after consuming events to clear the queue */
  consumeEvents: () => void
  /** Whether to show mock data (standalone mode or explicit config) */
  useMockData: boolean
  /** Whether CLAUDE_CODE_DISABLE_1M_CONTEXT=1 is set — caps context window to 200k */
  disable1MContext: boolean
  /** Open a file in the VS Code editor */
  bridgeOpenFile: (filePath: string, line?: number) => void
  /** Known sessions from the extension */
  sessions: SessionInfo[]
  /** Currently selected session ID */
  selectedSessionId: string | null
  /** Select a session to view (does not flush events — call flushSessionEvents after state swap). */
  selectSession: (sessionId: string | null) => void
  /** Flush buffered events for a session into pending. Call from useLayoutEffect after state swap. */
  flushSessionEvents: (sessionId: string, fromIndex?: number) => void
  /** Get the current event count for a session (for save/restore) */
  getSessionEventCount: (sessionId: string) => number
  /** Ref to the currently selected session ID — updated synchronously, not via React state */
  selectedSessionIdRef: React.RefObject<string | null>
  /** Session IDs that have received events while not selected */
  sessionsWithActivity: Set<string>
  /** Remove a session from the list */
  removeSession: (sessionId: string) => void
}

/**
 * Connects the VS Code bridge to the React app.
 * When running standalone, returns useMockData=true and no events.
 * When inside VS Code, receives events and forwards control commands.
 *
 * Supports multi-session: events are buffered per-session so switching
 * sessions replays the correct event history.
 */
export function useVSCodeBridge(): BridgeHookResult {
  const [isVSCode, setIsVSCode] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [useMockData, setUseMockData] = useState(process.env.NEXT_PUBLIC_DEMO !== '0')
  const [disable1MContext, setDisable1MContext] = useState(false)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  const seenRef = useRef(new Set<string>())
  const selectedSessionIdRef = useRef<string | null>(null)
  const [, setEventVersion] = useState(0)

  useEffect(() => {
    const bridge = vscodeBridge
    if (!bridge) return
    const unsubscribers = [
      bridge.onInit(() => { setIsVSCode(true); setUseMockData(false) }),
      bridge.onEvent((event: AgentEvent) => {
        const key = `${event.sessionId}:${event.time}:${event.type}:${JSON.stringify(event.payload)}`
        if (seenRef.current.has(key)) return
        seenRef.current.add(key)
        if (seenRef.current.size > 30000) seenRef.current.delete(seenRef.current.values().next().value!)
        const scoped = unifiedEvent(event)
        pendingEventsRef.current.push({ ...scoped, type: scoped.type as SimulationEvent['type'] })
        setEventVersion(v => v + 1)
      }),
      bridge.onStatus(setConnectionStatus),
      bridge.onConfig(config => {
        if (config.showMockData !== undefined) setUseMockData(config.showMockData)
        if (config.disable1MContext !== undefined) setDisable1MContext(config.disable1MContext)
      }),
      bridge.onSession((type, data) => {
        if (type === 'reset') {
          setSessions([]); pendingEventsRef.current.length = 0; seenRef.current.clear(); return
        }
        if (type === 'list') { setSessions(data as SessionInfo[]); return }
        if (type === 'started') {
          const session = data as SessionInfo
          setSessions(previous => {
            const existing = previous.some(s => s.id === session.id)
            return existing ? previous.map(s => s.id === session.id ? { ...s, ...session } : s) : [...previous, session]
          })
        }
        if (type === 'updated') {
          const update = data as { sessionId: string; label: string }
          setSessions(previous => previous.map(s => s.id === update.sessionId ? { ...s, label: update.label } : s))
        }
        if (type === 'ended') setSessions(previous => previous.map(s => s.id === data ? { ...s, status: 'completed' } : s))
      }),
    ]
    return () => { for (const unsubscribe of unsubscribers) unsubscribe() }
  }, [])

  useEffect(() => {
    if (!vscodeBridge || vscodeBridge.isVSCode) return
    const standalone = process.env.AGENT_FLOW_STANDALONE === '1'
    if (!standalone && (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DEMO !== '0')) return
    const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const es = new EventSource(relayPort ? `http://127.0.0.1:${relayPort}/events` : '/events')
    es.onopen = () => { setConnectionStatus('connected'); setUseMockData(false) }
    es.onmessage = event => { try { window.postMessage(JSON.parse(event.data), window.location.origin) } catch {} }
    es.onerror = () => setConnectionStatus('disconnected')
    return () => es.close()
  }, [])

  const consumeEvents = useCallback(() => { pendingEventsRef.current.length = 0 }, [])
  const bridgeOpenFile = useCallback((filePath: string, line?: number) => vscodeBridge?.openFile(filePath, line), [])
  return {
    isVSCode, connectionStatus, useMockData, disable1MContext, sessions,
    pendingEvents: pendingEventsRef.current, consumeEvents, bridgeOpenFile,
    // A null filter means all agents share the same simulation and timeline.
    selectedSessionId: null, selectedSessionIdRef,
    selectSession: () => {}, flushSessionEvents: () => {}, getSessionEventCount: () => 0,
    sessionsWithActivity: new Set(), removeSession: () => {},
  }
}
