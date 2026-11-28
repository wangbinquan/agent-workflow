import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { RUN_ALLOCATION_SUMMARY } from './lookups'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { RunSequencePlan } from './sequence'
import {
  ALLOCATION_NUMBER_COLUMNS,
  nullableInteger,
  text,
  unusableNumberColumns,
  unusableRowBlock,
} from './source'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'

/** RFC-626 §3.4 row 16: the decision the automatic upgrade records for a row-less sequence block. */
export const RUN_SEQUENCE_KEPT = 'v2-run-sequence-kept'
/**
 * The allocation base cannot be computed and there is no row the block could stand on (a task
 * without runs; an empty allocation table). The operator still gets the global block. The
 * automatic upgrade has nothing to set aside: it records the fact and emits no allocation high
 * water, so the target derives that high water from its largest row (`target/identity.ts`,
 * basis `max-row`), which needs nothing from this block.
 */
export function blockSequenceWithoutRow(
  ctx: RuleContext,
  input: {
    readonly sourceTable: string | null
    readonly taskId: string | null
    readonly error: string
  },
): void {
  if (ctx.resolution === 'automatic') {
    recordSequenceKept(ctx, input)
    return
  }
  ctx.out.block({
    code: 'v2-run-sequence',
    scope: 'global',
    sourceTable: input.sourceTable,
    sourceKey: null,
    taskId: input.taskId,
    runId: null,
    missingFields: ['seq'],
    detail: { error: input.error },
  })
}

/** The `v2-run-sequence-kept` decision: the allocation high water is left to the target's rows. */
export function recordSequenceKept(
  ctx: RuleContext,
  input: {
    readonly sourceTable: string | null
    readonly taskId: string | null
    readonly error: string
  },
): void {
  ctx.out.record({
    kind: 'decision',
    code: RUN_SEQUENCE_KEPT,
    payload: {
      automatic: 'kept',
      sourceTable: input.sourceTable,
      sourceKey: null,
      taskId: input.taskId,
      blockCode: 'v2-run-sequence',
      error: input.error,
      identityHighWater: 'max-row',
    },
  })
}

/**
 * RFC-626 §3.4 row 16 (§9.9): the allocation base of the run and allocation rules. The base is
 * one global value, so its error used to block every run and every allocation row of the
 * source. With automatic resolution a base that cannot be computed — the source's recorded high
 * water, or that plus the allocations still to make, past 2^53 — falls back to the largest
 * sequence the rows carry (`max-row`), and `kept` holds the error the caller records. A run
 * given a sequence is then given `observedHighWater + ordinal`, the value `assignLegacySequences`
 * already proved safe; a task it could not prove keeps its own row-level `v2-run-sequence`.
 * Operator resolution keeps the error.
 */
export function resolveAllocationBase(
  plan: Pick<RunSequencePlan, 'observedHighWater' | 'allocationCount'>,
  ctx: RuleContext,
): { readonly base: number; readonly kept: string | null } {
  try {
    return { base: allocationBase(plan, ctx), kept: null }
  } catch (error) {
    if (ctx.resolution !== 'automatic') throw error
    return { base: plan.observedHighWater, kept: String(error) }
  }
}

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
    let kept: string | null
    try {
      ;({ base, kept } = resolveAllocationBase(summary, ctx))
    } catch (error) {
      const rows = unit.rows.get('node_run_seq_allocations') ?? []
      for (const row of rows)
        ctx.out.block(rowBlock('v2-run-sequence', row, { error: String(error) }, ['seq']))
      if (!rows.length)
        blockSequenceWithoutRow(ctx, {
          sourceTable: 'node_run_seq_allocations',
          taskId: null,
          error: String(error),
        })
      return
    }
    // The rows convert either way; with the fallback the target derives the high water from them.
    if (kept === null) emitAllocationHighWater(summary, base, ctx)
    else
      recordSequenceKept(ctx, {
        sourceTable: 'node_run_seq_allocations',
        taskId: null,
        error: kept,
      })
    for (const row of unit.rows.get('node_run_seq_allocations') ?? []) {
      // RFC-626: the sequence lookups skip an allocation whose seq is past 2^53; so does this rule.
      const unusable = unusableNumberColumns(row, ALLOCATION_NUMBER_COLUMNS)
      if (unusable.length) {
        ctx.out.block(unusableRowBlock(row, unusable))
        continue
      }
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
