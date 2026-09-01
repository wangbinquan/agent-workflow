import { MaintenanceJobKeySchema } from '@agent-workflow/shared'
import { z } from 'zod'

export const MAINTENANCE_PROTOCOL_VERSION = 1 as const

const SqliteMaintenanceWorkerInitSchema = z
  .object({
    type: z.literal('init'),
    version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
    catalogDigest: z.string().length(64),
    dbPath: z.string().min(1),
    migrationsFolder: z.string().min(1),
    appHome: z.string().min(1),
    sqlite: z
      .object({
        synchronous: z.enum(['NORMAL', 'FULL']),
        pageCacheMib: z.number().int().min(2),
        mmapMib: z.number().int().min(0),
        busyTimeoutMs: z.number().int().min(0).max(1_000),
      })
      .strict(),
  })
  .strict()

const PostgresqlMaintenanceWorkerInitSchema = z
  .object({
    type: z.literal('init'),
    version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
    catalogDigest: z.string().length(64),
    provider: z.literal('postgresql'),
    generationId: z.string().min(1),
    appHome: z.string().min(1),
    database: z
      .object({
        provider: z.literal('postgresql'),
        urlEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        poolMax: z.number().int().min(1).max(256),
        connectTimeoutMs: z.number().int().min(100).max(300_000),
        statementTimeoutMs: z.number().int().min(100).max(3_600_000),
        idleTimeoutMs: z.number().int().min(1_000).max(3_600_000),
      })
      .strict(),
  })
  .strict()

/** The legacy SQLite frame remains byte-compatible for compiled-worker
 * upgrades. PostgreSQL carries only an environment-variable reference, never
 * the connection URL/credential. */
export const MaintenanceWorkerInitSchema = z.union([
  SqliteMaintenanceWorkerInitSchema,
  PostgresqlMaintenanceWorkerInitSchema,
])

export const MaintenanceWorkerRequestSchema = z.union([
  MaintenanceWorkerInitSchema,
  z
    .object({
      type: z.literal('wake'),
      version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
    })
    .strict(),
  z
    .object({
      type: z.literal('drain'),
      version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
    })
    .strict(),
])
export type MaintenanceWorkerRequest = z.infer<typeof MaintenanceWorkerRequestSchema>

const LifecycleDeltaSchema = z
  .object({
    kind: z.literal('lifecycle-alerts'),
    alerts: z.array(
      z
        .object({
          taskId: z.string(),
          rule: z.string(),
          severity: z.enum(['warning', 'error']),
          transition: z.enum(['new', 'promoted']),
        })
        .strict(),
    ),
    resolvedTaskIds: z.array(z.string()),
  })
  .strict()

const IntentQueuedDeltaSchema = z
  .object({
    kind: z.literal('intent-queued'),
    sessionIds: z.array(z.string()),
  })
  .strict()

export const MaintenanceWorkerDeltaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  LifecycleDeltaSchema,
  IntentQueuedDeltaSchema,
])
export type MaintenanceWorkerDelta = z.infer<typeof MaintenanceWorkerDeltaSchema>

const CountersSchema = z.record(z.string(), z.number().finite())

export const MaintenanceWorkerEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ready'),
      version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
      catalogDigest: z.string().length(64),
      at: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('heartbeat'),
      version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
      at: z.number().int().nonnegative(),
      activeRunId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('active'),
      version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
      runId: z.string(),
      job: MaintenanceJobKeySchema,
      startedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('completed'),
      version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
      runId: z.string(),
      job: MaintenanceJobKeySchema,
      outcome: z.enum(['succeeded', 'failed', 'deferred']),
      counters: CountersSchema,
      delta: MaintenanceWorkerDeltaSchema,
      finishedAt: z.number().int().nonnegative(),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('degraded'),
      version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
      at: z.number().int().nonnegative(),
      error: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('drained'),
      version: z.literal(MAINTENANCE_PROTOCOL_VERSION),
      at: z.number().int().nonnegative(),
    })
    .strict(),
])
export type MaintenanceWorkerEvent = z.infer<typeof MaintenanceWorkerEventSchema>
