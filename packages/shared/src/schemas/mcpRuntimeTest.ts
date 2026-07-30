// RFC-238 — MCP runtime playground contracts.
//
// The playground is a private, multi-turn logical session. Each accepted turn
// starts one runtime process; the runtime-native session id is resumed by later
// turns until the user ends the test or the 10-minute idle deadline expires.

import { z } from 'zod'
import { OperationConfigHashSchema } from './operationRevision'

const IdSchema = z.string().min(1).max(128)

export const McpRuntimeTestSessionStatusSchema = z.enum(['active', 'ending', 'ended'])
export type McpRuntimeTestSessionStatus = z.infer<typeof McpRuntimeTestSessionStatusSchema>

export const McpRuntimeTestTurnStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'interrupted',
])
export type McpRuntimeTestTurnStatus = z.infer<typeof McpRuntimeTestTurnStatusSchema>

export const McpRuntimeTestCaptureStateSchema = z.enum([
  'live',
  'complete',
  'truncated',
  'incomplete',
])
export type McpRuntimeTestCaptureState = z.infer<typeof McpRuntimeTestCaptureStateSchema>

export const McpRuntimeTestEndReasonSchema = z.enum([
  'user',
  'idle-timeout',
  'mcp-deleted',
  'mcp-disabled',
  'mcp-config-changed',
  'access-revoked',
  'runtime-disabled',
  'runtime-deleted',
  'runtime-profile-changed',
  'runtime-identity-changed',
  'capture-truncated',
  'capture-incomplete',
  'session-unusable',
])
export type McpRuntimeTestEndReason = z.infer<typeof McpRuntimeTestEndReasonSchema>

export const McpRuntimeTestContinuationBlockedReasonSchema = z.enum([
  'mcp-config-changed',
  'runtime-profile-changed',
  'runtime-identity-changed',
  'mcp-execution-changed',
  'capture-truncated',
  'capture-incomplete',
  'session-root-mismatch',
  'session-store-missing',
])
export type McpRuntimeTestContinuationBlockedReason = z.infer<
  typeof McpRuntimeTestContinuationBlockedReasonSchema
>

export const McpRuntimeTestTurnDtoSchema = z
  .object({
    id: IdSchema,
    seq: z.number().int().positive(),
    prompt: z.string(),
    status: McpRuntimeTestTurnStatusSchema,
    captureState: McpRuntimeTestCaptureStateSchema,
    hardDeadlineAt: z.number().int(),
    failureCode: z.string().nullable(),
    stderrTail: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int(),
    startedAt: z.number().int().nullable(),
    finishedAt: z.number().int().nullable(),
  })
  .strict()
export type McpRuntimeTestTurnDto = z.infer<typeof McpRuntimeTestTurnDtoSchema>

export const McpRuntimeTestSessionDtoSchema = z
  .object({
    id: IdSchema,
    mcpId: IdSchema,
    status: McpRuntimeTestSessionStatusSchema,
    endReason: McpRuntimeTestEndReasonSchema.nullable(),
    runtime: z
      .object({
        name: z.string().min(1),
        protocol: z.enum(['opencode', 'claude-code']),
      })
      .strict(),
    mcpConfigHash: OperationConfigHashSchema,
    runtimeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    nativeSessionReady: z.boolean(),
    continuationBlockedReason: McpRuntimeTestContinuationBlockedReasonSchema.nullable(),
    inFlightTurnId: IdSchema.nullable(),
    sessionVersion: z.number().int().nonnegative(),
    idleDeadlineAt: z.number().int().nullable(),
    cleanupState: z.enum(['not-started', 'pending', 'complete', 'quarantined']),
    turns: z.array(McpRuntimeTestTurnDtoSchema),
    eventCursor: z.number().int().nonnegative(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    endedAt: z.number().int().nullable(),
  })
  .strict()
export type McpRuntimeTestSessionDto = z.infer<typeof McpRuntimeTestSessionDtoSchema>

export const McpRuntimeTestCreateRequestSchema = z
  .object({
    expectedMcpConfigHash: OperationConfigHashSchema,
    runtimeName: z.string().min(1).max(128).nullable(),
    message: z.string().min(1).max(65_536),
    clientCreateId: IdSchema,
    clientMessageId: IdSchema,
  })
  .strict()
export type McpRuntimeTestCreateRequest = z.infer<typeof McpRuntimeTestCreateRequestSchema>

export const McpRuntimeTestCreateReceiptSchema = z
  .object({
    sessionId: IdSchema,
    acceptedTurnId: IdSchema,
  })
  .strict()
export type McpRuntimeTestCreateReceipt = z.infer<typeof McpRuntimeTestCreateReceiptSchema>

export const McpRuntimeTestMessageRequestSchema = z
  .object({
    message: z.string().min(1).max(65_536),
    clientMessageId: IdSchema,
    expectedSessionVersion: z.number().int().nonnegative(),
  })
  .strict()
export type McpRuntimeTestMessageRequest = z.infer<typeof McpRuntimeTestMessageRequestSchema>

export const McpRuntimeTestMessageReceiptSchema = z
  .object({
    sessionId: IdSchema,
    acceptedTurnId: IdSchema,
    sessionVersion: z.number().int().nonnegative(),
  })
  .strict()
export type McpRuntimeTestMessageReceipt = z.infer<typeof McpRuntimeTestMessageReceiptSchema>

export const McpRuntimeTestCancelRequestSchema = z
  .object({
    turnId: IdSchema,
  })
  .strict()
export type McpRuntimeTestCancelRequest = z.infer<typeof McpRuntimeTestCancelRequestSchema>

export const McpRuntimeTestMutationReceiptSchema = z
  .object({
    session: McpRuntimeTestSessionDtoSchema,
  })
  .strict()
export type McpRuntimeTestMutationReceipt = z.infer<typeof McpRuntimeTestMutationReceiptSchema>
