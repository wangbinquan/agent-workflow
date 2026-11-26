import type { EvidenceStagingFactory } from './application/ports/evidenceStaging'
import { selectedRequirementMaterializerContent } from './application/evidenceStaging'
import type { AutomationWorkspaceEffectsFactory } from './application/ports/automationWorkspaceEffects'
export type { AutomationWorkspaceEffectsFactory }
import { selectedAutomationWorkspaceEffects } from './infrastructure/automationWorkspaceEffects'
import type { ActionWorkspaceEffects } from './application/ports/actionWorkspaceEffects'
import { selectActionWorkspaceEffects } from './infrastructure/actionWorkspaceEffects'
export type { ActionWorkspaceEffects }
export { selectDevelopmentWorkspaceEffectBinding } from './infrastructure/actionWorkspaceEffects'
// RFC-431: the standalone profile's local selections (the hosted profile selects its own).
export { createFileActionWorkspaceEffects } from './infrastructure/local/fileActionWorkspaceEffects'
export { createFileRepositoryBaselineEffectsFactory } from './infrastructure/local/fileRepositoryBaselineEffects'
import type { RepositoryBaselineEffectsFactory } from './application/ports/repositoryBaselineEffects'
import type { VerificationCommandEffectsFactory } from './application/ports/verificationCommandEffects'
export type { VerificationCommandEffectsFactory }
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

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
export { createDevelopmentDeliveryProvider } from './infrastructure/developmentDeliveryProvider'
import { runMissionReconcile, type ReconcileOutcome } from './application/missionReconciler'
import { createDeferredMissionDrive, driveMission } from './application/missionDriver'
import { recoverMissions } from './application/missionRecovery'
import { confirmNoChange } from './application/commands/confirmNoChange'
import { submitMissionAnswers } from './application/commands/submitMissionAnswers'
import {
  attachMergeRequest,
  handoffMission,
  resumeMission,
} from './application/commands/missionHandover'
import { sweepMissionWakes } from './application/missionWakeSweep'
export { type DevelopmentWriterCutover } from './application/writerCutoverGates'
import type {
  AgentActionLauncherPort,
  ApprovalGatewayPort,
  CandidateDeliveryPort,
  ChangeCandidatePort,
  ConflictMergePort,
  MergeRequestFactsCollectorPort,
  MrEffectsPort,
  PipelineEvidencePort,
  ReconcilerPorts,
  RepoRemotePort,
  ScriptActionLauncherPort,
  FactSnapshotReader,
  RepositoryFactsCollectorPort,
  UploadPlanReaderPort,
  UploadPublicationPort,
} from './application/ports/reconcilerPorts'
import type { AdmissionLookup } from './application/ports/admissionLookup'
import type { DevelopmentMissionAutomation } from './application/ports/developmentMissionAutomation'
import type { MissionPersistence } from './application/ports/missionStore'
import type { PlaybookSagaPersistence } from './application/ports/playbookSagaStore'
import type {
  ActionTemplatePersistence,
  VerificationProfilePersistence,
} from './application/ports/configResourceStore'
import type { RequirementBundleRefPersistence } from './application/ports/requirementBundleRefStore'
import type { RepositoryLocationRead } from './application/ports/repositoryLocationRead'
import type { UploadMaintenancePersistence } from './application/ports/uploadMaintenance'
import type { UploadPlacementPersistence } from './application/ports/uploadPlacementStore'
import type { RecoveryReaders } from './application/missionRecovery'
import type { WakeSweepReaders } from './application/missionWakeSweep'
import { createWorkspaceValidationAdapter } from './infrastructure/attemptSupport'
import { adoptActionWorkspace, materializeActionWorkspace } from './application/actionWorkspace'
import type { EvidenceDocumentCommands } from './application/evidenceDocumentCommands'
export type { EvidenceDocumentCommands }
import type { EvidenceArtifactPort } from './application/ports/evidenceArtifacts'
export type { EvidenceArtifactPort }
import type { AttemptContextStorePort } from './application/ports/attemptContextStore'
export type { AttemptContextStorePort }
// RFC-566: the development purpose selection (the deployment's three purposes) is declared in bootstrap, which is the only
// reader — this root no longer names Integration's adapter bindings or its pipeline execution type. The selection's
// pipeline staging is this module's, handed to bootstrap as a type.
export type { PipelineStagingFactories } from './application/ports/evidenceStaging'
import {
  createActionBaselineResolver,
  createRepositoryLocationRead,
} from './infrastructure/gitBaselineReader'
import {
  createSelectedRequirementMaterializer,
  type RequirementSourceRunnerDep,
} from './application/requirementMaterializer'
import { createAdmissionLookup } from './infrastructure/admissionLookup'
import {
  createFactSnapshotReader,
  listFencedMissionIds,
  listPreparedEffectRows,
  listUnconsumedWakeHintMissionIds,
  missionEpochsOf,
} from './infrastructure/reconcilerReaders'
import { createMissionPersistence } from './infrastructure/missionStore'
import { createRequirementBundleRefPersistence } from './infrastructure/requirementBundleRefPersistence'
import {
  sweepDevelopmentRetention,
  type RetentionSweepResult,
} from './infrastructure/retentionSweeper'
import type { DevelopmentAutomationMaintenanceCommands } from './public/commands'
import { createPlaybookSagaPersistence } from './infrastructure/playbookSagaStore'
import { createChildMissionParticipant } from './infrastructure/childMissionParticipant'
import {
  createActionTemplatePersistence,
  createVerificationProfilePersistence,
} from './infrastructure/configResourceStore'
import { createRepositoryFactsCollector } from './infrastructure/repositoryFactsCollector'
import { repositoryFactsScannerOf } from './composition/repositoryFactsScanner'
import { recordUploadPublicationReceipt } from './infrastructure/uploadPublicationReceipt'
import { runVerificationProfileWithEffects } from './application/verificationRunner'
import { verificationProfileContentSchema } from './domain/verificationProfile'
import { readUploadPlan } from './infrastructure/uploadPlanStore'
import { createUploadMaintenancePersistence } from './infrastructure/missionInputUploadPersistence'
import { createUploadPlacementProvider } from './infrastructure/uploadPlacement'
import { createUploadPlacementPersistence } from './infrastructure/uploadPlacementPersistence'
import { createSelectedPipelineImportAdapter } from './application/pipelineEvidenceImport'
export { createMissionCodeHostEventContinuation } from './infrastructure/missionCodeHostEventContinuation'

