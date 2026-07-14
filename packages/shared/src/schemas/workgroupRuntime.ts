// RFC-164 PR-2 — workgroup runtime shapes: the task-level config snapshot,
// assignment / message DTO enums, and the group-specific envelope port
// payloads (design §1.3-1.5 / §5).
//
// The engine (PR-3) mints member runs whose protocol block is generated from
// these schemas — a member agent's own `outputs` declaration does NOT apply
// inside a workgroup task; the workgroup port set below replaces it.
//
// Member addressing inside payloads uses `displayName` tokens (never user
// ids — RFC-099 prompt-isolation invariant, design §11).

import { z } from 'zod'
import {
  WorkgroupMemberDisplayNameSchema,
  WorkgroupMemberTypeSchema,
  WorkgroupModeSchema,
  WorkgroupSwitchesSchema,
} from './workgroup'

// ---------------------------------------------------------------------------
// Task-level config snapshot (tasks.workgroup_config_json, design §1.3)
// ---------------------------------------------------------------------------

export const WorkgroupRuntimeMemberSchema = z.object({
  /** Member id frozen at launch (workgroup_members.id at snapshot time). */
  id: z.string().min(1),
  memberType: WorkgroupMemberTypeSchema,
  agentName: z.string().nullable(),
  /** Human member's users.id — server-side routing/audit only, never injected. */
  userId: z.string().nullable(),
  displayName: WorkgroupMemberDisplayNameSchema,
  roleDesc: z.string(),
})
export type WorkgroupRuntimeMember = z.infer<typeof WorkgroupRuntimeMemberSchema>

/**
 * The runtime copy the task owns (launch snapshot + mid-run edits, design
 * §8.4). The engine reads THIS, never the workgroups resource row.
 */
export const WorkgroupRuntimeConfigSchema = z.object({
  workgroupId: z.string().min(1),
  workgroupName: z.string().min(1),
  mode: WorkgroupModeSchema,
  /** Member id (of `members[]`) — non-null iff mode='leader_worker'. */
  leaderMemberId: z.string().nullable(),
  switches: WorkgroupSwitchesSchema,
  maxRounds: z.number().int().positive(),
  completionGate: z.boolean(),
  // RFC-180「全自动」— optional so pre-RFC-180 task snapshots (no field) parse as
  // non-autonomous (engine read sites coalesce `?? false`; zero regression). See
  // resolveCompletionGate / resolveClarifyEnabled in schemas/workgroup.ts.
  autonomous: z.boolean().optional(),
  instructions: z.string(),
  /** Launch goal text — the group's mission statement, injected every turn. */
  goal: z.string(),
  members: z.array(WorkgroupRuntimeMemberSchema).min(1),
})
export type WorkgroupRuntimeConfig = z.infer<typeof WorkgroupRuntimeConfigSchema>

// ---------------------------------------------------------------------------
// Assignment / message enums + DTOs (workgroup_assignments / _messages)
// ---------------------------------------------------------------------------

export const WORKGROUP_ASSIGNMENT_STATUSES = [
  'open', // fc: on the shared list, unclaimed
  'dispatched', // assigned, member run not started yet (human: awaiting delivery)
  'running', // agent member run in flight
  'awaiting_human', // agent run parked on a clarify round
  'delivered', // human member delivered; result awaits next-turn consumption
  'done',
  'failed',
  'canceled',
] as const
export const WorkgroupAssignmentStatusSchema = z.enum(WORKGROUP_ASSIGNMENT_STATUSES)
export type WorkgroupAssignmentStatus = z.infer<typeof WorkgroupAssignmentStatusSchema>

export const WORKGROUP_ASSIGNMENT_SOURCES = ['leader', 'human', 'self_claim', 'system'] as const
export const WorkgroupAssignmentSourceSchema = z.enum(WORKGROUP_ASSIGNMENT_SOURCES)
export type WorkgroupAssignmentSource = z.infer<typeof WorkgroupAssignmentSourceSchema>

export const WorkgroupAssignmentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  round: z.number().int().nonnegative(),
  source: WorkgroupAssignmentSourceSchema,
  createdByRunId: z.string().nullable(),
  /** Audit-only (source='human'); never injected into prompts (design §11). */
  createdByUserId: z.string().nullable(),
  assigneeMemberId: z.string().nullable(),
  title: z.string(),
  briefMd: z.string(),
  status: WorkgroupAssignmentStatusSchema,
  nodeRunId: z.string().nullable(),
  resultMessageId: z.string().nullable(),
  dedupKey: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type WorkgroupAssignment = z.infer<typeof WorkgroupAssignmentSchema>

export const WORKGROUP_MESSAGE_AUTHOR_KINDS = ['member', 'human', 'system'] as const
export const WorkgroupMessageAuthorKindSchema = z.enum(WORKGROUP_MESSAGE_AUTHOR_KINDS)
export type WorkgroupMessageAuthorKind = z.infer<typeof WorkgroupMessageAuthorKindSchema>

