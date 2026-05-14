// Generic JSON-WebSocket subscription hook.
//
// Reconnects with exponential-backoff up to 30s while the component is
// mounted. Token + baseUrl are read from the auth store on each connect so
// re-login refreshes the connection. Messages are routed to the listener
// after JSON-parse; non-JSON frames are silently dropped.

import { useEffect, useRef } from 'react'
import { getBaseUrl, getToken } from '@/stores/auth'

type Listener = (msg: unknown) => void

export interface UseWebSocketOptions {
  /** Path on the daemon, e.g. `/ws/workflows` or `/ws/tasks/01XYZ`. */
  path: string
  /** Receives every JSON message. */
  onMessage: Listener
  /** When false the connection is torn down (useful when no taskId yet). */
  enabled?: boolean
}

const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000

export function useWebSocket({ path, onMessage, enabled = true }: UseWebSocketOptions): void {
  // Latest-listener ref so we don't reconnect every render when the caller
  // passes an inline arrow function.
  const listenerRef = useRef<Listener>(onMessage)
  useEffect(() => {
    listenerRef.current = onMessage
  }, [onMessage])

  useEffect(() => {
    if (!enabled) return
    let backoff = BASE_BACKOFF_MS
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    function connect() {
      if (stopped) return
      const token = getToken()
      if (token === null) {
        // No token → don't churn; we'll retry once the user logs in.
        reconnectTimer = setTimeout(connect, 2000)
        return
      }
      const url = wsUrl(path, token)
      try {
        socket = new WebSocket(url)
      } catch {
        scheduleReconnect()
        return
      }
      socket.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(String(e.data))
          listenerRef.current(msg)
        } catch {
          /* ignore non-JSON frames */
        }
      })
      socket.addEventListener('open', () => {
        backoff = BASE_BACKOFF_MS
      })
      socket.addEventListener('close', () => {
        socket = null
        scheduleReconnect()
      })
      socket.addEventListener('error', () => {
        // The close handler will fire next and reschedule.
      })
    }

    function scheduleReconnect() {
      if (stopped) return
      const wait = Math.min(backoff, MAX_BACKOFF_MS)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      reconnectTimer = setTimeout(connect, wait)
    }

    connect()
    return () => {
      stopped = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [path, enabled])
}

function wsUrl(path: string, token: string): string {
  const base = getBaseUrl()
  const u = new URL(path, base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.searchParams.set('token', token)
  return u.toString()
}