export {
  createDevelopmentMissionExecutionTerminalObserver,
  type DevelopmentMissionExecutionTerminalObserver,
} from './composition/executionTerminalObserver'

/** pipeline evidence 平台收编上限（adapter outputBudget 之外的最后防线）。 */
const PIPELINE_IMPORT_BUDGET = {
  maxFiles: 10_000,
  maxFileBytes: 8 * 1024 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
} as const

export type DevelopmentAdmissionLookup = AdmissionLookup

/** 一份装配，两个 provider 共用（RFC-359 W4-D12）。 */
export function composeDevelopmentAdmissionLookup(db: PersistenceDb): AdmissionLookup {
  return createAdmissionLookup(db)
}

export const composePlaybookSaga = createPlaybookSagaPersistence

/** Worker-bootstrap composition for the context-owned maintenance slice（一份装配，两个 provider 共用）. */
export function composeDevelopmentAutomationMaintenanceCommands(
  db: PersistenceDb,
): DevelopmentAutomationMaintenanceCommands {
  const uploads = createUploadMaintenancePersistence(db)
  const lookup = composeDevelopmentAdmissionLookup(db)
  return {
    sweepExpiredUploads: (now, limit) => uploads.sweepExpired(now, limit),
    sweepRetention: (now) =>
      sweepDevelopmentRetention(
        db,
        {
          getPolicyRevisionContent: (id, revision) => lookup.getPolicyRevisionContent(id, revision),
        },
        now,
      ),
  }
}

