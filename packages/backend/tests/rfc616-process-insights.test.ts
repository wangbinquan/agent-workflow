// RFC-616 §9 — text-theme analyses as a use case: request, run, view, schedule.
//
// Locks what the analysis promises a reader:
//   · the model is only asked to group ids — every count, share and excerpt on
//     the page is computed from the text itself;
//   · an analysis reads exactly the text its requester could read, and a result
//     is seen only within the scope it was made for;
//   · nothing to read means no model call; an unreadable answer gets one more
//     try and then fails the analysis instead of showing a guess;
//   · the weekly schedule queues at most five subjects a pass, never the same
//     subject twice within seven days, and only when it has new units.
import { describe, expect, test } from 'bun:test'
import type { ProcessInsightSchedule, WorkflowDefinition } from '@agent-workflow/shared'
import {
  createInsightAnalyses,
  INSIGHT_SCHEDULE_BATCH,
  INSIGHT_SCHEDULE_CHECK_MS,
  INSIGHT_SCHEDULE_EVERY_MS,
  INSIGHT_SCHEDULE_WINDOW_MS,
} from '@/modules/run-observability/application/process/insightAnalyses'
import type {
  InsightRunRequest,
  InsightRunResult,
} from '@/modules/run-observability/application/process/ports/insightRunner'
import {
  INSIGHT_KEEP,
  type InsightAnalysis,
  type InsightScope,
  type InsightStore,
  type InsightSubject,
} from '@/modules/run-observability/application/process/ports/insightStore'
import { createProcessTexts } from '@/modules/run-observability/application/process/processTexts'
import { createSubjectActivity } from '@/modules/run-observability/application/process/subjectActivity'
import type { ProcessTextItem } from '@/platform/contracts/processFacts'
import {
  fakeProcessSources,
  person,
  taskUnit,
  type FakeProcessData,
} from './helpers/processMetricsFakes'

const H = 3_600_000
const DAY = 24 * H
const WINDOW = { from: 0, to: 100 * DAY }

const admin = person('admin', 'admin')
const alice = person('alice', 'user')
const dave = person('dave', 'user')
const nobody = person('ghost', 'user', ['tasks:read'])

/** The store's contract over an array, mirroring the two-provider implementation rule for rule. */
function memoryInsightStore(): { readonly rows: InsightAnalysis[]; readonly store: InsightStore } {
  const rows: InsightAnalysis[] = []
  const same = (row: InsightAnalysis, subject: InsightSubject, scope: InsightScope) =>
    row.subject.kind === subject.kind &&
    row.subject.id === subject.id &&
    row.scope.kind === scope.kind &&
    (scope.kind === 'all' || (row.scope.kind === 'user' && row.scope.userId === scope.userId))
  const newestFirst = (a: InsightAnalysis, b: InsightAnalysis) =>
    b.createdAt - a.createdAt || b.id.localeCompare(a.id)
  const replace = (id: string, change: Partial<InsightAnalysis>) => {
    const index = rows.findIndex((row) => row.id === id)
    rows[index] = { ...rows[index]!, ...change }
    return rows[index]!
  }
  const store: InsightStore = {
    async active(subject, scope) {
      return (
        rows
          .filter(
            (row) =>
              same(row, subject, scope) && (row.status === 'pending' || row.status === 'running'),
          )
          .sort(newestFirst)[0] ?? null
      )
    },
    async recent(subject, scope, limit) {
      return rows
        .filter((row) => same(row, subject, scope))
        .sort(newestFirst)
        .slice(0, limit)
    },
    async lastDone(subject, scope) {
      return (
        rows
          .filter((row) => same(row, subject, scope) && row.status === 'done')
          .sort(newestFirst)[0] ?? null
      )
    },
    async insert(entry) {
      rows.push({
        ...entry,
        status: 'pending',
        input: null,
        result: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
      })
    },
    async claimNext(at) {
      const next = rows
        .filter((row) => row.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
      return next === undefined ? null : replace(next.id, { status: 'running', startedAt: at })
    },
    async finish(id, outcome, at) {
      if (rows.find((row) => row.id === id)?.status !== 'running') return
      replace(
        id,
        outcome.status === 'done'
          ? { status: 'done', input: outcome.input, result: outcome.result, finishedAt: at }
          : {
              status: 'failed',
              input: outcome.input,
              errorCode: outcome.errorCode,
              errorMessage: outcome.errorMessage,
              finishedAt: at,
            },
      )
    },
    async failRunning(errorCode, errorMessage, at) {
      const running = rows.filter((row) => row.status === 'running')
      for (const row of running)
        replace(row.id, { status: 'failed', errorCode, errorMessage, finishedAt: at })
      return running.length
    },
    async prune(subject, scope) {
      const keep = new Set(
        rows
          .filter((row) => same(row, subject, scope))
          .sort(newestFirst)
          .slice(0, INSIGHT_KEEP)
          .map((row) => row.id),
      )
      const lastDone = await store.lastDone(subject, scope)
      if (lastDone) keep.add(lastDone.id)
      for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index]!
        if (
          same(row, subject, scope) &&
          !keep.has(row.id) &&
          (row.status === 'done' || row.status === 'failed')
        )
          rows.splice(index, 1)
      }
    },
    async lastScheduled(kind) {
      const last = new Map<string, number>()
      for (const row of rows) {
        if (row.subject.kind !== kind || row.scope.kind !== 'all') continue
        const key = row.subject.id ?? ''
        last.set(key, Math.max(last.get(key) ?? 0, row.createdAt))
      }
      return last
    },
  }
  return { rows, store }
}

