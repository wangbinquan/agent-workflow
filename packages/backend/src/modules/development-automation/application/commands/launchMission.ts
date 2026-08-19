// RFC-310 PR-2 —— T24/T24a admission：launch / select-source / retry / cancel。
//
// admission 只读「提交时已知」的事实：repositoryRef、submission kind、可选
// sourceKey 与程序化 repository facts（PR-2 用 unknown 占位 cell——真实
// inspector 归 PR-5；unknown facts 下规则选择老实地 indeterminate，走
// explicit/assignment 直选或 blocked）。员工选定后才解析 sourceKey→adapter
// binding（§3.8：反向依赖会成启动死锁）。upload 的 claim/plan 生成归 PR-3，
// 此处冻结每项的目标路径形状与唯一性并入 contentDigest。

import { ulid } from 'ulid'
import { z } from 'zod'

import { automationPolicyContentSchema } from '../../domain/automationPolicy'
import { canonicalDigest } from '../../domain/canonicalJson'
import { digitalEmployeeContentSchema } from '../../domain/digitalEmployee'
import { buildFactSnapshot, type FactCellValue } from '../../domain/facts'
import type { FactCell } from '../../domain/factCell'
import { checkCommandAdmissible, type MissionStatus } from '../../domain/mission'
import { repoRelativePathSchema } from '../../domain/requirementManifest'
import {
  resolveEmployeeSelection,
  type EmployeeSelectionRule,
} from '../../engine/policy/workSelection'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { AdmissionLookup } from '../ports/admissionLookup'
import type { MissionRow, MissionStore } from '../ports/missionStore'
import type { UploadSessionRow, UploadSessionStore } from '../ports/uploadSessionStore'
import {
  defaultUploadPolicyOf,
  previewUploadDispositions,
  resolveUploadPlanEntries,
  type BaselineFileReader,
  type PersistUploadPlanInput,
  type UploadDisposition,
  type UploadPlanRequestEntry,
} from '../uploadPlan'

const versionedRefSchema = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict()

function refineUploadList(
  uploads: readonly { uploadRef: string; repositoryTargetPath: string }[],
  ctx: z.RefinementCtx,
  basePath: readonly (string | number)[],
): void {
  const seenTargets = new Set<string>()
  const seenRefs = new Set<string>()
  uploads.forEach((upload, index) => {
    if (seenTargets.has(upload.repositoryTargetPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate repository target path: ${upload.repositoryTargetPath}`,
        path: [...basePath, index, 'repositoryTargetPath'],
      })
    }
    seenTargets.add(upload.repositoryTargetPath)
    if (seenRefs.has(upload.uploadRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate upload ref: ${upload.uploadRef}`,
        path: [...basePath, index, 'uploadRef'],
      })
    }
    seenRefs.add(upload.uploadRef)
  })
}

const directUploadSchema = z
  .object({
    /** POST /api/code/mission-input-uploads 返回的 upload 会话 id；bytes/sha256 从行取。 */
    uploadRef: z.string().min(1).max(64),
    repositoryTargetPath: repoRelativePathSchema,
    collisionMode: z.enum(['create-only', 'replace-existing']).optional(),
    contentPolicy: z.enum(['preserve-upload', 'agent-editable']).optional(),
    fileMode: z.enum(['regular', 'executable']).optional(),
  })
  .strict()

export const launchMissionInputSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(200),
    repositoryId: z.string().min(1),
    repositoryGroupId: z.string().min(1).nullable(),
    submission: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('direct'),
          title: z.string().min(1).max(500),
          body: z.string().nullable(),
          uploads: z.array(directUploadSchema).max(100),
        })
        .strict(),
      z
        .object({
          kind: z.literal('external-reference'),
          externalId: z.string().min(1).max(500),
          sourceKey: z.string().min(1).max(200).optional(),
        })
        .strict(),
    ]),
    delivery: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('create-merge-request'),
          targetRef: z.string().min(1).optional(),
        })
        .strict(),
      z
        .object({ kind: z.literal('adopt-merge-request'), mergeRequestRef: z.string().min(1) })
        .strict(),
    ]),
    requestedEmployee: versionedRefSchema.nullable(),
    requestedPolicy: versionedRefSchema.nullable(),
    actorUserId: z.string().nullable(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.submission.kind !== 'direct') return
    const { body, uploads } = input.submission
    if ((body === null || body.trim().length === 0) && uploads.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'direct submission needs a non-empty body or at least one upload',
        path: ['submission'],
      })
    }
    refineUploadList(uploads, ctx, ['submission', 'uploads'])
  })