/** RFC-497: the members the Mission operations use are their application port; this participant adds the rest. */
export interface DevelopmentAutomationModule extends DevelopmentMissionAutomation {
  readonly evidence: EvidenceArtifactPort
  reconcile(missionId: string): Promise<ReconcileOutcome>
  /** 30s 级 sweep：到期 durable wake（fireWake CAS 认领）+ 未消费 wake hint。 */
  sweepWakes(): Promise<{ reconciled: number }>
  /** hourly：未 claim 上传的 TTL 回收。 */
  sweepUploads(): Promise<{ swept: number }>
  /**
   * RFC-310 T71 —— hourly retention 执行：终态 Mission 的已结算 attempt 台账按
   * `attemptLedgerTtlDays` 清理、证据指针按 `requirementBundleTerminalTtlDays`
   * 标 expired。**不删 evidence blob**（缺完整引用索引，见 retentionSweeper 顶注）。
   */
  sweepRetention(): Promise<RetentionSweepResult>
  /** daemon 启动恢复：fence 悬挂 / epoch 过期 effect / 到期 wake。 */
  recover(): Promise<{ settledFences: number; invalidatedEffects: number; firedWakes: number }>
}

/**
 * RFC-597 (RFC-294 W4-E8 first step): the providers other modules implement, all required — the daemon gives every one,
 * and a deployment that leaves one out no longer type-checks (dual-provider-parity-audit-2026-09-04 F-H2-2: the PostgreSQL
 * daemon once composed this module without either launcher, and every action was blocked `*-launcher-not-wired`).
 * RFC-603: `ReconcilerPorts` is required too, and each command or publication chain takes only the ports it reads.
 */
export interface DevelopmentAutomationProviders {
  /** integration 模块组装的外部需求源 runner。 */
  readonly requirementSource: RequirementSourceRunnerDep
  /** task-execution 模块组装的 agent 执行 runner。 */
  readonly agentLauncher: AgentActionLauncherPort
  /** task-execution 模块组装的 program 执行 runner；与 Agent 共用 envelope 收口。 */
  readonly scriptLauncher: ScriptActionLauncherPort
  /** integration 模块组装的外部审批网关；提交/查询/观察均为幂等短调用。 */
  readonly approvalGateway: ApprovalGatewayPort
  /** source-control 模块组装的 candidate 派生。 */
  readonly changeCandidate: ChangeCandidatePort
  /** source-control 模块组装的发布链（stage/commit/push）。 */
  readonly candidateDelivery: CandidateDeliveryPort
  /** 装配点解析 repository remote（凭据 URL 解封在装配点）。 */
  readonly repoRemote: RepoRemotePort
  /** integration 模块组装的 code-host MR effects。 */
  readonly mrEffects: MrEffectsPort
  /** integration 模块组装的 pipeline provider 执行面。 */
  readonly pipelineEvidence: PipelineEvidencePort
  /** 装配点组装的 MR facts 采集面。 */
  readonly mergeRequestFacts: MergeRequestFactsCollectorPort
  /** source-control 组装的 conflict merge（prepare/finish/discard）；工作区根由本装配补齐。 */
  readonly conflictMerge: ConflictMergePort
}

export interface DevelopmentAutomationCompositionOptions extends DevelopmentAutomationProviders {
  readonly verificationCommands: VerificationCommandEffectsFactory
  /** RFC-598: the deployment's three effect selections are stated (the daemon gives all three; tests give the local ones). */
  readonly actionWorkspaceEffects: ActionWorkspaceEffects
  readonly automationWorkspaceEffects: AutomationWorkspaceEffectsFactory
  readonly repositoryBaselines: RepositoryBaselineEffectsFactory
  readonly appHome: string
  /**
   * RFC-524: the deployment's evidence artifacts (required; the composition no longer builds a local store). RFC-598:
   * its members are the only source of evidence reads, downloads, documents and attempt contexts.
   */
  readonly evidenceArtifacts: EvidenceArtifactPort
  /** RFC-524: the requirement purpose's writer and staging (required, as in bootstrap's `RequirementPurposeSelection`). */
  readonly evidenceDocumentCommands: EvidenceDocumentCommands
  readonly requirementStaging: EvidenceStagingFactory
  /** Bootstrap-selected admission configuration provider (RFC-524: required). */
  readonly admissionLookup: AdmissionLookup
}

