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

import {
  automationPolicyContentSchema,
  type AutomationPolicyContent,
} from '../domain/automationPolicy'
import { canonicalDigest, canonicalStringify } from '../domain/canonicalJson'
import { capabilityDefinition, type CapabilityId } from '../domain/capabilityDefinition'
import { nextDecisionSchema, type NextDecision } from '../domain/decision'
import {
  buildFactSnapshot,
  FACT_CATALOG,
  type FactCellValue,
  type MissionFactSnapshot,
} from '../domain/facts'
import { gateCountsAsPass, pipelineEvidenceManifestV1Schema } from '../domain/pipelineManifest'
import type { FactCell } from '../domain/factCell'
import {
  checkMissionTransition,
  TERMINAL_STATUSES,
  terminalStatusForMr,
  type MissionStatus,
} from '../domain/mission'
import { computeReadiness, type ReadinessInput } from '../domain/readiness'
import { backoffDelayMs, DEFAULT_TRANSIENT_BACKOFF } from '../domain/operationFailure'
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
import {
  collectAgentAttempt,
  launchAgentAttempt,
  publicFactsSummary,
  type CollectAgentAttemptOutcome,
} from './agentActionOrchestrator'
import { invalidateInFlightAction } from './actionInvalidation'
import { reopenClosedMission } from './commands/reopenMission'
import {
  feedbackFingerprint,
  selectableFeedback,
  type FeedbackLedgerRow,
} from '../domain/feedbackLedger'
import {
  DELIVERY_EFFECT_KINDS,
  handleCommitAndPublish,
  handleEnsureMergeRequest,
  handleRunVerification,
  redispatchDelivery,
  type DeliveryChainDeps,
} from './missionDeliveryChain'
import {
  MR_CARE_EFFECT_KINDS,
  handleReplyFeedback,
  prepareFeedbackSelection,
  releaseFeedbackSelection,
  redispatchMrCare,
} from './mrCareChain'
import {
  PIPELINE_EFFECT_KINDS,
  handleCollectPipelineEvidence,
  handleRerunPipeline,
  handleTriggerPipeline,
  loadPipelineManifest,
  redispatchPipeline,
} from './pipelineEvidenceChain'
import type { AdmissionLookup } from './ports/admissionLookup'
import type { EffectRow, MissionRow, MissionPersistence } from './ports/missionStore'
import type { FactSnapshotReader, ReconcilerPorts } from './ports/reconcilerPorts'
import {
  handleApprovalObserveDecision,
  handleApprovalSubmitDecision,
  handleChildMissionDecision,
  selectPlaybookStepDecision,
  settlePlaybookAction,
  settlePlaybookDecision,
} from './playbookStepCoordinator'

/**
 * Review text is provider material, not a rule fact. Keep it in one hidden,
 * bounded cell so the decision engine only sees the typed count/digest while
 * a later reconcile can still assemble the exact Agent input. The provider
 * endpoint itself caps a collection at 100 threads; this second bound prevents
 * a handful of very large comments from turning every fact snapshot into a
 * multi-megabyte DB row.
 */
export const MR_FEEDBACK_INPUT_MAX_BYTES = 256 * 1024
export const MR_FEEDBACK_INPUT_CELL = '__mr.feedbackInput'
export const MR_UNRESOLVED_FEEDBACK_CELL = '__mr.unresolvedFeedback'

interface FeedbackPromptItem {
  readonly threadRef: string
  readonly revision: string
  readonly body: string
  readonly path: string | null
}

interface FeedbackPromptSnapshot {
  readonly snapshotRef: string
  readonly headSha: string
  readonly items: readonly FeedbackPromptItem[]
}

export interface ReconcileDeps {
  readonly store: MissionPersistence
  readonly lookup: AdmissionLookup
  readonly snapshots: FactSnapshotReader
  readonly ports: ReconcilerPorts
  readonly now: () => number
}

export type ReconcileOutcome =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'terminal-noop' }
  /** T81/§10.4：终态未逆转，另建了一条带链接的新 Mission generation 接管该 MR。 */
  | { readonly kind: 'mission-reopened'; readonly successorMissionId: string }
  | { readonly kind: 'fence-pending'; readonly unsettled: number }
  | { readonly kind: 'fence-settled'; readonly result: 'canceled' | 'tracking-only' }
  | { readonly kind: 'deduped'; readonly decisionId: string }
  | { readonly kind: 'action-collect'; readonly result: CollectAgentAttemptOutcome }
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

function feedbackInputCell(input: {
  readonly providerSnapshotRef: string
  readonly headSha: string
  readonly selected: readonly { readonly threadRef: string; readonly revision: string }[]
  readonly threads: readonly FeedbackPromptItem[]
}): FactCell<FactCellValue> {
  const byRevision = new Map(
    input.threads.map((thread) => [`${thread.threadRef}\u0000${thread.revision}`, thread]),
  )
  const items: FeedbackPromptItem[] = []
  for (const selected of input.selected) {
    const found = byRevision.get(`${selected.threadRef}\u0000${selected.revision}`)
    if (found === undefined) {
      return {
        state: 'unknown',
        reason: `feedback-body-missing:${selected.threadRef}@${selected.revision}`,
        collectable: true,
      }
    }
    items.push(found)
  }
  const core = { headSha: input.headSha, items }
  const value = canonicalStringify({
    snapshotRef: canonicalDigest({ providerSnapshotRef: input.providerSnapshotRef, ...core }),
    ...core,
  })
  if (Buffer.byteLength(value, 'utf8') > MR_FEEDBACK_INPUT_MAX_BYTES) {
    return {
      state: 'unknown',
      reason: `feedback-input-over-budget:${MR_FEEDBACK_INPUT_MAX_BYTES}`,
      collectable: false,
    }
  }
  return { state: 'known', value, sourceRevision: input.providerSnapshotRef }
}

function unresolvedFeedbackCell(input: {
  readonly providerSnapshotRef: string
  readonly headSha: string
  readonly threads: readonly {
    readonly threadRef: string
    readonly revision: string
    readonly resolved: boolean
  }[]
}): FactCell<FactCellValue> {
  const value = canonicalStringify({
    headSha: input.headSha,
    items: input.threads
      .filter((thread) => !thread.resolved)
      .map((thread) => ({ threadRef: thread.threadRef, revision: thread.revision })),
  })
  if (Buffer.byteLength(value, 'utf8') > MR_FEEDBACK_INPUT_MAX_BYTES) {
    return {
      state: 'unknown',
      reason: `unresolved-feedback-over-budget:${MR_FEEDBACK_INPUT_MAX_BYTES}`,
      collectable: false,
    }
  }
  return { state: 'known', value, sourceRevision: input.providerSnapshotRef }
}

function unresolvedNeedsHumanCount(
  cells: Readonly<Record<string, FactCell<FactCellValue>>>,
  feedback: readonly FeedbackLedgerRow[],
): number {
  const headSha = knownString(cells, '__mr.headSha')
  const currentRows = feedback.filter(
    (row) => row.state === 'needs-human' && (headSha === null || row.headSha === headSha),
  )
  const cell = cells[MR_UNRESOLVED_FEEDBACK_CELL]
  if (cell === undefined || cell.state !== 'known' || typeof cell.value !== 'string') {
    // Old snapshots have no provider unresolved-set projection. Conservatively
    // retain the human hold until the next MR facts collection upgrades it.
    return currentRows.length
  }
  try {
    const raw = JSON.parse(cell.value) as { headSha?: unknown; items?: unknown }
    if (raw.headSha !== headSha || !Array.isArray(raw.items)) return currentRows.length
    const unresolved = new Set<string>()
    for (const item of raw.items) {
      if (
        item === null ||
        typeof item !== 'object' ||
        typeof (item as { threadRef?: unknown }).threadRef !== 'string' ||
        typeof (item as { revision?: unknown }).revision !== 'string'
      ) {
        return currentRows.length
      }
      unresolved.add(
        `${(item as { threadRef: string }).threadRef}\u0000${(item as { revision: string }).revision}`,
      )
    }
    return currentRows.filter((row) => unresolved.has(`${row.threadRef}\u0000${row.revision}`))
      .length
  } catch {
    return currentRows.length
  }
}

