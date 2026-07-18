// RFC-041 PR4 — WS subscription for the platform memory stream.
//
// /ws/memories carries every memory.* event (candidate.created /
// candidate.promoted / archived / unarchived / superseded / deleted).
// This hook invalidates the canonical react-query keys so the approval
// queue, all-approved tab, by-scope browser, and the inbox pending-count
// badge stay live without manual refetches.
//
// The hook is intentionally permission-agnostic — every logged-in user may
// subscribe; the backend WS upgrade enforces the broader admin gate on
// /ws/memory-distill-jobs but the /ws/memories channel is broadcast to all
// logged-in clients (regular users still see "Memories" sub-tabs).
//
// RFC-152 — thin wrapper over the useWsInvalidation rules table. The old
// `type.startsWith('memory.')` guard becomes an exhaustive per-variant
// table over MemoryWsMessage; unknown/foreign types are ignored by the
// table lookup itself.

import type { QueryKey } from '@tanstack/react-query'
import type { MemoryWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export interface UseMemoryWsOpts {
  /** When false the connection is torn down. Default true. */
  enabled?: boolean
}

export const MEMORY_QUERY_KEYS = {
  pendingCount: ['memories', 'pending-count'] as const,
  candidates: ['memories', 'candidates'] as const,
  all: ['memories', 'all'] as const,
  detail: (id: string) => ['memories', 'detail', id] as const,
  scoped: (scopeType: string, scopeId: string | null) =>
    ['memories', 'scoped', scopeType, scopeId] as const,
}

// Invalidate the broad surface — react-query coalesces refetches so
// multiple invalidates in a single message are cheap.
function broadSurface(): QueryKey[] {
  return [
    MEMORY_QUERY_KEYS.pendingCount,
    MEMORY_QUERY_KEYS.candidates,
    MEMORY_QUERY_KEYS.all,
    ['memories', 'scoped'],
  ]
}

/** Broad surface + the detail key when the message carries a single id. */
function withDetail(memoryId: string): QueryKey[] {
  return [...broadSurface(), MEMORY_QUERY_KEYS.detail(memoryId)]
}

const RULES: WsInvalidationRules<MemoryWsMessage> = {
  'memory.candidate.created': (msg) => withDetail(msg.memory.id),
  'memory.candidate.promoted': (msg) => withDetail(msg.memoryId),
  'memory.archived': (msg) => withDetail(msg.memoryId),
  'memory.unarchived': (msg) => withDetail(msg.memoryId),
  'memory.deleted': (msg) => withDetail(msg.memoryId),
  // RFC-045 in-place edit — useMemoryWs routes any memory event to the full
  // surface; changedFields granularity is a UI concern, not an invalidation
  // concern.
  'memory.updated': (msg) => withDetail(msg.memoryId),
  // superseded carries oldId/newId (no memoryId) → broad surface only.
  'memory.superseded': () => broadSurface(),
}

export function useMemoryWs({ enabled = true }: UseMemoryWsOpts = {}): void {
  useWsInvalidation<MemoryWsMessage>(enabled ? WS_PATHS.memories : null, RULES, undefined, {
    reconcileOnOpen: broadSurface,
  })
}
