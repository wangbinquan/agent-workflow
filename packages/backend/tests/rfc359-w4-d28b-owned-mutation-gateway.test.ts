// RFC-359 W4-D28b —— 同步 owned-mutation 网关退役：两个引擎跑同一条任务生命周期写路径。
//
// 退役前 `withTaskExecutionMutation` / `withTaskExecutionTransaction`（`sqliteOwnedTaskMutation.ts`）
// 建在 `dbTxSync` + `withOwnedTaskTx` 上——那是 bun:sqlite 独有的**同步**事务面，PostgreSQL 上根本
// 不存在。于是 `transitionMergeState` 这类写手只有 SQLite 一个引擎跑得动，正是 RFC-359 要消灭的
// 「一个好一个不好」。D28b 把这条网关整体退役，5 处调用点迁到两引擎共用的
// `withTaskExecutionWrite` + `fenceTaskWrite`（`infrastructure/ownedTaskExecution.ts`）。
//
// 这条用例锁两件事，**两个引擎各跑一遍**：
//   1. 同一个 `transitionMergeState` 在 SQLite 与 PostgreSQL 上都完成 merge_state CAS。迁移前
//      它在 PG 上不可能跑通（`dbTxSync` 要的是 bun:sqlite 的同步 `db.transaction`）。
//   2. 无执行上下文的控制面写入按**统一规则**走无主围栏：任务仍挂着活着的（`claimed`）owner 时
//      当场拒绝，且拒绝之后那一行原样不动。这是迁移**带来的**行为变化——旧的同步网关在无上下文
//      分支里既不开事务也不设围栏，直接裸写；PG 侧一直是有围栏的，合一即以有围栏的那侧为准。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionOwners, tasks, workflows } from '@/db/schema'
import { transitionMergeState } from '@/platform/persistence/sqlite/taskLifecycle'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedTaskWithNodeRun(
  db: ProviderNeutralDatabase,
): Promise<{ taskId: string; runId: string }> {
  const taskId = `d28b_${ulid()}`
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-d28b',
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now() - 1_000,
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
    ]),
  })
  const runId = ulid()
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'worker',
    status: 'pending',
    retryIndex: 0,
    iteration: 0,
  })
  return { taskId, runId }
}

/** 一个活着的 owner：无主围栏正是要为它让路的那种写手。 */
async function seedLiveOwner(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  const now = Date.now()
  await db.insert(taskExecutionOwners).values({
    taskId,
    ownerId: `owner_${ulid()}`,
    daemonGeneration: `gen_${ulid()}`,
    epoch: 1,
    state: 'claimed',
    leaseUntil: now + 60_000,
    revision: 1,
    lastHeartbeatAt: now,
    updatedAt: now,
  })
}

async function mergeStateOf(db: ProviderNeutralDatabase, runId: string): Promise<string | null> {
  const rows = await db
    .select({ mergeState: nodeRuns.mergeState })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, runId))
    .limit(1)
  return rows[0]?.mergeState ?? null
}

describeEachProvider('RFC-359 W4-D28b —— 同步 owned-mutation 网关退役', (harness) => {
  test('无 owner 的控制面写入：同一个 transitionMergeState 在两个引擎上都完成 CAS', async () => {
    const { runId } = await seedTaskWithNodeRun(harness.db)
    expect(await mergeStateOf(harness.db, runId)).toBeNull()

    const moved = await transitionMergeState({
      db: harness.db,
      nodeRunId: runId,
      event: { kind: 'begin-isolation' },
    })

    expect(moved).toEqual({ from: null, to: 'isolating' })
    expect(await mergeStateOf(harness.db, runId)).toBe('isolating')
  })

  test('任务仍挂着活着的 owner 时，无上下文的控制面写入被无主围栏拒绝且不落任何写', async () => {
    const { taskId, runId } = await seedTaskWithNodeRun(harness.db)
    await seedLiveOwner(harness.db, taskId)

    await expect(
      transitionMergeState({
        db: harness.db,
        nodeRunId: runId,
        event: { kind: 'begin-isolation' },
      }),
    ).rejects.toThrow(/stale-owner|ownerless/)

    // 拒绝必须是**整笔**回滚：行还停在 null，才说明围栏拦在写入之前而不是之后。
    expect(await mergeStateOf(harness.db, runId)).toBeNull()
  })
})
