import type { TasksListWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TASK_OPERATIONS_QUERY_KEY } from './useTaskOperationsPage'
import { useWebSocket } from './useWebSocket'

const DIRTY_TYPES = new Set<TasksListWsMessage['type']>([
  'task.created',
  'task.status',
  'task.deleted',
  'task.members.changed',
  'lifecycle.alert',
  'lifecycle.alert.resolved',
])

export interface TaskOperationsSyncState {
  dirty: boolean
  connected: boolean
  refresh: () => Promise<void>
}

export function useTaskOperationsSync(): TaskOperationsSyncState {
  const queryClient = useQueryClient()
  const [dirty, setDirty] = useState(false)

  const markDirty = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: TASK_OPERATIONS_QUERY_KEY,
      refetchType: 'none',
    })
    setDirty(true)
  }, [queryClient])

  const connection = useWebSocket({
    path: WS_PATHS.tasksList,
    onMessage: (raw) => {
      if (raw === null || typeof raw !== 'object') return
      const type = (raw as { type?: unknown }).type
      if (typeof type === 'string' && DIRTY_TYPES.has(type as TasksListWsMessage['type'])) {
        markDirty()
      }
    },
  })

  const previousEpoch = useRef(0)
  useEffect(() => {
    if (connection.connectionEpoch > 0 && previousEpoch.current > 0) markDirty()
    previousEpoch.current = connection.connectionEpoch
  }, [connection.connectionEpoch, markDirty])

  const refresh = useCallback(async () => {
    setDirty(false)
    await queryClient.resetQueries({ queryKey: TASK_OPERATIONS_QUERY_KEY })
  }, [queryClient])

  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(() => void refresh(), 15_000)
    return () => window.clearTimeout(timer)
  }, [dirty, refresh])

  useEffect(() => {
    if (connection.connected) return
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(timer)
  }, [connection.connected, refresh])

  return { dirty, connected: connection.connected, refresh }
}