export type LaunchMissionInput = z.infer<typeof launchMissionInputSchema>

/** 冻结的上传 baseline 上下文（composition 从 repository 域解析）。 */
export interface UploadBaselineContext {
  readonly repositoryRef: string
  readonly baselineSnapshotRef: string
  readonly baselineSha: string
  readonly reader: BaselineFileReader
}

/** upload admission 接线：缺席时带 uploads 的 direct launch 老实 blocked。 */
export interface UploadAdmissionDeps {
  readonly sessions: UploadSessionStore
  /** launch 事务边界（生产 = drizzle db.transaction 嵌套安全；测试可传直调）。 */
  readonly transact: <T>(fn: () => T) => T
  readonly resolveBaseline: (repositoryId: string) => Promise<UploadBaselineContext | null>
  readonly persistPlan: (plan: PersistUploadPlanInput) => void
}

export interface LaunchDeps {
  readonly store: MissionStore
  readonly lookup: AdmissionLookup
  readonly now: () => number
  readonly uploadAdmission?: UploadAdmissionDeps
}

export interface LaunchResult {
  readonly missionId: string
  readonly status: MissionStatus
  readonly created: boolean
  readonly blockCode: string | null
}

/**
 * direct 内容 digest（内容寻址：不掺随机 uploadRef，只掺行内容与落点语义）。
 * upload store 未接线时行数据不可得 ⇒ null（不伪造 digest）。
 */
function directContentDigest(
  submission: Extract<LaunchMissionInput['submission'], { kind: 'direct' }>,
  uploadRows: readonly UploadSessionRow[] | null,
): string | null {
  if (submission.uploads.length > 0 && uploadRows === null) return null
  return canonicalDigest({
    title: submission.title.trim(),
    body: submission.body?.trim() ?? null,
    uploads: submission.uploads.map((u, ordinal) => ({
      ordinal,
      fileName: uploadRows![ordinal]!.originalName,
      sha256: uploadRows![ordinal]!.sha256,
      targetPath: u.repositoryTargetPath,
      collisionMode: u.collisionMode ?? 'create-only',
      contentPolicy: u.contentPolicy ?? 'preserve-upload',
      fileMode: u.fileMode ?? 'regular',
    })),
  })
}

/** 事务内 createMission 撞 idempotency 赢家时用于整体回滚 + 重放返回。 */
class IdempotentReplay {
  constructor(readonly mission: MissionRow) {}
}

type DirectUploadRequest = z.infer<typeof directUploadSchema>

/**
 * 预读上传行：存在/归属/可用的快速失败（他人 ref 与不存在同形，§12.3）。
 * 原子判定仍由 launch 事务内的 claim 兜底；preview 走同一校验。
 */
function readPendingUploadRows(
  ua: UploadAdmissionDeps,
  uploads: readonly DirectUploadRequest[],
  actorUserId: string | null,
  now: number,
): UploadSessionRow[] {
  return uploads.map((u) => {
    const row = ua.sessions.getUpload(u.uploadRef)
    if (row === null || row.actorUserId !== actorUserId) {
      throw new NotFoundError('upload-not-found', `upload not found: ${u.uploadRef}`)
    }
    if (row.state === 'claimed') {
      throw new ConflictError('upload-already-claimed', `upload claimed elsewhere: ${u.uploadRef}`)
    }
    if (row.state !== 'pending' || row.expiresAt <= now) {
      throw new ConflictError('upload-not-claimable', `upload expired or unusable: ${u.uploadRef}`)
    }
    return row
  })
}

function toPlanRequests(
  uploads: readonly DirectUploadRequest[],
  rows: readonly UploadSessionRow[],
): UploadPlanRequestEntry[] {
  return uploads.map((u, index) => ({
    uploadRef: u.uploadRef,
    sha256: rows[index]!.sha256,
    bytes: rows[index]!.bytes,
    repositoryTargetPath: u.repositoryTargetPath,
    ...(u.collisionMode !== undefined ? { collisionMode: u.collisionMode } : {}),
    ...(u.contentPolicy !== undefined ? { contentPolicy: u.contentPolicy } : {}),
    ...(u.fileMode !== undefined ? { fileMode: u.fileMode } : {}),
  }))
}

function parseEmployeeRef(ref: string): { id: string; revision: number } {
  const at = ref.lastIndexOf('@')
  if (at <= 0) throw new ValidationError('employee-ref-malformed', `bad employee ref: ${ref}`)
  const revision = Number(ref.slice(at + 1))
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new ValidationError('employee-ref-malformed', `bad employee ref revision: ${ref}`)
  }
  return { id: ref.slice(0, at), revision }
}

