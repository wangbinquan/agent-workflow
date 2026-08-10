// MCP (Model Context Protocol) server schemas — DB-backed resource referenced
// by agents via `frontmatter.mcp: [name1, name2, ...]`. See RFC-028.
//
// Two server kinds, mirroring opencode `McpLocalConfig` / `McpRemoteConfig`
// (aligned with opencode/packages/opencode/src/config/mcp.ts):
//   - local : stdio command + env, no cwd (opencode uses process cwd = worktree)
//   - remote: http/sse URL + optional headers + optional oauth
//
// Field naming policy: the API / DB / form use the more intuitive `env` /
// `timeoutMs`; the runner translates to opencode's exact wire names
// `environment` / `timeout` at inline-JSON build time (see
// services/runner.ts buildInlineConfig). Do NOT rename here.

import { z } from 'zod'
import { OperationConfigHashSchema } from './operationRevision'
import { ResourceVisibilitySchema } from './resourceAcl'

/** Permitted characters in an MCP's display name. */
export const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const McpNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(128, 'name too long')
  .regex(MCP_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

/**
 * RFC-242 — env names an MCP may declare for its stdio child. POSIX identifier
 * shape; deliberately case-INSENSITIVE because `token` / `apiKey` are ordinary,
 * legitimate names that servers really use (the platform's first no-network
 * fence rejected them and broke working configurations).
 */
export const MCP_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/**
 * The one environment family the resource schema refuses on every path.
 * Dynamic-loader variables can replace code before the declared MCP command's
 * own startup logic runs. Everything else (including `NODE_OPTIONS` and
 * `PYTHONPATH`) belongs to the command author.
 */
export const MCP_ENV_DENY_RE = /^(?:LD_|DYLD_)/i

export type McpEnvNameProblem = 'name-charset' | 'loader-injection' | 'value-nul'

/** The single reason an MCP env entry is refused, or null when it is fine. */
export function mcpEnvEntryProblem(name: string, value: string): McpEnvNameProblem | null {
  if (!MCP_ENV_NAME_RE.test(name)) return 'name-charset'
  if (MCP_ENV_DENY_RE.test(name)) return 'loader-injection'
  if (value.includes('\0')) return 'value-nul'
  return null
}

/** Operator-facing explanation used by both the save-time gate and the docs. */
export function describeMcpEnvProblem(name: string, problem: McpEnvNameProblem): string {
  if (problem === 'name-charset') {
    return `env key '${name}' is not a valid environment variable name (letters, digits and _ only, not starting with a digit)`
  }
  if (problem === 'value-nul') {
    return `env value for '${name}' contains a NUL byte`
  }
  return `env key '${name}' is a dynamic-loader variable and is not accepted for an MCP child`
}

/** Every refused entry of an MCP env map, in declaration order. */
export function mcpEnvIssues(
  env: Readonly<Record<string, string>> | undefined,
): Array<{ name: string; problem: McpEnvNameProblem; message: string }> {
  if (env === undefined) return []
  const issues: Array<{ name: string; problem: McpEnvNameProblem; message: string }> = []
  for (const [name, value] of Object.entries(env)) {
    const problem = mcpEnvEntryProblem(name, value)
    if (problem !== null)
      issues.push({ name, problem, message: describeMcpEnvProblem(name, problem) })
  }
  return issues
}

/** Local stdio server (opencode `McpLocalConfig`). */
export const McpLocalConfigSchema = z
  .object({
    /** Argv[]; first element is the executable. At least one element required. */
    command: z.array(z.string().min(1)).min(1, 'command must have at least one entry'),
    /** stdio child env overlay (translated to opencode `environment` on inject). */
    env: z.record(z.string(), z.string()).optional(),
    /** Request timeout in ms (translated to opencode `timeout` on inject). */
    timeoutMs: z.number().int().positive().optional(),
    // INTENTIONALLY NO `cwd`: opencode McpLocalConfig has no cwd field; stdio
    // child cwd is taken from the opencode process directory = our worktree.
    // See docs/OPENCODE_CONFIG.md §3.3 and design/RFC-028.../design.md §0.3.
  })
  .strict()
export type McpLocalConfig = z.infer<typeof McpLocalConfigSchema>

/**
 * RFC-242 — the SAVE-path local config: same shape plus the env gate, so a key
 * the runtime fence can never forward is refused where the author can still see
 * and fix it (with the key named), instead of failing a node run hours later.
 *
 * Deliberately NOT folded into `McpLocalConfigSchema`: that one also parses
 * STORED rows, and a legacy row carrying a refused key must stay readable —
 * turning every list request into a 500 would be a worse failure than the one
 * being prevented.
 */
export const McpLocalConfigWriteSchema = McpLocalConfigSchema.superRefine((config, ctx) => {
  for (const issue of mcpEnvIssues(config.env)) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: ['env', issue.name] })
  }
})

/** OAuth knobs used by remote servers; mirrors opencode `McpOAuthConfig`. */
export const McpOAuthConfigSchema = z
  .object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scope: z.string().optional(),
    redirectUri: z.string().optional(),
  })
  .strict()
export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>

