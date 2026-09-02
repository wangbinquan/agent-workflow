// RFC-350 —— 不活跃超时收割的持久化实现。
//
// **一份实现，两个 provider 共用**（`sqliteTaskIdleTimeoutPersistence.ts` /
// `postgresqlTaskIdleTimeoutPersistence.ts` 只是两个具名工厂）。可以这么做是因为本
// adapter 只有纯读 + 两条单语句写、**没有事务**：SQLite 的 `dbTxSync` 与 PostgreSQL 的
// 异步事务那道真正的分歧在这里不存在，而 `DbClient` 与 `PostgresqlDatabaseClient` 都是
// drizzle 的 `BaseSQLiteDatabase`，同一套 query builder 在 `await` 下行为一致。
// 抄成两份只会制造漂移——RFC-350 的 provider 一致性（AC-15）由此在**结构上**成立，
// 而不是靠一条跑不进常规 CI 的对拍测试（PostgreSQL 侧要真实 server）。
//
// 活动时刻（`TaskActivityRecord.activityAt`）的合成规则见
// `domain/idleTimeoutPolicy.ts` 头注释。这里只补两条**成本**上的取舍：
//
//   · 已终态成员只用 `max(started_at, finished_at)`：终态行不会再产出事件，
//     `finished_at` 就是它停下的那一刻。于是逐 run 的事件查询只发生在**非终态**成员上，
//     一棵有几百个已完成子任务的大树不会把一拍撑爆。
//   · 每个 run 的最新事件用 `ORDER BY id DESC LIMIT 1` 而不是 `max(ts)`：前者走
//     `idx_events_node(node_run_id, id)` 一行就停，后者要扫完该 run 的全部事件行
//     （单个 run 有几万行事件是常态）。id 单调递增，两者取到的是同一行。

import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  CANCELABLE_TASK_STATUSES,
  TERMINAL_NODE_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
  type TaskStatus,
} from '@agent-workflow/shared'

import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'

import type * as schema from '@/db/schema'
import {
  collaborationGateOperations,
  nodeRunEvents,
  nodeRuns,
  recoveryEvents,
  tasks,
} from '@/db/schema'
import { bumpRecoveryCounter } from '@/services/recovery'
import { chunkedAll } from '@/util/sqlChunk'
import { createLogger } from '@/util/log'

import type { TaskActivityRecord } from '../domain/idleTimeoutPolicy'
import type {
  IdleTimeoutAuditRecord,
  IdleTimeoutRunSnapshot,
  IdleTimeoutTreeSnapshot,
  TaskIdleTimeoutPersistence,
} from '../application/ports/taskIdleTimeoutPersistence'

const log = createLogger('task-idle-timeout-persistence')

/**
 * 两个 provider 客户端的公共基类型。`DbClient`（bun:sqlite，同步）与
 * `PostgresqlDatabaseClient`（remote，异步）都可赋值给它，于是同一段查询代码
 * `await` 之后在两边行为一致。
 */
export type TaskIdleTimeoutDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>

/** cancelTask 写进 error_summary 的默认值；覆盖原因时按它认领「这行是我们取消的」。 */
export const CANCEL_DEFAULT_SUMMARY = 'canceled by user'

const TERMINAL_TASK_SET: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES)
const TERMINAL_RUN_SET: ReadonlySet<string> = new Set(TERMINAL_NODE_RUN_STATUSES)
/** 与归档器 `collectTree` 同款的深度上限。 */
const MAX_TREE_DEPTH = 64

