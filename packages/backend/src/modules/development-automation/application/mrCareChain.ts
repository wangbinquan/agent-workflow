// RFC-310 PR-7 T76 —— MR care 编排（design §4.7 默认顺序 / §10）。
//
// MR 建立后接管发布链落下的静止态（block / wait(mr-care-not-wired)）：
//   MR facts 缺/过期 → collect-mr-facts（三读 fence 的采集 arm 已在，含 feedback
//   台账联动与 mr.* 投影）；
//   feedback apply 结算后的 dispositions → 逐 thread 派 reply-feedback（effect
//   台账，只回复绝不 resolve），并更新台账 addressed/needs-human；
//   selectable feedback > 0 → 放行规则路由 mr.feedback.apply（catalog leaf
//   mr.unhandledFeedbackCount 规则可见；组织没配规则时诚实 wait，不冒进）；
//   全部 machine holds 清零 → publish-readiness（既有 arm 推进 watching →
//   ready-to-merge/waiting-committer）。
// terminal（merged/closed）由 fixed guard 派 mark-terminal，不在本链。链序：
// delivery → care → pipeline——care 先保 facts 新鲜（__mr.headSha 是 pipeline
// stale 判定的锚），CI evidence 面归 pipeline 链。

import type { AutomationPolicyContent } from '../domain/automationPolicy'
import type { NextDecision } from '../domain/decision'
import type { FactCellValue } from '../domain/facts'
import type { FactCell } from '../domain/factCell'
import { selectableFeedback } from '../domain/feedbackLedger'
import { claimDeliveryEffect, type DeliveryChainDeps } from './missionDeliveryChain'
import type { MissionRow } from './ports/missionStore'

export const MR_CARE_EFFECT_KINDS: ReadonlySet<string> = new Set(['mr-reply'])

/** MR facts 的新鲜度窗口（webhook wake 是主信号，这里是 sweep 兜底节拍）。 */
export const MR_FACTS_STALE_MS = 5 * 60 * 1000

type Cells = Readonly<Record<string, FactCell<FactCellValue>>>

function knownString(cells: Cells, id: string): string | null {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' && typeof cell.value === 'string'
    ? cell.value
    : null
}

function knownNumber(cells: Cells, id: string): number | null {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' && typeof cell.value === 'number'
    ? cell.value
    : null
}

interface PendingDisposition {
  readonly threadRef: string
  readonly revision: string
  readonly disposition: 'addressed' | 'needs-human'
}

function pendingDispositions(cells: Cells): PendingDisposition[] {
  const raw = knownString(cells, '__feedback.lastDispositions')
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (row): row is PendingDisposition =>
        row !== null &&
        typeof row === 'object' &&
        typeof (row as { threadRef?: unknown }).threadRef === 'string' &&
        typeof (row as { revision?: unknown }).revision === 'string' &&
        ((row as { disposition?: unknown }).disposition === 'addressed' ||
          (row as { disposition?: unknown }).disposition === 'needs-human'),
    )
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ redispatch

export function redispatchMrCare(
  deps: Pick<DeliveryChainDeps, 'store'>,
  mission: MissionRow,
  cells: Cells,
  policy: AutomationPolicyContent,
  selected: NextDecision,
  context: { readonly now: number },
): NextDecision {
  if (mission.mrClaimId === null) return selected
  const takeover =
    selected.kind === 'block' ||
    (selected.kind === 'wait' && selected.reason === 'mr-care-not-wired')
  if (!takeover) return selected

  // ---- 1) facts 缺/过期 → collect（terminal/feedback/readiness 都以它为锚）。
  const collectedAtRaw = knownString(cells, '__mr.factsCollectedAt')
  const collectedAt = collectedAtRaw === null ? null : Number.parseInt(collectedAtRaw, 10)
  if (
    collectedAt === null ||
    !Number.isFinite(collectedAt) ||
    context.now - collectedAt > MR_FACTS_STALE_MS
  ) {
    return { kind: 'collect-mr-facts' }
  }

  // ---- 1.5) conflict（§4.7 顺序 2）：report-only 呈现于 readiness；repair
  // 模式的 Agent 执行面（edit-conflicts workspace 物化/validator profile）尚未
  // 接线——诚实 typed block，prepare/finish 端口已备（PR-7b 注记债）。
  {
    const conflictCell = cells['mr.conflict']
    if (
      conflictCell !== undefined &&
      conflictCell.state === 'known' &&
      conflictCell.value === true &&
      policy.conflict.mode === 'repair' &&
      selected.kind !== 'block'
    ) {
      return { kind: 'block', reason: 'conflict-repair-agent-surface-not-wired' }
    }
  }

  // ---- 2) apply 结算后的 dispositions：还有未回复的 addressed thread → reply。
  const dispositions = pendingDispositions(cells)
  if (dispositions.length > 0) {
    const rows = deps.store.listFeedback(mission.id)
    for (const d of dispositions) {
      const row = rows.find((r) => r.threadRef === d.threadRef && r.revision === d.revision)
      if (row === undefined) continue
      if (d.disposition === 'needs-human') {
        if (row.state !== 'needs-human') {
          return { kind: 'reply-feedback', feedbackReceiptRef: row.id }
        }
        continue
      }
      if (row.state !== 'addressed') {
        return { kind: 'reply-feedback', feedbackReceiptRef: row.id }
      }
    }
  }

  // ---- 3) selectable feedback 待处理：放行规则路由 mr.feedback.apply。
  const unhandled = knownNumber(cells, 'mr.unhandledFeedbackCount')
  if (unhandled !== null && unhandled > 0) {
    // 规则没匹配（block 静止态）= 组织未配置自动处理：诚实等待人工/规则调整，
    // 不代替 policy 决定「要不要修」。
    return selected.kind === 'block'
      ? {
          kind: 'wait',
          reason: 'feedback-awaiting-policy',
          resumeAt: null,
          wakeSources: ['webhook', 'manual'],
          attemptOrdinal: 0,
        }
      : selected
  }

  // ---- 4) machine holds 清零 → readiness 推进（arm 内做 status 转移）。
  if (knownString(cells, 'pipeline.completeness') !== null && mission.status === 'watching') {
    const allPass = cells['pipeline.requiredGatesAllPass']
    if (allPass !== undefined && allPass.state === 'known' && allPass.value === true) {
      return { kind: 'publish-readiness' }
    }
  }
  return selected
}

