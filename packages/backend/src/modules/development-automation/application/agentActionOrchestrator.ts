// RFC-310 PR-4 —— AgentAttempt 编排（launch 半 + collect 半）。
//
// launch（run-agent-action arm 内）：baseline 解析 → workspace 物化（baseline
// + seed + evidence bundles）→ input manifest（content-addressed，nonce 不入
// digest）→ prompt（不可覆盖 protocol block）→ launcher.launch → attempt 台账
// （nonce 只落 digest；pre-state 上下文冻结为内容寻址 JSON blob）。
//
// collect（reconcile 顶部插桩，guards 之前）：fetchOutcome → §7.5 流水线
// （transport parse → capability semantic → workspace 对拍）→ changed 则经
// source-control 派生 immutable ChangeCandidate → settle validated + cells。
// 任一失败按 §7.7 分类（planNextAttempt）：fresh rerun = 整树废弃 + exact
// 输入重物化 + 新 nonce；耗尽 = blocked(agent-contract-exhausted)。
//
// same-scene retry starts a new bounded host task against the same disposable
// workspace and adds the exact rejection as trusted platform feedback. Once
// that budget is exhausted, fresh-session retry discards the whole workspace
// and rebuilds it from the frozen input.
// requirement/pipeline bundles 作为 platformInputPaths 冻结到 task row，节点
// 隔离快照逐轮 force-include；workspace protected-root 对拍保持只读边界。

import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'

import { sha256Hex } from '@/util/hash'
import { pipelineBundlePath, requirementBundlePath } from '@agent-workflow/shared'
import {
  canonicalDigest,
  canonicalStringify,
  type CanonicalJsonValue,
} from '../domain/canonicalJson'
import { actionTemplateContentSchema } from '../domain/actionTemplate'
import {
  encodeAgentAttemptBaselineRef,
  nonceDigestOf,
  planNextAttempt,
  type AttemptBudget,
  type AttemptFailureKind,
} from '../domain/agentAttempt'
import {
  computeAgentInputDigest,
  agentInputManifestV1Schema,
  type AgentInputManifestV1,
} from '../domain/agentInputManifest'
import { capabilityDefinition, type CapabilityId } from '../domain/capabilityDefinition'
import { projectAnalysisCells } from '../domain/requirementAnalysis'
import type { FactCell } from '../domain/factCell'
import type { FactCellValue } from '../domain/facts'
import { assembleAgentPrompt } from '../engine/prompt/assembleAgentPrompt'
import { parseAgentFrame } from '../engine/envelope/parseAgentFrame'
import { runCapabilitySemanticValidator } from '../engine/envelope/semanticValidators'
import type { MissionRow, MissionStore } from './ports/missionStore'
import type { ReconcileDeps } from './missionReconciler'

/** 预算硬上限（policy 级配置接线归 PR-5；先取保守常量并入 pre-state 冻结）。 */
export const ATTEMPT_WORKSPACE_BUDGET = {
  maxChangedFiles: 2000,
  maxTotalBytes: 64 * 1024 * 1024,
} as const

/** Legacy policy actions retain the historical fresh-only default. */
export const SAME_SESSION_BUDGET_PR4 = 0

interface FeedbackAttemptSnapshot {
  readonly snapshotRef: string
  readonly items: readonly {
    readonly threadRef: string
    readonly revision: string
    readonly body: string
    readonly path: string | null
  }[]
}

/**
 * A fresh session rebuilds the workspace but reuses the exact frozen input.
 * These values are the non-secret material needed to reproduce the first
 * manifest/prompt; reading mutable Mission projections again would silently
 * turn a retry into a different task.
 */
interface FrozenAttemptReplay {
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly seedRef: string | null
  readonly requirementBundle: AgentInputManifestV1['requirementBundle']
  readonly repositoryUploads: AgentInputManifestV1['repositoryUploads']
  readonly pipelineBundle: AgentInputManifestV1['pipelineBundle']
  readonly requirementItemRefs: readonly string[]
  readonly preservePaths: readonly string[]
  readonly editablePaths: readonly string[]
  readonly untrustedIndex: readonly { readonly label: string; readonly text: string }[]
  readonly taskBrief: string
  readonly feedbackSnapshot?: FeedbackAttemptSnapshot
  readonly candidateRef?: string
  readonly pipelineIssueRefs?: readonly string[]
  /** Exact content + manifest + pipeline evidence mounts from the first launch. */
  readonly evidenceBundles: readonly { readonly bundleId: string; readonly mountPath: string }[]
}

interface AttemptPreState {
  readonly schemaVersion: 1
  readonly missionId: string
  readonly actionRunId: string
  readonly capabilityId: string
  readonly templateId: string
  readonly templateRevision: number
  readonly agentId: string | null
  readonly scriptRef: string | null
  readonly templateSupplement: string | null
  readonly budget: AttemptBudget
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly seedRef: string | null
  readonly bundles: readonly { readonly bundleId: string; readonly mountPath: string }[]
  readonly workspacePath: string
  readonly businessTreeDigest: string
  /** WorkspaceValidationPort.capturePreState 的 opaque JSON。 */
  readonly preStateJson: string
  /** manifest 本体（含 protocol.nonce 占位 digest 化前的字段）——nonce 明文以外的全部。 */
  readonly manifestSansNonce: Omit<AgentInputManifestV1, 'protocol'> & {
    readonly protocol: { readonly port: 'agent-result'; readonly outcomeSchemaId: string }
  }
  readonly preservePaths: readonly string[]
  readonly editablePaths: readonly string[]
  readonly untrustedIndex: readonly { readonly label: string; readonly text: string }[]
  readonly taskBrief: string
  readonly factsSummary: readonly { readonly factId: string; readonly value: string }[]
  readonly feedbackSnapshot?: FeedbackAttemptSnapshot
  readonly closedRefs: {
    readonly requirementItemRefs: readonly string[]
    /** PR-5 T54：repository module catalog（analyze affectedModuleRefs 闭集）。 */
    readonly repositoryModuleIds?: readonly string[]
    /** PR-5 T58：review 对拍锚（launch 冻结）。 */
    readonly candidateRef?: string
    /** PR-6 T69：pipeline.repair 的 issue 闭集（launch 冻结）。 */
    readonly pipelineIssueRefs?: readonly string[]
  }
}

