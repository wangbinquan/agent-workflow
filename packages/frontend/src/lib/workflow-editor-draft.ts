// RFC-199 B2 — pure composite workflow-editor draft state machine.
//
// This module deliberately knows nothing about React Query, timers, fetch, or
// WebSocket hooks. Callers execute the returned commands and feed their
// outcomes back as events. That separation makes the response-loss and
// multi-tab races deterministic under a fake clock.

import {
  serializeWorkflowEditableSnapshotV1,
  type SaveWorkflowReceipt,
  type WorkflowDetail,
  type WorkflowDraftSnapshot,
  type WorkflowMutationId,
  type WorkflowRevision,
  type WorkflowSnapshotHash,
} from '@agent-workflow/shared'
import {
  canRedoWorkflowEditorHistory,
  canUndoWorkflowEditorHistory,
  createWorkflowEditorHistoryState,
  immutableWorkflowEditorSnapshot,
  recordWorkflowEditorHistory,
  redoWorkflowEditorHistory,
  resetWorkflowEditorHistory,
  undoWorkflowEditorHistory,
  type WorkflowDraftChangeMeta,
  type WorkflowEditorHistoryState,
} from '@/lib/workflow-editor-history'
import { sha256Hex, type Sha256Subtle } from '@/lib/sha256'

export type WorkflowDraftPhase =
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'reconciling'
  | 'error'
  | 'conflict'
  | 'inaccessible'
  | 'deleted'

/** Save state is intentionally orthogonal to connectivity state. */
export type WorkflowDraftTransport = 'online' | 'degraded' | 'offline'

export interface WorkflowSaveAttempt {
  /** Monotonic local revision captured by this request. */
  revision: number
  expectedVersion: number
  clientMutationId: WorkflowMutationId
  /** Isolated copy: later LOCAL_COMMIT events cannot mutate request bytes. */
  snapshot: WorkflowDraftSnapshot
  snapshotHash: WorkflowSnapshotHash
}

export interface WorkflowRemoteSnapshot {
  revision: WorkflowRevision
  snapshot: WorkflowDraftSnapshot
}

export interface WorkflowRemoteObservation {
  source: 'query' | 'ws' | 'reconcile'
  revision: WorkflowRevision
  /** WS update frames only carry revision metadata; GET/query observations carry this. */
  snapshot?: WorkflowDraftSnapshot
  clientMutationId?: WorkflowMutationId
}

export interface WorkflowRemoteConflict {
  reason: 'save-conflict' | 'remote-observed'
  current: WorkflowRevision | null
  snapshot: WorkflowDraftSnapshot | null
}

export interface WorkflowDraftFailure {
  kind: 'transport' | 'http'
  message: string
  status?: number
}

export interface WorkflowReconcileRetry {
  /** Number of consecutive failed reconciliation reads. */
  attempt: number
  nextAt: number | null
}

/** @deprecated B4 replaced the lightweight pointer with full immutable history. */
export type WorkflowDraftHistoryPointer = WorkflowEditorHistoryState

export interface WorkflowEditorDraftState {
  workflowId: string
  local: WorkflowDraftSnapshot
  server: WorkflowDraftSnapshot
  serverRevision: WorkflowRevision
  /** Every changed LOCAL_COMMIT, Undo/Redo, and confirmed remote adoption increases this. */
  revision: number
  /** Latest local revision acknowledged by an exact receipt/observation. */
  savedRevision: number
  inFlight: WorkflowSaveAttempt | null
  /** Latest local revision to submit after the one in flight; intermediate edits coalesce. */
  queuedRevision: number | null
  phase: WorkflowDraftPhase
  error: WorkflowDraftFailure | null
  conflict: WorkflowRemoteConflict | null
  transport: WorkflowDraftTransport
  reconcileRetry: WorkflowReconcileRetry
  history: WorkflowEditorHistoryState
  /** Correlates only an explicit user retry; ambient query/WS cannot revive terminal state. */
  accessRetryId: string | null
}

export type WorkflowDraftCommand =
  | { type: 'SEND_SAVE'; attempt: WorkflowSaveAttempt }
  | { type: 'REQUEST_SAVE'; revision: number }
  | {
      type: 'RECONCILE'
      attempt: WorkflowSaveAttempt
      trigger: 'save-uncertain' | 'timer' | 'wake'
    }
  | { type: 'SCHEDULE_RECONCILE'; delayMs: number; at: number }
  | { type: 'CANCEL_RECONCILE_TIMER' }
  | { type: 'FETCH_REMOTE' }
  | { type: 'RETRY_ACCESS'; requestId: string }
  | { type: 'CONFIRM_LOAD_REMOTE'; current: WorkflowRevision | null }
  | {
      type: 'PREPARE_OVERWRITE'
      snapshot: WorkflowDraftSnapshot
      current: WorkflowRevision | null
    }
  | { type: 'SAVE_COPY'; snapshot: WorkflowDraftSnapshot; suggestedName: string }

