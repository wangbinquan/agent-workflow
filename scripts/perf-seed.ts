// RFC-311 T30 — 基准库生成器(proposal §6:10 万任务 / 300 万 node_runs /
// 千万级事件行 / 10 万 webhook 投递 / 500 仓)。
//
// 不进 CI 门禁;开发机手动跑:
//   bun run scripts/perf-seed.ts --db /tmp/aw-perf/agent-workflow.db
//   bun run scripts/perf-seed.ts --db /tmp/aw-perf/agent-workflow.db --small   # 1% 快速档
//
// 按目标聚合分表批量写入；每张表遵守 provider bind budget，保留原事务分块。
// 生成的数据满足 RFC-311 PR-4 的物化列不变量(branch_started_at = 子树
// max(started_at)),否则 /api/tasks/page 快路径的基准数字不可信。

import { tablesOf } from '../packages/backend/src/platform/persistence/sessionTables'
import { workflowFixture } from '../packages/backend/tests/helpers/model'
import { nodeRunFixtureIdentity } from '../packages/backend/tests/helpers/model/identity'
import { nodeRunFixtureColumns } from '../packages/backend/tests/helpers/model/nodeRun'
import { splitTaskCreation } from '../packages/backend/src/modules/task-execution/domain/taskCreation'
import { taskReadColumns } from '../packages/backend/src/modules/task-execution/infrastructure/taskRepositorySql'
import type { PersistenceInsertValues } from '../packages/backend/src/platform/persistence/singleInsert'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { openDb } from '../packages/backend/src/db/client'
import { createHash } from 'node:crypto'
import { eq, getTableColumns, gt, type Table } from 'drizzle-orm'
import type {
  PersistenceDb,
  PersistenceTx,
} from '../packages/backend/src/platform/persistence/persistenceDb'
import {
  databaseSessionFor,
  type DatabaseSession,
} from '../packages/backend/src/platform/persistence/databaseTransaction'
import {
  PERF_CORPUS_CHUNKS,
  PERF_CORPUS_ENTRY,
  perfCorpusCounts,
  perfCorpusRanges,
  perfDeliveryRow,
  perfEventRow,
  perfNodeRunRow,
  perfRepoRow,
  perfTaskRow,
  type PerfCorpusCounts,
  type PerfCorpusDimensions,
} from './perf-corpus'

interface Args {
  db: string
  tasks: number
  runsPerTask: number
  events: number
  deliveries: number
  repos: number
  reset: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const small = argv.includes('--small')
  const scale = small ? 0.01 : 1
  const num = (name: string, dflt: number): number => {
    const raw = flag(name)
    return raw === undefined ? Math.max(1, Math.round(dflt * scale)) : Number(raw)
  }
  return {
    db: resolve(flag('db') ?? '/tmp/aw-perf/agent-workflow.db'),
    tasks: num('tasks', 100_000),
    runsPerTask: Number(flag('runs-per-task') ?? 30),
    events: num('events', 10_000_000),
    deliveries: num('deliveries', 100_000),
    repos: num('repos', 500),
    reset: argv.includes('--reset'),
  }
}

export interface PerfCorpusSeedProgress {
  readonly table: keyof PerfCorpusCounts
  readonly inserted: number
  readonly total: number
}

export interface PerfCorpusSeedReceipt {
  readonly version: 1
  readonly dimensions: PerfCorpusDimensions
  readonly expectedCounts: PerfCorpusCounts
  readonly actualCounts: PerfCorpusCounts
  readonly expectedDigests: Readonly<Record<keyof PerfCorpusCounts, string>>
  readonly actualDigests: Readonly<Record<keyof PerfCorpusCounts, string>>
  readonly matchesExpected: boolean
}

interface PerfCorpusDatabase {
  /** Both handles must belong to the same already migrated, initialized database. */
  readonly db: PersistenceDb
  readonly session: DatabaseSession
}

