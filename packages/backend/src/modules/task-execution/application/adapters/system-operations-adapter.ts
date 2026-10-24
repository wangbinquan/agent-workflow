import type { DoctorTaskLifecyclePort } from '@/modules/system-operations/composition/required-ports'
import type { TaskLifecycleCounts } from '../ports/taskStatusCounts'

export function composeDoctorTaskLifecyclePort(
  counts: TaskLifecycleCounts,
): DoctorTaskLifecyclePort {
  return {
    countLifecycleStates: (source) => counts.countLifecycleStates(source),
  }
}
