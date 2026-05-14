// Agent schemas — frontmatter fields + body markdown.
// Mirrors design/proposal.md §8 and design/design.md §3 (agents table).
// DB columns hold JSON-string for outputs/skills/permission/frontmatterExtra;
// these schemas describe the response/request shape after marshaling.

import { z } from 'zod'

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
  readonly: z.boolean(),
  model: z.string().optional(),
  variant: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  permission: AgentPermissionSchema,
  steps: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
  skills: z.array(z.string()),
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
  readonly: z.boolean().default(false),
  model: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  permission: AgentPermissionSchema.default({}),
  steps: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
  skills: z.array(z.string()).default([]),
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