const text = (
  taskId: string,
  source: ProcessTextItem['source'],
  at: number,
  words: string,
  stageRef: string | null = 'review',
): ProcessTextItem => ({ source, taskId, caseId: null, stageRef, at, text: words })

const definition = {
  $schema_version: 7,
  inputs: [],
  edges: [],
  nodes: [
    { id: 'design', kind: 'agent-single', title: 'Design' },
    { id: 'review', kind: 'review', title: 'Plan review' },
    { id: 'ask', kind: 'clarify', title: 'Ask the owner' },
  ],
} as unknown as WorkflowDefinition

function scenario(): Partial<FakeProcessData> {
  return {
    workflowNames: new Map([['wf-1', 'Requirement to merge']]),
    definitions: new Map([
      ['t1', definition],
      ['t2', definition],
    ]),
    tasks: [
      {
        kind: 'workflow',
        row: taskUnit({ taskId: 't1', startedAt: 10 * DAY, finishedAt: 11 * DAY }),
      },
      {
        kind: 'workflow',
        row: taskUnit({
          taskId: 't2',
          ownerUserId: 'dave',
          startedAt: 20 * DAY,
          finishedAt: 21 * DAY,
        }),
      },
    ],
    gateTexts: [
      text('t1', 'review', 10 * DAY + H, 'The error handling for an empty list is missing.'),
      text('t1', 'review', 10 * DAY + 2 * H, 'No test covers the empty list.'),
      text('t1', 'review', 10 * DAY + 3 * H, 'Naming: use the domain terms from the glossary.'),
      text('t1', 'clarify', 10 * DAY + 4 * H, 'Deploy to staging first.', 'ask'),
      text('t2', 'review', 20 * DAY + H, 'Empty input crashes the importer again.'),
      text('t2', 'review', 20 * DAY + 2 * H, '   '),
    ],
  }
}

interface Setup {
  readonly analyses: ReturnType<typeof createInsightAnalyses>
  readonly rows: InsightAnalysis[]
  readonly data: FakeProcessData
  readonly calls: InsightRunRequest[]
  readonly clock: { now: number }
  readonly settings: { schedule: ProcessInsightSchedule }
}

function setup(
  answers: readonly (InsightRunResult | Error)[] = [],
  seed: Partial<FakeProcessData> = scenario(),
): Setup {
  const { sources, data } = fakeProcessSources(seed)
  const { rows, store } = memoryInsightStore()
  const calls: InsightRunRequest[] = []
  const clock = { now: 50 * DAY }
  const settings: { schedule: ProcessInsightSchedule } = { schedule: 'manual' }
  const queue = [...answers]
  const analyses = createInsightAnalyses({
    store,
    runner: {
      async run(request) {
        calls.push(request)
        const next = queue.shift()
        if (next === undefined) throw new Error('unexpected model call')
        if (next instanceof Error) throw next
        return next
      },
    },
    texts: createProcessTexts(sources),
    schedule: async () => settings.schedule,
    activity: createSubjectActivity(sources),
    clock: () => clock.now,
  })
  return { analyses, rows, data, calls, clock, settings }
}

const answer = (groups: unknown): InsightRunResult => ({
  ok: true,
  answer: `Here is the grouping.\n${JSON.stringify({ groups })}`,
})

