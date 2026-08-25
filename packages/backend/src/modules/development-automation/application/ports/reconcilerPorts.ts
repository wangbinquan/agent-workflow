// RFC-310 PR-2 —— reconciler 消费的窄执行端口（T26）。
//
// application 层只认这些接口；生产实现由 provider adapter 经装配点注入
// （repository facts 采集归 PR-5 T53、MR facts 归 PR-7 T72、effect 执行与
// Agent launch 归 PR-4/PR-5、upload placement 归 PR-3 T36a），测试注入 typed
// fake。端口缺席不是静默跳过：对应 decision arm 会以 typed block
// （`*-not-wired`）落库——「没接上」必须可见（dev-gotchas「缺席的接线不会红」
// 教训的反向设计）。

import type { FactCellValue } from '../../domain/facts'
import type { FactCell } from '../../domain/factCell'
import type { OperationFailureReceipt } from '../../domain/operationFailure'
import type {
  ApprovalObservationReceipt,
  ApprovalReceipt,
  ApprovalSubmitIntent,
  ChildMissionIntent,
  ChildMissionReceipt,
} from '../../domain/stepSaga'
import type { PlaybookSagaStore } from './playbookSagaStore'
import type { RepositoryPublicationReceipt } from '@agent-workflow/shared'

export interface RepositoryFactsCollectorPort {
  collect(input: { readonly missionId: string; readonly repositoryId: string }): Promise<{
    readonly cells: Record<string, FactCell<FactCellValue>>
    readonly factsRef: string
  }>
}

export interface MergeRequestFactsCollectorPort {
  collect(input: { readonly missionId: string; readonly mrClaimId: string | null }): Promise<{
    readonly cells: Record<string, FactCell<FactCellValue>>
    readonly snapshotRef: string
    readonly headSha: string | null
    readonly targetSha: string | null
    /** PR-7 T72/T73：thread 明细（feedback 台账 upsert 的素材；closed 形状）。 */
    readonly threads?: readonly {
      readonly threadRef: string
      readonly revision: string
      readonly authorClass: 'human' | 'bot' | 'self'
      readonly resolved: boolean
      readonly bodyDigest: string
      /**
       * Exact review material for this revision. It is carried only into the
       * internal fact snapshot / Agent untrusted-data block; rules continue to
       * see the digest/count facts, never free-form provider text.
       */
      readonly body: string
      readonly path: string | null
    }[]
  }>
}

export type PortOutcome<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly failure: OperationFailureReceipt }

export interface MissionEffectExecutorPort {
  execute(input: {
    readonly effectId: string
    readonly effectKind: string
    readonly intentDigest: string
  }): Promise<PortOutcome<{ readonly receiptRef: string }>>
}

/**
 * PR-4 T41 —— task-execution 侧 runner 的结构同形端口（launch/收取/取消）。
 * 执行是长过程：launch 只换 durable executionRef；终态由 wake hint 提示、
 * fetchOutcome 收取（机制层只搬运 `agent-result` 端口原文，envelope 的
 * nonce/schema 判定归本模块 parser——§7.1 职责拆分）。
 */
export type AgentExecutionSnapshot =
  | { readonly kind: 'not-found'; readonly executionRef: string }
  | { readonly kind: 'pending'; readonly executionRef: string; readonly taskStatus: string }
  | {
      readonly kind: 'exited'
      readonly executionRef: string
      readonly taskStatus: 'done' | 'failed' | 'canceled' | 'interrupted'
      readonly resultText: string | null
      readonly errorSummary: string | null
      readonly errorMessage: string | null
    }

export interface AgentActionLauncherPort {
  launch(input: {
    readonly actionRunId: string
    readonly capabilityId: string
    readonly agentId: string
    readonly prompt: string
    readonly workspacePath: string
    readonly baselineSha: string
    /** Exact read-only requirement/pipeline mount roots visible inside Agent isolation. */
    readonly platformInputPaths: readonly string[]
    readonly wallTimeMs: number | null
  }): Promise<PortOutcome<{ readonly executionRef: string }>>
  fetchOutcome(executionRef: string): Promise<AgentExecutionSnapshot>
  cancel(executionRef: string): Promise<{
    readonly settled: 'canceled' | 'already-terminal' | 'not-found'
  }>
}

