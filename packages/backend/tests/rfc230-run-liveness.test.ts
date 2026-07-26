// RFC-230 — Run 活性证据链。
//
// 为什么这条测试存在（锁的是哪类回归）：
// 生产事故 `scheduler error` + `node_run <id> is terminal ('interrupted');
// refuse to overwrite (wrapper-finalize)`。周期孤儿回收器把「没有 pid」当成
// 「进程已消失」，而 wrapper 行（git / loop / fanout）永远不会有 pid —— 它不是
// 进程，是一段子图正在被推进的记账行。于是内层跑超 60s 宽限期的 wrapper 被
// 判死翻成 interrupted，收尾撞 lifecycle 终态守卫，整条任务失败；若它恰是最后
// 一条 running 行，任务本身也被翻，顺带伪造出 stuckTaskDetector 的 S3 卡死现场。
//
// 这个盲区此前被 design/test-guard-audit-2026-07-21/01-gaps.md 的
// B2-lifecycle-1 / M1-lcov-4 两条 P1 记过：判活函数是注入式的，四条 reconcile
// 用例全部注入桩，真实判活代码零执行。本文件直测真函数 + 真 wrapper 形状。
//
// 任何 refactor 一旦让下面任一条变红，说明「没有进程 ⇒ 已经死了」这个只对
// agent 成立的前提又被悄悄推广到了容器行上。

import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { NODE_KIND, type NodeKind, type WorkflowDefinition } from '@agent-workflow/shared'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { probeRunProcessAlive, reconcileDeadRunningRuns } from '../src/services/orphanReconcile'
import { listRecoveryEventsForTask } from '../src/services/recovery'
import { __setActiveTaskForTesting } from '../src/services/task'
import {
  classifyRunLiveness,
  livenessSourceOfKind,
  type LivenessRunRow,
  resolveRunLiveness,
} from '../src/services/runLiveness'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_000_000

// --- fixtures ---------------------------------------------------------------

function row(over: Partial<LivenessRunRow> & { id: string; nodeId: string }): LivenessRunRow {
  return {
    status: 'running',
    pid: null,
    spawnBinaryPath: null,
    parentNodeRunId: null,
    ...over,
  }
}

/** git wrapper `w` 包 agent `a`；另有一个独立 agent `solo`。 */
function gitWrapperDef(): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    edges: [],
    nodes: [
      { id: 'w', kind: 'wrapper-git', nodeIds: ['a'] },
      { id: 'a', kind: 'agent-single' },
      { id: 'solo', kind: 'agent-single' },
    ],
  } as unknown as WorkflowDefinition
}

/** loop `outer` 包 git `mid`，git 包 agent `leaf` —— 三层委派。 */
function nestedDef(): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    edges: [],
    nodes: [
      { id: 'outer', kind: 'wrapper-loop', nodeIds: ['mid'] },
      { id: 'mid', kind: 'wrapper-git', nodeIds: ['leaf'] },
      { id: 'leaf', kind: 'agent-single' },
    ],
  } as unknown as WorkflowDefinition
}

const ALIVE = (): boolean => true
const DEAD = (): boolean => false

// --- ① 真进程探针（此前零覆盖的那三条分支）---------------------------------

describe('RFC-230 — 真判活探针 probeRunProcessAlive', () => {
  test('活着的 pid + 无 binary 约束 ⇒ alive', () => {
    expect(probeRunProcessAlive(process.pid, null)).toBe(true)
  })

  test('已退出的 pid ⇒ not alive', async () => {
    const child = Bun.spawn(['/bin/sh', '-c', 'exit 0'])
    await child.exited
    expect(probeRunProcessAlive(child.pid, null)).toBe(false)
  })

  test('pid 活着但命令行不含 spawnBinaryPath（pid 被回收复用）⇒ not alive', () => {
    expect(probeRunProcessAlive(process.pid, '/nonexistent/binary/we/never/spawned')).toBe(false)
  })

  test('pid 活着且命令行含 spawnBinaryPath ⇒ alive（身份匹配的正向分支）', () => {
    // 本测试进程自己就是 `bun test …`，ps 命令行必含 'bun'。
    expect(probeRunProcessAlive(process.pid, 'bun')).toBe(true)
  })

  test('探针只接受 pid —— 没有 pid 的行根本不该走到这里', () => {
    // 回归锚点：旧实现的第一句是 `if (run.pid === null) return true`（已消失）。
    // 探针现在的签名要求 pid: number，pid-null 的分类由 classifyRunLiveness 决定。
    const wrapper = row({ id: 'r1', nodeId: 'w' })
    expect(classifyRunLiveness(wrapper, gitWrapperDef()).kind).toBe('delegated')
  })
})

