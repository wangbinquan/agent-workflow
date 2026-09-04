// RFC-349 — PostgreSQL continuation admission. Task lineage, retained replay
// decisions, maintenance fencing and the new intent commit atomically.

import { and, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { taskExecutionIntents } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  SubmittedTaskExecutionIntent,
  SubmitTaskExecutionIntentInput,
  TaskExecutionIntentPersistence,
} from '../application/ports/taskExecutionIntentPersistence'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'
import {
  submitCanonicalTaskExecutionIntent,
  submitTaskContinuation,
} from './taskContinuationAdmission'

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

async function serializable<T>(db: PostgresqlDatabaseClient, body: (tx: PgTx) => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(tx)
      })
    } catch (error) {
      if (await retryPostgresqlSerialization(attempt, error)) continue
      throw error
    }
  }
}

export class PostgresqlTaskExecutionIntentPersistence implements TaskExecutionIntentPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

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
    return await serializable(
      this.db,
      async (tx) => await submitCanonicalTaskExecutionIntent(tx, input, intentId, now),
    )
  }

  async submitContinuation(
    input: Parameters<TaskExecutionIntentPersistence['submitContinuation']>[0],
  ): Promise<SubmittedTaskExecutionIntent> {
    return await serializable(this.db, async (tx) => await submitTaskContinuation(tx, input))
  }
}
