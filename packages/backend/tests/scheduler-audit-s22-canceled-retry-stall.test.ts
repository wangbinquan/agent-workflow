import { rimrafDir } from './helpers/cleanup'
// RFC-095 SEMANTICS LOCK — design/scheduler-audit-2026-06-10.md S-22 (WP-2)
// design/RFC-095-scope-outcome-exhaustive/design.md §1 / §5-2 / §5-5
//
// 历史（本文件曾是 CURRENT-BEHAVIOR LOCK）：retryNode 的任务状态门（task.ts）只拒
// pending/running——canceled 任务被放行（前端 canRetryNodeRun 把 canceled 列为可重试，
// 设计内 UI 流）；但 sibling 的 canceled latest 行落 S-12 的无桶黑洞
// （isDispatchable(canceled)=false 且分桶不收）⇒ 目标节点重跑完后 scope 静默，
// runScope 以无 nodeId 归因的 `scheduler stalled` 假失败收场，循环失败。
//
// RFC-095 采用报告的「isDispatchable 把 canceled 视为可重铸信号」路线（方案①）：
// 无 supersede 标记的 canceled 行与 interrupted 同类，是复活信号——retryNode 复活
// canceled 任务后，sibling 的 canceled 行直接回 ready，调度器为其铸新行重跑。
// （supersede 标记行的停泊例外见 dispatch-frontier.test.ts / rfc095-scope-outcome.test.ts。）
//
// 纯函数段直测 deriveFrontier（row()/def() 复刻自 derive-frontier.test.ts，file-local）；
// DB 段照 retry-cascade-kind-matrix.test.ts 的 createInMemoryDb + retryNode 先例，并以
// mock opencode + 轮询任务终态做「retryNode → 后台 runTask → 任务 done、a/b 都有新
// done 行」的端到端证明。注意确定化（design §5-5）：方案① 下 retryNode 尾部的后台
// runTask 会给 canceled sibling 铸新行——旧版「b 行数恒 1」断言是竞态，已改为等待终态
// 后断言行集。

import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import type { nodeRuns as nodeRunsTable } from '../src/db/schema'
import { retryNode } from '../src/services/task'
import { deriveFrontier } from '../src/services/scheduler'

// 同毫秒多行排序确定化（先例：scheduler-clarify-dispatch.test.ts:33-40）——freshest
// 判定是纯 ULID id 序，monotonicFactory 保证后铸的行恒为 latest。
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

// retryNode 尾部后台 void runTask 会在 appHome 下创建 run 目录。用 pid 唯一路径避免
// 并行撞名，afterAll 尽力清理（/tmp 由 OS 兜底，这里只保证不留固定名脏目录）。
const APP_HOME = `/tmp/aw-s22-apphome-${process.pid}`
afterAll(() => {
  rimrafDir(APP_HOME)
})

// ---------------------------------------------------------------------------
// 纯函数面：canceled latest 行 = 复活信号 → ready（不再无桶黑洞）
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
    // RFC-095：isDispatchable 的 canceled 分支读 errorMessage（supersede 标记守卫），
    // 与真实行一致默认 null。
    errorMessage: null,
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

describe('S-22（纯函数面）— retryNode 后的行集：目标可跑、canceled sibling 同样复活', () => {
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

  test('retry 后第一 tick：a 的 failed 重试行 ready（N1），b 的 canceled 行也 ready（复活信号，RFC-095）', () => {
    const { definition, scopeNodes, scopeIds, upstreams } = postRetryScenario()
    const rows = [
      row('in', 'done'),
      row('a', 'canceled'),
      row('b', 'canceled'),
      row('a', 'failed', { retryIndex: 1 }), // retryNode 铸的 'queued for retry' 行（更晚 id ⇒ latest）
    ]
    const f = deriveFrontier(rows, definition, scopeNodes, scopeIds, 0, upstreams, NONE, NONE, NONE)
    expect(f.ready).toEqual(['a', 'b'])
    // b 不再是无桶黑洞：直接回 ready，不入任何停泊桶、不入 blocked 诊断。
    expect(f.completed.has('b')).toBe(false)
    expect(f.awaitingHuman).not.toContain('b')
    expect(f.awaitingReview).not.toContain('b')
    expect(f.failed).not.toContain('b')
    expect(f.exhausted).not.toContain('b')
    expect(f.blocked).toEqual([])
    expect(f.allSettled).toBe(false)
  })

  test('a 重跑 done 后 b 仍 ready——scope 不再 stalled（S-22 黑洞闭合）', () => {
    const { definition, scopeNodes, scopeIds, upstreams } = postRetryScenario()
    const rows = [
      row('in', 'done'),
      row('a', 'canceled'),
      row('b', 'canceled'),
      row('a', 'done', { retryIndex: 1 }), // 重试已成功
    ]
    const f = deriveFrontier(rows, definition, scopeNodes, scopeIds, 0, upstreams, NONE, NONE, NONE)
    expect(f.completed.has('a')).toBe(true)
    // 旧缺陷形态是「ready 空、四桶全空、allSettled=false」⇒ runScope 唯一落
    // `scheduler stalled` 兜底。RFC-095 后 b 获得显式归宿：ready。
    expect(f.ready).toEqual(['b'])
    expect(f.awaitingHuman).toEqual([])
    expect(f.awaitingReview).toEqual([])
    expect(f.failed).toEqual([])
    expect(f.exhausted).toEqual([])
    expect(f.blocked).toEqual([])
    expect(f.allSettled).toBe(false)
    // ready 非空 ⇒ runScope 直接派发 b，decideScopeOutcome 的 stalled 兜底不可达。
    // isDispatchable(canceled) 的单点断言见 dispatch-frontier.test.ts
    // （'canceled WITHOUT supersede marker → dispatchable'），不重复。
  })
})

