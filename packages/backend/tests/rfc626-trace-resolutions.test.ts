// RFC-626 §3.2.3 "改写的留痕" and §3.3 "收尾处置 · 追溯"
// (design/RFC-626-upgrade-no-refusal-minimal-time/design.md). Two decisions of an automatic
// upgrade are not in a row's unit receipt, and tracing a source row has to show both:
//
//   - a row of a task the upgrade ended reads one state in the source and another in the
//     target; the trace — the ordinary one and the replayed one — carries what was rewritten;
//   - finalizing the target can move a target row to the archive after its unit committed.
//     Such a row is still the source row's target: it is listed as absent with the finalize
//     record and its archive. Guessing targets from the source key only finds rows that keep
//     it, so once a run has finalize records only rows kept as they are take that short way;
//     any other row is replayed for its complete set of targets and the records are laid over
//     the result.
//
// A run that has neither kind of record is traced exactly as before: no new field appears.
// The cases run the real engine, sink, finalize and metadata store on a real target; the
// replay port here does what the composition's does (explain the row by converting again).
import { describe, setDefaultTimeout, expect, test } from 'bun:test'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { explainSourceRow } from '@/platform/persistence/migration/conversion/trace'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'
import type { MigrationTraceResult } from '@/platform/persistence/migration/run/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { createMigrationTraceQuery } from '@/modules/system-operations/application/epochSwitch/trace'
import type { TraceReplayPort } from '@/modules/system-operations/application/ports/epochSwitch'
import {
  PLAN_TIME,
  UPGRADE_CODE,
  UPGRADE_SUMMARY,
  cancelSettlement,
  emissionRule,
  engineInput,
  frozenRow,
  fxRun,
  fxTask,
  memorySource,
  scratchRoots,
  sourceKey,
  targetKey,
  taskFactsFromTasks,
  type Emission,
  type MemorySource,
} from './rfc626-engine-fixtures.test'
import {
  convertedSource,
  fixtureHandle,
  keepPolicies,
  run,
  runInput,
  task,
  type ConvertedTarget,
} from './rfc626-target-fixtures.test'

// Installing the fixture schema, converting into it, finalizing and replaying takes a few
// seconds per case on a CI-scaled PostgreSQL; 60 s leaves the margin the other target tests use.
setDefaultTimeout(60_000)

const scratch = scratchRoots()
const dangling = { policies: keepPolicies }
const ARCHIVE = /^archive:sha256:[a-f0-9]{64}$/

// ---- rows that keep their key, and rows whose targets have keys of their own ----------------

/** Kept as it is: the source row becomes the target row with the same key. */
const keptRule: ConversionRule = {
  ...emissionRule,
  ref: { id: 'fixture/kept-as-is', version: 1 },
  disposition: 'preserved',
}
/** Like `keptRule`; a row that lists nothing is inconsistent and blocks. */
const keptWithDefects: ConversionRule = {
  ...keptRule,
  ref: { id: 'fixture/kept-with-defects', version: 1 },
  convert(unit, ctx) {
    for (const row of unit.rows.get('maintenance_state')!) {
      const emissions = JSON.parse(String(row.values.value)) as readonly Emission[]
      if (!emissions.length) ctx.out.block(rowBlock('fixture-inconsistent', row, null))
      for (const emission of emissions) ctx.out.row(emission.table, emission.values, row)
    }
  },
}
/** A run and its inputs from one source row: the inputs have keys the source row does not. */
const derivedRule: ConversionRule = {
  ref: { id: 'fixture/derived', version: 1 },
  owner: 'fixture',
  claims: ['recovery_events'],
  produces: [{ table: 'fx_runs' }, { table: 'fx_run_inputs' }],
  lookups: [],
  unit: { kind: 'source-chunk', table: 'recovery_events' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('recovery_events')!)
      for (const emission of JSON.parse(String(row.values.reason)) as readonly Emission[])
        ctx.out.row(emission.table, emission.values, row)
  },
}
const kept = (key: string, ...emissions: Emission[]): DecodedSourceRow =>
  frozenRow('maintenance_state', { key, value: JSON.stringify(emissions), updated_at: 1 })
const derived = (id: string, ...emissions: Emission[]): DecodedSourceRow =>
  frozenRow('recovery_events', { id, reason: JSON.stringify(emissions) })
/**
 * `run-gone` and `run-up` belong to `missing`, a task that is not there unless `sound`; the
 * input of `run-body` waits on `run-up`.
 */
