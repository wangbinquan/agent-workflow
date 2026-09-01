// RFC-310 PR-3 T38a —— 平台渠道答案提交（submit-answers 命令）。
//
// 前提：问题集已以 platform 渠道发布（reconciler 的 publish arm 把 mission
// 推到 awaiting-information）。提交即冻结：correlate + exact revision（答案
// 内容 canonical digest）经 RequirementMaterializePort.stashAnswerSet 落
// evidence，随后 requirement cells 置 answers-committed、mission 回 working
// ——下一轮 reconcile 的规则据 clarificationState 继续推进。重复提交同答案
// 幂等（同 revision 同 cells ⇒ decision 去重路径接住）。

import { ulid } from 'ulid'
import { z } from 'zod'

import { canonicalDigest, canonicalStringify } from '../../domain/canonicalJson'
import {
  checkCommandAdmissible,
  checkMissionTransition,
  type MissionStatus,
} from '../../domain/mission'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { MissionPersistence } from '../ports/missionStore'
import type {
  FactSnapshotReader,
  ReconcilerPorts,
  RequirementMaterializePort,
} from '../ports/reconcilerPorts'
import { invalidateInFlightAction } from '../actionInvalidation'

export const submitMissionAnswersInputSchema = z
  .object({
    missionId: z.string().min(1),
    questionSetRef: z.string().min(1),
    answers: z
      .array(
        z.object({ questionId: z.string().min(1), answer: z.string().min(1).max(8000) }).strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()

export interface SubmitAnswersDeps {
  readonly store: MissionPersistence
  readonly snapshots: FactSnapshotReader
  readonly requirement: RequirementMaterializePort
  /** PR-5 T55：新 answer revision 使 in-flight action 失效（cancel 走 launcher）。 */
  readonly ports?: ReconcilerPorts
  readonly now: () => number
}

export interface SubmitAnswersResult {
  readonly status: MissionStatus
  readonly answerSetRef: string
  readonly answerRevision: string
}

export async function submitMissionAnswers(
  deps: SubmitAnswersDeps,
  rawInput: unknown,
): Promise<SubmitAnswersResult> {
  const input = submitMissionAnswersInputSchema.parse(rawInput)
  const mission = await deps.store.getMission(input.missionId)
  if (mission === null) throw new NotFoundError('mission-not-found', 'mission not found')
  const admissible = checkCommandAdmissible({
    command: 'submit-answers',
    status: mission.status,
    automationMode: mission.automationMode,
    fence: mission.transitionFence,
    hasMergeRequest: mission.mrClaimId !== null,
  })
  if (!admissible.ok) throw new ConflictError(`mission-command-${admissible.code}`, admissible.code)

  // 提交必须对准当前 pending 的问题集（防拿旧 ref 往新问题集上灌答案）。
  const cells =
    mission.requirementBundleRef === null
      ? null
      : await deps.snapshots.getCells(mission.requirementBundleRef)
  const pendingCell = cells?.['__requirement.pendingQuestionSetRef']
  const pendingRef =
    pendingCell !== undefined && pendingCell.state === 'known' ? String(pendingCell.value) : null
  if (pendingRef === null || pendingRef !== input.questionSetRef) {
    throw new ValidationError(
      'question-set-not-pending',
      'the referenced question set is not the pending one for this mission',
    )
  }

  const stashed = await deps.requirement.stashAnswerSet({
    missionId: mission.id,
    questionSetRef: input.questionSetRef,
    answers: input.answers,
  })
  if (!stashed.ok) {
    throw new ValidationError(stashed.failure.code, stashed.failure.remediation)
  }

  // PR-5 T55：答案已换代——in-flight Agent 动作的输入过期，立即失效收束
  //（cancel 尽力 + attempt discarded + run failed(input-invalidated)），
  // 后续轮以新 answers facts 重新开动作，不计旧预算。
  await invalidateInFlightAction(deps, mission, 'input-invalidated')

  // cells：answers-committed + exact revision；status：awaiting-information → working。
  const now = deps.now()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = await deps.store.getMission(mission.id)
    if (fresh === null) throw new NotFoundError('mission-not-found', 'mission not found')
    const base =
      fresh.requirementBundleRef === null
        ? {}
        : ((await deps.snapshots.getCells(fresh.requirementBundleRef)) ?? {})
    const merged = {
      ...base,
      'requirement.clarificationState': {
        state: 'known' as const,
        value: 'answers-committed',
        sourceRevision: stashed.answerRevision,
      },
      '__requirement.answerRevision': {
        state: 'known' as const,
        value: stashed.answerRevision,
        sourceRevision: stashed.answerRevision,
      },
      '__requirement.answerSetRef': {
        state: 'known' as const,
        value: stashed.answerSetRef,
        sourceRevision: stashed.answerRevision,
      },
    }
    const snapshotId = ulid()
    await deps.store.insertFactSnapshot({
      id: snapshotId,
      missionId: fresh.id,
      missionRevision: fresh.revision,
      capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
      cellsJson: canonicalStringify(merged),
      refsJson: canonicalStringify({
        kind: 'requirement-answers',
        questionSetRef: input.questionSetRef,
        answerSetRef: stashed.answerSetRef,
        answerRevision: stashed.answerRevision,
      }),
      digest: canonicalDigest(merged),
      now,
    })
    const toWorking =
      fresh.status === 'awaiting-information' &&
      checkMissionTransition({ from: fresh.status, to: 'working', fence: fresh.transitionFence }).ok
    const result = await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
      requirementBundleRef: snapshotId,
      ...(toWorking ? { status: 'working' as const } : {}),
    })
    if (result.ok) {
      return {
        status: toWorking ? 'working' : fresh.status,
        answerSetRef: stashed.answerSetRef,
        answerRevision: stashed.answerRevision,
      }
    }
    if (result.code !== 'revision-conflict') {
      throw new ConflictError(`mission-occ-${result.code}`, result.code)
    }
  }
  throw new ConflictError('mission-occ-revision-conflict', 'revision-conflict')
}
