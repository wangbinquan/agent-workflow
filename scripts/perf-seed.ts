// RFC-311 T30 — 基准库生成器(proposal §6:10 万任务 / 300 万 node_runs /
// 千万级事件行 / 10 万 webhook 投递 / 500 仓)。
//
// 不进 CI 门禁;开发机手动跑:
//   bun run scripts/perf-seed.ts --db /tmp/aw-perf/agent-workflow.db
//   bun run scripts/perf-seed.ts --db /tmp/aw-perf/agent-workflow.db --small   # 1% 快速档
//
// 写入姿势:openDb 先把迁移与 PRAGMA 铺好,随后用第二条 bun:sqlite 原生连接
// (WAL 允许并存)以 prepared statement + 大事务批量写——比走 ORM 快一个量级。
// 生成的数据满足 RFC-311 PR-4 的物化列不变量(branch_started_at = 子树
// max(started_at)),否则 /api/tasks/page 快路径的基准数字不可信。

import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { openDb } from '../packages/backend/src/db/client'
import { createHash } from 'node:crypto'
import { eq, getTableColumns, gt } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '../packages/backend/src/db/query'
import {
  authLoginPolicy,
  cachedRepos,
  nodeRunEvents,
  nodeRuns,
  tasks,
  userPats,
  users,
  webhookDeliveries,
  workflows,
} from '../packages/backend/src/db/schema'
import {
  databaseSessionFor,
  type DatabaseSession,
  type DatabaseTransaction,
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
  readonly db: ProviderNeutralDatabase
  readonly session: DatabaseSession
}

/** The existing entry fixture; workflow timestamps retain their database defaults. */
export async function seedPerformanceCorpusEntry({ session }: PerfCorpusDatabase): Promise<void> {
  await session.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({
        id: PERF_CORPUS_ENTRY.userId,
        username: PERF_CORPUS_ENTRY.username,
        displayName: PERF_CORPUS_ENTRY.displayName,
        role: PERF_CORPUS_ENTRY.role,
        createdAt: PERF_CORPUS_ENTRY.now,
        updatedAt: PERF_CORPUS_ENTRY.now,
      })
      .onConflictDoNothing()
      .run()
    await tx
      .insert(workflows)
      .values({
        id: PERF_CORPUS_ENTRY.workflowId,
        name: PERF_CORPUS_ENTRY.workflowName,
        definition: PERF_CORPUS_ENTRY.workflowDefinition,
      })
      .onConflictDoNothing()
      .run()
    await tx
      .update(authLoginPolicy)
      .set({ bootstrapCompletedAt: PERF_CORPUS_ENTRY.now })
      .where(eq(authLoginPolicy.id, 'global'))
      .run()
    await tx
      .insert(userPats)
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
      .run()
  })
}

