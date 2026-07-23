// RFC-165 (T13) — pure helpers for the /tasks/new wizard.
//
// Three explicit body builders (one per execution kind), the shared space
// stamping they delegate to, the scheduled-task payload envelope, and the
// inverse mapping (stored schedule payload → wizard seed) for
// `?editScheduled=`. Everything here is pure so the wire shapes are
// field-by-field unit-testable without the route harness (RFC-125 lesson:
// whitelist builders silently drop what they don't stamp — tests assert every
// field explicitly).

import {
  taskExecutionKind,
  type ScheduledLaunchKind,
  type Task,
  type WorkflowInput,
} from '@agent-workflow/shared'
import {
  bodyToRepoSources,
  buildLaunchBody,
  buildLaunchBodyMultiRepo,
  defaultRepoSource,
  type LaunchCommonPayload,
  type RepoSource,
} from './launch-repo-source'

/** The wizard's Step-1 execution-kind choice (mirrors ScheduledLaunchKind). */
export type WizardKind = ScheduledLaunchKind

/**
 * Step-2 execution space. `remote` carries 1..N URL repo rows; `scratch` is
 * the RFC-165 temporary space (backend `git init`s an empty repo — no repo
 * fields on the wire, `scratch: true` instead).
 */
export type WizardSpace = { kind: 'scratch' } | { kind: 'remote'; repos: RepoSource[] }

export function defaultWizardSpace(kind: 'remote' | 'scratch' = 'remote'): WizardSpace {
  return kind === 'scratch' ? { kind: 'scratch' } : { kind: 'remote', repos: [defaultRepoSource()] }
}

/** Optional fields shared by all three kinds' advanced fold. */
export interface WizardAdvancedFields {
  collaboratorUserIds?: string[]
  /** Pair-gated (both or neither) — callers trim before passing. */
  gitUserName?: string
  gitUserEmail?: string
  /** Remote-space only; the builder strips them under scratch (schema rejects). */
  workingBranch?: string
  autoCommitPush?: boolean
  maxDurationMs?: number
  maxTotalTokens?: number
}

/**
 * Stamp the space fields onto a body composed by the shared repo-source
 * builders. Scratch strips `workingBranch` / `autoCommitPush` BEFORE
 * delegating — StartTaskSchema rejects them with `scratch: true`, and the
 * wizard's Step-3 fold hides the fields but their state may linger from a
 * remote round-trip.
 */
function buildSpaceBody(space: WizardSpace, common: LaunchCommonPayload): Record<string, unknown> {
  if (space.kind === 'remote') {
    return space.repos.length > 1
      ? buildLaunchBodyMultiRepo(space.repos, common)
      : buildLaunchBody(space.repos[0] ?? defaultRepoSource(), common)
  }
  const { workingBranch: _wb, autoCommitPush: _acp, ...rest } = common
  const body = buildLaunchBody(defaultRepoSource(), rest)
  delete body.repoUrl
  body.scratch = true
  return body
}

function stampLimits(out: Record<string, unknown>, common: WizardAdvancedFields): void {
  if (common.maxDurationMs !== undefined) out.maxDurationMs = common.maxDurationMs
  if (common.maxTotalTokens !== undefined) out.maxTotalTokens = common.maxTotalTokens
}

/** Common fields for the workflow arm (superset of the shared launch payload). */
export type WorkflowWizardCommon = LaunchCommonPayload & WizardAdvancedFields

/** Compose the JSON body for `POST /api/tasks` (workflow arm). */
export function buildWorkflowStartBody(
  space: WizardSpace,
  common: WorkflowWizardCommon,
): Record<string, unknown> {
  const body = buildSpaceBody(space, common)
  stampLimits(body, common)
  return body
}

/**
 * Multipart sibling of `buildWorkflowStartBody` for workflows with upload
 * inputs. Upload keys missing from `inputs` are padded with '' so the
 * backend's per-input gate sees every declared key (RFC-020 contract).
 * Multi-repo + uploads is UI-gated before this is reachable.
 */
