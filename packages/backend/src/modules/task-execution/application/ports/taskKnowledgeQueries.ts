import type { TaskStatus } from '@agent-workflow/shared'
import type { TaskWorkgroupConfig } from '../../domain/taskWorkgroupConfig'

export interface TaskKnowledgeContext {
  readonly workflowId: string | null
  readonly cachedRepoId: string | null
  readonly repoGroupId: string | null
}

export interface TaskDistillationScope {
  readonly workflowSnapshot: string
  readonly workgroupConfig: TaskWorkgroupConfig | null
  readonly workflowId: string | null
  readonly cachedRepoId: string | null
  readonly cachedRepoExists: boolean
  readonly launchOrigin: 'manual' | 'scheduled' | 'event' | 'webhook' | 'api'
  readonly catalogVisibility: 'public' | 'internal'
  readonly spaceKind: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
}

export interface TaskDistillationSource {
  readonly id: string
  readonly name: string
  readonly status: TaskStatus
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly runningMs: number
  readonly errorSummary: string | null
  readonly errorMessage: string | null
  readonly failedNodeId: string | null
  readonly inputs: string
  readonly workflowSnapshot: string
}

/** One node-run event body as the distillation reads it (RFC-565: the port names the row; no storage row leaves). */
export interface TaskDistillationEvent {
  readonly id: number
  readonly nodeRunId: string
  readonly ts: number
  readonly kind: string
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
}

export interface TaskKnowledgeQueries {
  injectionContext(taskId: string): Promise<TaskKnowledgeContext | null>
  repositoryIds(taskId: string): Promise<readonly string[]>
  distillationScope(taskId: string): Promise<TaskDistillationScope | null>
  distillationSources(ids: readonly string[]): Promise<TaskDistillationSource[]>
  /** RFC-565: the event bodies of the given node runs, by event time then stable id. */
  distillationEvents(nodeRunIds: readonly string[]): Promise<TaskDistillationEvent[]>
}
