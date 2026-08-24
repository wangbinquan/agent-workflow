import { z } from 'zod'

export const DEVELOPMENT_TOOL_CONTRACT_IDS_V2 = [
  'development.prepare-materials',
  'development.plan-implementation',
  'development.implement-change',
  'development.resolve-review-feedback',
  'development.collect-pipeline-status',
  'development.classify-pipeline-failures',
  'development.repair-pipeline-failures',
  'development.resolve-merge-conflicts',
  'development.draft-approval',
] as const

export type DevelopmentToolContractIdV2 = (typeof DEVELOPMENT_TOOL_CONTRACT_IDS_V2)[number]

const refSchema = z
  .object({ id: z.string().min(1).max(500), revision: z.number().int().positive() })
  .strict()
const pathSchema = z.string().min(1).max(2_000)
const versionSchema = z.string().min(1).max(500)
const explanationSchema = z.string().trim().min(1).max(8_000)
const optionalCompletionExplanation = { explanation: explanationSchema.optional() } as const
const blockedSchema = z
  .object({ outcome: z.literal('blocked'), explanation: explanationSchema })
  .strict()

const prepareMaterialsInputSchema = z
  .object({
    connection: refSchema,
    externalItemId: z.string().trim().min(1).max(500),
    outputDirectory: pathSchema,
  })
  .strict()

const planImplementationInputSchema = z
  .object({ requirementsDirectory: pathSchema, outputFile: pathSchema })
  .strict()

const implementChangeInputSchema = z
  .object({
    requirementsDirectory: pathSchema,
    approvedPlanFile: pathSchema.optional(),
  })
  .strict()

const reviewMessageSchema = z
  .object({
    author: z.enum(['human', 'bot', 'self']),
    body: z.string().max(32_000),
  })
  .strict()

const reviewThreadSchema = z
  .object({
    threadRef: z.string().min(1).max(500),
    file: z.string().min(1).max(1_000).optional(),
    messages: z.array(reviewMessageSchema).min(1).max(500),
  })
  .strict()

const resolveReviewFeedbackInputSchema = z
  .object({
    requirementsDirectory: pathSchema,
    threads: z.array(reviewThreadSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.threads.map((thread) => thread.threadRef)).size !== value.threads.length) {
      ctx.addIssue({ code: 'custom', path: ['threads'], message: 'threadRef must be unique' })
    }
  })

const collectPipelineStatusInputSchema = z
  .object({
    connection: refSchema,
    mergeRequest: z.string().min(1).max(1_000),
    evidenceDirectory: pathSchema,
  })
  .strict()

const failedCheckSchema = z
  .object({
    checkRef: z.string().min(1).max(500),
    name: z.string().min(1).max(500),
    summary: z.string().min(1).max(4_000).optional(),
    evidenceFiles: z.array(pathSchema).min(1).max(100).optional(),
  })
  .strict()

const failureCategorySchema = z
  .object({
    type: z.string().min(1).max(160),
    name: z.string().min(1).max(500),
    description: z.string().max(4_000),
  })
  .strict()

const classifyPipelineFailuresInputSchema = z
  .object({
    failedChecks: z.array(failedCheckSchema).min(1).max(500),
    categories: z.array(failureCategorySchema).min(1).max(100),
    fallbackType: z.string().min(1).max(160),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.failedChecks.map((check) => check.checkRef)).size !== value.failedChecks.length
    ) {
      ctx.addIssue({ code: 'custom', path: ['failedChecks'], message: 'checkRef must be unique' })
    }
    const types = value.categories.map((category) => category.type)
    if (new Set(types).size !== types.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['categories'],
        message: 'category type must be unique',
      })
    }
    if (!types.includes(value.fallbackType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['fallbackType'],
        message: 'fallbackType must name one configured category',
      })
    }
  })

