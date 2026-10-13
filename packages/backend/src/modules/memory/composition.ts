import type { NodeRunPromptReader } from '@/modules/task-execution/public/queries'
import type { SystemAgentRunFamily } from '@/modules/task-execution/public/participants'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { createMemoryDistillQueries } from './application/distillQueries'
import { recoverOriginalMemoryExecution } from './application/distill/recoverExecution'
import type { MemoryDistillExecutionRecord } from './application/ports/distillExecutionJournal'
import type { MemoryDistillReadStore } from './application/ports/distillReadStore'
import type { MemoryInjectionReadStore } from './application/ports/injectionReadStore'
import type { MemoryResourceScopeAccessParticipant } from './application/ports/resourceScopeAccess'
import type {
  MemoryDistillReviewedArtifactReader,
  MemoryDistillRuntimeResolver,
  MemoryDistillWorkStore,
  ResolvedMemoryDistillRuntime,
  SelectedMemoryDistillRuntime,
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
export { setMemoryDistillPolicyProvider } from './application/distill/schedule'
import { IndeterminateRuntimeProcessError } from './application/distill/memoryDistiller'
export { IndeterminateRuntimeProcessError }
import { MemoryDistillSettlementPendingError } from './application/distill/settlement'
export { MemoryDistillSettlementPendingError }
import { DrizzleMemoryDistillReadStore } from './infrastructure/memoryDistillReadStore'
import { DrizzleMemoryDistillWorkStore } from './infrastructure/memoryDistillWorkStore'
import { DrizzleMemoryInjectionReadStore } from './infrastructure/memoryInjectionReadStore'
import {
  composeMemoryCatalogOperations,
  type MemoryCatalogTestHooks,
  type MemoryTransaction,
} from './infrastructure/memoryCatalogOperations'
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
export { composeSkillMemoryFusionParticipantFactory } from './infrastructure/skillMemoryFusionParticipant'
export { composeMemoryCatalogOperations, type MemoryCatalogTestHooks, type MemoryTransaction }
/** 旧名保留为装配别名，PG 装配收敛后删除。 */

// RFC-353 T6/T7：legacy 技能回滚要的 SQLite 同步解融合核心同样从 composition 出。
// **不从 `public/participants` 出**——那会让 public 面直接点名一个 provider 适配器
// （RFC-349 的 provider-cutover 账本明写「只能缩不能涨」）。跨 context 的 provider 装配
// 一律在 bootstrap / system-operation 根上完成，模块之间只交换 provider 中性的端口。
// RFC-359 W4-D5：融合提交的成员关系写入面只剩中立的 `composeSkillMemoryFusionParticipantFactory`。

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
  readonly systemAgents: SystemAgentRunFamily
  readonly reviewedArtifacts: MemoryDistillReviewedArtifactReader
  readonly nodeRunPrompts: NodeRunPromptReader
  readonly injectionQueries: MemoryInjectionQueries
  readonly catalog?: MemoryCatalogOperations
}): MemoryOperations {
  const distillQueries = createMemoryDistillQueries(input.readStore)
  const originalExecutions = new Map<
    string,
    IndeterminateRuntimeProcessError | MemoryDistillSettlementPendingError
  >()
  const continuations = new Map<string, readonly MemoryDistillExecutionRecord[]>()
  let activeSelectedTicks = 0
  const journal = input.workStore.executionJournal
  const loadOpen = journal.listOpen.bind(journal),
    loadHistory = journal.findByJob.bind(journal)
  const originalRecords = async (jobId: string, attemptIndex: number) =>
    (await loadHistory(jobId)).filter((row) => row.attemptIndex === attemptIndex)
  const recoverPersisted = async (
    records: readonly MemoryDistillExecutionRecord[],
    explicit: boolean,
  ) => {
    const result = await recoverOriginalMemoryExecution({
      store: input.workStore,
      systemAgents: input.systemAgents,
      records,
      now: Date.now,
      allowPhysicalRecovery: explicit,
    })
    if (result.kind === 'continuation') continuations.set(result.records[0]!.jobId, result.records)
    else if (result.kind === 'settled' && records[0]) continuations.delete(records[0].jobId)
    return result
  }
  const retainDurableRecovery = (records: readonly MemoryDistillExecutionRecord[]) => {
    const head = records[0]!
    const recover = async (explicit: boolean) =>
      recoverPersisted(await originalRecords(head.jobId, head.attemptIndex), explicit)
    const error = new IndeterminateRuntimeProcessError(
      'original durable distillation still requires recovery',
      async () => (await recover(true)).kind !== 'unproven',
    )
    error.retainOriginalSettlement(
      head.original.map((row) => row.id),
      async () => {
        if ((await recover(false)).kind === 'unproven')
          throw new Error('memory-distill-original-durable-recovery-unproven')
      },
    )
    for (const id of error.originalJobIds) originalExecutions.set(id, error)
    return error
  }
  const retainOriginalFailure = (error: unknown) => {
    if (
      error instanceof IndeterminateRuntimeProcessError ||
      error instanceof MemoryDistillSettlementPendingError
    )
      for (const id of error.originalJobIds) originalExecutions.set(id, error)
  }
  const unacknowledgedExecution = () =>
    [...new Set(originalExecutions.values())].find((original) =>
      original instanceof IndeterminateRuntimeProcessError
        ? !original.originalRecoveryAcknowledged()
        : !original.originalSettlementAcknowledged(),
    )
  return Object.freeze({
    distillQueries,
    injectionQueries: input.injectionQueries,
    ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
    distillCommands: Object.freeze({
      enqueue: async (command: EnqueueMemoryDistillJobInput) =>
        await enqueueDistillJob(input.workStore, command),
      retryFailed: async (jobId: string) => await retryFailedJob(input.workStore, jobId),
      cancelPending: async (jobId: string) => await cancelPendingJob(input.workStore, jobId),
      async recoverIssued(jobId: string) {
        const original = originalExecutions.get(jobId)
        if (original === undefined) {
          // The running original owner still receives this execution's result.
          // A cold recovery command must not steal a normally active attempt.
          if (activeSelectedTicks > 0) return false
          const open = await loadOpen()
          const selected = open.find((row) => row.original.some((subject) => subject.id === jobId))
          const history = selected
            ? await originalRecords(selected.jobId, selected.attemptIndex)
            : await loadHistory(jobId)
          if (history.length === 0) return false
          const attempt = Math.max(...history.map((row) => row.attemptIndex))
          const result = await recoverPersisted(
            history.filter((row) => row.attemptIndex === attempt),
            true,
          )
          return result.kind !== 'unproven'
        }
        if (original instanceof IndeterminateRuntimeProcessError)
          return await original.recoverOriginal()
        try {
          await original.retryOriginalSettlement()
        } catch (error) {
          if (!(error instanceof IndeterminateRuntimeProcessError)) throw error
          retainOriginalFailure(error)
          return await error.recoverOriginal()
        }
        return original.originalSettlementAcknowledged()
      },
    }),
    distillWorker: Object.freeze({
      async tick(options: Omit<MemoryDistillWorkerOptions, 'enabled' | 'intervalMs'> = {}) {
        const unacknowledged = unacknowledgedExecution()
        if (unacknowledged) throw unacknowledged
        const continuationKey = continuations.keys().next().value
        const continuation =
          continuationKey === undefined ? undefined : continuations.get(continuationKey)
        if (continuation !== undefined && options.execution === undefined)
          throw new Error('memory-distill-durable-continuation-requires-execution-authority')
        const selected = options.execution !== undefined
        if (selected) activeSelectedTicks += 1
        try {
          return await distillTick({
            ...options,
            ...(continuation === undefined ? {} : { restore: continuation }),
            store: input.workStore,
            reviewedArtifacts: input.reviewedArtifacts,
            nodeRunPrompts: input.nodeRunPrompts,
            runtimeResolver: input.runtimeResolver,
            systemAgents: input.systemAgents,
            retainOriginalFailure,
          }).then((result) => {
            if (continuationKey !== undefined && result.picked > 0)
              continuations.delete(continuationKey)
            return result
          })
        } catch (error) {
          retainOriginalFailure(error)
          throw error
        } finally {
          if (selected) activeSelectedTicks -= 1
        }
      },
      start: (options: MemoryDistillWorkerOptions = {}) =>
        startMemoryDistillLoop({
          ...options,
          store: input.workStore,
          reviewedArtifacts: input.reviewedArtifacts,
          nodeRunPrompts: input.nodeRunPrompts,
          runtimeResolver: input.runtimeResolver,
          systemAgents: input.systemAgents,
        }),
      async recoverRunning() {
        const unacknowledged = unacknowledgedExecution()
        if (unacknowledged) throw unacknowledged
        const open = await loadOpen()
        const groups = new Map<string, readonly MemoryDistillExecutionRecord[]>()
        for (const row of open)
          if (!groups.has(row.jobId + ':' + row.attemptIndex))
            groups.set(
              row.jobId + ':' + row.attemptIndex,
              await originalRecords(row.jobId, row.attemptIndex),
            )
        for (const records of groups.values())
          if ((await recoverPersisted(records, false)).kind === 'unproven')
            throw retainDurableRecovery(records)
        const preserved = [...continuations.values()].flatMap((records) =>
          records[0]!.original.map((row) => row.id),
        )
        return await recoverRunning(input.workStore, preserved)
      },
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

export interface ComposeMemoryOperationsOptions {
  readonly db: ProviderNeutralDatabase
  readonly reviewedArtifacts: MemoryDistillReviewedArtifactReader
  readonly nodeRunPrompts: NodeRunPromptReader
  readonly systemAgentBinding: {
    readonly family: SystemAgentRunFamily
    bindRuntime(runtime: ResolvedMemoryDistillRuntime): SelectedMemoryDistillRuntime
  }
  readonly injectionQueries?: MemoryInjectionQueries
  readonly catalogBinding?: MemoryCatalogBinding
}

export interface MemoryOperationsWithCatalog extends MemoryOperations {
  readonly catalog: MemoryCatalogOperations
}

/** A supplied catalog binding constructs the catalog in this call, for either provider. */
export function composeMemoryOperationsFor(
  input: ComposeMemoryOperationsOptions & { readonly catalogBinding: MemoryCatalogBinding },
): MemoryOperationsWithCatalog
export function composeMemoryOperationsFor(input: ComposeMemoryOperationsOptions): MemoryOperations
export function composeMemoryOperationsFor(
  input: ComposeMemoryOperationsOptions,
): MemoryOperations {
  const nativeRuntimeResolver = new DrizzleMemoryDistillRuntimeResolver(input.db)
  return composeMemoryOperations({
    readStore: new DrizzleMemoryDistillReadStore(input.db),
    workStore: new DrizzleMemoryDistillWorkStore(input.db),
    runtimeResolver: {
      async resolve(request) {
        return input.systemAgentBinding.bindRuntime(await nativeRuntimeResolver.resolve(request))
      },
    },
    systemAgents: input.systemAgentBinding.family,
    reviewedArtifacts: input.reviewedArtifacts,
    nodeRunPrompts: input.nodeRunPrompts,
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