function requiredPortsMissing(deps: ReconcileDeps): string | null {
  const ports = deps.ports
  if (ports.actionBaseline === undefined) return 'action-baseline-not-wired'
  if (ports.actionWorkspace === undefined) return 'action-workspace-not-wired'
  if (ports.attemptContext === undefined) return 'attempt-context-not-wired'
  if (ports.actionTemplates === undefined) return 'action-templates-not-wired'
  if (ports.workspaceValidation === undefined) return 'workspace-validation-not-wired'
  if (ports.changeCandidate === undefined) return 'change-candidate-not-wired'
  return null
}

export function publicFactsSummary(
  cells: Readonly<Record<string, FactCell<FactCellValue>>>,
): { factId: string; value: string }[] {
  const out: { factId: string; value: string }[] = []
  for (const factId of Object.keys(cells).sort()) {
    if (factId.startsWith('__')) continue
    const cell = cells[factId]!
    if (cell.state !== 'known') continue
    out.push({ factId, value: JSON.stringify(cell.value).slice(0, 200) })
  }
  return out
}

function agentIdOf(agentRef: string): string {
  const at = agentRef.lastIndexOf('@')
  return at > 0 ? agentRef.slice(0, at) : agentRef
}

export interface LaunchAgentAttemptInput {
  readonly actionRunId: string
  readonly capabilityId: string
  readonly templateId: string
  readonly templateRevision: number
  /** fresh rerun 时由 collect 侧递增；首启 0/0。 */
  readonly rerunSeq: number
  /** prompt 的公开 facts 摘要（arm 侧 publicFactsSummary(snapshot.cells)；
   *  fresh rerun 用 pre-state 冻结的同一份——同输入合同）。 */
  readonly factsSummary: readonly { readonly factId: string; readonly value: string }[]
  /** T58 review 的对拍锚：launch 时冻结的当前 candidateRef（cells 投影）。 */
  readonly candidateRef?: string
  /** PR-6 T69：pipeline.repair 的 evidence bundle 挂载 + issue 闭集（arm 从
   *  cells/manifest 算好传入；非 repair 动作缺省）。 */
  readonly pipelineBundle?: {
    readonly bundleId: string
    readonly manifestDigest: string
    readonly fileCount: number
    readonly totalBytes: number
  }
  readonly pipelineIssueRefs?: readonly string[]
  /** PR-7 T74：feedback apply 的 (threadRef,revision) 闭集（arm 冻结传入）。 */
  readonly feedbackSnapshot?: FeedbackAttemptSnapshot
  readonly problemInput?: {
    readonly producerId: string
    readonly evidenceDigest: string
    readonly headSha: string
    readonly allowedTypeIds: readonly string[]
    readonly subjectRefs: readonly string[]
    readonly requiredSubjectRefs: readonly string[]
  }
  readonly approvalInput?: {
    readonly stepRunRef: string
    readonly approvalType: string
    readonly evidenceRefs: readonly string[]
    readonly requestedScopes: readonly string[]
  }
  /** Business playbook step override. Legacy policy actions omit this. */
  readonly retryBudget?: AttemptBudget
  /** fresh rerun 的同输入合同：manifest.missionRevision 冻结在 action 创建时
   *  （mission.revision 随结算前进，不冻结会让 rerun 的 inputDigest 漂移）。 */
  readonly missionRevisionPin?: number
  /** T109：post-publish 修复轮（feedback/pipeline repair）的基线覆盖——已发布
   *  的 durable commit（`__delivery.commitSha`），修复 candidate 以它为 parent
   *  才能 fast-forward 推回 MR 分支。缺省 = repo 默认分支 head（首轮语义）。 */
  readonly publishedBaselineSha?: string
  /** Internal fresh-session replay seam; callers launching a new action omit it. */
  readonly frozenReplay?: FrozenAttemptReplay
}

export type LaunchAgentAttemptOutcome =
  | { readonly ok: true; readonly executionRef: string }
  | { readonly ok: false; readonly blockCode: string; readonly detail: string | null }

/**
 * launch 半：物化 → manifest → prompt → launcher → attempt 台账。
 * 失败一律 typed blockCode（调用方 settle run + blockMission）。
 */
