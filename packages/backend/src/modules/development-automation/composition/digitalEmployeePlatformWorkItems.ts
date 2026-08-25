import { desc, eq } from 'drizzle-orm'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import type { EmployeeReactionRoundQueryPort } from '@/modules/digital-employee/public/types'
import { repoRelativePathSchema } from '../domain/requirementManifest'
import {
  cachedRepos,
  employeeApprovalSagas,
  employeeCaseWorkspaces,
  employeeChangeCandidates,
  employeeRoundWorkspaceStates,
} from '@/db/schema'
import type {
  ApprovalGatewayPort,
  PipelineEvidencePort,
} from '../application/ports/reconcilerPorts'
import { encodeDevelopmentApprovalSubject } from '../domain/approvalSubject'
import { canonicalDigest } from '../domain/canonicalJson'
import {
  approvalContextSchema,
  mergeRequestContextSchema as mergeRequestStateSchema,
  pipelineContextSchema,
  problemSetContextSchema,
  reviewResolutionContextSchema,
} from './employeeTypePackage'
import { sha256Hex } from '@/util/hash'
import { stableIdentityComponent } from '@/util/gitRef'
import { createGitBaselineReader } from '../infrastructure/gitBaselineReader'
import {
  businessTreeSnapshot,
  businessTreeSnapshotDigest,
} from '../infrastructure/workspaceValidator'
import { EvidenceStore } from '../infrastructure/evidenceStore'
import { createPipelineImportAdapter } from '../infrastructure/pipelineEvidenceImport'
import { gateCountsAsPass, pipelineEvidenceManifestV1Schema } from '../domain/pipelineManifest'

interface DevelopmentReactionPlan {
  readonly roundRef: string
  readonly executionNonce: string
  readonly caseRef: { readonly id: string }
  readonly employeeTypeRef?: {
    readonly typeId: string
    readonly revision: number
  } | null
  readonly triggeringEventRef: string
  readonly workItemRef: string
  readonly connectionRef?: { readonly id: string; readonly revision: number } | null
  readonly inputEnvelopeJson: string
  readonly externalWaitDeadlineMs: number
}

const contextSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    typeId: z.string().min(1),
    stateJson: z.string().min(2),
    lifecycleState: z.enum(['active', 'waiting', 'terminal']).default('active'),
    artifactRefs: z.array(z.string().min(1)).default([]),
  })
  .passthrough()

const envelopeSchema = z.object({ contextsJson: z.string().min(2) }).passthrough()

