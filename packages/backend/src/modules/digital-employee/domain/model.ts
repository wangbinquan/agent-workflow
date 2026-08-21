// RFC-310 OS revision -- canonical digital-employee authoring contracts.
//
// The product hierarchy is deliberately structural, not a UI convention:
//   employee type -> work item -> tool registration
// A tool registration can only be created through a work-item scoped command,
// and every published binding pins an immutable registration revision.

import { canonicalJson } from '@agent-workflow/shared'
import { z } from 'zod'

import { sha256Hex } from '@/util/hash'

const machineIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)

const formFieldRefSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/)

export const localizedTextSchema = z
  .object({
    'zh-CN': z.string().min(1).max(500),
    'en-US': z.string().min(1).max(500),
  })
  .strict()

export type LocalizedText = z.infer<typeof localizedTextSchema>

export const exactResourceRefSchema = z
  .object({
    id: z.string().min(1).max(200),
    revision: z.number().int().positive(),
  })
  .strict()

export type ExactResourceRef = z.infer<typeof exactResourceRefSchema>

export const employeeTypeRefSchema = z
  .object({
    typeId: machineIdSchema,
    revision: z.number().int().positive(),
  })
  .strict()

export type EmployeeTypeRef = z.infer<typeof employeeTypeRefSchema>

export const workContractRefSchema = z
  .object({
    contractId: machineIdSchema,
    version: z.number().int().positive(),
  })
  .strict()

export type WorkContractRef = z.infer<typeof workContractRefSchema>

export const workItemToolBindingSchema = z
  .object({
    workItemRef: machineIdSchema,
    slotRef: machineIdSchema,
    registrationRef: exactResourceRefSchema,
  })
  .strict()

export type WorkItemToolBinding = z.infer<typeof workItemToolBindingSchema>

export const employeeCollaborationBindingSchema = z
  .object({
    workItemRef: machineIdSchema,
    memberRef: machineIdSchema.default('primary'),
    targetEmployeeRef: exactResourceRefSchema,
    invocationContractId: machineIdSchema,
    joinMode: z.enum(['all', 'any', 'quorum']).default('all'),
    quorum: z.number().int().positive().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.joinMode === 'quorum' && value.quorum === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quorum'],
        message: 'quorum is required when joinMode is quorum',
      })
    }
    if (value.joinMode !== 'quorum' && value.quorum !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quorum'],
        message: 'quorum is only allowed when joinMode is quorum',
      })
    }
  })

export type EmployeeCollaborationBinding = z.infer<typeof employeeCollaborationBindingSchema>

const toolBindingSlotSchema = z
  .object({
    slotRef: machineIdSchema,
    label: localizedTextSchema,
    description: localizedTextSchema,
    required: z.boolean(),
    cardinality: z.enum(['exactly-one', 'zero-or-one']),
  })
  .strict()

const toolRoleGroupSchema = z
  .object({
    roleRef: machineIdSchema,
    label: localizedTextSchema,
    description: localizedTextSchema,
    order: z.number().int().nonnegative(),
    bindingSlots: z.array(toolBindingSlotSchema).min(1).max(100),
  })
  .strict()

const responsibilityLaneSchema = z
  .object({
    laneId: machineIdSchema,
    label: localizedTextSchema,
    description: localizedTextSchema,
    order: z.number().int().nonnegative(),
    kind: z.enum(['spine', 'branch']),
  })
  .strict()

const lifecycleRegionSchema = z
  .object({
    regionId: machineIdSchema,
    label: localizedTextSchema,
    description: localizedTextSchema,
    order: z.number().int().nonnegative(),
    responsibilityLanes: z.array(responsibilityLaneSchema).max(30).default([]),
  })
  .strict()