interface DevelopmentAutomationPersistenceBundle {
  readonly store: MissionPersistence
  readonly admissionLookup: AdmissionLookup
  readonly snapshots: FactSnapshotReader
  readonly bundleRefs: RequirementBundleRefPersistence
  readonly uploadPlacement: UploadPlacementPersistence
  readonly uploadPlanReader: UploadPlanReaderPort
  readonly actionTemplates: ActionTemplatePersistence
  readonly verificationProfiles: VerificationProfilePersistence
  readonly playbookSaga: PlaybookSagaPersistence
  readonly repositoryLocations: RepositoryLocationRead
  readonly repositoryFacts: RepositoryFactsCollectorPort
  readonly uploadPublication: UploadPublicationPort
  readonly uploads: UploadMaintenancePersistence
  readonly wakeReaders: WakeSweepReaders
  readonly recoveryReaders: RecoveryReaders
  sweepRetention(reader: AdmissionLookup, now: number): Promise<RetentionSweepResult>
}

function composeDevelopmentAutomationFromPersistence(
  deps: DevelopmentAutomationCompositionOptions,
  persistence: DevelopmentAutomationPersistenceBundle,
): DevelopmentAutomationModule {
  const actionWorkspaceEffects = selectActionWorkspaceEffects(deps.actionWorkspaceEffects)
  const factory = selectedAutomationWorkspaceEffects(deps.automationWorkspaceEffects)

  const now = (): number => Date.now()
  const store = persistence.store
  const lookup = persistence.admissionLookup
  const snapshots = persistence.snapshots
  const evidence = deps.evidenceArtifacts
  const evidenceContents = evidence.contents
  const evidenceDownloads = evidence.downloads
  const materializer = createSelectedRequirementMaterializer({
    ...selectedRequirementMaterializerContent({
      staging: deps.requirementStaging,
      documentCommands: deps.evidenceDocumentCommands,
    }),
    bundleRefs: persistence.bundleRefs,
    store,
    snapshots,
    evidence,
    source: deps.requirementSource,
    now,
  })
  const seedsRoot = factory.resolve(
    factory.applicationRootReference ?? deps.appHome,
    'evidence',
    'seeds',
  )
  const templates = persistence.actionTemplates
  const verificationProfiles = persistence.verificationProfiles
  const playbookSaga = persistence.playbookSaga
  // Child Mission 的 drive 回调与本模块互相引用，但不会在装配期间执行；先
  // 声明完整依赖，再由标准 admission/materialization 路径创建或接续子任务。
  const missionDrive = createDeferredMissionDrive()
  const childMissions = createChildMissionParticipant({
    launch: { store, lookup, now },
    store,
    materializer,
    drive: missionDrive.drive,
    now,
  })
  const ports: ReconcilerPorts = {
    requirementMaterialize: materializer,
    uploadPlacement: createUploadPlacementProvider({
      persistence: persistence.uploadPlacement,
      evidence,
      seedsRoot,
      now,
      workspace: factory,
    }),
    agentLauncher: deps.agentLauncher,
    scriptLauncher: deps.scriptLauncher,
    approvalGateway: deps.approvalGateway,
    playbookSaga,
    childMissions,
    changeCandidate: deps.changeCandidate,
    actionBaseline: {
      resolve: createActionBaselineResolver(
        persistence.repositoryLocations,
        deps.repositoryBaselines,
      ),
    },
    actionWorkspace: {
      materialize: (input) =>
        materializeActionWorkspace(
          {
            evidence,
            seedsRoot,
            workspacesRoot: factory.resolve(
              factory.applicationRootReference ?? deps.appHome,
              'workspaces',
              'actions',
            ),
          },
          input,
          actionWorkspaceEffects,
        ),
      adopt: (input) => adoptActionWorkspace({ evidence }, input, actionWorkspaceEffects),
      discard: (reference) => actionWorkspaceEffects.discard(reference),
    },
    uploadPlanReader: persistence.uploadPlanReader,
    attemptContext: evidence.contexts,
    actionTemplates: {
      content: async (id, revision) => {
        const row = await templates.getRevision(id, revision)
        return row === null ? null : (JSON.parse(row.contentJson) as unknown)
      },
    },
    workspaceValidation: createWorkspaceValidationAdapter(factory),
    repositoryFacts: persistence.repositoryFacts,
    candidateDelivery: deps.candidateDelivery,
    repoRemote: deps.repoRemote,
    mrEffects: deps.mrEffects,
    verificationProfiles: {
      content: async (id, revision) => {
        const row = await verificationProfiles.getRevision(id, revision)
        return row === null ? null : (JSON.parse(row.contentJson) as unknown)
      },
    },
    verificationExecution: {
      run: (input) =>
        runVerificationProfileWithEffects(deps.verificationCommands.create({ evidence }), {
          workspacePath: input.workspacePath,
          profile: verificationProfileContentSchema.parse(input.profile),
        }),
    },
    uploadPublication: persistence.uploadPublication,
    pipelineEvidence: deps.pipelineEvidence,
    mergeRequestFacts: deps.mergeRequestFacts,
    // conflict workspace 的宿主根同样必须落 appHome 之下（RFC-308 owner 门；
    // 见 actionWorkspace）——application 层不知道 appHome，装配点补齐。
    conflictMerge: {
      prepare: (input: Parameters<ConflictMergePort['prepare']>[0]) =>
        deps.conflictMerge.prepare({
          ...input,
          workspacesRoot: factory.resolve(
            factory.applicationRootReference ?? deps.appHome,
            'workspaces',
            'conflicts',
          ),
        }),
      finish: (input: Parameters<ConflictMergePort['finish']>[0]) =>
        deps.conflictMerge.finish(input),
      discard: (input: Parameters<ConflictMergePort['discard']>[0]) =>
        deps.conflictMerge.discard(input),
    },
    pipelineImport: createSelectedPipelineImportAdapter(PIPELINE_IMPORT_BUDGET),
  }
  const reconcileDeps = { store, lookup, snapshots, ports, now }
  missionDrive.bind(reconcileDeps)

  return {
    materializer,
    evidence,
    evidenceContents,
    evidenceDownloads,
    async collaboration(missionId) {
      const links = await playbookSaga.listMissionLinks(missionId)
      const children = await Promise.all(
        links.map(async (link) => ({
          stepRunId: link.parentStepRunId,
          childMissionId: link.childMissionId,
          status: link.latestStatus,
          completionSatisfied: link.completionSatisfied,
          observedAt: link.observedAt,
          deadlineAt: (await playbookSaga.getStepRun(link.parentStepRunId))?.deadlineAt ?? null,
        })),
      )
      const approvals = (await playbookSaga.listApprovalSagas(missionId)).map((approval) => ({
        stepRunId: approval.stepRunId,
        externalRequestRef: approval.externalRequestRef,
        status: approval.latestStatus,
        nextObserveAt: approval.nextObserveAt,
        deadlineAt: approval.deadlineAt,
        updatedAt: approval.updatedAt,
      }))
      return { children, approvals }
    },
    reconcile: (missionId) => runMissionReconcile(reconcileDeps, missionId),
    drive: (missionId) => driveMission(reconcileDeps, missionId),
    confirmNoChange: (rawInput) => confirmNoChange(reconcileDeps, rawInput),
    handoff: (rawInput) => handoffMission(reconcileDeps, rawInput),
    attachMr: (rawInput) => attachMergeRequest(reconcileDeps, rawInput),
    resume: (rawInput) => resumeMission(reconcileDeps, rawInput),
    submitAnswers: (rawInput) =>
      submitMissionAnswers({ store, snapshots, requirement: materializer, ports, now }, rawInput),
    sweepWakes: () => sweepMissionWakes(reconcileDeps, persistence.wakeReaders),
    sweepUploads: async () => ({ swept: await persistence.uploads.sweepExpired(now(), 1_000) }),
    sweepRetention: () => persistence.sweepRetention(lookup, now()),
    recover: () => recoverMissions(reconcileDeps, persistence.recoveryReaders),
  }
}

