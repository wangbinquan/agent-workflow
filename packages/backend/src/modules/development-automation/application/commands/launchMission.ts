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

const versionedRefSchema = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict()

const directUploadSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
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
    const seen = new Set<string>()
    uploads.forEach((upload, index) => {
      if (seen.has(upload.repositoryTargetPath)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate repository target path: ${upload.repositoryTargetPath}`,
          path: ['submission', 'uploads', index, 'repositoryTargetPath'],
        })
      }
      seen.add(upload.repositoryTargetPath)
    })
  })

export type LaunchMissionInput = z.infer<typeof launchMissionInputSchema>

export interface LaunchDeps {
  readonly store: MissionStore
  readonly lookup: AdmissionLookup
  readonly now: () => number
}

export interface LaunchResult {
  readonly missionId: string
  readonly status: MissionStatus
  readonly created: boolean
  readonly blockCode: string | null
}

function directContentDigest(
  submission: Extract<LaunchMissionInput['submission'], { kind: 'direct' }>,
): string {
  return canonicalDigest({
    title: submission.title.trim(),
    body: submission.body?.trim() ?? null,
    uploads: submission.uploads.map((u, ordinal) => ({
      ordinal,
      fileName: u.fileName,
      sha256: u.sha256,
      targetPath: u.repositoryTargetPath,
      collisionMode: u.collisionMode ?? 'create-only',
      contentPolicy: u.contentPolicy ?? 'preserve-upload',
      fileMode: u.fileMode ?? 'regular',
    })),
  })
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

export async function launchMission(deps: LaunchDeps, rawInput: unknown): Promise<LaunchResult> {
  const input = launchMissionInputSchema.parse(rawInput)
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
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
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

  const base = {
    id: ulid(),
    revision: 0,
    epoch: 0,
    automationMode: 'active' as const,
    transitionFence: 'none' as const,
    repositoryId: input.repositoryId,
    sourceKind: input.submission.kind,
    sourceContentDigest:
      input.submission.kind === 'direct' ? directContentDigest(input.submission) : null,
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
    uploadPlanRef: null,
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
  if (selection.outcome === 'blocked') {
    status = 'blocked'
    base.blockCode =
      selection.reason === 'no-employee-match' ? 'no-employee-match' : 'selection-indeterminate'
    base.blockDetail = selection.indeterminateFact
  } else {
    const employee = parseEmployeeRef(selection.employeeRef)
    const content = await loadEmployeeContent(deps.lookup, employee.id, employee.revision)
    if (content === null) {
      status = 'blocked'
      base.blockCode = 'employee-revision-missing'
      base.blockDetail = selection.employeeRef
    } else {
      base.employeeId = employee.id
      base.employeeRevision = employee.revision

      // execution policy：explicit > assignment > employee default；必须存在。
      const policyRef =
        input.requestedPolicy ??
        (assignment?.executionPolicyId != null && assignment.executionPolicyRevision != null
          ? { id: assignment.executionPolicyId, revision: assignment.executionPolicyRevision }
          : content.defaultPolicyRef)
      const policyContent = await deps.lookup.getPolicyRevisionContent(
        policyRef.id,
        policyRef.revision,
      )
      if (policyContent === null) {
        status = 'blocked'
        base.blockCode = 'policy-revision-missing'
        base.blockDetail = `${policyRef.id}@${policyRef.revision}`
      } else {
        base.policyId = policyRef.id
        base.policyRevision = policyRef.revision

        if (input.submission.kind === 'direct') {
          status = 'working'
        } else {
          // requirement source 解析：requested > assignment default > 员工唯一 default。
          const candidates = content.requirementSources
          const requested = input.submission.sourceKey ?? null
          const byKey = (key: string) => candidates.find((c) => c.sourceKey === key) ?? null
          let resolved: (typeof candidates)[number] | null = null
          if (requested !== null) {
            resolved = byKey(requested)
            if (resolved === null) {
              status = 'blocked'
              base.blockCode = 'requirement-source-unresolved'
              base.blockDetail = `requested key '${requested}' not offered by employee`
            }
          } else if (
            assignment?.defaultRequirementSourceKey != null &&
            byKey(assignment.defaultRequirementSourceKey) !== null
          ) {
            resolved = byKey(assignment.defaultRequirementSourceKey)
          } else {
            const defaults = candidates.filter((c) => c.isDefault)
            if (defaults.length === 1) resolved = defaults[0]!
            else if (candidates.length === 1) resolved = candidates[0]!
          }
          if (resolved !== null) {
            base.resolvedSourceKey = resolved.sourceKey
            base.resolvedAdapterId = resolved.adapterRef.id
            base.resolvedAdapterRevision = resolved.adapterRef.revision
            status = 'working'
          } else if (base.blockCode === null) {
            if (candidates.length === 0) {
              status = 'blocked'
              base.blockCode = 'requirement-source-unresolved'
              base.blockDetail = 'employee offers no requirement source'
            } else {
              // 多候选且无默认：交互选择（AC-5）。
              status = 'awaiting-information'
              base.blockDetail = JSON.stringify(candidates.map((c) => c.sourceKey))
            }
          } else {
            status = 'blocked'
          }
        }
      }
    }
  }

  const row: MissionRow = { ...base, status }
  const { created, mission } = deps.store.createMission(row)
  if (created) {
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
      totalBytes: null,
      state: 'active',
      createdAt: now,
    })
  }
  return {
    missionId: mission.id,
    status: mission.status,
    created,
    blockCode: mission.blockCode,
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