const workItemDefinitionSchema = z
  .object({
    workItemRef: machineIdSchema,
    regionId: machineIdSchema,
    responsibilityLaneId: machineIdSchema.nullable().default(null),
    order: z.number().int().nonnegative(),
    label: localizedTextSchema,
    description: localizedTextSchema,
    workContractRef: workContractRefSchema,
    materialSummary: localizedTextSchema,
    completionStandard: localizedTextSchema,
    nodeKind: z.enum(['business-tool', 'system', 'collaboration']),
    collaborationContractId: machineIdSchema.nullable().default(null),
    toolRoleGroups: z.array(toolRoleGroupSchema).max(100),
    nextWorkItemRefs: z.array(machineIdSchema).max(20),
  })
  .strict()

export const employeeAuthoringManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    lifecycleRegions: z.array(lifecycleRegionSchema).min(1).max(50),
    workItems: z.array(workItemDefinitionSchema).min(1).max(200),
  })
  .strict()

export type EmployeeAuthoringManifest = z.infer<typeof employeeAuthoringManifestSchema>
export type WorkItemDefinition = EmployeeAuthoringManifest['workItems'][number]

export const workContractSchema = z
  .object({
    contractId: machineIdSchema,
    version: z.number().int().positive(),
    inputSchemaId: machineIdSchema,
    outputSchemaId: machineIdSchema,
    materialSummary: localizedTextSchema,
    completionStandard: localizedTextSchema,
    allowedToolKinds: z.array(z.enum(['agent', 'workflow', 'program'])).max(3),
    allowedEffectKinds: z.array(machineIdSchema).max(100),
    requiredConnectionPurpose: machineIdSchema.nullable().default(null),
    workspacePolicy: z
      .object({
        mode: z.enum(['write', 'read-only', 'none']),
        businessChangeOnOk: z.enum(['required', 'forbidden', 'optional']),
        writablePrefixes: z.array(z.string().min(1).max(1_000)).max(200),
        platformWritePrefixes: z.array(z.enum(['inputs/requirements', 'pipeline'])).max(2),
      })
      .strict(),
    semanticValidatorId: machineIdSchema,
    fixtureSuiteRef: exactResourceRefSchema,
  })
  .strict()

export type WorkContract = z.infer<typeof workContractSchema>

const contextProjectionFieldSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
    label: localizedTextSchema,
    format: z.enum(['text', 'count', 'short-hash', 'boolean', 'list', 'timestamp']),
  })
  .strict()

const contextTypeRegistrationSchema = z
  .object({
    typeId: machineIdSchema,
    schemaVersion: z.number().int().positive(),
    displayName: localizedTextSchema,
    description: localizedTextSchema,
    projectionFields: z.array(contextProjectionFieldSchema).max(20).default([]),
  })
  .strict()

const employeeFormFieldSchema = z
  .object({
    fieldRef: formFieldRefSchema,
    label: localizedTextSchema,
    description: localizedTextSchema,
    inputKind: z.enum(['text', 'repository-picker', 'repository-group-picker']),
    required: z.boolean(),
    placeholder: localizedTextSchema.nullable(),
  })
  .strict()

const workScopeVariantSchema = z
  .object({
    kind: machineIdSchema,
    label: localizedTextSchema,
    description: localizedTextSchema,
    fields: z.array(employeeFormFieldSchema).max(20),
  })
  .strict()

const workScopeAuthoringManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    label: localizedTextSchema,
    description: localizedTextSchema,
    variants: z.array(workScopeVariantSchema).min(1).max(20),
  })
  .strict()

const workIntakeAuthoringManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    label: localizedTextSchema,
    description: localizedTextSchema,
    targetFields: z.array(employeeFormFieldSchema).max(20),
    acceptedKinds: z
      .array(z.enum(['body', 'files', 'body-and-files', 'external-id']))
      .min(1)
      .max(4),
    body: z
      .object({
        label: localizedTextSchema,
        description: localizedTextSchema,
        placeholder: localizedTextSchema,
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(16 * 1024 * 1024),
      })
      .strict(),
    files: z
      .object({
        label: localizedTextSchema,
        description: localizedTextSchema,
        maxFiles: z.number().int().positive().max(500),
        maxFileBytes: z.number().int().positive(),
        targetPathRequired: z.literal(true),
      })
      .strict(),
    externalId: z
      .object({
        label: localizedTextSchema,
        description: localizedTextSchema,
        placeholder: localizedTextSchema,
      })
      .strict(),
  })
  .strict()