// ---------------------------------------------------------------------------
// DB 面：retryNode 对 canceled 任务放行（设计内 UI 流）+ 复活后端到端跑到 done
// ---------------------------------------------------------------------------

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

// retryNode 尾部 void runTask 在后台推进——确定化等待任务离开 pending/running
// （有限次 × 小间隔，轮询模式参考 scheduler-clarify-dispatch.test.ts 的集成先例）。
async function waitForTerminalTask(
  db: DbClient,
  taskId: string,
): Promise<typeof tasks.$inferSelect> {
  for (let i = 0; i < 400; i++) {
    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    if (t !== undefined && t.status !== 'pending' && t.status !== 'running') return t
    await Bun.sleep(25)
  }
  throw new Error(`task ${taskId} did not reach a terminal status within budget`)
}

describe('S-22（DB 面）— retryNode 对 canceled 任务放行，复活后任务跑到 done', () => {
  async function seedCanceledTask(db: DbClient): Promise<{
    taskId: string
    runA: string
    runB: string
  }> {
    // mock opencode 需要 agent 行（getAgent）与真实存在的 worktree 目录（spawn cwd）。
    // readonly=true ⇒ stash 快照路径 permissive，纯目录（非 git）即可——先例：
    // scheduler-boundary-wrapper-resume-interrupted.test.ts。
    await db.insert(agents).values({
      id: ulid(),
      name: 'x',
      description: 'test',
      outputs: JSON.stringify(['summary']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
    })
    const definition = {
      $schema_version: 3,
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
    const worktreePath = join(APP_HOME, `wt-${taskId}`)
    mkdirSync(worktreePath, { recursive: true })
    await db.insert(tasks).values({
      name: 't-s22',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: '/nonexistent-s22-repo',
      worktreePath, // 真实目录（mock spawn cwd）；preSnapshot=null ⇒ rollback 仍全程跳过
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

  test('canceled 任务 + canceled 行调 retryNode：放行（任务翻 pending、目标铸 failed 重试行），后台 runTask 给 a、b 都铸新 done 行——任务终态 done（S-22 根治的端到端证明）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, runA, runB } = await seedCanceledTask(db)

    const final = await withEnv(
      { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }) },
      async () => {
        const next = await retryNode(db, taskId, runA, {
          cascade: true,
          deps: { db, appHome: APP_HOME, opencodeCmd: ['bun', 'run', MOCK_OPENCODE] },
        })
        // 状态门只拒 pending/running——canceled 放行（设计内 UI 流，断言保留）。
        expect(next.status).toBe('pending')
        return await waitForTerminalTask(db, taskId)
      },
    )
    // errorSummary 拼进断言：失败时直接暴露失败原因，便于诊断。
    expect(`${final.status}:${final.errorSummary ?? ''}`).toBe('done:')

    const all = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // 目标节点 a：retryNode 铸的 retryIndex=1 failed 占位行（'queued for retry'）
    // 作为历史保留，其后由调度器铸更晚的 done 重跑行。
    const minted = all.find((r) => r.nodeId === 'a' && r.errorMessage === 'queued for retry')
    expect(minted).toBeDefined()
    expect(minted!.status).toBe('failed')
    expect(minted!.retryIndex).toBe(1)
    const aDone = all.filter((r) => r.nodeId === 'a' && r.status === 'done')
    expect(aDone).toHaveLength(1)
    expect(aDone[0]!.id > minted!.id).toBe(true)

    // sibling b：canceled latest 是复活信号——调度器为它铸了新行并跑到 done；
    // 原 canceled 行（runB）原样保留为历史。旧版锁定的缺陷形态（b 永远只有
    // 1 行 canceled、scope stalled 循环失败）在此翻转。
    const bRows = all.filter((r) => r.nodeId === 'b')
    expect(bRows.map((r) => r.status).sort()).toEqual(['canceled', 'done'])
    expect(bRows.find((r) => r.status === 'canceled')!.id).toBe(runB)
  }, 20000)

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
