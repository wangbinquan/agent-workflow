// RFC-338 — long-lived maintenance Worker entrypoint. It owns a separate
// bun:sqlite connection and serializes every heavy/recovery/checkpoint job.
// There is intentionally no fallback that runs a failed Worker job on main.

import { MaintenanceJobKeySchema } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { join } from 'node:path'

import { createPostgresqlTokenCallAudit, createSqliteTokenCallAudit } from '@/auth/composition'
import type { TokenCallAuditParticipant } from '@/auth/application/tokenCallAudit'
import { openDb, type DbClient } from '@/db/client'
import { retryableSqliteWriteErrorCode } from '@/db/sqliteWriteRetry'
import {
  composePostgresqlIntentMaintenanceCommandsForAppHome,
  composeSqliteIntentMaintenanceCommandsForAppHome,
} from '@/modules/intent/composition/maintenance'
import type { IntentMaintenanceCommands } from '@/modules/intent/public/commands'
import {
  composeDevelopmentAutomationMaintenanceCommands,
  composePostgresqlDevelopmentAutomationMaintenanceCommands,
} from '@/modules/development-automation/composition'
import {
  composeDigitalEmployeeMaintenanceCommands,
  composePostgresqlDigitalEmployeeMaintenanceCommands,
} from '@/modules/digital-employee/composition'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import type { TaskArchiveMaintenanceCommand } from '@/modules/task-execution/application/ports/taskArchiveMaintenanceCommand'
import {
  createPostgresqlTaskArchiveMaintenanceCommand,
  createSqliteTaskArchiveMaintenanceCommand,
} from '@/modules/task-execution/composition/taskArchiveMaintenance'
import {
  createPostgresqlTaskExecutionPersistence,
  createSqliteTaskExecutionPersistence,
} from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  composePostgresqlPluginGenerationGcCommand,
  composeSqlitePluginGenerationGcCommand,
} from '@/modules/resource-catalog/composition/pluginGenerationGc'
import {
  composePostgresqlResourcePackageApplyMaintenance,
  composeSqliteResourcePackageApplyMaintenance,
} from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import type {
  PluginGenerationGcCommand,
  ResourcePackageApplyMaintenanceCommand,
} from '@/modules/resource-catalog/public/commands'
import {
  composePostgresqlWebhookDeliveryPersistence,
  composeSqliteWebhookDeliveryPersistence,
} from '@/modules/integration/composition/webhookDelivery'
import { composeIntegrationMaintenanceCommands } from '@/modules/integration/composition/maintenance'
import type { IntegrationMaintenanceCommands } from '@/modules/integration/public/commands'
import {
  composePostgresqlWorkspaceMaintenanceCommand,
  composeSqliteWorkspaceMaintenanceCommand,
} from '@/modules/source-control/composition/workspaceMaintenance'
import type { WorkspaceMaintenanceCommand } from '@/modules/source-control/public/commands'
import type { ClaimedMaintenanceRun, MaintenanceRunStore } from './maintenanceRunStorePort'
import { createPostgresqlMaintenanceRunStore } from '@/platform/persistence/postgresqlMaintenanceRunStore'
import {
  createPostgresqlMaintenanceExecutionFence,
  createSqliteMaintenanceExecutionFence,
  type MaintenanceExecutionFence,
} from '@/platform/persistence/maintenanceExecutionFence'
import { createPostgresqlEventsArchiveStore } from '@/platform/persistence/postgresqlEventsArchive'
import { runPostgresqlRetentionSweepSlice } from '@/platform/persistence/postgresqlMaintenanceRetention'
import { createSqliteEventsArchiveStore } from '@/platform/persistence/sqlite/systemEventsArchive'
import { runRetentionSweepSlice } from '@/platform/persistence/sqlite/systemMaintenanceRetention'
import {
  checkpointSqliteWal,
  createSqliteMaintenanceRunStore,
} from '@/platform/persistence/sqlite/systemMaintenanceOperations'
import { createPostgresqlDatabaseOperationalAdapter } from '@/platform/persistence/databaseOperationalAdapter'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
} from '@/platform/persistence/postgresqlRuntime'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { activeResourceBundleApplyIds } from '@/services/bundle/apply'
import { createPluginGenerationFilesystemGcPort } from '@/services/pluginGenerationGc'
import { INTENT_SCRATCH_DIRNAME } from '@/services/intent/turnEngine'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import { createLogger } from '@/util/log'
import { MAINTENANCE_CATALOG_DIGEST } from './maintenanceCatalog'
import { runMaintenanceJob, type MaintenanceSystemOperations } from './maintenanceJobRunner'
import { createEventsArchiveMaintenanceCommand } from './eventsArchiveMaintenance'
import { installMaintenanceWorkerErrorBoundary } from './maintenanceWorkerErrorBoundary'
import { MAINTENANCE_PROTOCOL_VERSION, type MaintenanceWorkerEvent } from './maintenanceProtocol'
import {
  routeMaintenanceWorkerRequest,
  type MaintenanceWorkerInitRequest,
} from './maintenanceWorkerMessageRouter'

