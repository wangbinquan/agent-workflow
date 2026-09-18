// RFC-303 bootstrap-owned composition helpers. Integration receives only the
// participant and a mint closure, never task rows or driver internals.
//
// RFC-359 AC-1（第 14 刀）：两个 provider 的装配也收成一份——参与者本身已经合一，留着两个
// 同义的 `compose*` 只会让「同一个东西」在仓里有两个名字（`rfc359-w5-same-file-provider-pairs`
// 的账本原话：「先合下层，这一层自然塌成一份」）。
import {
  createTaskSourceTerminationParticipant,
  type TaskSourceTerminationParticipantInput,
} from '@/modules/task-execution/infrastructure/sourceTerminationParticipant'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'

export function composeTaskSourceTermination(input: TaskSourceTerminationParticipantInput) {
  return {
    participant: createTaskSourceTerminationParticipant(input),
    mintCapability: mintSourceTerminationEffectCapability,
  }
}
