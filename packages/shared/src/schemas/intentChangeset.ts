// RFC-234 — intent-builder changeset contract (T1).
//
// The intent system agent's ONLY output channel is a `<workflow-output nonce>`
// envelope whose `changeset` port carries the JSON validated here. Everything
// in this file is deliberately model-facing-hostile:
//
//  - Cross-resource references may ONLY be session handles (`res#<type>#<n>`)
//    or same-changeset tempRefs (`$new:<slug>`). Raw ULIDs, resource names and
//    usernames are rejected so a hallucinated / enumerated id can never reach
//    the resolve seam (design §3.1, Codex design-gate P1-1).
//  - Payload sizes are bounded BELOW every transport limit (stdout cap 8 MiB,
//    envelope rolling cap 8 MiB) so no schema-legal changeset is unemittable
//    (design §3.2, design-gate P1-6). The invariant is locked by a golden test
//    that walks the maximum legal payload through generate→parse→apply.
//  - Secret-bearing slots only ever accept the sentinel (see
//    ../intentSecretSlots.ts); real values enter at confirm time via
//    server-issued slots, never through the model.
//
// Pure schema module: no IO, browser-safe (shared by backend validation and
// the frontend confirm UI).

import { z } from 'zod'
import { AgentOutputKindSchema } from './review'
import { AGENT_NAME_RE } from './agent'
import { ACL_RESOURCE_TYPES, type AclResourceType } from './resourceAcl'

export const INTENT_CHANGESET_SCHEMA_VERSION = 1

// -----------------------------------------------------------------------------
// Reference grammar
// -----------------------------------------------------------------------------

/** Session-scoped opaque resource handle minted by the platform (design §3.1).
 *  The numeric suffix is a per-session counter; the mapping to a canonical id
 *  lives ONLY in the server-side context manifest. */
export const INTENT_HANDLE_RE =
  /^res#(agent|skill|mcp|plugin|workflow|workgroup)#([1-9][0-9]{0,5})$/

/** Same-changeset forward reference to a `create` op (`tempRef`). */
export const INTENT_TEMP_REF_RE = /^\$new:[a-z0-9][a-z0-9_-]{0,63}$/

export const IntentHandleSchema = z
  .string()
  .regex(INTENT_HANDLE_RE, 'must be a session resource handle (res#<type>#<n>)')
export const IntentTempRefSchema = z
  .string()
  .regex(INTENT_TEMP_REF_RE, 'must be a tempRef ($new:<slug>)')

/** A reference slot inside a payload: handle or tempRef, nothing else. */
export const IntentRefSchema = z.union([IntentHandleSchema, IntentTempRefSchema])
export type IntentRef = z.infer<typeof IntentRefSchema>

export function intentHandleType(handle: string): AclResourceType | null {
  const m = INTENT_HANDLE_RE.exec(handle)
  return m ? (m[1] as AclResourceType) : null
}

export function isIntentTempRef(ref: string): boolean {
  return INTENT_TEMP_REF_RE.test(ref)
}

// -----------------------------------------------------------------------------
// Size invariants (design §3.2) — all bounds sit far below the 8 MiB transport
// ceiling; the canonical-JSON byte bound is enforced by parseIntentChangeset.
// -----------------------------------------------------------------------------

export const INTENT_LIMITS = {
  maxOps: 64,
  maxSkillFiles: 32,
  maxSkillFileBytes: 128 * 1024,
  maxSkillFilesTotalBytes: 1024 * 1024,
  maxChangesetBytes: 2 * 1024 * 1024,
  maxBodyMdBytes: 256 * 1024,
  maxQuestions: 5,
  maxMountRequests: 16,
} as const

// Walled-off global lookup (git-url.ts precedent) so the shared tsconfig needs
// no DOM/Node lib entry: Bun and every modern browser provide TextEncoder.
const utf8Bytes = (s: string): number => {
  const TextEncoderCtor = (
    globalThis as unknown as { TextEncoder: new () => { encode: (s: string) => Uint8Array } }
  ).TextEncoder
  return new TextEncoderCtor().encode(s).length
}

// -----------------------------------------------------------------------------
// Per-type payloads (portable form; canonicalization happens server-side in
// services/intent/resolveChangeset.ts — the single resolve seam)
// -----------------------------------------------------------------------------

const NameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(AGENT_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

const DescriptionSchema = z.string().max(4096).default('')

/** Repo-local (self-discovered) skill selector — the only non-handle skill
 *  form allowed, because project skills have no DB row to point a handle at. */
const IntentProjectSkillSchema = z
  .object({ kind: z.literal('project'), name: z.string().min(1).max(128) })
  .strict()

const IntentAgentSkillEntrySchema = z.union([IntentRefSchema, IntentProjectSkillSchema])

export const IntentAgentPayloadSchema = z
  .object({
    name: NameSchema,
    description: DescriptionSchema,
    /** Output port names; duplicates rejected at resolve time by CreateAgentSchema. */
    outputs: z.array(z.string().min(1).max(128)).max(64).default([]),
    outputKinds: z.record(z.string(), AgentOutputKindSchema).optional(),
    inputs: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            // Canonical RFC-060 kind grammar — a free string here let models
            // invent kinds that then exploded inside prepareAgentCreate
            // (live-run 500, 2026-07-28). Fail at parse with the same message.
            kind: AgentOutputKindSchema,
            required: z.boolean().optional(),
            description: z.string().max(1024).optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    outputWrapperPortNames: z.record(z.string(), z.string().min(1)).optional(),
    role: z.enum(['normal', 'aggregator']).optional(),
    syncOutputsOnIterate: z.boolean().optional(),
    /** Runtime PROFILE NAME (not a resource handle — runtimes are not one of
     *  the six ACL types). Existence is validated at resolve time. */
    runtime: z.string().min(1).max(128).optional(),
    permission: z.record(z.string(), z.unknown()).optional(),
    skills: z.array(IntentAgentSkillEntrySchema).max(64).default([]),
    dependsOn: z.array(IntentRefSchema).max(64).default([]),
    mcp: z.array(IntentRefSchema).max(64).default([]),
    plugins: z.array(IntentRefSchema).max(64).default([]),
    frontmatterExtra: z.record(z.string(), z.unknown()).optional(),
    bodyMd: z
      .string()
      .refine((s) => utf8Bytes(s) <= INTENT_LIMITS.maxBodyMdBytes, 'bodyMd exceeds 256 KiB')
      .default(''),
  })
  .strict()
export type IntentAgentPayload = z.infer<typeof IntentAgentPayloadSchema>

/** Skill file path: relative, normalized, no traversal, no SKILL.md (the main
 *  file is first-class `bodyMd`/`frontmatterExtra`, mirroring the platform's
 *  protected-main-file rule in shared/skill-md.ts). */
const SKILL_FILE_PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/
export const IntentSkillFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(SKILL_FILE_PATH_RE, 'path must be relative segments of [A-Za-z0-9._-]')
  .refine(
    (p) => !p.split('/').some((seg) => seg === '.' || seg === '..'),
    'path traversal forbidden',
  )
  .refine((p) => p.toUpperCase() !== 'SKILL.MD', 'SKILL.md is authored via bodyMd, not files[]')

export const IntentSkillPayloadSchema = z
  .object({
    name: NameSchema,
    description: DescriptionSchema,
    frontmatterExtra: z.record(z.string(), z.unknown()).optional(),
    bodyMd: z
      .string()
      .refine((s) => utf8Bytes(s) <= INTENT_LIMITS.maxBodyMdBytes, 'bodyMd exceeds 256 KiB'),
    /** Auxiliary TEXT files (D20). Binary content cannot ride an envelope. */
    files: z
      .array(
        z
          .object({
            path: IntentSkillFilePathSchema,
            content: z
              .string()
              .refine(
                (s) => utf8Bytes(s) <= INTENT_LIMITS.maxSkillFileBytes,
                'file exceeds 128 KiB',
              ),
          })
          .strict(),
      )
      .max(INTENT_LIMITS.maxSkillFiles)
      .default([])
      .superRefine((files, ctx) => {
        const seen = new Set<string>()
        let total = 0
        for (const f of files) {
          const key = f.path.toLowerCase()
          if (seen.has(key)) {
            ctx.addIssue({ code: 'custom', message: `duplicate file path: ${f.path}` })
          }
          seen.add(key)
          total += utf8Bytes(f.content)
        }
        if (total > INTENT_LIMITS.maxSkillFilesTotalBytes) {
          ctx.addIssue({ code: 'custom', message: 'skill files exceed 1 MiB total' })
        }
      }),
  })
  .strict()
export type IntentSkillPayload = z.infer<typeof IntentSkillPayloadSchema>

/** MCP payload mirrors McpLocal/RemoteConfig bounds (schemas/mcp.ts) but stays
 *  its own schema: secret-bearing positions additionally pass the closed-slot
 *  scanner in ../intentSecretSlots.ts (sentinel-or-reject). */
export const IntentMcpPayloadSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('local'),
      name: NameSchema,
      description: DescriptionSchema,
      enabled: z.boolean().optional(),
      config: z
        .object({
          command: z.array(z.string().min(1).max(1024)).min(1).max(64),
          env: z.record(z.string().max(128), z.string().max(1024)).optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('remote'),
      name: NameSchema,
      description: DescriptionSchema,
      enabled: z.boolean().optional(),
      config: z
        .object({
          url: z
            .string()
            .min(1)
            .max(2048)
            .refine(
              (u) => u.startsWith('http://') || u.startsWith('https://'),
              'url must start with http:// or https://',
            ),
          headers: z.record(z.string().max(128), z.string().max(1024)).optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
])
export type IntentMcpPayload = z.infer<typeof IntentMcpPayloadSchema>

export const IntentPluginPayloadSchema = z
  .object({
    name: NameSchema,
    /** npm specifier / git URL. Scanned for embedded credentials (design §8). */
    spec: z.string().min(1).max(1024),
    optionsJson: z.record(z.string(), z.unknown()).optional(),
    description: DescriptionSchema,
    enabled: z.boolean().optional(),
  })
  .strict()
export type IntentPluginPayload = z.infer<typeof IntentPluginPayloadSchema>

/** Workflow definition rides as the platform's definition JSON with ONE
 *  deviation: agent-single nodes carry `agentRef` (handle | tempRef) instead of
 *  `agentId`/`agentName`. The definition is otherwise passthrough here; full
 *  structural validation runs after resolve via services/workflow.validator.ts
 *  (design §9.2). collectIntentWorkflowAgentRefs() is the single walker both
 *  the schema refine and the resolve seam use. */
export const IntentWorkflowNodeSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.string().min(1).max(64),
    agentRef: IntentRefSchema.optional(),
  })
  .passthrough()

export const IntentWorkflowDefinitionSchema = z
  .object({
    $schema_version: z.number().int().positive(),
    inputs: z.array(z.unknown()).max(64).default([]),
    nodes: z.array(IntentWorkflowNodeSchema).max(256),
    edges: z.array(z.unknown()).max(1024).default([]),
    outputs: z.unknown().optional(),
  })
  .passthrough()

export interface IntentWorkflowRefViolation {
  nodeId: string
  reason: 'agent-id-forbidden' | 'agent-name-forbidden' | 'agent-ref-missing'
}

/** Walk a definition: return the agentRefs of agent-single nodes plus any
 *  identity-form violations (raw agentId / agentName are model-forbidden). */
export function collectIntentWorkflowAgentRefs(definition: {
  nodes: Array<Record<string, unknown>>
}): { refs: string[]; violations: IntentWorkflowRefViolation[] } {
  const refs: string[] = []
  const violations: IntentWorkflowRefViolation[] = []
  for (const node of definition.nodes) {
    const nodeId = typeof node.id === 'string' ? node.id : '<unknown>'
    if (node.kind !== 'agent-single') continue
    if (typeof node.agentId === 'string' && node.agentId.length > 0) {
      violations.push({ nodeId, reason: 'agent-id-forbidden' })
      continue
    }
    if (typeof node.agentName === 'string' && node.agentName.length > 0) {
      violations.push({ nodeId, reason: 'agent-name-forbidden' })
      continue
    }
    const ref = node.agentRef
    if (typeof ref !== 'string' || !IntentRefSchema.safeParse(ref).success) {
      violations.push({ nodeId, reason: 'agent-ref-missing' })
      continue
    }
    refs.push(ref)
  }
  return { refs, violations }
}

export const IntentWorkflowPayloadSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: DescriptionSchema,
    definition: IntentWorkflowDefinitionSchema.superRefine((def, ctx) => {
      const { violations } = collectIntentWorkflowAgentRefs(
        def as { nodes: Array<Record<string, unknown>> },
      )
      for (const v of violations) {
        ctx.addIssue({
          code: 'custom',
          message: `node ${v.nodeId}: ${v.reason} (agent-single nodes must use agentRef = handle|tempRef)`,
        })
      }
    }),
  })
  .strict()
