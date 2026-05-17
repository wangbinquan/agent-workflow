// RFC-027: zod schema for the GET /api/tasks/:id/node-runs/:nodeRunId/session
// response body. Mirrors the SessionTree TypeScript types in
// `../sessionView.ts`; defined here (vs alongside the types) to follow
// the repo's existing schemas/ layout convention.

import { z } from 'zod'

const ToolStatusSchema = z.enum(['pending', 'running', 'completed', 'error'])

const UserMessageSchema = z.object({
  kind: z.literal('user'),
  text: z.string(),
  ts: z.number().int(),
})

const AssistantTextSchema = z.object({
  kind: z.literal('assistant-text'),
  text: z.string(),
  ts: z.number().int(),
  messageId: z.string().nullable(),
})

const AssistantReasoningSchema = z.object({
  kind: z.literal('assistant-reasoning'),
  text: z.string(),
  ts: z.number().int(),
  messageId: z.string().nullable(),
})

const ToolCallSchema = z.object({
  kind: z.literal('tool-call'),
  toolName: z.string(),
  callId: z.string(),
  status: ToolStatusSchema,
  input: z.unknown(),
  output: z.string().nullable(),
  ts: z.number().int(),
  messageId: z.string().nullable(),
})

interface SubagentCallShape {
  kind: 'subagent-call'
  toolName: string
  callId: string
  status: z.infer<typeof ToolStatusSchema>
  // z.unknown() produces an optional property at the TS level, mirror
  // that here so the recursive ZodType assignment compiles.
  input?: unknown
  output: string | null
  ts: number
  messageId: string | null
  childSessionId: string | null
  child: SessionTreeShape | null
  childOutputFallback: string | null
  childAgentName: string | null
}

interface SessionTreeShape {
  sessionId: string
  parentSessionId: string | null
  agentName: string | null
  messages: Array<
    | z.infer<typeof UserMessageSchema>
    | z.infer<typeof AssistantTextSchema>
    | z.infer<typeof AssistantReasoningSchema>
    | z.infer<typeof ToolCallSchema>
    | SubagentCallShape
  >
  captureComplete: boolean
}

export const SessionTreeSchema: z.ZodType<SessionTreeShape> = z.lazy(() =>
  z.object({
    sessionId: z.string(),
    parentSessionId: z.string().nullable(),
    agentName: z.string().nullable(),
    // z.union (not discriminatedUnion) because SubagentCallSchema is
    // recursive via z.lazy and discriminatedUnion can't introspect .shape
    // through a lazy wrapper.
    messages: z.array(
      z.union([
        UserMessageSchema,
        AssistantTextSchema,
        AssistantReasoningSchema,
        ToolCallSchema,
        SubagentCallSchema,
      ]),
    ),
    captureComplete: z.boolean(),
  }),
)

const SubagentCallSchema: z.ZodType<SubagentCallShape> = z.lazy(() =>
  z.object({
    kind: z.literal('subagent-call'),
    toolName: z.string(),
    callId: z.string(),
    status: ToolStatusSchema,
    input: z.unknown(),
    output: z.string().nullable(),
    ts: z.number().int(),
    messageId: z.string().nullable(),
    childSessionId: z.string().nullable(),
    child: SessionTreeSchema.nullable(),
    childOutputFallback: z.string().nullable(),
    childAgentName: z.string().nullable(),
  }),
)

export const SessionViewResponseSchema = z.object({
  tree: SessionTreeSchema,
})

export type SessionViewResponse = z.infer<typeof SessionViewResponseSchema>
