import { ulid } from 'ulid'
import {
  classifyTerminalKind,
  PLATFORM_WORK_ITEM_SLOT_REF,
} from '@/modules/digital-employee/public/types'
import type { WorkspaceFailureClass } from '@/modules/digital-employee/public/types'
import { z } from 'zod'
import {
  PLATFORM_WORKSPACE_DIR,
  TaskLaunchOriginSchema,
  type TaskLaunchOrigin,
} from '@agent-workflow/shared'
import { retryAttemptCap } from '@/platform/contracts/retryAttemptCap'

import type { EventCenterParticipant } from '@/modules/event-center/public/participants'
import type { EventObservationInput } from '@/modules/event-center/public/types'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { stableIdentityComponent } from '@/util/gitRef'
import type {
  EmployeeCaseDetailInputProjection,
  EmployeeCaseDetailProjectionInputV1,
  EmployeeCaseDetailProjectionParticipant,
  EmployeeTypeCollaborationCodec,
  EmployeeTypeContextCodec,
  EmployeeTypeReactionCodec,
} from '../public/types'
import { employeeInvocationResultObservation } from '../public/events'

type EmployeeTypeRuntimeCodec = EmployeeTypeContextCodec &
  EmployeeTypeReactionCodec &
  EmployeeTypeCollaborationCodec
import type {
  DigitalEmployeeAuthoringPersistence,
  DigitalEmployeePlatformToolCatalog,
} from './ports/authoringStore'
import { EMPTY_DIGITAL_EMPLOYEE_PLATFORM_TOOL_CATALOG } from './ports/authoringStore'
import type { ExecutionPolicyRevisionRecord } from './ports/authoringStore'
import type {
  AttentionBindingRecord,
  EmployeeOutboxRecord,
  RuntimeCasePersistence,
} from './ports/runtimeStore'
import type { EmployeeInputUploadPersistence } from './ports/inputUploadStore'
import type {
  EmployeeInputArtifactPort,
  PlatformWorkItemExecutionPort,
  ReactionExecutionMetering,
  ReactionExecutionPort,
} from '../composition/required-ports'
import {
  employeeCollaborationBindingSchema,
  effectiveReactionPriority,
  findWorkContract,
  findWorkItem,
  findToolSlot,
  type EmployeeTypePackageDescriptor,
  type EmployeeCollaborationBinding,
  type EmployeeTypeRef,
  type ExactResourceRef,
  type OrderedDispatchConfiguration,
  type WorkItemDefinition,
} from '../domain/model'
import {
  attentionSubjectSchema,
  employeeCaseLaunchSchema,
  employeeWorkIntakeSchema,
  evaluateEmployeeInvocationGuard,
  evaluateEmployeeInvocationJoin,
  MAX_EMPLOYEE_INVOCATION_DEPTH,
  reactionExecutionPlanSchema,
  runtimeDigest,
  validateRepositoryBranchOption,
  type EmployeeCaseRecord,
  type EmployeeContextRecord,
  type ReactionExecutionPlan,
  type ReactionRoundRecord,
} from '../domain/runtimeModel'

const subscribePayloadSchema = z
  .object({
    bindingId: z.string().min(1),
    // Optional for replaying durable outbox rows written before Attention
    // reactivation became generation-aware. New rows always carry it so a
    // cancelled identity can enqueue a distinct subscribe effect.
    contextRevision: z.number().int().positive().optional(),
    eventTypeRef: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
    subject: z.object({ typeId: z.string().min(1), subjectRef: z.string().min(1) }),
    caseId: z.string().min(1),
    // Old durable outbox rows predate this flag and keep the historical
    // late-subscription behavior.
    replayLatest: z.boolean().default(true),
  })
  .strict()

const unsubscribePayloadSchema = z
  .object({ bindingId: z.string().min(1), subscriptionId: z.string().min(1) })
  .strict()

const invocationCompletionSchema = z
  .object({
    contractId: z.string().min(1),
    resultSchemaId: z.string().min(1),
    eventTypeRef: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
    sourceRef: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
  })
  .strict()

const settlementContextPatchSchema = z
  .object({
    contextId: z.string().min(1).max(200).nullable(),
    contextTypeId: z.string().min(1).max(200),
    schemaVersion: z.number().int().positive(),
    expectedRevision: z.number().int().positive().nullable(),
    lifecycleState: z.enum(['active', 'waiting', 'terminal']),
    stateJson: z
      .string()
      .min(2)
      .max(2 * 1024 * 1024),
    artifactRefs: z.array(z.string().min(1).max(1_000)).max(500),
  })
  .strict()

const reactionSettlementSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseState: z.enum(['active', 'waiting', 'blocked', 'terminal']),
    terminalKind: z.string().min(1).max(160).nullable(),
    blockReason: z.string().min(1).max(2_000).nullable(),
    nextWorkItemRef: z.string().min(1).max(160).nullable(),
    summary: z.string().min(1).max(5_000),
    contextPatches: z.array(settlementContextPatchSchema).max(50),
    effectSuggestions: z.array(z.string().min(1).max(200)).max(50),
    artifactRefs: z.array(z.string().min(1).max(1_000)).max(500),
  })
  .strict()

const employeeCaseDetailInputProjectionSchema = z
  .object({
    source: TaskLaunchOriginSchema,
    ingressRef: z.string().min(1).max(200).nullable(),
    kind: z.enum(['body', 'files', 'body-and-files', 'external-id', 'event', 'unknown']),
    subjectRef: z.string().min(1).max(1_000).nullable(),
    repositoryRef: z.string().min(1).max(500).nullable(),
    body: z
      .string()
      .max(2 * 1024 * 1024)
      .nullable(),
    externalId: z.string().min(1).max(500).nullable(),
    uploads: z
      .array(
        z
          .object({
            artifactRef: z.string().min(1).max(1_000),
            originalName: z.string().min(1).max(1_000),
            placement: z.enum(['repository', 'temporary']),
            targetPath: z.string().min(1).max(1_000).nullable(),
          })
          .strict(),
      )
      .max(500),
    executionOptions: z.record(z.string().min(1).max(160), z.boolean()),
    advancedOptions: z.record(z.string().min(1).max(160), z.string().max(1_000)).default({}),
  })
  .strict()

const employeeCaseTypeDetailProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    input: employeeCaseDetailInputProjectionSchema,
    workspace: z
      .object({
        repositoryRef: z.string().min(1).max(500),
        cachedRepositoryRef: z.string().min(1).max(500),
        baselineSha: z.string().min(1).max(128),
        targetBranch: z.string().min(1).max(500),
        sourceBranch: z.string().min(1).max(500),
        remoteHeadSha: z.string().min(1).max(128).nullable(),
        state: z.enum(['active', 'published', 'released']),
      })
      .strict()
      .nullable(),
    changeCandidate: z
      .object({
        status: z.enum(['prepared', 'committed', 'published', 'obsolete']),
        candidateRef: z.string().min(1).max(128),
        baselineSha: z.string().min(1).max(128),
        treeOid: z.string().min(1).max(128),
        summary: z.string().min(1).max(5_000),
        changedPaths: z.array(z.string().min(1).max(1_000)).max(5_000),
        commitSha: z.string().min(1).max(128).nullable(),
      })
      .strict()
      .nullable(),
    delivery: z
      .object({
        kind: z.literal('merge-request'),
        status: z.enum(['active', 'merged', 'closed']),
        ref: z.string().min(1).max(1_000),
        providerRef: z.string().min(1).max(500).nullable(),
        webUrl: z.string().url().nullable(),
        repositoryRef: z.string().min(1).max(500).nullable(),
        sourceBranch: z.string().min(1).max(500).nullable(),
        targetBranch: z.string().min(1).max(500).nullable(),
        headSha: z.string().min(1).max(128),
        targetSha: z.string().min(1).max(128).nullable(),
        mergedCommitSha: z.string().min(1).max(128).nullable(),
        draft: z.boolean(),
        mergeableState: z.enum(['mergeable', 'conflict', 'unknown']),
        readyToMerge: z.boolean(),
        approvalHold: z.boolean().nullable(),
        unresolvedReviewCount: z.number().int().nonnegative(),
        relatedRegionRefs: z.array(z.string().min(1).max(160)).max(100),
        relatedWorkItemRefs: z.array(z.string().min(1).max(160)).max(500),
      })
      .strict()
      .nullable(),
  })
  .strict()

const employeeCaseArtifactSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input') }).strict(),
  z.object({ kind: z.literal('context'), contextId: z.string().min(1).max(500) }).strict(),
  z
    .object({
      kind: z.literal('round'),
      roundId: z.string().min(1).max(500),
      executionRef: z.string().min(1).max(500).nullable(),
    })
    .strict(),
])

const employeeCaseDetailProjectionSchema = employeeCaseTypeDetailProjectionSchema.extend({
  artifacts: z
    .array(
      z
        .object({
          ref: z.string().min(1).max(1_000),
          sources: z.array(employeeCaseArtifactSourceSchema).min(1).max(1_000),
        })
        .strict(),
    )
    .max(10_000),
})

type EmployeeCaseTypeDetailProjectionV1 = z.infer<typeof employeeCaseTypeDetailProjectionSchema>
type EmployeeCaseDetailProjectionV1 = z.infer<typeof employeeCaseDetailProjectionSchema>

function artifactRefsFromRoundOutput(outputJson: string | null): string[] {
  if (outputJson === null) return []
  try {
    const output = JSON.parse(outputJson) as unknown
    if (output === null || typeof output !== 'object' || Array.isArray(output)) return []
    const artifactRefs = (output as Record<string, unknown>).artifactRefs
    return Array.isArray(artifactRefs)
      ? artifactRefs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
      : []
  } catch {
    return []
  }
}

export function projectEmployeeCaseArtifacts(input: {
  readonly detailInput: EmployeeCaseDetailInputProjection
  readonly contexts: readonly Pick<EmployeeContextRecord, 'id' | 'artifactRefs'>[]
  readonly rounds: readonly Pick<ReactionRoundRecord, 'id' | 'executionRef' | 'outputJson'>[]
}): EmployeeCaseDetailProjectionV1['artifacts'] {
  const byRef = new Map<
    string,
    {
      ref: string
      sources: Array<z.infer<typeof employeeCaseArtifactSourceSchema>>
      sourceKeys: Set<string>
    }
  >()
  const add = (
    ref: string,
    source: z.infer<typeof employeeCaseArtifactSourceSchema>,
    sourceKey: string,
  ) => {
    const item = byRef.get(ref) ?? { ref, sources: [], sourceKeys: new Set<string>() }
    if (!item.sourceKeys.has(sourceKey)) {
      item.sourceKeys.add(sourceKey)
      item.sources.push(source)
    }
    byRef.set(ref, item)
  }
  for (const upload of input.detailInput.uploads)
    add(upload.artifactRef, { kind: 'input' }, 'input')
  for (const context of input.contexts) {
    for (const ref of context.artifactRefs) {
      add(ref, { kind: 'context', contextId: context.id }, `context:${context.id}`)
    }
  }
  for (const round of input.rounds) {
    for (const ref of artifactRefsFromRoundOutput(round.outputJson)) {
      add(
        ref,
        { kind: 'round', roundId: round.id, executionRef: round.executionRef },
        `round:${round.id}`,
      )
    }
  }
  return [...byRef.values()].map(({ ref, sources }) => ({ ref, sources }))
}

function fallbackEmployeeCaseTypeDetail(
  caseRecord: EmployeeCaseRecord,
): EmployeeCaseTypeDetailProjectionV1 {
  return {
    schemaVersion: 1,
    input: {
      source: caseRecord.launchOrigin,
      ingressRef: null,
      kind: 'unknown',
      subjectRef: null,
      repositoryRef: null,
      body: null,
      externalId: null,
      uploads: [],
      executionOptions: {},
      advancedOptions: {},
    },
    workspace: null,
    changeCandidate: null,
    delivery: null,
  }
}

export interface DigitalEmployeeRuntimeServiceDependencies {
  readonly store: RuntimeCasePersistence
  readonly authoringStore: DigitalEmployeeAuthoringPersistence
  readonly eventCenter: EventCenterParticipant
  readonly execution: ReactionExecutionPort
  readonly platformWorkItems: PlatformWorkItemExecutionPort
  readonly inputUploads: EmployeeInputUploadPersistence
  readonly inputArtifacts: EmployeeInputArtifactPort
  readonly runtimeCodecs: readonly EmployeeTypeRuntimeCodec[]
  readonly detailProjectionParticipants?: readonly EmployeeCaseDetailProjectionParticipant[]
  /** Latest installed revision for each programmable employee type. */
  readonly currentTypeRefs: readonly EmployeeTypeRef[]
  readonly executionContracts: ExecutionContractParticipant
  readonly platformTools?: DigitalEmployeePlatformToolCatalog
  readonly resolveExecutionPolicy?: () => Promise<ExecutionPolicyRevisionRecord>
  readonly now?: () => number
  readonly id?: () => string
  readonly workerId?: string
  readonly outboxLeaseMs?: number
}

function sameRef(
  left: { readonly id: string; readonly revision: number },
  right: { readonly id: string; readonly revision: number },
): boolean {
  return left.id === right.id && left.revision === right.revision
}

function typeKey(typeId: string, revision: number): string {
  return `${typeId}@${revision}`
}

export function isEmployeeReactionEventEnabled(input: {
  readonly descriptor: EmployeeTypePackageDescriptor
  readonly enabledWorkItemRefs: readonly string[]
  readonly eventTypeId: string
}): boolean {
  const enabledWorkItemRefs = new Set(
    input.enabledWorkItemRefs.length === 0
      ? input.descriptor.authoringManifest.workItems.map((candidate) => candidate.workItemRef)
      : input.enabledWorkItemRefs,
  )
  return input.descriptor.reactionRules.some(
    (rule) =>
      rule.eventTypeId === input.eventTypeId &&
      enabledWorkItemRefs.has(rule.capabilityWorkItemRef ?? rule.workItemRef),
  )
}

function findFrozenExecutionOptions(
  value: unknown,
  depth = 0,
): Readonly<Record<string, boolean>> | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const candidate = record.executionOptions
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      Object.values(candidate).every((entry) => typeof entry === 'boolean')
    ) {
      return candidate as Record<string, boolean>
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findFrozenExecutionOptions(child, depth + 1)
    if (found !== null) return found
  }
  return null
}

/**
 * 哪些失败类别要求换一个**干净场景**重试。
 *
 * 写成 `satisfies Record<WorkspaceFailureClass, boolean>` 而不是 `=== 'boundary'`：
 * 新增一类失败时这里编译不过，逼作者当场决定它要不要换场景，而不是默认落进「不换」——
 * 后者正是本条 finding 里那族没有 kind 段的 errorCode 长期被静默吞掉的形状。
 */
const ESCALATES_TO_FRESH_SCENE = {
  boundary: true,
  semantic: false,
  infrastructure: false,
} satisfies Record<WorkspaceFailureClass, boolean>

export function boundaryEscalates(errorClass: WorkspaceFailureClass): boolean {
  return ESCALATES_TO_FRESH_SCENE[errorClass]
}

function parseJsonOrUndefined(input: string): unknown {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return undefined
  }
}

export function projectFrozenExecutionOptions(input: {
  readonly definitions: readonly { readonly optionRef: string; readonly defaultValue: boolean }[]
  readonly primaryContextState: unknown
}): Record<string, boolean> {
  const frozen = findFrozenExecutionOptions(input.primaryContextState)
  return Object.fromEntries(
    input.definitions.map((definition) => [
      definition.optionRef,
      frozen?.[definition.optionRef] ?? definition.defaultValue,
    ]),
  )
}

