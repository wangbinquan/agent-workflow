// RFC-310 PR-2 T26 —— MissionReconciler 单轮循环（design.md §2.6/§4.3）。
//
// 一轮 = 读聚合 → terminal/fence 优先 → facts 组装（行投影 + 已采集 snapshot
// 合并）→ fixed guards + pinned policy first-match（engine 纯函数）→
// run-agent-action 补全（员工 route 是唯一 template selector）→ decision +
// intent 同事务落库（input digest 去重）→ arm handler（外部 IO 全部在事务外）
// → readiness 重算落 readinessJson。
//
// PR-2 的接线边界如实呈现：未注入的端口/未到批次的 arm 一律 typed block
// （`*-not-wired` / `arm-not-wired:<kind>`），绝不静默跳过——「开单 ≠ 在跑」
// 的 RFC-309 教训在这里用显式 blocked 表达。
//
// 确定性注记：canonical trace 覆盖的是**补全后**的 decision（run-agent-action
// 的 templateRef 由员工 route 决定，属于 decision 的一部分而不是执行期细节）；
// decisionInputDigest 只含 factDigest + policy/employee pin，因此同 snapshot
// 重复 reconcile 去重，而新 facts/新 pin 必然产生新 decision。

import { ulid } from 'ulid'

import { sha256Hex } from '@/util/hash'
import {
  automationPolicyContentSchema,
  type AutomationPolicyContent,
} from '../domain/automationPolicy'
import { canonicalDigest, canonicalStringify } from '../domain/canonicalJson'
import { capabilityDefinition, type CapabilityId } from '../domain/capabilityDefinition'
import { nextDecisionSchema, type NextDecision } from '../domain/decision'
import { buildFactSnapshot, type FactCellValue, type MissionFactSnapshot } from '../domain/facts'
import type { FactCell } from '../domain/factCell'
import {
  checkMissionTransition,
  TERMINAL_STATUSES,
  terminalStatusForMr,
  type MissionStatus,
} from '../domain/mission'
import { computeReadiness, type ReadinessInput } from '../domain/readiness'
import { digitalEmployeeContentSchema } from '../domain/digitalEmployee'
import {
  canonicalDecisionDigest,
  type DecisionCanonicalCore,
} from '../engine/policy/canonicalTrace'
import {
  evaluatePolicy,
  type FixedGuardInput,
  type PolicyRule,
} from '../engine/policy/evaluatePolicy'
import { selectActionTemplate, type CapabilityRouteRule } from '../engine/policy/workSelection'
import type { AdmissionLookup } from './ports/admissionLookup'
import type { EffectRow, MissionRow, MissionStore } from './ports/missionStore'
import type { FactSnapshotReader, ReconcilerPorts } from './ports/reconcilerPorts'

export interface ReconcileDeps {
  readonly store: MissionStore
  readonly lookup: AdmissionLookup
  readonly snapshots: FactSnapshotReader
  readonly ports: ReconcilerPorts
  readonly now: () => number
}

export type ReconcileOutcome =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'terminal-noop' }
  | { readonly kind: 'fence-pending'; readonly unsettled: number }
  | { readonly kind: 'fence-settled'; readonly result: 'canceled' | 'tracking-only' }
  | { readonly kind: 'deduped'; readonly decisionId: string }
  | {
      readonly kind: 'decided'
      readonly decisionId: string
      readonly selected: NextDecision
      readonly handled:
        | 'blocked'
        | 'collected'
        | 'action-launched'
        | 'action-launch-failed'
        | 'wake-armed'
        | 'terminal'
        | 'readiness-published'
        | 'placement-done'
    }

function knownCell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'row' }
}

/** 行投影 cells；collector 采回的 snapshot cells 覆盖同名项（更权威）。 */
function projectRowCells(mission: MissionRow): Record<string, FactCell<FactCellValue>> {
  return {
    'requirement.sourceKind': knownCell(mission.sourceKind === 'direct' ? 'direct' : 'external'),
    'requirement.clarificationState': knownCell('none'),
    'requirement.uploadSeedState':
      mission.uploadPlanRef === null
        ? { state: 'not-applicable', reason: 'no upload plan' }
        : knownCell(mission.uploadPublicationRef !== null ? 'published' : 'pending'),
    'mr.exists': knownCell(mission.mrClaimId !== null),
    'action.pendingKind': knownCell(mission.currentActionRunId !== null ? 'agent' : 'none'),
    'action.lastOutcome': knownCell('none'),
    'action.lastFailureCategory': knownCell('none'),
    'action.candidateState': knownCell('none'),
    'budget.actionRunsRemaining': knownCell(1_000),
    'budget.pipelineRerunsRemaining': knownCell(1_000),
    'budget.commitsRemaining': knownCell(1_000),
  }
}

