import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeTaskCollaborationReads } from '@/modules/collaboration/composition'
import { composeReviewUpstreamAgents } from '@/modules/resource-catalog/composition'
import { composeHumanGateTaskLockPort } from '@/modules/task-execution/composition'

/** RFC-395 II-b O2: the selected session's owner adapters travel through explicit dependencies. */
export function composeCrossContextClosure(db: PersistenceDb) {
  return {
    collaborationReads: composeTaskCollaborationReads(db),
    upstreamAgents: composeReviewUpstreamAgents(db),
    taskLock: composeHumanGateTaskLockPort,
  }
}