export interface WorkflowDraftTransition {
  state: WorkflowEditorDraftState
  commands: readonly WorkflowDraftCommand[]
}

export type WorkflowEditorDraftEvent =
  | { type: 'LOCAL_COMMIT'; snapshot: WorkflowDraftSnapshot; meta?: WorkflowDraftChangeMeta }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | {
      type: 'SAVE_REQUESTED'
      /** Guards an async hash from being paired with a newer local snapshot. */
      revision: number
      clientMutationId: WorkflowMutationId
      snapshot: WorkflowDraftSnapshot
      snapshotHash: WorkflowSnapshotHash
      mode?: 'autosave' | 'overwrite'
      /** Required for overwrite after the caller's fresh conflict refetch. */
      expectedRemote?: WorkflowRemoteSnapshot
    }
  | { type: 'SAVE_COMMITTED'; receipt: SaveWorkflowReceipt }
  | { type: 'SAVE_ALREADY_CURRENT'; receipt: SaveWorkflowReceipt }
  | {
      type: 'SAVE_FAILED'
      clientMutationId: WorkflowMutationId
      failure: WorkflowDraftFailure
      current?: WorkflowRemoteObservation
    }
  | {
      type: 'RECONCILED'
      clientMutationId: WorkflowMutationId
      observation: Omit<WorkflowRemoteObservation, 'source'>
    }
  | {
      type: 'RECONCILE_FAILED'
      clientMutationId: WorkflowMutationId
      failure: WorkflowDraftFailure
      now: number
    }
  | { type: 'REMOTE_OBSERVED'; observation: WorkflowRemoteObservation }
  | {
      type: 'REMOTE_DELETED'
      workflowId: string
      clientMutationId?: WorkflowMutationId
      deletedVersion?: number
    }
  | { type: 'REMOTE_INACCESSIBLE'; workflowId: string; failure?: WorkflowDraftFailure }
  | { type: 'INACCESSIBLE_RETRY_REQUESTED'; requestId: string }
  | {
      type: 'INACCESSIBLE_RETRY_SUCCEEDED'
      requestId: string
      remote: WorkflowRemoteSnapshot
    }
  | {
      type: 'INACCESSIBLE_RETRY_FAILED'
      requestId: string
      failure: WorkflowDraftFailure
    }
  | { type: 'TRANSPORT_CHANGED'; transport: WorkflowDraftTransport }
  | { type: 'RECONCILE_TIMER_FIRED'; now: number }
  | { type: 'RECONCILE_WAKE'; transport?: Exclude<WorkflowDraftTransport, 'offline'> }
  | { type: 'CONFLICT_LOAD_REMOTE_INTENT' }
  | { type: 'CONFLICT_LOAD_REMOTE_CONFIRMED'; remote: WorkflowRemoteSnapshot }
  | { type: 'CONFLICT_OVERWRITE_INTENT' }
  | { type: 'CONFLICT_SAVE_COPY_INTENT' }

const EMPTY_RETRY: WorkflowReconcileRetry = { attempt: 0, nextAt: null }
const RECONCILE_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const

/** 1st failed GET waits 1s; subsequent failures cap at 15s. */
export function workflowReconcileBackoffMs(failureCount: number): number {
  const index = Math.max(0, Math.min(RECONCILE_BACKOFF_MS.length - 1, failureCount - 1))
  return RECONCILE_BACKOFF_MS[index]!
}

/** Browser-safe canonical bytes used by both the Web Crypto hash and tests. */
export function workflowDraftSnapshotBytes(snapshot: WorkflowDraftSnapshot): Uint8Array {
  return new TextEncoder().encode(serializeWorkflowEditableSnapshotV1(snapshot))
}

/** Browser-safe SHA-256; no node:crypto enters the frontend bundle. Insecure
 *  http:// contexts (LAN-IP deployments) have no SubtleCrypto, so sha256Hex
 *  falls back to pure JS instead of throwing — the whole save pipeline hangs
 *  otherwise (2026-07-21 incident). */
export async function hashWorkflowDraftSnapshot(
  snapshot: WorkflowDraftSnapshot,
  subtle: Sha256Subtle | undefined = globalThis.crypto?.subtle,
): Promise<WorkflowSnapshotHash> {
  const hex = await sha256Hex(workflowDraftSnapshotBytes(snapshot), subtle)
  return hex as WorkflowSnapshotHash
}

