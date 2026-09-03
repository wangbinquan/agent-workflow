import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createMemoryDistillQueries } from './application/distillQueries'
import type { MemoryDistillReadStore } from './application/ports/distillReadStore'
import type { MemoryInjectionReadStore } from './application/ports/injectionReadStore'
import type { MemoryResourceScopeAccessParticipant } from './application/ports/resourceScopeAccess'
import type {
  MemoryDistillReviewedArtifactReader,
  MemoryDistillRuntimeResolver,
  MemoryDistillWorkStore,
} from './application/ports/distillWorkStore'
import {
  cancelPendingJob,
  distillTick,
  enqueueDistillJob,
  recoverRunning,
  retryFailedJob,
  startMemoryDistillLoop,
} from '@/services/memoryDistillScheduler'
import { PostgresqlMemoryDistillReadStore } from './infrastructure/postgresqlMemoryDistillReadStore'
import { SqliteMemoryDistillReadStore } from './infrastructure/sqliteMemoryDistillReadStore'
import { PostgresqlMemoryDistillWorkStore } from './infrastructure/postgresqlMemoryDistillWorkStore'
import { SqliteMemoryDistillWorkStore } from './infrastructure/sqliteMemoryDistillWorkStore'
import { PostgresqlMemoryInjectionReadStore } from './infrastructure/postgresqlMemoryInjectionReadStore'
import { SqliteMemoryInjectionReadStore } from './infrastructure/sqliteMemoryInjectionReadStore'
import {
  composePostgresqlMemoryCatalogOperations,
  type PostgresqlMemoryTransaction,
} from './infrastructure/postgresqlMemoryCatalogOperations'
import type { RepositoryScopeAuthorizationInTx } from '@/modules/source-control/public/participants'
import type { DbTxSync } from '@/db/txSync'
import { composeSqliteMemoryCatalogOperations } from './infrastructure/sqliteMemoryCatalogOperations'
import {
  createPostgresqlMemoryDistillSessionCapture,
  createSqliteMemoryDistillSessionCapture,
} from './infrastructure/memoryDistillSessionCapture'
import {
  PostgresqlMemoryDistillRuntimeResolver,
  SqliteMemoryDistillRuntimeResolver,
} from './infrastructure/memoryDistillRuntimeResolver'
import type { MemoryOperations } from './public/operations'
import type { MemoryInjectionQueries } from './public/queries'
import type { MemoryCatalogOperations } from './public/catalog'
import type { DirectCommandContextFactory } from '@/modules/identity-access/public/participants'
import type { MemoryResourceScopeAuthorization } from './infrastructure/sqliteMemoryCatalog'
import type { EnqueueMemoryDistillJobInput, MemoryDistillWorkerOptions } from './public/commands'
import {
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
} from './application/injection/injectMemory'

export { composePostgresqlSkillMemoryFusionParticipantFactory } from './infrastructure/postgresqlSkillMemoryFusionParticipant'

export { composeSqliteMemoryCatalogOperations }

export function composeSqliteMemoryDistillQueries(db: DbClient) {
  return createMemoryDistillQueries(new SqliteMemoryDistillReadStore(db))
}

export function composePostgresqlMemoryDistillQueries(db: PostgresqlDatabaseClient) {
  return createMemoryDistillQueries(new PostgresqlMemoryDistillReadStore(db))
}

function composeMemoryOperations(input: {
  readonly readStore: MemoryDistillReadStore
  readonly workStore: MemoryDistillWorkStore
  readonly runtimeResolver: MemoryDistillRuntimeResolver
  readonly reviewedArtifacts: MemoryDistillReviewedArtifactReader
  readonly injectionQueries: MemoryInjectionQueries
  readonly catalog?: MemoryCatalogOperations
}): MemoryOperations {
  const distillQueries = createMemoryDistillQueries(input.readStore)
  return Object.freeze({
    distillQueries,
    injectionQueries: input.injectionQueries,
    ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
    distillCommands: Object.freeze({
      enqueue: async (command: EnqueueMemoryDistillJobInput) =>
        await enqueueDistillJob(input.workStore, command),
      retryFailed: async (jobId: string) => await retryFailedJob(input.workStore, jobId),
      cancelPending: async (jobId: string) => await cancelPendingJob(input.workStore, jobId),
    }),
    distillWorker: Object.freeze({
      tick: async (options: Omit<MemoryDistillWorkerOptions, 'enabled' | 'intervalMs'> = {}) =>
        await distillTick({
          ...options,
          store: input.workStore,
          reviewedArtifacts: input.reviewedArtifacts,
          runtimeResolver: input.runtimeResolver,
        }),
      start: (options: MemoryDistillWorkerOptions = {}) =>
        startMemoryDistillLoop({
          ...options,
          store: input.workStore,
          reviewedArtifacts: input.reviewedArtifacts,
          runtimeResolver: input.runtimeResolver,
        }),
      recoverRunning: async () => await recoverRunning(input.workStore),
      listJobs: async (filter = {}) => await distillQueries.listJobs(filter),
    }),
  })
}

