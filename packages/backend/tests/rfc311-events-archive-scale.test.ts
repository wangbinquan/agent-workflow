// RFC-311 PR-2 — events archiver at real backlog scale.
//
// The pre-RFC-311 archiver deleted one batch with `DELETE … IN (<toDrop ids>)`.
// Any backlog above SQLite's 32766 bound-parameter limit made that statement a
// hard runtime error, so the hourly archiver FAILED EVERY TICK while the table
// kept growing — the exact death spiral the production 2.2GB DB was in (audit
// L3-4). This file pins the rewrite: range deletes in bounded batches, a
// per-run incremental high-water scan, and a per-tick row budget.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, users, workflows } from '../src/db/schema'
import { archiveEvents, readArchivedEvents } from '../src/services/eventsArchive'
import { readMaintenanceNumber } from '../src/services/maintenanceState'
import { count, max } from 'drizzle-orm'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Db = ReturnType<typeof createInMemoryDb>

async function seedRun(db: Db, taskId: string, runId: string): Promise<void> {
  const now = 1_788_278_400_000
  await db
    .insert(users)
    .values({
      id: 'u1',
      username: 'u1',
      displayName: 'U',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
  await db
    .insert(workflows)
    .values({ id: 'wf1', name: 'wf', definition: '{"nodes":[],"edges":[],"inputs":[]}' })
    .onConflictDoNothing()
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/never',
      worktreePath: '/tmp/never',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'done',
      inputs: '{}',
      startedAt: 100,
      finishedAt: 200,
      runningMs: 0,
      ownerUserId: 'u1',
    })
    .onConflictDoNothing()
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'n1',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: 100,
  })
}

async function insertEvents(
  db: Db,
  runId: string,
  n: number,
  payloadOf: (i: number) => string = (i) => `line-${i}`,
): Promise<void> {
  const CHUNK = 2_000
  for (let i = 0; i < n; i += CHUNK) {
    const batch = Array.from({ length: Math.min(CHUNK, n - i) }, (_, j) => ({
      nodeRunId: runId,
      ts: 1_000 + i + j,
      kind: 'stderr' as const,
      payload: payloadOf(i + j),
    }))
    await db.insert(nodeRunEvents).values(batch)
  }
}

async function eventCount(db: Db): Promise<number> {
  const rows = await db.select({ n: count(nodeRunEvents.id) }).from(nodeRunEvents)
  return rows[0]?.n ?? 0
}

describe('RFC-311 G3 — 扫描分窗:短语句、不丢行、不跳水位', () => {
  // 分窗之前，增量扫描的上界是开的:首轮(水位=0)等于把整张事件表 GROUP BY 一遍,
  // 10M 行库实测**单条语句 1.19 秒**——daemon 只有一条同步连接,这段时间整站无
  // 响应。分窗把「一条语句的时长」与「一轮的总工作量」解耦。这里用极小的窗口
  // (10 个 id)逼出多轮窗口，锁两件事:窗口边界不丢行、被预算截断时水位不前跳。
  test('rows spanning many windows are all found, and the watermark never skips unprocessed ids', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = mkdtempSync(join(tmpdir(), 'aw-rfc311-g3-'))
    try {
      await seedRun(db, 'task-a', 'run-a')
      await seedRun(db, 'task-b', 'run-b')
      // 两个 run 交替写入 ⇒ 任一窗口里都同时出现两者,窗口边界处最容易漏。
      for (let i = 0; i < 60; i += 1) {
        await insertEvents(db, i % 2 === 0 ? 'run-a' : 'run-b', 1)
      }
      const before = await eventCount(db)
      expect(before).toBe(60)

      const thresholds = { perNodeRunRows: 5, globalRows: 1_000_000 }
      const result = await archiveEvents(db, { eventsArchiveThresholds: thresholds }, logsDir, {
        scanWindowIds: 10,
      })
      // 每个 run 各 30 行、保留 5 行 ⇒ 各归档 25 行。窗口边界漏行会让这个数变小。
      expect(result.perGroupArchived).toBe(50)
      expect(await eventCount(db)).toBe(10)

      const watermark = await readMaintenanceNumber(db, 'events_archive_high_water')
      const maxRow = await db.select({ m: max(nodeRunEvents.id) }).from(nodeRunEvents)
      // 水位走到了最后一个已扫过的 id(不是停在 0,也不能超过表里最大 id)。
      expect(watermark).toBeGreaterThan(0)
      expect(watermark!).toBeGreaterThanOrEqual(maxRow[0]?.m ?? 0)
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  })

  // 上面那条只验证了「分窗之后仍然正确」——把分窗整个删掉它照样绿(无上界扫描
  // 也能找全所有行)。真正要锁的是**扫描语句有上界**这件事本身,而语句时长在
  // 单元测试里测不出来,所以退到源码层断言(仓规:运行时难覆盖时至少留一条文本
  // 断言兜底)。
  test('the incremental scan keeps an upper bound on its id range', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'eventsArchive.ts'),
      'utf8',
    )
    expect(source).toContain('lte(nodeRunEvents.id, scanTo)')
    // 无上界的旧形态:直接对 `id > highWater` 做 GROUP BY。
    expect(source).not.toMatch(/where\(gt\(nodeRunEvents\.id, highWater\)\)/)
  })
})

