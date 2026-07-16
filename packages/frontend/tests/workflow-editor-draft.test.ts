// RFC-199 B2 regression lock: saves are exact, single-flight attempts and
// response-loss reconciliation must never turn unsaved local edits into a
// false "saved" state.

import { describe, expect, test } from 'vitest'
import type {
  SaveWorkflowReceipt,
  WorkflowDraftSnapshot,
  WorkflowMutationId,
  WorkflowRevision,
  WorkflowSnapshotHash,
} from '@agent-workflow/shared'
import {
  createWorkflowEditorDraftState,
  hashWorkflowDraftSnapshot,
  isWorkflowDraftUnsafeToLeave,
  prepareWorkflowDraftSaveEvent,
  transitionWorkflowEditorDraft,
  workflowDraftSnapshotBytes,
  workflowReconcileBackoffMs,
  type WorkflowEditorDraftState,
  type WorkflowRemoteObservation,
  type WorkflowRemoteSnapshot,
  type WorkflowSaveAttempt,
} from '@/lib/workflow-editor-draft'

const MUTATION_A = '01KXF000000000000000000001' as WorkflowMutationId
const MUTATION_B = '01KXF000000000000000000002' as WorkflowMutationId
const MUTATION_C = '01KXF000000000000000000003' as WorkflowMutationId

function hash(char: string): WorkflowSnapshotHash {
  return char.repeat(64) as WorkflowSnapshotHash
}

function snapshot(description = 'base', name = 'workflow'): WorkflowDraftSnapshot {
  return {
    name,
    description,
    definition: {
      $schema_version: 4,
      inputs: [],
      nodes: [],
      edges: [],
    },
  }
}

function revision(
  version: number,
  snapshotHash: WorkflowSnapshotHash,
  updatedAt = version * 100,
): WorkflowRevision {
  return { workflowId: 'wf-1', version, snapshotHash, updatedAt }
}

function remote(version = 1, value = snapshot(), snapshotHash = hash('a')): WorkflowRemoteSnapshot {
  return { revision: revision(version, snapshotHash), snapshot: value }
}

function initial(): WorkflowEditorDraftState {
  return createWorkflowEditorDraftState(remote())
}

function localCommit(
  state: WorkflowEditorDraftState,
  value: WorkflowDraftSnapshot,
): WorkflowEditorDraftState {
  return transitionWorkflowEditorDraft(state, { type: 'LOCAL_COMMIT', snapshot: value }).state
}

function requestSave(
  state: WorkflowEditorDraftState,
  clientMutationId = MUTATION_A,
  snapshotHash = hash('b'),
) {
  return transitionWorkflowEditorDraft(state, {
    type: 'SAVE_REQUESTED',
    revision: state.revision,
    clientMutationId,
    snapshot: state.local,
    snapshotHash,
  })
}

function receipt(
  attempt: WorkflowSaveAttempt,
  nextRevision: WorkflowRevision,
  outcome: SaveWorkflowReceipt['outcome'] = 'committed',
): SaveWorkflowReceipt {
  return {
    clientMutationId: attempt.clientMutationId,
    requestedBaseVersion: attempt.expectedVersion,
    revision: nextRevision,
    snapshot: attempt.snapshot,
    outcome,
  }
}

function uncertainSave(state: WorkflowEditorDraftState): WorkflowEditorDraftState {
  const started = requestSave(localCommit(state, snapshot('attempt')))
  const attempt = started.state.inFlight!
  const failed = transitionWorkflowEditorDraft(started.state, {
    type: 'SAVE_FAILED',
    clientMutationId: attempt.clientMutationId,
    failure: { kind: 'transport', message: 'response lost' },
  })
  expect(failed.commands).toEqual([{ type: 'RECONCILE', attempt, trigger: 'save-uncertain' }])
  return failed.state
}

