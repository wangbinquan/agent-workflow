// Process-local pub/sub for WebSocket fan-out. Services call
// `broadcast(channel, message)`; the WS server adapter subscribes a callback
// per connected client. Synchronous + best-effort: a slow consumer doesn't
// block other consumers. A single daemon process means no cross-process
// bus is needed.

import { createLogger } from '@/util/log'

const log = createLogger('ws.broadcaster')

export type ChannelKey = string

type Listener<M, C> = (msg: M, context: C | undefined) => void

interface ResettableBroadcaster {
  reset(): void
}

// Keep reset coverage coupled to construction rather than to a hand-maintained
// list. A new logical channel is therefore test-isolated automatically as soon
// as its broadcaster is created.
const allBroadcasters = new Set<ResettableBroadcaster>()

class TypedBroadcaster<M, C = never> {
  private subs = new Map<ChannelKey, Set<Listener<M, C>>>()

  constructor() {
    allBroadcasters.add(this)
  }

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
export const AUTHORITY_CHANNEL: ChannelKey = 'authority'
export const TASKS_LIST_CHANNEL: ChannelKey = 'tasks-list'
export const WORKFLOWS_CHANNEL: ChannelKey = 'workflows'
export const WORKGROUPS_CHANNEL: ChannelKey = 'workgroups'
/** RFC-033: per-batch progress channel for `/repos` batch import. */
export const REPO_IMPORT_CHANNEL = (batchId: string): ChannelKey => `repo-import:${batchId}`
/** RFC-041: platform-wide memory candidate / promotion stream. */
export const MEMORY_CHANNEL: ChannelKey = 'memories'
/** RFC-041/RFC-305: capability-gated distill queue monitor. */
export const MEMORY_DISTILL_JOB_CHANNEL: ChannelKey = 'memory-distill-jobs'
export const SCHEDULED_TASK_CHANNEL: ChannelKey = 'scheduled-tasks' // RFC-159
export const INTENT_SESSIONS_CHANNEL: ChannelKey = 'intent-sessions' // RFC-234
export const MCP_RUNTIME_TESTS_CHANNEL: ChannelKey = 'mcp-runtime-tests' // RFC-238
export const PRESENCE_CHANNEL: ChannelKey = 'presence' // RFC-312

import type {
  IntentSessionWsMessage,
  McpRuntimeTestWsMessage,
  MemoryDistillJobWsMessage,
  ScheduledTaskWsMessage,
  MemoryWsMessage,
  PresenceWsMessage,
  RepoImportWsMessage,
  TaskWsMessage,
  TasksListWsMessage,
  WorkgroupsWsMessage,
  WorkflowsWsMessage,
  WsControlMessage,
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

export interface WorkgroupDeletedAudienceContext {
  kind: 'workgroup.deleted-audience'
  workgroupId: string
  visibility: 'public' | 'private'
  ownerUserId: string | null
  grantedUserIds: ReadonlySet<string>
}

export type WorkgroupsBroadcastContext = WorkgroupDeletedAudienceContext

export interface TaskMembersChangedAudienceContext {
  kind: 'task.members-changed-audience'
  taskId: string
  /** Union of the before/after owner + collaborator audiences. */
  visibleUserIds: ReadonlySet<string>
}

export interface TaskDeletedAudienceContext {
  kind: 'task.deleted-audience'
  taskId: string
  /** Owner + collaborators frozen before the task row disappears. */
  visibleUserIds: ReadonlySet<string>
}

/** RFC-330 —— employee case owner / members changed; before ∪ after audience. */
export interface EmployeeCaseMembersChangedAudienceContext {
  kind: 'employee-case.members-changed-audience'
  caseId: string
  visibleUserIds: ReadonlySet<string>
}

export type TasksListBroadcastContext =
  | TaskMembersChangedAudienceContext
  | TaskDeletedAudienceContext
  | EmployeeCaseMembersChangedAudienceContext

/** Owner identity is authorization metadata and is never serialized on wire. */
export interface McpRuntimeTestBroadcastContext {
  kind: 'mcp-runtime-test-owner'
  ownerUserId: string
}

export const taskBroadcaster = new TypedBroadcaster<TaskWsMessage>()
/** Silent product channel: revision notifications are sent directly by the
 * revalidation pass, while the registry still requires a typed subscriber. */
export const authorityBroadcaster = new TypedBroadcaster<WsControlMessage>()
export const tasksListBroadcaster = new TypedBroadcaster<
  TasksListWsMessage,
  TasksListBroadcastContext
>()
export const workflowsBroadcaster = new TypedBroadcaster<
  WorkflowsWsMessage,
  WorkflowsBroadcastContext
>()
export const workgroupsBroadcaster = new TypedBroadcaster<
  WorkgroupsWsMessage,
  WorkgroupsBroadcastContext
>()
export const repoImportsBroadcaster = new TypedBroadcaster<RepoImportWsMessage>()
export const memoryBroadcaster = new TypedBroadcaster<MemoryWsMessage>()
export const memoryDistillJobBroadcaster = new TypedBroadcaster<MemoryDistillJobWsMessage>()
export const scheduledTaskBroadcaster = new TypedBroadcaster<ScheduledTaskWsMessage>() // RFC-159
export const intentSessionsBroadcaster = new TypedBroadcaster<IntentSessionWsMessage>() // RFC-234
export const mcpRuntimeTestsBroadcaster = new TypedBroadcaster<
  McpRuntimeTestWsMessage,
  McpRuntimeTestBroadcastContext
>() // RFC-238
/** RFC-312 —— 在线状态。只广播 presence.changed；snapshot 在 onOpenExtra 里点对点发。 */
export const presenceBroadcaster = new TypedBroadcaster<PresenceWsMessage>()

/** Reset all broadcasters — only used in tests between cases. */
export function resetBroadcastersForTests(): void {
  for (const broadcaster of allBroadcasters) broadcaster.reset()
}
