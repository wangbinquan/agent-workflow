// RFC-626 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md §3.2.1, §3.2.3 rows 6-7,
// §3.4 row 17): the collaboration module's part of "an upgrade does not refuse because of data".
//
//   - The clarify rule and the gate-open validator block a row only while its task can
//     continue. With automatic resolution they say so through `blockExecutable`, and discovery
//     ends that task instead (every clarify code, and an open left half-way by a killed old
//     service). With operator resolution the same rows still block, byte for byte.
//   - Ending a task closes its open clarify rounds the way a cancel's terminal sweep does
//     (cross rounds abandoned at the upgrade time, others canceled) and resolves its open
//     lifecycle alerts (system-operations). Both settlers are pure; rows outside their
//     condition are left alone.
//   - Rounds and opens whose task facts are missing stay row-level blocks, which automatic
//     resolution sets aside.
import { describe, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  answer,
  gateRow,
  question,
  roundRow,
  seedCollabTask,
} from './helpers/rfc395V2/collabFixtures'
import { decisions, prepareAndRun, settledTasks } from './helpers/rfc626CollabContentFixtures'
import { conversion as collaborationConversion } from '@/modules/collaboration/composition/conversion'
import { conversion as systemOperationsConversion } from '@/modules/system-operations/composition/conversion'
import { clarifyRule } from '@/modules/collaboration/infrastructure/migration/clarifyRule'
import {
  gateOperationsRule,
  gateOperationsValidator,
} from '@/modules/collaboration/infrastructure/migration/gateOperationsRule'
import {
  clarifyRoundSettler,
  settleClarifyRounds,
} from '@/modules/collaboration/infrastructure/migration/settlement'
import {
  lifecycleAlertSettler,
  resolveOpenLifecycleAlerts,
} from '@/modules/system-operations/infrastructure/migration/settlement'
import { clarifyRoundTransition } from '@/modules/collaboration/domain/clarifyAnswers'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { RunFrame } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { SourceRow, TaskSettlement } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'

const PLAN_TIME = 123 // the harness's planTime
const settlement: TaskSettlement = {
  taskId: 'task',
  cause: 'unprovable-records',
  originalStatus: 'awaiting_human',
  blockCodes: ['v2-clarify-duplicate-question'],
  parentTaskId: null,
}
function sourceRow(
  table: string,
  values: DecodedSourceRow,
  extra: Partial<Pick<SourceRow, 'codecFailure'>> = {},
): SourceRow {
  const key = [canonicalValue(String(values.id))]
  return {
    table,
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey(table, key),
    canonical: { key, values: [] },
    values,
    ...extra,
  }
}
const round = (id: string, values: DecodedSourceRow = {}) =>
  sourceRow('clarify_rounds', {
    id,
    task_id: 'task',
    kind: 'self',
    status: 'awaiting_human',
    abandoned_at: null,
    questions_json: '[]',
    answered_at: null,
    ...values,
  })
const alert = (id: string, values: DecodedSourceRow = {}) =>
  sourceRow('lifecycle_alerts', {
    id,
    task_id: 'task',
    rule: 'stuck',
    severity: 'warning',
    detail: '{}',
    detected_at: 100,
    resolved_at: null,
    ...values,
  })

describe('RFC-626 §3.2.3 row 6: clarify round settler', () => {
  test('a self round awaiting a human is canceled; every other column is kept', () => {
    const open = round('self')
    expect(settleClarifyRounds([open], PLAN_TIME)).toEqual([
      {
        table: 'clarify_rounds',
        key: open.encodedKey,
        values: { ...open.values, status: 'canceled' },
      },
    ])
    // The terminal sweep's own transition writes nothing else for a cancel.
    expect(clarifyRoundTransition('cancel', PLAN_TIME)).toEqual({ status: 'canceled' })
  })
  test('a cross round awaiting a human is abandoned at the upgrade time', () => {
    const open = round('cross', { kind: 'cross' })
    expect(settleClarifyRounds([open], PLAN_TIME)).toEqual([
      {
        table: 'clarify_rounds',
        key: open.encodedKey,
        values: { ...open.values, status: 'abandoned', abandoned_at: PLAN_TIME },
      },
    ])
    expect(clarifyRoundTransition('abandon', PLAN_TIME)).toEqual({
      status: 'abandoned',
      abandonedAt: PLAN_TIME,
    })
  })
  test('rounds outside the condition and undecodable rows are not rewritten', () => {
    const rows = [
      round('answered', { status: 'answered', answered_at: 120 }),
      round('canceled', { status: 'canceled' }),
      round('abandoned', { kind: 'cross', status: 'abandoned', abandoned_at: 50 }),
      sourceRow(
        'clarify_rounds',
        { id: 'broken', task_id: 'task', kind: 'self', status: 'awaiting_human' },
        { codecFailure: { message: 'fixture', columns: ['questions_json'] } },
      ),
    ]
    expect(settleClarifyRounds(rows, PLAN_TIME)).toEqual([])
  })
  test('the settler reads and writes clarify_rounds by task_id and goes through the same function', () => {
    expect(clarifyRoundSettler.tables).toEqual([{ table: 'clarify_rounds', taskColumn: 'task_id' }])
    const rows = [round('a'), round('b', { kind: 'cross' }), round('c', { status: 'answered' })]
    expect(
      clarifyRoundSettler.settle(new Map([['clarify_rounds', rows]]), {
        settlement,
        planTime: PLAN_TIME,
      }),
    ).toEqual(settleClarifyRounds(rows, PLAN_TIME))
    expect(clarifyRoundSettler.settle(new Map(), { settlement, planTime: PLAN_TIME })).toEqual([])
  })
})

