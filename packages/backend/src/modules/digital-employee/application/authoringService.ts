import { ulid } from 'ulid'
import { z } from 'zod'

import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import type {
  ProgramArtifactPort,
  ToolConnectionCatalogPort,
  ToolConnectionVisibilitySubject,
} from '../composition/required-ports'
import {
  DEFAULT_GLOBAL_EXECUTION_POLICY,
  buildToolValidationReceipt,
  contentDigest,
  createToolRegistrationBodySchema,
  digitalEmployeeDefinitionContentSchema,
  digitalEmployeeDefinitionDraftSchema,
  employeeCollaborationBindingSchema,
  employeeJobTemplateContentSchema,
  employeeTypePackageDescriptorSchema,
  employeeTypeRefSchema,
  exactResourceRefSchema,
  findToolRole,
  findToolSlot,
  findWorkContract,
  findWorkItem,
  globalExecutionPolicySchema,
  laneAdapterBindingSchema,
  mergeExactAdapterBindings,
  mergeExactToolBindings,
  orderedDispatchConfigurationSchema,
  packageDigest,
  reactionLaneIds,
  toolRegistrationContentSchema,
  validateTypePackage,
  workContractRefForToolRole,
  workItemToolBindingSchema,
  type ContractValidationCheck,
  type CreateToolRegistrationBody,
  type DigitalEmployeeDefinitionDraft,
  type EmployeeCollaborationBinding,
  type EmployeeJobTemplateContent,
  type EmployeeTypePackageDescriptor,
  type EmployeeTypeRef,
  type EmployeeTypeRuntimePackage,
  type ExactResourceRef,
  type LaneAdapterBinding,
  type OrderedDispatchConfiguration,
  type ToolImplementation,
  type ToolRegistrationContent,
  type ToolValidationReceipt,
  type WorkItemToolBinding,
} from '../domain/model'
import type {
  DigitalEmployeeAuthoringStore,
  DigitalEmployeePlatformToolCatalog,
  EmployeeDefinitionRecord,
  EmployeeDefinitionRevisionRecord,
  JobTemplateRecord,
  ToolDraftRecord,
  ToolRevisionRecord,
  WorkScopeRevisionRecord,
} from './ports/authoringStore'
import { EMPTY_DIGITAL_EMPLOYEE_PLATFORM_TOOL_CATALOG } from './ports/authoringStore'

export const createJobTemplateBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2_000),
    defaultToolBindings: z.array(workItemToolBindingSchema).max(300),
    defaultAdapterBindings: z.array(laneAdapterBindingSchema).max(100).default([]),
    defaultCollaborationBindings: z.array(employeeCollaborationBindingSchema).max(100).default([]),
    orderedDispatchConfigurations: z.array(orderedDispatchConfigurationSchema).max(100).default([]),
    reactionLaneOrder: z.array(z.string().min(1).max(160)).max(30).default([]),
  })
  .strict()

export const updateJobTemplateBodySchema = createJobTemplateBodySchema

export const createEmployeeDefinitionBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    jobTemplateRef: exactResourceRefSchema,
    workScope: z.unknown(),
    toolOverrides: z.array(workItemToolBindingSchema).max(300).default([]),
    adapterOverrides: z.array(laneAdapterBindingSchema).max(100).default([]),
    collaborationOverrides: z.array(employeeCollaborationBindingSchema).max(100).default([]),
  })
  .strict()

export const updateEmployeeDefinitionBodySchema = createEmployeeDefinitionBodySchema

export interface DigitalEmployeeAuthoringServiceDependencies {
  readonly store: DigitalEmployeeAuthoringStore
  readonly typePackages: readonly EmployeeTypeRuntimePackage[]
  readonly connectionCatalog: ToolConnectionCatalogPort
  readonly programArtifacts: ProgramArtifactPort
  /** Platform-owned IO contract authority; there is no per-type fallback path. */
  readonly executionContracts: ExecutionContractParticipant
  readonly platformTools?: DigitalEmployeePlatformToolCatalog
  readonly onAutomaticUpgradeIssue?: (issue: AutomaticTypeUpgradeIssue) => void
  readonly now?: () => number
  readonly id?: () => string
}

export interface AutomaticTypeUpgradeIssue {
  readonly sourceTypeRef: EmployeeTypeRef
  readonly targetTypeRef: EmployeeTypeRef
  readonly resourceKind: 'job-template' | 'employee'
  readonly resourceId: string
  readonly reasonCode: string
  readonly detail: string
}

interface PendingAutomaticToolRevalidation {
  readonly sourceRef: ExactResourceRef
  readonly sourceTypeRef: EmployeeTypeRef
  readonly targetTypeRef: EmployeeTypeRef
  readonly workItemRef: string
}

function typeKey(ref: EmployeeTypeRef): string {
  return `${ref.typeId}@${ref.revision}`
}

export function encodeEmployeeTypeRef(ref: EmployeeTypeRef): string {
  return typeKey(ref)
}

export function parseEmployeeTypeRef(value: string): EmployeeTypeRef {
  const at = value.lastIndexOf('@')
  if (at <= 0) {
    throw new ValidationError(
      'employee-type-ref-invalid',
      'employee type ref must use <typeId>@<revision>',
    )
  }
  const revision = Number(value.slice(at + 1))
  const parsed = employeeTypeRefSchema.safeParse({ typeId: value.slice(0, at), revision })
  if (!parsed.success) {
    throw new ValidationError(
      'employee-type-ref-invalid',
      parsed.error.issues[0]?.message ?? 'invalid',
    )
  }
  return parsed.data
}

function sameType(left: EmployeeTypeRef, right: EmployeeTypeRef): boolean {
  return left.typeId === right.typeId && left.revision === right.revision
}

function exactRefKey(ref: ExactResourceRef): string {
  return JSON.stringify([ref.id, ref.revision])
}

function automaticToolRevalidationKey(input: PendingAutomaticToolRevalidation): string {
  return JSON.stringify([
    input.sourceRef.id,
    input.sourceRef.revision,
    input.targetTypeRef.typeId,
    input.targetTypeRef.revision,
    input.workItemRef,
  ])
}

function ownerVisibilitySubject(
  ownerUserId: string | null,
): ToolConnectionVisibilitySubject | null {
  return ownerUserId === null
    ? null
    : {
        userId: ownerUserId,
        authority: { bypass: false, private: true },
      }
}

function nextRevision(current: number | null): number {
  return (current ?? 0) + 1
}

function automaticUpgradeResourceId(kind: 'tool' | 'job', identity: unknown): string {
  return `auto-upgrade-${kind}-${contentDigest(identity).slice(0, 40)}`
}

function automaticUpgradeJobName(input: {
  readonly sourceName: string
  readonly sourceTypeRef: EmployeeTypeRef
  readonly content: EmployeeJobTemplateContent
}): string {
  const suffix = ` · migrated ${typeKey(input.sourceTypeRef)}-${contentDigest(input.content).slice(0, 8)}`
  return `${input.sourceName.slice(0, Math.max(1, 200 - suffix.length))}${suffix}`
}

class AutomaticTypeUpgradeError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message)
    this.name = 'AutomaticTypeUpgradeError'
  }
}

