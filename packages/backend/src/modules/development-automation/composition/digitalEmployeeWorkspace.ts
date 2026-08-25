import { and, desc, eq } from 'drizzle-orm'
import type { WorkspaceFailureClass } from '@/modules/digital-employee/public/types'
import { repoRelativePathSchema } from '../domain/requirementManifest'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { EmployeeReactionRoundQueryPort } from '@/modules/digital-employee/public/types'
import { cachedRepos, employeeCaseWorkspaces, employeeRoundWorkspaceStates } from '@/db/schema'
import { stableGitRefComponent, stableIdentityComponent } from '@/util/gitRef'
import { PLATFORM_OWNED_GIT_METADATA_PREFIXES } from '../infrastructure/attemptSupport'
import {
  protectedRootSnapshotDigest,
  snapshotProtectedRoots,
  type ProtectedRootSnapshot,
} from '../infrastructure/protectedSnapshot'
import {
  businessTreeSnapshot,
  businessTreeSnapshotDigest,
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
    employeeTypeRef: z
      .object({ typeId: z.string().min(1), revision: z.number().int().positive() })
      .strict()
      .nullable()
      .optional(),
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
    materialArtifactRefs: z.array(z.string().min(1)).default([]),
  })
  .passthrough()

const inputEnvelopeSchema = z
  .object({
    contextsJson: z.string().min(2),
  })
  .passthrough()

const contextRecordSchema = z
  .object({
    typeId: z.string().min(1),
    stateJson: z.string().min(2),
    artifactRefs: z.array(z.string().min(1)).default([]),
  })
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
        readonly contractProjectionJson?: string
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

interface FrozenPlatformArtifactRef {
  readonly path: string
  readonly sourceCaseKey: string
}

const REQUIREMENT_ARTIFACT_PREFIX = `${PLATFORM_WORKSPACE_DIR}/inputs/requirements/`
const PIPELINE_ARTIFACT_PREFIX = `${PLATFORM_WORKSPACE_DIR}/pipeline/`

function parseFrozenPlatformArtifactRef(raw: string): FrozenPlatformArtifactRef | null {
  const recognized =
    raw.startsWith(REQUIREMENT_ARTIFACT_PREFIX) || raw.startsWith(PIPELINE_ARTIFACT_PREFIX)
  if (!recognized) return null
  const canonical = raw.endsWith('/') ? raw.slice(0, -1) : raw
  const parsed = repoRelativePathSchema.safeParse(canonical)
  if (!parsed.success) throw new Error(`frozen platform artifact ref is unsafe: ${raw}`)
  const parts = parsed.data.split('/')
  const sourceCaseKey =
    parts[1] === 'inputs' && parts[2] === 'requirements'
      ? parts.length >= 4
        ? parts[3]!
        : null
      : parts[1] === 'pipeline' && parts.length >= 3
        ? parts[2]!
        : null
  if (
    sourceCaseKey === null ||
    sourceCaseKey.length === 0 ||
    stableIdentityComponent(sourceCaseKey) !== sourceCaseKey
  ) {
    throw new Error(`frozen platform artifact ref has an invalid Case namespace: ${raw}`)
  }
  return { path: parsed.data, sourceCaseKey }
}

function frozenPlatformArtifactRefs(refs: readonly string[]): FrozenPlatformArtifactRef[] {
  const exact = new Map<string, FrozenPlatformArtifactRef>()
  for (const raw of refs) {
    const parsed = parseFrozenPlatformArtifactRef(raw)
    if (parsed !== null) exact.set(parsed.path, parsed)
  }
  const ordered = [...exact.values()].sort((a, b) =>
    a.path.length === b.path.length ? a.path.localeCompare(b.path) : a.path.length - b.path.length,
  )
  return ordered.filter(
    (candidate, index) =>
      !ordered.slice(0, index).some((ancestor) => candidate.path.startsWith(ancestor.path + '/')),
  )
}

