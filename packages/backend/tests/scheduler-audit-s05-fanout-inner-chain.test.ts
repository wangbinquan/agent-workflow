import { rimrafDir } from './helpers/cleanup'
// design/scheduler-audit-2026-06-10.md S-5 — 分层状态（RFC-094 / WP-6a 已部分修复）：
//
// 【层 2 = 已修复（RFC-094），断言锁定正确语义】
//   - validator 现在以 error 'fanout-inner-chain-unsupported' 拒绝指向非
//     aggregator inner 节点的 inner-to-inner 数据边（短期止血：错误只阻启动
//     不阻保存）。
//   - boundary='wrapper-input' 边不再被规则 2 误报 edge-source-port-missing
//     （审计缺口 ⑥-9：这种边的 source 是 wrapper 本体，由规则 4 精确校验）。
//
// 【层 1 / 层 3 = CURRENT-BEHAVIOR LOCK，仍锁缺陷现状（WP-6b 根治时翻转）】
//   1. resolveUpstreamInputs (services/scheduler.ts) 用 `parentNodeRunId ===
//      null` 过滤候选行 —— fanout 内 per-shard 节点 A 的全部产出都挂在 shard
//      child 行上，A→B 链的 B 在解析上游时一行都拿不到：目标端口键整体缺失，
//      consumed 也为空。
//   3. 运行时静默成功 —— B 的 prompt 里 A 的端口占位符被 renderUserPrompt
//      （`v ?? ''`）静默替换为空字符串，任务整体 done 无报错；且 inner 派发按
//      nodeIds[] 数组序而非拓扑序。（这两层的工作流经直接 runTask 构造，不过
//      validator 门，故新 error 规则不影响它们的锁定。）
//   WP-6b 运行时修复（dispatchFanoutShard 按 shardKey 解析上游 child 行 +
//   拓扑序派发）落地时：fixer prompt 应包含 AUDIT-FINDING-SENTINEL，层 1/3
//   断言按旁注翻转，层 2 的 error 规则届时放开。

