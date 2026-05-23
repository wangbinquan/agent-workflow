// Agent schemas — frontmatter fields + body markdown.
// Mirrors design/proposal.md §8 and design/design.md §3 (agents table).
// DB columns hold JSON-string for outputs/skills/permission/frontmatterExtra;
// these schemas describe the response/request shape after marshaling.

import { z } from 'zod'
import { McpNameSchema } from './mcp'
import { PluginNameSchema } from './plugin'
import { AgentOutputKindSchema } from './review'

/**
 * Sidecar map declaring the "shape" of selected output ports.
 *
 * Carried alongside the legacy `outputs: string[]` array so all 17 existing
 * call sites (`agent.outputs.includes(port)`, `agent.outputs.map(...)`) keep
 * working unchanged. Consumers that care about kind (envelope parser,
 * review-node validator) look up `agent.outputKinds?.[portName] ?? 'string'`.
 *
 * Only ports also declared in `outputs` may appear here; the validator drops
 * orphan keys. RFC-005 PR-A T1.
 */
export const AgentOutputKindsMapSchema = z.record(z.string(), AgentOutputKindSchema)
export type AgentOutputKindsMap = z.infer<typeof AgentOutputKindsMapSchema>

/**
 * RFC-060 PR-B — agent role flag. Default `'normal'` for all agents that
 * existed before RFC-060; `'aggregator'` marks an agent designed to sit at
 * the convergence point of a wrapper-fanout (runs once per wrapper, sees
 * `raw list` of every shard's output, decides how to merge). Validator
 * rejects role=aggregator agents outside a wrapper-fanout
 * (`aggregator-agent-outside-fanout`, see workflow.validator.ts PR-B).
 *
 * Carried via agent.md frontmatter `role:` field; persisted in DB via
 * `frontmatter_extra` JSON column (same path as RFC-005 outputKinds).
 */
export const AGENT_ROLE = ['normal', 'aggregator'] as const
export const AgentRoleSchema = z.enum(AGENT_ROLE)
export type AgentRole = z.infer<typeof AgentRoleSchema>

/**
 * RFC-060 PR-B — per-output port rename map, used when promoting an
 * aggregator agent's outputs to wrapper-fanout output ports. Only
 * meaningful when `role === 'aggregator'`; ignored otherwise (PR-C
 * validator may emit a warning if the field is set on a normal agent).
 *
 * Keys are port names declared in `outputs`; values are the desired
 * wrapper-side port names. Missing keys → same-name mirror at wrapper
 * promotion time.
 *
 * Sidecar map kept symmetrical with `outputKinds`.
 */
export const AgentOutputWrapperPortNamesSchema = z.record(z.string(), z.string().min(1))
export type AgentOutputWrapperPortNames = z.infer<typeof AgentOutputWrapperPortNamesSchema>