/** TaskEngine-backed script implementation; the scriptRef resolves to an exact
 * immutable workflow definition and returns the same envelope port as Agent. */
export interface ScriptActionLauncherPort {
  launch(input: {
    readonly actionRunId: string
    readonly capabilityId: string
    readonly scriptRef: string
    readonly prompt: string
    readonly workspacePath: string
    readonly baselineSha: string
    readonly platformInputPaths: readonly string[]
    readonly wallTimeMs: number | null
  }): Promise<PortOutcome<{ readonly executionRef: string }>>
  fetchOutcome(executionRef: string): Promise<AgentExecutionSnapshot>
  cancel(executionRef: string): Promise<{
    readonly settled: 'canceled' | 'already-terminal' | 'not-found'
  }>
}

export interface ChildMissionPort {
  createOrAdopt(input: ChildMissionIntent): Promise<ChildMissionReceipt>
  observe(input: {
    readonly childMissionRef: string
    readonly completion: ChildMissionIntent['completion']
    readonly intentDigest: string
  }): Promise<ChildMissionReceipt>
}

export interface ApprovalGatewayPort {
  submit(
    input: ApprovalSubmitIntent,
  ): Promise<
    | { readonly ok: true; readonly receipt: ApprovalReceipt }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
  lookupByIdempotencyKey(input: {
    readonly adapterRef: ApprovalSubmitIntent['adapterRef']
    readonly idempotencyKey: string
  }): Promise<ApprovalReceipt | null>
  observe(input: {
    readonly adapterRef: ApprovalSubmitIntent['adapterRef']
    readonly correlationRef: string
  }): Promise<
    | { readonly ok: true; readonly receipt: ApprovalObservationReceipt }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
}

export interface UploadPlacementPort {
  place(input: {
    readonly missionId: string
    readonly uploadPlanRef: string
  }): Promise<PortOutcome<{ readonly seedTreeDigest: string }>>
}

/** fact snapshot 的读侧（store port 只有 insert；读回合并归本接口）。 */
export interface FactSnapshotReader {
  getCells(snapshotId: string): Record<string, FactCell<FactCellValue>> | null
}

/**
 * RFC-310 PR-3 T33/T35/T38a —— 需求取件/物化端口。实现在
 * infrastructure/requirementMaterializer.ts（EvidenceStore safe import +
 * 平台生成 manifest；外部程序执行经 integration 的 adapter runner 注入）。
 * DTO 只携 opaque ref/digest/closed 枚举——大字节永远留在 evidence。
 */
