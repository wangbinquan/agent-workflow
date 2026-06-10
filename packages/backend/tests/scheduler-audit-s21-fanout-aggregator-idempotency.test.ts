// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-21 (WP-6b)
//
// S-21 有两半，本文件各锁一半：
//
// ① aggregator 行无幂等复用（scheduler.ts:3064-3075）：
//   当前缺陷行为：dispatchFanoutShard 为"重启残留子行导致聚合挑错行"这一
//   危害专门写了 prior-child 复用分支（scheduler.ts:2784-2824，注释直言动机，
//   测试 scheduler-boundary-fanout-resume-duplicate-shards.test.ts 锁定），但
//   dispatchFanoutAggregator 自身没有同款分支 —— 每次进入都 `ulid()` 新铸一行
//   aggregator node_run；daemon 重启后旧的 interrupted aggregator 行永久残留
//   （永远不会被复用、不会被转移状态），aggNode 行数随每次恢复 +1。
//   正确语义：aggregator 应像 shard 一样按 (parentNodeRunId, shardKey=null)
//   复用既有子行（done 直接复用输出 / 非终态原行重跑）。修复落在 WP-6b
//   （"aggregator 复用分支 + done 过滤"）：届时 test 1 应翻红 —— aggNode 总行数
//   断言从 2 翻成 1（残留行被原地复用重跑），按各断言旁注释翻转期望值。
//
// ② 聚合输入挑 inner 行不过滤 status='done'（scheduler.ts:3021-3035）：
//   当前缺陷行为：`innerRows` 查询只按 (taskId, nodeId, parentNodeRunId)
//   检索、无 status 过滤、无 orderBy；`innerRows.find((r) => r.shardKey ===
//   s.shardKey)` 取 SELECT 顺序里第一条命中行。RFC-060 design §7.5 伪码明确
//   要求"聚合阶段只看 done 状态 shard 的输出"。当前仅因 S-18 的 fail-all
//   语义（任一 shard 失败 → wrapper failed → 聚合根本不执行）"碰巧"保证
//   进聚合时全 done 才不出错 —— 一旦 WP-6a 落地部分容忍，这里会静默读到
//   失败 shard 的空输出。由于 fail-all + dispatch 阶段对非 done 首行的
//   原地重跑（scheduler.ts:2812-2824）联手挡住了所有能让"非 done 行进入
//   聚合"的确定性构造（任何同 shardKey 的非 done 首行都会先被重跑成 done，
//   重跑失败则 wrapper 在聚合前就 failed），无法用集成测试稳定触发挑错行，
//   按调研分工的指引退化为源码文本断言兜底（test 2）。修复（WP-6b：
//   filter(done) + isFresherNodeRun 取最新）后 test 2 翻红，直接删除或改写
//   为"必须包含 done 过滤"的正向断言。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

// Same-ms ULID ordering guard (precedent: scheduler-clarify-dispatch.test.ts:33-40):
// pre-seed 的 wrapper 行 / shard 子行 / 残留 aggregator 行同毫秒连铸，必须
// 保证 id 顺序 == 插入顺序，latest-by-id 类断言才确定。
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const SCHEDULER_SRC = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-audit-s21-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify(extra),
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
    startedAt: Date.now(),
  })
  return taskId
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

// input docs → fan(wrapper-fanout, shardSource docs) → inner(worker) → aggNode(agg)
// 与 scheduler-wrapper-fanout-e2e.test.ts test 4 同构。
function fanoutWithAggregatorDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
    nodes: [
      { id: 'inp', kind: 'input', inputKey: 'docs' },
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['inner', 'aggNode'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      {
        id: 'inner',
        kind: 'agent-single',
        agentName: 'worker',
        promptTemplate: 'Process {{doc}}',
      },
      {
        id: 'aggNode',
        kind: 'agent-single',
        agentName: 'agg',
        promptTemplate: 'Merge {{items}}',
      },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'inp', portName: 'docs' },
        target: { nodeId: 'fan', portName: 'docs' },
      },
      {
        id: 'eB',
        source: { nodeId: 'fan', portName: 'docs' },
        target: { nodeId: 'inner', portName: 'doc' },
        boundary: 'wrapper-input',
      },
      {
        id: 'eAgg',
        source: { nodeId: 'inner', portName: 'result' },
        target: { nodeId: 'aggNode', portName: 'items' },
      },
    ],
  }
}