/**
 * Capture every request variable before the async hash boundary. If typing
 * advances state before this event is reduced, SAVE_REQUESTED rejects it by
 * revision/snapshot and asks the caller to prepare the latest revision.
 */
export async function prepareWorkflowDraftSaveEvent(
  state: WorkflowEditorDraftState,
  clientMutationId: WorkflowMutationId,
  options: {
    mode?: 'autosave' | 'overwrite'
    expectedRemote?: WorkflowRemoteSnapshot
  } = {},
): Promise<Extract<WorkflowEditorDraftEvent, { type: 'SAVE_REQUESTED' }>> {
  const revision = state.revision
  const snapshot = cloneSnapshot(state.local)
  const snapshotHash = await hashWorkflowDraftSnapshot(snapshot)
  return {
    type: 'SAVE_REQUESTED',
    revision,
    clientMutationId,
    snapshot,
    snapshotHash,
    ...options,
  }
}

export function workflowRemoteSnapshotFromDetail(detail: WorkflowDetail): WorkflowRemoteSnapshot {
  return {
    revision: {
      workflowId: detail.id,
      version: detail.version,
      snapshotHash: detail.snapshotHash,
      updatedAt: detail.updatedAt,
    },
    snapshot: cloneSnapshot({
      name: detail.name,
      description: detail.description,
      definition: detail.definition,
    }),
  }
}

export function createWorkflowEditorDraftState(
  remote: WorkflowRemoteSnapshot,
): WorkflowEditorDraftState {
  const server = cloneSnapshot(remote.snapshot)
  return {
    workflowId: remote.revision.workflowId,
    local: cloneSnapshot(server),
    server,
    serverRevision: { ...remote.revision },
    revision: 0,
    savedRevision: 0,
    inFlight: null,
    queuedRevision: null,
    phase: 'clean',
    error: null,
    conflict: null,
    transport: 'online',
    reconcileRetry: EMPTY_RETRY,
    history: createWorkflowEditorHistoryState(),
    accessRetryId: null,
  }
}

export function createWorkflowEditorDraftStateFromDetail(
  detail: WorkflowDetail,
): WorkflowEditorDraftState {
  return createWorkflowEditorDraftState(workflowRemoteSnapshotFromDetail(detail))
}

/** React-compatible reducer for consumers that handle commands elsewhere. */
export function workflowEditorDraftReducer(
  state: WorkflowEditorDraftState,
  event: WorkflowEditorDraftEvent,
): WorkflowEditorDraftState {
  return transitionWorkflowEditorDraft(state, event).state
}

export function transitionWorkflowEditorDraft(
  state: WorkflowEditorDraftState,
  event: WorkflowEditorDraftEvent,
): WorkflowDraftTransition {
  switch (event.type) {
    case 'LOCAL_COMMIT':
      return localCommit(state, event.snapshot, event.meta)
    case 'UNDO':
      return restoreLocalHistory(state, 'undo')
    case 'REDO':
      return restoreLocalHistory(state, 'redo')
    case 'SAVE_REQUESTED':
      return saveRequested(state, event)
    case 'SAVE_COMMITTED':
      return event.receipt.outcome === 'committed'
        ? settleReceipt(state, event.receipt)
        : unchanged(state)
    case 'SAVE_ALREADY_CURRENT':
      return event.receipt.outcome === 'already-current'
        ? settleReceipt(state, event.receipt)
        : unchanged(state)
    case 'SAVE_FAILED':
      return saveFailed(state, event)
    case 'RECONCILED':
      if (state.inFlight?.clientMutationId !== event.clientMutationId) return unchanged(state)
      return observeRemote(state, { ...event.observation, source: 'reconcile' })
    case 'RECONCILE_FAILED':
      return reconcileFailed(state, event)
    case 'REMOTE_OBSERVED':
      return observeRemote(state, event.observation)
    case 'REMOTE_DELETED':
      if (event.workflowId !== state.workflowId) return unchanged(state)
      return terminalState(state, 'deleted', null)
    case 'REMOTE_INACCESSIBLE':
      if (event.workflowId !== state.workflowId) return unchanged(state)
      return terminalState(
        state,
        'inaccessible',
        event.failure ?? { kind: 'http', status: 404, message: 'workflow inaccessible' },
      )
    case 'INACCESSIBLE_RETRY_REQUESTED':
      if (state.phase !== 'inaccessible') return unchanged(state)
      return {
        state: { ...state, accessRetryId: event.requestId },
        commands: [{ type: 'RETRY_ACCESS', requestId: event.requestId }],
      }
    case 'INACCESSIBLE_RETRY_SUCCEEDED':
      return inaccessibleRetrySucceeded(state, event.requestId, event.remote)
    case 'INACCESSIBLE_RETRY_FAILED':
      if (state.phase !== 'inaccessible' || state.accessRetryId !== event.requestId) {
        return unchanged(state)
      }
      return {
        state: {
          ...state,
          accessRetryId: null,
          error: event.failure,
          transport: event.failure.kind === 'transport' ? 'offline' : 'online',
        },
        commands: [],
      }
    case 'TRANSPORT_CHANGED':
      return transportChanged(state, event.transport)
    case 'RECONCILE_TIMER_FIRED':
      return reconcileTimerFired(state, event.now)
    case 'RECONCILE_WAKE':
      return reconcileWake(state, event.transport)
    case 'CONFLICT_LOAD_REMOTE_INTENT':
      if (state.phase !== 'conflict') return unchanged(state)
      return commandOnly(state, {
        type: 'CONFIRM_LOAD_REMOTE',
        current: state.conflict?.current ?? null,
      })
    case 'CONFLICT_LOAD_REMOTE_CONFIRMED':
      return loadRemoteConfirmed(state, event.remote)
    case 'CONFLICT_OVERWRITE_INTENT':
      if (state.phase !== 'conflict') return unchanged(state)
      return commandOnly(state, {
        type: 'PREPARE_OVERWRITE',
        snapshot: cloneSnapshot(state.local),
        current: state.conflict?.current ?? null,
      })
    case 'CONFLICT_SAVE_COPY_INTENT':
      if (!['conflict', 'inaccessible', 'deleted'].includes(state.phase)) return unchanged(state)
      return commandOnly(state, {
        type: 'SAVE_COPY',
        snapshot: cloneSnapshot(state.local),
        suggestedName: `${state.local.name}-copy`,
      })
  }
}

