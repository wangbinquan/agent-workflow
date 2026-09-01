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
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
export {
  createPostgresqlDevelopmentDeliveryProvider,
  createSqliteDevelopmentDeliveryProvider,
} from './infrastructure/developmentDeliveryProvider'
import { runMissionReconcile, type ReconcileOutcome } from './application/missionReconciler'
import {
  createDeferredMissionDrive,
  driveMission,
  type MissionDriveOutcome,
} from './application/missionDriver'
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
import {
  createAttemptContextStore,
  createWorkspaceValidationAdapter,
} from './infrastructure/attemptSupport'
import {
  adoptActionWorkspace,
  discardWorkspace,
  materializeActionWorkspace,
} from './infrastructure/actionWorkspace'
import { EvidenceStore } from './infrastructure/evidenceStore'
import {
  createActionBaselineResolver,
  createPostgresqlRepositoryLocationRead,
  createSqliteRepositoryLocationRead,
} from './infrastructure/gitBaselineReader'
import {
  createRequirementMaterializer,
  type RequirementMaterializer,
  type RequirementSourceRunnerDep,
} from './infrastructure/requirementMaterializer'
import { createSqliteAdmissionLookup } from './infrastructure/sqliteAdmissionLookup'
import { createPostgresqlAdmissionLookup } from './infrastructure/postgresqlAdmissionLookup'
import {
  createSqliteFactSnapshotReader,
  listFencedMissionIds,
  listPreparedEffectRows,
  listUnconsumedWakeHintMissionIds,
  missionEpochsOf,
} from './infrastructure/sqliteReconcilerReaders'
import { createSqliteMissionPersistence } from './infrastructure/sqliteMissionStore'
import { createPostgresqlMissionPersistence } from './infrastructure/postgresqlMissionStore'
import { createSqliteRequirementBundleRefPersistence } from './infrastructure/requirementBundleRefPersistence'
import { createPostgresqlRequirementBundleRefPersistence } from './infrastructure/requirementBundleRefPersistence'
import {
  sweepDevelopmentRetention,
  sweepPostgresqlDevelopmentRetention,
  type RetentionSweepResult,
} from './infrastructure/retentionSweeper'
import type { DevelopmentAutomationMaintenanceCommands } from './public/commands'
import { createSqlitePlaybookSagaPersistence } from './infrastructure/sqlitePlaybookSagaStore'
import { createPostgresqlPlaybookSagaPersistence } from './infrastructure/postgresqlPlaybookSagaStore'
import { createChildMissionParticipant } from './infrastructure/childMissionParticipant'
import {
  createSqliteActionTemplatePersistence,
  createSqliteVerificationProfilePersistence,
} from './infrastructure/sqliteConfigResourceStore'
import {
  createPostgresqlActionTemplatePersistence,
  createPostgresqlVerificationProfilePersistence,
} from './infrastructure/postgresqlConfigResourceStore'
import {
  createPostgresqlRepositoryFactsCollector,
  createRepositoryFactsCollector,
} from './infrastructure/repositoryFactsCollector'
import {
  recordPostgresqlUploadPublicationReceipt,
  recordUploadPublicationReceipt,
} from './infrastructure/uploadPublicationReceipt'
import {
  createRepoScriptResolver,
  runVerificationProfile,
} from './infrastructure/verificationRunner'
import { verificationProfileContentSchema } from './domain/verificationProfile'
import { readUploadPlan } from './infrastructure/sqliteUploadPlanStore'
import { readPostgresqlUploadPlan } from './infrastructure/postgresqlUploadPlanStore'
import {
  createPostgresqlUploadMaintenancePersistence,
  createSqliteUploadMaintenancePersistence,
} from './infrastructure/missionInputUploadPersistence'
import { createUploadPlacementProvider } from './infrastructure/uploadPlacement'
import {
  createPostgresqlUploadPlacementPersistence,
  createSqliteUploadPlacementPersistence,
} from './infrastructure/uploadPlacementPersistence'
import { createPipelineImportAdapter } from './infrastructure/pipelineEvidenceImport'
export {
  createPostgresqlMissionCodeHostEventContinuation,
  createSqliteMissionCodeHostEventContinuation,
} from './infrastructure/missionCodeHostEventContinuation'
import {
  createPostgresqlFactSnapshotReader,
  listPostgresqlFencedMissionIds,
  listPostgresqlPreparedEffectRows,
  listPostgresqlUnconsumedWakeHintMissionIds,
  postgresqlMissionEpochsOf,
} from './infrastructure/postgresqlReconcilerReaders'

