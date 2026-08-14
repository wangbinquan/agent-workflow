// RFC-303 — task-owned source termination snapshot, monotonic fence, and stop cause.
// Domain-only: integration may depend on this public vocabulary, but this file
// must never import webhook persistence or provider adapters.
import type { TaskStatus } from '@agent-workflow/shared'

export type SourceTerminationFence = 'closed' | 'merged'

export type SourceTerminationSnapshot = Readonly<{
  binding: string
  launchRevision: number
  fence: SourceTerminationFence | null
  effectRevision: number | null
}>

export type WebhookTerminalCause = Readonly<{
  terminal: SourceTerminationFence
  deliveryId: string
  streamRevision: number
}>

export type TaskStopCause =
  | Readonly<{ kind: 'user' }>
  | Readonly<{ kind: 'daemon-shutdown' }>
  | Readonly<{
      kind: 'parent-cascade'
      parentTaskId: string
      rootCause?: WebhookTerminalCause
    }>
  | Readonly<{
      kind: 'webhook-terminal'
      terminal: SourceTerminationFence
      deliveryId: string
      streamRevision: number
    }>

export type TaskStopProjection = Readonly<{
  code:
    | 'canceled-by-user'
    | 'daemon-shutdown'
    | 'canceled-by-parent-cascade'
    | 'webhook-mr-closed'
    | 'webhook-mr-merged'
  summary: string
}>

export function taskStopProjection(cause: TaskStopCause): TaskStopProjection {
  switch (cause.kind) {
    case 'user':
      return { code: 'canceled-by-user', summary: 'canceled by user' }
    case 'daemon-shutdown':
      return { code: 'daemon-shutdown', summary: 'interrupted by daemon shutdown' }
    case 'parent-cascade':
      return { code: 'canceled-by-parent-cascade', summary: 'canceled by parent task' }
    case 'webhook-terminal':
      return cause.terminal === 'closed'
        ? { code: 'webhook-mr-closed', summary: 'MR/PR 已关闭，任务已停止' }
        : { code: 'webhook-mr-merged', summary: 'MR/PR 已合入，任务已停止' }
  }
}

const CANCELABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
])

export type SourceTerminationTargetDisposition = 'cancel' | 'already-terminal'

export function sourceTerminationTargetDisposition(
  status: TaskStatus,
): SourceTerminationTargetDisposition {
  return CANCELABLE_STATUSES.has(status) ? 'cancel' : 'already-terminal'
}

export function isTaskBeforeSourceEffect(
  snapshot: Pick<SourceTerminationSnapshot, 'launchRevision'>,
  effectRevision: number,
): boolean {
  return snapshot.launchRevision < effectRevision
}

export function applySourceTerminationFence(
  snapshot: SourceTerminationSnapshot,
  terminal: SourceTerminationFence,
  effectRevision: number,
): SourceTerminationSnapshot {
  if (!isTaskBeforeSourceEffect(snapshot, effectRevision)) return snapshot
  if ((snapshot.effectRevision ?? -1) >= effectRevision) return snapshot
  const fence = snapshot.fence === 'merged' || terminal === 'merged' ? 'merged' : 'closed'
  return { ...snapshot, fence, effectRevision }
}

export function clearClosedSourceTerminationFence(
  snapshot: SourceTerminationSnapshot,
  effectRevision: number,
): SourceTerminationSnapshot {
  if (!isTaskBeforeSourceEffect(snapshot, effectRevision)) return snapshot
  if ((snapshot.effectRevision ?? -1) >= effectRevision) return snapshot
  if (snapshot.fence !== 'closed') return { ...snapshot, effectRevision }
  return { ...snapshot, fence: null, effectRevision }
}

export function sourceTerminationRevivalError(
  fence: SourceTerminationFence | null,
): 'task-source-terminal-closed' | 'task-source-terminal-merged' | null {
  if (fence === 'closed') return 'task-source-terminal-closed'
  if (fence === 'merged') return 'task-source-terminal-merged'
  return null
}

export function inheritSourceTerminationSnapshot(
  parent: SourceTerminationSnapshot | null,
): SourceTerminationSnapshot | null {
  return parent === null ? null : { ...parent }
}