export function buildWorkflowStartFormData(
  space: WizardSpace,
  common: WorkflowWizardCommon,
  uploads: Record<string, File[]>,
  /**
   * RFC-175 impl-gate F4: immediate-submit OCC guards (e.g. `expectedWorkflowVersion`)
   * merged into the payload JSON AFTER `buildWorkflowStartBody`'s field whitelist —
   * exactly like the JSON POST path spreads `immediateGuards()` after
   * `buildImmediateBody()`. `buildWorkflowStartBody` (buildSpaceBody + stampLimits)
   * drops unknown keys, so a guard spread into `common` would silently vanish; the
   * merge must happen here. Kept OUT of the shared builder so the scheduled-task
   * envelope (which reuses it) never persists a point-in-time guard.
   */
  extra?: Record<string, unknown>,
): FormData {
  const inputsOut: Record<string, string> = { ...common.inputs }
  for (const key of Object.keys(uploads)) {
    if (!(key in inputsOut)) inputsOut[key] = ''
  }
  const body = {
    ...buildWorkflowStartBody(space, { ...common, inputs: inputsOut }),
    ...(extra ?? {}),
  }
  const fd = new FormData()
  fd.set('payload', new Blob([JSON.stringify(body)], { type: 'application/json' }))
  for (const [key, list] of Object.entries(uploads)) {
    for (const f of list) {
      fd.append(`files[${key}][]`, f, f.name)
    }
  }
  return fd
}

export interface AgentWizardCommon extends WizardAdvancedFields {
  name: string
  /**
   * The task prompt for a ZERO-PORT agent (proposal: 描述即提示词). Caller
   * trims. RFC-218: exactly one of `description` / `inputs` is stamped —
   * port-declaring agents launch with `inputs` and MUST NOT carry a
   * description (the service rejects mixed shapes).
   */
  description?: string
  /** RFC-218 — port values for a port-declaring agent, keyed by port name. */
  inputs?: Record<string, string>
  /** RFC-165 D7 — schema default is true, so only `false` goes on the wire. */
  allowClarify: boolean
}

/** Compose the JSON body for `POST /api/agents/:name/tasks` (agent in URL, not body). */
export function buildAgentStartBody(
  space: WizardSpace,
  common: AgentWizardCommon,
): Record<string, unknown> {
  const body = buildSpaceBody(space, {
    // Stripped below — only present so the shared repo-source builders run
    // unchanged (same trick as buildWorkgroupLaunchBody).
    workflowId: '',
    inputs: {},
    name: common.name,
    ...(common.gitUserName !== undefined && common.gitUserEmail !== undefined
      ? { gitUserName: common.gitUserName, gitUserEmail: common.gitUserEmail }
      : {}),
    ...(common.workingBranch !== undefined ? { workingBranch: common.workingBranch } : {}),
    ...(common.autoCommitPush === true ? { autoCommitPush: true } : {}),
    ...(common.collaboratorUserIds !== undefined && common.collaboratorUserIds.length > 0
      ? { collaboratorUserIds: common.collaboratorUserIds }
      : {}),
  })
  delete body.workflowId
  delete body.inputs
  // RFC-218: whitelist-stamp EXACTLY the shape the caller chose. This builder
  // is a drop-what-you-don't-stamp whitelist ([launch-body helper lesson]);
  // forgetting one of these lines silently strips the field off the wire.
  if (common.description !== undefined) body.description = common.description
  if (common.inputs !== undefined) body.inputs = common.inputs
  if (common.allowClarify === false) body.allowClarify = false
  stampLimits(body, common)
  return body
}

/**
 * RFC-218 — multipart sibling of `buildAgentStartBody` for agents whose
 * declared ports include `path<ext>` (upload) kinds. Mirrors
 * `buildWorkflowStartFormData`: guards merge into the payload AFTER the
 * whitelist builder (they'd be silently dropped inside it).
 */
export function buildAgentStartFormData(
  space: WizardSpace,
  common: AgentWizardCommon,
  uploads: Record<string, File[]>,
  extra?: Record<string, unknown>,
): FormData {
  const body = { ...buildAgentStartBody(space, common), ...(extra ?? {}) }
  const fd = new FormData()
  fd.set('payload', new Blob([JSON.stringify(body)], { type: 'application/json' }))
  for (const [key, list] of Object.entries(uploads)) {
    for (const f of list) {
      fd.append(`files[${key}][]`, f, f.name)
    }
  }
  return fd
}