export function isWorkflowDraftUnsafeToLeave(state: WorkflowEditorDraftState): boolean {
  return state.phase !== 'clean'
}

export function canUndoWorkflowEditorDraft(state: WorkflowEditorDraftState): boolean {
  return canUndoWorkflowEditorHistory(state.history)
}

export function canRedoWorkflowEditorDraft(state: WorkflowEditorDraftState): boolean {
  return canRedoWorkflowEditorHistory(state.history)
}

function localCommit(
  state: WorkflowEditorDraftState,
  snapshot: WorkflowDraftSnapshot,
  meta?: WorkflowDraftChangeMeta,
): WorkflowDraftTransition {
  const recorded = recordWorkflowEditorHistory(state.history, state.local, snapshot, meta)
  if (!recorded.changed) {
    return recorded.history === state.history
      ? unchanged(state)
      : { state: { ...state, history: recorded.history }, commands: [] }
  }
  if (meta?.historyMode === 'reset') {
    return applyLocalRevision(state, recorded.snapshot, resetWorkflowEditorHistory(state.history))
  }
  return applyLocalRevision(state, recorded.snapshot, recorded.history)
}

function restoreLocalHistory(
  state: WorkflowEditorDraftState,
  direction: 'undo' | 'redo',
): WorkflowDraftTransition {
  const restored =
    direction === 'undo'
      ? undoWorkflowEditorHistory(state.history, state.local)
      : redoWorkflowEditorHistory(state.history, state.local)
  if (!restored.changed) return unchanged(state)
  return applyLocalRevision(state, restored.snapshot, restored.history)
}

function applyLocalRevision(
  state: WorkflowEditorDraftState,
  snapshot: WorkflowDraftSnapshot,
  history: WorkflowEditorHistoryState,
): WorkflowDraftTransition {
  const revision = state.revision + 1
  const hasActiveSave = state.inFlight !== null
  const mayResumeAutosave =
    state.phase === 'clean' || state.phase === 'dirty' || state.phase === 'error'
  return {
    state: {
      ...state,
      local: snapshot,
      revision,
      queuedRevision:
        hasActiveSave || state.queuedRevision !== null || state.transport === 'offline'
          ? revision
          : state.queuedRevision,
      phase: mayResumeAutosave ? 'dirty' : state.phase,
      error: mayResumeAutosave ? null : state.error,
      history,
    },
    commands: [],
  }
}