const eventSourceRegistrationSchema = z
  .object({
    sourceId: machineIdSchema,
    version: z.number().int().positive(),
    displayName: localizedTextSchema,
    description: localizedTextSchema,
    observationMode: z.enum(['passive', 'active', 'hybrid']),
    observerProgramRef: exactResourceRefSchema.nullable(),
    pollIntervalMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1_000),
    batchSize: z.number().int().min(1).max(1_000),
  })
  .strict()

const eventTypeRegistrationSchema = z
  .object({
    eventTypeId: machineIdSchema,
    version: z.number().int().positive(),
    subjectTypeId: machineIdSchema,
    payloadSchemaId: machineIdSchema,
    displayName: localizedTextSchema,
    description: localizedTextSchema,
    deliveryClass: machineIdSchema,
    priority: z.number().int().min(0).max(100_000),
    preemptsContinuation: z.boolean(),
    sourceRef: exactResourceRefSchema,
  })
  .strict()

const attentionSubscriptionSchema = z
  .object({
    eventTypeId: machineIdSchema,
    subjectPath: z.string().min(1).max(300),
    sourceProfileRef: exactResourceRefSchema.nullable(),
    deliveryClass: machineIdSchema,
  })
  .strict()

const attentionRuleSchema = z
  .object({
    ruleId: machineIdSchema,
    contextTypeId: machineIdSchema,
    whenState: z.enum(['active', 'waiting', 'terminal', 'any']),
    subscriptions: z.array(attentionSubscriptionSchema).min(1).max(50),
  })
  .strict()

const reactionRuleSchema = z
  .object({
    ruleId: machineIdSchema,
    eventTypeId: machineIdSchema,
    requiredContextTypes: z.array(machineIdSchema).min(1).max(20),
    workItemRef: machineIdSchema,
    slotRef: machineIdSchema,
    allowedEffectKinds: z.array(machineIdSchema).max(100),
  })
  .strict()

const invocationContractSchema = z
  .object({
    contractId: machineIdSchema,
    inputSchemaId: machineIdSchema,
    resultSchemaId: machineIdSchema,
    milestoneEventTypeIds: z.array(machineIdSchema).max(30),
  })
  .strict()

export const employeeTypePackageDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    typeRef: employeeTypeRefSchema,
    displayName: localizedTextSchema,
    description: localizedTextSchema,
    workScopeContractId: machineIdSchema,
    workScopeAuthoring: workScopeAuthoringManifestSchema,
    workIntakeAuthoring: workIntakeAuthoringManifestSchema,
    authoringManifest: employeeAuthoringManifestSchema,
    workContracts: z.array(workContractSchema).min(1).max(200),
    contextTypes: z.array(contextTypeRegistrationSchema).min(1).max(100),
    eventSources: z.array(eventSourceRegistrationSchema).min(1).max(100),
    eventTypes: z.array(eventTypeRegistrationSchema).min(1).max(200),
    attentionRules: z.array(attentionRuleSchema).max(200),
    reactionRules: z.array(reactionRuleSchema).max(300),
    invocationContracts: z.array(invocationContractSchema).max(100),
  })
  .strict()

export type EmployeeTypePackageDescriptor = z.infer<typeof employeeTypePackageDescriptorSchema>

export interface EmployeeTypeRuntimePackage {
  readonly descriptor: EmployeeTypePackageDescriptor
  parseWorkScope(input: unknown): unknown
  summarizeWorkScope(scope: unknown, locale: 'zh-CN' | 'en-US'): string
  validateContractFixture(input: {
    readonly contract: WorkContract
    readonly implementation: ToolImplementation
  }): readonly ContractValidationCheck[]
}

