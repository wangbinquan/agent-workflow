// RFC-349 — PostgreSQL adapter for the System Operations retention slice.
// The predicates and durable cursor mirror the SQLite oracle, but every
// bounded delete uses PostgreSQL CTE/RETURNING rather than SQLite rowid.

import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import { sql, type SQLWrapper } from 'drizzle-orm'

import {
  intentSessions,
  intentTurnEvents,
  intentTurns,
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessions,
  memoryDistillEvents,
  memoryDistillJobs,
  tasks,
  webhookTriggerFires,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from './postgresqlDatabaseClient'

const DAY_MS = 86_400_000
export const POSTGRESQL_RETENTION_DELETE_BATCH = 5_000

export interface PostgresqlRetentionConfig {
  readonly eventStreamRetentionDays: number
  readonly webhookTriggerFiresRetentionDays: number
}

export interface PostgresqlRetentionSweepResult {
  readonly distillEvents: number
  readonly intentTurnEvents: number
  readonly mcpRuntimeTestEvents: number
  readonly webhookTriggerFires: number
  readonly userAccessAudit: number
}

type PostgresqlRetentionPhase =
  | 'distill-events'
  | 'intent-turn-events'
  | 'mcp-runtime-test-events'
  | 'webhook-trigger-fires'
  | 'done'

export interface PostgresqlRetentionSweepCursorV1 {
  readonly version: 1
  readonly phase: PostgresqlRetentionPhase
  readonly eventCutoff: number | null
  readonly webhookCutoff: number | null
}

export interface PostgresqlRetentionSweepSliceResult {
  readonly done: boolean
  readonly cursor: PostgresqlRetentionSweepCursorV1
  readonly counters: PostgresqlRetentionSweepResult
}

function zeroResult() {
  return {
    distillEvents: 0,
    intentTurnEvents: 0,
    mcpRuntimeTestEvents: 0,
    webhookTriggerFires: 0,
    userAccessAudit: 0,
  }
}

function phases(cursor: PostgresqlRetentionSweepCursorV1): PostgresqlRetentionPhase[] {
  return [
    ...(cursor.eventCutoff === null
      ? []
      : (['distill-events', 'intent-turn-events', 'mcp-runtime-test-events'] as const)),
    ...(cursor.webhookCutoff === null ? [] : (['webhook-trigger-fires'] as const)),
    'done',
  ]
}

function cursorFor(
  value: unknown,
  config: PostgresqlRetentionConfig,
  now: number,
): PostgresqlRetentionSweepCursorV1 {
  if (value === null || value === undefined) {
    const initial: PostgresqlRetentionSweepCursorV1 = {
      version: 1,
      phase: 'done',
      eventCutoff:
        config.eventStreamRetentionDays > 0 ? now - config.eventStreamRetentionDays * DAY_MS : null,
      webhookCutoff:
        config.webhookTriggerFiresRetentionDays > 0
          ? now - config.webhookTriggerFiresRetentionDays * DAY_MS
          : null,
    }
    return { ...initial, phase: phases(initial)[0]! }
  }
  const candidate = value as Partial<PostgresqlRetentionSweepCursorV1> | null
  const validCutoff = (cutoff: unknown): cutoff is number | null =>
    cutoff === null || Number.isSafeInteger(cutoff)
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    candidate.version !== 1 ||
    ![
      'distill-events',
      'intent-turn-events',
      'mcp-runtime-test-events',
      'webhook-trigger-fires',
      'done',
    ].includes(String(candidate.phase)) ||
    !validCutoff(candidate.eventCutoff) ||
    !validCutoff(candidate.webhookCutoff)
  ) {
    throw new Error('maintenance-retention-cursor-invalid')
  }
  const parsed = candidate as PostgresqlRetentionSweepCursorV1
  if (!phases(parsed).includes(parsed.phase)) {
    throw new Error('maintenance-retention-cursor-phase-invalid')
  }
  return parsed
}

function advance(cursor: PostgresqlRetentionSweepCursorV1): PostgresqlRetentionSweepCursorV1 {
  const ordered = phases(cursor)
  const index = ordered.indexOf(cursor.phase)
  return { ...cursor, phase: ordered[Math.min(ordered.length - 1, index + 1)]! }
}

function distillDelete(cutoff: number | null, batchSize: number): SQLWrapper {
  return sql`
    WITH candidates AS (
      SELECT ${memoryDistillEvents.id} AS id
      FROM ${memoryDistillEvents}
      WHERE ${memoryDistillEvents.ts} < ${cutoff}
        AND EXISTS (
          SELECT 1 FROM ${memoryDistillJobs}
          WHERE ${memoryDistillJobs.id} = ${memoryDistillEvents.distillJobId}
            AND ${memoryDistillJobs.status} IN ('done', 'failed', 'canceled')
        )
      ORDER BY ${memoryDistillEvents.id}
      LIMIT ${batchSize}
    )
    DELETE FROM ${memoryDistillEvents}
    USING candidates
    WHERE ${memoryDistillEvents.id} = candidates.id
    RETURNING ${memoryDistillEvents.id} AS id
  `
}