export async function launchAgentAttempt(
  deps: ReconcileDeps,
  mission: MissionRow,
  input: LaunchAgentAttemptInput,
): Promise<LaunchAgentAttemptOutcome> {
  const missing = requiredPortsMissing(deps)
  if (missing !== null) return { ok: false, blockCode: missing, detail: null }
  const feedbackSnapshot = input.frozenReplay?.feedbackSnapshot ?? input.feedbackSnapshot
  if (input.capabilityId === 'mr.feedback.apply' && feedbackSnapshot === undefined) {
    return {
      ok: false,
      blockCode: 'feedback-snapshot-content-missing',
      detail:
        'the selected review revisions have no exact comment body snapshot; recollect MR facts',
    }
  }
  const ports = deps.ports

  const rawTemplate = ports.actionTemplates!.content(input.templateId, input.templateRevision)
  if (rawTemplate === null) {
    return {
      ok: false,
      blockCode: 'action-template-content-missing',
      detail: `${input.templateId}@${input.templateRevision}`,
    }
  }
  const template = actionTemplateContentSchema.safeParse(rawTemplate)
  if (!template.success) {
    return {
      ok: false,
      blockCode: 'action-template-content-invalid',
      detail: `${input.templateId}@${input.templateRevision}`,
    }
  }
  if (template.data.executor.kind === 'workgroup') {
    return {
      ok: false,
      blockCode: 'action-executor-not-supported',
      detail: template.data.executor.kind,
    }
  }
  if (template.data.executor.kind === 'agent' && ports.agentLauncher === undefined) {
    return { ok: false, blockCode: 'agent-launcher-not-wired', detail: null }
  }
  if (template.data.executor.kind === 'script' && ports.scriptLauncher === undefined) {
    return { ok: false, blockCode: 'script-launcher-not-wired', detail: null }
  }

  const resolvedBaseline =
    input.frozenReplay === undefined
      ? await ports.actionBaseline!.resolve(mission.repositoryId)
      : null
  if (input.frozenReplay === undefined && resolvedBaseline === null) {
    return { ok: false, blockCode: 'action-baseline-unavailable', detail: mission.repositoryId }
  }
  const baseline =
    input.frozenReplay !== undefined
      ? {
          repoPath: input.frozenReplay.baselineRepoPath,
          headSha: input.frozenReplay.baselineSha,
        }
      : input.publishedBaselineSha === undefined
        ? resolvedBaseline!
        : { repoPath: resolvedBaseline!.repoPath, headSha: input.publishedBaselineSha }

  // seed：mission 行存 seedTreeDigest；seeds 目录按 planDigest 命名（placement
  // 的落盘约定）——必须经 plan 行换算，直接拿 uploadPlacementRef 当目录名会
  // 静默空 seed（fork 缝合实测）。
  let seedRef: string | null = input.frozenReplay?.seedRef ?? null
  let uploadEntries: ReturnType<NonNullable<ReconcileDeps['ports']['uploadPlanReader']>['read']> =
    null
  if (
    input.frozenReplay === undefined &&
    mission.uploadPlanRef !== null &&
    mission.uploadPlacementRef !== null
  ) {
    uploadEntries = ports.uploadPlanReader?.read(mission.uploadPlanRef) ?? null
    if (uploadEntries === null) {
      return { ok: false, blockCode: 'upload-plan-unreadable', detail: mission.uploadPlanRef }
    }
    seedRef = uploadEntries.planDigest
  }

  const sources = input.frozenReplay === undefined ? deps.store.listMissionSources(mission.id) : []
  const requirementSource = sources
    .filter((s) => s.bundleRef !== null && s.state === 'materialized')
    .sort((a, b) => b.generation - a.generation)[0]
  const requirementBundle =
    input.frozenReplay !== undefined
      ? input.frozenReplay.requirementBundle
      : requirementSource === undefined
        ? null
        : {
            bundleId: requirementSource.bundleRef!,
            manifestDigest: requirementSource.manifestDigest!,
            mountPath: requirementBundlePath(requirementSource.bundleRef!),
            fileCount: requirementSource.fileCount ?? 0,
            totalBytes: requirementSource.totalBytes ?? 0,
          }
  const pipelineBundle =
    input.frozenReplay !== undefined
      ? input.frozenReplay.pipelineBundle
      : input.pipelineBundle === undefined
        ? null
        : {
            bundleId: input.pipelineBundle.bundleId,
            manifestDigest: input.pipelineBundle.manifestDigest,
            mountPath: pipelineBundlePath(input.pipelineBundle.bundleId),
            fileCount: input.pipelineBundle.fileCount,
            totalBytes: input.pipelineBundle.totalBytes,
          }
  const requirementManifestMount =
    input.frozenReplay !== undefined || requirementBundle === null
      ? null
      : (ports.requirementMaterialize?.getRequirementManifestMount(
          mission.id,
          requirementBundle.manifestDigest,
        ) ?? null)
  if (
    input.frozenReplay === undefined &&
    requirementBundle !== null &&
    requirementManifestMount === null
  ) {
    return {
      ok: false,
      blockCode: 'requirement-manifest-mount-unavailable',
      detail: requirementBundle.manifestDigest,
    }
  }
  const bundles = input.frozenReplay?.evidenceBundles ?? [
    ...(requirementBundle === null
      ? []
      : [
          {
            bundleId: requirementBundle.bundleId,
            mountPath: requirementBundle.mountPath,
          },
          {
            bundleId: requirementManifestMount!.bundleId,
            mountPath: requirementBundle.mountPath,
          },
        ]),
    // PR-6 T69：repair 动作把 pinned pipeline bundle 只读挂进 workspace。
    ...(pipelineBundle === null
      ? []
      : [
          {
            bundleId: pipelineBundle.bundleId,
            mountPath: pipelineBundle.mountPath,
          },
        ]),
  ]

  const workspace = await ports.actionWorkspace!.materialize({
    baselineRepoPath: baseline.repoPath,
    baselineSha: baseline.headSha,
    seedRef,
    bundles,
  })
  const discard = (): void => {
    try {
      ports.actionWorkspace!.discard(workspace.workspacePath)
    } catch {
      // 废弃失败不掩盖主错误；孤儿目录由 GC 兜底。
    }
  }

  const preservePaths =
    input.frozenReplay?.preservePaths ??
    uploadEntries?.entries
      .filter((e) => e.contentPolicy === 'preserve-upload' && e.disposition !== 'already-present')
      .map((e) => e.targetPath) ??
    []
  const editablePaths =
    input.frozenReplay?.editablePaths ??
    uploadEntries?.entries
      .filter((e) => e.contentPolicy === 'agent-editable' && e.disposition !== 'already-present')
      .map((e) => e.targetPath) ??
    []

  const definition = capabilityDefinition(input.capabilityId as CapabilityId)
  const nonce = randomBytes(24).toString('hex')
  const manifestCore = {
    schemaVersion: 1 as const,
    actionRunRef: input.actionRunId,
    capabilityId: input.capabilityId as AgentInputManifestV1['capabilityId'],
    capabilityContractVersion: definition.contractVersion,
    templateRevision: input.templateRevision,
    missionRevision: input.missionRevisionPin ?? mission.revision,
    baseHeadSha: baseline.headSha,
    requirementBundle,
    repositoryUploads:
      input.frozenReplay !== undefined
        ? input.frozenReplay.repositoryUploads
        : uploadEntries === null || uploadEntries.entries.length === 0
          ? null
          : {
              planDigest: uploadEntries.planDigest,
              placementDigest: mission.uploadPlacementRef!,
              entries: uploadEntries.entries.map((e) => ({
                ordinal: e.ordinal,
                targetPath: e.targetPath,
                contentPolicy: e.contentPolicy,
                fileMode: e.fileMode,
                originalEvidenceFileId: e.fileId,
              })),
            },
    pipelineBundle,
    feedbackSnapshot:
      feedbackSnapshot === undefined
        ? null
        : {
            snapshotRef: feedbackSnapshot.snapshotRef,
            items: feedbackSnapshot.items.map((item) => ({
              threadRef: item.threadRef,
              revision: item.revision,
            })),
          },
    verificationEvidence: null,
    ...(input.problemInput === undefined
      ? {}
      : {
          problemEvidence: {
            ...input.problemInput,
            allowedTypeIds: [...input.problemInput.allowedTypeIds],
            subjectRefs: [...input.problemInput.subjectRefs],
            requiredSubjectRefs: [...input.problemInput.requiredSubjectRefs],
          },
        }),
    ...(input.approvalInput === undefined
      ? {}
      : {
          approvalContext: {
            ...input.approvalInput,
            evidenceRefs: [...input.approvalInput.evidenceRefs],
            requestedScopes: [...input.approvalInput.requestedScopes],
          },
        }),
    writablePathClasses: [],
    protectedRoots: [],
  }
  const inputDigest = computeAgentInputDigest({
    ...manifestCore,
    protocol: {
      nonce,
      port: 'agent-result' as const,
      outcomeSchemaId: definition.outputSchemaId,
    },
  })
  const manifestParsed = agentInputManifestV1Schema.safeParse({
    ...manifestCore,
    inputDigest,
    protocol: { nonce, port: 'agent-result', outcomeSchemaId: definition.outputSchemaId },
  })
  if (!manifestParsed.success) {
    discard()
    return {
      ok: false,
      blockCode: 'agent-input-manifest-invalid',
      detail: manifestParsed.error.issues[0]?.message ?? null,
    }
  }
  const manifest = manifestParsed.data

  // coverage 闭集：requirement manifest 的 fileId 集（semantic validator 对拍）。
  const requirementItemRefs =
    input.frozenReplay?.requirementItemRefs ?? requirementManifestMount?.fileIds ?? []
  // analyze 的 module catalog 闭集：launch 时从 facts 摘要冻结（repository.moduleIds
  // 是 known string-set 时其 value 已在 factsSummary 序列化——直接从入参 cells 冻结
  // 更准确，但 arm 只传 factsSummary；此处从 JSON 摘要还原，投影失败取空集）。
  const repositoryModuleIds = ((): readonly string[] => {
    const row = input.factsSummary.find((f) => f.factId === 'repository.moduleIds')
    if (row === undefined) return []
    try {
      const parsed = JSON.parse(row.value) as unknown
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return []
    }
  })()

  const untrustedIndex: { label: string; text: string }[] =
    input.frozenReplay === undefined ? [] : [...input.frozenReplay.untrustedIndex]
  if (input.frozenReplay === undefined) {
    const source = sources[0]
    if (mission.sourceKind === 'direct') {
      untrustedIndex.push({
        label: 'requirement',
        text: `direct submission (digest ${mission.sourceContentDigest ?? 'n/a'})`,
      })
    } else if (source !== undefined && source.externalId !== null) {
      untrustedIndex.push({
        label: 'requirement',
        text: `external ${source.externalId} @ ${source.sourceRevision ?? 'unknown'}`,
      })
    }
    for (const feedback of feedbackSnapshot?.items ?? []) {
      untrustedIndex.push({
        label: `review feedback ${feedback.threadRef}@${feedback.revision}${
          feedback.path === null ? '' : ` (${feedback.path})`
        }`,
        text: feedback.body,
      })
    }
  }

  const taskBrief =
    input.frozenReplay?.taskBrief ??
    [
      `Capability: ${input.capabilityId} (contract v${definition.contractVersion}).`,
      `Repository baseline: ${baseline.headSha}.`,
      definition.workspaceMode === 'read-only'
        ? 'Inspect the repository and mounted evidence, then return the capability result. Do not modify any file.'
        : definition.workspaceMode === 'edit-business-files'
          ? 'Perform this capability inside the workspace. Edit business files only; Git and platform input paths remain read-only.'
          : definition.workspaceMode === 'edit-conflicts'
            ? 'Resolve only the pinned conflict work set. Do not perform Git operations or edit platform input paths.'
            : 'Return the capability result without modifying workspace files.',
    ].join('\n')
  const factsSummary = input.factsSummary
  const prompt = assembleAgentPrompt({
    taskBrief,
    factsSummary,
    templateSupplement: template.data.promptSupplement,
    manifest,
    untrustedIndex,
  })

  const preState: AttemptPreState = {
    schemaVersion: 1,
    missionId: mission.id,
    actionRunId: input.actionRunId,
    capabilityId: input.capabilityId,
    templateId: input.templateId,
    templateRevision: input.templateRevision,
    agentId:
      template.data.executor.kind === 'agent' ? agentIdOf(template.data.executor.agentRef) : null,
    scriptRef: template.data.executor.kind === 'script' ? template.data.executor.scriptRef : null,
    templateSupplement: template.data.promptSupplement,
    budget: {
      sameSession: input.retryBudget?.sameSession ?? SAME_SESSION_BUDGET_PR4,
      freshSession: input.retryBudget?.freshSession ?? template.data.retryDefaults.freshSession,
    },
    baselineRepoPath: baseline.repoPath,
    baselineSha: baseline.headSha,
    seedRef,
    bundles,
    workspacePath: workspace.workspacePath,
    businessTreeDigest: workspace.businessTreeDigest,
    preStateJson: ports.workspaceValidation!.capturePreState(workspace.workspacePath),
    manifestSansNonce: {
      ...manifest,
      protocol: { port: 'agent-result', outcomeSchemaId: manifest.protocol.outcomeSchemaId },
    },
    preservePaths,
    editablePaths,
    untrustedIndex,
    taskBrief,
    factsSummary,
    ...(feedbackSnapshot === undefined ? {} : { feedbackSnapshot }),
    closedRefs: {
      requirementItemRefs,
      repositoryModuleIds,
      ...(input.frozenReplay?.candidateRef === undefined && input.candidateRef === undefined
        ? {}
        : { candidateRef: input.frozenReplay?.candidateRef ?? input.candidateRef! }),
      ...(input.frozenReplay?.pipelineIssueRefs === undefined &&
      input.pipelineIssueRefs === undefined
        ? {}
        : {
            pipelineIssueRefs: input.frozenReplay?.pipelineIssueRefs ?? input.pipelineIssueRefs!,
          }),
    },
  }
  const preSnapshotRef = await ports.attemptContext!.save(JSON.stringify(preState))

  const launchCommon = {
    actionRunId: input.actionRunId,
    capabilityId: input.capabilityId,
    prompt,
    workspacePath: workspace.workspacePath,
    baselineSha: baseline.headSha,
    platformInputPaths: [...new Set(bundles.map((bundle) => bundle.mountPath))],
    wallTimeMs: null,
  }
  const launched =
    preState.scriptRef === null
      ? await ports.agentLauncher!.launch({ ...launchCommon, agentId: preState.agentId! })
      : await ports.scriptLauncher!.launch({ ...launchCommon, scriptRef: preState.scriptRef })
  if (!launched.ok) {
    discard()
    return {
      ok: false,
      blockCode: `agent-launch-failed:${launched.failure.code}`,
      detail: launched.failure.remediation,
    }
  }

  const claim = deps.store.claimAttempt({
    id: ulid(),
    actionRunId: input.actionRunId,
    rerunSeq: input.rerunSeq,
    attemptSeq: 0,
    executionRef: launched.executionRef,
    baselineRef: encodeAgentAttemptBaselineRef({
      repositorySnapshotRef: `git:${baseline.headSha}`,
      seedChangeRef: seedRef,
      priorChangeSetRefs: [],
    }),
    nonceDigest: nonceDigestOf(nonce),
    inputDigest: manifest.inputDigest,
    preSnapshotRef,
    now: deps.now(),
  })
  if (!claim.ok) {
    // ordinal 撞行 = 并发 reconciler 已抢先 launch；本次执行成为多余进程，
    // 直接取消（launcher 幂等 cancel），不 block mission。
    if (preState.scriptRef === null) await ports.agentLauncher!.cancel(launched.executionRef)
    else await ports.scriptLauncher!.cancel(launched.executionRef)
    discard()
    return { ok: false, blockCode: 'attempt-ordinal-taken', detail: null }
  }
  return { ok: true, executionRef: launched.executionRef }
}