const issueSchema = z
  .object({
    subjectRef: z.string().min(1),
    repositoryRef: z.string().min(1),
    request: z
      .object({
        body: z.string().nullable(),
        externalId: z.string().nullable(),
        uploads: z.array(
          z
            .object({
              artifactRef: z.string().regex(/^employee-input:[a-f0-9]{64}$/),
              placement: z.enum(['repository', 'temporary']).default('repository'),
              // RFC-317 T38（CC-08）—— 与**产出这个值的那一侧**共用同一个 schema。
              // 这里原本是 `z.string().min(1)`：同一条「上传目标必须是安全的仓库相对
              // 路径」契约在仓里有三份独立声明，严格度递减，而**写侧这一份最松**——
              // 产出侧拒掉的 `../`、反斜杠、盘符、空段，到了边界重解析时全部放行。
              // 今天没有真实逃逸只是因为产出侧先拦住了；那是被拿掉的纵深防御，
              // 而不是不需要的防御。
              targetPath: repoRelativePathSchema,
              originalName: z.string().min(1),
            })
            .strict(),
        ),
      })
      .passthrough(),
    materialArtifactRefs: z.array(z.string().min(1)).default([]),
    deliveryContent: z
      .object({
        commitMessage: z.string().trim().min(1).max(5_000),
        mergeRequestTitle: z.string().trim().min(1).max(240),
        mergeRequestDescription: z.string().trim().min(1).max(32_000),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .passthrough()

const employeeUploadPlanSchema = z
  .object({
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(
      z
        .object({
          // RFC-317 T38（CC-08）—— 上传计划里的目标路径同样走共享 schema：
          // 它与上面那一处最终落在同一个 join() + copyBlobTo() 上。
          targetPath: repoRelativePathSchema,
          contentPolicy: z.literal('agent-editable'),
          fileMode: z.enum(['regular', 'executable']),
          disposition: z.enum(['create', 'replace', 'already-present']),
          uploadSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict()

type EmployeeUploadPlan = z.infer<typeof employeeUploadPlanSchema>

async function resolveEmployeeUploadPlan(input: {
  readonly uploads: readonly z.infer<typeof issueSchema>['request']['uploads'][number][]
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly workspaceRoot: string
}): Promise<
  | { readonly ok: true; readonly plan: EmployeeUploadPlan | null }
  | { readonly ok: false; readonly code: string; readonly detail: string }
> {
  const repositoryUploads = input.uploads.filter((upload) => upload.placement === 'repository')
  if (repositoryUploads.length === 0) return { ok: true, plan: null }
  const baseline = createGitBaselineReader(input.baselineRepoPath, input.baselineSha)
  const entries: EmployeeUploadPlan['entries'][number][] = []
  for (const upload of repositoryUploads) {
    const uploadSha256 = upload.artifactRef.slice('employee-input:'.length)
    const stat = await baseline.stat(upload.targetPath)
    if (stat === 'directory' || stat === 'unsupported') {
      return {
        ok: false,
        code: stat === 'directory' ? 'upload-target-is-directory' : 'upload-target-unsupported',
        detail: upload.targetPath,
      }
    }
    entries.push({
      targetPath: upload.targetPath,
      contentPolicy: 'agent-editable',
      fileMode: stat === 'missing' ? 'regular' : stat.mode,
      disposition:
        stat === 'missing'
          ? 'create'
          : stat.sha256 !== uploadSha256
            ? 'replace'
            : (() => {
                const target = join(input.workspaceRoot, upload.targetPath)
                const finalStat = lstatSync(target, { throwIfNoEntry: false })
                return finalStat?.isFile() && sha256Hex(readFileSync(target)) === uploadSha256
                  ? 'already-present'
                  : 'replace'
              })(),
      uploadSha256,
    })
  }
  return {
    ok: true,
    plan: {
      planDigest: sha256Hex(JSON.stringify({ baselineSha: input.baselineSha, entries })),
      entries,
    },
  }
}

const candidateStateSchema = z
  .object({
    status: z.enum(['prepared', 'committed', 'published', 'obsolete']),
    candidateRef: z.string().min(1),
    baselineSha: z.string().min(1),
    treeOid: z.string().min(1),
    summarySource: z.string().min(1),
    changedPaths: z.array(z.string()),
    commitSha: z.string().nullable(),
  })
  .strict()

type MergeRequestReviewThreadState = z.infer<
  typeof mergeRequestStateSchema
>['reviewThreads'][number]

const conflictValidationSchema = z
  .object({
    ok: z.literal(true),
    changedPaths: z.array(z.string().min(1)).min(1),
    postBusinessDigest: z.string().regex(/^[a-f0-9]{64}$/),
    conflict: z
      .object({
        workspacePath: z.string().min(1),
        sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
        targetSha: z.string().regex(/^[a-f0-9]{40}$/),
        conflictPaths: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    inspection: z.object({ ok: z.literal(true) }).passthrough(),
  })
  .passthrough()

type Context = z.infer<typeof contextSchema>

function contextsOf(plan: DevelopmentReactionPlan): Context[] {
  const envelope = envelopeSchema.parse(JSON.parse(plan.inputEnvelopeJson) as unknown)
  return z.array(contextSchema).parse(JSON.parse(envelope.contextsJson) as unknown)
}

function isTargetAwarePipelinePlan(plan: DevelopmentReactionPlan): boolean {
  return plan.employeeTypeRef?.typeId === 'development' && plan.employeeTypeRef.revision >= 8
}

function usesMinimalToolContracts(plan: DevelopmentReactionPlan): boolean {
  return plan.employeeTypeRef?.typeId === 'development' && plan.employeeTypeRef.revision >= 9
}

function issueOf(contexts: readonly Context[]) {
  const context = contexts.find((candidate) => candidate.typeId === 'development.issue-handling')
  if (context === undefined) throw new Error('development issue context is missing')
  return { context, state: issueSchema.parse(JSON.parse(context.stateJson) as unknown) }
}

function contextPatch(input: {
  readonly current: Context | undefined
  readonly contextTypeId: string
  readonly lifecycleState?: 'active' | 'waiting' | 'terminal'
  readonly state: object
  readonly artifactRefs?: readonly string[]
}) {
  return {
    contextId: input.current?.id ?? null,
    contextTypeId: input.contextTypeId,
    schemaVersion: 1,
    expectedRevision: input.current?.revision ?? null,
    lifecycleState: input.lifecycleState ?? 'active',
    stateJson: JSON.stringify(input.state),
    artifactRefs: [...(input.artifactRefs ?? [])],
  }
}

function pendingPipelinePatch(input: {
  readonly current: Context | undefined
  readonly caseId: string
  readonly active: boolean
  readonly allowCreate: boolean
  readonly mergeRequestRef: string
  readonly headSha: string
  readonly targetSha: string | null
}) {
  if (!input.active) return null
  if (input.current === undefined && !input.allowCreate) return null
  if (input.current !== undefined) {
    const currentState = pipelineContextSchema.parse(JSON.parse(input.current.stateJson) as unknown)
    if (
      currentState.mergeRequestRef === input.mergeRequestRef &&
      currentState.headSha === input.headSha &&
      currentState.targetSha === input.targetSha
    ) {
      return null
    }
  }
  return contextPatch({
    current: input.current,
    contextTypeId: 'development.pipeline',
    lifecycleState: 'active',
    state: pipelineContextSchema.parse({
      status: 'pending',
      mergeRequestRef: input.mergeRequestRef,
      headSha: input.headSha,
      targetSha: input.targetSha,
      evidenceArtifactRef: `${PLATFORM_WORKSPACE_DIR}/pipeline/${stableIdentityComponent(input.caseId)}/`,
      failureTypes: [],
    }),
  })
}

function reconcileStaleReviewSelection(input: {
  readonly contexts: readonly Context[]
  readonly liveReviewThreads: readonly MergeRequestReviewThreadState[]
}): ReturnType<typeof contextPatch>[] {
  const currentProblemSet = input.contexts.find(
    (context) => context.typeId === 'development.problem-set',
  )
  const currentResolution = input.contexts.find(
    (context) => context.typeId === 'development.review-resolution',
  )
  if (currentProblemSet === undefined || currentResolution === undefined) return []
  const problemSet = problemSetContextSchema.parse(
    JSON.parse(currentProblemSet.stateJson) as unknown,
  )
  if (problemSet.source !== 'review' || problemSet.status !== 'active') return []
  const resolution = reviewResolutionContextSchema.parse(
    JSON.parse(currentResolution.stateJson) as unknown,
  )
  const liveActionableRevisions = new Set(
    input.liveReviewThreads
      .filter((thread) => !thread.resolved && thread.authorClass !== 'self')
      .map((thread) => `${thread.threadRef}\u0000${thread.revision}`),
  )
  const staleRevisions = new Set(
    problemSet.problems.flatMap((problem) => {
      const thread = problem.reviewThread
      if (thread === null) return []
      const key = `${thread.threadRef}\u0000${thread.revision}`
      return liveActionableRevisions.has(key) ? [] : [key]
    }),
  )
  if (staleRevisions.size === 0) return []
  const nextProblems = problemSet.problems.filter((problem) => {
    const thread = problem.reviewThread
    return thread === null || !staleRevisions.has(`${thread.threadRef}\u0000${thread.revision}`)
  })
  const noCurrentReviewProblems = nextProblems.length === 0
  const nextThreads = resolution.threads.filter(
    (thread) =>
      thread.acknowledgement !== null ||
      thread.finalReply !== null ||
      !staleRevisions.has(`${thread.threadRef}\u0000${thread.revision}`),
  )
  return [
    contextPatch({
      current: currentResolution,
      contextTypeId: 'development.review-resolution',
      state: reviewResolutionContextSchema.parse({
        ...resolution,
        status: 'collected',
        publishedHeadSha: null,
        commitSha: null,
        threads: nextThreads,
      }),
    }),
    contextPatch({
      current: currentProblemSet,
      contextTypeId: 'development.problem-set',
      lifecycleState: noCurrentReviewProblems ? 'terminal' : 'active',
      state: problemSetContextSchema.parse({
        ...problemSet,
        status: noCurrentReviewProblems ? 'resolved' : 'active',
        remainingTypes: noCurrentReviewProblems ? [] : ['review'],
        problems: nextProblems,
      }),
    }),
  ]
}

function platformOutput(
  plan: DevelopmentReactionPlan,
  input: {
    readonly status?: 'ok' | 'needs-input' | 'blocked'
    readonly summary: string
    readonly contextPatches?: readonly ReturnType<typeof contextPatch>[]
    readonly effectSuggestions?: readonly string[]
    readonly artifactRefs?: readonly string[]
  },
): string {
  return JSON.stringify({
    schemaVersion: 1,
    roundRef: plan.roundRef,
    executionNonce: plan.executionNonce,
    status: input.status ?? 'ok',
    summary: input.summary,
    contextPatches: [...(input.contextPatches ?? [])],
    effectSuggestions: [...(input.effectSuggestions ?? [])],
    artifactRefs: [...(input.artifactRefs ?? [])],
  })
}

function reviewReplyMarker(input: {
  readonly caseId: string
  readonly phase: 'received' | 'resolved'
  readonly threadRef: string
  readonly revision: string
  readonly commitSha?: string
}): string {
  return `${input.caseId}:review-${input.phase}:${sha256Hex(
    JSON.stringify({
      threadRef: input.threadRef,
      revision: input.revision,
      commitSha: input.commitSha ?? null,
    }),
  ).slice(0, 24)}`
}

function reviewMarkerToken(marker: string): string {
  return `<!-- aw-self:${marker} -->`
}

export function composeDevelopmentEmployeePlatformWorkItems(input: {
  readonly db: DbClient
  readonly appHome: string
  /** Direct fixture calls may bind a subject; runtime calls pass the frozen Case owner. */
  readonly directPublicationSubject?:
    | { readonly kind: 'user'; readonly userId: string }
    | { readonly kind: 'system' }
  /**
   * RFC-317 T41（DE-02）—— 反应轮次的只读查询面。此前这里按
   * `employeeReactionRounds.state === 'completed'` 直接查 Digital Employee OS 的
   * 私表，把它的内部状态机枚举变成了一条没有主人的事实合同。
   */
  readonly reactionRounds: EmployeeReactionRoundQueryPort
  readonly approvalGateway?: ApprovalGatewayPort
  readonly pipelineEvidence?: PipelineEvidencePort
  readonly repoRemote: {
    resolve(repositoryId: string): {
      readonly remoteUrl: string
      readonly defaultBranch: string | null
    } | null
  }
  readonly mrEffects: {
    reply(
      repositoryId: string,
      request: {
        readonly mrRef: string
        readonly threadRef: string
        readonly body: string
        readonly selfMarker: string
      },
    ): Promise<
      | { readonly ok: true; readonly noteRef: string }
      | { readonly ok: false; readonly code: string; readonly detail: string }
    >
    ensure(
      repositoryId: string,
      request: {
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
          }
        }
      | { readonly ok: false; readonly code: string; readonly detail: string }
    >
    observe(
      repositoryId: string,
      mrRef: string,
    ): Promise<
      | {
          readonly ok: true
          readonly observation: {
            readonly state: 'opened' | 'merged' | 'closed'
            readonly sourceSha: string | null
            readonly targetBranch: string | null
            readonly webUrl: string | null
          }
        }
      | { readonly ok: false; readonly code: string; readonly detail: string }
    >
  }
  readonly mrFacts?: {
    collect(
      repositoryId: string,
      mrRef: string,
      selfMarker: string,
    ): Promise<
      | {
          readonly ok: true
          readonly snapshot: {
            readonly state: 'opened' | 'merged' | 'closed'
            readonly headSha: string | null
            readonly targetSha: string | null
            readonly targetBranch: string | null
            readonly draft: boolean
            readonly mergeableState: 'mergeable' | 'conflict' | 'unknown'
            readonly approvalHold: boolean | null
            readonly mergedCommitSha: string | null
            readonly unresolvedReviewCount: number
            readonly reviewThreads: readonly {
              readonly threadRef: string
              readonly revision: string
              readonly authorClass: 'human' | 'bot' | 'self'
              readonly resolved: boolean
              readonly body: string
              readonly path: string | null
              readonly messages: readonly {
                readonly messageRef: string
                readonly parentMessageRef: string | null
                readonly authorClass: 'human' | 'bot' | 'self'
                readonly body: string
                readonly path: string | null
                readonly createdAt: string | null
              }[]
            }[]
          }
        }
      | { readonly ok: false; readonly code: string; readonly detail: string }
    >
  }
  readonly sourceControl: {
    derive(request: {
      readonly baselineRepoPath: string
      readonly baselineSha: string
      readonly overlayRoot: string
      readonly excludePolicyDigest: string
      readonly agentOutcomeRef: string
      readonly uploadPlan: {
        readonly planDigest: string
        readonly entries: readonly {
          readonly targetPath: string
          readonly contentPolicy: 'preserve-upload' | 'agent-editable'
          readonly fileMode: 'regular' | 'executable'
          readonly disposition: 'create' | 'replace' | 'already-present'
          readonly uploadSha256: string | null
        }[]
      } | null
      readonly uploadsAlreadyPublished: boolean
    }): Promise<
      | {
          readonly ok: true
          readonly receipt: {
            readonly candidateRef: string
            readonly treeOid: string
            readonly changed: {
              readonly added: readonly string[]
              readonly modified: readonly string[]
              readonly deleted: readonly string[]
            }
          }
        }
      | { readonly ok: false; readonly code: string; readonly detail: string }
    >
    commit(request: {
      readonly baselineRepoPath: string
      readonly baselineSha: string
      readonly overlayRoot: string
      readonly expectedTreeOid: string
      readonly missionId: string
      readonly summarySource: string
      readonly contextEnvelope: {
        readonly employeeCaseRef: string
        readonly issueContextRef: string
        readonly schemaRef: 'issue-handling.v1'
        readonly workItemRef: string
      }
      readonly uploadPlan: {
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
    push(request: {
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
          }
        }
      | { readonly ok: false; readonly code: string; readonly detail: string }
    >
    checkpoint(request: { readonly workspacePath: string; readonly checkpointRoot: string }): {
      readonly checkpointDigest: string
    }
    restore(request: {
      readonly caseRoot: string
      readonly baselineRepoPath: string
      readonly baselineSha: string
      readonly checkpointRoot: string
      readonly expectedCheckpointDigest: string
    }): Promise<{ readonly workspacePath: string }>
    materialize(request: {
      readonly caseRoot: string
      readonly baselineRepoPath: string
      readonly baselineSha: string
    }): Promise<{ readonly workspacePath: string }>
    rematerialize(request: {
      readonly caseRoot: string
      readonly baselineRepoPath: string
      readonly baselineSha: string
      readonly currentWorkspacePath: string
    }): Promise<{ readonly workspacePath: string }>
    fetchRemoteHead(request: {
      readonly baselineRepoPath: string
      readonly remoteUrl: string
      readonly branch: string
      readonly expectedHeadSha: string
      readonly publicationSubject:
        | { readonly kind: 'user'; readonly userId: string }
        | { readonly kind: 'system' }
    }): Promise<
      | { readonly ok: true; readonly headSha: string }
      | {
          readonly ok: false
          readonly code: 'remote-head-moved'
          readonly expectedHeadSha: string
          readonly actualHeadSha: string
        }
    >
    importCommit(request: {
      readonly baselineRepoPath: string
      readonly sourceRepoPath: string
      readonly commitSha: string
    }): Promise<void>
  }
  readonly conflictMerge: {
    finish(request: {
      readonly workspacePath: string
      readonly sourceSha: string
      readonly targetSha: string
      readonly conflictPaths: readonly string[]
      readonly validatedChangedPaths?: readonly string[]
      readonly missionId: string
    }): Promise<
      | { readonly ok: true; readonly mergeCommitSha: string; readonly treeOid: string }
      | {
          readonly ok: false
          readonly code: 'conflict-unresolved' | 'conflict-extra-changes' | 'finish-failed'
          readonly detail: string
        }
    >
  }
  readonly now?: () => number
}): {
  execute(
    plan: DevelopmentReactionPlan,
    executionContext?: {
      readonly publicationSubject:
        | { readonly kind: 'user'; readonly userId: string }
        | { readonly kind: 'system' }
    },
  ): Promise<string>
} {
  const candidateOps = input.sourceControl
  const delivery = input.sourceControl
  const workspaceOps = input.sourceControl
  const now = input.now ?? Date.now
  const pipelineEvidenceStore = new EvidenceStore(join(input.appHome, 'evidence'))
  const caseDirectory = (caseId: string) =>
    join(input.appHome, 'workspaces', 'employee-cases', stableIdentityComponent(caseId))
  const sceneRoot = (caseId: string) => join(caseDirectory(caseId), 'scene')
  const workspacePath = (caseId: string) => join(sceneRoot(caseId), 'workspace')

  const currentWorkspace = (caseId: string) => {
    const row = input.db
      .select()
      .from(employeeCaseWorkspaces)
      .where(eq(employeeCaseWorkspaces.caseId, caseId))
      .get()
    if (row === undefined) throw new Error(`employee case workspace is missing: ${caseId}`)
    const repository = input.db
      .select({ localPath: cachedRepos.localPath })
      .from(cachedRepos)
      .where(eq(cachedRepos.id, row.cachedRepoId))
      .get()
    if (repository === undefined)
      throw new Error(`cached repository is missing: ${row.cachedRepoId}`)
    return { row, repository }
  }

  return {
    async execute(plan, executionContext) {
      const publicationSubject = () => {
        const subject = executionContext?.publicationSubject ?? input.directPublicationSubject
        if (subject === undefined) {
          throw new Error(`platform publication subject missing for case: ${plan.caseRef.id}`)
        }
        return subject
      }
      const output = (value: Parameters<typeof platformOutput>[1]) => platformOutput(plan, value)
      const contexts = contextsOf(plan)
      const targetAwarePipeline = isTargetAwarePipelinePlan(plan)
      if (plan.workItemRef === 'prepare-materials') {
        const issue = issueOf(contexts)
        if (
          issue.state.request.kind === 'external-id' &&
          issue.state.materialArtifactRefs.length === 0
        ) {
          if (usesMinimalToolContracts(plan)) {
            return JSON.stringify({
              outcome: 'blocked',
              explanation: '外部需求或问题编号需要已配置的材料取得工具',
            })
          }
          return output({
            status: 'blocked',
            summary: '外部需求或问题 ID 必须由已配置的材料取得工具处理',
          })
        }
        if (usesMinimalToolContracts(plan)) {
          return JSON.stringify({ outcome: 'completed' })
        }
        const reusesPreparedExternalMaterials = issue.state.request.kind === 'external-id'
        return output({
          summary: reusesPreparedExternalMaterials
            ? `平台已沿用 ${issue.state.materialArtifactRefs.length} 份冻结的外部材料`
            : issue.state.request.uploads.length > 0
              ? `平台已接收正文并冻结 ${issue.state.request.uploads.length} 个上传文件落点`
              : '平台已接收并冻结需求或问题正文',
          contextPatches: reusesPreparedExternalMaterials
            ? [
                contextPatch({
                  current: issue.context,
                  contextTypeId: issue.context.typeId,
                  lifecycleState: issue.context.lifecycleState,
                  state: issue.state,
                  artifactRefs: issue.context.artifactRefs,
                }),
              ]
            : [],
          artifactRefs: reusesPreparedExternalMaterials ? issue.state.materialArtifactRefs : [],
        })
      }
      if (plan.workItemRef === 'collect-pipeline') {
        const currentMr = contexts.find((context) => context.typeId === 'development.merge-request')
        if (currentMr === undefined) {
          return JSON.stringify({
            outcome: 'blocked',
            explanation: '缺少当前 MR 上下文，无法采集流水线状态',
          })
        }
        const mergeRequest = mergeRequestStateSchema.parse(
          JSON.parse(currentMr.stateJson) as unknown,
        )
        if (input.pipelineEvidence === undefined || plan.connectionRef == null) {
          return JSON.stringify({
            outcome: 'blocked',
            explanation: '流水线泳道缺少已冻结的企业流水线连接',
          })
        }
        const pending = () =>
          JSON.stringify({
            outcome: 'completed',
            observedSourceVersion: mergeRequest.headSha,
            ...(mergeRequest.targetSha === null
              ? {}
              : { observedTargetVersion: mergeRequest.targetSha }),
            status: 'pending',
            checks: [],
          })
        if (
          mergeRequest.targetSha === null ||
          mergeRequest.repositoryRef === null ||
          mergeRequest.providerMrRef === null ||
          input.mrFacts === undefined
        ) {
          return pending()
        }
        const targetSha = mergeRequest.targetSha
        const collected = await input.pipelineEvidence.collect({
          adapterBindingRef: `${plan.connectionRef.id}@${plan.connectionRef.revision}`,
          headSha: mergeRequest.headSha,
          targetSha,
          gateKeys: [],
        })
        if (!collected.ok) {
          if (
            collected.failure.category === 'transient' &&
            collected.failure.retryability === 'same-input'
          ) {
            // Throw into Digital Employee OS's durable outbox retry path. The
            // current pending Context remains authoritative; a provider outage
            // never becomes a business-terminal "blocked" result.
            throw new Error(`pipeline-adapter-transient:${collected.failure.code}`)
          }
          if (collected.failure.category === 'stale-input') return pending()
          return JSON.stringify({
            outcome: 'blocked',
            explanation: `${collected.failure.code}: ${collected.failure.remediation}`,
          })
        }
        try {
          const refreshed = await input.mrFacts.collect(
            mergeRequest.repositoryRef,
            mergeRequest.providerMrRef,
            plan.caseRef.id,
          )
          const headStillCurrent =
            refreshed.ok && refreshed.snapshot.headSha === mergeRequest.headSha
          const targetStillCurrent =
            refreshed.ok && refreshed.snapshot.targetSha === mergeRequest.targetSha
          const providerHeadMatches =
            collected.envelope.providerHeadSha === mergeRequest.headSha &&
            collected.envelope.completeness === 'complete'
          const providerTargetMatches = collected.envelope.targetSha === mergeRequest.targetSha
          if (
            !headStillCurrent ||
            !targetStillCurrent ||
            !providerHeadMatches ||
            !providerTargetMatches
          ) {
            return pending()
          }
          if (!collected.envelope.gates.some((gate) => gate.required)) {
            return JSON.stringify({
              outcome: 'blocked',
              explanation: 'pipeline-required-gates-missing: 流水线证据未声明任何必需门禁',
            })
          }
          const imported = await createPipelineImportAdapter(
            pipelineEvidenceStore,
            collected.outputBudget,
          ).import({
            stagedRoot: collected.stagedRoot,
            envelope: collected.envelope,
            expectedHeadSha: mergeRequest.headSha,
            expectedTargetSha: targetSha,
          })
          if (!imported.ok) {
            return JSON.stringify({
              outcome: 'blocked',
              explanation: `${imported.code}: ${imported.detail}`,
            })
          }
          const manifest = pipelineEvidenceManifestV1Schema.parse(
            JSON.parse(imported.manifestJson) as unknown,
          )
          const required = manifest.gates.filter((gate) => gate.required)
          if (required.length === 0) {
            return JSON.stringify({
              outcome: 'blocked',
              explanation: 'pipeline-required-gates-missing: 流水线证据未声明任何必需门禁',
            })
          }
          if (manifest.redaction !== 'complete') {
            return JSON.stringify({
              outcome: 'blocked',
              explanation: 'pipeline-evidence-redaction-incomplete: 流水线证据脱敏未完成',
            })
          }
          const caseKey = stableIdentityComponent(plan.caseRef.id)
          const pipelineRelativeRoot = `${PLATFORM_WORKSPACE_DIR}/pipeline/${caseKey}`
          const snapshotRelativeRoot = `${pipelineRelativeRoot}/${manifest.bundleId}`
          const destination = join(workspacePath(plan.caseRef.id), snapshotRelativeRoot)
          // Completed rounds may still reference evidence from an earlier
          // failed attempt. A later green/pending snapshot must not erase that
          // audit material; materialize only the current immutable bundle and
          // leave unrelated prior files in the platform-owned directory.
          pipelineEvidenceStore.materializeBundle(manifest.bundleId, destination)
          const fileById = new Map(manifest.files.map((file) => [file.fileId, file] as const))
          const checks = required.map((gate) => {
            const status =
              gate.status === 'pass'
                ? ('passed' as const)
                : gate.status === 'fail' ||
                    gate.status === 'unknown' ||
                    gate.status === 'unavailable' ||
                    gate.status === 'skipped'
                  ? ('failed' as const)
                  : gate.status
            const evidenceFiles = gate.evidenceFileIds.flatMap((fileId) => {
              const file = fileById.get(fileId)
              return file === undefined ? [] : [`${snapshotRelativeRoot}/${file.relativePath}`]
            })
            return {
              checkRef: gate.gateKey,
              name: gate.gateKey,
              status,
              summary: `${manifest.providerKey} run ${gate.runRef}, attempt ${gate.attempt}`,
              ...(evidenceFiles.length === 0 ? {} : { evidenceFiles }),
            }
          })
          const hasFailure = checks.some(
            (check) => check.status === 'failed' || check.status === 'canceled',
          )
          const hasPending = checks.some(
            (check) => check.status === 'queued' || check.status === 'running',
          )
          const allRequiredPass = required.every((gate) => gateCountsAsPass(gate.status))
          const status = hasFailure
            ? ('failed' as const)
            : hasPending
              ? ('pending' as const)
              : !allRequiredPass
                ? ('failed' as const)
                : ('passed' as const)
          return JSON.stringify({
            outcome: 'completed',
            observedSourceVersion: mergeRequest.headSha,
            ...(mergeRequest.targetSha === null
              ? {}
              : { observedTargetVersion: mergeRequest.targetSha }),
            status,
            checks,
          })
        } finally {
          collected.cleanup()
        }
      }
      if (plan.workItemRef === 'classify-feedback') {
        const currentMr = contexts.find((context) => context.typeId === 'development.merge-request')
        if (currentMr === undefined) {
          return output({ status: 'blocked', summary: '缺少当前 MR 上下文，无法汇总检视意见' })
        }
        const mergeRequest = mergeRequestStateSchema.parse(
          JSON.parse(currentMr.stateJson) as unknown,
        )
        const currentProblemSet = contexts.find(
          (context) => context.typeId === 'development.problem-set',
        )
        const currentResolution = contexts.find(
          (context) => context.typeId === 'development.review-resolution',
        )
        const priorResolution =
          currentResolution === undefined
            ? null
            : reviewResolutionContextSchema.parse(
                JSON.parse(currentResolution.stateJson) as unknown,
              )
        const knownThreadRevisions = new Set(
          priorResolution?.threads.map((thread) => `${thread.threadRef}\u0000${thread.revision}`) ??
            [],
        )
        const actionable = mergeRequest.reviewThreads.filter(
          (thread) =>
            !thread.resolved &&
            thread.authorClass !== 'self' &&
            !knownThreadRevisions.has(`${thread.threadRef}\u0000${thread.revision}`),
        )
        if (actionable.length === 0) {
          return output({
            status: 'needs-input',
            summary: '没有新的外部检视线程需要处理；平台自身回复不会重新触发修复',
          })
        }
        const normalizedThreads = actionable.map((thread) => ({
          ...thread,
          messages:
            thread.messages.length > 0
              ? thread.messages
              : [
                  {
                    messageRef: thread.revision,
                    parentMessageRef: null,
                    authorClass: thread.authorClass,
                    body: thread.body,
                    path: thread.path,
                    createdAt: null,
                  },
                ],
        }))
        const problemSet = problemSetContextSchema.parse({
          status: 'active',
          source: 'review',
          headSha: mergeRequest.headSha,
          remainingTypes: ['review'],
          problems: normalizedThreads.map((thread) => ({
            problemId: thread.threadRef,
            type: 'review',
            summary: `${thread.path ?? 'MR'} · ${thread.body || thread.threadRef}`.slice(0, 2_000),
            evidenceArtifactRefs: [],
            reviewThread: thread,
          })),
        })
        const resolution = reviewResolutionContextSchema.parse({
          status: 'collected',
          mergeRequestRef: mergeRequest.mergeRequestRef,
          sourceHeadSha: mergeRequest.headSha,
          publishedHeadSha: null,
          commitSha: null,
          threads: [
            ...(priorResolution?.threads ?? []),
            ...normalizedThreads.map((thread) => ({
              threadRef: thread.threadRef,
              revision: thread.revision,
              acknowledgement: null,
              disposition: null,
              replyBody: null,
              finalReply: null,
            })),
          ],
        })
        return output({
          summary: `已汇总 ${actionable.length} 棵待处理检视线程树`,
          contextPatches: [
            contextPatch({
              current: currentProblemSet,
              contextTypeId: 'development.problem-set',
              state: problemSet,
            }),
            contextPatch({
              current: currentResolution,
              contextTypeId: 'development.review-resolution',
              state: resolution,
            }),
          ],
        })
      }

      if (plan.workItemRef === 'acknowledge-feedback') {
        const currentMr = contexts.find((context) => context.typeId === 'development.merge-request')
        const currentProblemSet = contexts.find(
          (context) => context.typeId === 'development.problem-set',
        )
        const currentResolution = contexts.find(
          (context) => context.typeId === 'development.review-resolution',
        )
        if (
          currentMr === undefined ||
          currentProblemSet === undefined ||
          currentResolution === undefined
        ) {
          return output({ status: 'blocked', summary: '缺少待确认的检视问题或线程上下文' })
        }
        if (input.mrFacts === undefined) {
          return output({ status: 'blocked', summary: 'MR 检视事实采集程序尚未接入平台' })
        }
        const mergeRequest = mergeRequestStateSchema.parse(
          JSON.parse(currentMr.stateJson) as unknown,
        )
        if (mergeRequest.repositoryRef === null || mergeRequest.providerMrRef === null) {
          return output({ status: 'blocked', summary: 'MR 上下文缺少仓库或代码平台标识' })
        }
        const resolution = reviewResolutionContextSchema.parse(
          JSON.parse(currentResolution.stateJson) as unknown,
        )
        const problemSet = problemSetContextSchema.parse(
          JSON.parse(currentProblemSet.stateJson) as unknown,
        )
        if (problemSet.source !== 'review') {
          return output({ status: 'blocked', summary: '待确认的问题集合不是检视意见' })
        }
        const live = await input.mrFacts.collect(
          mergeRequest.repositoryRef,
          mergeRequest.providerMrRef,
          plan.caseRef.id,
        )
        if (!live.ok) {
          return output({
            status: 'blocked',
            summary: `确认检视意见前刷新线程失败：${live.code} · ${live.detail}`,
          })
        }
        if (
          live.snapshot.state !== 'opened' ||
          live.snapshot.headSha !== mergeRequest.headSha ||
          problemSet.headSha !== mergeRequest.headSha ||
          resolution.sourceHeadSha !== mergeRequest.headSha
        ) {
          return output({
            status: 'needs-input',
            summary: 'MR head 已在检视分类后变化，等待下一份权威 MR 事实重新分类',
          })
        }
        const liveActionableRevisions = new Set(
          live.snapshot.reviewThreads
            .filter((thread) => !thread.resolved && thread.authorClass !== 'self')
            .map((thread) => `${thread.threadRef}\u0000${thread.revision}`),
        )
        const retiredRevisions = new Set<string>()
        const nextThreads = []
        let replyCount = 0
        for (const thread of resolution.threads) {
          if (thread.acknowledgement !== null || thread.finalReply !== null) {
            nextThreads.push(thread)
            continue
          }
          const revisionKey = `${thread.threadRef}\u0000${thread.revision}`
          if (!liveActionableRevisions.has(revisionKey)) {
            retiredRevisions.add(revisionKey)
            continue
          }
          const marker = reviewReplyMarker({
            caseId: plan.caseRef.id,
            phase: 'received',
            threadRef: thread.threadRef,
            revision: thread.revision,
          })
          const existing = live.snapshot.reviewThreads
            .find((candidate) => candidate.threadRef === thread.threadRef)
            ?.messages.find((message) => message.body.includes(reviewMarkerToken(marker)))
          if (existing !== undefined) {
            nextThreads.push({
              ...thread,
              acknowledgement: { marker, noteRef: existing.messageRef },
            })
            continue
          }
          const replied = await input.mrEffects.reply(mergeRequest.repositoryRef, {
            mrRef: mergeRequest.providerMrRef,
            threadRef: thread.threadRef,
            body: '已收到该检视意见，正在处理。',
            selfMarker: marker,
          })
          if (!replied.ok) {
            return output({
              status: 'blocked',
              summary: `回复检视意见失败：${replied.code} · ${replied.detail}`,
            })
          }
          replyCount += 1
          nextThreads.push({
            ...thread,
            acknowledgement: { marker, noteRef: replied.noteRef },
          })
        }
        const nextProblems = problemSet.problems.filter((problem) => {
          if (problem.reviewThread === null) return true
          return !retiredRevisions.has(
            `${problem.reviewThread.threadRef}\u0000${problem.reviewThread.revision}`,
          )
        })
        const problemSetRetired = nextProblems.length !== problemSet.problems.length
        const noCurrentReviewProblems = nextProblems.length === 0
        const nextResolution = reviewResolutionContextSchema.parse({
          ...resolution,
          status: nextThreads.length === 0 ? 'collected' : 'acknowledged',
          publishedHeadSha: nextThreads.length === 0 ? null : resolution.publishedHeadSha,
          commitSha: nextThreads.length === 0 ? null : resolution.commitSha,
          threads: nextThreads,
        })
        return output({
          summary:
            retiredRevisions.size === 0
              ? `已逐线程确认 ${nextThreads.filter((thread) => thread.finalReply === null).length} 条检视意见`
              : noCurrentReviewProblems
                ? `权威 MR 快照已不再包含 ${retiredRevisions.size} 条待确认检视意见，已自动淘汰并继续观察 MR`
                : `已淘汰 ${retiredRevisions.size} 条失效检视意见，并确认其余 ${replyCount} 条`,
          contextPatches: [
            contextPatch({
              current: currentResolution,
              contextTypeId: 'development.review-resolution',
              state: nextResolution,
            }),
            ...(problemSetRetired
              ? [
                  contextPatch({
                    current: currentProblemSet,
                    contextTypeId: 'development.problem-set',
                    lifecycleState: noCurrentReviewProblems ? 'terminal' : 'active',
                    state: problemSetContextSchema.parse({
                      ...problemSet,
                      status: noCurrentReviewProblems ? 'resolved' : 'active',
                      remainingTypes: noCurrentReviewProblems ? [] : ['review'],
                      problems: nextProblems,
                    }),
                  }),
                ]
              : []),
          ],
          effectSuggestions: replyCount > 0 ? ['code-host.merge-request.reply'] : [],
        })
      }

      if (plan.workItemRef === 'reply-feedback') {
        const currentMr = contexts.find((context) => context.typeId === 'development.merge-request')
        const currentResolution = contexts.find(
          (context) => context.typeId === 'development.review-resolution',
        )
        if (currentMr === undefined || currentResolution === undefined) {
          return output({ status: 'blocked', summary: '缺少已发布提交或检视处理说明' })
        }
        if (input.mrFacts === undefined) {
          return output({ status: 'blocked', summary: 'MR 检视事实采集程序尚未接入平台' })
        }
        const mergeRequest = mergeRequestStateSchema.parse(
          JSON.parse(currentMr.stateJson) as unknown,
        )
        const resolution = reviewResolutionContextSchema.parse(
          JSON.parse(currentResolution.stateJson) as unknown,
        )
        if (
          resolution.status !== 'prepared' ||
          mergeRequest.repositoryRef === null ||
          mergeRequest.providerMrRef === null
        ) {
          return output({ status: 'blocked', summary: '检视处理说明尚未准备好或 MR 标识不完整' })
        }
        const live = await input.mrFacts.collect(
          mergeRequest.repositoryRef,
          mergeRequest.providerMrRef,
          plan.caseRef.id,
        )
        if (!live.ok) {
          return output({
            status: 'blocked',
            summary: `回复修复结果前刷新线程失败：${live.code} · ${live.detail}`,
          })
        }
        const nextThreads = []
        for (const thread of resolution.threads) {
          if (thread.finalReply !== null) {
            nextThreads.push(thread)
            continue
          }
          if (thread.disposition === null || thread.replyBody === null) {
            return output({ status: 'blocked', summary: `线程 ${thread.threadRef} 缺少处理说明` })
          }
          const marker = reviewReplyMarker({
            caseId: plan.caseRef.id,
            phase: 'resolved',
            threadRef: thread.threadRef,
            revision: thread.revision,
            commitSha: mergeRequest.headSha,
          })
          const existing = live.snapshot.reviewThreads
            .find((candidate) => candidate.threadRef === thread.threadRef)
            ?.messages.find((message) => message.body.includes(reviewMarkerToken(marker)))
          if (existing !== undefined) {
            nextThreads.push({
              ...thread,
              finalReply: { marker, noteRef: existing.messageRef },
            })
            continue
          }
          const body =
            thread.disposition === 'addressed'
              ? `已在提交 ${mergeRequest.headSha.slice(0, 12)} 中处理。\n\n${thread.replyBody}`
              : `该意见需要人工决策，数字员工已暂停自动处理。\n\n${thread.replyBody}`
          const replied = await input.mrEffects.reply(mergeRequest.repositoryRef, {
            mrRef: mergeRequest.providerMrRef,
            threadRef: thread.threadRef,
            body,
            selfMarker: marker,
          })
          if (!replied.ok) {
            return output({
              status: 'blocked',
              summary: `回复检视修复结果失败：${replied.code} · ${replied.detail}`,
            })
          }
          nextThreads.push({ ...thread, finalReply: { marker, noteRef: replied.noteRef } })
        }
        return output({
          summary: `已把 ${nextThreads.length} 条检视处理说明回复到原线程`,
          contextPatches: [
            contextPatch({
              current: currentResolution,
              contextTypeId: 'development.review-resolution',
              lifecycleState: 'terminal',
              state: reviewResolutionContextSchema.parse({
                ...resolution,
                status: 'replied',
                publishedHeadSha: mergeRequest.headSha,
                commitSha: mergeRequest.headSha,
                threads: nextThreads,
              }),
            }),
          ],
          effectSuggestions: ['code-host.merge-request.reply'],
        })
      }

      if (plan.workItemRef === 'submit-approval') {
        const current = contexts.find((context) => context.typeId === 'development.approval')
        if (current === undefined) {
          return output({ status: 'blocked', summary: '缺少已校验的外部审批草稿上下文' })
        }
        if (input.approvalGateway === undefined) {
          return output({ status: 'blocked', summary: '外部审批程序尚未接入平台' })
        }
        const approval = approvalContextSchema.parse(JSON.parse(current.stateJson) as unknown)
        if (approval.status !== 'draft') {
          return output({ status: 'blocked', summary: '外部审批草稿状态不允许再次提交' })
        }
        if (
          plan.connectionRef != null &&
          (approval.adapterRef.id !== plan.connectionRef.id ||
            approval.adapterRef.revision !== plan.connectionRef.revision)
        ) {
          return output({ status: 'blocked', summary: '外部审批草稿未使用员工冻结的企业连接' })
        }
        const deadlineAt = new Date(now() + plan.externalWaitDeadlineMs).toISOString()
        const idempotencyKey = sha256Hex(
          JSON.stringify({
            caseRef: plan.caseRef.id,
            adapterRef: approval.adapterRef,
            validatedDraftRef: approval.validatedDraftRef,
          }),
        )
        const intent = {
          stepRunRef: plan.roundRef,
          adapterRef: approval.adapterRef,
          validatedDraftRef: approval.validatedDraftRef,
          deadlineAt,
          idempotencyKey,
        }
        // This digest is part of the approval adapter protocol. Keep it on the
        // same canonical representation used by the Integration-owned runner;
        // plain JSON.stringify depends on insertion order and makes a genuine
        // adapter receipt look unrelated to the frozen platform intent.
        const intentDigest = canonicalDigest(intent)
        input.db
          .insert(employeeApprovalSagas)
          .values({
            id: `employee-approval:${idempotencyKey}`,
            caseId: plan.caseRef.id,
            submitRoundId: plan.roundRef,
            adapterId: approval.adapterRef.id,
            adapterRevision: approval.adapterRef.revision,
            validatedDraftRef: approval.validatedDraftRef,
            deadlineAt,
            idempotencyKey,
            intentDigest,
            correlationRef: null,
            externalRequestRef: null,
            submittedRevision: null,
            submittedAt: null,
            latestStatus: 'prepared',
            observedRevision: null,
            evidenceRef: null,
            observedAt: null,
            createdAt: now(),
            updatedAt: now(),
          })
          .onConflictDoNothing({ target: employeeApprovalSagas.idempotencyKey })
          .run()
        const saga = input.db
          .select()
          .from(employeeApprovalSagas)
          .where(eq(employeeApprovalSagas.idempotencyKey, idempotencyKey))
          .get()
        if (
          saga === undefined ||
          saga.caseId !== plan.caseRef.id ||
          saga.adapterId !== approval.adapterRef.id ||
          saga.adapterRevision !== approval.adapterRef.revision ||
          saga.validatedDraftRef !== approval.validatedDraftRef
        ) {
          return output({ status: 'blocked', summary: '外部审批幂等身份与冻结输入冲突' })
        }
        let receipt =
          saga.correlationRef === null
            ? await input.approvalGateway.lookupByIdempotencyKey({
                adapterRef: approval.adapterRef,
                idempotencyKey,
              })
            : {
                intentDigest: saga.intentDigest,
                correlationRef: saga.correlationRef,
                externalRequestRef: saga.externalRequestRef!,
                submittedRevision: saga.submittedRevision!,
                submittedAt: saga.submittedAt!,
              }
        if (receipt === null) {
          const submitted = await input.approvalGateway.submit(intent)
          if (!submitted.ok) {
            return output({
              status: 'blocked',
              summary: `外部审批提交失败：${submitted.failure.code} · ${submitted.failure.remediation}`,
            })
          }
          receipt = submitted.receipt
        }
        if (receipt.intentDigest !== intentDigest) {
          return output({ status: 'blocked', summary: '外部审批回执不属于冻结提交意图' })
        }
        input.db
          .update(employeeApprovalSagas)
          .set({
            correlationRef: receipt.correlationRef,
            externalRequestRef: receipt.externalRequestRef,
            submittedRevision: receipt.submittedRevision,
            submittedAt: receipt.submittedAt,
            latestStatus: 'pending',
            updatedAt: now(),
          })
          .where(eq(employeeApprovalSagas.idempotencyKey, idempotencyKey))
          .run()
        const subjectRef = encodeDevelopmentApprovalSubject({
          adapterRef: approval.adapterRef,
          correlationRef: receipt.correlationRef,
        })
        return output({
          summary: `外部审批 ${receipt.externalRequestRef} 已提交，等待结果`,
          contextPatches: [
            contextPatch({
              current,
              contextTypeId: 'development.approval',
              state: approvalContextSchema.parse({
                ...approval,
                status: 'pending',
                subjectRef,
                deadlineAt,
                idempotencyKey,
                correlationRef: receipt.correlationRef,
                externalRequestRef: receipt.externalRequestRef,
                submittedRevision: receipt.submittedRevision,
              }),
            }),
          ],
          effectSuggestions: ['external-approval.submit'],
        })
      }

      if (plan.workItemRef === 'observe-approval') {
        const current = contexts.find((context) => context.typeId === 'development.approval')
        if (current === undefined) {
          return output({ status: 'blocked', summary: '缺少需要观察的外部审批上下文' })
        }
        if (input.approvalGateway === undefined) {
          return output({ status: 'blocked', summary: '外部审批程序尚未接入平台' })
        }
        const approval = approvalContextSchema.parse(JSON.parse(current.stateJson) as unknown)
        if (
          plan.connectionRef != null &&
          (approval.adapterRef.id !== plan.connectionRef.id ||
            approval.adapterRef.revision !== plan.connectionRef.revision)
        ) {
          return output({ status: 'blocked', summary: '外部审批观察未使用员工冻结的企业连接' })
        }
        if (
          approval.correlationRef === null ||
          approval.idempotencyKey === null ||
          approval.deadlineAt === null
        ) {
          return output({ status: 'blocked', summary: '外部审批上下文缺少提交回执' })
        }
        const saga = input.db
          .select()
          .from(employeeApprovalSagas)
          .where(eq(employeeApprovalSagas.idempotencyKey, approval.idempotencyKey))
          .get()
        if (saga === undefined || saga.caseId !== plan.caseRef.id) {
          return output({ status: 'blocked', summary: '外部审批持久回执不存在或归属不匹配' })
        }
        const terminal = new Set(['approved', 'rejected', 'expired', 'unavailable'])
        let status = terminal.has(saga.latestStatus) ? saga.latestStatus : null
        let observedRevision = saga.observedRevision
        let evidenceRef = saga.evidenceRef
        if (status === null) {
          if (Date.parse(approval.deadlineAt) <= now()) {
            status = 'expired'
            observedRevision = saga.observedRevision ?? `deadline:${approval.deadlineAt}`
          } else {
            const observed = await input.approvalGateway.observe({
              adapterRef: approval.adapterRef,
              correlationRef: approval.correlationRef,
            })
            if (!observed.ok) {
              return output({
                // The durable approval Attention remains armed while the
                // Context is pending. A provider outage is therefore an
                // inconclusive observation, not a business-terminal failure:
                // leave the Context untouched and let the next webhook/timer
                // wake retry the short call without user intervention.
                status: 'needs-input',
                summary: `外部审批暂时无法观察：${observed.failure.code} · ${observed.failure.remediation}`,
              })
            }
            status = observed.receipt.status
            observedRevision = observed.receipt.observedRevision
            evidenceRef = observed.receipt.evidenceRef
          }
          input.db
            .update(employeeApprovalSagas)
            .set({
              latestStatus: status,
              observedRevision,
              evidenceRef,
              observedAt: new Date(now()).toISOString(),
              updatedAt: now(),
            })
            .where(eq(employeeApprovalSagas.idempotencyKey, approval.idempotencyKey))
            .run()
        }
        const nextApproval = approvalContextSchema.parse({
          ...approval,
          status,
          observedRevision,
          evidenceRef,
        })
        return output({
          status: status === 'approved' ? 'ok' : status === 'pending' ? 'needs-input' : 'blocked',
          summary:
            status === 'approved'
              ? '外部审批已通过'
              : status === 'pending'
                ? '外部审批仍在等待处理'
                : `外部审批以 ${status} 结束，需要人工处理`,
          contextPatches: [
            contextPatch({
              current,
              contextTypeId: 'development.approval',
              lifecycleState: status === 'pending' ? 'active' : 'terminal',
              state: nextApproval,
              artifactRefs: evidenceRef === null ? [] : [evidenceRef],
            }),
          ],
          effectSuggestions: ['external-approval.observe'],
          artifactRefs: evidenceRef === null ? [] : [evidenceRef],
        })
      }

      if (plan.workItemRef === 'prepare-change') {
        const issue = issueOf(contexts)
        const { row, repository } = currentWorkspace(plan.caseRef.id)
        if (issue.state.deliveryContent === null) {
          return output({
            status: 'blocked',
            summary: 'Agent 未输出提交信息与 MR 标题/正文，不能形成修改候选',
          })
        }
        const summarySource = issue.state.deliveryContent.commitMessage
        const resolvedUploadPlan = await resolveEmployeeUploadPlan({
          uploads: issue.state.request.uploads,
          baselineRepoPath: repository.localPath,
          baselineSha: row.baselineSha,
          workspaceRoot: workspacePath(plan.caseRef.id),
        })
        if (!resolvedUploadPlan.ok) {
          return output({
            status: 'blocked',
            summary: `上传目标不可提交：${resolvedUploadPlan.code} · ${resolvedUploadPlan.detail}`,
          })
        }
        const uploadPlan = resolvedUploadPlan.plan
        const derived = await candidateOps.derive({
          baselineRepoPath: repository.localPath,
          baselineSha: row.baselineSha,
          overlayRoot: workspacePath(plan.caseRef.id),
          excludePolicyDigest: sha256Hex('digital-employee-workspace-v1'),
          agentOutcomeRef: plan.triggeringEventRef,
          uploadPlan,
          uploadsAlreadyPublished: row.state === 'published',
        })
        if (!derived.ok) {
          return output({
            status: 'blocked',
            summary: `无法形成修改候选：${derived.code} · ${derived.detail}`,
          })
        }
        const timestamp = now()
        input.db
          .insert(employeeChangeCandidates)
          .values({
            candidateRef: derived.receipt.candidateRef,
            caseId: plan.caseRef.id,
            roundId: plan.roundRef,
            baselineSha: row.baselineSha,
            treeOid: derived.receipt.treeOid,
            receiptJson: JSON.stringify({ ...derived.receipt, uploadPlan }),
            summarySource,
            state: 'prepared',
            commitSha: null,
            pushReceiptJson: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing()
          .run()
        const current = contexts.find(
          (context) => context.typeId === 'development.change-candidate',
        )
        const state = candidateStateSchema.parse({
          status: 'prepared',
          candidateRef: derived.receipt.candidateRef,
          baselineSha: row.baselineSha,
          treeOid: derived.receipt.treeOid,
          summarySource,
          changedPaths: [
            ...derived.receipt.changed.added,
            ...derived.receipt.changed.modified,
            ...derived.receipt.changed.deleted,
          ],
          commitSha: null,
        })
        return output({
          summary: `已形成 ${state.changedPaths.length} 个文件的修改候选`,
          contextPatches: [
            contextPatch({
              current,
              contextTypeId: 'development.change-candidate',
              state,
            }),
          ],
          effectSuggestions: ['source-control.candidate'],
        })
      }

      if (plan.workItemRef === 'publish-mr') {
        const issue = issueOf(contexts)
        if (issue.state.deliveryContent === null) {
          return output({
            status: 'blocked',
            summary: 'Agent 交付内容缺失，不能提交代码或创建 MR',
          })
        }
        const deliveryContent = issue.state.deliveryContent
        const { row, repository } = currentWorkspace(plan.caseRef.id)
        const candidateContext = contexts.find(
          (context) => context.typeId === 'development.change-candidate',
        )
        if (candidateContext === undefined) {
          return output({ status: 'blocked', summary: '缺少可发布的修改候选上下文' })
        }
        const candidateState = candidateStateSchema.parse(
          JSON.parse(candidateContext.stateJson) as unknown,
        )
        const candidate = input.db
          .select()
          .from(employeeChangeCandidates)
          .where(eq(employeeChangeCandidates.candidateRef, candidateState.candidateRef))
          .get()
        if (candidate === undefined || candidate.state === 'obsolete') {
          return output({ status: 'blocked', summary: '修改候选已经失效，请重新形成候选' })
        }
        const receipt = z
          .object({
            treeOid: z.string().min(1),
            uploadPlan: employeeUploadPlanSchema.nullable(),
            uploadLineage: z
              .object({ planDigest: z.string(), finalDigests: z.array(z.unknown()) })
              .nullable(),
          })
          .passthrough()
          .parse(JSON.parse(candidate.receiptJson) as unknown)
        const committed =
          candidate.commitSha === null
            ? await delivery.commit({
                baselineRepoPath: repository.localPath,
                baselineSha: candidate.baselineSha,
                overlayRoot: workspacePath(plan.caseRef.id),
                expectedTreeOid: candidate.treeOid,
                missionId: plan.caseRef.id,
                summarySource: candidate.summarySource,
                contextEnvelope: {
                  employeeCaseRef: plan.caseRef.id,
                  issueContextRef: issue.context.id,
                  schemaRef: 'issue-handling.v1',
                  workItemRef: issue.state.subjectRef,
                },
                uploadPlan:
                  receipt.uploadPlan === null
                    ? null
                    : {
                        entries: receipt.uploadPlan.entries.map((entry) => ({
                          targetPath: entry.targetPath,
                          disposition: entry.disposition,
                          fileMode: entry.fileMode,
                        })),
                      },
              })
            : {
                ok: true as const,
                commitSha: candidate.commitSha,
                localRef: '',
                reused: true,
              }
        if (!committed.ok) {
          return output({
            status: 'blocked',
            summary: `平台提交失败：${committed.code} · ${committed.detail}`,
          })
        }
        input.db
          .update(employeeChangeCandidates)
          .set({ state: 'committed', commitSha: committed.commitSha, updatedAt: now() })
          .where(eq(employeeChangeCandidates.candidateRef, candidate.candidateRef))
          .run()
        const remote = input.repoRemote.resolve(issue.state.repositoryRef)
        if (remote === null) {
          return output({ status: 'blocked', summary: '目标仓库的远端凭据或地址不可用' })
        }
        const pushed = await delivery.push({
          baselineRepoPath: repository.localPath,
          commitSha: committed.commitSha,
          remoteUrl: remote.remoteUrl,
          branch: row.sourceBranch,
          expectedRemoteSha: row.remoteHeadSha,
          expectedTreeOid: receipt.treeOid,
          baselineSha: candidate.baselineSha,
          publicationSubject: publicationSubject(),
        })
        if (!pushed.ok) {
          return output({
            status: 'blocked',
            summary: `平台推送失败：${pushed.code} · ${pushed.detail}`,
          })
        }
        const ensured = await input.mrEffects.ensure(issue.state.repositoryRef, {
          missionId: plan.caseRef.id,
          sourceBranch: row.sourceBranch,
          targetBranch: row.targetBranch,
          title: deliveryContent.mergeRequestTitle,
          description: [
            deliveryContent.mergeRequestDescription,
            '',
            `Agent-Workflow-Case: ${plan.caseRef.id}`,
            `Agent-Workflow-Context: ${issue.context.id}`,
            'Agent-Workflow-Schema: issue-handling.v1',
            `Work-Item: ${issue.state.subjectRef
              .replace(/[\r\n]+/g, ' ')
              .trim()
              .slice(0, 1_000)}`,
            `Change candidate: ${candidate.candidateRef}`,
          ].join('\n'),
        })
        if (!ensured.ok) {
          return output({
            status: 'blocked',
            summary: `MR 创建或绑定失败：${ensured.code} · ${ensured.detail}`,
          })
        }
        const publishedCheckpoint = join(
          caseDirectory(plan.caseRef.id),
          'published',
          candidate.candidateRef,
        )
        const checkpoint = workspaceOps.checkpoint({
          workspacePath: workspacePath(plan.caseRef.id),
          checkpointRoot: publishedCheckpoint,
        })
        await workspaceOps.restore({
          caseRoot: sceneRoot(plan.caseRef.id),
          baselineRepoPath: repository.localPath,
          baselineSha: committed.commitSha,
          checkpointRoot: publishedCheckpoint,
          expectedCheckpointDigest: checkpoint.checkpointDigest,
        })
        input.db.transaction((tx) => {
          tx.update(employeeChangeCandidates)
            .set({
              state: 'published',
              commitSha: committed.commitSha,
              pushReceiptJson: JSON.stringify(pushed.receipt),
              updatedAt: now(),
            })
            .where(eq(employeeChangeCandidates.candidateRef, candidate.candidateRef))
            .run()
          tx.update(employeeCaseWorkspaces)
            .set({
              baselineSha: committed.commitSha,
              remoteHeadSha: committed.commitSha,
              state: 'published',
              updatedAt: now(),
            })
            .where(eq(employeeCaseWorkspaces.caseId, plan.caseRef.id))
            .run()
        })
        const currentMr = contexts.find((context) => context.typeId === 'development.merge-request')
        const currentPipeline = contexts.find(
          (context) => context.typeId === 'development.pipeline',
        )
        const mrState = mergeRequestStateSchema.parse({
          status:
            ensured.mr.state === 'opened'
              ? 'active'
              : ensured.mr.state === 'merged'
                ? 'merged'
                : 'closed',
          mergeRequestRef: `${issue.state.repositoryRef}!${ensured.mr.mrRef}`,
          // The successful CAS push is the authority for the revision published
          // by this work item. An existing MR response may still expose its
          // pre-push source SHA while the provider converges.
          headSha: committed.commitSha,
          issueHandlingContextRef: issue.context.id,
          readyToMerge: false,
          factsHeadSha: null,
          targetSha: null,
          draft: false,
          mergeableState: 'unknown',
          approvalHold: null,
          unresolvedReviewCount: 0,
          reviewThreads: [],
          repositoryRef: issue.state.repositoryRef,
          providerMrRef: ensured.mr.mrRef,
          sourceBranch: row.sourceBranch,
          targetBranch: row.targetBranch,
          webUrl: ensured.mr.webUrl,
        })
        const pipelinePatch = pendingPipelinePatch({
          current: currentPipeline,
          caseId: plan.caseRef.id,
          active: mrState.status === 'active',
          allowCreate: true,
          mergeRequestRef: mrState.mergeRequestRef,
          headSha: mrState.headSha,
          targetSha: targetAwarePipeline ? mrState.targetSha : null,
        })
        return output({
          summary: ensured.mr.created === true ? '已提交并创建 MR' : '已提交并更新 MR',
          contextPatches: [
            contextPatch({
              current: candidateContext,
              contextTypeId: 'development.change-candidate',
              state: { ...candidateState, status: 'published', commitSha: committed.commitSha },
            }),
            contextPatch({
              current: currentMr,
              contextTypeId: 'development.merge-request',
              lifecycleState: mrState.status === 'active' ? 'active' : 'terminal',
              state: mrState,
            }),
            ...(pipelinePatch === null ? [] : [pipelinePatch]),
          ],
          effectSuggestions: [
            'source-control.commit',
            'source-control.push',
            'code-host.merge-request.ensure',
          ],
        })
      }

      if (plan.workItemRef === 'publish-conflict') {
        const current = contexts.find((context) => context.typeId === 'development.merge-request')
        const currentPipeline = contexts.find(
          (context) => context.typeId === 'development.pipeline',
        )
        if (current === undefined) {
          return output({ status: 'blocked', summary: '缺少需要发布冲突修复的 MR 上下文' })
        }
        const state = mergeRequestStateSchema.parse(JSON.parse(current.stateJson) as unknown)
        const repairRound = input.reactionRounds.lastSettledRound({
          caseId: plan.caseRef.id,
          workItemRef: 'repair-conflict',
        })
        const repairState =
          repairRound === null
            ? undefined
            : input.db
                .select({ validationJson: employeeRoundWorkspaceStates.validationJson })
                .from(employeeRoundWorkspaceStates)
                .where(eq(employeeRoundWorkspaceStates.roundId, repairRound.roundRef))
                .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
                .get()
        const validation =
          repairState?.validationJson === null || repairState?.validationJson === undefined
            ? null
            : conflictValidationSchema.safeParse(JSON.parse(repairState.validationJson) as unknown)
        if (validation === null || !validation.success) {
          return output({ status: 'blocked', summary: '冲突修复现场尚未通过平台校验' })
        }
        const conflict = validation.data.conflict
        const { row, repository } = currentWorkspace(plan.caseRef.id)
        if (
          state.status !== 'active' ||
          state.headSha !== conflict.sourceSha ||
          state.targetSha !== conflict.targetSha
        ) {
          return output({ status: 'blocked', summary: 'MR 头已变化，冲突修复现场必须重新生成' })
        }
        if (
          businessTreeSnapshotDigest(businessTreeSnapshot(conflict.workspacePath)) !==
          validation.data.postBusinessDigest
        ) {
          return output({
            status: 'blocked',
            summary: '冲突修复现场在平台校验后发生变化，必须重新生成',
          })
        }
        const finished = await input.conflictMerge.finish({
          ...conflict,
          validatedChangedPaths: validation.data.changedPaths,
          missionId: plan.caseRef.id,
        })
        if (!finished.ok) {
          return output({
            status: 'blocked',
            summary: `平台收口冲突修复失败：${finished.code} · ${finished.detail}`,
          })
        }
        const alreadyPublished =
          row.baselineSha === finished.mergeCommitSha &&
          row.remoteHeadSha === finished.mergeCommitSha
        if (!alreadyPublished) {
          if (row.remoteHeadSha !== conflict.sourceSha || row.baselineSha !== conflict.sourceSha) {
            return output({
              status: 'blocked',
              summary: '员工工作区头已变化，冲突修复不能覆盖新的提交',
            })
          }
          const remote = input.repoRemote.resolve(row.repositoryId)
          if (remote === null) {
            return output({ status: 'blocked', summary: '目标仓库的远端凭据或地址不可用' })
          }
          await workspaceOps.importCommit({
            baselineRepoPath: repository.localPath,
            sourceRepoPath: conflict.workspacePath,
            commitSha: finished.mergeCommitSha,
          })
          const pushed = await delivery.push({
            baselineRepoPath: repository.localPath,
            commitSha: finished.mergeCommitSha,
            remoteUrl: remote.remoteUrl,
            branch: row.sourceBranch,
            expectedRemoteSha: conflict.sourceSha,
            expectedTreeOid: finished.treeOid,
            baselineSha: conflict.sourceSha,
            publicationSubject: publicationSubject(),
          })
          if (!pushed.ok) {
            return output({
              status: 'blocked',
              summary: `平台推送冲突修复失败：${pushed.code} · ${pushed.detail}`,
            })
          }
          await workspaceOps.rematerialize({
            caseRoot: sceneRoot(plan.caseRef.id),
            baselineRepoPath: repository.localPath,
            baselineSha: finished.mergeCommitSha,
            currentWorkspacePath: workspacePath(plan.caseRef.id),
          })
          input.db
            .update(employeeCaseWorkspaces)
            .set({
              baselineSha: finished.mergeCommitSha,
              remoteHeadSha: finished.mergeCommitSha,
              state: 'published',
              updatedAt: now(),
            })
            .where(eq(employeeCaseWorkspaces.caseId, plan.caseRef.id))
            .run()
        }
        const next = mergeRequestStateSchema.parse({
          ...state,
          headSha: finished.mergeCommitSha,
          factsHeadSha: null,
          mergeableState: 'unknown',
          readyToMerge: false,
        })
        const pipelinePatch = pendingPipelinePatch({
          current: currentPipeline,
          caseId: plan.caseRef.id,
          active: next.status === 'active',
          allowCreate: true,
          mergeRequestRef: next.mergeRequestRef,
          headSha: next.headSha,
          targetSha: targetAwarePipeline ? next.targetSha : null,
        })
        return output({
          summary: '冲突已由平台形成 merge commit 并推送，等待重新获取 MR 事实',
          contextPatches: [
            contextPatch({
              current,
              contextTypeId: 'development.merge-request',
              state: next,
            }),
            ...(pipelinePatch === null ? [] : [pipelinePatch]),
          ],
          effectSuggestions: ['source-control.commit', 'source-control.push'],
        })
      }

      if (plan.workItemRef === 'observe-mr' || plan.workItemRef === 'wait-merge') {
        const current = contexts.find((context) => context.typeId === 'development.merge-request')
        const currentPipeline = contexts.find(
          (context) => context.typeId === 'development.pipeline',
        )
        if (current === undefined) {
          return output({ status: 'blocked', summary: '缺少需要看护的 MR 上下文' })
        }
        const state = mergeRequestStateSchema.parse(JSON.parse(current.stateJson) as unknown)
        if (state.repositoryRef === null) {
          return output({
            status: 'blocked',
            summary: 'MR 上下文缺少仓库引用，无法独立获取生命周期事实',
          })
        }
        const repositoryId = state.repositoryRef
        const providerMrRef =
          state.providerMrRef ??
          state.mergeRequestRef.slice(state.mergeRequestRef.lastIndexOf('!') + 1)
        const observed = await input.mrEffects.observe(repositoryId, providerMrRef)
        if (!observed.ok) {
          return output({
            status: 'blocked',
            summary: `MR 状态获取失败：${observed.code} · ${observed.detail}`,
          })
        }
        const facts =
          input.mrFacts === undefined
            ? null
            : await input.mrFacts.collect(repositoryId, providerMrRef, plan.caseRef.id)
        if (facts !== null && !facts.ok) {
          return output({
            status: 'blocked',
            summary: `MR 详细事实获取失败：${facts.code} · ${facts.detail}`,
          })
        }
        const factsSnapshot = facts?.ok === true ? facts.snapshot : null
        const nextHead = factsSnapshot?.headSha ?? observed.observation.sourceSha ?? state.headSha
        const observedState = factsSnapshot?.state ?? observed.observation.state
        const workspace = currentWorkspace(plan.caseRef.id)
        if (workspace.row.repositoryId !== repositoryId) {
          return output({ status: 'blocked', summary: 'MR 上下文与员工工作区的仓库不一致' })
        }
        const sourceHeadChanged =
          observedState === 'opened' &&
          (workspace.row.remoteHeadSha !== nextHead || workspace.row.baselineSha !== nextHead)
        const conflictTargetHead =
          factsSnapshot?.mergeableState === 'conflict' ? factsSnapshot.targetSha : null
        const conflictTargetBranch =
          factsSnapshot?.mergeableState === 'conflict' ? factsSnapshot.targetBranch : null
        if (observedState === 'opened' && (sourceHeadChanged || conflictTargetHead !== null)) {
          const remote = input.repoRemote.resolve(repositoryId)
          if (remote === null) {
            return output({ status: 'blocked', summary: '目标仓库的远端凭据或地址不可用' })
          }
          if (conflictTargetHead !== null && conflictTargetBranch !== null) {
            const fetchedTarget = await workspaceOps.fetchRemoteHead({
              baselineRepoPath: workspace.repository.localPath,
              remoteUrl: remote.remoteUrl,
              branch: conflictTargetBranch,
              expectedHeadSha: conflictTargetHead,
              publicationSubject: publicationSubject(),
            })
            if (!fetchedTarget.ok) {
              return output({
                status: 'needs-input',
                summary: 'MR target 在事实读取与 Git 获取之间已前进，等待下一份权威 MR 事实后重试',
              })
            }
          }
          if (sourceHeadChanged) {
            const sourceBranch = state.sourceBranch ?? workspace.row.sourceBranch
            const fetchedSource = await workspaceOps.fetchRemoteHead({
              baselineRepoPath: workspace.repository.localPath,
              remoteUrl: remote.remoteUrl,
              branch: sourceBranch,
              expectedHeadSha: nextHead,
              publicationSubject: publicationSubject(),
            })
            if (!fetchedSource.ok) {
              return output({
                status: 'needs-input',
                summary: 'MR source 在事实读取与 Git 获取之间已前进，等待下一份权威 MR 事实后重试',
              })
            }
            await workspaceOps.rematerialize({
              caseRoot: sceneRoot(plan.caseRef.id),
              baselineRepoPath: workspace.repository.localPath,
              baselineSha: nextHead,
              currentWorkspacePath: workspacePath(plan.caseRef.id),
            })
            input.db
              .update(employeeCaseWorkspaces)
              .set({
                baselineSha: nextHead,
                remoteHeadSha: nextHead,
                state: 'published',
                updatedAt: now(),
              })
              .where(eq(employeeCaseWorkspaces.caseId, plan.caseRef.id))
              .run()
          }
        }
        const next = mergeRequestStateSchema.parse({
          ...state,
          status:
            observedState === 'opened'
              ? 'active'
              : observedState === 'merged'
                ? 'merged'
                : 'closed',
          headSha: nextHead,
          factsHeadSha: factsSnapshot === null ? state.factsHeadSha : factsSnapshot.headSha,
          targetSha: factsSnapshot === null ? state.targetSha : factsSnapshot.targetSha,
          mergedCommitSha:
            factsSnapshot === null ? state.mergedCommitSha : factsSnapshot.mergedCommitSha,
          draft: factsSnapshot?.draft ?? state.draft,
          mergeableState: factsSnapshot?.mergeableState ?? state.mergeableState,
          approvalHold: factsSnapshot === null ? state.approvalHold : factsSnapshot.approvalHold,
          unresolvedReviewCount:
            factsSnapshot?.headSha === null || factsSnapshot === null
              ? state.unresolvedReviewCount
              : factsSnapshot.unresolvedReviewCount,
          reviewThreads:
            factsSnapshot?.headSha === null || factsSnapshot === null
              ? state.reviewThreads
              : factsSnapshot.reviewThreads,
          readyToMerge:
            observedState === 'opened' &&
            nextHead === state.headSha &&
            (!targetAwarePipeline ||
              factsSnapshot === null ||
              factsSnapshot.targetSha === state.targetSha)
              ? state.readyToMerge
              : false,
          targetBranch:
            factsSnapshot?.targetBranch ?? observed.observation.targetBranch ?? state.targetBranch,
          webUrl: observed.observation.webUrl ?? state.webUrl,
          repositoryRef: repositoryId,
          providerMrRef,
        })
        const pipelinePatch = pendingPipelinePatch({
          current: currentPipeline,
          caseId: plan.caseRef.id,
          active: next.status === 'active',
          // Frozen pre-v8 reactions did not include the pipeline Context in
          // observe-mr plans. Absence there means "not in this plan", not
          // "missing from the Case", so creating would duplicate identity.
          allowCreate: false,
          mergeRequestRef: next.mergeRequestRef,
          headSha: next.headSha,
          targetSha: targetAwarePipeline ? next.targetSha : null,
        })
        const reviewReconciliationPatches =
          factsSnapshot?.headSha === null || factsSnapshot === null
            ? []
            : reconcileStaleReviewSelection({
                contexts,
                liveReviewThreads: factsSnapshot.reviewThreads.map((thread) => ({
                  ...thread,
                  messages: thread.messages.map((message) => ({ ...message })),
                })),
              })
        return output({
          summary:
            next.status === 'active'
              ? reviewReconciliationPatches.length > 0
                ? 'MR 仍在看护中；已按权威快照自动淘汰失效检视事实'
                : 'MR 仍在看护中，等待新的检视或门禁事件'
              : next.status === 'merged'
                ? 'MR 已由 committer 合入'
                : 'MR 已关闭',
          contextPatches: [
            contextPatch({
              current,
              contextTypeId: 'development.merge-request',
              lifecycleState: next.status === 'active' ? 'waiting' : 'terminal',
              state: next,
            }),
            ...(pipelinePatch === null ? [] : [pipelinePatch]),
            ...reviewReconciliationPatches,
          ],
        })
      }

      if (plan.workItemRef === 'evaluate-ready') {
        const current = contexts.find((context) => context.typeId === 'development.merge-request')
        if (current === undefined) {
          return output({ status: 'blocked', summary: '缺少 MR 上下文，无法判断可合入状态' })
        }
        const state = mergeRequestStateSchema.parse(JSON.parse(current.stateJson) as unknown)
        const pipelineContext = contexts.find(
          (context) => context.typeId === 'development.pipeline',
        )
        const pipeline =
          pipelineContext === undefined
            ? null
            : z
                .object({
                  status: z.enum(['pending', 'passed', 'failed']),
                  headSha: z.string().regex(/^[a-f0-9]{40}$/),
                  targetSha: z
                    .string()
                    .regex(/^[a-f0-9]{40}$/)
                    .nullable()
                    .default(null),
                })
                .passthrough()
                .parse(JSON.parse(pipelineContext.stateJson) as unknown)
        const sameHeadFacts = state.factsHeadSha === state.headSha
        const sameHeadPipeline = pipeline?.headSha === state.headSha
        const sameTargetPipeline =
          !targetAwarePipeline ||
          (state.targetSha !== null && pipeline?.targetSha === state.targetSha)
        const approvalContext = contexts.find(
          (context) => context.typeId === 'development.approval',
        )
        const approval =
          approvalContext === undefined
            ? null
            : approvalContextSchema.parse(JSON.parse(approvalContext.stateJson) as unknown)
        const approvalReady =
          state.approvalHold !== true ||
          (approval?.status === 'approved' &&
            approval.mergeRequestRef === state.mergeRequestRef &&
            approval.headSha === state.headSha)
        const delegationContext = contexts.find(
          (context) => context.typeId === 'development.delegation',
        )
        const delegationStatus =
          delegationContext === undefined
            ? null
            : z
                .object({
                  status: z.enum(['requested', 'waiting', 'satisfied', 'failed']),
                })
                .passthrough()
                .parse(JSON.parse(delegationContext.stateJson) as unknown).status
        const delegationReady = delegationStatus === null || delegationStatus === 'satisfied'
        const readyToMerge =
          state.status === 'active' &&
          !state.draft &&
          state.mergeableState === 'mergeable' &&
          state.unresolvedReviewCount === 0 &&
          sameHeadFacts &&
          sameHeadPipeline &&
          sameTargetPipeline &&
          pipeline?.status === 'passed' &&
          approvalReady &&
          delegationReady
        const next = mergeRequestStateSchema.parse({ ...state, readyToMerge })
        const reasons = [
          ...(state.draft ? ['MR 仍是草稿'] : []),
          ...(state.mergeableState !== 'mergeable' ? ['代码平台尚未确认可合并'] : []),
          ...(state.unresolvedReviewCount > 0
            ? [`仍有 ${state.unresolvedReviewCount} 条未处理检视意见`]
            : []),
          ...(!sameHeadFacts ? ['MR 事实与当前 head 不一致'] : []),
          ...(!sameHeadPipeline || !sameTargetPipeline || pipeline?.status !== 'passed'
            ? [
                targetAwarePipeline
                  ? '当前 head 与 target 的流水线门禁未通过'
                  : '当前 head 的流水线门禁未通过',
              ]
            : []),
          ...(!approvalReady ? ['当前 MR head 的外部审批尚未通过'] : []),
          ...(!delegationReady ? ['协同员工结果尚未满足'] : []),
        ]
        return output({
          summary: readyToMerge
            ? 'MR 已随时可合入，等待 committer'
            : `MR 尚未就绪：${reasons.join('；')}`,
          contextPatches: [
            contextPatch({
              current,
              contextTypeId: 'development.merge-request',
              state: next,
            }),
          ],
        })
      }

      return output({
        status: 'blocked',
        summary: `未注册确定性平台处理器：${plan.workItemRef}`,
      })
    },
  }
}
