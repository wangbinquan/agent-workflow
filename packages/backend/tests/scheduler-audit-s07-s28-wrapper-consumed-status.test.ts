import { rimrafDir } from './helpers/cleanup'
// S-7 已修（RFC-098 B3 / WP-6c）→ [S-7 LOCK] 断言已按头注指引翻转为回归防护；
// S-28 已修（RFC-098 B3 / WP-6d，Stage2）→ [S-28 LOCK] 三断言已翻转为回归防护。
// 原始报告：design/scheduler-audit-2026-06-10.md S-7 (WP-6c) + S-28 (WP-6d)
//
// S-7（P1）修复后语义（本文件现在锁定的就是它）：loop/git wrapper 行在
// fresh-mint 时写入 inner 外部上游的 consumed 并集（computeWrapperConsumed →
// wrapperExternalUpstreamSources + pickUpstreamSourceRun），与 fanout 路径
// （RFC-074 §8 D3）对齐——零上游 def 也至少落 '{}'。resume 路径**不覆盖写**
// （对抗检视修订 #6：覆盖写会掩盖停泊期间的外部源 rerun；resume 不写由
// rfc098-wrapper-stale-redispatch.test.ts 锁定）。上游 rerun 后 wrapper done
// 行判 stale 重派——后果链同样由该文件锁定。
// 任何 refactor 把 loop/git wrapper 行的 consumed 写回 NULL = S-7 回归。
//
// S-28（P3）修复后语义（本文件现在锁定的就是它）：三处 wrapper fresh-mint
// （loop/git/fanout）在 insert('pending') 后立刻补一笔 mark-running DB 转移
// （transitionNodeRunStatus），eager 'running' 广播移到 CAS 之后——任何
// node.status 广播瞬间 DB 行必持有同一状态（lifecycle.ts「先写 DB 后广播」
// 规则）；markWrapperTerminal 的 allowedFrom 同步去掉了 'pending'。
// 任何 refactor 让 running 广播瞬间 DB 仍是 'pending' = S-28 回归。
//
// 观测方式（确定性，无轮询）：taskBroadcaster.subscribe 的 listener 在
// broadcast() 内同步执行（ws/broadcaster.ts:33-46），此刻 scheduler 协程停在
// broadcastNodeStatus 的栈帧上、wrapper 行刚插完；listener 里用 drizzle
// bun:sqlite 的同步 .all() 读行状态，零竞态。
//
// 集成 harness 仿 scheduler-clarify-dispatch.test.ts（createInMemoryDb +
// 真实临时 git worktree + fixtures/mock-opencode.ts）。

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { isDispatchable } from '../src/services/dispatchFrontier'
import { isNodeRunFresh } from '../src/services/freshness'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'
import { resetBroadcastersForTests, TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'

// 同毫秒多行 id 排序确定化（先例：scheduler-clarify-dispatch.test.ts:33-40）。
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

type Row = typeof nodeRuns.$inferSelect

// ---------------------------------------------------------------------------
// 纯函数层 — 谓词侧对照组（S-7 修复后两个用例都是"机制前提"锁）。
// 第一个用例锁"null consumed 恒 fresh"与派发谓词组合后的结论——修复后生产
// 不再产出该形态（wrapper 行恒写 consumed），但谓词侧契约必须保持（legacy 行
// /降级路径仍依赖）；第二个用例就是修复后的生产形态。
// ---------------------------------------------------------------------------

describe('S-7 纯函数层 — 谓词对照组：consumed=NULL（legacy 形态）恒 fresh；落 consumed 即可判 stale', () => {
  function row(over: Partial<Row>): Row {
    return {
      id: '01R',
      nodeId: 'lw',
      iteration: 0,
      status: 'done',
      consumedUpstreamRunsJson: null,
      wrapperProgressJson: null,
      ...over,
    } as unknown as Row
  }
  const def = {
    nodes: [
      { id: 'lw', kind: 'wrapper-loop', nodeIds: ['worker'] },
      { id: 'worker', kind: 'agent-single' },
    ],
    edges: [],
  } as unknown as WorkflowDefinition
  // 上游 up 已推进出新的 done 行（如 clarify 答复后的 rerun）。
  const upstreamAdvanced = new Map<string, Row>([['up', row({ id: '01NEW', nodeId: 'up' })]])

  test('[S-7 对照组] legacy 形态（consumed=NULL）：上游推进后 wrapper 仍 fresh、不可重派', () => {
    const loopDone = row({ consumedUpstreamRunsJson: null })
    expect(isNodeRunFresh(loopDone, upstreamAdvanced)).toBe(true)
    // done ∧ fresh → 不重派。S-7 修复后生产 fresh-mint 不再产出 consumed=NULL
    // 的 wrapper 行（恒写，最少 '{}'），但 null→fresh 的谓词契约必须保持
    // （freshness.test.ts B1 同款 legacy/降级兜底）。
    expect(isDispatchable(loopDone, 'wrapper-loop', upstreamAdvanced, [loopDone], def)).toBe(false)
  })

  test('对照组：若 wrapper 行像 fanout 一样落了 consumed → 上游推进即判 stale 可重派', () => {
    const withProvenance = row({ consumedUpstreamRunsJson: JSON.stringify({ up: '01OLD' }) })
    expect(isNodeRunFresh(withProvenance, upstreamAdvanced)).toBe(false)
    expect(
      isDispatchable(withProvenance, 'wrapper-loop', upstreamAdvanced, [withProvenance], def),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 集成层 harness
// ---------------------------------------------------------------------------

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-audit-s07-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  // wrapper-git 的 captureHead 需要真实 git worktree；agents 全 readonly，
  // stash 路径宽松（同 scheduler-clarify-dispatch.test.ts 的说明）。
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'r.md'), '# r\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    repoPath,
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedReadonlyAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
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
    repoPath: h.repoPath,
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

/**
 * 订阅某 nodeId 的 node.status 广播；listener 同步执行时用 .all() 抓该行的
 * DB status 快照（见文件头"观测方式"）。返回 {ws, db} 对的时间序。
 */
function captureWsDbPairs(
  h: Harness,
  taskId: string,
  nodeId: string,
): { pairs: Array<{ ws: string; db: string }>; unsub: () => void } {
  const pairs: Array<{ ws: string; db: string }> = []
  const unsub = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (msg) => {
    if (msg.type !== 'node.status' || msg.nodeId !== nodeId) return
    const row = h.db.select().from(nodeRuns).where(eq(nodeRuns.id, msg.nodeRunId)).all()[0]
    pairs.push({ ws: msg.status, db: row?.status ?? 'absent' })
  })
  return { pairs, unsub }
}

describe('S-7 / S-28 集成层 — loop/git wrapper 行 consumed 恒写；DB 与 WS running 广播同口径', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => {
    h.cleanup()
    resetBroadcastersForTests()
  })

  test('wrapper-loop：跑完后 wrapper 行 consumed 已写（agent 行写 {} 作对照）；running 广播瞬间 DB 已是 running', async () => {
    await seedReadonlyAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'audit', portName: 'findings' },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const taskId = await seedWorkflowAndTask(h, def)
    const { pairs, unsub } = captureWsDbPairs(h, taskId, 'loop')

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: '' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    unsub()

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const loopRows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    expect(loopRows.length).toBe(1)
    expect(loopRows[0]?.status).toBe('done')
    // [S-7 LOCK·已翻转] runLoopWrapperNode fresh-mint 写 consumed（RFC-098
    // B3）。本 def 无任何外部上游 → 精确等于 '{}'（与 agent 行对照组同款
    // "零上游也恒写"语义）。
    expect(loopRows[0]?.consumedUpstreamRunsJson).not.toBeNull()
    expect(JSON.parse(loopRows[0]?.consumedUpstreamRunsJson ?? 'null')).toEqual({})

    // 对照组：agent 行哪怕零上游也恒写 '{}'（scheduler.ts:1357 JSON.stringify）。
    const auditRows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'audit')))
    expect(auditRows.length).toBe(1)
    expect(auditRows[0]?.consumedUpstreamRunsJson).toBe('{}')

    // [S-28 LOCK·已翻转] WS 广播序 running → done，且每次广播瞬间 DB 行持有
    // 同一状态（fresh-mint 后 mark-running CAS 先于广播）。
    expect(pairs.map((p) => p.ws)).toEqual(['running', 'done'])
    expect(pairs[0]?.db).toBe('running')
    expect(pairs[1]?.db).toBe('done')
  })

  test('wrapper-git：跑完后 wrapper 行 consumed 已写；running 广播瞬间 DB 已是 running', async () => {
    await seedReadonlyAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        { id: 'wg', kind: 'wrapper-git', nodeIds: ['audit'] },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const taskId = await seedWorkflowAndTask(h, def)
    const { pairs, unsub } = captureWsDbPairs(h, taskId, 'wg')

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: '' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    unsub()

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const wgRows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'wg')))
    expect(wgRows.length).toBe(1)
    expect(wgRows[0]?.status).toBe('done')
    // [S-7 LOCK·已翻转] runGitWrapperNode fresh-mint 写 consumed（RFC-098
    // B3）；无外部上游 → '{}'。
    expect(wgRows[0]?.consumedUpstreamRunsJson).not.toBeNull()
    expect(JSON.parse(wgRows[0]?.consumedUpstreamRunsJson ?? 'null')).toEqual({})

    // [S-28 LOCK·已翻转] git wrapper fresh-mint 同型——mark-running 先于广播。
    expect(pairs.map((p) => p.ws)).toEqual(['running', 'done'])
    expect(pairs[0]?.db).toBe('running')
    expect(pairs[1]?.db).toBe('done')
  })

  test('对照组 wrapper-fanout：同一抽象的第三种实现会写 consumed（RFC-074 D3，:2452-2455）——三件套不一致即 S-7 的"漏掉 loop/git"', async () => {
    await seedReadonlyAgent(h.db, 'worker', ['result'])
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' } as WorkflowNode,
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'inner', kind: 'agent-single', agentName: 'worker' },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'inp', portName: 'docs' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
      ],
    }
    // 空 shardSource → 短路 done，不 spawn 任何 opencode；但 consumed 写入
    // （:2452-2455）发生在空源短路（:2465）之前，所以照样落库——这正是对照点。
    const taskId = await seedWorkflowAndTask(h, def, { docs: '' })
    const { pairs, unsub } = captureWsDbPairs(h, taskId, 'fan')

    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })
    unsub()

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const fanRows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'fan')))
    expect(fanRows.length).toBe(1)
    expect(fanRows[0]?.status).toBe('done')
    // fanout wrapper 行带 provenance：精确等于 {inp: 上游 input 节点 done 行的
    // run id}（def 里指向 fan 的边只有 inp→fan 一条，resolveUpstreamInputs 的
    // consumed 字典不会混入别的键）。
    const inpRows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'inp')))
    expect(inpRows.length).toBe(1)
    expect(inpRows[0]?.status).toBe('done')
    const consumed = JSON.parse(fanRows[0]?.consumedUpstreamRunsJson ?? 'null') as Record<
      string,
      string
    > | null
    expect(consumed).toEqual({ inp: inpRows[0]!.id })

    // [S-28 LOCK·已翻转] fanout fresh-mint 同型——三处 mint 点都补了
    // mark-running；本用例还顺带覆盖「mark-running 必须先于空源短路的
    // markWrapperTerminal('done')」（空 shardSource 路径，from='running' 合法）。
    expect(pairs.map((p) => p.ws)).toEqual(['running', 'done'])
    expect(pairs[0]?.db).toBe('running')
    expect(pairs[1]?.db).toBe('done')
  })
})
