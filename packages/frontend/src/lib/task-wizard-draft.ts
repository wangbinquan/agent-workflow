// RFC-250 — strict, session-scoped recovery boundary for /tasks/new.
//
// This module is intentionally pure apart from the caller-supplied Storage
// adapter. It never reads window/sessionStorage directly, so route tests can
// prove identity, expiry, size and secret-redaction behavior without mounting
// the full wizard.

import {
  hasQueryCredential,
  parseGitUrl,
  redactGitUrl,
  type WorkflowInput,
} from '@agent-workflow/shared'
import type { WizardKind, WizardSpace } from './task-wizard'
import { bytesToHex, sha256DigestJs } from './sha256'
import { stableStringify } from './stable-stringify'

export const TASK_WIZARD_DRAFT_PREFIX = 'aw:task-wizard-draft:v1:'
export const TASK_WIZARD_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000
export const TASK_WIZARD_DRAFT_MAX_BYTES = 512 * 1_024

export type TaskWizardDraftFlow = 'new' | 'relaunch' | 'edit-scheduled' | 'tour'

export type SerializableWizardSpace =
  | { kind: 'scratch' }
  | { kind: 'group'; groupId: string }
  | { kind: 'replay'; sourceTaskId: string }
  | {
      kind: 'remote'
      repos: Array<{
        repoUrlRedacted: string
        cachedRepoId?: string
        ref: string
        requiresRepoUrlReentry: boolean
      }>
    }

export type SerializedWizardInput = { kind: 'value'; value: string } | { kind: 'reentry-required' }

export interface TaskWizardDraftValues {
  kind: WizardKind
  workflowId: string
  /** Exact workflow definition revision that the persisted inputs were normalized against. */
  selectedWorkflowVersion?: number
  agentId: string
  workgroupId: string
  selectedWorkgroupVersion?: number
  space: SerializableWizardSpace
  taskName: string
  inputs: Record<string, SerializedWizardInput>
  uploadMetadata: Record<
    string,
    Array<{ name: string; size: number; type: string; lastModified: number }>
  >
  description: string
  goal: string
  allowClarify: boolean
  collaboratorIds: string[]
  workingBranch: string
  autoCommitPush: boolean
  maxDurationMin?: number
  maxTotalTokens?: number
}

export interface TaskWizardDraftV1 {
  schemaVersion: 1
  actorId: string
  flow: TaskWizardDraftFlow
  sourceId: string | null
  savedAt: number
  baselineFingerprint: string
  step: number
  /**
   * A non-secret marker written before a non-idempotent request leaves the
   * browser. Its presence freezes the restored draft until the user reconciles
   * the server inventory; it is not proof that the write committed.
   */
  reconciliation?: {
    operation: 'create-task' | 'create-scheduled-task' | 'save-scheduled-config'
    startedAt: number
    taskName: string
  }
  values: TaskWizardDraftValues
}

/**
 * Hash only the already-sanitized recovery projection. Callers must never
 * fingerprint their raw material signature: low-level form state can contain
 * repository credentials and secret inputs that are intentionally absent from
 * `TaskWizardDraftValues`.
 */
export function taskWizardBaselineFingerprint(values: TaskWizardDraftValues): string {
  const bytes = new TextEncoder().encode(stableStringify(values))
  return `sha256:${bytesToHex(sha256DigestJs(bytes))}`
}

export type TaskWizardDraftReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'oversize' }
  | { kind: 'expired' }
  | { kind: 'identity-mismatch' }
  | { kind: 'ok'; draft: TaskWizardDraftV1 }

export interface TaskWizardDraftIdentity {
  actorId: string
  flow: TaskWizardDraftFlow
  sourceId: string | null
}

export type TaskWizardNewDraftEntry =
  | { kind: 'picker'; preferredKind: WizardKind }
  | { kind: 'agent'; resourceId: string }
  | { kind: 'workflow'; resourceId: string; workflowVersion?: number }
  | { kind: 'workgroup'; resourceId: string; workgroupVersion?: number }

