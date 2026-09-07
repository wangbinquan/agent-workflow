// RFC-359 W6-T25 —— 批量写：矩阵给出 `batchInsertMax`，逐行 INSERT 的热路径改按批。
//
// 这条文件为什么存在（改动前后要证明的三件事）：
//
//   ① **结果等价**——按批落库的行必须与逐行落库逐字段相同，含顺序敏感的列。测试自带一份
//      逐行参考实现，同一批输入喂给两条路，逐字段对拍。改批量写最容易丢的就是这个。
//   ② **边界闭合**——空集合 / 恰好一批 / max+1 / 2*max+1 都要正确；**一批中途失败必须整笔回滚**。
//      回滚这条尤其重要：`insertInBatches` 里漏一个 `await`，SQLite 侧照样绿（同步驱动），
//      只有 PostgreSQL 才炸——所以它必须在**两个引擎**上各跑一遍（本文件走 describeEachProvider）。
//   ③ **性能形状**——判据是**语句数**（由形状唯一决定），不是墙钟（机器一忙就假红）。
//      逐行写 n 行 = n 条 INSERT；按批 = ceil(n / batchInsertMax) 条。
//
// 实测背景（2026-09-07，node_run_events 单事务插 n 行；墙钟仅作诊断）：
//   n=1000 逐行 SQLite 28.0ms / PostgreSQL 428.2ms；按批 SQLite 9.0ms / PostgreSQL 21.8ms。

import { describe, expect, test } from 'bun:test'
import { and, asc, eq, sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRunEvents, nodeRunOutputs, nodeRuns, tasks, workflows } from '@/db/schema'
import { insertInBatches, lastPerKey } from '@/platform/persistence/batchInsert'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { describeEachProvider } from './helpers/eachProvider'

const TASK_ID = 't_t25'

async function seedTask(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(workflows).values({
    id: 'wf_t25',
    name: 't25',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: TASK_ID,
    name: 't25',
    workflowId: 'wf_t25',
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw-t25',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${TASK_ID}`,
    status: 'running' as const,
    inputs: '{}',
    startedAt: 1,
  })
}

let runSeq = 0
async function seedRun(db: ProviderNeutralDatabase): Promise<string> {
  const id = `nr_t25_${(runSeq += 1)}`
  await db.insert(nodeRuns).values({ id, taskId: TASK_ID, nodeId: 'n1', status: 'running' })
  return id
}

function eventRows(
  nodeRunId: string,
  n: number,
): { nodeRunId: string; ts: number; kind: 'text'; payload: string; sessionId: string | null }[] {
  return Array.from({ length: n }, (_, i) => ({
    nodeRunId,
    ts: 1_000 + i,
    kind: 'text' as const,
    payload: JSON.stringify({ text: `line-${i}` }),
    sessionId: i % 3 === 0 ? null : `ses-${i % 3}`,
  }))
}

/** node_run_events 的批上限：表宽 7 列（含自增 id）。 */
const eventsBatchMax = (h: { capabilities: { batchInsertMax(n: number): number } }): number =>
  h.capabilities.batchInsertMax(7)

// ─── 「一批多少行」只许有一份推导：源代码层地板 ─────────────────────────────────────
//
// 为什么是源代码断言而不是行为断言：runner 改造前后**落库结果完全相同**（同样的行、同样的
// 顺序），差别只在「几笔事务」——进程内测试观察不到（rfc314-event-write-batching 对它自己的
// catch-flush 也留过同样性质的记录）。所以这里钉住形状：runner 不许再自带一份行数上限，
// 切批的唯一出口是能力矩阵。
describe('RFC-359 W6-T25 —— 行数上限只有矩阵一处', () => {
  test('runner 不再自带「一批多少行」的常量，整批交给 appendEvents', () => {
    const runner = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
      'utf8',
    )
    // 只看代码行：整行注释里**故意**留着这个名字，解释它为什么被删（去掉那段说明反而更差）。
    const code = runner
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(
      /EVENT_INSERT_MAX_ROWS|_MAX_ROWS\b|INSERT_MAX/.test(code),
      'runner.ts 里又出现了一份自己的批大小常量 —— 切批归 capabilities.batchInsertMax 一处',
    ).toBe(false)
    // 冲刷把整个缓冲一次交出去（没有再切片）。
    expect(runner).toContain('events: batch,')
  })

  test('批大小的推导只出现在能力矩阵里', () => {
    const matrix = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'platform', 'persistence', 'capabilities.ts'),
      'utf8',
    )
    expect(matrix).toContain('function batchInsertMaxRows(')
    // 两个引擎各只提供自己的两个数，推导不许各写一遍。
    expect(matrix.split('Math.floor(maxBindParameters / columnCount)').length - 1).toBe(1)
  })
})