function readFeedbackPromptSnapshot(
  cells: Readonly<Record<string, FactCell<FactCellValue>>>,
  selected: readonly { readonly threadRef: string; readonly revision: string }[],
): FeedbackPromptSnapshot | null {
  const cell = cells[MR_FEEDBACK_INPUT_CELL]
  if (cell === undefined || cell.state !== 'known' || typeof cell.value !== 'string') return null
  try {
    const raw = JSON.parse(cell.value) as {
      snapshotRef?: unknown
      headSha?: unknown
      items?: unknown
    }
    if (
      typeof raw.snapshotRef !== 'string' ||
      typeof raw.headSha !== 'string' ||
      !Array.isArray(raw.items)
    ) {
      return null
    }
    const items: FeedbackPromptItem[] = []
    for (const expected of selected) {
      const item = raw.items.find(
        (candidate): candidate is Record<string, unknown> =>
          candidate !== null &&
          typeof candidate === 'object' &&
          (candidate as Record<string, unknown>).threadRef === expected.threadRef &&
          (candidate as Record<string, unknown>).revision === expected.revision,
      )
      if (
        item === undefined ||
        typeof item.body !== 'string' ||
        !(item.path === null || typeof item.path === 'string')
      ) {
        return null
      }
      items.push({
        threadRef: expected.threadRef,
        revision: expected.revision,
        body: item.body,
        path: item.path,
      })
    }
    if (items.length !== raw.items.length) return null
    return { snapshotRef: raw.snapshotRef, headSha: raw.headSha, items }
  } catch {
    return null
  }
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
    // PR-10 T109 抓出：无 claim 时 mr 组 fact 若留 unknown，任何引用 mr.* 的
    // 规则会让引擎 indeterminate 停机派 collect-mr-facts——而采集在无 MR 时
    // 不可执行，mission 以 deduped block 卡死。domain 语义本就有解：MR 不存在
    // ⇒ mr fact **not-applicable**（predicate(null) 确定失配，first-match 落到
    // 下一条规则）。collector 采回的真值照常覆盖本投影（见函数注释）。
    ...(mission.mrClaimId === null
      ? Object.fromEntries(
          FACT_CATALOG.filter((f) => f.group === 'mr' && f.id !== 'mr.exists').map((f) => [
            f.id,
            { state: 'not-applicable', reason: 'no-mr-claim' } satisfies FactCell<FactCellValue>,
          ]),
        )
      : {}),
  }
}

async function mergeCollectedCells(
  deps: ReconcileDeps,
  mission: MissionRow,
  cells: Record<string, FactCell<FactCellValue>>,
): Promise<void> {
  for (const ref of [mission.repositoryFactsRef, mission.requirementBundleRef]) {
    if (ref === null) continue
    const collected = await deps.snapshots.getCells(ref)
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
  feedback: readonly FeedbackLedgerRow[],
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
    unhandledFeedback: knownNumber(cells, 'mr.unhandledFeedbackCount') ?? 0,
    conflict: boolOf('mr.conflict') === true,
    requiredGates: [...requiredGates],
    pipelineComplete: enumOf('pipeline.completeness') !== 'partial',
    factsComplete: true,
    headConsistent: true,
    uploadFulfillmentPending:
      mission.uploadPlanRef !== null && mission.uploadPublicationRef === null,
    approvalsOutstanding: boolOf('mr.approvalHold') === true ? 1 : 0,
    unresolvedHumanThreads: unresolvedNeedsHumanCount(cells, feedback),
    committerPolicyHold: false,
    hostMergeable: (enumOf('mr.mergeable') ?? 'unknown') as 'yes' | 'no' | 'unknown',
  }
}

async function projectLiveFeedbackCount(
  store: Pick<MissionPersistence, 'listFeedback'>,
  mission: MissionRow,
  cells: Record<string, FactCell<FactCellValue>>,
  policy: AutomationPolicyContent | null,
): Promise<void> {
  if (
    policy === null ||
    mission.mrClaimId === null ||
    cells['__mr.factsCollectedAt'] === undefined
  ) {
    return
  }
  cells['mr.unhandledFeedbackCount'] = {
    state: 'known',
    value: selectableFeedback(await store.listFeedback(mission.id), policy.feedback).length,
    sourceRevision: 'ledger-live',
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
  for (const effect of await deps.store.listUnsettledEffects(mission.id)) {
    if (effect.state === 'prepared') {
      await deps.store.invalidateEffect(effect.id, now)
      continue
    }
    // dispatched：必须按外部真相结算——经 executor 查询/重放；无 executor 则保持 pending。
    if (deps.ports.effectExecutor === undefined) continue
    const settled = await deps.ports.effectExecutor.execute({
      effectId: effect.id,
      effectKind: effect.effectKind,
      intentDigest: effect.intentDigest,
    })
    if (settled.ok) await deps.store.confirmEffect(effect.id, settled.receiptRef, now)
    else await deps.store.failEffect(effect.id, JSON.stringify(settled.failure), now)
  }
  const remaining = (await deps.store.listUnsettledEffects(mission.id)).filter(
    (e) => e.state === 'dispatched',
  )
  if (remaining.length > 0) return { kind: 'fence-pending', unsettled: remaining.length }

  const fresh = await deps.store.getMission(mission.id)
  if (fresh === null) return { kind: 'not-found' }
  if (fresh.transitionFence === 'cancel-pending') {
    const verdict = checkMissionTransition({
      from: fresh.status,
      to: 'canceled',
      fence: fresh.transitionFence,
    })
    if (!verdict.ok) return { kind: 'terminal-noop' }
    const result = await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
      status: 'canceled',
      transitionFence: 'none',
      terminalKind: 'canceled',
      terminalAt: now,
      currentActionRunId: null,
    })
    if (result.ok && fresh.mrClaimId !== null) await deps.store.releaseMr(fresh.mrClaimId, now)
    return { kind: 'fence-settled', result: 'canceled' }
  }
  // handoff-pending
  await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
    automationMode: 'tracking-only',
    transitionFence: 'none',
  })
  return { kind: 'fence-settled', result: 'tracking-only' }
}

async function publishReadiness(deps: ReconcileDeps, missionId: string): Promise<void> {
  const mission = await deps.store.getMission(missionId)
  if (mission === null || TERMINAL_STATUSES.has(mission.status)) return
  const cells = projectRowCells(mission)
  await mergeCollectedCells(deps, mission, cells)
  await projectLiveFeedbackCount(
    deps.store,
    mission,
    cells,
    await loadPolicyContent(deps.lookup, mission),
  )
  const unsettled = await deps.store.listUnsettledEffects(mission.id)
  const readiness = computeReadiness(
    readinessInputFrom(mission, unsettled, cells, await deps.store.listFeedback(mission.id)),
  )
  let projectedStatus: MissionStatus | null = null
  if (
    mission.status === 'watching' ||
    mission.status === 'waiting-committer' ||
    mission.status === 'ready-to-merge'
  ) {
    const candidate = readiness.status === 'working' ? 'watching' : readiness.status
    if (candidate !== mission.status) {
      const verdict = checkMissionTransition({
        from: mission.status,
        to: candidate,
        fence: mission.transitionFence,
      })
      if (verdict.ok) projectedStatus = candidate
    }
  }
  await deps.store.occUpdate(mission.id, mission.revision, mission.epoch, {
    readinessJson: canonicalStringify(readiness),
    ...(projectedStatus === null ? {} : { status: projectedStatus }),
  })
}

