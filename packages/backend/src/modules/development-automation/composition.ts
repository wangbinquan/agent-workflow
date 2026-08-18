// development-automation 装配入口（RFC-310）。
//
// 仅装配点可 import 本文件；它只做实例化与注入——不查 DB、无业务 if/switch、
// 不翻译 DTO（RFC-294 §2；本文件的「无业务分支」由 rfc310-architecture-lock
// 文本扫描强制）。消费者账本在 rfc310-architecture-lock.test.ts，增删一条都要
// 显式修订。PR-3 起真实装配：EvidenceStore、requirement materializer、upload
// placement、reconciler deps 与 sweep/recover 用例的读侧绑定。
// requirementSource（外部取件 runner）由装配点注入——它由 integration 模块
// 组装（modules/integration/composition/requirementSource.ts），本文件不得
// 跨 context import 其内部（rfc294 preflight 债务账本为空增长）。
// Agent launcher / MR·pipeline collector 端口随 PR-5/PR-6/PR-7 注入。

import { join } from 'node:path'

import type { DbClient } from '@/db/client'
import {
  runMissionReconcile,
  type ReconcileDeps,
  type ReconcileOutcome,
} from './application/missionReconciler'
import { recoverMissions } from './application/missionRecovery'
import { confirmNoChange, type ConfirmNoChangeResult } from './application/commands/confirmNoChange'
import {
  submitMissionAnswers,
  type SubmitAnswersResult,
} from './application/commands/submitMissionAnswers'
import {
  attachMergeRequest,
  handoffMission,
  resumeMission,
} from './application/commands/missionHandover'
import { sweepMissionWakes } from './application/missionWakeSweep'
import type {
  AgentActionLauncherPort,
  CandidateDeliveryPort,
  ChangeCandidatePort,
  ConflictMergePort,
  MergeRequestFactsCollectorPort,
  MrEffectsPort,
  PipelineEvidencePort,
  ReconcilerPorts,
  RepoRemotePort,
} from './application/ports/reconcilerPorts'
import {
  createAttemptContextStore,
  createWorkspaceValidationAdapter,
} from './infrastructure/attemptSupport'
import { discardWorkspace, materializeActionWorkspace } from './infrastructure/actionWorkspace'
import { EvidenceStore } from './infrastructure/evidenceStore'
import { resolveActionBaseline } from './infrastructure/gitBaselineReader'
import {
  createRequirementMaterializer,
  type RequirementMaterializer,
  type RequirementSourceRunnerDep,
} from './infrastructure/requirementMaterializer'
import { createSqliteAdmissionLookup } from './infrastructure/sqliteAdmissionLookup'
import {
  createSqliteFactSnapshotReader,
  listFencedMissionIds,
  listPreparedEffectRows,
  listUnconsumedWakeHintMissionIds,
  missionEpochsOf,
} from './infrastructure/sqliteReconcilerReaders'
import { createSqliteMissionStore } from './infrastructure/sqliteMissionStore'
import {
  createSqliteActionTemplateStore,
  createSqliteVerificationProfileStore,
} from './infrastructure/sqliteConfigResourceStore'
import { createRepositoryFactsCollector } from './infrastructure/repositoryFactsCollector'
import { recordUploadPublicationReceipt } from './infrastructure/uploadPublicationReceipt'
import {
  createRepoScriptResolver,
  runVerificationProfile,
} from './infrastructure/verificationRunner'
import { verificationProfileContentSchema } from './domain/verificationProfile'
import { readUploadPlan } from './infrastructure/sqliteUploadPlanStore'
import { createSqliteUploadSessionStore } from './infrastructure/sqliteUploadSessionStore'
import { createUploadPlacementProvider } from './infrastructure/uploadPlacement'
import { createPipelineImportAdapter } from './infrastructure/pipelineEvidenceImport'

/** pipeline evidence 平台收编上限（adapter outputBudget 之外的最后防线）。 */
const PIPELINE_IMPORT_BUDGET = {
  maxFiles: 10_000,
  maxFileBytes: 8 * 1024 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
} as const