export {
  createPostgresqlDevelopmentMissionExecutionTerminalObserver,
  createSqliteDevelopmentMissionExecutionTerminalObserver,
  type DevelopmentMissionExecutionTerminalObserver,
} from './composition/executionTerminalObserver'

/** pipeline evidence 平台收编上限（adapter outputBudget 之外的最后防线）。 */
const PIPELINE_IMPORT_BUDGET = {
  maxFiles: 10_000,
  maxFileBytes: 8 * 1024 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
} as const

export type DevelopmentAdmissionLookup = AdmissionLookup

export function composeSqliteDevelopmentAdmissionLookup(db: DbClient): AdmissionLookup {
  return createSqliteAdmissionLookup(db)
}

export function composePostgresqlDevelopmentAdmissionLookup(
  db: PostgresqlDatabaseClient,
): AdmissionLookup {
  return createPostgresqlAdmissionLookup(db)
}

export const composeSqlitePlaybookSaga = createSqlitePlaybookSagaPersistence
export const composePostgresqlPlaybookSaga = createPostgresqlPlaybookSagaPersistence

/** Worker-bootstrap composition for the context-owned maintenance slice. */
export function composeDevelopmentAutomationMaintenanceCommands(
  db: DbClient,
): DevelopmentAutomationMaintenanceCommands {
  const uploads = createSqliteUploadMaintenancePersistence(db)
  const lookup = composeSqliteDevelopmentAdmissionLookup(db)
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

export function composePostgresqlDevelopmentAutomationMaintenanceCommands(
  db: PostgresqlDatabaseClient,
): DevelopmentAutomationMaintenanceCommands {
  const uploads = createPostgresqlUploadMaintenancePersistence(db)
  const lookup = composePostgresqlDevelopmentAdmissionLookup(db)
  return {
    sweepExpiredUploads: (now, limit) => uploads.sweepExpired(now, limit),
    sweepRetention: (now) =>
      sweepPostgresqlDevelopmentRetention(
        db,
        {
          getPolicyRevisionContent: (id, revision) => lookup.getPolicyRevisionContent(id, revision),
        },
        now,
      ),
  }
}

export interface DevelopmentAutomationModule {
  readonly materializer: RequirementMaterializer
  readonly evidence: EvidenceStore
  /** Business-safe child/approval receipts for Mission detail and journey projection. */
  collaboration(missionId: string): Promise<{
    readonly children: readonly {
      readonly stepRunId: string
      readonly childMissionId: string | null
      readonly status: string | null
      readonly completionSatisfied: boolean
      readonly observedAt: number | null
      readonly deadlineAt: number | null
    }[]
    readonly approvals: readonly {
      readonly stepRunId: string
      readonly externalRequestRef: string | null
      readonly status: string
      readonly nextObserveAt: number | null
      readonly deadlineAt: number
      readonly updatedAt: number
    }[]
  }>
  reconcile(missionId: string): Promise<ReconcileOutcome>
  /** Advance settled platform steps until the next real asynchronous boundary. */
  drive(missionId: string): Promise<MissionDriveOutcome>
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

export interface DevelopmentAutomationCompositionOptions {
  readonly appHome: string
  /** Bootstrap-selected admission configuration provider; direct tests default to SQLite. */
  readonly admissionLookup?: AdmissionLookup
  /** integration 模块组装的外部需求源 runner；不注入 = 外部取件诚实 blocked。 */
  readonly requirementSource?: RequirementSourceRunnerDep
  /** task-execution 模块组装的 agent 执行 runner；不注入 = 动作发射诚实 blocked。 */
  readonly agentLauncher?: AgentActionLauncherPort
  /** task-execution 模块组装的 program 执行 runner；与 Agent 共用 envelope 收口。 */
  readonly scriptLauncher?: ScriptActionLauncherPort
  /** integration 模块组装的外部审批网关；提交/查询/观察均为幂等短调用。 */
  readonly approvalGateway?: ApprovalGatewayPort
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
  const now = (): number => Date.now()
  const store = persistence.store
  const lookup = deps.admissionLookup ?? persistence.admissionLookup
  const snapshots = persistence.snapshots
  const evidence = new EvidenceStore(join(deps.appHome, 'evidence'))
  const materializer = createRequirementMaterializer({
    bundleRefs: persistence.bundleRefs,
    store,
    snapshots,
    evidence,
    stagingRoot: join(deps.appHome, 'evidence', 'staging'),
    ...(deps.requirementSource === undefined ? {} : { source: deps.requirementSource }),
    now,
  })
  const seedsRoot = join(deps.appHome, 'evidence', 'seeds')
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
    }),
    ...(deps.agentLauncher === undefined ? {} : { agentLauncher: deps.agentLauncher }),
    ...(deps.scriptLauncher === undefined ? {} : { scriptLauncher: deps.scriptLauncher }),
    ...(deps.approvalGateway === undefined ? {} : { approvalGateway: deps.approvalGateway }),
    playbookSaga,
    childMissions,
    ...(deps.changeCandidate === undefined ? {} : { changeCandidate: deps.changeCandidate }),
    actionBaseline: { resolve: createActionBaselineResolver(persistence.repositoryLocations) },
    actionWorkspace: {
      materialize: (input) =>
        materializeActionWorkspace(
          { evidence, seedsRoot, workspacesRoot: join(deps.appHome, 'workspaces', 'actions') },
          input,
        ),
      adopt: (input) => adoptActionWorkspace({ evidence }, input),
      discard: discardWorkspace,
    },
    uploadPlanReader: persistence.uploadPlanReader,
    attemptContext: createAttemptContextStore(evidence),
    actionTemplates: {
      content: async (id, revision) => {
        const row = await templates.getRevision(id, revision)
        return row === null ? null : (JSON.parse(row.contentJson) as unknown)
      },
    },
    workspaceValidation: createWorkspaceValidationAdapter(),
    repositoryFacts: persistence.repositoryFacts,
    ...(deps.candidateDelivery === undefined ? {} : { candidateDelivery: deps.candidateDelivery }),
    ...(deps.repoRemote === undefined ? {} : { repoRemote: deps.repoRemote }),
    ...(deps.mrEffects === undefined ? {} : { mrEffects: deps.mrEffects }),
    verificationProfiles: {
      content: async (id, revision) => {
        const row = await verificationProfiles.getRevision(id, revision)
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
    uploadPublication: persistence.uploadPublication,
    ...(deps.pipelineEvidence === undefined ? {} : { pipelineEvidence: deps.pipelineEvidence }),
    ...(deps.mergeRequestFacts === undefined ? {} : { mergeRequestFacts: deps.mergeRequestFacts }),
    // conflict workspace 的宿主根同样必须落 appHome 之下（RFC-308 owner 门；
    // 见 actionWorkspace）——application 层不知道 appHome，装配点补齐。
    ...(deps.conflictMerge === undefined
      ? {}
      : {
          conflictMerge: {
            prepare: (input: Parameters<ConflictMergePort['prepare']>[0]) =>
              deps.conflictMerge!.prepare({
                ...input,
                workspacesRoot: join(deps.appHome, 'workspaces', 'conflicts'),
              }),
            finish: (input: Parameters<ConflictMergePort['finish']>[0]) =>
              deps.conflictMerge!.finish(input),
          },
        }),
    pipelineImport: createPipelineImportAdapter(evidence, PIPELINE_IMPORT_BUDGET),
  }
  const reconcileDeps = { store, lookup, snapshots, ports, now }
  missionDrive.bind(reconcileDeps)

  return {
    materializer,
    evidence,
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

/** SQLite behavior oracle retained behind the same asynchronous application ports. */
export function composeDevelopmentAutomation(
  deps: DevelopmentAutomationCompositionOptions & { readonly db: DbClient },
): DevelopmentAutomationModule {
  const repositories = createSqliteRepositoryLocationRead(deps.db)
  return composeDevelopmentAutomationFromPersistence(deps, {
    store: createSqliteMissionPersistence(deps.db),
    admissionLookup: createSqliteAdmissionLookup(deps.db),
    snapshots: createSqliteFactSnapshotReader(deps.db),
    bundleRefs: createSqliteRequirementBundleRefPersistence(deps.db),
    uploadPlacement: createSqliteUploadPlacementPersistence(deps.db),
    uploadPlanReader: { read: async (planId) => readUploadPlan(deps.db, planId) },
    actionTemplates: createSqliteActionTemplatePersistence(deps.db),
    verificationProfiles: createSqliteVerificationProfilePersistence(deps.db),
    playbookSaga: createSqlitePlaybookSagaPersistence(deps.db),
    repositoryLocations: repositories,
    repositoryFacts: createRepositoryFactsCollector(deps.db),
    uploadPublication: {
      record: async (input) => recordUploadPublicationReceipt(deps.db, input),
    },
    uploads: createSqliteUploadMaintenancePersistence(deps.db),
    wakeReaders: {
      listUnconsumedWakeHintMissionIds: async () => listUnconsumedWakeHintMissionIds(deps.db),
    },
    recoveryReaders: {
      listFencedMissionIds: async () => listFencedMissionIds(deps.db),
      listPreparedEffectRows: async () => listPreparedEffectRows(deps.db),
      missionEpochsOf: async (ids) => missionEpochsOf(deps.db, ids),
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

/** Real PostgreSQL composition. No SQLite client, shadow store or sync bridge is involved. */
export function composePostgresqlDevelopmentAutomation(
  deps: DevelopmentAutomationCompositionOptions & { readonly db: PostgresqlDatabaseClient },
): DevelopmentAutomationModule {
  const repositories = createPostgresqlRepositoryLocationRead(deps.db)
  return composeDevelopmentAutomationFromPersistence(deps, {
    store: createPostgresqlMissionPersistence(deps.db),
    admissionLookup: createPostgresqlAdmissionLookup(deps.db),
    snapshots: createPostgresqlFactSnapshotReader(deps.db),
    bundleRefs: createPostgresqlRequirementBundleRefPersistence(deps.db),
    uploadPlacement: createPostgresqlUploadPlacementPersistence(deps.db),
    uploadPlanReader: { read: (planId) => readPostgresqlUploadPlan(deps.db, planId) },
    actionTemplates: createPostgresqlActionTemplatePersistence(deps.db),
    verificationProfiles: createPostgresqlVerificationProfilePersistence(deps.db),
    playbookSaga: createPostgresqlPlaybookSagaPersistence(deps.db),
    repositoryLocations: repositories,
    repositoryFacts: createPostgresqlRepositoryFactsCollector(deps.db),
    uploadPublication: {
      record: (input) => recordPostgresqlUploadPublicationReceipt(deps.db, input),
    },
    uploads: createPostgresqlUploadMaintenancePersistence(deps.db),
    wakeReaders: {
      listUnconsumedWakeHintMissionIds: () => listPostgresqlUnconsumedWakeHintMissionIds(deps.db),
    },
    recoveryReaders: {
      listFencedMissionIds: () => listPostgresqlFencedMissionIds(deps.db),
      listPreparedEffectRows: () => listPostgresqlPreparedEffectRows(deps.db),
      missionEpochsOf: (ids) => postgresqlMissionEpochsOf(deps.db, ids),
    },
    sweepRetention: (lookup, now) =>
      sweepPostgresqlDevelopmentRetention(
        deps.db,
        {
          getPolicyRevisionContent: (id, revision) => lookup.getPolicyRevisionContent(id, revision),
        },
        now,
      ),
  })
}