/** The existing entry fixture; workflow timestamps retain their database defaults. */
export async function seedPerformanceCorpusEntry({ session }: PerfCorpusDatabase): Promise<void> {
  await session.transaction(async (tx) => {
    await tx
      .insert(tablesOf(tx).users)
      .values({
        id: PERF_CORPUS_ENTRY.userId,
        username: PERF_CORPUS_ENTRY.username,
        displayName: PERF_CORPUS_ENTRY.displayName,
        role: PERF_CORPUS_ENTRY.role,
        createdAt: PERF_CORPUS_ENTRY.now,
        updatedAt: PERF_CORPUS_ENTRY.now,
      })
      .onConflictDoNothing()
    await workflowFixture(
      tx,
      {
        id: PERF_CORPUS_ENTRY.workflowId,
        name: PERF_CORPUS_ENTRY.workflowName,
        definition: PERF_CORPUS_ENTRY.workflowDefinition,
      },
      { onConflict: 'ignore' },
    )
    await tx
      .update(tablesOf(tx).authLoginPolicy)
      .set({ bootstrapCompletedAt: PERF_CORPUS_ENTRY.now })
      .where(eq(tablesOf(tx).authLoginPolicy.id, 'global'))
    await tx
      .insert(tablesOf(tx).userPats)
      .values({
        id: PERF_CORPUS_ENTRY.patId,
        userId: PERF_CORPUS_ENTRY.userId,
        name: PERF_CORPUS_ENTRY.patName,
        tokenHash: new Bun.CryptoHasher('sha256')
          .update(PERF_CORPUS_ENTRY.bearerToken)
          .digest('hex'),
        scopesJson: PERF_CORPUS_ENTRY.patScopesJson,
        createdAt: PERF_CORPUS_ENTRY.now,
      })
      .onConflictDoNothing()
  })
}

interface CorpusRows<Row> {
  readonly table: keyof PerfCorpusCounts
  readonly total: number
  readonly chunk: number
  readonly columnCount: number
  readonly rowAt: (index: number) => Row
  readonly insert: (tx: PersistenceTx, rows: Row[]) => Promise<unknown>
}

async function writeCorpusRows<Row>(
  session: DatabaseSession,
  rows: CorpusRows<Row>,
  onProgress: ((progress: PerfCorpusSeedProgress) => void | Promise<void>) | undefined,
): Promise<void> {
  const batchSize = session.engine.batchInsertMax(rows.columnCount)
  for (const { base, hi } of perfCorpusRanges(rows.total, rows.chunk)) {
    await session.transaction(async (tx) => {
      for (let offset = base; offset < hi; offset += batchSize) {
        const batch: Row[] = []
        for (let i = offset; i < Math.min(offset + batchSize, hi); i += 1) {
          batch.push(rows.rowAt(i))
        }
        await rows.insert(tx, batch)
      }
    })
    // Reporting is outside the committed old-sized transaction, including async reporters.
    await onProgress?.({ table: rows.table, inserted: hi, total: rows.total })
  }
}

async function insertBatches<T extends Table>(
  tx: PersistenceTx,
  session: DatabaseSession,
  table: T,
  values: PersistenceInsertValues<T>[],
): Promise<void> {
  const size = session.engine.batchInsertMax(Object.keys(getTableColumns(table)).length)
  for (let offset = 0; offset < values.length; offset += size)
    await tx
      .insert(table)
      .values(values.slice(offset, offset + size))
      .onConflictDoNothing()
}

