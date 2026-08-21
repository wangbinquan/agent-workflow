import { ulid } from 'ulid'
import { z } from 'zod'
import { retryAttemptCap } from '@agent-workflow/shared'

import type { EventCenterParticipant } from '@/modules/event-center/public/participants'
import type { EventObservationInput } from '@/modules/event-center/public/types'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type {
  EmployeeTypeCollaborationCodec,
  EmployeeTypeContextCodec,
  EmployeeTypeReactionCodec,
} from '../public/types'
import { employeeInvocationResultObservation } from '../public/events'

type EmployeeTypeRuntimeCodec = EmployeeTypeContextCodec &
  EmployeeTypeReactionCodec &
  EmployeeTypeCollaborationCodec
import type { DigitalEmployeeAuthoringStore } from './ports/authoringStore'
import type { ExecutionPolicyRevisionRecord } from './ports/authoringStore'
import type {
  AttentionBindingRecord,
  EmployeeOutboxRecord,
  RuntimeCaseStorePort,
} from './ports/runtimeStore'
import type {
  EmployeeInputArtifactPort,
  PlatformWorkItemExecutionPort,
  ReactionExecutionPort,
} from '../composition/required-ports'
import type { EmployeeInputUploadStore } from '../infrastructure/inputUploadStore'
import {
  employeeCollaborationBindingSchema,
  findWorkContract,
  findWorkItem,
  findToolSlot,
  type EmployeeTypePackageDescriptor,
  type ExactResourceRef,
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
  type EmployeeCaseRecord,
  type EmployeeContextRecord,
  type ReactionExecutionPlan,
  type ReactionRoundRecord,
} from '../domain/runtimeModel'

