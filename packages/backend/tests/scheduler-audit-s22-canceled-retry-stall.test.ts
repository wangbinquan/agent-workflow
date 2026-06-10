// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-22 (WP-2; 依赖 S-12 诊断改进)
//
// 当前缺陷行为（两半合谋）：
//   1. retryNode 的任务状态门（task.ts:1083-1088）只拒 pending/running——canceled
//      任务被放行（且前端 canRetryNodeRun 把 canceled 列为可重试，这是设计内 UI 流）。
//      retryNode 给目标节点铸 failed 重试行、任务翻 pending、踢 runTask。
//   2. 但 sibling 的 canceled latest 行落 S-12 的无桶黑洞：isDispatchable(canceled)=false
//      （dispatchFrontier.ts:156-157）且分桶不收（scheduler.ts:1129-1132）⇒ 不 ready、
//      无桶、不 completed。目标节点重跑完后 scope 静默，runScope（scheduler.ts:675-678）
//      以无 nodeId 归因的 `scheduler stalled` 假失败收场；之后 resume 只重铸
//      failed/interrupted，循环失败且 errorSummary 互相覆盖。
//
// 正确语义（报告建议修法，二选一写进转移表）：retryNode 拒绝 canceled 任务（与
// resumeTask 对齐）——届时本文件 DB 段的 "不抛" 断言翻转为 expect ConflictError；
// 或 isDispatchable 把 canceled 视为可重铸信号——届时纯函数段的 ready/无桶断言翻转。
// canceled 在"可恢复终态 vs 真终态"之间的归类必须显式决策（修复落 WP-2）。
//
// 纯函数段直测 deriveFrontier（row()/def() 复刻自 derive-frontier.test.ts，file-local）；
// DB 段照 retry-cascade-kind-matrix.test.ts 的 createInMemoryDb + retryNode 先例
// （preSnapshot=null + worktreePath='' ⇒ rollback 全程跳过，零 git 依赖、确定性）。

import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import type { nodeRuns as nodeRunsTable } from '../src/db/schema'
import { retryNode } from '../src/services/task'
import { deriveFrontier } from '../src/services/scheduler'

// 同毫秒多行排序确定化（先例：scheduler-clarify-dispatch.test.ts:33-40）——freshest
// 判定是纯 ULID id 序，monotonicFactory 保证后铸的行恒为 latest。
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// retryNode 尾部后台 void runTask 可能在 appHome 下创建 run 目录（时机依赖进程退出
// 先后）。用 pid 唯一路径避免并行撞名，afterAll 尽力清理（后台任务仍可能晚于清理
// 重建——/tmp 由 OS 兜底，这里只保证不留固定名脏目录）。
const APP_HOME = `/tmp/aw-s22-apphome-${process.pid}`
afterAll(() => {
  rmSync(APP_HOME, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 纯函数面：canceled latest 行 → 不可调度且无桶 → scope 永 stalled
// ---------------------------------------------------------------------------

type Row = typeof nodeRunsTable.$inferSelect
type WorkflowNode = WorkflowDefinition['nodes'][number]
const NONE: ReadonlySet<string> = new Set()

let seq = 0
function row(nodeId: string, status: string, over: Partial<Row> = {}): Row {
  seq += 1
  return {
    id: `01R${String(seq).padStart(4, '0')}`,
    nodeId,
    iteration: 0,
    status,
    parentNodeRunId: null,
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
    ...over,
  } as unknown as Row
}

function def(nodes: Array<{ id: string; kind: NodeKind }>): {
  definition: WorkflowDefinition
  scopeNodes: WorkflowNode[]
  scopeIds: Set<string>
} {
  const definition = { nodes, edges: [] } as unknown as WorkflowDefinition
  return {
    definition,
    scopeNodes: nodes as unknown as WorkflowNode[],
    scopeIds: new Set(nodes.map((n) => n.id)),
  }
}

const ups = (m: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(m))

describe('S-22（纯函数面）— retryNode 后的行集：目标可跑、canceled sibling 永久黑洞', () => {
  // 并行 in → {a, b}，运行中取消：a/b 都 canceled。用户对 a retryNode ⇒ a 多了
  // failed 重试行（latest），b 仍是 canceled latest。
  function postRetryScenario() {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'a', kind: 'agent-single' },
      { id: 'b', kind: 'agent-single' },
    ])
    const upstreams = ups({ a: ['in'], b: ['in'] })
    return { definition, scopeNodes, scopeIds, upstreams }
  }

  test('retry 后第一 tick：a 的 failed 重试行 ready（N1），b 的 canceled 行不 ready 且无桶', () => {
    const { definition, scopeNodes, scopeIds, upstreams } = postRetryScenario()
    const rows = [
      row('in', 'done'),
      row('a', 'canceled'),
      row('b', 'canceled'),
      row('a', 'failed', { retryIndex: 1 }), // retryNode 铸的 'queued for retry' 行（更晚 id ⇒ latest）
    ]
    const f = deriveFrontier(rows, definition, scopeNodes, scopeIds, 0, upstreams, NONE, NONE, NONE)
    expect(f.ready).toEqual(['a'])
    // b：无桶黑洞（S-12）。FLIP on fix（若走 canceled→可重铸路线）：b 应进 ready。
    expect(f.completed.has('b')).toBe(false)
    expect(f.awaitingHuman).not.toContain('b')
    expect(f.awaitingReview).not.toContain('b')
    expect(f.failed).not.toContain('b')
    expect(f.exhausted).not.toContain('b')
    expect(f.allSettled).toBe(false)
  })

  test('LOCK: a 重跑 done 后 scope 静默——ready 空、四桶全空、allSettled=false ⇒ runScope 必然 "scheduler stalled" 循环', () => {
    const { definition, scopeNodes, scopeIds, upstreams } = postRetryScenario()
    const rows = [
      row('in', 'done'),
      row('a', 'canceled'),
      row('b', 'canceled'),
      row('a', 'done', { retryIndex: 1 }), // 重试已成功
    ]
    const f = deriveFrontier(rows, definition, scopeNodes, scopeIds, 0, upstreams, NONE, NONE, NONE)
    expect(f.completed.has('a')).toBe(true)
    // FLIP on fix：b 获得显式归宿（ready 或新桶）后，下面的"全空 + 未settle"组合翻转。
    expect(f.ready).toEqual([])
    expect(f.awaitingHuman).toEqual([])
    expect(f.awaitingReview).toEqual([])
    expect(f.failed).toEqual([])
    expect(f.exhausted).toEqual([])
    expect(f.allSettled).toBe(false)
    // 该 Frontier 形态在 runScope 静默块（scheduler.ts:643-678）唯一落
    // `{ summary: 'scheduler stalled' }` 兜底；resume 只重铸 failed/interrupted
    // ⇒ 行集不变 ⇒ 循环失败。isDispatchable(canceled)=false 的单点断言见
    // dispatch-frontier.test.ts（'canceled / running → NOT dispatchable'），不重复。
  })
})