/**
 * Derive the recovery namespace from URL-owned launch identity only. The
 * digest keeps even a hostile/corrupt resource id out of sessionStorage keys,
 * while the canonical projection separates picker/deep-link, immediate/
 * scheduled, resource kind and exact editor revisions.
 */
export function taskWizardNewDraftSourceId(input: {
  scheduled: boolean
  entry: TaskWizardNewDraftEntry
}): string {
  const bytes = new TextEncoder().encode(
    stableStringify({
      mode: input.scheduled ? 'scheduled' : 'immediate',
      entry: input.entry,
    }),
  )
  return `new:${input.scheduled ? 'scheduled' : 'immediate'}:${input.entry.kind}:sha256:${bytesToHex(
    sha256DigestJs(bytes),
  )}`
}

function keyPart(value: string): string {
  return encodeURIComponent(value)
}

export function taskWizardDraftKey(identity: TaskWizardDraftIdentity): string {
  return `${TASK_WIZARD_DRAFT_PREFIX}${keyPart(identity.actorId)}:${identity.flow}:${
    identity.sourceId === null ? '_' : keyPart(identity.sourceId)
  }`
}

function safeUrlDisplay(raw: string): string {
  // A fragment has no role in Git transport identity and can freely carry a
  // credential. A credential-like query is similarly dropped wholesale from
  // the recovery summary instead of preserving even its parameter name.
  const withoutFragment = raw.split('#', 1)[0] ?? ''
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? ''
  return redactGitUrl(withoutQuery)
}

export function serializeWizardSpace(space: WizardSpace): SerializableWizardSpace {
  if (space.kind === 'scratch') return { kind: 'scratch' }
  if (space.kind === 'group') return { kind: 'group', groupId: space.groupId }
  if (space.kind === 'replay') return { kind: 'replay', sourceTaskId: space.sourceTaskId }
  return {
    kind: 'remote',
    repos: space.repos.map((repo) => {
      const raw = repo.repoUrl.trim()
      const parsed = raw === '' ? null : parseGitUrl(raw)
      const redacted = redactGitUrl(raw)
      const requiresRepoUrlReentry =
        raw !== '' &&
        (parsed === null || redacted !== raw || hasQueryCredential(raw) || raw.includes('#'))
      return {
        // A malformed URL has no parser-proven credential boundary. Persist no
        // part of it: ad-hoc SCP-like strings can contain userinfo that the
        // ordinary URL redactor does not recognize.
        repoUrlRedacted:
          raw !== '' && parsed === null ? '' : requiresRepoUrlReentry ? safeUrlDisplay(raw) : raw,
        ...(repo.cachedRepoId !== undefined ? { cachedRepoId: repo.cachedRepoId } : {}),
        ref: repo.ref,
        requiresRepoUrlReentry,
      }
    }),
  }
}

export function restoreWizardSpace(space: SerializableWizardSpace): {
  space: WizardSpace
  requiresRepoUrlReentry: boolean
} {
  if (space.kind === 'scratch') return { space: { kind: 'scratch' }, requiresRepoUrlReentry: false }
  if (space.kind === 'group') {
    return { space: { kind: 'group', groupId: space.groupId }, requiresRepoUrlReentry: false }
  }
  if (space.kind === 'replay') {
    return {
      space: { kind: 'replay', sourceTaskId: space.sourceTaskId },
      requiresRepoUrlReentry: false,
    }
  }
  return {
    space: {
      kind: 'remote',
      repos: space.repos.map((repo) => ({
        kind: 'url',
        repoUrl: repo.requiresRepoUrlReentry ? '' : repo.repoUrlRedacted,
        ...(repo.cachedRepoId !== undefined && !repo.requiresRepoUrlReentry
          ? { cachedRepoId: repo.cachedRepoId }
          : {}),
        ref: repo.ref,
      })),
    },
    requiresRepoUrlReentry: space.repos.some((repo) => repo.requiresRepoUrlReentry),
  }
}

