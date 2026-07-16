// RFC-199 B4/T7.2-T7.4 regression lock: composite history is immutable,
// coalesces only one explicit field transaction, and restores full snapshots
// without rewinding the draft's monotonic local revision.

import { describe, expect, test } from 'vitest'
import type {
  WorkflowDraftSnapshot,
  WorkflowMutationId,
  WorkflowRevision,
  WorkflowSnapshotHash,
} from '@agent-workflow/shared'
import {
  canRedoWorkflowEditorDraft,
  canUndoWorkflowEditorDraft,
  createWorkflowEditorDraftState,
  transitionWorkflowEditorDraft,
  type WorkflowRemoteSnapshot,
} from '@/lib/workflow-editor-draft'
import {
  WORKFLOW_EDITOR_HISTORY_LIMIT,
  breakWorkflowEditorHistoryMerge,
  canRedoWorkflowEditorHistory,
  canUndoWorkflowEditorHistory,
  createWorkflowEditorHistoryState,
  recordWorkflowEditorHistory,
  redoWorkflowEditorHistory,
  resetWorkflowEditorHistory,
  undoWorkflowEditorHistory,
  type WorkflowDraftChangeMeta,
} from '@/lib/workflow-editor-history'

function hash(char: string): WorkflowSnapshotHash {
  return char.repeat(64) as WorkflowSnapshotHash
}

function snapshot(description: string): WorkflowDraftSnapshot {
  return {
    name: 'workflow',
    description,
    definition: {
      $schema_version: 4,
      inputs: [],
      nodes: [],
      edges: [],
    },
  }
}

