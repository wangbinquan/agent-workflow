import {
  canonicalJson,
  PLATFORM_WORKSPACE_DIR,
  type TaskLaunchOrigin,
} from '@agent-workflow/shared'
import { z } from 'zod'

import { sha256Hex } from '@/util/hash'
import { exactResourceRefSchema } from './model'

const contextLifecycleSchema = z.enum(['active', 'waiting', 'terminal'])

function isStrictRepositoryAncestor(ancestor: string, candidate: string): boolean {
  const ancestorSegments = ancestor.split('/')
  const candidateSegments = candidate.split('/')
  return (
    ancestorSegments.length < candidateSegments.length &&
    ancestorSegments.every((segment, index) => candidateSegments[index] === segment)
  )
}

const repositoryTargetPathSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[a-zA-Z]:[\\/]/.test(value) &&
      !value.includes('\\') &&
      value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'target path must be a normalized repository-relative path',
  )
  .refine((value) => {
    const root = value.split('/')[0]?.toLowerCase()
    return root !== '.git' && root !== PLATFORM_WORKSPACE_DIR
  }, 'target path must not overlap platform-owned repository paths')

export const employeeWorkIntakeSchema = z
  .object({
    /** Operator-owned logical task name; event admissions may derive one from event material. */
    name: z.string().trim().min(1).max(255).optional(),
    kind: z.enum(['body', 'files', 'body-and-files', 'external-id']),
    target: z.record(z.string().min(1).max(160), z.string().min(1).max(1_000)),
    body: z
      .string()
      .min(1)
      .max(2 * 1024 * 1024)
      .nullable(),
    externalId: z.string().min(1).max(500).nullable(),
    uploads: z
      .array(
        z
          .object({
            uploadRef: z.string().min(1).max(200),
            placement: z.enum(['repository', 'temporary']).default('repository'),
            targetPath: repositoryTargetPathSchema.nullable().default(null),
          })
          .strict()
          .superRefine((upload, ctx) => {
            if (upload.placement === 'repository' && upload.targetPath === null) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['targetPath'],
                message: 'repository placement requires a target path',
              })
            }
            if (upload.placement === 'temporary' && upload.targetPath !== null) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['targetPath'],
                message: 'temporary placement path is allocated by the platform',
              })
            }
          }),
      )
      .max(500),
    executionOptions: z.record(z.string().min(1).max(160), z.boolean()).default({}),
    idempotencyKey: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    const needsBody = value.kind === 'body' || value.kind === 'body-and-files'
    const needsFiles = value.kind === 'files' || value.kind === 'body-and-files'
    if (needsBody && value.body === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'body is required for this input kind' })
    }
    if (!needsBody && value.body !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'body is not allowed for this input kind',
      })
    }
    if (needsFiles && value.uploads.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'uploads are required for this input kind',
      })
    }
    if (!needsFiles && value.uploads.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'uploads are not allowed for this input kind',
      })
    }
    if (value.kind === 'external-id' && value.externalId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'externalId is required' })
    }
    if (value.kind !== 'external-id' && value.externalId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'externalId is not allowed for this input kind',
      })
    }
    const targetPaths = value.uploads.flatMap((upload) =>
      upload.placement === 'repository' && upload.targetPath !== null ? [upload.targetPath] : [],
    )
    if (new Set(targetPaths).size !== targetPaths.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'upload target paths must be unique' })
    }
    const prefixConflict = targetPaths.some((target, index) =>
      targetPaths.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          (isStrictRepositoryAncestor(other, target) || isStrictRepositoryAncestor(target, other)),
      ),
    )
    if (prefixConflict) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'upload target paths must not be ancestors or descendants of each other',
      })
    }
  })

export type EmployeeWorkIntake = z.infer<typeof employeeWorkIntakeSchema>

export const employeeCaseLaunchSchema = z
  .object({
    employeeRef: exactResourceRefSchema,
    primaryContextTypeId: z.string().min(1).max(200),
    primaryContextSchemaVersion: z.number().int().positive(),
    primaryContextState: contextLifecycleSchema,
    primaryContextJson: z
      .string()
      .min(2)
      .max(2 * 1024 * 1024),
    artifactRefs: z.array(z.string().min(1).max(1_000)).max(500),
    workSubject: z
      .object({ typeId: z.string().min(1).max(200), subjectRef: z.string().min(1).max(1_000) })
      .strict(),
  })
  .strict()