// ---------------------------------------------------------------------------
// DB 面：task.ts:1083-1088 状态门对 canceled 任务放行（现状锁定）
// ---------------------------------------------------------------------------

describe('S-22（DB 面）— retryNode 对 canceled 任务放行', () => {
  async function seedCanceledTask(db: DbClient): Promise<{
    taskId: string
    runA: string
    runB: string
  }> {
    const definition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'x', promptTemplate: '' },
        { id: 'b', kind: 'agent-single', agentName: 'x', promptTemplate: '' },
      ],
      edges: [],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'wf-s22',
      definition: JSON.stringify(definition),
    })
    const taskId = ulid()
    await db.insert(tasks).values({
      name: 't-s22',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: '/nonexistent-s22-repo',
      worktreePath: '', // 空 ⇒ rollbackNodeRunForResume 跳过（preSnapshot 也为 null）
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'canceled', // 运行中被取消
      inputs: '{}',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 500,
      errorSummary: 'task canceled',
    })
    const runA = ulid()
    const runB = ulid()
    await db.insert(nodeRuns).values({
      id: runA,
      taskId,
      nodeId: 'a',
      status: 'canceled',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 900,
      finishedAt: Date.now() - 600,
    })
    await db.insert(nodeRuns).values({
      id: runB,
      taskId,
      nodeId: 'b',
      status: 'canceled',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 900,
      finishedAt: Date.now() - 600,
    })
    return { taskId, runA, runB }
  }

  test('LOCK: canceled 任务 + canceled 行调 retryNode 不抛（状态门只拒 pending/running），任务翻 pending、目标铸 failed 重试行、sibling 的 canceled 行原样残留', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, runA, runB } = await seedCanceledTask(db)

    // FLIP on fix（若走"retryNode 拒绝 canceled 任务"路线）：这里改为
    // expect(retryNode(...)).rejects 携带 ConflictError（与 resumeTask 对齐）。
    const next = await retryNode(db, taskId, runA, {
      cascade: true,
      deps: { db, appHome: APP_HOME, opencodeCmd: ['/usr/bin/env', 'true'] },
    })
    expect(next.status).toBe('pending')

    const all = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // 目标节点 a：铸了 retryIndex=1 的 failed 占位行（'queued for retry'）。
    const minted = all.find((r) => r.nodeId === 'a' && r.errorMessage === 'queued for retry')
    expect(minted).toBeDefined()
    expect(minted!.status).toBe('failed')
    expect(minted!.retryIndex).toBe(1)

    // sibling b：没有任何重铸——它的 latest 仍是 canceled 行（runB），与纯函数段
    // 合谋出"重跑后必 stalled"。FLIP on fix（canceled→可重铸路线）：b 也应获得
    // 重试/重铸行。注意：retryNode 尾部会后台 void runTask（mock opencode），但
    // 调度器对 canceled 黑洞行永远不铸新行（这正是被锁的缺陷），断言不受竞态影响。
    const bRows = all.filter((r) => r.nodeId === 'b')
    expect(bRows).toHaveLength(1)
    expect(bRows[0]!.id).toBe(runB)
    expect(bRows[0]!.status).toBe('canceled')
  })

  test('对照：running 任务仍被状态门拒绝（ConflictError "task-still-running"）——证明放行 canceled 是门的选择而非门失效', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, runA } = await seedCanceledTask(db)
    await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))

    await expect(
      retryNode(db, taskId, runA, {
        cascade: true,
        deps: { db, appHome: APP_HOME, opencodeCmd: ['/usr/bin/env', 'true'] },
      }),
    ).rejects.toThrow(/task-still-running|is running/)
  })
})
