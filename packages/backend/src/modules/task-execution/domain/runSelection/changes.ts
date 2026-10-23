import { decodeRunSlot, encodeRunSlot, runSlotsEqual, type RunSlot } from './slots'

export interface SelectionRunIdentity {
  readonly id: string
  readonly taskId: string
  readonly slot: RunSlot
  readonly containerRunId: string | null
  readonly parentNodeRunId: string | null
  readonly shardKey: string | null
}

interface SelectionChangeBase {
  readonly taskId: string
  readonly slot: RunSlot
  readonly expectedRevision: number
  readonly generationSeq: number
  readonly cause: string
}

export type SelectionChange = SelectionChangeBase &
  ({ readonly kind: 'select'; readonly run: SelectionRunIdentity } | { readonly kind: 'clear' })

export interface SelectionRevision {
  readonly taskId: string
  readonly slot: RunSlot
  readonly revision: number
  readonly generationSeq: number
  readonly selectedRunId: string | null
}

export interface SelectionState extends SelectionRevision {
  readonly run: SelectionRunIdentity | null
}

/** II-a participant 只校验这份随 owner 传入的事实，不额外查库。 */
export function validateSelectionChange(change: SelectionChange): void {
  decodeRunSlot(encodeRunSlot(change.slot))
  if (change.kind !== 'select' && change.kind !== 'clear')
    throw new Error('invalid-selection-change-kind')
  if (
    !Number.isSafeInteger(change.expectedRevision) ||
    change.expectedRevision < 0 ||
    !Number.isSafeInteger(change.generationSeq) ||
    change.generationSeq < 0
  )
    throw new Error('invalid-selection-revision')
  if (
    change.kind === 'select' &&
    (change.run.taskId !== change.taskId || !runSlotsEqual(change.run.slot, change.slot))
  )
    throw new Error('selection-run-slot-mismatch')
}

export function selectionRevision(change: SelectionChange): SelectionRevision {
  validateSelectionChange(change)
  return {
    taskId: change.taskId,
    slot: change.slot,
    revision: change.expectedRevision + 1,
    generationSeq: change.generationSeq,
    selectedRunId: change.kind === 'select' ? change.run.id : null,
  }
}

/** 纯状态转换，供目标表实现用；II-a 不把它的结果写回旧 schema。 */
export function applySelectionChanges(
  state: readonly SelectionState[],
  changes: readonly SelectionChange[],
): readonly SelectionState[] {
  const key = (entry: { taskId: string; slot: RunSlot }) =>
    JSON.stringify([entry.taskId, encodeRunSlot(entry.slot)])
  const next = new Map(state.map((entry) => [key(entry), entry]))
  for (const change of changes) {
    const revision = selectionRevision(change)
    const previous = next.get(key(change))
    if ((previous?.revision ?? 0) !== change.expectedRevision)
      throw new Error('selection-revision-conflict')
    // HEAD selects each slot independently. Structural supersession is a separate
    // read predicate; replacing a wrapper does not erase reusable shard/aggregator
    // selections or loop-body frames. Owners must propose any actual clear explicitly.
    next.set(key(change), { ...revision, run: change.kind === 'select' ? change.run : null })
  }
  return [...next.values()]
}