describe('RFC-199 composite workflow draft', () => {
  test('canonical browser bytes/hash are stable and domain-separated', async () => {
    const a = snapshot('same')
    const b = {
      definition: { nodes: [], edges: [], inputs: [], $schema_version: 4 as const },
      description: 'same',
      name: 'workflow',
    }

    expect(new TextDecoder().decode(workflowDraftSnapshotBytes(a))).toMatch(
      /^workflow-editable-snapshot\/v1\n\{/,
    )
    await expect(hashWorkflowDraftSnapshot(a)).resolves.toMatch(/^[0-9a-f]{64}$/)
    await expect(hashWorkflowDraftSnapshot(b)).resolves.toBe(await hashWorkflowDraftSnapshot(a))
    await expect(hashWorkflowDraftSnapshot(snapshot('different'))).resolves.not.toBe(
      await hashWorkflowDraftSnapshot(a),
    )
  })

  test('LOCAL_COMMIT is monotonic; one in-flight save coalesces three edits', () => {
    const first = snapshot('first')
    let state = localCommit(initial(), first)
    expect(state).toMatchObject({
      revision: 1,
      savedRevision: 0,
      phase: 'dirty',
      history: { epoch: 0, cursor: 1 },
    })

    const started = requestSave(state)
    state = started.state
    expect(started.commands).toHaveLength(1)
    expect(started.commands[0]).toMatchObject({ type: 'SEND_SAVE', attempt: { revision: 1 } })
    const attempt = state.inFlight!
    expect(attempt.snapshot).toEqual(first)

    state = localCommit(state, snapshot('second'))
    state = localCommit(state, snapshot('third'))
    state = localCommit(state, snapshot('latest'))
    expect(state).toMatchObject({ revision: 4, queuedRevision: 4, phase: 'saving' })
    expect(state.inFlight).toBe(attempt)
    expect(attempt.snapshot).toEqual(first)

    const duplicateDebounce = requestSave(state, MUTATION_B, hash('c'))
    expect(duplicateDebounce.commands).toEqual([])
    expect(duplicateDebounce.state.inFlight).toBe(attempt)
    expect(duplicateDebounce.state.queuedRevision).toBe(4)

    const settled = transitionWorkflowEditorDraft(duplicateDebounce.state, {
      type: 'SAVE_COMMITTED',
      receipt: receipt(attempt, revision(2, attempt.snapshotHash)),
    })
    expect(settled.state).toMatchObject({
      local: snapshot('latest'),
      server: first,
      revision: 4,
      savedRevision: 1,
      queuedRevision: 4,
      phase: 'dirty',
      inFlight: null,
      history: { epoch: 0, cursor: 4 },
    })
    expect(settled.commands).toEqual([{ type: 'REQUEST_SAVE', revision: 4 }])
  })

  test('typing that supersedes an async hash cannot pair stale bytes with the latest revision', async () => {
    const revisionOne = localCommit(initial(), snapshot('hashing revision one'))
    const pendingEvent = prepareWorkflowDraftSaveEvent(revisionOne, MUTATION_A)
    const revisionTwo = localCommit(revisionOne, snapshot('typed during hash'))
    const staleEvent = await pendingEvent

    expect(staleEvent).toMatchObject({
      revision: 1,
      snapshot: snapshot('hashing revision one'),
    })
    const rejected = transitionWorkflowEditorDraft(revisionTwo, staleEvent)
    expect(rejected.state).toMatchObject({
      local: snapshot('typed during hash'),
      revision: 2,
      queuedRevision: 2,
      inFlight: null,
      phase: 'dirty',
    })
    expect(rejected.commands).toEqual([{ type: 'REQUEST_SAVE', revision: 2 }])
  })

  test('receipt only acknowledges its submitted revision and mismatches fail closed', () => {
    const started = requestSave(localCommit(initial(), snapshot('submitted')))
    const attempt = started.state.inFlight!
    const before = started.state

    const wrongMutation = transitionWorkflowEditorDraft(before, {
      type: 'SAVE_COMMITTED',
      receipt: { ...receipt(attempt, revision(2, hash('b'))), clientMutationId: MUTATION_B },
    })
    expect(wrongMutation.state).toBe(before)

    const wrongWorkflow = transitionWorkflowEditorDraft(before, {
      type: 'SAVE_COMMITTED',
      receipt: {
        ...receipt(attempt, revision(2, hash('b'))),
        revision: { ...revision(2, hash('b')), workflowId: 'wf-other' },
      },
    })
    expect(wrongWorkflow.state).toBe(before)

    const wrongBase = transitionWorkflowEditorDraft(before, {
      type: 'SAVE_COMMITTED',
      receipt: { ...receipt(attempt, revision(2, hash('b'))), requestedBaseVersion: 99 },
    })
    expect(wrongBase.state).toBe(before)

    const settled = transitionWorkflowEditorDraft(before, {
      type: 'SAVE_COMMITTED',
      receipt: receipt(attempt, revision(2, attempt.snapshotHash)),
    })
    expect(settled.state).toMatchObject({
      local: snapshot('submitted'),
      server: snapshot('submitted'),
      revision: 1,
      savedRevision: 1,
      phase: 'clean',
      history: { epoch: 0, cursor: 1 },
      inFlight: null,
    })
    expect(isWorkflowDraftUnsafeToLeave(settled.state)).toBe(false)
  })

  test('SAVE_ALREADY_CURRENT settles only the matching already-current receipt', () => {
    const started = requestSave(localCommit(initial(), snapshot('same logical')))
    const attempt = started.state.inFlight!
    const settled = transitionWorkflowEditorDraft(started.state, {
      type: 'SAVE_ALREADY_CURRENT',
      receipt: receipt(attempt, revision(1, attempt.snapshotHash), 'already-current'),
    })

    expect(settled.state.phase).toBe('clean')
    expect(settled.state.savedRevision).toBe(1)
    expect(settled.state.server).toEqual(snapshot('same logical'))
  })

  test('own WS before HTTP never overwrites; query-before-receipt may defensively settle', () => {
    const started = requestSave(localCommit(initial(), snapshot('submitted')))
    const attempt = started.state.inFlight!
    const ownWs: WorkflowRemoteObservation = {
      source: 'ws',
      revision: revision(2, attempt.snapshotHash),
      clientMutationId: attempt.clientMutationId,
    }

    const echoed = transitionWorkflowEditorDraft(started.state, {
      type: 'REMOTE_OBSERVED',
      observation: ownWs,
    })
    expect(echoed.state.local).toEqual(snapshot('submitted'))
    expect(echoed.state.phase).toBe('saving')
    expect(echoed.state.inFlight).toBe(attempt)
    expect(echoed.commands).toEqual([])

    const queryFirst = transitionWorkflowEditorDraft(started.state, {
      type: 'REMOTE_OBSERVED',
      observation: {
        source: 'query',
        revision: revision(2, attempt.snapshotHash),
        snapshot: snapshot('submitted'),
      },
    })
    expect(queryFirst.state).toMatchObject({ phase: 'clean', inFlight: null, savedRevision: 1 })

    const lateReceipt = transitionWorkflowEditorDraft(queryFirst.state, {
      type: 'SAVE_COMMITTED',
      receipt: receipt(attempt, revision(2, attempt.snapshotHash)),
    })
    expect(lateReceipt.state).toBe(queryFirst.state)
  })

  test('clean follows remote; dirty freezes local in conflict; conflict tracks newer remote', () => {
    const followed = transitionWorkflowEditorDraft(initial(), {
      type: 'REMOTE_OBSERVED',
      observation: {
        source: 'query',
        revision: revision(2, hash('c')),
        snapshot: snapshot('remote-2'),
      },
    })
    expect(followed.state).toMatchObject({
      local: snapshot('remote-2'),
      server: snapshot('remote-2'),
      revision: 1,
      savedRevision: 1,
      phase: 'clean',
      history: { epoch: 1, cursor: 0 },
    })

    const dirty = localCommit(initial(), snapshot('local-unsaved'))
    const conflicted = transitionWorkflowEditorDraft(dirty, {
      type: 'REMOTE_OBSERVED',
      observation: {
        source: 'query',
        revision: revision(2, hash('c')),
        snapshot: snapshot('remote-2'),
      },
    })
    expect(conflicted.state).toMatchObject({
      local: snapshot('local-unsaved'),
      phase: 'conflict',
      queuedRevision: 1,
      history: { epoch: 0, cursor: 1 },
      conflict: { current: revision(2, hash('c')), snapshot: snapshot('remote-2') },
    })

    const newer = transitionWorkflowEditorDraft(conflicted.state, {
      type: 'REMOTE_OBSERVED',
      observation: {
        source: 'query',
        revision: revision(3, hash('d')),
        snapshot: snapshot('remote-3'),
      },
    })
    expect(newer.state.local).toEqual(snapshot('local-unsaved'))
    expect(newer.state.conflict).toMatchObject({
      current: revision(3, hash('d')),
      snapshot: snapshot('remote-3'),
    })

    const editedAgain = localCommit(newer.state, snapshot('local-after-conflict'))
    expect(editedAgain).toMatchObject({
      local: snapshot('local-after-conflict'),
      revision: 2,
      queuedRevision: 2,
      phase: 'conflict',
    })
  })

  test('conflict recovery exposes load/overwrite/copy signals and confirmed load is monotonic', () => {
    const dirty = localCommit(initial(), snapshot('local-unsaved'))
    const conflicted = transitionWorkflowEditorDraft(dirty, {
      type: 'REMOTE_OBSERVED',
      observation: {
        source: 'query',
        revision: revision(2, hash('c')),
        snapshot: snapshot('remote-2'),
      },
    }).state

    expect(
      transitionWorkflowEditorDraft(conflicted, { type: 'CONFLICT_LOAD_REMOTE_INTENT' }).commands,
    ).toEqual([{ type: 'CONFIRM_LOAD_REMOTE', current: revision(2, hash('c')) }])
    expect(
      transitionWorkflowEditorDraft(conflicted, { type: 'CONFLICT_OVERWRITE_INTENT' }).commands,
    ).toEqual([
      {
        type: 'PREPARE_OVERWRITE',
        snapshot: snapshot('local-unsaved'),
        current: revision(2, hash('c')),
      },
    ])
    expect(
      transitionWorkflowEditorDraft(conflicted, { type: 'CONFLICT_SAVE_COPY_INTENT' }).commands,
    ).toEqual([
      {
        type: 'SAVE_COPY',
        snapshot: snapshot('local-unsaved'),
        suggestedName: 'workflow-copy',
      },
    ])

    const staleLoad = transitionWorkflowEditorDraft(conflicted, {
      type: 'CONFLICT_LOAD_REMOTE_CONFIRMED',
      remote: remote(1, snapshot('stale remote'), hash('a')),
    })
    expect(staleLoad.state).toBe(conflicted)
    expect(staleLoad.commands).toEqual([{ type: 'FETCH_REMOTE' }])

    const v2Started = requestSave(
      localCommit(
        createWorkflowEditorDraftState(remote(2, snapshot('server-v2'), hash('2'))),
        snapshot('v2-local'),
      ),
    )
    const noCurrentConflict = transitionWorkflowEditorDraft(v2Started.state, {
      type: 'SAVE_FAILED',
      clientMutationId: v2Started.state.inFlight!.clientMutationId,
      failure: { kind: 'http', status: 409, message: 'details omitted' },
    }).state
    expect(noCurrentConflict.conflict?.current).toBeNull()
    const olderThanServer = transitionWorkflowEditorDraft(noCurrentConflict, {
      type: 'CONFLICT_LOAD_REMOTE_CONFIRMED',
      remote: remote(1, snapshot('older than known server'), hash('1')),
    })
    expect(olderThanServer.state).toBe(noCurrentConflict)
    expect(olderThanServer.commands).toEqual([{ type: 'FETCH_REMOTE' }])

    const loaded = transitionWorkflowEditorDraft(conflicted, {
      type: 'CONFLICT_LOAD_REMOTE_CONFIRMED',
      remote: remote(3, snapshot('latest-remote'), hash('d')),
    })
    expect(loaded.state).toMatchObject({
      local: snapshot('latest-remote'),
      server: snapshot('latest-remote'),
      serverRevision: revision(3, hash('d')),
      revision: 2,
      savedRevision: 2,
      phase: 'clean',
      conflict: null,
      history: { epoch: 1, cursor: 0 },
    })
  })

  test('active reconciliation prioritizes submitted-hash, same-base retry, then advanced conflict', () => {
    const reconciling = uncertainSave(initial())
    const attempt = reconciling.inFlight!

    // Even an advanced version is success when canonical bytes equal the
    // submitted attempt (response loss followed by another logical no-op).
    const sameSubmitted = transitionWorkflowEditorDraft(reconciling, {
      type: 'RECONCILED',
      clientMutationId: attempt.clientMutationId,
      observation: {
        revision: revision(7, attempt.snapshotHash),
        snapshot: attempt.snapshot,
      },
    })
    expect(sameSubmitted.state).toMatchObject({
      phase: 'clean',
      inFlight: null,
      serverRevision: revision(7, attempt.snapshotHash),
    })

    const sameBase = transitionWorkflowEditorDraft(reconciling, {
      type: 'RECONCILED',
      clientMutationId: attempt.clientMutationId,
      observation: {
        revision: revision(attempt.expectedVersion, hash('a')),
        snapshot: snapshot('base'),
      },
    })
    expect(sameBase.state.phase).toBe('saving')
    expect(sameBase.state.inFlight).toBe(attempt)
    expect(sameBase.commands).toEqual([{ type: 'SEND_SAVE', attempt }])

    const advancedDifferent = transitionWorkflowEditorDraft(reconciling, {
      type: 'RECONCILED',
      clientMutationId: attempt.clientMutationId,
      observation: {
        revision: revision(attempt.expectedVersion + 1, hash('f')),
        snapshot: snapshot('foreign'),
      },
    })
    expect(advancedDifferent.state).toMatchObject({
      local: snapshot('attempt'),
      phase: 'conflict',
      inFlight: null,
      conflict: {
        current: revision(attempt.expectedVersion + 1, hash('f')),
        snapshot: snapshot('foreign'),
      },
    })

    const staleRead = transitionWorkflowEditorDraft(reconciling, {
      type: 'RECONCILED',
      clientMutationId: MUTATION_B,
      observation: {
        revision: revision(9, hash('9')),
        snapshot: snapshot('stale operation result'),
      },
    })
    expect(staleRead.state).toBe(reconciling)

    const v2Reconciling = uncertainSave(
      createWorkflowEditorDraftState(remote(2, snapshot('v2-base'), hash('2'))),
    )
    const v2Attempt = v2Reconciling.inFlight!
    const oldSameHash = transitionWorkflowEditorDraft(v2Reconciling, {
      type: 'RECONCILED',
      clientMutationId: v2Attempt.clientMutationId,
      observation: {
        revision: revision(1, v2Attempt.snapshotHash),
        snapshot: v2Attempt.snapshot,
      },
    })
    expect(oldSameHash.state).toMatchObject({
      phase: 'reconciling',
      inFlight: v2Attempt,
      serverRevision: revision(2, hash('2')),
      transport: 'online',
    })
    expect(oldSameHash.commands).toEqual([])
  })

  test.each([429, 503])(
    'HTTP %s is uncertain: reconcile first, then use capped backoff if GET fails',
    (status) => {
      const started = requestSave(localCommit(initial(), snapshot(`attempt-${status}`)))
      const attempt = started.state.inFlight!
      const uncertain = transitionWorkflowEditorDraft(started.state, {
        type: 'SAVE_FAILED',
        clientMutationId: attempt.clientMutationId,
        failure: { kind: 'http', status, message: `HTTP ${status}` },
      })
      expect(uncertain.state).toMatchObject({
        phase: 'reconciling',
        inFlight: attempt,
        transport: 'degraded',
      })
      expect(uncertain.commands).toEqual([
        { type: 'RECONCILE', attempt, trigger: 'save-uncertain' },
      ])

      const getFailed = transitionWorkflowEditorDraft(uncertain.state, {
        type: 'RECONCILE_FAILED',
        clientMutationId: attempt.clientMutationId,
        failure: { kind: 'http', status: 503, message: 'GET unavailable' },
        now: 2_000,
      })
      expect(getFailed.commands).toEqual([
        { type: 'SCHEDULE_RECONCILE', delayMs: 1_000, at: 3_000 },
      ])
    },
  )

  test('queued local intent survives response-loss reconciliation before it is submitted', () => {
    let state = uncertainSave(initial())
    const attempt = state.inFlight!
    state = localCommit(state, snapshot('typed while offline'))
    expect(state.queuedRevision).toBe(2)

    const settled = transitionWorkflowEditorDraft(state, {
      type: 'RECONCILED',
      clientMutationId: attempt.clientMutationId,
      observation: { revision: revision(2, attempt.snapshotHash) },
    })
    expect(settled.state).toMatchObject({
      local: snapshot('typed while offline'),
      server: snapshot('attempt'),
      savedRevision: 1,
      revision: 2,
      queuedRevision: 2,
      phase: 'dirty',
    })
    expect(settled.commands).toEqual([{ type: 'REQUEST_SAVE', revision: 2 }])
  })

  test('reconciliation fake-clock backoff is 1/2/4/8/15 seconds and caps', () => {
    let state = uncertainSave(initial())
    const attempt = state.inFlight!
    let now = 10_000
    const expected = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]

    expect(expected.map((_, index) => workflowReconcileBackoffMs(index + 1))).toEqual(expected)
    for (const delayMs of expected) {
      const failed = transitionWorkflowEditorDraft(state, {
        type: 'RECONCILE_FAILED',
        clientMutationId: attempt.clientMutationId,
        failure: { kind: 'transport', message: 'still offline' },
        now,
      })
      expect(failed.state.transport).toBe('offline')
      expect(failed.state.reconcileRetry.nextAt).toBe(now + delayMs)
      expect(failed.commands).toEqual([{ type: 'SCHEDULE_RECONCILE', delayMs, at: now + delayMs }])

      const early = transitionWorkflowEditorDraft(failed.state, {
        type: 'RECONCILE_TIMER_FIRED',
        now: now + delayMs - 1,
      })
      expect(early.commands).toEqual([])
      const due = transitionWorkflowEditorDraft(failed.state, {
        type: 'RECONCILE_TIMER_FIRED',
        now: now + delayMs,
      })
      expect(due.commands).toEqual([{ type: 'RECONCILE', attempt, trigger: 'timer' }])
      expect(due.state.reconcileRetry.nextAt).toBeNull()
      state = due.state
      now += delayMs
    }
  })

  test('WS/online wake cancels retry wait; offline edits coalesce without minting in-flight', () => {
    const reconciling = uncertainSave(initial())
    const attempt = reconciling.inFlight!
    const scheduled = transitionWorkflowEditorDraft(reconciling, {
      type: 'RECONCILE_FAILED',
      clientMutationId: attempt.clientMutationId,
      failure: { kind: 'transport', message: 'offline' },
      now: 5_000,
    }).state
    const wake = transitionWorkflowEditorDraft(scheduled, {
      type: 'RECONCILE_WAKE',
      transport: 'online',
    })
    expect(wake.state.reconcileRetry.nextAt).toBeNull()
    expect(wake.commands).toEqual([
      { type: 'CANCEL_RECONCILE_TIMER' },
      { type: 'RECONCILE', attempt, trigger: 'wake' },
    ])

    let offline = transitionWorkflowEditorDraft(initial(), {
      type: 'TRANSPORT_CHANGED',
      transport: 'offline',
    }).state
    offline = localCommit(offline, snapshot('one'))
    offline = localCommit(offline, snapshot('latest'))
    expect(offline).toMatchObject({ queuedRevision: 2, phase: 'dirty' })
    const directReconnect = transitionWorkflowEditorDraft(offline, {
      type: 'TRANSPORT_CHANGED',
      transport: 'online',
    })
    expect(directReconnect.commands).toEqual([{ type: 'REQUEST_SAVE', revision: 2 }])
    const requested = requestSave(offline, MUTATION_C, hash('e'))
    expect(requested.state).toMatchObject({
      phase: 'dirty',
      inFlight: null,
      queuedRevision: 2,
    })
    expect(requested.commands).toEqual([])

    const online = transitionWorkflowEditorDraft(requested.state, {
      type: 'TRANSPORT_CHANGED',
      transport: 'online',
    })
    expect(online.commands).toEqual([{ type: 'REQUEST_SAVE', revision: 2 }])
  })

  test('save phase and transport remain orthogonal', () => {
    const degradedClean = transitionWorkflowEditorDraft(initial(), {
      type: 'TRANSPORT_CHANGED',
      transport: 'degraded',
    }).state
    expect(degradedClean).toMatchObject({ phase: 'clean', transport: 'degraded' })
    expect(isWorkflowDraftUnsafeToLeave(degradedClean)).toBe(false)

    const saving = requestSave(localCommit(degradedClean, snapshot('dirty'))).state
    expect(saving).toMatchObject({ phase: 'saving', transport: 'degraded' })
    const offlineSaving = transitionWorkflowEditorDraft(saving, {
      type: 'TRANSPORT_CHANGED',
      transport: 'offline',
    }).state
    expect(offlineSaving).toMatchObject({ phase: 'saving', transport: 'offline' })
    expect(isWorkflowDraftUnsafeToLeave(offlineSaving)).toBe(true)
  })

  test('403/404 are inaccessible, while explicit delete is distinctly deleted', () => {
    const started = requestSave(localCommit(initial(), snapshot('preserve me')))
    const attempt = started.state.inFlight!
    const forbidden = transitionWorkflowEditorDraft(started.state, {
      type: 'SAVE_FAILED',
      clientMutationId: attempt.clientMutationId,
      failure: { kind: 'http', status: 403, message: 'forbidden' },
    })
    expect(forbidden.state).toMatchObject({
      local: snapshot('preserve me'),
      phase: 'inaccessible',
      inFlight: null,
      queuedRevision: 1,
    })
    expect(isWorkflowDraftUnsafeToLeave(forbidden.state)).toBe(true)
    expect(
      transitionWorkflowEditorDraft(forbidden.state, {
        type: 'CONFLICT_SAVE_COPY_INTENT',
      }).commands,
    ).toMatchObject([{ type: 'SAVE_COPY', snapshot: snapshot('preserve me') }])

    const ambientOldFrame = transitionWorkflowEditorDraft(forbidden.state, {
      type: 'REMOTE_OBSERVED',
      observation: {
        source: 'ws',
        revision: revision(1, hash('a')),
        snapshot: snapshot('base'),
      },
    })
    expect(ambientOldFrame.state.phase).toBe('inaccessible')
    expect(ambientOldFrame.commands).toEqual([])

    const retryRequested = transitionWorkflowEditorDraft(forbidden.state, {
      type: 'INACCESSIBLE_RETRY_REQUESTED',
      requestId: 'access-1',
    })
    expect(retryRequested.commands).toEqual([{ type: 'RETRY_ACCESS', requestId: 'access-1' }])
    const staleRetry = transitionWorkflowEditorDraft(retryRequested.state, {
      type: 'INACCESSIBLE_RETRY_SUCCEEDED',
      requestId: 'access-stale',
      remote: remote(1, snapshot('base'), hash('a')),
    })
    expect(staleRetry.state).toBe(retryRequested.state)

    const accessRestored = transitionWorkflowEditorDraft(retryRequested.state, {
      type: 'INACCESSIBLE_RETRY_SUCCEEDED',
      requestId: 'access-1',
      remote: remote(1, snapshot('base'), hash('a')),
    })
    expect(accessRestored.state).toMatchObject({
      phase: 'dirty',
      local: snapshot('preserve me'),
      queuedRevision: 1,
      error: null,
      transport: 'online',
      accessRetryId: null,
      history: { epoch: 0, cursor: 1 },
    })
    expect(accessRestored.commands).toEqual([{ type: 'REQUEST_SAVE', revision: 1 }])

    const deleted = transitionWorkflowEditorDraft(started.state, {
      type: 'REMOTE_DELETED',
      workflowId: 'wf-1',
      clientMutationId: MUTATION_B,
      deletedVersion: 2,
    })
    expect(deleted.state).toMatchObject({
      local: snapshot('preserve me'),
      phase: 'deleted',
      inFlight: null,
      history: { epoch: 0, cursor: 1 },
    })
    expect(deleted.state.error).toBeNull()

    const hiddenAfterGet = transitionWorkflowEditorDraft(uncertainSave(initial()), {
      type: 'RECONCILE_FAILED',
      clientMutationId: MUTATION_A,
      failure: { kind: 'http', status: 404, message: 'not found' },
      now: 1,
    })
    expect(hiddenAfterGet.state.phase).toBe('inaccessible')
  })

  test('409 pauses autosave; overwrite requires a fresh non-stale remote revision', () => {
    const started = requestSave(localCommit(initial(), snapshot('local')))
    const attempt = started.state.inFlight!
    const conflictRevision = revision(3, hash('f'))
    const conflicted = transitionWorkflowEditorDraft(started.state, {
      type: 'SAVE_FAILED',
      clientMutationId: attempt.clientMutationId,
      failure: { kind: 'http', status: 409, message: 'version mismatch' },
      current: {
        source: 'query',
        revision: conflictRevision,
        snapshot: snapshot('remote'),
      },
    }).state
    expect(conflicted.phase).toBe('conflict')

    const staleOverwrite = transitionWorkflowEditorDraft(conflicted, {
      type: 'SAVE_REQUESTED',
      revision: conflicted.revision,
      mode: 'overwrite',
      expectedRemote: remote(2, snapshot('stale remote'), hash('e')),
      clientMutationId: MUTATION_B,
      snapshot: conflicted.local,
      snapshotHash: hash('b'),
    })
    expect(staleOverwrite.state).toBe(conflicted)

    const freshRemote = remote(4, snapshot('fresh remote'), hash('4'))
    const overwrite = transitionWorkflowEditorDraft(conflicted, {
      type: 'SAVE_REQUESTED',
      revision: conflicted.revision,
      mode: 'overwrite',
      expectedRemote: freshRemote,
      clientMutationId: MUTATION_B,
      snapshot: conflicted.local,
      snapshotHash: hash('b'),
    })
    expect(overwrite.state).toMatchObject({
      phase: 'saving',
      conflict: null,
      server: snapshot('fresh remote'),
      serverRevision: freshRemote.revision,
      inFlight: {
        revision: 1,
        expectedVersion: 4,
        clientMutationId: MUTATION_B,
        snapshot: snapshot('local'),
      },
    })
    expect(overwrite.commands[0]).toMatchObject({
      type: 'SEND_SAVE',
      attempt: { expectedVersion: 4, clientMutationId: MUTATION_B },
    })
  })

  test('definitive 422 is error, keeps local queued, and a new edit resumes dirty', () => {
    const started = requestSave(localCommit(initial(), snapshot('invalid')))
    const attempt = started.state.inFlight!
    const failed = transitionWorkflowEditorDraft(started.state, {
      type: 'SAVE_FAILED',
      clientMutationId: attempt.clientMutationId,
      failure: { kind: 'http', status: 422, message: 'invalid definition' },
    }).state
    expect(failed).toMatchObject({
      phase: 'error',
      local: snapshot('invalid'),
      inFlight: null,
      queuedRevision: 1,
    })
    expect(isWorkflowDraftUnsafeToLeave(failed)).toBe(true)

    const edited = localCommit(failed, snapshot('fixed'))
    expect(edited).toMatchObject({ phase: 'dirty', revision: 2, error: null })
  })
})