export const WORKGROUP_MESSAGE_KINDS = [
  'chat', // plain talk (blackboard / directed via mentions)
  'dispatch', // assignment card anchor (leader / human @-dispatch)
  'result', // agent member result summary
  'delivery', // human member delivery
  'decision', // leader decision (done summary)
  'system', // round markers, config changes, gate events, warnings
] as const
export const WorkgroupMessageKindSchema = z.enum(WORKGROUP_MESSAGE_KINDS)
export type WorkgroupMessageKind = z.infer<typeof WorkgroupMessageKindSchema>

export const WorkgroupMessageSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  round: z.number().int().nonnegative(),
  authorKind: WorkgroupMessageAuthorKindSchema,
  authorMemberId: z.string().nullable(),
  /** Audit/UI only; the room shows the user, prompts see nothing (design §11). */
  authorUserId: z.string().nullable(),
  kind: WorkgroupMessageKindSchema,
  bodyMd: z.string(),
  /** Parsed @-mention member ids. */
  mentionMemberIds: z.array(z.string()),
  assignmentId: z.string().nullable(),
  createdAt: z.number().int(),
})
export type WorkgroupMessage = z.infer<typeof WorkgroupMessageSchema>

// ---------------------------------------------------------------------------
// Per-member current run (RFC-179) — room runtime visibility. Derived + read-only:
// maps a member to its current / most-recent host node_run so the room can make
// each member clickable (→ Session drawer) and show an executing indicator.
// Never enters a prompt (design §11 prompt-isolation) — UI/room rendering only.
// ---------------------------------------------------------------------------

/** Which turn kind a host run represents (rerun_cause classification). */
export const WORKGROUP_RUN_KINDS = ['leader-round', 'assignment', 'message-turn'] as const
export const WorkgroupRunKindSchema = z.enum(WORKGROUP_RUN_KINDS)
export type WorkgroupRunKind = z.infer<typeof WorkgroupRunKindSchema>

/**
 * A member's current session run (RFC-179 §2.1). `running` wins; else the most
 * recent terminal run; else the member has none (`memberRuns[id]` is null).
 * `triggerMessageId` is the @-mention that woke a message-turn (null otherwise),
 * driving the room's per-message「执行中」pill (design §5).
 */
export const WorkgroupMemberCurrentRunSchema = z.object({
  nodeRunId: z.string(),
  status: z.string(),
  kind: WorkgroupRunKindSchema,
  triggerMessageId: z.string().nullable(),
})
export type WorkgroupMemberCurrentRun = z.infer<typeof WorkgroupMemberCurrentRunSchema>

/**
 * RFC-182 — one host turn in the room's full execution history (`runHistory`
 * on the room aggregate, ascending by nodeRunId = mint order). Derived +
 * read-only; NEVER enters a prompt. `memberRuns` is a projection of this list
 * (running wins, else newest), so the two can never drift.
 */
export const WorkgroupRunEntrySchema = z.object({
  nodeRunId: z.string(),
  memberId: z.string(),
  /** Frozen at derivation; null when the member was removed mid-run
   *  (design-gate P2 — the UI renders a tombstone label, never a blank). */
  displayName: z.string().nullable(),
  kind: WorkgroupRunKindSchema,
  status: z.string(),
  /** Leader rounds carry their 1-based ordinal (countRoundsUsed semantics) so
   *  the room timeline can place the card under its round divider; others null. */
  round: z.number().int().nullable(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  triggerMessageId: z.string().nullable(),
  /** kind==='assignment' → the assignment id (= shardKey); else null. */
  assignmentId: z.string().nullable(),
  /** RFC-181 C — a clarify-forbidden closure surfaced as a display note
   *  (backend derives it from the run's failure columns; the protocol string
   *  never crosses the wire). */
  note: z.enum(['clarify-suppressed']).nullable(),
})
export type WorkgroupRunEntry = z.infer<typeof WorkgroupRunEntrySchema>

// ---------------------------------------------------------------------------
// Envelope ports (design §5) — generated protocol replaces agent outputs
// ---------------------------------------------------------------------------

export const WG_PORT_ASSIGNMENTS = 'wg_assignments'
export const WG_PORT_MESSAGES = 'wg_messages'
export const WG_PORT_DECISION = 'wg_decision'
export const WG_PORT_RESULT = 'wg_result'
export const WG_PORT_TASKS_ADD = 'wg_tasks_add'

/** Per-turn safety caps (design §12 消息风暴). */
export const WG_MAX_ASSIGNMENTS_PER_TURN = 16
export const WG_MAX_MESSAGES_PER_TURN = 16
export const WG_MAX_TASKS_ADD_PER_TURN = 32

export const WgAssignmentItemSchema = z.object({
  /** Target member displayName (roster token). */
  member: WorkgroupMemberDisplayNameSchema,
  title: z.string().trim().min(1).max(200),
  /** Task brief — objective / expected output / boundaries (design §5). */
  brief: z.string().min(1).max(16384),
})
export type WgAssignmentItem = z.infer<typeof WgAssignmentItemSchema>
export const WgAssignmentsPortSchema = z
  .array(WgAssignmentItemSchema)
  .max(WG_MAX_ASSIGNMENTS_PER_TURN)

export const WgMessageItemSchema = z.object({
  /** Target member displayName, or null = blackboard broadcast. */
  to: WorkgroupMemberDisplayNameSchema.nullable(),
  body: z.string().trim().min(1).max(8192),
})
export type WgMessageItem = z.infer<typeof WgMessageItemSchema>
export const WgMessagesPortSchema = z.array(WgMessageItemSchema).max(WG_MAX_MESSAGES_PER_TURN)

export const WgDecisionSchema = z
  .object({
    action: z.enum(['continue', 'done']),
    /** Group summary — REQUIRED when action='done' (becomes the decision message). */
    summary: z.string().trim().max(65536).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.action === 'done' && (d.summary === undefined || d.summary.length === 0)) {
      ctx.addIssue({ code: 'custom', message: "decision 'done' requires a non-empty summary" })
    }
  })
