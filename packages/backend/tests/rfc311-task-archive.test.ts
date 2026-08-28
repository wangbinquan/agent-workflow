// RFC-311 T19 — 终态任务树归档出库(proposal §5 C1,用户拍板「归档到归档目录、
// 从表里删除、界面不可见」)。
//
// 这是本 RFC 唯一**会删数据**的能力,所以锁的重点不是「归档成功」,而是那些
// 「不该发生的事一件都没发生」:
//   - 默认关闭(enabled=false / retentionDays=0 都不动任何数据);
//   - 排除条件:整树只要有一个任务非终态、或最近完成时间还在保留期内,整树不动;
//   - 原子性两分支(design §7.1 要求的 kill -9 注入):落盘后崩(rename 前)→ 库
//     里的行必须完好;rename 后崩(删库前)→ boot 恢复把 tmp 提升为正式目录;
//   - manifest 覆盖导出了什么,`db/*.jsonl` 行数与库里一致;runs/logs 目录是**挪移**
//     而不是复制(原地不得残留)。

import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { count, eq } from 'drizzle-orm'

import type { Hono } from 'hono'

import { SYSTEM_USER_ID } from '../src/auth/actor'
import * as schema from '../src/db/schema'
import { cascadeClosure, cascadeEdges, closureOverEdges } from './architecture/cascadeClosure'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  nodeRunEvents,
  nodeRuns,
  taskArchiveAudit,
  taskExecutionMaintenanceClaims,
  taskRepos,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import { createApp } from '../src/server'
import {
  ARCHIVED_TABLES,
  ARCHIVE_EXEMPT_TABLES,
  archiveTaskTree,
  findArchivableTrees,
  recoverInterruptedArchives,
  runTaskArchiveSweep,
} from '../src/services/taskArchive'

const TOKEN = 'a'.repeat(64)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAY = 86_400_000
const NOW = 1_788_278_400_000

type Db = ReturnType<typeof createInMemoryDb>

interface Dirs {
  archiveDir: string
  runsDir: string
  logsDir: string
}

function tmpDirs(): Dirs {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc311-archive-'))
  const dirs = {
    archiveDir: join(root, 'archive', 'tasks'),
    runsDir: join(root, 'runs'),
    logsDir: join(root, 'logs'),
  }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  return dirs
}

async function seedBase(db: Db): Promise<void> {
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
  id: string
  status: 'done' | 'failed' | 'canceled' | 'running' | 'awaiting_human'
  finishedAt: number | null
  parentTaskId?: string
}

async function addTask(db: Db, seed: TaskSeed): Promise<void> {
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
    startedAt: NOW - 200 * DAY,
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

async function addRunWithEvents(db: Db, taskId: string, runId: string, events: number) {
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'n1',
    status: 'done',
    startedAt: NOW - 200 * DAY,
    finishedAt: NOW - 199 * DAY,
  })
  for (let i = 0; i < events; i += 1) {
    await db.insert(nodeRunEvents).values({
      nodeRunId: runId,
      ts: NOW - 200 * DAY + i,
      kind: 'text',
      payload: `line-${i}`,
    })
  }
}

async function taskCount(db: DbClient): Promise<number> {
  const r = await db.select({ n: count() }).from(tasks)
  return r[0]?.n ?? 0
}

