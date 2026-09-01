export type MemoryInjectionScope = 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'

export interface MemoryInjectionRecord {
  readonly id: string
  readonly scopeType: MemoryInjectionScope
  readonly scopeId: string | null
  readonly title: string
  readonly bodyMd: string
  readonly createdAt: number
  readonly version: number
  readonly tagsJson: string
  readonly sourceKind: string
  readonly approvedAt: number | null
}

export interface MemoryInjectionTaskContext {
  readonly workflowId: string | null
  readonly cachedRepoId: string | null
  readonly repoGroupId: string | null
}

export interface MemoryInjectionRunRecord {
  readonly id: string
  readonly status: string
  readonly injectedMemoriesJson: string | null
}

/**
 * Provider-neutral read boundary for the runtime memory injection hot path.
 * Implementations keep Drizzle tables and concrete database clients entirely
 * in infrastructure while callers see only closed records.
 */
export interface MemoryInjectionReadStore {
  findTaskContext(taskId: string): Promise<MemoryInjectionTaskContext | null>
  listTaskRepositoryIds(taskId: string): Promise<readonly string[]>
  filterExistingRepositoryIds(repositoryIds: readonly string[]): Promise<readonly string[]>
  listApprovedMemories(input: {
    readonly scopeType: MemoryInjectionScope
    readonly scopeIds: readonly string[] | null
  }): Promise<readonly MemoryInjectionRecord[]>
  listRunRecords(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly iteration: number
    readonly shardKey: string | null
    readonly reviewIteration: number
  }): Promise<readonly MemoryInjectionRunRecord[]>
}
