import { and, desc, eq } from 'drizzle-orm'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import type { DbClient } from '@/db/client'
import {
  cachedRepos,
  employeeApprovalSagas,
  employeeCaseWorkspaces,
  employeeChangeCandidates,
  employeeReactionRounds,
  employeeRoundWorkspaceStates,
} from '@/db/schema'
import type { ApprovalGatewayPort } from '../application/ports/reconcilerPorts'
import { encodeDevelopmentApprovalSubject } from '../domain/approvalSubject'
import { canonicalDigest } from '../domain/canonicalJson'
import { approvalContextSchema } from './employeeTypePackage'
import { sha256Hex } from '@/util/hash'
import { stableIdentityComponent } from '@/util/gitRef'
import { createGitBaselineReader } from '../infrastructure/gitBaselineReader'

interface DevelopmentReactionPlan {
  readonly roundRef: string
  readonly executionNonce: string
  readonly caseRef: { readonly id: string }
  readonly triggeringEventRef: string
  readonly workItemRef: string
  readonly inputEnvelopeJson: string
  readonly externalWaitDeadlineMs: number
}

const contextSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    typeId: z.string().min(1),
    stateJson: z.string().min(2),
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
              targetPath: z.string().min(1),
              originalName: z.string().min(1),
            })
            .strict(),
        ),
      })
      .passthrough(),
  })
  .passthrough()

