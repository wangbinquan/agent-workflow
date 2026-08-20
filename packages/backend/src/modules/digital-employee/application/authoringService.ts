import { ulid } from 'ulid'
import { z } from 'zod'

import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type {
  ProgramArtifactPort,
  ToolConnectionCatalogPort,
  ToolResourceCatalogPort,
  WorkContractFixturePort,
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
  mergeExactToolBindings,
  packageDigest,
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
  type GlobalExecutionPolicy,
  type ToolImplementation,
  type ToolRegistrationContent,
  type ToolValidationReceipt,
  type WorkItemToolBinding,
} from '../domain/model'
import type {
  DigitalEmployeeAuthoringStore,
  EmployeeDefinitionRecord,
  JobTemplateRecord,
  ToolDraftRecord,
  ToolRevisionRecord,
} from './ports/authoringStore'

export const createJobTemplateBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2_000),
    defaultToolBindings: z.array(workItemToolBindingSchema).max(300),
    defaultCollaborationBindings: z.array(employeeCollaborationBindingSchema).max(100).default([]),
  })
  .strict()

export const updateJobTemplateBodySchema = createJobTemplateBodySchema

export const createEmployeeDefinitionBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    jobTemplateRef: exactResourceRefSchema,
    enabled: z.boolean().default(true),
    workScope: z.unknown(),
    toolOverrides: z.array(workItemToolBindingSchema).max(300).default([]),
    collaborationOverrides: z.array(employeeCollaborationBindingSchema).max(100).default([]),
  })
  .strict()

export const updateEmployeeDefinitionBodySchema = createEmployeeDefinitionBodySchema

export interface DigitalEmployeeAuthoringServiceDependencies {
  readonly store: DigitalEmployeeAuthoringStore
  readonly typePackages: readonly EmployeeTypeRuntimePackage[]
  readonly resourceCatalog: ToolResourceCatalogPort
  readonly connectionCatalog: ToolConnectionCatalogPort
  readonly programArtifacts: ProgramArtifactPort
  readonly fixtureRunner: WorkContractFixturePort
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
  readonly #resourceCatalog: ToolResourceCatalogPort
  readonly #connectionCatalog: ToolConnectionCatalogPort
  readonly #programArtifacts: ProgramArtifactPort
  readonly #fixtureRunner: WorkContractFixturePort
  readonly #now: () => number
  readonly #id: () => string

