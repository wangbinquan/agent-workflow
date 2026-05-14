// Subscribe to /ws/tasks for instant list refresh. Replaces the 4s polling
// loop on the Tasks page once a WS connection is established; the polling
// fallback stays in place at a longer interval (15s) for the case where
// the daemon WS subsystem is temporarily unavailable.

import { useQueryClient } from '@tanstack/react-query'
import type { TasksListWsMessage } from '@agent-workflow/shared'
import { useWebSocket } from './useWebSocket'

export function useTasksSync(enabled: boolean = true): void {
  const qc = useQueryClient()
  useWebSocket({
    path: '/ws/tasks',
    enabled,
    onMessage: (raw) => {
      const msg = raw as TasksListWsMessage
      if (
        msg.type === 'task.created' ||
        msg.type === 'task.status' ||
        msg.type === 'task.deleted'
      ) {
        void qc.invalidateQueries({ queryKey: ['tasks'] })
      }
    },
  })
}
