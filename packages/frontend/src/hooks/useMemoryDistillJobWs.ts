// RFC-041 PR4 — admin-only WS subscription for distill-job lifecycle.
//
// /ws/memory-distill-jobs is admin-only (backend WS upgrade enforces it).
// The hook is safe to mount unconditionally for non-admins because we
// short-circuit on `enabled=false` — callers gate it on
// usePermission('memory:approve').
//
// Events drive the Distill Jobs table; for `distill.done` we additionally
// invalidate the memory candidate queries so new candidates appear in the
// approval queue without a manual refresh.
//
// RFC-152 — thin wrapper over the useWsInvalidation rules table (the old
// `type.startsWith('distill.')` guard becomes the exhaustive table).

import type { QueryKey } from '@tanstack/react-query'
import type { MemoryDistillJobWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'
import { MEMORY_QUERY_KEYS } from './useMemoryWs'

export interface UseMemoryDistillJobWsOpts {
  enabled?: boolean
}

export const DISTILL_JOB_QUERY_KEYS = {
  list: ['memory-distill-jobs', 'list'] as const,
  detail: (id: string) => ['memory-distill-jobs', 'detail', id] as const,
}

function jobSurface(jobId: string): QueryKey[] {
  return [DISTILL_JOB_QUERY_KEYS.list, DISTILL_JOB_QUERY_KEYS.detail(jobId)]
}

const RULES: WsInvalidationRules<MemoryDistillJobWsMessage> = {
  'distill.queued': (msg) => jobSurface(msg.jobId),
  'distill.started': (msg) => jobSurface(msg.jobId),
  // distill.done means a fresh candidate row likely appeared.
  'distill.done': (msg) => [
    ...jobSurface(msg.jobId),
    MEMORY_QUERY_KEYS.pendingCount,
    MEMORY_QUERY_KEYS.candidates,
  ],
  'distill.failed': (msg) => jobSurface(msg.jobId),
}

export function useMemoryDistillJobWs({ enabled = true }: UseMemoryDistillJobWsOpts = {}): void {
  useWsInvalidation<MemoryDistillJobWsMessage>(
    enabled ? WS_PATHS.memoryDistillJobs : null,
    RULES,
    undefined,
    {
      reconcileOnOpen: () => [
        ['memory-distill-jobs'],
        MEMORY_QUERY_KEYS.pendingCount,
        MEMORY_QUERY_KEYS.candidates,
      ],
    },
  )
}