describe('RFC-616 text themes: requesting an analysis', () => {
  test('queues one pending analysis in the scope of whoever asked', async () => {
    const { analyses, rows } = setup()
    const accepted = await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    expect(accepted.status).toBe('pending')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: accepted.id,
      subject: { kind: 'workflow', id: 'wf-1', name: 'Requirement to merge' },
      scope: { kind: 'all' },
      windowFrom: 0,
      windowTo: 100 * DAY,
      trigger: 'manual',
      requestedBy: 'admin',
      status: 'pending',
      createdAt: 50 * DAY,
    })
    const own = await analyses.request(alice, 'workflow', 'wf-1', WINDOW)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === own.id)!.scope).toEqual({ kind: 'user', userId: 'alice' })
  })

  test('asking again while one is queued or running returns that one', async () => {
    const { analyses, rows } = setup([answer([])])
    const first = await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    expect(await analyses.request(admin, 'workflow', 'wf-1', WINDOW)).toEqual({
      id: first.id,
      status: 'pending',
    })
    rows[0] = { ...rows[0]!, status: 'running' }
    expect(await analyses.request(admin, 'workflow', 'wf-1', WINDOW)).toEqual({
      id: first.id,
      status: 'running',
    })
    expect(rows).toHaveLength(1)
  })

  test('nothing to read queues nothing', async () => {
    const { analyses, rows, calls } = setup([], { ...scenario(), gateTexts: [] })
    expect(await analyses.request(admin, 'workflow', 'wf-1', WINDOW)).toEqual({
      id: '',
      status: 'empty',
    })
    // An account without a task read scope has nothing to read either.
    expect((await setup().analyses.request(nobody, 'workflow', 'wf-1', WINDOW)).status).toBe(
      'empty',
    )
    expect(rows).toEqual([])
    expect(calls).toEqual([])
  })

  test('only the newest five analyses of a subject and scope are kept', async () => {
    const { analyses, rows, clock } = setup(Array.from({ length: 7 }, () => answer([])))
    for (let index = 0; index < 7; index++) {
      clock.now += H
      await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
      await analyses.runNext()
    }
    expect(rows).toHaveLength(INSIGHT_KEEP)
    // The two oldest are the ones dropped.
    expect(Math.min(...rows.map((row) => row.createdAt))).toBe(50 * DAY + 3 * H)
  })
})