export interface RequirementMaterializePort {
  /** direct 提交 → 平台 RequirementBundleManifestV1（stash 的 digest 必须对得上 submissionRef）。 */
  materializeDirect(input: { readonly missionId: string; readonly submissionRef: string }): Promise<
    PortOutcome<{
      readonly bundleRef: string
      readonly manifestDigest: string
      readonly fileCount: number
      readonly totalBytes: number
      readonly sourceRevision: string
    }>
  >
  /** 外部需求系统取件：adapter 落 one-shot sink → safe import → manifest。 */
  acquireExternal(input: {
    readonly missionId: string
    readonly adapterBindingRef: string
    readonly externalId: string
  }): Promise<
    PortOutcome<{
      readonly bundleRef: string
      readonly manifestDigest: string
      readonly fileCount: number
      readonly totalBytes: number
      readonly sourceRevision: string
      readonly complete: boolean
    }>
  >
  /** PR-4：attempt 编排读 requirement index（coverage 闭集）——同步读侧。 */
  getRequirementManifest(missionId: string): {
    readonly title: string
    readonly files: readonly { readonly fileId: string }[]
  } | null
  /** Exact platform-generated manifest document to mount beside requirement files. */
  getRequirementManifestMount(
    missionId: string,
    manifestDigest: string,
  ): { readonly bundleId: string; readonly fileIds: readonly string[] } | null
  /**
   * PR-7b T81 —— reopen 派生的新 Mission 继承原 Mission 的需求证据。复制的是
   * **指针行**（direct-submission / requirement-bundle / requirement-manifest），
   * evidence blob 本身内容寻址、原地共享，不产生第二份数据。返回复制条数。
   */
  carryOverRequirementEvidence(input: {
    readonly fromMissionId: string
    readonly toMissionId: string
  }): number
  /** PR-4：Agent needs-information 的问题集入台账（origin 'agent'）。 */
  stashQuestionSet(input: {
    readonly missionId: string
    readonly origin: 'platform' | 'agent'
    readonly channel: 'platform' | 'requirement-source'
    readonly questions: readonly {
      readonly questionId: string
      readonly text: string
      readonly answerKind: 'text' | 'single-choice'
      readonly choices: readonly string[] | null
    }[]
  }): Promise<PortOutcome<{ readonly questionSetRef: string }>>
  /** 问题集投递：platform 渠道零外呼；requirement-source 渠道经 adapter 写回。 */
  publishQuestions(input: {
    readonly missionId: string
    readonly questionSetRef: string
    readonly channel: 'platform' | 'requirement-source'
    readonly adapterBindingRef: string | null
  }): Promise<PortOutcome<{ readonly correlationRef: string }>>
  /** 原渠道答案收取：complete=false 是常态轮询结果，不算失败。 */
  collectAnswers(input: {
    readonly missionId: string
    readonly questionSetRef: string
    readonly adapterBindingRef: string
    readonly correlationRef: string
  }): Promise<
    PortOutcome<{
      readonly complete: boolean
      readonly answerRevision: string | null
      readonly answerSetRef: string | null
    }>
  >
  /** 平台渠道答案提交（submitMissionAnswers 命令用；correlate + stash + exact revision）。 */
  stashAnswerSet(input: {
    readonly missionId: string
    readonly questionSetRef: string
    readonly answers: readonly { readonly questionId: string; readonly answer: string }[]
  }): Promise<PortOutcome<{ readonly answerSetRef: string; readonly answerRevision: string }>>
}

/** PR-4 —— action baseline 解析：repositoryId → 本地缓存 checkout + exact head。 */
export interface ActionBaselinePort {
  resolve(
    repositoryId: string,
  ): Promise<{ readonly repoPath: string; readonly headSha: string } | null>
}

/** PR-4 —— action workspace 物化/整树废弃（infrastructure/actionWorkspace 的结构同形）。 */
export interface ActionWorkspacePort {
  materialize(input: {
    readonly baselineRepoPath: string
    readonly baselineSha: string
    readonly seedRef: string | null
    readonly bundles: readonly { readonly bundleId: string; readonly mountPath: string }[]
  }): Promise<{ readonly workspacePath: string; readonly businessTreeDigest: string }>
  /**
   * PR-7b T78 —— 采纳一个**平台在别处准备好的** workspace（当前唯一来源是
   * conflict merge 的 prepare：它含 .git/MERGE_HEAD，不能由 materialize 重建）。
   * 只补 action 侧的挂载与 digest，不动业务树；discard 与 materialize 同路。
   */
  adopt(input: {
    readonly workspacePath: string
    readonly bundles: readonly { readonly bundleId: string; readonly mountPath: string }[]
  }): { readonly workspacePath: string; readonly businessTreeDigest: string }
  discard(workspacePath: string): void
}

/** PR-4 —— upload plan 读侧（seed 定位用 planDigest、validator/candidate 用 entries）。 */
export interface UploadPlanReaderPort {
  read(planId: string): {
    readonly planDigest: string
    readonly entries: readonly {
      readonly ordinal: number
      readonly fileId: string
      readonly targetPath: string
      readonly contentPolicy: 'preserve-upload' | 'agent-editable'
      readonly fileMode: 'regular' | 'executable'
      readonly disposition: 'create' | 'replace' | 'already-present'
      readonly uploadSha256: string
    }[]
  } | null
}

/** PR-4 —— action template 发布内容读侧（executor/prompt supplement/重试默认）。 */
export interface ActionTemplateContentPort {
  content(id: string, revision: number): unknown | null
}