export type CollectAgentAttemptOutcome =
  | { readonly kind: 'no-op' }
  | { readonly kind: 'still-running' }
  | {
      readonly kind: 'action-collected'
      readonly actionRunId: string
      readonly disposition:
        | 'validated-changed'
        | 'validated-no-change'
        | 'analysis-completed'
        | 'needs-information'
        | 'agent-blocked'
    }
  | { readonly kind: 'action-retry'; readonly actionRunId: string; readonly rerunSeq: number }
  | { readonly kind: 'action-failed'; readonly actionRunId: string; readonly blockCode: string }

function parsePreState(json: string | null): AttemptPreState | null {
  if (json === null) return null
  try {
    const value = JSON.parse(json) as AttemptPreState & { scriptRef?: string | null }
    return value.schemaVersion === 1 ? { ...value, scriptRef: value.scriptRef ?? null } : null
  } catch {
    return null
  }
}

function releaseFeedbackRows(deps: ReconcileDeps, missionId: string, actionRunId: string): void {
  const run = deps.store.getActionRun(actionRunId)
  if (run?.capabilityId !== 'mr.feedback.apply') return
  const now = deps.now()
  for (const row of deps.store.listFeedback(missionId)) {
    if (row.state !== 'selected' || row.actionRunId !== actionRunId) continue
    deps.store.setFeedbackState({ id: row.id, state: 'observed', actionRunId: null, now })
  }
}