function saveRequested(
  state: WorkflowEditorDraftState,
  event: Extract<WorkflowEditorDraftEvent, { type: 'SAVE_REQUESTED' }>,
): WorkflowDraftTransition {
  if (state.inFlight !== null) {
    if (state.revision === state.inFlight.revision) return unchanged(state)
    return {
      state: { ...state, queuedRevision: state.revision },
      commands: [],
    }
  }

  if (
    event.revision !== state.revision ||
    serializeWorkflowEditableSnapshotV1(event.snapshot) !==
      serializeWorkflowEditableSnapshotV1(state.local)
  ) {
    return {
      state: { ...state, queuedRevision: state.revision },
      commands: [{ type: 'REQUEST_SAVE', revision: state.revision }],
    }
  }

  const overwrite = event.mode === 'overwrite'
  if (['inaccessible', 'deleted'].includes(state.phase)) return unchanged(state)
  if (state.phase === 'conflict' && !overwrite) return unchanged(state)
  if (overwrite && state.phase !== 'conflict') return unchanged(state)
  if (!overwrite && state.revision === state.savedRevision && state.phase === 'clean') {
    return unchanged(state)
  }

  if (state.transport === 'offline') {
    return {
      state: {
        ...state,
        queuedRevision: state.revision,
        phase: state.phase === 'error' ? 'dirty' : state.phase,
      },
      commands: [],
    }
  }

  const expectedRemote = overwrite
    ? event.expectedRemote
    : { revision: state.serverRevision, snapshot: state.server }
  const expectedRevision = expectedRemote?.revision
  const conflictCurrent = overwrite ? state.conflict?.current : null
  const overwriteBaseline =
    conflictCurrent !== null &&
    conflictCurrent !== undefined &&
    conflictCurrent.version >= state.serverRevision.version
      ? conflictCurrent
      : state.serverRevision
  if (
    expectedRemote === undefined ||
    expectedRevision === undefined ||
    expectedRevision.workflowId !== state.workflowId ||
    (overwrite && !revisionAtLeast(expectedRevision, overwriteBaseline))
  ) {
    return unchanged(state)
  }

  const attempt: WorkflowSaveAttempt = {
    revision: event.revision,
    expectedVersion: expectedRevision.version,
    clientMutationId: event.clientMutationId,
    snapshot: cloneSnapshot(event.snapshot),
    snapshotHash: event.snapshotHash,
  }
  const next: WorkflowEditorDraftState = {
    ...state,
    server: cloneSnapshot(expectedRemote.snapshot),
    serverRevision: overwrite ? { ...expectedRevision } : state.serverRevision,
    inFlight: attempt,
    queuedRevision: null,
    phase: 'saving',
    error: null,
    conflict: overwrite ? null : state.conflict,
    reconcileRetry: EMPTY_RETRY,
  }
  return { state: next, commands: [{ type: 'SEND_SAVE', attempt }] }
}

function settleReceipt(
  state: WorkflowEditorDraftState,
  receipt: SaveWorkflowReceipt,
): WorkflowDraftTransition {
  const attempt = state.inFlight
  if (
    attempt === null ||
    receipt.clientMutationId !== attempt.clientMutationId ||
    receipt.requestedBaseVersion !== attempt.expectedVersion ||
    receipt.revision.workflowId !== state.workflowId
  ) {
    return unchanged(state)
  }
  return settleAttempt(state, receipt.revision, receipt.snapshot)
}

function settleAttempt(
  state: WorkflowEditorDraftState,
  revision: WorkflowRevision,
  snapshot: WorkflowDraftSnapshot,
): WorkflowDraftTransition {
  const attempt = state.inFlight
  if (attempt === null) return unchanged(state)
  const caughtUp = state.revision === attempt.revision
  const server = cloneSnapshot(snapshot)
  const commands: WorkflowDraftCommand[] = []
  if (state.reconcileRetry.nextAt !== null) commands.push({ type: 'CANCEL_RECONCILE_TIMER' })
  if (!caughtUp) commands.push({ type: 'REQUEST_SAVE', revision: state.revision })
  return {
    state: {
      ...state,
      local: caughtUp ? cloneSnapshot(server) : state.local,
      server,
      serverRevision: { ...revision },
      savedRevision: attempt.revision,
      inFlight: null,
      queuedRevision: caughtUp ? null : state.revision,
      phase: caughtUp ? 'clean' : 'dirty',
      error: null,
      conflict: null,
      transport: 'online',
      reconcileRetry: EMPTY_RETRY,
    },
    commands,
  }
}

