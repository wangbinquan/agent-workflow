// RFC-349 — PostgreSQL intent terminalization and replay-authorization release.

import { and, eq, inArray, sql } from 'drizzle-orm'

import { taskExecutionIntents, taskExecutionLineageOperationRecords } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskExecutionIntentTerminalPersistence } from '../application/terminalizeExecutionIntent'
import { TaskExecutionError } from '../application/taskExecutionError'

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

function retryable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    const sqlState = (current as { readonly errno?: unknown }).errno
    // RFC-349：Bun.SQL 的 `PostgresError` 把 SQLSTATE 放在 `errno`，`code` 恒为
    // `ERR_POSTGRES_SERVER_ERROR`。只看 `code` 的判据一次都不会命中，SERIALIZABLE
    // 冲突就原样变成 500——托管取证跑实测 77 次。
    if (code === '40001' || code === '40P01') return true
    if (sqlState === '40001' || sqlState === '40P01') return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

async function serializable<T>(
  db: PostgresqlDatabaseClient,
  body: (tx: PgTx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(tx)
      })
    } catch (error) {
      if (attempt < 2 && retryable(error)) continue
      throw error
    }
  }
}

export class PostgresqlTaskExecutionIntentTerminalPersistence implements TaskExecutionIntentTerminalPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async terminalize(
    input: Parameters<TaskExecutionIntentTerminalPersistence['terminalize']>[0],
  ): Promise<void> {
    await serializable(this.db, async (tx) => {
      await terminalizePostgresqlTaskExecutionIntentsTx(tx, input)
    })
  }
}

/** Provider-private participant for larger PostgreSQL atoms (recovery,
 * source termination and human-gate decisions). */
export async function terminalizePostgresqlTaskExecutionIntentsTx(
  tx: PgTx,
  input: Parameters<TaskExecutionIntentTerminalPersistence['terminalize']>[0],
): Promise<void> {
  const active = await tx
    .select({ id: taskExecutionIntents.id })
    .from(taskExecutionIntents)
    .where(
      and(
        eq(taskExecutionIntents.taskId, input.taskId),
        input.claimedOwnerEpoch === undefined
          ? inArray(taskExecutionIntents.state, ['pending', 'claimed'])
          : and(
              eq(taskExecutionIntents.state, 'claimed'),
              eq(taskExecutionIntents.claimedEpoch, input.claimedOwnerEpoch),
            ),
      ),
    )
  const activeIntentIds = active.map((row) => row.id)
  if (activeIntentIds.length === 0) return
  const terminalized = await tx
    .update(taskExecutionIntents)
    .set({
      state: input.state,
      failureCode: input.failureCode,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(inArray(taskExecutionIntents.id, activeIntentIds))
    .returning({ id: taskExecutionIntents.id })
  if (terminalized.length !== activeIntentIds.length) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${input.taskId}' active intents changed during terminalization`,
    )
  }
  const decisions = await tx
    .select({
      id: taskExecutionLineageOperationRecords.id,
      revision: taskExecutionLineageOperationRecords.recordRevision,
    })
    .from(taskExecutionLineageOperationRecords)
    .where(
      and(
        eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
        eq(taskExecutionLineageOperationRecords.decisionState, 'actor-replay-authorized'),
        inArray(taskExecutionLineageOperationRecords.boundIntentId, activeIntentIds),
      ),
    )
  for (const decision of decisions) {
    const released = await tx
      .update(taskExecutionLineageOperationRecords)
      .set({
        decisionState: 'requires-actor',
        replayAuthorizationId: null,
        authorizationScopeJson: null,
        actorUserId: null,
        authorizationSource: null,
        boundIntentId: null,
        recordRevision: decision.revision + 1,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.id, decision.id),
          eq(taskExecutionLineageOperationRecords.recordRevision, decision.revision),
          eq(taskExecutionLineageOperationRecords.decisionState, 'actor-replay-authorized'),
        ),
      )
      .returning({ id: taskExecutionLineageOperationRecords.id })
    if (released[0] === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `replay decision '${decision.id}' changed during intent terminalization`,
      )
    }
  }
}
