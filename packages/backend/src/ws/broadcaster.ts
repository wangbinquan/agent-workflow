// Process-local pub/sub for WebSocket fan-out. Services call
// `broadcast(channel, message)`; the WS server adapter subscribes a callback
// per connected client. Synchronous + best-effort: a slow consumer doesn't
// block other consumers. A single daemon process means no cross-process
// bus is needed.

import { createLogger } from '@/util/log'

const log = createLogger('ws.broadcaster')

export type ChannelKey = string

type Listener<M, C> = (msg: M, context: C | undefined) => void

class TypedBroadcaster<M, C = never> {
  private subs = new Map<ChannelKey, Set<Listener<M, C>>>()

  subscribe(channel: ChannelKey, listener: Listener<M, C>): () => void {
    let set = this.subs.get(channel)
    if (set === undefined) {
      set = new Set()
      this.subs.set(channel, set)
    }
    set.add(listener)
    return () => {
      const s = this.subs.get(channel)
      if (s === undefined) return
      s.delete(listener)
      if (s.size === 0) this.subs.delete(channel)
    }
  }

  broadcast(channel: ChannelKey, msg: M, context?: C): void {
    const set = this.subs.get(channel)
    if (set === undefined) return
    for (const listener of set) {
      try {
        listener(msg, context)
      } catch (err) {
        log.warn('listener threw', {
          channel,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /** Test helper. */
  subscriberCount(channel: ChannelKey): number {
    return this.subs.get(channel)?.size ?? 0
  }

  /** Test helper. */
  reset(): void {
    this.subs.clear()
  }
}

// One broadcaster per logical channel namespace; each has its own message
// type. Each channel name is stored as a string with the path prefix baked
// in to avoid taskId/workflowId collisions.

export const TASK_CHANNEL = (taskId: string): ChannelKey => `task:${taskId}`
export const TASKS_LIST_CHANNEL: ChannelKey = 'tasks-list'
export const WORKFLOWS_CHANNEL: ChannelKey = 'workflows'
/** RFC-033: per-batch progress channel for `/repos` batch import. */
export const REPO_IMPORT_CHANNEL = (batchId: string): ChannelKey => `repo-import:${batchId}`
/** RFC-041: platform-wide memory candidate / promotion stream. */
export const MEMORY_CHANNEL: ChannelKey = 'memories'
/** RFC-041: admin-only distill queue monitor. */
export const MEMORY_DISTILL_JOB_CHANNEL: ChannelKey = 'memory-distill-jobs'
export const SCHEDULED_TASK_CHANNEL: ChannelKey = 'scheduled-tasks' // RFC-159

import type {
  MemoryDistillJobWsMessage,
  ScheduledTaskWsMessage,
  MemoryWsMessage,
  RepoImportWsMessage,
  TaskWsMessage,
  TasksListWsMessage,
  WorkflowsWsMessage,
} from '@agent-workflow/shared'

/**
 * Process-local authorization snapshot for a deleted workflow. This context is
 * delivered beside the shared WS message and is never serialized to clients.
 * The delete service captures it in the same transaction as the deleted row so
 * a cold WebSocket connection can still be gated after that row is gone.
 */
export interface WorkflowDeletedAudienceContext {
  kind: 'workflow.deleted-audience'
  workflowId: string
  visibility: 'public' | 'private'
  ownerUserId: string | null
  grantedUserIds: ReadonlySet<string>
}

export type WorkflowsBroadcastContext = WorkflowDeletedAudienceContext

export const taskBroadcaster = new TypedBroadcaster<TaskWsMessage>()
export const tasksListBroadcaster = new TypedBroadcaster<TasksListWsMessage>()
export const workflowsBroadcaster = new TypedBroadcaster<
  WorkflowsWsMessage,
  WorkflowsBroadcastContext
>()
export const repoImportsBroadcaster = new TypedBroadcaster<RepoImportWsMessage>()
export const memoryBroadcaster = new TypedBroadcaster<MemoryWsMessage>()
export const memoryDistillJobBroadcaster = new TypedBroadcaster<MemoryDistillJobWsMessage>()
export const scheduledTaskBroadcaster = new TypedBroadcaster<ScheduledTaskWsMessage>() // RFC-159

/** Reset all broadcasters — only used in tests between cases. */
export function resetBroadcastersForTests(): void {
  taskBroadcaster.reset()
  tasksListBroadcaster.reset()
  workflowsBroadcaster.reset()
  repoImportsBroadcaster.reset()
  memoryBroadcaster.reset()
  memoryDistillJobBroadcaster.reset()
}