// --- ② 证据分类 -------------------------------------------------------------

describe('RFC-230 — classifyRunLiveness', () => {
  test('wrapper 行（无 pid）⇒ delegated，且内层集合含传递后代', () => {
    const ev = classifyRunLiveness(row({ id: 'r', nodeId: 'outer' }), nestedDef())
    expect(ev.kind).toBe('delegated')
    if (ev.kind !== 'delegated') throw new Error('unreachable')
    expect([...ev.innerNodeIds].sort()).toEqual(['leaf', 'mid'])
  })

  test('有 pid 的行 ⇒ process（pid 优先于定义，快照坏了也能判）', () => {
    const empty = { $schema_version: 1, inputs: [], nodes: [], edges: [] } as WorkflowDefinition
    const ev = classifyRunLiveness(row({ id: 'r', nodeId: 'gone-node', pid: 4242 }), empty)
    expect(ev).toEqual({ kind: 'process', pid: 4242, spawnBinaryPath: null })
  })

  test('agent 行的 pre-spawn 窗口（无 pid、无子行）⇒ none —— 有驱动才判活', () => {
    expect(classifyRunLiveness(row({ id: 'r', nodeId: 'a' }), gitWrapperDef()).kind).toBe('none')
  })

  test('定义里已不存在、且无子行的节点 ⇒ none', () => {
    expect(classifyRunLiveness(row({ id: 'r', nodeId: 'ghost' }), gitWrapperDef()).kind).toBe(
      'none',
    )
  })

  test('结构规则：定义外的 synthetic 容器行（有子行）⇒ delegated', () => {
    // 真实反例：commit-push 容器行用 commitPushNodeId 生成的 synthetic nodeId，
    // 定义里根本没有这个节点，born running、自身不持 pid，真进程跑在它另 mint
    // 的 session 子行上。只按 NodeKind 分类会把它漏成「无法归类」。
    const container = row({ id: 'CP', nodeId: 'commit-push:a' })
    const session = row({ id: 'CP-S', nodeId: 'commit-push:a', pid: 321, parentNodeRunId: 'CP' })
    expect(classifyRunLiveness(container, gitWrapperDef(), [container, session]).kind).toBe(
      'delegated',
    )
  })

  test('每个 NodeKind 都声明了活性证据来源（AC8 穷尽性）', () => {
    for (const kind of NODE_KIND) {
      expect(['process', 'delegated']).toContain(livenessSourceOfKind(kind as NodeKind))
    }
  })
})

// --- ③ 证据链解析 -----------------------------------------------------------

