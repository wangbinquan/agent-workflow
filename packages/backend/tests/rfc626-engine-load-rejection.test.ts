// RFC-626 §3.3 "装载被目标库拒绝" (design/RFC-626-upgrade-no-refusal-minimal-time/design.md):
// with automatic resolution a sink whose target refuses rows of a unit commits nothing of it
// and returns every refused target row. The engine turns them into one decision per source
// row involved (phase, table and key of the source row, and all of its refused targets,
// sorted), collects the unit again with those source rows set aside, and commits again. The
// decision is the detail of the disposition, so it is persisted with the unit; a sink that
// opens a run hands the decisions of committed units back verbatim and the engine applies
// them before it converts such a unit again, which gives the committed bytes without asking
// the target a second time. A refused row nobody can attribute to a source row is an error.
//
// These cases run the engine against a recording sink that plays the target database; the
// real sink is covered in rfc626-sink-load-rejection.test.ts.
import { describe, expect, test } from 'bun:test'
import {
  prepareConversion,
  runConversion,
} from '@/platform/persistence/migration/conversion/engine'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { createUnitCollector } from '@/platform/persistence/migration/conversion/receipts'
import { targetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import { targetTopology } from '@/platform/persistence/migration/conversion/topology'
import { explainSourceRow } from '@/platform/persistence/migration/conversion/trace'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import type {
  LoadRejectionDecision,
  SourceRow,
  TargetLoadRejection,
  UnitOutput,
} from '@/platform/persistence/migration/conversion/types'
import {
  RecordingSink,
  engineInput,
  fixtureTarget,
  frozenRow,
  fxRun,
  fxTask,
  memorySource,
  noteRule,
  scratchRoots,
  sourceKey,
  targetKey,
  taskFactsFromTasks,
} from './rfc626-engine-fixtures.test'

const scratch = scratchRoots()

const LOAD_REJECTED = 'v3-target-load-rejected'

/** Every source row becomes a user and a mission: two target rows, the second under another key. */
function pairRule(overrides: Partial<ConversionRule> = {}): ConversionRule {
  return {
    ref: { id: 'fixture/pairs', version: 1 },
    owner: 'fixture',
    claims: ['maintenance_state'],
    produces: [{ table: 'fx_users' }, { table: 'fx_missions' }],
    lookups: [],
    unit: { kind: 'source-chunk', table: 'maintenance_state' },
    convert(unit, ctx) {
      for (const row of unit.rows.get('maintenance_state')!) {
        const id = String(row.values.key)
        ctx.out.row('fx_users', { id, name: String(row.values.value) }, row)
        ctx.out.row('fx_missions', { id: `mission-${id}`, reopened_from: null }, row)
      }
    },
    ...overrides,
  }
}
function input(rule: ConversionRule = pairRule(), resolution?: 'automatic'): ConversionInput {
  return engineInput(
    memorySource({
      maintenance_state: ['a', 'b', 'c', 'd'].map((key) =>
        frozenRow('maintenance_state', { key, value: `name-${key}`, updated_at: 1 }),
      ),
    }),
    [{ rules: [rule], lookups: [], validators: [] }],
    { scratchRoot: scratch(), ...(resolution ? { resolution } : {}) },
  )
}
interface Refusal {
  readonly table: string
  readonly id: string
}
function rejection(refusal: Refusal): TargetLoadRejection {
  return {
    table: refusal.table,
    targetKey: targetKey(refusal.table, refusal.id),
    constraint: `${refusal.table}_pkey`,
    message: `duplicate key ${refusal.table}/${refusal.id}`,
  }
}
/** The target refuses these rows whenever an attempt contains them, in the order given. */
function refusing(...refusals: readonly Refusal[]) {
  return (output: UnitOutput): TargetLoadRejection[] =>
    refusals
      .filter((refusal) =>
        output.rows.some(
          (group) =>
            group.table === refusal.table && group.rows.some((row) => row.id === refusal.id),
        ),
      )
      .map(rejection)
}
function decision(source: string, ...refusals: readonly Refusal[]): LoadRejectionDecision {
  return {
    sourcePhase: 'current',
    sourceTable: 'maintenance_state',
    sourceKey: sourceKey('maintenance_state', source),
    targets: refusals.map((refusal) => {
      const refused = rejection(refusal)
      return {
        table: refused.table,
        key: refused.targetKey,
        constraint: refused.constraint,
        message: refused.message,
      }
    }),
  }
}
const stateKey = (id: string) => sourceKey('maintenance_state', id)
function ids(sink: RecordingSink, table: string): string[] {
  return sink
    .rows(table)
    .map((row) => String(row.id))
    .sort()
}
function attemptsOf(sink: RecordingSink, unitId: string): UnitOutput[] {
  return sink.attempts.filter((attempt) => attempt.receipt.unitId === unitId)
}

describe('RFC-626 a unit the target refuses', () => {
  test('the source row of a refused target row is set aside with the decision and the unit is committed again', async () => {
    const sink = new RecordingSink()
    sink.refuse = refusing({ table: 'fx_missions', id: 'mission-b' })
    const summary = await runConversion(input(pairRule(), 'automatic'), sink)
    expect(summary.blocks).toEqual([])
    expect(summary.status).toBe('converted')

    const unit = sink.unitOf('maintenance_state', stateKey('b'))
    // One refused attempt, then the committed one.
    expect(attemptsOf(sink, unit.receipt.unitId)).toHaveLength(2)
    expect(attemptsOf(sink, unit.receipt.unitId)[1]).toBe(unit)
    // One of its two target rows was refused; neither is written.
    expect(ids(sink, 'fx_users')).toEqual(['a', 'c', 'd'])
    expect(ids(sink, 'fx_missions')).toEqual(['mission-a', 'mission-c', 'mission-d'])
    const expected = decision('b', { table: 'fx_missions', id: 'mission-b' })
    expect(sink.dispositions()).toEqual<unknown>([
      {
        sourceTable: 'maintenance_state',
        sourceKey: stateKey('b'),
        sourcePhase: 'current',
        class: 'archived',
        kind: 'archived',
        targets: [],
        archive: expect.stringMatching(/^archive:sha256:[a-f0-9]{64}$/),
        rule: { id: 'fixture/pairs', version: 1 },
        decision: { code: LOAD_REJECTED, detail: expected },
      },
    ])
    expect(unit.archives.map((archive) => archive.ref)).toEqual([sink.dispositions()[0]!.archive!])
    expect(unit.receipt.sources[0]!.counts).toEqual({
      converted: 1,
      preserved: 0,
      archived: 1,
      blocked: 0,
    })
    expect(summary.resolutions!.setAside).toEqual({
      total: 1,
      rows: [
        {
          sourcePhase: 'current',
          sourceTable: 'maintenance_state',
          sourceKey: stateKey('b'),
          code: LOAD_REJECTED,
        },
      ],
    })
    expect(summary.tableReceipts[0]).toMatchObject({
      rowsRead: 4,
      counts: { converted: 3, preserved: 0, archived: 1, blocked: 0 },
      targets: [
        { table: 'fx_missions', rows: 3 },
        { table: 'fx_users', rows: 3 },
      ],
    })
  })

  test('one decision per source row lists all of its refused targets in table, key, constraint order', async () => {
    const sink = new RecordingSink()
    // Reported users first; the decision lists them by target table.
    sink.refuse = refusing(
      { table: 'fx_users', id: 'd' },
      { table: 'fx_users', id: 'c' },
      { table: 'fx_missions', id: 'mission-c' },
    )
    const summary = await runConversion(input(pairRule(), 'automatic'), sink)
    expect(summary.status).toBe('converted')
    const byKey = Object.fromEntries(
      sink.dispositions().map((entry) => [entry.sourceKey, entry.decision]),
    )
    expect(byKey).toEqual<unknown>({
      [stateKey('c')]: {
        code: LOAD_REJECTED,
        detail: decision(
          'c',
          { table: 'fx_missions', id: 'mission-c' },
          { table: 'fx_users', id: 'c' },
        ),
      },
      [stateKey('d')]: {
        code: LOAD_REJECTED,
        detail: decision('d', { table: 'fx_users', id: 'd' }),
      },
    })
    expect(ids(sink, 'fx_users')).toEqual(['a', 'b'])
    expect(ids(sink, 'fx_missions')).toEqual(['mission-a', 'mission-b'])
  })

  test('a later attempt can be refused for other rows: the decisions only grow until the unit commits', async () => {
    const sink = new RecordingSink()
    const refuse = refusing({ table: 'fx_users', id: 'c' })
    const refuseNext = refusing({ table: 'fx_missions', id: 'mission-d' })
    // The second refusal only shows once the first row is out of the way.
    sink.refuse = (output) => {
      const first = refuse(output)
      return first.length ? first : refuseNext(output)
    }
    const summary = await runConversion(input(pairRule(), 'automatic'), sink)
    expect(summary.status).toBe('converted')
    const unit = sink.unitOf('maintenance_state', stateKey('c'))
    expect(attemptsOf(sink, unit.receipt.unitId)).toHaveLength(3)
    expect(unit.rows).toEqual([])
    const byDigest = (a: unknown, b: unknown): number =>
      valueDigest(a).localeCompare(valueDigest(b))
    expect(unit.dispositions.map((entry) => entry.decision).sort(byDigest)).toEqual<unknown>(
      [
        { code: LOAD_REJECTED, detail: decision('c', { table: 'fx_users', id: 'c' }) },
        { code: LOAD_REJECTED, detail: decision('d', { table: 'fx_missions', id: 'mission-d' }) },
      ].sort(byDigest),
    )
    expect(summary.resolutions!.setAside.total).toBe(2)
  })

  test('a refused target row without a source row is an engine error', async () => {
    const detached = pairRule({
      convert(unit, ctx) {
        for (const row of unit.rows.get('maintenance_state')!)
          ctx.out.row('fx_users', { id: String(row.values.key), name: 'from a row' }, row)
        // Produced from nothing: no source row can be set aside for it.
        if (unit.rows.get('maintenance_state')!.some((row) => row.values.key === 'a'))
          ctx.out.row('fx_users', { id: 'detached', name: 'from nothing' }, null)
      },
    })
    const sink = new RecordingSink()
    sink.refuse = refusing({ table: 'fx_users', id: 'detached' })
    await expect(runConversion(input(detached, 'automatic'), sink)).rejects.toBeInstanceOf(
      ConversionContractError,
    )
    expect(sink.units.size).toBe(0)

    // A row the unit never produced cannot be attributed either.
    const unknown = new RecordingSink()
    unknown.refuse = () => [rejection({ table: 'fx_users', id: 'never-produced' })]
    await expect(runConversion(input(pairRule(), 'automatic'), unknown)).rejects.toBeInstanceOf(
      ConversionContractError,
    )
  })

  test('under operator resolution a sink has no business returning refusals', async () => {
    const sink = new RecordingSink()
    sink.refuse = refusing({ table: 'fx_users', id: 'a' })
    await expect(runConversion(input(), sink)).rejects.toBeInstanceOf(ConversionContractError)
  })

  test('a refused row of an unfinished task under a `settles` rule is what discovery could not see: v2-settlement-missed', async () => {
    const runs: ConversionRule = {
      ...noteRule('node_runs'),
      ref: { id: 'fixture/runs', version: 1 },
      produces: [{ table: 'fx_runs' }],
      lookups: [TASK_FACTS],
      settles: {},
      convert(unit, ctx) {
        for (const row of unit.rows.get('node_runs')!)
          ctx.out.row('fx_runs', fxRun(String(row.values.id), String(row.values.task_id)), row)
      },
    }
    const convert = (status: string) => {
      const sink = new RecordingSink()
      sink.refuse = refusing({ table: 'fx_runs', id: 'run-1' })
      return {
        sink,
        run: runConversion(
          engineInput(
            memorySource({
              tasks: [frozenRow('tasks', { id: 'task-1', status })],
              node_runs: [
                frozenRow('node_runs', { id: 'run-1', task_id: 'task-1', status: 'done' }),
              ],
            }),
            [{ rules: [noteRule('tasks'), runs], lookups: [taskFactsFromTasks], validators: [] }],
            { scratchRoot: scratch(), resolution: 'automatic' },
          ),
          sink,
        ),
      }
    }
    await expect(convert('running').run).rejects.toThrow('v2-settlement-missed')
    // The same refusal on a row of a finished task is an ordinary set-aside.
    const finished = convert('done')
    expect((await finished.run).status).toBe('converted')
    expect(finished.sink.dispositions().map((entry) => entry.decision?.code)).toEqual([
      LOAD_REJECTED,
    ])
  })
})

// Implementation gate G1-3 (RFC-626): only the chunk form of a refusal was covered. In a group
// rule a refused row is out of the unit before the rule runs, so design §3.3 "the group
// semantics stay" applies: the whole group is set aside, and an unfinished task's group is what
// discovery could not see. Gate G2-1: a row of a `preservedClaims` table is a record attached to
// its group; refused or undecodable on its own, it takes only itself out.
describe('RFC-626 a group whose row the target refuses', () => {
  const groupRule = (overrides: Partial<ConversionRule> = {}): ConversionRule => ({
    ref: { id: 'fixture/task-groups', version: 1 },
    owner: 'fixture',
    claims: ['tasks', 'node_runs'],
    produces: [{ table: 'fx_tasks' }, { table: 'fx_runs' }],
    lookups: [],
    unit: {
      kind: 'group',
      driver: 'tasks',
      groupColumn: 'id',
      members: [{ table: 'node_runs', column: 'task_id' }],
    },
    convert(unit, ctx) {
      for (const row of unit.rows.get('tasks') ?? [])
        ctx.out.row(
          'fx_tasks',
          fxTask(String(row.values.id), { status: String(row.values.status) }),
          row,
        )
      for (const row of unit.rows.get('node_runs') ?? [])
        ctx.out.row('fx_runs', fxRun(String(row.values.id), String(row.values.task_id)), row)
    },
    ...overrides,
  })
  const source = (status: string, runValues: DecodedSourceRow = {}) =>
    memorySource({
      tasks: [
        frozenRow('tasks', { id: 't-1', status }),
        frozenRow('tasks', { id: 't-2', status: 'done' }),
      ],
      node_runs: [
        frozenRow('node_runs', { id: 'r-1a', task_id: 't-1', status: 'done' }),
        frozenRow('node_runs', { id: 'r-1b', task_id: 't-1', status: 'done', ...runValues }),
        frozenRow('node_runs', { id: 'r-2', task_id: 't-2', status: 'done' }),
      ],
    })
  /** Automatic resolution; the target refuses run r-1b unless `refuse` is false. */
  const convert = (
    rule: ConversionRule,
    options: { status?: string; refuse?: boolean; runValues?: DecodedSourceRow } = {},
  ) => {
    const sink = new RecordingSink()
    if (options.refuse !== false) sink.refuse = refusing({ table: 'fx_runs', id: 'r-1b' })
    return {
      sink,
      run: runConversion(
        engineInput(
          source(options.status ?? 'done', options.runValues),
          [{ rules: [rule], lookups: [taskFactsFromTasks], validators: [] }],
          { scratchRoot: scratch(), resolution: 'automatic' },
        ),
        sink,
      ),
    }
  }
  const outcome = (sink: RecordingSink) =>
    sink
      .dispositions()
      .map((entry) => `${entry.sourceTable}/${entry.class}/${entry.decision?.code}`)
      .sort()

  test('the refused row takes its whole group along; the other groups convert', async () => {
    const { sink, run } = convert(groupRule())
    const summary = await run
    expect(summary.blocks).toEqual([])
    expect(summary.status).toBe('converted')
    expect(ids(sink, 'fx_tasks')).toEqual(['t-2'])
    expect(ids(sink, 'fx_runs')).toEqual(['r-2'])
    expect(outcome(sink)).toEqual([
      'node_runs/archived/v2-group-member-blocked',
      `node_runs/archived/${LOAD_REJECTED}`,
      'tasks/archived/v2-group-member-blocked',
    ])
    expect(summary.resolutions!.setAside.total).toBe(3)
  })

  test("in a rule that declares `settles`, an unfinished task's refused group is what discovery could not see", async () => {
    await expect(convert(groupRule({ settles: {} }), { status: 'running' }).run).rejects.toThrow(
      'v2-settlement-missed',
    )
    // A finished task's group is set aside as above.
    const finished = convert(groupRule({ settles: {} }))
    expect((await finished.run).status).toBe('converted')
    expect(outcome(finished.sink)).toHaveLength(3)
  })

  test('a refused row of a `preservedClaims` table is set aside alone; its group converts', async () => {
    const { sink, run } = convert(groupRule({ preservedClaims: ['node_runs'] }))
    const summary = await run
    expect(summary.status).toBe('converted')
    expect(ids(sink, 'fx_tasks')).toEqual(['t-1', 't-2'])
    expect(ids(sink, 'fx_runs')).toEqual(['r-1a', 'r-2'])
    expect(outcome(sink)).toEqual([`node_runs/archived/${LOAD_REJECTED}`])
    expect(summary.resolutions!.setAside.total).toBe(1)
  })

  test('an undecodable row of a `preservedClaims` table: set aside alone, or under operator resolution the only block', async () => {
    const undecodable = { runtime_params_json: '{ not json' }
    const automatic = convert(groupRule({ preservedClaims: ['node_runs'] }), {
      refuse: false,
      runValues: undecodable,
    })
    expect((await automatic.run).status).toBe('converted')
    expect(ids(automatic.sink, 'fx_tasks')).toEqual(['t-1', 't-2'])
    expect(ids(automatic.sink, 'fx_runs')).toEqual(['r-1a', 'r-2'])
    expect(outcome(automatic.sink)).toEqual(['node_runs/archived/v2-source-codec'])

    const manual = new RecordingSink()
    const blocked = await runConversion(
      engineInput(
        source('done', undecodable),
        [
          {
            rules: [groupRule({ preservedClaims: ['node_runs'] })],
            lookups: [taskFactsFromTasks],
            validators: [],
          },
        ],
        { scratchRoot: scratch() },
      ),
      manual,
    )
    expect(blocked.status).toBe('blocked')
    expect(blocked.blocks.map((block) => [block.code, block.sourceTable, block.sourceKey])).toEqual(
      [['v2-source-codec', 'node_runs', sourceKey('node_runs', 'r-1b')]],
    )
    expect(ids(manual, 'fx_tasks')).toEqual(['t-1', 't-2'])
    expect(ids(manual, 'fx_runs')).toEqual(['r-1a', 'r-2'])

    // Without the declaration the same row still takes its group along, in both resolutions.
    const whole = convert(groupRule(), { refuse: false, runValues: undecodable })
    expect((await whole.run).status).toBe('converted')
    expect(outcome(whole.sink)).toEqual([
      'node_runs/archived/v2-group-member-blocked',
      'node_runs/archived/v2-source-codec',
      'tasks/archived/v2-group-member-blocked',
    ])
  })
})

describe('RFC-626 resuming a run whose units set rows aside for the target', () => {
  const refuse = () =>
    refusing({ table: 'fx_missions', id: 'mission-b' }, { table: 'fx_users', id: 'c' })
  /** What a sink reads back from its run: the decisions as the committed units stored them. */
  function persisted(sink: RecordingSink): Map<string, LoadRejectionDecision[]> {
    const stored = new Map<string, LoadRejectionDecision[]>()
    for (const [unitId, unit] of sink.units) {
      const decisions = unit.dispositions
        .filter((entry) => entry.decision?.code === LOAD_REJECTED)
        .map((entry) => JSON.parse(JSON.stringify(entry.decision!.detail)) as LoadRejectionDecision)
      if (decisions.length) stored.set(unitId, decisions)
    }
    return stored
  }

  test('with the persisted decisions the units convert to the committed bytes and the target is not asked again', async () => {
    const first = new RecordingSink()
    first.refuse = refuse()
    const summary = await runConversion(input(pairRule(), 'automatic'), first)
    expect(persisted(first).size).toBe(2)

    const resumed = new RecordingSink()
    resumed.opened = {
      committedUnitIds: new Set(first.units.keys()),
      loadRejections: persisted(first),
    }
    // The target would refuse the same rows again if they were offered.
    resumed.refuse = refuse()
    const replay = await runConversion(input(pairRule(), 'automatic'), resumed)
    expect(resumed.attempts).toHaveLength(first.units.size)
    expect([...resumed.units.keys()].sort()).toEqual([...first.units.keys()].sort())
    for (const [unitId, unit] of first.units)
      expect(resumed.units.get(unitId)!.receipt.digest).toBe(unit.receipt.digest)
    expect(valueDigest(replay)).toBe(valueDigest(summary))
  })

  test('without them the same units come out different, which is why they are handed back', async () => {
    const first = new RecordingSink()
    first.refuse = refuse()
    await runConversion(input(pairRule(), 'automatic'), first)
    const forgetful = new RecordingSink()
    forgetful.opened = { committedUnitIds: new Set(first.units.keys()) }
    await runConversion(input(pairRule(), 'automatic'), forgetful)
    const unitId = first.unitOf('maintenance_state', stateKey('b')).receipt.unitId
    expect(forgetful.units.get(unitId)!.receipt.digest).not.toBe(
      first.units.get(unitId)!.receipt.digest,
    )
  })

  test('a replay for trace applies the same decisions and reproduces the committed receipt', async () => {
    const first = new RecordingSink()
    first.refuse = refuse()
    await runConversion(input(pairRule(), 'automatic'), first)
    const committed = first.unitOf('maintenance_state', stateKey('b'))
    const explained = await explainSourceRow(
      input(pairRule(), 'automatic'),
      'maintenance_state',
      [canonicalValue('b')],
      'current',
      persisted(first),
    )
    expect(explained).toMatchObject({
      found: true,
      class: 'archived',
      targets: [],
      blocks: [],
      settlement: null,
    })
    expect(explained.dispositions.map((entry) => entry.decision)).toEqual<unknown>([
      { code: LOAD_REJECTED, detail: decision('b', { table: 'fx_missions', id: 'mission-b' }) },
    ])
    expect(explained.receipts.map((receipt) => receipt.digest)).toEqual([committed.receipt.digest])
    // A row of the same unit that was not refused keeps both of its targets.
    const kept = await explainSourceRow(
      input(pairRule(), 'automatic'),
      'maintenance_state',
      [canonicalValue('a')],
      'current',
      persisted(first),
    )
    expect(kept.class).toBe('converted')
    expect(kept.targets).toEqual([
      { table: 'fx_users', key: targetKey('fx_users', 'a') },
      { table: 'fx_missions', key: targetKey('fx_missions', 'mission-a') },
    ])
  })

  test('the plan a resumed run prepares is the plan the first run registered', async () => {
    const first = await prepareConversion(input(pairRule(), 'automatic'))
    const again = await prepareConversion(input(pairRule(), 'automatic'))
    try {
      expect(again.plan).toEqual(first.plan)
    } finally {
      first.close()
      again.close()
    }
  })
})

describe('RFC-626 the unit collector and known refusals', () => {
  const row = (id: string): SourceRow => {
    const key = [canonicalValue(id)]
    return {
      table: 'fixture',
      phase: 'current',
      key,
      encodedKey: encodeMigrationKey('fixture', key),
      canonical: { key, values: [canonicalValue(id)] },
      values: { id },
    }
  }
  const rule: ConversionRule = {
    ref: { id: 'fixture/known', version: 1 },
    owner: 'fixture',
    claims: ['fixture'],
    produces: [{ table: 'fx_users' }],
    lookups: [],
    unit: { kind: 'source-chunk', table: 'fixture' },
    convert() {},
  }
  const collect = (rows: readonly SourceRow[], loadRejections: readonly LoadRejectionDecision[]) =>
    createUnitCollector({
      rule,
      sourceRows: rows,
      sourceVersion: 'fixture/v1',
      sourceContract: 'fixture-contract',
      target: targetRegistryView(fixtureTarget),
      topology: targetTopology(fixtureTarget).order,
      resolution: 'automatic',
      loadRejections,
    })
  const known = (source: SourceRow): LoadRejectionDecision => ({
    sourcePhase: source.phase,
    sourceTable: source.table,
    sourceKey: source.encodedKey,
    targets: [
      {
        table: 'fx_users',
        key: targetKey('fx_users', String(source.values.id)),
        constraint: null,
        message: 'refused when the unit was first committed',
      },
    ],
  })

  test('a known refusal takes its row out of the unit before anything looks at it', () => {
    const kept = row('kept')
    const refused = row('refused')
    const collector = collect([kept, refused], [known(refused)])
    expect(collector.blocked(refused)).toBe(true)
    expect(collector.blocked(kept)).toBe(false)
    collector.out.row('fx_users', { id: 'kept', name: 'kept' }, kept)
    const output = collector.finish({
      unit: { kind: 'source-chunk', table: 'fixture', phase: 'current', afterKey: null, limit: 2 },
      unitId: 'unit',
      lookups: [],
    })
    expect(output.rows).toEqual([{ table: 'fx_users', rows: [{ id: 'kept', name: 'kept' }] }])
    expect(output.dispositions).toEqual([
      expect.objectContaining({
        sourceKey: refused.encodedKey,
        class: 'archived',
        kind: 'archived',
        targets: [],
        decision: { code: LOAD_REJECTED, detail: known(refused) },
      }),
    ])
    expect(output.blocks).toEqual([])
  })

  test('a decision that does not belong to a row of the unit is an engine error', () => {
    const present = row('present')
    const absent = row('absent')
    expect(() => collect([present], [known(absent)])).toThrow(ConversionContractError)
    expect(() => collect([present], [{ ...known(present), sourceTable: 'another' }])).toThrow(
      ConversionContractError,
    )
    expect(() => collect([present], [{ ...known(present), sourcePhase: 'pre-upgrade' }])).toThrow(
      ConversionContractError,
    )
  })

  test('the collector knows which source row each target row of the unit came from', () => {
    const source = row('source')
    const collector = collect([source], [])
    collector.out.row('fx_users', { id: 'from-source', name: 'x' }, source)
    collector.out.row('fx_users', { id: 'from-nothing', name: 'y' }, null)
    expect(collector.originOfTarget('fx_users', targetKey('fx_users', 'from-source'))).toEqual(
      source,
    )
    expect(collector.originOfTarget('fx_users', targetKey('fx_users', 'from-nothing'))).toBeNull()
    expect(
      collector.originOfTarget('fx_users', targetKey('fx_users', 'never-produced')),
    ).toBeUndefined()
    expect(
      collector.originOfTarget('fx_missions', targetKey('fx_missions', 'from-source')),
    ).toBeUndefined()
  })
})
