// RFC-164 PR-1 — pure helpers for the /workgroups pages. Mirrors lib/mcp-form:
// parse/validate/assemble logic lives outside the React tree so the validation
// matrix and the member-card operations are unit-testable without rendering.
//
// 决策 #21 (save-lenient / launch-strict): members may be EMPTY and a
// leader_worker group may be saved WITHOUT a leader — the shared
// `workgroupLaunchReadiness` oracle gates launching, and the detail page
// renders its reasons as a banner. The only save-blocking rules left on the
// frontend are the member token rules (displayName non-empty / unique / no
// @-comma-whitespace, human rows need a picked user, agent rows an agentName).
//
// Error values are raw i18n keys (`workgroups.errors.*`) — widgets translate
// at render time (same contract as PluginFields).

import type {
  UpdateWorkgroup,
  UserPublic,
  Workgroup,
  WorkgroupMemberInput,
  WorkgroupMemberType,
  WorkgroupMode,
  WorkgroupSwitches,
} from '@agent-workflow/shared'
import {
  CreateWorkgroupSchema,
  UpdateWorkgroupSchema,
  WORKGROUP_MAX_ROUNDS_DEFAULT,
  WORKGROUP_MAX_ROUNDS_LIMIT,
  WORKGROUP_NAME_RE,
} from '@agent-workflow/shared'

/** Characters a member displayName must not contain (mirrors the shared
 *  WorkgroupMemberDisplayNameSchema refine: @ breaks mentions, commas break
 *  roster lists, whitespace breaks both). */
const DISPLAY_NAME_FORBIDDEN_RE = /[@,\s]/

export type BuiltWorkgroup<P> =
  | { ok: true; payload: P }
  | { ok: false; errors: Record<string, string> }

// ---------------------------------------------------------------------------
// Quick create (list-page dialog) — POST {name, description} only; the
// backend defaults everything else (mode=leader_worker, members=[]).
// ---------------------------------------------------------------------------

export interface QuickCreateWorkgroupBody {
  name: string
  description: string
}

export function buildQuickCreatePayload(
  input: QuickCreateWorkgroupBody,
): BuiltWorkgroup<QuickCreateWorkgroupBody> {
  const errors: Record<string, string> = {}
  if (input.name.length === 0) errors.name = 'workgroups.errors.nameRequired'
  else if (input.name.length > 128 || !WORKGROUP_NAME_RE.test(input.name)) {
    errors.name = 'workgroups.errors.nameInvalid'
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  // Wire-shape net: the same schema the server parses (defaults fill in).
  const parsed = CreateWorkgroupSchema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: schemaIssues(parsed.error.issues) }
  return { ok: true, payload: { name: input.name, description: input.description } }
}

// ---------------------------------------------------------------------------
// Config draft (detail-page edit surface). Members are NOT part of the draft
// — they are managed card-by-card with immediate PUTs; a config save passes
// the group's current members through unchanged (PUT is full-replace).
// ---------------------------------------------------------------------------

export interface WorkgroupConfigDraft {
  // NOTE: `description` is NOT part of the config draft. Since 2026-07-13 it is
  // metadata edited in the rename dialog (POST /rename, atomic with the name),
  // so the config PUT passes the SERVER's current description through unchanged
  // (buildConfigUpdatePayload) — exactly like it passes members through. This
  // is what keeps a config save from reverting a dialog description edit.
  instructions: string
  mode: WorkgroupMode
  /** Stored switch values. free_collab renders them as forced-on but never
   *  mutates them, so flipping back to leader_worker restores the choices
   *  (mirrors shared resolveWorkgroupSwitches: fc reads all-on regardless of
   *  storage). */
  switches: WorkgroupSwitches
  /** undefined = field cleared → default (WORKGROUP_MAX_ROUNDS_DEFAULT = 1000). */
  maxRounds: number | undefined
  completionGate: boolean
}

export function workgroupToConfigDraft(w: Workgroup): WorkgroupConfigDraft {
  return {
    instructions: w.instructions,
    mode: w.mode,
    switches: { ...w.switches },
    maxRounds: w.maxRounds,
    completionGate: w.completionGate,
  }
}