function settleRunAndBlock(
  deps: ReconcileDeps,
  mission: MissionRow,
  actionRunId: string,
  blockCode: string,
  detail: string | null,
): void {
  releaseFeedbackRows(deps, mission.id, actionRunId)
  deps.store.settleActionRun({
    id: actionRunId,
    status: 'failed',
    resultRef: null,
    failureJson: JSON.stringify({
      category: 'agent-contract',
      code: blockCode,
      retryability: 'never',
      attemptOrdinal: 0,
      remediation: detail ?? blockCode,
      evidenceRef: null,
    }),
    now: deps.now(),
  })
  clearCurrentAction(deps.store, mission)
  // A playbook step owns its failure branch. Blocking the whole Mission here
  // would bypass the employee's onRejected/onExpired/onExhausted rule and turn
  // the Agent into an implicit scheduler. Legacy policy actions keep their
  // historical Mission-level boundary.
  if (
    deps.ports.playbookSaga?.findStepRunByAction(actionRunId) === null ||
    deps.ports.playbookSaga === undefined
  ) {
    blockMissionDirect(deps, mission.id, blockCode, detail)
  }
}

function clearCurrentAction(store: MissionStore, mission: MissionRow): void {
  const fresh = store.getMission(mission.id)
  if (fresh !== null && fresh.currentActionRunId !== null) {
    store.occUpdate(fresh.id, fresh.revision, fresh.epoch, { currentActionRunId: null })
  }
}

function blockMissionDirect(
  deps: ReconcileDeps,
  missionId: string,
  code: string,
  detail: string | null,
): void {
  const fresh = deps.store.getMission(missionId)
  if (fresh === null) return
  if (fresh.status !== 'blocked') {
    deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
      status: 'blocked',
      blockCode: code,
      blockDetail: detail,
    })
  } else {
    deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
      blockCode: code,
      blockDetail: detail,
    })
  }
}

function persistActionCells(
  deps: ReconcileDeps,
  mission: MissionRow,
  cells: Record<string, FactCell<FactCellValue>>,
): void {
  const fresh = deps.store.getMission(mission.id)
  if (fresh === null) return
  const base =
    fresh.requirementBundleRef === null
      ? {}
      : (deps.snapshots.getCells(fresh.requirementBundleRef) ?? {})
  const merged = { ...base, ...cells }
  const snapshotId = ulid()
  const now = deps.now()
  deps.store.insertFactSnapshot({
    id: snapshotId,
    missionId: fresh.id,
    missionRevision: fresh.revision,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(merged as unknown as CanonicalJsonValue),
    refsJson: canonicalStringify({ kind: 'agent-action' }),
    digest: canonicalDigest(merged as unknown as CanonicalJsonValue),
    now,
  })
  deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
    requirementBundleRef: snapshotId,
  })
}

/**
 * collect 半（reconcile 顶部插桩）：currentActionRunId 存在且 launcher 可用时
 * 收取执行结果。返回 no-op 时 reconcile 继续正常流程（guards 会因
 * active-action wait）。
 */