const repairPipelineFailuresInputSchema = z
  .object({
    failureType: z.string().min(1).max(160),
    problems: z
      .array(
        z
          .object({
            summary: z.string().min(1).max(4_000),
            evidenceFiles: z.array(pathSchema).min(1).max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict()

const resolveMergeConflictsInputSchema = z
  .object({
    sourceVersion: versionSchema,
    targetVersion: versionSchema,
    conflictFiles: z.array(pathSchema).min(1).max(2_000),
    requirementsDirectory: pathSchema,
  })
  .strict()

const draftApprovalInputSchema = z
  .object({
    mergeRequest: z.string().min(1).max(1_000),
    currentVersion: versionSchema,
    approvalType: z.string().min(1).max(120),
    gateConclusions: z
      .array(
        z
          .object({
            name: z.string().min(1).max(500),
            conclusion: z.enum(['passed', 'failed', 'not-applicable']),
            summary: z.string().min(1).max(4_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    formatGuide: z.string().min(1).max(8_000),
  })
  .strict()

export const developmentToolInputSchemasV2 = {
  'development.prepare-materials': prepareMaterialsInputSchema,
  'development.plan-implementation': planImplementationInputSchema,
  'development.implement-change': implementChangeInputSchema,
  'development.resolve-review-feedback': resolveReviewFeedbackInputSchema,
  'development.collect-pipeline-status': collectPipelineStatusInputSchema,
  'development.classify-pipeline-failures': classifyPipelineFailuresInputSchema,
  'development.repair-pipeline-failures': repairPipelineFailuresInputSchema,
  'development.resolve-merge-conflicts': resolveMergeConflictsInputSchema,
  'development.draft-approval': draftApprovalInputSchema,
} as const

const completedSignalSchema = z
  .object({ outcome: z.literal('completed'), ...optionalCompletionExplanation })
  .strict()
const deliveryResultSchema = z
  .object({
    outcome: z.literal('completed'),
    ...optionalCompletionExplanation,
    commitMessage: z.string().trim().min(1).max(5_000),
    mergeRequestTitle: z.string().trim().min(1).max(240),
    mergeRequestDescription: z.string().trim().min(1).max(32_000),
  })
  .strict()

const reviewResultSchema = z
  .object({
    outcome: z.literal('completed'),
    ...optionalCompletionExplanation,
    replies: z
      .array(
        z
          .object({
            threadRef: z.string().min(1).max(500),
            reply: z.string().trim().min(1).max(8_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    commitMessage: z.string().trim().min(1).max(5_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.replies.map((reply) => reply.threadRef)).size !== value.replies.length) {
      ctx.addIssue({ code: 'custom', path: ['replies'], message: 'threadRef must be unique' })
    }
  })

const pipelineCheckSchema = z
  .object({
    checkRef: z.string().min(1).max(500),
    name: z.string().min(1).max(500),
    status: z.enum(['queued', 'running', 'passed', 'failed', 'canceled', 'skipped']),
    summary: z.string().min(1).max(4_000).optional(),
    evidenceFiles: z.array(pathSchema).min(1).max(100).optional(),
  })
  .strict()

const pipelineStatusResultSchema = z
  .object({
    outcome: z.literal('completed'),
    ...optionalCompletionExplanation,
    observedSourceVersion: versionSchema,
    observedTargetVersion: versionSchema.optional(),
    status: z.enum(['pending', 'passed', 'failed']),
    checks: z.array(pipelineCheckSchema).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.checks.map((check) => check.checkRef)).size !== value.checks.length) {
      ctx.addIssue({ code: 'custom', path: ['checks'], message: 'checkRef must be unique' })
    }
    const hasFailure = value.checks.some(
      (check) => check.status === 'failed' || check.status === 'canceled',
    )
    const hasPending = value.checks.some(
      (check) => check.status === 'queued' || check.status === 'running',
    )
    if (value.status === 'failed' && !hasFailure) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'failed requires a failed check' })
    }
    if (value.status === 'passed' && (hasFailure || hasPending)) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'passed requires terminal checks' })
    }
    if (value.status === 'pending' && hasFailure) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'pending cannot contain failures' })
    }
  })

const classificationResultSchema = z
  .object({
    outcome: z.literal('completed'),
    ...optionalCompletionExplanation,
    groups: z
      .array(
        z
          .object({
            type: z.string().min(1).max(160),
            checkRefs: z.array(z.string().min(1).max(500)).min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.groups.map((group) => group.type)).size !== value.groups.length) {
      ctx.addIssue({ code: 'custom', path: ['groups'], message: 'one group is allowed per type' })
    }
    const refs = value.groups.flatMap((group) => group.checkRefs)
    if (new Set(refs).size !== refs.length) {
      ctx.addIssue({ code: 'custom', path: ['groups'], message: 'checkRef may appear only once' })
    }
  })

const commitResultSchema = z
  .object({
    outcome: z.literal('completed'),
    ...optionalCompletionExplanation,
    commitMessage: z.string().trim().min(1).max(5_000),
  })
  .strict()

const approvalDraftResultSchema = z
  .object({
    outcome: z.literal('completed'),
    ...optionalCompletionExplanation,
    draft: z.string().trim().min(1).max(32_000),
  })
  .strict()

export const developmentToolOutputSchemasV2 = {
  'development.prepare-materials': z.union([completedSignalSchema, blockedSchema]),
  'development.implement-change': z.union([deliveryResultSchema, blockedSchema]),
  'development.resolve-review-feedback': z.union([reviewResultSchema, blockedSchema]),
  'development.collect-pipeline-status': z.union([pipelineStatusResultSchema, blockedSchema]),
  'development.classify-pipeline-failures': z.union([classificationResultSchema, blockedSchema]),
  'development.repair-pipeline-failures': z.union([commitResultSchema, blockedSchema]),
  'development.resolve-merge-conflicts': z.union([commitResultSchema, blockedSchema]),
  'development.draft-approval': z.union([approvalDraftResultSchema, blockedSchema]),
} as const

export type DevelopmentToolJsonOutputContractIdV2 = keyof typeof developmentToolOutputSchemasV2

export function validateDevelopmentToolOutputV2(
  contractId: DevelopmentToolJsonOutputContractIdV2,
  outputJson: string,
): string {
  const parsed = developmentToolOutputSchemasV2[contractId].parse(JSON.parse(outputJson) as unknown)
  return JSON.stringify(parsed)
}