export type IntentWorkflowPayload = z.infer<typeof IntentWorkflowPayloadSchema>

/** Workgroup members: agent members reference by handle/tempRef; human members
 *  are PLACEHOLDERS ONLY (displayName + roleDesc, D16) — binding to a real
 *  user happens in the confirm UI via server-issued slots, never in the model
 *  payload. */
export const IntentWorkgroupMemberSchema = z.discriminatedUnion('memberType', [
  z
    .object({
      memberType: z.literal('agent'),
      agentRef: IntentRefSchema,
      displayName: z.string().min(1).max(64),
      roleDesc: z.string().max(1024).default(''),
    })
    .strict(),
  z
    .object({
      memberType: z.literal('human'),
      displayName: z.string().min(1).max(64),
      roleDesc: z.string().max(1024).default(''),
    })
    .strict(),
])
export type IntentWorkgroupMember = z.infer<typeof IntentWorkgroupMemberSchema>

export const IntentWorkgroupPayloadSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: DescriptionSchema,
    instructions: z.string().max(65536).default(''),
    mode: z.enum(['leader_worker', 'free_collab', 'dynamic_workflow']),
    leaderDisplayName: z.string().min(1).max(64).optional(),
    switches: z
      .object({
        shareOutputs: z.boolean().default(true),
        directMessages: z.boolean().default(false),
        blackboard: z.boolean().default(false),
      })
      .strict()
      .optional(),
    maxRounds: z.number().int().min(1).max(1000).optional(),
    completionGate: z.boolean().optional(),
    clarifyBudget: z.number().int().min(0).max(50).optional(),
    fanOut: z.boolean().optional(),
    members: z.array(IntentWorkgroupMemberSchema).max(64).default([]),
  })
  .strict()
  .superRefine((wg, ctx) => {
    const seen = new Set<string>()
    for (const m of wg.members) {
      const key = m.displayName.toLowerCase()
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', message: `duplicate member displayName: ${m.displayName}` })
      }
      seen.add(key)
    }
    if (wg.leaderDisplayName !== undefined) {
      const leader = wg.members.find((m) => m.displayName === wg.leaderDisplayName)
      if (!leader) {
        ctx.addIssue({ code: 'custom', message: 'leaderDisplayName does not match any member' })
      } else if (leader.memberType !== 'agent') {
        ctx.addIssue({ code: 'custom', message: 'leader must be an agent member' })
      }
    }
    if (wg.mode === 'dynamic_workflow' && wg.members.some((m) => m.memberType === 'human')) {
      ctx.addIssue({ code: 'custom', message: 'dynamic_workflow forbids human members' })
    }
  })
