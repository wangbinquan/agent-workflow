// RFC-165 (T13) — pure helpers for the /tasks/new wizard.
//
// Three explicit body builders (one per execution kind), the shared space
// stamping they delegate to, the scheduled-task payload envelope, and the
// inverse mapping (stored schedule payload → wizard seed) for
// `?editScheduled=`. Everything here is pure so the wire shapes are
// field-by-field unit-testable without the route harness (RFC-125 lesson:
// whitelist builders silently drop what they don't stamp — tests assert every
// field explicitly).

import type { ScheduledLaunchKind } from '@agent-workflow/shared'
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
): FormData {
  const inputsOut: Record<string, string> = { ...common.inputs }
  for (const key of Object.keys(uploads)) {
    if (!(key in inputsOut)) inputsOut[key] = ''
  }
  const body = buildWorkflowStartBody(space, { ...common, inputs: inputsOut })
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
  /** The task prompt (proposal: 描述即提示词). Caller trims. */
  description: string
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
  body.description = common.description
  if (common.allowClarify === false) body.allowClarify = false
  stampLimits(body, common)
  return body
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
  if (kind === 'agent') return { agentName: ref.agentName ?? '', ...body }
  if (kind === 'workgroup') return { workgroupName: ref.workgroupName ?? '', ...body }
  return body
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

/** RFC-165 D9: the space step defaults to remote and remembers the last choice. */
export const SPACE_KIND_LS_KEY = 'agent-workflow.wizard.spaceKind'
export function loadSpaceKindPref(): 'remote' | 'scratch' {
  if (typeof window === 'undefined') return 'remote'
  try {
    return window.localStorage.getItem(SPACE_KIND_LS_KEY) === 'scratch' ? 'scratch' : 'remote'
  } catch {
    return 'remote'
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
