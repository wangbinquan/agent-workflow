// RFC-199 B2 — React command runner for the pure workflow-editor draft model.
//
// The reducer owns all concurrency decisions. This hook only captures request
// bytes, executes its commands, correlates async outcomes, and translates
// browser/HTTP/WS lifecycle signals back into reducer events.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ulid } from 'ulid'
import {
  WorkflowDraftSnapshotSchema,
  WorkflowRevisionSchema,
  type SaveWorkflowReceipt,
  type UpdateWorkflow,
  type WorkflowDetail,
  type WorkflowDraftSnapshot,
  type WorkflowMutationId,
  type WorkflowSnapshotHash,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import {
  canRedoWorkflowEditorDraft,
  canUndoWorkflowEditorDraft,
  createWorkflowEditorDraftState,
  hashWorkflowDraftSnapshot,
  transitionWorkflowEditorDraft,
  workflowRemoteSnapshotFromDetail,
  type WorkflowDraftCommand,
  type WorkflowDraftFailure,
  type WorkflowDraftPhase,
  type WorkflowEditorDraftEvent,
  type WorkflowEditorDraftState,
  type WorkflowRemoteSnapshot,
  type WorkflowSaveAttempt,
} from '@/lib/workflow-editor-draft'
import type {
  WorkflowDraftChangeMeta,
  WorkflowEditorSelectionHint,
} from '@/lib/workflow-editor-history'
import type { WorkflowSyncFrame } from './useWorkflowSync'

// Keep the exported transport name specific to this controller: the reducer
// already uses "transport" for online/degraded/offline projection state.
export interface WorkflowEditorDraftControllerTransport {
  save(workflowId: string, input: UpdateWorkflow): Promise<SaveWorkflowReceipt>
  fetch(workflowId: string): Promise<WorkflowDetail>
}

export interface WorkflowEditorDraftScheduler {
  now(): number
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

export type WorkflowEditorDraftIntent =
  | {
      type: 'confirm-load-remote'
      current: WorkflowRemoteSnapshot['revision'] | null
    }
  | {
      type: 'confirm-overwrite'
      snapshot: WorkflowDraftSnapshot
      current: WorkflowRemoteSnapshot['revision'] | null
    }
  | {
      type: 'save-copy'
      snapshot: WorkflowDraftSnapshot
      suggestedName: string
    }

export interface UseWorkflowEditorDraftOptions {
  initial: WorkflowDetail | WorkflowRemoteSnapshot
  transport?: WorkflowEditorDraftControllerTransport
  debounceMs?: number
  /** Keeps a valid local draft dirty without emitting saves (for composite
   *  editors that currently own an invalid/transient sub-draft). */
  autosaveSuspended?: boolean
  scheduler?: WorkflowEditorDraftScheduler
  mutationIdFactory?: () => WorkflowMutationId
  hashSnapshot?: (snapshot: WorkflowDraftSnapshot) => Promise<WorkflowSnapshotHash>
  /** From useWorkflowSync; every positive change is an immediate wake. */
  connectionEpoch?: number
  /** From useWorkflowSync; false after a previously-open socket means degraded. */
  connected?: boolean
  /** Visibility/focus wakes are coalesced; online/WS/manual wakes are not. */
  ambientWakeThrottleMs?: number
  onIntent?: (intent: WorkflowEditorDraftIntent) => void
}

export interface UseWorkflowEditorDraftResult {
  state: WorkflowEditorDraftState
  inFlightMutationId: WorkflowMutationId | null
  intent: WorkflowEditorDraftIntent | null
  commit(snapshot: WorkflowDraftSnapshot, meta?: WorkflowDraftChangeMeta): void
  canUndo: boolean
  canRedo: boolean
  undo(): void
  redo(): void
  /** Semantic selection/focus restoration hint; viewport remains canvas-owned. */
  selectionHint: WorkflowEditorSelectionHint
  retry(): void
  remoteFrame(frame: WorkflowSyncFrame): void
  remoteDetail(detail: WorkflowDetail): void
  remoteInaccessible(error?: unknown): void
  requestLoadRemote(): void
  /** Safe to call directly after UI confirmation; no request* render is required. */
  confirmLoadRemote(): Promise<void>
  requestOverwrite(): void
  /** Safe to call directly after UI confirmation; always refetches the CAS base. */
  confirmOverwrite(): Promise<void>
  retryAccess(): void
  requestCopy(): void
  clearIntent(): void
  /** Flushes the latest composite snapshot and resolves only at exact server truth. */
  ensureSaved(options?: WorkflowEnsureSavedOptions): Promise<WorkflowSavedDraft>
  /** Async action fence: true only while this exact saved receipt is still current. */
  isSavedDraftCurrent(saved: WorkflowSavedDraft): boolean
}

export interface WorkflowEnsureSavedOptions {
  /** Cancels only this caller's barrier; the autosave/reconcile state keeps running. */
  signal?: AbortSignal
}

export interface WorkflowSavedDraft {
  /** Monotonic local revision acknowledged by the returned server revision. */
  revision: number
  server: WorkflowRemoteSnapshot['revision']
  snapshot: WorkflowDraftSnapshot
}

export type WorkflowEnsureSavedFailureReason =
  | Extract<WorkflowDraftPhase, 'error' | 'conflict' | 'inaccessible' | 'deleted'>
  | 'unavailable'
  | 'cancelled'

export class WorkflowEnsureSavedError extends Error {
  readonly code = 'workflow-draft-not-saveable'

  constructor(
    readonly reason: WorkflowEnsureSavedFailureReason,
    readonly transport: WorkflowEditorDraftState['transport'],
  ) {
    super(
      reason === 'cancelled'
        ? 'workflow save barrier was cancelled'
        : `workflow draft cannot be saved while ${reason}`,
    )
    this.name = 'WorkflowEnsureSavedError'
  }
}

interface EnsureSavedWaiter {
  workflowId: string
  resolve(value: WorkflowSavedDraft): void
  reject(error: WorkflowEnsureSavedError): void
  cleanup(): void
}

const DEFAULT_TRANSPORT: WorkflowEditorDraftControllerTransport = {
  save: (workflowId, input) =>
    api.put<SaveWorkflowReceipt>(`/api/workflows/${encodeURIComponent(workflowId)}`, input),
  fetch: (workflowId) =>
    api.get<WorkflowDetail>(`/api/workflows/${encodeURIComponent(workflowId)}`),
}

const DEFAULT_SCHEDULER: WorkflowEditorDraftScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
}

export function useWorkflowEditorDraft(
  options: UseWorkflowEditorDraftOptions,
): UseWorkflowEditorDraftResult {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const initialRemoteRef = useRef<WorkflowRemoteSnapshot | null>(null)
  if (initialRemoteRef.current === null) initialRemoteRef.current = normalizeRemote(options.initial)
  const [state, setState] = useState<WorkflowEditorDraftState>(() =>
    createWorkflowEditorDraftState(initialRemoteRef.current!),
  )
  const stateRef = useRef(state)
  const [intent, setIntentState] = useState<WorkflowEditorDraftIntent | null>(null)

  const mountedRef = useRef(false)
  const generationRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ensureIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ensureIdleRevisionRef = useRef<number | null>(null)
  const ensureWaitersRef = useRef(new Set<EnsureSavedWaiter>())
  const saveActiveRef = useRef<WorkflowMutationId | null>(null)
  const reconcileActiveRef = useRef<WorkflowMutationId | null>(null)
  const remoteFetchActiveRef = useRef<symbol | null>(null)
  const commandRunnerRef = useRef<(commands: readonly WorkflowDraftCommand[]) => void>(() => {})
  const ensureDriverRef = useRef<(next: WorkflowEditorDraftState) => void>(() => {})

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current === null) return
    ;(optionsRef.current.scheduler ?? DEFAULT_SCHEDULER).clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = null
  }, [])

  const clearReconcileTimer = useCallback(() => {
    if (reconcileTimerRef.current === null) return
    ;(optionsRef.current.scheduler ?? DEFAULT_SCHEDULER).clearTimeout(reconcileTimerRef.current)
    reconcileTimerRef.current = null
  }, [])

  const clearEnsureIdleTimer = useCallback(() => {
    if (ensureIdleTimerRef.current === null) return
    ;(optionsRef.current.scheduler ?? DEFAULT_SCHEDULER).clearTimeout(ensureIdleTimerRef.current)
    ensureIdleTimerRef.current = null
    ensureIdleRevisionRef.current = null
  }, [])

  const setIntent = useCallback((next: WorkflowEditorDraftIntent | null) => {
    setIntentState(next)
    if (next !== null) optionsRef.current.onIntent?.(next)
  }, [])

  const dispatchEvent = useCallback(
    (event: WorkflowEditorDraftEvent) => {
      const transition = transitionWorkflowEditorDraft(stateRef.current, event)
      stateRef.current = transition.state
      setState(transition.state)
      if (
        transition.state.phase === 'clean' ||
        transition.state.phase === 'conflict' ||
        transition.state.phase === 'inaccessible' ||
        transition.state.phase === 'deleted'
      ) {
        clearDebounceTimer()
      }
      commandRunnerRef.current(transition.commands)
      ensureDriverRef.current(transition.state)
      return transition
    },
    [clearDebounceTimer],
  )

  const isLive = useCallback((workflowId: string, generation: number): boolean => {
    return (
      mountedRef.current &&
      generationRef.current === generation &&
      stateRef.current.workflowId === workflowId
    )
  }, [])

  const prepareSave = useCallback(
    async (
      requestedRevision: number,
      mode: 'autosave' | 'overwrite' = 'autosave',
      expectedRemote?: WorkflowRemoteSnapshot,
      capturedSnapshot?: WorkflowDraftSnapshot,
      ensureIdleFence = false,
    ): Promise<void> => {
      if (mode === 'autosave' && optionsRef.current.autosaveSuspended === true) return
      const beforeHash = stateRef.current
      // ensureSaved's 300ms quiet period belongs to one exact revision. If a
      // stale timer fires after another keystroke, do not silently retarget it
      // to the newer revision and bypass that revision's own quiet period.
      if (ensureIdleFence && beforeHash.revision !== requestedRevision) {
        ensureDriverRef.current(beforeHash)
        return
      }
      if (beforeHash.revision !== requestedRevision && capturedSnapshot === undefined) {
        requestedRevision = beforeHash.revision
      }
      const workflowId = beforeHash.workflowId
      const generation = generationRef.current
      const revision = requestedRevision
      const snapshot = WorkflowDraftSnapshotSchema.parse(capturedSnapshot ?? beforeHash.local)
      const clientMutationId = (optionsRef.current.mutationIdFactory ?? defaultMutationId)()
      const hashSnapshot = optionsRef.current.hashSnapshot ?? hashWorkflowDraftSnapshot
      const snapshotHash = await hashSnapshot(snapshot)
      if (!isLive(workflowId, generation)) return
      // Hashing is asynchronous. A keystroke or caller cancellation that lands
      // after the 300ms timer but before the digest resolves must invalidate
      // this deferred attempt; the new revision receives a fresh quiet period,
      // while a cancelled exact action falls back to ordinary autosave.
      if (ensureIdleFence) {
        const current = stateRef.current
        if (
          ensureWaitersRef.current.size === 0 ||
          current.workflowId !== workflowId ||
          current.revision !== revision ||
          current.phase !== 'dirty' ||
          current.inFlight !== null
        ) {
          ensureDriverRef.current(current)
          return
        }
      }
      dispatchEvent({
        type: 'SAVE_REQUESTED',
        revision,
        clientMutationId,
        snapshot,
        snapshotHash,
        mode,
        ...(expectedRemote === undefined ? {} : { expectedRemote }),
      })
    },
    [dispatchEvent, isLive],
  )

  const runSave = useCallback(
    async (attempt: WorkflowSaveAttempt): Promise<void> => {
      if (saveActiveRef.current === attempt.clientMutationId) return
      saveActiveRef.current = attempt.clientMutationId
      const workflowId = stateRef.current.workflowId
      const generation = generationRef.current
      const input: UpdateWorkflow = {
        expectedVersion: attempt.expectedVersion,
        clientMutationId: attempt.clientMutationId,
        snapshot: attempt.snapshot,
      }
      try {
        const receipt = await (optionsRef.current.transport ?? DEFAULT_TRANSPORT).save(
          workflowId,
          input,
        )
        if (!isLive(workflowId, generation)) return
        saveActiveRef.current = null
        dispatchEvent({
          type: receipt.outcome === 'already-current' ? 'SAVE_ALREADY_CURRENT' : 'SAVE_COMMITTED',
          receipt,
        })
      } catch (error) {
        if (!isLive(workflowId, generation)) return
        saveActiveRef.current = null
        const failure = failureFromError(error)
        const current = revisionFromConflict(error)
        dispatchEvent({
          type: 'SAVE_FAILED',
          clientMutationId: attempt.clientMutationId,
          failure,
          ...(current === null ? {} : { current: { source: 'query' as const, revision: current } }),
        })
      } finally {
        if (saveActiveRef.current === attempt.clientMutationId) saveActiveRef.current = null
      }
    },
    [dispatchEvent, isLive],
  )

  const runReconcile = useCallback(
    async (attempt: WorkflowSaveAttempt): Promise<void> => {
      if (reconcileActiveRef.current === attempt.clientMutationId) return
      reconcileActiveRef.current = attempt.clientMutationId
      const workflowId = stateRef.current.workflowId
      const generation = generationRef.current
      try {
        const detail = await (optionsRef.current.transport ?? DEFAULT_TRANSPORT).fetch(workflowId)
        if (!isLive(workflowId, generation)) return
        reconcileActiveRef.current = null
        const remote = workflowRemoteSnapshotFromDetail(detail)
        dispatchEvent({
          type: 'RECONCILED',
          clientMutationId: attempt.clientMutationId,
          observation: remote,
        })
      } catch (error) {
        if (!isLive(workflowId, generation)) return
        reconcileActiveRef.current = null
        dispatchEvent({
          type: 'RECONCILE_FAILED',
          clientMutationId: attempt.clientMutationId,
          failure: failureFromError(error),
          now: (optionsRef.current.scheduler ?? DEFAULT_SCHEDULER).now(),
        })
      } finally {
        if (reconcileActiveRef.current === attempt.clientMutationId) {
          reconcileActiveRef.current = null
        }
      }
    },
    [dispatchEvent, isLive],
  )

  const fetchAndObserve = useCallback(async (): Promise<void> => {
    if (remoteFetchActiveRef.current !== null) return
    const fetchToken = Symbol('workflow-remote-fetch')
    remoteFetchActiveRef.current = fetchToken
    const workflowId = stateRef.current.workflowId
    const generation = generationRef.current
    try {
      const detail = await (optionsRef.current.transport ?? DEFAULT_TRANSPORT).fetch(workflowId)
      if (!isLive(workflowId, generation)) return
      const remote = workflowRemoteSnapshotFromDetail(detail)
      dispatchEvent({ type: 'REMOTE_OBSERVED', observation: { source: 'query', ...remote } })
      const observed = stateRef.current
      // A browser/WS wake is only a hint. The successful GET above is the
      // evidence that may release an offline queued edit, and it must happen
      // before the next save establishes a fresh expectedVersion.
      if (
        observed.phase === 'dirty' &&
        observed.inFlight === null &&
        observed.transport === 'online'
      ) {
        if (observed.queuedRevision !== null) {
          dispatchEvent({ type: 'TRANSPORT_CHANGED', transport: 'online' })
        } else {
          void prepareSave(observed.revision)
        }
      }
    } catch (error) {
      if (!isLive(workflowId, generation)) return
      const failure = failureFromError(error)
      if (failure.status === 403 || failure.status === 404) {
        dispatchEvent({ type: 'REMOTE_INACCESSIBLE', workflowId, failure })
      } else {
        dispatchEvent({
          type: 'TRANSPORT_CHANGED',
          transport: failure.kind === 'transport' ? 'offline' : 'degraded',
        })
      }
    } finally {
      if (remoteFetchActiveRef.current === fetchToken) remoteFetchActiveRef.current = null
    }
  }, [dispatchEvent, isLive, prepareSave])

  const retryAccessRequest = useCallback(
    async (requestId: string): Promise<void> => {
      const workflowId = stateRef.current.workflowId
      const generation = generationRef.current
      try {
        const detail = await (optionsRef.current.transport ?? DEFAULT_TRANSPORT).fetch(workflowId)
        if (!isLive(workflowId, generation)) return
        dispatchEvent({
          type: 'INACCESSIBLE_RETRY_SUCCEEDED',
          requestId,
          remote: workflowRemoteSnapshotFromDetail(detail),
        })
      } catch (error) {
        if (!isLive(workflowId, generation)) return
        dispatchEvent({
          type: 'INACCESSIBLE_RETRY_FAILED',
          requestId,
          failure: failureFromError(error),
        })
      }
    },
    [dispatchEvent, isLive],
  )

  const runCommands = useCallback(
    (commands: readonly WorkflowDraftCommand[]): void => {
      for (const command of commands) {
        switch (command.type) {
          case 'SEND_SAVE':
            clearDebounceTimer()
            void runSave(command.attempt)
            break
          case 'REQUEST_SAVE':
            void prepareSave(command.revision)
            break
          case 'RECONCILE':
            void runReconcile(command.attempt)
            break
          case 'SCHEDULE_RECONCILE': {
            clearReconcileTimer()
            const activeScheduler = optionsRef.current.scheduler ?? DEFAULT_SCHEDULER
            reconcileTimerRef.current = activeScheduler.setTimeout(() => {
              reconcileTimerRef.current = null
              dispatchEvent({ type: 'RECONCILE_TIMER_FIRED', now: activeScheduler.now() })
            }, command.delayMs)
            break
          }
          case 'CANCEL_RECONCILE_TIMER':
            clearReconcileTimer()
            break
          case 'FETCH_REMOTE':
            void fetchAndObserve()
            break
          case 'RETRY_ACCESS':
            void retryAccessRequest(command.requestId)
            break
          case 'CONFIRM_LOAD_REMOTE':
            setIntent({ type: 'confirm-load-remote', current: command.current })
            break
          case 'PREPARE_OVERWRITE':
            setIntent({
              type: 'confirm-overwrite',
              snapshot: command.snapshot,
              current: command.current,
            })
            break
          case 'SAVE_COPY':
            setIntent({
              type: 'save-copy',
              snapshot: command.snapshot,
              suggestedName: command.suggestedName,
            })
            break
        }
      }
    },
    [
      clearDebounceTimer,
      clearReconcileTimer,
      dispatchEvent,
      fetchAndObserve,
      prepareSave,
      retryAccessRequest,
      runReconcile,
      runSave,
      setIntent,
    ],
  )
  commandRunnerRef.current = runCommands

  const scheduleAutosave = useCallback(
    (revision: number): void => {
      clearDebounceTimer()
      if (optionsRef.current.autosaveSuspended === true) return
      const activeScheduler = optionsRef.current.scheduler ?? DEFAULT_SCHEDULER
      debounceTimerRef.current = activeScheduler.setTimeout(
        () => {
          debounceTimerRef.current = null
          void prepareSave(revision)
        },
        Math.max(0, optionsRef.current.debounceMs ?? 1_000),
      )
    },
    [clearDebounceTimer, prepareSave],
  )

  const rejectEnsureWaiters = useCallback(
    (
      reason: WorkflowEnsureSavedFailureReason,
      transport: WorkflowEditorDraftState['transport'],
    ): void => {
      clearEnsureIdleTimer()
      const error = new WorkflowEnsureSavedError(reason, transport)
      for (const waiter of ensureWaitersRef.current) waiter.reject(error)
      ensureWaitersRef.current.clear()
    },
    [clearEnsureIdleTimer],
  )

  const driveEnsureSaved = useCallback(
    (next: WorkflowEditorDraftState): void => {
      if (ensureWaitersRef.current.size === 0) {
        clearEnsureIdleTimer()
        return
      }

      for (const waiter of [...ensureWaitersRef.current]) {
        if (waiter.workflowId !== next.workflowId) {
          waiter.reject(new WorkflowEnsureSavedError('cancelled', next.transport))
          ensureWaitersRef.current.delete(waiter)
        }
      }
      if (ensureWaitersRef.current.size === 0) {
        clearEnsureIdleTimer()
        return
      }

      if (
        next.phase === 'error' ||
        next.phase === 'conflict' ||
        next.phase === 'inaccessible' ||
        next.phase === 'deleted'
      ) {
        rejectEnsureWaiters(next.phase, next.transport)
        return
      }

      // A response-ambiguous save remains owned by the reducer and will keep
      // reconciling after connectivity returns. Exact actions, however, must
      // not hold their interaction lock forever while the browser is offline.
      // Reject only their barrier; never discard the in-flight attempt/local
      // queue or interrupt the controller's recovery ledger.
      if (next.transport === 'offline') {
        rejectEnsureWaiters('unavailable', next.transport)
        return
      }

      if (
        next.phase === 'clean' &&
        next.inFlight === null &&
        next.revision === next.savedRevision
      ) {
        clearEnsureIdleTimer()
        const saved: WorkflowSavedDraft = {
          revision: next.revision,
          server: { ...next.serverRevision },
          snapshot: WorkflowDraftSnapshotSchema.parse(next.local),
        }
        for (const waiter of ensureWaitersRef.current) waiter.resolve(saved)
        ensureWaitersRef.current.clear()
        return
      }

      if (next.phase !== 'dirty' || next.inFlight !== null) {
        clearEnsureIdleTimer()
        return
      }

      if (ensureIdleTimerRef.current !== null && ensureIdleRevisionRef.current === next.revision) {
        return
      }
      clearEnsureIdleTimer()
      const activeScheduler = optionsRef.current.scheduler ?? DEFAULT_SCHEDULER
      const revision = next.revision
      ensureIdleRevisionRef.current = revision
      ensureIdleTimerRef.current = activeScheduler.setTimeout(() => {
        ensureIdleTimerRef.current = null
        ensureIdleRevisionRef.current = null
        const current = stateRef.current
        if (
          ensureWaitersRef.current.size === 0 ||
          current.workflowId !== next.workflowId ||
          current.revision !== revision
        ) {
          driveEnsureSaved(current)
          return
        }
        void prepareSave(revision, 'autosave', undefined, undefined, true)
      }, 300)
    },
    [clearEnsureIdleTimer, prepareSave, rejectEnsureWaiters],
  )
  ensureDriverRef.current = driveEnsureSaved

  const scheduleChangedLocalRevision = useCallback(
    (
      beforeRevision: number,
      transition: ReturnType<typeof transitionWorkflowEditorDraft>,
    ): void => {
      if (transition.state.revision === beforeRevision) return
      if (
        transition.state.phase === 'dirty' &&
        transition.state.inFlight === null &&
        transition.state.transport !== 'offline'
      ) {
        scheduleAutosave(transition.state.revision)
      }
    },
    [scheduleAutosave],
  )

  const commit = useCallback(
    (snapshot: WorkflowDraftSnapshot, meta?: WorkflowDraftChangeMeta): void => {
      const beforeRevision = stateRef.current.revision
      const committedAt = (optionsRef.current.scheduler ?? DEFAULT_SCHEDULER).now()
      const eventMeta: WorkflowDraftChangeMeta =
        meta === undefined
          ? { source: 'metadata', label: 'Edit workflow', transaction: 'single', committedAt }
          : { ...meta, committedAt }
      const transition = dispatchEvent({ type: 'LOCAL_COMMIT', snapshot, meta: eventMeta })
      scheduleChangedLocalRevision(beforeRevision, transition)
    },
    [dispatchEvent, scheduleChangedLocalRevision],
  )

  const undo = useCallback((): void => {
    const beforeRevision = stateRef.current.revision
    const transition = dispatchEvent({ type: 'UNDO' })
    scheduleChangedLocalRevision(beforeRevision, transition)
  }, [dispatchEvent, scheduleChangedLocalRevision])

  const redo = useCallback((): void => {
    const beforeRevision = stateRef.current.revision
    const transition = dispatchEvent({ type: 'REDO' })
    scheduleChangedLocalRevision(beforeRevision, transition)
  }, [dispatchEvent, scheduleChangedLocalRevision])

  const wake = useCallback(
    (transportEvidence = false): void => {
      clearDebounceTimer()
      const current = stateRef.current
      if (current.phase === 'reconciling' && current.inFlight !== null) {
        dispatchEvent({
          type: 'RECONCILE_WAKE',
          ...(transportEvidence ? { transport: 'online' as const } : {}),
        })
        return
      }
      void fetchAndObserve()
    },
    [clearDebounceTimer, dispatchEvent, fetchAndObserve],
  )

  const retry = useCallback((): void => {
    if (optionsRef.current.autosaveSuspended === true) return
    const current = stateRef.current
    if (current.phase === 'reconciling') {
      wake(false)
      return
    }
    if (current.phase !== 'dirty' && current.phase !== 'error') return
    clearDebounceTimer()
    if (current.transport === 'offline') {
      const transition = dispatchEvent({ type: 'TRANSPORT_CHANGED', transport: 'online' })
      if (transition.commands.length > 0) return
    }
    void prepareSave(stateRef.current.revision)
  }, [clearDebounceTimer, dispatchEvent, prepareSave, wake])

  const remoteFrame = useCallback(
    (frame: WorkflowSyncFrame): void => {
      if (frame.type === 'workflow.deleted') {
        dispatchEvent({
          type: 'REMOTE_DELETED',
          workflowId: frame.workflowId,
          clientMutationId: frame.clientMutationId,
          deletedVersion: frame.deletedVersion,
        })
        return
      }
      dispatchEvent({
        type: 'REMOTE_OBSERVED',
        observation: {
          source: 'ws',
          revision: {
            workflowId: frame.workflowId,
            version: frame.version,
            snapshotHash: frame.snapshotHash,
            updatedAt: frame.updatedAt,
          },
          clientMutationId: frame.clientMutationId,
        },
      })
    },
    [dispatchEvent],
  )

  const remoteDetail = useCallback(
    (detail: WorkflowDetail): void => {
      const remote = workflowRemoteSnapshotFromDetail(detail)
      dispatchEvent({ type: 'REMOTE_OBSERVED', observation: { source: 'query', ...remote } })
    },
    [dispatchEvent],
  )

  const remoteInaccessible = useCallback(
    (error?: unknown): void => {
      dispatchEvent({
        type: 'REMOTE_INACCESSIBLE',
        workflowId: stateRef.current.workflowId,
        ...(error === undefined ? {} : { failure: failureFromError(error) }),
      })
    },
    [dispatchEvent],
  )

  const requestLoadRemote = useCallback((): void => {
    dispatchEvent({ type: 'CONFLICT_LOAD_REMOTE_INTENT' })
  }, [dispatchEvent])

  const confirmLoadRemote = useCallback(async (): Promise<void> => {
    setIntent(null)
    const workflowId = stateRef.current.workflowId
    const generation = generationRef.current
    try {
      const detail = await (optionsRef.current.transport ?? DEFAULT_TRANSPORT).fetch(workflowId)
      if (!isLive(workflowId, generation)) return
      dispatchEvent({
        type: 'CONFLICT_LOAD_REMOTE_CONFIRMED',
        remote: workflowRemoteSnapshotFromDetail(detail),
      })
    } catch (error) {
      if (!isLive(workflowId, generation)) return
      const failure = failureFromError(error)
      if (failure.status === 403 || failure.status === 404) {
        dispatchEvent({ type: 'REMOTE_INACCESSIBLE', workflowId, failure })
      } else {
        dispatchEvent({
          type: 'TRANSPORT_CHANGED',
          transport: failure.kind === 'transport' ? 'offline' : 'degraded',
        })
      }
    }
  }, [dispatchEvent, isLive, setIntent])

  const requestOverwrite = useCallback((): void => {
    dispatchEvent({ type: 'CONFLICT_OVERWRITE_INTENT' })
  }, [dispatchEvent])

  const confirmOverwrite = useCallback(async (): Promise<void> => {
    setIntent(null)
    const captured = stateRef.current
    if (captured.phase !== 'conflict') return
    const workflowId = captured.workflowId
    const generation = generationRef.current
    const revision = captured.revision
    const snapshot = WorkflowDraftSnapshotSchema.parse(captured.local)
    try {
      const detail = await (optionsRef.current.transport ?? DEFAULT_TRANSPORT).fetch(workflowId)
      if (!isLive(workflowId, generation)) return
      await prepareSave(revision, 'overwrite', workflowRemoteSnapshotFromDetail(detail), snapshot)
    } catch (error) {
      if (!isLive(workflowId, generation)) return
      const failure = failureFromError(error)
      if (failure.status === 403 || failure.status === 404) {
        dispatchEvent({ type: 'REMOTE_INACCESSIBLE', workflowId, failure })
      } else {
        dispatchEvent({
          type: 'TRANSPORT_CHANGED',
          transport: failure.kind === 'transport' ? 'offline' : 'degraded',
        })
      }
    }
  }, [dispatchEvent, isLive, prepareSave, setIntent])

  const retryAccess = useCallback((): void => {
    const requestId = (optionsRef.current.mutationIdFactory ?? defaultMutationId)()
    dispatchEvent({ type: 'INACCESSIBLE_RETRY_REQUESTED', requestId })
  }, [dispatchEvent])

  const requestCopy = useCallback((): void => {
    dispatchEvent({ type: 'CONFLICT_SAVE_COPY_INTENT' })
  }, [dispatchEvent])

  const clearIntent = useCallback((): void => setIntent(null), [setIntent])

  const ensureSaved = useCallback(
    (options?: WorkflowEnsureSavedOptions): Promise<WorkflowSavedDraft> => {
      clearDebounceTimer()
      if (options?.signal?.aborted === true) {
        return Promise.reject(new WorkflowEnsureSavedError('cancelled', stateRef.current.transport))
      }
      return new Promise<WorkflowSavedDraft>((resolve, reject) => {
        const signal = options?.signal
        function cleanup(): void {
          signal?.removeEventListener('abort', onAbort)
        }
        function onAbort(): void {
          if (!ensureWaitersRef.current.delete(waiter)) return
          cleanup()
          reject(new WorkflowEnsureSavedError('cancelled', stateRef.current.transport))
          const current = stateRef.current
          driveEnsureSaved(current)
          // ensureSaved cancels the ordinary debounce while it owns the flush.
          // If the last caller cancels before a request starts, restore normal
          // autosave ownership so the retained dirty draft is not stranded.
          if (
            ensureWaitersRef.current.size === 0 &&
            current.phase === 'dirty' &&
            current.inFlight === null &&
            current.transport !== 'offline'
          ) {
            scheduleAutosave(current.revision)
          }
        }
        const waiter: EnsureSavedWaiter = {
          workflowId: stateRef.current.workflowId,
          resolve: (value) => {
            cleanup()
            resolve(value)
          },
          reject: (error) => {
            cleanup()
            reject(error)
          },
          cleanup,
        }
        ensureWaitersRef.current.add(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
        driveEnsureSaved(stateRef.current)
      })
    },
    [clearDebounceTimer, driveEnsureSaved, scheduleAutosave],
  )

  const isSavedDraftCurrent = useCallback((saved: WorkflowSavedDraft): boolean => {
    const current = stateRef.current
    return (
      current.phase === 'clean' &&
      current.inFlight === null &&
      current.revision === saved.revision &&
      current.savedRevision === saved.revision &&
      current.serverRevision.version === saved.server.version &&
      current.serverRevision.snapshotHash === saved.server.snapshotHash
    )
  }, [])

  const lastConnectionEpochRef = useRef(0)
  useEffect(() => {
    const epoch = options.connectionEpoch ?? 0
    if (epoch <= 0 || epoch === lastConnectionEpochRef.current) return
    lastConnectionEpochRef.current = epoch
    wake(true)
  }, [options.connectionEpoch, wake])

  useEffect(() => {
    if (options.autosaveSuspended === true) {
      clearDebounceTimer()
      return
    }
    const current = stateRef.current
    if (current.phase === 'dirty' && current.inFlight === null && current.transport !== 'offline') {
      scheduleAutosave(current.revision)
    }
  }, [clearDebounceTimer, options.autosaveSuspended, scheduleAutosave])

  const hasOpenedSocketRef = useRef((options.connectionEpoch ?? 0) > 0)
  useEffect(() => {
    if ((options.connectionEpoch ?? 0) > 0) hasOpenedSocketRef.current = true
    if (hasOpenedSocketRef.current && options.connected === false) {
      dispatchEvent({ type: 'TRANSPORT_CHANGED', transport: 'degraded' })
    }
  }, [dispatchEvent, options.connected, options.connectionEpoch])

  const lastAmbientWakeRef = useRef(Number.NEGATIVE_INFINITY)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const ambientWake = () => {
      const activeScheduler = optionsRef.current.scheduler ?? DEFAULT_SCHEDULER
      const now = activeScheduler.now()
      const throttle = Math.max(0, optionsRef.current.ambientWakeThrottleMs ?? 500)
      if (now - lastAmbientWakeRef.current < throttle) return
      lastAmbientWakeRef.current = now
      wake()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') ambientWake()
    }
    const onOnline = () => wake(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', ambientWake)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('focus', ambientWake)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [wake])

  const initialWorkflowId = remoteWorkflowId(options.initial)
  useEffect(() => {
    if (stateRef.current.workflowId === initialWorkflowId) return
    rejectEnsureWaiters('cancelled', stateRef.current.transport)
    clearDebounceTimer()
    clearReconcileTimer()
    generationRef.current += 1
    saveActiveRef.current = null
    reconcileActiveRef.current = null
    remoteFetchActiveRef.current = null
    const nextRemote = normalizeRemote(optionsRef.current.initial)
    initialRemoteRef.current = nextRemote
    const next = createWorkflowEditorDraftState(nextRemote)
    stateRef.current = next
    setState(next)
    setIntent(null)
    lastConnectionEpochRef.current = 0
  }, [clearDebounceTimer, clearReconcileTimer, initialWorkflowId, rejectEnsureWaiters, setIntent])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      clearDebounceTimer()
      clearReconcileTimer()
      rejectEnsureWaiters('cancelled', stateRef.current.transport)
    }
  }, [clearDebounceTimer, clearReconcileTimer, rejectEnsureWaiters])

  return {
    state,
    inFlightMutationId: state.inFlight?.clientMutationId ?? null,
    intent,
    commit,
    canUndo: canUndoWorkflowEditorDraft(state),
    canRedo: canRedoWorkflowEditorDraft(state),
    undo,
    redo,
    selectionHint: state.history.selectionHint,
    retry,
    remoteFrame,
    remoteDetail,
    remoteInaccessible,
    requestLoadRemote,
    confirmLoadRemote,
    requestOverwrite,
    confirmOverwrite,
    retryAccess,
    requestCopy,
    clearIntent,
    ensureSaved,
    isSavedDraftCurrent,
  }
}