/** 一份装配，两个 provider 共用：每个持久化入口都已是中立实现（RFC-359 W4-D12）。 */
export function composeDevelopmentAutomation(
  deps: DevelopmentAutomationCompositionOptions & { readonly db: PersistenceDb },
): DevelopmentAutomationModule {
  const repositories = createRepositoryLocationRead(deps.db)
  return composeDevelopmentAutomationFromPersistence(deps, {
    store: createMissionPersistence(deps.db),
    admissionLookup: deps.admissionLookup,
    snapshots: createFactSnapshotReader(deps.db),
    bundleRefs: createRequirementBundleRefPersistence(deps.db),
    uploadPlacement: createUploadPlacementPersistence(deps.db),
    uploadPlanReader: { read: (planId) => readUploadPlan(deps.db, planId) },
    actionTemplates: createActionTemplatePersistence(deps.db),
    verificationProfiles: createVerificationProfilePersistence(deps.db),
    playbookSaga: createPlaybookSagaPersistence(deps.db),
    repositoryLocations: repositories,
    // RFC-370 §10 V18 (a): a volume selection scans where the repository lives.
    repositoryFacts: createRepositoryFactsCollector(
      deps.db,
      repositoryFactsScannerOf(deps.automationWorkspaceEffects),
    ),
    uploadPublication: {
      record: (input) => recordUploadPublicationReceipt(deps.db, input),
    },
    uploads: createUploadMaintenancePersistence(deps.db),
    wakeReaders: {
      listUnconsumedWakeHintMissionIds: () => listUnconsumedWakeHintMissionIds(deps.db),
    },
    recoveryReaders: {
      listFencedMissionIds: () => listFencedMissionIds(deps.db),
      listPreparedEffectRows: () => listPreparedEffectRows(deps.db),
      missionEpochsOf: (ids) => missionEpochsOf(deps.db, ids),
    },
    sweepRetention: (lookup, now) =>
      sweepDevelopmentRetention(
        deps.db,
        {
          getPolicyRevisionContent: (id, revision) => lookup.getPolicyRevisionContent(id, revision),
        },
        now,
      ),
  })
}