async function writeTaskCorpus(
  session: DatabaseSession,
  dimensions: PerfCorpusDimensions,
  onProgress: ((progress: PerfCorpusSeedProgress) => void | Promise<void>) | undefined,
): Promise<void> {
  for (const { base, hi } of perfCorpusRanges(dimensions.tasks, PERF_CORPUS_CHUNKS.tasks)) {
    await session.transaction(async (tx) => {
      const tables = tablesOf(tx)
      const splits = Array.from({ length: hi - base }, (_, offset) => {
        const row = perfTaskRow(base + offset, dimensions)
        const split = splitTaskCreation({
          subject: { kind: 'workflow', sourceId: row.workflowId },
          core: { ...row, catalogVisibility: 'public' },
          definition: {
            definitionOrigin: 'authored',
            workflowSnapshot: row.workflowSnapshot,
            workflowVersion: null,
            inputs: row.inputs,
          },
          launch: { kind: 'root', launchOrigin: row.launchOrigin },
          launchContext: {},
          workspace: { ...row, baseCommit: null, spaceKind: 'local' },
          repos: [],
          nodePaths: [],
        })
        return {
          ...split,
          task: { ...split.task, rootTaskId: row.rootTaskId },
          launchContext: {
            ...split.launchContext,
            executionLineageId: row.executionLineageId,
            lineageSlotPathJson: row.lineageSlotPathJson,
          },
        }
      })
      await insertBatches(
        tx,
        session,
        tables.tasks,
        splits.map((split) => split.task),
      )
      await insertBatches(
        tx,
        session,
        tables.taskDefinitions,
        splits.map((split) => split.definition),
      )
      await insertBatches(
        tx,
        session,
        tables.taskLaunchContexts,
        splits.map((split) => split.launchContext),
      )
      await insertBatches(
        tx,
        session,
        tables.taskWorkspaces,
        splits.map((split) => split.workspace),
      )
      await insertBatches(
        tx,
        session,
        tables.taskExecutionGenerations,
        splits.map((split) => split.generation),
      )
      await insertBatches(
        tx,
        session,
        tables.taskRepositoryMounts,
        splits.flatMap((split) => split.mounts),
      )
      await insertBatches(
        tx,
        session,
        tables.taskSpaceNodes,
        splits.map((split) => ({
          taskId: split.task.id,
          nodePath: '',
          schemaVersion: 1,
        })),
      )
    })
    await onProgress?.({ table: 'tasks', inserted: hi, total: dimensions.tasks })
  }
}

async function writeRunCorpus(
  session: DatabaseSession,
  dimensions: PerfCorpusDimensions,
  onProgress: ((progress: PerfCorpusSeedProgress) => void | Promise<void>) | undefined,
): Promise<void> {
  const total = dimensions.tasks * dimensions.runsPerTask
  for (const { base, hi } of perfCorpusRanges(total, PERF_CORPUS_CHUNKS.nodeRuns)) {
    await session.transaction(async (tx) => {
      const tables = tablesOf(tx)
      const { nodeRunSeqAllocations } = tablesOf(tx)
      const rows = Array.from({ length: hi - base }, (_, offset) =>
        perfNodeRunRow(base + offset, dimensions),
      )
      const sequences = new Map<string, number>()
      const size = session.engine.batchInsertMax(
        Object.keys(getTableColumns(nodeRunSeqAllocations)).length,
      )
      for (let offset = 0; offset < rows.length; offset += size) {
        const allocated = await tx
          .insert(nodeRunSeqAllocations)
          .values(
            rows.slice(offset, offset + size).map((row) => ({
              taskId: row.taskId,
              nodeRunId: row.id,
              allocatedAt: row.startedAt,
            })),
          )
          .returning({ nodeRunId: nodeRunSeqAllocations.nodeRunId, seq: nodeRunSeqAllocations.seq })
        for (const row of allocated) sequences.set(row.nodeRunId, row.seq)
      }
      const roots = rows.map(({ retryIndex, ...row }) => ({
        ...row,
        ...nodeRunFixtureIdentity(row),
        seq: sequences.get(row.id)!,
        historicalParentId: null,
        attemptIndex: retryIndex,
        generationSeq: 0,
        inputsRecorded: false,
        recordMode: 'executable' as const,
        provenanceQuality: 'recorded' as const,
        envelopeNonce: 'fixture:' + row.id,
      }))
      await insertBatches(tx, session, tables.nodeRuns, roots)
      // The corpus has no config/process/result facts; row-presence therefore creates no such companions.
      await insertBatches(
        tx,
        session,
        tables.nodeRunSelections,
        roots.map((row) => ({
          taskId: row.taskId,
          slotKey: row.slotKey,
          selectedRunId: row.id,
          revision: 1,
          generationSeq: 0,
          cause: 'fixture',
          selectedAt: row.startedAt,
        })),
      )
    })
    await onProgress?.({ table: 'nodeRuns', inserted: hi, total })
  }
}

/**
 * The async sink consumes the same rows as the native SQLite CLI. The caller supplies
 * a real initialized database; schema migration, generation activation and ANALYZE
 * remain with the benchmark application's existing runtime lifecycle.
 */
