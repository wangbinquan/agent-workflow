import { ulid } from 'ulid'
import { z } from 'zod'

import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import type { ProgramArtifactPort, ToolConnectionCatalogPort } from '../composition/required-ports'
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
  mergeExactToolBindings,
  orderedDispatchConfigurationSchema,
  packageDigest,
  reactionLaneIds,
  toolRegistrationContentSchema,
  validateTypePackage,
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
  readonly now?: () => number
  readonly id?: () => string
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

function validationFailure(code: string, detail: string): ContractValidationCheck {
  return { code, ok: false, detail }
}

function nextRevision(current: number | null): number {
  return (current ?? 0) + 1
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
  readonly #now: () => number
  readonly #id: () => string

  constructor(deps: DigitalEmployeeAuthoringServiceDependencies) {
    this.#store = deps.store
    this.#connectionCatalog = deps.connectionCatalog
    this.#programArtifacts = deps.programArtifacts
    this.#executionContracts = deps.executionContracts
    this.#platformTools = deps.platformTools ?? EMPTY_DIGITAL_EMPLOYEE_PLATFORM_TOOL_CATALOG
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

    this.#store.ensureExecutionPolicy({
      content: DEFAULT_GLOBAL_EXECUTION_POLICY,
      contentDigest: contentDigest(DEFAULT_GLOBAL_EXECUTION_POLICY),
      publishedAt: this.#now(),
      publishedBy: null,
    })
  }

  #runtime(ref: EmployeeTypeRef): EmployeeTypeRuntimePackage {
    const runtime = this.#types.get(typeKey(ref))
    if (runtime === undefined) {
      throw new NotFoundError('employee-type-not-found', `employee type not found: ${typeKey(ref)}`)
    }
    return runtime
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
    return this.#runtime(ref).descriptor
  }

  getAuthoringManifest(ref: EmployeeTypeRef) {
    return this.#runtime(ref).descriptor.authoringManifest
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
    const contract = findWorkContract(runtime.descriptor, item.workContractRef)
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
      workContractRef: item.workContractRef,
      roleRef: role.roleRef,
      displayName: body.displayName,
      description: body.description,
      implementation,
      connectionRef: body.connectionRef ?? null,
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
    if (contract.requiredConnectionPurpose !== null) {
      if (content.connectionRef === null) {
        checks.push(
          validationFailure(
            'required-connection-present',
            `${contract.requiredConnectionPurpose} connection is required`,
          ),
        )
      } else {
        const projection = await this.#connectionCatalog.resolve(content.connectionRef)
        checks.push(
          projection === null
            ? validationFailure(
                'required-connection-exact-revision-resolves',
                `${content.connectionRef.id}@${content.connectionRef.revision} not found`,
              )
            : {
                code: 'required-connection-exact-revision-resolves',
                ok: true,
                detail: projection.closureSummary,
              },
        )
        if (projection !== null) {
          checks.push({
            code: 'required-connection-purpose-matches',
            ok: projection.purpose === contract.requiredConnectionPurpose,
            detail: `expected ${contract.requiredConnectionPurpose}; resolved ${projection.purpose}`,
          })
          checks.push({
            code: 'required-connection-available',
            ok: projection.available,
            detail: projection.closureSummary,
          })
        }
      }
    } else if (content.connectionRef !== null) {
      checks.push(
        validationFailure(
          'connection-not-accepted-by-contract',
          `${contract.contractId}@${contract.version} does not accept a connection`,
        ),
      )
    }

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
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
    }
    this.#store.createTool(record)
    return record
  }

  listTools(typeRef: EmployeeTypeRef, workItemRef: string): ToolDraftRecord[] {
    const item = findWorkItem(this.#runtime(typeRef).descriptor, workItemRef)
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
        connectionRef: record.content.connectionRef,
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
    if (
      !sameType(tool.content.typeRef, typeRef) ||
      tool.content.workItemRef !== binding.workItemRef ||
      tool.content.roleRef !== slot.roleRef
    ) {
      throw new ValidationError(
        'employee-tool-binding-invalid',
        `tool revision does not belong to ${binding.workItemRef}/${binding.slotRef}`,
      )
    }
    return tool
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
      const matches =
        definitions.length === configuration.routes.length &&
        definitions.every((definition, index) => {
          const route = configuration.routes[index]
          return (
            route !== undefined &&
            route.routeRef === definition.routeRef &&
            route.displayName === definition.displayName &&
            route.description === definition.description &&
            route.fallback === definition.fallback
          )
        })
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
  }): JobTemplateRecord {
    this.#runtime(input.typeRef)
    const body = createJobTemplateBodySchema.parse(input.body)
    for (const binding of body.defaultToolBindings) this.#validateBinding(input.typeRef, binding)
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
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    this.#store.createJobTemplate(record)
    return record
  }

  updateJobTemplate(input: { id: string; body: unknown }): JobTemplateRecord {
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
    this.#runtime(typeRef)
    return this.#store.listJobTemplates(typeRef)
  }

  publishJobTemplate(input: { id: string; actorUserId: string | null }): ExactResourceRef {
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
    const compiled = this.#compileEmployeeDefinition(record, input.ownerUserId)
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
      collaborationOverrides: body.collaborationOverrides,
    }
    const candidate: EmployeeDefinitionRecord = {
      ...existing,
      name: body.name,
      configuration,
      updatedAt: this.#now(),
    }
    const compiled = this.#compileEmployeeDefinition(candidate, input.actorUserId)
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
    if (typeRef !== undefined) this.#runtime(typeRef)
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

  listJobTemplateUpgradeCandidates(targetTypeRef: EmployeeTypeRef): JobTemplateRecord[] {
    this.#runtime(targetTypeRef)
    return this.#store
      .listJobTemplatesByTypeId(targetTypeRef.typeId)
      .filter((template) => template.typeRef.revision < targetTypeRef.revision)
  }

  listEmployeeDefinitionUpgradeCandidates(
    targetTypeRef: EmployeeTypeRef,
  ): EmployeeDefinitionRecord[] {
    this.#runtime(targetTypeRef)
    return this.#store
      .listEmployeeDefinitions()
      .filter(
        (employee) =>
          employee.currentRevision !== null &&
          employee.typeRef.typeId === targetTypeRef.typeId &&
          employee.typeRef.revision < targetTypeRef.revision,
      )
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

  upgradeEmployeeDefinition(input: {
    id: string
    targetTypeRef: EmployeeTypeRef
    body: unknown
    actorUserId: string | null
  }): ExactResourceRef {
    const existing = this.#store.getEmployeeDefinition(input.id)
    if (existing === null || existing.archivedAt !== null) {
      throw new NotFoundError('employee-definition-not-found', `employee not found: ${input.id}`)
    }
    if (
      existing.typeRef.typeId !== input.targetTypeRef.typeId ||
      existing.typeRef.revision >= input.targetTypeRef.revision
    ) {
      throw new ValidationError(
        'employee-type-upgrade-invalid',
        'employee upgrade must target a newer revision of the same employee type',
        { currentTypeRef: existing.typeRef, targetTypeRef: input.targetTypeRef },
      )
    }
    const runtime = this.#runtime(input.targetTypeRef)
    const body = updateEmployeeDefinitionBodySchema.parse(input.body)
    const template = this.#store.getJobTemplateRevision(body.jobTemplateRef)
    if (template === null || !sameType(template.content.typeRef, input.targetTypeRef)) {
      throw new ValidationError(
        'employee-job-template-invalid',
        'job template revision does not belong to the target employee type',
      )
    }
    runtime.parseWorkScope(body.workScope)
    validateCollaborationGroups(body.collaborationOverrides)
    const configuration = digitalEmployeeDefinitionDraftSchema.parse({
      schemaVersion: 1,
      typeRef: input.targetTypeRef,
      jobTemplateRef: body.jobTemplateRef,
      displayName: body.name,
      workScope: body.workScope,
      toolOverrides: body.toolOverrides,
      collaborationOverrides: body.collaborationOverrides,
    })
    const candidate: EmployeeDefinitionRecord = {
      ...existing,
      name: body.name,
      typeRef: input.targetTypeRef,
      configuration,
      updatedAt: this.#now(),
    }
    const compiled = this.#compileEmployeeDefinition(candidate, input.actorUserId)
    this.#store.saveEmployeeDefinition({
      ...compiled,
      definitionMutation: {
        kind: 'update',
        expectedTypeRef: existing.typeRef,
        targetTypeRef: input.targetTypeRef,
        name: candidate.name,
        configuration,
        updatedAt: compiled.revision.createdAt,
      },
    })
    return compiled.revision.ref
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