function saveFailed(
  state: WorkflowEditorDraftState,
  event: Extract<WorkflowEditorDraftEvent, { type: 'SAVE_FAILED' }>,
): WorkflowDraftTransition {
  const attempt = state.inFlight
  if (attempt === null || attempt.clientMutationId !== event.clientMutationId) {
    return unchanged(state)
  }
  const status = event.failure.status
  if (status === 403 || status === 404) {
    return terminalState(state, 'inaccessible', event.failure)
  }
  if (status === 409) {
    const current = event.current?.revision ?? null
    return {
      state: {
        ...state,
        inFlight: null,
        queuedRevision: state.revision,
        phase: 'conflict',
        error: null,
        conflict: {
          reason: 'save-conflict',
          current,
          snapshot: event.current?.snapshot ? cloneSnapshot(event.current.snapshot) : null,
        },
        transport: 'online',
        reconcileRetry: EMPTY_RETRY,
      },
      commands: cancelTimerCommand(state),
    }
  }
  if (
    event.failure.kind === 'transport' ||
    status === undefined ||
    status === 429 ||
    status >= 500
  ) {
    return {
      state: {
        ...state,
        phase: 'reconciling',
        error: event.failure,
        transport: state.transport === 'offline' ? 'offline' : 'degraded',
        reconcileRetry: EMPTY_RETRY,
      },
      commands: [
        ...cancelTimerCommand(state),
        { type: 'RECONCILE', attempt, trigger: 'save-uncertain' },
      ],
    }
  }
  return {
    state: {
      ...state,
      inFlight: null,
      queuedRevision: state.revision,
      phase: 'error',
      error: event.failure,
      transport: 'online',
      reconcileRetry: EMPTY_RETRY,
    },
    commands: cancelTimerCommand(state),
  }
}

function reconcileFailed(
  state: WorkflowEditorDraftState,
  event: Extract<WorkflowEditorDraftEvent, { type: 'RECONCILE_FAILED' }>,
): WorkflowDraftTransition {
  const attempt = state.inFlight
  if (
    state.phase !== 'reconciling' ||
    attempt === null ||
    attempt.clientMutationId !== event.clientMutationId
  ) {
    return unchanged(state)
  }
  if (event.failure.status === 403 || event.failure.status === 404) {
    return terminalState(state, 'inaccessible', event.failure)
  }
  const failures = state.reconcileRetry.attempt + 1
  const delayMs = workflowReconcileBackoffMs(failures)
  const at = event.now + delayMs
  return {
    state: {
      ...state,
      error: event.failure,
      transport: event.failure.kind === 'transport' ? 'offline' : 'degraded',
      reconcileRetry: { attempt: failures, nextAt: at },
    },
    commands: [{ type: 'SCHEDULE_RECONCILE', delayMs, at }],
  }
}

function observeRemote(
  state: WorkflowEditorDraftState,
  observation: WorkflowRemoteObservation,
): WorkflowDraftTransition {
  if (observation.revision.workflowId !== state.workflowId) return unchanged(state)

  // Explicitly deleted is terminal. Inaccessible may recover after the user
  // dispatches the correlated retry lifecycle; ambient/cache/WS observations
  // are never sufficient to restart autosave.
  if (state.phase === 'deleted') return unchangedWithTransport(state, 'online')
  if (state.phase === 'inaccessible') return unchangedWithTransport(state, 'online')

  const attempt = state.inFlight
  if (state.phase === 'reconciling' && attempt !== null) {
    return reconcileObservation(state, observation, attempt)
  }

  // A normal own WS echo never settles nor overwrites local state; the exact
  // PUT receipt remains authoritative. During reconciliation the branch above
  // may use it as evidence that a response-lost request committed.
  if (
    observation.source === 'ws' &&
    attempt !== null &&
    observation.clientMutationId === attempt.clientMutationId
  ) {
    return unchangedWithTransport(state, 'online')
  }

  // A refetch may beat the HTTP receipt. Same submitted hash is sufficient to
  // settle this exact intent, while a WS own echo still follows the rule above.
  if (
    attempt !== null &&
    observation.revision.snapshotHash === attempt.snapshotHash &&
    observation.revision.version >= attempt.expectedVersion
  ) {
    return settleAttempt(state, observation.revision, observation.snapshot ?? attempt.snapshot)
  }

  if (observation.revision.version < state.serverRevision.version) {
    return unchangedWithTransport(state, 'online')
  }
  if (
    observation.revision.version === state.serverRevision.version &&
    observation.revision.snapshotHash === state.serverRevision.snapshotHash
  ) {
    return unchangedWithTransport(state, 'online')
  }

  if (state.phase === 'conflict') {
    const current = state.conflict?.current
    if (
      current !== null &&
      current !== undefined &&
      observation.revision.version < current.version
    ) {
      return unchangedWithTransport(state, 'online')
    }
    return {
      state: {
        ...state,
        conflict: {
          reason: state.conflict?.reason ?? 'remote-observed',
          current: { ...observation.revision },
          snapshot: observation.snapshot
            ? cloneSnapshot(observation.snapshot)
            : (state.conflict?.snapshot ?? null),
        },
        transport: 'online',
      },
      commands: [],
    }
  }

  const clean = state.revision === state.savedRevision && state.inFlight === null
  if (state.phase === 'clean' && clean) {
    if (observation.snapshot === undefined) {
      return commandOnly({ ...state, transport: 'online' }, { type: 'FETCH_REMOTE' })
    }
    return adoptRemote(state, {
      revision: observation.revision,
      snapshot: observation.snapshot,
    })
  }

  // Any non-duplicate remote revision while local work is dirty is a conflict.
  return {
    state: {
      ...state,
      inFlight: null,
      queuedRevision: state.revision,
      phase: 'conflict',
      error: null,
      conflict: {
        reason: 'remote-observed',
        current: { ...observation.revision },
        snapshot: observation.snapshot ? cloneSnapshot(observation.snapshot) : null,
      },
      transport: 'online',
      reconcileRetry: EMPTY_RETRY,
    },
    commands: cancelTimerCommand(state),
  }
}

