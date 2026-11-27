// RFC-616 §5.4 — recording what people do.
//
// The route registry calls `record` after a route that declared `observe`
// returned successfully. Recording must never get in the way of the operation
// it observes: the registry swallows a rejection, and this recorder does not
// write while the database is not open for writes.
//
// `session` operations (opening a review, opening a clarify form) are polled by
// the page every few seconds. Repeats within 30 minutes belong to one record,
// whose last-seen time moves at most once a minute; a small in-process table of
// recent writes spares even the lookup in between. The table is only a
// shortcut: with several daemon instances each keeps its own and the worst
// case is a few extra updates of the same row.

import {
  PROCESS_OPERATION_SESSION_MS,
  PROCESS_OPERATION_TOUCH_MS,
  type ProcessOperationAction,
  type ProcessOperationSubjectKind,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { OperationStore } from './ports/operationStore'

export interface OperationRecordInput {
  readonly action: ProcessOperationAction
  readonly subjectKind: ProcessOperationSubjectKind
  readonly subjectId: string
  readonly mode: 'session' | 'each'
  readonly actorUserId: string
  readonly transport: 'http' | 'mcp'
  readonly at: number
}

export interface OperationRecorder {
  record(input: OperationRecordInput): Promise<void>
}

/** Recent `session` writes remembered in process. */
export const OPERATION_RECENT_LIMIT = 4_096

export function createOperationRecorder(deps: {
  readonly store: OperationStore
  /** false while the database must not be written (startup, maintenance, shutdown). */
  readonly writable?: () => boolean
}): OperationRecorder {
  const writable = deps.writable ?? (() => true)
  // Insertion-ordered: the oldest entry is the first key.
  const recent = new Map<string, { id: string; lastAt: number }>()
  const remember = (key: string, entry: { id: string; lastAt: number }) => {
    recent.delete(key)
    recent.set(key, entry)
    if (recent.size > OPERATION_RECENT_LIMIT) recent.delete(recent.keys().next().value!)
  }

  return {
    async record(input) {
      if (!writable()) return
      const key = {
        action: input.action,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        actorUserId: input.actorUserId,
      }
      if (input.mode === 'each') {
        await deps.store.insert({ ...key, id: ulid(), transport: input.transport, at: input.at })
        return
      }
      const cacheKey = `${key.action}\u0000${key.subjectKind}\u0000${key.subjectId}\u0000${key.actorUserId}`
      const known = recent.get(cacheKey)
      if (known !== undefined && input.at - known.lastAt < PROCESS_OPERATION_TOUCH_MS) return
      const latest = known ?? (await deps.store.latest(key))
      if (latest !== null && input.at - latest.lastAt <= PROCESS_OPERATION_SESSION_MS) {
        if (input.at - latest.lastAt >= PROCESS_OPERATION_TOUCH_MS) {
          await deps.store.touch(latest.id, input.at)
          remember(cacheKey, { id: latest.id, lastAt: input.at })
        } else {
          remember(cacheKey, latest)
        }
        return
      }
      const id = ulid()
      await deps.store.insert({ ...key, id, transport: input.transport, at: input.at })
      remember(cacheKey, { id, lastAt: input.at })
    },
  }
}
