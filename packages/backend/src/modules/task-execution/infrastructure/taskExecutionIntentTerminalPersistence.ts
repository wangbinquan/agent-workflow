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

/**
 * 同上，但**不校验受影响行数**（`'unchecked'`）。
 *
 * 它存在只有一个理由：与同步孪生 `terminalizeTaskExecutionIntentsTx`
 * （`sqliteTerminalizeExecutionIntent.ts`，同样是 `'unchecked'`）**逐字同语义**。
 * 取消级联与 boot-orphan 终结这两条路径历来走的是宽判据——被别的写者/触发器挡掉一行时
 * 它们照样收尾，而不是抛 `task-continuation-stale`。RFC-359 把这两处的事务换成中立原语时
 * **不该顺手收紧语义**：2026-09-11 实撞，换成严格版之后
 * `rfc359-w17-boot-orphan-terminalization` 的「skip-intent / skip-record 保留既有 returned-row
 * 分支」两条当场红——那两条锁的正是「SQLite 侧宽、PostgreSQL 侧严」这条既有差异。
 *
 * 差异本身该不该收敛是另一件事（要收就两个引擎一起收、并改那两条判据的意图）；
 * 换事务原语这一刀只负责搬形态，不负责改判据。
 */
export async function terminalizeTaskExecutionIntentsUncheckedInTx(
  tx: DatabaseTransaction,
  input: Parameters<TaskExecutionIntentTerminalPersistence['terminalize']>[0],
): Promise<void> {
  await driveAsyncProgram(taskExecutionIntentTerminalSequence(tx, input, 'unchecked'), (step) =>
    step(),
  )
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