export interface ContractValidationCheck {
  readonly code: string
  readonly ok: boolean
  readonly detail: string
}

export const contractValidationCheckSchema = z
  .object({
    code: z.string().min(1).max(200),
    ok: z.boolean(),
    detail: z.string().max(2_000),
  })
  .strict()

const agentToolImplementationSchema = z
  .object({
    kind: z.literal('agent'),
    agentRef: exactResourceRefSchema,
  })
  .strict()

const workflowToolImplementationSchema = z
  .object({
    kind: z.literal('workflow'),
    workflowRef: exactResourceRefSchema,
  })
  .strict()

const programToolImplementationSchema = z
  .object({
    kind: z.literal('program'),
    runtimeKind: z.enum(['bash', 'node', 'python']),
    executableArtifactRef: z.string().min(1).max(500),
    executableDigest: digestSchema,
    parameterValuesRef: z.string().min(1).max(500).nullable(),
    runtimeProfileRef: exactResourceRefSchema,
  })
  .strict()

export const toolImplementationSchema = z.discriminatedUnion('kind', [
  agentToolImplementationSchema,
  workflowToolImplementationSchema,
  programToolImplementationSchema,
])

export type ToolImplementation = z.infer<typeof toolImplementationSchema>

export const programToolAuthoringSchema = z
  .object({
    kind: z.literal('program'),
    runtimeKind: z.enum(['bash', 'node', 'python']),
    source: z
      .string()
      .min(1)
      .max(256 * 1024),
    parameterValues: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    runtimeProfileRef: exactResourceRefSchema,
  })
  .strict()

export const toolAuthoringImplementationSchema = z.discriminatedUnion('kind', [
  agentToolImplementationSchema,
  workflowToolImplementationSchema,
  programToolAuthoringSchema,
])

export type ToolAuthoringImplementation = z.infer<typeof toolAuthoringImplementationSchema>

export const createToolRegistrationBodySchema = z
  .object({
    displayName: z.string().min(1).max(200),
    description: z.string().max(2_000),
    roleRef: machineIdSchema,
    implementation: toolAuthoringImplementationSchema,
    connectionRef: exactResourceRefSchema.nullable().optional(),
  })
  .strict()

export type CreateToolRegistrationBody = z.infer<typeof createToolRegistrationBodySchema>

export const toolRegistrationContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    typeRef: employeeTypeRefSchema,
    workItemRef: machineIdSchema,
    workContractRef: workContractRefSchema,
    roleRef: machineIdSchema,
    displayName: z.string().min(1).max(200),
    description: z.string().max(2_000),
    implementation: toolImplementationSchema,
    connectionRef: exactResourceRefSchema.nullable(),
  })
  .strict()

export type ToolRegistrationContent = z.infer<typeof toolRegistrationContentSchema>

export const toolValidationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(['valid', 'invalid']),
    contractRef: workContractRefSchema,
    implementationDigest: digestSchema,
    checks: z
      .array(
        z
          .object({ code: z.string().min(1), ok: z.boolean(), detail: z.string().max(2_000) })
          .strict(),
      )
      .min(1),
    checkedAt: z.number().int().nonnegative(),
    receiptDigest: digestSchema,
  })
  .strict()

export type ToolValidationReceipt = z.infer<typeof toolValidationReceiptSchema>

export const employeeJobTemplateContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    typeRef: employeeTypeRefSchema,
    description: z.string().max(2_000),
    defaultToolBindings: z.array(workItemToolBindingSchema).max(300),
    defaultCollaborationBindings: z.array(employeeCollaborationBindingSchema).max(100),
  })
  .strict()

export type EmployeeJobTemplateContent = z.infer<typeof employeeJobTemplateContentSchema>

export const digitalEmployeeDefinitionDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    typeRef: employeeTypeRefSchema,
    jobTemplateRef: exactResourceRefSchema,
    displayName: z.string().min(1).max(200),
    enabled: z.boolean(),
    workScope: z.unknown(),
    toolOverrides: z.array(workItemToolBindingSchema).max(300),
    collaborationOverrides: z.array(employeeCollaborationBindingSchema).max(100),
  })
  .strict()

