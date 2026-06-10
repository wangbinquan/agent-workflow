// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-7 (WP-6c) + S-28 (WP-6d)
//
// S-7（P1）当前缺陷行为：consumedUpstreamRunsJson 只在 agent 路径
// （scheduler.ts:1448/1457/1545，恒写 JSON.stringify(...)，最少 '{}'）与
// wrapper-fanout 路径（:2452-2455，RFC-074 §8 D3）写入；
// runLoopWrapperNode（:2178-2336）/ runGitWrapperNode（:3186-3302）全段零写入，
// loop/git wrapper 行的 consumed 恒 NULL。
// 后果：freshness.ts:54-65 对空 consumed 恒判 fresh（机制前提已由
// freshness.test.ts B1 锁定）→ loop/git wrapper 的 done 行在上游 clarify/review
// 重跑后永不判 stale、永不重派，下游静默消费过期输出。
// 正确语义：与 fanout 对齐——wrapper 行应落 inner 节点外部上游的 consumed 并集，
// 上游 rerun 后 wrapper 判 stale 重派。修复落在 WP-6c。
// 修复时本文件应翻红：把下方标 [S-7 LOCK] 的 `toBeNull()` 断言翻成
// "非 null 且可解析为 {upstreamNodeId: runId}"。
//
// S-28（P3）当前缺陷行为：wrapper 行 fresh-mint 后 DB 全程 'pending'（从不进
// running），WS 却 eager 广播 'running'——loop :2248-2249、git :3230-3231、
// fanout :2430-2431 都是 insert('pending') 后立刻 broadcast('running')，中间没有
// 任何 DB 转移；markWrapperTerminal 的 allowedFrom 也因此必须容忍 'pending'
// （:2162）。DB/WS 双口径：页面刷新后状态 chip 从 running 回跳 pending。
// 正确语义：fresh-mint 后补一笔 pending→running DB 转移，eager 广播移到 CAS 之后。
// 修复落在 WP-6d。修复时把下方标 [S-28 LOCK] 的
// `dbStatusAtRunningBroadcast === 'pending'` 翻成 'running'。
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
// 纯函数层 — S-7 的危害在派发谓词上的直接后果。
// （"null consumed 恒 fresh" 的机制前提本身已由 freshness.test.ts B1 锁定，
// 这里锁的是它与 wrapper 行形态组合后的派发结论。）
// ---------------------------------------------------------------------------

describe('S-7 纯函数层 — consumed=NULL 的 loop wrapper done 行对上游推进免疫', () => {
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

  test('[S-7 LOCK] 生产形态（consumed=NULL）：上游推进后 wrapper 仍 fresh、不可重派', () => {
    const loopDone = row({ consumedUpstreamRunsJson: null })
    expect(isNodeRunFresh(loopDone, upstreamAdvanced)).toBe(true)
    // done ∧ fresh → 不重派 → 下游静默消费过期 loop 输出。修复后（wrapper 行
    // 落 consumed）此形态不再出现；本断言对照组保证谓词侧无需改动。
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
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedReadonlyAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
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

describe('S-7 / S-28 集成层 — loop/git wrapper 行 consumed 恒 NULL；DB pending 与 WS running 双口径', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => {
    h.cleanup()
    resetBroadcastersForTests()
  })

  test('wrapper-loop：跑完后 wrapper 行 consumed IS NULL（agent 行写 {} 作对照）；running 广播瞬间 DB 是 pending', async () => {
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
    // [S-7 LOCK] runLoopWrapperNode 全段不写 consumed —— 行恒 NULL。
    // 修复（WP-6c：wrapper 行落 inner 外部上游 consumed 并集）后翻成：
    //   expect(loopRows[0]?.consumedUpstreamRunsJson).not.toBeNull()
    expect(loopRows[0]?.consumedUpstreamRunsJson).toBeNull()

    // 对照组：agent 行哪怕零上游也恒写 '{}'（scheduler.ts:1357 JSON.stringify）。
    const auditRows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'audit')))
    expect(auditRows.length).toBe(1)
    expect(auditRows[0]?.consumedUpstreamRunsJson).toBe('{}')

    // [S-28 LOCK] WS 广播序是 running → done；但 running 广播瞬间 DB 行还是
    // 'pending'（fresh-mint 路径 :2248-2249 无 pending→running 转移）。
    // 修复（WP-6d）后把第一个 db 期望翻成 'running'。
    expect(pairs.map((p) => p.ws)).toEqual(['running', 'done'])
    expect(pairs[0]?.db).toBe('pending')
    expect(pairs[1]?.db).toBe('done')
  })

  test('wrapper-git：跑完后 wrapper 行 consumed IS NULL；running 广播瞬间 DB 是 pending', async () => {
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
    // [S-7 LOCK] runGitWrapperNode 全段不写 consumed。修复后翻成 not.toBeNull()。
    expect(wgRows[0]?.consumedUpstreamRunsJson).toBeNull()

    // [S-28 LOCK] git wrapper fresh-mint（:3230-3231）同型双口径。修复后第一个
    // db 期望翻成 'running'。
    expect(pairs.map((p) => p.ws)).toEqual(['running', 'done'])
    expect(pairs[0]?.db).toBe('pending')
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

    // S-28 同样适用于 fanout fresh-mint（:2430-2431）——三处 mint 点同型。
    expect(pairs.map((p) => p.ws)).toEqual(['running', 'done'])
    expect(pairs[0]?.db).toBe('pending')
    expect(pairs[1]?.db).toBe('done')
  })
})