declare const self: Worker

const LEASE_MS = 60 * 60 * 1_000
const IDLE_POLL_MS = 1_000
const HEARTBEAT_MS = 5_000
const MAX_BUSY_BACKOFF_MS = 30_000
const CLEANUP_COOLDOWN_MS = 25
const MAINTENANCE_RETENTION_SLICE_ROWS = 1_000

let db: DbClient | null = null
let store: MaintenanceRunStore | null = null
let postgresqlRuntime: PostgresqlDatabaseRuntime | null = null
let systemOperations: MaintenanceSystemOperations | null = null
let workspaceMaintenanceCommand: WorkspaceMaintenanceCommand | null = null
let developmentAutomationMaintenance: ReturnType<
  typeof composeDevelopmentAutomationMaintenanceCommands
> | null = null
let digitalEmployeeMaintenance: ReturnType<
  typeof composeDigitalEmployeeMaintenanceCommands
> | null = null
let intentMaintenanceCommands: IntentMaintenanceCommands | null = null
let integrationMaintenanceCommands: IntegrationMaintenanceCommands | null = null
let taskRecoveryOperations: TaskRecoveryOperations | null = null
let taskArchiveMaintenanceCommand: TaskArchiveMaintenanceCommand | null = null
let tokenCallAudit: TokenCallAuditParticipant | null = null
let pluginGenerationGcCommand: PluginGenerationGcCommand | null = null
let maintenanceExecutionFence: MaintenanceExecutionFence | null = null
let appHome = ''
let processing = false
let draining = false
let initialising = false
let initialised = false
let active: { runId: string; leaseToken: string } | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let heartbeatInFlight: Promise<void> | null = null
let statementTimings: TimingHistogram | null = null
let transactionTimings: TimingHistogram | null = null

interface TimingHistogram {
  count: number
  totalMs: number
  maxMs: number
  le10: number
  le50: number
  le250: number
}

function emptyTimingHistogram(): TimingHistogram {
  return { count: 0, totalMs: 0, maxMs: 0, le10: 0, le50: 0, le250: 0 }
}

function recordTiming(histogram: TimingHistogram | null, ms: number): void {
  if (histogram === null) return
  histogram.count += 1
  histogram.totalMs += ms
  histogram.maxMs = Math.max(histogram.maxMs, ms)
  if (ms <= 10) histogram.le10 += 1
  if (ms <= 50) histogram.le50 += 1
  if (ms <= 250) histogram.le250 += 1
}

function timingCounters(
  prefix: 'dbStatement' | 'dbTransaction',
  histogram: TimingHistogram,
): Record<string, number> {
  return {
    [`${prefix}Count`]: histogram.count,
    [`${prefix}MsTotal`]: histogram.totalMs,
    [`${prefix}MsMax`]: histogram.maxMs,
    [`${prefix}Le10Ms`]: histogram.le10,
    [`${prefix}Le50Ms`]: histogram.le50,
    [`${prefix}Le250Ms`]: histogram.le250,
  }
}

