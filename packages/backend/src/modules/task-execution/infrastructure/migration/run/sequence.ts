import { planNodeRunSeqBackfill } from './legacySequencePlan'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { integer, nullableInteger, text } from './source'

export function assignLegacySequences(
  rows: readonly { readonly id: string; readonly seq: number | null }[],
  allocator: { next(): number },
): {
  seqById: ReadonlyMap<string, number>
  derived: ReadonlySet<string>
  allocated: readonly string[]
} {
  const existing = rows.filter((row): row is { id: string; seq: number } => row.seq !== null)
  const missing = rows
    .filter((row) => row.seq === null)
    .map((row) => row.id)
    .sort()
  const plan = planNodeRunSeqBackfill(
    {
      minSeq: existing.length
        ? existing.reduce((min, row) => Math.min(min, row.seq), existing[0]!.seq)
        : null,
      maxId: existing.length
        ? existing
            .map((row) => row.id)
            .sort()
            .at(-1)!
        : null,
    },
    missing,
  )
  const seqById = new Map(existing.map((row) => [row.id, row.seq]))
  const allocated: string[] = []
  if (plan.kind === 'initial')
    missing.forEach((id, index) => seqById.set(id, index - missing.length + 1))
  else {
    for (const row of plan.older) seqById.set(row.id, row.seq)
    for (const id of plan.newer) {
      seqById.set(id, allocator.next())
      allocated.push(id)
    }
  }
  if ([...seqById.values()].some((seq) => !Number.isSafeInteger(seq)))
    throw new Error('v2-run-sequence-range')
  if (new Set(seqById.values()).size !== seqById.size) throw new Error('v2-run-sequence-duplicate')
  return { seqById, derived: new Set(missing), allocated }
}

export interface RunSequencePlan {
  readonly runs: readonly {
    readonly id: string
    readonly seq: number
    readonly derived: boolean
    readonly allocationOrdinal: number | null
  }[]
  readonly observedHighWater: number
  readonly allocationCount: number
  readonly error: string | null
}

/** D3: the global allocation order is (task_id, id), independent of source chunk order. */
export function planRunSequences(
  rows: Iterable<SourceRow>,
  allocations: Iterable<SourceRow>,
): ReadonlyMap<string, RunSequencePlan> {
  let observedHighWater = 0
  const groups = new Map<string, { id: string; seq: number | null }[]>()
  for (const row of rows) {
    if (row.codecFailure) continue
    const taskId = text(row, 'task_id')
    const group = groups.get(taskId) ?? []
    group.push({ id: text(row, 'id'), seq: nullableInteger(row, 'seq') })
    groups.set(taskId, group)
    observedHighWater = Math.max(observedHighWater, nullableInteger(row, 'seq') ?? 0)
  }
  for (const row of allocations)
    if (!row.codecFailure) observedHighWater = Math.max(observedHighWater, integer(row, 'seq'))
  let ordinal = 0
  const plans = new Map<string, RunSequencePlan>()
  for (const taskId of [...groups.keys()].sort()) {
    const taskRows = groups.get(taskId)!
    try {
      const ordinals = new Map<string, number>()
      const assigned = assignLegacySequences(taskRows, {
        next: () => observedHighWater + ++ordinal,
      })
      for (const id of assigned.allocated)
        ordinals.set(id, assigned.seqById.get(id)! - observedHighWater)
      plans.set(taskId, {
        runs: [...assigned.seqById].map(([id, seq]) => ({
          id,
          seq,
          derived: assigned.derived.has(id),
          allocationOrdinal: ordinals.get(id) ?? null,
        })),
        observedHighWater,
        allocationCount: 0,
        error: null,
      })
    } catch (error) {
      plans.set(taskId, { runs: [], observedHighWater, allocationCount: 0, error: String(error) })
    }
  }
  for (const [taskId, plan] of plans) plans.set(taskId, { ...plan, allocationCount: ordinal })
  return plans
}