import type { Agent, WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { resolveUpstreamInputs, runTask } from '../src/services/scheduler'
import { validateWorkflowDef } from '../src/services/workflow.validator'
import { createLogger } from '../src/util/log'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

// 同毫秒多行排序确定化（先例：scheduler-clarify-dispatch.test.ts:33-40）。
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const log = createLogger('test-s05-fanout-chain')

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// 层 1 — 纯函数面：resolveUpstreamInputs 的 parentNodeRunId===null 过滤
// （模式参考 resolve-upstream-inputs-picker-baseline.test.ts；PB4 已锁
//  "child 行存在但有 top-level 行兜底"的场景，这里锁 S-5 特有的
//  "上游产出【只】存在于 child 行 → 端口整体缺失"场景。）
// ---------------------------------------------------------------------------

async function seedBareTask(db: DbClient): Promise<string> {
  const taskId = `task_s05_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 's05',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 's05',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/s05',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

// id 用显式字典序字符串（'01...'），与 baseline 测试同法，排序确定。
async function seedRunWithOutput(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: {
    id: string
    iteration?: number
    retryIndex?: number
    status?: string
    parentNodeRunId?: string | null
    shardKey?: string | null
  },
  outputs: Record<string, string>,
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: fields.id,
    taskId,
    nodeId,
    status: (fields.status ?? 'done') as 'done',
    retryIndex: fields.retryIndex ?? 0,
    iteration: fields.iteration ?? 0,
    parentNodeRunId: fields.parentNodeRunId ?? null,
    shardKey: fields.shardKey ?? null,
  })
  for (const [portName, content] of Object.entries(outputs)) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: fields.id, portName, content })
  }
  return fields.id
}

function chainEdge(): WorkflowEdge {
  return {
    id: 'eChain',
    source: { nodeId: 'audit', portName: 'result' },
    target: { nodeId: 'fix', portName: 'findings' },
  }
}

describe('S-5 layer 1 — resolveUpstreamInputs excludes shard child rows wholesale', () => {
  test('upstream output existing ONLY on shard child rows → target port key entirely absent, consumed empty', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedBareTask(db)
    // fanout wrapper 行（child 行的 parent）。
    await db.insert(nodeRuns).values({
      id: '01WRAP',
      taskId,
      nodeId: 'fan',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: null,
    })
    // A（audit）的产出只存在于 shard child 行上 —— fanout 内 per-shard 节点的
    // 真实落库形态（见 scheduler.ts dispatchFanoutShard 的 insert：
    // parentNodeRunId = wrapperRunId）。
    await seedRunWithOutput(
      db,
      taskId,
      'audit',
      { id: '01SHARD_A', status: 'done', parentNodeRunId: '01WRAP', shardKey: 'a.md' },
      { result: 'FINDING-FOR-a.md' },
    )
    await seedRunWithOutput(
      db,
      taskId,
      'audit',
      { id: '01SHARD_B', status: 'done', parentNodeRunId: '01WRAP', shardKey: 'b.md' },
      { result: 'FINDING-FOR-b.md' },
    )

    const { inputs, consumed } = await resolveUpstreamInputs(
      db,
      taskId,
      [chainEdge()],
      'fix',
      0,
      log,
    )
    // [FLIP] 修复（长期方案：按 shardKey 解析 child 行）后：inputs.findings
    // 应携带对应 shard 的 'FINDING-FOR-*' 内容，consumed 应记录 child 行 id。
    // 当前缺陷行为：done 的 child 行被 parentNodeRunId===null 过滤整体排除，
    // 端口键缺失（注意：连空字符串都不是 —— key 不存在），provenance 为空。
    expect(inputs).toEqual({})
    expect(consumed).toEqual({})
  })

  test('control: same shape with a top-level done row resolves normally (proves the filter is the discriminator)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedBareTask(db)
    await seedRunWithOutput(
      db,
      taskId,
      'audit',
      { id: '01TOP', status: 'done', parentNodeRunId: null },
      { result: 'TOP-LEVEL-FINDING' },
    )
    const { inputs, consumed } = await resolveUpstreamInputs(
      db,
      taskId,
      [chainEdge()],
      'fix',
      0,
      log,
    )
    // 唯一差别是 parentNodeRunId=null —— 内容立即可见。证明层 1 的空结果
    // 完全由 child-row 过滤造成，而非端口名/状态等其他因素。
    expect(inputs.findings).toBe('TOP-LEVEL-FINDING')
    expect(consumed.audit).toBe('01TOP')
  })
})

// ---------------------------------------------------------------------------
// 层 2 — validator 面：inner-to-inner 链路边零规则
// （模式参考 workflow-validator-wrapper-fanout.test.ts 的 agent()/makeDef()。）
// ---------------------------------------------------------------------------

function valAgent(name: string, fields: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs: ['result'],
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
    ...fields,
  }
}

// 产品主打场景：fanout 内 audit→fix per-shard 链。fix 非 aggregator。
function chainWorkflowDef(nodeIds: string[] = ['audit', 'fix']): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
    nodes: [
      { id: 'inp', kind: 'input', inputKey: 'docs' },
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds,
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      {
        id: 'audit',
        kind: 'agent-single',
        agentName: 'auditor',
        promptTemplate: 'Audit {{doc}}',
      },
      {
        id: 'fix',
        kind: 'agent-single',
        agentName: 'fixer',
        promptTemplate: 'Fix using: [{{findings}}] end',
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
        target: { nodeId: 'audit', portName: 'doc' },
        boundary: 'wrapper-input',
      },
      // S-5 的主角：fanout 内 inner-to-inner 链路边，目标是非 aggregator。
      {
        id: 'eChain',
        source: { nodeId: 'audit', portName: 'result' },
        target: { nodeId: 'fix', portName: 'findings' },
      },
    ],
  } as unknown as WorkflowDefinition
}

describe('S-5 layer 2 — RFC-094 validator guardrails (flipped from the pre-fix locks)', () => {
  test('chain edge eChain is rejected with fanout-inner-chain-unsupported (error)', () => {
    const res = validateWorkflowDef(chainWorkflowDef(), {
      agents: [valAgent('auditor'), valAgent('fixer')],
      skills: [],
    })
    // RFC-094 (WP-6a)：v1 明确拒绝指向非 aggregator inner 节点的 inner-to-inner
    // 数据边——派发侧不喂 per-shard 链，fix 端口在运行时恒为空（层 3 仍锁该现状，
    // 直到 WP-6b 落地真正的链派发后一并翻转）。
    const chainIssues = res.issues.filter((i) => i.pointer === 'eChain')
    expect(chainIssues).toHaveLength(1)
    expect(chainIssues[0]!.code).toBe('fanout-inner-chain-unsupported')
    expect(chainIssues[0]!.severity ?? 'error').toBe('error')
    expect(res.ok).toBe(false)
  })

  test('boundary edge eB no longer misfires edge-source-port-missing (audit gap ⑥-9 fixed)', () => {
    // RFC-094：规则 2 对 boundary='wrapper-input' 边豁免 source-port 检查——
    // 这种边的 source 就是 wrapper 本体，由规则 4 的
    // boundary-input-port-not-declared 精确校验（未声明场景仍报错，见
    // rfc094-validator-guardrails.test.ts 的反例用例与
    // workflow-validator-wrapper-fanout.test.ts:245）。
    const res = validateWorkflowDef(chainWorkflowDef(), {
      agents: [valAgent('auditor'), valAgent('fixer')],
      skills: [],
    })
    const nonChainIssues = res.issues.filter(
      (i) => i.pointer !== 'eChain' && !i.message.includes('eChain'),
    )
    expect(nonChainIssues.map((i) => ({ code: i.code, pointer: i.pointer }))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 层 3 — 运行时集成面：B 全绿跑完但 prompt 里 A 的端口是空字符串；
//        inner 派发按 nodeIds[] 数组序而非拓扑序。
// （harness 仿 scheduler-wrapper-fanout-e2e.test.ts；prompt 捕获用
//  fixtures/mock-opencode.ts 的 MOCK_OPENCODE_CAPTURE_ARGV_TO —— argv[1]
//  即 runner 传给 opencode 的完整渲染后 prompt。）
// ---------------------------------------------------------------------------

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  captureFile: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-s05-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    captureFile: join(appHome, 'argv-capture.jsonl'),
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedAgentRow(db: DbClient, name: string): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(['result']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string>,
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf-s05',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 's05-task',
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

// env 注入后还原（同 scheduler-wrapper-fanout-e2e.test.ts 的 withEnv）。
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

function readCapturedSpawns(captureFile: string): Array<{ agent: string; prompt: string }> {
  const lines = readFileSync(captureFile, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
  return lines.map((l) => {
    const row = JSON.parse(l) as { agent: string; argv: string[] }
    // mock-opencode 以 `run "<prompt>" --agent NAME ...` 被调起；argv 已
    // slice(2)，所以 argv[0]==='run'、argv[1] 即渲染后的完整 user prompt。
    return { agent: row.agent, prompt: row.argv[1] ?? '' }
  })
}

const SENTINEL = 'AUDIT-FINDING-SENTINEL'

describe('S-5 layer 3 — runtime: per-shard chain B runs green on empty input', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test("R1: topological nodeIds [audit, fix] — audit data lands in DB, yet fix's prompt renders {{findings}} as ''", async () => {
    await seedAgentRow(h.db, 'auditor')
    await seedAgentRow(h.db, 'fixer')
    const taskId = await seedWorkflowAndTask(h, chainWorkflowDef(['audit', 'fix']), {
      docs: 'a.md\nb.md',
    })
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: SENTINEL }),
        MOCK_OPENCODE_CAPTURE_ARGV_TO: h.captureFile,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    // —— 静默成功的全套外观：任务 done、wrapper done、B 的 shard 行 done。
    const t = await h.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(t[0]?.status).toBe('done')
    const wrapperRow = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRow[0]?.status).toBe('done')

    // audit 的 2 个 shard child 行确实带着真实产出落库了（数据存在）。
    const auditRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'audit'))
    ).filter((r) => r.parentNodeRunId === wrapperRow[0]!.id)
    expect(auditRows.length).toBe(2)
    for (const r of auditRows) {
      expect(r.status).toBe('done')
      const outs = await h.db
        .select()
        .from(nodeRunOutputs)
        .where(eq(nodeRunOutputs.nodeRunId, r.id))
      expect(outs.find((o) => o.portName === 'result')?.content).toBe(SENTINEL)
    }

    // fix 被 applyAutoPromote 提为 per-shard：2 个 child 行、shardKey 对齐、全 done。
    const fixRows = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fix'))).filter(
      (r) => r.parentNodeRunId === wrapperRow[0]!.id,
    )
    expect(fixRows.length).toBe(2)
    expect(fixRows.map((r) => r.shardKey).sort()).toEqual(['a.md', 'b.md'])
    for (const r of fixRows) expect(r.status).toBe('done')

    // —— 核心锁定：prompt 内容。
    const spawns = readCapturedSpawns(h.captureFile)
    const auditSpawns = spawns.filter((s) => s.agent === 'auditor')
    const fixSpawns = spawns.filter((s) => s.agent === 'fixer')
    expect(auditSpawns.length).toBe(2)
    expect(fixSpawns.length).toBe(2)

    // 对照组：boundary 注入是通的 —— audit 每个 shard 的 prompt 携带分片值。
    const auditPrompts = auditSpawns.map((s) => s.prompt).sort()
    expect(auditPrompts[0]).toContain('Audit a.md')
    expect(auditPrompts[1]).toContain('Audit b.md')

    for (const s of fixSpawns) {
      // [FLIP] 长期修复（同 shardKey 上游 child 行解析）后：fix prompt 应
      // 包含 `Fix using: [${SENTINEL}] end`，下面两条断言整体反转。
      // 当前缺陷行为：即便 audit 的 2 个 shard 在 fix 派发前已全部 done
      // （nodeIds 给的是拓扑序，时序上最有利），{{findings}} 仍被渲染成
      // 空字符串 —— resolveUpstreamInputs 的 child-row 过滤是结构性的，
      // 与派发顺序无关。
      expect(s.prompt).toContain('Fix using: [] end')
      expect(s.prompt).not.toContain(SENTINEL)
    }
  }, 30000)

  test('R2: reversed nodeIds [fix, audit] — inner dispatch follows array order, fix runs entirely BEFORE audit', async () => {
    await seedAgentRow(h.db, 'auditor')
    await seedAgentRow(h.db, 'fixer')
    const taskId = await seedWorkflowAndTask(h, chainWorkflowDef(['fix', 'audit']), {
      docs: 'a.md\nb.md',
    })
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: SENTINEL }),
        MOCK_OPENCODE_CAPTURE_ARGV_TO: h.captureFile,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const t = await h.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(t[0]?.status).toBe('done')

    // [FLIP] 修复（拓扑序派发）后：无论 nodeIds 数组序如何，audit 都应先于
    // fix 派发 —— 此处前两条 spawn 应变为 auditor。
    // 当前缺陷行为：scheduler.ts:2517 的 for-of 按 nodeIds[] 原样迭代且逐个
    // await Promise.all，数组序 = 派发序。nodeIds 逆序时 fix 的两个 shard
    // 在 audit 任何一行存在之前就已 spawn —— 即使未来修掉 child-row 过滤，
    // 非拓扑派发也会让 B 读不到 A（capture 文件按 append 序记录 spawn 序）。
    const spawns = readCapturedSpawns(h.captureFile)
    expect(spawns.length).toBe(4)
    expect(spawns.slice(0, 2).map((s) => s.agent)).toEqual(['fixer', 'fixer'])
    expect(spawns.slice(2, 4).map((s) => s.agent)).toEqual(['auditor', 'auditor'])
    // 且 fix 的 prompt 同样是空输入渲染。
    for (const s of spawns.slice(0, 2)) {
      expect(s.prompt).toContain('Fix using: [] end')
      expect(s.prompt).not.toContain(SENTINEL)
    }
  }, 30000)
})
