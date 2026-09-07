// RFC-359 W8-A —— `TaskArchiveMaintenanceCommand` 的**双引擎对拍**。
//
// 这一对合一前是：SQLite 侧 66 行薄壳转发给 `services/taskArchive.ts`（1018 行），
// PostgreSQL 侧 `postgresqlTaskArchiveMaintenanceCommand.ts`（747 行）自己抄了一份同样的
// 导出 / 删库 / 恢复流程。两侧共用同一个中立的终态维护认领 store（W7 已合），差别只在
// 归档管线本身。这份对拍先在两个旧实现上跑，把纸面「零分叉」实际测出来的差异钉死；
// 合一之后同一批断言必须继续全绿——它就是合一的验收面。
//
// 为什么用 `createTaskArchiveMaintenanceCommand(db)` 而不是直接 import 某个实现：
// 它是 bootstrap 真正用的那条选择路径（providerRuntime.ts），对拍因此打在**产品装配**上，
// 换实现不用改测试。

import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { count, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunEvents,
  nodeRuns,
  reviewNodeReviewers,
  taskArchiveAudit,
  taskExecutionMaintenanceClaims,
  taskRepos,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { createTaskArchiveMaintenanceCommand } from '@/modules/task-execution/composition/providerRuntime'
import type { TaskArchiveMaintenanceOptions } from '@/modules/task-execution/application/ports/taskArchiveMaintenanceCommand'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const DAY = 86_400_000
const NOW = 1_788_278_400_000

interface Dirs {
  readonly archiveDir: string
  readonly runsDir: string
  readonly logsDir: string
}

function tmpDirs(): Dirs {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc359-w8-archive-'))
  const dirs = {
    archiveDir: join(root, 'archive', 'tasks'),
    runsDir: join(root, 'runs'),
    logsDir: join(root, 'logs'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return dirs
}

function options(dirs: Dirs, now: number = NOW): TaskArchiveMaintenanceOptions {
  return { ...dirs, now }
}

async function seedBase(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'u1',
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(workflows).values({ id: 'wf1', name: 'wf', definition: '{}' })
}

interface TaskSeed {
  readonly id: string
  readonly status: 'done' | 'failed' | 'canceled' | 'interrupted' | 'running'
  readonly finishedAt: number | null
  readonly parentTaskId?: string
}

async function addTask(db: ProviderNeutralDatabase, seed: TaskSeed): Promise<void> {
  await db.insert(tasks).values({
    id: seed.id,
    name: seed.id,
    workflowId: 'wf1',
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${seed.id}`,
    status: seed.status,
    inputs: '{}',
    startedAt: NOW - 400 * DAY,
    finishedAt: seed.finishedAt,
    runningMs: 0,
    ownerUserId: 'u1',
    launchOrigin: 'manual',
    parentTaskId: seed.parentTaskId ?? null,
    invocationDepth: seed.parentTaskId === undefined ? 0 : 1,
  })
  await db.insert(taskRepos).values({
    taskId: seed.id,
    repoIndex: 0,
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    branch: `agent-workflow/${seed.id}`,
  })
}

async function addRunWithEvents(
  db: ProviderNeutralDatabase,
  taskId: string,
  runId: string,
  events: number,
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'n1',
    status: 'done',
    startedAt: NOW - 400 * DAY,
    finishedAt: NOW - 399 * DAY,
  })
  for (let index = 0; index < events; index += 1) {
    await db.insert(nodeRunEvents).values({
      nodeRunId: runId,
      ts: NOW - 400 * DAY + index,
      kind: 'text',
      payload: `line-${index}`,
    })
  }
}

async function rowCount(
  db: ProviderNeutralDatabase,
  table: typeof tasks | typeof nodeRuns | typeof nodeRunEvents | typeof taskArchiveAudit,
): Promise<number> {
  const rows = await db.select({ n: count() }).from(table)
  return Number(rows[0]?.n ?? 0)
}

function seedWorkspaceDirs(dirs: Dirs, taskIds: readonly string[]): void {
  for (const id of taskIds) {
    mkdirSync(join(dirs.runsDir, id), { recursive: true })
    writeFileSync(join(dirs.runsDir, id, 'prompt.md'), `prompt of ${id}`, 'utf8')
    mkdirSync(join(dirs.logsDir, id), { recursive: true })
    writeFileSync(join(dirs.logsDir, id, 'x.jsonl'), '{}\n', 'utf8')
  }
}

interface ArchiveManifest {
  readonly schemaVersion: number
  readonly rootTaskId: string
  readonly taskIds: readonly string[]
  readonly rows: Readonly<Record<string, number>>
  readonly digest: string
  readonly terminalMaintenance: {
    readonly claim: {
      readonly id: string
      readonly state: string
      readonly memberSetDigest: string
    }
    readonly members: readonly { readonly taskId: string }[]
  }
}

function readManifest(dir: string): ArchiveManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ArchiveManifest
}

function jsonlLines(dir: string, table: string): readonly string[] {
  const file = join(dir, 'db', `${table}.jsonl`)
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8').trim()
  return text.length === 0 ? [] : text.split('\n')
}

describeEachProvider(
  'RFC-359 W8-A task archive maintenance command',
  (harness: ProviderHarness) => {
    const command = () => createTaskArchiveMaintenanceCommand(harness.db)

    test('disabled config and zero retention touch nothing', async () => {
      const dirs = tmpDirs()
      await seedBase(harness.db)
      await addTask(harness.db, { id: 'old', status: 'done', finishedAt: NOW - 300 * DAY })

      expect(
        (await command().runSweep({ enabled: false, retentionDays: 90 }, options(dirs))).archived,
      ).toHaveLength(0)
      expect(
        (await command().runSweep({ enabled: true, retentionDays: 0 }, options(dirs))).archived,
      ).toHaveLength(0)
      expect(await rowCount(harness.db, tasks)).toBe(1)
      expect(await rowCount(harness.db, taskArchiveAudit)).toBe(0)
      expect(readdirSync(dirs.archiveDir)).toEqual([])
    })

    test('preview reports whole-tree candidates and never mutates', async () => {
      const dirs = tmpDirs()
      await seedBase(harness.db)
      // ① 有一个后代仍在运行 ⇒ 整树不动。
      await addTask(harness.db, { id: 'r1', status: 'done', finishedAt: NOW - 300 * DAY })
      await addTask(harness.db, {
        id: 'r1c',
        status: 'running',
        finishedAt: null,
        parentTaskId: 'r1',
      })
      // ② 全终态但后代最近才完成 ⇒ 整树不动。
      await addTask(harness.db, { id: 'r2', status: 'done', finishedAt: NOW - 300 * DAY })
      await addTask(harness.db, {
        id: 'r2c',
        status: 'done',
        finishedAt: NOW - 2 * DAY,
        parentTaskId: 'r2',
      })
      // ③ 干净的可归档树（root + 一个后代）。
      await addTask(harness.db, { id: 'r3', status: 'failed', finishedAt: NOW - 300 * DAY })
      await addTask(harness.db, {
        id: 'r3c',
        status: 'canceled',
        finishedAt: NOW - 299 * DAY,
        parentTaskId: 'r3',
      })

      const preview = await command().preview({ retentionDays: 90, maxTrees: 10, now: NOW })
      expect(preview.map((tree) => tree.rootTaskId)).toEqual(['r3'])
      expect(preview[0]?.taskCount).toBe(2)
      expect(preview[0]?.lastFinishedAt).toBe(NOW - 299 * DAY)
      expect(await command().preview({ retentionDays: 0, maxTrees: 10, now: NOW })).toEqual([])
      expect(await rowCount(harness.db, tasks)).toBe(6)
      expect(readdirSync(dirs.archiveDir)).toEqual([])
    })

    // RFC-350：`interrupted` 也是终态（orphan reaper 会写 finished_at），不能漏。
    test('interrupted tasks are archivable terminal members', async () => {
      await seedBase(harness.db)
      await addTask(harness.db, { id: 'ri', status: 'interrupted', finishedAt: NOW - 300 * DAY })
      const preview = await command().preview({ retentionDays: 90, maxTrees: 10, now: NOW })
      expect(preview.map((tree) => tree.rootTaskId)).toEqual(['ri'])
    })

    test('sweep exports the tree, moves runs/logs, clears rows and writes one audit row', async () => {
      const dirs = tmpDirs()
      await seedBase(harness.db)
      await addTask(harness.db, { id: 'root', status: 'done', finishedAt: NOW - 300 * DAY })
      await addTask(harness.db, {
        id: 'child',
        status: 'done',
        finishedAt: NOW - 299 * DAY,
        parentTaskId: 'root',
      })
      await addRunWithEvents(harness.db, 'root', 'run-root', 3)
      await addRunWithEvents(harness.db, 'child', 'run-child', 2)
      await harness.db.insert(reviewNodeReviewers).values({
        taskId: 'root',
        reviewNodeId: 'review-node',
        reviewerUserId: 'u1',
        assignedByUserId: 'u1',
        assignedAt: NOW - 250 * DAY,
      })
      seedWorkspaceDirs(dirs, ['root', 'child'])

      const receipt = await command().runSweep({ enabled: true, retentionDays: 90 }, options(dirs))

      expect(receipt.skipped).toBe(0)
      expect(receipt.archived.map((tree) => tree.rootTaskId)).toEqual(['root'])
      expect([...(receipt.archived[0]?.taskIds ?? [])].sort()).toEqual(['child', 'root'])
      expect(await rowCount(harness.db, tasks)).toBe(0)
      expect(await rowCount(harness.db, nodeRuns)).toBe(0)
      expect(await rowCount(harness.db, nodeRunEvents)).toBe(0)

      const dir = join(dirs.archiveDir, 'root')
      expect(receipt.archived[0]?.dir).toBe(dir)
      const manifest = readManifest(dir)
      expect(manifest.schemaVersion).toBe(2)
      expect(manifest.rootTaskId).toBe('root')
      expect([...manifest.taskIds].sort()).toEqual(['child', 'root'])
      expect(manifest.rows.tasks).toBe(2)
      expect(manifest.rows.node_runs).toBe(2)
      expect(manifest.rows.node_run_events).toBe(5)
      expect(manifest.rows.task_repos).toBe(2)
      expect(manifest.rows.review_node_reviewers).toBe(1)
      expect(manifest.rows.task_execution_owners).toBe(0)
      expect(manifest.rows.task_execution_lineage_operation_records).toBe(0)
      expect(manifest.rows['runs_dirs']).toBe(2)
      expect(manifest.rows['logs_dirs']).toBe(2)
      expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.terminalMaintenance.claim.memberSetDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.terminalMaintenance.members.map((member) => member.taskId)).toEqual([
        'child',
        'root',
      ])

      expect(jsonlLines(dir, 'tasks')).toHaveLength(2)
      expect(jsonlLines(dir, 'node_run_events')).toHaveLength(5)
      expect(JSON.parse(jsonlLines(dir, 'review_node_reviewers')[0] ?? '{}')).toMatchObject({
        taskId: 'root',
        reviewNodeId: 'review-node',
      })
      expect(JSON.parse(jsonlLines(dir, 'tasks')[0] ?? '{}')).toMatchObject({ workflowId: 'wf1' })

      // runs / logs 是**挪移**：归档目录里有、原地没有。
      expect(readFileSync(join(dir, 'runs', 'root', 'prompt.md'), 'utf8')).toBe('prompt of root')
      expect(existsSync(join(dirs.runsDir, 'root'))).toBe(false)
      expect(existsSync(join(dirs.logsDir, 'child'))).toBe(false)

      // 认领在归档完成后收口。
      const claims = await harness.db
        .select()
        .from(taskExecutionMaintenanceClaims)
        .where(eq(taskExecutionMaintenanceClaims.id, manifest.terminalMaintenance.claim.id))
      expect(claims[0]?.state).toBe('completed')

      const audits = await harness.db.select().from(taskArchiveAudit)
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        source: 'sweep',
        actorUserId: null,
        retentionDays: 90,
        treeCount: 1,
        taskCount: 2,
        skippedCount: 0,
        createdAt: NOW,
      })
      expect(JSON.parse(String(audits[0]?.rootTaskIdsJson ?? '[]'))).toEqual(['root'])
    })

    test('an idle sweep writes no audit row; a manual run always does', async () => {
      const dirs = tmpDirs()
      await seedBase(harness.db)

      await command().runSweep({ enabled: true, retentionDays: 90 }, options(dirs))
      expect(await rowCount(harness.db, taskArchiveAudit)).toBe(0)

      const manual = await command().runManual(
        { retentionDays: 90, maxTrees: 5, actorUserId: 'u1' },
        options(dirs),
      )
      expect(manual.archived).toHaveLength(0)
      const audits = await harness.db.select().from(taskArchiveAudit)
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        source: 'manual',
        actorUserId: 'u1',
        retentionDays: 90,
        treeCount: 0,
        taskCount: 0,
        skippedCount: 0,
        createdAt: NOW,
      })
    })

    test('manual archive ignores the enabled switch and honours its own now', async () => {
      const dirs = tmpDirs()
      await seedBase(harness.db)
      await addTask(harness.db, { id: 'root', status: 'done', finishedAt: NOW - 300 * DAY })

      const receipt = await command().runManual(
        { retentionDays: 90, maxTrees: 5, actorUserId: 'u1', now: NOW },
        { ...dirs },
      )
      expect(receipt.archived.map((tree) => tree.rootTaskId)).toEqual(['root'])
      expect(await rowCount(harness.db, tasks)).toBe(0)
      const audits = await harness.db.select().from(taskArchiveAudit)
      expect(audits[0]).toMatchObject({ source: 'manual', createdAt: NOW, treeCount: 1 })
    })

    test('maxTrees bounds one pass', async () => {
      const dirs = tmpDirs()
      await seedBase(harness.db)
      for (const id of ['a', 'b', 'c']) {
        await addTask(harness.db, { id, status: 'done', finishedAt: NOW - 300 * DAY })
      }
      const receipt = await command().runSweep(
        { enabled: true, retentionDays: 90, maxTreesPerSweep: 2 },
        options(dirs),
      )
      expect(receipt.archived).toHaveLength(2)
      expect(await rowCount(harness.db, tasks)).toBe(1)
    })

    // crash branch B —— rename 之后、删库之前崩：boot 恢复必须把 tmp 提升为正式目录并删库。
    test('recover promotes a tmp directory whose manifest is complete', async () => {
      const dirs = tmpDirs()
      await seedBase(harness.db)
      await addTask(harness.db, { id: 'root', status: 'done', finishedAt: NOW - 300 * DAY })
      seedWorkspaceDirs(dirs, ['root'])

      // 造一个「行已删、盘上只有 .tmp-root」的现场：先正常归档，再把正式目录改回 tmp 名，
      // 并把任务行种回去（模拟删库那一步没跑完）。
      await command().runSweep({ enabled: true, retentionDays: 90 }, options(dirs))
      const finalDir = join(dirs.archiveDir, 'root')
      expect(existsSync(finalDir)).toBe(true)

      const { renameSync, rmSync } = await import('node:fs')
      renameSync(finalDir, join(dirs.archiveDir, '.tmp-root'))
      rmSync(join(dirs.archiveDir, '.tmp-root', 'runs'), { recursive: true, force: true })
      rmSync(join(dirs.archiveDir, '.tmp-root', 'logs'), { recursive: true, force: true })

      const receipt = await command().recover(options(dirs))
      expect(receipt.promoted).toEqual(['root'])
      expect(existsSync(finalDir)).toBe(true)
      expect(existsSync(join(dirs.archiveDir, '.tmp-root'))).toBe(false)
    })

    // crash branch A —— 落盘阶段崩、行还在：tmp 必须被丢弃，且挪走的 runs/logs 放回原处。
    test('recover restores moved runs/logs and discards the tmp when the rows are still live', async () => {
      const dirs = tmpDirs()
      await seedBase(harness.db)
      await addTask(harness.db, { id: 'root', status: 'done', finishedAt: NOW - 300 * DAY })

      const tmpDir = join(dirs.archiveDir, '.tmp-root')
      mkdirSync(join(tmpDir, 'db'), { recursive: true })
      mkdirSync(join(tmpDir, 'runs', 'root'), { recursive: true })
      writeFileSync(join(tmpDir, 'runs', 'root', 'prompt.md'), 'moved prompt', 'utf8')
      mkdirSync(join(tmpDir, 'logs', 'root'), { recursive: true })
      writeFileSync(join(tmpDir, 'logs', 'root', 'x.jsonl'), '{}\n', 'utf8')

      const receipt = await command().recover(options(dirs))
      expect(receipt.discarded).toEqual(['root'])
      expect(receipt.promoted).toEqual([])
      expect(existsSync(tmpDir)).toBe(false)
      expect(readFileSync(join(dirs.runsDir, 'root', 'prompt.md'), 'utf8')).toBe('moved prompt')
      expect(existsSync(join(dirs.logsDir, 'root', 'x.jsonl'))).toBe(true)
      expect(await rowCount(harness.db, tasks)).toBe(1)
    })

    test('recover is a no-op when nothing was interrupted', async () => {
      const dirs = tmpDirs()
      await seedBase(harness.db)
      await addTask(harness.db, { id: 'root', status: 'done', finishedAt: NOW - 300 * DAY })
      expect(await command().recover(options(dirs))).toEqual({ promoted: [], discarded: [] })
      expect(await rowCount(harness.db, tasks)).toBe(1)
    })

    // 判据缺口 10（`rfc359-w5-dual-engine-predicate-gaps`）：认领里冻结的 cleanupPlan 记着这次
    // 归档用的归档根。恢复被指到**另一个**根上时，那条认领不归本次恢复管——它盘上的产物在旧根
    // 下，按新根去判「盘上有没有」得到的结论必然是错的。SQLite 侧读 plan 并按 archiveRoot 围栏
    // 跳过；合一前 PostgreSQL 侧从不读 cleanupPlanJson，于是把它判成「盘上什么都没有」并把认领
    // **降级**成 recovery-required——一条本来处在 io-complete、只差删库的认领被推回去重做。
    test('recover leaves claims frozen against a different archive root untouched', async () => {
      const original = tmpDirs()
      await seedBase(harness.db)
      await addTask(harness.db, { id: 'root', status: 'done', finishedAt: NOW - 300 * DAY })

      await command().runSweep({ enabled: true, retentionDays: 90 }, options(original))
      const finalDir = join(original.archiveDir, 'root')
      const { renameSync } = await import('node:fs')
      renameSync(finalDir, join(original.archiveDir, '.tmp-root'))
      // 认领退回「盘上完成、库未删」的现场（崩在 rename 与删库之间）。
      await harness.db
        .update(taskExecutionMaintenanceClaims)
        .set({ state: 'io-complete' })
        .where(eq(taskExecutionMaintenanceClaims.state, 'completed'))
      await addTask(harness.db, { id: 'root', status: 'done', finishedAt: NOW - 300 * DAY })

      // 换一个**新的**归档根来调用 recover：plan 里冻结的仍是旧根。
      const moved = tmpDirs()
      const receipt = await command().recover(options(moved))

      expect(receipt).toEqual({ promoted: [], discarded: [] })
      expect(readdirSync(moved.archiveDir)).toEqual([])
      expect(existsSync(join(original.archiveDir, '.tmp-root'))).toBe(true)
      expect(await rowCount(harness.db, tasks)).toBe(1)
      // 认领没有被这次「不归我管」的恢复动过。
      const claims = await harness.db.select().from(taskExecutionMaintenanceClaims)
      expect(claims.map((claim) => claim.state)).toEqual(['io-complete'])

      // 指回正确的归档根，同一条认领照常收尾。
      const second = await command().recover(options(original))
      expect(second.promoted).toEqual(['root'])
      expect(existsSync(join(original.archiveDir, 'root'))).toBe(true)
      expect(await rowCount(harness.db, tasks)).toBe(0)
    })
  },
)