/** PR-4 T48 —— source-control 的 candidate 派生（结构同形注入，跨模块零内部 import）。 */
export interface ChangeCandidatePort {
  derive(input: {
    readonly baselineRepoPath: string
    readonly baselineSha: string
    readonly overlayRoot: string
    readonly excludePolicyDigest: string
    readonly agentOutcomeRef: string
    readonly protectedRoots?: readonly string[]
    readonly uploadsAlreadyPublished?: boolean
    readonly uploadPlan?: {
      readonly planDigest: string
      readonly entries: readonly {
        readonly targetPath: string
        readonly contentPolicy: 'preserve-upload' | 'agent-editable'
        readonly fileMode: 'regular' | 'executable'
        readonly disposition: 'create' | 'replace' | 'already-present'
        readonly uploadSha256: string | null
      }[]
    } | null
  }): Promise<
    | {
        readonly ok: true
        readonly receipt: {
          readonly candidateRef: string
          readonly treeOid: string
          readonly uploadLineage: {
            readonly planDigest: string
            readonly finalDigests: readonly {
              readonly targetPath: string
              readonly sha256: string
            }[]
          } | null
        }
      }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
}

/**
 * PR-4 —— attempt pre-state 上下文的持久面（内容寻址 JSON，evidence 池实现；
 * Agent workspace 之外，Agent 不可达——伪造 pre 快照即伪造回退基准）。
 */
export interface AttemptContextStorePort {
  save(json: string): Promise<string>
  load(ref: string): string | null
}

/**
 * PR-4 T47 —— workspace 对拍面（infrastructure/workspaceValidator 的结构同形；
 * pre-state 以 opaque JSON 跨 reconcile 轮传递）。
 */
export interface WorkspaceValidationPort {
  capturePreState(workspacePath: string): string
  validate(input: {
    readonly workspacePath: string
    readonly preStateJson: string
    readonly outcome: 'changed' | 'no-change' | 'needs-information' | 'blocked'
    readonly workspaceMode: string
    readonly writablePrefixes: readonly string[]
    readonly preservePaths: readonly string[]
    readonly editablePaths: readonly string[]
    readonly budget: { readonly maxChangedFiles: number; readonly maxTotalBytes: number }
  }):
    | { readonly ok: true; readonly kind: 'clean' }
    | { readonly ok: true; readonly kind: 'changed'; readonly changedPaths: readonly string[] }
    | {
        readonly ok: false
        readonly kind: 'boundary'
        readonly code: string
        readonly paths: readonly string[]
        readonly detail: string
      }
    | {
        readonly ok: false
        readonly kind: 'semantic'
        readonly code: string
        readonly detail: string
      }
}

/** PR-5 —— repo remote 定位（push 目标与默认 target 分支；URL 解封在装配点）。 */
export interface RepoRemotePort {
  resolve(repositoryId: string): {
    readonly remoteUrl: string
    readonly defaultBranch: string | null
  } | null
}

/** PR-5 T59 —— source-control 发布链（stage/commit/push 结构同形注入）。 */
export interface CandidateDeliveryPort {
  stage(input: {
    readonly baselineRepoPath: string
    readonly baselineSha: string
    readonly overlayRoot: string
    readonly uploadPlan?: {
      readonly entries: readonly {
        readonly targetPath: string
        readonly disposition: 'create' | 'replace' | 'already-present'
        readonly fileMode: 'regular' | 'executable'
      }[]
    } | null
  }): Promise<
    | { readonly ok: true; readonly ws: string; readonly treeOid: string; cleanup(): void }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
  commit(input: {
    readonly baselineRepoPath: string
    readonly baselineSha: string
    readonly overlayRoot: string
    readonly expectedTreeOid: string
    readonly missionId: string
    readonly summarySource: string
    readonly uploadPlan?: {
      readonly entries: readonly {
        readonly targetPath: string
        readonly disposition: 'create' | 'replace' | 'already-present'
        readonly fileMode: 'regular' | 'executable'
      }[]
    } | null
  }): Promise<
    | {
        readonly ok: true
        readonly commitSha: string
        readonly localRef: string
        readonly reused: boolean
      }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
  push(input: {
    readonly baselineRepoPath: string
    readonly commitSha: string
    readonly remoteUrl: string
    readonly branch: string
    readonly expectedRemoteSha: string | null
    readonly expectedTreeOid: string
    readonly baselineSha: string
    readonly publicationSubject:
      | { readonly kind: 'user'; readonly userId: string }
      | { readonly kind: 'system' }
  }): Promise<
    | {
        readonly ok: true
        readonly receipt: {
          readonly remoteRef: string
          readonly oldSha: string | null
          readonly newSha: string
          readonly reused: boolean
          readonly publication?: RepositoryPublicationReceipt
        }
      }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
}

