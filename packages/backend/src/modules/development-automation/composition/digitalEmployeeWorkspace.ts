import { and, desc, eq } from 'drizzle-orm'
import type { WorkspaceFailureClass } from '@/modules/digital-employee/public/types'
import { repoRelativePathSchema } from '../domain/requirementManifest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { EmployeeReactionRoundQueryPort } from '@/modules/digital-employee/public/types'
import { cachedRepos, employeeCaseWorkspaces, employeeRoundWorkspaceStates } from '@/db/schema'
import { stableGitRefComponent, stableIdentityComponent } from '@/util/gitRef'
import { PLATFORM_OWNED_GIT_METADATA_PREFIXES } from '../infrastructure/attemptSupport'
import {
  snapshotProtectedRoots,
  type ProtectedRootSnapshot,
} from '../infrastructure/protectedSnapshot'
import {
  businessTreeSnapshot,
  validateWorkspaceOutcome,
} from '../infrastructure/workspaceValidator'

const workspacePolicySchema = z
  .object({
    mode: z.enum(['write', 'read-only', 'none']),
    businessChangeOnOk: z.enum(['required', 'forbidden', 'optional']),
    writablePrefixes: z.array(z.string().min(1)),
    platformWritePrefixes: z.array(z.enum(['inputs/requirements', 'pipeline'])),
  })
  .strict()

const planSchema = z
  .object({
    roundRef: z.string().min(1),
    caseRef: z.object({ id: z.string().min(1) }).passthrough(),
    workItemRef: z.string().min(1),
    inputEnvelopeJson: z.string().min(2),
    workspacePolicy: workspacePolicySchema,
  })
  .passthrough()

const attemptSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    mode: z.enum(['initial', 'same-scene', 'fresh-scene']),
  })
  .passthrough()