export interface DevelopmentAutomationModule {
  readonly materializer: RequirementMaterializer
  readonly evidence: EvidenceStore
  reconcile(missionId: string): Promise<ReconcileOutcome>
  /** T55a：no-change 人工确认（唯一能进入 completed-no-change 的通道）。 */
  confirmNoChange(rawInput: unknown): Promise<ConfirmNoChangeResult>
  /** 平台渠道答题（T55：新 revision 会失效 in-flight action）。 */
  submitAnswers(rawInput: unknown): Promise<SubmitAnswersResult>
  /** T80：交接三命令（完整 ports——handoff 撤销含真 agent cancel）。 */
  handoff(rawInput: unknown): ReturnType<typeof handoffMission>
  attachMr(rawInput: unknown): ReturnType<typeof attachMergeRequest>
  resume(rawInput: unknown): ReturnType<typeof resumeMission>
  /** 30s 级 sweep：到期 durable wake（fireWake CAS 认领）+ 未消费 wake hint。 */
  sweepWakes(): Promise<{ reconciled: number }>
  /** hourly：未 claim 上传的 TTL 回收。 */
  sweepUploads(): { swept: number }
  /** daemon 启动恢复：fence 悬挂 / epoch 过期 effect / 到期 wake。 */
  recover(): Promise<{ settledFences: number; invalidatedEffects: number; firedWakes: number }>
}