// ------------------------------------------------------------ reply-feedback

export async function handleReplyFeedback(
  deps: DeliveryChainDeps,
  mission: MissionRow,
  cells: Cells,
  feedbackReceiptRef: string,
): Promise<'collected' | 'blocked'> {
  const ports = deps.ports
  if (ports.mrEffects === undefined) {
    deps.block(mission.id, 'mr-care-port-missing:mrEffects', null)
    return 'blocked'
  }
  const row = deps.store.listFeedback(mission.id).find((r) => r.id === feedbackReceiptRef)
  if (row === undefined) {
    deps.block(mission.id, 'feedback-receipt-missing', feedbackReceiptRef)
    return 'blocked'
  }
  const mrRef = knownString(cells, '__mr.ref')
  if (mrRef === null) {
    deps.block(mission.id, 'pipeline-mr-ref-missing', null)
    return 'blocked'
  }
  const dispositions = pendingDispositions(cells)
  const disposition =
    dispositions.find((d) => d.threadRef === row.threadRef && d.revision === row.revision)
      ?.disposition ?? 'addressed'

  const idempotencyKey = `reply:${mission.id}:${row.threadRef}:${row.revision}`
  const claim = claimDeliveryEffect(deps, mission, {
    actionRunId: row.actionRunId,
    effectKind: 'mr-reply',
    idempotencyKey,
    intent: {
      kind: 'mr-reply',
      missionId: mission.id,
      threadRef: row.threadRef,
      revision: row.revision,
      disposition,
    },
  })
  if (claim.disposition === 'refused') {
    deps.block(mission.id, claim.code, null)
    return 'blocked'
  }
  let replyEffectId: string | null = null
  if (claim.disposition === 'execute') {
    const body =
      disposition === 'addressed'
        ? 'This feedback has been addressed in the latest revision of this merge request.'
        : 'This feedback needs a human decision; the automation has paused on this thread.'
    const out = await ports.mrEffects.reply(mission.repositoryId, {
      mrRef,
      threadRef: row.threadRef,
      body,
      // self 循环防护：与 facts 采集同源 marker（missionId）。
      selfMarker: mission.id,
    })
    const now = deps.now()
    if (!out.ok) {
      deps.store.failEffect(
        claim.effectId,
        JSON.stringify({ code: out.code, detail: out.detail }),
        now,
      )
      deps.block(mission.id, out.code, out.detail)
      return 'blocked'
    }
    deps.store.confirmEffect(claim.effectId, out.noteRef, now)
    replyEffectId = claim.effectId
  }
  deps.store.setFeedbackState({
    id: row.id,
    state: disposition === 'addressed' ? 'addressed' : 'needs-human',
    replyEffectId,
    now: deps.now(),
  })
  return 'collected'
}

/** mr.feedback.apply 的 launch 前置：selectable 行标 selected + snapshot 素材。 */
export function prepareFeedbackSelection(
  deps: Pick<DeliveryChainDeps, 'store' | 'now'>,
  mission: MissionRow,
  policy: AutomationPolicyContent,
  actionRunId: string,
): readonly { readonly threadRef: string; readonly revision: string }[] {
  const rows = selectableFeedback(deps.store.listFeedback(mission.id), policy.feedback)
  const now = deps.now()
  for (const row of rows) {
    deps.store.setFeedbackState({ id: row.id, state: 'selected', actionRunId, now })
  }
  return rows.map((row) => ({ threadRef: row.threadRef, revision: row.revision }))
}