function emit(event: MaintenanceWorkerEvent): void {
  postMessage(event)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

installMaintenanceWorkerErrorBoundary({
  target: self,
  onFatal: (error) => {
    emit({
      type: 'degraded',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at: Date.now(),
      error,
    })
  },
})

function isSqliteBusy(error: unknown): boolean {
  return retryableSqliteWriteErrorCode(error) !== undefined
}

function postgresqlRetryCode(error: unknown): '40001' | '40P01' | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined
    const code = (current as { readonly code?: unknown }).code
    if (code === '40001' || code === '40P01') return code
    current = (current as { readonly cause?: unknown }).cause
  }
  return undefined
}

function retryableLedgerError(error: unknown): 'sqlite-busy' | 'postgresql-transient' | undefined {
  if (isSqliteBusy(error)) return 'sqlite-busy'
  return postgresqlRetryCode(error) === undefined ? undefined : 'postgresql-transient'
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('maintenance-ledger-json-object-invalid')
  }
  return parsed as Record<string, unknown>
}

function parseCounters(value: string): Record<string, number> {
  const parsed = parseJsonObject(value)
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  )
}

function addCounters(
  before: Readonly<Record<string, number>>,
  delta: Readonly<Record<string, number>>,
): Record<string, number> {
  const next = { ...before }
  for (const [key, value] of Object.entries(delta)) {
    next[key] = key.endsWith('MsMax') ? Math.max(next[key] ?? 0, value) : (next[key] ?? 0) + value
  }
  return next
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function busyBackoffMs(attempt: number): number {
  return Math.min(MAX_BUSY_BACKOFF_MS, 250 * 2 ** Math.min(8, Math.max(0, attempt)))
}

async function claimNextWithBusyBackoff(
  store: MaintenanceRunStore,
  input: Parameters<MaintenanceRunStore['claimNext']>[0],
): Promise<{ claimed: ClaimedMaintenanceRun | null; busyDeferrals: number }> {
  let busyDeferrals = 0
  for (;;) {
    if (draining) return { claimed: null, busyDeferrals }
    try {
      return { claimed: await store.claimNext(input), busyDeferrals }
    } catch (error) {
      if (retryableLedgerError(error) === undefined) throw error
      await delay(busyBackoffMs(busyDeferrals))
      busyDeferrals += 1
    }
  }
}

async function settleWithBusyBackoff(
  store: MaintenanceRunStore,
  input: Parameters<MaintenanceRunStore['settle']>[0] & {
    readonly counters: Readonly<Record<string, number>>
  },
): Promise<{ settled: boolean; counters: Record<string, number> }> {
  let busyDeferrals = 0
  for (;;) {
    const counters = addCounters(
      input.counters,
      busyDeferrals === 0 ? {} : { sqliteBusyDeferrals: busyDeferrals },
    )
    try {
      return { settled: await store.settle({ ...input, counters }), counters }
    } catch (error) {
      if (retryableLedgerError(error) === undefined) throw error
      await delay(busyBackoffMs(busyDeferrals))
      busyDeferrals += 1
    }
  }
}

async function closeConnection(): Promise<void> {
  if (pollTimer !== null) clearInterval(pollTimer)
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  pollTimer = null
  heartbeatTimer = null
  await heartbeatInFlight?.catch(() => undefined)
  heartbeatInFlight = null
  const current = db
  const currentPostgresqlRuntime = postgresqlRuntime
  db = null
  store = null
  postgresqlRuntime = null
  systemOperations = null
  workspaceMaintenanceCommand = null
  developmentAutomationMaintenance = null
  digitalEmployeeMaintenance = null
  intentMaintenanceCommands = null
  integrationMaintenanceCommands = null
  taskRecoveryOperations = null
  taskArchiveMaintenanceCommand = null
  tokenCallAudit = null
  pluginGenerationGcCommand = null
  maintenanceExecutionFence = null
  initialised = false
  ;(current as unknown as { $client?: { close(): void } } | null)?.$client?.close()
  await currentPostgresqlRuntime?.close()
}

async function drainIfReady(): Promise<void> {
  if (!draining || processing) return
  await closeConnection()
  emit({
    type: 'drained',
    version: MAINTENANCE_PROTOCOL_VERSION,
    at: Date.now(),
  })
}

function createWorkerWorkspaceMaintenanceCommand(
  factory: (isMaterializingTask: (taskId: string) => boolean) => WorkspaceMaintenanceCommand,
): WorkspaceMaintenanceCommand {
  let protectedTaskIds = new Set<string>()
  const command = factory((taskId) => protectedTaskIds.has(taskId))
  return Object.freeze({
    async runGcPhase(input: Parameters<WorkspaceMaintenanceCommand['runGcPhase']>[0]) {
      protectedTaskIds = new Set(input.activeTaskIds)
      try {
        return await command.runGcPhase(input)
      } finally {
        protectedTaskIds.clear()
      }
    },
    recover: (input: Parameters<WorkspaceMaintenanceCommand['recover']>[0]) =>
      command.recover(input),
  })
}

async function processQueue(): Promise<void> {
  const currentDb = db
  const currentStore = store
  const currentDevelopmentAutomationMaintenance = developmentAutomationMaintenance
  const currentDigitalEmployeeMaintenance = digitalEmployeeMaintenance
  const currentIntentMaintenanceCommands = intentMaintenanceCommands
  const currentIntegrationMaintenanceCommands = integrationMaintenanceCommands
  const currentWorkspaceMaintenanceCommand = workspaceMaintenanceCommand
  const currentSystemOperations = systemOperations
  const currentTaskRecoveryOperations = taskRecoveryOperations
  const currentTaskArchiveMaintenanceCommand = taskArchiveMaintenanceCommand
  const currentTokenCallAudit = tokenCallAudit
  const currentPluginGenerationGcCommand = pluginGenerationGcCommand
  const currentMaintenanceExecutionFence = maintenanceExecutionFence
  if (
    currentStore === null ||
    currentIntegrationMaintenanceCommands === null ||
    currentWorkspaceMaintenanceCommand === null ||
    currentSystemOperations === null ||
    currentDevelopmentAutomationMaintenance === null ||
    currentDigitalEmployeeMaintenance === null ||
    currentIntentMaintenanceCommands === null ||
    currentTaskRecoveryOperations === null ||
    currentTaskArchiveMaintenanceCommand === null ||
    currentTokenCallAudit === null ||
    currentPluginGenerationGcCommand === null ||
    currentMaintenanceExecutionFence === null ||
    processing ||
    draining
  ) {
    await drainIfReady()
    return
  }
  processing = true
  try {
    for (;;) {
      if (draining) break
      const now = Date.now()
      const leaseToken = ulid()
      const claim = await claimNextWithBusyBackoff(currentStore, {
        leaseToken,
        now,
        leaseMs: LEASE_MS,
      })
      const claimed = claim.claimed
      if (claimed === null) break
      const job = MaintenanceJobKeySchema.parse(claimed.row.jobKey)
      active = { runId: claimed.row.id, leaseToken }
      emit({
        type: 'active',
        version: MAINTENANCE_PROTOCOL_VERSION,
        runId: claimed.row.id,
        job,
        startedAt: claimed.row.startedAt ?? now,
      })
      try {
        const payload = parseJsonObject(claimed.row.payloadJson)
        const cursor =
          claimed.row.cursorJson === null ? undefined : parseJsonObject(claimed.row.cursorJson)
        statementTimings = emptyTimingHistogram()
        transactionTimings = emptyTimingHistogram()
        const sliceStartedAt = performance.now()
        const result = await runMaintenanceJob({
          appHome,
          ownerCommands: {
            workspace: currentWorkspaceMaintenanceCommand,
            developmentAutomation: currentDevelopmentAutomationMaintenance,
            digitalEmployee: currentDigitalEmployeeMaintenance,
            intent: currentIntentMaintenanceCommands,
            integration: currentIntegrationMaintenanceCommands,
            taskRecovery: currentTaskRecoveryOperations,
            taskArchive: currentTaskArchiveMaintenanceCommand,
            tokenAudit: currentTokenCallAudit,
            pluginGenerationGc: {
              command: currentPluginGenerationGcCommand,
              executionFence: currentMaintenanceExecutionFence,
            },
            system: currentSystemOperations,
          },
          job,
          payload,
          ...(cursor === undefined ? {} : { cursor }),
        })
        const sliceMs = performance.now() - sliceStartedAt
        const sliceCounters = {
          ...result.counters,
          ...(claim.busyDeferrals === 0
            ? {}
            : currentDb === null
              ? { postgresqlTransientDeferrals: claim.busyDeferrals }
              : { sqliteBusyDeferrals: claim.busyDeferrals }),
          workerSliceCount: 1,
          workerSliceMsTotal: sliceMs,
          workerSliceMsMax: sliceMs,
          ...timingCounters('dbStatement', statementTimings),
          ...timingCounters('dbTransaction', transactionTimings),
        }
        statementTimings = null
        transactionTimings = null
        const finishedAt = Date.now()
        const counters = addCounters(parseCounters(claimed.row.countersJson), sliceCounters)
        const continuation = result.continuation
        const outcome = continuation === undefined ? 'succeeded' : 'deferred'
        const settlement = await settleWithBusyBackoff(currentStore, {
          runId: claimed.row.id,
          leaseToken,
          now: finishedAt,
          outcome,
          counters,
          ...(continuation === undefined
            ? {}
            : {
                cursor: continuation.cursor,
                nextAttemptAt: finishedAt + continuation.resumeAfterMs,
              }),
        })
        if (settlement.settled) {
          emit({
            type: 'completed',
            version: MAINTENANCE_PROTOCOL_VERSION,
            runId: claimed.row.id,
            job,
            outcome,
            counters: settlement.counters,
            delta: result.delta,
            finishedAt,
          })
        }
        if (continuation !== undefined) await delay(continuation.resumeAfterMs)
        else if (claimed.row.jobClass === 'cleanup') await delay(CLEANUP_COOLDOWN_MS)
      } catch (error) {
        statementTimings = null
        transactionTimings = null
        const finishedAt = Date.now()
        const message = errorMessage(error)
        const retryable = retryableLedgerError(error)
        const busy = retryable !== undefined
        const backoff = Math.min(
          MAX_BUSY_BACKOFF_MS,
          250 * 2 ** Math.min(8, Math.max(0, claimed.row.attempt)),
        )
        const outcome = busy ? 'deferred' : 'failed'
        const errorCode =
          retryable === 'sqlite-busy'
            ? 'sqlite-busy'
            : retryable === 'postgresql-transient'
              ? 'postgresql-transient'
              : 'job-failed'
        const counters = addCounters(parseCounters(claimed.row.countersJson), {
          ...(retryable === 'sqlite-busy'
            ? { sqliteBusyDeferrals: 1 }
            : retryable === 'postgresql-transient'
              ? { postgresqlTransientDeferrals: 1 }
              : { workerFailures: 1 }),
        })
        const settlement = await settleWithBusyBackoff(currentStore, {
          runId: claimed.row.id,
          leaseToken,
          now: finishedAt,
          outcome,
          errorCode,
          errorMessage: message,
          counters,
          ...(busy ? { nextAttemptAt: finishedAt + backoff } : {}),
        })
        if (settlement.settled) {
          emit({
            type: 'completed',
            version: MAINTENANCE_PROTOCOL_VERSION,
            runId: claimed.row.id,
            job,
            outcome,
            counters: settlement.counters,
            delta: { kind: 'none' },
            finishedAt,
            errorCode,
            errorMessage: message,
          })
        }
      } finally {
        active = null
      }
    }
  } catch (error) {
    emit({
      type: 'degraded',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at: Date.now(),
      error: errorMessage(error),
    })
  } finally {
    processing = false
    await drainIfReady()
  }
}

async function initialise(parsed: MaintenanceWorkerInitRequest): Promise<void> {
  initialising = true
  try {
    if (parsed.catalogDigest !== MAINTENANCE_CATALOG_DIGEST) {
      throw new Error('maintenance-worker-catalog-digest-mismatch')
    }
    appHome = parsed.appHome
    if ('database' in parsed) {
      // The maintenance Worker owns a dedicated, deliberately small pool. It
      // cannot consume the foreground request pool and never opens db.sqlite.
      const runtime = createPostgresqlDatabaseRuntime({
        config: { ...parsed.database, poolMax: Math.min(2, parsed.database.poolMax) },
        generationId: parsed.generationId,
      })
      postgresqlRuntime = runtime
      const client = createPostgresqlDatabaseClient(runtime)
      store = createPostgresqlMaintenanceRunStore(client)
      integrationMaintenanceCommands = composeIntegrationMaintenanceCommands(
        composePostgresqlWebhookDeliveryPersistence(client),
      )
      const taskExecution = createPostgresqlTaskExecutionPersistence(client)
      taskRecoveryOperations = taskExecution.recoveryAdministration
      taskArchiveMaintenanceCommand = createPostgresqlTaskArchiveMaintenanceCommand(client)
      workspaceMaintenanceCommand = createWorkerWorkspaceMaintenanceCommand((isMaterializingTask) =>
        composePostgresqlWorkspaceMaintenanceCommand({
          db: client,
          appHome,
          terminalMaintenance: taskExecution.terminalMaintenance,
          isMaterializingTask,
          invalidateWorkspacePath: invalidateCallGraphIndex,
        }),
      )
      tokenCallAudit = createPostgresqlTokenCallAudit(client)
      pluginGenerationGcCommand = composePostgresqlPluginGenerationGcCommand(
        client,
        createPluginGenerationFilesystemGcPort(join(appHome, 'plugins')),
      )
      maintenanceExecutionFence = createPostgresqlMaintenanceExecutionFence(client)
      developmentAutomationMaintenance =
        composePostgresqlDevelopmentAutomationMaintenanceCommands(client)
      digitalEmployeeMaintenance = composePostgresqlDigitalEmployeeMaintenanceCommands(client)
      const operational = createPostgresqlDatabaseOperationalAdapter({
        runtime,
        contract: buildLogicalSchemaContract(),
      })
      systemOperations = Object.freeze({
        eventsArchive: createEventsArchiveMaintenanceCommand({
          store: createPostgresqlEventsArchiveStore(client),
          logsDir: join(appHome, 'logs'),
        }),
        retention: Object.freeze({
          async runSlice(
            input: Parameters<MaintenanceSystemOperations['retention']['runSlice']>[0],
          ) {
            const result = await runPostgresqlRetentionSweepSlice(
              client,
              input,
              input.cursor,
              Date.now(),
              MAINTENANCE_RETENTION_SLICE_ROWS,
            )
            return {
              counters: { ...result.counters },
              delta: { kind: 'none' as const },
              ...(result.done
                ? {}
                : {
                    continuation: {
                      cursor: result.cursor,
                      resumeAfterMs: CLEANUP_COOLDOWN_MS,
                    },
                  }),
            }
          },
        }),
        storage: Object.freeze({
          async run() {
            return (await operational.runStorageMaintenance()).counters
          },
        }),
      })

      const resourcePackageMaintenance = composePostgresqlResourcePackageApplyMaintenance({
        db: client,
        appHome,
        pluginsDir: join(appHome, 'plugins'),
      })
      const resourcePackageMaintenanceCommand: ResourcePackageApplyMaintenanceCommand =
        resourcePackageMaintenance.command
      const intentMaintenanceLog = createLogger('intentMaintenance')
      intentMaintenanceCommands = composePostgresqlIntentMaintenanceCommandsForAppHome({
        db: client,
        appHome,
        scratchDirectoryName: INTENT_SCRATCH_DIRNAME,
        pluginsDir: join(appHome, 'plugins'),
        resourcePackages: {
          converge: ({ activeApplyIds }) =>
            resourcePackageMaintenanceCommand.converge({ activeApplyIds }),
        },
        log: intentMaintenanceLog,
      })
    } else {
      const sqliteDb = openDb({
        path: parsed.dbPath,
        migrationsFolder: parsed.migrationsFolder,
        skipMigrations: true,
        skipIntegrityCheck: true,
        journalMode: 'preserve',
        synchronous: parsed.sqlite.synchronous,
        pageCacheMib: parsed.sqlite.pageCacheMib,
        mmapMib: parsed.sqlite.mmapMib,
        busyTimeoutMs: parsed.sqlite.busyTimeoutMs,
        slowQueryMs: 0,
        observeStatementMs: (ms) => recordTiming(statementTimings, ms),
        observeTransactionMs: (ms) => recordTiming(transactionTimings, ms),
      })
      db = sqliteDb
      developmentAutomationMaintenance = composeDevelopmentAutomationMaintenanceCommands(sqliteDb)
      digitalEmployeeMaintenance = composeDigitalEmployeeMaintenanceCommands(sqliteDb)
      integrationMaintenanceCommands = composeIntegrationMaintenanceCommands(
        composeSqliteWebhookDeliveryPersistence(sqliteDb),
      )
      const taskExecution = createSqliteTaskExecutionPersistence(sqliteDb)
      taskRecoveryOperations = taskExecution.recoveryAdministration
      taskArchiveMaintenanceCommand = createSqliteTaskArchiveMaintenanceCommand(sqliteDb)
      workspaceMaintenanceCommand = createWorkerWorkspaceMaintenanceCommand((isMaterializingTask) =>
        composeSqliteWorkspaceMaintenanceCommand({
          db: sqliteDb,
          appHome,
          terminalMaintenance: taskExecution.terminalMaintenance,
          isMaterializingTask,
          invalidateWorkspacePath: invalidateCallGraphIndex,
        }),
      )
      systemOperations = Object.freeze({
        eventsArchive: createEventsArchiveMaintenanceCommand({
          store: createSqliteEventsArchiveStore(sqliteDb),
          logsDir: join(appHome, 'logs'),
        }),
        retention: Object.freeze({
          async runSlice(
            input: Parameters<MaintenanceSystemOperations['retention']['runSlice']>[0],
          ) {
            const result = await runRetentionSweepSlice(
              sqliteDb,
              input,
              input.cursor,
              Date.now(),
              MAINTENANCE_RETENTION_SLICE_ROWS,
            )
            return {
              counters: { ...result.counters },
              delta: { kind: 'none' as const },
              ...(result.done
                ? {}
                : {
                    continuation: {
                      cursor: result.cursor,
                      resumeAfterMs: CLEANUP_COOLDOWN_MS,
                    },
                  }),
            }
          },
        }),
        storage: Object.freeze({
          async run() {
            checkpointSqliteWal(sqliteDb)
            return { checkpointed: 1 }
          },
        }),
      })
      const intentMaintenanceLog = createLogger('intentMaintenance')
      const resourcePackageMaintenance = composeSqliteResourcePackageApplyMaintenance({
        db: sqliteDb,
        appHome,
        pluginsDir: join(appHome, 'plugins'),
        activitySource: { activeApplyIds: activeResourceBundleApplyIds },
        log: intentMaintenanceLog,
      })
      const resourcePackageMaintenanceCommand: ResourcePackageApplyMaintenanceCommand =
        resourcePackageMaintenance.command
      intentMaintenanceCommands = composeSqliteIntentMaintenanceCommandsForAppHome({
        db: sqliteDb,
        appHome,
        scratchDirectoryName: INTENT_SCRATCH_DIRNAME,
        resourcePackages: {
          converge: ({ activeApplyIds }) =>
            resourcePackageMaintenanceCommand.converge({ activeApplyIds }),
        },
        log: intentMaintenanceLog,
      })
      tokenCallAudit = createSqliteTokenCallAudit(sqliteDb)
      pluginGenerationGcCommand = composeSqlitePluginGenerationGcCommand(
        sqliteDb,
        createPluginGenerationFilesystemGcPort(join(appHome, 'plugins')),
      )
      maintenanceExecutionFence = createSqliteMaintenanceExecutionFence(sqliteDb)
      store = createSqliteMaintenanceRunStore(sqliteDb)
    }
    await store.recoverRunning(Date.now())
    initialised = true
  } finally {
    initialising = false
  }
  // A drain requested while this init was in flight settles here: the
  // generation never admits work, never arms its timers, and answers the
  // supervisor's pause instead of announcing a readiness it is about to drop.
  if (draining) {
    await drainIfReady()
    return
  }
  pollTimer = setInterval(() => void processQueue(), IDLE_POLL_MS)
  pollTimer.unref?.()
  heartbeatTimer = setInterval(() => {
    const at = Date.now()
    const current = active
    const currentStore = store
    if (current !== null && currentStore !== null && heartbeatInFlight === null) {
      const pending = currentStore
        .heartbeat({
          runId: current.runId,
          leaseToken: current.leaseToken,
          now: at,
          leaseMs: LEASE_MS,
        })
        .then(() => undefined)
        .catch((error: unknown) => {
          // The one-hour lease easily covers a skipped heartbeat. Foreground
          // SQLite contention and PostgreSQL serialization/deadlock retries
          // both keep the same fenced lease for the next heartbeat.
          if (retryableLedgerError(error) === undefined) {
            emit({
              type: 'degraded',
              version: MAINTENANCE_PROTOCOL_VERSION,
              at,
              error: errorMessage(error),
            })
          }
        })
        .finally(() => {
          if (heartbeatInFlight === pending) heartbeatInFlight = null
        })
      heartbeatInFlight = pending
    }
    emit({
      type: 'heartbeat',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at,
      activeRunId: current?.runId ?? null,
    })
  }, HEARTBEAT_MS)
  heartbeatTimer.unref?.()
  emit({
    type: 'ready',
    version: MAINTENANCE_PROTOCOL_VERSION,
    catalogDigest: MAINTENANCE_CATALOG_DIGEST,
    at: Date.now(),
  })
  void processQueue()
}

self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    const action = routeMaintenanceWorkerRequest(
      initialised ? 'ready' : initialising ? 'initialising' : 'idle',
      event.data,
    )
    switch (action.kind) {
      case 'initialise':
        void initialise(action.request).catch(async (error: unknown) => {
          await closeConnection()
          emit({
            type: 'degraded',
            version: MAINTENANCE_PROTOCOL_VERSION,
            at: Date.now(),
            error: errorMessage(error),
          })
          // A drain requested while this init was failing still owes the
          // supervisor its receipt; without it pause waits out its timeout.
          await drainIfReady()
        })
        return
      case 'wake':
        void processQueue()
        return
      case 'drain':
        draining = true
        void drainIfReady()
        return
      case 'defer-drain':
        draining = true
        return
      case 'ignore':
        return
      case 'fail':
        // A misrouted frame is never a reason to tear down a live connection.
        throw new Error(action.error)
    }
  } catch (error) {
    emit({
      type: 'degraded',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at: Date.now(),
      error: errorMessage(error),
    })
  }
}