function remote(value = snapshot('base')): WorkflowRemoteSnapshot {
  const revision: WorkflowRevision = {
    workflowId: 'wf-history',
    version: 1,
    snapshotHash: hash('a'),
    updatedAt: 100,
  }
  return { revision, snapshot: value }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function meta(
  label: string,
  committedAt: number,
  extra: Partial<WorkflowDraftChangeMeta> = {},
): WorkflowDraftChangeMeta {
  return {
    source: 'inspector',
    label,
    transaction: 'single',
    committedAt,
    ...extra,
  }
}

describe('workflow editor composite history', () => {
  test('entry keeps full frozen before/after references without freezing caller input', () => {
    const before = snapshot('before')
    const after = snapshot('after')
    const selectionAfter = { kind: 'node' as const, id: 'node-a' }
    const recorded = recordWorkflowEditorHistory(
      createWorkflowEditorHistoryState(),
      before,
      after,
      meta('Edit node', 10, { selectionAfter }),
    )

    expect(recorded.changed).toBe(true)
    expect(recorded.history).toMatchObject({
      cursor: 1,
      epoch: 0,
      currentSelection: selectionAfter,
      selectionHint: null,
      selectionHintRevision: 0,
    })
    expect(recorded.history.entries[0]).toMatchObject({
      intent: 'Edit node',
      before,
      after,
      selectionBefore: null,
      selectionAfter,
      meta: { source: 'inspector', label: 'Edit node', committedAt: 10 },
    })
    expect(recorded.snapshot).toBe(recorded.history.entries[0]!.after)
    expect(Object.isFrozen(recorded.history.entries)).toBe(true)
    expect(Object.isFrozen(recorded.history.entries[0])).toBe(true)
    expect(Object.isFrozen(recorded.history.entries[0]!.after)).toBe(true)
    expect(Object.isFrozen(recorded.history.entries[0]!.after.definition)).toBe(true)
    expect(Object.isFrozen(recorded.history.entries[0]!.after.definition.nodes)).toBe(true)
    expect(Object.isFrozen(recorded.history.entries[0]!.meta)).toBe(true)
    expect(Object.isFrozen(after)).toBe(false)
    expect(Object.isFrozen(selectionAfter)).toBe(false)
  })

  test('passthrough nested compatibility data is cloned before history freezes it', () => {
    const callerNested = { labels: ['legacy'], config: { future: true } }
    const after = snapshot('with passthrough')
    after.definition.nodes = [
      {
        id: 'legacy',
        kind: 'agent-single',
        metadata: callerNested,
      } as never,
    ]

    const recorded = recordWorkflowEditorHistory(
      createWorkflowEditorHistoryState(),
      snapshot('before'),
      after,
      meta('Edit legacy node', 10),
    )
    const storedMetadata = (
      recorded.snapshot.definition.nodes[0] as unknown as { metadata: typeof callerNested }
    ).metadata

    expect(storedMetadata).toEqual(callerNested)
    expect(storedMetadata).not.toBe(callerNested)
    expect(storedMetadata.labels).not.toBe(callerNested.labels)
    expect(storedMetadata.config).not.toBe(callerNested.config)
    expect(Object.isFrozen(storedMetadata)).toBe(true)
    expect(Object.isFrozen(storedMetadata.labels)).toBe(true)
    expect(Object.isFrozen(storedMetadata.config)).toBe(true)
    expect(Object.isFrozen(callerNested)).toBe(false)
    expect(Object.isFrozen(callerNested.labels)).toBe(false)
    expect(Object.isFrozen(callerNested.config)).toBe(false)
  })

  test('reducer accepts deeply frozen state, event snapshot, and metadata without mutation', () => {
    const state = deepFreeze(createWorkflowEditorDraftState(remote()))
    const next = deepFreeze(snapshot('frozen input'))
    const changeMeta = deepFreeze(
      meta('Frozen edit', 10, {
        selectionAfter: { kind: 'workflow', field: 'description' },
      }),
    )
    const stateBefore = structuredClone(state)
    const nextBefore = structuredClone(next)
    const metaBefore = structuredClone(changeMeta)

    const transition = transitionWorkflowEditorDraft(state, {
      type: 'LOCAL_COMMIT',
      snapshot: next,
      meta: changeMeta,
    })

    expect(transition.state).not.toBe(state)
    expect(transition.state).toMatchObject({ revision: 1, local: next })
    expect(state).toEqual(stateBefore)
    expect(next).toEqual(nextBefore)
    expect(changeMeta).toEqual(metaBefore)
  })

  test('canonical equality is a true no-op; blur/focus boundary only closes coalescing', () => {
    const initial = createWorkflowEditorHistoryState()
    const value = snapshot('same')
    const equal = recordWorkflowEditorHistory(
      initial,
      value,
      structuredClone(value),
      meta('Same', 1),
    )
    expect(equal).toEqual({ history: initial, snapshot: value, changed: false })

    const blur = recordWorkflowEditorHistory(initial, value, value, {
      ...meta('Blur', 2),
      historyBoundary: 'blur',
    })
    expect(blur.changed).toBe(false)
    expect(blur.snapshot).toBe(value)
    expect(blur.history).toMatchObject({ cursor: 0, mergeEpoch: 1 })
    expect(blur.history.entries).toHaveLength(0)

    const focusBoundary = breakWorkflowEditorHistoryMerge(blur.history)
    expect(focusBoundary).toMatchObject({ cursor: 0, mergeEpoch: 2 })
  })

  test('same mergeKey coalesces through 750ms inclusive and boundary/idle split it', () => {
    let current = snapshot('base')
    let history = createWorkflowEditorHistoryState()
    const commit = (description: string, committedAt: number) => {
      const result = recordWorkflowEditorHistory(
        history,
        current,
        snapshot(description),
        meta('Edit description', committedAt, { mergeKey: 'metadata.description' }),
      )
      history = result.history
      current = result.snapshot
    }

    commit('a', 1_000)
    commit('ab', 1_750)
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]).toMatchObject({
      before: snapshot('base'),
      after: snapshot('ab'),
      startedAt: 1_000,
      updatedAt: 1_750,
    })

    commit('abc', 2_501)
    expect(history.entries).toHaveLength(2)

    history = breakWorkflowEditorHistoryMerge(history)
    commit('abcd', 2_502)
    expect(history.entries).toHaveLength(3)
  })

  test('adjacent entries structurally share the immutable snapshot reference', () => {
    const base = snapshot('base')
    const first = recordWorkflowEditorHistory(
      createWorkflowEditorHistoryState(),
      base,
      snapshot('first'),
      meta('First', 1),
    )
    const second = recordWorkflowEditorHistory(
      first.history,
      first.snapshot,
      snapshot('second'),
      meta('Second', 2),
    )

    expect(second.history.entries[0]!.after).toBe(second.history.entries[1]!.before)
  })

  test('Undo/Redo restore full snapshot + selection and a new edit invalidates redo', () => {
    const before = snapshot('base')
    const after = snapshot('deleted node')
    const selectionBefore = { kind: 'node' as const, id: 'node-a' }
    const recorded = recordWorkflowEditorHistory(
      createWorkflowEditorHistoryState(),
      before,
      after,
      meta('Delete node', 10, { selectionBefore, selectionAfter: null }),
    )

    expect(canUndoWorkflowEditorHistory(recorded.history)).toBe(true)
    expect(canRedoWorkflowEditorHistory(recorded.history)).toBe(false)
    const undone = undoWorkflowEditorHistory(recorded.history, recorded.snapshot)
    expect(undone.snapshot).toEqual(before)
    expect(undone.history).toMatchObject({ cursor: 0, selectionHint: selectionBefore })
    expect(canRedoWorkflowEditorHistory(undone.history)).toBe(true)

    const redone = redoWorkflowEditorHistory(undone.history, undone.snapshot)
    expect(redone.snapshot).toEqual(after)
    expect(redone.history).toMatchObject({ cursor: 1, selectionHint: null })

    const replacement = recordWorkflowEditorHistory(
      undone.history,
      undone.snapshot,
      snapshot('replacement edit'),
      meta('Insert node', 20),
    )
    expect(replacement.history.entries).toHaveLength(1)
    expect(replacement.history.entries[0]!.intent).toBe('Insert node')
    expect(canRedoWorkflowEditorHistory(replacement.history)).toBe(false)
  })

  test('remote/reset clears entries without rewinding the selection publication token', () => {
    const recorded = recordWorkflowEditorHistory(
      createWorkflowEditorHistoryState(),
      snapshot('base'),
      snapshot('edited'),
      meta('Edit', 10, { selectionBefore: { kind: 'node', id: 'node-a' } }),
    )
    const undone = undoWorkflowEditorHistory(recorded.history, recorded.snapshot)
    expect(undone.history.selectionHintRevision).toBe(1)

    const reset = resetWorkflowEditorHistory(undone.history)
    expect(reset).toMatchObject({
      epoch: 1,
      cursor: 0,
      entries: [],
      selectionHint: null,
      selectionHintRevision: 1,
    })
  })

  test('history retains the newest 50 transactions with a valid oldest before snapshot', () => {
    let current = snapshot('0')
    let history = createWorkflowEditorHistoryState()
    for (let index = 1; index <= WORKFLOW_EDITOR_HISTORY_LIMIT + 5; index += 1) {
      const recorded = recordWorkflowEditorHistory(
        history,
        current,
        snapshot(String(index)),
        meta(`Edit ${index}`, index),
      )
      history = recorded.history
      current = recorded.snapshot
    }

    expect(history.entries).toHaveLength(WORKFLOW_EDITOR_HISTORY_LIMIT)
    expect(history.cursor).toBe(WORKFLOW_EDITOR_HISTORY_LIMIT)
    expect(history.entries[0]!.before).toEqual(snapshot('5'))
    for (let index = 0; index < WORKFLOW_EDITOR_HISTORY_LIMIT; index += 1) {
      const undone = undoWorkflowEditorHistory(history, current)
      expect(undone.changed).toBe(true)
      history = undone.history
      current = undone.snapshot
    }
    expect(current).toEqual(snapshot('5'))
    expect(canUndoWorkflowEditorHistory(history)).toBe(false)
  })

  test('draft reducer Undo/Redo mint new revisions; save receipt preserves history; clean remote resets', () => {
    let state = createWorkflowEditorDraftState(remote())
    state = transitionWorkflowEditorDraft(state, {
      type: 'LOCAL_COMMIT',
      snapshot: snapshot('local'),
      meta: meta('Edit description', 10, {
        selectionAfter: { kind: 'workflow', field: 'description' },
      }),
    }).state
    expect(state).toMatchObject({ revision: 1, savedRevision: 0, phase: 'dirty' })
    expect(canUndoWorkflowEditorDraft(state)).toBe(true)

    state = transitionWorkflowEditorDraft(state, { type: 'UNDO' }).state
    expect(state).toMatchObject({
      revision: 2,
      savedRevision: 0,
      local: snapshot('base'),
      phase: 'dirty',
      history: { cursor: 0 },
    })
    expect(canRedoWorkflowEditorDraft(state)).toBe(true)

    state = transitionWorkflowEditorDraft(state, { type: 'REDO' }).state
    expect(state).toMatchObject({ revision: 3, local: snapshot('local'), history: { cursor: 1 } })

    const mutationId = '01KXF00000000000000000HIST' as WorkflowMutationId
    const saveStarted = transitionWorkflowEditorDraft(state, {
      type: 'SAVE_REQUESTED',
      revision: state.revision,
      clientMutationId: mutationId,
      snapshot: state.local,
      snapshotHash: hash('l'),
    }).state
    const beforeReceiptHistory = saveStarted.history
    const attempt = saveStarted.inFlight!
    state = transitionWorkflowEditorDraft(saveStarted, {
      type: 'SAVE_COMMITTED',
      receipt: {
        clientMutationId: mutationId,
        requestedBaseVersion: attempt.expectedVersion,
        revision: {
          ...state.serverRevision,
          version: 2,
          snapshotHash: attempt.snapshotHash,
          updatedAt: 200,
        },
        snapshot: attempt.snapshot,
        outcome: 'committed',
      },
    }).state
    expect(state.history).toBe(beforeReceiptHistory)

    const beforeOwnEchoHistory = state.history
    state = transitionWorkflowEditorDraft(state, {
      type: 'REMOTE_OBSERVED',
      observation: { source: 'ws', revision: state.serverRevision },
    }).state
    expect(state.history).toBe(beforeOwnEchoHistory)

    const clean = createWorkflowEditorDraftState(remote())
    const followed = transitionWorkflowEditorDraft(clean, {
      type: 'REMOTE_OBSERVED',
      observation: {
        source: 'query',
        revision: { ...clean.serverRevision, version: 2, snapshotHash: hash('b'), updatedAt: 200 },
        snapshot: snapshot('remote'),
      },
    }).state
    expect(followed.history).toMatchObject({ epoch: 1, cursor: 0, entries: [] })
  })

  test('compatibility healing becomes a dirty non-undoable baseline', () => {
    let state = createWorkflowEditorDraftState(remote())
    state = transitionWorkflowEditorDraft(state, {
      type: 'LOCAL_COMMIT',
      snapshot: snapshot('healed'),
      meta: {
        source: 'starter',
        label: 'Heal loaded workflow',
        transaction: 'single',
        committedAt: 10,
        historyMode: 'reset',
      },
    }).state

    expect(state).toMatchObject({
      local: snapshot('healed'),
      revision: 1,
      phase: 'dirty',
      history: { cursor: 0, entries: [] },
    })
    expect(canUndoWorkflowEditorDraft(state)).toBe(false)
  })
})