function inputCanPersist(definition: WorkflowInput | undefined): boolean {
  if (definition === undefined) return false
  const record = definition as Record<string, unknown>
  // Passthrough schema fields can mark every input kind (including enum) as a
  // secret. Sensitivity must win before any kind-specific persistence rule.
  if (record.secret === true || record.sensitive === true) return false
  if (definition.kind === 'enum') return true
  // Unknown sensitivity fails closed. An authored input can opt in only with
  // an explicit non-sensitive marker; `secret:true` always wins.
  return record.sensitive === false
}

export function serializeWizardInputs(
  values: Record<string, string>,
  definitions: readonly WorkflowInput[],
): Record<string, SerializedWizardInput> {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      inputCanPersist(byKey.get(key))
        ? { kind: 'value' as const, value }
        : { kind: 'reentry-required' as const },
    ]),
  )
}

export function restoreWizardInputs(inputs: Record<string, SerializedWizardInput>): {
  values: Record<string, string>
  reentryKeys: string[]
} {
  const values: Record<string, string> = {}
  const reentryKeys: string[] = []
  for (const [key, entry] of Object.entries(inputs)) {
    if (entry.kind === 'value') values[key] = entry.value
    else {
      values[key] = ''
      reentryKeys.push(key)
    }
  }
  return { values, reentryKeys }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  return !Object.keys(value).some((key) => key === '__proto__' || key === 'prototype')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalPositiveNumber(value: unknown): boolean {
  return value === undefined || (isFiniteNumber(value) && value > 0)
}

function isSerializableSpace(value: unknown): value is SerializableWizardSpace {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'scratch') return Object.keys(value).length === 1
  if (value.kind === 'group') return typeof value.groupId === 'string'
  if (value.kind === 'replay') return typeof value.sourceTaskId === 'string'
  if (value.kind !== 'remote' || !Array.isArray(value.repos) || value.repos.length === 0)
    return false
  return value.repos.every(
    (repo) =>
      isRecord(repo) &&
      typeof repo.repoUrlRedacted === 'string' &&
      (repo.cachedRepoId === undefined || typeof repo.cachedRepoId === 'string') &&
      typeof repo.ref === 'string' &&
      typeof repo.requiresRepoUrlReentry === 'boolean',
  )
}

function isInputs(value: unknown): value is Record<string, SerializedWizardInput> {
  if (!isStringRecord(value)) return false
  return Object.values(value).every(
    (entry) =>
      isRecord(entry) &&
      ((entry.kind === 'value' && typeof entry.value === 'string') ||
        (entry.kind === 'reentry-required' && Object.keys(entry).length === 1)),
  )
}

function isUploadMetadata(value: unknown): value is TaskWizardDraftValues['uploadMetadata'] {
  if (!isStringRecord(value)) return false
  return Object.values(value).every(
    (entries) =>
      Array.isArray(entries) &&
      entries.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.name === 'string' &&
          isFiniteNumber(entry.size) &&
          entry.size >= 0 &&
          typeof entry.type === 'string' &&
          isFiniteNumber(entry.lastModified) &&
          entry.lastModified >= 0,
      ),
  )
}

