import type { WorkgroupTaskRoomClarifyParticipantInTx } from '@/modules/task-execution/public/commands'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { createWorkgroupTaskRoomClarifyParticipantInTx } from '../infrastructure/workgroupTaskRoomClarifyParticipant'

/**
 * RFC-359 W4-D19a —— 工作组任务房里 Collaboration 那一半的参与者工厂：一份装配，两个 provider 共用。
 * 调用方（Resource Catalog 的任务房）持有事务，把它交给这里换一个只碰 Collaboration 表的参与者。
 */
export interface WorkgroupTaskRoomClarifyParticipantFactory {
  inTransaction(transaction: DatabaseTransaction): WorkgroupTaskRoomClarifyParticipantInTx
}

export function composeWorkgroupTaskRoomClarifyParticipantFactory(): WorkgroupTaskRoomClarifyParticipantFactory {
  return Object.freeze({
    inTransaction: createWorkgroupTaskRoomClarifyParticipantInTx,
  })
}