export async function seedPerformanceCorpus(
  options: PerfCorpusDatabase & {
    readonly dimensions: PerfCorpusDimensions
    readonly onProgress?: (progress: PerfCorpusSeedProgress) => void | Promise<void>
  },
): Promise<PerfCorpusSeedReceipt> {
  const { db, session, dimensions, onProgress } = options
  await seedPerformanceCorpusEntry(options)
  await writeCorpusRows(
    session,
    {
      table: 'cachedRepos',
      total: dimensions.repos,
      chunk: Math.max(1, dimensions.repos),
      columnCount: Object.keys(getTableColumns(tablesOf(options.db).cachedRepos)).length,
      rowAt: (i) => {
        const row = perfRepoRow(i)
        return {
          ...row,
          hasSubmodules: row.hasSubmodules === null ? null : row.hasSubmodules === 1,
          lastSubmoduleSyncOk: row.lastSubmoduleSyncOk === 1,
        }
      },
      insert: async (tx, rows) =>
        await tx.insert(tablesOf(tx).cachedRepos).values(rows).onConflictDoNothing(),
    },
    onProgress,
  )
  await writeTaskCorpus(session, dimensions, onProgress)
  await writeRunCorpus(session, dimensions, onProgress)
  await writeCorpusRows(
    session,
    {
      table: 'nodeRunEvents',
      total: dimensions.events,
      chunk: PERF_CORPUS_CHUNKS.nodeRunEvents,
      columnCount: Object.keys(getTableColumns(tablesOf(options.db).nodeRunEvents)).length,
      rowAt: (i) => perfEventRow(i, dimensions),
      // Preserve the original append-on-reseed event IDs, generated by the database.
      insert: async (tx, rows) => await tx.insert(tablesOf(tx).nodeRunEvents).values(rows),
    },
    onProgress,
  )
  await writeCorpusRows(
    session,
    {
      table: 'webhookDeliveries',
      total: dimensions.deliveries,
      chunk: PERF_CORPUS_CHUNKS.webhookDeliveries,
      columnCount: Object.keys(getTableColumns(tablesOf(options.db).webhookDeliveries)).length,
      rowAt: perfDeliveryRow,
      insert: async (tx, rows) =>
        await tx.insert(tablesOf(tx).webhookDeliveries).values(rows).onConflictDoNothing(),
    },
    onProgress,
  )
  return await readPerformanceCorpusReceipt(db, dimensions)
}

function expectedDigest(total: number, rowAt: (index: number) => object): string {
  const hash = createHash('sha256')
  for (let i = 0; i < total; i += 1) {
    hash.update(JSON.stringify(Object.values(rowAt(i))) + '\n')
  }
  return hash.digest('hex')
}

const RECEIPT_PAGE_SIZE = 500

async function readDigest<Id extends string | number, Row extends { readonly id: Id }>(
  page: (after: Id | undefined) => Promise<Row[]>,
  values: (row: Row) => object = (row) => row,
): Promise<{ readonly count: number; readonly digest: string }> {
  const hash = createHash('sha256')
  let count = 0
  let after: Id | undefined
  for (;;) {
    const rows = await page(after)
    for (const row of rows) {
      hash.update(JSON.stringify(Object.values(values(row))) + '\n')
      count += 1
    }
    if (rows.length < RECEIPT_PAGE_SIZE) break
    after = rows[rows.length - 1]!.id
  }
  return { count, digest: hash.digest('hex') }
}