interface EmployeeContent {
  readonly requirementSources: readonly {
    readonly sourceKey: string
    readonly adapterRef: { readonly id: string; readonly revision: number }
    readonly isDefault: boolean
  }[]
  readonly defaultPolicyRef: { readonly id: string; readonly revision: number }
}

async function loadEmployeeContent(
  lookup: AdmissionLookup,
  id: string,
  revision: number,
): Promise<EmployeeContent | null> {
  const raw = await lookup.getEmployeeRevisionContent(id, revision)
  if (raw === null) return null
  return digitalEmployeeContentSchema.parse(raw) as unknown as EmployeeContent
}

type AssignmentContext = Awaited<ReturnType<AdmissionLookup['resolveAssignment']>>

type AdmissionOutcome =
  | {
      readonly kind: 'blocked'
      readonly blockCode: string
      readonly blockDetail: string | null
      readonly employee: { readonly id: string; readonly revision: number } | null
    }
  | {
      readonly kind: 'selected'
      readonly employee: { readonly id: string; readonly revision: number }
      readonly employeeContent: EmployeeContent
      readonly policyRef: { readonly id: string; readonly revision: number }
      readonly policyContent: unknown
    }

type RequirementSourceResolution =
  | {
      readonly kind: 'selected'
      readonly source: EmployeeContent['requirementSources'][number]
      readonly options: readonly string[]
    }
  | {
      readonly kind: 'needs-selection'
      readonly options: readonly string[]
    }
  | {
      readonly kind: 'blocked'
      readonly blockCode: 'requirement-source-unresolved'
      readonly blockDetail: string
      readonly options: readonly string[]
    }

/**
 * launch 与 preview 共用的选择器链（design §12.1：preview 必须跑与 launch 同一套
 * repository facts → employee → policy 解析，不得用全局默认替代）。
 */
async function resolveEmployeeAndPolicy(
  deps: LaunchDeps,
  input: {
    readonly repositoryId: string
    readonly repositoryGroupId: string | null
    readonly requestedEmployee: { id: string; revision: number } | null
    readonly requestedPolicy: { id: string; revision: number } | null
    readonly now: number
  },
): Promise<{ readonly assignment: AssignmentContext; readonly outcome: AdmissionOutcome }> {
  // 1) assignment（可选上下文）。
  const assignment = await deps.lookup.resolveAssignment({
    repositoryId: input.repositoryId,
    repositoryGroupId: input.repositoryGroupId,
  })

  // 2) 占位 repository facts：PR-5 接真实 inspector 前全部 unknown（collectable）。
  const unknownCell: FactCell<FactCellValue> = {
    state: 'unknown',
    reason: 'repository-inspector-not-run',
    collectable: true,
  }
  const snapshot = buildFactSnapshot({
    missionRevision: 0,
    capturedAt: new Date(input.now).toISOString().replace('Z', '+00:00'),
    cells: {
      'repository.languages': unknownCell,
      'repository.buildSystems': unknownCell,
      'repository.moduleIds': unknownCell,
    },
  })

  // 3) selection rules 来自 assignment.selectionPolicy 的 employeeSelection group。
  let selectionRules: EmployeeSelectionRule[] | null = null
  if (
    assignment?.selectionPolicyId != null &&
    assignment.selectionPolicyRevision != null &&
    assignment.employeeId === null &&
    input.requestedEmployee === null
  ) {
    const policyContent = (await deps.lookup.getPolicyRevisionContent(
      assignment.selectionPolicyId,
      assignment.selectionPolicyRevision,
    )) as { employeeSelection?: { rules?: EmployeeSelectionRule[] } } | null
    selectionRules = policyContent?.employeeSelection?.rules ?? []
  }

  const selection = resolveEmployeeSelection({
    explicitEmployeeRef: input.requestedEmployee
      ? `${input.requestedEmployee.id}@${input.requestedEmployee.revision}`
      : null,
    assignment:
      assignment === null
        ? null
        : {
            scope: assignment.scopeKind,
            employeeRef:
              assignment.employeeId !== null && assignment.employeeRevision !== null
                ? `${assignment.employeeId}@${assignment.employeeRevision}`
                : null,
            selectionRules,
            executionPolicyRef:
              assignment.executionPolicyId !== null && assignment.executionPolicyRevision !== null
                ? `${assignment.executionPolicyId}@${assignment.executionPolicyRevision}`
                : null,
            defaultRequirementSourceKey: assignment.defaultRequirementSourceKey,
          },
    explicitFallbackRef: null,
    snapshot,
  })

  if (selection.outcome === 'blocked') {
    return {
      assignment,
      outcome: {
        kind: 'blocked',
        blockCode:
          selection.reason === 'no-employee-match'
            ? 'no-employee-match'
            : 'selection-indeterminate',
        blockDetail: selection.indeterminateFact,
        employee: null,
      },
    }
  }
  const employee = parseEmployeeRef(selection.employeeRef)
  const content = await loadEmployeeContent(deps.lookup, employee.id, employee.revision)
  if (content === null) {
    return {
      assignment,
      outcome: {
        kind: 'blocked',
        blockCode: 'employee-revision-missing',
        blockDetail: selection.employeeRef,
        employee: null,
      },
    }
  }
  // execution policy：explicit > assignment > employee default；必须存在。
  const policyRef =
    input.requestedPolicy ??
    (assignment?.executionPolicyId != null && assignment.executionPolicyRevision != null
      ? { id: assignment.executionPolicyId, revision: assignment.executionPolicyRevision }
      : content.defaultPolicyRef)
  const policyContent = await deps.lookup.getPolicyRevisionContent(policyRef.id, policyRef.revision)
  if (policyContent === null) {
    return {
      assignment,
      outcome: {
        kind: 'blocked',
        blockCode: 'policy-revision-missing',
        blockDetail: `${policyRef.id}@${policyRef.revision}`,
        employee,
      },
    }
  }
  return {
    assignment,
    outcome: { kind: 'selected', employee, employeeContent: content, policyRef, policyContent },
  }
}