function mergeCollectedCells(
  deps: ReconcileDeps,
  mission: MissionRow,
  cells: Record<string, FactCell<FactCellValue>>,
): void {
  for (const ref of [mission.repositoryFactsRef, mission.requirementBundleRef]) {
    if (ref === null) continue
    const collected = deps.snapshots.getCells(ref)
    if (collected !== null) Object.assign(cells, collected)
  }
  // MR facts snapshot 复用 repositoryFactsRef 之外的第二个 ref 位：PR-2 把最近
  // MR 采集结果也存 fact snapshot 并把 id 记进 readinessJson 侧不合适——直接
  // 约定：mr collector 的结果 snapshot id 存在 mission.uploadPlacementRef？不。
  // PR-2 的 MR cells 由 collect-mr-facts arm 写入独立 snapshot 并把 id 记在
  // mission.repositoryFactsRef 同级——缺列。裁量：MR 采集结果与 repository
  // facts 合并写入同一个新 snapshot（repositoryFactsRef 指向合并后快照），
  // 单 ref 即可回读。见 collect handlers。
}

function projectGuards(
  mission: MissionRow,
  unsettled: readonly EffectRow[],
  cells: Record<string, FactCell<FactCellValue>>,
): FixedGuardInput {
  const mrTerminalCell = cells['mr.terminalState']
  const mrTerminal =
    mrTerminalCell !== undefined && mrTerminalCell.state === 'known'
      ? mrTerminalCell.value === 'merged'
        ? 'merged'
        : mrTerminalCell.value === 'closed'
          ? 'closed'
          : 'active'
      : mission.mrClaimId !== null
        ? 'active'
        : 'not-applicable'
  return {
    missionTerminal: TERMINAL_STATUSES.has(mission.status),
    mrTerminal,
    holdsLease: true, // OCC 即 lease：写路径由 (revision, epoch) 裁决
    activeWritableAction: mission.currentActionRunId !== null,
    unsettledEffect: unsettled.length > 0,
    transitionFence: mission.transitionFence,
    factIntegrityViolations: [],
    staleBaseline: false,
    authorityViolations: [],
    exhaustedBudgets: [],
    automationMode: mission.automationMode,
    uploadSeed:
      mission.uploadPlanRef === null
        ? 'not-applicable'
        : mission.uploadPublicationRef !== null
          ? 'published'
          : mission.uploadPlacementRef !== null
            ? 'seeded'
            : 'pending',
    uploadPlanRef: mission.uploadPlanRef,
  }
}

function readinessInputFrom(
  mission: MissionRow,
  unsettled: readonly EffectRow[],
  cells: Record<string, FactCell<FactCellValue>>,
): ReadinessInput {
  const enumOf = (id: string): string | null => {
    const cell = cells[id]
    return cell !== undefined && cell.state === 'known' && typeof cell.value === 'string'
      ? cell.value
      : null
  }
  const boolOf = (id: string): boolean | null => {
    const cell = cells[id]
    return cell !== undefined && cell.state === 'known' && typeof cell.value === 'boolean'
      ? cell.value
      : null
  }
  const gatesAllPass = cells['pipeline.requiredGatesAllPass']
  const requiredGates =
    gatesAllPass === undefined || gatesAllPass.state === 'not-applicable'
      ? []
      : gatesAllPass.state !== 'known'
        ? ([{ gateKey: '__pipeline', status: 'unknown' }] as const)
        : gatesAllPass.value === true
          ? []
          : ([{ gateKey: '__pipeline', status: 'fail' }] as const)
  return {
    evaluatedForHead: enumOf('__mr.headSha'),
    factDigest: '',
    activeAction: mission.currentActionRunId !== null,
    unconfirmedEffects: unsettled.length,
    unhandledFeedback: 0,
    conflict: boolOf('mr.conflict') === true,
    requiredGates: [...requiredGates],
    pipelineComplete: enumOf('pipeline.completeness') !== 'partial',
    factsComplete: true,
    headConsistent: true,
    uploadFulfillmentPending:
      mission.uploadPlanRef !== null && mission.uploadPublicationRef === null,
    approvalsOutstanding: boolOf('mr.approvalHold') === true ? 1 : 0,
    unresolvedHumanThreads: 0,
    committerPolicyHold: false,
    hostMergeable: (enumOf('mr.mergeable') ?? 'unknown') as 'yes' | 'no' | 'unknown',
  }
}