const subscribePayloadSchema = z
  .object({
    bindingId: z.string().min(1),
    eventTypeRef: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
    subject: z.object({ typeId: z.string().min(1), subjectRef: z.string().min(1) }),
    caseId: z.string().min(1),
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

export interface DigitalEmployeeRuntimeServiceDependencies {
  readonly store: RuntimeCaseStorePort
  readonly authoringStore: DigitalEmployeeAuthoringStore
  readonly eventCenter: EventCenterParticipant
  readonly execution: ReactionExecutionPort
  readonly platformWorkItems: PlatformWorkItemExecutionPort
  readonly inputUploads: EmployeeInputUploadStore
  readonly inputArtifacts: EmployeeInputArtifactPort
  readonly runtimeCodecs: readonly EmployeeTypeRuntimeCodec[]
  readonly executionContracts: ExecutionContractParticipant
  readonly resolveExecutionPolicy?: () => ExecutionPolicyRevisionRecord
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

export class DigitalEmployeeRuntimeService {
  readonly #store: RuntimeCaseStorePort
  readonly #authoringStore: DigitalEmployeeAuthoringStore
  readonly #eventCenter: EventCenterParticipant
  readonly #execution: ReactionExecutionPort
  readonly #platformWorkItems: PlatformWorkItemExecutionPort
  readonly #inputUploads: EmployeeInputUploadStore
  readonly #inputArtifacts: EmployeeInputArtifactPort
  readonly #executionContracts: ExecutionContractParticipant
  readonly #resolveExecutionPolicy: () => ExecutionPolicyRevisionRecord
  readonly #codecs = new Map<string, EmployeeTypeRuntimeCodec>()
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
    this.#resolveExecutionPolicy =
      deps.resolveExecutionPolicy ??
      (() => {
        const policy = this.#authoringStore.getCurrentExecutionPolicy()
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

  #descriptor(caseRecord: EmployeeCaseRecord): EmployeeTypePackageDescriptor {
    const record = this.#authoringStore.getTypePackage(caseRecord.typeRef)
    if (record === null || record.state !== 'published') {
      throw new NotFoundError(
        'employee-type-not-found',
        `employee type not found: ${typeKey(caseRecord.typeRef.typeId, caseRecord.typeRef.revision)}`,
      )
    }
    return record.descriptor
  }

  launchWork(input: {
    readonly employeeId: string
    readonly intake: unknown
    readonly actorUserId: string | null
    readonly eventOrigin?: {
      readonly eventSubscriptionId: string
      readonly eventDeliveryId: string
    }
  }): EmployeeCaseRecord {
    if (input.eventOrigin !== undefined) {
      const existing = this.#store.findCaseByEventDelivery(input.eventOrigin.eventDeliveryId)
      if (existing !== null) return existing
    }
    const employee = this.#authoringStore.getEmployeeDefinition(input.employeeId)
    if (employee === null || employee.archivedAt !== null || employee.publishedRevision === null) {
      throw new NotFoundError(
        'employee-definition-not-found',
        `published employee not found: ${input.employeeId}`,
      )
    }
    const employeeRef = { id: employee.id, revision: employee.publishedRevision }
    const revision = this.#authoringStore.getEmployeeDefinitionRevision(employeeRef)
    if (revision === null || !revision.content.enabled) {
      throw new ValidationError(
        'employee-definition-unavailable',
        'the exact employee revision is missing or disabled',
      )
    }
    const scope = this.#authoringStore.getWorkScopeRevision(revision.content.workScopeRef)
    if (scope === null) {
      throw new ValidationError(
        'employee-work-scope-unavailable',
        'the employee work scope revision is unavailable',
      )
    }
    const intake = employeeWorkIntakeSchema.parse(input.intake)
    const caseId = this.#id()
    const now = this.#now()
    const uploads = this.#inputUploads.resolveForCase({
      ids: intake.uploads.map((upload) => upload.uploadRef),
      actorUserId: input.actorUserId,
      caseId,
      now,
    })
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
        targetPath: upload.targetPath,
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
            intake: { ...intake, uploads: resolvedUploads },
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
    return this.launchCase(launch, {
      caseId,
      now,
      eventOrigin: input.eventOrigin ?? null,
      uploadClaims: uploads.map((upload) => ({
        uploadRef: upload.id,
        actorUserId: input.actorUserId,
        sha256: upload.sha256,
        blobRef: upload.blobRef,
      })),
    })
  }

  launchCase(
    input: unknown,
    admission?: {
      readonly caseId: string
      readonly now: number
      readonly eventOrigin: {
        readonly eventSubscriptionId: string
        readonly eventDeliveryId: string
      } | null
      readonly uploadClaims: readonly {
        readonly uploadRef: string
        readonly actorUserId: string | null
        readonly sha256: string
        readonly blobRef: string
      }[]
    },
  ): EmployeeCaseRecord {
    const launch = employeeCaseLaunchSchema.parse(input)
    const employee = this.#authoringStore.getEmployeeDefinitionRevision(launch.employeeRef)
    if (employee === null || !employee.content.enabled) {
      throw new ValidationError(
        'employee-definition-unavailable',
        'the exact employee revision is missing or disabled',
      )
    }
    const typePackage = this.#authoringStore.getTypePackage(employee.content.typeRef)
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
      this.#store.findCaseByExternalSubject(
        launch.workSubject.typeId,
        launch.workSubject.subjectRef,
      ) !== null
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
    const policy = this.#resolveExecutionPolicy()

    const now = admission?.now ?? this.#now()
    const caseId = admission?.caseId ?? this.#id()
    const contextId = this.#id()
    const caseRecord: EmployeeCaseRecord = {
      id: caseId,
      employeeRef: launch.employeeRef,
      typeRef: employee.content.typeRef,
      primaryContextId: contextId,
      executionPolicyRevision: policy.revision,
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
    this.#store.createCase({
      caseRecord,
      primaryContext: context,
      contextDigest: runtimeDigest({
        stateJson: context.stateJson,
        artifactRefs: context.artifactRefs,
      }),
      externalSubject: launch.workSubject,
      eventOrigin: admission?.eventOrigin ?? null,
      uploadClaims: admission?.uploadClaims ?? [],
    })
    return caseRecord
  }

  getCase(caseId: string): EmployeeCaseRecord {
    const record = this.#store.getCase(caseId)
    if (record === null) {
      throw new NotFoundError('employee-case-not-found', `employee case not found: ${caseId}`)
    }
    return record
  }

  listCases(employeeId?: string, state?: string): EmployeeCaseRecord[] {
    if (state !== undefined && !['active', 'waiting', 'blocked', 'terminal'].includes(state)) {
      throw new ValidationError('employee-case-state-invalid', `invalid case state: ${state}`)
    }
    return this.#store.listCases(employeeId, state)
  }

  listCasePage(input: {
    readonly employeeId?: string
    readonly states?: readonly EmployeeCaseRecord['state'][]
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
    const page = this.#store.listCasesPage({
      ...(input.employeeId === undefined ? {} : { employeeId: input.employeeId }),
      ...(input.states === undefined ? {} : { states: input.states }),
      view: input.view ?? 'all',
      ...(input.q === undefined || input.q.trim() === ''
        ? {}
        : { q: input.q.trim().slice(0, 100) }),
      cursor,
      limit,
    })
    const items = page.cases.map((caseRecord) => {
      const descriptor = this.#descriptor(caseRecord)
      const employee = this.#authoringStore.getEmployeeDefinitionRevision(caseRecord.employeeRef)
      const primary = this.#store
        .listContexts(caseRecord.id)
        .find((context) => context.id === caseRecord.primaryContextId)
      const primaryState =
        primary === undefined ? null : (JSON.parse(primary.stateJson) as Record<string, unknown>)
      const currentItem =
        caseRecord.currentWorkItemRef === null
          ? null
          : findWorkItem(descriptor, caseRecord.currentWorkItemRef)
      const activeRound = this.#store
        .listRounds(caseRecord.id)
        .find((round) => ['planned', 'running', 'settling'].includes(round.state))
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
        pendingEventCount: this.#store
          .listInbox(caseRecord.id)
          .filter((event) => event.state === 'pending').length,
        openChannelCount: this.#store
          .listChannels(caseRecord.id)
          .filter((channel) => channel.state === 'open').length,
        createdAt: caseRecord.createdAt,
        updatedAt: caseRecord.updatedAt,
      }
    })
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

  findCaseByExternalSubject(subjectType: string, subjectRef: string) {
    return this.#store.findCaseByExternalSubject(subjectType, subjectRef)
  }

  project(caseId: string) {
    const caseRecord = this.getCase(caseId)
    const descriptor = this.#descriptor(caseRecord)
    const contexts = this.#store.listContexts(caseId)
    const attention = this.#store.listAttention(caseId)
    const inbox = this.#store.listInbox(caseId)
    const rounds = this.#store.listRounds(caseId)
    const activeRound = rounds.find((round) =>
      ['planned', 'running', 'settling'].includes(round.state),
    )
    return {
      case: caseRecord,
      employeeType: {
        displayName: descriptor.displayName,
        description: descriptor.description,
      },
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
      channels: this.#store.listChannels(caseId).map((channel) => {
        const invocation = this.#store
          .listInvocationsForRound(channel.correlationRef)
          .find((candidate) => candidate.id === channel.invocationId)
        if (invocation === undefined) {
          throw new Error(`employee channel ${channel.id} lost its invocation projection`)
        }
        return {
          ...channel,
          targetEmployeeRef: invocation.targetEmployeeRef,
          results: this.#store.listChannelResults(channel.id).map((result) => ({
            ...result,
            envelope: JSON.parse(result.envelopeJson) as unknown,
          })),
        }
      }),
      nextAction:
        caseRecord.state === 'terminal'
          ? null
          : caseRecord.state === 'blocked'
            ? { owner: 'current-user', action: 'resolve-blocker' }
            : activeRound === undefined && inbox.some((item) => item.state === 'pending')
              ? { owner: 'platform', action: 'schedule-next-reaction' }
              : { owner: 'digital-employee', action: 'continue-automatically' },
    }
  }

  #settleCompletedRound(round: ReactionRoundRecord, validatedOutputJson: string): void {
    const caseRecord = this.getCase(round.caseId)
    const descriptor = this.#descriptor(caseRecord)
    const item = findWorkItem(descriptor, round.workItemRef)
    if (item === null) throw new Error(`reaction work item disappeared: ${round.workItemRef}`)
    const plan = reactionExecutionPlanSchema.parse(JSON.parse(round.planJson) as unknown)
    const beforeContexts = this.#store.listContexts(caseRecord.id)
    const settlement = reactionSettlementSchema.parse(
      JSON.parse(
        this.#codec(caseRecord.typeRef.typeId).resolveReactionSettlementJson(
          JSON.stringify({
            schemaVersion: 1,
            workItemRef: round.workItemRef,
            toolSlotRef: plan.toolSlotRef,
            outputJson: validatedOutputJson,
            contextsJson: JSON.stringify(beforeContexts),
            allowedNextWorkItemRefs: item.nextWorkItemRefs,
          }),
        ),
      ) as unknown,
    )
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
      const subjects = z
        .array(attentionSubjectSchema)
        .parse(
          JSON.parse(
            this.#codec(caseRecord.typeRef.typeId).resolveAttentionSubjectsJson(
              context.typeId,
              context.stateJson,
            ),
          ) as unknown,
        )
      const externalSubjects = [
        ...new Map(
          subjects.map((subject) => [
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
    const existingAttention = this.#store.listAttention(caseRecord.id)
    const desiredIdentities = new Set<string>()
    const attentionUpserts: Array<{
      binding: AttentionBindingRecord
      subscribeOutbox: EmployeeOutboxRecord | null
    }> = []
    for (const context of contextsAfter) {
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
        if (current !== undefined && !['cancel-requested', 'cancelled'].includes(current.state)) {
          attentionUpserts.push({
            binding: { ...current, contextRevision: context.revision, updatedAt: now },
            subscribeOutbox: null,
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
          eventTypeRef: subject.eventTypeRef,
          subject: subject.subject,
          caseId: caseRecord.id,
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
    const cancelAll = settlement.caseState === 'terminal'
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

    this.#store.settleRound({
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

  #validateRoundOutput(round: ReactionRoundRecord, outputJson: string): string {
    const plan = reactionExecutionPlanSchema.parse(JSON.parse(round.planJson) as unknown)
    const platformValidatedOutput = this.#executionContracts.validateEnvelope({
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
    return this.#codec(this.getCase(round.caseId).typeRef.typeId).validateReactionOutputJson(
      JSON.stringify({
        schemaVersion: 1,
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

  #assertCollaborationAllowed(parentCase: EmployeeCaseRecord, targetEmployeeId: string): void {
    const outbound = this.#store
      .listChannels(parentCase.id)
      .filter((channel) => channel.parentCaseId === parentCase.id)
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
      const inbound = this.#store
        .listChannels(cursorId)
        .find((channel) => channel.childCaseId === cursorId)
      if (inbound === undefined) break
      cursor = this.#store.getCase(inbound.parentCaseId)
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

  #executeInvocationRound(round: ReactionRoundRecord, plan: ReactionExecutionPlan): void {
    if (plan.implementationJson === null) {
      throw new ValidationError(
        'employee-collaboration-plan-invalid',
        'collaboration plan has no exact target binding',
      )
    }
    const bindings = z
      .array(employeeCollaborationBindingSchema)
      .min(1)
      .parse(JSON.parse(plan.implementationJson) as unknown)
    const parentCase = this.getCase(round.caseId)
    const contexts = this.#store.listContexts(round.caseId)
    const event = this.#invocationEvent(plan)
    if (event?.subject.typeId === 'employee-invocation') {
      const channel = this.#store.getChannelByInvocation(event.subject.subjectRef)
      if (channel === null || channel.parentCaseId !== parentCase.id) {
        throw new ValidationError(
          'employee-channel-result-unmatched',
          'collaboration result does not belong to this parent case',
        )
      }
      const currentResult = this.#store.listChannelResults(channel.id).at(-1)
      if (currentResult === undefined) {
        throw new ValidationError(
          'employee-channel-result-missing',
          'collaboration result event arrived before its durable result',
        )
      }
      const groupInvocations = this.#store.listInvocationsForRound(channel.correlationRef)
      if (groupInvocations.length !== bindings.length) {
        throw new ValidationError(
          'employee-collaboration-group-incomplete',
          'the durable invocation group does not match its frozen collaboration plan',
        )
      }
      const members = bindings.map((binding) => {
        const invocation = groupInvocations.find((candidate) =>
          sameRef(candidate.targetEmployeeRef, binding.targetEmployeeRef),
        )
        if (invocation === undefined) {
          throw new ValidationError(
            'employee-collaboration-member-unmatched',
            `no durable invocation exists for member ${binding.memberRef}`,
          )
        }
        const memberChannel = this.#store.getChannelByInvocation(invocation.id)
        const result =
          memberChannel === null
            ? undefined
            : this.#store.listChannelResults(memberChannel.id).at(-1)
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
      })
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
        this.#store.detachOpenChannelsForRound(channel.correlationRef, this.#now())
      }
      if (joinState !== 'waiting') {
        const memberInvocations = new Set(groupInvocations.map((invocation) => invocation.id))
        for (const sibling of this.#store.listInbox(parentCase.id)) {
          if (
            sibling.state === 'pending' &&
            sibling.subject.typeId === 'employee-invocation' &&
            memberInvocations.has(sibling.subject.subjectRef)
          ) {
            this.#store.markInbox(sibling.id, 'obsolete', this.#now())
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
      this.#settleCompletedRound(round, this.#validateRoundOutput(round, output))
      return
    }
    const descriptor = this.#descriptor(parentCase)
    const policy = this.#authoringStore.getExecutionPolicyRevision(round.executionPolicyRevision)
    if (policy === null) throw new Error('pinned execution policy disappeared')
    const now = this.#now()
    const invocations: Array<{
      memberRef: string
      invocationRef: string
      targetEmployeeRef: ExactResourceRef
    }> = []
    for (const binding of bindings) {
      const target = this.#authoringStore.getEmployeeDefinitionRevision(binding.targetEmployeeRef)
      if (target === null || !target.content.enabled) {
        throw new ValidationError(
          'employee-collaboration-target-unavailable',
          `the frozen target employee is unavailable: ${binding.memberRef}`,
        )
      }
      const targetScope = this.#authoringStore.getWorkScopeRevision(target.content.workScopeRef)
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
      const existing = this.#store
        .listInvocationsForRound(round.id)
        .find((candidate) => candidate.id === invocationId)
      if (existing === undefined) {
        this.#assertCollaborationAllowed(parentCase, binding.targetEmployeeRef.id)
      }
      const childCaseId = `employee-child:${runtimeDigest({ invocationId }).slice(0, 32)}`
      const completion = invocationCompletionSchema.parse({
        contractId: contract.contractId,
        resultSchemaId: contract.resultSchemaId,
        eventTypeRef: { id: eventType.eventTypeId, revision: eventType.version },
        sourceRef: eventType.sourceRef,
      })
      this.#store.createInvocation({
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
      if (this.#store.getCase(childCaseId) === null) {
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
        this.launchCase(launch, { caseId: childCaseId, now, eventOrigin: null, uploadClaims: [] })
      }
      this.#store.acceptInvocation({
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
    this.#settleCompletedRound(round, this.#validateRoundOutput(round, output))
  }

  publishOneChannelResult(): 'completed' | 'idle' {
    const now = this.#now()
    const terminalCandidate = this.#store.listOpenChannelsWithTerminalChild(1)[0]
    const expiredCandidate =
      terminalCandidate === undefined ? this.#store.listExpiredOpenChannels(now, 1)[0] : undefined
    if (terminalCandidate === undefined && expiredCandidate === undefined) return 'idle'
    const candidate = terminalCandidate ?? expiredCandidate!
    const observationOnly = candidate.channel.state === 'detached'
    const completion = invocationCompletionSchema.parse(
      JSON.parse(candidate.channel.resultContractRefJson) as unknown,
    )
    const childContexts = this.#store.listContexts(candidate.childCase.id)
    const expired = terminalCandidate === undefined
    const terminalKind = expired
      ? 'deadline-exceeded'
      : (candidate.childCase.terminalKind ?? 'completed')
    const failed = expired || ['closed', 'cancelled', 'failed', 'blocked'].includes(terminalKind)
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
      this.#eventCenter.observe({
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
      this.#eventCenter.observe(
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
    this.#store.settleChannelResult({
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
    const outbox = this.#store.claimOutbox({
      workerId: this.#workerId,
      now,
      leaseMs: this.#outboxLeaseMs,
    })
    if (outbox === null) return 'idle'
    try {
      const ownedCase = outbox.caseId === null ? null : this.#store.getCase(outbox.caseId)
      if (
        ownedCase?.state === 'terminal' &&
        outbox.kind !== 'event-unsubscribe' &&
        outbox.kind !== 'event-publish'
      ) {
        this.#store.completeOutbox(outbox.id, this.#workerId, now)
        return 'completed'
      }
      if (outbox.kind === 'event-subscribe') {
        const payload = subscribePayloadSchema.parse(JSON.parse(outbox.payloadJson) as unknown)
        const binding = this.#store
          .listAttention(outbox.caseId ?? '')
          .find((candidate) => candidate.id === payload.bindingId)
        if (binding === undefined || ['cancel-requested', 'cancelled'].includes(binding.state)) {
          this.#store.completeOutbox(outbox.id, this.#workerId, this.#now())
          return 'completed'
        }
        const receipt = this.#eventCenter.subscribe({
          eventTypeRef: payload.eventTypeRef,
          subject: payload.subject,
          subscriber: { kind: 'employee-case', subscriberRef: payload.caseId },
        })
        this.#store.activateAttention(payload.bindingId, receipt.subscriptionId, now)
      } else if (outbox.kind === 'event-publish') {
        this.#eventCenter.observe(JSON.parse(outbox.payloadJson) as EventObservationInput)
      } else if (outbox.kind === 'event-unsubscribe') {
        const payload = unsubscribePayloadSchema.parse(JSON.parse(outbox.payloadJson) as unknown)
        this.#eventCenter.unsubscribe(payload.subscriptionId)
        this.#store.cancelAttention(payload.bindingId, now)
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
        this.#store.markRoundRunning(payload.roundId, receipt.executionRef, now)
      } else if (outbox.kind === 'platform-work-item-execute') {
        const payload = z
          .object({ roundId: z.string().min(1), plan: reactionExecutionPlanSchema })
          .strict()
          .parse(JSON.parse(outbox.payloadJson) as unknown)
        const round = this.#store
          .listRounds(outbox.caseId ?? '')
          .find((candidate) => candidate.id === payload.roundId)
        if (round === undefined)
          throw new Error(`platform work item round missing: ${payload.roundId}`)
        const output = await this.#platformWorkItems.execute(payload.plan)
        const validated = this.#validateRoundOutput(round, output)
        this.#settleCompletedRound(round, validated)
      } else if (outbox.kind === 'invocation-create') {
        const payload = z
          .object({ roundId: z.string().min(1), plan: reactionExecutionPlanSchema })
          .strict()
          .parse(JSON.parse(outbox.payloadJson) as unknown)
        const round = this.#store
          .listRounds(outbox.caseId ?? '')
          .find((candidate) => candidate.id === payload.roundId)
        if (round === undefined) throw new Error(`invocation round missing: ${payload.roundId}`)
        this.#executeInvocationRound(round, payload.plan)
      } else {
        throw new Error(`outbox kind not implemented: ${outbox.kind}`)
      }
      this.#store.completeOutbox(outbox.id, this.#workerId, this.#now())
      return 'completed'
    } catch (error) {
      const caseRecord = outbox.caseId === null ? null : this.#store.getCase(outbox.caseId)
      const policy =
        caseRecord === null
          ? this.#authoringStore.getCurrentExecutionPolicy()
          : this.#authoringStore.getExecutionPolicyRevision(caseRecord.executionPolicyRevision)
      const maxAttempts = retryAttemptCap(
        policy?.content.sameSceneAttempts ?? 1,
        policy?.content.freshSceneAttempts ?? 1,
      )
      const terminal = outbox.attemptCount >= Math.max(1, maxAttempts)
      const initial = policy?.content.initialBackoffMs ?? 1_000
      const maximum = policy?.content.maxBackoffMs ?? 60_000
      const backoff = Math.min(maximum, initial * 2 ** Math.max(0, outbox.attemptCount - 1))
      this.#store.retryOutbox({
        id: outbox.id,
        workerId: this.#workerId,
        now: this.#now(),
        nextAttemptAt: this.#now() + backoff,
        error: error instanceof Error ? error.message : String(error),
        terminal,
      })
      if (terminal && outbox.caseId !== null) {
        const detail = error instanceof Error ? error.message : String(error)
        const parsed = z
          .object({ roundId: z.string().min(1) })
          .passthrough()
          .safeParse(JSON.parse(outbox.payloadJson) as unknown)
        const activeRound = this.#store
          .listRounds(outbox.caseId)
          .find((round) => round.id === (parsed.success ? parsed.data.roundId : ''))
        if (
          activeRound !== undefined &&
          ['planned', 'running', 'settling'].includes(activeRound.state)
        ) {
          this.#store.settleRound({
            roundId: activeRound.id,
            state: 'failed',
            outputJson: JSON.stringify({
              kind: 'platform-dispatch-failed',
              outboxKind: outbox.kind,
              detail: detail.slice(0, 4_000),
            }),
            nextCaseState: policy?.content.handoffOnExhausted === false ? 'terminal' : undefined,
            terminalKind:
              policy?.content.handoffOnExhausted === false ? 'platform-dispatch-failed' : undefined,
            blockReason: `${outbox.kind}: ${detail}`.slice(0, 2_000),
            now: this.#now(),
          })
        } else if (policy?.content.handoffOnExhausted === false) {
          this.#store.terminateCase(outbox.caseId, 'platform-dispatch-failed', this.#now())
        } else {
          this.#store.blockCase(
            outbox.caseId,
            `${outbox.kind}: ${detail}`.slice(0, 2_000),
            this.#now(),
          )
        }
      }
      return 'retried'
    }
  }

  pumpOneDelivery(): boolean {
    for (const caseRecord of this.#store.listCases()) {
      const deliveries = this.#eventCenter.pendingDeliveries(
        { kind: 'employee-case', subscriberRef: caseRecord.id },
        100,
      )
      if (deliveries.length === 0) continue
      const descriptor = this.#descriptor(caseRecord)
      for (const delivery of deliveries) {
        const rule = descriptor.reactionRules.find(
          (candidate) => candidate.eventTypeId === delivery.eventTypeRef.id,
        )
        this.#store.acceptDelivery(
          caseRecord.id,
          this.#id(),
          delivery,
          rule?.priority ?? 0,
          this.#now(),
        )
        this.#eventCenter.acceptDelivery(delivery.deliveryId)
      }
      return true
    }
    return false
  }

  planOneReaction(): ReactionRoundRecord | null {
    for (const caseRecord of this.#store.listCases()) {
      if (!['active', 'waiting'].includes(caseRecord.state) || caseRecord.activeRoundId !== null) {
        continue
      }
      const policy = this.#authoringStore.getExecutionPolicyRevision(
        caseRecord.executionPolicyRevision,
      )
      if (policy === null) throw new Error('pinned execution policy disappeared')
      if (caseRecord.createdAt + policy.content.caseBudgetMs <= this.#now()) {
        if (policy.content.handoffOnExhausted) {
          this.#store.blockCase(caseRecord.id, 'case-budget-exhausted', this.#now())
        } else {
          this.#store.terminateCase(caseRecord.id, 'case-budget-exhausted', this.#now())
        }
        continue
      }
      const descriptor = this.#descriptor(caseRecord)
      const contexts = this.#store.listContexts(caseRecord.id)
      const pendingInbox = this.#store
        .listInbox(caseRecord.id)
        .find((item) => item.state === 'pending')
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
        this.#store.markInbox(inbox!.id, 'obsolete', this.#now())
        continue
      }
      const requiredContextTypes =
        selectedContinuation === null
          ? rule!.requiredContextTypes
          : contexts.map((context) => context.typeId)
      if (
        requiredContextTypes.some(
          (contextType) => !contexts.some((context) => context.typeId === contextType),
        )
      ) {
        if (inbox !== undefined) this.#store.markInbox(inbox.id, 'obsolete', this.#now())
        continue
      }
      const item = selectedContinuation ?? findWorkItem(descriptor, rule!.workItemRef)
      if (item === null)
        throw new Error(`reaction points to missing work item: ${rule!.workItemRef}`)
      const contract = findWorkContract(descriptor, item.workContractRef)
      if (contract === null) throw new Error(`work item contract missing: ${item.workItemRef}`)
      const employee = this.#authoringStore.getEmployeeDefinitionRevision(caseRecord.employeeRef)
      if (employee === null || !employee.content.enabled) {
        if (inbox !== undefined) this.#store.markInbox(inbox.id, 'obsolete', this.#now())
        continue
      }
      const defaultSlotRef =
        rule?.slotRef ??
        item.toolRoleGroups.flatMap((group) => group.bindingSlots).find((slot) => slot.required)
          ?.slotRef ??
        item.toolRoleGroups.flatMap((group) => group.bindingSlots)[0]?.slotRef ??
        'system'
      const selectedSlotRef = z
        .object({ slotRef: z.string().min(1).max(160) })
        .strict()
        .parse(
          JSON.parse(
            this.#codec(caseRecord.typeRef.typeId).selectReactionToolSlotJson(
              JSON.stringify({
                schemaVersion: 1,
                workItemRef: item.workItemRef,
                defaultSlotRef,
                contextsJson: JSON.stringify(contexts),
              }),
            ),
          ) as unknown,
        ).slotRef
      if (item.nodeKind === 'business-tool' && findToolSlot(item, selectedSlotRef) === null) {
        throw new ValidationError(
          'employee-tool-slot-selection-invalid',
          `type package selected unknown slot ${item.workItemRef}/${selectedSlotRef}`,
        )
      }
      const selectedBinding = employee.content.exactToolBindings.find(
        (candidate) =>
          candidate.workItemRef === item.workItemRef && candidate.slotRef === selectedSlotRef,
      )
      // Optional specialist slots deterministically fall back to the required
      // default (for development this is `unknown`) when no specialist was
      // configured. This preserves total routing without letting the model pick.
      const binding =
        selectedBinding ??
        (selectedSlotRef === defaultSlotRef
          ? undefined
          : employee.content.exactToolBindings.find(
              (candidate) =>
                candidate.workItemRef === item.workItemRef && candidate.slotRef === defaultSlotRef,
            ))
      // Freeze the logical business slot, not the fallback registration slot:
      // an `unknown` fallback may execute a `compile` assignment, but settlement
      // must still retire `compile` from the deterministic problem queue.
      const frozenSlotRef = selectedSlotRef
      const tool =
        binding === undefined ? null : this.#authoringStore.getToolRevision(binding.registrationRef)
      if (item.nodeKind === 'business-tool' && (binding === undefined || tool === null)) {
        throw new ValidationError(
          'employee-tool-binding-unavailable',
          `no exact published tool for ${item.workItemRef}/${selectedSlotRef} (fallback ${defaultSlotRef})`,
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
        .filter((context) => requiredContextTypes.includes(context.typeId))
        .map((context) => ({ id: context.id, revision: context.revision }))
      const triggeringEventRef =
        inbox?.eventId ?? `continuation:${caseRecord.revision}:${item.workItemRef}`
      const executionNonce = runtimeDigest({
        roundId,
        caseRef: { id: caseRecord.id, revision: caseRecord.revision },
        inputContexts,
        triggeringEventRef,
        workItemRef: item.workItemRef,
        toolSlotRef: frozenSlotRef,
        workContractRef: item.workContractRef,
        toolRegistrationRef: tool?.ref ?? null,
        executionPolicyRevision: caseRecord.executionPolicyRevision,
      })
      const assembledInputEnvelopeJson = this.#codec(
        caseRecord.typeRef.typeId,
      ).assembleReactionInputJson(
        JSON.stringify({
          schemaVersion: 1,
          roundRef: roundId,
          executionNonce,
          workItemRef: item.workItemRef,
          toolSlotRef: frozenSlotRef,
          connectionRef: tool?.content.connectionRef ?? null,
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
            contexts.filter((context) => requiredContextTypes.includes(context.typeId)),
          ),
        }),
      )
      const inputEnvelopeJson = this.#executionContracts.validateEnvelope({
        direction: 'input',
        contractRef: item.workContractRef,
        roundRef: roundId,
        executionNonce,
        envelopeJson: assembledInputEnvelopeJson,
      })
      let implementationRef: ExactResourceRef | null = null
      let implementationKind: ReactionExecutionPlan['implementationKind'] =
        item.nodeKind === 'system'
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
        inputContextRefs: inputContexts,
        triggeringEventRef,
        workItemRef: item.workItemRef,
        toolSlotRef: frozenSlotRef,
        workContractRef: item.workContractRef,
        toolRegistrationRef: tool?.ref ?? null,
        connectionRef: tool?.content.connectionRef ?? null,
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
        roundBudgetMs: policy.content.roundBudgetMs,
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
          item.nodeKind === 'business-tool'
            ? 'execution-launch'
            : item.nodeKind === 'system'
              ? 'platform-work-item-execute'
              : 'invocation-create',
        payloadJson: JSON.stringify(
          item.nodeKind === 'business-tool'
            ? {
                roundId,
                plan,
                attempt: { ordinal: 0, mode: 'initial', previousError: null },
              }
            : { roundId, plan },
        ),
        dedupeKey:
          item.nodeKind === 'business-tool'
            ? `execution-launch:${roundId}:0`
            : item.nodeKind === 'system'
              ? `platform-work-item-execute:${roundId}`
              : `invocation-create:${roundId}`,
        attemptCount: 0,
      }
      if (
        !this.#store.createRound({
          expectedCaseRevision: caseRecord.revision,
          inboxId: selectedContinuation === null ? inbox!.id : null,
          round,
          plan,
          launchOutbox,
        })
      ) {
        continue
      }
      return round
    }
    return null
  }

  #retryOrFailExecution(
    round: ReactionRoundRecord,
    errorCode: string,
    errorDetail: string,
  ): 'retried' | 'failed' {
    if (round.executionRef === null) throw new Error('running round has no execution ref')
    const policy = this.#authoringStore.getExecutionPolicyRevision(round.executionPolicyRevision)
    if (policy === null) throw new Error('pinned execution policy disappeared')
    const boundaryFailure = errorCode.startsWith('workspace-boundary-')
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
      const plan = reactionExecutionPlanSchema.parse(JSON.parse(round.planJson) as unknown)
      const mode = nextOrdinal % attemptsPerScene === 0 ? 'fresh-scene' : 'same-scene'
      const now = this.#now()
      const retryDelay = Math.min(
        policy.content.maxBackoffMs,
        policy.content.initialBackoffMs * 2 ** Math.max(0, nextOrdinal - 1),
      )
      this.#store.retryRound({
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
    this.#store.settleRound({
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

  async inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'> {
    const round = this.#store.listRunningRounds()[0]
    if (round === undefined || round.executionRef === null) return 'idle'
    const snapshot = await this.#execution.inspect(round.executionRef)
    if (snapshot.kind === 'pending') return 'pending'
    if (snapshot.kind === 'failed') {
      return this.#retryOrFailExecution(round, snapshot.errorCode, snapshot.errorDetail)
    }
    try {
      const validated = this.#validateRoundOutput(round, snapshot.outputJson)
      this.#settleCompletedRound(round, validated)
      return 'completed'
    } catch (error) {
      return this.#retryOrFailExecution(
        round,
        'execution-envelope-invalid',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  terminate(caseId: string, terminalKind: string): EmployeeCaseRecord {
    if (!/^[a-z][a-z0-9._-]{0,159}$/.test(terminalKind)) {
      throw new ValidationError('employee-terminal-kind-invalid', 'invalid terminal kind')
    }
    return this.#store.terminateCase(caseId, terminalKind, this.#now())
  }

  resume(caseId: string): EmployeeCaseRecord {
    return this.#store.resumeCase(caseId, this.#now())
  }

  previewPolicyUpgrade(caseId: string, targetPolicyRevision: number): string {
    const caseRecord = this.getCase(caseId)
    if (caseRecord.state === 'terminal' || caseRecord.activeRoundId !== null) {
      throw new ConflictError(
        'employee-policy-upgrade-not-safe',
        'policy upgrade requires a non-terminal case with no active reaction',
      )
    }
    const policy = this.#authoringStore.getExecutionPolicyRevision(targetPolicyRevision)
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

  applyPolicyUpgrade(previewToken: string): EmployeeCaseRecord {
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
    const policy = this.#authoringStore.getExecutionPolicyRevision(preview.targetPolicyRevision)
    if (policy?.contentDigest !== preview.targetDigest) {
      throw new ConflictError(
        'employee-policy-preview-stale',
        'target policy revision changed or is unavailable',
      )
    }
    const updated = this.#store.upgradePolicy({
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