/** Ordered keyset reads cover every row, so pre-existing or appended data fails equality. */
export async function readPerformanceCorpusReceipt(
  db: PersistenceDb,
  dimensions: PerfCorpusDimensions,
): Promise<PerfCorpusSeedReceipt> {
  const expectedCounts = perfCorpusCounts(dimensions)
  const expectedDigests = {
    cachedRepos: expectedDigest(dimensions.repos, perfRepoRow),
    tasks: expectedDigest(dimensions.tasks, (i) => perfTaskRow(i, dimensions)),
    nodeRuns: expectedDigest(expectedCounts.nodeRuns, (i) => perfNodeRunRow(i, dimensions)),
    nodeRunEvents: expectedDigest(dimensions.events, (i) => ({
      id: i + 1,
      ...perfEventRow(i, dimensions),
    })),
    webhookDeliveries: expectedDigest(dimensions.deliveries, perfDeliveryRow),
  }
  const actual = await databaseSessionFor(db).snapshotRead(async (tx) => {
    const repos = await readDigest(
      async (after: string | undefined) =>
        await tx
          .select({
            id: tablesOf(tx).cachedRepos.id,
            urlHash: tablesOf(tx).cachedRepos.urlHash,
            urlRedacted: tablesOf(tx).cachedRepos.urlRedacted,
            localPath: tablesOf(tx).cachedRepos.localPath,
            defaultBranch: tablesOf(tx).cachedRepos.defaultBranch,
            lastFetchedAt: tablesOf(tx).cachedRepos.lastFetchedAt,
            createdAt: tablesOf(tx).cachedRepos.createdAt,
            lastAutoRefreshAt: tablesOf(tx).cachedRepos.lastAutoRefreshAt,
            hasSubmodules: tablesOf(tx).cachedRepos.hasSubmodules,
            lastSubmoduleSyncOk: tablesOf(tx).cachedRepos.lastSubmoduleSyncOk,
          })
          .from(tablesOf(tx).cachedRepos)
          .where(after === undefined ? undefined : gt(tablesOf(tx).cachedRepos.id, after))
          .orderBy(tablesOf(tx).cachedRepos.id)
          .limit(RECEIPT_PAGE_SIZE),
      (row) => ({
        ...row,
        hasSubmodules: row.hasSubmodules === null ? null : Number(row.hasSubmodules),
        lastSubmoduleSyncOk:
          row.lastSubmoduleSyncOk === null ? null : Number(row.lastSubmoduleSyncOk),
      }),
    )
    const taskRows = await readDigest(
      async (after: string | undefined) =>
        await tx
          .select({
            id: tablesOf(tx).tasks.id,
            name: tablesOf(tx).tasks.name,
            workflowId: taskReadColumns(tx).workflowId,
            workflowSnapshot: taskReadColumns(tx).workflowSnapshot,
            repoPath: taskReadColumns(tx).repoPath,
            worktreePath: taskReadColumns(tx).worktreePath,
            baseBranch: taskReadColumns(tx).baseBranch,
            branch: taskReadColumns(tx).branch,
            status: tablesOf(tx).tasks.status,
            inputs: taskReadColumns(tx).inputs,
            startedAt: tablesOf(tx).tasks.startedAt,
            finishedAt: tablesOf(tx).tasks.finishedAt,
            runningMs: tablesOf(tx).tasks.runningMs,
            ownerUserId: tablesOf(tx).tasks.ownerUserId,
            launchOrigin: taskReadColumns(tx).launchOrigin,
            parentTaskId: tablesOf(tx).tasks.parentTaskId,
            invocationDepth: tablesOf(tx).tasks.invocationDepth,
            cachedRepoId: taskReadColumns(tx).cachedRepoId,
            branchStartedAt: tablesOf(tx).tasks.branchStartedAt,
            rootTaskId: tablesOf(tx).tasks.rootTaskId,
            executionLineageId: taskReadColumns(tx).executionLineageId,
            lineageSlotPathJson: taskReadColumns(tx).lineageSlotPathJson,
          })
          .from(tablesOf(tx).tasks)
          .where(after === undefined ? undefined : gt(tablesOf(tx).tasks.id, after))
          .orderBy(tablesOf(tx).tasks.id)
          .limit(RECEIPT_PAGE_SIZE),
    )
    const runs = await readDigest(
      async (after: string | undefined) =>
        await tx
          .select({
            id: tablesOf(tx).nodeRuns.id,
            taskId: tablesOf(tx).nodeRuns.taskId,
            nodeId: tablesOf(tx).nodeRuns.nodeId,
            status: tablesOf(tx).nodeRuns.status,
            iteration: tablesOf(tx).nodeRuns.iteration,
            retryIndex: nodeRunFixtureColumns(tx).retryIndex,
            startedAt: tablesOf(tx).nodeRuns.startedAt,
            finishedAt: tablesOf(tx).nodeRuns.finishedAt,
            continuationSlotKey: tablesOf(tx).nodeRuns.continuationSlotKey,
            lineageSlotPathJson: tablesOf(tx).nodeRuns.lineageSlotPathJson,
            scopePath: tablesOf(tx).nodeRuns.scopePath,
          })
          .from(tablesOf(tx).nodeRuns)
          .where(after === undefined ? undefined : gt(tablesOf(tx).nodeRuns.id, after))
          .orderBy(tablesOf(tx).nodeRuns.id)
          .limit(RECEIPT_PAGE_SIZE),
    )
    const events = await readDigest(
      async (after: number | undefined) =>
        await tx
          .select({
            id: tablesOf(tx).nodeRunEvents.id,
            nodeRunId: tablesOf(tx).nodeRunEvents.nodeRunId,
            ts: tablesOf(tx).nodeRunEvents.ts,
            kind: tablesOf(tx).nodeRunEvents.kind,
            payload: tablesOf(tx).nodeRunEvents.payload,
          })
          .from(tablesOf(tx).nodeRunEvents)
          .where(after === undefined ? undefined : gt(tablesOf(tx).nodeRunEvents.id, after))
          .orderBy(tablesOf(tx).nodeRunEvents.id)
          .limit(RECEIPT_PAGE_SIZE),
    )
    const deliveries = await readDigest(
      async (after: string | undefined) =>
        await tx
          .select({
            id: tablesOf(tx).webhookDeliveries.id,
            endpointId: tablesOf(tx).webhookDeliveries.endpointId,
            eventUuid: tablesOf(tx).webhookDeliveries.eventUuid,
            objectKind: tablesOf(tx).webhookDeliveries.objectKind,
            eventType: tablesOf(tx).webhookDeliveries.eventType,
            status: tablesOf(tx).webhookDeliveries.status,
            receivedAt: tablesOf(tx).webhookDeliveries.receivedAt,
            bodyJson: tablesOf(tx).webhookDeliveries.bodyJson,
          })
          .from(tablesOf(tx).webhookDeliveries)
          .where(after === undefined ? undefined : gt(tablesOf(tx).webhookDeliveries.id, after))
          .orderBy(tablesOf(tx).webhookDeliveries.id)
          .limit(RECEIPT_PAGE_SIZE),
    )
    return {
      cachedRepos: repos,
      tasks: taskRows,
      nodeRuns: runs,
      nodeRunEvents: events,
      webhookDeliveries: deliveries,
    }
  })
  const actualCounts = {
    cachedRepos: actual.cachedRepos.count,
    tasks: actual.tasks.count,
    nodeRuns: actual.nodeRuns.count,
    nodeRunEvents: actual.nodeRunEvents.count,
    webhookDeliveries: actual.webhookDeliveries.count,
  }
  const actualDigests = {
    cachedRepos: actual.cachedRepos.digest,
    tasks: actual.tasks.digest,
    nodeRuns: actual.nodeRuns.digest,
    nodeRunEvents: actual.nodeRunEvents.digest,
    webhookDeliveries: actual.webhookDeliveries.digest,
  }
  return {
    version: 1,
    dimensions,
    expectedCounts,
    actualCounts,
    expectedDigests,
    actualDigests,
    matchesExpected:
      JSON.stringify(actualCounts) === JSON.stringify(expectedCounts) &&
      JSON.stringify(actualDigests) === JSON.stringify(expectedDigests),
  }
}

async function runSqliteSeed(): Promise<void> {
  const args = parseArgs()
  const migrationsFolder = resolve(import.meta.dir, '../packages/backend/db/migrations')
  if (args.reset)
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(args.db + suffix)) rmSync(args.db + suffix)
  mkdirSync(dirname(args.db), { recursive: true })
  const db = openDb({ path: args.db, migrationsFolder })
  try {
    const receipt = await seedPerformanceCorpus({
      db,
      session: databaseSessionFor(db),
      dimensions: args,
      onProgress: ({ table, inserted, total }) => {
        console.log(`[perf-seed] ${table}: ${inserted}/${total}`)
      },
    })
    if (!receipt.matchesExpected) throw new Error('performance-corpus-receipt-mismatch')
    db.$client.exec('ANALYZE; PRAGMA wal_checkpoint(TRUNCATE);')
    console.log(`[perf-seed] done: ${args.db}`)
  } finally {
    db.$client.close()
  }
}
if (import.meta.main) await runSqliteSeed()