async function loadPolicyContent(
  lookup: AdmissionLookup,
  mission: MissionRow,
): Promise<AutomationPolicyContent | null> {
  if (mission.policyId === null || mission.policyRevision === null) return null
  const raw = await lookup.getPolicyRevisionContent(mission.policyId, mission.policyRevision)
  if (raw === null) return null
  return automationPolicyContentSchema.parse(raw)
}

interface EmployeeRoutes {
  readonly routes: readonly {
    readonly capabilityId: string
    readonly rules: readonly CapabilityRouteRule[]
    readonly fallbackTemplateRef: string | null
  }[]
}

async function loadEmployeeRoutes(
  lookup: AdmissionLookup,
  mission: MissionRow,
): Promise<EmployeeRoutes | null> {
  if (mission.employeeId === null || mission.employeeRevision === null) return null
  const raw = await lookup.getEmployeeRevisionContent(mission.employeeId, mission.employeeRevision)
  if (raw === null) return null
  const content = digitalEmployeeContentSchema.parse(raw) as unknown as {
    capabilityRoutes: readonly {
      capabilityId: string
      rules: readonly {
        ruleId: string
        when: CapabilityRouteRule['when']
        templateRef: { id: string; revision: number }
      }[]
      fallbackTemplateRef: { id: string; revision: number } | null
    }[]
  }
  return {
    routes: content.capabilityRoutes.map((route) => ({
      capabilityId: route.capabilityId,
      rules: route.rules.map((r) => ({
        ruleId: r.ruleId,
        when: r.when,
        templateRef: `${r.templateRef.id}@${r.templateRef.revision}`,
      })),
      fallbackTemplateRef:
        route.fallbackTemplateRef === null
          ? null
          : `${route.fallbackTemplateRef.id}@${route.fallbackTemplateRef.revision}`,
    })),
  }
}

function parseTemplateRef(ref: string): { readonly id: string; readonly revision: number } {
  const at = ref.lastIndexOf('@')
  return { id: ref.slice(0, at), revision: Number(ref.slice(at + 1)) }
}

/** fence settle（cancel/handoff 的收口半边；design §2.3/§4.8）。 */
async function settleFence(deps: ReconcileDeps, mission: MissionRow): Promise<ReconcileOutcome> {
  const now = deps.now()
  for (const effect of deps.store.listUnsettledEffects(mission.id)) {
    if (effect.state === 'prepared') {
      deps.store.invalidateEffect(effect.id, now)
      continue
    }
    // dispatched：必须按外部真相结算——经 executor 查询/重放；无 executor 则保持 pending。
    if (deps.ports.effectExecutor === undefined) continue
    const settled = await deps.ports.effectExecutor.execute({
      effectId: effect.id,
      effectKind: effect.effectKind,
      intentDigest: effect.intentDigest,
    })
    if (settled.ok) deps.store.confirmEffect(effect.id, settled.receiptRef, now)
    else deps.store.failEffect(effect.id, JSON.stringify(settled.failure), now)
  }
  const remaining = deps.store
    .listUnsettledEffects(mission.id)
    .filter((e) => e.state === 'dispatched')
  if (remaining.length > 0) return { kind: 'fence-pending', unsettled: remaining.length }

  const fresh = deps.store.getMission(mission.id)
  if (fresh === null) return { kind: 'not-found' }
  if (fresh.transitionFence === 'cancel-pending') {
    const verdict = checkMissionTransition({
      from: fresh.status,
      to: 'canceled',
      fence: fresh.transitionFence,
    })
    if (!verdict.ok) return { kind: 'terminal-noop' }
    const result = deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
      status: 'canceled',
      transitionFence: 'none',
      terminalKind: 'canceled',
      terminalAt: now,
      currentActionRunId: null,
    })
    if (result.ok && fresh.mrClaimId !== null) deps.store.releaseMr(fresh.mrClaimId, now)
    return { kind: 'fence-settled', result: 'canceled' }
  }
  // handoff-pending
  deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
    automationMode: 'tracking-only',
    transitionFence: 'none',
  })
  return { kind: 'fence-settled', result: 'tracking-only' }
}