describe('RFC-311 T19 — task archive', () => {
  test('is off by default: neither disabled nor zero-retention touches any row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    await addTask(db, { id: 'old', status: 'done', finishedAt: NOW - 300 * DAY })

    expect(
      (await runTaskArchiveSweep(db, { enabled: false, retentionDays: 90 }, { ...dirs, now: NOW }))
        .archived,
    ).toHaveLength(0)
    expect(
      (await runTaskArchiveSweep(db, { enabled: true, retentionDays: 0 }, { ...dirs, now: NOW }))
        .archived,
    ).toHaveLength(0)
    expect(await taskCount(db)).toBe(1)
    expect(readdirSync(dirs.archiveDir)).toEqual([])
  })

  test('a whole tree is excluded when any member is non-terminal or still inside the window', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    // ① 有一个后代仍在运行 ⇒ 整树不动。
    await addTask(db, { id: 'r1', status: 'done', finishedAt: NOW - 300 * DAY })
    await addTask(db, {
      id: 'r1-child',
      status: 'running',
      finishedAt: null,
      parentTaskId: 'r1',
    })
    // ② 全终态但后代最近才完成 ⇒ 整树不动(root 自己早已超期)。
    await addTask(db, { id: 'r2', status: 'done', finishedAt: NOW - 300 * DAY })
    await addTask(db, {
      id: 'r2-child',
      status: 'done',
      finishedAt: NOW - 2 * DAY,
      parentTaskId: 'r2',
    })
    // ③ 干净的可归档树。
    await addTask(db, { id: 'r3', status: 'failed', finishedAt: NOW - 300 * DAY })

    const trees = await findArchivableTrees(db, NOW - 90 * DAY, 10)
    expect(trees.map((t) => t.rootTaskId)).toEqual(['r3'])
  })

  test('archiving exports the tree, moves runs/logs, and clears the rows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    await addTask(db, { id: 'root', status: 'done', finishedAt: NOW - 300 * DAY })
    await addTask(db, {
      id: 'child',
      status: 'done',
      finishedAt: NOW - 299 * DAY,
      parentTaskId: 'root',
    })
    await addRunWithEvents(db, 'root', 'run-root', 3)
    await addRunWithEvents(db, 'child', 'run-child', 2)
    await db.insert(schema.reviewNodeReviewers).values({
      taskId: 'root',
      reviewNodeId: 'review-node',
      reviewerUserId: 'u1',
      assignedByUserId: 'u1',
      assignedAt: NOW - 250 * DAY,
    })
    for (const id of ['root', 'child']) {
      mkdirSync(join(dirs.runsDir, id), { recursive: true })
      writeFileSync(join(dirs.runsDir, id, 'prompt.md'), `prompt of ${id}`, 'utf-8')
      mkdirSync(join(dirs.logsDir, id), { recursive: true })
      writeFileSync(join(dirs.logsDir, id, 'x.jsonl'), '{}\n', 'utf-8')
    }

    const result = await archiveTaskTree(db, 'root', { ...dirs, now: NOW })

    // 库里清空。
    expect(await taskCount(db)).toBe(0)
    const runsLeft = await db.select({ n: count() }).from(nodeRuns)
    expect(runsLeft[0]?.n ?? 0).toBe(0)
    const eventsLeft = await db.select({ n: count() }).from(nodeRunEvents)
    expect(eventsLeft[0]?.n ?? 0).toBe(0)

    // 目录自描述:manifest + 逐表 JSONL。
    const dir = join(dirs.archiveDir, 'root')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as {
      schemaVersion: number
      taskIds: string[]
      rows: Record<string, number>
      digest: string
      terminalMaintenance: {
        claim: { id: string; state: string; memberSetDigest: string }
        members: Array<{ taskId: string }>
      }
    }
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.taskIds.sort()).toEqual(['child', 'root'])
    expect(manifest.rows.tasks).toBe(2)
    expect(manifest.rows.node_runs).toBe(2)
    expect(manifest.rows.node_run_events).toBe(5)
    expect(manifest.rows.task_repos).toBe(2)
    expect(manifest.rows.review_node_reviewers).toBe(1)
    expect(manifest.rows.task_execution_owners).toBe(0)
    expect(manifest.rows.task_execution_intents).toBe(0)
    expect(manifest.rows.task_execution_effects).toBe(0)
    expect(manifest.rows.task_execution_effect_attempts).toBe(0)
    expect(manifest.rows.task_execution_effect_fences).toBe(0)
    expect(manifest.rows.task_execution_lineage_operation_records).toBe(0)
    expect(manifest.terminalMaintenance.claim).toMatchObject({ state: 'claimed' })
    expect(manifest.terminalMaintenance.claim.memberSetDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.terminalMaintenance.members.map((member) => member.taskId)).toEqual([
      'child',
      'root',
    ])
    expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/)

    const durableClaim = await db
      .select()
      .from(schema.taskExecutionMaintenanceClaims)
      .where(eq(schema.taskExecutionMaintenanceClaims.id, manifest.terminalMaintenance.claim.id))
      .get()
    expect(durableClaim?.state).toBe('completed')

    const taskLines = readFileSync(join(dir, 'db', 'tasks.jsonl'), 'utf-8')
      .trim()
      .split('\n')
    expect(taskLines).toHaveLength(2)
    expect(JSON.parse(taskLines[0]!)).toMatchObject({ workflowId: 'wf1' })
    const eventLines = readFileSync(join(dir, 'db', 'node_run_events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
    expect(eventLines).toHaveLength(5)
    expect(
      JSON.parse(readFileSync(join(dir, 'db', 'review_node_reviewers.jsonl'), 'utf-8').trim()),
    ).toMatchObject({ taskId: 'root', reviewNodeId: 'review-node', reviewerUserId: 'u1' })

    // runs/logs 是**挪移**:归档目录里有、原地没有。
    expect(readFileSync(join(dir, 'runs', 'root', 'prompt.md'), 'utf-8')).toBe('prompt of root')
    expect(existsSync(join(dirs.runsDir, 'root'))).toBe(false)
    expect(existsSync(join(dirs.logsDir, 'child'))).toBe(false)
    expect(result.dir).toBe(dir)
  })

  test('a failure before rename leaves the database intact (crash branch A)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    await addTask(db, { id: 'root', status: 'done', finishedAt: NOW - 300 * DAY })
    // 归档根目录换成一个**文件**:mkdir 必失败 ⇒ 落盘阶段抛错。
    const brokenRoot = join(dirs.archiveDir, 'blocked')
    writeFileSync(brokenRoot, 'not a directory', 'utf-8')

    await expect(
      archiveTaskTree(db, 'root', { ...dirs, archiveDir: brokenRoot, now: NOW }),
    ).rejects.toThrow()
    // 关键:库里的行必须完好——宁可留一份可丢弃的 tmp,也不能删库。
    expect(await taskCount(db)).toBe(1)
  })

  test('boot recovery promotes a post-rename crash and discards a pre-delete one (crash branch B)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    await addTask(db, { id: 'still-here', status: 'done', finishedAt: NOW - 300 * DAY })

    // 残留 tmp ①:对应任务仍在库里(说明崩在删库之前)⇒ 丢弃,下轮重做。
    mkdirSync(join(dirs.archiveDir, '.tmp-still-here', 'db'), { recursive: true })
    // 残留 tmp ②:对应任务已不在库里(崩在 rename 与删库之间的窗口,行已删)⇒
    // 提升为正式目录,否则数据就真的没了。
    mkdirSync(join(dirs.archiveDir, '.tmp-gone', 'db'), { recursive: true })
    writeFileSync(join(dirs.archiveDir, '.tmp-gone', 'manifest.json'), '{}', 'utf-8')

    const recovered = await recoverInterruptedArchives(db, dirs)
    expect(recovered.promoted).toEqual(['gone'])
    expect(recovered.discarded).toEqual(['still-here'])
    expect(existsSync(join(dirs.archiveDir, 'gone', 'manifest.json'))).toBe(true)
    expect(existsSync(join(dirs.archiveDir, '.tmp-still-here'))).toBe(false)
    // 库里的行没被恢复流程碰过。
    expect(await taskCount(db)).toBe(1)
  })

  test('the sweep is bounded per tick and reports failures without touching the database', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    for (let i = 0; i < 3; i += 1) {
      await addTask(db, { id: `t${i}`, status: 'done', finishedAt: NOW - 300 * DAY })
    }
    const result = await runTaskArchiveSweep(
      db,
      { enabled: true, retentionDays: 90, maxTreesPerSweep: 2 },
      { ...dirs, now: NOW },
    )
    expect(result.archived).toHaveLength(2)
    expect(result.skipped).toBe(0)
    // 有界:剩下的那棵留给下一拍。
    expect(await taskCount(db)).toBe(1)
    const rest = await db.select({ id: tasks.id }).from(tasks)
    expect(rest).toHaveLength(1)
    expect(
      await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, rest[0]!.id)),
    ).toHaveLength(1)
  })
})