describe('scheduler-audit S-21 — fanout aggregator idempotency + done-filter (current-behavior lock)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  // ---------------------------------------------------------------------------
  // ① 重启恢复：shard 子行被复用（不重跑），aggregator 却新铸一行，
  //    旧 interrupted aggregator 行永久残留。
  // ---------------------------------------------------------------------------
  test('resume reuses done shard children but MINTS A NEW aggregator row; stale interrupted aggregator row is permanent residue', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    await seedAgent(h.db, 'agg', ['result'], {
      role: 'aggregator',
      outputWrapperPortNames: { result: 'final' },
    })

    const def = fanoutWithAggregatorDef()
    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md' })

    // 复刻 daemon 重启后的恢复现场（同 scheduler-boundary-fanout-resume-
    // duplicate-shards.test.ts 的构造方式）：
    //   - wrapper 行存活为 'pending'（resume 转 running 合法）；
    //   - 两个 shard 子行已 done、输出已持久化（→ dispatchFanoutShard 的
    //     prior-child 分支会原样复用，不再 spawn）；
    //   - 上一代 aggregator 子行被 reap 成 'interrupted' 残留。
    const wrapperRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: wrapperRunId,
      taskId,
      nodeId: 'fan',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: null,
      shardKey: null,
      startedAt: Date.now(),
    })
    const doneShardA = ulid()
    const doneShardB = ulid()
    for (const [id, key, content] of [
      [doneShardA, 'a.md', 'A-out'],
      [doneShardB, 'b.md', 'B-out'],
    ] as const) {
      await h.db.insert(nodeRuns).values({
        id,
        taskId,
        nodeId: 'inner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        parentNodeRunId: wrapperRunId,
        shardKey: key,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      })
      await h.db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'result', content })
    }
    const staleAggId = ulid()
    await h.db.insert(nodeRuns).values({
      id: staleAggId,
      taskId,
      nodeId: 'aggNode',
      status: 'interrupted',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: wrapperRunId,
      shardKey: null,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })

    const argvCapture = join(h.appHome, 'argv-capture.jsonl')
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'AGG' }),
        MOCK_OPENCODE_CAPTURE_ARGV_TO: argvCapture,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // wrapper 行被复用（RFC-040 wrapper resume），没有重铸。
    const wrapperRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRows.length).toBe(1)
    expect(wrapperRows[0]?.id).toBe(wrapperRunId)
    expect(wrapperRows[0]?.status).toBe('done')

    // 对照面（shard 侧有复用防护）：done shard 子行被原样复用 —— 整个恢复
    // 过程只 spawn 了 1 个 opencode 进程，且就是 aggregator（agent='agg'）。
    const invocations = readFileSync(argvCapture, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { agent: string; argv: string[] })
    expect(invocations.length).toBe(1)
    expect(invocations[0]?.agent).toBe('agg')
    // 复用的 done 子行输出真实喂进了聚合 prompt（argv[0]==='run'，argv[1] 即
    // 渲染后的完整 user prompt —— 同 scheduler-audit-s05 的捕获约定）：
    // `### shardKey\n内容` 块、shardKey 字典序。这证明聚合读到的是
    // pre-seed 行持久化的输出（A-out/B-out），而不是任何新 spawn 的产物。
    const aggPrompt = invocations[0]?.argv[1] ?? ''
    expect(aggPrompt).toContain('### a.md\nA-out')
    expect(aggPrompt).toContain('### b.md\nB-out')
    expect(aggPrompt.indexOf('### a.md')).toBeLessThan(aggPrompt.indexOf('### b.md'))
    // shard 子行没有新增、没有改动。
    const innerRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    expect(innerRows.length).toBe(2)
    expect(innerRows.map((r) => r.id).sort()).toEqual([doneShardA, doneShardB].sort())

    // 缺陷面（aggregator 侧无复用）：aggNode 现在挂着 2 行 ——
    // 残留的 interrupted 行原封不动 + 新铸的 done 行。
    // 修复（WP-6b aggregator 复用分支）后翻转：总行数 1，且残留行被原地
    // 复用重跑（id === staleAggId、status 'done'）。
    const aggRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'aggNode'))
    expect(aggRows.length).toBe(2)
    const staleRow = aggRows.find((r) => r.id === staleAggId)!
    expect(staleRow.status).toBe('interrupted') // 永久残留，无人认领
    const freshRow = aggRows.find((r) => r.id !== staleAggId)!
    expect(freshRow.id > staleAggId).toBe(true) // 新铸 ulid，非复用
    expect(freshRow.status).toBe('done')
    expect(freshRow.parentNodeRunId).toBe(wrapperRunId)
    expect(freshRow.shardKey).toBeNull()

    // 聚合结果本身正确（本场景全 done，无 status 过滤"碰巧"无害）：
    // outlet 'final' 拿到 aggregator 输出。
    const wrapperOuts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, wrapperRunId))
    expect(wrapperOuts.find((o) => o.portName === 'final')?.content).toBe('AGG')
  }, 60_000)

  // ---------------------------------------------------------------------------
  // ② 源码文本兜底：聚合输入挑行无 status='done' 过滤、无排序、无复用分支。
  //    集成层无法确定性构造"非 done 行进入聚合"（见文件头说明），故按
  //    调研分工指引锁定源码文本。
  // ---------------------------------------------------------------------------
  test('source-text lock: dispatchFanoutAggregator picks inner rows with NO status filter, NO ordering, NO prior-row reuse', () => {
    const src = readFileSync(SCHEDULER_SRC, 'utf-8')
    const start = src.indexOf('async function dispatchFanoutAggregator')
    expect(start).toBeGreaterThan(-1)
    // 函数体切片：到下一个顶层 `async function` 为止。
    const nextFn = src.indexOf('\nasync function ', start + 1)
    expect(nextFn).toBeGreaterThan(start)
    const body = src.slice(start, nextFn)

    // (a) 挑行谓词只比 shardKey，不看 status —— RFC-060 §7.5 要求 done-only。
    //     修复后此行会变成带 done 过滤 / freshest 选择的形态 → 断言翻红，
    //     届时改写为"必须包含 done 过滤"的正向断言或直接删除本 test。
    expect(body).toContain('innerRows.find((r) => r.shardKey === s.shardKey)')
    // shared 上游分支同病：同样只比 shardKey === null。
    expect(body).toContain('innerRows.find((r) => r.shardKey === null)')

    // (b) innerRows 检索段（select → find 之间）完全不含 status 条件 / orderBy。
    const segStart = body.indexOf('const innerRows')
    expect(segStart).toBeGreaterThan(-1)
    const segEnd = body.indexOf('innerRows.find((r) => r.shardKey === s.shardKey)')
    const segment = body.slice(segStart, segEnd)
    expect(segment).not.toContain('status')
    expect(segment).not.toContain('orderBy')

    // (c) 无 prior-row 复用分支：shard 路径的幂等复用（dispatchFanoutShard
    //     的 priorChild / priorChildren，scheduler.ts:2784-2824）在 aggregator
    //     这里不存在 —— 行子铸造是无条件的 `ulid()`。
    expect(body).not.toContain('priorChild')
    expect(body).toContain('const aggRunId = ulid()')

    // 对照锚点：shard 路径确实有那套复用（保证 (c) 不是空泛断言）。
    // 顺序守卫：切片 [shardStart, start) 仅在 dispatchFanoutShard 定义在
    // dispatchFanoutAggregator 之前时才有意义；函数重排时给出可诊断的失败。
    const shardStart = src.indexOf('async function dispatchFanoutShard')
    expect(shardStart).toBeGreaterThan(-1)
    expect(shardStart).toBeLessThan(start)
    const shardBody = src.slice(shardStart, start)
    expect(shardBody).toContain('priorChild')
  })
})