/** PR-5 T57 —— verification profile 内容读侧 + 程序执行（runner 结构同形）。 */
export interface VerificationProfileContentPort {
  content(id: string, revision: number): unknown | null
}
export interface VerificationExecutionPort {
  run(input: { readonly workspacePath: string; readonly profile: unknown }): Promise<{
    readonly ok: boolean
    readonly receiptDigest: string
    readonly steps: readonly {
      readonly stepId: string
      readonly ok: boolean
      readonly exitCode: number | null
      readonly timedOut: boolean
      readonly outputTailRef: string | null
    }[]
  }>
}

/** PR-6 T63 —— pipeline collect envelope 的端口 DTO（integration 词表结构同形）。 */
export interface PipelineCollectEnvelopeDto {
  readonly providerKey: string
  /** provider 无 head 绑定（partial）时为 null。 */
  readonly providerHeadSha: string | null
  readonly targetSha: string | null
  readonly completeness: 'complete' | 'partial'
  readonly gates: readonly {
    readonly gateKey: string
    readonly required: boolean
    readonly status:
      | 'queued'
      | 'running'
      | 'pass'
      | 'fail'
      | 'canceled'
      | 'skipped'
      | 'unknown'
      | 'unavailable'
    readonly runRef: string
    readonly attempt: number
    readonly finishedAt: string | null
    readonly retryability: 'safe' | 'unsafe' | 'unknown'
    readonly failureCategories: readonly string[]
    readonly files: readonly { readonly fileId: string; readonly relativePath: string }[]
  }[]
  readonly redaction: 'complete' | 'failed'
}