export type EmployeeCaseLaunch = z.infer<typeof employeeCaseLaunchSchema>

export interface EmployeeCaseRecord {
  readonly id: string
  readonly name: string
  readonly employeeRef: { readonly id: string; readonly revision: number }
  readonly typeRef: { readonly typeId: string; readonly revision: number }
  readonly primaryContextId: string
  readonly executionPolicyRevision: number
  readonly ownerUserId: string | null
  readonly launchOrigin: TaskLaunchOrigin
  readonly state: 'active' | 'waiting' | 'blocked' | 'terminal'
  readonly terminalKind: string | null
  readonly blockReason: string | null
  readonly currentWorkItemRef: string | null
  readonly activeRoundId: string | null
  readonly revision: number
  readonly writerGeneration: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt: number | null
}

export const MAX_EMPLOYEE_INVOCATION_DEPTH = 8
export const MAX_CHILD_INVOCATIONS_PER_CASE = 16

export type EmployeeInvocationGuardResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code:
        | 'employee-collaboration-child-budget-exhausted'
        | 'employee-collaboration-depth-exhausted'
        | 'employee-collaboration-ancestry-invalid'
        | 'employee-collaboration-cycle'
      readonly detail: string
    }

export function evaluateEmployeeInvocationGuard(input: {
  readonly ancestry: readonly { readonly caseId: string; readonly employeeId: string }[]
  readonly targetEmployeeId: string
  readonly outboundInvocationCount: number
}): EmployeeInvocationGuardResult {
  if (input.outboundInvocationCount >= MAX_CHILD_INVOCATIONS_PER_CASE) {
    return {
      ok: false,
      code: 'employee-collaboration-child-budget-exhausted',
      detail: `employee case already created ${MAX_CHILD_INVOCATIONS_PER_CASE} child invocations`,
    }
  }
  if (input.ancestry.length >= MAX_EMPLOYEE_INVOCATION_DEPTH) {
    return {
      ok: false,
      code: 'employee-collaboration-depth-exhausted',
      detail: `employee invocation depth reached ${MAX_EMPLOYEE_INVOCATION_DEPTH}`,
    }
  }
  if (new Set(input.ancestry.map((entry) => entry.caseId)).size !== input.ancestry.length) {
    return {
      ok: false,
      code: 'employee-collaboration-ancestry-invalid',
      detail: 'employee invocation ancestry contains a case cycle',
    }
  }
  if (input.ancestry.some((entry) => entry.employeeId === input.targetEmployeeId)) {
    return {
      ok: false,
      code: 'employee-collaboration-cycle',
      detail: `employee ${input.targetEmployeeId} already appears in the invocation ancestry`,
    }
  }
  return { ok: true }
}

export function evaluateEmployeeInvocationJoin(input: {
  readonly mode: 'all' | 'any' | 'quorum'
  readonly quorum: number | null
  readonly memberStates: readonly ('waiting' | 'satisfied' | 'failed' | 'detached')[]
}): 'waiting' | 'satisfied' | 'failed' {
  if (input.memberStates.length === 0) throw new Error('employee invocation join has no members')
  const satisfied = input.memberStates.filter((state) => state === 'satisfied').length
  const failed = input.memberStates.filter(
    (state) => state === 'failed' || state === 'detached',
  ).length
  const remaining = input.memberStates.length - satisfied - failed
  if (input.mode === 'all') {
    if (failed > 0) return 'failed'
    return satisfied === input.memberStates.length ? 'satisfied' : 'waiting'
  }
  if (input.mode === 'any') {
    if (satisfied > 0) return 'satisfied'
    return remaining === 0 ? 'failed' : 'waiting'
  }
  if (input.quorum === null || input.quorum < 1 || input.quorum > input.memberStates.length) {
    throw new Error('employee invocation quorum is outside member cardinality')
  }
  if (satisfied >= input.quorum) return 'satisfied'
  return satisfied + remaining < input.quorum ? 'failed' : 'waiting'
}

