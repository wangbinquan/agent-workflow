// Agent schemas — frontmatter fields + body markdown.
// Mirrors design/proposal.md §8 and design/design.md §3 (agents table).
// DB columns hold JSON-string for outputs/skills/permission/frontmatterExtra;
// these schemas describe the response/request shape after marshaling.

import { z } from 'zod'
import { ResourceVisibilitySchema } from './resourceAcl'
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
 * RFC-166 — declarative INPUT ports (symmetrical to `outputs`, but kind is
 * inlined here rather than via a sidecar map — inputs is a new field with no
 * legacy `string[]` shape to preserve). OPTIONAL / additive: an agent that
 * declares no inputs (the default `[]`) behaves byte-for-byte as before — the
 * runner still binds inputs implicitly via `promptTemplate`'s `{{token}}`
 * (validator prompt-template rule unchanged). Declared inputs are consumed
 * ONLY by the capability card (leader roster / RFC-167 orchestrator) — they
 * do NOT enter the spawn path. `kind` reuses the registered-kind grammar
 * (string | markdown | signal | path<ext> | list<T>).
 */
export const AgentInputPortSchema = z.object({
  name: z.string().min(1, 'input port name is required').max(128, 'input port name too long'),
  kind: AgentOutputKindSchema.default('string'),
  required: z.boolean().optional(),
  description: z.string().max(2048).optional(),
})
export type AgentInputPort = z.infer<typeof AgentInputPortSchema>

/**
 * RFC-166 — the declared-input-ports array. Port `name` is an identity key:
 * the capability card renders one row per name and the RFC-167 orchestrator
 * matches upstream→downstream by name, so duplicate names make the contract
 * ambiguous. Reject repeats at the schema boundary (mirrors the workgroup
 * member displayName uniqueness refine). serializeInputs re-parses through
 * this same schema so the persistence path rejects dupes too; the READ path
 * (parseInputsColumn) stays lenient by design.
 */
export const AgentInputPortsSchema = z.array(AgentInputPortSchema).superRefine((ports, ctx) => {
  const names = ports.map((p) => p.name)
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: 'custom', message: 'input port name must be unique' })
  }
})
export type AgentInputPorts = z.infer<typeof AgentInputPortsSchema>

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

/**
 * RFC-223 (PR-1) — a stored cross-resource reference. At rest this is always a
 * resource `id` (ULID) so a rename never mutates the referencing row (D4/D7).
 * The create / import wire ALSO accepts a `name` here: while name↔id stays 1:1
 * (uniqueness not yet relaxed — that is PR-8) the server resolves a name to its
 * single id deterministically (services/agentRefs.ts), so agent.md authored by
 * name and the id-based pickers flow through the same field. The old per-kind
 * `McpNameSchema` / `PluginNameSchema` / `AgentNameSchema` element validation is
 * dropped (an id is not a name-shaped string); only length is bounded.
 */
export const ResourceRefSchema = z
  .string()
  .min(1, 'reference is required')
  .max(128, 'reference too long')

/**
 * RFC-223 (PR-1) — `agents.skills` element. Persistent, DB/wire/runtime shape.
 * A `managed` ref points at a DB-backed skill row by its stable id; a `project`
 * ref names a repo-local (self-discovered) skill that has NO DB row (RFC-178) —
 * it is passed to the CLI verbatim by name. Discriminated on `kind` so the two
 * cannot be confused. On the create / import wire a managed ref's `skillId` may
 * carry a NAME (resolved to id server-side, or demoted to `project` when no
 * managed skill matches — RFC-178); at rest it is always an id.
 */
export const AgentSkillRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('managed'), skillId: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('project'), name: z.string().min(1).max(128) }),
])
export type AgentSkillRef = z.infer<typeof AgentSkillRefSchema>

/**
 * RFC-223 (PR-1) — the PORTABLE, name-based selector form of a skill reference
 * (agent.md export / cross-environment YAML). It carries NO DB id so an offline
 * parser can produce it without a database; the import boundary resolves it to
 * an `AgentSkillRef` against the actor's ACL-visible set. `ownerUsername`
 * disambiguates once uniqueness is relaxed (PR-8); ignored while name↔id is 1:1.
 */
export const AgentSkillSelectorSchema = z.union([
  z.object({
    kind: z.literal('managed'),
    name: z.string().min(1).max(128),
    ownerUsername: z.string().optional(),
  }),
  z.object({ kind: z.literal('project'), name: z.string().min(1).max(128) }),
])
export type AgentSkillSelector = z.infer<typeof AgentSkillSelectorSchema>

