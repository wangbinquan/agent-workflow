import type { RealtimeTaskFactsPort } from '@/modules/runtime-management/composition/required-ports'
import type { RealtimeTaskFacts } from '../ports/realtimeTaskFacts'

export function composeRealtimeTaskFactsPort(facts: RealtimeTaskFacts): RealtimeTaskFactsPort {
  return {
    taskAudience: (taskId, userId) => facts.taskAudience(taskId, userId),
    taskEventsSince: (taskId, afterEventId) => facts.taskEventsSince(taskId, afterEventId),
  }
}
