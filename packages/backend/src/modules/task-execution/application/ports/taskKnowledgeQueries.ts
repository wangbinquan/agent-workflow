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

export interface TaskKnowledgeQueries {
  injectionContext(taskId: string): Promise<TaskKnowledgeContext | null>
  repositoryIds(taskId: string): Promise<readonly string[]>
  distillationScope(taskId: string): Promise<TaskDistillationScope | null>
  distillationSources(ids: readonly string[]): Promise<TaskDistillationSource[]>
}