/** Remote http/sse server (opencode `McpRemoteConfig`). */
export const McpRemoteConfigSchema = z
  .object({
    url: z
      .string()
      .min(1, 'url is required')
      .refine(
        (u) => u.startsWith('http://') || u.startsWith('https://'),
        'url must start with http:// or https://',
      ),
    headers: z.record(z.string(), z.string()).optional(),
    /** Either an OAuth object or literal false to disable OAuth auto-detection. */
    oauth: z.union([McpOAuthConfigSchema, z.literal(false)]).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
export type McpRemoteConfig = z.infer<typeof McpRemoteConfigSchema>

/** Discriminated MCP resource as stored / returned by the API. */
export const McpSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    name: McpNameSchema,
    description: z.string(),
    /** RFC-099 ACL — owner (users.id or '__system__'); null until first owner write. */
    ownerUserId: z.string().nullable().optional(),
    /** RFC-099 ACL — 'public' = every user; 'private' = owner + grants. Absent ⇒ 'public'. */
    visibility: ResourceVisibilitySchema.optional(),
    /** Monotonic ACL revision; absent only in legacy fixtures. */
    aclRevision: z.number().int().nonnegative().optional(),
    type: z.literal('local'),
    config: McpLocalConfigSchema,
    enabled: z.boolean(),
    schemaVersion: z.number().int(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  }),
  z.object({
    id: z.string(),
    name: McpNameSchema,
    description: z.string(),
    /** RFC-099 ACL — owner (users.id or '__system__'); null until first owner write. */
    ownerUserId: z.string().nullable().optional(),
    /** RFC-099 ACL — 'public' = every user; 'private' = owner + grants. Absent ⇒ 'public'. */
    visibility: ResourceVisibilitySchema.optional(),
    /** Monotonic ACL revision; absent only in legacy fixtures. */
    aclRevision: z.number().int().nonnegative().optional(),
    type: z.literal('remote'),
    config: McpRemoteConfigSchema,
    enabled: z.boolean(),
    schemaVersion: z.number().int(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  }),
])
export type Mcp = z.infer<typeof McpSchema>

/** GET/POST/PUT MCP wire shape after RFC-201 exact-operation fencing. */
export const McpOperationResourceSchema = McpSchema.and(
  z.object({ operationConfigHash: OperationConfigHashSchema }),
)
export type McpOperationResource = z.infer<typeof McpOperationResourceSchema>

export const McpOperationRequestSchema = z
  .object({ expectedConfigHash: OperationConfigHashSchema })
  .strict()
export type McpOperationRequest = z.infer<typeof McpOperationRequestSchema>

/** POST /api/mcps body — both kinds. */
export const CreateMcpSchema = z.discriminatedUnion('type', [
  z.object({
    name: McpNameSchema,
    description: z.string().default(''),
    type: z.literal('local'),
    // RFC-242: save-time env gate (write path only — see McpLocalConfigWriteSchema).
    config: McpLocalConfigWriteSchema,
    enabled: z.boolean().default(true),
  }),
  z.object({
    name: McpNameSchema,
    description: z.string().default(''),
    type: z.literal('remote'),
    config: McpRemoteConfigSchema,
    enabled: z.boolean().default(true),
  }),
])
export type CreateMcp = z.infer<typeof CreateMcpSchema>

/**
 * PUT /api/mcps/:id body. Name changes go through /rename. `type` may not
 * change (changing transport in-place is meaningless; create a new one).
 */
export const UpdateMcpLocalSchema = z
  .object({
    description: z.string().optional(),
    type: z.literal('local').optional(),
    // RFC-242: save-time env gate (write path only — see McpLocalConfigWriteSchema).
    config: McpLocalConfigWriteSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

export const UpdateMcpRemoteSchema = z
  .object({
    description: z.string().optional(),
    type: z.literal('remote').optional(),
    config: McpRemoteConfigSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

export const UpdateMcpSchema = z.union([UpdateMcpLocalSchema, UpdateMcpRemoteSchema])
export type UpdateMcp = z.infer<typeof UpdateMcpSchema>

export const UpdateMcpRequestSchema = z.union([
  UpdateMcpLocalSchema.extend({
    expectedConfigHash: OperationConfigHashSchema,
  }),
  UpdateMcpRemoteSchema.extend({
    expectedConfigHash: OperationConfigHashSchema,
  }),
])
export type UpdateMcpRequest = z.infer<typeof UpdateMcpRequestSchema>

/** POST /api/mcps/:id/rename body. */
export const RenameMcpSchema = z.object({
  newName: McpNameSchema,
})
export type RenameMcp = z.infer<typeof RenameMcpSchema>

export const RenameMcpRequestSchema = RenameMcpSchema.extend({
  expectedConfigHash: OperationConfigHashSchema,
}).strict()
export type RenameMcpRequest = z.infer<typeof RenameMcpRequestSchema>

export const DeleteMcpSchema = z
  .object({
    confirm: z.string().optional(),
    expectedConfigHash: OperationConfigHashSchema,
  })
  .strict()
export type DeleteMcp = z.infer<typeof DeleteMcpSchema>