/** Permitted characters in agent name (URL-safe; matches /agents/:name). */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const AgentNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(128, 'name too long')
  .regex(AGENT_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

/** opencode permission map; passed through verbatim. */
export const AgentPermissionSchema = z.record(z.string(), z.unknown())
export type AgentPermission = z.infer<typeof AgentPermissionSchema>

/** Full agent resource (response shape). */
export const AgentSchema = z.object({
  id: z.string(),
  name: AgentNameSchema,
  description: z.string(),
  outputs: z.array(z.string()),
  outputKinds: AgentOutputKindsMapSchema.optional(),
  /**
   * RFC-060 PR-B — wrapper-fanout output rename sidecar. Only meaningful
   * when `role === 'aggregator'`; absent otherwise.
   */
  outputWrapperPortNames: AgentOutputWrapperPortNamesSchema.optional(),
  /**
   * RFC-060 PR-B — agent role; absent / undefined → treat as 'normal'.
   * See AgentRoleSchema docs. Persisted into agent.md frontmatter `role:`;
   * round-trips via frontmatter_extra in DB. Optional on the schema so
   * pre-RFC-060 fixtures / hand-constructed test agents continue to compile
   * without each call site spelling out `role: 'normal'`. Consumers MUST
   * treat undefined as 'normal' (see workflow.validator.ts placement check
   * + scheduler aggregator dispatch in PR-D).
   */
  role: AgentRoleSchema.optional(),
  readonly: z.boolean(),
  /**
   * RFC-014: when true (default), an iterate decision on a multi-markdown
   * upstream node re-generates every markdown[_file] sibling port and resets
   * sibling reviews back to awaiting_review. Author opt-out → only the
   * reviewed port regenerates (RFC-005 §2.1 #8 legacy behavior).
   */
  syncOutputsOnIterate: z.boolean(),
  model: z.string().optional(),
  variant: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  permission: AgentPermissionSchema,
  steps: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
  skills: z.array(z.string()),
  /**
   * RFC-022: agent names this agent transitively requires at runtime. The
   * framework runs BFS over depends_on to compute a closure, then injects
   * every member as an entry under `agent` in OPENCODE_CONFIG_CONTENT and
   * unions every member's skills into OPENCODE_CONFIG_DIR/skills/. Default
   * `[]` keeps legacy single-agent injection behavior.
   *
   * Save-time validation (services/agentDeps.ts): names must exist, no
   * self-reference, no cycle. Workflow validator extends the existing
   * `agent-not-found` / `skill-not-found` checks to the closure.
   */
  dependsOn: z.array(AgentNameSchema),
  /**
   * RFC-028: MCP server names this agent needs at runtime. Runner unions the
   * mcp[] of every agent in the dependsOn closure (RFC-022) and injects each
   * member as an entry under `mcp` in OPENCODE_CONFIG_CONTENT. opencode then
   * spawns the listed servers and exposes their tools to the spawned process.
   * Default `[]` leaves the agent free of framework-managed MCPs (the user's
   * repo `.opencode/config.json` and `~/.config/opencode/` MCPs still load
   * naturally — see OPENCODE_CONFIG.md §4).
   */
  mcp: z.array(McpNameSchema),
  /**
   * RFC-031: opencode plugin names this agent needs at runtime. Runner unions
   * the plugins[] of every agent in the dependsOn closure (RFC-022) and
   * injects each member's `file://<cachedPath>` (with options when present)
   * under `plugin` in OPENCODE_CONFIG_CONTENT. Spawn paths never hit the
   * network because cachedPath is populated at save time, not run time.
   * Default `[]` leaves the agent free of framework-managed plugins.
   */
  plugins: z.array(PluginNameSchema),
  frontmatterExtra: z.record(z.string(), z.unknown()),
  bodyMd: z.string(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Agent = z.infer<typeof AgentSchema>

/** POST /api/agents body. */
export const CreateAgentSchema = z.object({
  name: AgentNameSchema,
  description: z.string().default(''),
  outputs: z.array(z.string()).default([]),
  outputKinds: AgentOutputKindsMapSchema.optional(),
  /** RFC-060 PR-B — wrapper-fanout output rename sidecar (aggregator only). */
  outputWrapperPortNames: AgentOutputWrapperPortNamesSchema.optional(),
  /** RFC-060 PR-B — agent role flag; optional, treat absent as 'normal'. */
  role: AgentRoleSchema.optional(),
  readonly: z.boolean().default(false),
  /** RFC-014: default true — author must explicitly opt-out. */
  syncOutputsOnIterate: z.boolean().default(true),
  model: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  permission: AgentPermissionSchema.default({}),
  steps: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
  skills: z.array(z.string()).default([]),
  /** RFC-022 — see AgentSchema.dependsOn. */
  dependsOn: z.array(AgentNameSchema).max(64).default([]),
  /** RFC-028 — see AgentSchema.mcp. */
  mcp: z.array(McpNameSchema).max(64).default([]),
  /** RFC-031 — see AgentSchema.plugins. */
  plugins: z.array(PluginNameSchema).max(64).default([]),
  frontmatterExtra: z.record(z.string(), z.unknown()).default({}),
  bodyMd: z.string().default(''),
})
export type CreateAgent = z.infer<typeof CreateAgentSchema>

/** PUT /api/agents/:name body. Name changes happen via /rename. */
export const UpdateAgentSchema = CreateAgentSchema.omit({ name: true }).partial()
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>

/** POST /api/agents/:name/rename body. */
export const RenameAgentSchema = z.object({
  newName: AgentNameSchema,
})
export type RenameAgent = z.infer<typeof RenameAgentSchema>