export type DigitalEmployeeDefinitionDraft = z.infer<typeof digitalEmployeeDefinitionDraftSchema>

export const digitalEmployeeDefinitionContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    typeRef: employeeTypeRefSchema,
    jobTemplateRef: exactResourceRefSchema,
    displayName: z.string().min(1).max(200),
    enabled: z.boolean(),
    workScopeRef: exactResourceRefSchema,
    workScopeSummary: z.string().min(1).max(500),
    exactToolBindings: z.array(workItemToolBindingSchema).max(300),
    exactCollaborationBindings: z.array(employeeCollaborationBindingSchema).max(100),
    compiledClosureDigest: digestSchema,
  })
  .strict()

export type DigitalEmployeeDefinitionContent = z.infer<
  typeof digitalEmployeeDefinitionContentSchema
>

export const globalExecutionPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    sameSceneAttempts: z.number().int().min(0).max(20),
    freshSceneAttempts: z.number().int().min(0).max(20),
    initialBackoffMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000),
    maxBackoffMs: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60 * 60 * 1000),
    roundBudgetMs: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 24 * 60 * 60 * 1000),
    caseBudgetMs: z
      .number()
      .int()
      .min(1_000)
      .max(365 * 24 * 60 * 60 * 1000),
    externalWaitDeadlineMs: z
      .number()
      .int()
      .min(1_000)
      .max(365 * 24 * 60 * 60 * 1000),
    handoffOnExhausted: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maxBackoffMs < value.initialBackoffMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxBackoffMs'],
        message: 'maximum backoff must be greater than or equal to initial backoff',
      })
    }
    if (value.caseBudgetMs < value.roundBudgetMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caseBudgetMs'],
        message: 'case budget must be greater than or equal to round budget',
      })
    }
  })

export type GlobalExecutionPolicy = z.infer<typeof globalExecutionPolicySchema>

export const DEFAULT_GLOBAL_EXECUTION_POLICY: GlobalExecutionPolicy = {
  schemaVersion: 1,
  sameSceneAttempts: 2,
  freshSceneAttempts: 2,
  initialBackoffMs: 2_000,
  maxBackoffMs: 120_000,
  roundBudgetMs: 2 * 60 * 60 * 1000,
  caseBudgetMs: 30 * 24 * 60 * 60 * 1000,
  externalWaitDeadlineMs: 14 * 24 * 60 * 60 * 1000,
  handoffOnExhausted: true,
}

export interface TypePackageViolation {
  readonly code: string
  readonly at: string
  readonly detail: string
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicate = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value)
    seen.add(value)
  }
  return [...duplicate].sort()
}

function refKey(ref: WorkContractRef): string {
  return `${ref.contractId}@${ref.version}`
}

