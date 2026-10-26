import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { TargetRow } from '@/platform/persistence/migration/conversion/types'
import type { LegacyNodeRunIdentity } from '../../../domain/runSelection/legacyFacts'
import { encodeCanonicalRunSlot } from '../../../domain/runSelection/slotKey'
import { runSlotInFamily } from '../../../domain/runSelection/families'
import { compareRunSequence } from '../../../domain/runSelection/ordering'
import type { RunSlot } from '../../../domain/runSelection/slots'
import { selectResumeRollbackTargets } from '../../../application/resumeRollbackTargets'
import { createRunSelectionOracleSnapshot } from '../../migration/oracle/snapshot'
import type { OracleRunRow } from '../../migration/oracle/rows'

export interface SelectionMismatch {
  readonly runId: string
  readonly slotKey: string | null
  readonly code: 'v2-run-selection-mismatch' | 'v2-run-selected-unprovable'
  readonly selectedRunId: string | null
}
export async function computeLegacySelections(input: {
  readonly task: TaskFacts
  readonly rows: readonly OracleRunRow[]
  readonly identities: ReadonlyMap<string, LegacyNodeRunIdentity>
  readonly historyOnly: ReadonlySet<string>
}): Promise<{
  selections: readonly TargetRow[]
  mismatches: readonly SelectionMismatch[]
  executionUsed: ReadonlySet<string>
}> {
  const oracle = createRunSelectionOracleSnapshot(input.rows)
  const slots = new Map<string, { slot: RunSlot; rows: OracleRunRow[] }>()
  const mismatches: SelectionMismatch[] = []
  const newest = (rows: readonly OracleRunRow[]) =>
    [...rows]
      .sort((a, b) => compareRunSequence({ ...a, seq: a.seq! }, { ...b, seq: b.seq! }))
      .at(-1)
  for (const row of input.rows) {
    const identity = input.identities.get(row.id)
    if (!identity?.slot) continue
    const key = encodeCanonicalRunSlot(identity.slot)
    const group = slots.get(key) ?? { slot: identity.slot, rows: [] }
    group.rows.push(row)
    slots.set(key, group)
  }
  const selections: TargetRow[] = []
  const executionUsed = new Set<string>()
  for (const [slotKey, { slot, rows }] of slots) {
    let selectedId = (await oracle.current(input.task.taskId, slot))?.id ?? null
    const selectedIdentity = selectedId === null ? undefined : input.identities.get(selectedId)
    if (
      slot.kind === 'workgroup-host' &&
      selectedIdentity?.slot?.kind === 'synthetic' &&
      selectedIdentity.slot.syntheticKind === 'wg-gate'
    ) {
      const family = {
        kind: 'workgroup' as const,
        taskId: input.task.taskId,
        nodeId: slot.nodeId,
        shardKey: slot.shardKey,
      }
      const members = input.rows.filter((row) => {
        const candidate = input.identities.get(row.id)?.slot
        return candidate !== undefined && candidate !== null && runSlotInFamily(candidate, family)
      })
      // Approved #70: the old host picker is a family query including the gate.
      // Keep that equality, then initialize the exact host slot from host rows.
      if (newest(members)?.id === selectedId) selectedId = newest(rows)?.id ?? null
    }
    const identity = selectedId === null ? undefined : input.identities.get(selectedId)
    if (
      selectedId === null ||
      !identity?.slot ||
      encodeCanonicalRunSlot(identity.slot) !== slotKey
    ) {
      for (const runId of new Set([
        ...rows.map((row) => row.id),
        ...(selectedId === null ? [] : [selectedId]),
      ]))
        mismatches.push({
          runId,
          slotKey,
          code: 'v2-run-selection-mismatch',
          selectedRunId: selectedId,
        })
      continue
    }
    executionUsed.add(selectedId)
    if (input.historyOnly.has(selectedId))
      mismatches.push({
        runId: selectedId,
        slotKey,
        code: 'v2-run-selected-unprovable',
        selectedRunId: selectedId,
      })
    const selected = rows.find((row) => row.id === selectedId)!
    selections.push({
      task_id: input.task.taskId,
      slot_key: slotKey,
      selected_run_id: selected.id,
      revision: 1,
      generation_seq: 0,
      cause: 'legacy-epoch1',
      selected_at: selected.startedAt ?? input.task.startedAt,
    })
  }
  for (const row of await selectResumeRollbackTargets(input.rows, oracle, input.task.taskId))
    executionUsed.add(row.id)
  for (const { slot } of slots.values()) {
    if (slot.kind !== 'node') continue
    // resolveSchedulerRunRow adopts only the latest non-superseded pending row.
    const pending = (
      await oracle.slotHistory(input.task.taskId, slot, {
        statusIn: ['pending'],
        excludeSuperseded: true,
      })
    ).at(-1)
    if (pending) executionUsed.add(pending.id)
  }
  // The turns driver adopts every persisted pending host, not just its slot head.
  for (const row of input.rows)
    if (row.status === 'pending' && input.identities.get(row.id)?.slot?.kind === 'workgroup-host')
      executionUsed.add(row.id)
  return { selections, mismatches, executionUsed }
}