function mergeCollaborationBindings(input: {
  readonly defaults: readonly EmployeeCollaborationBinding[]
  readonly overrides: readonly EmployeeCollaborationBinding[]
}): EmployeeCollaborationBinding[] {
  const merged = new Map<string, EmployeeCollaborationBinding>()
  const overriddenWorkItems = new Set<string>()
  for (const [source, bindings] of [
    ['job template', input.defaults],
    ['employee', input.overrides],
  ] as const) {
    const seen = new Set<string>()
    for (const binding of bindings) {
      const identity = `${binding.workItemRef}/${binding.memberRef}`
      if (seen.has(identity)) {
        throw new ValidationError(
          'employee-collaboration-binding-duplicate',
          `${source} defines ${identity} more than once`,
        )
      }
      seen.add(identity)
      if (source === 'employee' && !overriddenWorkItems.has(binding.workItemRef)) {
        for (const [key, inherited] of merged) {
          if (inherited.workItemRef === binding.workItemRef) merged.delete(key)
        }
        overriddenWorkItems.add(binding.workItemRef)
      }
      merged.set(identity, binding)
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.workItemRef.localeCompare(right.workItemRef) ||
      left.memberRef.localeCompare(right.memberRef),
  )
}

function validateCollaborationGroups(bindings: readonly EmployeeCollaborationBinding[]): void {
  const groups = new Map<string, EmployeeCollaborationBinding[]>()
  for (const binding of bindings) {
    const group = groups.get(binding.workItemRef) ?? []
    group.push(binding)
    groups.set(binding.workItemRef, group)
  }
  for (const [workItemRef, group] of groups) {
    const first = group[0]!
    if (
      group.some(
        (binding) => binding.joinMode !== first.joinMode || binding.quorum !== first.quorum,
      )
    ) {
      throw new ValidationError(
        'employee-collaboration-join-inconsistent',
        `${workItemRef} members must share one deterministic join rule`,
      )
    }
    if (new Set(group.map((binding) => binding.targetEmployeeRef.id)).size !== group.length) {
      throw new ValidationError(
        'employee-collaboration-target-duplicate',
        `${workItemRef} cannot invoke the same employee more than once`,
      )
    }
    if (first.joinMode === 'quorum' && (first.quorum === null || first.quorum > group.length)) {
      throw new ValidationError(
        'employee-collaboration-quorum-invalid',
        `${workItemRef} quorum must be between 1 and ${group.length}`,
      )
    }
  }
}

export class DigitalEmployeeAuthoringService {
  readonly #store: DigitalEmployeeAuthoringStore
  readonly #types = new Map<string, EmployeeTypeRuntimePackage>()
  readonly #connectionCatalog: ToolConnectionCatalogPort
  readonly #programArtifacts: ProgramArtifactPort
  readonly #executionContracts: ExecutionContractParticipant
  readonly #platformTools: DigitalEmployeePlatformToolCatalog
  readonly #onAutomaticUpgradeIssue: (issue: AutomaticTypeUpgradeIssue) => void
  readonly #now: () => number
  readonly #id: () => string
  readonly #pendingAutomaticToolRevalidations = new Map<string, PendingAutomaticToolRevalidation>()
  readonly #automaticToolRevalidationFailures = new Map<string, AutomaticTypeUpgradeError>()
  readonly #automaticToolRevalidatedSuccessors = new Map<string, ExactResourceRef>()

  constructor(deps: DigitalEmployeeAuthoringServiceDependencies) {
    this.#store = deps.store
    this.#connectionCatalog = deps.connectionCatalog
    this.#programArtifacts = deps.programArtifacts
    this.#executionContracts = deps.executionContracts
    this.#platformTools = deps.platformTools ?? EMPTY_DIGITAL_EMPLOYEE_PLATFORM_TOOL_CATALOG
    this.#onAutomaticUpgradeIssue = deps.onAutomaticUpgradeIssue ?? (() => {})
    this.#now = deps.now ?? Date.now
    this.#id = deps.id ?? ulid

    for (const runtime of deps.typePackages) {
      const descriptor = runtime.descriptor
      const parsed = employeeTypePackageDescriptorSchema.safeParse(descriptor)
      if (!parsed.success) {
        throw new Error(
          `invalid employee type package ${descriptor.typeRef.typeId}: ${parsed.error.issues[0]?.message ?? 'schema error'}`,
        )
      }
      const violations = validateTypePackage(parsed.data)
      if (violations.length > 0) {
        throw new Error(
          `invalid employee type package ${typeKey(descriptor.typeRef)}: ${JSON.stringify(violations.slice(0, 10))}`,
        )
      }
      const key = typeKey(descriptor.typeRef)
      if (this.#types.has(key)) throw new Error(`duplicate employee type package: ${key}`)
      this.#types.set(key, runtime)
      this.#store.ensureTypePackage({
        descriptor,
        descriptorDigest: packageDigest(descriptor),
        state: 'published',
        registeredAt: this.#now(),
      })
    }

    const latestRuntimeByType = new Map<string, EmployeeTypeRuntimePackage>()
    for (const runtime of deps.typePackages) {
      const current = latestRuntimeByType.get(runtime.descriptor.typeRef.typeId)
      if (
        current === undefined ||
        current.descriptor.typeRef.revision < runtime.descriptor.typeRef.revision
      ) {
        latestRuntimeByType.set(runtime.descriptor.typeRef.typeId, runtime)
      }
    }
    const latestRuntimes = [...latestRuntimeByType.values()].sort((left, right) =>
      left.descriptor.typeRef.typeId.localeCompare(right.descriptor.typeRef.typeId),
    )
    for (const runtime of latestRuntimes) {
      this.#automaticallyUpgradeCompatibleClosures(runtime.descriptor.typeRef)
    }
    this.#automaticallyReconcileCompatibleAdapterBindings()
    this.#automaticallyReconcileCompatibleCollaborationTargets()

    this.#store.ensureExecutionPolicy({
      content: DEFAULT_GLOBAL_EXECUTION_POLICY,
      contentDigest: contentDigest(DEFAULT_GLOBAL_EXECUTION_POLICY),
      publishedAt: this.#now(),
      publishedBy: null,
    })
  }

  /**
   * A changed WorkContract cannot reuse its source validation receipt. The
   * bootstrap calls this asynchronous second phase so the target contract
   * authority can validate the exact implementation before a successor is
   * frozen and the owning job/employee closures are retried.
   */
  async settleAutomaticUpgrades(): Promise<void> {
    const attempted = new Set<string>()
    while (this.#pendingAutomaticToolRevalidations.size > 0) {
      const pending = [...this.#pendingAutomaticToolRevalidations.entries()].sort(
        ([left], [right]) => left.localeCompare(right),
      )
      this.#pendingAutomaticToolRevalidations.clear()
      for (const [key, input] of pending) {
        if (attempted.has(key)) {
          this.#automaticToolRevalidationFailures.set(
            key,
            new AutomaticTypeUpgradeError(
              'work-contract-successor-loop',
              `automatic tool successor did not converge for ${input.sourceRef.id}@${input.sourceRef.revision}`,
            ),
          )
          continue
        }
        attempted.add(key)
        try {
          await this.#revalidateAutomaticToolRevision(input)
          this.#automaticToolRevalidationFailures.delete(key)
        } catch (error) {
          this.#automaticToolRevalidationFailures.set(
            key,
            error instanceof AutomaticTypeUpgradeError
              ? error
              : new AutomaticTypeUpgradeError(
                  'work-contract-successor-validation-failed',
                  error instanceof Error ? error.message : String(error),
                ),
          )
        }
      }

      const latestByType = new Map<string, EmployeeTypeRef>()
      for (const runtime of this.#types.values()) {
        const ref = runtime.descriptor.typeRef
        const current = latestByType.get(ref.typeId)
        if (current === undefined || current.revision < ref.revision) {
          latestByType.set(ref.typeId, ref)
        }
      }
      for (const ref of [...latestByType.values()].sort((left, right) =>
        left.typeId.localeCompare(right.typeId),
      )) {
        this.#automaticallyUpgradeCompatibleClosures(ref)
      }
      this.#automaticallyReconcileCompatibleAdapterBindings()
      this.#automaticallyReconcileCompatibleCollaborationTargets()
    }
  }

  /**
   * The package **compiled into the running build** — the only one that can be
   * authored or executed. Every other registered revision is frozen history:
   * still readable (see the store-backed list queries below), never writable.
   */
  #runtime(ref: EmployeeTypeRef): EmployeeTypeRuntimePackage {
    const runtime = this.#types.get(typeKey(ref))
    if (runtime === undefined) {
      if (this.#store.getTypePackage(ref) !== null) {
        const executable = [...this.#types.values()]
          .map((candidate) => candidate.descriptor.typeRef)
          .filter((candidate) => candidate.typeId === ref.typeId)
          .map((candidate) => typeKey(candidate))
        throw new ConflictError(
          'employee-type-revision-not-executable',
          `employee type revision is frozen history: ${typeKey(ref)} is still registered but this build executes ${
            executable.length === 0 ? 'no revision of it' : executable.join(', ')
          }`,
        )
      }
      throw new NotFoundError('employee-type-not-found', `employee type not found: ${typeKey(ref)}`)
    }
    return runtime
  }

  #descriptor(ref: EmployeeTypeRef): EmployeeTypePackageDescriptor {
    const record = this.#store.getTypePackage(ref)
    if (record === null) {
      throw new NotFoundError('employee-type-not-found', `employee type not found: ${typeKey(ref)}`)
    }
    return record.descriptor
  }

  listTypes(): EmployeeTypePackageDescriptor[] {
    const latest = new Map<string, EmployeeTypePackageDescriptor>()
    for (const record of this.#store.listTypePackages()) {
      if (record.state !== 'published') continue
      const current = latest.get(record.descriptor.typeRef.typeId)
      if (current === undefined || current.typeRef.revision < record.descriptor.typeRef.revision) {
        latest.set(record.descriptor.typeRef.typeId, record.descriptor)
      }
    }
    return [...latest.values()].sort((a, b) => a.typeRef.typeId.localeCompare(b.typeRef.typeId))
  }

  getType(ref: EmployeeTypeRef): EmployeeTypePackageDescriptor {
    return this.#descriptor(ref)
  }

  getAuthoringManifest(ref: EmployeeTypeRef) {
    return this.#descriptor(ref).authoringManifest
  }

  #automaticallyUpgradeCompatibleClosures(targetTypeRef: EmployeeTypeRef): void {
    const employeeDefinitions = this.#store.listEmployeeDefinitions()
    const currentEmployeeJobRefs = new Set(
      employeeDefinitions
        .filter((employee) => employee.archivedAt === null && employee.currentRevision !== null)
        .map((employee) => exactRefKey(employee.configuration.jobTemplateRef)),
    )
    const templates = this.#store
      .listJobTemplatesByTypeId(targetTypeRef.typeId)
      .filter(
        (template) =>
          template.publishedRevision !== null && template.typeRef.revision < targetTypeRef.revision,
      )
      .filter((template) => {
        const publishedRevision = template.publishedRevision
        if (publishedRevision === null) return false
        const source = this.#store.getJobTemplateRevision({
          id: template.id,
          revision: publishedRevision,
        })
        if (source === null) return false
        // User-published standalone jobs remain migration roots forever. A
        // system-published job is an automatic intermediate and only needs a
        // successor while a current employee still references that exact ref;
        // otherwise every later Type Package revision replays all historical
        // intermediates and produces duplicate jobs or noisy incompatibility
        // diagnostics.
        return source.publishedBy !== null || currentEmployeeJobRefs.has(exactRefKey(source.ref))
      })
    for (const template of templates) {
      const publishedRevision = template.publishedRevision
      if (publishedRevision === null) continue
      try {
        this.#automaticallyUpgradeJobTemplate(
          { id: template.id, revision: publishedRevision },
          targetTypeRef,
        )
      } catch (error) {
        this.#reportAutomaticUpgradeIssue(
          {
            sourceTypeRef: template.typeRef,
            targetTypeRef,
            resourceKind: 'job-template',
            resourceId: template.id,
          },
          error,
        )
      }
    }

    const candidates = employeeDefinitions
      .filter(
        (employee) =>
          employee.currentRevision !== null &&
          employee.typeRef.typeId === targetTypeRef.typeId &&
          employee.typeRef.revision < targetTypeRef.revision,
      )
      .sort(
        (left, right) =>
          right.typeRef.revision - left.typeRef.revision || left.id.localeCompare(right.id),
      )

    for (const employee of candidates) {
      try {
        this.#automaticallyUpgradeEmployee(employee, targetTypeRef)
      } catch (error) {
        this.#reportAutomaticUpgradeIssue(
          {
            sourceTypeRef: employee.typeRef,
            targetTypeRef,
            resourceKind: 'employee',
            resourceId: employee.id,
          },
          error,
        )
      }
    }
  }

  #reportAutomaticUpgradeIssue(
    resource: Omit<AutomaticTypeUpgradeIssue, 'reasonCode' | 'detail'>,
    error: unknown,
  ): void {
    if (
      error instanceof AutomaticTypeUpgradeError &&
      error.reasonCode === 'work-contract-revalidation-pending'
    ) {
      return
    }
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    const issue: AutomaticTypeUpgradeIssue = {
      ...resource,
      reasonCode:
        error instanceof AutomaticTypeUpgradeError
          ? error.reasonCode
          : typeof errorCode === 'string'
            ? errorCode
            : `${resource.resourceKind}-closure-incompatible`,
      detail: error instanceof Error ? error.message : String(error),
    }
    try {
      this.#onAutomaticUpgradeIssue(issue)
    } catch {
      // Diagnostics must never turn a compatible/incompatible decision into a
      // second business outcome. The caller owns sink reliability.
    }
  }

  #automaticallyUpgradeEmployee(
    employee: EmployeeDefinitionRecord,
    targetTypeRef: EmployeeTypeRef,
  ): void {
    const runtime = this.#runtime(targetTypeRef)
    try {
      runtime.parseWorkScope(employee.configuration.workScope)
    } catch (error) {
      throw new AutomaticTypeUpgradeError(
        'work-scope-incompatible',
        `target work-scope codec rejected ${employee.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const jobTemplateRef = this.#automaticallyUpgradeJobTemplate(
      employee.configuration.jobTemplateRef,
      targetTypeRef,
    )
    const collaborationOverrides = employee.configuration.collaborationOverrides.map((binding) =>
      this.#resolveAutomaticCollaborationBinding(binding),
    )
    for (const binding of collaborationOverrides) {
      this.#assertAutomaticCollaborationCompatibility(employee.typeRef, targetTypeRef, binding)
    }
    const adapterOverrides = this.#projectLegacyAdapterBindings({
      targetTypeRef,
      toolBindings: employee.configuration.toolOverrides,
      explicitBindings: employee.configuration.adapterOverrides,
      requireForEnabledLanes: false,
      subject: ownerVisibilitySubject(employee.ownerUserId),
    })
    const toolOverrides = employee.configuration.toolOverrides
      .filter((binding) => {
        const item = findWorkItem(runtime.descriptor, binding.workItemRef)
        return item?.nodeKind === 'business-tool' && findToolSlot(item, binding.slotRef) !== null
      })
      .map((binding) => ({
        ...binding,
        registrationRef: this.#automaticallyUpgradeToolRevision(
          binding.registrationRef,
          employee.typeRef,
          targetTypeRef,
          binding.workItemRef,
        ),
      }))
    const configuration = digitalEmployeeDefinitionDraftSchema.parse({
      ...employee.configuration,
      typeRef: targetTypeRef,
      jobTemplateRef,
      toolOverrides,
      adapterOverrides,
      collaborationOverrides,
    })
    const candidate: EmployeeDefinitionRecord = {
      ...employee,
      typeRef: targetTypeRef,
      configuration,
      updatedAt: this.#now(),
    }
    const compiled = this.#compileEmployeeDefinition(candidate, null, null)
    this.#store.saveEmployeeDefinition({
      ...compiled,
      definitionMutation: {
        kind: 'update',
        expectedTypeRef: employee.typeRef,
        targetTypeRef,
        name: employee.name,
        configuration,
        updatedAt: compiled.revision.createdAt,
      },
    })
  }

  #automaticallyUpgradeToolRevision(
    sourceRef: ExactResourceRef,
    sourceTypeRef: EmployeeTypeRef,
    targetTypeRef: EmployeeTypeRef,
    workItemRef: string,
  ): ExactResourceRef {
    if (this.#platformTools.isPlatformTool(sourceRef.id)) {
      const successor = this.#platformTools.resolveCompatibleRevision({
        sourceRef,
        targetTypeRef,
        workItemRef,
      })
      if (successor === null) {
        throw new AutomaticTypeUpgradeError(
          'platform-tool-successor-missing',
          `platform tool has no compatible successor: ${sourceRef.id}@${sourceRef.revision}`,
        )
      }
      this.#assertTargetToolRevision(successor, targetTypeRef, workItemRef)
      return successor.ref
    }

    const migration = this.#automaticToolMigrationCandidate(
      sourceRef,
      sourceTypeRef,
      targetTypeRef,
      workItemRef,
    )
    const pending: PendingAutomaticToolRevalidation = {
      sourceRef,
      sourceTypeRef,
      targetTypeRef,
      workItemRef,
    }
    const revalidationKey = automaticToolRevalidationKey(pending)
    const revalidatedRef = this.#automaticToolRevalidatedSuccessors.get(revalidationKey)
    if (revalidatedRef !== undefined) {
      const revalidated = this.#store.getToolRevision(revalidatedRef)
      if (revalidated === null) {
        throw new AutomaticTypeUpgradeError(
          'work-contract-successor-missing',
          `automatic tool successor is unavailable: ${revalidatedRef.id}@${revalidatedRef.revision}`,
        )
      }
      this.#assertTargetToolRevision(revalidated, targetTypeRef, workItemRef)
      return revalidated.ref
    }
    const id = automaticUpgradeResourceId('tool', {
      targetTypeRef,
      ownerUserId: migration.sourceRecord.ownerUserId,
      content: migration.content,
    })
    const existing = this.#publishedAutomaticToolRevision({
      id,
      sourceRecord: migration.sourceRecord,
      targetTypeRef,
      workItemRef,
      content: migration.content,
    })
    if (existing !== null) return existing

    if (contentDigest(migration.sourceContract) !== contentDigest(migration.targetContract)) {
      const failure = this.#automaticToolRevalidationFailures.get(revalidationKey)
      if (failure !== undefined) throw failure
      this.#pendingAutomaticToolRevalidations.set(revalidationKey, pending)
      throw new AutomaticTypeUpgradeError(
        'work-contract-revalidation-pending',
        `target WorkContract validation is pending for ${targetTypeRef.typeId}/${workItemRef}`,
      )
    }

    return this.#persistAutomaticToolRevision({
      id,
      sourceRecord: migration.sourceRecord,
      targetTypeRef,
      workItemRef,
      content: migration.content,
      validationReceipt: migration.source.validationReceipt,
    })
  }

  #automaticToolMigrationCandidate(
    sourceRef: ExactResourceRef,
    sourceTypeRef: EmployeeTypeRef,
    targetTypeRef: EmployeeTypeRef,
    workItemRef: string,
  ) {
    const source = this.#store.getToolRevision(sourceRef)
    const sourceRecord = this.#store.getTool(sourceRef.id)
    if (
      source === null ||
      sourceRecord === null ||
      source.state !== 'published' ||
      sourceRecord.retiredAt !== null ||
      !sameType(source.content.typeRef, sourceTypeRef)
    ) {
      throw new AutomaticTypeUpgradeError(
        'tool-revision-unavailable',
        `custom tool is not an active published revision: ${sourceRef.id}@${sourceRef.revision}`,
      )
    }
    if (
      source.content.typeRef.typeId !== targetTypeRef.typeId ||
      source.content.typeRef.revision >= targetTypeRef.revision ||
      source.content.workItemRef !== workItemRef
    ) {
      throw new AutomaticTypeUpgradeError(
        'tool-source-type-invalid',
        `custom tool does not belong to an older ${targetTypeRef.typeId}/${workItemRef} closure`,
      )
    }
    if (source.validationReceipt.status !== 'valid') {
      throw new AutomaticTypeUpgradeError(
        'tool-validation-invalid',
        `custom tool validation receipt is not valid: ${sourceRef.id}@${sourceRef.revision}`,
      )
    }

    const sourceDescriptor = this.#descriptor(source.content.typeRef)
    const targetDescriptor = this.#descriptor(targetTypeRef)
    const sourceContract = findWorkContract(sourceDescriptor, source.content.workContractRef)
    const targetItem = findWorkItem(targetDescriptor, workItemRef)
    const targetRoleContractRef =
      targetItem === null ? null : workContractRefForToolRole(targetItem, source.content.roleRef)
    const targetContract =
      targetRoleContractRef === null
        ? null
        : findWorkContract(targetDescriptor, targetRoleContractRef)
    if (
      sourceContract === null ||
      targetItem === null ||
      targetItem.nodeKind !== 'business-tool' ||
      targetContract === null
    ) {
      throw new AutomaticTypeUpgradeError(
        'work-contract-changed',
        `work contract changed for ${targetTypeRef.typeId}/${workItemRef}`,
      )
    }
    if (findToolRole(targetItem, source.content.roleRef) === null) {
      throw new AutomaticTypeUpgradeError(
        'tool-role-changed',
        `tool role is not present in the target work item: ${source.content.roleRef}`,
      )
    }

    const content = toolRegistrationContentSchema.parse({
      ...source.content,
      typeRef: targetTypeRef,
      workContractRef: targetRoleContractRef,
      connectionRef: null,
    })
    return { source, sourceRecord, sourceContract, targetContract, content }
  }

  #publishedAutomaticToolRevision(input: {
    readonly id: string
    readonly sourceRecord: ToolDraftRecord
    readonly targetTypeRef: EmployeeTypeRef
    readonly workItemRef: string
    readonly content: ToolRegistrationContent
  }): ExactResourceRef | null {
    const target = this.#store.getTool(input.id)
    if (target === null) return null
    if (
      !sameType(target.typeRef, input.targetTypeRef) ||
      target.workItemRef !== input.workItemRef ||
      target.ownerUserId !== input.sourceRecord.ownerUserId ||
      target.retiredAt !== null
    ) {
      throw new AutomaticTypeUpgradeError(
        'tool-migration-identity-conflict',
        `automatic tool migration identity conflicts with an existing resource: ${input.id}`,
      )
    }
    if (target.publishedRevision === null) return null
    const published = this.#store.getToolRevision({
      id: target.id,
      revision: target.publishedRevision,
    })
    if (
      published === null ||
      published.state !== 'published' ||
      published.validationReceipt.status !== 'valid' ||
      published.validationReceipt.contractRef.contractId !==
        input.content.workContractRef.contractId ||
      published.validationReceipt.contractRef.version !== input.content.workContractRef.version ||
      contentDigest(published.content) !== contentDigest(input.content)
    ) {
      throw new AutomaticTypeUpgradeError(
        'tool-migration-content-conflict',
        `automatic tool migration content conflicts with ${input.id}@${target.publishedRevision}`,
      )
    }
    return published.ref
  }

  #persistAutomaticToolRevision(input: {
    readonly id: string
    readonly sourceRecord: ToolDraftRecord
    readonly targetTypeRef: EmployeeTypeRef
    readonly workItemRef: string
    readonly content: ToolRegistrationContent
    readonly validationReceipt: ToolValidationReceipt
  }): ExactResourceRef {
    const published = this.#publishedAutomaticToolRevision(input)
    if (published !== null) return published

    let target = this.#store.getTool(input.id)
    if (target === null) {
      const now = this.#now()
      this.#store.createTool({
        id: input.id,
        typeRef: input.targetTypeRef,
        workItemRef: input.workItemRef,
        content: input.content,
        validationReceipt: input.validationReceipt,
        publishedRevision: null,
        ownerUserId: input.sourceRecord.ownerUserId,
        // RFC-330 D18' —— successor 继承 source 的归属与可见性（grants 不继承）。
        visibility: input.sourceRecord.visibility,
        createdAt: now,
        updatedAt: now,
        retiredAt: null,
      })
      target = this.#store.getTool(input.id)
    }
    if (
      target === null ||
      !sameType(target.typeRef, input.targetTypeRef) ||
      target.workItemRef !== input.workItemRef ||
      target.ownerUserId !== input.sourceRecord.ownerUserId ||
      target.retiredAt !== null
    ) {
      throw new AutomaticTypeUpgradeError(
        'tool-migration-identity-conflict',
        `automatic tool migration identity conflicts with an existing resource: ${input.id}`,
      )
    }
    if (
      contentDigest(target.content) !== contentDigest(input.content) ||
      target.validationReceipt.status !== 'valid' ||
      target.validationReceipt.contractRef.contractId !==
        input.content.workContractRef.contractId ||
      target.validationReceipt.contractRef.version !== input.content.workContractRef.version
    ) {
      throw new AutomaticTypeUpgradeError(
        'tool-migration-content-conflict',
        `automatic tool migration draft conflicts with the expected content: ${input.id}`,
      )
    }
    const revision: ToolRevisionRecord = {
      ref: { id: input.id, revision: 1 },
      content: input.content,
      contentDigest: contentDigest(input.content),
      validationReceipt: target.validationReceipt,
      state: 'published',
      publishedAt: this.#now(),
      publishedBy: null,
    }
    this.#store.publishTool(revision)
    return revision.ref
  }

  async #revalidateAutomaticToolRevision(input: PendingAutomaticToolRevalidation): Promise<void> {
    const migration = this.#automaticToolMigrationCandidate(
      input.sourceRef,
      input.sourceTypeRef,
      input.targetTypeRef,
      input.workItemRef,
    )
    const targetRuntime = this.#runtime(input.targetTypeRef)
    let content = migration.content
    let validationReceipt = await this.#validateTool(targetRuntime, content)
    if (
      validationReceipt.status !== 'valid' &&
      migration.source.content.implementation.kind === 'program' &&
      targetRuntime.upgradeProgramSource !== undefined
    ) {
      const sourceImplementation = migration.source.content.implementation
      const sourceArtifact = this.#programArtifacts.read(sourceImplementation)
      if (sourceArtifact === null) {
        throw new AutomaticTypeUpgradeError(
          'program-source-unavailable',
          `program source is unavailable for ${input.sourceRef.id}@${input.sourceRef.revision}`,
        )
      }
      const upgraded = targetRuntime.upgradeProgramSource({
        sourceContract: migration.sourceContract,
        targetContract: migration.targetContract,
        implementation: sourceImplementation,
        source: sourceArtifact.source,
      })
      if (upgraded !== null) {
        const upgradedArtifact = await this.#programArtifacts.put({
          runtimeKind: upgraded.runtimeKind,
          source: upgraded.source,
          parameterValues: sourceArtifact.parameterValues,
        })
        content = toolRegistrationContentSchema.parse({
          ...migration.content,
          implementation: {
            ...sourceImplementation,
            runtimeKind: upgraded.runtimeKind,
            executableArtifactRef: upgradedArtifact.executableArtifactRef,
            executableDigest: upgradedArtifact.executableDigest,
            parameterValuesRef: upgradedArtifact.parameterValuesRef,
          },
        })
        validationReceipt = await this.#validateTool(targetRuntime, content)
      }
    }
    if (validationReceipt.status !== 'valid') {
      const failedChecks = validationReceipt.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.code}: ${check.detail}`)
        .join('; ')
      throw new AutomaticTypeUpgradeError(
        'work-contract-successor-invalid',
        `target WorkContract rejected ${input.sourceRef.id}@${input.sourceRef.revision}${failedChecks.length === 0 ? '' : `; ${failedChecks}`}`,
      )
    }
    const id = automaticUpgradeResourceId('tool', {
      targetTypeRef: input.targetTypeRef,
      ownerUserId: migration.sourceRecord.ownerUserId,
      content,
    })
    const successorRef = this.#persistAutomaticToolRevision({
      id,
      sourceRecord: migration.sourceRecord,
      targetTypeRef: input.targetTypeRef,
      workItemRef: input.workItemRef,
      content,
      validationReceipt,
    })
    this.#automaticToolRevalidatedSuccessors.set(automaticToolRevalidationKey(input), successorRef)
  }

  #assertTargetToolRevision(
    revision: ToolRevisionRecord,
    targetTypeRef: EmployeeTypeRef,
    workItemRef: string,
  ): void {
    const item = findWorkItem(this.#runtime(targetTypeRef).descriptor, workItemRef)
    const expectedContractRef =
      item === null ? null : workContractRefForToolRole(item, revision.content.roleRef)
    if (
      revision.state !== 'published' ||
      revision.validationReceipt.status !== 'valid' ||
      !sameType(revision.content.typeRef, targetTypeRef) ||
      revision.content.workItemRef !== workItemRef ||
      item === null ||
      item.nodeKind !== 'business-tool' ||
      expectedContractRef === null ||
      expectedContractRef.contractId !== revision.content.workContractRef.contractId ||
      expectedContractRef.version !== revision.content.workContractRef.version ||
      findToolRole(item, revision.content.roleRef) === null
    ) {
      throw new AutomaticTypeUpgradeError(
        'platform-tool-successor-invalid',
        `platform tool successor does not close ${typeKey(targetTypeRef)}/${workItemRef}`,
      )
    }
  }

  #automaticallyUpgradeJobTemplate(
    sourceRef: ExactResourceRef,
    targetTypeRef: EmployeeTypeRef,
  ): ExactResourceRef {
    const source = this.#store.getJobTemplateRevision(sourceRef)
    const sourceRecord = this.#store.getJobTemplate(sourceRef.id)
    if (
      source === null ||
      sourceRecord === null ||
      sourceRecord.archivedAt !== null ||
      source.content.typeRef.typeId !== targetTypeRef.typeId ||
      source.content.typeRef.revision >= targetTypeRef.revision
    ) {
      throw new AutomaticTypeUpgradeError(
        'job-template-revision-unavailable',
        `job template is not an active older revision: ${sourceRef.id}@${sourceRef.revision}`,
      )
    }
    const defaultCollaborationBindings = source.content.defaultCollaborationBindings.map(
      (binding) => this.#resolveAutomaticCollaborationBinding(binding),
    )
    for (const binding of defaultCollaborationBindings) {
      this.#assertAutomaticCollaborationCompatibility(
        source.content.typeRef,
        targetTypeRef,
        binding,
      )
    }
    const defaultAdapterBindings = this.#projectLegacyAdapterBindings({
      targetTypeRef,
      toolBindings: source.content.defaultToolBindings,
      explicitBindings: source.content.defaultAdapterBindings,
      requireForEnabledLanes: true,
      subject: ownerVisibilitySubject(sourceRecord.ownerUserId),
    })
    const targetDescriptor = this.#runtime(targetTypeRef).descriptor
    const defaultToolBindings = source.content.defaultToolBindings
      .filter((binding) => {
        const item = findWorkItem(targetDescriptor, binding.workItemRef)
        return item?.nodeKind === 'business-tool' && findToolSlot(item, binding.slotRef) !== null
      })
      .map((binding) => ({
        ...binding,
        registrationRef: this.#automaticallyUpgradeToolRevision(
          binding.registrationRef,
          source.content.typeRef,
          targetTypeRef,
          binding.workItemRef,
        ),
      }))
    const reconciledOrderedDispatchConfigurations =
      this.#reconcileAutomaticOrderedDispatchConfigurations(
        targetTypeRef,
        source.content.orderedDispatchConfigurations,
        defaultToolBindings,
      )
    const orderedDispatchConfigurations = reconciledOrderedDispatchConfigurations.map(
      (configuration) => ({
        ...configuration,
        routes: configuration.routes.map((route) => ({
          ...route,
          registrationRef:
            route.registrationRef === null
              ? null
              : this.#automaticallyUpgradeToolRevision(
                  route.registrationRef,
                  source.content.typeRef,
                  targetTypeRef,
                  route.destinationWorkItemRef,
                ),
        })),
      }),
    )
    const content = employeeJobTemplateContentSchema.parse({
      ...source.content,
      typeRef: targetTypeRef,
      defaultToolBindings,
      defaultAdapterBindings,
      defaultCollaborationBindings,
      orderedDispatchConfigurations,
      reactionLaneOrder: this.#normalizeReactionLaneOrder(
        targetTypeRef,
        source.content.reactionLaneOrder,
      ),
    })
    this.#assertJobTemplateContentPublishable(content)

    const targetJobs = this.#store.listJobTemplates(targetTypeRef)
    const preferredId = automaticUpgradeResourceId('job', {
      targetTypeRef,
      ownerUserId: sourceRecord.ownerUserId,
      name: sourceRecord.name,
      content,
    })
    // RFC-330 D17' —— 名字唯一域是 (owner, type, typeRevision, name)：只有**同 owner** 的
    // 同名模版才是占位；其它 owner 的同名模版与 successor 互不影响。
    const preferred = targetJobs.find(
      (candidate) =>
        candidate.name === sourceRecord.name && candidate.ownerUserId === sourceRecord.ownerUserId,
    )
    let preferredMatches = preferred === undefined
    if (
      preferred?.ownerUserId === sourceRecord.ownerUserId &&
      preferred.publishedRevision !== null
    ) {
      const published = this.#store.getJobTemplateRevision({
        id: preferred.id,
        revision: preferred.publishedRevision,
      })
      preferredMatches =
        published !== null && contentDigest(published.content) === contentDigest(content)
    } else if (preferred?.ownerUserId === sourceRecord.ownerUserId) {
      preferredMatches =
        preferred.id === preferredId && contentDigest(preferred.draft) === contentDigest(content)
    }
    const targetName = preferredMatches
      ? sourceRecord.name
      : automaticUpgradeJobName({
          sourceName: sourceRecord.name,
          sourceTypeRef: source.content.typeRef,
          content,
        })
    const id = automaticUpgradeResourceId('job', {
      targetTypeRef,
      ownerUserId: sourceRecord.ownerUserId,
      name: targetName,
      content,
    })
    const exactTarget = this.#store.getJobTemplate(id)
    const sameNameTarget = targetJobs.find(
      (candidate) =>
        candidate.name === targetName && candidate.ownerUserId === sourceRecord.ownerUserId,
    )
    let target = exactTarget ?? sameNameTarget ?? null
    if (target === null) {
      const now = this.#now()
      this.#store.createJobTemplate({
        id,
        typeRef: targetTypeRef,
        name: targetName,
        draft: content,
        publishedRevision: null,
        ownerUserId: sourceRecord.ownerUserId,
        // RFC-330 D18' —— successor 继承 source 的归属与可见性（grants 不继承）。
        visibility: sourceRecord.visibility,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      })
      target = this.#store.getJobTemplate(id)
    }
    if (
      target === null ||
      !sameType(target.typeRef, targetTypeRef) ||
      target.name !== targetName ||
      target.ownerUserId !== sourceRecord.ownerUserId ||
      target.archivedAt !== null
    ) {
      throw new AutomaticTypeUpgradeError(
        'job-template-migration-identity-conflict',
        `automatic job migration identity conflicts with an existing resource: ${targetName}`,
      )
    }
    if (target.publishedRevision !== null) {
      const published = this.#store.getJobTemplateRevision({
        id: target.id,
        revision: target.publishedRevision,
      })
      if (published === null || contentDigest(published.content) !== contentDigest(content)) {
        throw new AutomaticTypeUpgradeError(
          'job-template-migration-content-conflict',
          `automatic job migration content conflicts with ${target.id}@${target.publishedRevision}`,
        )
      }
      return published.ref
    }
    if (target.id !== id || contentDigest(target.draft) !== contentDigest(content)) {
      throw new AutomaticTypeUpgradeError(
        'job-template-migration-content-conflict',
        `automatic job migration draft conflicts with the expected content: ${targetName}`,
      )
    }
    const ref = { id, revision: 1 }
    this.#store.publishJobTemplate({
      ref,
      content,
      contentDigest: contentDigest(content),
      publishedAt: this.#now(),
      publishedBy: null,
    })
    return ref
  }

  #latestRegisteredTypeRevision(typeId: string): number | null {
    let latest: number | null = null
    for (const runtime of this.#types.values()) {
      if (runtime.descriptor.typeRef.typeId !== typeId) continue
      latest = Math.max(latest ?? 0, runtime.descriptor.typeRef.revision)
    }
    return latest
  }

  /**
   * A provider Adapter can be published after an otherwise current employee.
   * Freeze the newly available exact revision into a system-authored employee
   * successor so external work starts without a user migration/edit step.
   */
  #automaticallyReconcileCompatibleAdapterBindings(): void {
    const employees = this.#store
      .listEmployeeDefinitions()
      .filter(
        (employee) =>
          employee.currentRevision !== null &&
          this.#latestRegisteredTypeRevision(employee.typeRef.typeId) === employee.typeRef.revision,
      )
      .sort((left, right) => left.id.localeCompare(right.id))

    for (const employee of employees) {
      try {
        const currentRevision = employee.currentRevision
        if (currentRevision === null) continue
        const current = this.#store.getEmployeeDefinitionRevision({
          id: employee.id,
          revision: currentRevision,
        })
        if (current === null) continue
        const projected = this.#projectLegacyAdapterBindings({
          targetTypeRef: employee.typeRef,
          toolBindings: current.content.exactToolBindings,
          explicitBindings: current.content.exactAdapterBindings,
          requireForEnabledLanes: true,
          subject: ownerVisibilitySubject(employee.ownerUserId),
        })
        const exactKeys = new Set(
          current.content.exactAdapterBindings.map(
            (binding) => `${binding.laneId}\u0000${binding.slotRef}`,
          ),
        )
        const additions = projected.filter(
          (binding) => !exactKeys.has(`${binding.laneId}\u0000${binding.slotRef}`),
        )
        if (additions.length === 0) continue

        const configuration = digitalEmployeeDefinitionDraftSchema.parse({
          ...employee.configuration,
          adapterOverrides: [...employee.configuration.adapterOverrides, ...additions],
        })
        const candidate: EmployeeDefinitionRecord = {
          ...employee,
          configuration,
          updatedAt: this.#now(),
        }
        const compiled = this.#compileEmployeeDefinition(candidate, null, null)
        this.#store.saveEmployeeDefinition({
          ...compiled,
          definitionMutation: {
            kind: 'update',
            expectedTypeRef: employee.typeRef,
            targetTypeRef: employee.typeRef,
            name: employee.name,
            configuration,
            updatedAt: compiled.revision.createdAt,
          },
        })
      } catch (error) {
        this.#reportAutomaticUpgradeIssue(
          {
            sourceTypeRef: employee.typeRef,
            targetTypeRef: employee.typeRef,
            resourceKind: 'employee',
            resourceId: employee.id,
          },
          error,
        )
      }
    }
  }

  #resolveAutomaticCollaborationBinding(
    binding: EmployeeCollaborationBinding,
  ): EmployeeCollaborationBinding {
    const frozenTarget = this.#store.getEmployeeDefinitionRevision(binding.targetEmployeeRef)
    if (frozenTarget === null) return binding
    const currentTypeRevision = this.#latestRegisteredTypeRevision(
      frozenTarget.content.typeRef.typeId,
    )
    if (
      currentTypeRevision === null ||
      frozenTarget.content.typeRef.revision > currentTypeRevision
    ) {
      return binding
    }
    const currentTarget = this.#store.getEmployeeDefinition(binding.targetEmployeeRef.id)
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
    const successor = this.#store.getEmployeeDefinitionRevision(successorRef)
    if (
      successor === null ||
      successor.createdBy !== null ||
      successor.content.typeRef.typeId !== frozenTarget.content.typeRef.typeId ||
      successor.content.typeRef.revision !== currentTypeRevision
    ) {
      return binding
    }
    return employeeCollaborationBindingSchema.parse({
      ...binding,
      targetEmployeeRef: successorRef,
    })
  }

  #automaticallyReconcileCompatibleCollaborationTargets(): void {
    const employees = this.#store
      .listEmployeeDefinitions()
      .filter(
        (employee) =>
          employee.currentRevision !== null &&
          this.#latestRegisteredTypeRevision(employee.typeRef.typeId) === employee.typeRef.revision,
      )
    const employeeById = new Map(employees.map((employee) => [employee.id, employee] as const))
    const currentById = new Map(
      employees.flatMap((employee) => {
        const current = this.#store.getEmployeeDefinitionRevision({
          id: employee.id,
          revision: employee.currentRevision!,
        })
        return current === null ? [] : ([[employee.id, current]] as const)
      }),
    )
    const visitState = new Map<string, 'visiting' | 'visited'>()
    const stack: string[] = []
    const cyclicIds = new Set<string>()
    const orderedIds: string[] = []
    const visit = (employeeId: string): void => {
      const state = visitState.get(employeeId)
      if (state === 'visited') return
      if (state === 'visiting') {
        const cycleStart = stack.lastIndexOf(employeeId)
        for (const id of stack.slice(Math.max(0, cycleStart))) cyclicIds.add(id)
        return
      }
      visitState.set(employeeId, 'visiting')
      stack.push(employeeId)
      const current = currentById.get(employeeId)
      for (const targetId of [
        ...new Set(
          current?.content.exactCollaborationBindings.map(
            (binding) => binding.targetEmployeeRef.id,
          ) ?? [],
        ),
      ].sort()) {
        if (employeeById.has(targetId)) visit(targetId)
      }
      stack.pop()
      visitState.set(employeeId, 'visited')
      orderedIds.push(employeeId)
    }
    for (const employeeId of [...employeeById.keys()].sort()) visit(employeeId)

    for (const employeeId of [...cyclicIds].sort()) {
      const employee = employeeById.get(employeeId)!
      this.#reportAutomaticUpgradeIssue(
        {
          sourceTypeRef: employee.typeRef,
          targetTypeRef: employee.typeRef,
          resourceKind: 'employee',
          resourceId: employee.id,
        },
        new AutomaticTypeUpgradeError(
          'collaboration-cycle',
          `automatic collaboration reconciliation found a cycle containing ${employee.id}`,
        ),
      )
    }

    for (const employeeId of orderedIds) {
      if (cyclicIds.has(employeeId)) continue
      const employee = this.#store.getEmployeeDefinition(employeeId)
      if (employee === null || employee.currentRevision === null) continue
      try {
        const current = this.#store.getEmployeeDefinitionRevision({
          id: employee.id,
          revision: employee.currentRevision,
        })
        if (current === null) continue
        const resolvedBindings = current.content.exactCollaborationBindings.map((binding) =>
          this.#resolveAutomaticCollaborationBinding(binding),
        )
        const changedWorkItems = new Set(
          current.content.exactCollaborationBindings.flatMap((binding, index) =>
            binding.targetEmployeeRef.id !== resolvedBindings[index]?.targetEmployeeRef.id ||
            binding.targetEmployeeRef.revision !==
              resolvedBindings[index]?.targetEmployeeRef.revision
              ? [binding.workItemRef]
              : [],
          ),
        )
        if (changedWorkItems.size === 0) continue
        const collaborationOverrides = [
          ...employee.configuration.collaborationOverrides.filter(
            (binding) => !changedWorkItems.has(binding.workItemRef),
          ),
          ...resolvedBindings.filter((binding) => changedWorkItems.has(binding.workItemRef)),
        ]
        const configuration = digitalEmployeeDefinitionDraftSchema.parse({
          ...employee.configuration,
          collaborationOverrides,
        })
        const candidate: EmployeeDefinitionRecord = {
          ...employee,
          configuration,
          updatedAt: this.#now(),
        }
        const compiled = this.#compileEmployeeDefinition(candidate, null, null)
        this.#store.saveEmployeeDefinition({
          ...compiled,
          definitionMutation: {
            kind: 'update',
            expectedTypeRef: employee.typeRef,
            targetTypeRef: employee.typeRef,
            name: employee.name,
            configuration,
            updatedAt: compiled.revision.createdAt,
          },
        })
      } catch (error) {
        this.#reportAutomaticUpgradeIssue(
          {
            sourceTypeRef: employee.typeRef,
            targetTypeRef: employee.typeRef,
            resourceKind: 'employee',
            resourceId: employee.id,
          },
          error,
        )
      }
    }
  }

  #assertAutomaticCollaborationCompatibility(
    sourceTypeRef: EmployeeTypeRef,
    targetTypeRef: EmployeeTypeRef,
    binding: EmployeeCollaborationBinding,
  ): void {
    const sourceDescriptor = this.#descriptor(sourceTypeRef)
    const targetDescriptor = this.#descriptor(targetTypeRef)
    const sourceItem = findWorkItem(sourceDescriptor, binding.workItemRef)
    const targetItem = findWorkItem(targetDescriptor, binding.workItemRef)
    const sourceContract = sourceDescriptor.invocationContracts.find(
      (contract) => contract.contractId === binding.invocationContractId,
    )
    const targetContract = targetDescriptor.invocationContracts.find(
      (contract) => contract.contractId === binding.invocationContractId,
    )
    if (
      sourceItem === null ||
      sourceItem.nodeKind !== 'collaboration' ||
      sourceItem.collaborationContractId !== binding.invocationContractId ||
      targetItem === null ||
      targetItem.nodeKind !== 'collaboration' ||
      targetItem.collaborationContractId !== binding.invocationContractId ||
      sourceContract === undefined ||
      targetContract === undefined ||
      contentDigest(sourceContract) !== contentDigest(targetContract)
    ) {
      throw new AutomaticTypeUpgradeError(
        'invocation-contract-changed',
        `invocation contract changed for ${targetTypeRef.typeId}/${binding.workItemRef}`,
      )
    }
  }

  #assertJobTemplateContentPublishable(content: EmployeeJobTemplateContent): void {
    for (const binding of content.defaultToolBindings) {
      this.#validateBinding(content.typeRef, binding)
    }
    for (const binding of content.defaultCollaborationBindings) {
      this.#validateCollaborationBinding(content.typeRef, binding)
    }
    validateCollaborationGroups(content.defaultCollaborationBindings)
    const enabledWorkItemRefs = this.#enabledWorkItemRefs({
      typeRef: content.typeRef,
      toolBindings: content.defaultToolBindings,
      collaborationBindings: content.defaultCollaborationBindings,
      orderedDispatchConfigurations: content.orderedDispatchConfigurations,
    })
    const merged = mergeExactToolBindings({
      manifest: this.#runtime(content.typeRef).descriptor.authoringManifest,
      defaults: content.defaultToolBindings,
      overrides: [],
      enabledWorkItemRefs,
    })
    if (merged.violations.length > 0) {
      throw new ValidationError(
        'employee-job-template-bindings-incomplete',
        'automatically migrated job template does not cover every required work-item tool slot',
        { violations: merged.violations },
      )
    }
    const adapterBindings = mergeExactAdapterBindings({
      manifest: this.#runtime(content.typeRef).descriptor.authoringManifest,
      defaults: content.defaultAdapterBindings,
      overrides: [],
      enabledWorkItemRefs,
    })
    if (adapterBindings.violations.length > 0) {
      throw new ValidationError(
        'employee-job-template-adapter-bindings-incomplete',
        'automatically migrated job template does not cover every required lane Adapter slot',
        { violations: adapterBindings.violations },
      )
    }
    for (const binding of adapterBindings.bindings) {
      this.#validateAdapterBinding(content.typeRef, binding, null)
    }
    this.#validateOrderedDispatchConfigurations(
      content.typeRef,
      content.orderedDispatchConfigurations,
      content.defaultToolBindings,
      enabledWorkItemRefs,
    )
  }

  async #materializeImplementation(
    authored: CreateToolRegistrationBody['implementation'],
  ): Promise<ToolImplementation> {
    if (authored.kind !== 'program') return authored
    const artifact = await this.#programArtifacts.put({
      runtimeKind: authored.runtimeKind,
      source: authored.source,
      parameterValues: authored.parameterValues ?? null,
    })
    return {
      kind: 'program',
      runtimeKind: authored.runtimeKind,
      executableArtifactRef: artifact.executableArtifactRef,
      executableDigest: artifact.executableDigest,
      parameterValuesRef: artifact.parameterValuesRef,
      runtimeProfileRef: authored.runtimeProfileRef,
    }
  }

  #exactTool(input: {
    readonly typeRef: EmployeeTypeRef
    readonly workItemRef: string
    readonly toolId: string
  }): ToolDraftRecord {
    if (this.#platformTools.isPlatformTool(input.toolId)) {
      throw new ConflictError(
        'employee-platform-tool-readonly',
        `platform tool is immutable: ${input.toolId}`,
      )
    }
    const tool = this.#store.getTool(input.toolId)
    if (
      tool === null ||
      !sameType(tool.typeRef, input.typeRef) ||
      tool.workItemRef !== input.workItemRef ||
      tool.retiredAt !== null
    ) {
      throw new NotFoundError(
        'employee-tool-not-found',
        `tool registration not found: ${input.toolId}`,
      )
    }
    return tool
  }

  async #prepareToolDraft(input: {
    readonly typeRef: EmployeeTypeRef
    readonly workItemRef: string
    readonly body: unknown
  }): Promise<{
    readonly content: ToolRegistrationContent
    readonly validationReceipt: ToolValidationReceipt
  }> {
    if (
      typeof input.body === 'object' &&
      input.body !== null &&
      Object.prototype.hasOwnProperty.call(input.body, 'connectionRef')
    ) {
      throw new ValidationError(
        'tool-connection-moved-to-employee-binding',
        'connectionRef is configured by the lane Adapter card on a job template or employee',
      )
    }
    const runtime = this.#runtime(input.typeRef)
    const item = findWorkItem(runtime.descriptor, input.workItemRef)
    if (item === null) {
      throw new NotFoundError(
        'employee-work-item-not-found',
        `work item not found: ${input.workItemRef}`,
      )
    }
    if (item.nodeKind !== 'business-tool') {
      throw new ConflictError(
        'employee-work-item-does-not-accept-tools',
        `${input.workItemRef} is a ${item.nodeKind} node`,
      )
    }
    const body = createToolRegistrationBodySchema.parse(input.body)
    const role = findToolRole(item, body.roleRef)
    if (role === null) {
      throw new ValidationError(
        'employee-tool-role-invalid',
        `${body.roleRef} is not defined by ${input.workItemRef}`,
      )
    }
    const roleContractRef = workContractRefForToolRole(item, role.roleRef)
    if (roleContractRef === null) throw new Error(`type package lost role for ${item.workItemRef}`)
    const contract = findWorkContract(runtime.descriptor, roleContractRef)
    if (contract === null) throw new Error(`type package lost contract for ${item.workItemRef}`)
    const dispatchSources = runtime.descriptor.authoringManifest.workItems.filter((source) =>
      source.orderedDispatchAuthoring?.destinationWorkItemRefs.includes(item.workItemRef),
    )
    if (item.orderedDispatchAuthoring !== null && body.dispatchRouteDefinitions === undefined) {
      throw new ValidationError(
        'employee-tool-dispatch-routes-required',
        'classifier tools must define their ordered dispatch routes',
      )
    }
    if (item.orderedDispatchAuthoring === null && body.dispatchRouteDefinitions !== undefined) {
      throw new ValidationError(
        'employee-tool-dispatch-routes-unexpected',
        `${item.workItemRef} is not an ordered dispatch classifier`,
      )
    }
    if (dispatchSources.length > 0 && body.acceptedDispatchRoutes === undefined) {
      throw new ValidationError(
        'employee-tool-dispatch-capability-required',
        'dispatch destination tools must declare accepted routes',
      )
    }
    for (const accepted of body.acceptedDispatchRoutes ?? []) {
      if (
        !dispatchSources.some((source) => source.workItemRef === accepted.classifierWorkItemRef)
      ) {
        throw new ValidationError(
          'employee-tool-dispatch-classifier-invalid',
          `${accepted.classifierWorkItemRef} does not dispatch to ${item.workItemRef}`,
        )
      }
    }
    const implementation = await this.#materializeImplementation(body.implementation)
    const content = toolRegistrationContentSchema.parse({
      schemaVersion: 1,
      typeRef: input.typeRef,
      workItemRef: item.workItemRef,
      workContractRef: roleContractRef,
      roleRef: role.roleRef,
      displayName: body.displayName,
      description: body.description,
      implementation,
      connectionRef: null,
      ...(body.dispatchRouteDefinitions === undefined
        ? {}
        : { dispatchRouteDefinitions: body.dispatchRouteDefinitions }),
      ...(body.acceptedDispatchRoutes === undefined
        ? {}
        : { acceptedDispatchRoutes: body.acceptedDispatchRoutes }),
    })
    return {
      content,
      validationReceipt: await this.#validateTool(runtime, content),
    }
  }

  async #validateTool(
    runtime: EmployeeTypeRuntimePackage,
    content: ToolRegistrationContent,
  ): Promise<ToolValidationReceipt> {
    const contract = findWorkContract(runtime.descriptor, content.workContractRef)
    if (contract === null) {
      throw new ConflictError(
        'employee-work-contract-missing',
        `${content.workContractRef.contractId}@${content.workContractRef.version} is no longer registered`,
      )
    }
    const checks: ContractValidationCheck[] = [
      ...runtime.validateContractFixture({ contract, implementation: content.implementation }),
    ]
    const receipt = await this.#executionContracts.validateExecutor({
      contractRef: { contractId: contract.contractId, version: contract.version },
      implementation: content.implementation,
    })
    checks.push(...receipt.checks)
    return buildToolValidationReceipt({
      contract,
      implementation: content.implementation,
      checks,
      checkedAt: this.#now(),
    })
  }

  async createTool(input: {
    typeRef: EmployeeTypeRef
    workItemRef: string
    body: unknown
    ownerUserId: string | null
  }): Promise<ToolDraftRecord> {
    const { content, validationReceipt } = await this.#prepareToolDraft(input)
    const now = this.#now()
    const record: ToolDraftRecord = {
      id: this.#id(),
      typeRef: input.typeRef,
      workItemRef: input.workItemRef,
      content,
      validationReceipt,
      publishedRevision: null,
      ownerUserId: input.ownerUserId,
      // RFC-330 D3 —— 新建默认 private（与 RFC-231 全站默认一致）。
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
    }
    this.#store.createTool(record)
    return record
  }

  listTools(typeRef: EmployeeTypeRef, workItemRef: string): ToolDraftRecord[] {
    // Store-backed on purpose: a Case frozen on an older revision deep-links
    // this panel, and listing rows needs the frozen descriptor, not a codec.
    const item = findWorkItem(this.#descriptor(typeRef), workItemRef)
    if (item === null) {
      throw new NotFoundError('employee-work-item-not-found', `work item not found: ${workItemRef}`)
    }
    return [
      ...this.#platformTools.list(typeRef, workItemRef),
      ...this.#store.listTools(typeRef, workItemRef),
    ]
  }

  #toolRevision(ref: ExactResourceRef): ToolRevisionRecord | null {
    return this.#platformTools.getRevision(ref) ?? this.#store.getToolRevision(ref)
  }

  async getToolAuthoring(input: {
    readonly typeRef: EmployeeTypeRef
    readonly workItemRef: string
    readonly toolId: string
  }): Promise<{ readonly record: ToolDraftRecord; readonly body: CreateToolRegistrationBody }> {
    const record = this.#exactTool(input)
    const implementation: CreateToolRegistrationBody['implementation'] =
      record.content.implementation.kind === 'program'
        ? (() => {
            const artifact = this.#programArtifacts.read(record.content.implementation)
            if (artifact === null) {
              throw new ConflictError(
                'employee-program-artifact-unavailable',
                `program source is unavailable for tool registration: ${record.id}`,
              )
            }
            return {
              kind: 'program' as const,
              runtimeKind: record.content.implementation.runtimeKind,
              source: artifact.source,
              parameterValues: artifact.parameterValues ?? undefined,
              runtimeProfileRef: record.content.implementation.runtimeProfileRef,
            }
          })()
        : record.content.implementation
    return {
      record,
      body: createToolRegistrationBodySchema.parse({
        displayName: record.content.displayName,
        description: record.content.description,
        roleRef: record.content.roleRef,
        implementation,
        ...(record.content.dispatchRouteDefinitions === undefined
          ? {}
          : { dispatchRouteDefinitions: record.content.dispatchRouteDefinitions }),
        ...(record.content.acceptedDispatchRoutes === undefined
          ? {}
          : { acceptedDispatchRoutes: record.content.acceptedDispatchRoutes }),
      }),
    }
  }

  async updateTool(input: {
    readonly typeRef: EmployeeTypeRef
    readonly workItemRef: string
    readonly toolId: string
    readonly body: unknown
  }): Promise<ToolDraftRecord> {
    const existing = this.#exactTool(input)
    const { content, validationReceipt } = await this.#prepareToolDraft(input)
    this.#store.updateToolValidation(existing.id, content, validationReceipt, this.#now())
    return this.#exactTool(input)
  }

  async validateTool(input: {
    typeRef: EmployeeTypeRef
    workItemRef: string
    toolId: string
  }): Promise<ToolDraftRecord> {
    const runtime = this.#runtime(input.typeRef)
    const tool = this.#exactTool(input)
    const receipt = await this.#validateTool(runtime, tool.content)
    this.#store.updateToolValidation(tool.id, tool.content, receipt, this.#now())
    const updated = this.#store.getTool(tool.id)
    if (updated === null) throw new Error('tool vanished after validation')
    return updated
  }

  async publishTool(input: {
    typeRef: EmployeeTypeRef
    workItemRef: string
    toolId: string
    actorUserId: string | null
  }): Promise<ToolRevisionRecord> {
    const tool = await this.validateTool(input)
    if (tool.validationReceipt.status !== 'valid') {
      throw new ValidationError(
        'employee-tool-contract-invalid',
        'tool does not satisfy the work contract',
        { checks: tool.validationReceipt.checks.filter((check) => !check.ok) },
      )
    }
    const revision = nextRevision(tool.publishedRevision)
    const record: ToolRevisionRecord = {
      ref: { id: tool.id, revision },
      content: tool.content,
      contentDigest: contentDigest(tool.content),
      validationReceipt: tool.validationReceipt,
      state: 'published',
      publishedAt: this.#now(),
      publishedBy: input.actorUserId,
    }
    this.#store.publishTool(record)
    return record
  }

  retireTool(input: { typeRef: EmployeeTypeRef; workItemRef: string; toolId: string }): void {
    const tool = this.#exactTool(input)
    this.#store.retireTool(tool.id, this.#now())
  }

  #validateBinding(typeRef: EmployeeTypeRef, binding: WorkItemToolBinding): ToolRevisionRecord {
    const runtime = this.#runtime(typeRef)
    const item = findWorkItem(runtime.descriptor, binding.workItemRef)
    if (item === null) {
      throw new ValidationError(
        'employee-tool-binding-invalid',
        `unknown work item: ${binding.workItemRef}`,
      )
    }
    const slot = findToolSlot(item, binding.slotRef)
    if (slot === null) {
      throw new ValidationError(
        'employee-tool-binding-invalid',
        `unknown slot: ${binding.workItemRef}/${binding.slotRef}`,
      )
    }
    const tool = this.#toolRevision(binding.registrationRef)
    if (tool === null || tool.state !== 'published') {
      throw new ValidationError(
        'employee-tool-binding-invalid',
        `tool revision is not published: ${binding.registrationRef.id}@${binding.registrationRef.revision}`,
      )
    }
    const expectedContractRef = workContractRefForToolRole(item, slot.roleRef)
    if (
      !sameType(tool.content.typeRef, typeRef) ||
      tool.content.workItemRef !== binding.workItemRef ||
      tool.content.roleRef !== slot.roleRef ||
      expectedContractRef === null ||
      expectedContractRef.contractId !== tool.content.workContractRef.contractId ||
      expectedContractRef.version !== tool.content.workContractRef.version
    ) {
      throw new ValidationError(
        'employee-tool-binding-invalid',
        `tool revision does not belong to ${binding.workItemRef}/${binding.slotRef}`,
      )
    }
    return tool
  }

  #validateAdapterBinding(
    typeRef: EmployeeTypeRef,
    binding: LaneAdapterBinding,
    subject: ToolConnectionVisibilitySubject | null,
  ): string {
    const descriptor = this.#runtime(typeRef).descriptor
    const lane = descriptor.authoringManifest.lifecycleRegions
      .flatMap((region) => region.responsibilityLanes)
      .find((candidate) => candidate.laneId === binding.laneId)
    const slot = lane?.adapterSlots.find((candidate) => candidate.slotRef === binding.slotRef)
    if (lane === undefined || slot === undefined) {
      throw new ValidationError(
        'employee-adapter-binding-invalid',
        `unknown lane Adapter slot: ${binding.laneId}/${binding.slotRef}`,
      )
    }
    const projection = this.#connectionCatalog.resolve(binding.adapterRef, subject)
    if (projection === null) {
      throw new ValidationError(
        'employee-adapter-revision-unavailable',
        `Adapter revision is not published: ${binding.adapterRef.id}@${binding.adapterRef.revision}`,
      )
    }
    if (!projection.visible) {
      throw new ValidationError(
        'employee-adapter-revision-not-visible',
        `Adapter revision is not visible: ${binding.adapterRef.id}@${binding.adapterRef.revision}`,
      )
    }
    if (projection.purpose !== slot.purpose) {
      throw new ValidationError(
        'employee-adapter-purpose-mismatch',
        `${binding.laneId}/${binding.slotRef} requires ${slot.purpose}; resolved ${projection.purpose}`,
      )
    }
    if (!projection.available) {
      throw new ValidationError('employee-adapter-revision-archived', projection.closureSummary)
    }
    return projection.contentDigest
  }

  #projectLegacyAdapterBindings(input: {
    readonly targetTypeRef: EmployeeTypeRef
    readonly toolBindings: readonly WorkItemToolBinding[]
    readonly explicitBindings: readonly LaneAdapterBinding[]
    readonly requireForEnabledLanes: boolean
    readonly subject: ToolConnectionVisibilitySubject | null
  }): LaneAdapterBinding[] {
    const descriptor = this.#runtime(input.targetTypeRef).descriptor
    const manifest = descriptor.authoringManifest
    const explicitKeys = new Set(
      input.explicitBindings.map((binding) => `${binding.laneId}\u0000${binding.slotRef}`),
    )
    const projected: LaneAdapterBinding[] = []
    for (const region of manifest.lifecycleRegions) {
      for (const lane of region.responsibilityLanes) {
        const laneWorkItemRefs = new Set(
          manifest.workItems
            .filter(
              (item) =>
                item.regionId === region.regionId && item.responsibilityLaneId === lane.laneId,
            )
            .map((item) => item.workItemRef),
        )
        for (const slot of lane.adapterSlots) {
          const key = `${lane.laneId}\u0000${slot.slotRef}`
          if (explicitKeys.has(key)) continue
          const laneEnabled = input.toolBindings.some((binding) =>
            laneWorkItemRefs.has(binding.workItemRef),
          )
          const requiredByEnabledContract = input.toolBindings.some((binding) => {
            if (!laneWorkItemRefs.has(binding.workItemRef)) return false
            const item = findWorkItem(descriptor, binding.workItemRef)
            const tool = this.#toolRevision(binding.registrationRef)
            if (item === null || item.nodeKind !== 'business-tool' || tool === null) return false
            const contractRef = workContractRefForToolRole(item, tool.content.roleRef)
            const contract = contractRef === null ? null : findWorkContract(descriptor, contractRef)
            return contract?.requiredConnectionPurpose === slot.purpose
          })
          const candidates = new Map<string, ExactResourceRef>()
          for (const binding of input.toolBindings) {
            if (!laneWorkItemRefs.has(binding.workItemRef)) continue
            const connectionRef = this.#toolRevision(binding.registrationRef)?.content.connectionRef
            if (connectionRef === null || connectionRef === undefined) continue
            const projection = this.#connectionCatalog.resolve(connectionRef, input.subject)
            if (projection?.purpose !== slot.purpose) continue
            candidates.set(`${connectionRef.id}@${connectionRef.revision}`, connectionRef)
          }
          const historicalCandidates = [...candidates.values()]
          const bindingRequired =
            input.requireForEnabledLanes &&
            laneEnabled &&
            (slot.requiredWhenLaneEnabled || requiredByEnabledContract)
          const selected =
            historicalCandidates.length === 0 && !bindingRequired
              ? null
              : this.#connectionCatalog.selectAutomatic === undefined
                ? historicalCandidates.length === 1
                  ? this.#connectionCatalog.resolve(historicalCandidates[0]!, input.subject)
                  : null
                : this.#connectionCatalog.selectAutomatic({
                    purpose: slot.purpose,
                    candidates: historicalCandidates,
                    subject: input.subject,
                  })
          if (
            selected !== null &&
            selected.purpose === slot.purpose &&
            selected.available &&
            selected.visible
          ) {
            projected.push({
              laneId: lane.laneId,
              slotRef: slot.slotRef,
              adapterRef: selected.ref,
            })
          } else if (bindingRequired) {
            throw new AutomaticTypeUpgradeError(
              historicalCandidates.length > 1
                ? 'legacy-adapter-binding-ambiguous'
                : 'adapter-binding-missing',
              `${lane.laneId}/${slot.slotRef} has no compatible published Adapter available for automatic upgrade`,
            )
          }
        }
      }
    }
    return [...input.explicitBindings, ...projected]
  }

  #validateAdapterDraftBindings(
    typeRef: EmployeeTypeRef,
    bindings: readonly LaneAdapterBinding[],
    subject: ToolConnectionVisibilitySubject | null,
  ): void {
    const merged = mergeExactAdapterBindings({
      manifest: this.#runtime(typeRef).descriptor.authoringManifest,
      defaults: bindings,
      overrides: [],
      enabledWorkItemRefs: [],
    })
    if (merged.violations.length > 0) {
      throw new ValidationError(
        'employee-adapter-bindings-invalid',
        'lane Adapter bindings contain an unknown or duplicate slot',
        { violations: merged.violations },
      )
    }
    for (const binding of merged.bindings) {
      this.#validateAdapterBinding(typeRef, binding, subject)
    }
  }

  #reconcileAutomaticOrderedDispatchConfigurations(
    typeRef: EmployeeTypeRef,
    configurations: readonly OrderedDispatchConfiguration[],
    toolBindings: readonly WorkItemToolBinding[],
  ): OrderedDispatchConfiguration[] {
    const runtime = this.#runtime(typeRef)
    return configurations.map((configuration) => {
      const classifierBinding = toolBindings.find(
        (binding) => binding.workItemRef === configuration.classifierWorkItemRef,
      )
      const classifierTool =
        classifierBinding === undefined
          ? null
          : this.#toolRevision(classifierBinding.registrationRef)
      const definitions = classifierTool?.content.dispatchRouteDefinitions
      if (definitions === undefined) return configuration

      const sourceByRouteRef = new Map(
        configuration.routes.map((route) => [route.routeRef, route] as const),
      )
      const missing = definitions.filter((definition) => !sourceByRouteRef.has(definition.routeRef))
      if (missing.length > 0) {
        throw new AutomaticTypeUpgradeError(
          'ordered-dispatch-route-missing',
          `${configuration.classifierWorkItemRef} added routes without historical destinations: ${missing.map((definition) => definition.routeRef).join(', ')}`,
        )
      }

      const definitionByRouteRef = new Map(
        definitions.map((definition) => [definition.routeRef, definition] as const),
      )
      const classifier = findWorkItem(runtime.descriptor, configuration.classifierWorkItemRef)
      const jobOwnsOrder = classifier?.orderedDispatchAuthoring?.processingOrderOwner === 'job'
      const orderedDefinitions = jobOwnsOrder
        ? configuration.routes
            .map((route) => definitionByRouteRef.get(route.routeRef))
            .filter((definition): definition is (typeof definitions)[number] => Boolean(definition))
            .sort((left, right) => Number(left.fallback) - Number(right.fallback))
        : [...definitions]

      return orderedDispatchConfigurationSchema.parse({
        ...configuration,
        routes: orderedDefinitions.map((definition) => {
          const source = sourceByRouteRef.get(definition.routeRef)!
          return {
            ...source,
            displayName: definition.displayName,
            description: definition.description,
            fallback: definition.fallback,
          }
        }),
      })
    })
  }

  #validateOrderedDispatchConfigurations(
    typeRef: EmployeeTypeRef,
    configurations: readonly OrderedDispatchConfiguration[],
    toolBindings: readonly WorkItemToolBinding[],
    enabledWorkItemRefs?: readonly string[],
  ): ToolRevisionRecord[] {
    const runtime = this.#runtime(typeRef)
    const expectedClassifiers = runtime.descriptor.authoringManifest.workItems.filter(
      (item) => item.orderedDispatchAuthoring !== null,
    )
    const byClassifier = new Map<string, OrderedDispatchConfiguration>()
    for (const configuration of configurations) {
      if (byClassifier.has(configuration.classifierWorkItemRef)) {
        throw new ValidationError(
          'employee-ordered-dispatch-duplicate',
          `ordered dispatch is defined more than once for ${configuration.classifierWorkItemRef}`,
        )
      }
      const classifier = findWorkItem(runtime.descriptor, configuration.classifierWorkItemRef)
      if (classifier?.orderedDispatchAuthoring === null || classifier === null) {
        throw new ValidationError(
          'employee-ordered-dispatch-invalid',
          `work item does not declare ordered dispatch authoring: ${configuration.classifierWorkItemRef}`,
        )
      }
      const allowedDestinations = new Set(
        classifier.orderedDispatchAuthoring.destinationWorkItemRefs,
      )
      for (const route of configuration.routes) {
        if (!allowedDestinations.has(route.destinationWorkItemRef)) {
          throw new ValidationError(
            'employee-ordered-dispatch-destination-invalid',
            `${route.routeRef} cannot dispatch ${configuration.classifierWorkItemRef} to ${route.destinationWorkItemRef}`,
          )
        }
      }
      byClassifier.set(configuration.classifierWorkItemRef, configuration)
    }
    if (enabledWorkItemRefs !== undefined) {
      const enabled = new Set(enabledWorkItemRefs)
      for (const classifier of expectedClassifiers) {
        if (!enabled.has(classifier.workItemRef)) continue
        if (byClassifier.has(classifier.workItemRef)) continue
        throw new ValidationError(
          'employee-ordered-dispatch-missing',
          `ordered dispatch must be configured for ${classifier.workItemRef}`,
        )
      }
    }

    const tools: ToolRevisionRecord[] = []
    for (const configuration of configurations) {
      for (const route of configuration.routes) {
        const destination = findWorkItem(runtime.descriptor, route.destinationWorkItemRef)
        if (destination === null) {
          throw new ValidationError(
            'employee-ordered-dispatch-destination-invalid',
            `unknown dispatch destination: ${route.destinationWorkItemRef}`,
          )
        }
        if (destination.nodeKind === 'collaboration') {
          if (route.registrationRef !== null) {
            throw new ValidationError(
              'employee-ordered-dispatch-tool-invalid',
              `${route.routeRef} dispatches to collaboration and cannot bind a tool`,
            )
          }
          continue
        }
        if (destination.nodeKind !== 'business-tool' || route.registrationRef === null) {
          throw new ValidationError(
            'employee-ordered-dispatch-tool-missing',
            `${route.routeRef} must bind a published tool for ${route.destinationWorkItemRef}`,
          )
        }
        const tool = this.#toolRevision(route.registrationRef)
        if (tool === null || tool.state !== 'published') {
          throw new ValidationError(
            'employee-ordered-dispatch-tool-invalid',
            `tool revision is not published: ${route.registrationRef.id}@${route.registrationRef.revision}`,
          )
        }
        const validRoles = new Set(destination.toolRoleGroups.map((role) => role.roleRef))
        if (
          !sameType(tool.content.typeRef, typeRef) ||
          tool.content.workItemRef !== destination.workItemRef ||
          !validRoles.has(tool.content.roleRef)
        ) {
          throw new ValidationError(
            'employee-ordered-dispatch-tool-invalid',
            `tool revision does not belong to ${route.destinationWorkItemRef}`,
          )
        }
        const accepted = tool.content.acceptedDispatchRoutes?.find(
          (candidate) => candidate.classifierWorkItemRef === configuration.classifierWorkItemRef,
        )
        const acceptsRoute =
          // Revisions frozen before route capability declarations remain
          // compatible with every route, preserving their existing behavior.
          tool.content.acceptedDispatchRoutes === undefined ||
          accepted?.routeRefs.includes('*') === true ||
          accepted?.routeRefs.includes(route.routeRef) === true
        if (!acceptsRoute) {
          throw new ValidationError(
            'employee-ordered-dispatch-tool-incompatible',
            `${tool.content.displayName} does not accept ${configuration.classifierWorkItemRef}/${route.routeRef}`,
          )
        }
        tools.push(tool)
      }
    }
    for (const configuration of configurations) {
      const classifierBinding = toolBindings.find(
        (binding) => binding.workItemRef === configuration.classifierWorkItemRef,
      )
      if (classifierBinding === undefined) continue
      const classifierTool = this.#toolRevision(classifierBinding.registrationRef)
      const definitions = classifierTool?.content.dispatchRouteDefinitions
      // Immutable revisions created before tool-owned problem definitions keep
      // their existing job-owned list. Every newly authored classifier is
      // required to carry definitions by #prepareToolDraft above.
      if (definitions === undefined) continue
      const classifier = findWorkItem(runtime.descriptor, configuration.classifierWorkItemRef)
      const jobOwnsOrder = classifier?.orderedDispatchAuthoring?.processingOrderOwner === 'job'
      const matchesDefinition = (
        definition: (typeof definitions)[number],
        route: (typeof configuration.routes)[number] | undefined,
      ) =>
        route !== undefined &&
        route.routeRef === definition.routeRef &&
        route.displayName === definition.displayName &&
        route.description === definition.description &&
        route.fallback === definition.fallback
      const matches =
        definitions.length === configuration.routes.length &&
        (jobOwnsOrder
          ? definitions.every((definition) =>
              matchesDefinition(
                definition,
                configuration.routes.find((route) => route.routeRef === definition.routeRef),
              ),
            )
          : definitions.every((definition, index) =>
              matchesDefinition(definition, configuration.routes[index]),
            ))
      if (!matches) {
        throw new ValidationError(
          'employee-ordered-dispatch-definition-mismatch',
          `${configuration.classifierWorkItemRef} routes must match the classifier tool revision`,
        )
      }
    }
    return tools
  }

  #enabledWorkItemRefs(input: {
    typeRef: EmployeeTypeRef
    toolBindings: readonly WorkItemToolBinding[]
    collaborationBindings: readonly EmployeeCollaborationBinding[]
    orderedDispatchConfigurations: readonly OrderedDispatchConfiguration[]
  }): string[] {
    const manifest = this.#runtime(input.typeRef).descriptor.authoringManifest
    const laneOptional = new Map(
      manifest.lifecycleRegions.flatMap((region) =>
        region.responsibilityLanes.map((lane) => [lane.laneId, lane.optional] as const),
      ),
    )
    const activeOptionalLanes = new Set<string>()
    const activate = (workItemRef: string) => {
      const item = manifest.workItems.find((candidate) => candidate.workItemRef === workItemRef)
      if (item?.responsibilityLaneId !== null && item?.responsibilityLaneId !== undefined) {
        activeOptionalLanes.add(item.responsibilityLaneId)
      }
    }
    for (const binding of input.toolBindings) activate(binding.workItemRef)
    for (const binding of input.collaborationBindings) activate(binding.workItemRef)
    for (const configuration of input.orderedDispatchConfigurations) {
      activate(configuration.classifierWorkItemRef)
      for (const route of configuration.routes) activate(route.destinationWorkItemRef)
    }
    return manifest.workItems
      .filter((item) => {
        if (item.responsibilityLaneId === null) return true
        return (
          laneOptional.get(item.responsibilityLaneId) !== true ||
          activeOptionalLanes.has(item.responsibilityLaneId)
        )
      })
      .map((item) => item.workItemRef)
  }

  #normalizeReactionLaneOrder(
    typeRef: EmployeeTypeRef,
    authoredOrder: readonly string[],
  ): string[] {
    const expected = reactionLaneIds(this.#runtime(typeRef).descriptor)
    if (authoredOrder.length === 0) return expected
    const actual = new Set(authoredOrder)
    if (
      actual.size !== authoredOrder.length ||
      actual.size !== expected.length ||
      expected.some((laneId) => !actual.has(laneId))
    ) {
      throw new ValidationError(
        'employee-reaction-lane-order-invalid',
        'reaction lane order must contain every event-driven business lane exactly once',
        { expected, actual: authoredOrder },
      )
    }
    return [...authoredOrder]
  }

  #validateCollaborationBinding(
    typeRef: EmployeeTypeRef,
    binding: EmployeeCollaborationBinding,
  ): string {
    const runtime = this.#runtime(typeRef)
    const item = findWorkItem(runtime.descriptor, binding.workItemRef)
    if (item === null || item.nodeKind !== 'collaboration') {
      throw new ValidationError(
        'employee-collaboration-binding-invalid',
        `${binding.workItemRef} is not a collaboration work item`,
      )
    }
    if (
      item.collaborationContractId !== binding.invocationContractId ||
      !runtime.descriptor.invocationContracts.some(
        (contract) => contract.contractId === item.collaborationContractId,
      )
    ) {
      throw new ValidationError(
        'employee-collaboration-contract-invalid',
        `unknown invocation contract: ${binding.invocationContractId}`,
      )
    }
    const target = this.#store.getEmployeeDefinitionRevision(binding.targetEmployeeRef)
    if (target === null) {
      throw new ValidationError(
        'employee-collaboration-target-unavailable',
        `target employee is unavailable: ${binding.targetEmployeeRef.id}@${binding.targetEmployeeRef.revision}`,
      )
    }
    return target.contentDigest
  }

  createJobTemplate(input: {
    typeRef: EmployeeTypeRef
    body: unknown
    ownerUserId: string | null
    adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): JobTemplateRecord {
    this.#runtime(input.typeRef)
    const body = createJobTemplateBodySchema.parse(input.body)
    for (const binding of body.defaultToolBindings) this.#validateBinding(input.typeRef, binding)
    this.#validateAdapterDraftBindings(
      input.typeRef,
      body.defaultAdapterBindings,
      input.adapterVisibilitySubject ?? null,
    )
    for (const binding of body.defaultCollaborationBindings) {
      this.#validateCollaborationBinding(input.typeRef, binding)
    }
    this.#validateOrderedDispatchConfigurations(
      input.typeRef,
      body.orderedDispatchConfigurations,
      body.defaultToolBindings,
    )
    validateCollaborationGroups(body.defaultCollaborationBindings)
    const draft = employeeJobTemplateContentSchema.parse({
      schemaVersion: 1,
      typeRef: input.typeRef,
      description: body.description,
      defaultToolBindings: body.defaultToolBindings,
      defaultAdapterBindings: body.defaultAdapterBindings,
      defaultCollaborationBindings: body.defaultCollaborationBindings,
      orderedDispatchConfigurations: body.orderedDispatchConfigurations,
      reactionLaneOrder: this.#normalizeReactionLaneOrder(input.typeRef, body.reactionLaneOrder),
    })
    const now = this.#now()
    const record: JobTemplateRecord = {
      id: this.#id(),
      typeRef: input.typeRef,
      name: body.name,
      draft,
      publishedRevision: null,
      ownerUserId: input.ownerUserId,
      // RFC-330 D3 —— 新建默认 private。
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    this.#store.createJobTemplate(record)
    return record
  }

  updateJobTemplate(input: {
    id: string
    body: unknown
    adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): JobTemplateRecord {
    const existing = this.#store.getJobTemplate(input.id)
    if (existing === null || existing.archivedAt !== null) {
      throw new NotFoundError(
        'employee-job-template-not-found',
        `job template not found: ${input.id}`,
      )
    }
    const body = updateJobTemplateBodySchema.parse(input.body)
    for (const binding of body.defaultToolBindings) {
      this.#validateBinding(existing.typeRef, binding)
    }
    this.#validateAdapterDraftBindings(
      existing.typeRef,
      body.defaultAdapterBindings,
      input.adapterVisibilitySubject ?? null,
    )
    for (const binding of body.defaultCollaborationBindings) {
      this.#validateCollaborationBinding(existing.typeRef, binding)
    }
    this.#validateOrderedDispatchConfigurations(
      existing.typeRef,
      body.orderedDispatchConfigurations,
      body.defaultToolBindings,
    )
    validateCollaborationGroups(body.defaultCollaborationBindings)
    const draft: EmployeeJobTemplateContent = {
      schemaVersion: 1,
      typeRef: existing.typeRef,
      description: body.description,
      defaultToolBindings: body.defaultToolBindings,
      defaultAdapterBindings: body.defaultAdapterBindings,
      defaultCollaborationBindings: body.defaultCollaborationBindings,
      orderedDispatchConfigurations: body.orderedDispatchConfigurations,
      reactionLaneOrder: this.#normalizeReactionLaneOrder(existing.typeRef, body.reactionLaneOrder),
    }
    this.#store.updateJobTemplate(existing.id, body.name, draft, this.#now())
    const updated = this.#store.getJobTemplate(existing.id)
    if (updated === null) throw new Error('job template vanished after update')
    return updated
  }

  listJobTemplates(typeRef: EmployeeTypeRef): JobTemplateRecord[] {
    this.#descriptor(typeRef)
    return this.#store.listJobTemplates(typeRef)
  }

  publishJobTemplate(input: {
    id: string
    actorUserId: string | null
    adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): ExactResourceRef {
    const template = this.#store.getJobTemplate(input.id)
    if (template === null || template.archivedAt !== null) {
      throw new NotFoundError(
        'employee-job-template-not-found',
        `job template not found: ${input.id}`,
      )
    }
    const runtime = this.#runtime(template.typeRef)
    const enabledWorkItemRefs = this.#enabledWorkItemRefs({
      typeRef: template.typeRef,
      toolBindings: template.draft.defaultToolBindings,
      collaborationBindings: template.draft.defaultCollaborationBindings,
      orderedDispatchConfigurations: template.draft.orderedDispatchConfigurations,
    })
    const merged = mergeExactToolBindings({
      manifest: runtime.descriptor.authoringManifest,
      defaults: template.draft.defaultToolBindings,
      overrides: [],
      enabledWorkItemRefs,
    })
    if (merged.violations.length > 0) {
      throw new ValidationError(
        'employee-job-template-bindings-incomplete',
        'job template does not cover every required work-item tool slot',
        { violations: merged.violations },
      )
    }
    const adapterBindings = mergeExactAdapterBindings({
      manifest: runtime.descriptor.authoringManifest,
      defaults: template.draft.defaultAdapterBindings,
      overrides: [],
      enabledWorkItemRefs,
    })
    if (adapterBindings.violations.length > 0) {
      throw new ValidationError(
        'employee-job-template-adapter-bindings-incomplete',
        'job template does not cover every required lane Adapter slot',
        { violations: adapterBindings.violations },
      )
    }
    for (const binding of adapterBindings.bindings) {
      this.#validateAdapterBinding(
        template.typeRef,
        binding,
        input.adapterVisibilitySubject ?? null,
      )
    }
    for (const binding of template.draft.defaultToolBindings) {
      this.#validateBinding(template.typeRef, binding)
    }
    for (const binding of template.draft.defaultCollaborationBindings) {
      this.#validateCollaborationBinding(template.typeRef, binding)
    }
    this.#validateOrderedDispatchConfigurations(
      template.typeRef,
      template.draft.orderedDispatchConfigurations,
      template.draft.defaultToolBindings,
      enabledWorkItemRefs,
    )
    validateCollaborationGroups(template.draft.defaultCollaborationBindings)
    const publishedContent = employeeJobTemplateContentSchema.parse({
      ...template.draft,
      reactionLaneOrder: this.#normalizeReactionLaneOrder(
        template.typeRef,
        template.draft.reactionLaneOrder,
      ),
    })
    const ref = { id: template.id, revision: nextRevision(template.publishedRevision) }
    this.#store.publishJobTemplate({
      ref,
      content: publishedContent,
      contentDigest: contentDigest(publishedContent),
      publishedAt: this.#now(),
      publishedBy: input.actorUserId,
    })
    return ref
  }

  createEmployeeDefinition(input: {
    typeRef: EmployeeTypeRef
    body: unknown
    ownerUserId: string | null
    adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): EmployeeDefinitionRecord {
    const runtime = this.#runtime(input.typeRef)
    const body = createEmployeeDefinitionBodySchema.parse(input.body)
    const template = this.#store.getJobTemplateRevision(body.jobTemplateRef)
    if (template === null || !sameType(template.content.typeRef, input.typeRef)) {
      throw new ValidationError(
        'employee-job-template-invalid',
        'job template revision does not belong to this employee type',
      )
    }
    runtime.parseWorkScope(body.workScope)
    validateCollaborationGroups(body.collaborationOverrides)
    const configuration = digitalEmployeeDefinitionDraftSchema.parse({
      schemaVersion: 1,
      typeRef: input.typeRef,
      jobTemplateRef: body.jobTemplateRef,
      displayName: body.name,
      workScope: body.workScope,
      toolOverrides: body.toolOverrides,
      adapterOverrides: body.adapterOverrides,
      collaborationOverrides: body.collaborationOverrides,
    })
    const now = this.#now()
    const record: EmployeeDefinitionRecord = {
      id: this.#id(),
      name: body.name,
      typeRef: input.typeRef,
      configuration,
      currentRevision: null,
      ownerUserId: input.ownerUserId,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    const compiled = this.#compileEmployeeDefinition(
      record,
      input.ownerUserId,
      input.adapterVisibilitySubject ?? null,
    )
    this.#store.saveEmployeeDefinition({
      ...compiled,
      definitionMutation: { kind: 'create', record },
    })
    const saved = this.#store.getEmployeeDefinition(record.id)
    if (saved === null || saved.currentRevision === null) {
      throw new Error('employee vanished after atomic create')
    }
    return saved
  }

  updateEmployeeDefinition(input: {
    id: string
    body: unknown
    actorUserId: string | null
    adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): EmployeeDefinitionRecord {
    const existing = this.#store.getEmployeeDefinition(input.id)
    if (existing === null || existing.archivedAt !== null) {
      throw new NotFoundError('employee-definition-not-found', `employee not found: ${input.id}`)
    }
    const runtime = this.#runtime(existing.typeRef)
    const body = updateEmployeeDefinitionBodySchema.parse(input.body)
    const template = this.#store.getJobTemplateRevision(body.jobTemplateRef)
    if (template === null || !sameType(template.content.typeRef, existing.typeRef)) {
      throw new ValidationError(
        'employee-job-template-invalid',
        'job template revision does not belong to this employee type',
      )
    }
    runtime.parseWorkScope(body.workScope)
    validateCollaborationGroups(body.collaborationOverrides)
    const configuration: DigitalEmployeeDefinitionDraft = {
      schemaVersion: 1,
      typeRef: existing.typeRef,
      jobTemplateRef: body.jobTemplateRef,
      displayName: body.name,
      workScope: body.workScope,
      toolOverrides: body.toolOverrides,
      adapterOverrides: body.adapterOverrides,
      collaborationOverrides: body.collaborationOverrides,
    }
    const candidate: EmployeeDefinitionRecord = {
      ...existing,
      name: body.name,
      configuration,
      updatedAt: this.#now(),
    }
    const compiled = this.#compileEmployeeDefinition(
      candidate,
      input.actorUserId,
      input.adapterVisibilitySubject ?? null,
    )
    this.#store.saveEmployeeDefinition({
      ...compiled,
      definitionMutation: {
        kind: 'update',
        expectedTypeRef: existing.typeRef,
        targetTypeRef: existing.typeRef,
        name: candidate.name,
        configuration,
        updatedAt: compiled.revision.createdAt,
      },
    })
    const updated = this.#store.getEmployeeDefinition(existing.id)
    if (updated === null || updated.currentRevision === null) {
      throw new Error('employee vanished after atomic update')
    }
    return updated
  }

  listEmployeeDefinitions(typeRef?: EmployeeTypeRef): EmployeeDefinitionRecord[] {
    if (typeRef !== undefined) this.#descriptor(typeRef)
    return this.#store
      .listEmployeeDefinitions(typeRef)
      .filter((employee) => employee.currentRevision !== null)
  }

  listLaunchableEmployeeDefinitions(): EmployeeDefinitionRecord[] {
    const currentTypeRevisions = new Map(
      this.listTypes().map((descriptor) => [
        descriptor.typeRef.typeId,
        descriptor.typeRef.revision,
      ]),
    )
    return this.#store.listEmployeeDefinitions().filter((employee) => {
      if (
        employee.currentRevision === null ||
        currentTypeRevisions.get(employee.typeRef.typeId) !== employee.typeRef.revision
      ) {
        return false
      }
      return (
        this.#store.getEmployeeDefinitionRevision({
          id: employee.id,
          revision: employee.currentRevision,
        }) !== null
      )
    })
  }

  getEmployeeDefinition(id: string): EmployeeDefinitionRecord {
    const record = this.#store.getEmployeeDefinition(id)
    if (record === null || record.archivedAt !== null || record.currentRevision === null) {
      throw new NotFoundError('employee-definition-not-found', `employee not found: ${id}`)
    }
    return record
  }

  #compileEmployeeDefinition(
    employee: EmployeeDefinitionRecord,
    actorUserId: string | null,
    adapterVisibilitySubject: ToolConnectionVisibilitySubject | null,
  ): {
    readonly revision: EmployeeDefinitionRevisionRecord
    readonly workScope: WorkScopeRevisionRecord
  } {
    const runtime = this.#runtime(employee.typeRef)
    const template = this.#store.getJobTemplateRevision(employee.configuration.jobTemplateRef)
    if (template === null || !sameType(template.content.typeRef, employee.typeRef)) {
      throw new ValidationError(
        'employee-job-template-invalid',
        'the pinned job template is unavailable or belongs to another type',
      )
    }
    const collaborationBindings = mergeCollaborationBindings({
      defaults: template.content.defaultCollaborationBindings,
      overrides: employee.configuration.collaborationOverrides,
    })
    const enabledWorkItemRefs = this.#enabledWorkItemRefs({
      typeRef: employee.typeRef,
      toolBindings: [
        ...template.content.defaultToolBindings,
        ...employee.configuration.toolOverrides,
      ],
      collaborationBindings,
      orderedDispatchConfigurations: template.content.orderedDispatchConfigurations,
    })
    const merged = mergeExactToolBindings({
      manifest: runtime.descriptor.authoringManifest,
      defaults: template.content.defaultToolBindings,
      overrides: employee.configuration.toolOverrides,
      enabledWorkItemRefs,
    })
    if (merged.violations.length > 0) {
      throw new ValidationError(
        'employee-tool-bindings-incomplete',
        'employee tool bindings do not cover the job contract',
        { violations: merged.violations },
      )
    }
    const mergedAdapters = mergeExactAdapterBindings({
      manifest: runtime.descriptor.authoringManifest,
      defaults: template.content.defaultAdapterBindings,
      overrides: employee.configuration.adapterOverrides,
      enabledWorkItemRefs,
    })
    if (mergedAdapters.violations.length > 0) {
      throw new ValidationError(
        'employee-adapter-bindings-incomplete',
        'employee Adapter bindings do not cover the enabled lane contract',
        { violations: mergedAdapters.violations },
      )
    }
    const adapterDigests = mergedAdapters.bindings.map((binding) =>
      this.#validateAdapterBinding(employee.typeRef, binding, adapterVisibilitySubject),
    )
    const toolDigests: string[] = []
    for (const binding of merged.bindings) {
      const revision = this.#validateBinding(employee.typeRef, binding)
      toolDigests.push(revision.contentDigest)
    }
    validateCollaborationGroups(collaborationBindings)
    const collaborationTargetDigests = collaborationBindings.map((binding) =>
      this.#validateCollaborationBinding(employee.typeRef, binding),
    )
    const dispatchTools = this.#validateOrderedDispatchConfigurations(
      employee.typeRef,
      template.content.orderedDispatchConfigurations,
      merged.bindings,
      enabledWorkItemRefs,
    )
    for (const configuration of template.content.orderedDispatchConfigurations) {
      for (const route of configuration.routes) {
        const destination = findWorkItem(runtime.descriptor, route.destinationWorkItemRef)
        if (
          destination?.nodeKind === 'collaboration' &&
          !collaborationBindings.some(
            (binding) => binding.workItemRef === route.destinationWorkItemRef,
          )
        ) {
          throw new ValidationError(
            'employee-ordered-dispatch-collaboration-missing',
            `${route.routeRef} requires a collaboration target for ${route.destinationWorkItemRef}`,
          )
        }
      }
    }

    const encodedScope = runtime.parseWorkScope(employee.configuration.workScope)
    const scopeRef = { id: this.#id(), revision: 1 }
    const revisionRef = { id: employee.id, revision: nextRevision(employee.currentRevision) }
    const closure = {
      typeRef: employee.typeRef,
      jobTemplateRef: employee.configuration.jobTemplateRef,
      workScopeRef: scopeRef,
      bindings: merged.bindings,
      toolDigests,
      adapterBindings: mergedAdapters.bindings,
      adapterDigests,
      collaborationBindings,
      collaborationTargetDigests,
      orderedDispatchConfigurations: template.content.orderedDispatchConfigurations,
      reactionLaneOrder: template.content.reactionLaneOrder,
      dispatchToolDigests: dispatchTools.map((tool) => tool.contentDigest),
    }
    const content = digitalEmployeeDefinitionContentSchema.parse({
      schemaVersion: 1,
      typeRef: employee.typeRef,
      jobTemplateRef: employee.configuration.jobTemplateRef,
      displayName: employee.configuration.displayName,
      workScopeRef: scopeRef,
      workScopeSummary: runtime.summarizeWorkScope(encodedScope, 'zh-CN'),
      exactToolBindings: merged.bindings,
      exactAdapterBindings: mergedAdapters.bindings,
      exactCollaborationBindings: collaborationBindings,
      exactOrderedDispatchConfigurations: template.content.orderedDispatchConfigurations,
      exactReactionLaneOrder: template.content.reactionLaneOrder,
      enabledWorkItemRefs,
      compiledClosureDigest: contentDigest(closure),
    })
    const now = this.#now()
    return {
      workScope: {
        ref: scopeRef,
        typeRef: employee.typeRef,
        encodedScope,
        displaySummary: content.workScopeSummary,
        contentDigest: contentDigest(encodedScope),
        createdAt: now,
        createdBy: actorUserId,
      },
      revision: {
        ref: revisionRef,
        content,
        contentDigest: contentDigest(content),
        createdAt: now,
        createdBy: actorUserId,
      },
    }
  }

  getExecutionPolicy() {
    const current = this.#store.getCurrentExecutionPolicy()
    if (current === null) throw new Error('global execution policy was not seeded')
    return current
  }

  /**
   * Materialize the current Settings -> Limits retry values as an immutable
   * runtime snapshot. Identical limits reuse the existing revision, so this is
   * safe to call at every case admission.
   */
  ensureExecutionPolicyFromLimits(input: {
    readonly defaultNodeRetries: number
    readonly sessionRestartBudget: number
  }) {
    const content = globalExecutionPolicySchema.parse({
      ...DEFAULT_GLOBAL_EXECUTION_POLICY,
      sameSceneAttempts: input.defaultNodeRetries,
      freshSceneAttempts: input.sessionRestartBudget,
    })
    return this.#store.ensureExecutionPolicy({
      content,
      contentDigest: contentDigest(content),
      publishedAt: this.#now(),
      publishedBy: null,
    })
  }
}