function publishReadiness(deps: ReconcileDeps, missionId: string): void {
  const mission = deps.store.getMission(missionId)
  if (mission === null || TERMINAL_STATUSES.has(mission.status)) return
  const cells = projectRowCells(mission)
  mergeCollectedCells(deps, mission, cells)
  const unsettled = deps.store.listUnsettledEffects(mission.id)
  const readiness = computeReadiness(readinessInputFrom(mission, unsettled, cells))
  deps.store.occUpdate(mission.id, mission.revision, mission.epoch, {
    readinessJson: canonicalStringify(readiness),
  })
}

export async function runMissionReconcile(
  deps: ReconcileDeps,
  missionId: string,
): Promise<ReconcileOutcome> {
  const mission = deps.store.getMission(missionId)
  if (mission === null) return { kind: 'not-found' }
  const now = deps.now()

  if (TERMINAL_STATUSES.has(mission.status)) {
    deps.store.consumeWakeHints(mission.id, now)
    return { kind: 'terminal-noop' }
  }
  if (mission.transitionFence !== 'none') {
    const outcome = await settleFence(deps, mission)
    return outcome
  }

  deps.store.consumeWakeHints(mission.id, now)

  // ---- facts 组装 -----------------------------------------------------------
  const cells = projectRowCells(mission)
  mergeCollectedCells(deps, mission, cells)
  const unsettled = deps.store.listUnsettledEffects(mission.id)
  const snapshot: MissionFactSnapshot = buildFactSnapshot({
    missionRevision: mission.revision,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cells,
  })

  // ---- guards + rules -------------------------------------------------------
  const guards = projectGuards(mission, unsettled, cells)
  const policy = await loadPolicyContent(deps.lookup, mission)
  if (policy === null) {
    return await commitAndHandle(deps, mission, snapshot, {
      selected: { kind: 'block', reason: 'policy-content-missing' },
      selectedBy: 'guard',
      matchedRuleId: null,
      guardTrace: [],
      ruleTrace: [],
    })
  }
  const rules: PolicyRule[] = policy.actionPriority.rules.map((rule) => ({
    ruleId: rule.ruleId,
    when: rule.when,
    decision: {
      kind: 'run-agent-action',
      capabilityId: rule.capabilityId,
      templateRef: 'pending-route',
      workSetRef: 'none',
    },
  }))
  const evaluation = evaluatePolicy({ guards, snapshot, rules })

  // ---- run-agent-action 补全（员工 route 是唯一 selector） ------------------
  let selected: NextDecision = evaluation.selected
  if (selected.kind === 'run-agent-action' && selected.templateRef === 'pending-route') {
    const employee = await loadEmployeeRoutes(deps.lookup, mission)
    const capabilityId = selected.capabilityId
    const route = employee?.routes.find((r) => r.capabilityId === capabilityId)
    if (employee === null || route === undefined) {
      selected = { kind: 'block', reason: `no-route-for:${capabilityId}` }
    } else {
      const routed = selectActionTemplate({
        rules: route.rules,
        fallbackTemplateRef: route.fallbackTemplateRef,
        snapshot,
      })
      selected =
        routed.outcome === 'selected'
          ? {
              kind: 'run-agent-action',
              capabilityId,
              templateRef: routed.templateRef,
              workSetRef: 'none',
            }
          : { kind: 'block', reason: `template-route:${routed.reason}` }
    }
  }

  return await commitAndHandle(deps, mission, snapshot, { ...evaluation, selected })
}