const employeeUploadPlanSchema = z
  .object({
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(
      z
        .object({
          targetPath: z.string().min(1),
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
  if (input.uploads.length === 0) return { ok: true, plan: null }
  const baseline = createGitBaselineReader(input.baselineRepoPath, input.baselineSha)
  const entries: EmployeeUploadPlan['entries'][number][] = []
  for (const upload of input.uploads) {
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

const reviewThreadStateSchema = z
  .object({
    threadRef: z.string().min(1).max(500),
    revision: z.string().min(1).max(500),
    authorClass: z.enum(['human', 'bot', 'self']),
    resolved: z.boolean(),
    body: z.string().max(32_000),
    path: z.string().min(1).max(1_000).nullable(),
  })
  .strict()

const mergeRequestStateSchema = z
  .object({
    status: z.enum(['active', 'merged', 'closed']),
    mergeRequestRef: z.string().min(1),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    issueHandlingContextRef: z.string().min(1),
    readyToMerge: z.boolean(),
    factsHeadSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable()
      .default(null),
    targetSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable()
      .default(null),
    draft: z.boolean().default(false),
    mergeableState: z.enum(['mergeable', 'conflict', 'unknown']).default('unknown'),
    approvalHold: z.boolean().nullable().default(null),
    unresolvedReviewCount: z.number().int().nonnegative().default(0),
    reviewThreads: z.array(reviewThreadStateSchema).max(100).default([]),
    repositoryRef: z.string().nullable().default(null),
    providerMrRef: z.string().nullable().default(null),
    sourceBranch: z.string().nullable().default(null),
    targetBranch: z.string().nullable().default(null),
    webUrl: z.string().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const actionableReviews = (value.reviewThreads ?? []).filter(
      (thread) => !thread.resolved && thread.authorClass !== 'self',
    ).length
    if (value.unresolvedReviewCount !== actionableReviews) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unresolvedReviewCount does not match actionable reviewThreads',
      })
    }
  })

const conflictValidationSchema = z
  .object({
    ok: z.literal(true),
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

export function composeDevelopmentEmployeePlatformWorkItems(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly approvalGateway?: ApprovalGatewayPort
  readonly repoRemote: {
    resolve(repositoryId: string): {
      readonly remoteUrl: string
      readonly defaultBranch: string | null
    } | null
  }
  readonly mrEffects: {
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
    }): Promise<void>
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
}): { execute(plan: DevelopmentReactionPlan): Promise<string> } {
  const candidateOps = input.sourceControl
  const delivery = input.sourceControl
  const workspaceOps = input.sourceControl
  const now = input.now ?? Date.now
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
    async execute(plan) {
      const output = (value: Parameters<typeof platformOutput>[1]) => platformOutput(plan, value)
      const contexts = contextsOf(plan)
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
                status: 'blocked',
                summary: `外部审批观察失败：${observed.failure.code} · ${observed.failure.remediation}`,
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
        const previousRound = input.db
          .select({ outputJson: employeeReactionRounds.outputJson })
          .from(employeeReactionRounds)
          .where(
            and(
              eq(employeeReactionRounds.caseId, plan.caseRef.id),
              eq(employeeReactionRounds.state, 'completed'),
            ),
          )
          .orderBy(desc(employeeReactionRounds.createdAt))
          .get()
        let summarySource = 'Digital employee prepared a repository change'
        if (previousRound?.outputJson !== null && previousRound?.outputJson !== undefined) {
          const parsed = z
            .object({ summary: z.string().min(1) })
            .passthrough()
            .safeParse(JSON.parse(previousRound.outputJson) as unknown)
          if (parsed.success) summarySource = parsed.data.summary
        }
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
        })
        if (!pushed.ok) {
          return output({
            status: 'blocked',
            summary: `平台推送失败：${pushed.code} · ${pushed.detail}`,
          })
        }
        const titleSource =
          issue.state.request.body?.split('\n')[0]?.trim() ||
          issue.state.request.externalId ||
          issue.state.subjectRef
        const ensured = await input.mrEffects.ensure(issue.state.repositoryRef, {
          missionId: plan.caseRef.id,
          sourceBranch: row.sourceBranch,
          targetBranch: row.targetBranch,
          title: titleSource.slice(0, 240),
          description: [
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
        const mrState = mergeRequestStateSchema.parse({
          status:
            ensured.mr.state === 'opened'
              ? 'active'
              : ensured.mr.state === 'merged'
                ? 'merged'
                : 'closed',
          mergeRequestRef: `${issue.state.repositoryRef}!${ensured.mr.mrRef}`,
          headSha: ensured.mr.sourceSha ?? committed.commitSha,
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
        if (current === undefined) {
          return output({ status: 'blocked', summary: '缺少需要发布冲突修复的 MR 上下文' })
        }
        const state = mergeRequestStateSchema.parse(JSON.parse(current.stateJson) as unknown)
        const repairRound = input.db
          .select({ id: employeeReactionRounds.id })
          .from(employeeReactionRounds)
          .where(
            and(
              eq(employeeReactionRounds.caseId, plan.caseRef.id),
              eq(employeeReactionRounds.workItemRef, 'repair-conflict'),
              eq(employeeReactionRounds.state, 'completed'),
            ),
          )
          .orderBy(desc(employeeReactionRounds.settledAt))
          .get()
        const repairState =
          repairRound === undefined
            ? undefined
            : input.db
                .select({ validationJson: employeeRoundWorkspaceStates.validationJson })
                .from(employeeRoundWorkspaceStates)
                .where(eq(employeeRoundWorkspaceStates.roundId, repairRound.id))
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
        const finished = await input.conflictMerge.finish({
          ...conflict,
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
        return output({
          summary: '冲突已由平台形成 merge commit 并推送，等待重新获取 MR 事实',
          contextPatches: [
            contextPatch({
              current,
              contextTypeId: 'development.merge-request',
              state: next,
            }),
          ],
          effectSuggestions: ['source-control.commit', 'source-control.push'],
        })
      }

      if (plan.workItemRef === 'observe-mr' || plan.workItemRef === 'wait-merge') {
        const current = contexts.find((context) => context.typeId === 'development.merge-request')
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
            await workspaceOps.fetchRemoteHead({
              baselineRepoPath: workspace.repository.localPath,
              remoteUrl: remote.remoteUrl,
              branch: conflictTargetBranch,
              expectedHeadSha: conflictTargetHead,
            })
          }
          if (sourceHeadChanged) {
            const sourceBranch = state.sourceBranch ?? workspace.row.sourceBranch
            await workspaceOps.fetchRemoteHead({
              baselineRepoPath: workspace.repository.localPath,
              remoteUrl: remote.remoteUrl,
              branch: sourceBranch,
              expectedHeadSha: nextHead,
            })
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
          readyToMerge: nextHead === state.headSha ? state.readyToMerge : false,
          targetBranch:
            factsSnapshot?.targetBranch ?? observed.observation.targetBranch ?? state.targetBranch,
          webUrl: observed.observation.webUrl ?? state.webUrl,
          repositoryRef: repositoryId,
          providerMrRef,
        })
        return output({
          summary:
            next.status === 'active'
              ? 'MR 仍在看护中，等待新的检视或门禁事件'
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
                })
                .passthrough()
                .parse(JSON.parse(pipelineContext.stateJson) as unknown)
        const sameHeadFacts = state.factsHeadSha === state.headSha
        const sameHeadPipeline = pipeline?.headSha === state.headSha
        const readyToMerge =
          state.status === 'active' &&
          !state.draft &&
          state.mergeableState === 'mergeable' &&
          state.unresolvedReviewCount === 0 &&
          sameHeadFacts &&
          sameHeadPipeline &&
          pipeline?.status === 'passed'
        const next = mergeRequestStateSchema.parse({ ...state, readyToMerge })
        const reasons = [
          ...(state.draft ? ['MR 仍是草稿'] : []),
          ...(state.mergeableState !== 'mergeable' ? ['代码平台尚未确认可合并'] : []),
          ...(state.unresolvedReviewCount > 0
            ? [`仍有 ${state.unresolvedReviewCount} 条未处理检视意见`]
            : []),
          ...(!sameHeadFacts ? ['MR 事实与当前 head 不一致'] : []),
          ...(!sameHeadPipeline || pipeline?.status !== 'passed'
            ? ['当前 head 的流水线门禁未通过']
            : []),
        ]
        return output({
          summary: readyToMerge
            ? state.approvalHold === true
              ? '代码与机器门禁已就绪，等待 committer 审核合入'
              : 'MR 已随时可合入，等待 committer'
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
