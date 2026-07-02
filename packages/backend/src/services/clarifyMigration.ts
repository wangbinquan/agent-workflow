// RFC-132 PR-D' 步骤0 — 迁移垫片：把升级前遗留的 immediate 反问 round 收敛到统一的
// dispatched 模型，修 HEAD 上的丢答案缺口（design §13 更正①）。
//
// 缺口：PR-B 曾用 `buildPromptContext` fallback 兜底「answered 但无 dispatched_at」的
// legacy round；PR-C 删了该 fallback，而 `selectAgentQueue` 要
// `dispatched_at IS NOT NULL AND (sealed_at IS NOT NULL OR manual)`
// （services/clarifyQueue.ts）。⇒ 一个 PR-B 之前 answered、其 self/questioner
// continuation 仍在飞的 round，升级后注入空 → agent 看不到用户答案 → 丢答案。
//
// 修复：一次性、幂等、boot 时（daemon resume 之前，cli/start.ts）reconcile —— 对每个
// 遗留 round 的 self/questioner entry 补 `sealed_at` + `dispatched_at`，并把
// `trigger_run_id` 绑到【已存在】的 continuation run（不新 mint）。之后
// `buildClarifyQueueContext` 能选中并注入；派生老化 `isTargetNodeConsumed` 在该
// continuation done+output 时自然判老化。
//
// 三不变式（防 design §6 那次被叫停的 borrow ledger regression）：
//   ① 不产生「dispatched 但 continuation 仍 immediate」的 hybrid —— 只绑到【已存在】的
//      continuation run；绑后该 round 的 origin 进 `deferredDispatchedOrigins`，
//      `openImmediateRounds` 恒排除它（不再算 immediate 账本）。
//   ② 不留「answered 却既非 dispatched 又非 immediate」—— 找不到 continuation run 的
//      （数据已损 / GC）SKIP + warn，绝不制造半状态。
//   ③ 补 `dispatched_at` 与绑 `trigger_run_id` 在同一 UPDATE（天然原子）。
//
// 幂等：判据要 `dispatched_at IS NULL`，补完 dispatched 后二次运行不再命中。PR-B 之后的
// 新数据 self/q entry 都已经 `autoDispatchClarifyRound` 打了 dispatched_at，故此判据只命中
// 升级前遗留，绝不碰新数据。

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { clarifyRounds, crossClarifySessions, nodeRuns, taskQuestions } from '@/db/schema'
import {
  getNodeClarifyDirectiveRow,
  setNodeClarifyDirective,
} from '@/services/taskClarifyDirective'
import { createLogger } from '@/util/log'

const log = createLogger('clarify-migration')

const MIGRATION_ACTOR = 'rfc132-migration'

export interface ReconcileLegacyImmediateResult {
  /** rounds whose self/questioner entries were补下发+bound to their continuation run. */
  reconciled: number
  /** answered rounds with undispatched self/q entries but NO continuation run (data lost / GC'd). */
  skipped: number
}

/**
 * RFC-132 迁移垫片。见文件头。boot 时调一次（daemon resume 之前），幂等，best-effort。
 */
