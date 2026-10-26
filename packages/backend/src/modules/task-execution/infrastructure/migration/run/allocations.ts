import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { RUN_ALLOCATION_SUMMARY } from './lookups'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { RunSequencePlan } from './sequence'
import { nullableInteger, text } from './source'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'

export function allocationBase(
  plan: Pick<RunSequencePlan, 'observedHighWater' | 'allocationCount'>,
  ctx: RuleContext,
): number {
  let highWater = BigInt(plan.observedHighWater)
  for (const source of (ctx.preUpgradePreflight ?? ctx.preflight).identityHighWater)
    if (
      source.table === 'node_run_seq_allocations' &&
      (source.column === 'seq' || source.column === null)
    )
      highWater = highWater > BigInt(source.value) ? highWater : BigInt(source.value)
  if (highWater + BigInt(plan.allocationCount) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('v2-run-sequence-range')
  return Number(highWater)
}

export function emitRunAllocation(
  row: SourceRow,
  seq: number,
  sourceHighWater: number,
  taskStartedAt: number,
  ctx: RuleContext,
): void {
  ctx.out.row(
    'node_run_seq_allocations',
    {
      seq,
      task_id: text(row, 'task_id'),
      node_run_id: text(row, 'id'),
      allocated_at: nullableInteger(row, 'started_at') ?? taskStartedAt,
    },
    row,
  )
  ctx.out.exception({
    sourceTable: row.table,
    sourceKey: row.encodedKey,
    class: 'converted',
    kind: 'derived-id',
    targets: [
      {
        table: 'node_run_seq_allocations',
        key: encodeMigrationKey('node_run_seq_allocations', [canonicalValue(seq)]),
      },
    ],
    archive: null,
    allocation: { column: 'seq', value: String(seq), sourceHighWater: String(sourceHighWater) },
    decision: {
      code: 'v2-run-sequence-allocated',
      detail: { runId: text(row, 'id'), seq, sourceHighWater },
    },
  })
}

export function emitAllocationHighWater(
  plan: Pick<RunSequencePlan, 'observedHighWater' | 'allocationCount'>,
  base: number,
  ctx: RuleContext,
): void {
  ctx.out.record({
    kind: 'identity-high-water',
    table: 'node_run_seq_allocations',
    column: 'seq',
    value: String(base + plan.allocationCount),
    basis: (ctx.preUpgradePreflight ?? ctx.preflight).identityHighWater.some(
      (entry) => entry.table === 'node_run_seq_allocations',
    )
      ? 'both'
      : 'max-row',
    ...((ctx.preUpgradePreflight ?? ctx.preflight).identityEvidence ===
    'not-recorded-by-epoch1-artifact'
      ? {
          warning:
            'epoch1 artifact did not record identity state; maximum observed value used; no pruned allocation invented',
        }
      : {}),
  })
}

/** Allocation rows outlive their task; only their watermark survives that deletion. */
export const allocationRule: ConversionRule = {
  ref: { id: 'task-execution/run/allocations', version: 1 },
  owner: 'task-execution',
  claims: ['node_run_seq_allocations'],
  produces: [{ table: 'node_run_seq_allocations' }],
  lookups: [TASK_FACTS, RUN_ALLOCATION_SUMMARY],
  unit: { kind: 'source-chunk', table: 'node_run_seq_allocations' },
  convert(unit, ctx) {
    const summary = ctx.lookup(RUN_ALLOCATION_SUMMARY).require('global')
    let base: number
    try {
      base = allocationBase(summary, ctx)
    } catch (error) {
      const rows = unit.rows.get('node_run_seq_allocations') ?? []
      for (const row of rows)
        ctx.out.block(rowBlock('v2-run-sequence', row, { error: String(error) }, ['seq']))
      if (!rows.length)
        ctx.out.block({
          code: 'v2-run-sequence',
          scope: 'global',
          sourceTable: 'node_run_seq_allocations',
          sourceKey: null,
          taskId: null,
          runId: null,
          missingFields: ['seq'],
          detail: { error: String(error) },
        })
      return
    }
    emitAllocationHighWater(summary, base, ctx)
    for (const row of unit.rows.get('node_run_seq_allocations') ?? []) {
      if (ctx.lookup(TASK_FACTS).get(text(row, 'task_id'))) {
        ctx.out.row('node_run_seq_allocations', row.values, row)
        continue
      }
      const archive = ctx.out.archive({
        kind: 'deleted-row',
        sourceTable: row.table,
        format: 'logical-row@1',
        bytes: Buffer.from(canonicalSchemaJson(row.canonical)),
        rows: 1,
      })
      ctx.out.exception({
        sourceTable: row.table,
        sourceKey: row.encodedKey,
        class: 'archived',
        kind: 'archived',
        targets: [],
        archive,
        decision: {
          code: 'v2-run-deleted-task-allocation',
          detail: {
            taskId: text(row, 'task_id'),
            seq: String(row.values.seq),
            highWater: String(base),
          },
        },
      })
    }
  },
}
