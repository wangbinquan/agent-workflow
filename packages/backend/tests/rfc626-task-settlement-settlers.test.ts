// RFC-626 §3.2.3 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md): when the automatic
// upgrade ends an unfinished task, the task-execution module says what that writes to its own
// rows — the same columns the cancel transaction writes (childTaskLifecycleParticipant.ts:817-929,
// taskExecutionIntentTerminalSequence.ts:20-98) plus the gate sweep's stamp on an open clarify
// round's intermediary run (humanGatePersistenceParticipant.ts:31-51) — and which children the
// ending takes along (childTaskLifecycleParticipant.ts:905-911). This file locks those pure
// pieces column by column: every table's condition and rewrite, rows outside the condition left
// untouched, the stop reasons taken from taskStopProjection rather than literals, and the
// cascade (four cancelable states taken, `interrupted` and finished ones not, several levels).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskConversion } from '@/modules/task-execution/composition/conversion'
import { taskSettlement } from '@/modules/task-execution/infrastructure/migration/settlement'
import { cascadeSettlements } from '@/modules/task-execution/infrastructure/migration/settlement/cascade'
import {
  executionIntentSettler,
  releaseReplayDecisionValues,
  settleIntentValues,
} from '@/modules/task-execution/infrastructure/migration/settlement/executionIntents'
import {
  CANCEL_OWNER_RECOVERY_CODE,
  executionOwnerSettler,
  revokeOwnerValues,
} from '@/modules/task-execution/infrastructure/migration/settlement/executionOwners'
import {
  GATE_SWEEP_CANCELED_CAUSE,
  nodeRunSettler,
  settleNodeRunValues,
} from '@/modules/task-execution/infrastructure/migration/settlement/nodeRuns'
import {
  nextRevision,
  settlementStop,
} from '@/modules/task-execution/infrastructure/migration/settlement/stop'
import { taskRowSettler } from '@/modules/task-execution/infrastructure/migration/settlement/tasks'
import { taskStopProjection } from '@/modules/task-execution/domain/sourceTermination'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import type { StagedReader } from '@/platform/persistence/migration/conversion/staging'
import type { SourceRow, TaskSettlement } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { runValues, sourceRow } from './helpers/rfc395V2/runFixtures'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'

const PLAN_TIME = 777
const ACTIVE_TASK_STATUSES = ['pending', 'running', 'awaiting_review', 'awaiting_human'] as const
const EXECUTABLE_TASK_STATUSES = [...ACTIVE_TASK_STATUSES, 'interrupted'] as const

function ended(taskId: string, originalStatus = 'running'): TaskSettlement {
  return {
    taskId,
    cause: 'unprovable-records',
    originalStatus,
    blockCodes: ['v2-run-null-nonce'],
    parentTaskId: null,
  }
}
function cascaded(
  taskId: string,
  parentTaskId: string,
  originalStatus = 'pending',
): TaskSettlement {
  return { taskId, cause: 'parent-cascade', originalStatus, blockCodes: [], parentTaskId }
}
function task(id: string, values: DecodedSourceRow = {}): SourceRow {
  return sourceRow('tasks', frozenValues('tasks', { id, status: 'running', ...values }))
}
function run(id: string, values: DecodedSourceRow = {}): SourceRow {
  return sourceRow('node_runs', runValues(id, { task_id: 'task', ...values }))
}
function round(id: string, values: DecodedSourceRow = {}): SourceRow {
  return sourceRow(
    'clarify_rounds',
    frozenValues('clarify_rounds', { id, task_id: 'task', status: 'awaiting_human', ...values }),
  )
}
function intent(id: string, values: DecodedSourceRow = {}): SourceRow {
  return sourceRow(
    'task_execution_intents',
    frozenValues('task_execution_intents', {
      id,
      task_id: 'task',
      state: 'pending',
      created_at: 10,
      updated_at: 10,
      ...values,
    }),
  )
}
function decision(id: string, values: DecodedSourceRow = {}): SourceRow {
  return sourceRow(
    'task_execution_lineage_operation_records',
    frozenValues('task_execution_lineage_operation_records', {
      id,
      record_kind: 'replay-decision',
      operation_generation: 0,
      highest_settled_generation: null,
      decision_state: 'actor-replay-authorized',
      replay_authorization_id: 'authorization',
      authorization_scope_json: '{"v":1}',
      actor_user_id: 'actor',
      authorization_source: 'rest',
      bound_intent_id: 'intent',
      source_task_id: 'task',
      record_revision: 2,
      updated_at: 10,
      ...values,
    }),
  )
}
function owner(values: DecodedSourceRow = {}): SourceRow {
  return sourceRow(
    'task_execution_owners',
    frozenValues('task_execution_owners', {
      task_id: 'task',
      state: 'claimed',
      revision: 3,
      recovery_code: null,
      updated_at: 10,
      ...values,
    }),
  )
}
/** A row whose frozen codec failed; settlers never rewrite what nobody could decode. */
function undecodable(row: SourceRow): SourceRow {
  return { ...row, codecFailure: { message: 'fixture', columns: ['status'] } }
}