function runsSource(sound: boolean): MemorySource {
  return memorySource({
    maintenance_state: [
      kept('task-ok', task('task-ok')),
      ...(sound ? [kept('missing', task('missing'))] : []),
      kept('run-gone', run('run-gone', 'missing')),
      kept('run-kept', run('run-kept', 'task-ok')),
      kept('run-up', run('run-up', 'missing')),
    ],
    recovery_events: [
      derived('run-body', run('run-body', 'task-ok'), runInput('run-body', 'in', 'run-up')),
      derived('run-plain', run('run-plain', 'task-ok'), runInput('run-plain', 'in', null)),
    ],
  })
}
const runsRules: readonly ConversionContribution[] = [
  { rules: [keptRule, derivedRule], lookups: [], validators: [] },
]

// ---- a task the upgrade ends -----------------------------------------------------------------

const tasksRule: ConversionRule = {
  ref: { id: 'fixture/tasks', version: 1 },
  owner: 'fixture',
  claims: ['tasks'],
  produces: [{ table: 'fx_tasks' }],
  lookups: [],
  unit: { kind: 'source-chunk', table: 'tasks' },
  settles: {},
  convert(unit, ctx) {
    for (const row of unit.rows.get('tasks')!)
      ctx.out.row(
        'fx_tasks',
        fxTask(String(row.values.id), { status: String(row.values.status) }),
        row,
      )
  },
}
/**
 * A run becomes a run under a key of its own. Without a nonce it cannot be proven while its
 * task could still continue.
 */
const runsRule: ConversionRule = {
  ref: { id: 'fixture/runs', version: 1 },
  owner: 'fixture',
  claims: ['node_runs'],
  produces: [{ table: 'fx_runs' }],
  lookups: [TASK_FACTS],
  unit: { kind: 'source-chunk', table: 'node_runs' },
  settles: {},
  convert(unit, ctx) {
    for (const row of unit.rows.get('node_runs')!) {
      const facts = ctx.lookup(TASK_FACTS).get(String(row.values.task_id))
      if (facts?.execution === 'executable' && row.values.envelope_nonce === null) {
        ctx.out.blockExecutable(
          { taskId: facts.taskId, status: facts.status },
          rowBlock('fixture-run-unprovable', row, null),
        )
        continue
      }
      ctx.out.row(
        'fx_runs',
        fxRun(`converted-${String(row.values.id)}`, String(row.values.task_id), {
          status: String(row.values.status),
        }),
        row,
      )
    }
  },
}
function endedSource(): MemorySource {
  return memorySource({
    tasks: [
      frozenRow('tasks', { id: 't-broken', status: 'interrupted' }),
      frozenRow('tasks', { id: 't-sound', status: 'done' }),
    ],
    node_runs: [
      frozenRow('node_runs', {
        id: 'r-broken',
        task_id: 't-broken',
        status: 'awaiting_human',
        envelope_nonce: null,
      }),
      frozenRow('node_runs', {
        id: 'r-sound',
        task_id: 't-sound',
        status: 'done',
        envelope_nonce: 'nonce',
      }),
    ],
  })
}
const endedRules: readonly ConversionContribution[] = [
  {
    rules: [tasksRule, runsRule],
    lookups: [taskFactsFromTasks],
    validators: [],
    settlement: cancelSettlement,
  },
]
const rewritten = (before: string | null, after: string | number) => ({
  before: canonicalValue(before),
  after: canonicalValue(after),
})
const taskRewrite = {
  taskId: 't-broken',
  cause: 'unprovable-records',
  columns: {
    status: rewritten('interrupted', 'canceled'),
    finished_at: rewritten(null, PLAN_TIME),
    error_summary: rewritten(null, UPGRADE_SUMMARY),
    error_message: rewritten(null, UPGRADE_CODE),
  },
}
const runRewrite = {
  taskId: 't-broken',
  cause: 'unprovable-records',
  columns: {
    status: rewritten('awaiting_human', 'canceled'),
    finished_at: rewritten(null, PLAN_TIME),
    error_message: rewritten(null, UPGRADE_CODE),
  },
}

// ---- tracing -----------------------------------------------------------------------------------