export async function collectAgentAttempt(
  deps: ReconcileDeps,
  mission: MissionRow,
): Promise<CollectAgentAttemptOutcome> {
  const ports = deps.ports
  const actionRunId = mission.currentActionRunId
  if (actionRunId === null) return { kind: 'no-op' }
  const attempts = deps.store.listAttempts(actionRunId)
  const attempt = attempts[attempts.length - 1]
  if (attempt === undefined) return { kind: 'no-op' }
  if (attempt.status !== 'claimed' && attempt.status !== 'running') return { kind: 'no-op' }
  if (attempt.executionRef === null) return { kind: 'no-op' }

  const preState = parsePreState(ports.attemptContext?.load(attempt.preSnapshotRef ?? '') ?? null)
  const launcher = preState?.scriptRef === null ? ports.agentLauncher : ports.scriptLauncher
  if (launcher === undefined) return { kind: 'no-op' }
  const snapshot = await launcher.fetchOutcome(attempt.executionRef)
  if (snapshot.kind === 'pending') return { kind: 'still-running' }
  const now = deps.now()

  const failAttempt = async (
    failure: AttemptFailureKind,
    rejection: unknown,
    detailForBlock: string,
  ): Promise<CollectAgentAttemptOutcome> => {
    deps.store.settleAttempt({
      id: attempt.id,
      status: failure === 'boundary-violation' ? 'discarded' : 'rejected',
      rejectionJson: JSON.stringify(rejection),
      outcomeRef: null,
      now,
    })
    const plan = planNextAttempt({
      failure,
      budget: preState?.budget ?? { sameSession: 0, freshSession: 1 },
      rerunSeq: attempt.rerunSeq,
      attemptSeq: attempt.attemptSeq,
    })
    if (plan.kind === 'same-session' && preState !== null) {
      const nonce = randomBytes(24).toString('hex')
      const manifest = agentInputManifestV1Schema.safeParse({
        ...preState.manifestSansNonce,
        protocol: {
          nonce,
          port: 'agent-result',
          outcomeSchemaId: preState.manifestSansNonce.protocol.outcomeSchemaId,
        },
      })
      if (!manifest.success || manifest.data.inputDigest !== attempt.inputDigest) {
        try {
          ports.actionWorkspace?.discard(preState.workspacePath)
        } catch {
          // GC 兜底。
        }
        settleRunAndBlock(
          deps,
          mission,
          actionRunId,
          'same-scene-manifest-unrebuildable',
          manifest.success ? 'input digest drifted' : (manifest.error.issues[0]?.message ?? null),
        )
        return {
          kind: 'action-failed',
          actionRunId,
          blockCode: 'same-scene-manifest-unrebuildable',
        }
      }
      const prompt = assembleAgentPrompt({
        taskBrief: `${preState.taskBrief}\n\nRetry the same scene. Correct the previous result and emit a new exact envelope; do not use Git.`,
        factsSummary: preState.factsSummary,
        templateSupplement: preState.templateSupplement,
        manifest: manifest.data,
        untrustedIndex: [
          ...preState.untrustedIndex,
          {
            label: 'previous attempt rejection',
            text: `${detailForBlock}: ${JSON.stringify(rejection).slice(0, 4_000)}`,
          },
        ],
      })
      const launchCommon = {
        actionRunId,
        capabilityId: preState.capabilityId,
        prompt,
        workspacePath: preState.workspacePath,
        baselineSha: preState.baselineSha,
        platformInputPaths: [...new Set(preState.bundles.map((bundle) => bundle.mountPath))],
        wallTimeMs: null,
      }
      const launched =
        preState.scriptRef === null
          ? await ports.agentLauncher!.launch({ ...launchCommon, agentId: preState.agentId! })
          : await ports.scriptLauncher!.launch({ ...launchCommon, scriptRef: preState.scriptRef })
      if (launched.ok) {
        const claim = deps.store.claimAttempt({
          id: ulid(),
          actionRunId,
          rerunSeq: plan.rerunSeq,
          attemptSeq: plan.attemptSeq,
          executionRef: launched.executionRef,
          baselineRef: attempt.baselineRef,
          nonceDigest: nonceDigestOf(nonce),
          inputDigest: manifest.data.inputDigest,
          preSnapshotRef: attempt.preSnapshotRef,
          now: deps.now(),
        })
        if (claim.ok) {
          return { kind: 'action-retry', actionRunId, rerunSeq: plan.rerunSeq }
        }
        if (preState.scriptRef === null) await ports.agentLauncher!.cancel(launched.executionRef)
        else await ports.scriptLauncher!.cancel(launched.executionRef)
      }
      try {
        ports.actionWorkspace?.discard(preState.workspacePath)
      } catch {
        // GC 兜底。
      }
      const blockCode = launched.ok
        ? 'attempt-ordinal-taken'
        : `same-scene-launch-failed:${launched.failure.code}`
      settleRunAndBlock(deps, mission, actionRunId, blockCode, detailForBlock)
      return { kind: 'action-failed', actionRunId, blockCode }
    }
    // Fresh retry and every terminal failure discard the complete scene. A
    // boundary violation can therefore never leak a tainted workspace forward.
    if (preState !== null) {
      try {
        ports.actionWorkspace?.discard(preState.workspacePath)
      } catch {
        // GC 兜底。
      }
    }
    if (plan.kind === 'fresh-session' && preState !== null) {
      const relaunched = await launchAgentAttempt(deps, mission, {
        actionRunId,
        capabilityId: preState.capabilityId,
        templateId: preState.templateId,
        templateRevision: preState.templateRevision,
        rerunSeq: plan.rerunSeq,
        factsSummary: preState.factsSummary,
        missionRevisionPin: preState.manifestSansNonce.missionRevision,
        ...(preState.manifestSansNonce.problemEvidence === undefined
          ? {}
          : { problemInput: preState.manifestSansNonce.problemEvidence }),
        ...(preState.manifestSansNonce.approvalContext === undefined
          ? {}
          : { approvalInput: preState.manifestSansNonce.approvalContext }),
        frozenReplay: {
          baselineRepoPath: preState.baselineRepoPath,
          baselineSha: preState.baselineSha,
          seedRef: preState.seedRef,
          requirementBundle: preState.manifestSansNonce.requirementBundle,
          repositoryUploads: preState.manifestSansNonce.repositoryUploads,
          pipelineBundle: preState.manifestSansNonce.pipelineBundle,
          requirementItemRefs: preState.closedRefs.requirementItemRefs,
          preservePaths: preState.preservePaths,
          editablePaths: preState.editablePaths,
          untrustedIndex: preState.untrustedIndex,
          taskBrief: preState.taskBrief,
          ...(preState.feedbackSnapshot === undefined
            ? {}
            : { feedbackSnapshot: preState.feedbackSnapshot }),
          ...(preState.closedRefs.candidateRef === undefined
            ? {}
            : { candidateRef: preState.closedRefs.candidateRef }),
          ...(preState.closedRefs.pipelineIssueRefs === undefined
            ? {}
            : { pipelineIssueRefs: preState.closedRefs.pipelineIssueRefs }),
          evidenceBundles: preState.bundles,
        },
      })
      if (relaunched.ok) return { kind: 'action-retry', actionRunId, rerunSeq: plan.rerunSeq }
      settleRunAndBlock(deps, mission, actionRunId, relaunched.blockCode, relaunched.detail)
      return { kind: 'action-failed', actionRunId, blockCode: relaunched.blockCode }
    }
    const blockCode =
      plan.kind === 'exhausted' || plan.kind === 'forbidden'
        ? plan.blockCode
        : `agent-retry-unavailable:${detailForBlock}`
    settleRunAndBlock(deps, mission, actionRunId, blockCode, detailForBlock)
    return { kind: 'action-failed', actionRunId, blockCode }
  }

  if (snapshot.kind === 'not-found') {
    return await failAttempt(
      'runtime-transient',
      { code: 'execution-not-found' },
      'execution-not-found',
    )
  }

  // exited —— 先按任务终态分类。
  if (snapshot.taskStatus === 'canceled') {
    deps.store.settleAttempt({
      id: attempt.id,
      status: 'discarded',
      rejectionJson: JSON.stringify({ code: 'execution-canceled' }),
      outcomeRef: null,
      now,
    })
    if (preState !== null) {
      try {
        ports.actionWorkspace?.discard(preState.workspacePath)
      } catch {
        // GC 兜底。
      }
    }
    settleRunAndBlock(deps, mission, actionRunId, 'agent-execution-canceled', null)
    return { kind: 'action-failed', actionRunId, blockCode: 'agent-execution-canceled' }
  }
  if (snapshot.taskStatus === 'interrupted') {
    return await failAttempt(
      'runtime-transient',
      { code: 'execution-interrupted' },
      'execution-interrupted',
    )
  }
  if (snapshot.taskStatus === 'failed' && snapshot.resultText === null) {
    return await failAttempt(
      'runtime-transient',
      { code: 'execution-failed', errorSummary: snapshot.errorSummary },
      snapshot.errorSummary ?? 'execution-failed',
    )
  }

  if (preState === null || ports.workspaceValidation === undefined) {
    return await failAttempt(
      'evidence-unavailable',
      { code: 'attempt-pre-state-unavailable' },
      'attempt-pre-state-unavailable',
    )
  }

  // §7.5 步骤 1-3：transport parse（nonce digest 对拍）。
  const parsed = parseAgentFrame(snapshot.resultText ?? '', {
    nonceDigest: attempt.nonceDigest,
    actionRunRef: actionRunId,
    inputDigest: attempt.inputDigest,
    capabilityId: preState.capabilityId,
  })
  if (!parsed.ok) {
    return await failAttempt('protocol', parsed.rejection, parsed.rejection.code)
  }
  const envelope = parsed.envelope

  // 步骤 4：capability semantic。
  const manifest = agentInputManifestV1Schema.safeParse({
    ...preState.manifestSansNonce,
    protocol: {
      // parser 已按 digest 对拍过 nonce；此处用回显明文重建完整 manifest。
      nonce: envelope.nonce,
      port: 'agent-result',
      outcomeSchemaId: preState.manifestSansNonce.protocol.outcomeSchemaId,
    },
  })
  if (!manifest.success) {
    return await failAttempt(
      'evidence-unavailable',
      { code: 'attempt-manifest-unrebuildable' },
      'attempt-manifest-unrebuildable',
    )
  }
  const semantic = runCapabilitySemanticValidator({
    manifest: manifest.data,
    envelope,
    closedRefs: {
      requirementItemRefs: preState.closedRefs.requirementItemRefs,
      repositoryModuleIds: preState.closedRefs.repositoryModuleIds,
      ...(preState.closedRefs.candidateRef === undefined
        ? {}
        : { candidateRef: preState.closedRefs.candidateRef }),
      ...(preState.closedRefs.pipelineIssueRefs === undefined
        ? {}
        : { pipelineIssueRefs: preState.closedRefs.pipelineIssueRefs }),
    },
  })
  if (!semantic.ok) {
    return await failAttempt('protocol', semantic.rejection, semantic.rejection.code)
  }

  // 步骤 5-7：workspace 对拍。
  const validated = ports.workspaceValidation.validate({
    workspacePath: preState.workspacePath,
    preStateJson: preState.preStateJson,
    // completed（read-only 完成）对现场的要求与 no-change 相同：必须 clean。
    outcome: envelope.outcome === 'completed' ? 'no-change' : envelope.outcome,
    workspaceMode: capabilityDefinition(preState.capabilityId as CapabilityId).workspaceMode,
    writablePrefixes: [],
    preservePaths: preState.preservePaths,
    editablePaths: preState.editablePaths,
    budget: ATTEMPT_WORKSPACE_BUDGET,
  })
  if (!validated.ok) {
    if (validated.kind === 'boundary') {
      return await failAttempt(
        'boundary-violation',
        { code: validated.code, paths: validated.paths, detail: validated.detail },
        validated.code,
      )
    }
    return await failAttempt(
      'protocol',
      { code: validated.code, detail: validated.detail },
      validated.code,
    )
  }

  // 步骤 8：changed ⇒ 派生 immutable ChangeCandidate（独立 diff）。
  let candidateRef: string | null = null
  let candidateTreeOid: string | null = null
  let candidateUploadLineage: {
    readonly finalDigests: readonly { readonly targetPath: string; readonly sha256: string }[]
  } | null = null
  if (envelope.outcome === 'changed') {
    const derived = await ports.changeCandidate!.derive({
      baselineRepoPath: preState.baselineRepoPath,
      baselineSha: preState.baselineSha,
      overlayRoot: preState.workspacePath,
      excludePolicyDigest: sha256Hex('rfc308:platform-workspace-exclude@1'),
      agentOutcomeRef: attempt.id,
      protectedRoots: [],
      uploadsAlreadyPublished: mission.uploadPublicationRef !== null,
      uploadPlan:
        mission.uploadPlanRef !== null
          ? (ports.uploadPlanReader?.read(mission.uploadPlanRef) ?? null)
          : null,
    })
    if (!derived.ok) {
      const isBoundary =
        derived.code === 'candidate-forbidden-path' || derived.code === 'overlay-symlink'
      return await failAttempt(
        isBoundary ? 'boundary-violation' : 'protocol',
        { code: derived.code, detail: derived.detail },
        derived.code,
      )
    }
    candidateRef = derived.receipt.candidateRef
    candidateTreeOid = derived.receipt.treeOid
    candidateUploadLineage = derived.receipt.uploadLineage
  }

  const structuredResultRef =
    envelope.outcome === 'completed' &&
    (envelope.result.capabilityId === 'problem.classify' ||
      envelope.result.capabilityId === 'approval.prepare')
      ? await ports.attemptContext!.save(JSON.stringify(envelope.result))
      : null
  const actionResultRef = candidateRef ?? structuredResultRef

  // 结算：attempt validated + run validated + cells + 清 currentActionRunId。
  deps.store.settleAttempt({
    id: attempt.id,
    status: 'validated',
    rejectionJson: null,
    outcomeRef: actionResultRef,
    now,
  })
  deps.store.settleActionRun({
    id: actionRunId,
    status: 'settled',
    resultRef: actionResultRef,
    failureJson: null,
    now,
  })
  clearCurrentAction(deps.store, mission)
  const known = (value: FactCellValue): FactCell<FactCellValue> => ({
    state: 'known',
    value,
    sourceRevision: attempt.id,
  })
  persistActionCells(deps, mission, {
    'action.lastOutcome': known(envelope.outcome),
    'action.lastCapability': known(preState.capabilityId),
    '__action.runId': known(actionRunId),
    ...(candidateRef === null ? {} : { '__action.candidateRef': known(candidateRef) }),
    ...(structuredResultRef === null
      ? {}
      : envelope.outcome === 'completed' && envelope.result.capabilityId === 'problem.classify'
        ? {
            '__problem.setRef': known(structuredResultRef),
            '__problem.evidenceDigest': known(envelope.result.evidenceDigest),
            '__problem.typeIds': known(
              [...new Set(envelope.result.problems.map((problem) => problem.typeId))].sort(),
            ),
          }
        : { '__approval.draftRef': known(structuredResultRef) }),
    // PR-5 发布链（missionDeliveryChain）的接管信号与 stage 重放对拍锚：
    // candidateState='derived' + treeOid 由 redispatchDelivery 读取。
    ...(candidateRef === null || candidateTreeOid === null
      ? {}
      : {
          '__action.candidateState': known('derived'),
          '__action.candidateTreeOid': known(candidateTreeOid),
          // 这条 candidate 是**哪个 run** 产出的。`__action.runId` 记的是"最近一次
          // 动作"，read-only 动作（approval.prepare / problem.classify / review …）
          // 同样会覆盖它却不产 candidate；发布链若拿 runId 去找 candidate 的现场，
          // 就会用一个**没有业务改动的 workspace** 重放 stage，得到与记录不同的
          // tree ⇒ 假的 `candidate-tree-drift`（T140 旅程实测：父任务在审批步骤
          // 之后必然撞上）。所以 candidate 的现场必须自带 run 身份。
          '__action.candidateRunId': known(actionRunId),
        }),
    // push 后记 upload publication receipt 的 lineage（finalDigests）在此冻结。
    ...(candidateUploadLineage === null
      ? {}
      : { '__delivery.uploadLineage': known(JSON.stringify(candidateUploadLineage)) }),
    // PR-5 T54：analyze 完成 → 经 validator 的认知结论投影为 agent-validated
    // facts（affectedModuleIds/scopeDisposition），驱动后续 implement 路由。
    ...(envelope.outcome === 'completed' ? projectAnalysisCells(envelope, attempt.id) : {}),
    // PR-7 T74：feedback apply 结算——thread dispositions 冻结进内部 cells
    // （care 链据此派 reply 并更新台账；envelope 本体不落 DB）。
    ...(envelope.outcome === 'changed' && envelope.result.capabilityId === 'mr.feedback.apply'
      ? {
          '__feedback.lastDispositions': known(
            JSON.stringify(
              envelope.result.feedback.map((f) => ({
                threadRef: f.threadRef,
                revision: f.revision,
                disposition: f.disposition,
              })),
            ),
          ),
        }
      : {}),
  })

  const disposition =
    envelope.outcome === 'changed'
      ? ('validated-changed' as const)
      : envelope.outcome === 'completed'
        ? ('analysis-completed' as const)
        : envelope.outcome === 'no-change'
          ? ('validated-no-change' as const)
          : envelope.outcome === 'needs-information'
            ? ('needs-information' as const)
            : ('agent-blocked' as const)

  if (preState.capabilityId === 'mr.feedback.apply' && envelope.outcome !== 'changed') {
    releaseFeedbackRows(deps, mission.id, actionRunId)
  }

  if (envelope.outcome === 'blocked') {
    // completed（read-only 分析）不 block：scopeDisposition facts 已就位，
    // 下轮规则立即据此路由 implement / no-change gate。
    if (
      deps.ports.playbookSaga?.findStepRunByAction(actionRunId) === null ||
      deps.ports.playbookSaga === undefined
    ) {
      blockMissionDirect(
        deps,
        mission.id,
        `agent-blocked:${envelope.result.code}`,
        envelope.result.explanation,
      )
    }
  } else if (envelope.outcome === 'needs-information') {
    // Agent 问题集入台账（origin 'agent'、平台渠道），下轮 reconcile 的澄清
    // 重派会 publish → awaiting-information → answers 闭环 → 重新选动作。
    const stashed = await ports.requirementMaterialize?.stashQuestionSet({
      missionId: mission.id,
      origin: 'agent',
      channel: 'platform',
      questions: envelope.result.questions.map((q) => ({
        questionId: q.questionId,
        text: q.text,
        answerKind: 'text' as const,
        choices: null,
      })),
    })
    if (
      (stashed === undefined || !stashed.ok) &&
      (deps.ports.playbookSaga?.findStepRunByAction(actionRunId) === null ||
        deps.ports.playbookSaga === undefined)
    ) {
      blockMissionDirect(deps, mission.id, 'agent-questions-stash-failed', null)
    }
  } else if (envelope.outcome === 'no-change') {
    // validated no-change（write 能力跑完零业务改动）：收束判定属 no-change
    // gate/后续批次——不静默重复选同一动作，以 typed block 停住（「开单 ≠
    // 在跑」同款诚实边界）。changed 不再 block：candidateState='derived' 已
    // 落 cells，下轮 reconcile 由发布链（missionDeliveryChain redispatch）
    // 接管 verification → commit/publish → MR。completed（read-only 分析）
    // 也不 block：scopeDisposition facts 就位后规则立即续路由。
    if (
      deps.ports.playbookSaga?.findStepRunByAction(actionRunId) === null ||
      deps.ports.playbookSaga === undefined
    ) {
      blockMissionDirect(deps, mission.id, 'action-stage-complete:no-change', candidateRef)
    }
  }

  return { kind: 'action-collected', actionRunId, disposition }
}
