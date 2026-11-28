// RFC-626 F2 (design §3.2.1, §3.3, §3.4 rows 16-17; plan T0 blocks.md tables 1.5 and 3):
// locks the run rule's side of "upgrades never refuse because of data" without a database.
// - Every "cannot be proved" decision of a run whose task could continue goes through
//   `blockExecutable`: the operator gets the very block as before (equal unit outputs), the
//   automatic upgrade turns it into a settlement trigger, and reaching it after discovery fails.
// - The run rule declares `settles` and no longer emits the generation-0 row (the task rule does).
// - The row-less `v2-run-sequence` blocks become a recorded decision with automatic resolution;
//   so does the global allocation base past 2^53, which no longer blocks every row (gate G2-4).
// - Input producers of another node, unreadable prompt files and numbers past 2^53 no longer
//   abort the conversion (X9, X12, X13) or produce a row the target probe rejects. Unreadable
//   prompt files only with automatic resolution: the manual flow still stops (gate G2-2).
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { runRule } from '@/modules/task-execution/infrastructure/migration/run/rule'
import {
  allocationRule,
  blockSequenceWithoutRow,
  RUN_SEQUENCE_KEPT,
} from '@/modules/task-execution/infrastructure/migration/run/allocations'
import { emitRunEvidence } from '@/modules/task-execution/infrastructure/migration/run/evidence'
import type { RunDecision } from '@/modules/task-execution/infrastructure/migration/run/checkpoints'
import { convertConsumedInputs } from '@/modules/task-execution/infrastructure/migration/run/inputs'
import {
  convertPrompt,
  unreadablePromptStat,
} from '@/modules/task-execution/infrastructure/migration/run/prompts'
import { planRunSequences } from '@/modules/task-execution/infrastructure/migration/run/sequence'
import {
  ALLOCATION_NUMBER_COLUMNS,
  RUN_ROW_UNUSABLE,
  readableRun,
  unusableNumberColumns,
  unusableRowBlock,
} from '@/modules/task-execution/infrastructure/migration/run/source'
import {
  ConversionContractError,
  rowBlock,
} from '@/platform/persistence/migration/conversion/blockCodes'
import { createUnitCollector } from '@/platform/persistence/migration/conversion/receipts'
import type { RuleContext, RuleOutput } from '@/platform/persistence/migration/conversion/rule'
import { targetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import {
  RESOLUTION_CODES,
  type ArtifactReceipt,
  type ConversionBlock,
  type ConversionResolution,
  type MigrationRecord,
  type RowDisposition,
  type SourceRow,
  type UnitRef,
} from '@/platform/persistence/migration/conversion/types'
import type { ContentStat } from '@/platform/persistence/migration/conversion/content'
import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'
import { emptyV2Content } from './helpers/rfc395V2Harness'
import { runSource, sourceRow, taskFacts } from './helpers/rfc395V2/runFixtures'
import { UNPROVABLE_RUN_CODES } from './helpers/rfc626RunConversion'

const runDir = resolve(
  import.meta.dir,
  '../src/modules/task-execution/infrastructure/migration/run',
)
const CONTRACT = `sha256:${'a'.repeat(64)}`
const HUGE = 9007199254740993n

const unitRef: UnitRef = {
  kind: 'group',
  rule: runRule.ref.id,
  index: 0,
  firstGroup: 'task',
  lastGroup: 'task',
}
function collector(
  row: SourceRow,
  options: {
    readonly resolution?: ConversionResolution
    readonly mode?: 'convert' | 'discover'
    readonly settles?: boolean
  } = {},
) {
  const target = targetRegistryView(persistenceSchema)
  return createUnitCollector({
    rule: runRule,
    sourceRows: [row],
    sourceVersion: 'v0.19.2',
    sourceContract: CONTRACT,
    target,
    topology: target.tables.map((table) => table.id),
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    // The engine passes this when the rule declares `settles` (it does, see below).
    ...(options.settles === false
      ? {}
      : {
          settles: {
            tasksOf: (source: SourceRow) => [String(source.values.task_id)],
            isExecutable: () => true,
          },
        }),
  })
}
function evidenceContext(
  out: RuleOutput,
  resolution: ConversionResolution = 'operator',
): RuleContext {
  return {
    sourceVersion: 'v0.19.2',
    sourceProvider: 'sqlite',
    sourceGenerationId: 'dbg_source_fixture',
    preflight: { contract: null, fingerprint: { digest: CONTRACT } } as unknown as SourcePreflight,
    planTime: 123,
    target: targetRegistryView(persistenceSchema),
    lookup() {
      throw new Error('run evidence does not query lookups')
    },
    ids: {
      child() {
        throw new Error('run evidence does not allocate ids')
      },
    },
    content: emptyV2Content,
    resolution,
    out,
  }
}
const decision = (code: string): RunDecision => ({
  code,
  missingFields: ['fixture_field'],
  detail: { fixture: code },
  unprovable: true,
})

describe('RFC-626 run evidence: blockExecutable instead of block', () => {
  test('the run rule declares settles with the default task_id and no generation-0 output', () => {
    // The default `tasksOf` (the row's task_id); a group, keyed by that task id, covers only
    // its own task (gate G1-5: discovery leaves groups of finished tasks unread).
    expect(Object.keys(runRule.settles!)).toEqual(['tasksOfGroup'])
    expect(
      runRule.settles!.tasksOfGroup!('task-7', () => {
        throw new Error('the run groups need no lookup to name their task')
      }),
    ).toEqual(['task-7'])
    expect(runRule.produces.map((output) => output.table)).not.toContain(
      'task_execution_generations',
    )
    // The allocation ledger is not part of what an unfinished task needs to continue.
    expect(allocationRule.settles).toBeUndefined()
  })

  test('source text: the run evidence never blocks directly; generation 0 left the run rule', () => {
    const evidence = readFileSync(resolve(runDir, 'evidence.ts'), 'utf8')
    expect(evidence).toContain('ctx.out.blockExecutable(')
    expect(evidence).not.toContain('ctx.out.block(')
    const rule = readFileSync(resolve(runDir, 'rule.ts'), 'utf8')
    expect(rule).not.toContain('task_execution_generations')
    expect(rule).not.toContain('legacyGeneration')
    expect(existsSync(resolve(runDir, 'generations.ts'))).toBe(false)
  })

  for (const code of UNPROVABLE_RUN_CODES)
    test(`${code}: operator output is the block emitted before RFC-626, byte for byte`, () => {
      const row = runSource('run', { task_id: 'task', envelope_nonce: null })
      const facts = taskFacts('task', 'running')
      const viaExecutable = collector(row)
      emitRunEvidence(row, facts, [decision(code)], null, evidenceContext(viaExecutable.out))
      // The pre-RFC-626 emission: a plain block for the same row and detail.
      const viaBlock = collector(row)
      emitRunEvidence(
        row,
        facts,
        [decision(code)],
        null,
        evidenceContext({
          ...viaBlock.out,
          blockExecutable: (_task, block) => viaBlock.out.block(block),
        }),
      )
      const finish = (entry: ReturnType<typeof collector>) =>
        entry.finish({ unit: unitRef, unitId: 'unit', lookups: [] })
      const output = finish(viaExecutable)
      expect(output).toEqual(finish(viaBlock))
      expect(output.blocks).toEqual([
        rowBlock(
          code,
          row,
          { fixture: code, executableTask: { taskId: 'task', status: 'running' } },
          ['fixture_field'],
        ),
      ])
    })

  test('automatic discovery: every code becomes a settlement trigger and no block', () => {
    const row = runSource('run', { task_id: 'task' })
    const discovering = collector(row, { resolution: 'automatic', mode: 'discover' })
    emitRunEvidence(
      row,
      taskFacts('task', 'interrupted'),
      UNPROVABLE_RUN_CODES.map(decision),
      null,
      evidenceContext(discovering.out, 'automatic'),
    )
    expect(discovering.settlementTriggers()).toEqual(
      UNPROVABLE_RUN_CODES.map((code) => ({ taskId: 'task', code })),
    )
    expect(discovering.finish({ unit: unitRef, unitId: 'unit', lookups: [] }).blocks).toEqual([])
  })

  test('automatic conversion: an unfinished task still reaching blockExecutable is an engine fault', () => {
    const row = runSource('run', { task_id: 'task' })
    const converting = collector(row, { resolution: 'automatic', mode: 'convert' })
    expect(() =>
      emitRunEvidence(
        row,
        taskFacts('task', 'running'),
        [decision('v2-run-null-nonce')],
        null,
        evidenceContext(converting.out, 'automatic'),
      ),
    ).toThrow(RESOLUTION_CODES.settlementMissed)
  })

  test('without the settles declaration blockExecutable fails in both resolutions', () => {
    for (const resolution of ['operator', 'automatic'] as const) {
      const row = runSource('run', { task_id: 'task' })
      const undeclared = collector(row, { resolution, settles: false })
      expect(() =>
        emitRunEvidence(
          row,
          taskFacts('task', 'running'),
          [decision('v2-run-null-nonce')],
          null,
          evidenceContext(undeclared.out, resolution),
        ),
      ).toThrow('v2-settles-undeclared')
    }
  })

  test('a task that cannot continue (as after settlement) keeps the history-only path and never blocks', () => {
    for (const status of ['canceled', 'failed', 'done']) {
      const calls: string[] = []
      const dispositions: Omit<RowDisposition, 'rule'>[] = []
      const row = runSource('run', { task_id: 'task' })
      const entry = collector(row, { resolution: 'automatic', mode: 'convert' })
      emitRunEvidence(
        row,
        taskFacts('task', status),
        UNPROVABLE_RUN_CODES.map(decision),
        null,
        evidenceContext(
          {
            ...entry.out,
            block(block) {
              calls.push(`block:${block.code}`)
              entry.out.block(block)
            },
            blockExecutable(task, block) {
              calls.push(`blockExecutable:${block.code}`)
              entry.out.blockExecutable(task, block)
            },
            exception(disposition) {
              dispositions.push(disposition)
              entry.out.exception(disposition)
            },
          },
          'automatic',
        ),
      )
      expect(calls).toEqual([])
      expect(dispositions).toMatchObject([
        {
          kind: 'history-only',
          history: { taskId: 'task', runId: 'run', execution: taskFacts('task', status).execution },
          decision: { code: 'v2-run-history-only', detail: { codes: [...UNPROVABLE_RUN_CODES] } },
        },
      ])
    }
  })
})

describe('RFC-626 run sequence without a row (design §3.4 row 16)', () => {
  const stub = (resolution: ConversionResolution) => {
    const blocks: ConversionBlock[] = []
    const records: MigrationRecord[] = []
    const rows: { table: string; key: string }[] = []
    const ctx = {
      resolution,
      out: {
        block: (block: ConversionBlock) => blocks.push(block),
        record: (record: MigrationRecord) => records.push(record),
        row: (table: string, _values: unknown, origin: SourceRow) =>
          rows.push({ table, key: origin.encodedKey }),
      },
    } as unknown as RuleContext
    return { ctx, blocks, records, rows }
  }
  test('operator: the same global block as before; automatic: one kept decision, no block', () => {
    for (const sourceTable of [null, 'node_run_seq_allocations']) {
      const taskId = sourceTable === null ? 'empty-task' : null
      const manual = stub('operator')
      blockSequenceWithoutRow(manual.ctx, { sourceTable, taskId, error: 'Error: overflow' })
      expect(manual.records).toEqual([])
      expect(manual.blocks).toEqual([
        {
          code: 'v2-run-sequence',
          scope: 'global',
          sourceTable,
          sourceKey: null,
          taskId,
          runId: null,
          missingFields: ['seq'],
          detail: { error: 'Error: overflow' },
        },
      ])
      // Key order is part of the canonical bytes the plan digest is computed from.
      expect(Object.keys(manual.blocks[0]!)).toEqual([
        'code',
        'scope',
        'sourceTable',
        'sourceKey',
        'taskId',
        'runId',
        'missingFields',
        'detail',
      ])
      const automatic = stub('automatic')
      blockSequenceWithoutRow(automatic.ctx, { sourceTable, taskId, error: 'Error: overflow' })
      expect(automatic.blocks).toEqual([])
      expect(automatic.records).toEqual([
        {
          kind: 'decision',
          code: RUN_SEQUENCE_KEPT,
          payload: {
            automatic: 'kept',
            sourceTable,
            sourceKey: null,
            taskId,
            blockCode: 'v2-run-sequence',
            error: 'Error: overflow',
            identityHighWater: 'max-row',
          },
        },
      ])
    }
    expect(RUN_SEQUENCE_KEPT).toBe('v2-run-sequence-kept')
  })

  const allocationContext = (
    resolution: ConversionResolution,
    summary: { observedHighWater: number; allocationCount: number },
  ) => {
    const out = stub(resolution)
    const ctx = {
      ...out.ctx,
      resolution,
      preflight: { identityHighWater: [], identityEvidence: 'captured' },
      lookup: () => ({
        require: () => summary,
        get: () => taskFacts('task'),
      }),
    } as unknown as RuleContext
    return { ...out, ctx }
  }
  const allocationUnit = (rows: readonly SourceRow[]) => ({
    rows: new Map([['node_run_seq_allocations', rows]]),
  })

  test('allocation rule: an empty table past the safe range keeps the operator block and records the automatic decision', async () => {
    const overflow = { observedHighWater: Number.MAX_SAFE_INTEGER, allocationCount: 1 }
    const manual = allocationContext('operator', overflow)
    await allocationRule.convert(allocationUnit([]), manual.ctx)
    expect(manual.blocks).toEqual([
      {
        code: 'v2-run-sequence',
        scope: 'global',
        sourceTable: 'node_run_seq_allocations',
        sourceKey: null,
        taskId: null,
        runId: null,
        missingFields: ['seq'],
        detail: { error: 'Error: v2-run-sequence-range' },
      },
    ])
    const automatic = allocationContext('automatic', overflow)
    await allocationRule.convert(allocationUnit([]), automatic.ctx)
    expect(automatic.blocks).toEqual([])
    // No allocation high water: the target derives it from its largest row instead.
    expect(automatic.records).toEqual([
      {
        kind: 'decision',
        code: RUN_SEQUENCE_KEPT,
        payload: {
          automatic: 'kept',
          sourceTable: 'node_run_seq_allocations',
          sourceKey: null,
          taskId: null,
          blockCode: 'v2-run-sequence',
          error: 'Error: v2-run-sequence-range',
          identityHighWater: 'max-row',
        },
      },
    ])
  })

  // Gate G2-4: the base is one global value. The operator still gets a block on every row; the
  // automatic upgrade copies the rows, records the fallback once for the unit and leaves the high
  // water to the target's largest row, instead of setting every allocation row aside.
  test('allocation rule with rows past the safe range: operator blocks each row; automatic copies them and records the fallback', async () => {
    const row = sourceRow('node_run_seq_allocations', {
      seq: 7,
      task_id: 'task',
      node_run_id: 'run',
      allocated_at: 1,
    })
    const overflow = { observedHighWater: Number.MAX_SAFE_INTEGER, allocationCount: 1 }
    const manual = allocationContext('operator', overflow)
    await allocationRule.convert(allocationUnit([row]), manual.ctx)
    expect(manual.records).toEqual([])
    expect(manual.rows).toEqual([])
    expect(manual.blocks).toEqual([
      rowBlock('v2-run-sequence', row, { error: 'Error: v2-run-sequence-range' }, ['seq']),
    ])

    const automatic = allocationContext('automatic', overflow)
    await allocationRule.convert(allocationUnit([row]), automatic.ctx)
    expect(automatic.blocks).toEqual([])
    expect(automatic.rows).toEqual([{ table: 'node_run_seq_allocations', key: row.encodedKey }])
    expect(automatic.records).toEqual([
      {
        kind: 'decision',
        code: RUN_SEQUENCE_KEPT,
        payload: {
          automatic: 'kept',
          sourceTable: 'node_run_seq_allocations',
          sourceKey: null,
          taskId: null,
          blockCode: 'v2-run-sequence',
          error: 'Error: v2-run-sequence-range',
          identityHighWater: 'max-row',
        },
      },
    ])
  })

  test('allocation rule: an allocation seq past 2^53 is an unusable row, not a lookup failure', async () => {
    const huge = sourceRow('node_run_seq_allocations', {
      seq: HUGE,
      task_id: 'task',
      node_run_id: 'run',
      allocated_at: 1,
    })
    const entry = allocationContext('operator', { observedHighWater: 5, allocationCount: 0 })
    await allocationRule.convert(allocationUnit([huge]), entry.ctx)
    expect(entry.blocks).toEqual([unusableRowBlock(huge, ['seq'])])
    expect(entry.blocks[0]).toMatchObject({
      code: RUN_ROW_UNUSABLE,
      missingFields: ['seq'],
      detail: { unusable: [{ column: 'seq', value: String(HUGE) }] },
    })
  })
})

describe('RFC-626 numbers past 2^53 (blocks.md X9, X13)', () => {
  test('one predicate names every unusable number column', () => {
    expect(unusableNumberColumns(runSource('ok'))).toEqual([])
    expect(readableRun(runSource('ok'))).toBe(true)
    for (const column of [
      'seq',
      'iteration',
      'retry_index',
      'review_iteration',
      'wg_round',
      'started_at',
    ]) {
      const row = runSource('huge', { [column]: HUGE })
      expect(unusableNumberColumns(row)).toEqual([column])
      expect(readableRun(row)).toBe(false)
      expect(unusableRowBlock(row, [column])).toEqual(
        rowBlock(RUN_ROW_UNUSABLE, row, { unusable: [{ column, value: String(HUGE) }] }, [column]),
      )
    }
    expect(unusableNumberColumns(runSource('unsafe', { started_at: 2 ** 60 }))).toEqual([
      'started_at',
    ])
    // NULL is a value only where the column allows it.
    expect(
      unusableNumberColumns(runSource('nulls', { seq: null, wg_round: null, started_at: null })),
    ).toEqual([])
    expect(unusableNumberColumns(runSource('null-iteration', { iteration: null }))).toEqual([
      'iteration',
    ])
    expect(
      unusableNumberColumns(
        runSource('two', { iteration: HUGE, review_iteration: HUGE, retry_index: 1 }),
      ),
    ).toEqual(['iteration', 'review_iteration'])
    const allocation = sourceRow('node_run_seq_allocations', {
      seq: HUGE,
      task_id: 'task',
      node_run_id: 'run',
      allocated_at: 1,
    })
    expect(unusableNumberColumns(allocation, ALLOCATION_NUMBER_COLUMNS)).toEqual(['seq'])
    expect(
      unusableNumberColumns(
        sourceRow('node_run_seq_allocations', {
          seq: 3,
          task_id: 'task',
          node_run_id: 'run',
          allocated_at: 1,
        }),
        ALLOCATION_NUMBER_COLUMNS,
      ),
    ).toEqual([])
  })

  test('the sequence plan skips unusable runs and allocations instead of throwing', () => {
    const plans = planRunSequences(
      [
        runSource('a', { task_id: 'task', seq: 1 }),
        runSource('huge-seq', { task_id: 'task', seq: HUGE }),
        runSource('huge-iteration', { task_id: 'task', seq: 2, iteration: HUGE }),
        runSource('z', { task_id: 'task', seq: null }),
      ],
      [
        sourceRow('node_run_seq_allocations', {
          seq: HUGE,
          task_id: 'task',
          node_run_id: 'pruned',
          allocated_at: 1,
        }),
        sourceRow('node_run_seq_allocations', {
          seq: 40,
          task_id: 'task',
          node_run_id: 'pruned-2',
          allocated_at: 1,
        }),
      ],
    )
    const plan = plans.get('task')!
    expect(plan.error).toBeNull()
    expect(plan.runs.map((run) => run.id).sort()).toEqual(['a', 'z'])
    // Neither skipped row raises the observed high water.
    expect(plan.observedHighWater).toBe(40)
    expect(plan.runs.find((run) => run.id === 'z')!.seq).toBe(41)
  })
})

describe('RFC-626 run inputs whose producer is another node (both resolutions)', () => {
  const producers = new Map([['p', runSource('p', { node_id: 'a', shard_key: 'k' })]])
  test('the matching node keeps the reference', () => {
    const matched = convertConsumedInputs(
      runSource('c', { consumed_upstream_runs_json: '{"a":"p"}' }),
      producers,
    )
    expect(matched.decisions).toEqual([])
    expect(matched.inputs).toMatchObject([
      {
        producer_run_id: 'p',
        producer_run_ref: 'p',
        producer_node_id: 'a',
        evidence_ref_json: null,
        producer_shard_slot: 'shard-v1:key:"k"',
      },
    ])
  })
  test('another node takes the missing-producer path: reference cleared, evidence kept', () => {
    const mismatched = convertConsumedInputs(
      runSource('c', { consumed_upstream_runs_json: '{"b":"p"}' }),
      producers,
    )
    expect(mismatched.decisions).toEqual([
      {
        code: 'v2-run-input-producer-missing',
        detail: { producerRunId: 'p', producerNodeId: 'b', recordedNodeId: 'a' },
      },
    ])
    expect(mismatched.inputs).toEqual([
      {
        task_id: 'task',
        consumer_run_id: 'c',
        ordinal: 0,
        producer_run_id: 'p',
        producer_run_ref: null,
        provenance_quality: 'legacy-derived',
        evidence_ref_json: canonicalSchemaJson({
          code: 'v2-run-input-producer-missing',
          producerRunId: 'p',
          producerNodeId: 'b',
          recordedNodeId: 'a',
        }),
        input_kind: 'frame-input',
        producer_node_id: 'b',
        producer_shard_slot: 'shard-v1:none',
      },
    ])
  })
  test('a producer that does not exist keeps the evidence bytes it had before RFC-626', () => {
    const missing = convertConsumedInputs(
      runSource('c', { consumed_upstream_runs_json: '{"n":"gone"}' }),
      producers,
    )
    expect(missing.decisions).toEqual([
      {
        code: 'v2-run-input-producer-missing',
        detail: { producerRunId: 'gone', producerNodeId: 'n' },
      },
    ])
    expect(missing.inputs[0]!.evidence_ref_json).toBe(
      canonicalSchemaJson({
        code: 'v2-run-input-producer-missing',
        producerRunId: 'gone',
        producerNodeId: 'n',
      }),
    )
  })
})

describe('RFC-626 prompt files the inventory cannot read (blocks.md X12, automatic resolution)', () => {
  const promptRow = () => runSource('file', { prompt_path: 'task/prompts/file.md' })
  const promptContext = (
    stat: () => Promise<ContentStat>,
    resolution: ConversionResolution = 'automatic',
  ) => {
    const artifacts: ArtifactReceipt[] = []
    const ctx = {
      content: {
        stat,
        async read() {
          throw new Error('the run rule never reads prompt bytes')
        },
      },
      resolution,
      out: { artifact: (receipt: ArtifactReceipt) => artifacts.push(receipt) },
    } as unknown as RuleContext
    return { ctx, artifacts }
  }
  // Implementation gate G2-2: the fallback is the automatic upgrade's. With operator resolution
  // (the manual flow and the default) an unlisted or unreadable prompt file still ends the
  // conversion where it is found, as before RFC-626, and no receipt is written for it.
  test('operator: an unlisted or unreadable prompt file still ends the conversion', async () => {
    for (const error of [
      new Error('content-unlisted-present'),
      Object.assign(new Error("EACCES: permission denied, open 'file.md'"), { code: 'EACCES' }),
    ]) {
      const { ctx, artifacts } = promptContext(async () => {
        throw error
      }, 'operator')
      await expect(convertPrompt(promptRow(), ctx)).rejects.toBe(error)
      expect(artifacts).toEqual([])
    }
  })
  test('a file present but absent from the freeze listing is recorded as originally absent', async () => {
    const { ctx, artifacts } = promptContext(async () => {
      throw new Error('content-unlisted-present')
    })
    const result = await convertPrompt(promptRow(), ctx)
    expect(result.json).not.toBeNull()
    expect(result.decisions).toEqual([
      {
        code: 'v2-run-prompt-missing',
        missingFields: ['prompt_path'],
        detail: {
          state: 'absent',
          cause: 'originally-absent',
          evidence: 'content-unlisted-present: prompt file is absent from the freeze listing',
          path: 'task/prompts/file.md',
        },
        unprovable: false,
      },
    ])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      sourceColumn: 'prompt_path',
      originalReference: 'task/prompts/file.md',
      bytes: null,
      missing: {
        state: 'originally-absent',
        evidence: 'content-unlisted-present: prompt file is absent from the freeze listing',
      },
    })
  })
  test('a system error while reading is recorded as missing at freeze with the error text', async () => {
    const { ctx, artifacts } = promptContext(async () => {
      throw Object.assign(new Error("EACCES: permission denied, open 'file.md'"), {
        code: 'EACCES',
      })
    })
    const result = await convertPrompt(promptRow(), ctx)
    expect(result.decisions).toMatchObject([
      {
        code: 'v2-run-prompt-missing',
        unprovable: false,
        detail: { state: 'absent', cause: 'missing-at-freeze' },
      },
    ])
    expect(artifacts[0]!.missing).toEqual({
      state: 'missing-at-freeze',
      evidence: "prompt file unreadable: EACCES: permission denied, open 'file.md'",
    })
    expect(unreadablePromptStat('not an error')).toEqual({
      state: 'absent',
      cause: 'missing-at-freeze',
      evidence: 'prompt file unreadable: not an error',
    })
  })
  test('an engine contract error is still thrown', async () => {
    for (const resolution of ['automatic', 'operator'] as const) {
      const { ctx, artifacts } = promptContext(async () => {
        throw new ConversionContractError('v2-fixture-contract', 'engine fault')
      }, resolution)
      await expect(convertPrompt(promptRow(), ctx)).rejects.toThrow('v2-fixture-contract')
      expect(artifacts).toEqual([])
    }
  })
  test('an absent file and an inline prompt behave as before', async () => {
    const absent = promptContext(async () => ({
      state: 'absent' as const,
      cause: 'missing-at-freeze' as const,
      evidence: 'frozen inventory',
    }))
    expect((await convertPrompt(promptRow(), absent.ctx)).decisions).toEqual([
      {
        code: 'v2-run-prompt-missing',
        missingFields: ['prompt_path'],
        detail: {
          state: 'absent',
          cause: 'missing-at-freeze',
          evidence: 'frozen inventory',
          path: 'task/prompts/file.md',
        },
        unprovable: false,
      },
    ])
    const inline = promptContext(async () => {
      throw new Error('inline prompts are never looked up')
    })
    const result = await convertPrompt(runSource('inline', { prompt_text: 'hello' }), inline.ctx)
    expect(result.decisions).toEqual([])
    expect(inline.artifacts[0]!.missing).toBeNull()
  })
})