function normalizeRemote(input: WorkflowDetail | WorkflowRemoteSnapshot): WorkflowRemoteSnapshot {
  return isRemoteSnapshot(input) ? input : workflowRemoteSnapshotFromDetail(input)
}

function isRemoteSnapshot(
  input: WorkflowDetail | WorkflowRemoteSnapshot,
): input is WorkflowRemoteSnapshot {
  return 'revision' in input && 'snapshot' in input
}

function remoteWorkflowId(input: WorkflowDetail | WorkflowRemoteSnapshot): string {
  return isRemoteSnapshot(input) ? input.revision.workflowId : input.id
}

function defaultMutationId(): WorkflowMutationId {
  return ulid() as WorkflowMutationId
}

function failureFromError(error: unknown): WorkflowDraftFailure {
  // RFC-203 impl-gate P2 follow-up: the fetch boundary tags genuine network
  // failures as ApiError(status 0, 'network-unreachable'). Status 0 means the
  // request never produced an HTTP verdict — the save may or may not have
  // landed — so it MUST classify as a transport loss (offline + reconcile,
  // RFC-199 G1), never as a definitive http failure. The e2e weak-network
  // suite (rfc199-save-reliability.spec.ts) locks this end-to-end.
  if (error instanceof ApiError && error.status !== 0) {
    return { kind: 'http', status: error.status, message: error.message }
  }
  return {
    kind: 'transport',
    message: error instanceof Error ? error.message : String(error),
  }
}

function revisionFromConflict(error: unknown): WorkflowRemoteSnapshot['revision'] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  if (typeof error.details !== 'object' || error.details === null) return null
  const parsed = WorkflowRevisionSchema.safeParse((error.details as { current?: unknown }).current)
  return parsed.success ? parsed.data : null
}