export type WgDecision = z.infer<typeof WgDecisionSchema>

export const WgResultSchema = z.object({
  summary: z.string().trim().min(1).max(16384),
  detail: z.string().max(65536).optional(),
})
export type WgResult = z.infer<typeof WgResultSchema>

export const WgTaskAddItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  brief: z.string().max(16384).default(''),
})
export type WgTaskAddItem = z.infer<typeof WgTaskAddItemSchema>
export const WgTasksAddPortSchema = z.array(WgTaskAddItemSchema).max(WG_MAX_TASKS_ADD_PER_TURN)

// ---------------------------------------------------------------------------
// Port parsing (JSON text from the envelope → validated payload)
// ---------------------------------------------------------------------------

export type WgPortParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function parseJsonPort<S extends z.ZodTypeAny>(
  schema: S,
  raw: string,
): WgPortParseResult<z.output<S>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      ok: false,
      errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
  const r = schema.safeParse(parsed)
  if (!r.success) {
    return {
      ok: false,
      errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  return { ok: true, value: r.data as z.output<S> }
}

/**
 * Validate member displayName references against the roster. Unknown names
 * reject the WHOLE port (dispatch atomicity, design §5) — the engine turns
 * this into a malformed-retry with the error list injected.
 */
function unknownMembers(
  names: ReadonlyArray<string | null>,
  roster: ReadonlySet<string>,
): string[] {
  const missing = new Set<string>()
  for (const n of names) {
    if (n !== null && !roster.has(n)) missing.add(n)
  }
  return [...missing]
}

export function parseWgAssignmentsPort(
  raw: string,
  rosterDisplayNames: ReadonlySet<string>,
): WgPortParseResult<WgAssignmentItem[]> {
  const r = parseJsonPort(WgAssignmentsPortSchema, raw)
  if (!r.ok) return r
  const missing = unknownMembers(
    r.value.map((a) => a.member),
    rosterDisplayNames,
  )
  if (missing.length > 0) {
    return { ok: false, errors: missing.map((m) => `unknown member '${m}'`) }
  }
  return r
}

export function parseWgMessagesPort(
  raw: string,
  rosterDisplayNames: ReadonlySet<string>,
): WgPortParseResult<WgMessageItem[]> {
  const r = parseJsonPort(WgMessagesPortSchema, raw)
  if (!r.ok) return r
  const missing = unknownMembers(
    r.value.map((m) => m.to),
    rosterDisplayNames,
  )
  if (missing.length > 0) {
    return { ok: false, errors: missing.map((m) => `unknown member '${m}'`) }
  }
  return r
}

export function parseWgDecisionPort(raw: string): WgPortParseResult<WgDecision> {
  return parseJsonPort(WgDecisionSchema, raw)
}

export function parseWgResultPort(raw: string): WgPortParseResult<WgResult> {
  return parseJsonPort(WgResultSchema, raw)
}

export function parseWgTasksAddPort(raw: string): WgPortParseResult<WgTaskAddItem[]> {
  return parseJsonPort(WgTasksAddPortSchema, raw)
}

/**
 * free_collab duplicate-task guard key (design §7.3): NFKC + lower + strip
 * whitespace/punctuation. Near-synonym duplicates are out of scope (v1
 * documented limitation — humans can cancel redundant cards in the room).
 */
export function normalizeWgTaskTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}