describe('RFC-626 §3.2.3 row 7: lifecycle alert settler', () => {
  test('an open alert is resolved at the upgrade time; every other column is kept', () => {
    const open = alert('open')
    expect(resolveOpenLifecycleAlerts([open], PLAN_TIME)).toEqual([
      {
        table: 'lifecycle_alerts',
        key: open.encodedKey,
        values: { ...open.values, resolved_at: PLAN_TIME },
      },
    ])
  })
  test('resolved alerts and undecodable rows are not rewritten', () => {
    expect(
      resolveOpenLifecycleAlerts(
        [
          alert('resolved', { resolved_at: 50 }),
          sourceRow(
            'lifecycle_alerts',
            { id: 'broken', task_id: 'task', resolved_at: null },
            { codecFailure: { message: 'fixture', columns: ['detected_at'] } },
          ),
        ],
        PLAN_TIME,
      ),
    ).toEqual([])
  })
  test('the settler reads lifecycle_alerts by task_id', () => {
    expect(lifecycleAlertSettler.tables).toEqual([
      { table: 'lifecycle_alerts', taskColumn: 'task_id' },
    ])
    const rows = [alert('a'), alert('b', { resolved_at: 7 })]
    expect(
      lifecycleAlertSettler.settle(new Map([['lifecycle_alerts', rows]]), {
        settlement,
        planTime: PLAN_TIME,
      }),
    ).toEqual(resolveOpenLifecycleAlerts(rows, PLAN_TIME))
  })
})

describe('RFC-626 contributions', () => {
  test('collaboration contributes the clarify settler and declares settles where it blocks', () => {
    expect(collaborationConversion.settlement?.settlers).toEqual([clarifyRoundSettler])
    expect(collaborationConversion.settlement?.expand).toBeUndefined()
    expect(clarifyRule.settles).toEqual({})
    expect(gateOperationsRule.settles).toEqual({})
    expect(gateOperationsValidator.settles).toEqual({})
  })
  test('system-operations contributes only the lifecycle alert settler', () => {
    expect(systemOperationsConversion).toEqual({
      rules: [],
      lookups: [],
      validators: [],
      settlement: { settlers: [lifecycleAlertSettler] },
    })
  })
})

const EXECUTABLE = ['pending', 'running', 'awaiting_review', 'awaiting_human', 'interrupted']
/** One round per clarify block code, each on its own unfinished task. */
const clarifyCases: readonly {
  readonly id: string
  readonly code: string
  readonly round: DecodedSourceRow
  readonly frame: boolean
}[] = [
  { id: 'frame-unproven', code: 'v2-clarify-frame-unproven', round: {}, frame: false },
  {
    id: 'frame-conflict',
    code: 'v2-clarify-frame-conflict',
    round: { container_run_id: 'recorded-frame' },
    frame: true,
  },
  {
    id: 'json-unproven',
    code: 'v2-clarify-json-unproven',
    round: { truncation_warnings_json: '{broken' },
    frame: true,
  },
  {
    id: 'questions-shape',
    code: 'v2-clarify-questions-shape',
    round: { questions_json: '{"legacy":true}' },
    frame: true,
  },
  {
    id: 'answer-key',
    code: 'v2-clarify-answer-key',
    round: { answers_json: '[{"customText":"no question id"}]' },
    frame: true,
  },
  {
    id: 'duplicate-question',
    code: 'v2-clarify-duplicate-question',
    round: {
      status: 'awaiting_human',
      answered_at: null,
      questions_json: JSON.stringify([question(), question()]),
    },
    frame: true,
  },
  {
    id: 'orphan-answer',
    code: 'v2-clarify-orphan-answer',
    round: { status: 'awaiting_human', answers_json: JSON.stringify([answer('missing')]) },
    frame: true,
  },
  {
    id: 'orphan-draft',
    code: 'v2-clarify-orphan-draft',
    round: { status: 'awaiting_human', draft_answers_json: '{"missing":{"customText":"draft"}}' },
    frame: true,
  },
  {
    id: 'duplicate-draft',
    code: 'v2-clarify-duplicate-draft',
    round: {
      status: 'awaiting_human',
      draft_answers_json: '{"q":{"customText":"first"},"q":{"customText":"last"}}',
    },
    frame: true,
  },
  {
    id: 'orphan-attribution',
    code: 'v2-clarify-orphan-attribution',
    round: {
      status: 'awaiting_human',
      answer_attributions_json: '{"missing":{"userId":"editor"}}',
    },
    frame: true,
  },
  {
    id: 'duplicate-attribution',
    code: 'v2-clarify-duplicate-attribution',
    round: {
      status: 'awaiting_human',
      answer_attributions_json: '{"q":null,"q":{"userId":"editor"}}',
    },
    frame: true,
  },
]

