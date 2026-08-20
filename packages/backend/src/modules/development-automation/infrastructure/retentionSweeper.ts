// RFC-310 T71 —— retention 的消费者（design §10.4 步骤 5 / §11.5）。
//
// `AutomationPolicy.retention.*TtlDays` 从 PR-1a 起就在 schema 里、设置页也能改，
// 却**一个消费者都没有**：终态 Mission 的证据与台账只增不减，而策略字段让人误以为
// 它在生效。这里补上消费者。
//
// ## 这一版做什么、不做什么（判断依据写在这里，别只看代码）
//
// **做**：
//   - `development_agent_attempts`：终态 Mission 且超过 `attemptLedgerTtlDays` 的
//     **已结算** attempt 行直接删。它是本模块增长最快的表（每次重试一行），而终态
//     Mission 再也不会 collect，删行不影响任何活路径。
//   - `development_bundle_refs`：超过 `requirementBundleTerminalTtlDays` 的行标
//     `retention_state='expired'`。**标记不是删除**——它可逆、可见，让「有多少证据
//     已过保留期」成为运维看得见的数，而不是一个零消费者的策略字段。
//
// **不做：删 evidence blob / bundle manifest。** 这不是工程量问题，是**判据缺失**：
// blob 内容寻址、跨 bundle 共享，而本仓当前**没有完整的引用索引**——
//   ① pipeline evidence bundle 直接写 EvidenceStore，没有任何 DB 指针行；
//   ② attempt 的 `pre_snapshot_ref` 只被 attempt 行引用；
//   ③ `development_bundle_refs` 只覆盖 requirement 那一族。
// 在这种前提下写删 blob 的 sweeper，等于**按猜测删除证据**，而这些证据正是 blocked
// 诊断与审计要用的。正解是先建一张覆盖全部生产者的引用表（owner_kind/owner_id →
// evidence_ref），零引用才可清；存量无法回填的部分标 legacy 永不清扫。那是独立一
// 波的工作量，plan.md 已如实登记。
//
// 单轮有上限：大库上一次全表扫会把 hourly 维护变成一次停顿。

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  developmentActionRuns,
  developmentAgentAttempts,
  developmentBundleRefs,
  developmentMissions,
} from '@/db/schema'
import { automationPolicyContentSchema } from '../domain/automationPolicy'

const DAY_MS = 24 * 60 * 60 * 1000

/** 单轮处理的终态 Mission 上限。 */
export const RETENTION_SWEEP_MISSION_LIMIT = 200

export interface RetentionSweepResult {
  /** 本轮检视的终态 Mission 数。 */
  readonly missionsScanned: number
  /** 删掉的已结算 attempt 行数。 */
  readonly prunedAttempts: number
  /** 本轮新标为 expired 的 bundle 指针行数。 */
  readonly markedBundleRefs: number
  /**
   * 累计处于 expired 的指针行——它们等的是「引用索引到位后才能安全清扫 blob」，
   * 报出来是为了让这笔债有个数字，而不是沉默地涨。
   */
  readonly expiredBundleRefsPending: number
}

interface PolicyRetention {
  readonly requirementBundleTerminalTtlDays: number
  readonly attemptLedgerTtlDays: number
}

/** 策略内容读侧：与 admission/reconciler 同一个来源，避免第二份解析口径。 */
export interface RetentionPolicyReader {
  getPolicyRevisionContent(policyId: string, revision: number): Promise<unknown | null>
}

async function retentionOf(
  reader: RetentionPolicyReader,
  cache: Map<string, PolicyRetention | null>,
  policyId: string | null,
  policyRevision: number | null,
): Promise<PolicyRetention | null> {
  if (policyId === null || policyRevision === null) return null
  const key = `${policyId}@${policyRevision}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let value: PolicyRetention | null = null
  try {
    const raw = await reader.getPolicyRevisionContent(policyId, policyRevision)
    if (raw !== null) {
      const parsed = automationPolicyContentSchema.safeParse(raw)
      if (parsed.success) value = parsed.data.retention
    }
  } catch {
    // 读不到策略就不动这条 Mission 的数据——沉默跳过好过按默认值删东西。
    value = null
  }
  cache.set(key, value)
  return value
}

export async function sweepDevelopmentRetention(
  db: DbClient,
  reader: RetentionPolicyReader,
  now: number,
  limit: number = RETENTION_SWEEP_MISSION_LIMIT,
): Promise<RetentionSweepResult> {
  const missions = db
    .select({
      id: developmentMissions.id,
      terminalAt: developmentMissions.terminalAt,
      policyId: developmentMissions.policyId,
      policyRevision: developmentMissions.policyRevision,
    })
    .from(developmentMissions)
    .where(isNotNull(developmentMissions.terminalAt))
    .orderBy(developmentMissions.terminalAt)
    .limit(limit)
    .all()

  const cache = new Map<string, PolicyRetention | null>()
  let prunedAttempts = 0
  let markedBundleRefs = 0

  for (const mission of missions) {
    const terminalAt = mission.terminalAt
    if (terminalAt === null) continue
    const retention = await retentionOf(reader, cache, mission.policyId, mission.policyRevision)
    if (retention === null) continue
    const age = now - terminalAt

    if (age > retention.attemptLedgerTtlDays * DAY_MS) {
      // 只删**已结算**的 attempt：终态 Mission 理论上不该还有在途行，但真有的话
      // 那是需要有人看的异常，不该被保留期清理顺手抹掉。
      const runIds = db
        .select({ id: developmentActionRuns.id })
        .from(developmentActionRuns)
        .where(eq(developmentActionRuns.missionId, mission.id))
        .all()
        .map((row) => row.id)
      if (runIds.length > 0) {
        // 先取 id 再按 id 删：本仓 drizzle 的 `.run()` 不回传 changes，而这个数字
        // 要进 hourly 日志——没有它，运维看不出保留期到底清掉了什么。
        const doomed = db
          .select({ id: developmentAgentAttempts.id })
          .from(developmentAgentAttempts)
          .where(
            and(
              inArray(developmentAgentAttempts.actionRunId, runIds),
              isNotNull(developmentAgentAttempts.settledAt),
            ),
          )
          .all()
          .map((row) => row.id)
        if (doomed.length > 0) {
          db.delete(developmentAgentAttempts)
            .where(inArray(developmentAgentAttempts.id, doomed))
            .run()
          prunedAttempts += doomed.length
        }
      }
    }

    if (age > retention.requirementBundleTerminalTtlDays * DAY_MS) {
      const stale = db
        .select({ id: developmentBundleRefs.id })
        .from(developmentBundleRefs)
        .where(
          and(
            eq(developmentBundleRefs.missionId, mission.id),
            eq(developmentBundleRefs.retentionState, 'active'),
          ),
        )
        .all()
        .map((row) => row.id)
      if (stale.length > 0) {
        db.update(developmentBundleRefs)
          .set({ retentionState: 'expired' })
          .where(inArray(developmentBundleRefs.id, stale))
          .run()
        markedBundleRefs += stale.length
      }
    }
  }

  const pending =
    db
      .select({ n: sql<number>`count(*)` })
      .from(developmentBundleRefs)
      .where(eq(developmentBundleRefs.retentionState, 'expired'))
      .get()?.n ?? 0

  return {
    missionsScanned: missions.length,
    prunedAttempts,
    markedBundleRefs,
    expiredBundleRefsPending: Number(pending),
  }
}

export const RETENTION_DAY_MS = DAY_MS