describeEachProvider('RFC-359 W6-T25 —— batchInsertMax 与批量写', (h) => {
  // ─── ① 矩阵项本身：两个引擎上各有一次真实执行 ────────────────────────────────────

  test('batchInsertMax = min(参数预算 ÷ 列数, 行数甜点)，且按它插满的一批真的能执行', async () => {
    const cap = h.capabilities
    // 窄表：行数甜点（500）先到顶。
    expect(cap.batchInsertMax(1)).toBe(500)
    expect(cap.batchInsertMax(7)).toBe(500)
    // 宽表：参数预算先到顶——`floor(预算 / 列数)` 严格小于甜点时由它说了算。
    const wide = Math.ceil(cap.maxBindParameters / 500) + 1
    expect(cap.batchInsertMax(wide)).toBe(Math.floor(cap.maxBindParameters / wide))
    expect(cap.batchInsertMax(wide)).toBeLessThan(500)
    // 一行就吃光预算的表退化成逐行，不返回 0（否则切批会死循环）。
    expect(cap.batchInsertMax(cap.maxBindParameters * 2)).toBe(1)
    // 列数不合法要大声抛，而不是悄悄返回 Infinity / NaN。
    expect(() => cap.batchInsertMax(0)).toThrow('positive column count')
    expect(() => cap.batchInsertMax(1.5)).toThrow('positive column count')

    // 真实执行：按上限插满一批，行数与内容都对。
    await seedTask(h.db)
    const nodeRunId = await seedRun(h.db)
    const max = eventsBatchMax(h)
    await databaseSessionFor(h.db).transaction(async (tx) => {
      await tx.insert(nodeRunEvents).values(eventRows(nodeRunId, max))
    })
    const stored = await h.db
      .select({ ts: nodeRunEvents.ts })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(stored.length).toBe(max)
  }, 120_000)

  // ─── ② 边界：空 / 恰好一批 / 跨批 / 中途失败整批回滚 ─────────────────────────────

  test('切批边界：0 / 1 / max / max+1 / 2*max+1 行都完整落库，语句数 = ceil(n / max)', async () => {
    await seedTask(h.db)
    const max = eventsBatchMax(h)
    for (const n of [0, 1, max, max + 1, 2 * max + 1]) {
      const nodeRunId = await seedRun(h.db)
      const rec = h.recordStatements()
      let batches = 0
      await databaseSessionFor(h.db).transaction(async (tx) => {
        batches = await insertInBatches(tx, nodeRunEvents, eventRows(nodeRunId, n), (batch) =>
          tx
            .insert(nodeRunEvents)
            .values([...batch])
            .run(),
        )
      })
      const inserts = rec.statements.filter((s) =>
        /^\s*insert\s+into\s+.*node_run_events/i.test(s.sql),
      )
      rec.stop()
      const expected = Math.ceil(n / max)
      expect(batches, `n=${n}`).toBe(expected)
      expect(inserts.length, `n=${n} 的 INSERT 语句数`).toBe(expected)
      // 每条语句的绑定参数都在引擎预算之内——切批的全部意义就在这里。
      for (const statement of inserts) {
        expect(statement.params).toBeLessThanOrEqual(h.capabilities.maxBindParameters)
      }
      const stored = await h.db
        .select({ ts: nodeRunEvents.ts, payload: nodeRunEvents.payload })
        .from(nodeRunEvents)
        .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
        .orderBy(asc(nodeRunEvents.id))
      expect(stored.length, `n=${n} 的落库行数`).toBe(n)
      expect(stored.map((row) => row.ts)).toEqual(eventRows(nodeRunId, n).map((row) => row.ts))
    }
  }, 300_000)

  test('一批中途失败 ⇒ 整笔回滚，先前批次的行一行都不留', async () => {
    await seedTask(h.db)
    const nodeRunId = await seedRun(h.db)
    const max = h.capabilities.batchInsertMax(6) // node_run_outputs 是 6 列
    // 提前占住第二批里的一个端口名：第二批插到它时撞主键，整笔必须回滚。
    await h.db
      .insert(nodeRunOutputs)
      .values({ nodeRunId, portName: `p${max + 3}`, content: 'pre-existing' })

    const rows = Array.from({ length: 2 * max }, (_, i) => ({
      nodeRunId,
      portName: `p${i}`,
      content: `c${i}`,
    }))
    await expect(
      databaseSessionFor(h.db).transaction(async (tx) => {
        await insertInBatches(tx, nodeRunOutputs, rows, (batch) =>
          tx
            .insert(nodeRunOutputs)
            .values([...batch])
            .run(),
        )
      }),
    ).rejects.toThrow()

    // 只剩预置的那一行：第一批（max 行）必须一起被回滚掉。
    const stored = await h.db
      .select({ portName: nodeRunOutputs.portName, content: nodeRunOutputs.content })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
    expect(stored).toEqual([{ portName: `p${max + 3}`, content: 'pre-existing' }])
  }, 300_000)

  // ─── ③ 结果等价：批量 vs 逐行，逐字段对拍 ───────────────────────────────────────

  test('appendEvents：按批落库与逐行落库逐字段相同（含 id 单调 / 顺序）', async () => {
    await seedTask(h.db)
    const persistence = new DrizzleNodeExecutionPersistence(h.db)
    const max = eventsBatchMax(h)
    const n = max + 37 // 跨批，且尾批不满

    const batchedRun = await seedRun(h.db)
    await persistence.appendEvents({ nodeRunId: batchedRun, events: eventRows(batchedRun, n) })

    // 参考实现：一行一条 INSERT（改造前的形状）。
    const referenceRun = await seedRun(h.db)
    await databaseSessionFor(h.db).transaction(async (tx) => {
      for (const row of eventRows(referenceRun, n)) await tx.insert(nodeRunEvents).values(row)
    })

    const read = async (nodeRunId: string) =>
      (
        await h.db
          .select({
            ts: nodeRunEvents.ts,
            kind: nodeRunEvents.kind,
            payload: nodeRunEvents.payload,
            sessionId: nodeRunEvents.sessionId,
            parentSessionId: nodeRunEvents.parentSessionId,
          })
          .from(nodeRunEvents)
          .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
          .orderBy(asc(nodeRunEvents.id))
      ).map((row) => ({ ...row }))

    const batched = await read(batchedRun)
    expect(batched.length).toBe(n)
    expect(batched).toEqual(await read(referenceRun))

    // id 严格单调：顺序敏感的读点（WS 回放 / stderr 拼接）依赖它。
    const ids = await h.db
      .select({ id: nodeRunEvents.id })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, batchedRun))
      .orderBy(asc(nodeRunEvents.id))
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]!.id).toBeGreaterThan(ids[i - 1]!.id)
  }, 300_000)

  test('upsertOutputs：按批 upsert 与逐行 upsert 逐字段相同，重复端口仍是「后写覆盖先写」', async () => {
    await seedTask(h.db)
    const persistence = new DrizzleNodeExecutionPersistence(h.db)
    // 同一批里既有新端口、也有已存在的端口、还有重复端口名——三条路径一次覆盖。
    //
    // **≥2 个已存在端口是必须的**：只有一个的时候，`set` 里错写成「批里第一行的字面量」
    // 也能碰巧对（那一行就是唯一冲突行），变异 M8 因此假绿。两个各带不同新值时，只有
    // `excluded.*`（每行更新成自己那行的值）能过。
    // 两个存量端口的**四个列**都取彼此不同的新值，逐列都能把「拿别人那行的值」抓出来。
    interface OutputWrite {
      readonly portName: string
      readonly content: string
      readonly kind: string | null
      readonly archiveJson: string | null
      readonly active: boolean
    }
    const seededOutputs: readonly OutputWrite[] = [
      { portName: 'a', content: 'stale-a', kind: null, archiveJson: null, active: true },
      { portName: 'b', content: 'stale-b', kind: 'text', archiveJson: '{"old":1}', active: false },
    ]
    const outputs: readonly OutputWrite[] = [
      { portName: 'a', content: 'a1', kind: 'text', archiveJson: null, active: true },
      { portName: 'b', content: 'b1', kind: null, archiveJson: '{"v":1}', active: true },
      { portName: 'a', content: 'a2', kind: 'markdown', archiveJson: null, active: false },
      { portName: 'c', content: 'c1', kind: null, archiveJson: null, active: true },
    ]

    const batchedRun = await seedRun(h.db)
    await persistence.upsertOutputs({ nodeRunId: batchedRun, outputs: seededOutputs })
    await persistence.upsertOutputs({ nodeRunId: batchedRun, outputs })

    // 参考实现：逐行 upsert（改造前的形状），字面量 set。
    const referenceRun = await seedRun(h.db)
    const applyRowByRow = async (
      nodeRunId: string,
      rows: readonly OutputWrite[],
    ): Promise<void> => {
      await databaseSessionFor(h.db).transaction(async (tx) => {
        for (const output of rows) {
          await tx
            .insert(nodeRunOutputs)
            .values({ nodeRunId, ...output })
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: {
                content: output.content,
                kind: output.kind,
                archiveJson: output.archiveJson,
                active: output.active,
              },
            })
        }
      })
    }
    await applyRowByRow(referenceRun, seededOutputs)
    await applyRowByRow(referenceRun, outputs)

    const read = async (nodeRunId: string) =>
      (
        await h.db
          .select({
            portName: nodeRunOutputs.portName,
            content: nodeRunOutputs.content,
            kind: nodeRunOutputs.kind,
            archiveJson: nodeRunOutputs.archiveJson,
            active: nodeRunOutputs.active,
          })
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
          .orderBy(asc(nodeRunOutputs.portName))
      ).map((row) => ({ ...row }))

    const batched = await read(batchedRun)
    expect(batched).toEqual(await read(referenceRun))
    // 具体钉住语义：重复端口 'a' 保留最后一条（a2 / markdown / active=false）；两个存量端口
    // 'a' / 'b' 各自被**自己那行**的新值覆盖（不是被同一行覆盖），四个列都换掉。
    expect(batched).toEqual([
      { portName: 'a', content: 'a2', kind: 'markdown', archiveJson: null, active: false },
      { portName: 'b', content: 'b1', kind: null, archiveJson: '{"v":1}', active: true },
      { portName: 'c', content: 'c1', kind: null, archiveJson: null, active: true },
    ])
  }, 300_000)

  test('lastPerKey：按键保留最后一条，且保持首次出现的相对顺序', () => {
    expect(
      lastPerKey(
        [
          { k: 'a', v: 1 },
          { k: 'b', v: 2 },
          { k: 'a', v: 3 },
        ],
        (row) => row.k,
      ),
    ).toEqual([
      { k: 'a', v: 3 },
      { k: 'b', v: 2 },
    ])
    expect(lastPerKey([] as { k: string }[], (row) => row.k)).toEqual([])
  })

  // ─── ④ 性能形状：语句数不随行数线性增长 ─────────────────────────────────────────

  test('热路径的语句数由形状唯一决定：appendEvents 1000 行 ⇒ ceil(1000/max) 条 INSERT', async () => {
    await seedTask(h.db)
    const persistence = new DrizzleNodeExecutionPersistence(h.db)
    const nodeRunId = await seedRun(h.db)
    const n = 1_000
    const rec = h.recordStatements()
    const started = Bun.nanoseconds()
    await persistence.appendEvents({ nodeRunId, events: eventRows(nodeRunId, n) })
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6
    const inserts = rec.statements.filter((s) =>
      /^\s*insert\s+into\s+.*node_run_events/i.test(s.sql),
    )
    rec.stop()
    // 墙钟只作诊断（机器一忙就飘），判据是语句数。
    console.log(
      `[${h.capabilities.provider}] appendEvents n=${n}: ${inserts.length} 条 INSERT / ${elapsedMs.toFixed(1)}ms`,
    )
    expect(inserts.length).toBe(Math.ceil(n / eventsBatchMax(h)))
    // 逐行写会是 1000 条量级；留一个宽松的塌方探测下界，实现退回逐行立刻红。
    expect(inserts.length).toBeLessThan(n / 10)
    const stored = await h.db
      .select({ n: sql<number>`count(*)` })
      .from(nodeRunEvents)
      .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), eq(nodeRunEvents.kind, 'text')))
    expect(h.capabilities.numericFromRawRow(stored[0]!.n, 'count')).toBe(n)
  }, 300_000)
})