export async function reconcileLegacyImmediateRounds(
  db: DbClient,
): Promise<ReconcileLegacyImmediateResult> {
  const answered = await db.select().from(clarifyRounds).where(eq(clarifyRounds.status, 'answered'))

  let reconciled = 0
  let skipped = 0

  for (const round of answered) {
    // 该 round 的 self/questioner entry（originNodeRunId = intermediaryNodeRunId）。designer
    // entry 不在步骤0 范围（走独立的 dispatched designer 队列）。
    const entries = await db
      .select()
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.originNodeRunId, round.intermediaryNodeRunId),
          inArray(taskQuestions.roleKind, ['self', 'questioner']),
        ),
      )
    const undispatched = entries.filter((e) => e.dispatchedAt === null)
    if (undispatched.length === 0) continue // 新数据 / 已 reconcile → 幂等 no-op

    // 找【已存在】的 immediate continuation run（不新 mint）：asking 节点、同 iteration、对应
    // cause、top-level（parentNodeRunId NULL）。一个 round 的 undispatched self/q entry 同属一
    // 个 role（self round → self；cross round → questioner），故 cause 单一。取最新一条（retry
    // 时最后 mint 的 handler）作 trigger anchor。
    const isSelf = undispatched.some((e) => e.roleKind === 'self')
    const cause = isSelf ? 'clarify-answer' : 'cross-clarify-questioner-rerun'
    const conts = await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, round.taskId),
          eq(nodeRuns.nodeId, round.askingNodeId),
          eq(nodeRuns.iteration, round.iteration),
          eq(nodeRuns.rerunCause, cause),
          isNull(nodeRuns.parentNodeRunId),
        ),
      )
      .orderBy(desc(nodeRuns.id))
      .limit(1)
    const continuationRunId = conts[0]?.id
    if (continuationRunId === undefined) {
      // 不变式②：无 continuation run → 数据已损 / GC，不制造半状态，SKIP。
      skipped += 1
      log.warn('legacy immediate round has no continuation run — skipped', {
        taskId: round.taskId,
        roundId: round.id,
        askingNodeId: round.askingNodeId,
        cause,
      })
      continue
    }

    // 不变式③：补 sealed_at + dispatched_at 与绑 trigger_run_id 在同一 UPDATE（原子）。
    // immediate 路径不逐题 seal，故这批 entry 的 sealed_at 都是 NULL；无条件设 now 等价。
    // where 再夹 dispatched_at IS NULL 保证幂等（并发/重跑只补一次）。
    const now = Date.now()
    await db
      .update(taskQuestions)
      .set({
        sealedAt: now,
        sealedBy: MIGRATION_ACTOR,
        dispatchedAt: now,
        dispatchedBy: MIGRATION_ACTOR,
        triggerRunId: continuationRunId,
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            taskQuestions.id,
            undispatched.map((e) => e.id),
          ),
          isNull(taskQuestions.dispatchedAt),
        ),
      )
    reconciled += 1
  }

  if (reconciled > 0 || skipped > 0) {
    log.info('reconciled legacy immediate clarify rounds', { reconciled, skipped })
  }
  return { reconciled, skipped }
}

export interface ReconcileLegacyCrossStopResult {
  /** questioner nodes with a legacy cross 'stop' but no node-level directive → backfilled 'stop'. */
  backfilled: number
  /** questioner nodes that already had a node-level directive row (left untouched). */
  skipped: number
}

/**
 * RFC-132 T7 迁移垫片。`resolveCrossNodeStopped` 现只读 questioner 节点的 node 级 directive
 * (`task_node_clarify_directives`)，不再读 `crossClarifySessions.directive`。升级前遗留的
 * cross 'stop'（pre-RFC-123 写入，未镜像到 node 级 directive）会因此"复活"——cross 节点不再被
 * short-circuit（回归为反复反问）。修复：扫每条 `crossClarifySessions.directive='stop'`，对其
 * `sourceQuestionerNodeId` 若 node 级【无 row】→ 补 `setNodeClarifyDirective('stop')`。
 *
 * 幂等 + 不覆盖：只在 `getNodeClarifyDirectiveRow` 返回 undefined（完全没有 node 级 row）时补；
 * 已有 node 级 row 一律不碰——包括用户在 canvas 上 re-enable 写下的 'continue'（覆盖它会把
 * re-enable 错误地退回 stop）。新数据无碍：seal-stop 与 legacy submit-stop 都已同写 node 级
 * directive，故其 questioner 节点必有 row → 命中 skip 分支。boot 时调一次（daemon resume 之前，
 * cli/start.ts），best-effort。
 */
export async function reconcileLegacyCrossPersistentStop(
  db: DbClient,
): Promise<ReconcileLegacyCrossStopResult> {
  const stopRows = await db
    .select({
      taskId: crossClarifySessions.taskId,
      questionerNodeId: crossClarifySessions.sourceQuestionerNodeId,
    })
    .from(crossClarifySessions)
    .where(eq(crossClarifySessions.directive, 'stop'))

  // Distinct (task, questioner) — multiple stop sessions can share one questioner node.
  const seen = new Set<string>()
  let backfilled = 0
  let skipped = 0
  for (const row of stopRows) {
    const key = `${row.taskId}\x00${row.questionerNodeId}`
    if (seen.has(key)) continue
    seen.add(key)
    const existing = await getNodeClarifyDirectiveRow(db, row.taskId, row.questionerNodeId)
    if (existing !== undefined) {
      // A node-level row already exists (a mirrored 'stop', or a user re-enable 'continue')
      // — never overwrite; node last-write-wins already owns the truth.
      skipped += 1
      continue
    }
    await setNodeClarifyDirective(db, row.taskId, row.questionerNodeId, 'stop', MIGRATION_ACTOR)
    backfilled += 1
  }

  if (backfilled > 0 || skipped > 0) {
    log.info('reconciled legacy cross persistent-stop directives', { backfilled, skipped })
  }
  return { backfilled, skipped }
}