export function validateTypePackage(
  descriptor: EmployeeTypePackageDescriptor,
): TypePackageViolation[] {
  const violations: TypePackageViolation[] = []
  const addDuplicates = (at: string, values: readonly string[]) => {
    for (const value of duplicateValues(values)) {
      violations.push({ code: 'duplicate-identity', at, detail: value })
    }
  }

  addDuplicates(
    'authoringManifest.lifecycleRegions',
    descriptor.authoringManifest.lifecycleRegions.map((region) => region.regionId),
  )
  for (const region of descriptor.authoringManifest.lifecycleRegions) {
    addDuplicates(
      `authoringManifest.lifecycleRegions.${region.regionId}.responsibilityLanes`,
      region.responsibilityLanes.map((lane) => lane.laneId),
    )
  }
  addDuplicates(
    'authoringManifest.workItems',
    descriptor.authoringManifest.workItems.map((item) => item.workItemRef),
  )
  addDuplicates(
    'workContracts',
    descriptor.workContracts.map((contract) => refKey(contract)),
  )
  addDuplicates(
    'contextTypes',
    descriptor.contextTypes.map((context) => context.typeId),
  )
  addDuplicates(
    'eventSources',
    descriptor.eventSources.map((source) => `${source.sourceId}@${source.version}`),
  )
  addDuplicates(
    'eventTypes',
    descriptor.eventTypes.map((event) => event.eventTypeId),
  )
  addDuplicates(
    'attentionRules',
    descriptor.attentionRules.map((rule) => rule.ruleId),
  )
  addDuplicates(
    'reactionRules',
    descriptor.reactionRules.map((rule) => rule.ruleId),
  )

  const regionIds = new Set(
    descriptor.authoringManifest.lifecycleRegions.map((region) => region.regionId),
  )
  const regions = new Map(
    descriptor.authoringManifest.lifecycleRegions.map(
      (region) => [region.regionId, region] as const,
    ),
  )
  const contracts = new Set(descriptor.workContracts.map((contract) => refKey(contract)))
  const contexts = new Set(descriptor.contextTypes.map((context) => context.typeId))
  const events = new Set(descriptor.eventTypes.map((event) => event.eventTypeId))
  const eventSources = new Set(
    descriptor.eventSources.map((source) => `${source.sourceId}@${source.version}`),
  )
  const workItems = new Map(
    descriptor.authoringManifest.workItems.map((item) => [item.workItemRef, item] as const),
  )

  for (const item of descriptor.authoringManifest.workItems) {
    if (!regionIds.has(item.regionId)) {
      violations.push({
        code: 'unknown-lifecycle-region',
        at: `workItems.${item.workItemRef}.regionId`,
        detail: item.regionId,
      })
    }
    const region = regions.get(item.regionId)
    if (
      item.responsibilityLaneId !== null &&
      !region?.responsibilityLanes.some((lane) => lane.laneId === item.responsibilityLaneId)
    ) {
      violations.push({
        code: 'unknown-responsibility-lane',
        at: `workItems.${item.workItemRef}.responsibilityLaneId`,
        detail: item.responsibilityLaneId,
      })
    }
    if (
      region !== undefined &&
      region.responsibilityLanes.length > 0 &&
      item.responsibilityLaneId === null
    ) {
      violations.push({
        code: 'missing-responsibility-lane',
        at: `workItems.${item.workItemRef}.responsibilityLaneId`,
        detail: item.regionId,
      })
    }
    if (!contracts.has(refKey(item.workContractRef))) {
      violations.push({
        code: 'unknown-work-contract',
        at: `workItems.${item.workItemRef}.workContractRef`,
        detail: refKey(item.workContractRef),
      })
    }
    const roleIds = item.toolRoleGroups.map((role) => role.roleRef)
    addDuplicates(`workItems.${item.workItemRef}.toolRoleGroups`, roleIds)
    const slots = item.toolRoleGroups.flatMap((role) =>
      role.bindingSlots.map((slot) => slot.slotRef),
    )
    addDuplicates(`workItems.${item.workItemRef}.bindingSlots`, slots)
    if (item.nodeKind === 'business-tool' && item.toolRoleGroups.length === 0) {
      violations.push({
        code: 'business-work-item-without-tool-slot',
        at: `workItems.${item.workItemRef}`,
        detail: item.workItemRef,
      })
    }
    const itemContract = descriptor.workContracts.find(
      (contract) => refKey(contract) === refKey(item.workContractRef),
    )
    if (item.nodeKind === 'business-tool' && itemContract?.allowedToolKinds.length === 0) {
      violations.push({
        code: 'business-work-item-without-tool-kind',
        at: `workItems.${item.workItemRef}.workContractRef`,
        detail: refKey(item.workContractRef),
      })
    }
    if (item.nodeKind === 'system' && item.toolRoleGroups.length !== 0) {
      violations.push({
        code: 'system-work-item-has-tool-slot',
        at: `workItems.${item.workItemRef}`,
        detail: item.workItemRef,
      })
    }
    if (item.nodeKind === 'collaboration') {
      if (
        item.collaborationContractId === null ||
        !descriptor.invocationContracts.some(
          (contract) => contract.contractId === item.collaborationContractId,
        )
      ) {
        violations.push({
          code: 'collaboration-work-item-contract-invalid',
          at: `workItems.${item.workItemRef}.collaborationContractId`,
          detail: item.collaborationContractId ?? 'missing',
        })
      }
    } else if (item.collaborationContractId !== null) {
      violations.push({
        code: 'non-collaboration-work-item-has-invocation-contract',
        at: `workItems.${item.workItemRef}.collaborationContractId`,
        detail: item.collaborationContractId,
      })
    }
    for (const next of item.nextWorkItemRefs) {
      if (!workItems.has(next)) {
        violations.push({
          code: 'unknown-next-work-item',
          at: `workItems.${item.workItemRef}.nextWorkItemRefs`,
          detail: next,
        })
      }
    }
  }

  for (const rule of descriptor.attentionRules) {
    if (!contexts.has(rule.contextTypeId)) {
      violations.push({
        code: 'unknown-context-type',
        at: `attentionRules.${rule.ruleId}.contextTypeId`,
        detail: rule.contextTypeId,
      })
    }
    for (const subscription of rule.subscriptions) {
      if (!events.has(subscription.eventTypeId)) {
        violations.push({
          code: 'unknown-event-type',
          at: `attentionRules.${rule.ruleId}.subscriptions`,
          detail: subscription.eventTypeId,
        })
      }
    }
  }

  for (const source of descriptor.eventSources) {
    if (source.observationMode !== 'passive' && source.observerProgramRef === null) {
      violations.push({
        code: 'active-event-source-without-observer',
        at: `eventSources.${source.sourceId}`,
        detail: source.observationMode,
      })
    }
  }

  for (const event of descriptor.eventTypes) {
    if (!eventSources.has(`${event.sourceRef.id}@${event.sourceRef.revision}`)) {
      violations.push({
        code: 'unknown-event-source',
        at: `eventTypes.${event.eventTypeId}.sourceRef`,
        detail: `${event.sourceRef.id}@${event.sourceRef.revision}`,
      })
    }
  }

  for (const rule of descriptor.reactionRules) {
    const item = workItems.get(rule.workItemRef)
    if (!events.has(rule.eventTypeId)) {
      violations.push({
        code: 'unknown-event-type',
        at: `reactionRules.${rule.ruleId}.eventTypeId`,
        detail: rule.eventTypeId,
      })
    }
    for (const context of rule.requiredContextTypes) {
      if (!contexts.has(context)) {
        violations.push({
          code: 'unknown-context-type',
          at: `reactionRules.${rule.ruleId}.requiredContextTypes`,
          detail: context,
        })
      }
    }
    if (item === undefined) {
      violations.push({
        code: 'unknown-work-item',
        at: `reactionRules.${rule.ruleId}.workItemRef`,
        detail: rule.workItemRef,
      })
      continue
    }
    const slotIds = new Set(
      item.toolRoleGroups.flatMap((role) => role.bindingSlots.map((slot) => slot.slotRef)),
    )
    const systemSlotMatches =
      (item.nodeKind === 'system' && rule.slotRef === 'system') ||
      (item.nodeKind === 'collaboration' && rule.slotRef === 'collaboration')
    if (!slotIds.has(rule.slotRef) && !systemSlotMatches) {
      violations.push({
        code: 'unknown-tool-slot',
        at: `reactionRules.${rule.ruleId}.slotRef`,
        detail: rule.slotRef,
      })
    }
  }

  return violations
}

