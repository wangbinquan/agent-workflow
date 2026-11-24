import type { DoctorTaskLifecyclePort } from '@/modules/system-operations/composition/required-ports'
// RFC-562: the hosted restore normalization participant Task Execution implements (`infrastructure/hostedRestoreNormalization.ts`).
export type { HostedRestoreNormalizationParticipant } from '@/modules/system-operations/composition/required-ports'
import type { TaskLifecycleCounts } from '../ports/taskStatusCounts'

export function composeDoctorTaskLifecyclePort(
  counts: TaskLifecycleCounts,
): DoctorTaskLifecyclePort {
  return {
    countLifecycleStates: (source) => counts.countLifecycleStates(source),
  }
}