function requirePlainDirectory(path: string, label: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a plain directory: ${path}`)
  }
}

function requirePlainDirectoryPath(root: string, relativeDirectory: string): void {
  requirePlainDirectory(root, 'frozen artifact source workspace')
  let current = root
  for (const segment of relativeDirectory.split('/').filter((part) => part.length > 0)) {
    current = join(current, segment)
    requirePlainDirectory(current, 'frozen artifact source path')
  }
}

function ensurePlainDirectoryPath(root: string, relativeDirectory: string): void {
  requirePlainDirectory(root, 'frozen artifact target workspace')
  let current = root
  for (const segment of relativeDirectory.split('/').filter((part) => part.length > 0)) {
    current = join(current, segment)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (stat === undefined) {
      mkdirSync(current)
      continue
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`frozen artifact target path is not a plain directory: ${current}`)
    }
  }
}

function copyFrozenPlatformEntry(source: string, target: string): void {
  const sourceStat = lstatSync(source, { throwIfNoEntry: false })
  if (sourceStat === undefined || sourceStat.isSymbolicLink()) {
    throw new Error(`frozen platform artifact is missing or linked: ${source}`)
  }
  if (sourceStat.isDirectory()) {
    const targetStat = lstatSync(target, { throwIfNoEntry: false })
    if (targetStat === undefined) mkdirSync(target)
    else if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new Error(`frozen artifact target is not a plain directory: ${target}`)
    }
    const sourceNames = readdirSync(source).sort()
    for (const name of sourceNames) {
      copyFrozenPlatformEntry(join(source, name), join(target, name))
    }
    const extras = readdirSync(target)
      .filter((name) => !sourceNames.includes(name))
      .sort()
    if (extras.length > 0) {
      throw new Error(`frozen artifact target contains ungranted entries: ${extras.join(', ')}`)
    }
    return
  }
  if (!sourceStat.isFile() || sourceStat.nlink > 1) {
    throw new Error(`frozen platform artifact is not a plain file: ${source}`)
  }
  const sourceContent = readFileSync(source)
  const targetStat = lstatSync(target, { throwIfNoEntry: false })
  if (targetStat === undefined) {
    copyFileSync(source, target, constants.COPYFILE_EXCL)
    chmodSync(target, sourceStat.mode & 0o777)
    return
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink > 1) {
    throw new Error(`frozen artifact target is not a plain file: ${target}`)
  }
  if (!readFileSync(target).equals(sourceContent)) {
    throw new Error(`frozen artifact target disagrees with its source: ${target}`)
  }
}

function hydrateFrozenPlatformArtifacts(input: {
  readonly appHome: string
  readonly workspacePath: string
  readonly refs: readonly string[]
}): FrozenPlatformArtifactRef[] {
  const artifacts = frozenPlatformArtifactRefs(input.refs)
  for (const artifact of artifacts) {
    const sourceWorkspace = join(
      input.appHome,
      'workspaces',
      'employee-cases',
      artifact.sourceCaseKey,
      'scene',
      'workspace',
    )
    requirePlainDirectory(sourceWorkspace, 'frozen artifact source workspace')
    const artifactParent = artifact.path.split('/').slice(0, -1).join('/')
    requirePlainDirectoryPath(sourceWorkspace, artifactParent)
    ensurePlainDirectoryPath(input.workspacePath, artifactParent)
    copyFrozenPlatformEntry(
      join(sourceWorkspace, artifact.path),
      join(input.workspacePath, artifact.path),
    )
  }
  return artifacts
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

function preStateWithFrozenPlatformArtifacts(input: {
  readonly pre: SerializedPreState
  readonly plan: z.infer<typeof planSchema>
  readonly workspacePath: string
  readonly artifacts: readonly FrozenPlatformArtifactRef[]
}): SerializedPreState {
  if (input.artifacts.length === 0) return input.pre
  const actual = snapshotProtectedRoots(rootsOf(input.workspacePath), {
    skipPrefixesByRoot: skipPrefixes(
      input.plan.workspacePolicy,
      input.plan.caseRef.id,
      input.plan.workItemRef,
      hasImplementationPlanReview(input.plan),
    ),
  })
  const prior = reviveProtected(input.pre.protected)
  const entries = new Map(
    [...prior.entries.entries()].map(([root, paths]) => [root, new Map(paths)] as const),
  )
  const priorEvidence = entries.get('evidence') ?? new Map<string, string>()
  const actualEvidence = actual.entries.get('evidence') ?? new Map<string, string>()
  const relativeRefs = input.artifacts.map((artifact) =>
    artifact.path.slice(PLATFORM_WORKSPACE_DIR.length + 1),
  )
  for (const [path, digest] of actualEvidence) {
    const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path
    const granted = relativeRefs.some(
      (ref) =>
        normalizedPath === ref ||
        normalizedPath.startsWith(ref + '/') ||
        ref.startsWith(normalizedPath + '/'),
    )
    if (!granted) continue
    const frozenDigest = priorEvidence.get(path)
    if (frozenDigest !== undefined && frozenDigest !== digest) {
      throw new Error(`frozen platform artifact changed after the round checkpoint: ${path}`)
    }
    priorEvidence.set(path, digest)
  }
  entries.set('evidence', priorEvidence)
  return {
    ...input.pre,
    protected: serializeProtected({
      entries,
      digest: protectedRootSnapshotDigest(entries),
    }),
  }
}

function contextsOf(plan: z.infer<typeof planSchema>) {
  const envelope = inputEnvelopeSchema.parse(JSON.parse(plan.inputEnvelopeJson) as unknown)
  return z.array(contextRecordSchema).parse(JSON.parse(envelope.contextsJson) as unknown)
}

function resolveIssue(plan: z.infer<typeof planSchema>): z.infer<typeof issueContextSchema> {
  const contexts = contextsOf(plan)
  const issue = contexts.find((context) => context.typeId === 'development.issue-handling')
  if (issue === undefined) throw new Error('development employee scene has no issue context')
  const state = issueContextSchema.parse(JSON.parse(issue.stateJson) as unknown)
  return {
    ...state,
    materialArtifactRefs: [...new Set([...state.materialArtifactRefs, ...issue.artifactRefs])],
  }
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
  return businessChangedPaths(before, after).length > 0
}

function businessChangedPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort()
}

function directoryContainsFile(root: string): boolean {
  if (!existsSync(root)) return false
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isFile()) return true
      if (entry.isDirectory()) pending.push(join(current, entry.name))
    }
  }
  return false
}

const changedWorkspaceValidationSchema = z
  .object({
    ok: z.literal(true),
    kind: z.literal('changed'),
    changedPaths: z.array(z.string().min(1)).min(1),
    postBusinessDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough()

interface RepositoryPreparationPort {
  /**
   * Make the cached repository current before a new Case freezes its immutable
   * baseline. The provider owns credentials, fetching and cache locking; this
   * consumer receives only the prepared local repository identity.
   */
  prepare(input: { readonly repositoryId: string }): Promise<{
    readonly id: string
    readonly localPath: string
    readonly defaultBranch: string | null
  }>
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
  readonly repositoryPreparation: RepositoryPreparationPort
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
      readonly validatedChangedPaths?: readonly string[]
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

  /**
   * A completed write round can be followed by a preempting provider fact before
   * prepare-change publishes its validated delta. If the same business action is
   * then replayed, its action-local baseline already contains that delta and a
   * correct Agent reports success without manufacturing another edit.
   *
   * Reuse is intentionally closed over platform evidence: the latest settled
   * round must be the same work item and policy, its validation must be a trusted
   * changed verdict on the same unpublished workspace baseline, and the current
   * pre-state must differ from that round's pre-state by exactly the validated
   * paths. Any extra, missing, published, or policy-incompatible delta fails
   * closed and keeps the normal semantic retry behavior.
   */
  const carriedValidatedChange = (request: {
    readonly plan: z.infer<typeof planSchema>
    readonly stateBaselineSha: string
    readonly currentPreBusiness: ReadonlyMap<string, string>
  }): {
    readonly ok: true
    readonly kind: 'changed'
    readonly changedPaths: readonly string[]
  } | null => {
    const priorRound = input.reactionRounds.lastSettledRound({
      caseId: request.plan.caseRef.id,
      workItemRef: request.plan.workItemRef,
    })
    if (priorRound === null || priorRound.roundRef === request.plan.roundRef) return null
    const priorFrozen = input.reactionRounds.frozenPlan(priorRound.roundRef)
    if (priorFrozen === null) return null
    const priorPlan = planSchema.safeParse(JSON.parse(priorFrozen.planJson) as unknown)
    if (
      !priorPlan.success ||
      JSON.stringify(priorPlan.data.workspacePolicy) !==
        JSON.stringify(request.plan.workspacePolicy)
    ) {
      return null
    }
    const workspace = input.db
      .select({ baselineSha: employeeCaseWorkspaces.baselineSha })
      .from(employeeCaseWorkspaces)
      .where(eq(employeeCaseWorkspaces.caseId, request.plan.caseRef.id))
      .get()
    if (workspace?.baselineSha !== request.stateBaselineSha) return null
    const priorState = input.db
      .select()
      .from(employeeRoundWorkspaceStates)
      .where(eq(employeeRoundWorkspaceStates.roundId, priorRound.roundRef))
      .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
      .get()
    if (
      priorState === undefined ||
      priorState.baselineSha !== request.stateBaselineSha ||
      priorState.validationJson === null
    ) {
      return null
    }
    const priorValidation = changedWorkspaceValidationSchema.safeParse(
      JSON.parse(priorState.validationJson) as unknown,
    )
    if (!priorValidation.success) return null
    if (
      businessTreeSnapshotDigest(request.currentPreBusiness) !==
      priorValidation.data.postBusinessDigest
    ) {
      return null
    }
    const priorPre = JSON.parse(priorState.preStateJson) as SerializedPreState
    if (priorPre.conflict !== undefined) return null
    const carriedPaths = businessChangedPaths(
      new Map(priorPre.business),
      request.currentPreBusiness,
    )
    const validatedPaths = [...priorValidation.data.changedPaths].sort()
    if (JSON.stringify(carriedPaths) !== JSON.stringify(validatedPaths)) return null
    return { ok: true, kind: 'changed', changedPaths: carriedPaths }
  }

  return {
    async prepare(request) {
      const plan = planSchema.parse(JSON.parse(request.planJson) as unknown)
      const attempt = attemptSchema.parse(JSON.parse(request.attemptJson) as unknown)
      const platformCaseKey = stableIdentityComponent(plan.caseRef.id)
      if (plan.workspacePolicy.mode === 'none') return { kind: 'scratch' }
      const issue = resolveIssue(plan)
      const hydrateArtifacts = (targetWorkspacePath: string) =>
        hydrateFrozenPlatformArtifacts({
          appHome: input.appHome,
          workspacePath: targetWorkspacePath,
          refs: issue.materialArtifactRefs,
        })
      const platformInputPaths = (
        artifacts: readonly FrozenPlatformArtifactRef[],
      ): readonly string[] => [
        ...new Set([
          `${PLATFORM_WORKSPACE_DIR}/inputs/requirements/${platformCaseKey}`,
          `${PLATFORM_WORKSPACE_DIR}/pipeline/${platformCaseKey}`,
          ...artifacts.map((artifact) => artifact.path),
        ]),
      ]
      let row = input.db
        .select()
        .from(employeeCaseWorkspaces)
        .where(eq(employeeCaseWorkspaces.caseId, plan.caseRef.id))
        .get()
      if (row === undefined) {
        const repository = await input.repositoryPreparation.prepare({
          repositoryId: issue.repositoryRef,
        })
        if (repository.id !== issue.repositoryRef) {
          throw new Error(
            `prepared repository identity changed: expected ${issue.repositoryRef}, got ${repository.id}`,
          )
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
        const existingState =
          attempt.mode === 'same-scene'
            ? input.db
                .select()
                .from(employeeRoundWorkspaceStates)
                .where(eq(employeeRoundWorkspaceStates.roundId, plan.roundRef))
                .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
                .get()
            : input.db
                .select()
                .from(employeeRoundWorkspaceStates)
                .where(
                  and(
                    eq(employeeRoundWorkspaceStates.roundId, plan.roundRef),
                    eq(employeeRoundWorkspaceStates.attemptOrdinal, attempt.ordinal),
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
          mkdirSync(pipelineRoot, { recursive: true })
          const canonicalWorkspace = workspacePath(plan.caseRef.id)
          copyFrozenPlatformEntry(
            join(
              canonicalWorkspace,
              PLATFORM_WORKSPACE_DIR,
              'inputs',
              'requirements',
              platformCaseKey,
            ),
            requirementsRoot,
          )
          copyFrozenPlatformEntry(
            join(canonicalWorkspace, PLATFORM_WORKSPACE_DIR, 'pipeline', platformCaseKey),
            pipelineRoot,
          )
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
        }
        const conflict = pre?.conflict
        if (conflict === undefined) throw new Error('conflict scene state was not persisted')
        const artifacts = hydrateArtifacts(conflict.workspacePath)
        const expandedPre = preStateWithFrozenPlatformArtifacts({
          pre: pre!,
          plan,
          workspacePath: conflict.workspacePath,
          artifacts,
        })
        if (JSON.stringify(expandedPre) !== state!.preStateJson) {
          state = {
            ...state!,
            preStateJson: JSON.stringify(expandedPre),
            updatedAt: now(),
          }
          input.db
            .update(employeeRoundWorkspaceStates)
            .set({ preStateJson: state.preStateJson, updatedAt: state.updatedAt })
            .where(
              and(
                eq(employeeRoundWorkspaceStates.roundId, plan.roundRef),
                eq(employeeRoundWorkspaceStates.attemptOrdinal, state.attemptOrdinal),
              ),
            )
            .run()
          pre = expandedPre
        }
        if (attempt.ordinal !== state!.attemptOrdinal) {
          state = {
            ...state!,
            attemptOrdinal: attempt.ordinal,
            validationJson: null,
            updatedAt: now(),
          }
          input.db.insert(employeeRoundWorkspaceStates).values(state).onConflictDoNothing().run()
        }
        return {
          kind: 'repository',
          workspacePath: conflict.workspacePath,
          baselineSha: conflict.sourceSha,
          contractProjectionJson: JSON.stringify({ conflictFiles: conflict.conflictPaths }),
          platformInputPaths: platformInputPaths(artifacts),
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

      const artifacts = hydrateArtifacts(workspacePath(plan.caseRef.id))
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
      } else {
        const expandedPre = preStateWithFrozenPlatformArtifacts({
          pre: JSON.parse(state.preStateJson) as SerializedPreState,
          plan,
          workspacePath: workspacePath(plan.caseRef.id),
          artifacts,
        })
        if (JSON.stringify(expandedPre) !== state.preStateJson) {
          state = {
            ...state,
            preStateJson: JSON.stringify(expandedPre),
            updatedAt: now(),
          }
          input.db
            .update(employeeRoundWorkspaceStates)
            .set({ preStateJson: state.preStateJson, updatedAt: state.updatedAt })
            .where(
              and(
                eq(employeeRoundWorkspaceStates.roundId, plan.roundRef),
                eq(employeeRoundWorkspaceStates.attemptOrdinal, 0),
              ),
            )
            .run()
        }
      }
      if (attempt.ordinal !== 0) {
        const existingAttempt = input.db
          .select()
          .from(employeeRoundWorkspaceStates)
          .where(
            and(
              eq(employeeRoundWorkspaceStates.roundId, plan.roundRef),
              eq(employeeRoundWorkspaceStates.attemptOrdinal, attempt.ordinal),
            ),
          )
          .get()
        if (existingAttempt === undefined) {
          input.db
            .insert(employeeRoundWorkspaceStates)
            .values({ ...state, attemptOrdinal: attempt.ordinal, updatedAt: now() })
            .run()
        } else {
          const expandedPre = preStateWithFrozenPlatformArtifacts({
            pre: JSON.parse(existingAttempt.preStateJson) as SerializedPreState,
            plan,
            workspacePath: workspacePath(plan.caseRef.id),
            artifacts,
          })
          if (JSON.stringify(expandedPre) !== existingAttempt.preStateJson) {
            input.db
              .update(employeeRoundWorkspaceStates)
              .set({ preStateJson: JSON.stringify(expandedPre), updatedAt: now() })
              .where(
                and(
                  eq(employeeRoundWorkspaceStates.roundId, plan.roundRef),
                  eq(employeeRoundWorkspaceStates.attemptOrdinal, attempt.ordinal),
                ),
              )
              .run()
          }
        }
      }
      return {
        kind: 'repository',
        workspacePath: workspacePath(plan.caseRef.id),
        baselineSha: row.baselineSha,
        platformInputPaths: platformInputPaths(artifacts),
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
      const directOutput = z
        .object({
          outcome: z.enum(['completed', 'blocked']),
          commitMessage: z.string().min(1).optional(),
        })
        .passthrough()
        .safeParse(decodedOutput)
      const completedSuccessfully =
        request.taskStatus === 'done' &&
        ((parsedOutput.success && parsedOutput.data.status === 'ok') ||
          (directOutput.success && directOutput.data.outcome === 'completed'))
      if ((!parsedOutput.success && !directOutput.success) || request.taskStatus !== 'done') {
        outcome = businessDelta(beforeBusiness, afterBusiness) ? 'changed' : 'no-change'
      } else if (directOutput.success && directOutput.data.outcome === 'blocked') {
        outcome = 'blocked'
      } else if (directOutput.success && plan.workItemRef === 'repair-feedback') {
        outcome = directOutput.data.commitMessage === undefined ? 'no-change' : 'changed'
      } else if (directOutput.success) {
        outcome =
          plan.workspacePolicy.businessChangeOnOk === 'required'
            ? 'changed'
            : plan.workspacePolicy.businessChangeOnOk === 'forbidden'
              ? 'no-change'
              : businessDelta(beforeBusiness, afterBusiness)
                ? 'changed'
                : 'no-change'
      } else if (parsedOutput.success && parsedOutput.data.status === 'needs-input') {
        outcome = 'needs-information'
      } else if (parsedOutput.success && parsedOutput.data.status === 'blocked') {
        outcome = 'blocked'
      } else if (plan.workspacePolicy.businessChangeOnOk === 'required') {
        outcome = 'changed'
      } else if (plan.workspacePolicy.businessChangeOnOk === 'forbidden') {
        outcome = 'no-change'
      } else {
        outcome = businessDelta(beforeBusiness, afterBusiness) ? 'changed' : 'no-change'
      }
      const issue = resolveIssue(plan)
      let verdict = validateWorkspaceOutcome({
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
      if (
        !verdict.ok &&
        verdict.kind === 'semantic' &&
        verdict.code === 'outcome-workspace-mismatch' &&
        pre.conflict === undefined &&
        request.taskStatus === 'done' &&
        completedSuccessfully &&
        plan.workspacePolicy.businessChangeOnOk === 'required' &&
        !businessDelta(beforeBusiness, afterBusiness)
      ) {
        verdict =
          carriedValidatedChange({
            plan,
            stateBaselineSha: state.baselineSha,
            currentPreBusiness: beforeBusiness,
          }) ?? verdict
      }
      if (
        verdict.ok &&
        directOutput.success &&
        directOutput.data.outcome === 'completed' &&
        plan.workItemRef === 'prepare-materials' &&
        issue.request.externalId !== null &&
        !directoryContainsFile(
          join(
            activeWorkspacePath,
            PLATFORM_WORKSPACE_DIR,
            'inputs',
            'requirements',
            stableIdentityComponent(plan.caseRef.id),
            'external',
          ),
        )
      ) {
        verdict = {
          ok: false,
          kind: 'semantic',
          code: 'outcome-workspace-mismatch',
          detail: 'prepare-materials completed without writing any material file',
        }
      }
      const conflictInspection =
        verdict.ok && pre.conflict !== undefined && outcome === 'changed'
          ? await input.conflictMerge.inspect({
              workspacePath: pre.conflict.workspacePath,
              conflictPaths: pre.conflict.conflictPaths,
              validatedChangedPaths: verdict.kind === 'changed' ? verdict.changedPaths : [],
            })
          : null
      const validation = {
        ...verdict,
        ...(verdict.ok && verdict.kind === 'changed'
          ? { postBusinessDigest: businessTreeSnapshotDigest(afterBusiness) }
          : {}),
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