/**
 * External-ID source choice is shared by preview and launch. Keeping this in
 * one pure helper prevents the UI preflight from claiming one adapter while
 * the durable Mission freezes another.
 */
function resolveRequirementSource(
  content: EmployeeContent,
  assignment: AssignmentContext,
  requestedSourceKey: string | null,
): RequirementSourceResolution {
  const candidates = content.requirementSources
  const options = candidates.map((candidate) => candidate.sourceKey)
  const byKey = (key: string) => candidates.find((candidate) => candidate.sourceKey === key) ?? null
  if (requestedSourceKey !== null) {
    const selected = byKey(requestedSourceKey)
    return selected === null
      ? {
          kind: 'blocked',
          blockCode: 'requirement-source-unresolved',
          blockDetail: `requested key '${requestedSourceKey}' not offered by employee`,
          options,
        }
      : { kind: 'selected', source: selected, options }
  }
  if (assignment?.defaultRequirementSourceKey != null) {
    const selected = byKey(assignment.defaultRequirementSourceKey)
    if (selected !== null) return { kind: 'selected', source: selected, options }
  }
  const defaults = candidates.filter((candidate) => candidate.isDefault)
  if (defaults.length === 1) return { kind: 'selected', source: defaults[0]!, options }
  if (candidates.length === 1) return { kind: 'selected', source: candidates[0]!, options }
  if (candidates.length === 0) {
    return {
      kind: 'blocked',
      blockCode: 'requirement-source-unresolved',
      blockDetail: 'employee offers no requirement source',
      options,
    }
  }
  return { kind: 'needs-selection', options }
}

/** 裸 ZodError 到中央 handler 会渲染成 500——统一折成 typed 422（仓内定式）。 */
function parseOr422<T>(
  schema: { safeParse: (v: unknown) => z.SafeParseReturnType<unknown, T> },
  rawInput: unknown,
): T {
  const parsed = schema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ValidationError(
      'mission-input-invalid',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
        .slice(0, 500),
    )
  }
  return parsed.data
}

