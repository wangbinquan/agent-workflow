import type {
  WorkgroupTaskRoomClarifyParticipantInTx,
  WorkgroupTaskRoomTaskParticipantInTx,
} from '../public/commands'
import { createWorkgroupTaskRoomTaskParticipantInTx } from '../infrastructure/workgroupTaskRoomTaskParticipant'
import type { TaskExecutionTransaction } from '../infrastructure/ownedTaskExecution'

/**
 * RFC-359 W4-D19a —— 工作组任务房里 TaskExecution 那一半的参与者工厂：一份装配，两个 provider 共用。
 * Collaboration 的那一半由 bootstrap 注入，两半共用调用方持有的同一笔事务。
 */
export interface WorkgroupTaskRoomClarifyParticipantFactory {
  inTransaction(transaction: TaskExecutionTransaction): WorkgroupTaskRoomClarifyParticipantInTx
}

export interface WorkgroupTaskRoomTaskParticipantFactory {
  inTransaction(transaction: TaskExecutionTransaction): WorkgroupTaskRoomTaskParticipantInTx
}

export function composeWorkgroupTaskRoomTaskParticipantFactory(input: {
  readonly collaboration: WorkgroupTaskRoomClarifyParticipantFactory
}): WorkgroupTaskRoomTaskParticipantFactory {
  return Object.freeze({
    inTransaction: (transaction: TaskExecutionTransaction) =>
      createWorkgroupTaskRoomTaskParticipantInTx(
        transaction,
        input.collaboration.inTransaction(transaction),
      ),
  })
}
