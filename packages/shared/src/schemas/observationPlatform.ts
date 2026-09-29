import { z } from 'zod'

// RFC-034 v2 projection. This is platform proof, not AW's local native baseline.
const key = z.string().min(1).max(512)
const size = z.number().int().nonnegative().max(10000)
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const resource = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const order = z.object({ epoch: key, sequence }).strict()
const proof = z
  .object({
    contract: z.literal('opencode-child-steps-v1'),
    lineageKey: key,
    turn: key,
    turnIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['pending', 'complete', 'partial', 'unsupported']),
    root: key.nullable(),
    observedAt: z.string().datetime(),
    baseline: z
      .object({
        kind: z.enum(['fresh', 'resume']),
        fingerprint: key.nullable(),
        order: order.optional(),
      })
      .strict(),
    order: order.optional(),
    fingerprint: key.nullable(),
    sessions: size,
    steps: size,
    emitted: size,
    baselineSteps: size,
    priorRevisionGap: z.boolean(),
    issues: z.array(z.string().min(1).max(120)).max(30),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.state === 'complete' &&
      value.baseline.kind === 'resume' &&
      (value.order || value.baseline.order) &&
      (!value.order ||
        !value.baseline.order ||
        value.baseline.order.epoch !== value.order.epoch ||
        value.baseline.order.sequence >= value.order.sequence)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid native resume order' })
    if (
      value.state === 'complete' &&
      (!value.root ||
        !value.fingerprint ||
        value.sessions < 1 ||
        value.steps !== value.emitted + value.baselineSteps ||
        value.priorRevisionGap ||
        value.issues.length ||
        (value.baseline.kind === 'resume' && !value.baseline.fingerprint))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete native capture proof' })
  })
export const ObservationPlatformNativeCaptureSchema = z
  .object({
    id: key,
    identity: z
      .object({
        projectId: resource,
        taskId: resource,
        subtaskId: resource,
        executionId: resource,
        executionGeneration: sequence,
      })
      .strict(),
    sourceId: key,
    proof,
    state: z.enum(['pending', 'complete', 'partial', 'unsupported']),
    issues: z.array(z.string().min(1).max(120)).max(40),
    receivedSteps: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    receivedBaselineSteps: size,
    unresolvedBaselineSteps: size,
    revisedBaselineSteps: size,
    correctedBaselineSteps: size.optional(),
    historicalRevisionGap: z.boolean(),
  })
  .strict()
export type ObservationPlatformNativeCapture = z.infer<
  typeof ObservationPlatformNativeCaptureSchema
>