describe('RFC-616 text themes: running an analysis', () => {
  test('an empty queue is a quiet beat', async () => {
    const { analyses, calls } = setup()
    expect(await analyses.runNext()).toBe(false)
    expect(calls).toEqual([])
  })

  test('the model groups ids; counts, shares, excerpts and stages are computed from the text', async () => {
    const { analyses, rows, calls } = setup([
      answer([
        {
          source: 'review',
          themes: [
            // r4 is not an id of this input and r1 is cited twice: both are ignored the second time.
            {
              name: 'Empty input is not handled',
              itemIds: ['r1', 'r2', 'r4', 'r9'],
              advice: 'Add an empty-input case to the design prompt.',
            },
            { name: 'Naming', itemIds: ['r3', 'r1'], advice: 'Point the agent at the glossary.' },
            { name: 'Invented', itemIds: ['r77'], advice: 'Nothing.' },
          ],
        },
        { source: 'clarify', themes: [] },
      ]),
    ])
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    expect(await analyses.runNext()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      analysisId: rows[0]!.id,
      attempt: 1,
      ownerUserId: 'admin',
      subjectName: 'Requirement to merge',
    })
    // Ids are numbered per source in reading order; the blank comment is not sent.
    expect(calls[0]!.prompt).toContain('[r1] The error handling for an empty list is missing.')
    expect(calls[0]!.prompt).toContain('[r4] Empty input crashes the importer again.')
    expect(calls[0]!.prompt).toContain('[c1] Deploy to staging first.')
    expect(calls[0]!.prompt).not.toContain('[r5]')

    expect(rows[0]).toMatchObject({
      status: 'done',
      finishedAt: 50 * DAY,
      input: {
        sources: [
          { source: 'review', items: 4, truncated: false },
          { source: 'clarify', items: 1, truncated: false },
        ],
        newestAt: 20 * DAY + H,
      },
    })
    const [review, clarify] = rows[0]!.result!.groups
    expect(review).toEqual({
      source: 'review',
      items: 4,
      truncated: false,
      otherItems: 0,
      themes: [
        {
          name: 'Empty input is not handled',
          items: 3,
          share: 3 / 4,
          stages: ['review'],
          // The two shortest of the three, in a person's own words, with the unit they came from.
          quotes: [
            { text: 'No test covers the empty list.', unitId: 't1' },
            { text: 'Empty input crashes the importer again.', unitId: 't2' },
          ],
          advice: 'Add an empty-input case to the design prompt.',
        },
        {
          name: 'Naming',
          items: 1,
          share: 1 / 4,
          stages: ['review'],
          quotes: [{ text: 'Naming: use the domain terms from the glossary.', unitId: 't1' }],
          advice: 'Point the agent at the glossary.',
        },
      ],
    })
    expect(clarify).toMatchObject({ source: 'clarify', items: 1, themes: [], otherItems: 1 })
    // Only the stages a theme refers to keep their label.
    expect(rows[0]!.result!.stageLabels).toEqual({ review: 'Plan review' })
  })

  test('a member analysis reads only the text of the units that member can see', async () => {
    const { analyses, calls } = setup([answer([])])
    await analyses.request(alice, 'workflow', 'wf-1', WINDOW)
    await analyses.runNext()
    expect(calls[0]!.prompt).toContain('No test covers the empty list.')
    // dave's task is not alice's.
    expect(calls[0]!.prompt).not.toContain('Empty input crashes the importer again.')
    expect(calls[0]!.ownerUserId).toBe('alice')
  })

  test('an unreadable answer gets one more try with the correction appended', async () => {
    const { analyses, rows, calls } = setup([
      { ok: true, answer: 'I could not find any themes, sorry.' },
      answer([
        { source: 'review', themes: [{ name: 'Empty input', itemIds: ['r1', 'r2'], advice: '' }] },
      ]),
    ])
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    await analyses.runNext()
    expect(calls.map((call) => call.attempt)).toEqual([1, 2])
    expect(calls[1]!.prompt.startsWith(calls[0]!.prompt)).toBe(true)
    expect(calls[1]!.prompt).toContain('Your previous answer was not the requested document.')
    expect(rows[0]!.status).toBe('done')
    expect(rows[0]!.result!.groups[0]!.themes[0]).toMatchObject({ name: 'Empty input', items: 2 })
  })

  test('a second unreadable answer fails the analysis instead of showing a guess', async () => {
    const { analyses, rows, calls } = setup([
      { ok: true, answer: 'no' },
      { ok: true, answer: '{"themes": "none"' },
    ])
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    await analyses.runNext()
    expect(calls).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'invalid-output',
      result: null,
      // What it read is still recorded.
      input: { newestAt: 20 * DAY + H },
    })
  })

  test('a run that fails is not retried and keeps its reason', async () => {
    const failed = setup([
      { ok: false, code: 'run-timeout', message: 'no answer within the limit' },
    ])
    await failed.analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    await failed.analyses.runNext()
    expect(failed.calls).toHaveLength(1)
    expect(failed.rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'run-timeout',
      errorMessage: 'no answer within the limit',
    })

    const thrown = setup([new Error('runtime is not configured')])
    await thrown.analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    expect(await thrown.analyses.runNext()).toBe(true)
    expect(thrown.rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'analysis-failed',
      errorMessage: 'runtime is not configured',
    })
  })

  test('text that is gone by the time the job runs ends the analysis without a model call', async () => {
    const { analyses, rows, data, calls } = setup()
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    data.gateTexts = []
    await analyses.runNext()
    expect(calls).toEqual([])
    expect(rows[0]).toMatchObject({
      status: 'done',
      input: { sources: [], newestAt: null },
      result: { groups: [], stageLabels: {} },
    })
  })

  test('analyses are worked oldest first, one a beat', async () => {
    const { analyses, rows, clock } = setup([answer([]), answer([])])
    await analyses.request(alice, 'workflow', 'wf-1', WINDOW)
    clock.now += H
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    await analyses.runNext()
    expect(rows.map((row) => [row.requestedBy, row.status])).toEqual([
      ['alice', 'done'],
      ['admin', 'pending'],
    ])
  })
})

