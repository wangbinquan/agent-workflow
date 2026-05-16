// Agent schemas — frontmatter fields + body markdown.
// Mirrors design/proposal.md §8 and design/design.md §3 (agents table).
// DB columns hold JSON-string for outputs/skills/permission/frontmatterExtra;
// these schemas describe the response/request shape after marshaling.

import { z } from 'zod'
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
