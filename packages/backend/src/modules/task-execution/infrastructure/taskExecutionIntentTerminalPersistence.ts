// RFC-359: asynchronous transaction shell over the shared terminalization sequence.
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { driveAsyncProgram } from '@/platform/persistence/transactionProgram'
import type { TaskExecutionIntentTerminalPersistence } from '../application/terminalizeExecutionIntent'
import { taskExecutionIntentTerminalSequence } from './taskExecutionIntentTerminalSequence'

export class DrizzleTaskExecutionIntentTerminalPersistence implements TaskExecutionIntentTerminalPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async terminalize(
    input: Parameters<TaskExecutionIntentTerminalPersistence['terminalize']>[0],
  ): Promise<void> {
    // intents 有跨行不变量（每任务至多一个 pending / claimed 的部分唯一索引 + replay 决定的释放），沿用 SERIALIZABLE。
    await databaseSessionFor(this.db).serializable(async (tx) => {
      await terminalizeTaskExecutionIntentsInTx(tx, input)
    })
  }
}

/** 事务内参与者，供更大的原子（恢复、源终止、人工门决定）在自己的事务里调用。 */
export async function terminalizeTaskExecutionIntentsInTx(
  tx: DatabaseTransaction,
  input: Parameters<TaskExecutionIntentTerminalPersistence['terminalize']>[0],
): Promise<void> {
  await driveAsyncProgram(
    taskExecutionIntentTerminalSequence(tx, input, 'require-returned-rows'),
    (step) => step(),
  )
}