export type { RepositoryBaselineEffectsFactory } from './application/ports/repositoryBaselineEffects'

export { schemaContribution } from './composition/schema'

// RFC-399 B1: bootstrap's maintenance job table takes these handlers via composition.
export { createDevelopmentAutomationMaintenanceJobHandlers } from './application/maintenanceJobs'
/**
 * RFC-436: development-automation mounts its own case-scoped routes (graph
 * design routes and the activity operation) right after the digital-employee
 * routes; bootstrap supplies the case authorization.
 */
export {
  mountDevelopmentCaseRoutes,
  type DevelopmentCaseRoutes,
} from './inbound/http/employeeCaseRoutes'
// RFC-579: the development config, mission and mission-input upload HTTP bindings joined this module's inbound layer.
export { mountDevelopmentConfigRoutes } from './inbound/http/developmentConfigRoutes'
export { mountDevelopmentMissionRoutes } from './inbound/http/developmentMissionRoutes'
export { mountMissionInputUploadRoutes } from './inbound/http/missionInputUploadRoutes'

// RFC-518: the CrewStation / task-image adapters live in infrastructure/crewstation; bootstrap takes them here.
export { composeCrewStationDevelopmentEvidence } from './infrastructure/crewstation/crewstationEvidence'
export { composeCrewStationEvidenceStaging } from './infrastructure/crewstation/crewstationEvidenceStaging'
export { createCrewStationVerificationCommandEffectsFactory } from './infrastructure/crewstation/crewstationVerification'
export { composeCrewStationDevelopmentWorkspaces } from './infrastructure/crewstation/crewstationWorkspace'
export { executeTaskImageEvidence } from './infrastructure/crewstation/taskImageEvidence'
export { executeTaskImageVerification } from './infrastructure/crewstation/taskImageVerification'
export {
  executeTaskImageDevelopmentOperation,
  TASK_IMAGE_DEVELOPMENT_OPERATIONS,
} from './infrastructure/crewstation/taskImageWorkspace'
