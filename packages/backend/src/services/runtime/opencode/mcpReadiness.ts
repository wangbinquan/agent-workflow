import { z } from 'zod'
import { executionIdentityFailure } from './failure'

export const MCP_RUNTIME_STATUSES = [
  'connected',
  'disabled',
  'failed',
  'needs_auth',
  'needs_client_registration',
] as const

export const McpRuntimeStatusSchema = z.enum(MCP_RUNTIME_STATUSES)
export type McpRuntimeStatus = z.infer<typeof McpRuntimeStatusSchema>
export type McpObservedStatus = McpRuntimeStatus | 'missing'

const McpNameSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 256 && !value.includes('\0'))

// OpenCode has added non-semantic diagnostic fields to status objects across
// releases. Admit those fields, but project only the closed status enum below;
// this keeps normal version drift functional without letting error text cross
// the launcher/runner boundary.
const RawMcpStatusSchema = z.object({ status: McpRuntimeStatusSchema }).passthrough()

/**
 * Closed decoder for OpenCode's same-instance GET /mcp response. Upstream
 * failure text is accepted only so the wire shape can be validated, then is
 * discarded before the value leaves this module.
 */
export const McpStatusesResponseSchema = z
  .record(McpNameSchema, RawMcpStatusSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 256) {
      ctx.addIssue({ code: 'custom', message: 'too many MCP status entries' })
    }
  })
  .transform((value): Readonly<Record<string, McpRuntimeStatus>> => {
    const statuses: Record<string, McpRuntimeStatus> = Object.create(null) as Record<
      string,
      McpRuntimeStatus
    >
    for (const [name, status] of Object.entries(value)) statuses[name] = status.status
    return statuses
  })

export const McpReadinessServerSchema = z
  .object({
    name: McpNameSchema,
    type: z.enum(['local', 'remote']),
  })
  .strict()

export type McpReadinessServer = z.infer<typeof McpReadinessServerSchema>

export const McpReadinessPlanSchema = z
  .object({
    enabled: z.boolean(),
    servers: z.array(McpReadinessServerSchema).max(256),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled !== value.servers.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['enabled'], message: 'enabled must match servers' })
    }
    const seen = new Set<string>()
    for (let index = 0; index < value.servers.length; index += 1) {
      const name = value.servers[index]!.name
      if (seen.has(name)) {
        ctx.addIssue({ code: 'custom', path: ['servers', index, 'name'], message: 'duplicate MCP' })
      }
      seen.add(name)
      if (index > 0 && compareCodePoints(value.servers[index - 1]!.name, name) >= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['servers', index, 'name'],
          message: 'MCP servers must be code-point sorted',
        })
      }
    }
  })

export type McpReadinessPlan = z.infer<typeof McpReadinessPlanSchema>

export interface McpReadinessItem extends McpReadinessServer {
  status: McpObservedStatus
}

export interface McpReadinessReceipt {
  connected: McpReadinessItem[]
  unavailableLocal: McpUnavailableReadinessItem[]
  unavailableRemote: McpUnavailableReadinessItem[]
}

export interface McpUnavailableReadinessItem extends McpReadinessServer {
  status: Exclude<McpObservedStatus, 'connected'>
}

export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) as number)
  const b = Array.from(right, (character) => character.codePointAt(0) as number)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]! - b[index]!
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

export function buildMcpReadinessPlan(
  mcps: readonly { name: string; type: 'local' | 'remote'; enabled: boolean }[],
): McpReadinessPlan {
  const parsed = McpReadinessPlanSchema.safeParse({
    enabled: mcps.some((mcp) => mcp.enabled),
    servers: mcps
      .filter((mcp) => mcp.enabled)
      .map(({ name, type }) => ({ name, type }))
      .sort((left, right) => compareCodePoints(left.name, right.name)),
  })
  if (!parsed.success) return executionIdentityFailure('execution-identity-mismatch')
  return parsed.data
}

export function compareMcpReadiness(
  expected: readonly McpReadinessServer[],
  statuses: Readonly<Record<string, McpRuntimeStatus>>,
): McpReadinessReceipt {
  const receipt: McpReadinessReceipt = {
    connected: [],
    unavailableLocal: [],
    unavailableRemote: [],
  }
  for (const server of expected) {
    const status: McpObservedStatus = statuses[server.name] ?? 'missing'
    if (status === 'connected') receipt.connected.push({ ...server, status })
    else if (server.type === 'local') receipt.unavailableLocal.push({ ...server, status })
    else receipt.unavailableRemote.push({ ...server, status })
  }
  return receipt
}