export interface EmployeeContextRecord {
  readonly id: string
  readonly caseId: string
  readonly typeId: string
  readonly schemaVersion: number
  readonly revision: number
  readonly lifecycleState: 'active' | 'waiting' | 'terminal'
  readonly stateJson: string
  readonly artifactRefs: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CaseInboxRecord {
  readonly id: string
  readonly caseId: string
  readonly deliveryId: string
  readonly eventId: string
  readonly eventTypeRef: { readonly id: string; readonly revision: number }
  readonly sourceRef: { readonly id: string; readonly revision: number }
  readonly subject: { readonly typeId: string; readonly subjectRef: string }
  readonly deliveryClass: string
  readonly priority: number
  readonly occurredAt: number
  readonly summary: string
  readonly payloadArtifactRef: string | null
  readonly state: 'pending' | 'claimed' | 'settled' | 'coalesced' | 'obsolete'
  readonly roundId: string | null
  readonly acceptedAt: number
  readonly settledAt: number | null
}

export interface ReactionRoundRecord {
  readonly id: string
  readonly caseId: string
  readonly caseRevision: number
  readonly inboxId: string | null
  readonly employeeRef: { readonly id: string; readonly revision: number }
  readonly ruleId: string
  readonly workItemRef: string
  readonly workContractRef: { readonly contractId: string; readonly version: number }
  readonly toolRef: { readonly id: string; readonly revision: number } | null
  readonly executionPolicyRevision: number
  readonly inputContextRefsJson: string
  readonly planJson: string
  readonly state: 'planned' | 'running' | 'settling' | 'completed' | 'failed' | 'obsolete'
  readonly executionRef: string | null
  readonly outputJson: string | null
  readonly attemptOrdinal: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly settledAt: number | null
}

export const attentionSubjectSchema = z
  .object({
    eventTypeRef: exactResourceRefSchema,
    subject: z
      .object({ typeId: z.string().min(1).max(200), subjectRef: z.string().min(1).max(1_000) })
      .strict(),
  })
  .strict()

export type AttentionSubject = z.infer<typeof attentionSubjectSchema>

export const reactionExecutionPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    roundRef: z.string().min(1),
    executionNonce: z.string().regex(/^[a-f0-9]{64}$/),
    caseRef: z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict(),
    inputContextRefs: z.array(
      z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict(),
    ),
    triggeringEventRef: z.string().min(1),
    workItemRef: z.string().min(1),
    toolSlotRef: z.string().min(1),
    workContractRef: z
      .object({ contractId: z.string().min(1), version: z.number().int().positive() })
      .strict(),
    toolRegistrationRef: exactResourceRefSchema.nullable(),
    connectionRef: exactResourceRefSchema.nullable(),
    implementationRef: exactResourceRefSchema.nullable(),
    implementationKind: z.enum(['agent', 'workflow', 'program', 'system', 'collaboration']),
    implementationJson: z.string().min(2).nullable(),
    inputSchemaId: z.string().min(1),
    outputSchemaId: z.string().min(1),
    semanticValidatorId: z.string().min(1),
    executionPolicyRevision: z.number().int().positive(),
    roundBudgetMs: z.number().int().positive(),
    externalWaitDeadlineMs: z.number().int().positive(),
    allowedEffectKinds: z.array(z.string().min(1)).max(100),
    workspacePolicy: z
      .object({
        mode: z.enum(['write', 'read-only', 'none']),
        businessChangeOnOk: z.enum(['required', 'forbidden', 'optional']),
        writablePrefixes: z.array(z.string().min(1).max(1_000)).max(200),
        platformWritePrefixes: z.array(z.enum(['inputs/requirements', 'pipeline'])).max(2),
      })
      .strict(),
    inputEnvelopeJson: z.string().min(2),
  })
  .strict()

export type ReactionExecutionPlan = z.infer<typeof reactionExecutionPlanSchema>

export function runtimeDigest(value: object): string {
  return sha256Hex(canonicalJson(value))
}
