// RFC-344 — transport-neutral application surface for development configuration.
//
// HTTP owns request decoding and response status.  This contract owns the
// current-user use cases; no Hono context, route, AppDeps or repository handle
// crosses the boundary.

import { z } from 'zod'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { nextDecisionSchema } from '../domain/decision'
import { factCellSchema } from '../domain/factCell'
import { factPredicateSchema } from '../domain/predicate'
import { defineCommandOperation, defineQueryOperation } from '@/platform/operations/definitions'

/** Branded authority minted by identity-access; never a transport Actor. */
type Actor = DirectAuthenticatedAuthority

export type DevelopmentConfigResourceKind =
  | 'action-template'
  | 'verification-profile'
  | 'digital-employee'
  | 'automation-policy'
  | 'development-adapter'

export interface DevelopmentConfigIdentityView {
  readonly id: string
  readonly name: string
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
  readonly [key: string]: unknown
}

export interface DevelopmentConfigAclRow {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
}

export const developmentConfigCreateInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    draft: z.unknown().optional(),
    capabilityId: z.string().min(1).optional(),
    purpose: z
      .enum(['requirement-source', 'pipeline-gate', 'pipeline-classifier', 'approval-gateway'])
      .optional(),
  })
  .strict()

export const developmentConfigReviseInputSchema = z
  .object({ name: z.string().min(1).max(200).optional(), draft: z.unknown() })
  .strict()

export const developmentEmployeePlaybookInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    playbook: z.unknown(),
  })
  .strict()

export const developmentAssignmentInputSchema = z
  .object({
    scopeKind: z.enum(['repository', 'repository-group', 'global-default']),
    scopeRef: z.string().min(1).nullable(),
    employee: z
      .object({ id: z.string().min(1), revision: z.number().int().positive() })
      .strict()
      .nullable(),
    selectionPolicy: z
      .object({ id: z.string().min(1), revision: z.number().int().positive() })
      .strict()
      .nullable(),
    executionPolicy: z
      .object({ id: z.string().min(1), revision: z.number().int().positive() })
      .strict()
      .nullable(),
    defaultRequirementSourceKey: z.string().min(1).nullable(),
  })
  .strict()

const guardSchema = z
  .object({
    missionTerminal: z.boolean(),
    mrTerminal: z.enum(['active', 'merged', 'closed', 'not-applicable']),
    holdsLease: z.boolean(),
    activeWritableAction: z.boolean(),
    unsettledEffect: z.boolean(),
    transitionFence: z.enum(['none', 'cancel-pending', 'handoff-pending']),
    factIntegrityViolations: z.array(z.string()),
    staleBaseline: z.boolean(),
    authorityViolations: z.array(z.string()),
    exhaustedBudgets: z.array(z.string()),
    automationMode: z.enum(['active', 'tracking-only']),
    uploadSeed: z.enum(['not-applicable', 'pending', 'seeded', 'published']),
    uploadPlanRef: z.string().nullable(),
  })
  .strict()

const cellsSchema = z.record(
  factCellSchema(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
)

export const developmentPolicyPreviewInputSchema = z
  .object({
    guards: guardSchema,
    cells: cellsSchema,
    rules: z.array(
      z
        .object({
          ruleId: z.string().min(1),
          when: z.array(factPredicateSchema),
          decision: nextDecisionSchema,
        })
        .strict(),
    ),
  })
  .strict()

const selectionRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    when: z.array(factPredicateSchema),
    employeeRef: z.string().min(1),
  })
  .strict()