export function packageDigest(descriptor: EmployeeTypePackageDescriptor): string {
  return sha256Hex(canonicalJson(descriptor))
}

export function contentDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function findWorkItem(
  descriptor: EmployeeTypePackageDescriptor,
  workItemRef: string,
): WorkItemDefinition | null {
  return (
    descriptor.authoringManifest.workItems.find((item) => item.workItemRef === workItemRef) ?? null
  )
}

export function findWorkContract(
  descriptor: EmployeeTypePackageDescriptor,
  ref: WorkContractRef,
): WorkContract | null {
  return (
    descriptor.workContracts.find(
      (contract) => contract.contractId === ref.contractId && contract.version === ref.version,
    ) ?? null
  )
}

export function findToolRole(
  item: WorkItemDefinition,
  roleRef: string,
): WorkItemDefinition['toolRoleGroups'][number] | null {
  return item.toolRoleGroups.find((role) => role.roleRef === roleRef) ?? null
}

export function findToolSlot(
  item: WorkItemDefinition,
  slotRef: string,
): { roleRef: string; required: boolean } | null {
  for (const role of item.toolRoleGroups) {
    const slot = role.bindingSlots.find((candidate) => candidate.slotRef === slotRef)
    if (slot !== undefined) return { roleRef: role.roleRef, required: slot.required }
  }
  return null
}

