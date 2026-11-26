// RFC-602: online queries use the explicitly prepared durable projection.
import type { CodeHistoryQueryReader } from '../application/ports/historyQueryIndex'
import type { WorkItemProjectionReadPort } from '../application/ports/workItemProjectionRead'

export function createWorkItemProjectionRead(
  history: CodeHistoryQueryReader,
): WorkItemProjectionReadPort {
  return history.workItems
}