function reconcileObservation(
  state: WorkflowEditorDraftState,
  observation: WorkflowRemoteObservation,
  attempt: WorkflowSaveAttempt,
): WorkflowDraftTransition {
  // Stale cache/WS data can coincidentally have the submitted hash after a
  // user reverts content. It cannot prove this vN attempt committed and must
  // never move the authoritative revision backwards.
  if (
    observation.revision.version < attempt.expectedVersion ||
    observation.revision.version < state.serverRevision.version
  ) {
    return unchangedWithTransport(state, 'online')
  }
  if (observation.revision.snapshotHash === attempt.snapshotHash) {
    return settleAttempt(state, observation.revision, observation.snapshot ?? attempt.snapshot)
  }
  if (observation.revision.version < attempt.expectedVersion) {
    return unchangedWithTransport(state, 'online')
  }
  if (observation.revision.version === attempt.expectedVersion) {
    return {
      state: {
        ...state,
        server: observation.snapshot ? cloneSnapshot(observation.snapshot) : state.server,
        serverRevision: { ...observation.revision },
        phase: 'saving',
        error: null,
        transport: 'online',
        reconcileRetry: EMPTY_RETRY,
      },
      commands: [...cancelTimerCommand(state), { type: 'SEND_SAVE', attempt }],
    }
  }
  return {
    state: {
      ...state,
      inFlight: null,
      queuedRevision: state.revision,
      phase: 'conflict',
      error: null,
      conflict: {
        reason: 'remote-observed',
        current: { ...observation.revision },
        snapshot: observation.snapshot ? cloneSnapshot(observation.snapshot) : null,
      },
      transport: 'online',
      reconcileRetry: EMPTY_RETRY,
    },
    commands: cancelTimerCommand(state),
  }
}

function transportChanged(
  state: WorkflowEditorDraftState,
  transport: WorkflowDraftTransport,
): WorkflowDraftTransition {
  const next = { ...state, transport }
  if (transport !== 'online') return { state: next, commands: [] }
  if (state.phase === 'reconciling' && state.inFlight !== null) {
    return {
      state: { ...next, reconcileRetry: { ...state.reconcileRetry, nextAt: null } },
      commands: [
        ...cancelTimerCommand(state),
        { type: 'RECONCILE', attempt: state.inFlight, trigger: 'wake' },
      ],
    }
  }
  if (state.phase === 'dirty' && state.queuedRevision !== null) {
    return { state: next, commands: [{ type: 'REQUEST_SAVE', revision: state.revision }] }
  }
  return { state: next, commands: [] }
}

function reconcileTimerFired(
  state: WorkflowEditorDraftState,
  now: number,
): WorkflowDraftTransition {
  const nextAt = state.reconcileRetry.nextAt
  if (state.phase !== 'reconciling' || state.inFlight === null || nextAt === null || now < nextAt) {
    return unchanged(state)
  }
  return {
    state: { ...state, reconcileRetry: { ...state.reconcileRetry, nextAt: null } },
    commands: [{ type: 'RECONCILE', attempt: state.inFlight, trigger: 'timer' }],
  }
}

function reconcileWake(
  state: WorkflowEditorDraftState,
  transport: Exclude<WorkflowDraftTransport, 'offline'> | undefined,
): WorkflowDraftTransition {
  if (state.phase !== 'reconciling' || state.inFlight === null) return unchanged(state)
  return {
    state: {
      ...state,
      transport: transport ?? state.transport,
      reconcileRetry: { ...state.reconcileRetry, nextAt: null },
    },
    commands: [
      ...cancelTimerCommand(state),
      { type: 'RECONCILE', attempt: state.inFlight, trigger: 'wake' },
    ],
  }
}

function loadRemoteConfirmed(
  state: WorkflowEditorDraftState,
  remote: WorkflowRemoteSnapshot,
): WorkflowDraftTransition {
  if (state.phase !== 'conflict' || remote.revision.workflowId !== state.workflowId) {
    return unchanged(state)
  }
  const current = state.conflict?.current
  const baseline =
    current !== null && current !== undefined && current.version >= state.serverRevision.version
      ? current
      : state.serverRevision
  if (!revisionAtLeast(remote.revision, baseline)) {
    return commandOnly(state, { type: 'FETCH_REMOTE' })
  }
  return adoptRemote(state, remote)
}