/** What the composition's replay does: convert again, explain the row, probe its targets. */
function replaying(f: ConvertedTarget, asked: string[] = []): TraceReplayPort {
  return {
    async replay(query) {
      asked.push(encodeMigrationKey(query.table, query.key))
      const result = await explainSourceRow(
        f.replayInput(),
        query.table,
        query.key,
        query.phase ?? 'current',
      )
      return {
        runId: query.run.runId,
        sourceTable: result.sourceTable,
        sourceKey: result.sourceKey,
        sourcePhase: result.sourcePhase,
        proof: result.found ? ('replay' as const) : ('not-found' as const),
        class: result.class,
        dispositions: result.dispositions,
        unit: null,
        targets: await Promise.all(
          result.targets.map(async (target) => ({
            ...target,
            probed: true,
            present: await f.meta.probeTarget(target),
          })),
        ),
        artifacts: [],
        restrictions: [],
        blocks: result.blocks,
        archive: result.dispositions.find((row) => row.archive)?.archive ?? null,
      }
    },
  }
}
function tracing(h: V3Harness, f: ConvertedTarget, replay?: TraceReplayPort) {
  const query = createMigrationTraceQuery({ meta: f.meta, ...(replay ? { replay } : {}) })
  return (table: string, id: string): Promise<MigrationTraceResult> =>
    query({ operationId: h.operationId, table, key: [canonicalValue(id)] })
}
const moved = (table: string, key: string, foreignKey: string, references: string) => ({
  targetTable: table,
  targetKey: key,
  foreignKey,
  references,
  action: 'set-aside',
  archive: expect.stringMatching(ARCHIVE),
})

