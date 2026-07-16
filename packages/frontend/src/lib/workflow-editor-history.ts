// RFC-199 B4/T7.2-T7.4 — immutable composite workflow-editor history.
//
// History owns editable snapshots and restoration hints only. It deliberately
// knows nothing about persistence, validation, viewport position, React, or
// browser timers. Callers stamp commits with their scheduler clock so the
// 750ms coalescing rule stays deterministic under fake time.

import {
  WorkflowDraftSnapshotSchema,
  serializeWorkflowEditableSnapshotV1,
  type WorkflowDraftSnapshot,
} from '@agent-workflow/shared'

export const WORKFLOW_EDITOR_HISTORY_LIMIT = 50
export const WORKFLOW_EDITOR_HISTORY_MERGE_WINDOW_MS = 750

export type WorkflowEditorHistorySource = 'canvas' | 'inspector' | 'metadata' | 'starter'

/**
 * A semantic restoration hint. It intentionally excludes viewport state: the
 * route may select/focus the referenced target after Undo/Redo, while pan/zoom
 * remains owned by the canvas.
 */
export type WorkflowEditorSelectionHint =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'workflow'; field?: string }
  | null

export type WorkflowEditorHistoryBoundary = 'blur' | 'focus-boundary'

export interface WorkflowDraftChangeMeta {
  source: WorkflowEditorHistorySource
  label: string
  mergeKey?: string
  /**
   * Descriptive compatibility metadata. It does not open a mutable reducer
   * transaction: callers must emit one LOCAL_COMMIT at drag-stop/submit.
   */
  transaction?: 'single' | 'begin' | 'update' | 'commit'
  selectionBefore?: WorkflowEditorSelectionHint
  selectionAfter?: WorkflowEditorSelectionHint
  /** Scheduler time captured by the controller; never read Date.now() here. */
  committedAt?: number
  /** A no-op LOCAL_COMMIT may carry this to close the active merge group. */
  historyBoundary?: WorkflowEditorHistoryBoundary
  /**
   * Compatibility healing may create a dirty local baseline that must never
   * be undoable back to the invalid wire shape. Ordinary user edits record.
   */
  historyMode?: 'record' | 'reset'
}

export interface WorkflowEditorHistoryEntry {
  /** User-facing intent, kept separate from transport/save state. */
  readonly intent: string
  /** Full composite state before and after this one undoable transaction. */
  readonly before: WorkflowDraftSnapshot
  readonly after: WorkflowDraftSnapshot
  readonly selectionBefore: WorkflowEditorSelectionHint
  readonly selectionAfter: WorkflowEditorSelectionHint
  readonly meta: Readonly<WorkflowDraftChangeMeta>
  readonly startedAt: number
  readonly updatedAt: number
  /** Prevents a post-blur/focus-boundary edit from merging into an older entry. */
  readonly mergeEpoch: number
}

export interface WorkflowEditorHistoryState {
  /** Remote adoption reset counter retained from the B2 history pointer. */
  readonly epoch: number
  /** Number of applied entries; entries after cursor form the redo stack. */
  readonly cursor: number
  readonly entries: readonly WorkflowEditorHistoryEntry[]
  readonly mergeEpoch: number
  /** Selection after the currently applied cursor; used when metadata omits it. */
  readonly currentSelection: WorkflowEditorSelectionHint
  /** Latest Undo/Redo restoration hint. Ordinary edits never publish one. */
  readonly selectionHint: WorkflowEditorSelectionHint
  /** Changes only when Undo/Redo publishes a restoration hint. */
  readonly selectionHintRevision: number
}

export interface WorkflowEditorHistoryRecordResult {
  readonly history: WorkflowEditorHistoryState
  readonly snapshot: WorkflowDraftSnapshot
  readonly changed: boolean
}

export interface WorkflowEditorHistoryRestoreResult {
  readonly history: WorkflowEditorHistoryState
  readonly snapshot: WorkflowDraftSnapshot
  readonly changed: boolean
}