export type EmployeeCaseNextAction =
  | null
  | { readonly owner: 'current-user'; readonly action: 'resolve-blocker' }
  | {
      readonly owner: 'current-user'
      readonly action: 'complete-human-review'
      readonly executionRef: string
    }
  | { readonly owner: 'platform'; readonly action: 'schedule-next-reaction' }
  | { readonly owner: 'digital-employee'; readonly action: 'continue-automatically' }

export function projectEmployeeCaseNextAction(input: {
  readonly caseState: EmployeeCaseRecord['state']
  readonly activeRoundExists: boolean
  readonly hasPendingInbox: boolean
  readonly reviewGates: readonly {
    readonly state: 'not-reached' | 'skipped' | 'planning' | 'waiting' | 'approved' | 'failed'
    readonly executionRef: string | null
  }[]
}): EmployeeCaseNextAction {
  if (input.caseState === 'terminal') return null
  if (input.caseState === 'blocked') {
    return { owner: 'current-user', action: 'resolve-blocker' }
  }
  const waitingReview = input.reviewGates.find(
    (gate) => gate.state === 'waiting' && gate.executionRef !== null,
  )
  if (waitingReview?.executionRef !== null && waitingReview?.executionRef !== undefined) {
    return {
      owner: 'current-user',
      action: 'complete-human-review',
      executionRef: waitingReview.executionRef,
    }
  }
  if (!input.activeRoundExists && input.hasPendingInbox) {
    return { owner: 'platform', action: 'schedule-next-reaction' }
  }
  return { owner: 'digital-employee', action: 'continue-automatically' }
}

function boundedCaseTaskName(candidate: string, fallback: string): string {
  const normalized = candidate.trim().slice(0, 255)
  return normalized === '' ? fallback.slice(0, 255) : normalized
}

function taskNameFromEventIntake(input: {
  readonly body: string | null
  readonly externalId: string | null
  readonly idempotencyKey: string
}): string {
  const material = (input.externalId ?? input.body ?? '').trim()
  const firstLine = material.split(/\r?\n/, 1)[0] ?? ''
  return boundedCaseTaskName(firstLine, input.idempotencyKey)
}

export class DigitalEmployeeRuntimeService {
  readonly #store: RuntimeCasePersistence
  readonly #authoringStore: DigitalEmployeeAuthoringPersistence
  readonly #eventCenter: EventCenterParticipant
  readonly #execution: ReactionExecutionPort
  readonly #platformWorkItems: PlatformWorkItemExecutionPort
  readonly #inputUploads: EmployeeInputUploadPersistence
  readonly #inputArtifacts: EmployeeInputArtifactPort
  readonly #executionContracts: ExecutionContractParticipant
  readonly #platformTools: DigitalEmployeePlatformToolCatalog
  readonly #resolveExecutionPolicy: () => Promise<ExecutionPolicyRevisionRecord>
  readonly #codecs = new Map<string, EmployeeTypeRuntimeCodec>()
  readonly #detailProjectionParticipants = new Map<
    string,
    EmployeeCaseDetailProjectionParticipant
  >()
  readonly #currentTypeRevisions = new Map<string, number>()
  readonly #now: () => number
  readonly #id: () => string
  readonly #workerId: string
  readonly #outboxLeaseMs: number

  constructor(deps: DigitalEmployeeRuntimeServiceDependencies) {
    this.#store = deps.store
    this.#authoringStore = deps.authoringStore
    this.#eventCenter = deps.eventCenter
    this.#execution = deps.execution
    this.#platformWorkItems = deps.platformWorkItems
    this.#inputUploads = deps.inputUploads
    this.#inputArtifacts = deps.inputArtifacts
    this.#executionContracts = deps.executionContracts
    this.#platformTools = deps.platformTools ?? EMPTY_DIGITAL_EMPLOYEE_PLATFORM_TOOL_CATALOG
    this.#resolveExecutionPolicy =
      deps.resolveExecutionPolicy ??
      (async () => {
        const policy = await this.#authoringStore.getCurrentExecutionPolicy()
        if (policy === null) throw new Error('global execution policy is not initialized')
        return policy
      })
    this.#now = deps.now ?? Date.now
    this.#id = deps.id ?? ulid
    this.#workerId = deps.workerId ?? `digital-employee-${ulid()}`
    this.#outboxLeaseMs = deps.outboxLeaseMs ?? 60_000
    for (const codec of deps.runtimeCodecs) {
      if (this.#codecs.has(codec.typeId)) {
        throw new Error(`duplicate employee runtime codec: ${codec.typeId}`)
      }
      this.#codecs.set(codec.typeId, codec)
    }
    for (const participant of deps.detailProjectionParticipants ?? []) {
      if (this.#detailProjectionParticipants.has(participant.typeId)) {
        throw new Error(
          `duplicate employee case detail projection participant: ${participant.typeId}`,
        )
      }
      this.#detailProjectionParticipants.set(participant.typeId, participant)
    }
    for (const ref of deps.currentTypeRefs) {
      const current = this.#currentTypeRevisions.get(ref.typeId) ?? 0
      if (ref.revision > current) this.#currentTypeRevisions.set(ref.typeId, ref.revision)
    }
  }