  constructor(deps: DigitalEmployeeAuthoringServiceDependencies) {
    this.#store = deps.store
    this.#resourceCatalog = deps.resourceCatalog
    this.#connectionCatalog = deps.connectionCatalog
    this.#programArtifacts = deps.programArtifacts
    this.#fixtureRunner = deps.fixtureRunner
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

    if (this.#store.getCurrentExecutionPolicy() === null) {
      const now = this.#now()
      this.#store.publishExecutionPolicy({
        revision: 1,
        content: DEFAULT_GLOBAL_EXECUTION_POLICY,
        contentDigest: contentDigest(DEFAULT_GLOBAL_EXECUTION_POLICY),
        publishedAt: now,
        publishedBy: null,
      })
    }
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

    if (content.implementation.kind === 'agent') {
      const projection = await this.#resourceCatalog.resolveAgent(content.implementation.agentRef)
      checks.push(
        projection === null
          ? validationFailure(
              'agent-exact-revision-resolves',
              `${content.implementation.agentRef.id}@${content.implementation.agentRef.revision} not found`,
            )
          : {
              code: 'agent-exact-revision-resolves',
              ok: projection.available,
              detail: projection.available
                ? projection.closureSummary
                : `${projection.name} unavailable`,
            },
      )
    } else if (content.implementation.kind === 'workflow') {
      const projection = await this.#resourceCatalog.resolveWorkflow(
        content.implementation.workflowRef,
      )
      checks.push(
        projection === null
          ? validationFailure(
              'workflow-exact-revision-resolves',
              `${content.implementation.workflowRef.id}@${content.implementation.workflowRef.revision} not found`,
            )
          : {
              code: 'workflow-exact-revision-resolves',
              ok: projection.available,
              detail: projection.available
                ? projection.closureSummary
                : `${projection.name} unavailable`,
            },
      )
    }

    checks.push(
      ...(await this.#fixtureRunner.validate({
        inputSchemaId: contract.inputSchemaId,
        outputSchemaId: contract.outputSchemaId,
        implementation: content.implementation,
      })),
    )
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
    })
    const validationReceipt = await this.#validateTool(runtime, content)
    const now = this.#now()
    const record: ToolDraftRecord = {
      id: this.#id(),
      typeRef: input.typeRef,
      workItemRef: item.workItemRef,
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
    return this.#store.listTools(typeRef, workItemRef)
  }

  async validateTool(input: {
    typeRef: EmployeeTypeRef
    workItemRef: string
    toolId: string
  }): Promise<ToolDraftRecord> {
    const runtime = this.#runtime(input.typeRef)
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
    const tool = this.#store.getTool(input.toolId)
    if (
      tool === null ||
      !sameType(tool.typeRef, input.typeRef) ||
      tool.workItemRef !== input.workItemRef
    ) {
      throw new NotFoundError(
        'employee-tool-not-found',
        `tool registration not found: ${input.toolId}`,
      )
    }
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
    const tool = this.#store.getToolRevision(binding.registrationRef)
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
    if (target === null || !target.content.enabled) {
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
    validateCollaborationGroups(body.defaultCollaborationBindings)
    const draft = employeeJobTemplateContentSchema.parse({
      schemaVersion: 1,
      typeRef: input.typeRef,
      description: body.description,
      defaultToolBindings: body.defaultToolBindings,
      defaultCollaborationBindings: body.defaultCollaborationBindings,
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
    validateCollaborationGroups(body.defaultCollaborationBindings)
    const draft: EmployeeJobTemplateContent = {
      schemaVersion: 1,
      typeRef: existing.typeRef,
      description: body.description,
      defaultToolBindings: body.defaultToolBindings,
      defaultCollaborationBindings: body.defaultCollaborationBindings,
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
    const merged = mergeExactToolBindings({
      manifest: runtime.descriptor.authoringManifest,
      defaults: template.draft.defaultToolBindings,
      overrides: [],
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
    validateCollaborationGroups(template.draft.defaultCollaborationBindings)
    const ref = { id: template.id, revision: nextRevision(template.publishedRevision) }
    this.#store.publishJobTemplate({
      ref,
      content: template.draft,
      contentDigest: contentDigest(template.draft),
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
    const draft = digitalEmployeeDefinitionDraftSchema.parse({
      schemaVersion: 1,
      typeRef: input.typeRef,
      jobTemplateRef: body.jobTemplateRef,
      displayName: body.name,
      enabled: body.enabled,
      workScope: body.workScope,
      toolOverrides: body.toolOverrides,
      collaborationOverrides: body.collaborationOverrides,
    })
    const now = this.#now()
    const record: EmployeeDefinitionRecord = {
      id: this.#id(),
      name: body.name,
      typeRef: input.typeRef,
      draft,
      publishedRevision: null,
      ownerUserId: input.ownerUserId,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    this.#store.createEmployeeDefinition(record)
    return record
  }

  updateEmployeeDefinition(input: { id: string; body: unknown }): EmployeeDefinitionRecord {
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
    const draft: DigitalEmployeeDefinitionDraft = {
      schemaVersion: 1,
      typeRef: existing.typeRef,
      jobTemplateRef: body.jobTemplateRef,
      displayName: body.name,
      enabled: body.enabled,
      workScope: body.workScope,
      toolOverrides: body.toolOverrides,
      collaborationOverrides: body.collaborationOverrides,
    }
    this.#store.updateEmployeeDefinition(existing.id, body.name, draft, this.#now())
    const updated = this.#store.getEmployeeDefinition(existing.id)
    if (updated === null) throw new Error('employee vanished after update')
    return updated
  }

  listEmployeeDefinitions(typeRef?: EmployeeTypeRef): EmployeeDefinitionRecord[] {
    if (typeRef !== undefined) this.#runtime(typeRef)
    return this.#store.listEmployeeDefinitions(typeRef)
  }

  getEmployeeDefinition(id: string): EmployeeDefinitionRecord {
    const record = this.#store.getEmployeeDefinition(id)
    if (record === null || record.archivedAt !== null) {
      throw new NotFoundError('employee-definition-not-found', `employee not found: ${id}`)
    }
    return record
  }

  publishEmployeeDefinition(input: { id: string; actorUserId: string | null }): ExactResourceRef {
    const employee = this.getEmployeeDefinition(input.id)
    const runtime = this.#runtime(employee.typeRef)
    const template = this.#store.getJobTemplateRevision(employee.draft.jobTemplateRef)
    if (template === null || !sameType(template.content.typeRef, employee.typeRef)) {
      throw new ValidationError(
        'employee-job-template-invalid',
        'the pinned job template is unavailable or belongs to another type',
      )
    }
    const merged = mergeExactToolBindings({
      manifest: runtime.descriptor.authoringManifest,
      defaults: template.content.defaultToolBindings,
      overrides: employee.draft.toolOverrides,
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
    const collaborationBindings = mergeCollaborationBindings({
      defaults: template.content.defaultCollaborationBindings,
      overrides: employee.draft.collaborationOverrides,
    })
    validateCollaborationGroups(collaborationBindings)
    const collaborationTargetDigests = collaborationBindings.map((binding) =>
      this.#validateCollaborationBinding(employee.typeRef, binding),
    )

    const encodedScope = runtime.parseWorkScope(employee.draft.workScope)
    const scopeRef = { id: this.#id(), revision: 1 }
    const revisionRef = { id: employee.id, revision: nextRevision(employee.publishedRevision) }
    const closure = {
      typeRef: employee.typeRef,
      jobTemplateRef: employee.draft.jobTemplateRef,
      workScopeRef: scopeRef,
      bindings: merged.bindings,
      toolDigests,
      collaborationBindings,
      collaborationTargetDigests,
    }
    const content = digitalEmployeeDefinitionContentSchema.parse({
      schemaVersion: 1,
      typeRef: employee.typeRef,
      jobTemplateRef: employee.draft.jobTemplateRef,
      displayName: employee.draft.displayName,
      enabled: employee.draft.enabled,
      workScopeRef: scopeRef,
      workScopeSummary: runtime.summarizeWorkScope(encodedScope, 'zh-CN'),
      exactToolBindings: merged.bindings,
      exactCollaborationBindings: collaborationBindings,
      compiledClosureDigest: contentDigest(closure),
    })
    const now = this.#now()
    this.#store.publishEmployeeDefinition({
      workScope: {
        ref: scopeRef,
        typeRef: employee.typeRef,
        encodedScope,
        displaySummary: content.workScopeSummary,
        contentDigest: contentDigest(encodedScope),
        createdAt: now,
        createdBy: input.actorUserId,
      },
      revision: {
        ref: revisionRef,
        content,
        contentDigest: contentDigest(content),
        publishedAt: now,
        publishedBy: input.actorUserId,
      },
    })
    return revisionRef
  }

  getExecutionPolicy() {
    const current = this.#store.getCurrentExecutionPolicy()
    if (current === null) throw new Error('global execution policy was not seeded')
    return current
  }

  publishExecutionPolicy(input: { body: unknown; actorUserId: string | null }): {
    revision: number
    content: GlobalExecutionPolicy
    contentDigest: string
  } {
    const content = globalExecutionPolicySchema.parse(input.body)
    if (content.maxBackoffMs < content.initialBackoffMs) {
      throw new ValidationError(
        'employee-execution-policy-invalid',
        'maxBackoffMs must be greater than or equal to initialBackoffMs',
      )
    }
    const current = this.getExecutionPolicy()
    const revision = current.revision + 1
    const digest = contentDigest(content)
    this.#store.publishExecutionPolicy({
      revision,
      content,
      contentDigest: digest,
      publishedAt: this.#now(),
      publishedBy: input.actorUserId,
    })
    return { revision, content, contentDigest: digest }
  }
}
