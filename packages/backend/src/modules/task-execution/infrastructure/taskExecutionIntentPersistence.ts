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
    return await databaseSessionFor(this.db).serializable(
      async (tx) => await submitCanonicalTaskExecutionIntent(tx, input, intentId, now),
    )
  }

  async submitContinuation(
    input: Parameters<TaskExecutionIntentPersistence['submitContinuation']>[0],
  ): Promise<SubmittedTaskExecutionIntent> {
    return await databaseSessionFor(this.db).serializable(
      async (tx) => await submitTaskContinuation(tx, input),
    )
  }
}