export async function launchMission(deps: LaunchDeps, rawInput: unknown): Promise<LaunchResult> {
  const input = parseOr422(launchMissionInputSchema, rawInput)
  const existing = deps.store.findByIdempotencyKey(input.idempotencyKey)
  if (existing !== null) {
    return {
      missionId: existing.id,
      status: existing.status,
      created: false,
      blockCode: existing.blockCode,
    }
  }
  const now = deps.now()

  // 0) direct uploads：预读行。store 未接线 ⇒ uploadRows 保持 null，后面老实 blocked。
  let uploadRows: UploadSessionRow[] | null = null
  if (
    input.submission.kind === 'direct' &&
    input.submission.uploads.length > 0 &&
    deps.uploadAdmission !== undefined
  ) {
    uploadRows = readPendingUploadRows(
      deps.uploadAdmission,
      input.submission.uploads,
      input.actorUserId,
      now,
    )
  }
  let pendingPlan: PersistUploadPlanInput | null = null

  // 1–3) assignment → facts → employee/policy 选择器（与 preview 共用同一条链）。
  const { assignment, outcome } = await resolveEmployeeAndPolicy(deps, {
    repositoryId: input.repositoryId,
    repositoryGroupId: input.repositoryGroupId,
    requestedEmployee: input.requestedEmployee,
    requestedPolicy: input.requestedPolicy,
    now,
  })

  const base = {
    id: ulid(),
    revision: 0,
    epoch: 0,
    automationMode: 'active' as const,
    transitionFence: 'none' as const,
    repositoryId: input.repositoryId,
    sourceKind: input.submission.kind,
    sourceContentDigest:
      input.submission.kind === 'direct' ? directContentDigest(input.submission, uploadRows) : null,
    requestedSourceKey:
      input.submission.kind === 'external-reference' ? (input.submission.sourceKey ?? null) : null,
    externalId: input.submission.kind === 'external-reference' ? input.submission.externalId : null,
    resolvedSourceKey: null as string | null,
    resolvedAdapterId: null as string | null,
    resolvedAdapterRevision: null as number | null,
    deliveryKind: input.delivery.kind,
    deliveryTargetRef:
      input.delivery.kind === 'create-merge-request' ? (input.delivery.targetRef ?? null) : null,
    deliverySourceBranch: null,
    adoptedMrRef:
      input.delivery.kind === 'adopt-merge-request' ? input.delivery.mergeRequestRef : null,
    assignmentId: null,
    employeeId: null as string | null,
    employeeRevision: null as number | null,
    policyId: null as string | null,
    policyRevision: null as number | null,
    requirementBundleRef: null,
    repositoryFactsRef: null,
    uploadPlanRef: null as string | null,
    uploadPlacementRef: null,
    uploadPublicationRef: null,
    mrClaimId: null,
    currentActionRunId: null,
    readinessJson: null as string | null,
    blockCode: null as string | null,
    blockDetail: null as string | null,
    terminalKind: null,
    terminalUploadFulfillment: null,
    terminalAt: null,
    launchIdempotencyKey: input.idempotencyKey,
    createdBy: input.actorUserId,
    createdAt: now,
    updatedAt: now,
  }

  let status: MissionStatus
  if (outcome.kind === 'blocked') {
    status = 'blocked'
    base.blockCode = outcome.blockCode
    base.blockDetail = outcome.blockDetail
    if (outcome.employee !== null) {
      base.employeeId = outcome.employee.id
      base.employeeRevision = outcome.employee.revision
    }
  } else {
    base.employeeId = outcome.employee.id
    base.employeeRevision = outcome.employee.revision
    base.policyId = outcome.policyRef.id
    base.policyRevision = outcome.policyRef.revision

    if (input.submission.kind === 'direct') {
      if (input.submission.uploads.length === 0) {
        status = 'working'
      } else if (uploadRows === null) {
        status = 'blocked'
        base.blockCode = 'upload-admission-not-wired'
        base.blockDetail = 'uploads present but upload admission deps are not wired'
      } else {
        const baseline = await deps.uploadAdmission!.resolveBaseline(input.repositoryId)
        const parsedPolicy = automationPolicyContentSchema.safeParse(outcome.policyContent)
        if (baseline === null) {
          status = 'blocked'
          base.blockCode = 'baseline-reader-not-wired'
          base.blockDetail = `no baseline reader for repository ${input.repositoryId}`
        } else if (!parsedPolicy.success) {
          status = 'blocked'
          base.blockCode = 'policy-content-invalid'
          base.blockDetail = `${outcome.policyRef.id}@${outcome.policyRef.revision}`
        } else {
          // 任一 blocked ⇒ ValidationError('upload-plan-blocked') 透传：零 mission、
          // 零 claim（uploads 保持 pending 可复用；改 plan = 修正后重新 launch）。
          const resolved = await resolveUploadPlanEntries({
            uploads: toPlanRequests(input.submission.uploads, uploadRows),
            policy: defaultUploadPolicyOf(parsedPolicy.data),
            baseline: baseline.reader,
          })
          base.uploadPlanRef = resolved.planId
          pendingPlan = {
            planId: resolved.planId,
            missionId: base.id,
            missionRevision: 0,
            repositoryId: input.repositoryId,
            baselineSnapshotRef: baseline.baselineSnapshotRef,
            baselineSha: baseline.baselineSha,
            planDigest: resolved.planDigest({
              repositoryRef: baseline.repositoryRef,
              snapshotRef: baseline.baselineSnapshotRef,
              headSha: baseline.baselineSha,
            }),
            entries: resolved.entries,
            createdAt: now,
          }
          status = 'working'
        }
      }
    } else {
      // requirement source 解析：requested > assignment default > 员工唯一 default。
      const source = resolveRequirementSource(
        outcome.employeeContent,
        assignment,
        input.submission.sourceKey ?? null,
      )
      if (source.kind === 'selected') {
        base.resolvedSourceKey = source.source.sourceKey
        base.resolvedAdapterId = source.source.adapterRef.id
        base.resolvedAdapterRevision = source.source.adapterRef.revision
        status = 'working'
      } else if (source.kind === 'needs-selection') {
        // 多候选且无默认：交互选择（AC-5）。
        status = 'awaiting-information'
        base.blockDetail = JSON.stringify(source.options)
      } else {
        status = 'blocked'
        base.blockCode = source.blockCode
        base.blockDetail = source.blockDetail
      }
    }
  }

  const row: MissionRow = { ...base, status }
  // launch 事务：mission 行 → claim → plan 落库 → source 行，任何失败整体回滚
  // （零 mission、零 upload 消费）。撞 idempotency 赢家用哨兵回滚后重放返回。
  const ua = deps.uploadAdmission
  const runTx: <T>(fn: () => T) => T = ua !== undefined ? ua.transact : (fn) => fn()
  try {
    const mission = runTx(() => {
      const result = deps.store.createMission(row)
      if (!result.created) throw new IdempotentReplay(result.mission)
      if (pendingPlan !== null) {
        ua!.sessions.claimUploads({
          missionId: row.id,
          actorUserId: input.actorUserId,
          uploadRefs: pendingPlan.entries.map((e) => e.fileId),
          now,
        })
        ua!.persistPlan(pendingPlan)
      }
      deps.store.insertMissionSource({
        id: ulid(),
        missionId: row.id,
        generation: 1,
        sourceKind: row.sourceKind,
        externalId: row.externalId,
        adapterId: row.resolvedAdapterId,
        adapterRevision: row.resolvedAdapterRevision,
        sourceRevision: null,
        bundleRef: null,
        manifestDigest: row.sourceContentDigest,
        fileCount: input.submission.kind === 'direct' ? input.submission.uploads.length : null,
        totalBytes: uploadRows === null ? null : uploadRows.reduce((sum, r) => sum + r.bytes, 0),
        state: 'active',
        createdAt: now,
      })
      return result.mission
    })
    return {
      missionId: mission.id,
      status: mission.status,
      created: true,
      blockCode: mission.blockCode,
    }
  } catch (error) {
    if (error instanceof IdempotentReplay) {
      return {
        missionId: error.mission.id,
        status: error.mission.status,
        created: false,
        blockCode: error.mission.blockCode,
      }
    }
    throw error
  }
}

