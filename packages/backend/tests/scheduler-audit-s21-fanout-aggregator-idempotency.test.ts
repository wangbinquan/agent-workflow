// REGRESSION LOCK — design/scheduler-audit-2026-06-10.md S-21 (WP-6b，
// RFC-098 B3 已修复；本文件自此锁定修复后语义，不再是缺陷现状锁定)
//
// S-21 有两半，本文件各锁一半：
//
// ① aggregator 行幂等复用（dispatchFanoutAggregator 复用分支）：
//   旧缺陷：dispatchFanoutShard 有 prior-child 复用分支（测试
//   scheduler-boundary-fanout-resume-duplicate-shards.test.ts 锁定），但
//   dispatchFanoutAggregator 每次进入都 `ulid()` 新铸一行 —— daemon 重启后
//   旧的 interrupted aggregator 行永久残留，aggNode 行数随每次恢复 +1。
//   修复语义（test 1 锁定）：aggregator 镜像 shard 的三分支 —— freshest done
//   且比全部本轮参与 shard 行新 → 回放 outputs；同代非终态残留 → 原地 reset
//   pending 重跑（本测试场景：id === staleAggId 被复用、终态 done、总行数 1）；
//   前代残留 → 铸新行。
//
// ② 聚合输入挑行 done-filter + freshest-per-shardKey（test 2 源码文本正向
//   断言）：旧缺陷是 innerRows 查询无 status 过滤、`innerRows.find(...)` 取
//   SELECT 首行 —— 重启残留的空 interrupted 子行会静默顶掉带输出的 done 行。
//   修复后挑行必须走 pickReusableShardRun（freshness.ts：done-only +
//   isFresherNodeRun + hash null=match），与 dispatchFanoutShard 的复用判定
//   共用同一个 picker（「freshest-run 抽一次别 fork」）；锚也与 shard 同步
//   放宽为 (taskId, nodeId, iteration, parentNodeRunId IS NOT NULL)。由于
//   fail-all + 同代原地重跑挡住了"非 done 行进聚合"的确定性集成构造，这一半
//   仍按调研分工指引保留为源码文本断言（改写成正向形态）。

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
import { canonicalizeWorkflowAgentIds } from './helpers/canonicalWorkflowFixture'

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
  const canonicalDefinition = await canonicalizeWorkflowAgentIds(h.db, definition)
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(canonicalDefinition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(canonicalDefinition),
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

describe('scheduler-audit S-21 — fanout aggregator idempotency + done-filter (regression lock)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  // ---------------------------------------------------------------------------
  // ① 重启恢复：shard 子行被复用（不重跑），aggregator 残留的 interrupted
  //    行同样被原地复用重跑 —— 不再新铸、不再残留。
  // ---------------------------------------------------------------------------
  test('resume reuses done shard children AND re-runs the stale interrupted aggregator row in place (no residue)', async () => {
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
      .map((l) => JSON.parse(l) as { agent: string; argv: string[]; prompt?: string })
    expect(invocations.length).toBe(1)
    expect(invocations[0]?.agent).toBe('agg')
    // 复用的 done 子行输出真实喂进了聚合 prompt（mock 把 `-- ` 之后的尾随
    // prompt 位置参抽成 `prompt` 字段 —— 同 scheduler-audit-s05 的捕获约定）：
    // `### shardKey\n内容` 块、shardKey 字典序。这证明聚合读到的是
    // pre-seed 行持久化的输出（A-out/B-out），而不是任何新 spawn 的产物。
    const aggPrompt = invocations[0]?.prompt ?? invocations[0]?.argv[1] ?? ''
    expect(aggPrompt).toContain('### a.md\nA-out')
    expect(aggPrompt).toContain('### b.md\nB-out')
    expect(aggPrompt.indexOf('### a.md')).toBeLessThan(aggPrompt.indexOf('### b.md'))
    // shard 子行没有新增、没有改动。
    const innerRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    expect(innerRows.length).toBe(2)
    expect(innerRows.map((r) => r.id).sort()).toEqual([doneShardA, doneShardB].sort())

    // 修复面（RFC-098 B3 aggregator 复用分支）：aggNode 总行数 1 —— 残留的
    // interrupted 行被原地复用重跑（同代非终态分支：id === staleAggId、
    // reset pending 后由 runNode 跑成 done），不再新铸、不再残留。
    const aggRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'aggNode'))
    expect(aggRows.length).toBe(1)
    const reusedRow = aggRows[0]!
    expect(reusedRow.id).toBe(staleAggId) // 原地复用，非新铸
    expect(reusedRow.status).toBe('done')
    expect(reusedRow.parentNodeRunId).toBe(wrapperRunId)
    expect(reusedRow.shardKey).toBeNull()

    // 聚合结果本身正确（本场景全 done，无 status 过滤"碰巧"无害）：
    // outlet 'final' 拿到 aggregator 输出。
    const wrapperOuts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, wrapperRunId))
    expect(wrapperOuts.find((o) => o.portName === 'final')?.content).toBe('AGG')
  }, 60_000)

  // ---------------------------------------------------------------------------
  // ② 源码文本兜底（正向形态）：聚合输入挑行必须走共享的 done-filter +
  //    freshest picker（pickReusableShardRun），且 aggregator 自身必须带复用
  //    分支。集成层依旧无法确定性构造"非 done 行进入聚合"（fail-all + 同代
  //    原地重跑挡路，见文件头说明），故按调研分工指引保留源码文本断言。
  // ---------------------------------------------------------------------------
  test('source-text lock: dispatchFanoutAggregator picks inner rows via pickReusableShardRun (done-only + freshest) and reuses its own prior row', () => {
    const src = readFileSync(SCHEDULER_SRC, 'utf-8')
    const start = src.indexOf('async function dispatchFanoutAggregator')
    expect(start).toBeGreaterThan(-1)
    // 函数体切片：到下一个顶层 `async function` 为止。
    const nextFn = src.indexOf('\nasync function ', start + 1)
    expect(nextFn).toBeGreaterThan(start)
    const body = src.slice(start, nextFn)

    // (a) 挑行必须走 pickReusableShardRun（freshness.ts 的 done-only +
    //     isFresherNodeRun + hash null=match picker）——perShard 与 shared
    //     两个分支都不允许退回裸 find 首行匹配。
    expect(body).toContain('pickReusableShardRun(innerRows, {')
    expect(body).toContain('pickReusableShardRun(innerRows, { shardKey: null, valueHash: null })')
    expect(body).not.toContain('innerRows.find((r) => r.shardKey === s.shardKey)')
    expect(body).not.toContain('innerRows.find((r) => r.shardKey === null)')

    // (b) innerRows 检索锚与 shard 路径同步放宽：iteration 维度 + 非空
    //     parentNodeRunId（跨代 done 子行可见，顶层占位行被排除）。
    const segStart = body.indexOf('const innerRows')
    expect(segStart).toBeGreaterThan(-1)
    const segEnd = body.indexOf('if (scope.perShard.has(edge.source.nodeId))')
    expect(segEnd).toBeGreaterThan(segStart)
    const segment = body.slice(segStart, segEnd)
    expect(segment).toContain('eq(nodeRuns.iteration, iteration)')
    expect(segment).toContain('isNotNull(nodeRuns.parentNodeRunId)')

    // (c) aggregator 自身的复用分支存在：同代非终态残留原地 reset 重跑
    //     （reason 'fanout-aggregator-resume'），铸新行不再是无条件路径。
    expect(body).toContain("reason: 'fanout-aggregator-resume'")
    expect(body).not.toContain('const aggRunId = ulid()')
    expect(body).toContain('let aggRunId: string')

    // 对照锚点：shard 路径用的是同一个 picker（「freshest-run 抽一次别
    // fork」缝——两处共用 freshness.ts 的 pickReusableShardRun）。
    // 顺序守卫：切片 [shardStart, start) 仅在 dispatchFanoutShard 定义在
    // dispatchFanoutAggregator 之前时才有意义；函数重排时给出可诊断的失败。
    const shardStart = src.indexOf('async function dispatchFanoutShard')
    expect(shardStart).toBeGreaterThan(-1)
    expect(shardStart).toBeLessThan(start)
    const shardBody = src.slice(shardStart, start)
    expect(shardBody).toContain('pickReusableShardRun(candidates, {')
  })
})