/** The display / selector name carried by a skill ref, ignoring its kind. For a
 *  managed ref this is the raw `skillId` (an id at rest, a name on the import
 *  wire); for a project ref it is the skill name. Used for preview + agent.md. */
export function agentSkillRefName(ref: AgentSkillRef): string {
  return ref.kind === 'managed' ? ref.skillId : ref.name
}

/**
 * RFC-223 (PR-1) — ref ← selector. Resolve a portable selector into a stored
 * ref. `resolveManagedId(name)` returns the managed skill id visible for that
 * name, or undefined; a managed selector that does not resolve is demoted to a
 * `project` ref (RFC-178: a name with no managed row is a repo-local skill).
 */
export function skillSelectorToRef(
  selector: AgentSkillSelector,
  resolveManagedId: (name: string) => string | undefined,
): AgentSkillRef {
  if (selector.kind === 'project') return { kind: 'project', name: selector.name }
  const id = resolveManagedId(selector.name)
  return id === undefined
    ? { kind: 'project', name: selector.name }
    : { kind: 'managed', skillId: id }
}

/**
 * RFC-223 (PR-1) — selector ← ref. Produce the portable selector for a stored
 * ref. `resolveManagedName(skillId)` maps a managed id back to its name (+ owner
 * for PR-8); a managed ref whose id no longer resolves is emitted as a `project`
 * selector carrying the raw id (best-effort — the row is gone).
 */
export function skillRefToSelector(
  ref: AgentSkillRef,
  resolveManagedName: (skillId: string) => { name: string; ownerUsername?: string } | undefined,
): AgentSkillSelector {
  if (ref.kind === 'project') return { kind: 'project', name: ref.name }
  const resolved = resolveManagedName(ref.skillId)
  if (resolved === undefined) return { kind: 'project', name: ref.skillId }
  return { kind: 'managed', name: resolved.name, ownerUsername: resolved.ownerUsername }
}

/** opencode permission map; passed through verbatim. */
export const AgentPermissionSchema = z.record(z.string(), z.unknown())
export type AgentPermission = z.infer<typeof AgentPermissionSchema>