export const developmentSelectionPreviewInputSchema = z
  .object({
    explicitEmployeeRef: z.string().min(1).nullable(),
    assignment: z
      .object({
        scope: z.enum(['repository', 'repository-group', 'global-default']),
        employeeRef: z.string().min(1).nullable(),
        selectionRules: z.array(selectionRuleSchema).nullable(),
        executionPolicyRef: z.string().min(1).nullable(),
        defaultRequirementSourceKey: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    explicitFallbackRef: z.string().min(1).nullable(),
    cells: cellsSchema,
  })
  .strict()

export type DevelopmentConfigCreateInput = z.infer<typeof developmentConfigCreateInputSchema>
export type DevelopmentConfigReviseInput = z.infer<typeof developmentConfigReviseInputSchema>
export type DevelopmentEmployeePlaybookInput = z.infer<
  typeof developmentEmployeePlaybookInputSchema
>
export type DevelopmentAssignmentInput = z.infer<typeof developmentAssignmentInputSchema>
export type DevelopmentPolicyPreviewInput = z.infer<typeof developmentPolicyPreviewInputSchema>
export type DevelopmentSelectionPreviewInput = z.infer<
  typeof developmentSelectionPreviewInputSchema
>

export interface DevelopmentConfigResourceOperations {
  readonly kind: DevelopmentConfigResourceKind
  list(actor: Actor): Promise<DevelopmentConfigIdentityView[]>
  get(
    actor: Actor,
    id: string,
  ): Promise<(DevelopmentConfigIdentityView & { readonly draft?: unknown }) | null>
  create(actor: Actor, input: DevelopmentConfigCreateInput): Promise<DevelopmentConfigIdentityView>
  revise(actor: Actor, id: string, input: DevelopmentConfigReviseInput): Promise<void>
  publish(
    actor: Actor,
    id: string,
  ): Promise<{ readonly revision: number; readonly contentDigest: string }>
  archive(actor: Actor, id: string): Promise<void>
  loadAclRow(id: string): Promise<DevelopmentConfigAclRow | null>
}

export interface DevelopmentConfigOperations {
  readonly resources: Readonly<
    Record<DevelopmentConfigResourceKind, DevelopmentConfigResourceOperations>
  >
  readEmployeePlaybook(actor: Actor, id: string): Promise<Record<string, unknown>>
  reviseEmployeePlaybook(
    actor: Actor,
    id: string,
    input: DevelopmentEmployeePlaybookInput,
  ): Promise<{ readonly ok: true; readonly nextLocation: string }>
  validateEmployeePlaybook(actor: Actor, id: string): Promise<Record<string, unknown>>
  readSetupJourney(actor: Actor, employeeId?: string): Promise<Record<string, unknown>>
  listAssignments(): Promise<ReadonlyArray<unknown>>
  upsertAssignment(actor: Actor, input: DevelopmentAssignmentInput): Promise<unknown>
  deleteAssignment(
    scopeKind: DevelopmentAssignmentInput['scopeKind'],
    scopeRef: string | null,
  ): Promise<void>
  previewPolicy(input: DevelopmentPolicyPreviewInput): Promise<unknown>
  previewSelection(input: DevelopmentSelectionPreviewInput): Promise<unknown>
}

const publicErrors = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)
const emptySchema = z.object({}).strict()
const idSchema = z.object({ id: z.string().min(1) }).strict()
const identityViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    publishedRevision: z.number().int().nullable(),
    ownerUserId: z.string().nullable(),
    visibility: z.enum(['private', 'public']),
    createdAt: z.number(),
    updatedAt: z.number(),
    archivedAt: z.number().nullable(),
  })
  .catchall(z.unknown())
const reviseWithIdSchema = z
  .object({ id: z.string().min(1), ...developmentConfigReviseInputSchema.shape })
  .strict()
const publishReceiptSchema = z
  .object({ revision: z.number().int().positive(), contentDigest: z.string().min(1) })
  .strict()