interface EvaluationLike {
  readonly selected: NextDecision
  readonly selectedBy: 'guard' | 'rule' | 'no-match'
  readonly matchedRuleId: string | null
  readonly guardTrace: readonly unknown[]
  readonly ruleTrace: readonly unknown[]
}

async function commitAndHandle(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  evaluation: EvaluationLike,
): Promise<ReconcileOutcome> {
  const now = deps.now()
  const selected = nextDecisionSchema.parse(evaluation.selected)
  const core: DecisionCanonicalCore = {
    policyRef: mission.policyId === null ? 'none' : `${mission.policyId}@${mission.policyRevision}`,
    employeeRef:
      mission.employeeId === null ? null : `${mission.employeeId}@${mission.employeeRevision}`,
    factDigest: snapshot.digest,
    workSetDigest: null,
    guardTrace: evaluation.guardTrace as never,
    ruleTrace: evaluation.ruleTrace as never,
    selected,
  }
  const canonical = canonicalDecisionDigest(core)
  // 去重键用 cells 的**内容** digest：snapshot.digest 含 missionRevision 与
  // capturedAt（readiness 落盘也会 bump revision），拿它当键会让同 facts 的
  // 重复 reconcile 永不去重。内容不变 ⇒ 决策输入不变 ⇒ 去重。
  const decisionInputDigest = canonicalDigest({
    cellsDigest: canonicalDigest(snapshot.cells),
    policyId: mission.policyId,
    policyRevision: mission.policyRevision,
    employeeId: mission.employeeId,
    employeeRevision: mission.employeeRevision,
  })

  const snapshotId = ulid()
  const decisionId = ulid()
  const inserted = deps.store.inTx(() => {
    deps.store.insertFactSnapshot({
      id: snapshotId,
      missionId: mission.id,
      missionRevision: mission.revision,
      capturedAt: snapshot.capturedAt,
      cellsJson: canonicalStringify(snapshot.cells),
      refsJson: canonicalStringify({}),
      digest: snapshot.digest,
      now,
    })
    return deps.store.insertDecision({
      id: decisionId,
      missionId: mission.id,
      missionRevision: mission.revision,
      policyId: mission.policyId,
      policyRevision: mission.policyRevision,
      employeeId: mission.employeeId,
      employeeRevision: mission.employeeRevision,
      factSnapshotId: snapshotId,
      factDigest: snapshot.digest,
      workSetJson: null,
      guardTraceJson: canonicalStringify(evaluation.guardTrace),
      ruleTraceJson: canonicalStringify(evaluation.ruleTrace),
      selectedJson: canonicalStringify(selected),
      canonicalDigest: canonical,
      decisionInputDigest,
      now,
    })
  })
  if (!inserted.created) {
    publishReadiness(deps, mission.id)
    return { kind: 'deduped', decisionId: inserted.decisionId }
  }

  const handled = await handleDecision(deps, mission, snapshot, selected, inserted.decisionId)
  publishReadiness(deps, mission.id)
  return { kind: 'decided', decisionId: inserted.decisionId, selected, handled }
}

function blockMission(
  deps: ReconcileDeps,
  missionId: string,
  code: string,
  detail: string | null,
): void {
  const mission = deps.store.getMission(missionId)
  if (mission === null) return
  const verdict = checkMissionTransition({
    from: mission.status,
    to: 'blocked',
    fence: mission.transitionFence,
  })
  if (!verdict.ok) return
  deps.store.occUpdate(mission.id, mission.revision, mission.epoch, {
    status: 'blocked',
    blockCode: code,
    blockDetail: detail,
    currentActionRunId: null,
  })
}

