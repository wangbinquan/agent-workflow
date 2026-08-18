// RFC-310 PR-5 T55a —— no-change human confirmation（completed-no-change 的
// 唯一入口）。
//
// §8.2 尾段：`already-satisfied-candidate` / validated no-change 只是规则
// fact；没有 receipt 不得进入终态。本命令 = 人对 no-change gate 的确认：
// admissible（awaiting-information + active + 无 fence）→ cells 复核 gate 真
// 挂起 → upload 防御复检（created/replaced entry 存在则拒——seed 必须走发布
// 链，不许以 no-change 跳过）→ receipt cells（note+at，不落 user id——归属
// 只进审计列，绝不进未来 prompt 的 facts 面）→ working → completed-no-change
// 两步合法转移 + terminal 列。
//
// 复现测试见 tests/rfc310-pr5-no-change.test.ts。

import { ulid } from 'ulid'
import { z } from 'zod'

import { canonicalDigest, canonicalStringify } from '../../domain/canonicalJson'
import { checkCommandAdmissible, checkMissionTransition } from '../../domain/mission'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { ReconcileDeps } from '../missionReconciler'

export const confirmNoChangeInputSchema = z
  .object({
    missionId: z.string().min(1),
    receiptNote: z.string().min(1).max(2000),
  })
  .strict()

export interface ConfirmNoChangeResult {
  readonly status: 'completed-no-change'
  readonly receiptRef: string
}

export async function confirmNoChange(
  deps: ReconcileDeps,
  rawInput: unknown,
): Promise<ConfirmNoChangeResult> {
  const input = confirmNoChangeInputSchema.parse(rawInput)
  const mission = deps.store.getMission(input.missionId)
  if (mission === null) throw new NotFoundError('mission-not-found', 'mission not found')
  const admissible = checkCommandAdmissible({
    command: 'confirm-no-change',
    status: mission.status,
    automationMode: mission.automationMode,
    fence: mission.transitionFence,
    hasMergeRequest: mission.mrClaimId !== null,
  })
  if (!admissible.ok) throw new ConflictError(`mission-command-${admissible.code}`, admissible.code)

  const cells =
    mission.requirementBundleRef === null
      ? null
      : deps.snapshots.getCells(mission.requirementBundleRef)
  const gateCell = cells?.['__gate.pendingHumanDecision']
  const gatePending =
    gateCell !== undefined &&
    gateCell.state === 'known' &&
    gateCell.value === 'no-change-confirmation'
  if (!gatePending) {
    throw new ValidationError(
      'no-change-gate-not-pending',
      'this mission has no pending no-change confirmation gate',
    )
  }

  // 防御复检（重派已挡，人为改库/竞态兜底）：非 already-present 上传必须进
  // 发布链，不许 no-change 收束。
  if (mission.uploadPlanRef !== null) {
    const plan = deps.ports.uploadPlanReader?.read(mission.uploadPlanRef) ?? null
    if (plan === null || plan.entries.some((entry) => entry.disposition !== 'already-present')) {
      throw new ValidationError(
        'no-change-uploads-pending',
        'created/replaced upload entries must go through the delivery chain',
      )
    }
  }

  const now = deps.now()
  const receipt = {
    kind: 'no-change-confirmation',
    note: input.receiptNote,
    confirmedAt: new Date(now).toISOString().replace('Z', '+00:00'),
  }
  const receiptRef = canonicalDigest(receipt)
  const base = cells ?? {}
  const merged = {
    ...base,
    '__gate.pendingHumanDecision': {
      state: 'known' as const,
      value: 'none',
      sourceRevision: receiptRef,
    },
    '__gate.noChangeReceipt': {
      state: 'known' as const,
      value: canonicalStringify(receipt),
      sourceRevision: receiptRef,
    },
  }
  const snapshotId = ulid()
  deps.store.insertFactSnapshot({
    id: snapshotId,
    missionId: mission.id,
    missionRevision: mission.revision,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(merged),
    refsJson: canonicalStringify({ kind: 'no-change-receipt', receiptRef }),
    digest: canonicalDigest(merged),
    now,
  })

  // 两步合法转移：awaiting-information → working → completed-no-change
  // （TRANSITIONS 里 completed-no-change 只从 working 可达）。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = deps.store.getMission(mission.id)
    if (fresh === null) throw new NotFoundError('mission-not-found', 'mission not found')
    const first = checkMissionTransition({
      from: fresh.status,
      to: 'working',
      fence: fresh.transitionFence,
    })
    if (fresh.status === 'awaiting-information' && !first.ok) {
      throw new ConflictError('no-change-transition-refused', first.code)
    }
    const step1 =
      fresh.status === 'awaiting-information'
        ? deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
            status: 'working',
            requirementBundleRef: snapshotId,
          })
        : ({ ok: true } as const)
    if (!step1.ok) continue
    const mid = deps.store.getMission(mission.id)
    if (mid === null) throw new NotFoundError('mission-not-found', 'mission not found')
    const second = checkMissionTransition({
      from: mid.status,
      to: 'completed-no-change',
      fence: mid.transitionFence,
    })
    if (!second.ok) throw new ConflictError('no-change-transition-refused', second.code)
    const step2 = deps.store.occUpdate(mid.id, mid.revision, mid.epoch, {
      status: 'completed-no-change',
      terminalKind: 'no-change-confirmed',
      terminalAt: now,
      ...(fresh.status === 'awaiting-information' ? {} : { requirementBundleRef: snapshotId }),
    })
    if (step2.ok) return { status: 'completed-no-change', receiptRef }
  }
  throw new ConflictError('mission-occ-revision-conflict', 'revision-conflict')
}