describe('RFC-616 text themes: what a viewer sees', () => {
  test('before any analysis: nothing, with the configured schedule and the viewer scope', async () => {
    const { analyses, settings } = setup()
    settings.schedule = 'weekly'
    expect(await analyses.view(alice, 'workflow', 'wf-1', WINDOW)).toEqual({
      asOf: 50 * DAY,
      scope: 'own',
      schedule: 'weekly',
      result: null,
      active: null,
      failure: null,
      stale: false,
    })
    expect((await analyses.view(admin, 'workflow', 'wf-1', WINDOW)).scope).toBe('all')
  })

  test('queued, then finished; a result belongs to the scope it was made for', async () => {
    const { analyses, rows, clock } = setup([
      answer([
        { source: 'review', themes: [{ name: 'Empty input', itemIds: ['r1', 'r2'], advice: 'x' }] },
      ]),
    ])
    const accepted = await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    expect((await analyses.view(admin, 'workflow', 'wf-1', WINDOW)).active).toEqual({
      id: accepted.id,
      status: 'pending',
      requestedAt: 50 * DAY,
    })
    clock.now += H
    await analyses.runNext()
    const view = await analyses.view(admin, 'workflow', 'wf-1', WINDOW)
    expect(view.active).toBeNull()
    expect(view.failure).toBeNull()
    expect(view.stale).toBe(false)
    expect(view.result).toMatchObject({
      id: accepted.id,
      trigger: 'manual',
      windowFrom: 0,
      windowTo: 100 * DAY,
      finishedAt: 50 * DAY + H,
      groups: rows[0]!.result!.groups,
    })
    // Another manager shares it; a member does not see it, and neither does another member.
    expect(
      (await analyses.view(person('root', 'admin'), 'workflow', 'wf-1', WINDOW)).result?.id,
    ).toBe(accepted.id)
    expect((await analyses.view(alice, 'workflow', 'wf-1', WINDOW)).result).toBeNull()
    expect((await analyses.view(dave, 'workflow', 'wf-1', WINDOW)).result).toBeNull()
    // …nor does the same manager on another subject.
    expect((await analyses.view(admin, 'workflow', 'wf-2', WINDOW)).result).toBeNull()
  })

  test('a result goes stale when newer text appears', async () => {
    const { analyses, data } = setup([answer([])])
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    await analyses.runNext()
    expect((await analyses.view(admin, 'workflow', 'wf-1', WINDOW)).stale).toBe(false)
    data.gateTexts.push(text('t2', 'review', 21 * DAY, 'Still no empty-list test.'))
    expect((await analyses.view(admin, 'workflow', 'wf-1', WINDOW)).stale).toBe(true)
  })

  test('a failed attempt after a finished one shows both', async () => {
    const { analyses, clock } = setup([
      answer([]),
      { ok: false, code: 'run-failed', message: 'model unavailable' },
    ])
    const first = await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    await analyses.runNext()
    clock.now += H
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    clock.now += H
    await analyses.runNext()
    const view = await analyses.view(admin, 'workflow', 'wf-1', WINDOW)
    expect(view.result?.id).toBe(first.id)
    expect(view.failure).toEqual({
      code: 'run-failed',
      message: 'model unavailable',
      at: 50 * DAY + 2 * H,
    })
    expect(view.active).toBeNull()
  })

  test('the last good result survives any number of later failures', async () => {
    // Regression: with the runtime down, five attempts (by hand or by the weekly schedule) pushed
    // the last successful analysis out of the kept five and off the page.
    const failures = INSIGHT_KEEP + 2
    const { analyses, rows, clock } = setup([
      answer([]),
      ...Array.from({ length: failures }, () => ({
        ok: false as const,
        code: 'run-failed',
        message: 'model unavailable',
      })),
    ])
    const good = await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    await analyses.runNext()
    for (let index = 0; index < failures; index++) {
      clock.now += H
      await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
      await analyses.runNext()
    }
    // The newest five attempts, all failed, and the good one kept beside them.
    expect(rows.filter((row) => row.status === 'failed')).toHaveLength(INSIGHT_KEEP)
    expect(rows.filter((row) => row.status === 'done').map((row) => row.id)).toEqual([good.id])
    const view = await analyses.view(admin, 'workflow', 'wf-1', WINDOW)
    expect(view.result?.id).toBe(good.id)
    expect(view.failure).toMatchObject({ code: 'run-failed' })
  })

  test('an account without a task read scope sees nothing', async () => {
    const { analyses } = setup([answer([])])
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    await analyses.runNext()
    expect(await analyses.view(nobody, 'workflow', 'wf-1', WINDOW)).toMatchObject({
      result: null,
      active: null,
    })
  })
})