function intentDelete(cutoff: number | null, batchSize: number): SQLWrapper {
  return sql`
    WITH candidates AS (
      SELECT ${intentTurnEvents.id} AS id
      FROM ${intentTurnEvents}
      WHERE ${intentTurnEvents.ts} < ${cutoff}
        AND EXISTS (
          SELECT 1
          FROM ${intentTurns}
          JOIN ${intentSessions} ON ${intentSessions.id} = ${intentTurns.sessionId}
          WHERE ${intentTurns.id} = ${intentTurnEvents.turnId}
            AND ${intentSessions.status} = 'archived'
        )
      ORDER BY ${intentTurnEvents.id}
      LIMIT ${batchSize}
    )
    DELETE FROM ${intentTurnEvents}
    USING candidates
    WHERE ${intentTurnEvents.id} = candidates.id
    RETURNING ${intentTurnEvents.id} AS id
  `
}

function mcpRuntimeDelete(cutoff: number | null, batchSize: number): SQLWrapper {
  return sql`
    WITH candidates AS (
      SELECT ${mcpRuntimeTestEvents.id} AS id
      FROM ${mcpRuntimeTestEvents}
      WHERE ${mcpRuntimeTestEvents.ts} < ${cutoff}
        AND EXISTS (
          SELECT 1 FROM ${mcpRuntimeTestSessions}
          WHERE ${mcpRuntimeTestSessions.id} = ${mcpRuntimeTestEvents.testSessionId}
            AND ${mcpRuntimeTestSessions.status} = 'ended'
        )
      ORDER BY ${mcpRuntimeTestEvents.id}
      LIMIT ${batchSize}
    )
    DELETE FROM ${mcpRuntimeTestEvents}
    USING candidates
    WHERE ${mcpRuntimeTestEvents.id} = candidates.id
    RETURNING ${mcpRuntimeTestEvents.id} AS id
  `
}

function webhookFireDelete(cutoff: number | null, batchSize: number): SQLWrapper {
  return sql`
    WITH candidates AS (
      SELECT ${webhookTriggerFires.id} AS id
      FROM ${webhookTriggerFires}
      WHERE ${webhookTriggerFires.firedAt} < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM ${tasks}
          WHERE ${tasks.id} = ${webhookTriggerFires.taskId}
            AND ${tasks.status} NOT IN (${sql.join(
              TERMINAL_TASK_STATUSES.map((value) => sql`${value}`),
              sql`, `,
            )})
        )
      ORDER BY ${webhookTriggerFires.id}
      LIMIT ${batchSize}
    )
    DELETE FROM ${webhookTriggerFires}
    USING candidates
    WHERE ${webhookTriggerFires.id} = candidates.id
    RETURNING ${webhookTriggerFires.id} AS id
  `
}

/** One bounded, predicate-rechecking PostgreSQL retention statement. The
 * provider client wraps the CTE delete in the active-generation write fence. */
export async function runPostgresqlRetentionSweepSlice(
  db: PostgresqlDatabaseClient,
  config: PostgresqlRetentionConfig,
  cursorValue: unknown,
  now: number = Date.now(),
  batchSize: number = POSTGRESQL_RETENTION_DELETE_BATCH,
): Promise<PostgresqlRetentionSweepSliceResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('maintenance-retention-batch-invalid')
  }
  const cursor = cursorFor(cursorValue, config, now)
  const counters = zeroResult()
  if (cursor.phase === 'done') return { done: true, cursor, counters }

  const statement =
    cursor.phase === 'distill-events'
      ? distillDelete(cursor.eventCutoff, batchSize)
      : cursor.phase === 'intent-turn-events'
        ? intentDelete(cursor.eventCutoff, batchSize)
        : cursor.phase === 'mcp-runtime-test-events'
          ? mcpRuntimeDelete(cursor.eventCutoff, batchSize)
          : webhookFireDelete(cursor.webhookCutoff, batchSize)
  const deleted = await db.all<{ id: string | number }>(statement)
  if (cursor.phase === 'distill-events') counters.distillEvents = deleted.length
  else if (cursor.phase === 'intent-turn-events') counters.intentTurnEvents = deleted.length
  else if (cursor.phase === 'mcp-runtime-test-events') {
    counters.mcpRuntimeTestEvents = deleted.length
  } else counters.webhookTriggerFires = deleted.length

  const next = deleted.length < batchSize ? advance(cursor) : cursor
  return { done: next.phase === 'done', cursor: next, counters }
}