interface CorpusRows<Row> {
  readonly table: keyof PerfCorpusCounts
  readonly total: number
  readonly chunk: number
  readonly columnCount: number
  readonly rowAt: (index: number) => Row
  readonly insert: (tx: DatabaseTransaction, rows: Row[]) => Promise<unknown>
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
      columnCount: Object.keys(getTableColumns(cachedRepos)).length,
      rowAt: (i) => {
        const row = perfRepoRow(i)
        return {
          ...row,
          hasSubmodules: row.hasSubmodules === null ? null : row.hasSubmodules === 1,
          lastSubmoduleSyncOk: row.lastSubmoduleSyncOk === 1,
        }
      },
      insert: async (tx, rows) =>
        await tx.insert(cachedRepos).values(rows).onConflictDoNothing().run(),
    },
    onProgress,
  )
  await writeCorpusRows(
    session,
    {
      table: 'tasks',
      total: dimensions.tasks,
      chunk: PERF_CORPUS_CHUNKS.tasks,
      columnCount: Object.keys(getTableColumns(tasks)).length,
      rowAt: (i) => perfTaskRow(i, dimensions),
      insert: async (tx, rows) => await tx.insert(tasks).values(rows).onConflictDoNothing().run(),
    },
    onProgress,
  )
  await writeCorpusRows(
    session,
    {
      table: 'nodeRuns',
      total: dimensions.tasks * dimensions.runsPerTask,
      chunk: PERF_CORPUS_CHUNKS.nodeRuns,
      columnCount: Object.keys(getTableColumns(nodeRuns)).length,
      rowAt: (i) => perfNodeRunRow(i, dimensions),
      insert: async (tx, rows) =>
        await tx.insert(nodeRuns).values(rows).onConflictDoNothing().run(),
    },
    onProgress,
  )
  await writeCorpusRows(
    session,
    {
      table: 'nodeRunEvents',
      total: dimensions.events,
      chunk: PERF_CORPUS_CHUNKS.nodeRunEvents,
      columnCount: Object.keys(getTableColumns(nodeRunEvents)).length,
      rowAt: (i) => perfEventRow(i, dimensions),
      // Preserve the original append-on-reseed event IDs, generated by the database.
      insert: async (tx, rows) => await tx.insert(nodeRunEvents).values(rows).run(),
    },
    onProgress,
  )
  await writeCorpusRows(
    session,
    {
      table: 'webhookDeliveries',
      total: dimensions.deliveries,
      chunk: PERF_CORPUS_CHUNKS.webhookDeliveries,
      columnCount: Object.keys(getTableColumns(webhookDeliveries)).length,
      rowAt: perfDeliveryRow,
      insert: async (tx, rows) =>
        await tx.insert(webhookDeliveries).values(rows).onConflictDoNothing().run(),
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
  db: ProviderNeutralDatabase,
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
            id: cachedRepos.id,
            urlHash: cachedRepos.urlHash,
            urlRedacted: cachedRepos.urlRedacted,
            localPath: cachedRepos.localPath,
            defaultBranch: cachedRepos.defaultBranch,
            lastFetchedAt: cachedRepos.lastFetchedAt,
            createdAt: cachedRepos.createdAt,
            lastAutoRefreshAt: cachedRepos.lastAutoRefreshAt,
            hasSubmodules: cachedRepos.hasSubmodules,
            lastSubmoduleSyncOk: cachedRepos.lastSubmoduleSyncOk,
          })
          .from(cachedRepos)
          .where(after === undefined ? undefined : gt(cachedRepos.id, after))
          .orderBy(cachedRepos.id)
          .limit(RECEIPT_PAGE_SIZE)
          .all(),
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
            id: tasks.id,
            name: tasks.name,
            workflowId: tasks.workflowId,
            workflowSnapshot: tasks.workflowSnapshot,
            repoPath: tasks.repoPath,
            worktreePath: tasks.worktreePath,
            baseBranch: tasks.baseBranch,
            branch: tasks.branch,
            status: tasks.status,
            inputs: tasks.inputs,
            startedAt: tasks.startedAt,
            finishedAt: tasks.finishedAt,
            runningMs: tasks.runningMs,
            ownerUserId: tasks.ownerUserId,
            launchOrigin: tasks.launchOrigin,
            parentTaskId: tasks.parentTaskId,
            invocationDepth: tasks.invocationDepth,
            cachedRepoId: tasks.cachedRepoId,
            branchStartedAt: tasks.branchStartedAt,
            rootTaskId: tasks.rootTaskId,
            executionLineageId: tasks.executionLineageId,
            lineageSlotPathJson: tasks.lineageSlotPathJson,
          })
          .from(tasks)
          .where(after === undefined ? undefined : gt(tasks.id, after))
          .orderBy(tasks.id)
          .limit(RECEIPT_PAGE_SIZE)
          .all(),
    )
    const runs = await readDigest(
      async (after: string | undefined) =>
        await tx
          .select({
            id: nodeRuns.id,
            taskId: nodeRuns.taskId,
            nodeId: nodeRuns.nodeId,
            status: nodeRuns.status,
            iteration: nodeRuns.iteration,
            retryIndex: nodeRuns.retryIndex,
            startedAt: nodeRuns.startedAt,
            finishedAt: nodeRuns.finishedAt,
            continuationSlotKey: nodeRuns.continuationSlotKey,
            lineageSlotPathJson: nodeRuns.lineageSlotPathJson,
            scopePath: nodeRuns.scopePath,
          })
          .from(nodeRuns)
          .where(after === undefined ? undefined : gt(nodeRuns.id, after))
          .orderBy(nodeRuns.id)
          .limit(RECEIPT_PAGE_SIZE)
          .all(),
    )
    const events = await readDigest(
      async (after: number | undefined) =>
        await tx
          .select({
            id: nodeRunEvents.id,
            nodeRunId: nodeRunEvents.nodeRunId,
            ts: nodeRunEvents.ts,
            kind: nodeRunEvents.kind,
            payload: nodeRunEvents.payload,
          })
          .from(nodeRunEvents)
          .where(after === undefined ? undefined : gt(nodeRunEvents.id, after))
          .orderBy(nodeRunEvents.id)
          .limit(RECEIPT_PAGE_SIZE)
          .all(),
    )
    const deliveries = await readDigest(
      async (after: string | undefined) =>
        await tx
          .select({
            id: webhookDeliveries.id,
            endpointId: webhookDeliveries.endpointId,
            eventUuid: webhookDeliveries.eventUuid,
            objectKind: webhookDeliveries.objectKind,
            eventType: webhookDeliveries.eventType,
            status: webhookDeliveries.status,
            receivedAt: webhookDeliveries.receivedAt,
            bodyJson: webhookDeliveries.bodyJson,
          })
          .from(webhookDeliveries)
          .where(after === undefined ? undefined : gt(webhookDeliveries.id, after))
          .orderBy(webhookDeliveries.id)
          .limit(RECEIPT_PAGE_SIZE)
          .all(),
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

function runSqliteSeed(): void {
  const args = parseArgs()
  const MIGRATIONS = resolve(import.meta.dir, '..', 'packages', 'backend', 'db', 'migrations')
  const T0 = PERF_CORPUS_ENTRY.now

  if (args.reset && existsSync(args.db)) {
    rmSync(args.db)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(args.db + suffix)) rmSync(args.db + suffix)
    }
  }
  mkdirSync(dirname(args.db), { recursive: true })

  console.log(`[perf-seed] migrating ${args.db}`)
  openDb({ path: args.db, migrationsFolder: MIGRATIONS })

  const raw = new Database(args.db)
  raw.exec('PRAGMA journal_mode = WAL;')
  raw.exec('PRAGMA synchronous = OFF;') // 基准库可重建,写入期换速度
  raw.exec('PRAGMA busy_timeout = 10000;')

  function tx(fn: () => void): void {
    raw.exec('BEGIN')
    try {
      fn()
      raw.exec('COMMIT')
    } catch (e) {
      raw.exec('ROLLBACK')
      throw e
    }
  }

  const started = Date.now()

  // --- users / workflow --------------------------------------------------------
  tx(() => {
    raw
      .prepare(
        `INSERT OR IGNORE INTO users (id, username, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', ?, ?)`,
      )
      .run(
        PERF_CORPUS_ENTRY.userId,
        PERF_CORPUS_ENTRY.username,
        PERF_CORPUS_ENTRY.displayName,
        T0,
        T0,
      )
    raw
      .prepare(`INSERT OR IGNORE INTO workflows (id, name, definition) VALUES (?, ?, ?)`)
      .run(
        PERF_CORPUS_ENTRY.workflowId,
        PERF_CORPUS_ENTRY.workflowName,
        PERF_CORPUS_ENTRY.workflowDefinition,
      )
    // bootstrap 闸门:auth_login_policy.bootstrap_completed_at 为 NULL 时全 API
    // 403(bootstrap-admin-required),bench 一格都跑不了。
    raw
      .prepare(`UPDATE auth_login_policy SET bootstrap_completed_at = ? WHERE id = 'global'`)
      .run(T0)
    // bench 的凭据:bootstrap 完成后 daemon token 失效,读端点走一枚确定性
    // PAT(空 scope = 只读,bench 全 GET 正好)。raw token 见 perf-bench.ts。
    const patRaw = PERF_CORPUS_ENTRY.bearerToken
    const patHash = new Bun.CryptoHasher('sha256').update(patRaw).digest('hex')
    raw
      .prepare(
        `INSERT OR IGNORE INTO user_pats (id, user_id, name, token_hash, scopes_json, created_at)
       VALUES ('perf-pat', 'perf-admin', 'perf-bench', ?, '[]', ?)`,
      )
      .run(patHash, T0)
  })

  // --- repos -------------------------------------------------------------------
  console.log(`[perf-seed] repos: ${args.repos}`)
  tx(() => {
    const ins = raw.prepare(
      `INSERT OR IGNORE INTO cached_repos
       (id, url_hash, url_redacted, local_path, default_branch, last_fetched_at, created_at,
        last_auto_refresh_at, has_submodules, last_submodule_sync_ok)
     VALUES (?, ?, ?, ?, 'main', ?, ?, ?, ?, ?)`,
    )
    for (let i = 0; i < args.repos; i += 1) {
      const row = perfRepoRow(i)
      ins.run(
        row.id,
        row.urlHash,
        row.urlRedacted,
        row.localPath,
        row.lastFetchedAt,
        row.createdAt,
        row.lastAutoRefreshAt,
        row.hasSubmodules,
        row.lastSubmoduleSyncOk,
      )
    }
  })

  // --- tasks -------------------------------------------------------------------
  // 90% 根任务,10% 挂一个子任务(锁 branch_started_at = 子树 max 的不变量:
  // 子任务 startedAt 晚于父,父行的 branch_started_at 取子值)。
  console.log(`[perf-seed] tasks: ${args.tasks}`)
  const CHUNK = PERF_CORPUS_CHUNKS.tasks
  for (let base = 0; base < args.tasks; base += CHUNK) {
    const hi = Math.min(base + CHUNK, args.tasks)
    tx(() => {
      const ins = raw.prepare(
        `INSERT OR IGNORE INTO tasks
         (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path, base_branch, branch,
          status, inputs, started_at, finished_at, running_ms, owner_user_id, launch_origin,
          parent_task_id, invocation_depth, cached_repo_id, branch_started_at, root_task_id)
       VALUES (?, ?, 'perf-wf', '{}', ?, ?, 'main', ?, ?, '{}', ?, ?, 0, 'perf-admin', 'manual', ?, ?, ?, ?, ?)`,
      )
      for (let i = base; i < hi; i += 1) {
        const row = perfTaskRow(i, args)
        ins.run(
          row.id,
          row.name,
          row.repoPath,
          row.worktreePath,
          row.branch,
          row.status,
          row.startedAt,
          row.finishedAt,
          row.parentTaskId,
          row.invocationDepth,
          row.cachedRepoId,
          row.branchStartedAt,
          row.rootTaskId,
        )
      }
    })
    console.log(`[perf-seed]   tasks ${hi}/${args.tasks}`)
  }

  // --- node_runs ---------------------------------------------------------------
  const totalRuns = args.tasks * args.runsPerTask
  console.log(`[perf-seed] node_runs: ${totalRuns}`)
  const RUN_CHUNK = PERF_CORPUS_CHUNKS.nodeRuns
  for (let base = 0; base < totalRuns; base += RUN_CHUNK) {
    const hi = Math.min(base + RUN_CHUNK, totalRuns)
    tx(() => {
      const ins = raw.prepare(
        `INSERT OR IGNORE INTO node_runs
         (id, task_id, node_id, status, iteration, retry_index, started_at, finished_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      for (let i = base; i < hi; i += 1) {
        const row = perfNodeRunRow(i, args)
        ins.run(row.id, row.taskId, row.nodeId, row.status, row.startedAt, row.finishedAt)
      }
    })
    console.log(`[perf-seed]   node_runs ${hi}/${totalRuns}`)
  }

  // --- node_run_events ---------------------------------------------------------
  console.log(`[perf-seed] events: ${args.events}`)
  const EV_CHUNK = PERF_CORPUS_CHUNKS.nodeRunEvents
  for (let base = 0; base < args.events; base += EV_CHUNK) {
    const hi = Math.min(base + EV_CHUNK, args.events)
    tx(() => {
      const ins = raw.prepare(
        `INSERT INTO node_run_events (node_run_id, ts, kind, payload) VALUES (?, ?, 'text', ?)`,
      )
      for (let i = base; i < hi; i += 1) {
        const row = perfEventRow(i, args)
        ins.run(row.nodeRunId, row.ts, row.payload)
      }
    })
    console.log(`[perf-seed]   events ${hi}/${args.events}`)
  }

  // --- webhook deliveries ------------------------------------------------------
  console.log(`[perf-seed] webhook deliveries: ${args.deliveries}`)
  for (let base = 0; base < args.deliveries; base += RUN_CHUNK) {
    const hi = Math.min(base + RUN_CHUNK, args.deliveries)
    tx(() => {
      const ins = raw.prepare(
        `INSERT OR IGNORE INTO webhook_deliveries
         (id, endpoint_id, event_uuid, object_kind, event_type, status, received_at, body_json)
       VALUES (?, 'perf-endpoint', ?, 'merge_request', 'merge_request', 'matched', ?, ?)`,
      )
      for (let i = base; i < hi; i += 1) {
        const row = perfDeliveryRow(i)
        ins.run(row.id, row.eventUuid, row.receivedAt, row.bodyJson)
      }
    })
    console.log(`[perf-seed]   deliveries ${hi}/${args.deliveries}`)
  }

  raw.exec('PRAGMA synchronous = NORMAL;')
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  raw.exec('ANALYZE;')
  raw.close()

  const sizeMb = (Bun.file(args.db).size / 1024 / 1024).toFixed(0)
  console.log(
    `[perf-seed] done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${sizeMb}MB at ${args.db}`,
  )
}

if (import.meta.main) runSqliteSeed()