export const previewDirectInputSchema = z
  .object({
    repositoryId: z.string().min(1),
    repositoryGroupId: z.string().min(1).nullable(),
    uploads: z.array(directUploadSchema).min(1).max(100),
    requestedEmployee: versionedRefSchema.nullable(),
    requestedPolicy: versionedRefSchema.nullable(),
    actorUserId: z.string().nullable(),
  })
  .strict()
  .superRefine((input, ctx) => {
    refineUploadList(input.uploads, ctx, ['uploads'])
  })

export const previewMissionAdmissionInputSchema = z
  .object({
    repositoryId: z.string().min(1),
    repositoryGroupId: z.string().min(1).nullable(),
    submission: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('direct') }).strict(),
      z
        .object({
          kind: z.literal('external-reference'),
          sourceKey: z.string().min(1).max(200).optional(),
        })
        .strict(),
    ]),
    requestedEmployee: versionedRefSchema.nullable(),
    requestedPolicy: versionedRefSchema.nullable(),
    actorUserId: z.string().nullable(),
  })
  .strict()

export interface MissionAdmissionPreview {
  readonly outcome: 'ready' | 'needs-source-selection' | 'blocked'
  readonly employee: { readonly id: string; readonly revision: number } | null
  readonly policy: { readonly id: string; readonly revision: number } | null
  readonly requirementSource: {
    readonly sourceKey: string
    readonly adapter: { readonly id: string; readonly revision: number }
  } | null
  readonly sourceOptions: readonly string[]
  readonly block: { readonly code: string; readonly detail: string | null } | null
}

/**
 * Side-effect-free configuration preflight for every submission shape. Unlike
 * the upload disposition preview, this needs no upload sessions and therefore
 * also explains body-only and external-ID launches before a Mission is
 * created. Selection and source resolution call the same helpers as launch.
 */