const DEFAULT_META: Readonly<WorkflowDraftChangeMeta> = Object.freeze({
  source: 'metadata',
  label: 'Edit workflow',
  transaction: 'single',
})
const IMMUTABLE_SNAPSHOTS = new WeakSet<object>()

export function createWorkflowEditorHistoryState(epoch = 0): WorkflowEditorHistoryState {
  return {
    epoch,
    cursor: 0,
    entries: Object.freeze([]),
    mergeEpoch: 0,
    currentSelection: null,
    selectionHint: null,
    selectionHintRevision: 0,
  }
}

export function canUndoWorkflowEditorHistory(history: WorkflowEditorHistoryState): boolean {
  return history.cursor > 0
}

export function canRedoWorkflowEditorHistory(history: WorkflowEditorHistoryState): boolean {
  return history.cursor < history.entries.length
}

export function resetWorkflowEditorHistory(
  history: WorkflowEditorHistoryState,
): WorkflowEditorHistoryState {
  return {
    ...createWorkflowEditorHistoryState(history.epoch + 1),
    // This is a monotonic publication token, not history-local data. A clean
    // remote follow resets entries without publishing an Undo/Redo selection
    // restoration; rewinding this token would make the route clear a live
    // inspector and steal focus even though the selected node still exists.
    selectionHintRevision: history.selectionHintRevision,
  }
}

/** Close a coalescing group without creating a revision or history entry. */
export function breakWorkflowEditorHistoryMerge(
  history: WorkflowEditorHistoryState,
): WorkflowEditorHistoryState {
  return {
    ...history,
    mergeEpoch: history.mergeEpoch + 1,
  }
}

export function recordWorkflowEditorHistory(
  history: WorkflowEditorHistoryState,
  current: WorkflowDraftSnapshot,
  next: WorkflowDraftSnapshot,
  rawMeta?: WorkflowDraftChangeMeta,
): WorkflowEditorHistoryRecordResult {
  const equal = snapshotsEqual(current, next)
  if (equal) {
    return {
      history:
        rawMeta?.historyBoundary === undefined ? history : breakWorkflowEditorHistoryMerge(history),
      snapshot: current,
      changed: false,
    }
  }

  const before = immutableWorkflowEditorSnapshot(current)
  const after = immutableWorkflowEditorSnapshot(next)
  const meta = immutableMeta(rawMeta)
  const committedAt = normalizedTime(meta.committedAt)
  const selectionBefore = immutableSelectionHint(
    rawMeta !== undefined && Object.prototype.hasOwnProperty.call(rawMeta, 'selectionBefore')
      ? (rawMeta.selectionBefore ?? null)
      : history.currentSelection,
  )
  const selectionAfter = immutableSelectionHint(
    rawMeta !== undefined && Object.prototype.hasOwnProperty.call(rawMeta, 'selectionAfter')
      ? (rawMeta.selectionAfter ?? null)
      : selectionBefore,
  )

  const appliedEntries = history.entries.slice(0, history.cursor)
  const previous = appliedEntries.at(-1)
  const mergeEpoch =
    meta.historyBoundary === undefined ? history.mergeEpoch : history.mergeEpoch + 1
  const canMerge =
    meta.historyBoundary === undefined &&
    meta.mergeKey !== undefined &&
    meta.committedAt !== undefined &&
    Number.isFinite(meta.committedAt) &&
    previous !== undefined &&
    previous.meta.mergeKey === meta.mergeKey &&
    previous.meta.committedAt !== undefined &&
    Number.isFinite(previous.meta.committedAt) &&
    previous.mergeEpoch === mergeEpoch &&
    committedAt >= previous.updatedAt &&
    committedAt - previous.updatedAt <= WORKFLOW_EDITOR_HISTORY_MERGE_WINDOW_MS

  let entries: WorkflowEditorHistoryEntry[]
  if (canMerge) {
    const merged = freezeEntry({
      ...previous,
      intent: meta.label,
      after,
      selectionAfter,
      meta,
      updatedAt: committedAt,
    })
    entries = [...appliedEntries.slice(0, -1), merged]
  } else {
    const entry = freezeEntry({
      intent: meta.label,
      before,
      after,
      selectionBefore,
      selectionAfter,
      meta,
      startedAt: committedAt,
      updatedAt: committedAt,
      mergeEpoch,
    })
    entries = [...appliedEntries, entry]
  }

  if (entries.length > WORKFLOW_EDITOR_HISTORY_LIMIT) {
    entries = entries.slice(entries.length - WORKFLOW_EDITOR_HISTORY_LIMIT)
  }
  const frozenEntries = Object.freeze(entries)
  return {
    history: {
      ...history,
      cursor: frozenEntries.length,
      entries: frozenEntries,
      mergeEpoch,
      currentSelection: selectionAfter,
    },
    snapshot: after,
    changed: true,
  }
}