describe('RFC-626 settlement stop reasons', () => {
  test('a task the upgrade ends and a child it takes along use the projected causes', () => {
    expect(settlementStop(ended('task'))).toEqual(taskStopProjection({ kind: 'upgrade' }))
    expect(settlementStop(ended('task'))).toEqual({
      code: 'ended-by-upgrade',
      summary: 'ended by upgrade',
    })
    expect(settlementStop(cascaded('child', 'task'))).toEqual({
      code: 'canceled-by-parent-cascade',
      summary: 'canceled by parent task',
    })
  })

  test('a cascade without its parent is a broken engine contract', () => {
    expect(() => settlementStop({ ...cascaded('child', 'task'), parentTaskId: null })).toThrow(
      ConversionContractError,
    )
  })

  test('revision counters step on in the representation the codec decodes', () => {
    expect(nextRevision(3)).toBe(4)
    expect(nextRevision(9007199254740993n)).toBe(9007199254740994n)
    expect(nextRevision(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
    expect(nextRevision('3')).toBeNull()
    expect(nextRevision(null)).toBeNull()
    expect(nextRevision(1.5)).toBeNull()
  })

  test('the settlement code never spells a stop reason itself (single source)', () => {
    const directory = join(
      import.meta.dir,
      '../src/modules/task-execution/infrastructure/migration/settlement',
    )
    const sources = readdirSync(directory)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(join(directory, name), 'utf8'))
    expect(sources.length).toBeGreaterThanOrEqual(6)
    for (const source of sources)
      for (const literal of [
        'ended-by-upgrade',
        'ended by upgrade',
        'canceled-by-parent-cascade',
        'canceled by parent task',
        'canceled-by-user',
      ])
        expect(source).not.toContain(`'${literal}'`)
    expect(sources.join('\n')).toContain('taskStopProjection(')
  })
})

describe('RFC-626 §3.2.3 row 1: tasks', () => {
  for (const status of EXECUTABLE_TASK_STATUSES)
    test(`${status}: canceled now with the upgrade reason, every other column kept`, () => {
      const row = task('task', { status, lifecycle_event_revision: 5, error_message: 'old' })
      const changes = taskRowSettler.settle(new Map([['tasks', [row]]]), {
        settlement: ended('task', status),
        planTime: PLAN_TIME,
      })
      expect(changes).toEqual([
        {
          table: 'tasks',
          key: row.encodedKey,
          values: {
            ...row.values,
            status: 'canceled',
            finished_at: PLAN_TIME,
            error_summary: 'ended by upgrade',
            error_message: 'ended-by-upgrade',
          },
        },
      ])
      // No lifecycle event is appended, so the revision is not moved either.
      expect(changes[0]!.values.lifecycle_event_revision).toBe(5)
    })

  test('a cascaded child carries the parent-cascade reason', () => {
    const row = task('child', { status: 'awaiting_review', parent_task_id: 'task' })
    const [change] = taskRowSettler.settle(new Map([['tasks', [row]]]), {
      settlement: cascaded('child', 'task', 'awaiting_review'),
      planTime: PLAN_TIME,
    })
    expect(change!.values).toMatchObject({
      status: 'canceled',
      finished_at: PLAN_TIME,
      error_summary: 'canceled by parent task',
      error_message: 'canceled-by-parent-cascade',
    })
  })

  for (const status of ['done', 'failed', 'canceled'])
    test(`${status}: a finished task row is not rewritten`, () => {
      expect(
        taskRowSettler.settle(new Map([['tasks', [task('task', { status })]]]), {
          settlement: ended('task'),
          planTime: PLAN_TIME,
        }),
      ).toEqual([])
    })

  test('an undecodable task row is not rewritten', () => {
    expect(
      taskRowSettler.settle(new Map([['tasks', [undecodable(task('task'))]]]), {
        settlement: ended('task'),
        planTime: PLAN_TIME,
      }),
    ).toEqual([])
  })
})

describe('RFC-626 §3.2.3 rows 2a and 2b: node_runs', () => {
  const settle = (runs: SourceRow[], rounds: SourceRow[] = [], settlement = ended('task')) =>
    nodeRunSettler.settle(
      new Map([
        ['node_runs', runs],
        ['clarify_rounds', rounds],
      ]),
      { settlement, planTime: PLAN_TIME },
    )

  test('clarify rounds are only read', () => {
    expect(nodeRunSettler.tables).toEqual([
      { table: 'node_runs', taskColumn: 'task_id' },
      { table: 'clarify_rounds', taskColumn: 'task_id', write: false },
    ])
  })

  for (const status of ACTIVE_TASK_STATUSES)
    test(`2a ${status}: canceled now with the stop reason code`, () => {
      const row = run('run', { status, finished_at: null, error_message: null, exit_code: 3 })
      expect(settle([row])).toEqual([
        {
          table: 'node_runs',
          key: row.encodedKey,
          values: {
            ...row.values,
            status: 'canceled',
            finished_at: PLAN_TIME,
            error_message: 'ended-by-upgrade',
          },
        },
      ])
    })

  for (const status of ['done', 'failed', 'canceled', 'interrupted', 'skipped', 'exhausted'])
    test(`2a ${status}: a run the cancel does not select is untouched`, () => {
      expect(settle([run('run', { status, error_message: 'kept' })])).toEqual([])
    })

  test('2a for a cascaded child uses the parent-cascade code', () => {
    const [change] = settle([run('run', { status: 'running' })], [], cascaded('task', 'parent'))
    expect(change!.values.error_message).toBe('canceled-by-parent-cascade')
  })

  test('2b: the intermediary run of an open round is canceled and stamped by the sweep', () => {
    const intermediary = run('intermediary', { status: 'awaiting_human', finished_at: null })
    const other = run('other', { status: 'awaiting_review', finished_at: null })
    const changes = settle(
      [intermediary, other],
      [round('round', { intermediary_node_run_id: 'intermediary' })],
    )
    expect(changes.find((change) => change.key === intermediary.encodedKey)!.values).toEqual({
      ...intermediary.values,
      status: 'canceled',
      finished_at: PLAN_TIME,
      error_message: GATE_SWEEP_CANCELED_CAUSE,
    })
    expect(GATE_SWEEP_CANCELED_CAUSE).toBe('task-canceled')
    expect(changes.find((change) => change.key === other.encodedKey)!.values.error_message).toBe(
      'ended-by-upgrade',
    )
  })

  test('2b: an intermediary canceled earlier only gets the sweep reason', () => {
    const earlier = run('intermediary', {
      status: 'canceled',
      finished_at: 50,
      error_message: 'canceled-by-user',
    })
    expect(
      settle([earlier], [round('round', { intermediary_node_run_id: 'intermediary' })]),
    ).toEqual([
      {
        table: 'node_runs',
        key: earlier.encodedKey,
        values: { ...earlier.values, error_message: GATE_SWEEP_CANCELED_CAUSE },
      },
    ])
  })

  test('2b: a round no longer awaiting a person, or an intermediary in another state, is left alone', () => {
    const answered = run('answered-run', { status: 'canceled', error_message: 'earlier' })
    const interrupted = run('interrupted-run', { status: 'interrupted', error_message: null })
    expect(
      settle(
        [answered, interrupted],
        [
          round('answered', { status: 'answered', intermediary_node_run_id: 'answered-run' }),
          round('open', { intermediary_node_run_id: 'interrupted-run' }),
        ],
      ),
    ).toEqual([])
  })

  test('2b reads the round as staged even when the collaboration settler rewrites it', () => {
    // Every settler of one batch sees rows as they were before it; the pure function only needs
    // the round's original state, which is what the engine passes.
    expect(
      settleNodeRunValues(runValues('run', { status: 'canceled', error_message: 'x' }), {
        code: 'ended-by-upgrade',
        planTime: PLAN_TIME,
        openRoundIntermediary: true,
      }),
    ).toMatchObject({ status: 'canceled', error_message: GATE_SWEEP_CANCELED_CAUSE })
  })

  test('an undecodable run is not rewritten', () => {
    expect(settle([undecodable(run('run', { status: 'running' }))])).toEqual([])
  })
})

describe('RFC-626 §3.2.3 rows 3 and 5: intents and replay decisions', () => {
  const settle = (intents: SourceRow[], decisions: SourceRow[], settlement = ended('task')) =>
    executionIntentSettler.settle(
      new Map([
        ['task_execution_intents', intents],
        ['task_execution_lineage_operation_records', decisions],
      ]),
      { settlement, planTime: PLAN_TIME },
    )

  test('the settler reads intents by task and replay decisions through the intents they are bound to', () => {
    expect(executionIntentSettler.tables).toEqual([
      { table: 'task_execution_intents', taskColumn: 'task_id' },
      {
        table: 'task_execution_lineage_operation_records',
        taskColumn: 'bound_intent_id',
        via: { table: 'task_execution_intents', keyColumn: 'id' },
      },
    ])
  })

  for (const state of ['pending', 'claimed'])
    test(`row 3 ${state}: canceled with the reason code, completed and updated now`, () => {
      const row = intent('intent', { state, failure_code: null, completed_at: null })
      expect(settle([row], [])).toEqual([
        {
          table: 'task_execution_intents',
          key: row.encodedKey,
          values: {
            ...row.values,
            state: 'canceled',
            failure_code: 'ended-by-upgrade',
            completed_at: PLAN_TIME,
            updated_at: PLAN_TIME,
          },
        },
      ])
    })

  for (const state of ['completed', 'canceled', 'failed'])
    test(`row 3 ${state}: a closed intent is untouched`, () => {
      expect(
        settleIntentValues(intent('intent', { state }).values, { code: 'x', planTime: 1 }),
      ).toBe(null)
    })

  test('row 5: an authorized decision bound to a closed intent requires an actor again', () => {
    const row = decision('decision')
    const changes = settle([intent('intent')], [row])
    expect(changes.find((change) => change.key === row.encodedKey)!.values).toEqual({
      ...row.values,
      decision_state: 'requires-actor',
      replay_authorization_id: null,
      authorization_scope_json: null,
      actor_user_id: null,
      authorization_source: null,
      bound_intent_id: null,
      record_revision: 3,
      updated_at: PLAN_TIME,
    })
  })

  test('row 5 applies only to decisions bound to an intent this settlement closed', () => {
    const closed = new Set(['intent'])
    const release = (values: DecodedSourceRow) =>
      releaseReplayDecisionValues(decision('decision', values).values, {
        closedIntentIds: closed,
        planTime: PLAN_TIME,
      })
    expect(release({ bound_intent_id: 'other-intent' })).toBeNull()
    expect(release({ decision_state: 'requires-actor' })).toBeNull()
    expect(release({ decision_state: 'actor-replay-authorized-suspended' })).toBeNull()
    expect(release({ decision_state: 'consumed' })).toBeNull()
    expect(
      release({
        record_kind: 'generation-watermark',
        decision_state: null,
        operation_generation: null,
        highest_settled_generation: 0,
      }),
    ).toBeNull()
    expect(release({ record_revision: 9007199254740993n })!.record_revision).toBe(9007199254740994n)
    // An intent that was already completed is not closed now, so its decision stays bound.
    expect(
      settle([intent('intent', { state: 'completed' })], [decision('decision')]).map(
        (change) => change.table,
      ),
    ).toEqual([])
  })

  test('a cascaded child closes its intents with the parent-cascade code', () => {
    const [change] = settle([intent('intent')], [], cascaded('task', 'parent'))
    expect(change!.values.failure_code).toBe('canceled-by-parent-cascade')
  })
})

describe('RFC-626 §3.2.3 row 4: execution owners', () => {
  test('a claimed owner is revoked with the cancel recovery code', () => {
    const row = owner()
    expect(
      executionOwnerSettler.settle(new Map([['task_execution_owners', [row]]]), {
        settlement: ended('task'),
        planTime: PLAN_TIME,
      }),
    ).toEqual([
      {
        table: 'task_execution_owners',
        key: row.encodedKey,
        values: {
          ...row.values,
          state: 'revoked',
          revision: 4,
          recovery_code: 'terminal-control-cancel',
          updated_at: PLAN_TIME,
        },
      },
    ])
    expect(CANCEL_OWNER_RECOVERY_CODE).toBe('terminal-control-cancel')
  })

  for (const state of ['revoked', 'released', 'recovery-required'])
    test(`${state}: an owner that does not hold the task is untouched`, () => {
      expect(revokeOwnerValues(owner({ state }).values, PLAN_TIME)).toBeNull()
    })
})

/** Only `tasks` is read by the cascade; the rest of the reader is never consulted. */
function stagedTasks(rows: readonly SourceRow[]): StagedReader {
  const of = (table: string) => (table === 'tasks' ? rows : [])
  return {
    *rows(table) {
      yield* of(table)
    },
    read: (table) => of(table),
    get: (table, key) => of(table).find((row) => row.encodedKey === key),
    group: (table, column, value) => of(table).filter((row) => row.values[column] === value),
    groupKeys: () => [],
    count: (table) => of(table).length,
  }
}

describe('RFC-626 §3.2.3 cascade: expand', () => {
  const child = (id: string, parent: string, status: string, values: DecodedSourceRow = {}) =>
    task(id, { parent_task_id: parent, status, ...values })

  test('the four cancelable children are taken along; interrupted and finished ones are not', () => {
    const rows = [
      task('root'),
      ...['pending', 'running', 'awaiting_review', 'awaiting_human'].map((status) =>
        child(`child-${status}`, 'root', status),
      ),
      ...['interrupted', 'done', 'failed', 'canceled'].map((status) =>
        child(`kept-${status}`, 'root', status),
      ),
    ]
    const added = cascadeSettlements({
      settled: new Map([['root', ended('root')]]),
      staged: stagedTasks(rows),
    })
    expect([...added].sort((a, b) => a.taskId.localeCompare(b.taskId))).toEqual(
      ['awaiting_human', 'awaiting_review', 'pending', 'running'].map((status) =>
        cascaded(`child-${status}`, 'root', status),
      ),
    )
  })

  test('several levels are taken along, each child under its own parent', () => {
    const rows = [
      task('root'),
      child('child', 'root', 'running'),
      child('grandchild', 'child', 'pending'),
      child('great-grandchild', 'grandchild', 'awaiting_human'),
      child('paused', 'root', 'interrupted'),
      child('under-paused', 'paused', 'running'),
    ]
    const added = cascadeSettlements({
      settled: new Map([['root', ended('root')]]),
      staged: stagedTasks(rows),
    })
    expect(added).toEqual([
      cascaded('child', 'root', 'running'),
      cascaded('grandchild', 'child', 'pending'),
      cascaded('great-grandchild', 'grandchild', 'awaiting_human'),
    ])
  })

  test('a child settled for its own records keeps that settlement', () => {
    const rows = [task('root'), child('child', 'root', 'running')]
    expect(
      cascadeSettlements({
        settled: new Map([
          ['root', ended('root')],
          ['child', ended('child')],
        ]),
        staged: stagedTasks(rows),
      }),
    ).toEqual([])
  })

  test('a child the converter cannot read or use is set aside, not ended', () => {
    const rows = [
      task('root'),
      undecodable(child('undecodable', 'root', 'running')),
      child('unusable', 'root', 'running', { space_kind: 'cloud' }),
    ]
    expect(
      cascadeSettlements({
        settled: new Map([['root', ended('root')]]),
        staged: stagedTasks(rows),
      }),
    ).toEqual([])
  })
})

describe('RFC-626 task-execution settlement contribution', () => {
  test('the composed task conversion carries the settlers and the cascade', () => {
    expect(taskConversion.settlement).toBe(taskSettlement)
    expect(taskSettlement.expand).toBe(cascadeSettlements)
    expect(taskSettlement.settlers.flatMap((settler) => settler.tables)).toEqual([
      { table: 'tasks', taskColumn: 'id' },
      { table: 'node_runs', taskColumn: 'task_id' },
      { table: 'clarify_rounds', taskColumn: 'task_id', write: false },
      { table: 'task_execution_intents', taskColumn: 'task_id' },
      {
        table: 'task_execution_lineage_operation_records',
        taskColumn: 'bound_intent_id',
        via: { table: 'task_execution_intents', keyColumn: 'id' },
      },
      { table: 'task_execution_owners', taskColumn: 'task_id' },
    ])
  })
})
