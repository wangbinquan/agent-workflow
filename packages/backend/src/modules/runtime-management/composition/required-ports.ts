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

// RFC-556: Resource Catalog implements the runtime profile usage reader; its designated runtime-management adapter takes
// this port type-only.
export type { RuntimeProfileUsageReader } from '../application/ports/runtimeProfileParticipants'
