// RFC-164 — workgroup (工作组) schemas: a sixth ACL resource that groups
// agents (and humans) into a runtime-collaborating team, launched as a task
// (leader dispatches work turn-by-turn, or leaderless free collaboration).
//
// Resource-level shapes only. Runtime shapes (assignments / messages /
// envelope ports / cursors) land with the engine PRs — see
// design/RFC-164-workgroup/design.md.
//
// Member addressing: `displayName` is the group-unique token used by the
// roster, @-mentions and dispatch briefs. For human members it is a REQUIRED
// alias so prompts never carry user ids (RFC-099 prompt-isolation invariant,
// design §11). Create/Update reference the leader by displayName (member ids
// are server-generated); the stored row keeps `leaderMemberId`.

import { z } from 'zod'
import { ResourceVisibilitySchema } from './resourceAcl'

/**
 * RFC-217 T3 (G7) — message-turn shardKey codec: `msg:<memberId>:<maxMsgId>`.
 * The SINGLE build/parse pair for the `msg:` wire family (engine adoption,
 * room kind derivation, clarify asker folding all consume it) — hand-rolled
 * `.split(':')` on shard keys is grep-banned in the workgroup dir.
 */
export function buildMsgShardKey(memberId: string, maxMessageId: string): string {
  return `msg:${memberId}:${maxMessageId || '0'}`
}
export function parseMsgShardKey(
  shardKey: string,
): { memberId: string; maxMessageId: string } | null {
  const m = /^msg:([^:]+):(.*)$/.exec(shardKey)
  return m === null ? null : { memberId: m[1] as string, maxMessageId: m[2] as string }
}

/**
 * RFC-215 §3.1 — fc task-batch shard key: `batch:<memberId>:<id1>+<id2>...`.
 * memberId/卡 id 均为 ULID（不含 `:`/`+`）. The SINGLE-SOURCE codec every batch
 * consumer keys on (design §9); lives here (not workgroupRuntime.ts) so the
 * in-module wgClarifyAskerKey can use it too — workgroupRuntime imports FROM this
 * file, so a helper it owned would be unreachable here without a cycle. Parses
 * via indexOf/slice, never the grep-banned `.split(':')`.
 */
export function buildBatchShardKey(memberId: string, assignmentIds: readonly string[]): string {
  return `batch:${memberId}:${assignmentIds.join('+')}`
}