export async function runMissionReconcile(
  deps: ReconcileDeps,
  missionId: string,
): Promise<ReconcileOutcome> {
  const mission = await deps.store.getMission(missionId)
  if (mission === null) return { kind: 'not-found' }
  const now = deps.now()

  if (TERMINAL_STATUSES.has(mission.status)) {
    const hints = await deps.store.consumeWakeHints(mission.id, now)
    // T81（design §10.4）：终态**不逆转**，但外部把已关闭的 MR 重新打开时要另建
    // 一条带链接的后继去接管它。只在真的收到投递（wake hint）时探一次——终态
    // Mission 只增不减，每轮 sweep 都对 code host 探一次的话，成本随历史线性增长
    // 而收益为零。
    if (hints > 0 && mission.terminalKind === 'closed-unmerged') {
      const reopened = await reopenClosedMission(
        { store: deps.store, ports: deps.ports, now: deps.now },
        mission,
      )
      if (reopened.kind === 'created') {
        return { kind: 'mission-reopened', successorMissionId: reopened.missionId }
      }
    }
    return { kind: 'terminal-noop' }
  }
  if (mission.transitionFence !== 'none') {
    const outcome = await settleFence(deps, mission)
    return outcome
  }

  const consumedWakeHints = await deps.store.consumeWakeHints(mission.id, now)

  // ---- PR-4：进行中 Agent action 的结果收取（guards 之前——active-action
  // guard 会 wait，收取必须先于它；pending 则落回正常流程）。 ----------------
  if (mission.currentActionRunId !== null) {
    const collected = await collectAgentAttempt(deps, mission)
    if (collected.kind !== 'no-op' && collected.kind !== 'still-running') {
      if (collected.kind === 'action-collected' || collected.kind === 'action-failed') {
        await settlePlaybookAction(deps, collected.actionRunId, collected)
      }
      return { kind: 'action-collect', result: collected }
    }
  }

  // ---- facts 组装 -----------------------------------------------------------
  const cells = projectRowCells(mission)
  await mergeCollectedCells(deps, mission, cells)
  if (deps.ports.playbookSaga !== undefined) {
    cells['__playbook.sagaDigest'] = {
      state: 'known',
      value: await deps.ports.playbookSaga.sagaDigest(mission.id),
      sourceRevision: 'playbook-saga',
    }
  }
  const policy = await loadPolicyContent(deps.lookup, mission)

  // ---- T109 抓出：mr.unhandledFeedbackCount 的事实源是台账，不是 collect 的
  // 时点快照。apply validated 后行已 selected/addressed，但 cells 里的 count
  // 仍是采集时的旧值——规则会用陈旧计数重复发射 feedback.apply 直到 budget
  // 耗尽。claim 存在且 MR facts 已采过时按台账现算覆盖（与 collect 投影同一
  // 算法 selectableFeedback，两处必然一致）。必须先于 buildFactSnapshot——
  // snapshot 定格后的覆盖进不了决策输入。
  await projectLiveFeedbackCount(deps.store, mission, cells, policy)

  // Make an external invalidation part of the audited decision input. Merely
  // swapping the selected decision below is insufficient: decisionInputDigest
  // dedupes before the arm runs, so a wake against an otherwise identical
  // snapshot would still collapse into the preceding wait decision.
  if (consumedWakeHints > 0 && mission.mrClaimId !== null) {
    cells['__wake.mrFactsInvalidatedAt'] = {
      state: 'known',
      value: String(now),
      sourceRevision: `wake-hints:${consumedWakeHints}`,
    }
  }

  const unsettled = await deps.store.listUnsettledEffects(mission.id)
  const snapshot: MissionFactSnapshot = buildFactSnapshot({
    missionRevision: mission.revision,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cells,
  })

  // ---- guards + rules -------------------------------------------------------
  // 发布链的 effect（commit/push/mr-ensure）由链自身按 idempotencyKey 撞回重放
  // 结算，不进 effect-unsettled guard（否则悬挂行会让 guard 永久 wait）。
  const guards = projectGuards(
    mission,
    unsettled.filter(
      (e) =>
        !DELIVERY_EFFECT_KINDS.has(e.effectKind) &&
        !PIPELINE_EFFECT_KINDS.has(e.effectKind) &&
        !MR_CARE_EFFECT_KINDS.has(e.effectKind),
    ),
    cells,
  )
  if (policy === null) {
    return await commitAndHandle(deps, mission, snapshot, guards, {
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

  // The feedback prompt freezes exact provider text for one selectable batch.
  // After that batch settles, the live ledger can expose the next batch while
  // the old prompt still names only the previous revisions. Refresh MR facts
  // before launching so Agent input never drifts from the selected ledger rows.
  if (selected.kind === 'run-agent-action' && selected.capabilityId === 'mr.feedback.apply') {
    const selectedRows = selectableFeedback(
      await deps.store.listFeedback(mission.id),
      policy.feedback,
    )
    const promptCell = cells[MR_FEEDBACK_INPUT_CELL]
    const prompt = readFeedbackPromptSnapshot(
      cells,
      selectedRows.map((row) => ({ threadRef: row.threadRef, revision: row.revision })),
    )
    if (
      selectedRows.length > 0 &&
      prompt === null &&
      (promptCell === undefined || promptCell.state !== 'unknown' || promptCell.collectable)
    ) {
      selected = { kind: 'collect-mr-facts' }
    }
  }

  // ---- mr fact 前置引用翻译（PR-10 T109 抓出）------------------------------
  // policy 规则在 MR 存在之前引用 mr.* fact 时，引擎按 indeterminate 停机派
  // collect-mr-facts（引擎纯层不知道 claim）。此时采集不可执行——若放行到
  // arm 只能 blocked，而 blocked 是执行结果不进决策输入，下一轮同 digest 直接
  // deduped：mission 永久卡死。在 redispatch 之前把它翻译成 block 静止态，
  // delivery 链照常接管发布进度，MR ensure 之后规则自然恢复可判。
  if (selected.kind === 'collect-mr-facts' && mission.mrClaimId === null) {
    selected = { kind: 'block', reason: 'mr-facts-unavailable:no-mr-claim' }
  }

  // A webhook/manual wake is an invalidation signal, not merely a request to
  // rerun the same decision over the same still-fresh snapshot. Without this
  // translation a review comment arriving inside MR_FACTS_STALE_MS consumes
  // its durable hint, reproduces the previous wait decision, and is then lost
  // until another unrelated event happens. Only replace a rule-level block:
  // an already selected action and fixed-guard waits keep their priority.
  if (consumedWakeHints > 0 && mission.mrClaimId !== null && selected.kind === 'block') {
    selected = { kind: 'collect-mr-facts' }
  }

  // ---- requirement 重派（PR-3 T33/T38a）------------------------------------
  // evaluatePolicy 的 COLLECT_BY_GROUP 对 requirement 组注明「交由上层重派」：
  // 规则读 requirement fact 撞 indeterminate 时这里按 sourceKind 派
  // materialize/collect；澄清闭环（问题集 pending / 已发布待答）是 closed
  // 平台步骤，优先于动作规则的选择。
  selected = redispatchRequirement(mission, cells, selected)

  // ---- no-change 收束重派（PR-5 T55a）--------------------------------------
  // §8.2 尾段：analyze already-satisfied-candidate / implement no-change 且尚
  // 无 MR 时，按 policy 打开 no-change-confirmation human gate；只有 receipt
  // 才能进入 completed-no-change。upload plan 有 created/replaced entry 时
  // 不许以 no-change 跳过 seed（gate 不开，正常链继续把 seed 送发布）。
  selected = await redispatchNoChangeGate(deps, mission, cells, policy, selected)

  // ---- candidate 发布链重派（PR-5 T56/T57/T59）------------------------------
  // candidate 已派生且规则无话可说时，依 `__delivery.*` 进度派 verification →
  // commit/push → ensure-MR；MR 建立后 block 改写为诚实 wait（MR care 属 PR-7）。
  selected = redispatchDelivery(mission, cells, policy, selected)

  // ---- MR care 链重派（PR-7 T76）--------------------------------------------
  // facts 新鲜度 → reply 派发 → feedback 规则放行 → readiness 推进；terminal
  // 由 fixed guard 兜。链序 delivery → care → pipeline：care 先保 facts 新鲜
  // （__mr.headSha 是 pipeline stale 判定的锚）。
  selected = await redispatchMrCare(deps, mission, cells, policy, selected, { now })

  // ---- pipeline evidence 链重派（PR-6 T68）---------------------------------
  // MR 建立后接管发布链落下的静止态：collect（两次 head fence）→ trigger/
  // rerun（effect 台账）→ 全过放行 readiness；「在跑」诚实 wait。
  selected = redispatchPipeline(mission, cells, policy, selected, {
    now,
    manifest: loadPipelineManifest(deps, cells),
  })

  // Published business steps are a deterministic overlay after the platform
  // chains have derived all exact inputs. They may run only when every fixed
  // guard passed; terminal/fence/active-action/authority waits remain supreme.
  if (evaluation.guardTrace.every((node) => node.outcome === 'pass')) {
    const playbookDecision = await selectPlaybookStepDecision(deps, mission, snapshot)
    if (playbookDecision !== null) selected = playbookDecision
  }

  return await commitAndHandle(deps, mission, snapshot, guards, { ...evaluation, selected })
}

async function redispatchNoChangeGate(
  deps: ReconcileDeps,
  mission: MissionRow,
  cells: Readonly<Record<string, FactCell<FactCellValue>>>,
  policy: AutomationPolicyContent,
  selected: NextDecision,
): Promise<NextDecision> {
  if (selected.kind !== 'block') return selected
  if (mission.mrClaimId !== null) return selected
  if (policy.requirement.noChangeConfirmation !== 'human-confirmation') return selected
  const scope = knownString(cells, 'requirement.scopeDisposition')
  const lastOutcome = knownString(cells, 'action.lastOutcome')
  const noChangeShape = scope === 'already-satisfied-candidate' || lastOutcome === 'no-change'
  if (!noChangeShape) return selected
  // gate 已挂起（等确认命令）时不重复派。
  if (knownString(cells, '__gate.pendingHumanDecision') === 'no-change-confirmation') {
    return selected
  }
  if (mission.uploadPlanRef !== null) {
    const plan = (await deps.ports.uploadPlanReader?.read(mission.uploadPlanRef)) ?? null
    // plan 不可读 = 保守不开 gate（indeterminate 语义：宁可停在原 block）。
    if (plan === null) return selected
    if (plan.entries.some((entry) => entry.disposition !== 'already-present')) return selected
  }
  return { kind: 'request-human-decision', gate: 'no-change-confirmation' }
}

function knownString(
  cells: Readonly<Record<string, FactCell<FactCellValue>>>,
  id: string,
): string | null {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' && typeof cell.value === 'string'
    ? cell.value
    : null
}

function knownNumber(
  cells: Readonly<Record<string, FactCell<FactCellValue>>>,
  id: string,
): number | null {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' && typeof cell.value === 'number'
    ? cell.value
    : null
}

function adapterBindingRefOf(mission: MissionRow): string | null {
  return mission.resolvedAdapterId !== null && mission.resolvedAdapterRevision !== null
    ? `${mission.resolvedAdapterId}@${mission.resolvedAdapterRevision}`
    : null
}

function redispatchRequirement(
  mission: MissionRow,
  cells: Record<string, FactCell<FactCellValue>>,
  selected: NextDecision,
): NextDecision {
  // 1) 澄清闭环：pending 问题集 / 已发布待答优先于 block 与新动作（未澄清的
  //    需求不该起 writable 动作）；guard 产生的 wait/terminal/collect 不动。
  if (selected.kind === 'block' || selected.kind === 'run-agent-action') {
    const pendingQuestionSetRef = knownString(cells, '__requirement.pendingQuestionSetRef')
    const clarificationState = knownString(cells, 'requirement.clarificationState')
    const channel = knownString(cells, '__requirement.questionChannel')
    if (pendingQuestionSetRef !== null && clarificationState === 'none') {
      return {
        kind: 'publish-requirement-questions',
        questionSetRef: pendingQuestionSetRef,
        channel: channel === 'requirement-source' ? 'requirement-source' : 'platform',
      }
    }
    if (pendingQuestionSetRef !== null && clarificationState === 'questions-published') {
      if (channel === 'platform') {
        // 平台渠道等人答（submitMissionAnswers 命令收口）；不是故障，不 block。
        return {
          kind: 'wait',
          reason: 'awaiting-platform-answers',
          resumeAt: null,
          wakeSources: ['manual', 'requirement'],
          attemptOrdinal: 0,
        }
      }
      const binding = adapterBindingRefOf(mission)
      if (binding === null) return { kind: 'block', reason: 'requirement-adapter-unresolved' }
      return {
        kind: 'collect-requirement-answers',
        questionSetRef: pendingQuestionSetRef,
        adapterBindingRef: binding,
      }
    }
  }
  // 2) 取件重派：requirement fact indeterminate 且 bundle 尚未物化。
  if (selected.kind !== 'block' || !selected.reason.startsWith('fact-unavailable:requirement.')) {
    return selected
  }
  const bundleCell = cells['requirement.bundleComplete']
  if (bundleCell !== undefined && bundleCell.state === 'known') return selected
  if (mission.sourceKind === 'direct') {
    return mission.sourceContentDigest !== null
      ? { kind: 'materialize-direct-requirement', submissionRef: mission.sourceContentDigest }
      : { kind: 'block', reason: 'direct-submission-digest-missing' }
  }
  const binding = adapterBindingRefOf(mission)
  return binding !== null
    ? { kind: 'collect-external-requirement', adapterBindingRef: binding }
    : { kind: 'block', reason: 'requirement-adapter-unresolved' }
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
  guards: FixedGuardInput,
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
  // guards 必须一并入键（2026-08-18 journey 实红修复，rfc310-pr3-journey
  // body+file 用例锁定）：placement/effect/fence/action 只改 mission 行不改
  // cells——只按 cells 去重会把 guard 面变化后的新决策误吞（实测 placement
  // 翻 uploadSeed pending→seeded 后 mission 永久 deduped 卡 working）。
  const decisionInputDigest = canonicalDigest({
    cellsDigest: canonicalDigest(snapshot.cells),
    guards,
    policyId: mission.policyId,
    policyRevision: mission.policyRevision,
    employeeId: mission.employeeId,
    employeeRevision: mission.employeeRevision,
  })

  const snapshotId = ulid()
  const decisionId = ulid()
  const inserted = await deps.store.commitFactSnapshotAndDecision({
    snapshot: {
      id: snapshotId,
      missionId: mission.id,
      missionRevision: mission.revision,
      capturedAt: snapshot.capturedAt,
      cellsJson: canonicalStringify(snapshot.cells),
      refsJson: canonicalStringify({}),
      digest: snapshot.digest,
      now,
    },
    decision: {
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
    },
  })
  if (!inserted.created) {
    // T83 crash matrix 抓出的恢复缺陷：链自治 effect（commit/push/mr-ensure/
    // trigger/rerun/reply）在 dispatched 悬挂时，cells/guards 都没变 ⇒ 决策被
    // 去重吞 ⇒ handler 永不重放 ⇒ 卡死。悬挂自治 effect 存在时照常执行
    // handler——重放按 idempotencyKey 撞回同一行、intent digest 对拍后幂等。
    const hangingSelfSettled = (await deps.store.listUnsettledEffects(mission.id)).some(
      (e) =>
        e.state === 'dispatched' &&
        (DELIVERY_EFFECT_KINDS.has(e.effectKind) ||
          PIPELINE_EFFECT_KINDS.has(e.effectKind) ||
          MR_CARE_EFFECT_KINDS.has(e.effectKind)),
    )
    if (!hangingSelfSettled) {
      await publishReadiness(deps, mission.id)
      return { kind: 'deduped', decisionId: inserted.decisionId }
    }
  }

  const handled = await handleDecision(deps, mission, snapshot, selected, inserted.decisionId)
  await settlePlaybookDecision(deps, selected, inserted.decisionId, handled)
  await publishReadiness(deps, mission.id)
  return { kind: 'decided', decisionId: inserted.decisionId, selected, handled }
}

/**
 * RFC-310 —— `step-failed:<stepId>:<code>` 这类 block 的**人读细节**。
 *
 * 决策本体只带 reason 串（它是 canonical decision trace 的一部分，不能塞自由文本），
 * 而 mission 行的 `blockDetail` 正是给人看的那一栏。少了它，界面上只有一个
 * `agent-contract-exhausted` —— 运维（和排查 CI 的人）无从下手：真正的话在 attempt
 * 失败回执的 `remediation` 里（例如 "opencode exited with code 2"）。T140 的 windows
 * 腿就是因此定位不了。这里按 reason 反查那次失败的 step run → action run → 回执。
 */
/**
 * `blockDetail` 里 remediation 的长度上限。
 *
 * 原值 500 是 2026-08-20 windows 那轮**白跑一次 CI** 的直接原因：runtime 崩溃的回执是
 * `opencode exited with code 1; stderr tail: …`，而 500 字头部只够放下前缀 + 一小截
 * stderr——真正的 `error: <message>` 正好落在窗口外，拿到手的 blockDetail 全是压缩源码
 * 碎片。同一模块里 rejection 明细的上限本来就是 4000（agentActionOrchestrator.ts），
 * 500 才是这里的异类。放宽到 2000：够装一条崩溃栈，仍远小于把日志整篇灌进 UI。
 */
export const MAX_STEP_FAILURE_DETAIL_CHARS = 2_000

export async function stepFailureDetail(
  deps: ReconcileDeps,
  missionId: string,
  reason: string,
): Promise<string | null> {
  // 用正则而不是 split/join：failureCode 本身可能含 `:`（如 `step-failed:s:a:b`），
  // 而 `.join(':')` 会被 RFC-254 的平台面守卫当成 PATH 列表拼接（Windows 上 `:` 是
  // 盘符分隔符）—— 这里拼的是决策 reason，不是路径，索性不用那个形状。
  const match = /^step-failed:([^:]+):(.+)$/.exec(reason)
  if (match === null) return null
  const stepId = match[1]!
  const failureCode = match[2]!
  const runs =
    deps.ports.playbookSaga === undefined
      ? []
      : await deps.ports.playbookSaga.listStepRuns(missionId)
  const failed = [...runs]
    .reverse()
    .find((run) => run.stepId === stepId && run.failureCode === failureCode)
  if (failed === undefined || failed.actionRunId === null) return null
  const actionRun = await deps.store.getActionRun(failed.actionRunId)
  if (actionRun === null || actionRun.failureJson === null) return null
  let parsed: { remediation?: unknown }
  try {
    parsed = JSON.parse(actionRun.failureJson) as { remediation?: unknown }
  } catch {
    return null
  }
  const remediation = typeof parsed.remediation === 'string' ? parsed.remediation.trim() : ''
  return remediation === '' ? null : remediation.slice(0, MAX_STEP_FAILURE_DETAIL_CHARS)
}

async function blockMission(
  deps: ReconcileDeps,
  missionId: string,
  code: string,
  detail: string | null,
): Promise<void> {
  const mission = await deps.store.getMission(missionId)
  if (mission === null) return
  const verdict = checkMissionTransition({
    from: mission.status,
    to: 'blocked',
    fence: mission.transitionFence,
  })
  if (!verdict.ok) return
  await deps.store.occUpdate(mission.id, mission.revision, mission.epoch, {
    status: 'blocked',
    blockCode: code,
    blockDetail: detail,
    currentActionRunId: null,
  })
}

/**
 * requirement cells 的落盘通道：与既有 requirement 快照合并 → 新快照 →
 * requirementBundleRef 指向它（mergeCollectedCells 下一轮读回）。失败重试的
 * attempt ordinal 也走这里——cells 变化 ⇒ decisionInputDigest 变化 ⇒ retry
 * 后不会被去重卡死（facts 不变则去重是设计行为）。
 */
async function persistRequirementCells(
  deps: ReconcileDeps,
  missionId: string,
  patch: Record<string, FactCell<FactCellValue>>,
  refs: unknown,
): Promise<void> {
  const mission = await deps.store.getMission(missionId)
  if (mission === null) return
  const base =
    mission.requirementBundleRef === null
      ? {}
      : ((await deps.snapshots.getCells(mission.requirementBundleRef)) ?? {})
  const merged = { ...base, ...patch }
  const now = deps.now()
  const snapshotId = ulid()
  await deps.store.insertFactSnapshot({
    id: snapshotId,
    missionId,
    missionRevision: mission.revision,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(merged),
    refsJson: canonicalStringify(refs),
    digest: canonicalDigest(merged),
    now,
  })
  await deps.store.occUpdate(mission.id, mission.revision, mission.epoch, {
    requirementBundleRef: snapshotId,
  })
}

/** pipeline.repair 的 launch 附件：pinned bundle 描述 + failing gate 的 issue 闭集。 */
function pipelineRepairInputs(
  deps: ReconcileDeps,
  cells: Readonly<Record<string, FactCell<FactCellValue>>>,
): {
  pipelineBundle?: {
    readonly bundleId: string
    readonly manifestDigest: string
    readonly fileCount: number
    readonly totalBytes: number
  }
  pipelineIssueRefs?: readonly string[]
} {
  const manifestRef = knownString(cells, '__pipeline.manifestRef')
  if (manifestRef === null || deps.ports.attemptContext === undefined) return {}
  const raw = deps.ports.attemptContext.load(manifestRef)
  if (raw === null) return {}
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return {}
  }
  const parsed = pipelineEvidenceManifestV1Schema.safeParse(parsedJson)
  if (!parsed.success) return {}
  const manifest = parsed.data
  const issueRefs = manifest.gates
    .filter(
      (gate) =>
        gate.required &&
        !gateCountsAsPass(gate.status) &&
        gate.status !== 'queued' &&
        gate.status !== 'running',
    )
    .map((gate) => `${gate.gateKey}#${gate.runRef}`)
  return {
    pipelineBundle: {
      bundleId: manifest.bundleId,
      manifestDigest: manifest.manifestDigest,
      fileCount: manifest.totals.files,
      totalBytes: manifest.totals.bytes,
    },
    pipelineIssueRefs: issueRefs,
  }
}

function deliveryDeps(deps: ReconcileDeps): DeliveryChainDeps {
  return {
    store: deps.store,
    ports: deps.ports,
    now: deps.now,
    persistCells: (missionId, patch, refs) => persistRequirementCells(deps, missionId, patch, refs),
    block: (missionId, code, detail) => blockMission(deps, missionId, code, detail),
  }
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
      // PR-7 T81（§10.4）：终态结算——在途 Agent action 先撤销（cancel 尽力 +
      // attempt discarded + run failed），upload fulfillment 按 publication
      // receipt 如实定格（unfulfilled 不是 success，只是生命周期被外部截断）。
      if (mission.currentActionRunId !== null) {
        await invalidateInFlightAction(
          { store: deps.store, ports: deps.ports, now: deps.now },
          mission,
          'input-invalidated',
        )
      }
      const uploadFulfillment =
        mission.uploadPlanRef === null
          ? null
          : mission.uploadPublicationRef !== null
            ? 'fulfilled'
            : 'unfulfilled'
      const fresh = await deps.store.getMission(mission.id)
      if (fresh === null) return 'blocked'
      const result = await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
        status: to,
        terminalKind: selected.terminal,
        terminalAt: now,
        currentActionRunId: null,
        terminalUploadFulfillment: uploadFulfillment,
      })
      if (result.ok && mission.mrClaimId !== null)
        await deps.store.releaseMr(mission.mrClaimId, now)
      return 'terminal'
    }
    case 'block': {
      await blockMission(
        deps,
        mission.id,
        selected.reason,
        await stepFailureDetail(deps, mission.id, selected.reason),
      )
      return 'blocked'
    }
    case 'wait': {
      const existing = await deps.store.getWake(mission.id, decisionId)
      if (existing === null) {
        await deps.store.armWake({
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
        await blockMission(deps, mission.id, 'collector-not-wired:repository', null)
        return 'blocked'
      }
      const collected = await collector.collect({
        missionId: mission.id,
        repositoryId: mission.repositoryId,
      })
      const snapshotId = ulid()
      await deps.store.insertFactSnapshot({
        id: snapshotId,
        missionId: mission.id,
        missionRevision: mission.revision,
        capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
        cellsJson: canonicalStringify(collected.cells),
        refsJson: canonicalStringify({ kind: 'repository', factsRef: collected.factsRef }),
        digest: canonicalDigest(collected.cells),
        now,
      })
      const fresh = await deps.store.getMission(mission.id)
      if (fresh !== null) {
        await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
          repositoryFactsRef: snapshotId,
        })
      }
      return 'collected'
    }
    case 'collect-mr-facts': {
      const collector = deps.ports.mergeRequestFacts
      if (collector === undefined) {
        await blockMission(deps, mission.id, 'collector-not-wired:merge-request', null)
        return 'blocked'
      }
      // T109 抓出的健壮性缺陷：policy 规则在 MR 存在之前引用 mr.* fact 时，
      // 引擎按 indeterminate 停机派本 arm（正确），但此时还没有 claim——
      // loud throw 会让 mission 以未分类异常卡死。typed block 是静止态，
      // delivery 链照常接管发布进度；MR ensure 之后规则自然恢复可判。
      if (mission.mrClaimId === null) {
        await blockMission(deps, mission.id, 'mr-facts-unavailable:no-mr-claim', null)
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
          : ((await deps.snapshots.getCells(mission.repositoryFactsRef)) ?? {})
      const merged = { ...base, ...collected.cells }
      if (collected.headSha !== null) {
        merged['__mr.headSha'] = {
          state: 'known',
          value: collected.headSha,
          sourceRevision: collected.snapshotRef,
        }
      }
      // PR-7b T78：conflict repair 的 merge 方向由 (S=source head, T=target
      // head) 两端唯一确定。S 早已投影，T 此前只落 refsJson——决策面读不到，
      // repair 就无法在 launch 时冻结 exact 的合并意图。
      if (collected.targetSha !== null) {
        merged['__mr.targetSha'] = {
          state: 'known',
          value: collected.targetSha,
          sourceRevision: collected.snapshotRef,
        }
      }
      // PR-7 T73：feedback 台账联动——新 head 先 obsolete 旧 head 的未终结行，
      // 逐 thread 幂等 upsert（webhook 重放/重复采集不重复起 action），再按
      // policy 算 selectable 数投影 mr.unhandledFeedbackCount。
      if (collected.threads !== undefined && collected.headSha !== null) {
        await deps.store.obsoleteFeedbackForOtherHeads(mission.id, collected.headSha, now)
        merged[MR_UNRESOLVED_FEEDBACK_CELL] = unresolvedFeedbackCell({
          providerSnapshotRef: collected.snapshotRef,
          headSha: collected.headSha,
          threads: collected.threads,
        })
        for (const thread of collected.threads) {
          if (thread.resolved) continue
          await deps.store.upsertFeedbackObservation({
            id: ulid(),
            missionId: mission.id,
            threadRef: thread.threadRef,
            revision: thread.revision,
            headSha: collected.headSha,
            fingerprint: feedbackFingerprint({
              threadRef: thread.threadRef,
              revision: thread.revision,
              headSha: collected.headSha,
              bodyDigest: thread.bodyDigest,
            }),
            authorClass: thread.authorClass,
            now,
          })
        }
        const policyContent = await loadPolicyContent(deps.lookup, mission)
        if (policyContent !== null) {
          const selectable = selectableFeedback(
            await deps.store.listFeedback(mission.id),
            policyContent.feedback,
          )
          merged['mr.unhandledFeedbackCount'] = {
            state: 'known',
            value: selectable.length,
            sourceRevision: collected.snapshotRef,
          }
          // The old implementation persisted only bodyDigest. That proved a
          // comment existed but left mr.feedback.apply with no review text to
          // act on; the scripted T109 launcher happened to know the requested
          // edit out of band. Freeze the exact selectable revisions and their
          // bounded provider text in a hidden cell. It never enters public
          // facts or policy predicates; launch renders it as untrusted data.
          merged[MR_FEEDBACK_INPUT_CELL] = feedbackInputCell({
            providerSnapshotRef: collected.snapshotRef,
            headSha: collected.headSha,
            selected: selectable,
            threads: collected.threads.map((thread) => ({
              threadRef: thread.threadRef,
              revision: thread.revision,
              body: thread.body,
              path: thread.path,
            })),
          })
        }
      }
      const snapshotId = ulid()
      await deps.store.insertFactSnapshot({
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
      const fresh = await deps.store.getMission(mission.id)
      if (fresh !== null) {
        await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
          repositoryFactsRef: snapshotId,
        })
      }
      return 'collected'
    }
    case 'seed-repository-uploads': {
      const placement = deps.ports.uploadPlacement
      if (placement === undefined) {
        await blockMission(deps, mission.id, 'placement-not-wired', null)
        return 'blocked'
      }
      const placed = await placement.place({
        missionId: mission.id,
        uploadPlanRef: selected.uploadPlanRef,
      })
      if (!placed.ok) {
        await blockMission(deps, mission.id, `placement-failed:${placed.failure.code}`, null)
        return 'blocked'
      }
      const fresh = await deps.store.getMission(mission.id)
      if (fresh !== null) {
        await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
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
      const created = await deps.store.createActionRun({
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
        await blockMission(deps, mission.id, created.code, null)
        return 'blocked'
      }
      {
        const fresh = await deps.store.getMission(mission.id)
        if (fresh !== null) {
          await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
            currentActionRunId: actionRunId,
          })
        }
      }
      // PR-4：完整 attempt 编排（workspace 物化 → manifest/nonce/prompt →
      // launcher → 台账；失败一律 typed block，端口缺席细分 *-not-wired）。
      const launchOutcome = await launchAgentAttempt(deps, mission, {
        actionRunId,
        capabilityId: selected.capabilityId,
        templateId: template.id,
        templateRevision: template.revision,
        rerunSeq: 0,
        factsSummary: publicFactsSummary(snapshot.cells),
        ...((): { candidateRef?: string } => {
          const cell = snapshot.cells['__action.candidateRef']
          return cell !== undefined && cell.state === 'known' && typeof cell.value === 'string'
            ? { candidateRef: cell.value }
            : {}
        })(),
        // T109：post-publish 修复轮以已发布 durable commit 为基线（fast-forward
        // 推回 MR 分支的 parent 前提）；未发布过则缺省首轮语义。
        ...((): { publishedBaselineSha?: string } => {
          const pushed = snapshot.cells['__delivery.publishState']
          const sha = snapshot.cells['__delivery.commitSha']
          return pushed !== undefined &&
            pushed.state === 'known' &&
            pushed.value === 'pushed' &&
            sha !== undefined &&
            sha.state === 'known' &&
            typeof sha.value === 'string'
            ? { publishedBaselineSha: sha.value }
            : {}
        })(),
        // PR-6 T69：repair 动作挂 pinned pipeline bundle + issue 闭集（新
        // commit 产生新 head 后 collect 会覆盖 cells，旧 evidence 自然失效）。
        ...(selected.capabilityId === 'pipeline.repair'
          ? pipelineRepairInputs(deps, snapshot.cells)
          : {}),
        // PR-7b T78：conflict repair 的 exact 合并两端。缺任一端不猜——
        // launch 会以 conflict-heads-unavailable 诚实停住，由 MR facts 重采补齐。
        ...((): { conflictInput?: { sourceSha: string; targetSha: string } } => {
          if (definition.workspaceMode !== 'edit-conflicts') return {}
          const source = knownString(snapshot.cells, '__mr.headSha')
          const target = knownString(snapshot.cells, '__mr.targetSha')
          return source === null || target === null
            ? {}
            : { conflictInput: { sourceSha: source, targetSha: target } }
        })(),
        ...(selected.problemInput === undefined ? {} : { problemInput: selected.problemInput }),
        ...(selected.approvalInput === undefined ? {} : { approvalInput: selected.approvalInput }),
        ...(selected.retryBudget === undefined ? {} : { retryBudget: selected.retryBudget }),
        // PR-7 T74：feedback apply 的 (threadRef,revision) 闭集——selectable 行
        // 标 selected 并冻结进 manifest.feedbackSnapshot（validator 双射对拍）。
        ...(await (async (): Promise<{
          feedbackSnapshot?: {
            readonly snapshotRef: string
            readonly items: readonly FeedbackPromptItem[]
          }
        }> => {
          if (selected.capabilityId !== 'mr.feedback.apply') return {}
          const feedbackPolicy = await loadPolicyContent(deps.lookup, mission)
          if (feedbackPolicy === null) return {}
          const selectable = selectableFeedback(
            await deps.store.listFeedback(mission.id),
            feedbackPolicy.feedback,
          )
          const promptSnapshot = readFeedbackPromptSnapshot(snapshot.cells, selectable)
          // Missing/mismatched bodies are a hard input boundary. Do not mark
          // ledger rows selected; launchAgentAttempt will return the typed
          // feedback-snapshot-content-missing block and a later recollect can
          // repair the input without orphaning the feedback rows.
          if (promptSnapshot === null) return {}
          const selectedRefs = await prepareFeedbackSelection(
            { store: deps.store, now: deps.now },
            mission,
            feedbackPolicy,
            actionRunId,
          )
          if (selectedRefs.length === 0) return {}
          const byRef = new Map(
            promptSnapshot.items.map((item) => [`${item.threadRef}\u0000${item.revision}`, item]),
          )
          const items = selectedRefs.map((item) =>
            byRef.get(`${item.threadRef}\u0000${item.revision}`),
          )
          if (items.some((item) => item === undefined)) return {}
          return {
            feedbackSnapshot: {
              snapshotRef: promptSnapshot.snapshotRef,
              items: items as FeedbackPromptItem[],
            },
          }
        })()),
      })
      if (!launchOutcome.ok) {
        if (selected.capabilityId === 'mr.feedback.apply') {
          await releaseFeedbackSelection(
            { store: deps.store, now: deps.now },
            mission.id,
            actionRunId,
          )
        }
        await deps.store.settleActionRun({
          id: actionRunId,
          status: 'failed',
          resultRef: null,
          failureJson: JSON.stringify({
            category: 'configuration',
            code: launchOutcome.blockCode,
            retryability: 'after-configuration',
            attemptOrdinal: 0,
            remediation: launchOutcome.detail ?? launchOutcome.blockCode,
            evidenceRef: null,
          }),
          now,
        })
        {
          const fresh = await deps.store.getMission(mission.id)
          if (fresh !== null && fresh.currentActionRunId === actionRunId) {
            await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
              currentActionRunId: null,
            })
          }
        }
        await blockMission(deps, mission.id, launchOutcome.blockCode, launchOutcome.detail)
        return 'action-launch-failed'
      }
      return 'action-launched'
    }
    case 'publish-readiness': {
      // commitAndHandle 尾部统一重算 readinessJson + 业务状态。单一投影点
      // 同时覆盖显式 publish-readiness、pipeline wait 和 webhook invalidation。
      return 'readiness-published'
    }
    // ---- requirement 取件/物化（PR-3 T33/T35）--------------------------------
    case 'materialize-direct-requirement':
    case 'collect-external-requirement': {
      const port = deps.ports.requirementMaterialize
      if (port === undefined) {
        await blockMission(deps, mission.id, 'requirement-port-not-wired', null)
        return 'blocked'
      }
      const attempts = (knownNumber(snapshot.cells, '__requirement.acquireAttempts') ?? 0) + 1
      const failed = async (code: string, remediation: string): Promise<'blocked'> => {
        await persistRequirementCells(
          deps,
          mission.id,
          {
            '__requirement.acquireAttempts': knownCell(attempts),
            '__requirement.lastAcquireFailure': knownCell(code),
          },
          { kind: 'requirement-failure', code },
        )
        await blockMission(deps, mission.id, `requirement-acquire-failed:${code}`, remediation)
        return 'blocked'
      }
      let bundle: {
        bundleRef: string
        manifestDigest: string
        fileCount: number
        totalBytes: number
        sourceRevision: string
        complete: boolean
      }
      if (selected.kind === 'materialize-direct-requirement') {
        const out = await port.materializeDirect({
          missionId: mission.id,
          submissionRef: selected.submissionRef,
        })
        if (!out.ok) return await failed(out.failure.code, out.failure.remediation)
        bundle = { ...out, complete: true }
      } else {
        if (mission.externalId === null)
          return await failed('external-id-missing', 'mission has no external id')
        const out = await port.acquireExternal({
          missionId: mission.id,
          adapterBindingRef: selected.adapterBindingRef,
          externalId: mission.externalId,
        })
        if (!out.ok) return await failed(out.failure.code, out.failure.remediation)
        bundle = out
      }
      await deps.store.insertMissionSource({
        id: ulid(),
        missionId: mission.id,
        generation: (await deps.store.listMissionSources(mission.id)).length + 1,
        sourceKind:
          selected.kind === 'materialize-direct-requirement' ? 'direct' : 'external-reference',
        externalId: mission.externalId,
        adapterId: mission.resolvedAdapterId,
        adapterRevision: mission.resolvedAdapterRevision,
        sourceRevision: bundle.sourceRevision,
        bundleRef: bundle.bundleRef,
        manifestDigest: bundle.manifestDigest,
        fileCount: bundle.fileCount,
        totalBytes: bundle.totalBytes,
        state: 'materialized',
        createdAt: now,
      })
      await persistRequirementCells(
        deps,
        mission.id,
        {
          'requirement.bundleComplete': knownCell(bundle.complete),
          'requirement.clarificationState': knownCell('none'),
        },
        { kind: 'requirement', bundleRef: bundle.bundleRef, manifestDigest: bundle.manifestDigest },
      )
      return 'collected'
    }
    // ---- 澄清闭环（PR-3 T38a）------------------------------------------------
    case 'publish-requirement-questions': {
      const port = deps.ports.requirementMaterialize
      if (port === undefined) {
        await blockMission(deps, mission.id, 'requirement-port-not-wired', null)
        return 'blocked'
      }
      const binding = adapterBindingRefOf(mission)
      if (selected.channel === 'requirement-source' && binding === null) {
        await blockMission(deps, mission.id, 'requirement-adapter-unresolved', null)
        return 'blocked'
      }
      const out = await port.publishQuestions({
        missionId: mission.id,
        questionSetRef: selected.questionSetRef,
        channel: selected.channel,
        adapterBindingRef: selected.channel === 'requirement-source' ? binding : null,
      })
      if (!out.ok) {
        const attempts = (knownNumber(snapshot.cells, '__requirement.publishAttempts') ?? 0) + 1
        await persistRequirementCells(
          deps,
          mission.id,
          { '__requirement.publishAttempts': knownCell(attempts) },
          { kind: 'requirement-questions-failure', code: out.failure.code },
        )
        await blockMission(
          deps,
          mission.id,
          `requirement-questions-failed:${out.failure.code}`,
          out.failure.remediation,
        )
        return 'blocked'
      }
      await persistRequirementCells(
        deps,
        mission.id,
        {
          'requirement.clarificationState': knownCell('questions-published'),
          '__requirement.questionCorrelationRef': knownCell(out.correlationRef),
        },
        {
          kind: 'requirement-questions',
          questionSetRef: selected.questionSetRef,
          correlationRef: out.correlationRef,
        },
      )
      if (selected.channel === 'platform') {
        const fresh = await deps.store.getMission(mission.id)
        if (fresh !== null && fresh.status !== 'awaiting-information') {
          const verdict = checkMissionTransition({
            from: fresh.status,
            to: 'awaiting-information',
            fence: fresh.transitionFence,
          })
          if (verdict.ok) {
            await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
              status: 'awaiting-information',
            })
          }
        }
      }
      return 'collected'
    }
    case 'collect-requirement-answers': {
      const port = deps.ports.requirementMaterialize
      if (port === undefined) {
        await blockMission(deps, mission.id, 'requirement-port-not-wired', null)
        return 'blocked'
      }
      const correlationRef = knownString(snapshot.cells, '__requirement.questionCorrelationRef')
      if (correlationRef === null) {
        await blockMission(deps, mission.id, 'question-correlation-missing', null)
        return 'blocked'
      }
      const out = await port.collectAnswers({
        missionId: mission.id,
        questionSetRef: selected.questionSetRef,
        adapterBindingRef: selected.adapterBindingRef,
        correlationRef,
      })
      if (!out.ok) {
        const attempts = (knownNumber(snapshot.cells, '__requirement.answerPolls') ?? 0) + 1
        await persistRequirementCells(
          deps,
          mission.id,
          { '__requirement.answerPolls': knownCell(attempts) },
          { kind: 'requirement-answers-failure', code: out.failure.code },
        )
        await blockMission(
          deps,
          mission.id,
          `requirement-answers-failed:${out.failure.code}`,
          out.failure.remediation,
        )
        return 'blocked'
      }
      if (!out.complete) {
        // 常态轮询未齐：poll ordinal 落 cells（新 digest ⇒ 下轮新 decision 再收），
        // durable wake 兜底 timer 唤醒；early 唤醒不清零 ordinal（deferredWake 语义）。
        const polls = (knownNumber(snapshot.cells, '__requirement.answerPolls') ?? 0) + 1
        await persistRequirementCells(
          deps,
          mission.id,
          { '__requirement.answerPolls': knownCell(polls) },
          { kind: 'requirement-answers-pending', poll: polls },
        )
        if ((await deps.store.getWake(mission.id, decisionId)) === null) {
          await deps.store.armWake({
            id: ulid(),
            missionId: mission.id,
            decisionId,
            reason: 'requirement-answers-pending',
            resumeAt:
              now +
              (backoffDelayMs(DEFAULT_TRANSIENT_BACKOFF, polls - 1) ??
                DEFAULT_TRANSIENT_BACKOFF.maxMs),
            wakeSources: ['requirement', 'timer'],
            attemptOrdinal: polls,
            now,
          })
        }
        return 'wake-armed'
      }
      // PR-5 T55：原渠道答案收齐 = 新 answer revision——in-flight 动作输入
      // 过期，先失效（cancel 尽力 + discarded + run failed）再落 cells。
      await invalidateInFlightAction(deps, mission, 'input-invalidated')
      await persistRequirementCells(
        deps,
        mission.id,
        {
          'requirement.clarificationState': knownCell('answers-committed'),
          '__requirement.answerRevision': knownCell(out.answerRevision ?? ''),
          '__requirement.answerSetRef': knownCell(out.answerSetRef ?? ''),
        },
        {
          kind: 'requirement-answers',
          questionSetRef: selected.questionSetRef,
          answerSetRef: out.answerSetRef,
          answerRevision: out.answerRevision,
        },
      )
      return 'collected'
    }
    // ---- no-change human gate（PR-5 T55a）----------------------------------
    case 'request-human-decision': {
      // 现阶段唯一 gate 形态：no-change-confirmation（decision schema 钉死）。
      // mission → awaiting-information（等人），gate 标记入 cells；确认走
      // confirmNoChange 命令（唯一能进入 completed-no-change 的通道）。
      await persistRequirementCells(
        deps,
        mission.id,
        { '__gate.pendingHumanDecision': knownCell('no-change-confirmation') },
        { kind: 'human-gate', gate: selected.gate },
      )
      const fresh = await deps.store.getMission(mission.id)
      if (fresh !== null && fresh.status !== 'awaiting-information') {
        const verdict = checkMissionTransition({
          from: fresh.status,
          to: 'awaiting-information',
          fence: fresh.transitionFence,
        })
        if (verdict.ok) {
          await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
            status: 'awaiting-information',
            blockCode: null,
            blockDetail: 'no-change-confirmation pending',
          })
        }
      }
      return 'collected'
    }
    // ---- 发布链 arm（PR-5，实现在 missionDeliveryChain.ts）------------------
    case 'run-verification': {
      const policy = await loadPolicyContent(deps.lookup, mission)
      if (policy === null) {
        await blockMission(deps, mission.id, 'policy-content-missing', null)
        return 'blocked'
      }
      return await handleRunVerification(
        deliveryDeps(deps),
        mission,
        snapshot.cells,
        selected.profileRef,
        policy.verification.requiredProfileRefs,
      )
    }
    case 'commit-and-publish-candidate': {
      const policy = await loadPolicyContent(deps.lookup, mission)
      if (policy === null) {
        await blockMission(deps, mission.id, 'policy-content-missing', null)
        return 'blocked'
      }
      return await handleCommitAndPublish(
        deliveryDeps(deps),
        mission,
        snapshot.cells,
        policy,
        selected.publicationMode,
      )
    }
    case 'ensure-merge-request': {
      return await handleEnsureMergeRequest(deliveryDeps(deps), mission)
    }
    // ---- pipeline evidence arm（PR-6，实现在 pipelineEvidenceChain.ts）------
    case 'collect-pipeline-evidence': {
      return await handleCollectPipelineEvidence(
        deliveryDeps(deps),
        deps.lookup,
        mission,
        snapshot.cells,
        selected.gateKeys,
      )
    }
    case 'trigger-pipeline': {
      return await handleTriggerPipeline(
        deliveryDeps(deps),
        deps.lookup,
        mission,
        snapshot.cells,
        selected.gateKeys,
      )
    }
    case 'rerun-pipeline': {
      return await handleRerunPipeline(deliveryDeps(deps), deps.lookup, mission, snapshot.cells, {
        gateKey: selected.gateKey,
        runRef: selected.runRef,
      })
    }
    // ---- published employee collaboration / approval saga (PR-12) ----------
    case 'invoke-child-mission': {
      if (deps.ports.playbookSaga === undefined || deps.ports.childMissions === undefined) {
        await blockMission(deps, mission.id, 'child-mission-port-not-wired', null)
        return 'blocked'
      }
      return await handleChildMissionDecision(deps, mission, selected, decisionId)
    }
    case 'submit-approval': {
      if (deps.ports.playbookSaga === undefined || deps.ports.approvalGateway === undefined) {
        await blockMission(deps, mission.id, 'approval-gateway-not-wired', null)
        return 'blocked'
      }
      return await handleApprovalSubmitDecision(deps, mission, selected, decisionId)
    }
    case 'observe-approval': {
      if (deps.ports.playbookSaga === undefined || deps.ports.approvalGateway === undefined) {
        await blockMission(deps, mission.id, 'approval-gateway-not-wired', null)
        return 'blocked'
      }
      return await handleApprovalObserveDecision(deps, mission, selected, decisionId)
    }
    // ---- MR care arm（PR-7，实现在 mrCareChain.ts）--------------------------
    case 'reply-feedback': {
      return await handleReplyFeedback(
        deliveryDeps(deps),
        mission,
        snapshot.cells,
        selected.feedbackReceiptRef,
      )
    }
    // ---- 未到批次的 arm：typed block，绝不静默 ------------------------------
    case 'prepare-change-candidate':
    case 'handoff':
    case 'mark-ready-to-merge': {
      await blockMission(deps, mission.id, `arm-not-wired:${selected.kind}`, null)
      return 'blocked'
    }
    default: {
      const exhaustive: never = selected
      throw new Error(`unhandled decision arm: ${JSON.stringify(exhaustive)}`)
    }
  }
}