export function createTaskIdleTimeoutPersistence(
  db: TaskIdleTimeoutDb,
): TaskIdleTimeoutPersistence {
  return Object.freeze({
    async listIdleCandidateRoots(limit: number): Promise<readonly string[]> {
      if (limit <= 0) return []
      // 起手式只要活任务的三列，走 status 索引；软删除行整体不参与（AC-14）。
      const live = await db
        .select({
          id: tasks.id,
          parentTaskId: tasks.parentTaskId,
          rootTaskId: tasks.rootTaskId,
          startedAt: tasks.startedAt,
        })
        .from(tasks)
        .where(and(isNull(tasks.deletedAt), inArray(tasks.status, [...CANCELABLE_TASK_STATUSES])))
      // 最老的活任务优先——一拍收不完时先收积压最久的那些。
      const ordered = [...live].sort((a, b) => a.startedAt - b.startedAt)
      const roots: string[] = []
      const seen = new Set<string>()
      for (const row of ordered) {
        if (roots.length >= limit) break
        const root =
          row.rootTaskId ?? (row.parentTaskId === null ? row.id : await resolveRoot(db, row.id))
        if (seen.has(root)) continue
        seen.add(root)
        roots.push(root)
      }
      return Object.freeze(roots)
    },

    async loadTreeActivity(rootTaskId: string): Promise<IdleTimeoutTreeSnapshot | null> {
      const taskIds = await collectTree(db, rootTaskId)
      const taskRows = await chunkedAll(taskIds, (chunk) =>
        db
          .select({
            id: tasks.id,
            status: tasks.status,
            startedAt: tasks.startedAt,
            finishedAt: tasks.finishedAt,
            deletedAt: tasks.deletedAt,
          })
          .from(tasks)
          .where(inArray(tasks.id, chunk)),
      )
      if (taskRows.length === 0) return null
      // 树里混进软删除行 ⇒ 整棵树本拍不动（AC-14 的树级表达）。
      if (taskRows.some((row) => row.deletedAt !== null)) return null

      const liveTaskIds = taskRows
        .filter((row) => !TERMINAL_TASK_SET.has(row.status))
        .map((row) => row.id)
      const runRows =
        liveTaskIds.length === 0
          ? []
          : await chunkedAll(liveTaskIds, (chunk) =>
              db
                .select({
                  id: nodeRuns.id,
                  taskId: nodeRuns.taskId,
                  status: nodeRuns.status,
                  startedAt: nodeRuns.startedAt,
                  pid: nodeRuns.pid,
                  spawnBinaryPath: nodeRuns.spawnBinaryPath,
                  spawnLaunchNonce: nodeRuns.spawnLaunchNonce,
                })
                .from(nodeRuns)
                .where(inArray(nodeRuns.taskId, chunk)),
            )
      const gateRows =
        liveTaskIds.length === 0
          ? []
          : await chunkedAll(liveTaskIds, (chunk) =>
              db
                .select({
                  taskId: collaborationGateOperations.taskId,
                  committedAt: collaborationGateOperations.committedAt,
                })
                .from(collaborationGateOperations)
                .where(
                  and(
                    inArray(collaborationGateOperations.taskId, chunk),
                    eq(collaborationGateOperations.operationKind, 'decide'),
                    isNotNull(collaborationGateOperations.committedAt),
                  ),
                ),
            )

      const runActivity = new Map<string, number>()
      const liveRuns: IdleTimeoutRunSnapshot[] = []
      for (const run of runRows) {
        bump(runActivity, run.taskId, run.startedAt ?? 0)
        const latest = await latestEventTsForRun(db, run.id)
        if (latest !== null) bump(runActivity, run.taskId, latest)
        if (TERMINAL_RUN_SET.has(run.status)) continue
        liveRuns.push(
          Object.freeze({
            nodeRunId: run.id,
            taskId: run.taskId,
            pid: run.pid,
            startedAt: run.startedAt,
            spawnBinaryPath: run.spawnBinaryPath,
            spawnLaunchNonce: run.spawnLaunchNonce,
          }),
        )
      }
      const gateActivity = new Map<string, number>()
      for (const gate of gateRows) bump(gateActivity, gate.taskId, gate.committedAt ?? 0)

      const members: TaskActivityRecord[] = taskRows.map((row) =>
        Object.freeze({
          taskId: row.id,
          status: row.status as TaskStatus,
          activityAt: Math.max(
            row.startedAt,
            row.finishedAt ?? 0,
            runActivity.get(row.id) ?? 0,
            gateActivity.get(row.id) ?? 0,
          ),
        }),
      )
      return Object.freeze({
        rootTaskId,
        members: Object.freeze(members),
        liveRuns: Object.freeze(liveRuns),
      })
    },

    async writeIdleTimeoutReason(input: {
      readonly taskId: string
      readonly summary: string
      readonly message: string
    }): Promise<void> {
      await db
        .update(tasks)
        .set({ errorSummary: input.summary, errorMessage: input.message })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.status, 'canceled'),
            eq(tasks.errorSummary, CANCEL_DEFAULT_SUMMARY),
          ),
        )
        .run()
    },

    async recordReapAudit(input: IdleTimeoutAuditRecord): Promise<void> {
      bumpRecoveryCounter('idle-timeout-reap')
      try {
        await db
          .insert(recoveryEvents)
          .values({
            id: ulid(),
            taskId: input.taskId,
            nodeRunId: null,
            actor: 'system',
            kind: 'idle-timeout-reap',
            reason: input.reason,
            beforeJson: JSON.stringify({
              silentMs: input.silentMs,
              thresholdMs: input.thresholdMs,
            }),
            afterJson: JSON.stringify({
              status: 'canceled',
              killOutcomes: input.killOutcomes,
            }),
            createdAt: input.now,
          })
          .run()
      } catch (error) {
        log.warn('idle-timeout recovery audit dropped', { error: String(error) })
      }
    },
  })
}

function bump(into: Map<string, number>, key: string, value: number): void {
  const current = into.get(key)
  if (current === undefined || value > current) into.set(key, value)
}

async function latestEventTsForRun(
  db: TaskIdleTimeoutDb,
  nodeRunId: string,
): Promise<number | null> {
  const row = await db
    .select({ ts: nodeRunEvents.ts })
    .from(nodeRunEvents)
    .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    .orderBy(desc(nodeRunEvents.id))
    .limit(1)
    .get()
  return row?.ts ?? null
}

/** legacy 行（`root_task_id` 为 NULL，migration 0183 之前铸的）沿父链上溯。 */
async function resolveRoot(db: TaskIdleTimeoutDb, taskId: string): Promise<string> {
  let current = taskId
  for (let depth = 0; depth < MAX_TREE_DEPTH; depth += 1) {
    const row = await db
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, current))
      .limit(1)
      .get()
    if (row === undefined || row.parentTaskId === null) return current
    current = row.parentTaskId
  }
  return current
}

/** 与归档器 `collectTree` 同形，保证「树」在两个功能里是同一个东西。 */
async function collectTree(db: TaskIdleTimeoutDb, rootTaskId: string): Promise<string[]> {
  const out = [rootTaskId]
  const seen = new Set(out)
  let frontier = [rootTaskId]
  for (let depth = 0; frontier.length > 0 && depth < MAX_TREE_DEPTH; depth += 1) {
    const children = await chunkedAll(frontier, (chunk) =>
      db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.parentTaskId, chunk)),
    )
    const next: string[] = []
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      next.push(child.id)
    }
    frontier = next
    out.push(...next)
  }
  return out
}