// design §7.1 的第二半:「另有 admin API + 设置页维护区『按条件批量归档』手动入口
// (审计行记录操作者与数量)」。审计行是这条路径唯一的事后证据——归档把任务行删了,
// 之后除了 task_archive_audit,库里再没有任何地方能回答「谁在什么时候删了什么」。
describe('RFC-311 T19 — 手动批量归档入口与审计行', () => {
  async function auditRows(db: DbClient) {
    return db.select().from(taskArchiveAudit)
  }

  function appWith(db: DbClient, home: string): Hono {
    mkdirSync(home, { recursive: true })
    process.env.AGENT_WORKFLOW_HOME = home
    return createApp({
      token: TOKEN,
      configPath: join(home, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 17,
      db,
    })
  }

  async function post(app: Hono, body: unknown): Promise<Response> {
    return app.request('/api/tasks/archive', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('dry-run 是默认:给出预览,但一行不删、一条审计都不写', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc311-manual-'))
    const app = appWith(db, home)
    await seedBase(db)
    await addTask(db, { id: 'old', status: 'done', finishedAt: NOW - 300 * DAY })
    await addTask(db, {
      id: 'kid',
      status: 'done',
      finishedAt: NOW - 299 * DAY,
      parentTaskId: 'old',
    })

    const res = await post(app, { retentionDays: 90 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dryRun: boolean; treeCount: number; taskCount: number }
    expect(body.dryRun).toBe(true)
    expect(body.treeCount).toBe(1)
    // 单位是整棵树:root + 后代都算进去。
    expect(body.taskCount).toBe(2)
    expect(await taskCount(db)).toBe(2)
    expect(await auditRows(db)).toHaveLength(0)
  })

  test('dryRun:false 才真删,并留下带操作者与数量的审计行', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc311-manual-'))
    const app = appWith(db, home)
    await seedBase(db)
    await addTask(db, { id: 'old', status: 'done', finishedAt: NOW - 300 * DAY })
    await addTask(db, {
      id: 'kid',
      status: 'done',
      finishedAt: NOW - 299 * DAY,
      parentTaskId: 'old',
    })

    const res = await post(app, { retentionDays: 90, dryRun: false })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dryRun: boolean; treeCount: number; taskCount: number }
    expect(body.dryRun).toBe(false)
    expect(body.treeCount).toBe(1)
    expect(body.taskCount).toBe(2)
    expect(await taskCount(db)).toBe(0)
    expect(existsSync(join(home, 'archive', 'tasks', 'old', 'manifest.json'))).toBe(true)

    const audit = await auditRows(db)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.source).toBe('manual')
    expect(audit[0]!.actorUserId).toBe(SYSTEM_USER_ID)
    expect(audit[0]!.treeCount).toBe(1)
    expect(audit[0]!.taskCount).toBe(2)
    expect(audit[0]!.retentionDays).toBe(90)
    expect(JSON.parse(audit[0]!.rootTaskIdsJson)).toEqual(['old'])
  })

  test('手动入口在自动开关关着时照样可用(它本来就是给关着的部署用的)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc311-manual-'))
    const app = appWith(db, home)
    // 配置里显式关掉自动归档,只留保留期。
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ taskArchive: { enabled: false, retentionDays: 90 } }),
    )
    await seedBase(db)
    await addTask(db, { id: 'old', status: 'done', finishedAt: NOW - 300 * DAY })

    // 不传 retentionDays 时回落到配置值。
    const res = await post(app, { dryRun: false })
    expect(res.status).toBe(200)
    expect(await taskCount(db)).toBe(0)
    expect((await auditRows(db))[0]!.retentionDays).toBe(90)
  })

  test('载荷不合法时 422 task-archive-invalid,而不是拿默认值蒙混执行', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc311-manual-'))
    const app = appWith(db, home)
    await seedBase(db)
    await addTask(db, { id: 'old', status: 'done', finishedAt: NOW - 300 * DAY })

    // 天数不是整数 / 棵数越界 / dryRun 不是布尔——三种都必须拒绝:这条路径的
    // 「宽容解析」等于拿一个没人要求过的参数去做不可逆删除。
    for (const bad of [
      { retentionDays: 1.5, dryRun: false },
      { retentionDays: 90, maxTrees: 0, dryRun: false },
      { retentionDays: 90, dryRun: 'yes' },
    ]) {
      const res = await post(app, bad)
      expect(res.status).toBe(422)
      expect(((await res.json()) as { code: string }).code).toBe('task-archive-invalid')
    }
    expect(await taskCount(db)).toBe(1)
    expect(await auditRows(db)).toHaveLength(0)
  })

  test('配置成 0(=不归档)时手动入口拒绝执行,而不是把 0 天当成「全归档」', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc311-manual-'))
    const app = appWith(db, home)
    // retentionDays=0 在配置语义里是「关」。若手动入口把它当 cutoff=now 用,
    // 这台机器上**每一棵终态树**都会被立刻不可逆地删掉。
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ taskArchive: { enabled: false, retentionDays: 0 } }),
    )
    await seedBase(db)
    await addTask(db, { id: 'fresh', status: 'done', finishedAt: NOW - 1_000 })

    const res = await post(app, { dryRun: false })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('task-archive-retention-unset')
    expect(await taskCount(db)).toBe(1)
    expect(await auditRows(db)).toHaveLength(0)
  })

  test('sweeper 的审计行归给系统(无操作者),且空转不写行', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    // 还在保留期内 ⇒ 这一拍什么都没归档 ⇒ 不该留下噪音审计行。
    await addTask(db, { id: 'fresh', status: 'done', finishedAt: NOW - 1 * DAY })
    await runTaskArchiveSweep(db, { enabled: true, retentionDays: 90 }, { ...dirs, now: NOW })
    expect(await auditRows(db)).toHaveLength(0)

    await addTask(db, { id: 'old', status: 'done', finishedAt: NOW - 300 * DAY })
    await runTaskArchiveSweep(db, { enabled: true, retentionDays: 90 }, { ...dirs, now: NOW })
    const audit = await auditRows(db)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.source).toBe('sweep')
    expect(audit[0]!.actorUserId).toBeNull()
    expect(JSON.parse(audit[0]!.rootTaskIdsJson)).toEqual(['old'])
    expect(
      await db
        .select({
          operation: taskExecutionMaintenanceClaims.operation,
          state: taskExecutionMaintenanceClaims.state,
        })
        .from(taskExecutionMaintenanceClaims),
    ).toContainEqual({ operation: 'retention', state: 'completed' })
  })
})