export function undoWorkflowEditorHistory(
  history: WorkflowEditorHistoryState,
  current: WorkflowDraftSnapshot,
): WorkflowEditorHistoryRestoreResult {
  if (!canUndoWorkflowEditorHistory(history)) {
    return { history, snapshot: current, changed: false }
  }
  const entry = history.entries[history.cursor - 1]!
  return {
    history: {
      ...history,
      cursor: history.cursor - 1,
      mergeEpoch: history.mergeEpoch + 1,
      currentSelection: entry.selectionBefore,
      selectionHint: entry.selectionBefore,
      selectionHintRevision: history.selectionHintRevision + 1,
    },
    snapshot: entry.before,
    changed: true,
  }
}

export function redoWorkflowEditorHistory(
  history: WorkflowEditorHistoryState,
  current: WorkflowDraftSnapshot,
): WorkflowEditorHistoryRestoreResult {
  if (!canRedoWorkflowEditorHistory(history)) {
    return { history, snapshot: current, changed: false }
  }
  const entry = history.entries[history.cursor]!
  return {
    history: {
      ...history,
      cursor: history.cursor + 1,
      mergeEpoch: history.mergeEpoch + 1,
      currentSelection: entry.selectionAfter,
      selectionHint: entry.selectionAfter,
      selectionHintRevision: history.selectionHintRevision + 1,
    },
    snapshot: entry.after,
    changed: true,
  }
}

/** Clone first, then recursively freeze; caller-owned values are never frozen. */
export function immutableWorkflowEditorSnapshot(
  snapshot: WorkflowDraftSnapshot,
): WorkflowDraftSnapshot {
  if (IMMUTABLE_SNAPSHOTS.has(snapshot)) return snapshot
  // Zod passthrough schemas clone their declared object shell but may retain
  // aliases to unknown nested compatibility fields. Clone the complete graph
  // first so recursive freezing can never freeze caller-owned extensions.
  const immutable = deepFreeze(WorkflowDraftSnapshotSchema.parse(structuredClone(snapshot)))
  IMMUTABLE_SNAPSHOTS.add(immutable)
  return immutable
}

function immutableMeta(rawMeta?: WorkflowDraftChangeMeta): Readonly<WorkflowDraftChangeMeta> {
  if (rawMeta === undefined) return DEFAULT_META
  return deepFreeze({
    ...rawMeta,
    ...(Object.prototype.hasOwnProperty.call(rawMeta, 'selectionBefore')
      ? { selectionBefore: immutableSelectionHint(rawMeta.selectionBefore ?? null) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawMeta, 'selectionAfter')
      ? { selectionAfter: immutableSelectionHint(rawMeta.selectionAfter ?? null) }
      : {}),
  })
}

function immutableSelectionHint(hint: WorkflowEditorSelectionHint): WorkflowEditorSelectionHint {
  if (hint === null) return null
  return deepFreeze({ ...hint })
}

function freezeEntry(entry: WorkflowEditorHistoryEntry): WorkflowEditorHistoryEntry {
  return Object.freeze(entry)
}

function snapshotsEqual(a: WorkflowDraftSnapshot, b: WorkflowDraftSnapshot): boolean {
  return serializeWorkflowEditableSnapshotV1(a) === serializeWorkflowEditableSnapshotV1(b)
}

function normalizedTime(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