describeV3Providers('RFC-626 trace: rows finalize moved to the archive', (h) => {
  async function finalized(sound: boolean) {
    const f = await convertedSource(h, runsSource(sound), runsRules)
    const report = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    expect(report.violations).toEqual([])
    return { f, report }
  }

  test('a row kept as it is takes the short way; its moved target is listed as absent with the archive', async () => {
    const { f, report } = await finalized(false)
    expect(report.dispositions).toHaveLength(3)
    // No replay port at all: these rows must not need one.
    const trace = tracing(h, f)

    const gone = await trace('maintenance_state', 'run-gone')
    const key = targetKey('fx_runs', 'run-gone')
    expect(gone).toEqual<unknown>({
      runId: f.runId,
      sourceTable: 'maintenance_state',
      sourcePhase: 'current',
      sourceKey: sourceKey('maintenance_state', 'run-gone'),
      proof: 'unit-range',
      class: 'preserved',
      dispositions: [],
      unit: expect.objectContaining({ rule: { id: 'fixture/kept-as-is', version: 1 } }),
      targets: [
        {
          table: 'fx_runs',
          key,
          probed: true,
          present: false,
          finalized: [moved('fx_runs', key, 'fx_runs_task_fk', 'fx_tasks')],
        },
      ],
      artifacts: [],
      restrictions: [],
      blocks: [],
      archive: null,
    })
    // The archive it names is the one finalize stored.
    const ref = gone.targets[0]!.finalized![0]!.archive!
    expect(await f.meta.archive({ runId: f.runId, ref })).not.toBeNull()

    // A row of the same unit whose target is still there is traced as it always was.
    const stays = await trace('maintenance_state', 'run-kept')
    expect(stays).toMatchObject({ proof: 'unit-range', class: 'preserved' })
    expect(stays.targets).toStrictEqual([
      { table: 'fx_runs', key: targetKey('fx_runs', 'run-kept'), probed: true, present: true },
    ])
    expect(stays).not.toHaveProperty('settlement')
  })

  test('a row whose targets have keys of their own is replayed, and the finalize record is laid over the result', async () => {
    const { f } = await finalized(false)
    const asked: string[] = []
    const trace = tracing(h, f, replaying(f, asked))

    // The run itself is still there; its input waited on a run that was moved away.
    const body = await trace('recovery_events', 'run-body')
    const input = targetKey('fx_run_inputs', 'run-body', 'in')
    expect(body).toMatchObject({ proof: 'replay', class: 'converted', dispositions: [] })
    expect(body.targets).toEqual<unknown>([
      { table: 'fx_runs', key: targetKey('fx_runs', 'run-body'), probed: true, present: true },
      {
        table: 'fx_run_inputs',
        key: input,
        probed: true,
        present: false,
        finalized: [moved('fx_run_inputs', input, 'fx_run_inputs_upstream_fk', 'fx_runs')],
      },
    ])
    expect(body.targets[0]).not.toHaveProperty('finalized')

    // Replayed as well, because only a replay knows all of its targets; nothing was moved.
    const plain = await trace('recovery_events', 'run-plain')
    expect(plain.proof).toBe('replay')
    expect(plain.targets).toStrictEqual([
      { table: 'fx_runs', key: targetKey('fx_runs', 'run-plain'), probed: true, present: true },
      {
        table: 'fx_run_inputs',
        key: targetKey('fx_run_inputs', 'run-plain', 'in'),
        probed: true,
        present: true,
      },
    ])

    // Rows kept as they are never asked for a replay.
    await trace('maintenance_state', 'run-gone')
    await trace('maintenance_state', 'task-ok')
    expect(asked).toEqual([
      sourceKey('recovery_events', 'run-body'),
      sourceKey('recovery_events', 'run-plain'),
    ])
  })

  test('without a replay port such a row cannot be explained: v3-trace-replay-required', async () => {
    const { f } = await finalized(false)
    await expect(tracing(h, f)('recovery_events', 'run-body')).rejects.toThrow(
      'v3-trace-replay-required',
    )
  })

  test('a run without finalize records is traced exactly as before', async () => {
    // Every reference is satisfied: finalize resolves nothing and records nothing.
    const { f, report } = await finalized(true)
    expect(report.dispositions).toEqual([])
    const asked: string[] = []
    const trace = tracing(h, f, replaying(f, asked))
    const unit = {
      unitId: expect.any(String),
      receiptDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      groups: null,
    }
    /** The fields a trace result had before this RFC, and no other — not even an empty one. */
    const expectFormerShape = (result: MigrationTraceResult): void => {
      expect(Object.keys(result).sort()).toEqual([
        'archive',
        'artifacts',
        'blocks',
        'class',
        'dispositions',
        'proof',
        'restrictions',
        'runId',
        'sourceKey',
        'sourcePhase',
        'sourceTable',
        'targets',
        'unit',
      ])
      for (const target of result.targets)
        expect(Object.keys(target).sort()).toEqual(['key', 'present', 'probed', 'table'])
    }

    const keptRow = await trace('maintenance_state', 'run-kept')
    expectFormerShape(keptRow)
    expect(keptRow).toEqual<unknown>({
      runId: f.runId,
      sourceTable: 'maintenance_state',
      sourcePhase: 'current',
      sourceKey: sourceKey('maintenance_state', 'run-kept'),
      proof: 'unit-range',
      class: 'preserved',
      dispositions: [],
      unit: {
        ...unit,
        rule: { id: 'fixture/kept-as-is', version: 1 },
        range: {
          firstKey: expect.stringMatching(/^mk1:/),
          lastKey: expect.stringMatching(/^mk1:/),
        },
      },
      targets: [
        { table: 'fx_runs', key: targetKey('fx_runs', 'run-kept'), probed: true, present: true },
      ],
      artifacts: [],
      restrictions: [],
      blocks: [],
      archive: null,
    })
    // The short way, as before: the target that keeps the source key, and no replay.
    const derivedRow = await trace('recovery_events', 'run-body')
    expectFormerShape(derivedRow)
    expect(derivedRow).toEqual<unknown>({
      runId: f.runId,
      sourceTable: 'recovery_events',
      sourcePhase: 'current',
      sourceKey: sourceKey('recovery_events', 'run-body'),
      proof: 'unit-range',
      class: 'converted',
      dispositions: [],
      unit: {
        ...unit,
        rule: { id: 'fixture/derived', version: 1 },
        range: {
          firstKey: sourceKey('recovery_events', 'run-body'),
          lastKey: sourceKey('recovery_events', 'run-plain'),
        },
      },
      targets: [
        { table: 'fx_runs', key: targetKey('fx_runs', 'run-body'), probed: true, present: true },
      ],
      artifacts: [],
      restrictions: [],
      blocks: [],
      archive: null,
    })
    expect(asked).toEqual([])
  })
})