export function buildToolValidationReceipt(input: {
  readonly contract: WorkContract
  readonly implementation: ToolImplementation
  readonly checks: readonly ContractValidationCheck[]
  readonly checkedAt: number
}): ToolValidationReceipt {
  const core = {
    schemaVersion: 1 as const,
    status: input.checks.every((check) => check.ok) ? ('valid' as const) : ('invalid' as const),
    contractRef: {
      contractId: input.contract.contractId,
      version: input.contract.version,
    },
    implementationDigest: contentDigest(input.implementation),
    checks: input.checks.map((check) => ({ ...check })),
    checkedAt: input.checkedAt,
  }
  return { ...core, receiptDigest: contentDigest(core) }
}

export function mergeExactToolBindings(input: {
  readonly manifest: EmployeeAuthoringManifest
  readonly defaults: readonly WorkItemToolBinding[]
  readonly overrides: readonly WorkItemToolBinding[]
}): { bindings: WorkItemToolBinding[]; violations: TypePackageViolation[] } {
  const violations: TypePackageViolation[] = []
  const allowed = new Map<string, { workItemRef: string; slotRef: string; required: boolean }>()
  for (const item of input.manifest.workItems) {
    for (const role of item.toolRoleGroups) {
      for (const slot of role.bindingSlots) {
        allowed.set(`${item.workItemRef}\u0000${slot.slotRef}`, {
          workItemRef: item.workItemRef,
          slotRef: slot.slotRef,
          required: slot.required,
        })
      }
    }
  }

  const merged = new Map<string, WorkItemToolBinding>()
  const apply = (bindings: readonly WorkItemToolBinding[], source: string) => {
    const seen = new Set<string>()
    for (const binding of bindings) {
      const key = `${binding.workItemRef}\u0000${binding.slotRef}`
      if (!allowed.has(key)) {
        violations.push({
          code: 'unknown-tool-slot',
          at: source,
          detail: `${binding.workItemRef}/${binding.slotRef}`,
        })
        continue
      }
      if (seen.has(key)) {
        violations.push({
          code: 'duplicate-tool-binding',
          at: source,
          detail: `${binding.workItemRef}/${binding.slotRef}`,
        })
        continue
      }
      seen.add(key)
      merged.set(key, binding)
    }
  }
  apply(input.defaults, 'jobTemplate.defaultToolBindings')
  apply(input.overrides, 'employee.toolOverrides')

  for (const [key, slot] of allowed) {
    if (slot.required && !merged.has(key)) {
      violations.push({
        code: 'required-tool-binding-missing',
        at: `workItems.${slot.workItemRef}`,
        detail: `${slot.workItemRef}/${slot.slotRef}`,
      })
    }
  }

  const bindings = [...merged.values()].sort((a, b) => {
    const left = `${a.workItemRef}\u0000${a.slotRef}`
    const right = `${b.workItemRef}\u0000${b.slotRef}`
    return left < right ? -1 : left > right ? 1 : 0
  })
  return { bindings, violations }
}