describe('RFC-230 — resolveRunLiveness', () => {
  const wrapperRow = row({ id: 'W', nodeId: 'w' })

  test('driver 门短路一切：任务仍被调度器持有 ⇒ 活', () => {
    const v = resolveRunLiveness({
      row: row({ id: 'X', nodeId: 'a', pid: 999 }),
      rows: [],
      definition: gitWrapperDef(),
      taskHasDriver: true,
      probeProcess: DEAD, // 进程已死也不许后台判它死
    })
    expect(v).toEqual({ alive: true, reason: 'driver-attached' })
  })

  test('wrapper 内层 agent 进程活着 ⇒ wrapper 判活（事故正例）', () => {
    const inner = row({ id: 'A', nodeId: 'a', pid: 777 })
    const v = resolveRunLiveness({
      row: wrapperRow,
      rows: [wrapperRow, inner],
      definition: gitWrapperDef(),
      taskHasDriver: false,
      probeProcess: ALIVE,
    })
    expect(v).toEqual({ alive: true, reason: 'inner-alive' })
  })

  test('wrapper 内层全部终态 + 无驱动 ⇒ 判死，理由 inner-all-terminal', () => {
    const inner = row({ id: 'A', nodeId: 'a', pid: 777, status: 'done' })
    const v = resolveRunLiveness({
      row: wrapperRow,
      rows: [wrapperRow, inner],
      definition: gitWrapperDef(),
      taskHasDriver: false,
      probeProcess: ALIVE,
    })
    expect(v).toEqual({ alive: false, reason: 'inner-all-terminal' })
  })

  test('内层 running 但进程确已消失 ⇒ wrapper 也判死', () => {
    const inner = row({ id: 'A', nodeId: 'a', pid: 777 })
    const v = resolveRunLiveness({
      row: wrapperRow,
      rows: [wrapperRow, inner],
      definition: gitWrapperDef(),
      taskHasDriver: false,
      probeProcess: DEAD,
    })
    expect(v.alive).toBe(false)
  })

  test('内层 pending / awaiting_human ⇒ 有未完成的工作，判活', () => {
    for (const status of ['pending', 'awaiting_human', 'awaiting_review']) {
      const inner = row({ id: 'A', nodeId: 'a', status })
      const v = resolveRunLiveness({
        row: wrapperRow,
        rows: [wrapperRow, inner],
        definition: gitWrapperDef(),
        taskHasDriver: false,
        probeProcess: DEAD,
      })
      expect(v).toEqual({ alive: true, reason: 'inner-alive' })
    }
  })

  test('空窗 + 有驱动 ⇒ 判活（瞬时窗口只发生在驱动活着时，由 driver 门罩住）', () => {
    const v = resolveRunLiveness({
      row: wrapperRow,
      rows: [wrapperRow],
      definition: gitWrapperDef(),
      taskHasDriver: true,
      probeProcess: DEAD,
    })
    expect(v).toEqual({ alive: true, reason: 'driver-attached' })
  })

  test('零下层 + 无驱动 ⇒ 判死（没人会再造出下层，这是残骸不是空窗）', () => {
    // Codex 设计门 P1-1：这类输入每 tick 完全相同，判活等于让残骸活满整个
    // daemon 生命周期，而不是「晚一点回收」。
    const v = resolveRunLiveness({
      row: wrapperRow,
      rows: [wrapperRow],
      definition: gitWrapperDef(),
      taskHasDriver: false,
      probeProcess: DEAD,
    })
    expect(v).toEqual({ alive: false, reason: 'empty-delegation' })
  })

  test('从未 spawn + 无子行 + 无驱动 ⇒ 判死（AC4）', () => {
    const v = resolveRunLiveness({
      row: row({ id: 'P', nodeId: 'solo' }),
      rows: [row({ id: 'P', nodeId: 'solo' })],
      definition: gitWrapperDef(),
      taskHasDriver: false,
      probeProcess: DEAD,
    })
    expect(v).toEqual({ alive: false, reason: 'unowned-never-spawned' })
  })

  test('synthetic 容器行（commit-push 形状）由子行判活，不再被漏成永久残骸', () => {
    const container = row({ id: 'CP', nodeId: 'commit-push:a' })
    const session = row({ id: 'CP-S', nodeId: 'commit-push:a', pid: 321, parentNodeRunId: 'CP' })
    const rows = [container, session]
    expect(
      resolveRunLiveness({
        row: container,
        rows,
        definition: gitWrapperDef(),
        taskHasDriver: false,
        probeProcess: ALIVE,
      }),
    ).toEqual({ alive: true, reason: 'inner-alive' })
    expect(
      resolveRunLiveness({
        row: container,
        rows,
        definition: gitWrapperDef(),
        taskHasDriver: false,
        probeProcess: DEAD,
      }),
    ).toEqual({ alive: false, reason: 'inner-all-terminal' })
  })

  test('嵌套三层：最内层活 ⇒ 最外层活（跨迭代亦然，活性不看新鲜度）', () => {
    const outer = row({ id: 'O', nodeId: 'outer' })
    const mid = row({ id: 'M', nodeId: 'mid' })
    const leaf = row({ id: 'L', nodeId: 'leaf', pid: 555 })
    const v = resolveRunLiveness({
      row: outer,
      rows: [outer, mid, leaf],
      definition: nestedDef(),
      taskHasDriver: false,
      probeProcess: ALIVE,
    })
    expect(v).toEqual({ alive: true, reason: 'inner-alive' })
  })

  test('嵌套三层：最内层已死 ⇒ 最外层判死', () => {
    const outer = row({ id: 'O', nodeId: 'outer' })
    const mid = row({ id: 'M', nodeId: 'mid' })
    const leaf = row({ id: 'L', nodeId: 'leaf', pid: 555, status: 'failed' })
    const v = resolveRunLiveness({
      row: outer,
      rows: [outer, mid, leaf],
      definition: nestedDef(),
      taskHasDriver: false,
      probeProcess: ALIVE,
    })
    expect(v.alive).toBe(false)
  })

  test('fanout 子行经父指针可达（内层节点不在定义包含关系里也算数）', () => {
    const wrapper = row({ id: 'W', nodeId: 'w' })
    const shard = row({ id: 'S', nodeId: 'not-in-definition', pid: 888, parentNodeRunId: 'W' })
    const v = resolveRunLiveness({
      row: wrapper,
      rows: [wrapper, shard],
      definition: gitWrapperDef(),
      taskHasDriver: false,
      probeProcess: ALIVE,
    })
    expect(v).toEqual({ alive: true, reason: 'inner-alive' })
  })

  test('父指针成环的脏数据不会导致无限递归', () => {
    const a = row({ id: 'A', nodeId: 'w' })
    const b = row({ id: 'B', nodeId: 'w', parentNodeRunId: 'A' })
    const aCycled = { ...a, parentNodeRunId: 'B' }
    const v = resolveRunLiveness({
      row: aCycled,
      rows: [aCycled, b],
      definition: gitWrapperDef(),
      taskHasDriver: false,
      probeProcess: DEAD,
    })
    // 互指的脏行不许互相保活：环那一支在 visited 命中处判死（lineage-cycle），
    // 于是外层看到「下层没有活的」而收敛为 inner-all-terminal，而不是无限递归、
    // 也不是两行互相当作活性证据。
    expect(v.alive).toBe(false)
    expect(['inner-all-terminal', 'lineage-cycle']).toContain(v.reason)
  })
})