function inaccessibleRetrySucceeded(
  state: WorkflowEditorDraftState,
  requestId: string,
  remote: WorkflowRemoteSnapshot,
): WorkflowDraftTransition {
  if (
    state.phase !== 'inaccessible' ||
    state.accessRetryId !== requestId ||
    remote.revision.workflowId !== state.workflowId
  ) {
    return unchanged(state)
  }

  const exactBase =
    remote.revision.version === state.serverRevision.version &&
    remote.revision.snapshotHash === state.serverRevision.snapshotHash
  const clean = state.revision === state.savedRevision
  if (exactBase) {
    if (clean) {
      return {
        state: {
          ...state,
          phase: 'clean',
          error: null,
          transport: 'online',
          accessRetryId: null,
        },
        commands: [],
      }
    }
    return {
      state: {
        ...state,
        queuedRevision: state.revision,
        phase: 'dirty',
        error: null,
        transport: 'online',
        accessRetryId: null,
      },
      commands: [{ type: 'REQUEST_SAVE', revision: state.revision }],
    }
  }

  if (remote.revision.version < state.serverRevision.version) {
    return {
      state: { ...state, transport: 'online' },
      commands: [{ type: 'RETRY_ACCESS', requestId }],
    }
  }
  if (clean) return adoptRemote(state, remote)
  return {
    state: {
      ...state,
      inFlight: null,
      queuedRevision: state.revision,
      phase: 'conflict',
      error: null,
      conflict: {
        reason: 'remote-observed',
        current: { ...remote.revision },
        snapshot: cloneSnapshot(remote.snapshot),
      },
      transport: 'online',
      reconcileRetry: EMPTY_RETRY,
      accessRetryId: null,
    },
    commands: cancelTimerCommand(state),
  }
}

function adoptRemote(
  state: WorkflowEditorDraftState,
  remote: WorkflowRemoteSnapshot,
): WorkflowDraftTransition {
  const nextRevision = state.revision + 1
  const snapshot = cloneSnapshot(remote.snapshot)
  return {
    state: {
      ...state,
      local: cloneSnapshot(snapshot),
      server: snapshot,
      serverRevision: { ...remote.revision },
      revision: nextRevision,
      savedRevision: nextRevision,
      inFlight: null,
      queuedRevision: null,
      phase: 'clean',
      error: null,
      conflict: null,
      transport: 'online',
      reconcileRetry: EMPTY_RETRY,
      history: resetWorkflowEditorHistory(state.history),
      accessRetryId: null,
    },
    commands: cancelTimerCommand(state),
  }
}

function terminalState(
  state: WorkflowEditorDraftState,
  phase: 'inaccessible' | 'deleted',
  error: WorkflowDraftFailure | null,
): WorkflowDraftTransition {
  return {
    state: {
      ...state,
      inFlight: null,
      queuedRevision: state.revision === state.savedRevision ? null : state.revision,
      phase,
      error,
      conflict: null,
      transport: 'online',
      reconcileRetry: EMPTY_RETRY,
      accessRetryId: null,
    },
    commands: cancelTimerCommand(state),
  }
}

function cloneSnapshot(snapshot: WorkflowDraftSnapshot): WorkflowDraftSnapshot {
  return immutableWorkflowEditorSnapshot(snapshot)
}

function revisionAtLeast(candidate: WorkflowRevision, baseline: WorkflowRevision): boolean {
  return (
    candidate.workflowId === baseline.workflowId &&
    (candidate.version > baseline.version ||
      (candidate.version === baseline.version && candidate.snapshotHash === baseline.snapshotHash))
  )
}

function cancelTimerCommand(state: WorkflowEditorDraftState): WorkflowDraftCommand[] {
  return state.reconcileRetry.nextAt === null ? [] : [{ type: 'CANCEL_RECONCILE_TIMER' }]
}

function unchanged(state: WorkflowEditorDraftState): WorkflowDraftTransition {
  return { state, commands: [] }
}

function unchangedWithTransport(
  state: WorkflowEditorDraftState,
  transport: WorkflowDraftTransport,
): WorkflowDraftTransition {
  return state.transport === transport
    ? unchanged(state)
    : { state: { ...state, transport }, commands: [] }
}

function commandOnly(
  state: WorkflowEditorDraftState,
  command: WorkflowDraftCommand,
): WorkflowDraftTransition {
  return { state, commands: [command] }
}