export async function previewMissionAdmission(
  deps: LaunchDeps,
  rawInput: unknown,
): Promise<MissionAdmissionPreview> {
  const input = parseOr422(previewMissionAdmissionInputSchema, rawInput)
  const { assignment, outcome } = await resolveEmployeeAndPolicy(deps, {
    repositoryId: input.repositoryId,
    repositoryGroupId: input.repositoryGroupId,
    requestedEmployee: input.requestedEmployee,
    requestedPolicy: input.requestedPolicy,
    now: deps.now(),
  })
  if (outcome.kind === 'blocked') {
    return {
      outcome: 'blocked',
      employee: outcome.employee,
      policy: null,
      requirementSource: null,
      sourceOptions: [],
      block: { code: outcome.blockCode, detail: outcome.blockDetail },
    }
  }
  const base = {
    employee: outcome.employee,
    policy: outcome.policyRef,
  }
  if (input.submission.kind === 'direct') {
    return {
      outcome: 'ready',
      ...base,
      requirementSource: null,
      sourceOptions: [],
      block: null,
    }
  }
  const source = resolveRequirementSource(
    outcome.employeeContent,
    assignment,
    input.submission.sourceKey ?? null,
  )
  if (source.kind === 'selected') {
    return {
      outcome: 'ready',
      ...base,
      requirementSource: {
        sourceKey: source.source.sourceKey,
        adapter: source.source.adapterRef,
      },
      sourceOptions: source.options,
      block: null,
    }
  }
  if (source.kind === 'needs-selection') {
    return {
      outcome: 'needs-source-selection',
      ...base,
      requirementSource: null,
      sourceOptions: source.options,
      block: null,
    }
  }
  return {
    outcome: 'blocked',
    ...base,
    requirementSource: null,
    sourceOptions: source.options,
    block: { code: source.blockCode, detail: source.blockDetail },
  }
}

export interface DirectInputPreview {
  readonly employee: { readonly id: string; readonly revision: number }
  readonly policy: { readonly id: string; readonly revision: number }
  readonly baseline: { readonly snapshotRef: string; readonly sha: string }
  readonly dispositions: readonly UploadDisposition[]
}

/**
 * direct 上传落点 preview（design §12.1）：跑与 launch 同一条 employee/policy
 * 选择链，在当前 baseline 上返回逐项 disposition。不写 workspace、不建 Mission、
 * 不 claim；launch 时仍会冻结 baseline 重验，preview 结果不被信任复用。
 */
export async function previewDirectInput(
  deps: LaunchDeps,
  rawInput: unknown,
): Promise<DirectInputPreview> {
  const input = parseOr422(previewDirectInputSchema, rawInput)
  const ua = deps.uploadAdmission
  if (ua === undefined) {
    throw new ValidationError('upload-admission-not-wired', 'upload admission deps are not wired')
  }
  const now = deps.now()
  const rows = readPendingUploadRows(ua, input.uploads, input.actorUserId, now)
  const { outcome } = await resolveEmployeeAndPolicy(deps, {
    repositoryId: input.repositoryId,
    repositoryGroupId: input.repositoryGroupId,
    requestedEmployee: input.requestedEmployee,
    requestedPolicy: input.requestedPolicy,
    now,
  })
  if (outcome.kind === 'blocked') {
    // 选择不唯一/配置缺失：直接配置阻断，不能用全局默认顶替未选出的策略。
    throw new ValidationError(outcome.blockCode, outcome.blockDetail ?? outcome.blockCode)
  }
  const baseline = await ua.resolveBaseline(input.repositoryId)
  if (baseline === null) {
    throw new ValidationError(
      'baseline-reader-not-wired',
      `no baseline reader for repository ${input.repositoryId}`,
    )
  }
  const parsedPolicy = automationPolicyContentSchema.safeParse(outcome.policyContent)
  if (!parsedPolicy.success) {
    throw new ValidationError(
      'policy-content-invalid',
      `${outcome.policyRef.id}@${outcome.policyRef.revision}`,
    )
  }
  const dispositions = await previewUploadDispositions({
    uploads: toPlanRequests(input.uploads, rows),
    policy: defaultUploadPolicyOf(parsedPolicy.data),
    baseline: baseline.reader,
  })
  return {
    employee: outcome.employee,
    policy: outcome.policyRef,
    baseline: { snapshotRef: baseline.baselineSnapshotRef, sha: baseline.baselineSha },
    dispositions,
  }
}