export function composeDevelopmentAutomation(deps: {
  readonly db: DbClient
  readonly appHome: string
  /** integration 模块组装的外部需求源 runner；不注入 = 外部取件诚实 blocked。 */
  readonly requirementSource?: RequirementSourceRunnerDep
  /** task-execution 模块组装的 agent 执行 runner；不注入 = 动作发射诚实 blocked。 */
  readonly agentLauncher?: AgentActionLauncherPort
  /** source-control 模块组装的 candidate 派生；不注入 = changed 结算诚实 blocked。 */
  readonly changeCandidate?: ChangeCandidatePort
  /** source-control 模块组装的发布链（stage/commit/push）；不注入 = 发布诚实 blocked。 */
  readonly candidateDelivery?: CandidateDeliveryPort
  /** 装配点解析 repository remote（凭据 URL 解封在装配点）；不注入 = push/MR 诚实 blocked。 */
  readonly repoRemote?: RepoRemotePort
  /** integration 模块组装的 code-host MR effects；不注入 = ensure-MR 诚实 blocked。 */
  readonly mrEffects?: MrEffectsPort
  /** integration 模块组装的 pipeline provider 执行面；不注入 = pipeline 诚实 blocked。 */
  readonly pipelineEvidence?: PipelineEvidencePort
  /** 装配点组装的 MR facts 采集面；不注入 = collect-mr-facts 诚实 blocked。 */
  readonly mergeRequestFacts?: MergeRequestFactsCollectorPort
  /** source-control 组装的 conflict merge（prepare/finish）；Agent 面接线前端口先备。 */
  readonly conflictMerge?: ConflictMergePort
}): DevelopmentAutomationModule {
  const now = (): number => Date.now()
  const store = createSqliteMissionStore(deps.db)
  const lookup = createSqliteAdmissionLookup(deps.db)
  const snapshots = createSqliteFactSnapshotReader(deps.db)
  const evidence = new EvidenceStore(join(deps.appHome, 'evidence'))
  const materializer = createRequirementMaterializer({
    db: deps.db,
    store,
    snapshots,
    evidence,
    stagingRoot: join(deps.appHome, 'evidence', 'staging'),
    ...(deps.requirementSource === undefined ? {} : { source: deps.requirementSource }),
    now,
  })
  const uploads = createSqliteUploadSessionStore(deps.db)
  const seedsRoot = join(deps.appHome, 'evidence', 'seeds')
  const templates = createSqliteActionTemplateStore(deps.db)
  const verificationProfiles = createSqliteVerificationProfileStore(deps.db)
  const ports: ReconcilerPorts = {
    requirementMaterialize: materializer,
    uploadPlacement: createUploadPlacementProvider({
      db: deps.db,
      evidence,
      seedsRoot,
      now,
    }),
    ...(deps.agentLauncher === undefined ? {} : { agentLauncher: deps.agentLauncher }),
    ...(deps.changeCandidate === undefined ? {} : { changeCandidate: deps.changeCandidate }),
    actionBaseline: { resolve: resolveActionBaseline(deps.db) },
    actionWorkspace: {
      materialize: (input) =>
        materializeActionWorkspace(
          { evidence, seedsRoot, workspacesRoot: join(deps.appHome, 'workspaces', 'actions') },
          input,
        ),
      discard: discardWorkspace,
    },
    uploadPlanReader: { read: (planId) => readUploadPlan(deps.db, planId) },
    attemptContext: createAttemptContextStore(evidence),
    actionTemplates: {
      content: (id, revision) => {
        const row = templates.getRevision(id, revision)
        return row === null ? null : (JSON.parse(row.contentJson) as unknown)
      },
    },
    workspaceValidation: createWorkspaceValidationAdapter(),
    repositoryFacts: createRepositoryFactsCollector(deps.db),
    ...(deps.candidateDelivery === undefined ? {} : { candidateDelivery: deps.candidateDelivery }),
    ...(deps.repoRemote === undefined ? {} : { repoRemote: deps.repoRemote }),
    ...(deps.mrEffects === undefined ? {} : { mrEffects: deps.mrEffects }),
    verificationProfiles: {
      content: (id, revision) => {
        const row = verificationProfiles.getRevision(id, revision)
        return row === null ? null : (JSON.parse(row.contentJson) as unknown)
      },
    },
    verificationExecution: {
      run: (input) =>
        runVerificationProfile(
          { evidence, resolver: createRepoScriptResolver() },
          {
            workspacePath: input.workspacePath,
            profile: verificationProfileContentSchema.parse(input.profile),
          },
        ),
    },
    uploadPublication: {
      record: (input) => recordUploadPublicationReceipt(deps.db, input),
    },
    ...(deps.pipelineEvidence === undefined ? {} : { pipelineEvidence: deps.pipelineEvidence }),
    ...(deps.mergeRequestFacts === undefined ? {} : { mergeRequestFacts: deps.mergeRequestFacts }),
    ...(deps.conflictMerge === undefined ? {} : { conflictMerge: deps.conflictMerge }),
    pipelineImport: createPipelineImportAdapter(evidence, PIPELINE_IMPORT_BUDGET),
  }
  const reconcileDeps: ReconcileDeps = { store, lookup, snapshots, ports, now }

  return {
    materializer,
    evidence,
    reconcile: (missionId) => runMissionReconcile(reconcileDeps, missionId),
    confirmNoChange: (rawInput) => confirmNoChange(reconcileDeps, rawInput),
    handoff: (rawInput) => handoffMission(reconcileDeps, rawInput),
    attachMr: (rawInput) => attachMergeRequest(reconcileDeps, rawInput),
    resume: (rawInput) => resumeMission(reconcileDeps, rawInput),
    submitAnswers: (rawInput) =>
      submitMissionAnswers({ store, snapshots, requirement: materializer, ports, now }, rawInput),
    sweepWakes: () =>
      sweepMissionWakes(reconcileDeps, {
        listUnconsumedWakeHintMissionIds: () => listUnconsumedWakeHintMissionIds(deps.db),
      }),
    sweepUploads: () => ({ swept: uploads.sweepExpired(now()) }),
    recover: () =>
      recoverMissions(reconcileDeps, {
        listFencedMissionIds: () => listFencedMissionIds(deps.db),
        listPreparedEffectRows: () => listPreparedEffectRows(deps.db),
        missionEpochsOf: (ids) => missionEpochsOf(deps.db, ids),
      }),
  }
}