export function parseBatchShardKey(
  shardKey: string | null,
): { memberId: string; assignmentIds: string[] } | null {
  if (shardKey === null || !shardKey.startsWith('batch:')) return null
  const rest = shardKey.slice('batch:'.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const memberId = rest.slice(0, sep)
  const ids = rest
    .slice(sep + 1)
    .split('+')
    .filter((s) => s.length > 0)
  if (ids.length === 0) return null
  return { memberId, assignmentIds: ids }
}

/** Permitted characters in workgroup name (URL-safe; matches `/api/workgroups/:name`). */
export const WORKGROUP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const WorkgroupNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(128, 'name too long')
  .regex(WORKGROUP_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

// RFC-167: `dynamic_workflow` is the THIRD execution mode (user 2026-07-11
// "工作组有三种执行模式：leader/自由/动态工作流"). Unlike the two turn-based
// chatroom modes, a dynamic_workflow group's agent members are an orchestratable
// POOL: launching runs a built-in orchestrator that reads their capability cards
// + a goal, emits a workflow DAG, a human confirms it, then the ordinary engine
// executes it. Human members / leader / the three switches / maxRounds do not
// apply to this mode (mode-conditional, same shape as free_collab's switch
// overrides). The generate→confirm→execute engine lands in RFC-167 PR-2.
export const WORKGROUP_MODES = ['leader_worker', 'free_collab', 'dynamic_workflow'] as const
export const WorkgroupModeSchema = z.enum(WORKGROUP_MODES)
export type WorkgroupMode = z.infer<typeof WorkgroupModeSchema>

export const WORKGROUP_MEMBER_TYPES = ['agent', 'human'] as const
export const WorkgroupMemberTypeSchema = z.enum(WORKGROUP_MEMBER_TYPES)
export type WorkgroupMemberType = z.infer<typeof WorkgroupMemberTypeSchema>

/** Group-unique member display name — roster / @-mention / dispatch token. */
export const WorkgroupMemberDisplayNameSchema = z
  .string()
  .trim()
  .min(1, 'displayName is required')
  .max(64, 'displayName too long')
  // '@' and whitespace would break mention parsing; commas break roster lists.
  .refine((s) => !/[@,\s]/.test(s), 'displayName must not contain @, comma or whitespace')

/** Member row as stored / returned by the API. */
export const WorkgroupMemberSchema = z.object({
  id: z.string(),
  memberType: WorkgroupMemberTypeSchema,
  /** memberType='agent': agents.name (soft reference, launch-validated). Kept
   *  for display / back-compat; `agentId` is the canonical launch reference. */
  agentName: z.string().nullable(),
  /**
   * RFC-223 (PR-2) — memberType='agent': the CANONICAL agent `id` (ULID),
   * resolved from `agentName` at save time (server-side, name↔id 1:1). Launch
   * readiness validates the roster by id so a rename never re-routes a member
   * and a delete+recreate-same-name cannot silently bind a replacement agent.
   * Nullable: a member authored for an agent that does not (yet) exist, or a
   * legacy row before migration 0112, carries null and is caught by the launch
   * readiness check. `display_name` (group addressing) is unaffected. OPTIONAL
   * on the DTO (like the other RFC-223 id fields) so pre-existing fixtures that
   * omit it still compile; `rowToWorkgroup` always populates it (string|null),
   * and launch readiness treats a missing/null id as an unresolved member.
   */
  agentId: z.string().nullable().optional(),
  /** memberType='human': users.id — audit/UI only, never injected into prompts. */
  userId: z.string().nullable(),
  displayName: WorkgroupMemberDisplayNameSchema,
  /** Group-internal role description shown in the roster (选人依据). */
  roleDesc: z.string(),
  sortOrder: z.number().int(),
})
export type WorkgroupMember = z.infer<typeof WorkgroupMemberSchema>

/** Member input for create / full-replace update (ids are server-generated). */
export const WorkgroupMemberInputSchema = z
  .object({
    memberType: WorkgroupMemberTypeSchema,
    agentName: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    displayName: WorkgroupMemberDisplayNameSchema,
    roleDesc: z.string().max(2048).default(''),
  })
  .superRefine((m, ctx) => {
    if (m.memberType === 'agent') {
      if (!m.agentName) {
        ctx.addIssue({ code: 'custom', message: 'agent member requires agentName' })
      }
      if (m.userId) {
        ctx.addIssue({ code: 'custom', message: 'agent member must not carry userId' })
      }
    } else {
      if (!m.userId) {
        ctx.addIssue({ code: 'custom', message: 'human member requires userId' })
      }
      if (m.agentName) {
        ctx.addIssue({ code: 'custom', message: 'human member must not carry agentName' })
      }
    }
  })
export type WorkgroupMemberInput = z.infer<typeof WorkgroupMemberInputSchema>

/** The three visibility switches (design §6.2). free_collab reads as all-on. */
export const WorkgroupSwitchesSchema = z.object({
  /** Inject peers' finished-assignment result summaries. */
  shareOutputs: z.boolean(),
  /** Members may @ each other; @-mentions are injected and can wake the target. */
  directMessages: z.boolean(),
  /** Inject the public room stream (budget-clipped tail). */
  blackboard: z.boolean(),
})
export type WorkgroupSwitches = z.infer<typeof WorkgroupSwitchesSchema>

export const WORKGROUP_MAX_ROUNDS_DEFAULT = 1000
export const WORKGROUP_MAX_ROUNDS_LIMIT = 1000

/** Workgroup resource as stored / returned by the API. */
export const WorkgroupSchema = z.object({
  id: z.string(),
  name: WorkgroupNameSchema,
  description: z.string(),
  /** Group charter — injected for EVERY member each turn (决策 #18). */
  instructions: z.string(),
  mode: WorkgroupModeSchema,
  /** Required (non-null) when mode='leader_worker'; must be an agent member. */
  leaderMemberId: z.string().nullable(),
  switches: WorkgroupSwitchesSchema,
  maxRounds: z.number().int().positive(),
  /** Completion gate: leader-done parks the task for human confirmation. */
  completionGate: z.boolean(),
  /**
   * RFC-207「反问预算」— how many times ONE asker (the leader, one assignment,
   * or one member's message turns) may ask the humans before the ask-back is
   * suppressed and it is told to decide for itself. Guards against endless
   * ask-back ping-pong once the roster does contain a human. Absent ⇒ 3
   * (resolveClarifyBudget is the ONLY fallback site — never bare `?? 3`).
   */
  clarifyBudget: z.number().int().min(0).max(50).optional(),
  /**
   * RFC-185 D4 — opt-in leader fan-out: when true the leader protocol invites
   * same-member MULTIPLE wg_assignments entries (each = a concurrent instance).
   * OFF (default) keeps the original one-entity-per-agent protocol untouched —
   * fan-out is a NEW capability, never a behavior change to existing groups.
   * Absent ⇒ OFF; consumers coalesce `?? false`.
   */
  fanOut: z.boolean().optional(),
  members: z.array(WorkgroupMemberSchema),
  /** RFC-099 ACL — owner (users.id or '__system__'); null until first owner write. */
  ownerUserId: z.string().nullable().optional(),
  /** RFC-099 ACL — 'public' = every user; 'private' = owner + grants. Absent ⇒ 'public'. */
  visibility: ResourceVisibilitySchema.optional(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Workgroup = z.infer<typeof WorkgroupSchema>

const workgroupConfigFields = {
  description: z.string().max(4096).default(''),
  instructions: z.string().max(65536).default(''),
  mode: WorkgroupModeSchema.default('leader_worker'),
  /** displayName of the leader member (server resolves to leaderMemberId). */
  leaderDisplayName: WorkgroupMemberDisplayNameSchema.optional(),
  switches: WorkgroupSwitchesSchema.default({
    shareOutputs: true,
    directMessages: false,
    blackboard: false,
  }),
  maxRounds: z
    .number()
    .int()
    .positive()
    .max(WORKGROUP_MAX_ROUNDS_LIMIT)
    .default(WORKGROUP_MAX_ROUNDS_DEFAULT),
  // Default ON (2026-07-13 用户拍板): a new group's tasks park for human
  // confirmation when the leader declares done, instead of auto-finishing.
  completionGate: z.boolean().default(true),
  // RFC-207「反问预算」— per-asker ask-back cap; see WorkgroupSchema above.
  // Optional (not .default) BY DESIGN (same rationale RFC-181 design-gate P1
  // established for the deleted `autonomous`): this field object is shared by
  // Create AND full-replace Update, so a schema default would let an omitting
  // PUT silently rewrite an existing group. Handler defaults instead: create
  // coalesces `?? WG_CLARIFY_BUDGET_DEFAULT`, update `?? existing`.
  clarifyBudget: z.number().int().min(0).max(50).optional(),
  // RFC-185 D4 — opt-in leader fan-out. Same optional-not-default rationale as
  // autonomous above; handler defaults: create `?? false` (fan-out must never
  // change the original fixed mode unless explicitly enabled), update
  // `?? existing` (omitted ⇒ preserve).
  fanOut: z.boolean().optional(),
  /**
   * 快速创建（用户 2026-07-10 拍板 #21）：members MAY be empty at save time —
   * groups are created light and members are managed card-by-card on the
   * detail page. Launch-readiness (≥1 agent member; lw needs a designated
   * leader) is enforced at LAUNCH time via workgroupLaunchReadiness, not here.
   */
  members: z.array(WorkgroupMemberInputSchema).max(64).default([]),
}

function validateGroupShape(
  g: {
    mode: WorkgroupMode
    leaderDisplayName?: string | undefined
    members: WorkgroupMemberInput[]
  },
  ctx: z.RefinementCtx,
): void {
  const names = g.members.map((m) => m.displayName)
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: 'custom', message: 'member displayName must be unique within the group' })
  }
  // RFC-167: a dynamic_workflow group's members are the orchestratable AGENT
  // pool — human members have no place in the generate→confirm→execute model
  // (no chatroom, no turns). Reject them at save time (a clear modeling error,
  // not a lenient launch-time gate); an empty pool is still SAVE-valid (quick
  // create) and only rejected at launch via workgroupLaunchReadiness.
  if (g.mode === 'dynamic_workflow' && g.members.some((m) => m.memberType === 'human')) {
    ctx.addIssue({
      code: 'custom',
      message: 'dynamic_workflow groups may only have agent members (the orchestratable pool)',
    })
  }
  // A designated leader (when provided) must resolve to an agent member.
  // Leaderless leader_worker groups are SAVE-valid (quick create) and only
  // rejected at launch (workgroupLaunchReadiness).
  if (g.leaderDisplayName !== undefined) {
    const leader = g.members.find((m) => m.displayName === g.leaderDisplayName)
    if (leader === undefined) {
      ctx.addIssue({ code: 'custom', message: 'leaderDisplayName does not match any member' })
    } else if (leader.memberType !== 'agent') {
      ctx.addIssue({ code: 'custom', message: 'leader must be an agent member' })
    }
  }
}

/** POST /api/workgroups body. */
export const CreateWorkgroupSchema = z
  .object({ name: WorkgroupNameSchema, ...workgroupConfigFields })
  .superRefine(validateGroupShape)
export type CreateWorkgroup = z.infer<typeof CreateWorkgroupSchema>

/**
 * PUT /api/workgroups/:name body — full document replace (members full-replace,
 * ids regenerated; launched tasks are unaffected — they snapshot the config at
 * launch time). Name changes go through /rename.
 */
export const UpdateWorkgroupSchema = z.object(workgroupConfigFields).superRefine(validateGroupShape)
export type UpdateWorkgroup = z.infer<typeof UpdateWorkgroupSchema>

/**
 * POST /api/workgroups/:name/rename body. Name + description are the group's
 * "metadata" fields; the detail-page rename dialog edits both and saves them
 * ATOMICALLY here (2026-07-13, 用户拍板「后端原子端点」). `description` is
 * optional — a pure rename omits it and the stored description is untouched;
 * a description-only edit sends the current name as `newName` (a no-op rename)
 * plus the new `description`. Description therefore no longer travels on the
 * config PUT (buildConfigUpdatePayload passes the server's value through).
 */
export const RenameWorkgroupSchema = z.object({
  newName: WorkgroupNameSchema,
  description: z.string().max(4096).optional(),
})
export type RenameWorkgroup = z.infer<typeof RenameWorkgroupSchema>

/**
 * Launch-readiness oracle (决策 #21 — save is lenient, launch is strict).
 * The launch gate (PR-3) and the detail-page banner both consume this.
 *
 * RFC-187 TRAP-1 (AC-6): `warnings` is the ADVISORY tier — structurally
 * suspect rosters that still launch (the user may mean it), surfaced by the
 * same single oracle everywhere a readiness read happens. Per the design-gate
 * correction (§8 P1-5尾) only structurally checkable codes exist: the agent
 * `readonly` field is gone (RFC-130), so a "no-producer" heuristic has no
 * data source and was dropped.
 */
export interface WorkgroupLaunchReadiness {
  ready: boolean
  reasons: Array<'no-agent-member' | 'leader-missing'>
  /**
   * Advisory (never blocks launch): `no-non-leader-worker` — a leader_worker
   * roster whose ONLY member is the leader itself; there is nobody (agent or
   * human) to dispatch to, so the leader can only spin idle / declare done
   * with zero delegated work (workgroup-e2e-audit TRAP-1: such a group used
   * to sail through readiness and die as an opaque protocol failure).
   */
  warnings: Array<'no-non-leader-worker'>
}

export function workgroupLaunchReadiness(group: {
  mode: WorkgroupMode
  leaderMemberId: string | null
  members: ReadonlyArray<{ id: string; memberType: WorkgroupMemberType }>
}): WorkgroupLaunchReadiness {
  const reasons: WorkgroupLaunchReadiness['reasons'] = []
  const warnings: WorkgroupLaunchReadiness['warnings'] = []
  const agentMembers = group.members.filter((m) => m.memberType === 'agent')
  if (agentMembers.length === 0) reasons.push('no-agent-member')
  if (group.mode === 'leader_worker') {
    const leaderOk =
      group.leaderMemberId !== null && agentMembers.some((m) => m.id === group.leaderMemberId)
    if (!leaderOk) reasons.push('leader-missing')
    // Only meaningful once a leader resolves — a leaderless roster already
    // carries the blocking `leader-missing` and needs no second banner line.
    if (leaderOk && group.members.every((m) => m.id === group.leaderMemberId)) {
      warnings.push('no-non-leader-worker')
    }
  }
  return { ready: reasons.length === 0, reasons, warnings }
}

/**
 * Effective switch view (design §1.1): free_collab collaborates through the
 * shared list + room, so all three switches read as ON regardless of storage.
 */
export function resolveWorkgroupSwitches(
  mode: WorkgroupMode,
  stored: WorkgroupSwitches,
): WorkgroupSwitches {
  if (mode === 'free_collab') {
    return { shareOutputs: true, directMessages: true, blackboard: true }
  }
  return stored
}

/**
 * RFC-207 §1.1 — THE single predicate for "does this group involve humans?".
 *
 * Whether a group wants a human in the loop is expressed exactly once, by the
 * roster: putting a `memberType: 'human'` member in it. The RFC-180/181
 * `autonomous` switch was a second source for the same intent and is deleted —
 * two sources could disagree, and both disagreeing combinations were bugs
 * (no human yet still asking = the original complaint; human present yet hard
 * suppressed = the roster edit being overruled by a switch).
 *
 * Only roster members count: a task's `collaboratorUserIds` is a permission
 * list, invisible to agents and unaddressable in prompts (RFC-207 D5).
 */
export function workgroupHasHumanMember(
  members: ReadonlyArray<{ memberType: WorkgroupMemberType }>,
): boolean {
  return members.some((m) => m.memberType === 'human')
}

/**
 * RFC-207 §1.2 — effective completion-gate view. No human member ⇒ nobody to
 * confirm ⇒ the gate is off and a leader-declared done finishes directly;
 * otherwise the group's stored value stands.
 * Single source — the engine reads this, never `config.completionGate` raw.
 *
 * The first parameter is deliberately the MEMBER LIST rather than a boolean:
 * the predicate it replaced (`autonomous`) sat in the same position with the
 * exact OPPOSITE truth value, so a boolean signature would let a missed call
 * site typecheck while inverting behaviour (RFC-207 R1).
 */
export function resolveCompletionGate(
  members: ReadonlyArray<{ memberType: WorkgroupMemberType }>,
  storedGate: boolean,
): boolean {
  return workgroupHasHumanMember(members) ? storedGate : false
}

/**
 * RFC-207 §3.6.5 — the ONLY fallback site for a missing `clarifyBudget`.
 * Frozen task snapshots taken before RFC-207 carry no such field, and the two
 * gates that consume it (dispatch-time invite, envelope-time accept) MUST agree
 * — a bare `?? 3` at each read site is how they drift apart.
 */
export const WG_CLARIFY_BUDGET_DEFAULT = 3
export function resolveClarifyBudget(config: { clarifyBudget?: number | undefined }): number {
  return config.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT
}

/**
 * RFC-207 §3.6.3 — the stable identity of an ask-back "asker". Both the budget
 * counter and the per-asker stop directive key on this.
 *
 * A raw shard key cannot serve: a member's MESSAGE turn is sharded by
 * `msg:<memberId>:<messageId>`, so every fresh message would mint a new asker,
 * resetting the budget and orphaning any stop — a bypass through which ask-back
 * could run forever (RFC-207 R12). Message turns therefore collapse to the
 * member.
 */
export function wgClarifyAskerKey(
  nodeId: string,
  shardKey: string | null,
  leaderNodeId: string,
): string {
  if (nodeId === leaderNodeId) return 'leader'
  if (shardKey === null) return 'leader'
  {
    const msg = parseMsgShardKey(shardKey)
    if (msg !== null) return `mem:${msg.memberId}`
  }
  // RFC-215 §6.3 — fc 任务批 run 折叠到成员：批 shardKey 编卡集合，卡回 open 重组
  // 批次会换 key，若直用则预算清零 + stop 指令成孤儿（同上 R12 的旁路在任务轨重开）。
  // 单源 parseBatchShardKey（design §9 六消费点承诺），不再手工 split(':')。
  const batch = parseBatchShardKey(shardKey)
  if (batch !== null) return `asg:batch:${batch.memberId}`
  return `asg:${shardKey}`
}

/** RFC-207 §3.3 — consecutive no-progress leader-idle nudges before parking. */
export const WG_LEADER_IDLE_NUDGE_LIMIT = 3

// ---------------------------------------------------------------------------
// Launch body (POST /api/workgroups/:name/tasks, design §3)
// ---------------------------------------------------------------------------

/**
 * Workgroup launch body — repo/collaborator/limit fields mirror StartTask.
 * Deliberately SHAPE-lenient: the service composes a full StartTask candidate
 * (workflowId = builtin host, inputs = {}) and runs StartTaskSchema on it, so
 * the repo-source cross-field rules stay single-sourced in schemas/task.ts.
 */
export const StartWorkgroupTaskSchema = z.object({
  name: z.string().trim().min(1).max(255),
  /** The group's mission statement — injected every turn (决策 #12 goal). */
  goal: z.string().trim().min(1).max(65536),
  /** RFC-165: temporary-space launch (see StartTaskSchema.scratch). */
  scratch: z.boolean().optional(),
  repoUrl: z.string().min(1).optional(),
  /** RFC-204: reuse a cached mirror by id (XOR `repoUrl`; enforced by StartTaskSchema downstream). */
  cachedRepoId: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  repos: z.array(z.unknown()).min(1).max(16).optional(),
  collaboratorUserIds: z.array(z.string().min(1)).max(64).optional(),
  gitUserName: z.string().max(255).optional(),
  gitUserEmail: z.string().max(255).optional(),
  workingBranch: z.string().optional(),
  autoCommitPush: z.boolean().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
  /**
   * RFC-175 (§2b): immediate-submit-only OCC guard for relaunch. When present,
   * `startWorkgroupTask` rejects (409 `workgroup-id-mismatch`, after the ACL-404
   * gate) if the resolved workgroup's stable id differs — closing the seed→submit
   * delete+recreate-same-name TOCTOU. NEVER persisted into a scheduled task
   * (§2d overlay-only; scheduled payload schema rejects it).
   */
  expectedWorkgroupId: z.string().optional(),
})
export type StartWorkgroupTask = z.infer<typeof StartWorkgroupTaskSchema>