export async function selectMissionRequirementSource(
  deps: LaunchDeps,
  input: { readonly missionId: string; readonly sourceKey: string },
): Promise<{ readonly status: MissionStatus }> {
  const mission = deps.store.getMission(input.missionId)
  if (mission === null) throw new NotFoundError('mission-not-found', 'mission not found')
  const admissible = checkCommandAdmissible({
    command: 'select-requirement-source',
    status: mission.status,
    automationMode: mission.automationMode,
    fence: mission.transitionFence,
    hasMergeRequest: mission.mrClaimId !== null,
  })
  if (!admissible.ok) {
    // 幂等：同 key 已解析过（awaiting → working 后重放同请求）直接返回。
    if (mission.resolvedSourceKey === input.sourceKey && mission.status === 'working') {
      return { status: mission.status }
    }
    throw new ConflictError(`mission-command-${admissible.code}`, admissible.code)
  }
  if (mission.employeeId === null || mission.employeeRevision === null) {
    throw new ConflictError('mission-employee-not-pinned', 'employee not pinned')
  }
  const content = await loadEmployeeContent(
    deps.lookup,
    mission.employeeId,
    mission.employeeRevision,
  )
  const candidate = content?.requirementSources.find((c) => c.sourceKey === input.sourceKey) ?? null
  if (candidate === null) {
    throw new ValidationError(
      'requirement-source-not-offered',
      `source key '${input.sourceKey}' is not offered by the pinned employee`,
    )
  }
  const result = deps.store.occUpdate(mission.id, mission.revision, mission.epoch, {
    status: 'working',
    resolvedSourceKey: candidate.sourceKey,
    resolvedAdapterId: candidate.adapterRef.id,
    resolvedAdapterRevision: candidate.adapterRef.revision,
    blockDetail: null,
  })
  if (!result.ok) throw new ConflictError(`mission-occ-${result.code}`, result.code)
  return { status: 'working' }
}

export async function retryBlockedMission(
  deps: LaunchDeps,
  input: { readonly missionId: string },
): Promise<{ readonly status: MissionStatus }> {
  const mission = deps.store.getMission(input.missionId)
  if (mission === null) throw new NotFoundError('mission-not-found', 'mission not found')
  const admissible = checkCommandAdmissible({
    command: 'retry-blocked',
    status: mission.status,
    automationMode: mission.automationMode,
    fence: mission.transitionFence,
    hasMergeRequest: mission.mrClaimId !== null,
  })
  if (!admissible.ok) throw new ConflictError(`mission-command-${admissible.code}`, admissible.code)
  const result = deps.store.occUpdate(mission.id, mission.revision, mission.epoch, {
    status: 'working',
    blockCode: null,
    blockDetail: null,
  })
  if (!result.ok) throw new ConflictError(`mission-occ-${result.code}`, result.code)
  return { status: 'working' }
}

export async function cancelMission(
  deps: LaunchDeps,
  input: { readonly missionId: string },
): Promise<{ readonly status: MissionStatus; readonly pending: boolean }> {
  const mission = deps.store.getMission(input.missionId)
  if (mission === null) throw new NotFoundError('mission-not-found', 'mission not found')
  const admissible = checkCommandAdmissible({
    command: 'cancel',
    status: mission.status,
    automationMode: mission.automationMode,
    fence: mission.transitionFence,
    hasMergeRequest: mission.mrClaimId !== null,
  })
  if (!admissible.ok) throw new ConflictError(`mission-command-${admissible.code}`, admissible.code)
  const now = deps.now()

  // fence 先落（bump epoch 使一切在途 continuation 过期），未 dispatch intent 作废。
  const fenced = deps.store.bumpEpoch(mission.id, mission.revision, {
    transitionFence: 'cancel-pending',
  })
  if (!fenced.ok) throw new ConflictError(`mission-occ-${fenced.code}`, fenced.code)
  const unsettled = deps.store.listUnsettledEffects(mission.id)
  for (const effect of unsettled) {
    if (effect.state === 'prepared') deps.store.invalidateEffect(effect.id, now)
  }
  const remaining = deps.store
    .listUnsettledEffects(mission.id)
    .filter((e) => e.state === 'dispatched')
  if (remaining.length > 0) {
    // 已 dispatch/结果未知的外部 effect 必须先按外部真相 reconcile（T26/T28 的
    // reconciler 负责查询并 settle 后收口到 canceled）；此处保持 cancel-pending。
    return { status: mission.status, pending: true }
  }
  const settled = deps.store.occUpdate(mission.id, fenced.revision, mission.epoch + 1, {
    status: 'canceled',
    transitionFence: 'none',
    terminalKind: 'canceled',
    terminalAt: now,
  })
  if (!settled.ok) throw new ConflictError(`mission-occ-${settled.code}`, settled.code)
  return { status: 'canceled', pending: false }
}
