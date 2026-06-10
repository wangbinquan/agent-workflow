// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md §⑥ 缺口4 + 附录C-4 (WP-6a)
//
// 纯函数面（evaluateExitCondition 喂空串）已被既有测试盖住，本文件不重复：
//   - port-count-lt '' → count=0 < n 恒真：exit-condition.test.ts:101（默认分隔符）、
//     exit-condition-custom-separator.test.ts:87（自定义分隔符）
//   - port-not-empty '' → 恒假：exit-condition.test.ts:72
// 本文件锁定的是报告未被任何测试覆盖的【组合缺陷】（已对照源码核实可达）：
//
// 当前缺陷行为：
//   - workflow.validator.ts:638-672 对 wrapper-loop 的 exitCondition 只校验
//     "节点存在 + 端口存在"，【不要求】被引节点在 loop 体内 —— 引用 loop 体外
//     节点的工作流 validator 全绿（零 issue），startTask 的启动门
//     （task.ts:414-427）也照常放行。
//   - 运行时 readPortAtIteration 严格按 `iteration = i` 过滤（scheduler.ts:3606-3615）。
//     loop 体外节点只在顶层 iteration=0 跑一次，因此 i≥1 时恒返回 ''。
//   - 于是 port-count-lt 引用体外端口时：i=0 读到真实内容（可能 false 继续），
//     i=1 读到 '' → count=0 < n 恒真 → 【恒在第 2 轮退出】，与被引端口的实际
//     内容完全无关。loop 显示 done，任务全绿 —— 静默错误形态。
//     （port-not-empty 引体外端口没有可区分的错误形态：i=0 非空则两种语义都当轮
//     退出、空则都 exhausted，故本文件不为它落集成用例。）
//   - 可达性注记：v1 wrapper 不接受任何入边（validator 报 edge-target-port-missing），
//     所以用户可保存/可启动的形态里 lister 与 loop 必然无序 —— iteration 0 与
//     lister 完成存在竞速（提前读 '' 则第 1 轮就退）；但 i≥1 恒 '' 的缺陷不受竞速
//     影响，loop 无论如何不会晚于第 2 轮退出。运行时用例为消除 iteration 0 的竞速
//     直接播种带 lister→loop 排序边的 snapshot（runTask 只做 schema parse、不跑
//     validator），从而能精确断言"恰好第 2 轮退出"。
//
// 正确语义应是（二选一，对应两条修复路径）：
//   a) WP-6a validator 短期禁入：exitCondition 引用 loop 体外节点直接报 error
//      （校验失败不阻止保存、但 startTask 启动门会拒绝启动；本文件 validator
//      用例应翻转为"期待 scope error"断言）；或
//   b) 运行时读"被引端口的最新值"（last-value）：体外端口 5 行 findings、n=3 时
//      5<3 恒假 → loop 应跑满 maxIterations 落 exhausted、任务 failed。
//      （届时本文件翻红：done→failed、worker 2 轮→4 轮，按断言旁注释翻转。）
//
// 修复归属：WP-6a（validator 禁入 + 现状固化）。

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { validateWorkflowDef } from '../src/services/workflow.validator'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_OPENCODE = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

// Five findings lines — count=5 with the default '\n' separator. Under
// "read the latest value" semantics 5 < 3 is false on EVERY iteration.
const FINDINGS = 'f1\nf2\nf3\nf4\nf5'

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-gap4-loop-exit-'))
  const worktreePath = join(appHome, 'wt')
  const stateDir = join(appHome, 'scenario-state')
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const planFile = join(appHome, 'plan.json')
  writeFileSync(
    planFile,
    JSON.stringify({
      lister: [{ output: { findings: FINDINGS } }],
      worker: [{ output: { out: 'iter-result' } }],
    }),
  )
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    stateDir,
    planFile,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