const issueContextSchema = z
  .object({
    repositoryRef: z.string().min(1),
    request: z
      .object({
        body: z.string().nullable(),
        externalId: z.string().nullable(),
        uploads: z.array(
          z
            .object({
              artifactRef: z.string().regex(/^employee-input:/),
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
  })
  .passthrough()

const inputEnvelopeSchema = z
  .object({
    contextsJson: z.string().min(2),
  })
  .passthrough()

const contextRecordSchema = z
  .object({ typeId: z.string().min(1), stateJson: z.string().min(2) })
  .passthrough()

const mergeRequestContextSchema = z
  .object({
    status: z.enum(['active', 'merged', 'closed']),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    targetSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    mergeableState: z.enum(['mergeable', 'conflict', 'unknown']),
  })
  .passthrough()

interface SerializedPreState {
  readonly protected: {
    readonly digest: string
    readonly entries: readonly (readonly [string, readonly (readonly [string, string])[]])[]
  }
  readonly business: readonly (readonly [string, string])[]
  readonly conflict?: {
    readonly workspacePath: string
    readonly sourceSha: string
    readonly targetSha: string
    readonly conflictPaths: readonly string[]
  }
}

interface DevelopmentEmployeeWorkspaceParticipant {
  prepare(input: { readonly planJson: string; readonly attemptJson: string }): Promise<
    | { readonly kind: 'scratch' }
    | {
        readonly kind: 'repository'
        readonly workspacePath: string
        readonly baselineSha: string
        readonly platformInputPaths: readonly string[]
      }
  >
  validate(input: {
    readonly roundRef: string
    readonly taskStatus: string
    readonly outputJson: string | null
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false
        readonly errorClass: WorkspaceFailureClass
        readonly errorCode: string
        readonly errorDetail: string
      }
  >
}

function serializeProtected(snapshot: ProtectedRootSnapshot): SerializedPreState['protected'] {
  return {
    digest: snapshot.digest,
    entries: [...snapshot.entries.entries()].map(
      ([root, files]) => [root, [...files.entries()]] as const,
    ),
  }
}

function reviveProtected(value: SerializedPreState['protected']): ProtectedRootSnapshot {
  return {
    digest: value.digest,
    entries: new Map(value.entries.map(([root, files]) => [root, new Map(files)])),
  }
}

function rootsOf(workspacePath: string): Record<string, string> {
  return {
    'git-meta': join(workspacePath, '.git'),
    evidence: join(workspacePath, PLATFORM_WORKSPACE_DIR),
  }
}

function skipPrefixes(
  policy: z.infer<typeof workspacePolicySchema>,
  caseId: string,
  workItemRef: string,
  planReviewEnabled: boolean,
) {
  const platformCaseKey = stableIdentityComponent(caseId)
  return {
    'git-meta': PLATFORM_OWNED_GIT_METADATA_PREFIXES,
    evidence: policy.platformWritePrefixes.flatMap((prefix) => {
      if (prefix === 'inputs/requirements' && workItemRef === 'analyze-implement') {
        return planReviewEnabled
          ? [`${prefix}/${platformCaseKey}/review/implementation-plan.md`]
          : []
      }
      return [
        prefix === 'inputs/requirements' && workItemRef === 'prepare-materials'
          ? `${prefix}/${platformCaseKey}/external`
          : `${prefix}/${platformCaseKey}`,
      ]
    }),
  } as const
}

function hasImplementationPlanReview(plan: z.infer<typeof planSchema>): boolean {
  return (
    z
      .object({
        humanReview: z
          .object({ kind: z.literal('implementation-plan') })
          .passthrough()
          .nullable(),
      })
      .passthrough()
      .catch({ humanReview: null })
      .parse(JSON.parse(plan.inputEnvelopeJson) as unknown).humanReview !== null
  )
}

function contextsOf(plan: z.infer<typeof planSchema>) {
  const envelope = inputEnvelopeSchema.parse(JSON.parse(plan.inputEnvelopeJson) as unknown)
  return z.array(contextRecordSchema).parse(JSON.parse(envelope.contextsJson) as unknown)
}

function resolveIssue(plan: z.infer<typeof planSchema>): z.infer<typeof issueContextSchema> {
  const contexts = contextsOf(plan)
  const issue = contexts.find((context) => context.typeId === 'development.issue-handling')
  if (issue === undefined) throw new Error('development employee scene has no issue context')
  return issueContextSchema.parse(JSON.parse(issue.stateJson) as unknown)
}

function resolveMergeRequest(plan: z.infer<typeof planSchema>) {
  const context = contextsOf(plan).find(
    (candidate) => candidate.typeId === 'development.merge-request',
  )
  if (context === undefined) throw new Error('conflict scene has no merge-request context')
  return mergeRequestContextSchema.parse(JSON.parse(context.stateJson) as unknown)
}

function businessDelta(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): boolean {
  if (before.size !== after.size) return true
  for (const [path, digest] of before) if (after.get(path) !== digest) return true
  return false
}

export function composeDevelopmentEmployeeWorkspace(input: {
  readonly db: DbClient
  readonly appHome: string
  /**
   * RFC-317 T41（DE-02）—— 反应轮次的只读查询面。此前这里直接查
   * `employeeReactionRounds`（Digital Employee OS 的私表），把它冻结的 planJson
   * 与内部状态机枚举当成了事实合同。改经端口后，表与列只有 OS 知道。
   */
  readonly reactionRounds: EmployeeReactionRoundQueryPort
  readonly inputArtifacts: {
    copyBlobTo(blobRef: string, absoluteTargetPath: string): void
  }
  readonly sourceControl: {
    resolveBaseline(request: {
      readonly baselineRepoPath: string
      readonly preferredBranch: string | null
    }): Promise<{ readonly baselineSha: string; readonly targetBranch: string }>
    materialize(request: {
      readonly caseRoot: string
      readonly baselineRepoPath: string
      readonly baselineSha: string
    }): Promise<{ readonly workspacePath: string }>
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
  }
  readonly conflictMerge: {
    prepare(request: {
      readonly baselineRepoPath: string
      readonly sourceSha: string
      readonly targetSha: string
      readonly workspacesRoot?: string
    }): Promise<
      | {
          readonly ok: true
          readonly workspacePath: string
          readonly conflictPaths: readonly string[]
          cleanup(): void
        }
      | {
          readonly ok: false
          readonly code: 'conflict-workspace-failed' | 'no-conflict' | 'merge-failed'
          readonly detail: string
        }
    >
    inspect(request: {
      readonly workspacePath: string
      readonly conflictPaths: readonly string[]
    }): Promise<
      | { readonly ok: true }
      | {
          readonly ok: false
          readonly code: 'conflict-unresolved' | 'conflict-extra-changes' | 'finish-failed'
          readonly detail: string
        }
    >
  }
  readonly now?: () => number
}): DevelopmentEmployeeWorkspaceParticipant {
  const sourceControl = input.sourceControl
  const now = input.now ?? Date.now
  const caseDirectory = (caseId: string) =>
    join(input.appHome, 'workspaces', 'employee-cases', stableIdentityComponent(caseId))
  const sceneRoot = (caseId: string) => join(caseDirectory(caseId), 'scene')
  const workspacePath = (caseId: string) => join(sceneRoot(caseId), 'workspace')
  const checkpointRoot = (caseId: string, roundId: string) =>
    join(caseDirectory(caseId), 'checkpoints', roundId)

  return {
    async prepare(request) {
      const plan = planSchema.parse(JSON.parse(request.planJson) as unknown)
      const attempt = attemptSchema.parse(JSON.parse(request.attemptJson) as unknown)
      const platformCaseKey = stableIdentityComponent(plan.caseRef.id)
      if (plan.workspacePolicy.mode === 'none') return { kind: 'scratch' }
      const issue = resolveIssue(plan)
      let row = input.db
        .select()
        .from(employeeCaseWorkspaces)
        .where(eq(employeeCaseWorkspaces.caseId, plan.caseRef.id))
        .get()
      if (row === undefined) {
        const repository = input.db
          .select({
            id: cachedRepos.id,
            localPath: cachedRepos.localPath,
            defaultBranch: cachedRepos.defaultBranch,
          })
          .from(cachedRepos)
          .where(eq(cachedRepos.id, issue.repositoryRef))
          .get()
        if (repository === undefined) {
          throw new Error(`cached repository is unavailable: ${issue.repositoryRef}`)
        }
        const baseline = await sourceControl.resolveBaseline({
          baselineRepoPath: repository.localPath,
          preferredBranch: repository.defaultBranch,
        })
        await sourceControl.materialize({
          caseRoot: sceneRoot(plan.caseRef.id),
          baselineRepoPath: repository.localPath,
          baselineSha: baseline.baselineSha,
        })
        for (const upload of issue.request.uploads) {
          const blobRef = upload.artifactRef.slice('employee-input:'.length)
          const target = join(workspacePath(plan.caseRef.id), upload.targetPath)
          mkdirSync(dirname(target), { recursive: true })
          input.inputArtifacts.copyBlobTo(blobRef, target)
        }
        const requirementsRoot = join(
          workspacePath(plan.caseRef.id),
          PLATFORM_WORKSPACE_DIR,
          'inputs',
          'requirements',
          platformCaseKey,
        )
        const pipelineRoot = join(
          workspacePath(plan.caseRef.id),
          PLATFORM_WORKSPACE_DIR,
          'pipeline',
          platformCaseKey,
        )
        mkdirSync(requirementsRoot, { recursive: true })
        mkdirSync(join(requirementsRoot, 'uploads'), { recursive: true })
        mkdirSync(join(requirementsRoot, 'external'), { recursive: true })
        mkdirSync(join(requirementsRoot, 'review'), { recursive: true })
        mkdirSync(pipelineRoot, { recursive: true })
        writeFileSync(
          join(requirementsRoot, 'request.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              body: issue.request.body,
              externalId: issue.request.externalId,
              uploads: issue.request.uploads,
            },
            null,
            2,
          ),
        )
        const timestamp = now()
        row = {
          caseId: plan.caseRef.id,
          repositoryId: issue.repositoryRef,
          cachedRepoId: repository.id,
          baselineSha: baseline.baselineSha,
          targetBranch: baseline.targetBranch,
          sourceBranch: `agent-workflow/employee/${stableGitRefComponent(plan.caseRef.id)}`,
          remoteHeadSha: null,
          state: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        input.db.insert(employeeCaseWorkspaces).values(row).run()
      }
      const repository = input.db
        .select({ localPath: cachedRepos.localPath })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, row.cachedRepoId))
        .get()
      if (repository === undefined) throw new Error('employee case cached repository disappeared')

      if (plan.workItemRef === 'repair-conflict') {
        const mergeRequest = resolveMergeRequest(plan)
        if (
          mergeRequest.status !== 'active' ||
          mergeRequest.mergeableState !== 'conflict' ||
          mergeRequest.targetSha === null
        ) {
          throw new Error('merge-request conflict facts are incomplete or stale')
        }
        if (
          row.remoteHeadSha !== mergeRequest.headSha ||
          row.baselineSha !== mergeRequest.headSha
        ) {
          throw new Error('conflict source head no longer matches the employee workspace')
        }
        const stateOrdinal = attempt.mode === 'same-scene' ? 0 : attempt.ordinal
        const existingState = input.db
          .select()
          .from(employeeRoundWorkspaceStates)
          .where(
            and(
              eq(employeeRoundWorkspaceStates.roundId, plan.roundRef),
              eq(employeeRoundWorkspaceStates.attemptOrdinal, stateOrdinal),
            ),
          )
          .get()
        let state = existingState
        let pre =
          state === undefined ? undefined : (JSON.parse(state.preStateJson) as SerializedPreState)
        if (pre?.conflict === undefined || !existsSync(pre.conflict.workspacePath)) {
          if (state !== undefined && attempt.mode !== 'fresh-scene') {
            throw new Error('conflict scene is missing; a fresh-scene retry is required')
          }
          const prepared = await input.conflictMerge.prepare({
            baselineRepoPath: repository.localPath,
            sourceSha: mergeRequest.headSha,
            targetSha: mergeRequest.targetSha,
            workspacesRoot: join(
              caseDirectory(plan.caseRef.id),
              'conflicts',
              plan.roundRef,
              `attempt-${attempt.ordinal}`,
            ),
          })
          if (!prepared.ok) {
            throw new Error(
              `conflict scene preparation failed: ${prepared.code}: ${prepared.detail}`,
            )
          }
          const requirementsRoot = join(
            prepared.workspacePath,
            PLATFORM_WORKSPACE_DIR,
            'inputs',
            'requirements',
            platformCaseKey,
          )
          const pipelineRoot = join(
            prepared.workspacePath,
            PLATFORM_WORKSPACE_DIR,
            'pipeline',
            platformCaseKey,
          )
          mkdirSync(requirementsRoot, { recursive: true })
          mkdirSync(join(requirementsRoot, 'uploads'), { recursive: true })
          mkdirSync(join(requirementsRoot, 'external'), { recursive: true })
          mkdirSync(join(requirementsRoot, 'review'), { recursive: true })
          mkdirSync(pipelineRoot, { recursive: true })
          const checkpoint = sourceControl.checkpoint({
            workspacePath: prepared.workspacePath,
            checkpointRoot: checkpointRoot(plan.caseRef.id, `${plan.roundRef}-${attempt.ordinal}`),
          })
          pre = {
            protected: serializeProtected(
              snapshotProtectedRoots(rootsOf(prepared.workspacePath), {
                skipPrefixesByRoot: skipPrefixes(
                  plan.workspacePolicy,
                  plan.caseRef.id,
                  plan.workItemRef,
                  hasImplementationPlanReview(plan),
                ),
              }),
            ),
            business: [...businessTreeSnapshot(prepared.workspacePath).entries()],
            conflict: {
              workspacePath: prepared.workspacePath,
              sourceSha: mergeRequest.headSha,
              targetSha: mergeRequest.targetSha,
              conflictPaths: prepared.conflictPaths,
            },
          }
          const timestamp = now()
          const replacement = {
            roundId: plan.roundRef,
            attemptOrdinal: attempt.ordinal,
            caseId: plan.caseRef.id,
            baselineSha: mergeRequest.headSha,
            preStateJson: JSON.stringify(pre),
            checkpointDigest: checkpoint.checkpointDigest,
            validationJson: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          }
          input.db
            .insert(employeeRoundWorkspaceStates)
            .values(replacement)
            .onConflictDoUpdate({
              target: [
                employeeRoundWorkspaceStates.roundId,
                employeeRoundWorkspaceStates.attemptOrdinal,
              ],
              set: {
                caseId: replacement.caseId,
                baselineSha: replacement.baselineSha,
                preStateJson: replacement.preStateJson,
                checkpointDigest: replacement.checkpointDigest,
                validationJson: null,
                updatedAt: replacement.updatedAt,
              },
            })
            .run()
          state = replacement
        } else if (attempt.ordinal !== state!.attemptOrdinal) {
          state = {
            ...state!,
            attemptOrdinal: attempt.ordinal,
            validationJson: null,
            updatedAt: now(),
          }
          input.db.insert(employeeRoundWorkspaceStates).values(state).onConflictDoNothing().run()
        }
        const conflict = pre?.conflict
        if (conflict === undefined) throw new Error('conflict scene state was not persisted')
        return {
          kind: 'repository',
          workspacePath: conflict.workspacePath,
          baselineSha: conflict.sourceSha,
          platformInputPaths: [
            `${PLATFORM_WORKSPACE_DIR}/inputs/requirements/${platformCaseKey}`,
            `${PLATFORM_WORKSPACE_DIR}/pipeline/${platformCaseKey}`,
          ],
        }
      }

      const initialState = input.db
        .select()
        .from(employeeRoundWorkspaceStates)
        .where(
          and(
            eq(employeeRoundWorkspaceStates.roundId, plan.roundRef),
            eq(employeeRoundWorkspaceStates.attemptOrdinal, 0),
          ),
        )
        .get()
      if (attempt.mode === 'fresh-scene') {
        if (initialState === undefined) throw new Error('fresh scene has no frozen checkpoint')
        await sourceControl.restore({
          caseRoot: sceneRoot(plan.caseRef.id),
          baselineRepoPath: repository.localPath,
          baselineSha: initialState.baselineSha,
          checkpointRoot: checkpointRoot(plan.caseRef.id, plan.roundRef),
          expectedCheckpointDigest: initialState.checkpointDigest,
        })
      } else if (!existsSync(workspacePath(plan.caseRef.id))) {
        throw new Error('employee case workspace is missing; explicit recovery is required')
      }

      let state = initialState
      if (state === undefined) {
        const checkpoint = sourceControl.checkpoint({
          workspacePath: workspacePath(plan.caseRef.id),
          checkpointRoot: checkpointRoot(plan.caseRef.id, plan.roundRef),
        })
        const protectedSnapshot = snapshotProtectedRoots(rootsOf(workspacePath(plan.caseRef.id)), {
          skipPrefixesByRoot: skipPrefixes(
            plan.workspacePolicy,
            plan.caseRef.id,
            plan.workItemRef,
            hasImplementationPlanReview(plan),
          ),
        })
        const preState: SerializedPreState = {
          protected: serializeProtected(protectedSnapshot),
          business: [...businessTreeSnapshot(workspacePath(plan.caseRef.id)).entries()],
        }
        const timestamp = now()
        state = {
          roundId: plan.roundRef,
          attemptOrdinal: 0,
          caseId: plan.caseRef.id,
          baselineSha: row.baselineSha,
          preStateJson: JSON.stringify(preState),
          checkpointDigest: checkpoint.checkpointDigest,
          validationJson: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        input.db.insert(employeeRoundWorkspaceStates).values(state).run()
      }
      if (attempt.ordinal !== 0) {
        input.db
          .insert(employeeRoundWorkspaceStates)
          .values({ ...state, attemptOrdinal: attempt.ordinal, updatedAt: now() })
          .onConflictDoNothing()
          .run()
      }
      return {
        kind: 'repository',
        workspacePath: workspacePath(plan.caseRef.id),
        baselineSha: row.baselineSha,
        platformInputPaths: [
          `${PLATFORM_WORKSPACE_DIR}/inputs/requirements/${platformCaseKey}`,
          `${PLATFORM_WORKSPACE_DIR}/pipeline/${platformCaseKey}`,
        ],
      }
    },

    async validate(request) {
      const round = input.reactionRounds.frozenPlan(request.roundRef)
      if (round === null) {
        return {
          ok: false,
          // 轮次行不见了：这是平台侧的状态缺失，不是工作区被污染——换个干净场景重跑
          // 也变不出这一行，所以按 infrastructure 处理（行为同改造前：不升级）。
          errorClass: 'infrastructure',
          errorCode: 'workspace-round-missing',
          errorDetail: request.roundRef,
        }
      }
      const plan = planSchema.parse(JSON.parse(round.planJson) as unknown)
      if (plan.workspacePolicy.mode === 'none') return { ok: true }
      const state = input.db
        .select()
        .from(employeeRoundWorkspaceStates)
        .where(eq(employeeRoundWorkspaceStates.roundId, request.roundRef))
        .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
        .get()
      if (state === undefined) {
        return {
          ok: false,
          // 同上：平台侧的前置状态缺失，换场景也补不回来。
          errorClass: 'infrastructure',
          errorCode: 'workspace-pre-state-missing',
          errorDetail: request.roundRef,
        }
      }
      const pre = JSON.parse(state.preStateJson) as SerializedPreState
      const beforeBusiness = new Map(pre.business)
      const activeWorkspacePath = pre.conflict?.workspacePath ?? workspacePath(round.caseId)
      const afterBusiness = businessTreeSnapshot(activeWorkspacePath)
      let outcome: 'changed' | 'no-change' | 'needs-information' | 'blocked'
      let decodedOutput: unknown = null
      if (request.outputJson !== null) {
        try {
          decodedOutput = JSON.parse(request.outputJson) as unknown
        } catch {
          decodedOutput = null
        }
      }
      const parsedOutput = z
        .object({ status: z.enum(['ok', 'needs-input', 'blocked']) })
        .passthrough()
        .safeParse(decodedOutput)
      if (!parsedOutput.success || request.taskStatus !== 'done') {
        outcome = businessDelta(beforeBusiness, afterBusiness) ? 'changed' : 'no-change'
      } else if (parsedOutput.data.status === 'needs-input') {
        outcome = 'needs-information'
      } else if (parsedOutput.data.status === 'blocked') {
        outcome = 'blocked'
      } else if (plan.workspacePolicy.businessChangeOnOk === 'required') {
        outcome = 'changed'
      } else if (plan.workspacePolicy.businessChangeOnOk === 'forbidden') {
        outcome = 'no-change'
      } else {
        outcome = businessDelta(beforeBusiness, afterBusiness) ? 'changed' : 'no-change'
      }
      const issue = resolveIssue(plan)
      const verdict = validateWorkspaceOutcome({
        workspacePath: activeWorkspacePath,
        preProtected: reviveProtected(pre.protected),
        protectedRoots: rootsOf(activeWorkspacePath),
        protectedSkipPrefixesByRoot: skipPrefixes(
          plan.workspacePolicy,
          plan.caseRef.id,
          plan.workItemRef,
          hasImplementationPlanReview(plan),
        ),
        preBusinessTree: beforeBusiness,
        outcome,
        workspaceMode:
          plan.workspacePolicy.mode === 'write' ? 'edit-business-files' : plan.workspacePolicy.mode,
        writablePrefixes: pre.conflict?.conflictPaths ?? plan.workspacePolicy.writablePrefixes,
        preservePaths: [],
        editablePaths:
          pre.conflict === undefined
            ? issue.request.uploads.flatMap((upload) =>
                upload.placement === 'repository' ? [upload.targetPath] : [],
              )
            : [],
        budget: { maxChangedFiles: 2_000, maxTotalBytes: 128 * 1024 * 1024 },
      })
      const conflictInspection =
        verdict.ok && pre.conflict !== undefined && outcome === 'changed'
          ? await input.conflictMerge.inspect({
              workspacePath: pre.conflict.workspacePath,
              conflictPaths: pre.conflict.conflictPaths,
            })
          : null
      const validation = {
        ...verdict,
        ...(pre.conflict === undefined
          ? {}
          : {
              conflict: pre.conflict,
              inspection: conflictInspection,
            }),
      }
      input.db
        .update(employeeRoundWorkspaceStates)
        .set({ validationJson: JSON.stringify(validation), updatedAt: now() })
        .where(
          and(
            eq(employeeRoundWorkspaceStates.roundId, request.roundRef),
            eq(employeeRoundWorkspaceStates.attemptOrdinal, state.attemptOrdinal),
          ),
        )
        .run()
      if (verdict.ok && conflictInspection !== null && !conflictInspection.ok) {
        return {
          ok: false,
          // 冲突检查失败**不**升级到新场景——这与本次改造前的行为逐字一致（旧判据是
          // 前缀嗅探，而这一族 errorCode 没有 `boundary` 段，从来就没触发过升级）。
          // 它「该不该」升级是产品判断，不在本次「把隐式握手换成显式契约」的范围内；
          // 改成显式字段之后，要改它只需改这一个词，且改动会被重试用例看见。
          errorClass: 'semantic',
          errorCode: `workspace-${conflictInspection.code}`,
          errorDetail: conflictInspection.detail,
        }
      }
      if (verdict.ok) return { ok: true }
      if (verdict.kind === 'boundary') {
        const workspace = input.db
          .select({
            cachedRepoId: employeeCaseWorkspaces.cachedRepoId,
            baselineSha: employeeCaseWorkspaces.baselineSha,
          })
          .from(employeeCaseWorkspaces)
          .where(eq(employeeCaseWorkspaces.caseId, round.caseId))
          .get()
        const repository =
          workspace === undefined
            ? undefined
            : input.db
                .select({ localPath: cachedRepos.localPath })
                .from(cachedRepos)
                .where(eq(cachedRepos.id, workspace.cachedRepoId))
                .get()
        if (pre.conflict === undefined && workspace !== undefined && repository !== undefined) {
          await sourceControl.restore({
            caseRoot: sceneRoot(round.caseId),
            baselineRepoPath: repository.localPath,
            baselineSha: state.baselineSha,
            checkpointRoot: checkpointRoot(round.caseId, request.roundRef),
            expectedCheckpointDigest: state.checkpointDigest,
          })
        }
      }
      return {
        ok: false,
        // `verdict.kind` 是 'boundary' | 'semantic' 的闭合联合，直接成为类别——
        // 这正是原先靠字符串前缀传递、因而可以被任意一侧改名悄悄切断的那条信息。
        errorClass: verdict.kind,
        errorCode: `workspace-${verdict.kind}-${verdict.code}`,
        errorDetail: verdict.detail,
      }
    },
  }
}
