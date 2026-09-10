// RFC-359 W4-B1 批 2g —— 执行 intent 准入（提交 / continuation）：一份实现，两个 provider 共用。
// 此前 SQLite 侧薄壳套 `sqliteTaskExecutionIntent.ts` / `sqliteTaskExecutionIntentAdmission.ts` 的同步内核；两者暂留给 legacy 同步调用方。

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { taskExecutionIntents } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type {
  SubmittedTaskExecutionIntent,
  SubmitTaskExecutionIntentInput,
  TaskExecutionIntentPersistence,
} from '../application/ports/taskExecutionIntentPersistence'
import {
  admitWithPendingIntentConflict,
  submitCanonicalTaskExecutionIntent,
  submitTaskContinuation,
} from './taskContinuationAdmission'

export class DrizzleTaskExecutionIntentPersistence implements TaskExecutionIntentPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async hasPendingGateSuccessor(taskId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: taskExecutionIntents.id })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.taskId, taskId),
          eq(taskExecutionIntents.kind, 'gate-continuation'),
          eq(taskExecutionIntents.state, 'pending'),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  async submit(input: SubmitTaskExecutionIntentInput): Promise<SubmittedTaskExecutionIntent> {
    const intentId = input.intentId ?? ulid()
    const now = input.now ?? Date.now()
    // 准入有跨行不变量（每任务至多一个 pending / claimed 的部分唯一索引、lineage 记录），沿用 SERIALIZABLE。
    // 输家的两种收场都要落在**领域错误**上：SSI 先判 ⇒ 40001 由 serializable 重试后走活跃 intent
    // 判据；部分唯一索引先抛 ⇒ 23505 由这一层翻译（否则驱动错误原样漏出去，用户拿到 500 而非 409）。
    const session = databaseSessionFor(this.db)
    return await admitWithPendingIntentConflict(
      session.engine.uniqueViolationTarget,
      input.request.taskId,
      async () =>
        await session.serializable(
          async (tx) => await submitCanonicalTaskExecutionIntent(tx, input, intentId, now),
        ),
    )
  }

  async submitContinuation(
    input: Parameters<TaskExecutionIntentPersistence['submitContinuation']>[0],
  ): Promise<SubmittedTaskExecutionIntent> {
    const session = databaseSessionFor(this.db)
    return await admitWithPendingIntentConflict(
      session.engine.uniqueViolationTarget,
      input.taskId,
      async () => await session.serializable(async (tx) => await submitTaskContinuation(tx, input)),
    )
  }
}