export function buildConfigUpdatePayload(
  draft: WorkgroupConfigDraft,
  group: Workgroup,
): BuiltWorkgroup<UpdateWorkgroup> {
  const errors: Record<string, string> = {}
  if (draft.maxRounds !== undefined && !isValidMaxRounds(draft.maxRounds)) {
    errors.maxRounds = 'workgroups.errors.maxRoundsInvalid'
  }
  // RFC-168 F3 — mode-transition error must be VISIBLE: switching the draft
  // to dynamic_workflow while the group still has human members would only
  // fail in the schema net below (an unexplained disabled Save). Surface it
  // as a stable `mode` key the form renders under the mode control.
  if (draft.mode === 'dynamic_workflow' && group.members.some((m) => m.memberType === 'human')) {
    errors.mode = 'workgroups.errors.dynamicNoHumanMembers'
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const leader = storedLeaderDisplayName(group)
  const payload = {
    // Pass the server's current description through unchanged — it is owned by
    // the rename dialog now (POST /rename), never edited on this config form.
    description: group.description,
    instructions: draft.instructions,
    mode: draft.mode,
    // Backend nulls the leader outside leader_worker regardless; only carry
    // it when it still means something (leaderless lw is save-valid).
    ...(draft.mode === 'leader_worker' && leader !== null ? { leaderDisplayName: leader } : {}),
    switches: { ...draft.switches },
    maxRounds: draft.maxRounds ?? WORKGROUP_MAX_ROUNDS_DEFAULT,
    completionGate: draft.completionGate,
    members: membersToInputs(group.members),
  }
  const parsed = UpdateWorkgroupSchema.safeParse(payload)
  if (!parsed.success) return { ok: false, errors: schemaIssues(parsed.error.issues) }
  return { ok: true, payload: parsed.data }
}

// ---------------------------------------------------------------------------
// Member-card domain. Every card operation is read-current → pure change →
// PUT full document. `leaderKey` anchors to the row key (= server member id
// for stored rows, a local key for not-yet-saved rows) so renames never move
// the leader flag.
// ---------------------------------------------------------------------------

export interface WorkgroupMemberRowState {
  key: string
  memberType: WorkgroupMemberType
  /** memberType='agent' — may reference a not-yet-existing agent (dangling
   *  references are legal; launch-time validation owns existence). */
  agentName: string
  /** memberType='human' — users.id of the picked platform user. */
  userId: string
  displayName: string
  roleDesc: string
}

export interface WorkgroupMembersState {
  members: WorkgroupMemberRowState[]
  leaderKey: string | null
}

let rowSeq = 0
/** Monotonic local row key — unique within the session, never on the wire. */
export function nextMemberRowKey(): string {
  rowSeq += 1
  return `row-${rowSeq}`
}

export function makeAgentMemberRow(input: {
  agentName: string
  displayName: string
  roleDesc?: string
}): WorkgroupMemberRowState {
  return {
    key: nextMemberRowKey(),
    memberType: 'agent',
    agentName: input.agentName,
    userId: '',
    displayName: input.displayName,
    roleDesc: input.roleDesc ?? '',
  }
}

export function makeHumanMemberRow(input: {
  userId: string
  displayName: string
  roleDesc?: string
}): WorkgroupMemberRowState {
  return {
    key: nextMemberRowKey(),
    memberType: 'human',
    agentName: '',
    userId: input.userId,
    displayName: input.displayName,
    roleDesc: input.roleDesc ?? '',
  }
}

/** Stored group → card-ops working state (rows keyed by server member id). */
export function workgroupToMembersState(w: Workgroup): WorkgroupMembersState {
  const members = [...w.members]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map<WorkgroupMemberRowState>((m) => ({
      key: m.id,
      memberType: m.memberType,
      agentName: m.agentName ?? '',
      userId: m.userId ?? '',
      displayName: m.displayName,
      roleDesc: m.roleDesc,
    }))
  return { members, leaderKey: w.leaderMemberId }
}

export function addMember(
  state: WorkgroupMembersState,
  row: WorkgroupMemberRowState,
): WorkgroupMembersState {
  return { members: [...state.members, row], leaderKey: state.leaderKey }
}

/** Removing the leader clears the flag (leaderless lw is save-valid). */
export function removeMember(state: WorkgroupMembersState, key: string): WorkgroupMembersState {
  return {
    members: state.members.filter((m) => m.key !== key),
    leaderKey: state.leaderKey === key ? null : state.leaderKey,
  }
}

/** Card edit dialog only touches the alias + role description. */
export function patchMember(
  state: WorkgroupMembersState,
  key: string,
  patch: Partial<Pick<WorkgroupMemberRowState, 'displayName' | 'roleDesc'>>,
): WorkgroupMembersState {
  return {
    members: state.members.map((m) => (m.key === key ? { ...m, ...patch } : m)),
    leaderKey: state.leaderKey,
  }
}

/** Only agent rows may lead (shared schema rule) — a non-agent / unknown key
 *  is a no-op. `null` unsets the leader. */
export function setLeader(state: WorkgroupMembersState, key: string | null): WorkgroupMembersState {
  if (key === null) return { members: state.members, leaderKey: null }
  const row = state.members.find((m) => m.key === key)
  if (row === undefined || row.memberType !== 'agent') return state
  return { members: state.members, leaderKey: key }
}

/**
 * Per-member validation used by the add/edit dialogs. `others` = the group's
 * remaining members (excluding the edited one) for the uniqueness check.
 * Keys: agentName / userId / displayName.
 */
export function validateMemberDraft(
  draft: Pick<WorkgroupMemberRowState, 'memberType' | 'agentName' | 'userId' | 'displayName'>,
  others: ReadonlyArray<Pick<WorkgroupMemberRowState, 'displayName'>>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (draft.memberType === 'agent') {
    if (draft.agentName.trim().length === 0) {
      errors.agentName = 'workgroups.errors.agentNameRequired'
    }
  } else if (draft.userId.length === 0) {
    errors.userId = 'workgroups.errors.userRequired'
  }
  const dn = draft.displayName.trim()
  if (dn.length === 0) errors.displayName = 'workgroups.errors.displayNameRequired'
  else if (DISPLAY_NAME_FORBIDDEN_RE.test(dn)) {
    errors.displayName = 'workgroups.errors.displayNameInvalid'
  } else if (dn.length > 64) errors.displayName = 'workgroups.errors.displayNameTooLong'
  else if (others.some((m) => m.displayName.trim() === dn)) {
    errors.displayName = 'workgroups.errors.displayNameDuplicate'
  }
  return errors
}

/**
 * Assemble the full-replace PUT body for a member-card operation: config
 * fields pass through from the stored group, members + leader come from the
 * changed state. Re-runs the per-row rules as a net (dialogs pre-validate).
 */
export function buildMembersUpdatePayload(
  group: Workgroup,
  state: WorkgroupMembersState,
): BuiltWorkgroup<UpdateWorkgroup> {
  const errors: Record<string, string> = {}
  state.members.forEach((m, i) => {
    const rowErrors = validateMemberDraft(
      m,
      state.members.filter((o) => o.key !== m.key),
    )
    for (const [field, key] of Object.entries(rowErrors)) {
      errors[`member-${i}-${field}`] ??= key
    }
  })
  const leaderRow =
    state.leaderKey === null ? undefined : state.members.find((m) => m.key === state.leaderKey)
  if (state.leaderKey !== null && (leaderRow === undefined || leaderRow.memberType !== 'agent')) {
    errors.leader = 'workgroups.errors.leaderMustBeAgent'
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const payload = {
    description: group.description,
    instructions: group.instructions,
    mode: group.mode,
    ...(group.mode === 'leader_worker' && leaderRow !== undefined
      ? { leaderDisplayName: leaderRow.displayName.trim() }
      : {}),
    switches: { ...group.switches },
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    members: state.members.map(rowToInput),
  }
  const parsed = UpdateWorkgroupSchema.safeParse(payload)
  if (!parsed.success) return { ok: false, errors: schemaIssues(parsed.error.issues) }
  return { ok: true, payload: parsed.data }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Strip mention-breaking characters from a candidate alias. */
export function sanitizeMemberAlias(raw: string): string {
  return raw.replace(/[@,\s]+/g, '').slice(0, 64)
}

/** Default member alias when a human row picks a platform user: the user's
 *  display name with mention-breaking characters stripped, falling back to
 *  the username (whose charset is always a legal alias token). */
export function deriveMemberAlias(user: Pick<UserPublic, 'displayName' | 'username'>): string {
  const cleaned = sanitizeMemberAlias(user.displayName)
  return cleaned.length > 0 ? cleaned : user.username
}

/** Leader member's displayName for list rendering; null for free_collab /
 *  unset (callers render an em dash). */
export function workgroupLeaderDisplayName(w: Workgroup): string | null {
  if (w.mode !== 'leader_worker') return null
  return storedLeaderDisplayName(w)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function storedLeaderDisplayName(w: Workgroup): string | null {
  if (w.leaderMemberId === null) return null
  const leader = w.members.find((m) => m.id === w.leaderMemberId && m.memberType === 'agent')
  return leader?.displayName ?? null
}

function isValidMaxRounds(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= WORKGROUP_MAX_ROUNDS_LIMIT
}

function rowToInput(m: WorkgroupMemberRowState): WorkgroupMemberInput {
  return m.memberType === 'agent'
    ? {
        memberType: 'agent',
        agentName: m.agentName.trim(),
        displayName: m.displayName.trim(),
        roleDesc: m.roleDesc,
      }
    : {
        memberType: 'human',
        userId: m.userId,
        displayName: m.displayName.trim(),
        roleDesc: m.roleDesc,
      }
}

function membersToInputs(members: Workgroup['members']): WorkgroupMemberInput[] {
  return [...members]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((m) =>
      m.memberType === 'agent'
        ? {
            memberType: 'agent' as const,
            agentName: m.agentName ?? '',
            displayName: m.displayName,
            roleDesc: m.roleDesc,
          }
        : {
            memberType: 'human' as const,
            userId: m.userId ?? '',
            displayName: m.displayName,
            roleDesc: m.roleDesc,
          },
    )
}

/** Map schema-fallback issues to the same error record shape. Pre-validation
 *  covers every UI-reachable case; this net only catches wire-shape drift. */
function schemaIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of issues) {
    const path = issue.path.join('.')
    out[path === '' ? '_' : path] = out[path === '' ? '_' : path] ?? issue.message
  }
  return out
}
