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

/** Permitted characters in workgroup name (URL-safe; matches `/api/workgroups/:name`). */
export const WORKGROUP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const WorkgroupNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(128, 'name too long')
  .regex(WORKGROUP_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

export const WORKGROUP_MODES = ['leader_worker', 'free_collab'] as const
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
  /** memberType='agent': agents.name (soft reference, launch-validated). */
  agentName: z.string().nullable(),
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

export const WORKGROUP_MAX_ROUNDS_DEFAULT = 20
export const WORKGROUP_MAX_ROUNDS_LIMIT = 500

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
  completionGate: z.boolean().default(false),
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

/** POST /api/workgroups/:name/rename body. */
export const RenameWorkgroupSchema = z.object({
  newName: WorkgroupNameSchema,
})
export type RenameWorkgroup = z.infer<typeof RenameWorkgroupSchema>

/**
 * Launch-readiness oracle (决策 #21 — save is lenient, launch is strict).
 * The launch gate (PR-3) and the detail-page banner both consume this.
 */
export interface WorkgroupLaunchReadiness {
  ready: boolean
  reasons: Array<'no-agent-member' | 'leader-missing'>
}

export function workgroupLaunchReadiness(group: {
  mode: WorkgroupMode
  leaderMemberId: string | null
  members: ReadonlyArray<{ id: string; memberType: WorkgroupMemberType }>
}): WorkgroupLaunchReadiness {
  const reasons: WorkgroupLaunchReadiness['reasons'] = []
  const agentMembers = group.members.filter((m) => m.memberType === 'agent')
  if (agentMembers.length === 0) reasons.push('no-agent-member')
  if (group.mode === 'leader_worker') {
    const leaderOk =
      group.leaderMemberId !== null && agentMembers.some((m) => m.id === group.leaderMemberId)
    if (!leaderOk) reasons.push('leader-missing')
  }
  return { ready: reasons.length === 0, reasons }
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
  ref: z.string().min(1).optional(),
  repos: z.array(z.unknown()).min(1).max(16).optional(),
  collaboratorUserIds: z.array(z.string().min(1)).max(64).optional(),
  gitUserName: z.string().max(255).optional(),
  gitUserEmail: z.string().max(255).optional(),
  workingBranch: z.string().optional(),
  autoCommitPush: z.boolean().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
})
export type StartWorkgroupTask = z.infer<typeof StartWorkgroupTaskSchema>
