// RFC-030 — MCP interface probe schemas.
//
// Wire contract for what `services/mcpProbe.ts` returns (and persists in the
// `mcp_probes` table). Mirrors the shape returned by the official
// `@modelcontextprotocol/sdk` clients:
//   - listTools().tools[]               → McpToolInfoSchema
//   - listResources().resources[]       → McpResourceInfoSchema
//   - listResourceTemplates().resourceTemplates[] → McpResourceTemplateInfoSchema
//   - listPrompts().prompts[]           → McpPromptInfoSchema
//
// `inputSchema` is intentionally `z.unknown()` — it's the raw JSON Schema the
// server publishes; the front-end renders it as a JSON viewer, never executes
// against it. We do *not* re-validate it as a JSON Schema here (would couple
// us to a particular meta-schema version).
//
// Error semantics: probe-time failures are normalized into the six codes
// listed in McpProbeErrorCode. `mcp-disabled` is the only one returned at the
// HTTP boundary as 422 (before any transport spawn). All five remaining codes
// are persisted with `status='error'` (or `status='ok'` for `partial`).

import { z } from 'zod'
import { OperationConfigHashSchema } from './operationRevision'

/** A single tool advertised by the MCP server. */
export const McpToolInfoSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    // Raw JSON Schema (or whatever the server publishes). Rendered, not executed.
    inputSchema: z.unknown().optional(),
  })
  .strict()
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>

/** A static resource advertised by the MCP server. */
export const McpResourceInfoSchema = z
  .object({
    uri: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .strict()
export type McpResourceInfo = z.infer<typeof McpResourceInfoSchema>

/** A parameterised resource template. */
export const McpResourceTemplateInfoSchema = z
  .object({
    uriTemplate: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .strict()
export type McpResourceTemplateInfo = z.infer<typeof McpResourceTemplateInfoSchema>

/** A named argument on a prompt template. */
export const McpPromptArgumentSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })
  .strict()
export type McpPromptArgument = z.infer<typeof McpPromptArgumentSchema>

/** A prompt template advertised by the MCP server. */
export const McpPromptInfoSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    arguments: z.array(McpPromptArgumentSchema).optional(),
  })
  .strict()
export type McpPromptInfo = z.infer<typeof McpPromptInfoSchema>

/**
 * Normalised probe error codes. See RFC-030 design §6 for the full mapping
 * table from SDK exceptions / HTTP responses to these values.
 *
 *   connect-failed   transport itself failed (stdio spawn ENOENT, HTTP refused, DNS, etc.)
 *   handshake-failed transport up but `initialize` timed out or returned error
 *   auth-required    SDK UnauthorizedError or HTTP 401/403
 *   timeout          overall probe exceeded the hard 60s ceiling
 *   partial          initialize ok, but at least one of tools/resources/prompts list failed
 *                    — status STAYS 'ok' in this case (server is reachable; just doesn't
 *                    implement every list method). errorDetail.partialFailures explains.
 *   internal-error   catch-all for bugs in our probe code
 *   mcp-disabled     mcp.enabled === false; returned 422 at route boundary, never persisted
 */
export const McpProbeErrorCode = z.enum([
  'connect-failed',
  'handshake-failed',
  'auth-required',
  'timeout',
  'partial',
  'internal-error',
  'mcp-disabled',
])
export type McpProbeErrorCodeT = z.infer<typeof McpProbeErrorCode>

/** Public shape returned by GET/POST /api/mcps/:name/probe and the list endpoint. */
export const McpProbeSchema = z
  .object({
    id: z.string().min(1),
    mcpId: z.string().min(1),
    mcpName: z.string().min(1),
    status: z.enum(['ok', 'error']),
    latencyMs: z.number().int().nonnegative(),
    handshakeMs: z.number().int().nonnegative().nullable(),
    serverInfo: z.object({ name: z.string(), version: z.string().optional() }).strict().nullable(),
    protocolVersion: z.string().nullable(),
    capabilities: z.record(z.string(), z.unknown()).nullable(),
    tools: z.array(McpToolInfoSchema).nullable(),
    resources: z.array(McpResourceInfoSchema).nullable(),
    resourceTemplates: z.array(McpResourceTemplateInfoSchema).nullable(),
    prompts: z.array(McpPromptInfoSchema).nullable(),
    errorCode: McpProbeErrorCode.nullable(),
    errorMessage: z.string().nullable(),
    errorDetail: z.record(z.string(), z.unknown()).nullable(),
    startedAt: z.number().int(),
    finishedAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict()
export type McpProbe = z.infer<typeof McpProbeSchema>

/** Immediate POST /probe receipt; persisted GET rows intentionally omit the fence. */
export const McpProbeOperationReceiptSchema = McpProbeSchema.extend({
  configHashUsed: OperationConfigHashSchema,
})
export type McpProbeOperationReceipt = z.infer<typeof McpProbeOperationReceiptSchema>
