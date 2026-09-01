// RFC-349 — realtime provider persistence belongs to runtime-management.

export type RealtimeAclResourceType = 'workflow' | 'workgroup'

export interface RealtimeMemoryScope {
  readonly scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
  readonly scopeId: string | null
}

export interface RealtimeResourceRow {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export interface RealtimeTaskAudience {
  readonly ownerUserId: string | null
  readonly member: boolean
}

export interface RealtimeTaskEventRow {
  readonly id: number
  readonly nodeRunId: string
  readonly ts: number
  readonly kind:
    | 'tool_use'
    | 'text'
    | 'reasoning'
    | 'permission_asked'
    | 'error'
    | 'step_start'
    | 'step_finish'
    | 'stderr'
    | 'subagent_capture_failed'
  readonly payload: string
}

export interface RealtimeStore {
  findTaskAudience(taskId: string, userId: string): Promise<RealtimeTaskAudience | null>
  findResource(
    type: RealtimeAclResourceType,
    resourceId: string,
  ): Promise<RealtimeResourceRow | null>
  findMemoryScope(memoryId: string): Promise<RealtimeMemoryScope | null>
  listTaskEvents(taskId: string, since: number): Promise<readonly RealtimeTaskEventRow[]>
}
