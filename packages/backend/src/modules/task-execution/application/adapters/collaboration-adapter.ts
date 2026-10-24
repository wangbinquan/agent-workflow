import type { HumanGateTaskLockParticipant } from '@/modules/collaboration/composition/required-ports'
import type { HumanGatePersistenceParticipantInTx } from '../ports/humanGatePersistenceParticipant'

export function composeHumanGateTaskLockParticipant(
  participant: Pick<HumanGatePersistenceParticipantInTx, 'lockTask'>,
): HumanGateTaskLockParticipant {
  return { lockTask: (taskId) => participant.lockTask(taskId) }
}
