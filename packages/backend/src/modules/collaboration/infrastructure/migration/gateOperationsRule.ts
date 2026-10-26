import type { ConversionRule, RowValidator } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { recordCollaborationDecision } from './evidence'

function pendingOpen(row: SourceRow): boolean {
  const v = row.values
  return (
    (v.state === 'preparing' || v.state === 'prepared') &&
    v.operation_kind === 'open' &&
    (v.gate_kind === 'clarify' || v.gate_kind === 'review')
  )
}

export const gateOperationsValidator: RowValidator = {
  ref: { id: 'collaboration/gate-open-drain', version: 1 },
  table: 'collaboration_gate_operations',
  lookups: [TASK_FACTS],
  validate(row, ctx) {
    if (!pendingOpen(row)) return []
    const task = ctx.lookup(TASK_FACTS).get(String(row.values.task_id))
    if (!task) return [rowBlock('v2-gate-task-facts-missing', row, null, ['TASK_FACTS'])]
    return task.execution === 'executable'
      ? [
          rowBlock(
            'v2-gate-open-in-flight',
            row,
            {
              gateKind: String(row.values.gate_kind),
              state: String(row.values.state),
              execution: task.execution,
            },
            ['legacy-open-replay'],
          ),
        ]
      : []
  },
}

export const gateOperationsRule: ConversionRule = {
  ref: { id: 'collaboration/gate-operations', version: 1 },
  owner: 'collaboration',
  claims: ['collaboration_gate_operations'],
  produces: [{ table: 'collaboration_gate_operations' }],
  lookups: [TASK_FACTS],
  unit: { kind: 'source-chunk', table: 'collaboration_gate_operations' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('collaboration_gate_operations') ?? []) {
      // Receipts, decision manifests and rollback plans remain byte-exact. R1 owns immutableOnceSet.
      ctx.out.row(row.table, row.values, row)
      if (!pendingOpen(row)) continue
      const task = ctx.lookup(TASK_FACTS).require(String(row.values.task_id))
      recordCollaborationDecision(
        row,
        ctx,
        {
          code: 'v2-gate-open-history-only',
          detail: { gateKind: String(row.values.gate_kind), state: String(row.values.state) },
        },
        [{ table: row.table, key: ctx.target.key(row.table, row.values) }],
        {
          execution: task.execution,
          missingFields: ['legacy-open-replay'],
        },
      )
    }
  },
}