export interface WorkgroupWizardCommon extends WizardAdvancedFields {
  name: string
  /** The group's mission statement — injected every turn. Caller trims. */
  goal: string
}

/** Compose the JSON body for `POST /api/workgroups/:name/tasks` (group in URL, not body). */
export function buildWorkgroupStartBody(
  space: WizardSpace,
  common: WorkgroupWizardCommon,
): Record<string, unknown> {
  const body = buildSpaceBody(space, {
    workflowId: '',
    inputs: {},
    name: common.name,
    ...(common.gitUserName !== undefined && common.gitUserEmail !== undefined
      ? { gitUserName: common.gitUserName, gitUserEmail: common.gitUserEmail }
      : {}),
    ...(common.workingBranch !== undefined ? { workingBranch: common.workingBranch } : {}),
    ...(common.autoCommitPush === true ? { autoCommitPush: true } : {}),
    ...(common.collaboratorUserIds !== undefined && common.collaboratorUserIds.length > 0
      ? { collaboratorUserIds: common.collaboratorUserIds }
      : {}),
  })
  delete body.workflowId
  delete body.inputs
  body.goal = common.goal
  stampLimits(body, common)
  return body
}

/**
 * Wrap an immediate-launch body into the scheduled-task payload envelope for
 * its kind (RFC-165 §9b): the workflow arm already carries `workflowId`; the
 * agent / workgroup arms move the URL path segment into the payload.
 */
export function buildScheduledEnvelope(
  kind: WizardKind,
  body: Record<string, unknown>,
  ref: { agentName?: string; workgroupName?: string },
): Record<string, unknown> {
  // RFC-199 T6.6: scheduled workflows deliberately resolve the latest
  // workflow revision when each occurrence fires. Keep the immediate-launch
  // OCC fence out of durable schedule config even if a caller accidentally
  // hands this helper an already-guarded body.
  const scheduledBody = { ...body }
  delete scheduledBody.expectedWorkflowVersion
  delete scheduledBody.expectedWorkgroupVersion

  if (kind === 'agent') return { agentName: ref.agentName ?? '', ...scheduledBody }
  if (kind === 'workgroup') return { workgroupName: ref.workgroupName ?? '', ...scheduledBody }
  return scheduledBody
}

/**
 * Inverse of the three builders for `?editScheduled=`: reconstruct the
 * wizard's field state from a schedule's stored `launchPayload`. Read
 * defensively (the payload arrives off the wire); a payload missing its
 * kind discriminant returns null → the wizard renders blank for repair.
 */
export interface WizardSeed {
  workflowId?: string
  agentName?: string
  workgroupName?: string
  taskName: string
  space: WizardSpace
  inputs: Record<string, string>
  description: string
  goal: string
  allowClarify: boolean
  collaboratorUserIds: string[]
  gitUserName: string
  gitUserEmail: string
  workingBranch: string
  autoCommitPush: boolean
  maxDurationMs?: number
  maxTotalTokens?: number
}