/** PR-6 T63 —— pipeline provider 执行面（integration adapter 结构同形注入）。 */
export interface PipelineEvidencePort {
  collect(input: {
    readonly adapterBindingRef: string
    readonly headSha: string
    readonly targetSha: string
    readonly gateKeys: readonly string[]
  }): Promise<
    | {
        readonly ok: true
        readonly envelope: PipelineCollectEnvelopeDto
        readonly stagedRoot: string
        readonly outputBudget: {
          readonly maxFiles: number
          readonly maxFileBytes: number
          readonly maxTotalBytes: number
        }
        cleanup(): void
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
  trigger(input: {
    readonly adapterBindingRef: string
    readonly headSha: string
    readonly gateKeys: readonly string[]
    readonly idempotencyKey: string
  }): Promise<
    | {
        readonly ok: true
        readonly runRef: string
        readonly providerReceiptRef: string
        readonly adopted: boolean
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
  rerun(input: {
    readonly adapterBindingRef: string
    readonly runRef: string
    readonly gateKey: string
    readonly headSha: string
    readonly idempotencyKey: string
  }): Promise<
    | {
        readonly ok: true
        readonly runRef: string
        readonly attempt: number
        readonly providerReceiptRef: string
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
}

/** PR-6 T65 —— staged sink → manifest 的收编面（infrastructure importer 注入）。 */
export interface PipelineImportPort {
  import(input: {
    readonly stagedRoot: string
    readonly envelope: PipelineCollectEnvelopeDto
    readonly expectedHeadSha: string
    readonly expectedTargetSha: string
  }): Promise<
    | { readonly ok: true; readonly manifestJson: string; readonly manifestRef: string }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
}

/** PR-5 T59 —— upload plan 的 publication receipt 落账（push 即 published）。 */
export interface UploadPublicationPort {
  record(input: {
    readonly planId: string
    readonly baselineSnapshotRef: string
    readonly seedChangeRef: string | null
    readonly seedTreeDigest: string | null
    readonly commitSha: string
    readonly entries: readonly { readonly targetPath: string; readonly sha256: string }[]
    readonly now: number
  }): { readonly created: boolean; readonly receiptId: string }
}

/** PR-5 T60 —— code-host MR effects（integration 组装的结构同形）。 */
export interface MrEffectsPort {
  ensure(
    repositoryId: string,
    input: {
      readonly missionId: string
      readonly sourceBranch: string
      readonly targetBranch: string
      readonly title: string
      readonly description?: string
    },
  ): Promise<
    | {
        readonly ok: true
        readonly mr: {
          readonly mrRef: string
          readonly webUrl: string | null
          readonly state: 'opened' | 'merged' | 'closed'
          readonly sourceSha: string | null
          readonly created: boolean
          readonly providerCorrelationRef: string
        }
      }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
  /** PR-7 T75：feedback thread 回复（只回复，绝不 resolve；正文含 self marker）。 */
  reply(
    repositoryId: string,
    input: {
      readonly mrRef: string
      readonly threadRef: string
      readonly body: string
      /** self 循环防护 marker（与 facts 采集同源，建议 missionId）。 */
      readonly selfMarker: string
    },
  ): Promise<
    | { readonly ok: true; readonly noteRef: string }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
  /** PR-6：pipeline fence 的 MR head/target 读面（单次 mr.get 观察）。 */
  observe(
    repositoryId: string,
    mrRef: string,
  ): Promise<
    | {
        readonly ok: true
        readonly observation: {
          readonly mrRef: string
          readonly state: 'opened' | 'merged' | 'closed'
          readonly sourceSha: string | null
          readonly targetBranch: string | null
          readonly webUrl: string | null
        }
      }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
}

/** PR-7b T77 —— source-control conflict merge（prepare/finish 结构同形）。 */
export interface ConflictMergePort {
  prepare(input: {
    readonly baselineRepoPath: string
    readonly sourceSha: string
    readonly targetSha: string
    /** 装配点注入的 workspace 宿主根（appHome 之下）；application 层不传。 */
    readonly workspacesRoot?: string
  }): Promise<
    | {
        readonly ok: true
        readonly workspacePath: string
        readonly conflictPaths: readonly string[]
        cleanup(): void
      }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
  finish(input: {
    readonly workspacePath: string
    readonly sourceSha: string
    readonly targetSha: string
    readonly conflictPaths: readonly string[]
    readonly missionId: string
  }): Promise<
    | { readonly ok: true; readonly mergeCommitSha: string; readonly treeOid: string }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
}

export interface ReconcilerPorts {
  readonly repositoryFacts?: RepositoryFactsCollectorPort
  readonly mergeRequestFacts?: MergeRequestFactsCollectorPort
  readonly effectExecutor?: MissionEffectExecutorPort
  readonly agentLauncher?: AgentActionLauncherPort
  readonly scriptLauncher?: ScriptActionLauncherPort
  readonly playbookSaga?: PlaybookSagaStore
  readonly childMissions?: ChildMissionPort
  readonly approvalGateway?: ApprovalGatewayPort
  readonly uploadPlacement?: UploadPlacementPort
  readonly requirementMaterialize?: RequirementMaterializePort
  readonly actionBaseline?: ActionBaselinePort
  readonly actionWorkspace?: ActionWorkspacePort
  readonly uploadPlanReader?: UploadPlanReaderPort
  readonly changeCandidate?: ChangeCandidatePort
  readonly attemptContext?: AttemptContextStorePort
  readonly actionTemplates?: ActionTemplateContentPort
  readonly workspaceValidation?: WorkspaceValidationPort
  readonly repoRemote?: RepoRemotePort
  readonly candidateDelivery?: CandidateDeliveryPort
  readonly verificationProfiles?: VerificationProfileContentPort
  readonly verificationExecution?: VerificationExecutionPort
  readonly mrEffects?: MrEffectsPort
  readonly uploadPublication?: UploadPublicationPort
  readonly conflictMerge?: ConflictMergePort
  readonly pipelineEvidence?: PipelineEvidencePort
  readonly pipelineImport?: PipelineImportPort
}