function isDraftValues(value: unknown): value is TaskWizardDraftValues {
  if (!isRecord(value)) return false
  if (value.kind !== 'agent' && value.kind !== 'workflow' && value.kind !== 'workgroup')
    return false
  return (
    typeof value.workflowId === 'string' &&
    (value.selectedWorkflowVersion === undefined ||
      (typeof value.selectedWorkflowVersion === 'number' &&
        Number.isInteger(value.selectedWorkflowVersion) &&
        value.selectedWorkflowVersion > 0)) &&
    // A workflow draft without a revision fence predates the safe recovery
    // contract. Reject it instead of silently binding vN inputs to vN+1.
    (value.kind !== 'workflow' ||
      value.workflowId === '' ||
      value.selectedWorkflowVersion !== undefined) &&
    typeof value.agentId === 'string' &&
    typeof value.workgroupId === 'string' &&
    (value.selectedWorkgroupVersion === undefined ||
      (typeof value.selectedWorkgroupVersion === 'number' &&
        Number.isInteger(value.selectedWorkgroupVersion) &&
        value.selectedWorkgroupVersion > 0)) &&
    isSerializableSpace(value.space) &&
    typeof value.taskName === 'string' &&
    isInputs(value.inputs) &&
    isUploadMetadata(value.uploadMetadata) &&
    typeof value.description === 'string' &&
    typeof value.goal === 'string' &&
    typeof value.allowClarify === 'boolean' &&
    Array.isArray(value.collaboratorIds) &&
    value.collaboratorIds.every((id) => typeof id === 'string') &&
    typeof value.workingBranch === 'string' &&
    typeof value.autoCommitPush === 'boolean' &&
    isOptionalPositiveNumber(value.maxDurationMin) &&
    isOptionalPositiveNumber(value.maxTotalTokens)
  )
}

function isTaskWizardDraftV1(value: unknown): value is TaskWizardDraftV1 {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 1 &&
    typeof value.actorId === 'string' &&
    (value.flow === 'new' ||
      value.flow === 'relaunch' ||
      value.flow === 'edit-scheduled' ||
      value.flow === 'tour') &&
    (value.sourceId === null || typeof value.sourceId === 'string') &&
    isFiniteNumber(value.savedAt) &&
    value.savedAt >= 0 &&
    typeof value.baselineFingerprint === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.baselineFingerprint) &&
    typeof value.step === 'number' &&
    Number.isInteger(value.step) &&
    value.step >= 0 &&
    value.step <= 3 &&
    (value.reconciliation === undefined ||
      (isRecord(value.reconciliation) &&
        (value.reconciliation.operation === 'create-task' ||
          value.reconciliation.operation === 'create-scheduled-task' ||
          value.reconciliation.operation === 'save-scheduled-config') &&
        isFiniteNumber(value.reconciliation.startedAt) &&
        value.reconciliation.startedAt >= 0 &&
        typeof value.reconciliation.taskName === 'string')) &&
    isDraftValues(value.values)
  )
}

export function parseTaskWizardDraft(
  raw: string | null,
  identity: TaskWizardDraftIdentity & { now?: number },
): TaskWizardDraftReadResult {
  if (raw === null) return { kind: 'missing' }
  if (byteLength(raw) > TASK_WIZARD_DRAFT_MAX_BYTES) return { kind: 'oversize' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'invalid' }
  }
  if (!isTaskWizardDraftV1(parsed)) return { kind: 'invalid' }
  if (
    parsed.actorId !== identity.actorId ||
    parsed.flow !== identity.flow ||
    parsed.sourceId !== identity.sourceId
  ) {
    return { kind: 'identity-mismatch' }
  }
  const now = identity.now ?? Date.now()
  if (now - parsed.savedAt > TASK_WIZARD_DRAFT_TTL_MS || parsed.savedAt > now + 60_000) {
    return { kind: 'expired' }
  }
  return { kind: 'ok', draft: parsed }
}

export type TaskWizardDraftWriteResult =
  | { ok: true }
  | { ok: false; reason: 'oversize' | 'storage'; error?: unknown }

export function writeTaskWizardDraft(
  storage: Storage,
  key: string,
  draft: TaskWizardDraftV1,
): TaskWizardDraftWriteResult {
  const raw = JSON.stringify(draft)
  if (byteLength(raw) > TASK_WIZARD_DRAFT_MAX_BYTES) return { ok: false, reason: 'oversize' }
  try {
    storage.setItem(key, raw)
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, reason: 'storage', error }
  }
}

export function clearAllTaskWizardDrafts(storage: Storage): void {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(TASK_WIZARD_DRAFT_PREFIX) === true) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}