function composeMemoryInjectionQueries(store: MemoryInjectionReadStore): MemoryInjectionQueries {
  return Object.freeze({
    injectForRun: async (command: Parameters<MemoryInjectionQueries['injectForRun']>[0]) =>
      await injectMemoryForRun({ ...command, store }),
    loadFirstAttemptSnapshot: async (
      command: Parameters<MemoryInjectionQueries['loadFirstAttemptSnapshot']>[0],
    ) => await loadInjectedSnapshotFromFirstAttempt(store, command),
  })
}

export function composeSqliteMemoryInjectionQueries(db: DbClient): MemoryInjectionQueries {
  return composeMemoryInjectionQueries(new SqliteMemoryInjectionReadStore(db))
}

export function composePostgresqlMemoryInjectionQueries(
  db: PostgresqlDatabaseClient,
): MemoryInjectionQueries {
  return composeMemoryInjectionQueries(new PostgresqlMemoryInjectionReadStore(db))
}

export function composeSqliteMemoryOperations(input: {
  readonly db: DbClient
  readonly reviewedArtifacts: MemoryDistillReviewedArtifactReader
  readonly injectionQueries?: MemoryInjectionQueries
  readonly catalogBinding?: {
    readonly contexts: DirectCommandContextFactory
    readonly authorization: MemoryResourceScopeAuthorization
    /**
     * RFC-352 T4：repository / repository-group scope 的授权 participant 由 source-control 提供。
     * 不传就用 source-control 的 SQLite 实现——bootstrap 之外的调用方（测试夹具）不必自己装。
     */
    readonly repositoryScopes?: RepositoryScopeAuthorizationInTx<DbTxSync>
  }
}): MemoryOperations {
  return composeMemoryOperations({
    readStore: new SqliteMemoryDistillReadStore(input.db),
    workStore: new SqliteMemoryDistillWorkStore(
      input.db,
      createSqliteMemoryDistillSessionCapture(input.db),
    ),
    runtimeResolver: new SqliteMemoryDistillRuntimeResolver(input.db),
    reviewedArtifacts: input.reviewedArtifacts,
    injectionQueries: input.injectionQueries ?? composeSqliteMemoryInjectionQueries(input.db),
    ...(input.catalogBinding === undefined
      ? {}
      : {
          catalog: composeSqliteMemoryCatalogOperations({
            db: input.db,
            ...input.catalogBinding,
          }),
        }),
  })
}

export function composePostgresqlMemoryOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly reviewedArtifacts: MemoryDistillReviewedArtifactReader
  readonly injectionQueries?: MemoryInjectionQueries
  readonly catalogBinding?: {
    readonly contexts: DirectCommandContextFactory
    readonly authorization: MemoryResourceScopeAccessParticipant<PostgresqlMemoryTransaction>
  }
}): MemoryOperations {
  return composeMemoryOperations({
    readStore: new PostgresqlMemoryDistillReadStore(input.db),
    workStore: new PostgresqlMemoryDistillWorkStore(
      input.db,
      createPostgresqlMemoryDistillSessionCapture(input.db),
    ),
    runtimeResolver: new PostgresqlMemoryDistillRuntimeResolver(input.db),
    reviewedArtifacts: input.reviewedArtifacts,
    injectionQueries: input.injectionQueries ?? composePostgresqlMemoryInjectionQueries(input.db),
    ...(input.catalogBinding === undefined
      ? {}
      : {
          catalog: composePostgresqlMemoryCatalogOperations({
            db: input.db,
            ...input.catalogBinding,
          }),
        }),
  })
}
