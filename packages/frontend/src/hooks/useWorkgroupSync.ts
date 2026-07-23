// RFC-225 — /ws/workgroups invalidation + focused-editor frame projection.

import { useEffect } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { WS_PATHS, type WorkgroupsWsMessage } from '@agent-workflow/shared'
import type { WebSocketConnectionState } from './useWebSocket'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export type WorkgroupSyncFrame = Extract<
  WorkgroupsWsMessage,
  { type: 'workgroup.updated' | 'workgroup.deleted' }
>

export interface WorkgroupSyncOptions {
  workgroupId: string | null
  currentVersion: number | null
  inFlightMutationId?: string | null
  onFrame?: (frame: WorkgroupSyncFrame) => void
  enabled?: boolean
}

const RULES: WsInvalidationRules<WorkgroupsWsMessage, WorkgroupSyncOptions> = {
  'workgroup.created': () => [['workgroups']],
  'workgroup.updated': (message, context) => {
    const keys: QueryKey[] = [['workgroups']]
    if (typeof context.workgroupId === 'string' && message.workgroupId === context.workgroupId) {
      context.onFrame?.(message)
      const ownEcho =
        context.inFlightMutationId !== null &&
        context.inFlightMutationId !== undefined &&
        message.clientMutationId === context.inFlightMutationId
      const newer = context.currentVersion === null || message.version > context.currentVersion
      if (!ownEcho && newer) keys.push(['workgroups', context.workgroupId])
    }
    return keys
  },
  'workgroup.deleted': (message, context) => {
    if (message.workgroupId === context.workgroupId) context.onFrame?.(message)
    return [['workgroups']]
  },
  'workgroup.acl.updated': () => [['workgroups']],
}

export function useWorkgroupSync(options: WorkgroupSyncOptions): WebSocketConnectionState {
  const queryClient = useQueryClient()
  const connection = useWsInvalidation<WorkgroupsWsMessage, WorkgroupSyncOptions>(
    (options.enabled ?? true) ? WS_PATHS.workgroups : null,
    RULES,
    options,
  )

  useEffect(() => {
    if (connection.connectionEpoch === 0 || !(options.enabled ?? true)) return
    if (typeof options.workgroupId === 'string') {
      void queryClient.invalidateQueries({ queryKey: ['workgroups', options.workgroupId] })
    }
    void queryClient.invalidateQueries({ queryKey: ['workgroups'] })
  }, [connection.connectionEpoch, options.enabled, options.workgroupId, queryClient])

  return connection
}
