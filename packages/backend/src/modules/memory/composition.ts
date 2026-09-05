import type { ProviderNeutralDatabase } from '@/db/query'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
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
} from './application/distill/schedule'

// RFC-352 T7：bootstrap 只经 composition 取 memory 的东西，不深入 application。
export { setMemoryDistillLangProvider } from './application/distill/schedule'
import { DrizzleMemoryDistillReadStore } from './infrastructure/memoryDistillReadStore'
import { DrizzleMemoryDistillWorkStore } from './infrastructure/memoryDistillWorkStore'
import { DrizzleMemoryInjectionReadStore } from './infrastructure/memoryInjectionReadStore'
import {
  composeMemoryCatalogOperations,
  type MemoryCatalogTestHooks,
  type MemoryTransaction,
} from './infrastructure/memoryCatalogOperations'
import { createMemoryDistillSessionCapture } from './infrastructure/memoryDistillSessionCapture'
import { DrizzleMemoryDistillRuntimeResolver } from './infrastructure/memoryDistillRuntimeResolver'
import type { MemoryOperations } from './public/operations'
import type { MemoryInjectionQueries } from './public/queries'
import type { MemoryCatalogOperations } from './public/catalog'
import type { DirectCommandContextFactory } from '@/modules/identity-access/public/participants'
import type { EnqueueMemoryDistillJobInput, MemoryDistillWorkerOptions } from './public/commands'
import {
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
} from './application/injection/injectMemory'

// RFC-359 W4-D4：memory 的目录 / 融合 participant / 蒸馏运行时解析都只有一份实现，两个 provider 共用；
// provider 只在 bootstrap 交来的数据库客户端上体现。旧的 provider 命名入口保留为装配别名。
export {
  composePostgresqlSkillMemoryFusionParticipantFactory,
  composeSkillMemoryFusionParticipantFactory,
} from './infrastructure/skillMemoryFusionParticipant'
export { composeMemoryCatalogOperations, type MemoryCatalogTestHooks, type MemoryTransaction }
/** 旧名保留为装配别名，PG 装配收敛后删除。 */
export const composeSqliteMemoryCatalogOperations = composeMemoryCatalogOperations
export const composePostgresqlMemoryCatalogOperations = composeMemoryCatalogOperations

// RFC-353 T6/T7：legacy 技能回滚要的 SQLite 同步解融合核心同样从 composition 出。
// **不从 `public/participants` 出**——那会让 public 面直接点名一个 provider 适配器
// （RFC-349 的 provider-cutover 账本明写「只能缩不能涨」）。跨 context 的 provider 装配
// 一律在 bootstrap / system-operation 根上完成，模块之间只交换 provider 中性的端口。
// RFC-359 W4-D5：融合提交的成员关系写入面只剩中立的 `composeSkillMemoryFusionParticipantFactory`。
export { unfuseAboveVersionSync } from './infrastructure/sqliteMemoryMembershipParticipant'

export function composeMemoryDistillQueries(db: ProviderNeutralDatabase) {
  return createMemoryDistillQueries(new DrizzleMemoryDistillReadStore(db))
}
export {
  composeMemoryDistillQueries as composePostgresqlMemoryDistillQueries,
  composeMemoryDistillQueries as composeSqliteMemoryDistillQueries,
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

export function composeMemoryInjectionQueriesFor(
  db: ProviderNeutralDatabase,
): MemoryInjectionQueries {
  return composeMemoryInjectionQueries(new DrizzleMemoryInjectionReadStore(db))
}
export {
  composeMemoryInjectionQueriesFor as composePostgresqlMemoryInjectionQueries,
  composeMemoryInjectionQueriesFor as composeSqliteMemoryInjectionQueries,
}

/** 目录绑定：identity-access 的命令上下文工厂 + resource-catalog 的 scope 访问 participant（两个 provider 同一份）。 */
export interface MemoryCatalogBinding {
  readonly contexts: DirectCommandContextFactory
  readonly authorization: MemoryResourceScopeAccessParticipant<DatabaseTransaction>
  readonly testHooks?: MemoryCatalogTestHooks
}

export function composeMemoryOperationsFor(input: {
  readonly db: ProviderNeutralDatabase
  readonly reviewedArtifacts: MemoryDistillReviewedArtifactReader
  readonly injectionQueries?: MemoryInjectionQueries
  readonly catalogBinding?: MemoryCatalogBinding
}): MemoryOperations {
  return composeMemoryOperations({
    readStore: new DrizzleMemoryDistillReadStore(input.db),
    workStore: new DrizzleMemoryDistillWorkStore(
      input.db,
      createMemoryDistillSessionCapture(input.db),
    ),
    runtimeResolver: new DrizzleMemoryDistillRuntimeResolver(input.db),
    reviewedArtifacts: input.reviewedArtifacts,
    injectionQueries: input.injectionQueries ?? composeMemoryInjectionQueriesFor(input.db),
    ...(input.catalogBinding === undefined
      ? {}
      : {
          catalog: composeMemoryCatalogOperations({
            db: input.db,
            ...input.catalogBinding,
          }),
        }),
  })
}
export {
  composeMemoryOperationsFor as composePostgresqlMemoryOperations,
  composeMemoryOperationsFor as composeSqliteMemoryOperations,
}