describeV2Providers('RFC-626 collaboration rules under automatic resolution', (h) => {
  async function seedClarifyCases(): Promise<RunFrame[]> {
    const frames: RunFrame[] = []
    for (const [index, entry] of clarifyCases.entries()) {
      const status = EXECUTABLE[index % EXECUTABLE.length]!
      const { frame } = await seedCollabTask(h, entry.id, status, 'executable')
      if (entry.frame) frames.push(frame)
      await h.write('clarify_rounds', [roundRow(entry.id, entry.id, entry.round)])
    }
    // A finished task's ambiguous round never ends anything.
    const done = await seedCollabTask(h, 'done', 'done', 'terminal-history')
    frames.push(done.frame)
    await h.write('clarify_rounds', [
      roundRow('done', 'done', {
        status: 'awaiting_human',
        questions_json: JSON.stringify([question(), question()]),
      }),
    ])
    return frames
  }

  test('every clarify block code of an unfinished task ends that task; the rounds then convert', async () => {
    await h.install()
    const frames = await seedClarifyCases()
    const automatic = await prepareAndRun(h, [collaborationConversion, settledTasks], {
      resolution: 'automatic',
      fixtures: { runFrames: frames },
      chunkLimit: 2,
    })
    const settlements = automatic.plan.settlements ?? []
    expect(settlements.map((entry) => entry.taskId)).toEqual(
      clarifyCases.map((entry) => entry.id).sort(),
    )
    for (const [index, entry] of clarifyCases.entries()) {
      const settled = settlements.find((candidate) => candidate.taskId === entry.id)!
      expect(settled).toMatchObject({
        cause: 'unprovable-records',
        originalStatus: EXECUTABLE[index % EXECUTABLE.length],
        parentTaskId: null,
      })
      expect(settled.blockCodes).toContain(entry.code)
    }
    // Formal conversion never reaches blockExecutable again: it would be an engine error.
    expect(automatic.summary.blocks).toEqual([])
    expect(automatic.summary.status).toBe('converted')
    expect(automatic.summary.resolutions?.settledTasks).toEqual(settlements)
    // The round that awaited a human is closed like a cancel's sweep closes it.
    expect(
      automatic.sink.rows('clarify_rounds').find((row) => row.id === 'duplicate-question'),
    ).toMatchObject({ status: 'canceled', abandoned_at: null })
    expect(
      decisions(automatic.records, 'v2-task-settled-at-upgrade').some(
        (record) =>
          (record.payload as { taskId?: string }).taskId === 'duplicate-question' &&
          (record.payload as { sourceTable?: string }).sourceTable === 'clarify_rounds',
      ),
    ).toBe(true)
    // The ended tasks' rounds are history now, restricted like any canceled task's.
    expect(
      automatic.dispositions.some(
        (d) =>
          d.kind === 'history-only' &&
          d.history?.taskId === 'frame-unproven' &&
          d.history.execution === 'retryable-history',
      ),
    ).toBe(true)
    // The finished task's round converts as before and ends nothing.
    expect(automatic.sink.rows('clarify_rounds').find((row) => row.id === 'done')).toMatchObject({
      status: 'awaiting_human',
    })
  }, 180_000)

  test('operator resolution: the same rounds block exactly the codes automatic resolution settles on', async () => {
    await h.install()
    const frames = await seedClarifyCases()
    const automatic = await prepareAndRun(h, [collaborationConversion, settledTasks], {
      resolution: 'automatic',
      fixtures: { runFrames: frames },
      chunkLimit: 2,
    })
    const operator = await prepareAndRun(h, [collaborationConversion, settledTasks], {
      fixtures: { runFrames: frames },
      chunkLimit: 2,
    })
    expect(operator.plan.settlements).toBeUndefined()
    expect(operator.plan.resolution).toBeUndefined()
    expect(operator.summary.resolutions).toBeUndefined()
    const byTask = new Map<string, Set<string>>()
    for (const block of operator.summary.blocks) {
      expect(block.scope).toBe('row')
      const codes = byTask.get(block.taskId!) ?? new Set<string>()
      codes.add(block.code)
      byTask.set(block.taskId!, codes)
    }
    expect(
      [...byTask]
        .map(([taskId, codes]) => ({ taskId, blockCodes: [...codes].sort() }))
        .sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    ).toEqual(
      (automatic.plan.settlements ?? []).map(({ taskId, blockCodes }) => ({
        taskId,
        blockCodes: [...blockCodes],
      })),
    )
    // Blocked rounds produce no target rows; no round was rewritten.
    expect(operator.sink.rows('clarify_rounds').map((row) => row.id)).toEqual(['done'])
    expect(decisions(operator.records, 'v2-task-settled-at-upgrade')).toEqual([])
  }, 180_000)

  test('an open left in flight ends its unfinished task; the operation converts as history', async () => {
    await h.install()
    await seedCollabTask(h, 'active', 'running', 'executable')
    await seedCollabTask(h, 'done', 'done', 'terminal-history')
    await h.write('collaboration_gate_operations', [
      gateRow('open-active', 'active', { gate_kind: 'review', state: 'preparing' }),
      gateRow('open-done', 'done', { state: 'prepared' }),
    ])
    const automatic = await prepareAndRun(h, [collaborationConversion, settledTasks], {
      resolution: 'automatic',
      fixtures: { runFrames: [] },
    })
    expect(automatic.plan.settlements).toEqual([
      {
        taskId: 'active',
        cause: 'unprovable-records',
        originalStatus: 'running',
        blockCodes: ['v2-gate-open-in-flight'],
        parentTaskId: null,
      },
    ])
    expect(automatic.summary.blocks).toEqual([])
    expect(automatic.sink.rows('collaboration_gate_operations')).toHaveLength(2)
    const history = automatic.dispositions.filter(
      (d) => d.kind === 'history-only' && d.decision?.code === 'v2-gate-open-history-only',
    )
    expect(
      history
        .map((d) => [d.history?.taskId, d.history?.execution, d.history?.missingFields])
        .sort(),
    ).toEqual([
      ['active', 'retryable-history', ['legacy-open-replay']],
      ['done', 'terminal-history', ['legacy-open-replay']],
    ])

    const operator = await prepareAndRun(h, [collaborationConversion, settledTasks], {
      fixtures: { runFrames: [] },
    })
    expect(operator.plan.settlements).toBeUndefined()
    expect(operator.summary.blocks).toEqual([
      expect.objectContaining({
        code: 'v2-gate-open-in-flight',
        scope: 'row',
        sourceTable: 'collaboration_gate_operations',
        taskId: 'active',
        missingFields: ['legacy-open-replay'],
        detail: { gateKind: 'review', state: 'preparing', execution: 'executable' },
      }),
    ])
    expect(operator.sink.rows('collaboration_gate_operations').map((row) => row.id)).toEqual([
      'open-done',
    ])
  }, 180_000)

  test('rounds and opens without task facts stay row-level blocks, which automatic resolution sets aside', async () => {
    await h.install()
    const { frame } = await seedCollabTask(h, 'task', 'running', 'executable')
    await h.write('clarify_rounds', [roundRow('orphan', 'task')])
    await h.write('collaboration_gate_operations', [gateRow('orphan', 'task')])
    const operator = await prepareAndRun(h, [collaborationConversion], {
      fixtures: { taskFacts: [], runFrames: [frame] },
    })
    expect(operator.summary.blocks.map((block) => [block.code, block.scope]).sort()).toEqual([
      ['v2-clarify-task-facts-missing', 'row'],
      ['v2-gate-task-facts-missing', 'row'],
    ])
    const automatic = await prepareAndRun(h, [collaborationConversion], {
      resolution: 'automatic',
      fixtures: { taskFacts: [], runFrames: [frame] },
    })
    expect(automatic.summary.blocks).toEqual([])
    expect(automatic.plan.settlements ?? []).toEqual([])
    expect(automatic.sink.rows('clarify_rounds')).toEqual([])
    expect(automatic.sink.rows('collaboration_gate_operations')).toEqual([])
    for (const [table, code] of [
      ['clarify_rounds', 'v2-clarify-task-facts-missing'],
      ['collaboration_gate_operations', 'v2-gate-task-facts-missing'],
    ] as const) {
      expect(automatic.dispositions).toContainEqual(
        expect.objectContaining({
          sourceTable: table,
          class: 'archived',
          kind: 'archived',
          targets: [],
          decision: expect.objectContaining({ code }),
        }),
      )
      expect(
        decisions(automatic.records, 'v2-row-set-aside').some(
          (record) =>
            (record.payload as { sourceTable?: string; code?: string }).sourceTable === table &&
            (record.payload as { code?: string }).code === code,
        ),
      ).toBe(true)
    }
  }, 180_000)
})