  #assertCurrentLaunchType(ref: EmployeeTypeRef): void {
    const currentRevision = this.#currentTypeRevisions.get(ref.typeId)
    if (currentRevision === ref.revision) return
    throw new ValidationError(
      'employee-upgrade-required',
      `digital employee ${typeKey(ref.typeId, ref.revision)} cannot start new work; upgrade it to ${typeKey(ref.typeId, currentRevision ?? 0)}`,
      { employeeTypeRef: ref, currentTypeRevision: currentRevision ?? null },
    )
  }

  #codec(typeId: string): EmployeeTypeRuntimeCodec {
    const codec = this.#codecs.get(typeId)
    if (codec === undefined) {
      throw new NotFoundError(
        'employee-runtime-codec-not-found',
        `employee runtime codec not found: ${typeId}`,
      )
    }
    return codec
  }

  async #descriptor(caseRecord: EmployeeCaseRecord): Promise<EmployeeTypePackageDescriptor> {
    const record = await this.#authoringStore.getTypePackage(caseRecord.typeRef)
    if (record === null || record.state !== 'published') {
      throw new NotFoundError(
        'employee-type-not-found',
        `employee type not found: ${typeKey(caseRecord.typeRef.typeId, caseRecord.typeRef.revision)}`,
      )
    }
    return record.descriptor
  }

  async #projectCaseDetail(
    caseRecord: EmployeeCaseRecord,
    contexts: readonly EmployeeContextRecord[],
    rounds: readonly ReactionRoundRecord[],
  ): Promise<EmployeeCaseDetailProjectionV1> {
    const participant = this.#detailProjectionParticipants.get(caseRecord.typeRef.typeId)
    const request: EmployeeCaseDetailProjectionInputV1 = {
      schemaVersion: 1,
      case: {
        id: caseRecord.id,
        typeRef: caseRecord.typeRef,
        launchOrigin: caseRecord.launchOrigin,
        primaryContextId: caseRecord.primaryContextId,
      },
      contexts: contexts.map((context) => ({
        id: context.id,
        typeId: context.typeId,
        schemaVersion: context.schemaVersion,
        stateJson: context.stateJson,
        artifactRefs: context.artifactRefs,
        updatedAt: context.updatedAt,
      })),
      rounds: rounds.map((round) => ({
        id: round.id,
        executionRef: round.executionRef,
        outputJson: round.outputJson,
      })),
    }
    const typeDetail =
      participant === undefined
        ? fallbackEmployeeCaseTypeDetail(caseRecord)
        : employeeCaseTypeDetailProjectionSchema.parse(
            JSON.parse(await participant.projectJson(JSON.stringify(request))) as unknown,
          )
    return employeeCaseDetailProjectionSchema.parse({
      ...typeDetail,
      artifacts: projectEmployeeCaseArtifacts({
        detailInput: typeDetail.input,
        contexts,
        rounds,
      }),
    })
  }

  async #toolRevision(ref: ExactResourceRef) {
    return this.#platformTools.getRevision(ref) ?? (await this.#authoringStore.getToolRevision(ref))
  }

  #selectWorkItemSlot(input: {
    readonly caseRecord: EmployeeCaseRecord
    readonly item: WorkItemDefinition
    readonly contexts: readonly EmployeeContextRecord[]
    readonly orderedDispatchConfigurations: readonly OrderedDispatchConfiguration[]
    readonly preferredSlotRef: string | undefined
  }): string {
    const defaultSlotRef =
      input.preferredSlotRef ??
      (input.item.nodeKind === 'collaboration' ? 'collaboration' : undefined) ??
      input.item.toolRoleGroups.flatMap((group) => group.bindingSlots).find((slot) => slot.required)
        ?.slotRef ??
      input.item.toolRoleGroups.flatMap((group) => group.bindingSlots)[0]?.slotRef ??
      'system'
    return z
      .object({ slotRef: z.string().min(1).max(160) })
      .strict()
      .parse(
        JSON.parse(
          this.#codec(input.caseRecord.typeRef.typeId).selectReactionToolSlotJson(
            JSON.stringify({
              schemaVersion: 1,
              workItemRef: input.item.workItemRef,
              defaultSlotRef,
              contextsJson: JSON.stringify(input.contexts),
              orderedDispatchConfigurationsJson: JSON.stringify(
                input.orderedDispatchConfigurations,
              ),
            }),
          ),
        ) as unknown,
      ).slotRef
  }

  async launchWork(input: {
    readonly employeeId: string
    readonly intake: unknown
    readonly actorUserId: string | null
    readonly eventOrigin?: {
      readonly eventSubscriptionId: string
      readonly eventDeliveryId: string
    }
  }): Promise<EmployeeCaseRecord> {
    if (input.eventOrigin !== undefined) {
      const existing = await this.#store.findCaseByEventDelivery(input.eventOrigin.eventDeliveryId)
      if (existing !== null) return existing
    }
    const employee = await this.#authoringStore.getEmployeeDefinition(input.employeeId)
    if (employee === null || employee.archivedAt !== null || employee.currentRevision === null) {
      throw new NotFoundError(
        'employee-definition-not-found',
        `digital employee not found: ${input.employeeId}`,
      )
    }
    const employeeRef = { id: employee.id, revision: employee.currentRevision }
    const revision = await this.#authoringStore.getEmployeeDefinitionRevision(employeeRef)
    if (revision === null) {
      throw new ValidationError(
        'employee-definition-unavailable',
        'the exact employee revision is missing',
      )
    }
    this.#assertCurrentLaunchType(revision.content.typeRef)
    const scope = await this.#authoringStore.getWorkScopeRevision(revision.content.workScopeRef)
    if (scope === null) {
      throw new ValidationError(
        'employee-work-scope-unavailable',
        'the employee work scope revision is unavailable',
      )
    }
    const admittedType = await this.#authoringStore.getTypePackage(revision.content.typeRef)
    if (admittedType === null || admittedType.state !== 'published') {
      throw new ValidationError(
        'employee-type-unavailable',
        'the employee type package is unavailable at work admission',
      )
    }
    const parsedIntake = employeeWorkIntakeSchema.parse(input.intake)
    const optionDefinitions = admittedType.descriptor.workIntakeAuthoring.executionOptions
    const allowedOptionRefs = new Set(optionDefinitions.map((option) => option.optionRef))
    const unknownOption = Object.keys(parsedIntake.executionOptions).find(
      (optionRef) => !allowedOptionRefs.has(optionRef),
    )
    if (unknownOption !== undefined) {
      throw new ValidationError(
        'employee-intake-option-unknown',
        `unknown employee intake option: ${unknownOption}`,
      )
    }
    const executionOptions = Object.fromEntries(
      optionDefinitions.map((option) => [
        option.optionRef,
        parsedIntake.executionOptions[option.optionRef] ?? option.defaultValue,
      ]),
    )
    const advancedOptionDefinitions = admittedType.descriptor.workIntakeAuthoring.advancedOptions
    const advancedOptionByRef = new Map(
      advancedOptionDefinitions.map((option) => [option.optionRef, option]),
    )
    const unknownAdvancedOption = Object.keys(parsedIntake.advanced.typeOptions).find(
      (optionRef) => !advancedOptionByRef.has(optionRef),
    )
    if (unknownAdvancedOption !== undefined) {
      throw new ValidationError(
        'employee-intake-advanced-option-unknown',
        `unknown employee intake advanced option: ${unknownAdvancedOption}`,
      )
    }
    for (const [optionRef, value] of Object.entries(parsedIntake.advanced.typeOptions)) {
      const definition = advancedOptionByRef.get(optionRef)!
      if (definition.control === 'repository-branch' && !validateRepositoryBranchOption(value)) {
        throw new ValidationError(
          'employee-intake-working-branch-invalid',
          `invalid repository branch for employee intake option: ${optionRef}`,
        )
      }
    }
    const intake = employeeWorkIntakeSchema.parse({
      ...parsedIntake,
      executionOptions,
      advanced: {
        ...parsedIntake.advanced,
        typeOptions: Object.fromEntries(
          advancedOptionDefinitions.flatMap((option) => {
            const value = parsedIntake.advanced.typeOptions[option.optionRef]
            return value === undefined ? [] : [[option.optionRef, value]]
          }),
        ),
      },
    })
    const { name: providedTaskName, advanced, ...workIntake } = intake
    if (input.actorUserId === null && advanced.collaboratorUserIds.length > 0) {
      throw new ValidationError(
        'employee-intake-collaborator-actor-required',
        'digital employee collaborators require a user-owned launch',
      )
    }
    if (input.eventOrigin === undefined && providedTaskName === undefined) {
      throw new ValidationError(
        'employee-task-name-required',
        'manual digital employee work requires a task name',
      )
    }
    const taskName =
      providedTaskName ??
      taskNameFromEventIntake({
        body: intake.body,
        externalId: intake.externalId,
        idempotencyKey: intake.idempotencyKey,
      })
    const exactBinding = (workItemRef: string, slotRef: string) =>
      revision.content.exactToolBindings.find(
        (binding) => binding.workItemRef === workItemRef && binding.slotRef === slotRef,
      )
    const intakeRequirement = admittedType.descriptor.workIntakeAuthoring.kindRequirements.find(
      (requirement) => requirement.kind === intake.kind,
    )
    if (intakeRequirement !== undefined) {
      const binding = exactBinding(intakeRequirement.workItemRef, intakeRequirement.slotRef)
      const tool = binding === undefined ? null : await this.#toolRevision(binding.registrationRef)
      if (tool === null || tool.state !== 'published') {
        throw new ValidationError(
          'employee-intake-kind-unsupported',
          `this employee cannot accept ${intake.kind} until ${intakeRequirement.workItemRef}/${intakeRequirement.slotRef} has a published tool`,
        )
      }
    }
    for (const option of optionDefinitions) {
      if (!executionOptions[option.optionRef] || option.requiredWorkItemRef === null) continue
      const binding = exactBinding(option.requiredWorkItemRef, option.requiredSlotRef!)
      const tool = binding === undefined ? null : await this.#toolRevision(binding.registrationRef)
      if (
        tool === null ||
        tool.state !== 'published' ||
        (option.requiredExecutorKind !== null &&
          tool.content.implementation.kind !== option.requiredExecutorKind)
      ) {
        throw new ValidationError(
          'employee-intake-option-incompatible',
          `${option.optionRef} requires a published ${option.requiredExecutorKind ?? 'compatible'} tool at ${option.requiredWorkItemRef}/${option.requiredSlotRef}`,
        )
      }
    }
    const caseId = this.#id()
    const now = this.#now()
    const uploads = await this.#inputUploads.resolveForCase({
      ids: intake.uploads.map((upload) => upload.uploadRef),
      actorUserId: input.actorUserId,
      caseId,
      now,
    })
    const platformCaseKey = stableIdentityComponent(caseId)
    const resolvedUploads = intake.uploads.map((upload, index) => {
      const row = uploads[index]!
      if (!this.#inputArtifacts.hasBlob(row.blobRef)) {
        throw new ValidationError(
          'employee-upload-artifact-missing',
          `input upload artifact is missing: ${row.id}`,
        )
      }
      return {
        uploadRef: row.id,
        blobRef: row.blobRef,
        sha256: row.sha256,
        bytes: row.bytes,
        originalName: row.originalName,
        placement: upload.placement,
        targetPath:
          upload.placement === 'repository'
            ? upload.targetPath!
            : `${PLATFORM_WORKSPACE_DIR}/inputs/requirements/${platformCaseKey}/uploads/${String(index + 1).padStart(3, '0')}-${stableIdentityComponent(row.id)}`,
      }
    })
    const launch = employeeCaseLaunchSchema.parse(
      JSON.parse(
        this.#codec(revision.content.typeRef.typeId).buildInitialCaseJson(
          JSON.stringify({
            schemaVersion: 1,
            caseRef: caseId,
            employeeRef,
            workScopeJson: JSON.stringify(scope.encodedScope),
            receivedAt: now,
            intake: {
              ...workIntake,
              uploads: resolvedUploads,
              typeOptions: advanced.typeOptions,
            },
          }),
        ),
      ) as unknown,
    )
    if (!sameRef(launch.employeeRef, employeeRef)) {
      throw new ValidationError(
        'employee-initial-case-contract-invalid',
        'employee type codec changed the admitted employee revision',
      )
    }
    return await this.launchCase(launch, {
      caseId,
      now,
      taskName,
      ownerUserId: input.actorUserId,
      launchOrigin: input.eventOrigin === undefined ? 'manual' : 'event',
      eventOrigin: input.eventOrigin ?? null,
      maxDurationMs: advanced.maxDurationMs ?? null,
      maxTotalTokens: advanced.maxTotalTokens ?? null,
      initialMembers:
        input.actorUserId === null
          ? []
          : [...new Set(advanced.collaboratorUserIds)]
              .filter((userId) => userId !== input.actorUserId)
              .map((userId) => ({
                userId,
                role: 'collaborator' as const,
                addedBy: input.actorUserId!,
                addedAt: now,
              })),
      uploadClaims: uploads.map((upload) => ({
        uploadRef: upload.id,
        actorUserId: input.actorUserId,
        sha256: upload.sha256,
        blobRef: upload.blobRef,
      })),
    })
  }

  async launchCase(
    input: unknown,
    admission?: {
      readonly caseId: string
      readonly now: number
      readonly taskName?: string
      readonly ownerUserId: string | null
      readonly launchOrigin: TaskLaunchOrigin
      readonly eventOrigin: {
        readonly eventSubscriptionId: string
        readonly eventDeliveryId: string
      } | null
      readonly maxDurationMs?: number | null
      readonly maxTotalTokens?: number | null
      readonly initialMembers?: readonly {
        readonly userId: string
        readonly role: 'collaborator'
        readonly addedBy: string
        readonly addedAt: number
      }[]
      readonly uploadClaims: readonly {
        readonly uploadRef: string
        readonly actorUserId: string | null
        readonly sha256: string
        readonly blobRef: string
      }[]
    },
  ): Promise<EmployeeCaseRecord> {
    const launch = employeeCaseLaunchSchema.parse(input)
    const employee = await this.#authoringStore.getEmployeeDefinitionRevision(launch.employeeRef)
    if (employee === null) {
      throw new ValidationError(
        'employee-definition-unavailable',
        'the exact employee revision is missing',
      )
    }
    this.#assertCurrentLaunchType(employee.content.typeRef)
    const typePackage = await this.#authoringStore.getTypePackage(employee.content.typeRef)
    if (typePackage === null || typePackage.state !== 'published') {
      throw new ValidationError(
        'employee-type-unavailable',
        'the exact employee type is unavailable',
      )
    }
    const contextType = typePackage.descriptor.contextTypes.find(
      (candidate) => candidate.typeId === launch.primaryContextTypeId,
    )
    if (
      contextType === undefined ||
      contextType.schemaVersion !== launch.primaryContextSchemaVersion
    ) {
      throw new ValidationError(
        'employee-context-contract-invalid',
        'the primary context type or schema version is not registered by this employee type',
      )
    }
    const workStartItem = findWorkItem(
      typePackage.descriptor,
      typePackage.descriptor.workStartWorkItemRef,
    )
    if (workStartItem === null) {
      throw new ValidationError(
        'employee-work-start-invalid',
        'the employee type does not expose a valid deterministic first work item',
      )
    }
    if (
      (await this.#store.findCaseByExternalSubject(
        launch.workSubject.typeId,
        launch.workSubject.subjectRef,
      )) !== null
    ) {
      throw new ConflictError(
        'employee-case-subject-conflict',
        'this external work subject is already handled by a digital employee case',
      )
    }
    const codec = this.#codec(employee.content.typeRef.typeId)
    const contextJson = codec.validateContextJson(
      launch.primaryContextTypeId,
      launch.primaryContextJson,
    )
    const policy = await this.#resolveExecutionPolicy()

    const now = admission?.now ?? this.#now()
    const caseId = admission?.caseId ?? this.#id()
    const contextId = this.#id()
    const caseRecord: EmployeeCaseRecord = {
      id: caseId,
      name: boundedCaseTaskName(admission?.taskName ?? launch.workSubject.subjectRef, caseId),
      employeeRef: launch.employeeRef,
      typeRef: employee.content.typeRef,
      primaryContextId: contextId,
      executionPolicyRevision: policy.revision,
      maxDurationMs: admission?.maxDurationMs ?? null,
      consumedDurationMs: 0,
      maxTotalTokens: admission?.maxTotalTokens ?? null,
      consumedTotalTokens: 0,
      ownerUserId: admission?.ownerUserId ?? null,
      launchOrigin: admission?.launchOrigin ?? 'api',
      state: 'active',
      terminalKind: null,
      blockReason: null,
      currentWorkItemRef: workStartItem.workItemRef,
      activeRoundId: null,
      revision: 1,
      writerGeneration: 1,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
    }
    const context: EmployeeContextRecord = {
      id: contextId,
      caseId,
      typeId: launch.primaryContextTypeId,
      schemaVersion: launch.primaryContextSchemaVersion,
      revision: 1,
      lifecycleState: launch.primaryContextState,
      stateJson: contextJson,
      artifactRefs: launch.artifactRefs,
      createdAt: now,
      updatedAt: now,
    }
    await this.#store.createCase({
      caseRecord,
      primaryContext: context,
      contextDigest: runtimeDigest({
        stateJson: context.stateJson,
        artifactRefs: context.artifactRefs,
      }),
      externalSubject: launch.workSubject,
      eventOrigin: admission?.eventOrigin ?? null,
      uploadClaims: admission?.uploadClaims ?? [],
      initialMembers: admission?.initialMembers ?? [],
    })
    return caseRecord
  }

  async getCase(caseId: string): Promise<EmployeeCaseRecord> {
    const record = await this.#store.getCase(caseId)
    if (record === null) {
      throw new NotFoundError('employee-case-not-found', `employee case not found: ${caseId}`)
    }
    return record
  }

  /**
   * RFC-330 —— 案例归属的窄查询：transport 层据此做可见性 / 操作判据（与任务成员制
   * 同形）。不存在返回 null，让调用方给出与「不可见」同形的 404。
   */
  async getCaseAcl(caseId: string): Promise<{
    readonly id: string
    readonly ownerUserId: string | null
    readonly employeeId: string
  } | null> {
    const record = await this.#store.getCase(caseId)
    return record === null
      ? null
      : { id: record.id, ownerUserId: record.ownerUserId, employeeId: record.employeeRef.id }
  }

  async listCaseMembers(caseId: string) {
    await this.getCase(caseId)
    return await this.#store.listCaseMembers(caseId)
  }

  async getCaseMemberRole(caseId: string, userId: string) {
    return await this.#store.getCaseMemberRole(caseId, userId)
  }

  async replaceCaseMembers(input: Parameters<RuntimeCasePersistence['replaceCaseMembers']>[0]) {
    return await this.#store.replaceCaseMembers(input)
  }

  async listCases(employeeId?: string, state?: string): Promise<EmployeeCaseRecord[]> {
    if (state !== undefined && !['active', 'waiting', 'blocked', 'terminal'].includes(state)) {
      throw new ValidationError('employee-case-state-invalid', `invalid case state: ${state}`)
    }
    return await this.#store.listCases(employeeId, state)
  }

  async listTerminalOutcomeGroups() {
    return await this.#store.listTerminalOutcomeGroups()
  }

  async listCasePage(input: {
    readonly employeeId?: string
    readonly ownerUserId?: string
    readonly membership?: { readonly actorUserId: string; readonly scope: 'mine' | 'shared' }
    readonly launchOrigin?: TaskLaunchOrigin
    readonly states?: readonly EmployeeCaseRecord['state'][]
    readonly terminalCatalogStatuses?: readonly ('done' | 'canceled')[]
    readonly view?: 'all' | 'active' | 'attention' | 'finished'
    readonly q?: string
    readonly cursor?: string
    readonly limit?: number
  }) {
    const limit = Math.min(100, Math.max(1, input.limit ?? 50))
    let cursor: { updatedAt: number; id: string } | null = null
    if (input.cursor !== undefined) {
      try {
        cursor = z
          .object({ updatedAt: z.number().int().nonnegative(), id: z.string().min(1) })
          .strict()
          .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as unknown)
      } catch {
        throw new ValidationError('employee-case-cursor-invalid', 'invalid case list cursor')
      }
    }
    const page = await this.#store.listCasesPage({
      ...(input.employeeId === undefined ? {} : { employeeId: input.employeeId }),
      ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
      ...(input.membership === undefined ? {} : { membership: input.membership }),
      ...(input.launchOrigin === undefined ? {} : { launchOrigin: input.launchOrigin }),
      ...(input.states === undefined ? {} : { states: input.states }),
      ...(input.terminalCatalogStatuses === undefined
        ? {}
        : { terminalCatalogStatuses: input.terminalCatalogStatuses }),
      view: input.view ?? 'all',
      ...(input.q === undefined || input.q.trim() === ''
        ? {}
        : { q: input.q.trim().slice(0, 100) }),
      cursor,
      limit,
    })
    const items = await Promise.all(
      page.cases.map(async (caseRecord) => {
        const descriptor = await this.#descriptor(caseRecord)
        const employee = await this.#authoringStore.getEmployeeDefinitionRevision(
          caseRecord.employeeRef,
        )
        const primary = (await this.#store.listContexts(caseRecord.id)).find(
          (context) => context.id === caseRecord.primaryContextId,
        )
        const primaryState =
          primary === undefined ? null : (JSON.parse(primary.stateJson) as Record<string, unknown>)
        const currentItem =
          caseRecord.currentWorkItemRef === null
            ? null
            : findWorkItem(descriptor, caseRecord.currentWorkItemRef)
        const activeRound = (await this.#store.listRounds(caseRecord.id)).find((round) =>
          ['planned', 'running', 'settling'].includes(round.state),
        )
        const subjectRef =
          typeof primaryState?.subjectRef === 'string'
            ? primaryState.subjectRef
            : typeof primaryState?.title === 'string'
              ? primaryState.title
              : caseRecord.id
        const targetRef =
          typeof primaryState?.repositoryRef === 'string'
            ? primaryState.repositoryRef
            : typeof primaryState?.projectRef === 'string'
              ? primaryState.projectRef
              : null
        return {
          id: caseRecord.id,
          revision: caseRecord.revision,
          state: caseRecord.state,
          terminalKind: caseRecord.terminalKind,
          blockReason: caseRecord.blockReason,
          employeeRef: caseRecord.employeeRef,
          employeeName: employee?.content.displayName ?? caseRecord.employeeRef.id,
          typeRef: caseRecord.typeRef,
          typeName: descriptor.displayName,
          taskName: caseRecord.name,
          subjectRef,
          targetRef,
          currentWorkItemRef: caseRecord.currentWorkItemRef,
          currentWorkItemName: currentItem?.label ?? null,
          activeRound:
            activeRound === undefined
              ? null
              : {
                  id: activeRound.id,
                  state: activeRound.state,
                  workItemRef: activeRound.workItemRef,
                  attemptOrdinal: activeRound.attemptOrdinal,
                },
          pendingEventCount: (await this.#store.listInbox(caseRecord.id)).filter(
            (event) => event.state === 'pending',
          ).length,
          openChannelCount: (await this.#store.listChannels(caseRecord.id)).filter(
            (channel) => channel.parentCaseId === caseRecord.id && channel.state === 'open',
          ).length,
          createdAt: caseRecord.createdAt,
          updatedAt: caseRecord.updatedAt,
        }
      }),
    )
    const last = page.cases.at(-1)
    return {
      items,
      nextCursor:
        page.hasMore && last !== undefined
          ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString(
              'base64url',
            )
          : null,
      facets: page.facets,
    }
  }

  async findCaseByExternalSubject(subjectType: string, subjectRef: string) {
    return await this.#store.findCaseByExternalSubject(subjectType, subjectRef)
  }

  async project(caseId: string) {
    const caseRecord = await this.getCase(caseId)
    const descriptor = await this.#descriptor(caseRecord)
    const contexts = await this.#store.listContexts(caseId)
    const employee = await this.#authoringStore.getEmployeeDefinitionRevision(
      caseRecord.employeeRef,
    )
    if (employee === null) throw new Error('pinned employee definition disappeared')
    const primaryContext = contexts.find((context) => context.id === caseRecord.primaryContextId)
    const primaryContextState =
      primaryContext === undefined ? null : (JSON.parse(primaryContext.stateJson) as unknown)
    const activeWorkItemRefs =
      employee.content.enabledWorkItemRefs.length === 0
        ? descriptor.authoringManifest.workItems.map((item) => item.workItemRef)
        : employee.content.enabledWorkItemRefs
    const capabilityActivation = {
      displayName: employee.content.displayName,
      jobTemplateRef: employee.content.jobTemplateRef,
      activeWorkItemRefs,
      executionOptions: projectFrozenExecutionOptions({
        definitions: descriptor.workIntakeAuthoring.executionOptions,
        primaryContextState,
      }),
      exactAdapterBindings: employee.content.exactAdapterBindings,
      exactOrderedDispatchConfigurations: employee.content.exactOrderedDispatchConfigurations,
    }
    const attention = await this.#store.listAttention(caseId)
    const inbox = await this.#store.listInbox(caseId)
    const rounds = await this.#store.listRounds(caseId)
    const detail = await this.#projectCaseDetail(caseRecord, contexts, rounds)
    const activeRound = rounds.find((round) =>
      ['planned', 'running', 'settling'].includes(round.state),
    )
    const reviewGates = descriptor.authoringManifest.workItems.flatMap<{
      parentWorkItemRef: string
      optionRef: string
      state: 'not-reached' | 'skipped' | 'planning' | 'waiting' | 'approved' | 'failed'
      executionRef: string | null
    }>((item) => {
      if (item.humanReview === null) return []
      const round = [...rounds]
        .filter((candidate) => candidate.workItemRef === item.workItemRef)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .at(-1)
      if (round === undefined) {
        return [
          {
            parentWorkItemRef: item.workItemRef,
            optionRef: item.humanReview.optionRef,
            state: 'not-reached' as const,
            executionRef: null,
          },
        ]
      }
      let enabled = false
      try {
        const rawPlan = JSON.parse(round.planJson) as { inputEnvelopeJson?: unknown }
        if (typeof rawPlan.inputEnvelopeJson === 'string') {
          const envelope = JSON.parse(rawPlan.inputEnvelopeJson) as { humanReview?: unknown }
          enabled = envelope.humanReview !== null && envelope.humanReview !== undefined
        }
      } catch {
        enabled = false
      }
      if (!enabled) {
        return [
          {
            parentWorkItemRef: item.workItemRef,
            optionRef: item.humanReview.optionRef,
            state: 'skipped' as const,
            executionRef: round.executionRef,
          },
        ]
      }
      const taskState =
        round.executionRef === null
          ? null
          : (this.#execution.inspectHumanReview?.(round.executionRef) ?? null)
      const state =
        taskState ??
        (round.state === 'completed'
          ? 'approved'
          : round.state === 'failed' || round.state === 'obsolete'
            ? 'failed'
            : 'planning')
      return [
        {
          parentWorkItemRef: item.workItemRef,
          optionRef: item.humanReview.optionRef,
          state,
          executionRef: round.executionRef,
        },
      ]
    })
    const channels = await Promise.all(
      (await this.#store.listChannels(caseId))
        .filter((channel) => channel.parentCaseId === caseId)
        .map(async (channel) => {
          const invocation = (
            await this.#store.listInvocationsForRound(channel.correlationRef)
          ).find((candidate) => candidate.id === channel.invocationId)
          if (invocation === undefined) {
            throw new Error(`employee channel ${channel.id} lost its invocation projection`)
          }
          const completion = invocationCompletionSchema.parse(
            JSON.parse(invocation.completionContractRefJson) as unknown,
          )
          return {
            ...channel,
            targetEmployeeRef: invocation.targetEmployeeRef,
            invocationContractId: completion.contractId,
            results: (await this.#store.listChannelResults(channel.id)).map((result) => ({
              ...result,
              envelope: JSON.parse(result.envelopeJson) as unknown,
            })),
          }
        }),
    )
    return {
      case: caseRecord,
      employeeType: {
        displayName: descriptor.displayName,
        description: descriptor.description,
      },
      capabilityActivation,
      detail,
      contexts: contexts.map((context) => ({
        ...context,
        state: JSON.parse(context.stateJson) as unknown,
      })),
      attention: attention.map((binding) => {
        const eventType = descriptor.eventTypes.find(
          (event) =>
            event.eventTypeId === binding.eventTypeRef.id &&
            event.version === binding.eventTypeRef.revision,
        )
        return {
          ...binding,
          displayName: eventType?.displayName ?? null,
          description: eventType?.description ?? null,
        }
      }),
      inbox: inbox.map((item) => {
        const eventType = descriptor.eventTypes.find(
          (event) =>
            event.eventTypeId === item.eventTypeRef.id &&
            event.version === item.eventTypeRef.revision,
        )
        return {
          ...item,
          displayName: eventType?.displayName ?? null,
          description: eventType?.description ?? null,
        }
      }),
      activeRound,
      rounds,
      reviewGates,
      channels,
      nextAction: projectEmployeeCaseNextAction({
        caseState: caseRecord.state,
        activeRoundExists: activeRound !== undefined,
        hasPendingInbox: inbox.some((item) => item.state === 'pending'),
        reviewGates,
      }),
    }
  }

  #caseLimitTerminalKind(caseRecord: EmployeeCaseRecord): string | null {
    if (
      caseRecord.maxDurationMs !== null &&
      caseRecord.consumedDurationMs >= caseRecord.maxDurationMs
    ) {
      return 'case-duration-limit-exceeded'
    }
    if (
      caseRecord.maxTotalTokens !== null &&
      caseRecord.consumedTotalTokens >= caseRecord.maxTotalTokens
    ) {
      return 'case-token-limit-exceeded'
    }
    return null
  }

  async #recordReactionMetering(
    round: ReactionRoundRecord,
    metering: ReactionExecutionMetering,
  ): Promise<string | null> {
    if (
      !Number.isSafeInteger(metering.durationMs) ||
      metering.durationMs < 0 ||
      !Number.isSafeInteger(metering.totalTokens) ||
      metering.totalTokens < 0
    ) {
      throw new ValidationError(
        'employee-case-metering-invalid',
        'reaction execution metering must contain nonnegative safe integers',
      )
    }
    return this.#caseLimitTerminalKind(
      (
        await this.#store.recordMetering({
          sourceRef: metering.sourceRef,
          caseId: round.caseId,
          roundId: round.id,
          durationMs: metering.durationMs,
          totalTokens: metering.totalTokens,
          now: this.#now(),
        })
      ).caseRecord,
    )
  }

  async #settleCompletedRound(
    round: ReactionRoundRecord,
    validatedOutputJson: string,
    limitTerminalKind: string | null = null,
  ): Promise<void> {
    const caseRecord = await this.getCase(round.caseId)
    const descriptor = await this.#descriptor(caseRecord)
    const employee = await this.#authoringStore.getEmployeeDefinitionRevision(
      caseRecord.employeeRef,
    )
    if (employee === null) throw new Error('pinned employee definition disappeared')
    const eventCapabilityEnabled = (eventTypeId: string): boolean =>
      isEmployeeReactionEventEnabled({
        descriptor,
        enabledWorkItemRefs: employee.content.enabledWorkItemRefs,
        eventTypeId,
      })
    const item = findWorkItem(descriptor, round.workItemRef)
    if (item === null) throw new Error(`reaction work item disappeared: ${round.workItemRef}`)
    const plan = reactionExecutionPlanSchema.parse(JSON.parse(round.planJson) as unknown)
    const beforeContexts = await this.#store.listContexts(caseRecord.id)
    const resolvedSettlement = reactionSettlementSchema.parse(
      JSON.parse(
        this.#codec(caseRecord.typeRef.typeId).resolveReactionSettlementJson(
          JSON.stringify({
            schemaVersion: 1,
            employeeTypeRef: caseRecord.typeRef,
            workItemRef: round.workItemRef,
            toolSlotRef: plan.toolSlotRef,
            outputJson: validatedOutputJson,
            contextsJson: JSON.stringify(beforeContexts),
            inputEnvelopeJson: plan.inputEnvelopeJson,
            enabledWorkItemRefsJson: JSON.stringify(employee.content.enabledWorkItemRefs),
            allowedNextWorkItemRefs: item.nextWorkItemRefs,
          }),
        ),
      ) as unknown,
    )
    const settlement =
      limitTerminalKind === null
        ? resolvedSettlement
        : {
            ...resolvedSettlement,
            caseState: 'terminal' as const,
            terminalKind: limitTerminalKind,
            blockReason: null,
            nextWorkItemRef: null,
          }
    if (
      settlement.nextWorkItemRef !== null &&
      !item.nextWorkItemRefs.includes(settlement.nextWorkItemRef)
    ) {
      throw new ValidationError(
        'employee-continuation-invalid',
        `work item ${item.workItemRef} cannot continue to ${settlement.nextWorkItemRef}`,
      )
    }
    if (settlement.nextWorkItemRef !== null && settlement.caseState !== 'active') {
      throw new ValidationError(
        'employee-continuation-state-invalid',
        'a queued next work item requires an active case',
      )
    }
    const disallowedEffects = settlement.effectSuggestions.filter(
      (effect) => !plan.allowedEffectKinds.includes(effect),
    )
    if (disallowedEffects.length > 0) {
      throw new ValidationError(
        'employee-effect-outside-closure',
        `reaction suggested effects outside the frozen closure: ${disallowedEffects.join(', ')}`,
      )
    }

    const now = this.#now()
    const seenContextIds = new Set<string>()
    const seenContextTypes = new Set<string>()
    const contextMutations: Array<{
      context: EmployeeContextRecord
      expectedRevision: number | null
      contentDigest: string
      externalSubjects: Array<{ typeId: string; subjectRef: string }>
    }> = []
    const contextLinks: Array<{
      id: string
      fromContextId: string
      relation: 'delivers'
      toContextId: string
    }> = []
    for (const patch of settlement.contextPatches) {
      if (seenContextTypes.has(patch.contextTypeId)) {
        throw new ValidationError(
          'employee-context-patch-duplicate',
          `multiple patches target context type ${patch.contextTypeId}`,
        )
      }
      seenContextTypes.add(patch.contextTypeId)
      const byId =
        patch.contextId === null
          ? null
          : (beforeContexts.find((context) => context.id === patch.contextId) ?? null)
      const byType = beforeContexts.filter((context) => context.typeId === patch.contextTypeId)
      const existing = byId ?? (byType.length === 1 ? byType[0]! : null)
      if (patch.expectedRevision === null && existing !== null) {
        throw new ConflictError(
          'employee-context-create-conflict',
          `context type already exists: ${patch.contextTypeId}`,
        )
      }
      if (
        patch.expectedRevision !== null &&
        (existing === null || existing.revision !== patch.expectedRevision)
      ) {
        throw new ConflictError(
          'employee-context-revision-conflict',
          `expected ${patch.contextTypeId}@${patch.expectedRevision}, but the pinned context changed`,
        )
      }
      if (existing !== null && existing.typeId !== patch.contextTypeId) {
        throw new ValidationError(
          'employee-context-type-mismatch',
          `context ${existing.id} is not ${patch.contextTypeId}`,
        )
      }
      const contextId = existing?.id ?? patch.contextId ?? this.#id()
      if (seenContextIds.has(contextId)) {
        throw new ValidationError(
          'employee-context-patch-duplicate',
          `multiple patches target context ${contextId}`,
        )
      }
      seenContextIds.add(contextId)
      const stateJson = this.#codec(caseRecord.typeRef.typeId).validateContextJson(
        patch.contextTypeId,
        patch.stateJson,
      )
      const context: EmployeeContextRecord = {
        id: contextId,
        caseId: caseRecord.id,
        typeId: patch.contextTypeId,
        schemaVersion: patch.schemaVersion,
        revision: (existing?.revision ?? 0) + 1,
        lifecycleState: patch.lifecycleState,
        stateJson,
        artifactRefs: [...patch.artifactRefs],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      const codec = this.#codec(caseRecord.typeRef.typeId)
      const bindingSubjects = z
        .array(attentionSubjectSchema)
        .parse(
          JSON.parse(
            codec.resolveExternalSubjectBindingsJson?.(context.typeId, context.stateJson) ??
              codec.resolveAttentionSubjectsJson(context.typeId, context.stateJson),
          ) as unknown,
        )
        .filter((subject) => eventCapabilityEnabled(subject.eventTypeRef.id))
      const externalSubjects = [
        ...new Map(
          bindingSubjects.map((subject) => [
            `${subject.subject.typeId}\u0000${subject.subject.subjectRef}`,
            subject.subject,
          ]),
        ).values(),
      ]
      contextMutations.push({
        context,
        expectedRevision: existing?.revision ?? null,
        contentDigest: runtimeDigest({
          stateJson: context.stateJson,
          artifactRefs: context.artifactRefs,
        }),
        externalSubjects,
      })
      if (existing === null && context.id !== caseRecord.primaryContextId) {
        contextLinks.push({
          id: this.#id(),
          fromContextId: caseRecord.primaryContextId,
          relation: 'delivers',
          toContextId: context.id,
        })
      }
    }

    const contextsAfter = beforeContexts.map(
      (context) =>
        contextMutations.find((mutation) => mutation.context.id === context.id)?.context ?? context,
    )
    for (const mutation of contextMutations) {
      if (!contextsAfter.some((context) => context.id === mutation.context.id)) {
        contextsAfter.push(mutation.context)
      }
    }
    const existingAttention = await this.#store.listAttention(caseRecord.id)
    const cancelAll = settlement.caseState === 'terminal'
    const desiredIdentities = new Set<string>()
    const attentionUpserts: Array<{
      binding: AttentionBindingRecord
      subscribeOutbox: EmployeeOutboxRecord | null
    }> = []
    // Terminal is an absorbing state for Attention. Re-evaluating desired
    // subjects here can otherwise supersede an already queued unsubscribe and
    // leave a terminal Case subscribed forever.
    for (const context of cancelAll ? [] : contextsAfter) {
      const desired = z
        .array(attentionSubjectSchema)
        .parse(
          JSON.parse(
            this.#codec(caseRecord.typeRef.typeId).resolveAttentionSubjectsJson(
              context.typeId,
              context.stateJson,
            ),
          ) as unknown,
        )
        .filter((subject) => eventCapabilityEnabled(subject.eventTypeRef.id))
      for (const subject of desired) {
        const eventType = descriptor.eventTypes.find(
          (candidate) =>
            candidate.eventTypeId === subject.eventTypeRef.id &&
            candidate.version === subject.eventTypeRef.revision,
        )
        if (eventType === undefined || eventType.subjectTypeId !== subject.subject.typeId) {
          throw new ValidationError(
            'employee-attention-contract-invalid',
            `attention subject does not match event ${subject.eventTypeRef.id}`,
          )
        }
        const desiredIdentityKey = `attention:${runtimeDigest({
          caseId: caseRecord.id,
          contextId: context.id,
          eventTypeRef: subject.eventTypeRef,
          subject: subject.subject,
        })}`
        desiredIdentities.add(desiredIdentityKey)
        const current = existingAttention.find(
          (binding) => binding.desiredIdentityKey === desiredIdentityKey,
        )
        if (current !== undefined) {
          if (!['cancel-requested', 'cancelled'].includes(current.state)) {
            attentionUpserts.push({
              binding: { ...current, contextRevision: context.revision, updatedAt: now },
              subscribeOutbox: null,
            })
            continue
          }
          // desired_identity_key is the durable identity of an Attention, not
          // only of its currently active subscription. A context may become
          // relevant again after the prior subscription was cancelled (for
          // example failed pipeline -> child work -> pending pipeline). Reuse
          // that row and request a fresh subscription; inserting a new id would
          // violate the identity index and leave the outbox retrying forever.
          const binding: AttentionBindingRecord = {
            ...current,
            contextRevision: context.revision,
            // A pending unsubscribe is only an intent, not proof that the
            // Event Center subscription has gone away. Keep its identity while
            // reactivation supersedes that intent so a second cancellation can
            // still clean it up if the new subscribe has not run yet.
            eventSubscriptionId:
              current.state === 'cancel-requested' ? current.eventSubscriptionId : null,
            state: 'desired',
            updatedAt: now,
          }
          const payload = {
            bindingId: binding.id,
            contextRevision: context.revision,
            eventTypeRef: subject.eventTypeRef,
            subject: subject.subject,
            caseId: caseRecord.id,
            replayLatest: false,
          }
          attentionUpserts.push({
            binding,
            subscribeOutbox: {
              id: this.#id(),
              caseId: caseRecord.id,
              kind: 'event-subscribe',
              payloadJson: JSON.stringify(payload),
              dedupeKey: `event-subscribe:${runtimeDigest(payload)}`,
              attemptCount: 0,
            },
          })
          continue
        }
        const bindingId = this.#id()
        const binding: AttentionBindingRecord = {
          id: bindingId,
          caseId: caseRecord.id,
          contextId: context.id,
          contextRevision: context.revision,
          eventTypeRef: subject.eventTypeRef,
          subject: subject.subject,
          desiredIdentityKey,
          eventSubscriptionId: null,
          state: 'desired',
          createdAt: now,
          updatedAt: now,
        }
        const payload = {
          bindingId,
          contextRevision: context.revision,
          eventTypeRef: subject.eventTypeRef,
          subject: subject.subject,
          caseId: caseRecord.id,
          replayLatest: true,
        }
        attentionUpserts.push({
          binding,
          subscribeOutbox: {
            id: this.#id(),
            caseId: caseRecord.id,
            kind: 'event-subscribe',
            payloadJson: JSON.stringify(payload),
            dedupeKey: `event-subscribe:${runtimeDigest(payload)}`,
            attemptCount: 0,
          },
        })
      }
    }
    const attentionCancellations = existingAttention
      .filter(
        (binding) =>
          !['cancel-requested', 'cancelled'].includes(binding.state) &&
          (cancelAll || !desiredIdentities.has(binding.desiredIdentityKey)),
      )
      .map((binding) => ({
        bindingId: binding.id,
        unsubscribeOutbox:
          binding.eventSubscriptionId === null
            ? null
            : {
                id: this.#id(),
                caseId: caseRecord.id,
                kind: 'event-unsubscribe' as const,
                payloadJson: JSON.stringify({
                  bindingId: binding.id,
                  subscriptionId: binding.eventSubscriptionId,
                }),
                dedupeKey: `event-unsubscribe:${binding.id}:${binding.contextRevision}`,
                attemptCount: 0,
              },
      }))

    await this.#store.settleRound({
      roundId: round.id,
      state: 'completed',
      outputJson: validatedOutputJson,
      nextWorkItemRef: settlement.nextWorkItemRef,
      nextCaseState: settlement.caseState,
      terminalKind: settlement.terminalKind,
      blockReason: settlement.blockReason,
      contextMutations,
      contextLinks,
      attentionUpserts,
      attentionCancellations,
      now,
    })
  }

  async #validateRoundOutput(round: ReactionRoundRecord, outputJson: string): Promise<string> {
    const plan = reactionExecutionPlanSchema.parse(JSON.parse(round.planJson) as unknown)
    const caseRecord = await this.getCase(round.caseId)
    const platformValidatedOutput = await this.#executionContracts.validateEnvelope({
      direction: 'output',
      contractRef: plan.workContractRef,
      roundRef: round.id,
      executionNonce: plan.executionNonce,
      envelopeJson: outputJson,
    })
    const identity = z
      .object({
        schemaVersion: z.literal(1),
        roundRef: z.string().min(1),
        executionNonce: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .passthrough()
      .parse(JSON.parse(platformValidatedOutput) as unknown)
    if (identity.roundRef !== round.id || identity.executionNonce !== plan.executionNonce) {
      throw new ValidationError(
        'employee-output-envelope-identity-mismatch',
        'output envelope does not belong to the frozen reaction round',
      )
    }
    return this.#codec(caseRecord.typeRef.typeId).validateReactionOutputJson(
      JSON.stringify({
        schemaVersion: 1,
        employeeTypeRef: caseRecord.typeRef,
        workItemRef: round.workItemRef,
        toolSlotRef: plan.toolSlotRef,
        connectionRef: plan.connectionRef,
        inputEnvelopeJson: plan.inputEnvelopeJson,
        outputJson: platformValidatedOutput,
      }),
    )
  }

  #invocationEvent(plan: ReactionExecutionPlan): {
    readonly subject: { readonly typeId: string; readonly subjectRef: string }
  } | null {
    const envelope = z
      .object({ eventJson: z.string().min(2) })
      .passthrough()
      .parse(JSON.parse(plan.inputEnvelopeJson) as unknown)
    const event = z
      .object({
        subject: z.object({ typeId: z.string().min(1), subjectRef: z.string().min(1) }).strict(),
      })
      .passthrough()
      .safeParse(JSON.parse(envelope.eventJson) as unknown)
    return event.success ? event.data : null
  }

  async #assertCollaborationAllowed(
    parentCase: EmployeeCaseRecord,
    targetEmployeeId: string,
  ): Promise<void> {
    const outbound = (await this.#store.listChannels(parentCase.id)).filter(
      (channel) => channel.parentCaseId === parentCase.id,
    )
    const ancestry: Array<{ caseId: string; employeeId: string }> = []
    const visited = new Set<string>()
    let cursor: EmployeeCaseRecord | null = parentCase
    while (cursor !== null) {
      if (visited.has(cursor.id)) {
        throw new ValidationError(
          'employee-collaboration-ancestry-invalid',
          'employee invocation ancestry contains a case cycle',
        )
      }
      visited.add(cursor.id)
      ancestry.push({ caseId: cursor.id, employeeId: cursor.employeeRef.id })
      if (ancestry.length >= MAX_EMPLOYEE_INVOCATION_DEPTH) break
      const cursorId = cursor.id
      const inbound = (await this.#store.listChannels(cursorId)).find(
        (channel) => channel.childCaseId === cursorId,
      )
      if (inbound === undefined) break
      cursor = await this.#store.getCase(inbound.parentCaseId)
      if (cursor === null) {
        throw new ValidationError(
          'employee-collaboration-ancestry-invalid',
          'employee invocation ancestry points to a missing parent case',
        )
      }
    }
    const guard = evaluateEmployeeInvocationGuard({
      ancestry,
      targetEmployeeId,
      outboundInvocationCount: outbound.length,
    })
    if (!guard.ok) throw new ValidationError(guard.code, guard.detail)
  }

  async #resolveCompatibleSuccessorBindings(
    _parentCase: EmployeeCaseRecord,
    frozenBindings: readonly EmployeeCollaborationBinding[],
  ): Promise<EmployeeCollaborationBinding[]> {
    // The frozen parent binding remains the authority for an in-flight Case.
    // Its employee may be unable to upgrade because of an unrelated tool or
    // scope contract, while the stable target employee has a proven automatic
    // successor. Requiring a current parent revision here deadlocks that
    // historical invocation even though only the target must start new work.
    return await Promise.all(
      frozenBindings.map(async (binding) => {
        const frozenTarget = await this.#authoringStore.getEmployeeDefinitionRevision(
          binding.targetEmployeeRef,
        )
        if (frozenTarget === null) return binding
        const currentTargetTypeRevision = this.#currentTypeRevisions.get(
          frozenTarget.content.typeRef.typeId,
        )
        if (
          currentTargetTypeRevision === undefined ||
          frozenTarget.content.typeRef.revision > currentTargetTypeRevision
        ) {
          return binding
        }
        const currentTarget = await this.#authoringStore.getEmployeeDefinition(
          binding.targetEmployeeRef.id,
        )
        if (
          currentTarget === null ||
          currentTarget.archivedAt !== null ||
          currentTarget.currentRevision === null ||
          currentTarget.currentRevision <= binding.targetEmployeeRef.revision
        ) {
          return binding
        }
        const successorRef = {
          id: currentTarget.id,
          revision: currentTarget.currentRevision,
        }
        const compatibleTarget =
          await this.#authoringStore.getEmployeeDefinitionRevision(successorRef)
        if (
          compatibleTarget === null ||
          compatibleTarget.createdBy !== null ||
          compatibleTarget.content.typeRef.typeId !== frozenTarget.content.typeRef.typeId ||
          compatibleTarget.content.typeRef.revision !== currentTargetTypeRevision
        ) {
          return binding
        }
        return employeeCollaborationBindingSchema.parse({
          ...binding,
          targetEmployeeRef: successorRef,
        })
      }),
    )
  }

  async #resolveCompatibleInvocationBindings(
    parentCase: EmployeeCaseRecord,
    round: ReactionRoundRecord,
    frozenBindings: readonly EmployeeCollaborationBinding[],
  ): Promise<EmployeeCollaborationBinding[]> {
    const compatibleBindings = await this.#resolveCompatibleSuccessorBindings(
      parentCase,
      frozenBindings,
    )
    const durableInvocations = await this.#store.listInvocationsForRound(round.id)
    return frozenBindings.map((binding, index) => {
      const invocation = durableInvocations.find(
        (candidate) => candidate.id === `invocation:${round.id}:${binding.memberRef}`,
      )
      return invocation === undefined
        ? compatibleBindings[index]!
        : employeeCollaborationBindingSchema.parse({
            ...binding,
            targetEmployeeRef: invocation.targetEmployeeRef,
          })
    })
  }

  async #automaticallyResumeCompatibleInvocationUpgrade(
    caseRecord: EmployeeCaseRecord,
  ): Promise<boolean> {
    if (
      caseRecord.state !== 'blocked' ||
      caseRecord.activeRoundId !== null ||
      caseRecord.currentWorkItemRef === null
    ) {
      return false
    }
    const failedRound = (await this.#store.listRounds(caseRecord.id)).find(
      (round) => round.state === 'failed' && round.workItemRef === caseRecord.currentWorkItemRef,
    )
    if (failedRound === undefined || failedRound.outputJson === null) return false
    const failure = z
      .object({
        kind: z.literal('platform-dispatch-failed'),
        outboxKind: z.literal('invocation-create'),
        errorCode: z.string().min(1).optional(),
        detail: z.string().optional(),
      })
      .passthrough()
      .safeParse(parseJsonOrUndefined(failedRound.outputJson))
    if (!failure.success) return false
    const legacyUpgradeFailure =
      failure.data.errorCode === undefined &&
      failure.data.detail?.includes('cannot start new work; upgrade it to') === true
    if (failure.data.errorCode !== 'employee-upgrade-required' && !legacyUpgradeFailure) {
      return false
    }
    const plan = reactionExecutionPlanSchema.safeParse(parseJsonOrUndefined(failedRound.planJson))
    if (
      !plan.success ||
      plan.data.implementationKind !== 'collaboration' ||
      plan.data.implementationJson === null
    ) {
      return false
    }
    const bindings = z
      .array(employeeCollaborationBindingSchema)
      .min(1)
      .safeParse(parseJsonOrUndefined(plan.data.implementationJson))
    if (!bindings.success) return false
    const invocations = await this.#store.listInvocationsForRound(failedRound.id)
    let invalidInvocation = invocations.length === 0
    for (const invocation of invocations) {
      if (
        invocation.state !== 'requested' ||
        invocation.childCaseId !== null ||
        (await this.#store.getChannelByInvocation(invocation.id)) !== null
      ) {
        invalidInvocation = true
        break
      }
    }
    if (invalidInvocation) {
      return false
    }
    const compatible = await this.#resolveCompatibleSuccessorBindings(caseRecord, bindings.data)
    const changed = bindings.data.some(
      (binding, index) => !sameRef(binding.targetEmployeeRef, compatible[index]!.targetEmployeeRef),
    )
    if (!changed) return false
    await this.#store.resumeCase(caseRecord.id, this.#now())
    return true
  }

  async #automaticallyResumeRecoveredToolBinding(caseRecord: EmployeeCaseRecord): Promise<boolean> {
    const prefix =
      'reaction-planning-failed: employee-tool-binding-unavailable: no exact published tool for '
    if (
      caseRecord.state !== 'blocked' ||
      caseRecord.activeRoundId !== null ||
      caseRecord.currentWorkItemRef === null ||
      caseRecord.blockReason?.startsWith(prefix) !== true
    ) {
      return false
    }
    const identity = caseRecord.blockReason.slice(prefix.length)
    // This is a domain identity (`workItemRef/slotRef`), not a filesystem
    // path. Split the contract delimiter explicitly so the recovery logic does
    // not encode a POSIX-only dirname operation.
    const identityParts = identity.split('/')
    const slotRef = identityParts.pop()
    const workItemRef = identityParts.join('/')
    if (workItemRef.length === 0 || slotRef === undefined || slotRef.length === 0) return false
    if (workItemRef !== caseRecord.currentWorkItemRef) return false
    const employee = await this.#authoringStore.getEmployeeDefinitionRevision(
      caseRecord.employeeRef,
    )
    if (employee === null) return false
    const typePackage = await this.#authoringStore.getTypePackage(caseRecord.typeRef)
    if (typePackage === null || typePackage.state !== 'published') return false
    const item = findWorkItem(typePackage.descriptor, workItemRef)
    if (item === null || item.nodeKind !== 'business-tool') return false
    let selectedSlotRef: string
    try {
      selectedSlotRef = this.#selectWorkItemSlot({
        caseRecord,
        item,
        contexts: await this.#store.listContexts(caseRecord.id),
        orderedDispatchConfigurations: employee.content.exactOrderedDispatchConfigurations,
        preferredSlotRef: undefined,
      })
    } catch {
      return false
    }
    const dispatchBinding = employee.content.exactOrderedDispatchConfigurations
      .flatMap((configuration) => configuration.routes)
      .find(
        (route) =>
          route.routeRef === selectedSlotRef && route.destinationWorkItemRef === workItemRef,
      )
    const toolBinding = employee.content.exactToolBindings.find(
      (binding) => binding.workItemRef === workItemRef && binding.slotRef === selectedSlotRef,
    )
    if (
      selectedSlotRef !== PLATFORM_WORK_ITEM_SLOT_REF &&
      findToolSlot(item, selectedSlotRef) === null &&
      dispatchBinding === undefined
    ) {
      return false
    }
    const registrationRef = dispatchBinding?.registrationRef ?? toolBinding?.registrationRef ?? null
    if (
      selectedSlotRef !== PLATFORM_WORK_ITEM_SLOT_REF &&
      (registrationRef === null ||
        (await this.#toolRevision(registrationRef))?.state !== 'published')
    ) {
      return false
    }
    for (const binding of employee.content.exactToolBindings) {
      if (
        binding.workItemRef === workItemRef &&
        (await this.#toolRevision(binding.registrationRef))?.state !== 'published'
      ) {
        return false
      }
    }
    await this.#store.resumeCase(caseRecord.id, this.#now())
    return true
  }

  async #executeInvocationRound(
    round: ReactionRoundRecord,
    plan: ReactionExecutionPlan,
  ): Promise<void> {
    if (plan.implementationJson === null) {
      throw new ValidationError(
        'employee-collaboration-plan-invalid',
        'collaboration plan has no exact target binding',
      )
    }
    const frozenBindings = z
      .array(employeeCollaborationBindingSchema)
      .min(1)
      .parse(JSON.parse(plan.implementationJson) as unknown)
    const parentCase = await this.getCase(round.caseId)
    const bindings = await this.#resolveCompatibleInvocationBindings(
      parentCase,
      round,
      frozenBindings,
    )
    const contexts = await this.#store.listContexts(round.caseId)
    const event = this.#invocationEvent(plan)
    if (event?.subject.typeId === 'employee-invocation') {
      const channel = await this.#store.getChannelByInvocation(event.subject.subjectRef)
      if (channel === null || channel.parentCaseId !== parentCase.id) {
        throw new ValidationError(
          'employee-channel-result-unmatched',
          'collaboration result does not belong to this parent case',
        )
      }
      const currentResult = (await this.#store.listChannelResults(channel.id)).at(-1)
      if (currentResult === undefined) {
        throw new ValidationError(
          'employee-channel-result-missing',
          'collaboration result event arrived before its durable result',
        )
      }
      const groupInvocations = await this.#store.listInvocationsForRound(channel.correlationRef)
      if (groupInvocations.length !== bindings.length) {
        throw new ValidationError(
          'employee-collaboration-group-incomplete',
          'the durable invocation group does not match its frozen collaboration plan',
        )
      }
      const members = await Promise.all(
        bindings.map(async (binding) => {
          const invocation = groupInvocations.find((candidate) =>
            sameRef(candidate.targetEmployeeRef, binding.targetEmployeeRef),
          )
          if (invocation === undefined) {
            throw new ValidationError(
              'employee-collaboration-member-unmatched',
              `no durable invocation exists for member ${binding.memberRef}`,
            )
          }
          const memberChannel = await this.#store.getChannelByInvocation(invocation.id)
          const result =
            memberChannel === null
              ? undefined
              : (await this.#store.listChannelResults(memberChannel.id)).at(-1)
          return {
            memberRef: binding.memberRef,
            invocationRef: invocation.id,
            targetEmployeeRef: binding.targetEmployeeRef,
            state:
              result === undefined
                ? invocation.state === 'detached'
                  ? ('detached' as const)
                  : ('waiting' as const)
                : result.envelopeJson.length > 0 &&
                    z
                      .object({ state: z.enum(['satisfied', 'failed']) })
                      .passthrough()
                      .parse(JSON.parse(result.envelopeJson) as unknown).state === 'satisfied'
                  ? ('satisfied' as const)
                  : ('failed' as const),
            resultEnvelopeJson: result?.envelopeJson ?? null,
          }
        }),
      )
      const satisfied = members.filter((member) => member.state === 'satisfied').length
      const failed = members.filter((member) => member.state === 'failed').length
      const joinMode = bindings[0]!.joinMode
      const quorum = joinMode === 'quorum' ? bindings[0]!.quorum! : null
      const currentResultSummary = z
        .object({ summary: z.string().min(1) })
        .passthrough()
        .parse(JSON.parse(currentResult.envelopeJson) as unknown).summary
      const joinState = evaluateEmployeeInvocationJoin({
        mode: joinMode,
        quorum,
        memberStates: members.map((member) => member.state),
      })
      if (joinState === 'satisfied' && joinMode !== 'all') {
        await this.#store.detachOpenChannelsForRound(channel.correlationRef, this.#now())
      }
      if (joinState !== 'waiting') {
        const memberInvocations = new Set(groupInvocations.map((invocation) => invocation.id))
        for (const sibling of await this.#store.listInbox(parentCase.id)) {
          if (
            sibling.state === 'pending' &&
            sibling.subject.typeId === 'employee-invocation' &&
            memberInvocations.has(sibling.subject.subjectRef)
          ) {
            await this.#store.markInbox(sibling.id, 'obsolete', this.#now())
          }
        }
      }
      const aggregate = {
        schemaVersion: 1 as const,
        groupRef: channel.correlationRef,
        joinMode,
        quorum,
        state: joinState,
        summary:
          members.length === 1
            ? currentResultSummary
            : joinState === 'satisfied'
              ? `协同汇合已满足（${satisfied}/${members.length}）`
              : joinState === 'failed'
                ? `协同汇合无法满足（${satisfied} 成功，${failed} 失败）`
                : `等待协同员工返回（${satisfied}/${members.length}）`,
        members,
        artifactRefs: [
          ...new Set(
            members.flatMap((member) => {
              if (member.resultEnvelopeJson === null) return []
              return z
                .object({ artifactRefs: z.array(z.string()).default([]) })
                .passthrough()
                .parse(JSON.parse(member.resultEnvelopeJson) as unknown).artifactRefs
            }),
          ),
        ],
      }
      const eventBinding = bindings.find((binding) =>
        sameRef(
          binding.targetEmployeeRef,
          groupInvocations.find((candidate) => candidate.id === channel.invocationId)!
            .targetEmployeeRef,
        ),
      )
      if (eventBinding === undefined) {
        throw new ValidationError(
          'employee-collaboration-member-unmatched',
          'the result event target is not in the frozen collaboration plan',
        )
      }
      const output = this.#codec(parentCase.typeRef.typeId).buildInvocationResultOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          roundRef: plan.roundRef,
          executionNonce: plan.executionNonce,
          invocationRef: channel.invocationId,
          targetEmployeeRef: eventBinding.targetEmployeeRef,
          contextsJson: JSON.stringify(contexts),
          resultEnvelopeJson: currentResult.envelopeJson,
          joinResultEnvelopeJson: JSON.stringify(aggregate),
        }),
      )
      await this.#settleCompletedRound(round, await this.#validateRoundOutput(round, output))
      return
    }
    const descriptor = await this.#descriptor(parentCase)
    const policy = await this.#authoringStore.getExecutionPolicyRevision(
      round.executionPolicyRevision,
    )
    if (policy === null) throw new Error('pinned execution policy disappeared')
    const now = this.#now()
    const invocations: Array<{
      memberRef: string
      invocationRef: string
      targetEmployeeRef: ExactResourceRef
    }> = []
    for (const binding of bindings) {
      const target = await this.#authoringStore.getEmployeeDefinitionRevision(
        binding.targetEmployeeRef,
      )
      if (target === null) {
        throw new ValidationError(
          'employee-collaboration-target-unavailable',
          `the frozen target employee is unavailable: ${binding.memberRef}`,
        )
      }
      const targetScope = await this.#authoringStore.getWorkScopeRevision(
        target.content.workScopeRef,
      )
      if (targetScope === null) {
        throw new ValidationError(
          'employee-collaboration-scope-unavailable',
          `the frozen target employee scope is unavailable: ${binding.memberRef}`,
        )
      }
      const contract = descriptor.invocationContracts.find(
        (candidate) => candidate.contractId === binding.invocationContractId,
      )
      if (contract === undefined) {
        throw new ValidationError(
          'employee-collaboration-contract-unavailable',
          `the frozen invocation contract is unavailable: ${binding.invocationContractId}`,
        )
      }
      const eventType = descriptor.eventTypes.find(
        (candidate) =>
          contract.milestoneEventTypeIds.includes(candidate.eventTypeId) &&
          candidate.subjectTypeId === 'employee-invocation',
      )
      if (eventType === undefined) {
        throw new ValidationError(
          'employee-collaboration-result-event-unavailable',
          'invocation contract has no employee-channel result event',
        )
      }
      const invocationId = `invocation:${round.id}:${binding.memberRef}`
      const existing = (await this.#store.listInvocationsForRound(round.id)).find(
        (candidate) => candidate.id === invocationId,
      )
      if (existing === undefined) {
        await this.#assertCollaborationAllowed(parentCase, binding.targetEmployeeRef.id)
      }
      const childCaseId = `employee-child:${runtimeDigest({ invocationId }).slice(0, 32)}`
      const completion = invocationCompletionSchema.parse({
        contractId: contract.contractId,
        resultSchemaId: contract.resultSchemaId,
        eventTypeRef: { id: eventType.eventTypeId, revision: eventType.version },
        sourceRef: eventType.sourceRef,
      })
      await this.#store.createInvocation({
        id: invocationId,
        idempotencyKey: `employee-invocation:${round.id}:${binding.memberRef}`,
        parentCaseId: parentCase.id,
        parentRoundId: round.id,
        targetEmployeeRef: binding.targetEmployeeRef,
        targetWorkScopeRefJson: JSON.stringify(target.content.workScopeRef),
        inputEnvelopeRef: `reaction-round:${round.id}`,
        inputDigest: runtimeDigest({ inputEnvelopeJson: plan.inputEnvelopeJson }),
        completionContractRefJson: JSON.stringify(completion),
        deadlineAt: now + policy.content.externalWaitDeadlineMs,
        childCaseId: null,
        state: 'requested',
        createdAt: now,
        updatedAt: now,
      })
      if ((await this.#store.getCase(childCaseId)) === null) {
        const launch = employeeCaseLaunchSchema.parse(
          JSON.parse(
            this.#codec(target.content.typeRef.typeId).buildInvokedCaseJson(
              JSON.stringify({
                schemaVersion: 1,
                invocationRef: invocationId,
                parentCaseRef: { id: parentCase.id, revision: parentCase.revision },
                targetEmployeeRef: binding.targetEmployeeRef,
                targetWorkScopeJson: JSON.stringify(targetScope.encodedScope),
                inputEnvelopeJson: plan.inputEnvelopeJson,
                receivedAt: now,
              }),
            ),
          ) as unknown,
        )
        if (!sameRef(launch.employeeRef, binding.targetEmployeeRef)) {
          throw new ValidationError(
            'employee-invoked-case-contract-invalid',
            'target type codec changed the frozen target employee revision',
          )
        }
        await this.launchCase(launch, {
          caseId: childCaseId,
          now,
          taskName: boundedCaseTaskName(
            `${parentCase.name} · ${target.content.displayName}`,
            childCaseId,
          ),
          ownerUserId: parentCase.ownerUserId,
          launchOrigin: 'api',
          eventOrigin: null,
          uploadClaims: [],
        })
      }
      await this.#store.acceptInvocation({
        invocationId,
        childCaseId,
        channel: {
          id: `channel:${runtimeDigest({ invocationId }).slice(0, 32)}`,
          invocationId,
          parentCaseId: parentCase.id,
          childCaseId,
          correlationRef: round.id,
          resultContractRefJson: JSON.stringify(completion),
          state: 'open',
          createdAt: now,
          updatedAt: now,
        },
        now,
      })
      invocations.push({
        memberRef: binding.memberRef,
        invocationRef: invocationId,
        targetEmployeeRef: binding.targetEmployeeRef,
      })
    }
    const output = this.#codec(parentCase.typeRef.typeId).buildInvocationStartedOutputJson(
      JSON.stringify({
        schemaVersion: 1,
        roundRef: plan.roundRef,
        executionNonce: plan.executionNonce,
        invocationRef: invocations[0]!.invocationRef,
        targetEmployeeRef: invocations[0]!.targetEmployeeRef,
        invocations,
        joinMode: bindings[0]!.joinMode,
        quorum: bindings[0]!.quorum,
        contextsJson: JSON.stringify(contexts),
      }),
    )
    await this.#settleCompletedRound(round, await this.#validateRoundOutput(round, output))
  }

  async publishOneChannelResult(): Promise<'completed' | 'idle'> {
    const now = this.#now()
    const terminalCandidate = (await this.#store.listOpenChannelsWithTerminalChild(1))[0]
    const expiredCandidate =
      terminalCandidate === undefined
        ? (await this.#store.listExpiredOpenChannels(now, 1))[0]
        : undefined
    if (terminalCandidate === undefined && expiredCandidate === undefined) return 'idle'
    const candidate = terminalCandidate ?? expiredCandidate!
    const observationOnly = candidate.channel.state === 'detached'
    const completion = invocationCompletionSchema.parse(
      JSON.parse(candidate.channel.resultContractRefJson) as unknown,
    )
    const childContexts = await this.#store.listContexts(candidate.childCase.id)
    const expired = terminalCandidate === undefined
    const terminalKind = expired
      ? 'deadline-exceeded'
      : (candidate.childCase.terminalKind ?? 'completed')
    // RFC-317 T44（DE-06）—— 走共享分类。旧写法里的 'cancelled' 是**双 L 拼写**，
    // 而全仓其它每一处都写 'canceled'——一个以 'canceled' 终结的子 Case 会被判成 satisfied。
    // 另外 'failed' / 'blocked' 是 Case 的 **state**，不是 terminalKind，放在这张表里
    // 从来不会命中；真正的失败终态是 'execution-failed' / 'deadline-exceeded'。
    const failed = expired || classifyTerminalKind(terminalKind).failed
    const envelope = {
      schemaVersion: 1 as const,
      invocationRef: candidate.channel.invocationId,
      channelRef: candidate.channel.id,
      childCaseRef: {
        id: candidate.childCase.id,
        revision: candidate.childCase.revision,
      },
      state: failed ? ('failed' as const) : ('satisfied' as const),
      terminalKind,
      summary: expired
        ? '协同员工未在全局等待期限内返回'
        : failed
          ? `协同员工以 ${terminalKind} 结束`
          : `协同员工已完成（${terminalKind}）`,
      contextRefs: childContexts.map((context) => ({
        id: context.id,
        revision: context.revision,
      })),
      artifactRefs: [...new Set(childContexts.flatMap((context) => context.artifactRefs))],
    }
    const envelopeJson = JSON.stringify(envelope)
    const envelopeDigest = runtimeDigest(envelope)
    const occurredAt = expired ? now : (candidate.childCase.terminalAt ?? now)
    if (!observationOnly) {
      await this.#eventCenter.observe({
        sourceRef: completion.sourceRef,
        eventTypeRef: completion.eventTypeRef,
        subject: {
          typeId: 'employee-invocation',
          subjectRef: candidate.channel.invocationId,
        },
        occurredAt,
        dedupeKey: `employee-channel-result:${envelopeDigest}`,
        summary: envelope.summary,
        payloadArtifactRef: null,
      })
      await this.#eventCenter.observe(
        employeeInvocationResultObservation({
          invocationRef: candidate.channel.invocationId,
          state: envelope.state,
          terminalKind: envelope.terminalKind,
          summary: envelope.summary,
          envelopeDigest,
          occurredAt,
        }),
      )
    }
    await this.#store.settleChannelResult({
      result: {
        id: this.#id(),
        channelId: candidate.channel.id,
        milestoneType: observationOnly ? 'observed-late' : expired ? 'expired' : 'completed',
        envelopeJson,
        envelopeDigest,
        monotonic: true,
        createdAt: now,
      },
      channelState: observationOnly ? 'detached' : failed ? 'failed' : 'satisfied',
      now,
    })
    return 'completed'
  }

  async runOneOutbox(): Promise<'completed' | 'retried' | 'idle'> {
    const now = this.#now()
    const outbox = await this.#store.claimOutbox({
      workerId: this.#workerId,
      now,
      leaseMs: this.#outboxLeaseMs,
    })
    if (outbox === null) return 'idle'
    let platformAttempt: { readonly roundId: string; readonly startedAt: number } | null = null
    try {
      const ownedCase = outbox.caseId === null ? null : await this.#store.getCase(outbox.caseId)
      if (
        ownedCase?.state === 'terminal' &&
        outbox.kind !== 'event-unsubscribe' &&
        outbox.kind !== 'event-publish'
      ) {
        await this.#store.completeOutbox(outbox.id, this.#workerId, now)
        return 'completed'
      }
      if (outbox.kind === 'event-subscribe') {
        const payload = subscribePayloadSchema.parse(JSON.parse(outbox.payloadJson) as unknown)
        const binding = (await this.#store.listAttention(outbox.caseId ?? '')).find(
          (candidate) => candidate.id === payload.bindingId,
        )
        if (binding === undefined || ['cancel-requested', 'cancelled'].includes(binding.state)) {
          await this.#store.completeOutbox(outbox.id, this.#workerId, this.#now())
          return 'completed'
        }
        const receipt = await this.#eventCenter.subscribe({
          eventTypeRef: payload.eventTypeRef,
          subject: payload.subject,
          subscriber: { kind: 'employee-case', subscriberRef: payload.caseId },
          replayLatest: payload.replayLatest,
        })
        await this.#store.activateAttention(payload.bindingId, receipt.subscriptionId, now)
      } else if (outbox.kind === 'event-publish') {
        await this.#eventCenter.observe(JSON.parse(outbox.payloadJson) as EventObservationInput)
      } else if (outbox.kind === 'event-unsubscribe') {
        const payload = unsubscribePayloadSchema.parse(JSON.parse(outbox.payloadJson) as unknown)
        const binding = (await this.#store.listAttention(outbox.caseId ?? '')).find(
          (candidate) => candidate.id === payload.bindingId,
        )
        if (
          binding !== undefined &&
          (binding.state !== 'cancel-requested' ||
            binding.eventSubscriptionId !== payload.subscriptionId)
        ) {
          // Attention state is the current cancellation authority. A delayed
          // effect must not cancel a subscription that has since been retained
          // or replaced by reactivation.
          await this.#store.completeOutbox(outbox.id, this.#workerId, this.#now())
          return 'completed'
        }
        await this.#eventCenter.unsubscribe(payload.subscriptionId)
        await this.#store.cancelAttention(payload.bindingId, now)
      } else if (outbox.kind === 'execution-launch') {
        const payload = z
          .object({
            roundId: z.string().min(1),
            plan: reactionExecutionPlanSchema,
            attempt: z
              .object({
                ordinal: z.number().int().nonnegative(),
                mode: z.enum(['initial', 'same-scene', 'fresh-scene']),
                previousError: z.string().max(4_000).nullable(),
              })
              .strict()
              .default({ ordinal: 0, mode: 'initial', previousError: null }),
          })
          .strict()
          .parse(JSON.parse(outbox.payloadJson) as unknown)
        const receipt = await this.#execution.launch(payload.plan, payload.attempt)
        await this.#store.markRoundRunning(payload.roundId, receipt.executionRef, now)
      } else if (outbox.kind === 'platform-work-item-execute') {
        const payload = z
          .object({ roundId: z.string().min(1), plan: reactionExecutionPlanSchema })
          .strict()
          .parse(JSON.parse(outbox.payloadJson) as unknown)
        const round = (await this.#store.listRounds(outbox.caseId ?? '')).find(
          (candidate) => candidate.id === payload.roundId,
        )
        if (round === undefined)
          throw new Error(`platform work item round missing: ${payload.roundId}`)
        if (ownedCase === null) {
          throw new Error(`platform work item case missing: ${outbox.caseId ?? 'null'}`)
        }
        platformAttempt = { roundId: round.id, startedAt: this.#now() }
        const output = await this.#platformWorkItems.execute(payload.plan, {
          publicationSubject:
            ownedCase.ownerUserId === null
              ? { kind: 'system' }
              : { kind: 'user', userId: ownedCase.ownerUserId },
        })
        const limitTerminalKind = await this.#recordReactionMetering(round, {
          sourceRef: `platform:${outbox.id}:${outbox.attemptCount}`,
          durationMs: Math.max(0, this.#now() - platformAttempt.startedAt),
          totalTokens: 0,
        })
        const validated = await this.#validateRoundOutput(round, output)
        await this.#settleCompletedRound(round, validated, limitTerminalKind)
        platformAttempt = null
      } else if (outbox.kind === 'invocation-create') {
        const payload = z
          .object({ roundId: z.string().min(1), plan: reactionExecutionPlanSchema })
          .strict()
          .parse(JSON.parse(outbox.payloadJson) as unknown)
        const round = (await this.#store.listRounds(outbox.caseId ?? '')).find(
          (candidate) => candidate.id === payload.roundId,
        )
        if (round === undefined) throw new Error(`invocation round missing: ${payload.roundId}`)
        await this.#executeInvocationRound(round, payload.plan)
      } else {
        throw new Error(`outbox kind not implemented: ${outbox.kind}`)
      }
      await this.#store.completeOutbox(outbox.id, this.#workerId, this.#now())
      return 'completed'
    } catch (error) {
      const caseRecord = outbox.caseId === null ? null : await this.#store.getCase(outbox.caseId)
      const platformRound =
        platformAttempt === null || outbox.caseId === null
          ? undefined
          : (await this.#store.listRounds(outbox.caseId)).find(
              (round) => round.id === platformAttempt?.roundId,
            )
      const limitTerminalKind =
        platformAttempt === null || platformRound === undefined || caseRecord?.state === 'terminal'
          ? null
          : await this.#recordReactionMetering(platformRound, {
              sourceRef: `platform:${outbox.id}:${outbox.attemptCount}`,
              durationMs: Math.max(0, this.#now() - platformAttempt.startedAt),
              totalTokens: 0,
            })
      const policy =
        caseRecord === null
          ? await this.#authoringStore.getCurrentExecutionPolicy()
          : await this.#authoringStore.getExecutionPolicyRevision(
              caseRecord.executionPolicyRevision,
            )
      const maxAttempts = retryAttemptCap(
        policy?.content.sameSceneAttempts ?? 1,
        policy?.content.freshSceneAttempts ?? 1,
      )
      const terminal = limitTerminalKind !== null || outbox.attemptCount >= Math.max(1, maxAttempts)
      const initial = policy?.content.initialBackoffMs ?? 1_000
      const maximum = policy?.content.maxBackoffMs ?? 60_000
      const backoff = Math.min(maximum, initial * 2 ** Math.max(0, outbox.attemptCount - 1))
      await this.#store.retryOutbox({
        id: outbox.id,
        workerId: this.#workerId,
        now: this.#now(),
        nextAttemptAt: this.#now() + backoff,
        error: error instanceof Error ? error.message : String(error),
        terminal,
      })
      if (terminal && outbox.caseId !== null) {
        const detail = error instanceof Error ? error.message : String(error)
        const errorCode = error instanceof DomainError ? error.code : 'internal-error'
        const parsed = z
          .object({ roundId: z.string().min(1) })
          .passthrough()
          .safeParse(JSON.parse(outbox.payloadJson) as unknown)
        const activeRound = (await this.#store.listRounds(outbox.caseId)).find(
          (round) => round.id === (parsed.success ? parsed.data.roundId : ''),
        )
        if (
          activeRound !== undefined &&
          ['planned', 'running', 'settling'].includes(activeRound.state)
        ) {
          await this.#store.settleRound({
            roundId: activeRound.id,
            state: 'failed',
            outputJson: JSON.stringify({
              kind: 'platform-dispatch-failed',
              outboxKind: outbox.kind,
              errorCode,
              detail: detail.slice(0, 4_000),
            }),
            nextCaseState:
              limitTerminalKind !== null || policy?.content.handoffOnExhausted === false
                ? 'terminal'
                : undefined,
            terminalKind:
              limitTerminalKind ??
              (policy?.content.handoffOnExhausted === false
                ? 'platform-dispatch-failed'
                : undefined),
            blockReason:
              limitTerminalKind === null ? `${outbox.kind}: ${detail}`.slice(0, 2_000) : null,
            now: this.#now(),
          })
        } else if (limitTerminalKind !== null) {
          await this.#store.terminateCase(outbox.caseId, limitTerminalKind, this.#now())
        } else if (policy?.content.handoffOnExhausted === false) {
          await this.#store.terminateCase(outbox.caseId, 'platform-dispatch-failed', this.#now())
        } else {
          await this.#store.blockCase(
            outbox.caseId,
            `${outbox.kind}: ${detail}`.slice(0, 2_000),
            this.#now(),
          )
        }
      }
      return 'retried'
    }
  }

  async pumpOneDelivery(): Promise<boolean> {
    for (const caseRecord of await this.#store.listCases()) {
      const deliveries = await this.#eventCenter.pendingDeliveries(
        { kind: 'employee-case', subscriberRef: caseRecord.id },
        100,
      )
      if (deliveries.length === 0) continue
      const descriptor = await this.#descriptor(caseRecord)
      const employee = await this.#authoringStore.getEmployeeDefinitionRevision(
        caseRecord.employeeRef,
      )
      for (const delivery of deliveries) {
        const rule = descriptor.reactionRules.find(
          (candidate) => candidate.eventTypeId === delivery.eventTypeRef.id,
        )
        await this.#store.acceptDelivery(
          caseRecord.id,
          this.#id(),
          delivery,
          rule === undefined || employee === null
            ? (rule?.priority ?? 0)
            : effectiveReactionPriority({
                descriptor,
                reactionLaneOrder: employee.content.exactReactionLaneOrder,
                rule,
              }),
          this.#now(),
        )
        await this.#eventCenter.acceptDelivery(delivery.deliveryId)
      }
      return true
    }
    return false
  }

  async planOneReaction(): Promise<ReactionRoundRecord | null> {
    for (const caseRecord of await this.#store.listCases()) {
      if (
        (await this.#automaticallyResumeRecoveredToolBinding(caseRecord)) ||
        (await this.#automaticallyResumeCompatibleInvocationUpgrade(caseRecord))
      ) {
        break
      }
    }
    for (const caseRecord of await this.#store.listCases()) {
      if (!['active', 'waiting'].includes(caseRecord.state) || caseRecord.activeRoundId !== null) {
        continue
      }
      try {
        const policy = await this.#authoringStore.getExecutionPolicyRevision(
          caseRecord.executionPolicyRevision,
        )
        if (policy === null) throw new Error('pinned execution policy disappeared')
        const exhaustedUserLimit = this.#caseLimitTerminalKind(caseRecord)
        if (exhaustedUserLimit !== null) {
          await this.#store.terminateCase(caseRecord.id, exhaustedUserLimit, this.#now())
          continue
        }
        const remainingDurationMs =
          caseRecord.maxDurationMs === null
            ? null
            : caseRecord.maxDurationMs - caseRecord.consumedDurationMs
        const remainingTotalTokens =
          caseRecord.maxTotalTokens === null
            ? null
            : caseRecord.maxTotalTokens - caseRecord.consumedTotalTokens
        const roundBudgetMs =
          remainingDurationMs === null
            ? policy.content.roundBudgetMs
            : Math.min(policy.content.roundBudgetMs, remainingDurationMs)
        if (caseRecord.createdAt + policy.content.caseBudgetMs <= this.#now()) {
          if (policy.content.handoffOnExhausted) {
            await this.#store.blockCase(caseRecord.id, 'case-budget-exhausted', this.#now())
          } else {
            await this.#store.terminateCase(caseRecord.id, 'case-budget-exhausted', this.#now())
          }
          continue
        }
        const descriptor = await this.#descriptor(caseRecord)
        const contexts = await this.#store.listContexts(caseRecord.id)
        const pendingInbox = (await this.#store.listInbox(caseRecord.id)).find(
          (item) => item.state === 'pending',
        )
        const continuationItem =
          caseRecord.currentWorkItemRef === null
            ? null
            : findWorkItem(descriptor, caseRecord.currentWorkItemRef)
        if (caseRecord.currentWorkItemRef !== null && continuationItem === null) {
          throw new Error(`case points to missing work item: ${caseRecord.currentWorkItemRef}`)
        }
        const pendingRule =
          pendingInbox === undefined
            ? undefined
            : descriptor.reactionRules.find(
                (candidate) => candidate.eventTypeId === pendingInbox.eventTypeRef.id,
              )
        const eventPreemptsContinuation =
          continuationItem !== null && pendingRule?.preemptsContinuation === true
        const selectedContinuation = eventPreemptsContinuation ? null : continuationItem
        const inbox = selectedContinuation === null ? pendingInbox : undefined
        const rule =
          selectedContinuation !== null || inbox === undefined ? null : (pendingRule ?? null)
        if (selectedContinuation === null && inbox === undefined) continue
        if (selectedContinuation === null && rule === null) {
          await this.#store.markInbox(inbox!.id, 'obsolete', this.#now())
          continue
        }
        const requiredContextTypes =
          selectedContinuation === null
            ? rule!.requiredContextTypes
            : contexts.map((context) => context.typeId)
        const inputContextTypes =
          selectedContinuation === null
            ? [...requiredContextTypes, ...rule!.optionalContextTypes]
            : requiredContextTypes
        if (
          requiredContextTypes.some(
            (contextType) => !contexts.some((context) => context.typeId === contextType),
          )
        ) {
          if (inbox !== undefined) await this.#store.markInbox(inbox.id, 'obsolete', this.#now())
          continue
        }
        const item = selectedContinuation ?? findWorkItem(descriptor, rule!.workItemRef)
        if (item === null)
          throw new Error(`reaction points to missing work item: ${rule!.workItemRef}`)
        const contract = findWorkContract(descriptor, item.workContractRef)
        if (contract === null) throw new Error(`work item contract missing: ${item.workItemRef}`)
        const employee = await this.#authoringStore.getEmployeeDefinitionRevision(
          caseRecord.employeeRef,
        )
        if (employee === null) {
          if (inbox !== undefined) await this.#store.markInbox(inbox.id, 'obsolete', this.#now())
          continue
        }
        const enabledWorkItemRefs =
          employee.content.enabledWorkItemRefs.length === 0
            ? descriptor.authoringManifest.workItems.map((candidate) => candidate.workItemRef)
            : employee.content.enabledWorkItemRefs
        const capabilityWorkItemRef = rule?.capabilityWorkItemRef ?? item.workItemRef
        if (
          !enabledWorkItemRefs.includes(item.workItemRef) ||
          !enabledWorkItemRefs.includes(capabilityWorkItemRef)
        ) {
          if (inbox !== undefined) {
            await this.#store.markInbox(inbox.id, 'obsolete', this.#now())
            continue
          }
          throw new ValidationError(
            'employee-continuation-capability-disabled',
            `continuation points to disabled optional capability: ${item.workItemRef}`,
          )
        }
        const selectedSlotRef = this.#selectWorkItemSlot({
          caseRecord,
          item,
          contexts,
          orderedDispatchConfigurations: employee.content.exactOrderedDispatchConfigurations,
          preferredSlotRef: rule?.slotRef,
        })
        const selectedDispatchRoute = employee.content.exactOrderedDispatchConfigurations
          .flatMap((configuration) => configuration.routes)
          .find(
            (route) =>
              route.routeRef === selectedSlotRef &&
              route.destinationWorkItemRef === item.workItemRef,
          )
        const platformSelected =
          item.nodeKind === 'business-tool' && selectedSlotRef === PLATFORM_WORK_ITEM_SLOT_REF
        if (
          item.nodeKind === 'business-tool' &&
          !platformSelected &&
          findToolSlot(item, selectedSlotRef) === null &&
          selectedDispatchRoute === undefined
        ) {
          throw new ValidationError(
            'employee-tool-slot-selection-invalid',
            `type package selected unknown slot ${item.workItemRef}/${selectedSlotRef}`,
          )
        }
        const selectedBinding = employee.content.exactToolBindings.find(
          (candidate) =>
            candidate.workItemRef === item.workItemRef && candidate.slotRef === selectedSlotRef,
        )
        const binding = selectedBinding
        const frozenSlotRef = selectedSlotRef
        const selectedRegistrationRef =
          selectedDispatchRoute?.registrationRef ?? binding?.registrationRef ?? null
        const tool =
          selectedRegistrationRef === null
            ? null
            : await this.#toolRevision(selectedRegistrationRef)
        if (item.nodeKind === 'business-tool' && !platformSelected && tool === null) {
          throw new ValidationError(
            'employee-tool-binding-unavailable',
            `no exact published tool for ${item.workItemRef}/${selectedSlotRef}`,
          )
        }
        const exactWorkItemTools =
          item.nodeKind !== 'business-tool'
            ? []
            : await Promise.all(
                employee.content.exactToolBindings
                  .filter((candidate) => candidate.workItemRef === item.workItemRef)
                  .map(async (candidate) => {
                    const revision =
                      tool !== null &&
                      candidate.registrationRef.id === tool.ref.id &&
                      candidate.registrationRef.revision === tool.ref.revision
                        ? tool
                        : await this.#toolRevision(candidate.registrationRef)
                    if (revision === null || revision.state !== 'published') {
                      throw new ValidationError(
                        'employee-tool-binding-unavailable',
                        `no exact published tool for ${candidate.workItemRef}/${candidate.slotRef}`,
                      )
                    }
                    return {
                      slotRef: candidate.slotRef,
                      registrationRef: revision.ref,
                      workContractRef: revision.content.workContractRef,
                      implementation: revision.content.implementation,
                    }
                  }),
              )
        const adapterSlot =
          item.responsibilityLaneId === null || contract.requiredConnectionPurpose === null
            ? null
            : (descriptor.authoringManifest.lifecycleRegions
                .flatMap((region) => region.responsibilityLanes)
                .find((lane) => lane.laneId === item.responsibilityLaneId)
                ?.adapterSlots.find(
                  (slot) => slot.purpose === contract.requiredConnectionPurpose,
                ) ?? null)
        const exactAdapterRef =
          adapterSlot === null
            ? (tool?.content.connectionRef ?? null)
            : (employee.content.exactAdapterBindings.find(
                (candidate) =>
                  candidate.laneId === item.responsibilityLaneId &&
                  candidate.slotRef === adapterSlot.slotRef,
              )?.adapterRef ?? null)
        if (
          adapterSlot !== null &&
          adapterSlot.requiredWhenLaneEnabled &&
          exactAdapterRef === null
        ) {
          throw new ValidationError(
            'employee-adapter-binding-unavailable',
            `no exact Adapter for ${item.responsibilityLaneId}/${adapterSlot.slotRef}`,
          )
        }
        const collaborationBindings =
          item.nodeKind === 'collaboration'
            ? employee.content.exactCollaborationBindings.filter(
                (candidate) => candidate.workItemRef === item.workItemRef,
              )
            : []
        if (item.nodeKind === 'collaboration' && collaborationBindings.length === 0) {
          throw new ValidationError(
            'employee-collaboration-binding-unavailable',
            `no target employee is configured for ${item.workItemRef}`,
          )
        }
        const roundId = this.#id()
        const inputContexts = contexts
          .filter((context) => inputContextTypes.includes(context.typeId))
          .map((context) => ({ id: context.id, revision: context.revision }))
        const triggeringEventRef =
          inbox?.eventId ?? `continuation:${caseRecord.revision}:${item.workItemRef}`
        const executionNonce = runtimeDigest({
          roundId,
          caseRef: { id: caseRecord.id, revision: caseRecord.revision },
          employeeTypeRef: caseRecord.typeRef,
          inputContexts,
          triggeringEventRef,
          workItemRef: item.workItemRef,
          toolSlotRef: frozenSlotRef,
          workContractRef: item.workContractRef,
          toolRegistrationRef: tool?.ref ?? null,
          adapterRef: exactAdapterRef,
          exactWorkItemTools,
          orderedDispatchConfigurations: employee.content.exactOrderedDispatchConfigurations,
          executionPolicyRevision: caseRecord.executionPolicyRevision,
          roundBudgetMs,
          maxTotalTokens: remainingTotalTokens,
        })
        const assembledInputEnvelopeJson = this.#codec(
          caseRecord.typeRef.typeId,
        ).assembleReactionInputJson(
          JSON.stringify({
            schemaVersion: 1,
            employeeTypeRef: caseRecord.typeRef,
            caseRef: caseRecord.id,
            roundRef: roundId,
            executionNonce,
            workItemRef: item.workItemRef,
            toolSlotRef: frozenSlotRef,
            connectionRef: exactAdapterRef,
            inputSchemaId: contract.inputSchemaId,
            outputSchemaId: contract.outputSchemaId,
            eventJson: JSON.stringify(
              inbox ?? {
                kind: 'work-item-continuation',
                caseId: caseRecord.id,
                workItemRef: item.workItemRef,
              },
            ),
            contextsJson: JSON.stringify(
              contexts.filter((context) => inputContextTypes.includes(context.typeId)),
            ),
            orderedDispatchConfigurationsJson: JSON.stringify(
              employee.content.exactOrderedDispatchConfigurations,
            ),
            toolBindingsJson: JSON.stringify(exactWorkItemTools),
          }),
        )
        const inputEnvelopeJson = await this.#executionContracts.validateEnvelope({
          direction: 'input',
          contractRef: item.workContractRef,
          roundRef: roundId,
          executionNonce,
          envelopeJson: assembledInputEnvelopeJson,
        })
        let implementationRef: ExactResourceRef | null = null
        let implementationKind: ReactionExecutionPlan['implementationKind'] =
          item.nodeKind === 'system' || platformSelected
            ? 'system'
            : item.nodeKind === 'collaboration'
              ? 'collaboration'
              : 'agent'
        if (tool !== null) {
          implementationKind = tool.content.implementation.kind
          implementationRef =
            tool.content.implementation.kind === 'agent'
              ? tool.content.implementation.agentRef
              : tool.content.implementation.kind === 'workflow'
                ? tool.content.implementation.workflowRef
                : tool.ref
        } else if (collaborationBindings.length === 1) {
          implementationRef = collaborationBindings[0]!.targetEmployeeRef
        }
        const plan = reactionExecutionPlanSchema.parse({
          schemaVersion: 1,
          roundRef: roundId,
          executionNonce,
          caseRef: { id: caseRecord.id, revision: caseRecord.revision },
          employeeTypeRef: caseRecord.typeRef,
          inputContextRefs: inputContexts,
          triggeringEventRef,
          workItemRef: item.workItemRef,
          toolSlotRef: frozenSlotRef,
          workContractRef: item.workContractRef,
          toolRegistrationRef: tool?.ref ?? null,
          connectionRef: exactAdapterRef,
          implementationRef,
          implementationKind,
          implementationJson:
            tool !== null
              ? JSON.stringify(tool.content.implementation)
              : collaborationBindings.length === 0
                ? null
                : JSON.stringify(
                    z.array(employeeCollaborationBindingSchema).parse(collaborationBindings),
                  ),
          inputSchemaId: contract.inputSchemaId,
          outputSchemaId: contract.outputSchemaId,
          semanticValidatorId: contract.semanticValidatorId,
          executionPolicyRevision: caseRecord.executionPolicyRevision,
          roundBudgetMs,
          maxTotalTokens: remainingTotalTokens,
          externalWaitDeadlineMs: policy.content.externalWaitDeadlineMs,
          allowedEffectKinds: rule?.allowedEffectKinds ?? contract.allowedEffectKinds,
          workspacePolicy: contract.workspacePolicy,
          inputEnvelopeJson,
        })
        const now = this.#now()
        const round: ReactionRoundRecord = {
          id: roundId,
          caseId: caseRecord.id,
          caseRevision: caseRecord.revision,
          inboxId: selectedContinuation === null ? inbox!.id : null,
          employeeRef: caseRecord.employeeRef,
          ruleId: rule?.ruleId ?? `continue-${item.workItemRef}`,
          workItemRef: item.workItemRef,
          workContractRef: item.workContractRef,
          toolRef: tool?.ref ?? null,
          executionPolicyRevision: caseRecord.executionPolicyRevision,
          inputContextRefsJson: JSON.stringify(inputContexts),
          planJson: JSON.stringify(plan),
          state: 'planned',
          executionRef: null,
          outputJson: null,
          attemptOrdinal: 0,
          createdAt: now,
          updatedAt: now,
          settledAt: null,
        }
        const launchOutbox: EmployeeOutboxRecord = {
          id: this.#id(),
          caseId: caseRecord.id,
          kind:
            item.nodeKind === 'business-tool' && !platformSelected
              ? 'execution-launch'
              : item.nodeKind === 'system' || platformSelected
                ? 'platform-work-item-execute'
                : 'invocation-create',
          payloadJson: JSON.stringify(
            item.nodeKind === 'business-tool' && !platformSelected
              ? {
                  roundId,
                  plan,
                  attempt: { ordinal: 0, mode: 'initial', previousError: null },
                }
              : { roundId, plan },
          ),
          dedupeKey:
            item.nodeKind === 'business-tool' && !platformSelected
              ? `execution-launch:${roundId}:0`
              : item.nodeKind === 'system' || platformSelected
                ? `platform-work-item-execute:${roundId}`
                : `invocation-create:${roundId}`,
          attemptCount: 0,
        }
        if (
          !(await this.#store.createRound({
            expectedCaseRevision: caseRecord.revision,
            inboxId: selectedContinuation === null ? inbox!.id : null,
            round,
            plan,
            launchOutbox,
          }))
        ) {
          continue
        }
        return round
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        await this.#store.blockCase(
          caseRecord.id,
          `reaction-planning-failed: ${error.code}: ${error.message}`.slice(0, 2_000),
          this.#now(),
        )
      }
    }
    return null
  }

  async #retryOrFailExecution(
    round: ReactionRoundRecord,
    errorClass: WorkspaceFailureClass,
    errorCode: string,
    errorDetail: string,
  ): Promise<'retried' | 'failed'> {
    if (round.executionRef === null) throw new Error('running round has no execution ref')
    const policy = await this.#authoringStore.getExecutionPolicyRevision(
      round.executionPolicyRevision,
    )
    if (policy === null) throw new Error('pinned execution policy disappeared')
    // RFC-317 T31（DE-03）—— 原本是 `errorCode.startsWith('workspace-boundary-')`：
    // 平台级的重试策略由某个业务模块**拼字符串的拼法**决定。现在读端口上的闭合字段。
    const boundaryFailure = boundaryEscalates(errorClass)
    const attemptsPerScene = policy.content.sameSceneAttempts + 1
    const nextOrdinal = boundaryFailure
      ? Math.max(
          round.attemptOrdinal + 1,
          (Math.floor(round.attemptOrdinal / attemptsPerScene) + 1) * attemptsPerScene,
        )
      : round.attemptOrdinal + 1
    const retryBudget =
      retryAttemptCap(policy.content.sameSceneAttempts, policy.content.freshSceneAttempts) - 1
    const errorJson = JSON.stringify({
      kind: 'failed',
      executionRef: round.executionRef,
      errorCode,
      errorDetail: errorDetail.slice(0, 4_000),
    })
    if (nextOrdinal <= retryBudget) {
      const frozenPlan = reactionExecutionPlanSchema.parse(JSON.parse(round.planJson) as unknown)
      const caseRecord = await this.getCase(round.caseId)
      const remainingDurationMs =
        caseRecord.maxDurationMs === null
          ? null
          : caseRecord.maxDurationMs - caseRecord.consumedDurationMs
      const remainingTotalTokens =
        caseRecord.maxTotalTokens === null
          ? null
          : caseRecord.maxTotalTokens - caseRecord.consumedTotalTokens
      const plan = reactionExecutionPlanSchema.parse({
        ...frozenPlan,
        roundBudgetMs:
          remainingDurationMs === null
            ? frozenPlan.roundBudgetMs
            : Math.min(frozenPlan.roundBudgetMs, Math.max(1, remainingDurationMs)),
        maxTotalTokens: remainingTotalTokens === null ? null : Math.max(1, remainingTotalTokens),
      })
      const mode = nextOrdinal % attemptsPerScene === 0 ? 'fresh-scene' : 'same-scene'
      const now = this.#now()
      const retryDelay = Math.min(
        policy.content.maxBackoffMs,
        policy.content.initialBackoffMs * 2 ** Math.max(0, nextOrdinal - 1),
      )
      await this.#store.retryRound({
        roundId: round.id,
        expectedExecutionRef: round.executionRef,
        attemptOrdinal: nextOrdinal,
        errorJson,
        launchOutbox: {
          id: this.#id(),
          caseId: round.caseId,
          kind: 'execution-launch',
          payloadJson: JSON.stringify({
            roundId: round.id,
            plan,
            attempt: {
              ordinal: nextOrdinal,
              mode,
              previousError: `${errorCode}: ${errorDetail}`.slice(0, 4_000),
            },
          }),
          dedupeKey: `execution-launch:${round.id}:${nextOrdinal}`,
          attemptCount: 0,
        },
        nextAttemptAt: now + retryDelay,
        now,
      })
      return 'retried'
    }
    await this.#store.settleRound({
      roundId: round.id,
      state: 'failed',
      outputJson: errorJson,
      nextCaseState: policy.content.handoffOnExhausted ? undefined : 'terminal',
      terminalKind: policy.content.handoffOnExhausted ? undefined : 'execution-failed',
      blockReason: `${errorCode}: ${errorDetail}`.slice(0, 2_000),
      now: this.#now(),
    })
    return 'failed'
  }

  async #failRoundForUserLimit(
    round: ReactionRoundRecord,
    terminalKind: string,
  ): Promise<'failed'> {
    await this.#store.settleRound({
      roundId: round.id,
      state: 'failed',
      outputJson: JSON.stringify({ kind: 'failed', terminalKind }),
      nextCaseState: 'terminal',
      terminalKind,
      blockReason: null,
      now: this.#now(),
    })
    return 'failed'
  }

  async inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'> {
    const rounds = await this.#store.listRunningRounds()
    if (rounds.length === 0) return 'idle'
    let hasPendingExecution = false
    for (const round of rounds) {
      if (round.executionRef === null) continue
      const snapshot = await this.#execution.inspect(round.executionRef)
      if (snapshot.kind === 'pending') {
        hasPendingExecution = true
        continue
      }
      const limitTerminalKind = await this.#recordReactionMetering(round, snapshot.metering)
      if (snapshot.kind === 'failed') {
        if (limitTerminalKind !== null) {
          return await this.#failRoundForUserLimit(round, limitTerminalKind)
        }
        return await this.#retryOrFailExecution(
          round,
          snapshot.errorClass,
          snapshot.errorCode,
          snapshot.errorDetail,
        )
      }
      try {
        const validated = await this.#validateRoundOutput(round, snapshot.outputJson)
        await this.#settleCompletedRound(round, validated, limitTerminalKind)
        return 'completed'
      } catch (error) {
        if (limitTerminalKind !== null) {
          return await this.#failRoundForUserLimit(round, limitTerminalKind)
        }
        return await this.#retryOrFailExecution(
          round,
          // agent 交回来的信封不合契约：与工作区边界无关，按同场景重试（行为同改造前）。
          'semantic',
          'execution-envelope-invalid',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    return hasPendingExecution ? 'pending' : 'idle'
  }

  async terminate(caseId: string, terminalKind: string): Promise<EmployeeCaseRecord> {
    if (!/^[a-z][a-z0-9._-]{0,159}$/.test(terminalKind)) {
      throw new ValidationError('employee-terminal-kind-invalid', 'invalid terminal kind')
    }
    return await this.#store.terminateCase(caseId, terminalKind, this.#now())
  }

  async resume(caseId: string): Promise<EmployeeCaseRecord> {
    return await this.#store.resumeCase(caseId, this.#now())
  }

  async previewPolicyUpgrade(caseId: string, targetPolicyRevision: number): Promise<string> {
    const caseRecord = await this.getCase(caseId)
    if (caseRecord.state === 'terminal' || caseRecord.activeRoundId !== null) {
      throw new ConflictError(
        'employee-policy-upgrade-not-safe',
        'policy upgrade requires a non-terminal case with no active reaction',
      )
    }
    const policy = await this.#authoringStore.getExecutionPolicyRevision(targetPolicyRevision)
    if (policy === null) {
      throw new NotFoundError(
        'employee-execution-policy-not-found',
        `execution policy revision not found: ${targetPolicyRevision}`,
      )
    }
    const payload = {
      caseId,
      expectedCaseRevision: caseRecord.revision,
      fromPolicyRevision: caseRecord.executionPolicyRevision,
      targetPolicyRevision,
      targetDigest: policy.contentDigest,
    }
    return Buffer.from(JSON.stringify({ ...payload, digest: runtimeDigest(payload) })).toString(
      'base64url',
    )
  }

  /**
   * RFC-330 —— 只解出 preview token 指向的案例 id，供 transport 在 apply 前做
   * 操作判据；完整校验（strict schema + digest + 目标策略对账）仍在 applyPolicyUpgrade。
   */
  peekPolicyUpgradeCaseId(previewToken: string): string {
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(previewToken, 'base64url').toString('utf8')) as unknown
    } catch {
      throw new ValidationError('employee-policy-preview-invalid', 'invalid policy preview token')
    }
    const parsed = z
      .object({ caseId: z.string().min(1) })
      .passthrough()
      .safeParse(decoded)
    if (!parsed.success) {
      throw new ValidationError('employee-policy-preview-invalid', 'invalid policy preview token')
    }
    return parsed.data.caseId
  }

  async applyPolicyUpgrade(previewToken: string): Promise<EmployeeCaseRecord> {
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(previewToken, 'base64url').toString('utf8')) as unknown
    } catch {
      throw new ValidationError('employee-policy-preview-invalid', 'invalid policy preview token')
    }
    const preview = z
      .object({
        caseId: z.string().min(1),
        expectedCaseRevision: z.number().int().positive(),
        fromPolicyRevision: z.number().int().positive(),
        targetPolicyRevision: z.number().int().positive(),
        targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(decoded)
    const { digest, ...payload } = preview
    if (runtimeDigest(payload) !== digest) {
      throw new ValidationError('employee-policy-preview-invalid', 'policy preview digest mismatch')
    }
    const policy = await this.#authoringStore.getExecutionPolicyRevision(
      preview.targetPolicyRevision,
    )
    if (policy?.contentDigest !== preview.targetDigest) {
      throw new ConflictError(
        'employee-policy-preview-stale',
        'target policy revision changed or is unavailable',
      )
    }
    const updated = await this.#store.upgradePolicy({
      caseId: preview.caseId,
      expectedRevision: preview.expectedCaseRevision,
      targetPolicyRevision: preview.targetPolicyRevision,
      now: this.#now(),
    })
    if (updated === null) {
      throw new ConflictError(
        'employee-policy-preview-stale',
        'case changed after policy upgrade preview',
      )
    }
    return updated
  }
}
