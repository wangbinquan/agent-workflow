import type {
  RealtimeTaskAudience,
  RealtimeTaskEventRow,
  RealtimeAclResourceType,
  RealtimeResourceRow,
} from '../application/ports/realtimeStore'

export interface RealtimeTaskFactsPort {
  taskAudience(taskId: string, userId: string): Promise<RealtimeTaskAudience | null>
  taskEventsSince(taskId: string, afterEventId: number): Promise<readonly RealtimeTaskEventRow[]>
}

export interface RealtimeResourceAclPort {
  find(kind: RealtimeAclResourceType, id: string): Promise<RealtimeResourceRow | null>
}
