// RFC-311 余项 —— 维护循环的「第一拍」与配置热读。
//
// 这条测试为什么存在（2026-08-21 生产对账）：某部署跑的是 v0.18.11，**已经含**
// RFC-311 的事件归档字节水位（`765910a3`），事件表却仍长到 78.6 万行 / 1.72GB。
// 复现后根因不在水位算得对不对，而在装配：
//
//   - `startEventsArchiver` / `startTaskArchiveSweeper` 只挂了 `setInterval(1h)`，
//     **没有 boot 首拍**。平均重启间隔短于一个周期的部署（发版、崩溃、watchdog）
//     这两个清理器一次都不会执行，事件表与终态任务只涨不缩——而它们恰恰是
//     RFC-311 用来给库体积封顶的两个执行者。对照组：`startLifecycleInvariantsLoop`
//     一直是 boot + 周期两拍（`lifecycleInvariants.ts:904-905`）。
//   - `startWalCheckpointLoop` 读的是 **boot 配置快照**（`cli/start.ts:354→900`），
//     而邻居（events 归档器 / webhook GC / worktree GC）都是每拍 `loadConfig()`
//     热读；更糟的是 `intervalMs<=0` 时它直接返回空 handle，**进程里连 timer 都
//     没有**。于是把 `walCheckpointIntervalMs` 从 0 改成 600000 之后，不重启
//     daemon 永远不生效（用户实测：改完文件、-wal 照涨）。
//
// 三条不变量：
//   ① 两个清理器都在 `bootDelayMs` 内跑第一拍，不必等满一个周期；
//   ② `stop()` 撤得掉还没触发的 boot 首拍——否则 DB 关掉之后定时器还会去碰它；
//   ③ checkpoint 循环每拍热读间隔：0→N 不重启即生效，N→0 立刻停。
//
// 判据都用「轮询到条件成立 + 显式预算」而不是固定 sleep；断言「不该发生」的两条
// 只能等一个远大于 bootDelay 的窗口（10×），这是非事件断言的固有形态。

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { count } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, openDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { startEventsArchiver } from '../src/services/eventsArchive'
import { startTaskArchiveSweeper } from '../src/services/taskArchive'
import { startWalCheckpointLoop } from '../src/services/backupScheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmps.push(d)
  return d
}
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 轮询到条件成立；超预算就带着最后一次观测值失败（而不是静默超时）。 */
async function until(
  what: string,
  predicate: () => Promise<boolean> | boolean,
  budgetMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${budgetMs}ms waiting for: ${what}`)
    await sleep(5)
  }
}

async function seedEvents(db: DbClient, n: number): Promise<void> {
  const workflowId = ulid()
  const taskId = ulid()
  const nodeRunId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'wf', definition: '{}' })
  await db.insert(tasks).values({
    id: taskId,
    name: 'boot-tick-fixture',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/r',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'n1',
    status: 'running',
    startedAt: Date.now(),
  })
  for (let i = 0; i < n; i += 1) {
    await db.insert(nodeRunEvents).values({
      nodeRunId,
      ts: Date.now() + i,
      kind: 'text',
      payload: JSON.stringify({ chunk: i }),
    })
  }
}

async function eventRows(db: DbClient): Promise<number> {
  return (await db.select({ n: count() }).from(nodeRunEvents))[0]?.n ?? 0
}

/** 行数水位（字节水位显式关掉），让归档量完全确定。 */
const ROWS_ONLY = {
  eventsArchiveThresholds: {
    perNodeRunRows: 5,
    globalRows: 1_000,
    perNodeRunBytes: 0,
    globalBytes: 0,
  },
}

describe('RFC-311 余项 ① —— 维护循环必须有 boot 首拍', () => {
  test('事件归档器：boot 后 bootDelayMs 内就跑第一拍，不必等满一个周期', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = join(tmp('aw-boot-tick-'), 'logs')
    await seedEvents(db, 50)
    expect(await eventRows(db)).toBe(50)

    // 周期给足一小时：唯一能让它跑起来的只有 boot 首拍。
    const ticker = startEventsArchiver(db, () => ROWS_ONLY, logsDir, 3_600_000, 15)
    closers.push(() => ticker.stop())

    await until('归档器把这个 run 削到 per-run 水位', async () => (await eventRows(db)) === 5)
  })

  test('事件归档器：stop() 撤得掉还没触发的 boot 首拍', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = join(tmp('aw-boot-tick-'), 'logs')
    await seedEvents(db, 50)

    const ticker = startEventsArchiver(db, () => ROWS_ONLY, logsDir, 3_600_000, 50)
    ticker.stop()

    // 非事件断言：等一个远大于 bootDelay 的窗口（10×）。
    await sleep(500)
    expect(await eventRows(db)).toBe(50)
  })

  test('终态任务 sweeper：boot 后 bootDelayMs 内读一次配置并跑第一拍', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    let reads = 0
    // enabled:false ⇒ runTaskArchiveSweep 在碰任何目录之前就 return（taskArchive.ts:495），
    // 所以这条用例只观察「首拍有没有发生」，不产生任何文件系统副作用。
    const ticker = startTaskArchiveSweeper(
      db,
      () => {
        reads += 1
        return { enabled: false, retentionDays: 90 }
      },
      3_600_000,
      15,
    )
    closers.push(() => ticker.stop())

    await until('sweeper 的 boot 首拍读到配置', () => reads >= 1)
  })

  test('终态任务 sweeper：stop() 撤得掉还没触发的 boot 首拍', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    let reads = 0
    const ticker = startTaskArchiveSweeper(
      db,
      () => {
        reads += 1
        return { enabled: false, retentionDays: 90 }
      },
      3_600_000,
      50,
    )
    ticker.stop()

    await sleep(500)
    expect(reads).toBe(0)
  })
})

describe('RFC-311 余项 ② —— WAL checkpoint 循环每拍热读间隔', () => {
  test('0 → N 不重启即生效；N → 0 立刻停', async () => {
    const dbPath = join(tmp('aw-wal-hot-'), 'db.sqlite')
    const db: DbClient = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    closers.push(() => (db as unknown as { $client: Database }).$client.close())

    const growWal = async (): Promise<number> => {
      for (let i = 0; i < 30; i += 1) {
        await db.insert(workflows).values({
          id: ulid(),
          name: `wf-${i}`,
          definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
        })
      }
      return statSync(`${dbPath}-wal`).size
    }

    let intervalMs = 0
    const ticker = startWalCheckpointLoop({ db, getIntervalMs: () => intervalMs, tickMs: 5 })
    closers.push(() => ticker.stop())

    // ① 0 = 关：给它几十拍的窗口，-wal 不该被截断。
    expect(await growWal()).toBeGreaterThan(0)
    await sleep(200)
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)

    // ② 改成"每拍都到期"，不重启进程 —— 下一拍就该 checkpoint 掉。
    intervalMs = 1
    await until('-wal 被 TRUNCATE 归零', () => statSync(`${dbPath}-wal`).size === 0)

    // ③ 再改回 0，重新长出来的 -wal 不再被动它。
    intervalMs = 0
    expect(await growWal()).toBeGreaterThan(0)
    await sleep(200)
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)
  })

  // 热读的代价：每拍都要碰一次 config 文件。定时器回调里抛出的同步异常没人接得住
  // （uncaughtException 直接打死 daemon），所以一个读坏的 config 只能让这一拍空过，
  // 不能升级成宕机——也不能让循环从此哑掉。
  test('getIntervalMs 抛异常只跳过这一拍，循环不死也不哑', async () => {
    const dbPath = join(tmp('aw-wal-throw-'), 'db.sqlite')
    const db: DbClient = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    closers.push(() => (db as unknown as { $client: Database }).$client.close())
    for (let i = 0; i < 30; i += 1) {
      await db.insert(workflows).values({
        id: ulid(),
        name: `wf-${i}`,
        definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
      })
    }
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)

    let throwing = true
    let reads = 0
    const ticker = startWalCheckpointLoop({
      db,
      getIntervalMs: () => {
        reads += 1
        if (throwing) throw new Error('config-unreadable')
        return 1
      },
      tickMs: 5,
    })
    closers.push(() => ticker.stop())

    await until('抛异常的拍已经过去几轮', () => reads >= 3)
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)

    throwing = false
    await until('config 恢复后循环照常 checkpoint', () => statSync(`${dbPath}-wal`).size === 0)
  })
})
