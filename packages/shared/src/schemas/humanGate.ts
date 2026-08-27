import { z } from 'zod'

/** RFC-333 public business receipt. Execution intent ids and wake failures are
 * deliberately absent; a committed receipt means durable continuation exists. */
export const GateDecisionReceiptSchema = z.object({
  operationId: z.string().min(1),
  gate: z.object({
    kind: z.enum(['review', 'clarify', 'questions']),
    ref: z.string().min(1),
  }),
  gateRevision: z.number().int().nonnegative(),
  taskRevision: z.number().int().nonnegative(),
  acceptedAt: z.number().int().nonnegative(),
  replayed: z.boolean(),
})
export type GateDecisionReceipt = z.infer<typeof GateDecisionReceiptSchema>

export const GateDecisionRerunSchema = z.object({
  targetNodeId: z.string().min(1),
  nodeRunId: z.string().min(1),
  entryIds: z.array(z.string().min(1)),
})
export type GateDecisionRerun = z.infer<typeof GateDecisionRerunSchema>

export const GateDecisionDeferredEntrySchema = z.object({
  entryId: z.string().min(1),
  homeNodeId: z.string().min(1),
  reason: z.string().min(1),
})
export type GateDecisionDeferredEntry = z.infer<typeof GateDecisionDeferredEntrySchema>

/** 200 body of POST /api/tasks/:id/questions/dispatch. */
export const DispatchTaskQuestionsResponseSchema = z.object({
  ok: z.literal(true),
  taskId: z.string().min(1),
  receipt: GateDecisionReceiptSchema,
  reruns: z.array(GateDecisionRerunSchema),
  dispatchedEntryIds: z.array(z.string().min(1)),
  deferred: z.array(GateDecisionDeferredEntrySchema),
})
export type DispatchTaskQuestionsResponse = z.infer<typeof DispatchTaskQuestionsResponseSchema>