// exitCondition references 'lister' which lives OUTSIDE the loop body.
//
// Two variants of the same workflow:
//   - withOrderingEdge=false — what a user can actually save AND start
//     (validator fully green; the launch gate task.ts:414-427 passes). v1
//     wrappers accept no inbound edges at all, so EVERY user-reachable
//     out-of-loop exitCondition reference is unordered w.r.t. the loop:
//     iteration 0 races lister (exit at iter 0 reading '' vs iter 1 reading
//     the real 5 lines) — but i≥1 reads '' either way, so the loop NEVER
//     exits later than iteration 1 regardless of content. Used by the
//     validator test below.
//   - withOrderingEdge=true — adds lister→loop, which deriveFrontier honors
//     as a dispatch dep (both ends in the top scope) but the v1 validator
//     REJECTS as 'edge-target-port-missing' (wrappers take no inbound
//     edges), so it can only exist as a directly-seeded snapshot. Used by
//     the runtime test purely to pin iteration 0 deterministically (lister
//     done first → i=0 reads the real content) so the lock can assert the
//     exact exit iteration instead of a racy disjunction.
function buildDefinition(withOrderingEdge: boolean): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    nodes: [
      { id: 'lister', kind: 'agent-single', agentName: 'lister' },
      { id: 'worker', kind: 'agent-single', agentName: 'worker' },
      {
        id: 'loop',
        kind: 'wrapper-loop',
        nodeIds: ['worker'],
        maxIterations: 4,
        exitCondition: { kind: 'port-count-lt', nodeId: 'lister', portName: 'findings', n: 3 },
        outputBindings: [{ name: 'final', bind: { nodeId: 'worker', portName: 'out' } }],
      },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: withOrderingEdge
      ? [
          {
            id: 'e1',
            source: { nodeId: 'lister', portName: 'findings' },
            target: { nodeId: 'loop', portName: 'findings' },
          },
        ]
      : [],
  }
}

async function seedWorkflowAndTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
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
    inputs: '{}',
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

describe('gap4 — wrapper-loop exitCondition referencing an out-of-loop node (current-behavior lock)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('validator accepts the out-of-loop reference with ZERO issues (no scope rule — WP-6a wants this to become an error)', () => {
    // DEFECT LOCK: only node-existence + port-existence are checked
    // (workflow.validator.ts:638-672); 'lister' exists and declares
    // 'findings', so the out-of-scope reference sails through. This uses the
    // edge-free variant — the one a user can really save AND start (the
    // launch gate task.ts:414-427 only blocks on validator errors, of which
    // there are none) — and pins the FULL issue list to [] so any new
    // diagnostic for this shape (whatever its code) flips it. After the
    // WP-6a validator rule lands, flip to expect the scope error.
    const mkAgent = (name: string, outputs: string[]): Agent => ({
      id: `agent-${name}`,
      name,
      description: '',
      outputs,
      readonly: true,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    const res = validateWorkflowDef(buildDefinition(false), {
      agents: [mkAgent('lister', ['findings']), mkAgent('worker', ['out'])],
      skills: [],
    })
    expect(res.ok).toBe(true)
    expect(res.issues).toEqual([])
  })

  test('port-count-lt against an out-of-loop port ALWAYS exits on iteration 1, regardless of the referenced content', async () => {
    await seedAgent(h.db, 'lister', ['findings'])
    await seedAgent(h.db, 'worker', ['out'])
    // Ordering-edge variant, seeded directly as the task snapshot (runTask
    // only schema-parses it; the validator runs at startTask, not here) so
    // lister deterministically completes before iteration 0's exit check.
    const taskId = await seedWorkflowAndTask(h, buildDefinition(true))

    await withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
      }),
    )

    // Sanity: the referenced out-of-loop port really held 5 lines (count=5,
    // so 5 < 3 should NEVER be true under last-value semantics).
    const listerRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'lister')))
    expect(listerRuns.length).toBe(1)
    expect(listerRuns[0]?.iteration).toBe(0)
    const listerOut = (
      await h.db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(
            eq(nodeRunOutputs.nodeRunId, listerRuns[0]!.id),
            eq(nodeRunOutputs.portName, 'findings'),
          ),
        )
    )[0]
    expect(listerOut?.content).toBe(FINDINGS)

    // DEFECT LOCK: iteration 0 reads the real row (5 < 3 → false, continue);
    // iteration 1's readPortAtIteration(lister, findings, 1) finds no row →
    // '' → count 0 < 3 → exit. The loop lands 'done' after exactly 2 of its
    // 4 allowed iterations and the task goes green.
    // After the runtime (last-value) fix: task 'failed'
    // (wrapper-loop-exhausted), loop row 'exhausted', worker rows = 4.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const loopRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    )[0]
    expect(loopRun?.status).toBe('done')

    const workerRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'worker')))
    expect(workerRuns.map((r) => r.iteration).sort()).toEqual([0, 1])
  })
})