export function payloadToWizardSeed(
  kind: WizardKind,
  payload: Record<string, unknown>,
): WizardSeed | null {
  const discriminant =
    kind === 'workflow'
      ? payload.workflowId
      : kind === 'agent'
        ? payload.agentName
        : payload.workgroupName
  if (typeof discriminant !== 'string' || discriminant.length === 0) return null
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const seed: WizardSeed = {
    taskName: str(payload.name),
    space:
      payload.scratch === true
        ? { kind: 'scratch' }
        : { kind: 'remote', repos: bodyToRepoSources(payload) },
    inputs:
      typeof payload.inputs === 'object' && payload.inputs !== null
        ? Object.fromEntries(
            Object.entries(payload.inputs as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          )
        : {},
    description: str(payload.description),
    goal: str(payload.goal),
    allowClarify: payload.allowClarify !== false,
    collaboratorUserIds: Array.isArray(payload.collaboratorUserIds)
      ? payload.collaboratorUserIds.filter((v): v is string => typeof v === 'string')
      : [],
    gitUserName: str(payload.gitUserName),
    gitUserEmail: str(payload.gitUserEmail),
    workingBranch: str(payload.workingBranch),
    autoCommitPush: payload.autoCommitPush === true,
  }
  if (kind === 'workflow') seed.workflowId = discriminant
  if (kind === 'agent') seed.agentName = discriminant
  if (kind === 'workgroup') seed.workgroupName = discriminant
  if (typeof payload.maxDurationMs === 'number') seed.maxDurationMs = payload.maxDurationMs
  if (typeof payload.maxTotalTokens === 'number') seed.maxTotalTokens = payload.maxTotalTokens
  return seed
}

// ---------------------------------------------------------------------------
// RFC-175 — "relaunch": reconstruct a launch payload from a terminal task.

/**
 * RFC-175 (§3): 3-state clarify inference for an agent task's relaunch. The
 * agent host snapshot wires a `kind:'clarify'` node IFF the launch set
 * allowClarify=true (backend services/agentLaunch.ts). Presence ⟺ `true`;
 * a structurally-valid snapshot with no clarify node ⟺ `false`; anything
 * unparseable ⟺ `'unknown'`. Callers send `allowClarify:false` ONLY on `false`
 * — `true`/`'unknown'` omit the field so `payloadToWizardSeed` defaults it true
 * (never conflate "snapshot broken" with "clarify was off").
 */
/**
 * RFC-218 — is this frozen agent-host snapshot the PORTED shape? Detection is
 * the EXACT indexed input-node id form. Never a prefix test: the RFC-165
 * legacy node id `__agent_input__` itself starts with `__agent_input_`, so a
 * prefix match would classify every zero-port task as ported and relaunch
 * would drop the saved description (design-gate P1-1).
 */
const PORTED_INPUT_NODE_RE = /^__agent_input_\d+__$/
export function snapshotIsPortedAgentHost(snapshot: unknown): boolean {
  if (snapshot === null || typeof snapshot !== 'object') return false
  const nodes = (snapshot as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return false
  return nodes.some(
    (n) =>
      typeof n === 'object' &&
      n !== null &&
      typeof (n as { id?: unknown }).id === 'string' &&
      PORTED_INPUT_NODE_RE.test((n as { id: string }).id),
  )
}

/** Upload-kind input keys declared in a frozen snapshot's `inputs[]`. */
export function snapshotUploadInputKeys(snapshot: unknown): Set<string> {
  const out = new Set<string>()
  if (snapshot === null || typeof snapshot !== 'object') return out
  const inputs = (snapshot as { inputs?: unknown }).inputs
  if (!Array.isArray(inputs)) return out
  for (const def of inputs) {
    if (
      typeof def === 'object' &&
      def !== null &&
      (def as { kind?: unknown }).kind === 'upload' &&
      typeof (def as { key?: unknown }).key === 'string'
    ) {
      out.add((def as { key: string }).key)
    }
  }
  return out
}

export function snapshotClarifyState(snapshot: unknown): boolean | 'unknown' {
  if (snapshot === null || typeof snapshot !== 'object') return 'unknown'
  const nodes = (snapshot as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return 'unknown'
  return nodes.some(
    (n) => typeof n === 'object' && n !== null && (n as { kind?: unknown }).kind === 'clarify',
  )
}

/**
 * RFC-175 (§3): reconstruct a `payloadToWizardSeed`-compatible launch payload
 * from a terminal task's already-persisted fields (relaunch pre-fill). Pure and
 * field-by-field unit-testable. `spaceResolvable=false` signals the space could
 * NOT be faithfully rebuilt (internal/fusion space, or a legacy path-mode local
 * task with no URL to replay) — the wizard then leaves the space at its default
 * rather than a wrong value. Collaborators are NOT included here (fetched
 * separately from the members endpoint — §4). Subject validity (does the current
 * same-named agent/workgroup match) is a wizard concern (needs the inventory
 * queries), NOT decidable from the Task alone (§4.7).
 */
export function taskToLaunchPayload(task: Task): {
  payload: Record<string, unknown>
  spaceResolvable: boolean
} {
  const kind = taskExecutionKind(task)
  const payload: Record<string, unknown> = { name: task.name }

  // Space (§3): four spaceKind values. scratch/remote reconstruct faithfully;
  // legacy `local` with a redacted URL is best-effort; `local` without a URL
  // (pure path mode) and `internal` (fusion) are unresolvable.
  let spaceResolvable = true
  if (task.spaceKind === 'scratch') {
    payload.scratch = true
  } else if (task.spaceKind === 'internal') {
    spaceResolvable = false
  } else if (
    task.status === 'failed' &&
    (task.errorSummary ?? '').startsWith('worktree creation failed:')
  ) {
    // RFC-175 impl-gate F2 (re-review): ONLY a materialize/worktree-creation
    // failure risks a truncated repo prefix. A multi-repo materialize aborts on
    // the first bad repo and persists only the successful PREFIX, with repo_count
    // collapsed to that length (services/task.ts persists
    // `errorSummary: 'worktree creation failed: …'` + `repoCount:
    // Math.max(1, materializedRepos.length)`) — the dropped repos are
    // unrecoverable from the DTO, so refuse to reconstruct a SUBSET. Match the
    // POSITIVE worktree-creation marker, NOT `failedNodeId === null`: scheduler
    // failures (snapshot-invalid / cycle / scheduler-error) also have a null
    // failedNodeId but a COMPLETE materialized space and must stay resolvable.
    // (Locked to the backend marker by a source test.)
    spaceResolvable = false
  } else {
    // RFC-204: prefer the mirror id. `task.repos[].repoUrl` is stored REDACTED
    // (RFC-054 W3-4), so relaunching a private repo by URL sent `https://***@…`
    // and failed authentication — it was never a usable relaunch source. The id
    // is; the daemon resolves the real URL server-side.
    const repos = task.repos
      .filter((r) => (r.cachedRepoId ?? '') !== '' || (r.repoUrl ?? '') !== '')
      .map((r) =>
        (r.cachedRepoId ?? '') !== ''
          ? {
              cachedRepoId: r.cachedRepoId as string,
              ...(r.baseBranch ? { ref: r.baseBranch } : {}),
            }
          : {
              repoUrl: r.repoUrl ?? '',
              ...(r.baseBranch ? { ref: r.baseBranch } : {}),
            },
      )
    if (repos.length > 0) payload.repos = repos
    else spaceResolvable = false
  }

  // Common advanced fields (git identity is pair-gated; only send set ones).
  if (task.gitUserName && task.gitUserEmail) {
    payload.gitUserName = task.gitUserName
    payload.gitUserEmail = task.gitUserEmail
  }
  if (task.workingBranch) payload.workingBranch = task.workingBranch
  if (task.autoCommitPush) payload.autoCommitPush = true
  if (task.maxDurationMs != null) payload.maxDurationMs = task.maxDurationMs
  if (task.maxTotalTokens != null) payload.maxTotalTokens = task.maxTotalTokens

  // Per-kind discriminant + kind-specific fields.
  if (kind === 'workflow') {
    payload.workflowId = task.workflowId
    // Upload-kind input values are stale worktree paths — the wizard clears them
    // against the current inputDefs (§4.8); carried verbatim here.
    payload.inputs = task.inputs
  } else if (kind === 'agent') {
    payload.agentName = task.sourceAgentName ?? ''
    if (snapshotIsPortedAgentHost(task.workflowSnapshot)) {
      // RFC-218: ported host — replay port values. Upload-kind keys are stale
      // worktree paths the browser cannot rebuild into Files; drop them so the
      // wizard's required gate forces a visible re-pick (same policy as the
      // workflow arm's normalizeSeededInput).
      const uploadKeys = snapshotUploadInputKeys(task.workflowSnapshot)
      payload.inputs = Object.fromEntries(
        Object.entries(task.inputs).filter(([key]) => !uploadKeys.has(key)),
      )
    } else {
      payload.description = task.inputs.description ?? ''
    }
    if (snapshotClarifyState(task.workflowSnapshot) === false) payload.allowClarify = false
  } else {
    payload.workgroupName = task.workgroupName ?? ''
    payload.goal = task.goal ?? ''
  }

  return { payload, spaceResolvable }
}

/**
 * RFC-175 impl-gate F3: normalize ONE seeded input value against the CURRENT
 * workflow input definition. A relaunch (and the ?editScheduled= edit path)
 * replays the source task's stored input strings, which may be stale against a
 * since-edited workflow. Returns the value to seed:
 *   - `upload`: always '' — the stored value is a worktree path the browser
 *     cannot rebuild into a File (it would submit as a bogus string; §4.8).
 *   - `enum` single (no allowOther): keep only if still a declared choice, else ''.
 *   - `enum` multiSelect: keep the JSON-array members that are still choices;
 *     drop unknown/removed ones; '' if none survive or the JSON is unparseable.
 *   - `enum` with allowOther: any value is legal — keep as-is.
 *   - everything else (text / git / files): keep as-is.
 * An invalid enum value would otherwise render as "nothing selected" in
 * EnumPicker yet still submit (missingRequired only checks non-empty), silently
 * launching with a value the user cannot see; clearing it makes the required
 * gate force a visible re-pick.
 */
export function normalizeSeededInput(def: WorkflowInput, value: string): string {
  if (def.kind === 'upload') return ''
  if (def.kind === 'enum') {
    const loose = def as Record<string, unknown>
    const allowOther = loose.allowOther === true
    const choices = Array.isArray(loose.choices)
      ? loose.choices.filter((c): c is string => typeof c === 'string')
      : []
    // multiSelect FIRST (re-review F3): the wire format is a JSON string array,
    // so enforce it even when allowOther is on — a stale single-select scalar
    // (definition drift single→multi) must not slip through as a raw string that
    // EnumPicker fails to parse. allowOther keeps arbitrary members; otherwise
    // filter to live choices. Empty selection normalizes to '' (same as a fresh
    // untouched field), which the required gate treats as missing.
    if (loose.multiSelect === true) {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        return ''
      }
      if (!Array.isArray(parsed)) return ''
      const members = parsed.filter((x): x is string => typeof x === 'string')
      const kept = allowOther ? members : members.filter((m) => choices.includes(m))
      return kept.length > 0 ? JSON.stringify(kept) : ''
    }
    // single-select: allowOther keeps any value; else require a live choice.
    if (allowOther) return value
    return choices.includes(value) ? value : ''
  }
  return value
}

// ---------------------------------------------------------------------------
// Per-machine launch preferences (localStorage).

/**
 * RFC-075: remember the auto commit&push toggle across reloads. Default ON —
 * only an explicit opt-out (stored '0') keeps it off. Moved here from
 * routes/workflows.launch.tsx (RFC-165: that page retires; the wizard is the
 * surviving consumer).
 */
export const AUTO_COMMIT_PUSH_LS_KEY = 'agent-workflow.launcher.autoCommitPush'
export function loadAutoCommitPushPref(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(AUTO_COMMIT_PUSH_LS_KEY) !== '0'
  } catch {
    return true
  }
}
export function saveAutoCommitPushPref(v: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(AUTO_COMMIT_PUSH_LS_KEY, v ? '1' : '0')
  } catch {
    /* noop */
  }
}

/** RFC-165 D9（用户 2026-07-11 修订）: the space step defaults to SCRATCH and
 *  remembers the last choice (an explicit 'remote' pick survives reloads). */
export const SPACE_KIND_LS_KEY = 'agent-workflow.wizard.spaceKind'
export function loadSpaceKindPref(): 'remote' | 'scratch' {
  if (typeof window === 'undefined') return 'scratch'
  try {
    return window.localStorage.getItem(SPACE_KIND_LS_KEY) === 'remote' ? 'remote' : 'scratch'
  } catch {
    return 'scratch'
  }
}
export function saveSpaceKindPref(v: 'remote' | 'scratch'): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SPACE_KIND_LS_KEY, v)
  } catch {
    /* noop */
  }
}