// 归档 = 导出 + 删库。删库靠 FK 级联,而级联是**跟着 schema 长的**:以后任何人给
// tasks / node_runs 挂一张新的 cascade 子表,那张表的行就会随归档一起消失。如果它
// 不在导出清单里,这就是一次静默丢失——目录里没有、库里也没有,而且没有任何报错。
// 这条守卫把「schema 里有什么」和「归档导出了什么」直接对上,新表要么进清单、要么
// 进豁免清单(并写明为什么)。
//
// RFC-317 CC-01 订正:原来这里只走**一跳**(`if (target !== 'tasks' && target !==
// 'node_runs') continue`),于是跨两跳才够到根的表一律被判成「够不着」。而
// `ON DELETE CASCADE` 是**传递**的:删 tasks 带走 doc_versions,带走 doc_versions
// 又带走 review_comments。`review_comments` 就是这么被静默删掉的——它既不在导出
// 清单也不在豁免清单,而守卫全绿。现在改用不动点闭包 `cascadeClosure`,新表挂在
// 任何一张已可达的表上都会自动进入分母。
describe('RFC-311 T19 / RFC-317 R8 — 级联闭包与导出清单的对账', () => {
  const ROOTS = ['tasks', 'node_runs'] as const

  test('每一张随 tasks/node_runs **传递**级联删除的表,要么被归档,要么显式豁免', () => {
    const reachable = cascadeClosure(schema, ROOTS)
    for (const root of ROOTS) reachable.delete(root)

    // 语料非空:闭包算出 0 张表说明 schema 反射或 roots 名字变了,本用例此刻零预言力。
    expect(reachable.size, '级联闭包扫到 0 张表——反射口径已失效,不是「真的没有」').toBeGreaterThan(
      10,
    )

    const covered = new Set([...ARCHIVED_TABLES, ...ARCHIVE_EXEMPT_TABLES])
    const uncovered = [...reachable].filter((name) => !covered.has(name)).sort()
    expect(
      uncovered,
      `这些表会随归档删库消失,却既不在 ARCHIVED_TABLES 也不在 ARCHIVE_EXEMPT_TABLES 里:${uncovered.join(', ')}`,
    ).toEqual([])
  })

  test('闭包确实比一跳更宽——review_comments 只有闭包看得见', () => {
    // 这条是上面那条的**预言力证明**:它锁死「闭包 ⊋ 一跳」,并点名当初漏掉的那张表。
    // 如果哪天有人把 cascadeClosure 改回一跳,这里会红,而不是让守卫悄悄退化。
    const oneHop = new Set<string>()
    for (const edge of cascadeEdges(schema)) {
      if ((ROOTS as readonly string[]).includes(edge.parent)) oneHop.add(edge.child)
    }
    const closure = cascadeClosure(schema, ROOTS)
    for (const root of ROOTS) closure.delete(root)

    const onlyInClosure = [...closure].filter((name) => !oneHop.has(name)).sort()
    expect(onlyInClosure, '闭包必须真的比一跳宽,否则这次修复没有任何效果').toContain(
      'review_comments',
    )
    expect([...ARCHIVED_TABLES]).toContain('review_comments')
  })

  test('合成孙表 fixture:闭包会报,一跳不会（RFC-317 R8 的算法证明）', () => {
    // 不往真 schema 里塞故意的违规——用一份**手写边集**喂给同一个纯算法。
    // `cascadeEdges` 已经把「非 cascade 的外键」过滤掉了,所以这里的边集按定义
    // 只含 cascade 边;要证的是「传递」这一点。
    const edges = [
      { child: 'child', parent: 'tasks' },
      { child: 'grandchild', parent: 'child' },
      { child: 'unrelated', parent: 'some_other_root' },
    ] as const

    const closure = closureOverEdges(edges, ['tasks'])
    expect([...closure].sort()).toEqual(['child', 'grandchild', 'tasks'])

    const oneHop = edges.filter((edge) => edge.parent === 'tasks').map((edge) => edge.child)
    expect(oneHop, '一跳看不见孙表——这正是 review_comments 当初逃掉的机制').toEqual(['child'])
    expect(closure.has('unrelated'), '闭包不能过宽:够不到的根不该被拉进来').toBe(false)
  })

  test('豁免清单只放确实不值得归档的运行态', () => {
    // 豁免是有代价的(数据真的没了),所以清单必须短且逐条有理由。
    expect([...ARCHIVE_EXEMPT_TABLES]).toEqual(['runtime_session_leases'])
  })
})