export type IntentWorkgroupPayload = z.infer<typeof IntentWorkgroupPayloadSchema>

// -----------------------------------------------------------------------------
// Ops + changeset
// -----------------------------------------------------------------------------

export const IntentOpIdSchema = z.string().regex(/^op-[1-9][0-9]{0,3}$/, 'opId must be op-<n>')

const opBase = {
  opId: IntentOpIdSchema,
  /** Optional one-line rationale surfaced on the change card. */
  note: z.string().max(512).optional(),
}

function opPair<T extends AclResourceType, P extends z.ZodTypeAny>(resourceType: T, payload: P) {
  const create = z
    .object({
      ...opBase,
      action: z.literal('create'),
      resourceType: z.literal(resourceType),
      tempRef: IntentTempRefSchema,
      payload,
    })
    .strict()
  const update = z
    .object({
      ...opBase,
      action: z.literal('update'),
      resourceType: z.literal(resourceType),
      /** Handle of a manifest (dumped) resource; MUST match resourceType. */
      target: IntentHandleSchema,
      payload,
    })
    .strict()
  return [create, update] as const
}

export const IntentOpSchema = z.union([
  ...opPair('agent', IntentAgentPayloadSchema),
  ...opPair('skill', IntentSkillPayloadSchema),
  ...opPair('mcp', IntentMcpPayloadSchema),
  ...opPair('plugin', IntentPluginPayloadSchema),
  ...opPair('workflow', IntentWorkflowPayloadSchema),
  ...opPair('workgroup', IntentWorkgroupPayloadSchema),
])
export type IntentOp = z.infer<typeof IntentOpSchema>