// --- ④ 回收器端到端 ---------------------------------------------------------

async function seedTask(db: DbClient, definition: WorkflowDefinition): Promise<string> {
  const wfId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({ id: wfId, name: 'w', definition: JSON.stringify(definition) })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW - 100_000,
  })
  return taskId
}

async function seedRun(
  db: DbClient,
  taskId: string,
  over: { nodeId: string; status: string; pid?: number | null },
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: over.nodeId,
    status: over.status as 'running',
    pid: over.pid ?? null,
    startedAt: NOW - 50_000, // 远早于 grace
  })
  return id
}

describe('RFC-230 — reconcileDeadRunningRuns 对 wrapper 行的处置', () => {
  test('内层 agent 还在跑的 wrapper 不被回收（事故直接回归）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, gitWrapperDef())
    const wrapperId = await seedRun(db, taskId, { nodeId: 'w', status: 'running' })
    await seedRun(db, taskId, { nodeId: 'a', status: 'running', pid: 777 })
    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: ALIVE,
      taskHasDriver: () => false,
    })
    expect(res.reapedRuns).toHaveLength(0)
    const w = await db.select().from(nodeRuns).where(eq(nodeRuns.id, wrapperId))
    expect(w[0]!.status).toBe('running')
    const t = await db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(t[0]!.status).toBe('running')
  })

  test('失去驱动的 wrapper（内层全终态）被正确回收，理由 inner-all-terminal', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, gitWrapperDef())
    const wrapperId = await seedRun(db, taskId, { nodeId: 'w', status: 'running' })
    await seedRun(db, taskId, { nodeId: 'a', status: 'done', pid: 777 })
    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: ALIVE,
      taskHasDriver: () => false,
    })
    expect(res.reapedRuns).toEqual([wrapperId])
    expect(res.reasons[wrapperId]).toBe('inner-all-terminal')
    const w = await db.select().from(nodeRuns).where(eq(nodeRuns.id, wrapperId))
    expect(w[0]!.status).toBe('interrupted')
  })

  test('driver 门：任务仍被调度器驱动时，行与任务行都不被改写', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, gitWrapperDef())
    const wrapperId = await seedRun(db, taskId, { nodeId: 'w', status: 'running' })
    await seedRun(db, taskId, { nodeId: 'a', status: 'done', pid: 777 })
    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: DEAD,
      taskHasDriver: () => true,
    })
    expect(res.reapedRuns).toHaveLength(0)
    expect(res.reapedTasks).toHaveLength(0)
    const w = await db.select().from(nodeRuns).where(eq(nodeRuns.id, wrapperId))
    expect(w[0]!.status).toBe('running')
    const t = await db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(t[0]!.status).toBe('running')
  })

  test('pre-spawn 行：走生产 activeTasks 注册表，有驱动不收 / 无驱动收', async () => {
    // Codex 设计门 P2-4：这条刻意**不注入** taskHasDriver，用真实的
    // isTaskActive 接线，证明生产默认路径本身是对的。
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, gitWrapperDef())
    const runId = await seedRun(db, taskId, { nodeId: 'solo', status: 'running' }) // 尚未写 pid
    try {
      __setActiveTaskForTesting(taskId)
      const guarded = await reconcileDeadRunningRuns({
        db,
        graceMs: 1000,
        now: NOW,
        probeProcessAlive: DEAD,
      })
      expect(guarded.reapedRuns).toHaveLength(0)

      __setActiveTaskForTesting(undefined)
      const reaped = await reconcileDeadRunningRuns({
        db,
        graceMs: 1000,
        now: NOW,
        probeProcessAlive: DEAD,
      })
      expect(reaped.reapedRuns).toEqual([runId])
      expect(reaped.reasons[runId]).toBe('unowned-never-spawned')
    } finally {
      __setActiveTaskForTesting(undefined)
    }
  })

  test('回收 run 但任务仍有活时，run 级审计事件仍然存在（AC2）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, gitWrapperDef())
    const wrapperId = await seedRun(db, taskId, { nodeId: 'w', status: 'running' })
    await seedRun(db, taskId, { nodeId: 'a', status: 'done', pid: 777 })
    await seedRun(db, taskId, { nodeId: 'solo', status: 'pending' }) // 任务仍有活
    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: ALIVE,
      taskHasDriver: () => false,
    })
    expect(res.reapedRuns).toEqual([wrapperId])
    expect(res.reapedTasks).toHaveLength(0) // 任务没翻
    const events = await listRecoveryEventsForTask(db, taskId)
    const reap = events.find((e) => e.nodeRunId === wrapperId)
    expect(reap?.kind).toBe('periodic-reap')
    expect(reap?.reason).toContain('inner-all-terminal')
  })

  test('快照不可解析的任务被跳过（保守），不因残缺定义误杀', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, gitWrapperDef())
    await db.update(tasks).set({ workflowSnapshot: '{ not json' }).where(eq(tasks.id, taskId))
    await seedRun(db, taskId, { nodeId: 'w', status: 'running' })
    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: DEAD,
      taskHasDriver: () => false,
    })
    expect(res.reapedRuns).toHaveLength(0)
  })
})
