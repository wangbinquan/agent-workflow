// RFC-359 W4-B1 批 2g —— 执行 intent 准入（提交 / continuation）：一份实现，两个 provider 共用。
// 此前 SQLite 侧薄壳套 `sqliteTaskExecutionIntent.ts` / `sqliteTaskExecutionIntentAdmission.ts` 的同步内核；两者暂留给 legacy 同步调用方。

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { taskExecutionIntents } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { isPostgresqlSerializationFailure } from '@/platform/persistence/postgresqlSerializationRetry'
import { TaskExecutionError } from '../application/taskExecutionError'
import type {
  SubmittedTaskExecutionIntent,
  SubmitTaskExecutionIntentInput,
  TaskExecutionIntentPersistence,
} from '../application/ports/taskExecutionIntentPersistence'
import {
  submitCanonicalTaskExecutionIntent,
  submitTaskContinuation,
} from './taskContinuationAdmission'

/**
 * 重试预算耗尽后**仍然是**序列化冲突 ⇒ 用户看到的还是「冲突」，不是裸驱动错误（500）。
 * 命中就返回要抛的领域错误，不命中返回 `undefined`（调用方原样抛原错误）。
 *
 * 为什么必须翻：准入的跨行不变量走 SERIALIZABLE（见 `submit` 的注释），PostgreSQL 的 SSI 把
 * 并发准入判成 40001；`serializable()` 会按满抖动退避重试 10 次，绝大多数情况下重试后的那一遍
 * 就在「活跃 intent 检查」上拿到领域错误。但预算是有限的——CI 上真的耗尽过：
 * `rfc359-w8-t29-unique-insert-conflict` 的并发续跑判据 2026-09-11 连红两轮，逐层导出的 cause 链
 * 坐实是 `1:PostgresError/code=ERR_POSTGRES_SERVER_ERROR/errno=40001`。
 *
 * 而**同一场竞争在 SQLite 上**由部分唯一索引给出 `task-continuation-conflict`（那条 insert 上就地
 * 翻译）。不翻这一层，就是同一件事两个引擎两种回答：SQLite 409、PostgreSQL 500——正是 AC-8
 * 要消灭的形态。原始驱动错误挂在 `cause` 上，日志与后续归因仍然看得到 SQLSTATE。
 */
export function admissionSerializationConflict(
  taskId: string,
  error: unknown,
): TaskExecutionError | undefined {
  if (!isPostgresqlSerializationFailure(error)) return undefined
  const conflict = new TaskExecutionError(
    'task-continuation-conflict',
    `task '${taskId}' could not admit a continuation while concurrent writers kept conflicting`,
  )
  return Object.defineProperty(conflict, 'cause', { value: error, configurable: true })
}

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
    // 输家的两种收场都落在**领域错误**上：SSI 先判 ⇒ 40001 由 serializable 重试后走活跃 intent 判据；
    // 部分唯一索引先抛 ⇒ 由 `submitCanonicalTaskExecutionIntent` 在那条 insert 上就地翻译
    //（放在那里而不是这一层，是因为只有贴着语句才知道撞的必然是 intents 自己那条索引——见其注释）。
    try {
      return await databaseSessionFor(this.db).serializable(
        async (tx) => await submitCanonicalTaskExecutionIntent(tx, input, intentId, now),
      )
    } catch (error) {
      throw admissionSerializationConflict(input.request.taskId, error) ?? error
    }
  }

  async submitContinuation(
    input: Parameters<TaskExecutionIntentPersistence['submitContinuation']>[0],
  ): Promise<SubmittedTaskExecutionIntent> {
    try {
      return await databaseSessionFor(this.db).serializable(
        async (tx) => await submitTaskContinuation(tx, input),
      )
    } catch (error) {
      throw admissionSerializationConflict(input.taskId, error) ?? error
    }
  }
}
