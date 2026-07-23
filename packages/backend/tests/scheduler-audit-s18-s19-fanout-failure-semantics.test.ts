// REGRESSION LOCK — design/scheduler-audit-2026-06-10.md S-18 + S-19 (WP-6a / WP-6b)
// （S-18 = RFC-094 方案 A 定版的 fail-all 语义锁；S-19 = RFC-098 B3 修复后的
//  done-shard 跨代复用语义锁——两段都不再是缺陷现状锁定。）
//
// S-18（fail-all 现状，scheduler.ts:2612-2622）：
//   当前缺陷行为：wrapper-fanout 的 perShard 分发 join 之后只要
//   `failedShards.length > 0` 就把整个 wrapper 标 failed（errorMessage
//   以 `inner-shard-failed:` 开头），跳过聚合（dispatchFanoutAggregator 从不
//   执行）、不写任何 wrapper outlet —— 已 done shard 的输出对下游完全不可见，
//   设计文档承诺的自动 `errors` port（design/design.md:681/765/779/1246）不存在。
//   注意它也不是 :2763 注释声称的 "fails-fast"：失败 shard 不会取消兄弟
//   shard，三个 shard 全部跑完（join 后才统一判失败）—— 本文件用 mock 调用
//   计数锁定这一点。
//   正确语义（RFC-060 design §7.5，design/RFC-060-fanout-as-wrapper/design.md:529-531）：
//   单 shard 失败只标记该 shard，不阻塞其他 shard；聚合阶段只看 done shard
//   的输出；全部 shard 失败才把 wrapper 标 failed；失败清单走自动 errors port。
//   【RFC-094 决策落定（2026-06-11，方案 A）】：v1 保留 fail-all-after-join 并
//   已写进 design.md §6.3（部分容忍 + errors port 标记为 deferred，归 WP-6b
//   产品决策）。本文件 test 1 自此是**正式回归锁**（锁定与文档一致的语义），
//   不再是缺陷现状锁定；若未来 WP-6b 落地部分容忍，断言随该 RFC 翻转 ——
//   task/wrapper 转 done、aggNode 跑 1 次、wrapper outlet 出现 'final'（和
//   errors port）、下游 down 节点正常 dispatch。
//
// S-19（failed→重试只重跑失败 shard —— RFC-098 B3 已按方案 A 修复，本段
//   自此为**正式回归锁**）：
//   旧缺陷：wrapper 失败后恢复任务时 findResumableWrapperRun 把 `failed` 列为
//   terminal 返回 null → 重铸全新 wrapperRunId → dispatchFanoutShard 的复用
//   查询锚定 `parentNodeRunId = 新 wrapperRunId`，永远查不到旧 wrapper 下已
//   done 的 shard 子行 → 所有 shard（含已成功的）全量重跑。
//   修复语义（方案 A，复用锚放宽）：复用查询改
//   (taskId, innerNodeId, iteration, shardKey, parentNodeRunId IS NOT NULL)
//   —— 跨代 done 子行带 value-hash 匹配直接回放 outputs（不改 parent、不铸
//   行），failed→resume 只重跑失败的那 1 个 shard。test 2 的 mock 调用计数
//   锁 4（run1 3 + run2 1）；新 wrapper 下只铸 1 个新子行（失败 key），
//   其余 key 的旧 done 行被跨代复用、每 key 行数 1。
//
// 确定性手段：maxConcurrentNodes:1 + multiProcessSubprocessConcurrency:1 把
// shard 子进程串行化，配合 MOCK_OPENCODE_FAIL_COUNTER（磁盘计数器）+
// MOCK_OPENCODE_FAIL_UNTIL=1 让"恰好第 1 次 spawn 失败、其余成功"完全确定
// （串行化同时消除了计数器文件的读写竞争）。不依赖信号量的 FIFO 顺序——
// 所有断言只数 status / 行数 / 调用次数，不锁定具体哪个 shardKey 失败。

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

// Same-ms ULID ordering guard (precedent: scheduler-clarify-dispatch.test.ts:33-40).
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-audit-s18-s19-'))
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