const RESOURCE_DESCRIPTOR_PRESENTATION = Object.freeze({
  'action-template': {
    idNoun: 'action-template',
    idPlural: 'action-templates',
    permissionPrefix: 'action-templates',
    summaryNoun: 'action template',
  },
  'verification-profile': {
    idNoun: 'verification-profile',
    idPlural: 'verification-profiles',
    permissionPrefix: 'verification-profiles',
    summaryNoun: 'verification profile',
  },
  'digital-employee': {
    idNoun: 'digital-employee',
    idPlural: 'digital-employees',
    permissionPrefix: 'digital-employees',
    summaryNoun: 'digital employee',
  },
  'automation-policy': {
    idNoun: 'automation-policy',
    idPlural: 'automation-policies',
    permissionPrefix: 'automation-policies',
    summaryNoun: 'automation policy',
  },
  'development-adapter': {
    idNoun: 'development-adapter',
    idPlural: 'development-adapters',
    permissionPrefix: 'adapter-definitions',
    summaryNoun: 'development adapter',
  },
} as const)

export function createDevelopmentConfigResourceDescriptors(
  operations: DevelopmentConfigResourceOperations,
) {
  const presentation = RESOURCE_DESCRIPTOR_PRESENTATION[operations.kind]
  const permission = (verb: 'read' | 'create' | 'update' | 'archive') =>
    [`${presentation.permissionPrefix}:${verb}`] as const
  const prefix = `development-automation`
  const noun = presentation.idNoun
  return Object.freeze({
    list: defineQueryOperation({
      id: `${prefix}.list-${presentation.idPlural}.v1`,
      summary: `List visible ${presentation.summaryNoun}s`,
      permissions: permission('read'),
      publicErrors,
      inputSchema: emptySchema,
      outputSchema: z.array(identityViewSchema),
      invoke: async (actor: Actor) => [...(await operations.list(actor))],
    }),
    create: defineCommandOperation({
      id: `${prefix}.create-${noun}.v1`,
      summary: `Create a ${presentation.summaryNoun} draft`,
      permissions: permission('create'),
      publicErrors,
      inputSchema: developmentConfigCreateInputSchema,
      outputSchema: identityViewSchema,
      invoke: (actor: Actor, input: DevelopmentConfigCreateInput) =>
        operations.create(actor, input),
    }),
    get: defineQueryOperation({
      id: `${prefix}.get-${noun}.v1`,
      summary: `Read one ${presentation.summaryNoun} (draft + published head)`,
      permissions: permission('read'),
      publicErrors,
      inputSchema: idSchema,
      outputSchema: identityViewSchema.nullable(),
      invoke: (actor: Actor, input: z.infer<typeof idSchema>) => operations.get(actor, input.id),
    }),
    revise: defineCommandOperation({
      id: `${prefix}.revise-${noun}.v1`,
      summary: `Revise a ${presentation.summaryNoun} draft`,
      permissions: permission('update'),
      publicErrors,
      inputSchema: reviseWithIdSchema,
      outputSchema: z.void(),
      invoke: (actor: Actor, input: z.infer<typeof reviseWithIdSchema>) =>
        operations.revise(actor, input.id, input),
    }),
    publish: defineCommandOperation({
      id: `${prefix}.publish-${noun}.v1`,
      summary: `Publish an immutable ${presentation.summaryNoun} revision`,
      permissions: permission('update'),
      publicErrors,
      inputSchema: idSchema,
      outputSchema: publishReceiptSchema,
      invoke: (actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.publish(actor, input.id),
    }),
    archive: defineCommandOperation({
      id: `${prefix}.archive-${noun}.v1`,
      summary: `Archive a ${presentation.summaryNoun} (references stay resolvable)`,
      permissions: permission('archive'),
      publicErrors,
      inputSchema: idSchema,
      outputSchema: z.void(),
      invoke: (actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.archive(actor, input.id),
    }),
  })
}

const jsonRecordSchema = z.record(z.unknown())
const employeeIdSchema = z.object({ employeeId: z.string().min(1).optional() }).strict()
const playbookWithIdSchema = z
  .object({ id: z.string().min(1), ...developmentEmployeePlaybookInputSchema.shape })
  .strict()
const assignmentDeleteSchema = z
  .object({
    scopeKind: developmentAssignmentInputSchema.shape.scopeKind,
    scopeRef: z.string().nullable(),
  })
  .strict()

export function createDevelopmentConfigSupplementalDescriptors(
  operations: DevelopmentConfigOperations,
) {
  return Object.freeze({
    readEmployeePlaybook: defineQueryOperation({
      id: 'development-automation.read-employee-playbook.v1',
      summary: 'Read one business digital-employee playbook with validation and next action',
      permissions: ['digital-employees:read'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.readEmployeePlaybook(actor, input.id),
    }),
    reviseEmployeePlaybook: defineCommandOperation({
      id: 'development-automation.revise-employee-playbook.v1',
      summary: 'Revise one complete business digital-employee playbook',
      permissions: ['digital-employees:update'],
      publicErrors,
      inputSchema: playbookWithIdSchema,
      outputSchema: z.object({ ok: z.literal(true), nextLocation: z.string().min(1) }).strict(),
      invoke: (actor: Actor, input: z.infer<typeof playbookWithIdSchema>) =>
        operations.reviseEmployeePlaybook(actor, input.id, input),
    }),
    validateEmployeePlaybook: defineQueryOperation({
      id: 'development-automation.validate-employee-playbook.v1',
      summary: 'Validate and compile the current business digital-employee playbook',
      permissions: ['digital-employees:read'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.validateEmployeePlaybook(actor, input.id),
    }),
    readSetupJourney: defineQueryOperation({
      id: 'development-automation.read-setup-journey.v1',
      summary: 'Read the single next action for first-time digital-employee setup',
      permissions: ['digital-employees:read'],
      publicErrors,
      inputSchema: employeeIdSchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof employeeIdSchema>) =>
        operations.readSetupJourney(actor, input.employeeId),
    }),
    listAssignments: defineQueryOperation({
      id: 'development-automation.list-repository-assignments.v1',
      summary: 'List repository/group/global digital-employee assignments',
      permissions: ['repository-employee-assignments:read'],
      publicErrors,
      inputSchema: emptySchema,
      outputSchema: z.array(z.unknown()),
      invoke: async () => [...(await operations.listAssignments())],
    }),
    upsertAssignment: defineCommandOperation({
      id: 'development-automation.upsert-repository-assignment.v1',
      summary: 'Upsert the single assignment for one scope',
      permissions: ['repository-employee-assignments:update'],
      publicErrors,
      inputSchema: developmentAssignmentInputSchema,
      outputSchema: z.unknown(),
      invoke: (actor: Actor, input: DevelopmentAssignmentInput) =>
        operations.upsertAssignment(actor, input),
    }),
    deleteAssignment: defineCommandOperation({
      id: 'development-automation.delete-repository-assignment.v1',
      summary: 'Delete the assignment for one scope (scopeRef via query)',
      permissions: ['repository-employee-assignments:update'],
      publicErrors,
      inputSchema: assignmentDeleteSchema,
      outputSchema: z.void(),
      invoke: (_actor: Actor, input: z.infer<typeof assignmentDeleteSchema>) =>
        operations.deleteAssignment(input.scopeKind, input.scopeRef),
    }),
    previewPolicy: defineQueryOperation({
      id: 'development-automation.preview-policy-decision.v1',
      summary: 'Simulate the fixed-guard + first-match evaluator on fixture facts',
      permissions: ['automation-policies:read'],
      publicErrors,
      inputSchema: developmentPolicyPreviewInputSchema,
      outputSchema: z.unknown(),
      invoke: (_actor: Actor, input: DevelopmentPolicyPreviewInput) =>
        operations.previewPolicy(input),
    }),
    previewSelection: defineQueryOperation({
      id: 'development-automation.preview-employee-selection.v1',
      summary: 'Simulate deterministic employee selection on fixture facts',
      permissions: ['digital-employees:read'],
      publicErrors,
      inputSchema: developmentSelectionPreviewInputSchema,
      outputSchema: z.unknown(),
      invoke: (_actor: Actor, input: DevelopmentSelectionPreviewInput) =>
        operations.previewSelection(input),
    }),
  })
}
