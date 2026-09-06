import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type { WorkgroupHostLedgerParticipantInTx } from '../public/commands'
import { createWorkgroupHostLedgerParticipantInTx } from '../infrastructure/workgroupHostLedgerParticipant'
import type { WorkgroupTaskRoomClarifyParticipantFactory } from './workgroupTaskRoomTask'

export interface WorkgroupHostLedgerParticipantFactory {
  inTransaction(transaction: DatabaseTransaction): WorkgroupHostLedgerParticipantInTx
}

/**
 * 跨上下文装配接缝（RFC-359 W4-D19c 起两个 provider 共用）。Resource Catalog 那一侧预留事务，
 * 只拿到 TaskExecution 为**那一笔**事务闭合的宿主账本参与者。
 */
export function composeWorkgroupHostLedgerParticipantFactory(input: {
  readonly collaboration: WorkgroupTaskRoomClarifyParticipantFactory
}): WorkgroupHostLedgerParticipantFactory {
  return Object.freeze({
    inTransaction: (transaction: DatabaseTransaction) =>
      createWorkgroupHostLedgerParticipantInTx(
        transaction,
        input.collaboration.inTransaction(transaction),
      ),
  })
}