describe('scheduler-audit S-18/S-19 — wrapper-fanout failure semantics (regression lock)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  // ---------------------------------------------------------------------------
  // S-18 — 1/3 shard 失败 → 整 wrapper failed；聚合不执行；done shard 输出
  // 对下游不可见；无 errors port。
  // ---------------------------------------------------------------------------
  test('S-18: 1 of 3 shards fails → wrapper fail-all, no aggregation, no errors port, done outputs invisible downstream', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    await seedAgent(h.db, 'agg', ['result'], {
      role: 'aggregator',
      outputWrapperPortNames: { result: 'final' },
    })
    await seedAgent(h.db, 'downstream', ['out'])

    const def: WorkflowDefinition = {
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
        {
          id: 'down',
          kind: 'agent-single',
          agentName: 'downstream',
          promptTemplate: 'Consume {{merged}}',
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
        {
          id: 'eDown',
          source: { nodeId: 'fan', portName: 'final' },
          target: { nodeId: 'down', portName: 'merged' },
        },
      ],
    }

    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md\nc.md' })
    const counterFile = join(h.appHome, 'fail-counter.txt')

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'shard-ok' }),
        MOCK_OPENCODE_FAIL_COUNTER: counterFile,
        MOCK_OPENCODE_FAIL_UNTIL: '1', // 第 1 次 spawn 失败，其余成功
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          // 串行化 shard：调用计数确定（恰好 1 失败 2 成功），计数器文件无竞争。
          maxConcurrentNodes: 1,
          multiProcessSubprocessConcurrency: 1,
        }),
    )

    // 当前行为：任一 shard 失败 → 整 task failed，失败归因到 wrapper 'fan'，
    // errorSummary 直接写明 "1/3 shards failed"（fail-all 的表层证据：仅 1/3
    // 失败也整体失败）。修复（§7.5 部分容忍）后翻转：status 'done'、
    // failedNodeId null、errorSummary null。
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.failedNodeId).toBe('fan')
    expect(t?.errorSummary ?? '').toContain('1/3 shards failed')

    // wrapper 行 failed，errorMessage 锁定 fail-all 路径的 'inner-shard-failed:' 前缀。
    // 修复后翻转：wrapper 应为 'done'，errorMessage 为 null。
    const wrapperRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRows.length).toBe(1)
    const wrapper = wrapperRows[0]!
    expect(wrapper.status).toBe('failed')
    expect(wrapper.errorMessage ?? '').toStartWith('inner-shard-failed:')

    // 不是 fails-fast：失败 shard 不取消兄弟 —— 3 个 shard 全部 spawn 过
    // （join 之后才统一判失败）。计数器恰好 3 同时证明 runNode 在 fanout
    // shard 路径上无内部重试（dispatchFanoutShard 注释 "No retry"）。
    expect(readFileSync(counterFile, 'utf-8').trim()).toBe('3')

    // 3 个 shard 子行：恰好 1 failed + 2 done（串行化 + FAIL_UNTIL=1 保证）。
    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === wrapper.id)
    expect(innerRows.length).toBe(3)
    expect(innerRows.map((r) => r.status).sort()).toEqual(['done', 'done', 'failed'])

    // done shard 的输出已经持久化在子行上（成果存在）……
    const doneChildren = innerRows.filter((r) => r.status === 'done')
    for (const child of doneChildren) {
      const outs = await h.db
        .select()
        .from(nodeRunOutputs)
        .where(eq(nodeRunOutputs.nodeRunId, child.id))
      expect(outs.find((o) => o.portName === 'result')?.content).toBe('shard-ok')
    }
    // ……失败 shard 没有输出行。
    const failedChild = innerRows.find((r) => r.status === 'failed')!
    const failedOuts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, failedChild.id))
    expect(failedOuts.length).toBe(0)

    // 聚合未执行：aggNode 一行都没有。
    // 修复后翻转：aggNode 恰好 1 行 done（只聚合 done shard 的输出）。
    const aggRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'aggNode'))
    expect(aggRows.length).toBe(0)

    // wrapper 行零输出：既没有聚合 outlet 'final'，也没有设计文档
    // （design/design.md:765 "errors port 即使没有失败 shard 也存在"）承诺的
    // 自动 errors port。修复后翻转：'final' 出现，且 errors port 携带失败清单。
    const wrapperOuts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, wrapper.id))
    expect(wrapperOuts.length).toBe(0)
    expect(wrapperOuts.find((o) => o.portName === 'errors')).toBeUndefined()

    // done shard 的输出对下游不可见：down 节点从未被 dispatch。
    // 修复后翻转：down 恰好 1 行 done。
    const downRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'down'))
    expect(downRows.length).toBe(0)
  }, 60_000)

  // ---------------------------------------------------------------------------
  // S-19（RFC-098 B3 修复后回归锁）— failed → resume：重铸新 wrapperRunId，
  // 但旧 wrapper 下已 done 的 shard 子行被跨代复用，只重跑失败的 1 个 shard。
  // ---------------------------------------------------------------------------
  test('S-19: failed fanout + resume re-mints wrapperRunId but REUSES done shards (only the failed shard re-runs)', async () => {
    await seedAgent(h.db, 'worker', ['result'])

    // 无 aggregator 的最小 fanout（outlet 为 __done__ 信号），让 run2 的
    // spawn 计数纯粹等于 shard 数。
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        {
          id: 'inner',
          kind: 'agent-single',
          agentName: 'worker',
          promptTemplate: 'Process {{doc}}',
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
      ],
    }

    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md\nc.md' })
    const counterFile = join(h.appHome, 'fail-counter.txt')
    const env = {
      MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'shard-ok' }),
      MOCK_OPENCODE_FAIL_COUNTER: counterFile,
      MOCK_OPENCODE_FAIL_UNTIL: '1', // 仅全局第 1 次 spawn 失败（run1 的第 1 个 shard）
    }
    const runOpts = {
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      maxConcurrentNodes: 1,
      multiProcessSubprocessConcurrency: 1,
    }

    // ---- run 1：1/3 shard 失败 → wrapper + task failed，2 个 shard done。----
    await withEnv(env, () => runTask(runOpts))

    const t1 = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t1?.status).toBe('failed')
    expect(readFileSync(counterFile, 'utf-8').trim()).toBe('3')

    const wrapperAfterRun1 = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperAfterRun1.length).toBe(1)
    const oldWrapper = wrapperAfterRun1[0]!
    expect(oldWrapper.status).toBe('failed')
    const oldChildren = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === oldWrapper.id)
    expect(oldChildren.length).toBe(3)
    const oldDoneIds = oldChildren.filter((r) => r.status === 'done').map((r) => r.id)
    expect(oldDoneIds.length).toBe(2)

    // ---- resume：复刻 resumeTask 的 DB 侧动作（task.ts:1010-1019）后直接
    // await runTask。resumeTask 本体对 runTask 是 fire-and-forget（无法在测试
    // 里确定性等待），且其余动作（rollbackNodeRunForResume）对 readonly agent
    // + 无 preSnapshot 的行是 no-op，因此这一复刻在调度器视角与真实 resume
    // 完全等价（dispatchFrontier.ts:139 把 failed 行视为 dispatchable）。----
    await h.db
      .update(tasks)
      .set({
        status: 'pending',
        finishedAt: null,
        errorSummary: null,
        errorMessage: null,
        failedNodeId: null,
      })
      .where(eq(tasks.id, taskId))

    // ---- run 2：RFC-098 B3 修复后 = 只重跑失败的 1 个 shard。----
    await withEnv(env, () => runTask(runOpts))

    const t2 = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t2?.status).toBe('done')

    // 核心 oracle：mock 总调用数 3(run1) + 1(run2 仅失败 shard) = 4。
    // 已 done 的 2 个 shard 跨代回放 outputs，零 spawn（真实场景 = 省下
    // 重复 LLM 成本）。回退到全量重跑会把这里翻成 '6'。
    expect(readFileSync(counterFile, 'utf-8').trim()).toBe('4')

    // 仍重铸新 wrapperRunId：findResumableWrapperRun 把 failed 列为 terminal
    // （RFC-098 B3 刻意不动它——复用走子行锚，不走 wrapper 行复活）→ 旧行
    // 保留为历史，新行另起炉灶。
    const wrapperAfterRun2 = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperAfterRun2.length).toBe(2)
    const newWrapper = wrapperAfterRun2.find((r) => r.id !== oldWrapper.id)!
    expect(newWrapper.id > oldWrapper.id).toBe(true)
    expect(newWrapper.status).toBe('done')
    // 旧 wrapper 行保持 failed 不被触碰。
    expect(wrapperAfterRun2.find((r) => r.id === oldWrapper.id)?.status).toBe('failed')

    // 方案 A：新 wrapper 下只铸 1 个新子行 —— 失败的那个 shardKey；其余
    // 2 个 done 子行留在旧 wrapper 名下被原样回放（不改 parent、不铸行，
    // 历史归属真实）。
    const allInner = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    const newChildren = allInner.filter((r) => r.parentNodeRunId === newWrapper.id)
    const failedKey = oldChildren.find((r) => r.status === 'failed')!.shardKey!
    expect(newChildren.length).toBe(1)
    const reRun = newChildren[0]!
    expect(reRun.shardKey).toBe(failedKey)
    expect(reRun.status).toBe('done')
    expect(oldDoneIds.includes(reRun.id)).toBe(false) // 新铸行，不是旧 done 行
    // 旧 done 子行原封不动（id 不变、parent 仍是旧 wrapper、status done）。
    for (const id of oldDoneIds) {
      const row = allInner.find((r) => r.id === id)!
      expect(row.status).toBe('done')
      expect(row.parentNodeRunId).toBe(oldWrapper.id)
    }
    // 行数分布：失败 key 2 行（旧 failed + 新 done），其余 key 各 1 行。
    const byKey = new Map<string, number>()
    for (const r of allInner) byKey.set(r.shardKey ?? '?', (byKey.get(r.shardKey ?? '?') ?? 0) + 1)
    for (const key of ['a.md', 'b.md', 'c.md']) {
      expect(byKey.get(key)).toBe(key === failedKey ? 2 : 1)
    }
  }, 120_000)
})