export const IntentChangesetSchema = z
  .object({
    $schema_version: z.literal(INTENT_CHANGESET_SCHEMA_VERSION),
    ops: z.array(IntentOpSchema).min(1).max(INTENT_LIMITS.maxOps),
  })
  .strict()
  .superRefine((cs, ctx) => {
    const opIds = new Set<string>()
    const tempRefs = new Set<string>()
    const updateTargets = new Set<string>()
    for (const op of cs.ops) {
      if (opIds.has(op.opId)) {
        ctx.addIssue({ code: 'custom', message: `duplicate opId: ${op.opId}` })
      }
      opIds.add(op.opId)
      if (op.action === 'create') {
        if (tempRefs.has(op.tempRef)) {
          ctx.addIssue({ code: 'custom', message: `duplicate tempRef: ${op.tempRef}` })
        }
        tempRefs.add(op.tempRef)
      } else {
        if (intentHandleType(op.target) !== op.resourceType) {
          ctx.addIssue({
            code: 'custom',
            message: `${op.opId}: target handle type does not match resourceType`,
          })
        }
        if (updateTargets.has(op.target)) {
          ctx.addIssue({ code: 'custom', message: `duplicate update target: ${op.target}` })
        }
        updateTargets.add(op.target)
      }
    }
    // Every tempRef referenced anywhere must be declared by a create op.
    const referenced = collectChangesetRefs(cs as IntentChangeset)
    for (const ref of referenced) {
      if (isIntentTempRef(ref) && !tempRefs.has(ref)) {
        ctx.addIssue({ code: 'custom', message: `undeclared tempRef referenced: ${ref}` })
      }
    }
  })
export type IntentChangeset = z.infer<typeof IntentChangesetSchema>

/** Every handle/tempRef reference reachable from op payloads (dedup, stable
 *  order). Single source shared by the schema refine, the resolve seam and the
 *  UI dependency preview. */