async function handleDecision(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  selected: NextDecision,
  decisionId: string,
): Promise<Extract<ReconcileOutcome, { kind: 'decided' }>['handled']> {
  const now = deps.now()
  switch (selected.kind) {
    case 'mark-terminal': {
      const to: MissionStatus =
        selected.terminal === 'merged'
          ? terminalStatusForMr('merged')
          : selected.terminal === 'closed-unmerged'
            ? terminalStatusForMr('closed')
            : selected.terminal
      const verdict = checkMissionTransition({
        from: mission.status,
        to,
        fence: mission.transitionFence,
      })
      if (!verdict.ok) return 'blocked'
      const result = deps.store.occUpdate(mission.id, mission.revision, mission.epoch, {
        status: to,
        terminalKind: selected.terminal,
        terminalAt: now,
        currentActionRunId: null,
      })
      if (result.ok && mission.mrClaimId !== null) deps.store.releaseMr(mission.mrClaimId, now)
      return 'terminal'
    }
    case 'block': {
      blockMission(deps, mission.id, selected.reason, null)
      return 'blocked'
    }
    case 'wait': {
      const existing = deps.store.getWake(mission.id, decisionId)
      if (existing === null) {
        deps.store.armWake({
          id: ulid(),
          missionId: mission.id,
          decisionId,
          reason: selected.reason,
          resumeAt: selected.resumeAt === null ? null : Date.parse(selected.resumeAt),
          wakeSources: selected.wakeSources,
          attemptOrdinal: selected.attemptOrdinal,
          now,
        })
      }
      return 'wake-armed'
    }
    case 'collect-repository-facts': {
      const collector = deps.ports.repositoryFacts
      if (collector === undefined) {
        blockMission(deps, mission.id, 'collector-not-wired:repository', null)
        return 'blocked'
      }
      const collected = await collector.collect({
        missionId: mission.id,
        repositoryId: mission.repositoryId,
      })
      const snapshotId = ulid()
      deps.store.insertFactSnapshot({
        id: snapshotId,
        missionId: mission.id,
        missionRevision: mission.revision,
        capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
        cellsJson: canonicalStringify(collected.cells),
        refsJson: canonicalStringify({ kind: 'repository', factsRef: collected.factsRef }),
        digest: canonicalDigest(collected.cells),
        now,
      })
      const fresh = deps.store.getMission(mission.id)
      if (fresh !== null) {
        deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
          repositoryFactsRef: snapshotId,
        })
      }
      return 'collected'
    }
    case 'collect-mr-facts': {
      const collector = deps.ports.mergeRequestFacts
      if (collector === undefined) {
        blockMission(deps, mission.id, 'collector-not-wired:merge-request', null)
        return 'blocked'
      }
      const collected = await collector.collect({
        missionId: mission.id,
        mrClaimId: mission.mrClaimId,
      })
      // MR cells 与既有 repository cells 合并进一个新快照（单 ref 回读；见
      // mergeCollectedCells 的裁量注释）。
      const base =
        mission.repositoryFactsRef === null
          ? {}
          : (deps.snapshots.getCells(mission.repositoryFactsRef) ?? {})
      const merged = { ...base, ...collected.cells }
      if (collected.headSha !== null) {
        merged['__mr.headSha'] = {
          state: 'known',
          value: collected.headSha,
          sourceRevision: collected.snapshotRef,
        }
      }
      const snapshotId = ulid()
      deps.store.insertFactSnapshot({
        id: snapshotId,
        missionId: mission.id,
        missionRevision: mission.revision,
        capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
        cellsJson: canonicalStringify(merged),
        refsJson: canonicalStringify({
          kind: 'repository+mr',
          snapshotRef: collected.snapshotRef,
          headSha: collected.headSha,
          targetSha: collected.targetSha,
        }),
        digest: canonicalDigest(merged),
        now,
      })
      const fresh = deps.store.getMission(mission.id)
      if (fresh !== null) {
        deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
          repositoryFactsRef: snapshotId,
        })
      }
      return 'collected'
    }
    case 'seed-repository-uploads': {
      const placement = deps.ports.uploadPlacement
      if (placement === undefined) {
        blockMission(deps, mission.id, 'placement-not-wired', null)
        return 'blocked'
      }
      const placed = await placement.place({
        missionId: mission.id,
        uploadPlanRef: selected.uploadPlanRef,
      })
      if (!placed.ok) {
        blockMission(deps, mission.id, `placement-failed:${placed.failure.code}`, null)
        return 'blocked'
      }
      const fresh = deps.store.getMission(mission.id)
      if (fresh !== null) {
        deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
          uploadPlacementRef: placed.seedTreeDigest,
        })
      }
      return 'placement-done'
    }
    case 'run-agent-action': {
      const template = parseTemplateRef(selected.templateRef)
      const definition = capabilityDefinition(selected.capabilityId as CapabilityId)
      const writable =
        definition.workspaceMode === 'edit-business-files' ||
        definition.workspaceMode === 'edit-conflicts'
      const actionRunId = ulid()
      const created = deps.store.createActionRun({
        id: actionRunId,
        missionId: mission.id,
        missionRevision: mission.revision,
        decisionId,
        capabilityId: selected.capabilityId,
        capabilityContractVersion: definition.contractVersion,
        templateId: template.id,
        templateRevision: template.revision,
        workSetDigest: null,
        inputFactDigest: snapshot.digest,
        baselineRef: null,
        writable,
        now,
      })
      if (!created.ok) {
        blockMission(deps, mission.id, created.code, null)
        return 'blocked'
      }
      {
        const fresh = deps.store.getMission(mission.id)
        if (fresh !== null) {
          deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
            currentActionRunId: actionRunId,
          })
        }
      }
      const launcher = deps.ports.agentLauncher
      if (launcher === undefined) {
        deps.store.settleActionRun({
          id: actionRunId,
          status: 'failed',
          resultRef: null,
          failureJson: JSON.stringify({
            category: 'configuration',
            code: 'agent-launcher-not-wired',
            retryability: 'after-configuration',
            attemptOrdinal: 0,
            remediation: 'wire AgentActionLauncherPort (PR-4/PR-5)',
            evidenceRef: null,
          }),
          now,
        })
        blockMission(deps, mission.id, 'agent-launcher-not-wired', null)
        return 'action-launch-failed'
      }
      const launched = await launcher.launch({
        actionRunId,
        capabilityId: selected.capabilityId,
        templateId: template.id,
        templateRevision: template.revision,
      })
      if (!launched.ok) {
        deps.store.settleActionRun({
          id: actionRunId,
          status: 'failed',
          resultRef: null,
          failureJson: JSON.stringify(launched.failure),
          now,
        })
        blockMission(deps, mission.id, `agent-launch-failed:${launched.failure.code}`, null)
        return 'action-launch-failed'
      }
      deps.store.claimAttempt({
        id: ulid(),
        actionRunId,
        rerunSeq: 0,
        attemptSeq: 0,
        executionRef: launched.executionRef,
        baselineRef: 'baseline-pending',
        nonceDigest: sha256Hex(`${actionRunId}:0:0`),
        inputDigest: snapshot.digest,
        now,
      })
      return 'action-launched'
    }
    case 'publish-readiness': {
      // readiness 在 commitAndHandle 尾部统一重算；此处只做状态推进。
      const fresh = deps.store.getMission(mission.id)
      if (fresh === null) return 'readiness-published'
      const cells = projectRowCells(fresh)
      mergeCollectedCells(deps, fresh, cells)
      const readiness = computeReadiness(
        readinessInputFrom(fresh, deps.store.listUnsettledEffects(fresh.id), cells),
      )
      if (
        readiness.status !== fresh.status &&
        (fresh.status === 'watching' ||
          fresh.status === 'waiting-committer' ||
          fresh.status === 'ready-to-merge')
      ) {
        const to = readiness.status === 'working' ? 'watching' : readiness.status
        if (to !== fresh.status) {
          const verdict = checkMissionTransition({
            from: fresh.status,
            to,
            fence: fresh.transitionFence,
          })
          if (verdict.ok) {
            deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, { status: to })
          }
        }
      }
      return 'readiness-published'
    }
    // ---- 未到批次的 arm：typed block，绝不静默 ------------------------------
    case 'materialize-direct-requirement':
    case 'collect-external-requirement':
    case 'publish-requirement-questions':
    case 'collect-requirement-answers':
    case 'collect-pipeline-evidence':
    case 'run-verification':
    case 'request-human-decision':
    case 'prepare-change-candidate':
    case 'commit-and-publish-candidate':
    case 'ensure-merge-request':
    case 'reply-feedback':
    case 'trigger-pipeline':
    case 'rerun-pipeline':
    case 'handoff':
    case 'mark-ready-to-merge': {
      blockMission(deps, mission.id, `arm-not-wired:${selected.kind}`, null)
      return 'blocked'
    }
    default: {
      const exhaustive: never = selected
      throw new Error(`unhandled decision arm: ${JSON.stringify(exhaustive)}`)
    }
  }
}