/** Full agent resource (response shape). */
export const AgentSchema = z.object({
  id: z.string(),
  name: AgentNameSchema,
  description: z.string(),
  /** RFC-099 ACL — owner (users.id or '__system__'); null until first owner write. */
  ownerUserId: z.string().nullable().optional(),
  /** RFC-099 ACL — 'public' = every user; 'private' = owner + grants. Absent ⇒ 'public'. */
  visibility: ResourceVisibilitySchema.optional(),
  /** RFC-104 — read-only built-in marker. Response-only: Create/Update bodies
   *  are separate schemas that never accept it, and zod strips it if sent. */
  builtin: z.boolean().optional(),
  outputs: z.array(z.string()),
  outputKinds: AgentOutputKindsMapSchema.optional(),
  /** RFC-166 — declarative input ports. OPTIONAL on the DTO (same as
   *  outputKinds/role, RFC-060 precedent): existing fixtures/built-in agents
   *  need not spell it. rowToAgent always populates `[]` so real responses
   *  carry a value; consumers read `agent.inputs ?? []`. Duplicate port names
   *  are rejected (AgentInputPortsSchema — name is an identity key). */
  inputs: AgentInputPortsSchema.optional(),
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
  /**
   * RFC-014: when true (default), an iterate decision on a multi-markdown
   * upstream node re-generates every markdown[_file] sibling port and resets
   * sibling reviews back to awaiting_review. Author opt-out → only the
   * reviewed port regenerates (RFC-005 §2.1 #8 legacy behavior).
   */
  syncOutputsOnIterate: z.boolean(),
  /**
   * RFC-111 / RFC-112: agent runtime — a registered runtime NAME (the built-ins
   * are 'opencode' / 'claude-code'; custom forks add more). Absent → inherit
   * config.defaultRuntime (→ opencode). RFC-112 widens this from the two-value
   * enum to any name; the name resolves to a (protocol, binary) via the runtimes
   * registry at dispatch, and the model namespace follows the protocol.
   */
  runtime: z.string().min(1).optional(),
  permission: AgentPermissionSchema,
  /**
   * RFC-223 (PR-1): typed skill references. `managed` refs point at a DB skill
   * by id; `project` refs name a repo-local self-discovered skill (RFC-178, no
   * DB row). Replaces the former `string[]` of skill names. See
   * AgentSkillRefSchema.
   */
  skills: z.array(AgentSkillRefSchema),
  /**
   * RFC-022: agents this agent transitively requires at runtime, stored BY ID
   * (RFC-223 PR-1 — was names). The framework runs BFS over depends_on to
   * compute a closure, then injects every member as an entry under `agent` in
   * OPENCODE_CONFIG_CONTENT and unions every member's skills into
   * OPENCODE_CONFIG_DIR/skills/. Default `[]` keeps legacy single-agent
   * injection behavior.
   *
   * Save-time validation (services/agentDeps.ts): ids must exist, no
   * self-reference, no cycle. Workflow validator extends the existing
   * `agent-not-found` / `skill-not-found` checks to the closure.
   */
  dependsOn: z.array(ResourceRefSchema),
  /**
   * RFC-028: MCP servers this agent needs at runtime, stored BY ID (RFC-223
   * PR-1 — was names). Runner unions the mcp[] of every agent in the dependsOn
   * closure (RFC-022) and injects each member as an entry under `mcp` in
   * OPENCODE_CONFIG_CONTENT. opencode then spawns the listed servers and
   * exposes their tools to the spawned process. Default `[]` leaves the agent
   * free of framework-managed MCPs (the user's repo `.opencode/config.json` and
   * `~/.config/opencode/` MCPs still load naturally — see docs/OPENCODE_CONFIG.md §4).
   */
  mcp: z.array(ResourceRefSchema),
  /**
   * RFC-031: opencode plugins this agent needs at runtime, stored BY ID
   * (RFC-223 PR-1 — was names). Runner unions the plugins[] of every agent in
   * the dependsOn closure (RFC-022) and injects each member's
   * `file://<cachedPath>` (with options when present) under `plugin` in
   * OPENCODE_CONFIG_CONTENT. Spawn paths never hit the network because
   * cachedPath is populated at save time, not run time. Default `[]` leaves the
   * agent free of framework-managed plugins.
   */
  plugins: z.array(ResourceRefSchema),
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
  /** RFC-166 — declarative input ports; OPTIONAL on create bodies (server
   *  fills []). Duplicate port names rejected (AgentInputPortsSchema); existing
   *  callers/fixtures need not spell it. */
  inputs: AgentInputPortsSchema.optional(),
  /** RFC-060 PR-B — wrapper-fanout output rename sidecar (aggregator only). */
  outputWrapperPortNames: AgentOutputWrapperPortNamesSchema.optional(),
  /** RFC-060 PR-B — agent role flag; optional, treat absent as 'normal'. */
  role: AgentRoleSchema.optional(),
  /** RFC-014: default true — author must explicitly opt-out. */
  syncOutputsOnIterate: z.boolean().default(true),
  /** RFC-111 / RFC-112: agent runtime — a registered runtime NAME (built-ins
   *  'opencode' / 'claude-code'; custom forks add more). Absent → inherit. */
  runtime: z.string().min(1).optional(),
  permission: AgentPermissionSchema.default({}),
  /** RFC-223 (PR-1) — typed skill refs (managed=skillId / project=name). */
  skills: z.array(AgentSkillRefSchema).default([]),
  /** RFC-022 — see AgentSchema.dependsOn (id refs; name accepted on import). */
  dependsOn: z.array(ResourceRefSchema).max(64).default([]),
  /** RFC-028 — see AgentSchema.mcp (id refs; name accepted on import). */
  mcp: z.array(ResourceRefSchema).max(64).default([]),
  /** RFC-031 — see AgentSchema.plugins (id refs; name accepted on import). */
  plugins: z.array(ResourceRefSchema).max(64).default([]),
  frontmatterExtra: z.record(z.string(), z.unknown()).default({}),
  bodyMd: z.string().default(''),
})
export type CreateAgent = z.infer<typeof CreateAgentSchema>

/** PUT /api/agents/:name body. Name changes happen via /rename. */
export const UpdateAgentSchema = CreateAgentSchema.omit({ name: true })
  .partial()
  .extend({
    // RFC-115: unlike create (absent already means "no pin"), an UPDATE can
    // explicitly CLEAR a pinned runtime back to inherit by sending null.
    // undefined = leave the current value untouched (sparse-patch semantics).
    runtime: z.string().min(1).nullable().optional(),
  })
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>

/** POST /api/agents/:name/rename body. */
export const RenameAgentSchema = z.object({
  newName: AgentNameSchema,
})
export type RenameAgent = z.infer<typeof RenameAgentSchema>