describeV3Providers(
  'RFC-626 trace: a unit that set a row aside beside rows kept as they are',
  (h) => {
    async function finalized() {
      const f = await convertedSource(
        h,
        memorySource({
          maintenance_state: [
            // The first unit holds both: one row set aside, one row kept as it is.
            kept('a-defect'),
            kept('a-kept', task('a-kept')),
            kept('run-gone', run('run-gone', 'missing')),
          ],
        }),
        [{ rules: [keptWithDefects], lookups: [], validators: [] }],
        { resolution: 'automatic' },
      )
      expect(f.summary.resolutions!.setAside.total).toBe(1)
      const report = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
      expect(report.dispositions).toHaveLength(1)
      return f
    }

    test('the row the conversion set aside is explained by its own disposition', async () => {
      const f = await finalized()
      const aside = await tracing(h, f)('maintenance_state', 'a-defect')
      expect(aside).toMatchObject({
        proof: 'row-disposition',
        class: 'archived',
        targets: [],
        archive: expect.stringMatching(ARCHIVE),
        dispositions: [
          {
            class: 'archived',
            kind: 'archived',
            targets: [],
            decision: { code: 'fixture-inconsistent', detail: null },
          },
        ],
      })
      expect(aside).not.toHaveProperty('settlement')
    })

    // Design §3.3: "本轮运行有收尾处置、且该来源行所属规则不是原样保留时，trace 不走快路径". The row
    // belongs to a rule that keeps rows as they are, and a row without a disposition in a unit
    // that converted nothing under another key is such a row: its target is the one with its key.
    test('the kept row of that unit still takes the short way and needs no replay', async () => {
      const f = await finalized()
      const stays = await tracing(h, f)('maintenance_state', 'a-kept')
      expect(stays.proof).toBe('unit-range')
      expect(stays.targets).toStrictEqual([
        { table: 'fx_tasks', key: targetKey('fx_tasks', 'a-kept'), probed: true, present: true },
      ])
    })
  },
)

describeV3Providers('RFC-626 trace: rows of a task the upgrade ended', (h) => {
  test('the ordinary trace and the replayed one both carry what ending the task rewrote', async () => {
    const f = await convertedSource(h, endedSource(), endedRules, { resolution: 'automatic' })
    expect(f.plan.settlements).toEqual([
      {
        taskId: 't-broken',
        cause: 'unprovable-records',
        originalStatus: 'interrupted',
        blockCodes: ['fixture-run-unprovable'],
        parentTaskId: null,
      },
    ])
    const asked: string[] = []
    const trace = tracing(h, f, replaying(f, asked))

    // The task row keeps its key: the short way. Source says interrupted, target canceled.
    const ended = await trace('tasks', 't-broken')
    expect(ended).toMatchObject({
      proof: 'unit-range',
      class: 'converted',
      targets: [
        { table: 'fx_tasks', key: targetKey('fx_tasks', 't-broken'), probed: true, present: true },
      ],
    })
    expect(ended.settlement).toEqual<unknown>(taskRewrite)
    expect(asked).toEqual([])

    // The run has a key of its own in the target, so it is replayed; the note is there too.
    const endedRun = await trace('node_runs', 'r-broken')
    expect(endedRun).toMatchObject({
      proof: 'replay',
      class: 'converted',
      targets: [
        {
          table: 'fx_runs',
          key: targetKey('fx_runs', 'converted-r-broken'),
          probed: true,
          present: true,
        },
      ],
    })
    expect(endedRun.settlement).toEqual<unknown>(runRewrite)
    expect(asked).toEqual([sourceKey('node_runs', 'r-broken')])

    // Rows of a task nobody ended say nothing about a rewrite.
    expect(await trace('tasks', 't-sound')).not.toHaveProperty('settlement')
    expect(await trace('node_runs', 'r-sound')).not.toHaveProperty('settlement')
  })
})

describe('RFC-626 replay: explaining a source row', () => {
  const explain = (table: string, id: string, resolution?: 'automatic') =>
    explainSourceRow(
      engineInput(endedSource(), endedRules, {
        scratchRoot: scratch(),
        ...(resolution ? { resolution } : {}),
      }),
      table,
      [canonicalValue(id)],
    )

  test('the explanation of a rewritten row carries the rewrite; any other row carries none', async () => {
    const ended = await explain('tasks', 't-broken', 'automatic')
    expect(ended).toMatchObject({ found: true, class: 'converted', blocks: [] })
    expect(ended.settlement).toEqual<unknown>(taskRewrite)
    expect((await explain('node_runs', 'r-broken', 'automatic')).settlement).toEqual<unknown>(
      runRewrite,
    )
    expect((await explain('node_runs', 'r-sound', 'automatic')).settlement).toBeNull()
  })

  test('under operator resolution nothing is rewritten and the row is blocked as before', async () => {
    const blocked = await explain('node_runs', 'r-broken')
    expect(blocked).toMatchObject({ found: true, class: 'blocked', targets: [] })
    expect(blocked.blocks.map((block) => block.code)).toEqual(['fixture-run-unprovable'])
    expect(blocked.settlement ?? null).toBeNull()
    expect((await explain('tasks', 't-broken')).settlement ?? null).toBeNull()
  })
})
