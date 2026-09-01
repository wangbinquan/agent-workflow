// RFC-310 T31a —— 在途 Mission 的 configuration upgrade（design §12.1）。
//
// preview 用 pure planner（engine/policy/configUpgradePlanner）；apply 是原子
// repin：先决拒条件（terminal/fence/writable action），再一次性写新 closure +
// bump epoch（旧 worker receipt 全部过期）+ 作废未 dispatch 的 effect。已
// push 的 commit/MR 历史不回滚。HTTP 面（preview/apply 端点与
// `development-missions:upgrade` 权限点）随 PR-8 与 handoff/attach/resume
// 一起挂载。

import { checkCommandAdmissible } from '../../domain/mission'
import {
  planConfigurationUpgrade,
  type ConfigUpgradePlan,
  type PinnedClosure,
} from '../../engine/policy/configUpgradePlanner'
import type { MissionPersistence } from '../ports/missionStore'
import type { AdmissionLookup } from '../ports/admissionLookup'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

export interface UpgradeDeps {
  readonly store: MissionPersistence
  readonly lookup: AdmissionLookup
  readonly now: () => number
}

export interface UpgradeRequest {
  readonly missionId: string
  readonly nextEmployee: { readonly id: string; readonly revision: number } | null
  readonly nextPolicy: { readonly id: string; readonly revision: number } | null
}

function currentClosure(mission: {
  employeeId: string | null
  employeeRevision: number | null
  policyId: string | null
  policyRevision: number | null
}): PinnedClosure {
  return {
    employee:
      mission.employeeId !== null && mission.employeeRevision !== null
        ? { id: mission.employeeId, revision: mission.employeeRevision }
        : null,
    policy:
      mission.policyId !== null && mission.policyRevision !== null
        ? { id: mission.policyId, revision: mission.policyRevision }
        : null,
    templates: {},
    verificationProfiles: {},
    adapters: {},
  }
}

export async function previewConfigurationUpgrade(
  deps: UpgradeDeps,
  request: UpgradeRequest,
): Promise<ConfigUpgradePlan> {
  const mission = await deps.store.getMission(request.missionId)
  if (mission === null) throw new NotFoundError('mission-not-found', 'mission not found')
  const next: PinnedClosure = {
    ...currentClosure(mission),
    employee: request.nextEmployee ?? currentClosure(mission).employee,
    policy: request.nextPolicy ?? currentClosure(mission).policy,
  }
  const unsettled = await deps.store.listUnsettledEffects(request.missionId)
  return planConfigurationUpgrade({
    current: currentClosure(mission),
    next,
    inFlight: {
      unpublishedActionRunRefs:
        mission.currentActionRunId === null ? [] : [mission.currentActionRunId],
      unpublishedCandidateRefs: [],
      pendingDecisionRefs: unsettled.filter((e) => e.state === 'prepared').map((e) => e.id),
      analysisReceiptRefs: [],
    },
  })
}

export async function applyConfigurationUpgrade(
  deps: UpgradeDeps,
  request: UpgradeRequest,
): Promise<{ readonly epoch: number; readonly noop: boolean }> {
  const mission = await deps.store.getMission(request.missionId)
  if (mission === null) throw new NotFoundError('mission-not-found', 'mission not found')
  const admissible = checkCommandAdmissible({
    command: 'configuration-upgrade',
    status: mission.status,
    automationMode: mission.automationMode,
    fence: mission.transitionFence,
    hasMergeRequest: mission.mrClaimId !== null,
  })
  if (!admissible.ok) {
    throw new ConflictError(`configuration-upgrade-${admissible.code}`, 'upgrade not admissible')
  }
  if (mission.currentActionRunId !== null) {
    // active writable ActionRun 必须先 cancel/settle（design §12.1）；本命令
    // 不代做——那是有外部现场的动作，归 reconciler 的 fence 流程。
    throw new ConflictError('configuration-upgrade-active-action', 'settle the active action first')
  }
  const plan = await previewConfigurationUpgrade(deps, request)
  if (plan.noop) return { epoch: mission.epoch, noop: true }

  // 校验新 pin 存在（published revision）。
  if (request.nextEmployee !== null) {
    const content = await deps.lookup.getEmployeeRevisionContent(
      request.nextEmployee.id,
      request.nextEmployee.revision,
    )
    if (content === null) {
      throw new ValidationError(
        'configuration-upgrade-employee-missing',
        'employee revision not found',
      )
    }
  }
  if (request.nextPolicy !== null) {
    const content = await deps.lookup.getPolicyRevisionContent(
      request.nextPolicy.id,
      request.nextPolicy.revision,
    )
    if (content === null) {
      throw new ValidationError('configuration-upgrade-policy-missing', 'policy revision not found')
    }
  }

  // 作废未 dispatch 的 intent；dispatched 的由 reconciler 按外部真相 settle。
  for (const effect of await deps.store.listUnsettledEffects(request.missionId)) {
    if (effect.state === 'prepared') {
      await deps.store.invalidateEffect(effect.id, deps.now())
    }
  }
  // bumpEpoch 原子完成 repin：epoch+1 让所有旧 worker receipt 过期。
  const result = await deps.store.bumpEpoch(request.missionId, mission.revision, {
    ...(request.nextEmployee === null
      ? {}
      : { employeeId: request.nextEmployee.id, employeeRevision: request.nextEmployee.revision }),
    ...(request.nextPolicy === null
      ? {}
      : { policyId: request.nextPolicy.id, policyRevision: request.nextPolicy.revision }),
  })
  if (!result.ok) {
    throw new ConflictError(`configuration-upgrade-${result.code}`, 'concurrent mission write')
  }
  const upgraded = await deps.store.getMission(request.missionId)
  return { epoch: upgraded?.epoch ?? mission.epoch + 1, noop: false }
}