describe('RFC-311 — events archiver at backlog scale', () => {
  // 实现门 P0-1(变异 #7:把区间删改回一次性 35000 参数的巨型 IN,4 条仍全绿)——
  // 本机 bun 1.3.13 打包的 SQLite 3.51 实测在 5 万参数下**不报错**(10 万才抛),
  // 所以「40k 行 > 32766」这个前提在本环境根本不成立,测试名与注释都是未验证假设。
  // 真正要锁的是**语句形状**:每条 DELETE 的绑定参数是常数(区间删),批次数随
  // toDrop 线性——这与引擎的参数上限解耦,换个更保守的 SQLite 构建也照样成立。
  test('a 40k-row backlog archives in bounded batches with constant-size DELETEs', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = mkdtempSync(join(tmpdir(), 'rfc311-arch-'))
    try {
      await seedRun(db, 't1', 'run1')
      await insertEvents(db, 'run1', 40_000)

      const result = await archiveEvents(
        db,
        { eventsArchiveThresholds: { perNodeRunRows: 5_000, globalRows: 1_000_000 } },
        logsDir,
      )
      expect(result.perGroupArchived).toBe(35_000)
      expect(await eventCount(db)).toBe(5_000)

      // 形状锁:删除走「node_run_id = ? AND id <= ?」的区间形式(两个绑定参数),
      // 不得回到 `IN (<toDrop 个 id>)`。
      const src = readFileSync(
        resolve(import.meta.dir, '..', 'src', 'services', 'eventsArchive.ts'),
        'utf8',
      )
      expect(src).toMatch(/lte\(nodeRunEvents\.id, lastId\)/)
      expect(src).not.toMatch(/inArray\(\s*nodeRunEvents\.id/)
      // 且每批不超过 ARCHIVE_BATCH_ROWS——批大小是常数,与 backlog 无关。
      expect(src).toMatch(/ARCHIVE_BATCH_ROWS = 5_000/)

      // The JSONL carries exactly the archived prefix, ids ascending.
      const archived = await readArchivedEvents(logsDir, 't1', 'run1', 0, 50_000)
      expect(archived.length).toBe(35_000)
      expect(archived[0]!.payload).toBe('line-0')
      expect(archived.at(-1)!.payload).toBe('line-34999')

      // DB retains the newest tail — seamless continuation for the reader.
      const remaining = await db
        .select({ payload: nodeRunEvents.payload })
        .from(nodeRunEvents)
        .limit(1)
      expect(remaining[0]?.payload).toBe('line-35000')
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  })

  test('high-water advances after a clean pass and skips unchanged runs', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = mkdtempSync(join(tmpdir(), 'rfc311-arch-hw-'))
    try {
      await seedRun(db, 't1', 'run1')
      await insertEvents(db, 'run1', 1_000)
      const thresholds = { perNodeRunRows: 600, globalRows: 1_000_000 }

      const first = await archiveEvents(db, { eventsArchiveThresholds: thresholds }, logsDir)
      expect(first.perGroupArchived).toBe(400)
      // 实现门 P1-7(变异 #16:把 highWater 写死 0 使增量扫描失效,4 条仍全绿)——
      // 断言它推进到「本轮见过的最大 id」,而不是只查非空。
      const maxIdRow = await db.select({ maxId: max(nodeRunEvents.id) }).from(nodeRunEvents)
      const highWater = await readMaintenanceNumber(db, 'events_archive_high_water')
      expect(highWater).toBe(maxIdRow[0]?.maxId ?? 0)

      // No new rows → the incremental scan sees nothing and archives nothing.
      const second = await archiveEvents(db, { eventsArchiveThresholds: thresholds }, logsDir)
      expect(second.perGroupArchived).toBe(0)

      // New rows push the run back over the threshold → caught incrementally.
      await insertEvents(db, 'run1', 200)
      const third = await archiveEvents(db, { eventsArchiveThresholds: thresholds }, logsDir)
      expect(third.perGroupArchived).toBe(200)
      expect(await eventCount(db)).toBe(600)
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  })

  test('byte watermark fires while the ROW watermark is still far away (proposal C3)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = mkdtempSync(join(tmpdir(), 'rfc311-arch-bytes-'))
    try {
      await seedRun(db, 't1', 'run1')
      // 5000 × 1KiB ≈ 5MB — far under the 1M-row watermark, well over 2MB.
      await insertEvents(db, 'run1', 5_000, () => 'x'.repeat(1024))
      const result = await archiveEvents(
        db,
        {
          eventsArchiveThresholds: {
            perNodeRunRows: 1_000_000,
            globalRows: 1_000_000,
            perNodeRunBytes: 0,
            globalBytes: 2 * 1024 * 1024,
          },
        },
        logsDir,
      )
      // Derived rows = 2MiB / (1024B payload + fixed-overhead estimate):
      // exact value tracks the sampling constant, so pin a tolerance band.
      const remaining = await eventCount(db)
      expect(result.globalArchived).toBeGreaterThan(2_500)
      expect(remaining).toBeGreaterThanOrEqual(1_000)
      expect(remaining).toBeLessThanOrEqual(2_200)
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  })

  test('global cap also archives via range deletes without parameter blowups', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = mkdtempSync(join(tmpdir(), 'rfc311-arch-glob-'))
    try {
      await seedRun(db, 't1', 'run1')
      await insertEvents(db, 'run1', 36_000)
      const result = await archiveEvents(
        db,
        { eventsArchiveThresholds: { perNodeRunRows: 1_000_000, globalRows: 1_000 } },
        logsDir,
      )
      expect(result.globalArchived).toBe(35_000)
      expect(await eventCount(db)).toBe(1_000)
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  })
})