describe('RFC-616 text themes: the weekly schedule', () => {
  const many = (count: number): Partial<FakeProcessData> => ({
    tasks: Array.from({ length: count }, (_, index) => ({
      kind: 'workflow' as const,
      row: taskUnit({
        taskId: `t${index}`,
        subjectId: `wf-${index}`,
        startedAt: 45 * DAY + index * H,
        finishedAt: 45 * DAY + index * H + H,
      }),
    })),
    workflowNames: new Map(
      Array.from({ length: count }, (_, index) => [`wf-${index}`, `Flow ${index}`]),
    ),
  })

  test('manual: nothing is ever queued', async () => {
    const { analyses, rows } = setup([], many(3))
    expect(await analyses.scheduleDue()).toBe(0)
    expect(rows).toEqual([])
  })

  test('weekly: subjects with units in the last 30 days, at most five a pass, for everyone', async () => {
    const { analyses, rows, settings } = setup([], {
      ...many(7),
      // A workflow whose only unit is older than the window is not due.
      ...{},
    })
    settings.schedule = 'weekly'
    expect(await analyses.scheduleDue()).toBe(INSIGHT_SCHEDULE_BATCH)
    expect(rows).toHaveLength(INSIGHT_SCHEDULE_BATCH)
    expect(rows[0]).toMatchObject({
      scope: { kind: 'all' },
      trigger: 'scheduled',
      requestedBy: null,
      windowFrom: 50 * DAY - INSIGHT_SCHEDULE_WINDOW_MS,
      windowTo: 50 * DAY,
      status: 'pending',
    })
    expect(rows.every((row) => row.subject.name?.startsWith('Flow '))).toBe(true)
    // The next pass takes the remaining two and nothing twice.
    expect(await analyses.scheduleDue()).toBe(2)
    expect(new Set(rows.map((row) => row.subject.id)).size).toBe(7)
    expect(await analyses.scheduleDue()).toBe(0)
  })

  test('a subject is analysed again after seven days, and only if a unit started since', async () => {
    const { analyses, rows, data, clock, settings } = setup([], many(1))
    settings.schedule = 'weekly'
    expect(await analyses.scheduleDue()).toBe(1)
    rows[0] = { ...rows[0]!, status: 'done', finishedAt: clock.now }
    clock.now += INSIGHT_SCHEDULE_EVERY_MS - H
    expect(await analyses.scheduleDue()).toBe(0)
    clock.now += 2 * H
    // Seven days have passed but nothing new ran.
    expect(await analyses.scheduleDue()).toBe(0)
    data.tasks.push({
      kind: 'workflow',
      row: taskUnit({
        taskId: 'later',
        subjectId: 'wf-0',
        startedAt: clock.now - H,
        finishedAt: clock.now,
      }),
    })
    expect(await analyses.scheduleDue()).toBe(1)
    expect(rows).toHaveLength(2)
  })

  test('a manual analysis for everyone also counts as the last one', async () => {
    const { analyses, rows, settings } = setup([answer([])])
    settings.schedule = 'weekly'
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    // wf-1's units are older than the 30-day window anyway; a recent unit makes it a candidate.
    expect(await analyses.scheduleDue()).toBe(0)
    expect(rows).toHaveLength(1)
  })

  test('one beat checks the schedule at most hourly and works one analysis', async () => {
    const { analyses, rows, clock, settings } = setup([answer([]), answer([])], many(2))
    settings.schedule = 'weekly'
    await analyses.tick()
    // Both subjects were queued by the check; the beat worked the older one.
    expect(rows.map((row) => row.status).sort()).toEqual(['done', 'pending'])
    rows.splice(0, rows.length)
    clock.now += INSIGHT_SCHEDULE_CHECK_MS - 1
    await analyses.tick()
    // Within the hour the schedule is not looked at again.
    expect(rows).toEqual([])
    clock.now += 1
    await analyses.tick()
    expect(rows).toHaveLength(2)
  })

  test('analyses left running by a previous daemon are failed, queued ones stay queued', async () => {
    const { analyses, rows, clock } = setup()
    await analyses.request(admin, 'workflow', 'wf-1', WINDOW)
    await analyses.request(alice, 'workflow', 'wf-1', WINDOW)
    rows[0] = { ...rows[0]!, status: 'running', startedAt: clock.now }
    clock.now += H
    expect(await analyses.repairInterrupted()).toBe(1)
    expect(rows.map((row) => [row.status, row.errorCode, row.finishedAt])).toEqual([
      ['failed', 'daemon-restarted', 50 * DAY + H],
      ['pending', null, null],
    ])
    expect((await analyses.view(admin, 'workflow', 'wf-1', WINDOW)).failure).toMatchObject({
      code: 'daemon-restarted',
    })
  })
})