export function collectChangesetRefs(cs: IntentChangeset): string[] {
  const out: string[] = []
  const push = (ref: string) => {
    if (!out.includes(ref)) out.push(ref)
  }
  for (const op of cs.ops) {
    switch (op.resourceType) {
      case 'agent': {
        for (const s of op.payload.skills) if (typeof s === 'string') push(s)
        for (const r of op.payload.dependsOn) push(r)
        for (const r of op.payload.mcp) push(r)
        for (const r of op.payload.plugins) push(r)
        break
      }
      case 'workflow': {
        const { refs } = collectIntentWorkflowAgentRefs(
          op.payload.definition as { nodes: Array<Record<string, unknown>> },
        )
        for (const r of refs) push(r)
        break
      }
      case 'workgroup': {
        for (const m of op.payload.members) {
          if (m.memberType === 'agent') push(m.agentRef)
        }
        break
      }
      default:
        break
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// Envelope port payloads (questions / requests) — design §3.3
// -----------------------------------------------------------------------------

export const IntentQuestionSchema = z
  .object({
    id: z.string().min(1).max(64),
    question: z.string().min(1).max(2048),
    options: z.array(z.string().min(1).max(512)).min(2).max(4),
    multiSelect: z.boolean().default(false),
  })
  .strict()
export type IntentQuestion = z.infer<typeof IntentQuestionSchema>

export const IntentQuestionsSchema = z
  .array(IntentQuestionSchema)
  .min(1)
  .max(INTENT_LIMITS.maxQuestions)
  .superRefine((qs, ctx) => {
    const seen = new Set<string>()
    for (const q of qs) {
      if (seen.has(q.id))
        ctx.addIssue({ code: 'custom', message: `duplicate question id: ${q.id}` })
      seen.add(q.id)
    }
  })

/** Mount request = SUGGESTION ONLY (design-gate P1-4): the platform surfaces it
 *  for explicit user approval; nothing is auto-mounted. `name` is matched
 *  against the actor-visible inventory server-side; unknown names surface as
 *  not-found suggestions without existence disclosure beyond the actor's own
 *  visibility. */
export const IntentMountRequestSchema = z
  .object({
    resourceType: z.enum(ACL_RESOURCE_TYPES),
    name: z.string().min(1).max(200),
    reason: z.string().max(512).optional(),
  })
  .strict()
export type IntentMountRequest = z.infer<typeof IntentMountRequestSchema>

export const IntentMountRequestsSchema = z
  .array(IntentMountRequestSchema)
  .min(1)
  .max(INTENT_LIMITS.maxMountRequests)

// -----------------------------------------------------------------------------
// Canonical JSON + byte-bound entry point
// -----------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted, no whitespace. The backend hashes
 *  this exact string (sha-256) into intent_drafts.draft_hash; keeping the
 *  canonicalizer here means frontend previews and backend fences agree. */
export function canonicalIntentJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === 'object') {
      const src = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(src).sort()) out[k] = sort(src[k])
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}

export type IntentChangesetParseResult =
  | { ok: true; changeset: IntentChangeset; canonicalJson: string; bytes: number }
  | { ok: false; errors: string[] }

/** The single entry point the turn engine uses on the `changeset` port text. */
/**
 * Flatten zod issues into agent-actionable `path: message` lines. Plain-union
 * failures (IntentOpSchema is a 12-branch union) collapse to a bare "Invalid
 * input" by default — useless for the model self-fix loop (live deepseek run,
 * 2026-07-28). For invalid_union we recurse into the branch with the FEWEST
 * issues (almost always the intended variant) so the errors name the exact
 * offending fields. Output is capped — INTENT.md replays these verbatim.
 */
const MAX_CHANGESET_ERRORS = 12
/**
 * Codex impl-gate P1-5 — server-issued `finalName` slot values must satisfy
 * the SAME grammar as the changeset's own name field for that resource type
 * (the overlay happens AFTER schema parse, so without this a confirm-time
 * rename could smuggle arbitrary strings past canonical validation).
 * Returns null when valid, else the rejection message.
 */
export function validateFinalNameForType(
  resourceType: 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup',
  value: string,
): string | null {
  if (resourceType === 'workflow' || resourceType === 'workgroup') {
    if (value.length < 1 || value.length > 200) return 'name must be 1..200 characters'
    // Control chars would break YAML/JSON round-trips and canvas labels; the
    // codepoint scan avoids a control-char regex (eslint no-control-regex).
    for (const ch of value) {
      const code = ch.codePointAt(0) ?? 0
      if (code < 0x20 || code === 0x7f) return 'name must not contain control characters'
    }
    return null
  }
  if (value.length < 1 || value.length > 128) return 'name must be 1..128 characters'
  if (!AGENT_NAME_RE.test(value)) {
    return 'name must start with [a-z0-9] and contain only [a-z0-9_-]'
  }
  return null
}

export function formatChangesetIssues(issues: readonly z.ZodIssue[]): string[] {
  const lines = expandIssues(issues, [])
  if (lines.length <= MAX_CHANGESET_ERRORS) return lines
  return [
    ...lines.slice(0, MAX_CHANGESET_ERRORS),
    `… ${lines.length - MAX_CHANGESET_ERRORS} more issues truncated`,
  ]
}

function expandIssues(
  issues: readonly z.ZodIssue[],
  prefix: readonly (string | number)[],
): string[] {
  const out: string[] = []
  for (const issue of issues) {
    const path = [...prefix, ...issue.path]
    if (issue.code === 'invalid_union') {
      const branches = (issue as z.ZodInvalidUnionIssue).unionErrors ?? []
      let best: string[] | null = null
      for (const branch of branches) {
        const expanded = expandIssues(branch.issues, path)
        if (best === null || expanded.length < best.length) best = expanded
      }
      out.push(...(best ?? [`${path.join('.') || '$'}: no union branch matched`]))
      continue
    }
    out.push(`${path.join('.') || '$'}: ${issue.message}`)
  }
  return out
}

export function parseIntentChangeset(portText: string): IntentChangesetParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(portText)
  } catch (err) {
    return { ok: false, errors: [`changeset-json-invalid: ${(err as Error).message}`] }
  }
  const parsed = IntentChangesetSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, errors: formatChangesetIssues(parsed.error.issues) }
  }
  const canonicalJson = canonicalIntentJson(parsed.data)
  const bytes = utf8Bytes(canonicalJson)
  if (bytes > INTENT_LIMITS.maxChangesetBytes) {
    return {
      ok: false,
      errors: [
        `changeset-too-large: ${bytes} bytes > ${INTENT_LIMITS.maxChangesetBytes} (split into multiple submissions)`,
      ],
    }
  }
  return { ok: true, changeset: parsed.data, canonicalJson, bytes }
}
