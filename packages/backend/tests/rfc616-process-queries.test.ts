// RFC-616 §6.1 / §8 — the process metrics use cases over in-memory fact
// sources, for workflows.
//
// One hand-checked scenario exercises everything a workflow summary shows: the
// time split, tokens by cause (adding up to the headline), stages including a
// call node that carries its child task's tokens and waiting, platform work on
// its own stage, the review statistics, a manual retry (placeholder + revival),
// and the difference between what a manager and an ordinary member may see.
// Also locks scope, the unit limit, both comparisons, paging and unit detail.
import { describe, expect, test } from 'bun:test'
import {
  PROCESS_SUMMARY_UNIT_LIMIT,
  PROCESS_UNIT_PAGE_SIZE,
  type ProcessWorkflowSummary,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { createProcessQueries } from '@/modules/run-observability/application/process/processQueries'
import { ValidationError } from '@/platform/errors/domainErrors'
import {
  fakeProcessSources,
  gateRound,
  nodeRun,
  person,
  taskUnit,
  usageRow,
  wrapperRun,
  type FakeProcessData,
} from './helpers/processMetricsFakes'

const M = 60_000
const H = 60 * M
const NOW = 100 * H
const WINDOW = { from: 0, to: 1_000 * H, tzOffset: 0, compare: 'off' as const }

const admin = person('admin', 'admin')
const alice = person('alice', 'user')
const nobody = person('ghost', 'user', ['tasks:read'])

const definition = {
  $schema_version: 7,
  inputs: [],
  edges: [],
  nodes: [
    { id: 'design', kind: 'agent-single', title: 'Design' },
    { id: 'review', kind: 'review', title: 'Plan review' },
    { id: 'loop', kind: 'wrapper-loop', nodeIds: ['code'], maxIterations: 5 },
    { id: 'code', kind: 'agent-single', agentName: 'coder' },
    { id: 'call', kind: 'call-workflow', title: 'Sub flow' },
  ],
} as unknown as WorkflowDefinition

function scenario(): Partial<FakeProcessData> {
  return {
    usageSince: 0,
    workflowNames: new Map([['wf-1', 'Requirement to merge']]),
    identities: [
      { id: 'bob', username: 'bob', displayName: 'Bob' },
      { id: 'carol', username: 'carol', displayName: 'Carol' },
      { id: 'alice', username: 'alice', displayName: 'Alice' },
      { id: 'dave', username: 'dave', displayName: 'Dave' },
    ],
    // The summary draws its stages from the newest unit; a unit's own detail from its own definition.
    definitions: new Map([
      ['t1', definition],
      ['t3', definition],
    ]),
    tasks: [
      {
        kind: 'workflow',
        row: taskUnit({
          taskId: 't1',
          subjectRevision: 2,
          startedAt: 10 * H,
          finishedAt: 20 * H,
          autoMs: 3 * H,
        }),
      },
      {
        kind: 'workflow',
        row: taskUnit({
          taskId: 't2',
          ownerUserId: 'dave',
          origin: 'scheduled',
          status: 'failed',
          startedAt: 30 * H,
          finishedAt: 31 * H,
          autoMs: H / 2,
        }),
      },
      {
        kind: 'workflow',
        row: taskUnit({
          taskId: 't3',
          status: 'running',
          startedAt: 40 * H,
          finishedAt: null,
          autoMs: H,
        }),
      },
      // Before the window: the baseline of a period comparison.
      {
        kind: 'workflow',
        row: taskUnit({ taskId: 't0', startedAt: -50 * H, finishedAt: -48 * H, autoMs: H }),
      },
      // Another workflow and a workgroup task never leak into wf-1.
      {
        kind: 'workflow',
        row: taskUnit({ taskId: 'x1', subjectId: 'wf-2', startedAt: 12 * H, finishedAt: 13 * H }),
      },
      {
        kind: 'workgroup',
        row: taskUnit({
          taskId: 'g1',
          subjectId: 'wf-1',
          engineKind: 'workgroup-turns',
          startedAt: 12 * H,
        }),
      },
    ],
    nodeRuns: [
      nodeRun({
        taskId: 't1',
        nodeRunId: 'r-design-1',
        nodeId: 'design',
        startedAt: 10 * H,
        finishedAt: 10.5 * H,
      }),
      nodeRun({
        taskId: 't1',
        nodeRunId: 'r-review-park',
        nodeId: 'review',
        rerunCause: 'review-park',
        status: 'awaiting_review',
        startedAt: null,
        finishedAt: null,
      }),
      nodeRun({
        taskId: 't1',
        nodeRunId: 'r-design-2',
        nodeId: 'design',
        rerunCause: 'review-iterate',
        startedAt: 13 * H,
        finishedAt: 13.5 * H,
      }),
      nodeRun({
        taskId: 't1',
        nodeRunId: 'r-code-1',
        nodeId: 'code',
        containerRunId: 'loop-run-1',
        status: 'failed',
        failureCode: 'envelope-missing',
        startedAt: 14 * H,
        finishedAt: 15 * H,
      }),
      nodeRun({
        taskId: 't1',
        nodeRunId: 'r-code-2',
        nodeId: 'code',
        containerRunId: 'loop-run-1',
        rerunCause: 'process-retry',
        startedAt: 15 * H,
        finishedAt: 15.5 * H,
      }),
      nodeRun({
        taskId: 't1',
        nodeRunId: 'r-call-1',
        nodeId: 'call',
        startedAt: 16 * H,
        finishedAt: 18 * H,
      }),
      nodeRun({
        taskId: 't1',
        nodeRunId: 'r-commit',
        nodeId: '__commit_push__:code',
        rerunCause: 'commit-push-session',
        startedAt: 18 * H,
        finishedAt: 18 * H + 6 * M,
      }),
      // A manual retry: the placeholder (failed, never started) and the real rerun.
      nodeRun({
        taskId: 't1',
        nodeRunId: 'r-placeholder',
        nodeId: 'design',
        rerunCause: 'retry-node',
        status: 'failed',
        startedAt: null,
        finishedAt: 19 * H,
      }),
      nodeRun({
        taskId: 't1',
        nodeRunId: 'r-design-3',
        nodeId: 'design',
        rerunCause: 'revival',
        startedAt: 19 * H,
        finishedAt: 19.5 * H,
      }),
      nodeRun({
        taskId: 't2',
        nodeRunId: 'r2-design',
        nodeId: 'design',
        status: 'failed',
        failureCode: 'timeout',
        startedAt: 30 * H,
        finishedAt: 30.5 * H,
      }),
      nodeRun({
        taskId: 't3',
        nodeRunId: 'r3-design',
        nodeId: 'design',
        status: 'running',
        startedAt: 40 * H,
        finishedAt: null,
      }),
      nodeRun({
        taskId: 't0',
        nodeRunId: 'r0-design',
        nodeId: 'design',
        startedAt: -50 * H,
        finishedAt: -49 * H,
      }),
    ],
    wrappers: [
      wrapperRun({
        taskId: 't1',
        runId: 'loop-run-1',
        nodeId: 'loop',
        seq: 1,
        startedAt: 14 * H,
        finishedAt: 15.5 * H,
      }),
    ],
    descendants: [
      { unitTaskId: 't1', taskId: 'c1', callNodeId: 'call', callNodeRunId: 'r-call-1' },
    ],
    gateRounds: [
      gateRound({
        taskId: 't1',
        gateNodeRunId: 'rr-1',
        ordinal: 1,
        openedAt: 10.5 * H,
        closedAt: 13 * H,
        outcome: 'iterated',
        deciderUserId: 'bob',
        measures: { comments: 4, commenters: 2 },
        people: [
          { userId: 'bob', comments: 3, answers: 0 },
          { userId: 'carol', comments: 1, answers: 0 },
        ],
      }),
      gateRound({
        taskId: 't1',
        gateNodeRunId: 'rr-1',
        ordinal: 2,
        openedAt: 13.5 * H,
        closedAt: 14 * H,
        outcome: 'approved',
        deciderUserId: 'bob',
        measures: { comments: 0 },
      }),
      // A clarify round inside the called task: waiting time and an intervention of t1, nothing else.
      gateRound({
        taskId: 'c1',
        kind: 'clarify',
        stageNodeId: 'child-ask',
        relatedNodeId: 'child-design',
        gateNodeRunId: 'child-ask-run',
        openedAt: 16.5 * H,
        closedAt: 17.5 * H,
        outcome: 'continue',
        deciderUserId: 'alice',
        measures: { questions: 3 },
      }),
    ],
    usage: [
      usageRow({ taskId: 't1', nodeRunId: 'r-design-1', tokens: 1_000 }),
      usageRow({ taskId: 't1', nodeRunId: 'r-design-2', tokens: 500 }),
      usageRow({ taskId: 't1', nodeRunId: 'r-code-1', tokens: 300 }),
      usageRow({ taskId: 't1', nodeRunId: 'r-code-2', tokens: 100 }),
      usageRow({ taskId: 't1', nodeRunId: 'r-design-3', tokens: 50 }),
      usageRow({ taskId: 't1', nodeRunId: 'r-commit', tokens: 20 }),
      usageRow({ taskId: 't1', purpose: 'system', systemKind: 'memory-distiller', tokens: 30 }),
      usageRow({ taskId: 'c1', nodeRunId: 'child-run', tokens: 400 }),
      usageRow({ taskId: 'c1', purpose: 'system', systemKind: 'change-narrative', tokens: 10 }),
      usageRow({ taskId: 't2', nodeRunId: 'r2-design', tokens: 200 }),
      usageRow({ taskId: 't3', nodeRunId: 'r3-design', tokens: 70 }),
      usageRow({ taskId: 't0', nodeRunId: 'r0-design', tokens: 100 }),
    ],
    operations: [
      {
        action: 'review.view',
        subjectKind: 'node-run',
        subjectId: 'rr-1',
        actorUserId: 'bob',
        firstAt: 11 * H,
        lastAt: 11 * H + 12 * M,
      },
      {
        action: 'task.resume',
        subjectKind: 'task',
        subjectId: 't1',
        actorUserId: 'alice',
        firstAt: 19 * H,
        lastAt: 19 * H,
      },
    ],
  }
}

function queriesOf(seed: Partial<FakeProcessData> = scenario()) {
  const fake = fakeProcessSources(seed)
  return { ...fake, queries: createProcessQueries({ sources: fake.sources, clock: () => NOW }) }
}

const stageOf = (summary: ProcessWorkflowSummary, key: string) =>
  summary.stages.find((stage) => stage.key === key)!

describe('RFC-616 workflow summary', () => {
  test('the headline numbers', async () => {
    const { queries } = queriesOf()
    const summary = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(summary.kind).toBe('workflow')
    expect(summary).toMatchObject({
      asOf: NOW,
      subjectId: 'wf-1',
      subjectName: 'Requirement to merge',
      scope: 'all',
      counts: { total: 3, succeeded: 1, failed: 1, canceled: 0, active: 1 },
      compare: { mode: 'off', split: null, baselineUnits: 0 },
    })
    const value = (id: keyof typeof summary.metrics) => summary.metrics[id]!.value
    expect(value('units')).toBe(3)
    expect(value('successRate')).toBe(1 / 2)
    expect(value('leadP50')).toBe(10 * H)
    expect(value('flowEfficiency')).toBe(0.3)
    // Tokens: the two ended tasks (2410 + 200) / 2; the running task is not in the sample.
    expect(value('tokensPerUnit')).toBe(1_305)
    expect(value('costNanoPerUnit')).toBe(13_050)
    expect(value('firstPassRate')).toBe(0)
    // t1: two review rounds, one clarify round in its child, one manual retry, one resume.
    expect(value('interventionsPerUnit')).toBe(5 / 2)
    expect(summary.metrics.units!.baseline).toBeNull()
  })

  test('where the time went: the three parts add up to the lead time', async () => {
    const { queries } = queriesOf()
    const { time } = await queries.summary(admin, 'workflow', 'wf-1', WINDOW)
    expect(time).toEqual({
      sampleUnits: 1,
      leadMs: 10 * H,
      autoMs: 3 * H,
      waits: [
        { kind: 'review', ms: 3 * H },
        // The clarify round happened in the task the call node started.
        { kind: 'clarify', ms: H },
      ],
      otherMs: 3 * H,
    })
  })

  test('tokens by cause add up to the headline number', async () => {
    const { queries } = queriesOf()
    const summary = await queries.summary(admin, 'workflow', 'wf-1', WINDOW)
    expect(summary.causes.map((slice) => [slice.cause, slice.tokens])).toEqual([
      ['first', 950],
      ['review-rework', 250],
      ['clarify-rerun', 0],
      ['auto-retry', 50],
      // The rerun after the manual retry is a recovery.
      ['other-rerun', 25],
      // Commit and push, memory extraction, and the child's change narrative.
      ['system', 30],
    ])
    expect(summary.causes.reduce((sum, slice) => sum + slice.tokens, 0)).toBe(
      summary.metrics.tokensPerUnit!.value!,
    )
  })

  test('interventions, stability, origins, revisions and the data note', async () => {
    const { queries } = queriesOf()
    const summary = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(summary.interventions).toEqual({
      gates: [
        { kind: 'review', perUnit: 1 },
        { kind: 'clarify', perUnit: 0.5 },
      ],
      manualRetriesPerUnit: 0.5,
      operationsPerUnit: 0.5,
    })
    expect(summary.stability).toEqual({
      failureCodes: [
        { code: 'envelope-missing', runs: 1 },
        { code: 'timeout', runs: 1 },
      ],
      autoRetries: 1,
      interruptions: 0,
      recoveries: 1,
      // One placeholder row: the manual retry is counted once and is not a failed execution.
      manualRetries: 1,
      limitCancellations: 0,
      operations: 1,
    })
    expect(summary.origins).toEqual([
      { origin: 'manual', units: 2 },
      { origin: 'scheduled', units: 1 },
    ])
    expect(summary.revisions).toEqual([
      { revision: 2, units: 1 },
      { revision: 1, units: 2 },
    ])
    expect(summary.note).toEqual({
      units: 3,
      partial: false,
      unitLimit: PROCESS_SUMMARY_UNIT_LIMIT,
      unitsWithoutUsage: 0,
      unitsWithoutRuntime: 0,
      runsWithoutCause: 0,
      usageLowerBound: false,
      unpriced: false,
    })
    expect(summary.definition).toBe(definition)
  })

  test('stages: nodes, the wrapper, the call node, platform work', async () => {
    const { queries } = queriesOf()
    const summary = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(summary.stages.map((stage) => stage.key)).toEqual([
      'design',
      'review',
      'loop',
      'code',
      'call',
      'system:commit-push',
      'system:other',
    ])
    expect(stageOf(summary, 'design')).toMatchObject({
      label: 'Design',
      kind: 'agent-single',
      removed: false,
      units: 3,
      // Three real runs in t1 (the placeholder is not one), one in t2, one in t3.
      runsPerUnit: 5 / 3,
      durationMs: { n: 1, p50: 90 * M },
      tokensPerUnit: 875,
      tokenShare: 1_750 / 2_610,
      failureRate: 1 / 4,
      autoRetryRate: 0,
      topFailureCode: 'timeout',
      rejectRate: 1 / 2,
      reworkTokenShare: 500 / 1_750,
    })
    expect(stageOf(summary, 'code')).toMatchObject({
      label: 'coder',
      parentKey: 'loop',
      runsPerUnit: 2,
      durationMs: { n: 1, p50: 90 * M },
      failureRate: 1 / 2,
      autoRetryRate: 1 / 2,
      topFailureCode: 'envelope-missing',
    })
    expect(stageOf(summary, 'loop')).toMatchObject({
      kind: 'wrapper-loop',
      durationMs: { n: 1, p50: 1.5 * H },
      loop: {
        roundsMean: 1,
        roundsMax: 1,
        maxIterations: 5,
        capRate: 0,
        capIncludesFullRuns: false,
      },
    })
    // The call node: its own run time, the child task's tokens, the child's waiting.
    expect(stageOf(summary, 'call')).toMatchObject({
      label: 'Sub flow',
      runsPerUnit: 1,
      durationMs: { n: 1, p50: 2 * H },
      tokensPerUnit: 410,
      gateRoundsPerUnit: 1,
      gateWaitMsPerUnit: H,
      // The child's gates say nothing about this workflow's reviews.
      gateFirstPassRate: null,
    })
    expect(stageOf(summary, 'review')).toMatchObject({
      label: 'Plan review',
      runsPerUnit: null,
      gateRoundsPerUnit: 2,
      gateWaitMsPerUnit: 3 * H,
      gateFirstPassRate: 0,
    })
    expect(stageOf(summary, 'system:commit-push')).toMatchObject({
      kind: 'system',
      removed: false,
      tokensPerUnit: 20,
    })
    expect(stageOf(summary, 'system:other')).toMatchObject({ kind: 'system', tokensPerUnit: 30 })
    // Every token of the sample is on some stage.
    const sampleTokens = 2_410 + 200
    expect(
      summary.stages.reduce((sum, stage) => sum + (stage.tokenShare ?? 0) * sampleTokens, 0),
    ).toBeCloseTo(sampleTokens)
  })

  test('review statistics describe this workflow only; the child task has its own', async () => {
    const { queries } = queriesOf()
    const summary = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(summary.review).toMatchObject({
      rounds: 2,
      voidRounds: 0,
      durationMs: { n: 2, p50: H / 2, p90: 2.5 * H },
      responseMs: { n: 1, p50: H / 2 },
      handlingMs: { n: 1, p50: 2 * H },
      roundsPerUnit: 2,
      firstPassRate: 0,
      commentsPerRound: 2,
      commentsPerCommenter: 2,
      reworkMs: { n: 1, p50: H / 2 },
      decisions: { approved: 1, iterated: 1, rejected: 0 },
      commentsByRound: [
        { ordinal: 1, rounds: 1, comments: 4 },
        { ordinal: 2, rounds: 1, comments: 0 },
      ],
      byStage: [
        { stageKey: 'review', relatedStageKey: 'design', roundsPerUnit: 2, firstPassRate: 0 },
      ],
      people: [
        { userId: 'bob', decisions: 2, comments: 3, answers: 0, responseP50: H / 2 },
        { userId: 'carol', decisions: 0, comments: 1, answers: 0, responseP50: null },
      ],
    })
    expect(summary.clarify).toBeNull()
    expect(summary.mindmap).toBeNull()
    expect(summary.identities.map((identity) => identity.id).sort()).toEqual(['bob', 'carol'])
  })
})

describe('RFC-616 scope', () => {
  test('a member sees the statistics of their own tasks, without per-person detail', async () => {
    const { queries } = queriesOf()
    const summary = (await queries.summary(
      alice,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(summary.scope).toBe('own')
    // dave's failed task is not alice's.
    expect(summary.counts).toEqual({ total: 2, succeeded: 1, failed: 0, canceled: 0, active: 1 })
    expect(summary.metrics.tokensPerUnit!.value).toBe(2_410)
    expect(summary.origins).toEqual([{ origin: 'manual', units: 2 }])
    expect(summary.review!.people).toBeNull()
    // The averages a member sees are still computed.
    expect(summary.review!.commentsPerCommenter).toBe(2)
    expect(summary.identities).toEqual([])
  })

  test('a collaborator sees a task they take part in', async () => {
    const seed = scenario()
    seed.tasks![1] = { ...seed.tasks![1]!, collaborators: ['alice'] }
    const { queries } = queriesOf(seed)
    const summary = await queries.summary(alice, 'workflow', 'wf-1', WINDOW)
    expect(summary.counts.total).toBe(3)
  })

  test('an account without a task read scope gets empty answers', async () => {
    const { queries } = queriesOf()
    const summary = await queries.summary(nobody, 'workflow', 'wf-1', WINDOW)
    expect(summary.counts.total).toBe(0)
    expect(summary.metrics.successRate).toEqual({ value: null, baseline: null })
    expect(
      (await queries.subjects(nobody, { kind: 'workflow', from: 0, to: 1_000 * H })).items,
    ).toEqual([])
    expect(
      (await queries.units(nobody, 'workflow', 'wf-1', { ...WINDOW, status: 'all' })).items,
    ).toEqual([])
    expect(await queries.unit(nobody, 'workflow', 't1')).toBeNull()
  })

  test('beyond the unit limit the newest units are aggregated and the answer says so', async () => {
    const tasks = Array.from({ length: PROCESS_SUMMARY_UNIT_LIMIT + 1 }, (_, index) => ({
      kind: 'workflow' as const,
      row: taskUnit({
        taskId: `t${index}`,
        startedAt: index * M,
        finishedAt: index * M + M,
        autoMs: M,
      }),
    }))
    const { queries } = queriesOf({ tasks })
    const summary = await queries.summary(admin, 'workflow', 'wf-1', WINDOW)
    expect(summary.note).toMatchObject({
      units: PROCESS_SUMMARY_UNIT_LIMIT,
      partial: true,
      unitLimit: PROCESS_SUMMARY_UNIT_LIMIT,
    })
    // The oldest task is the one left out.
    expect(summary.trend.reduce((sum, point) => sum + point.units, 0)).toBe(
      PROCESS_SUMMARY_UNIT_LIMIT,
    )
  })

  test('units before the first recorded call and units without a running-time record are counted apart', async () => {
    const seed = scenario()
    seed.usageSince = 25 * H
    // t1 ran before calls were recorded: neither it nor the task it called left any.
    seed.usage = seed.usage!.filter((row) => row.taskId !== 't1' && row.taskId !== 'c1')
    seed.tasks![0] = { kind: 'workflow', row: { ...seed.tasks![0]!.row, autoMs: null } }
    const { queries } = queriesOf(seed)
    const summary = await queries.summary(admin, 'workflow', 'wf-1', WINDOW)
    // t1 started before records began; only t2 is in the token sample.
    expect(summary.note).toMatchObject({ unitsWithoutUsage: 1, unitsWithoutRuntime: 1 })
    expect(summary.metrics.tokensPerUnit!.value).toBe(200)
    expect(summary.time.sampleUnits).toBe(0)
  })

  // Regression (2026-11-26, a freshly installed database): the first tasks of an installation
  // showed no tokens. Their own calls are the oldest on record and start after the tasks do, so
  // "started before the oldest recorded call" was true of exactly the tasks that had records.
  test('a task whose own calls are the oldest on record is in the token sample', async () => {
    const seed = scenario()
    // t1 started at 10 h; its first call, the oldest one there is, a minute later.
    seed.usageSince = 10 * H + M
    const { queries } = queriesOf(seed)
    const summary = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(summary.note).toMatchObject({ unitsWithoutUsage: 0 })
    // Both ended tasks: t1 with the task it called (2,410) and t2 (200).
    expect(summary.metrics.tokensPerUnit!.value).toBe(1_305)
    expect(stageOf(summary, 'design').tokensPerUnit).toBe(875)
  })

  test('the listing counts such a task too: it reads call totals, not node runs', async () => {
    const seed = scenario()
    seed.usageSince = 10 * H + M
    const { queries } = queriesOf(seed)
    const list = await queries.subjects(admin, { kind: 'workflow', from: 0, to: 1_000 * H })
    expect(list.items.find((row) => row.subjectId === 'wf-1')).toMatchObject({
      tokensPerUnit: 1_305,
    })
  })

  test('a task called by such a task makes it count: the calls of the whole unit are its record', async () => {
    const seed = scenario()
    seed.usageSince = 10 * H + M
    // Only the called task c1 left calls; t1 itself made none.
    seed.usage = seed.usage!.filter((row) => row.taskId !== 't1')
    const { queries } = queriesOf(seed)
    const summary = await queries.summary(admin, 'workflow', 'wf-1', WINDOW)
    expect(summary.note).toMatchObject({ unitsWithoutUsage: 0 })
    // t1 through c1 (410) and t2 (200).
    expect(summary.metrics.tokensPerUnit!.value).toBe(305)
  })
})

// The rules are tested on hand-made facts (hints-themes); this protects the wiring that fills
// those facts from a workflow's real numbers.
describe('RFC-616 hints of a computed workflow summary', () => {
  const reviewed = (count: number): Partial<FakeProcessData> => {
    const ids = Array.from({ length: count }, (_, index) => `h${index + 1}`)
    return {
      usageSince: 0,
      tasks: ids.map((taskId, index) => ({
        kind: 'workflow' as const,
        row: taskUnit({
          taskId,
          startedAt: (10 + 20 * index) * H,
          finishedAt: (20 + 20 * index) * H,
          autoMs: 2 * H,
        }),
      })),
      nodeRuns: ids.map((taskId, index) =>
        nodeRun({
          taskId,
          nodeRunId: `d-${taskId}`,
          nodeId: 'design',
          startedAt: (10 + 20 * index) * H,
          finishedAt: (11 + 20 * index) * H,
        }),
      ),
      // Each task's design waited six of its ten hours for a review that sent it back.
      gateRounds: ids.map((taskId, index) =>
        gateRound({
          taskId,
          gateNodeRunId: `r-${taskId}`,
          stageNodeId: 'review',
          relatedNodeId: 'design',
          openedAt: (11 + 20 * index) * H,
          closedAt: (17 + 20 * index) * H,
          outcome: 'iterated',
          deciderUserId: 'bob',
        }),
      ),
    }
  }
  const hintsOf = async (count: number) =>
    (await queriesOf(reviewed(count)).queries.summary(admin, 'workflow', 'wf-1', WINDOW)).hints

  test('waiting, a slow gate and a stage that is sent back are found, most severe first, with the numbers the page shows', async () => {
    expect(await hintsOf(5)).toEqual([
      {
        id: 'wait-dominant',
        severity: 'high',
        target: 'gates',
        params: { share: 0.6, gate: 'review', gateShare: 0.6 },
      },
      {
        id: 'output-rejected',
        severity: 'high',
        target: 'stages',
        params: { stageKey: 'design', rate: 1, rounds: 5 },
      },
      {
        id: 'gate-slow',
        severity: 'mid',
        target: 'gates',
        params: { gate: 'review', p50: 6 * H, p90: 6 * H, rounds: 5 },
      },
    ])
  })

  test('four tasks are too few for any of them', async () => {
    expect(await hintsOf(4)).toEqual([])
  })
})

describe('RFC-616 comparison and filters', () => {
  test('against the previous period', async () => {
    const seed = scenario()
    // The baseline task ran from 1 h to 3 h, inside the period just before the compared one.
    seed.tasks![3] = {
      kind: 'workflow',
      row: taskUnit({ taskId: 't0', startedAt: H, finishedAt: 3 * H, autoMs: H }),
    }
    seed.nodeRuns = seed.nodeRuns!.map((run) =>
      run.nodeRunId === 'r0-design' ? { ...run, startedAt: H, finishedAt: 2 * H } : run,
    )
    const { queries } = queriesOf(seed)
    // The period before [5 h, 100 h) would start before time zero; it is cut there.
    const summary = await queries.summary(admin, 'workflow', 'wf-1', {
      from: 5 * H,
      to: 100 * H,
      tzOffset: 0,
      compare: 'period',
    })
    expect(summary.compare).toEqual({ mode: 'period', split: null, baselineUnits: 1 })
    expect(summary.metrics.units).toEqual({ value: 3, baseline: 1 })
    expect(summary.metrics.leadP50).toEqual({ value: 10 * H, baseline: 2 * H })
    expect(summary.metrics.tokensPerUnit).toEqual({ value: 1_305, baseline: 100 })
    expect(summary.metrics.firstPassRate).toEqual({ value: 0, baseline: 1 })
    const design = (summary as ProcessWorkflowSummary).stages.find(
      (stage) => stage.key === 'design',
    )!
    expect(design.baseline).toEqual({ durationP50: H, tokensPerUnit: 100 })
    // Regression: the revision picker lists the range's own tasks; the task of the earlier
    // period it is compared with is not one of them.
    expect(summary.revisions.reduce((units, entry) => units + entry.units, 0)).toBe(3)
  })

  test('under a revision split the follow-up generation numbers describe the current group only', async () => {
    // Regression: both groups are loaded together, and the follow-up calls of both were averaged.
    const mapRound = (taskId: string, at: number) =>
      gateRound({
        taskId,
        kind: 'clarify',
        stageNodeId: 'ask',
        relatedNodeId: 'a',
        gateNodeRunId: `ask-${taskId}`,
        openedAt: at,
        closedAt: at + H,
        outcome: 'continue',
        deciderUserId: 'alice',
        mindmap: true,
        measures: { questions: 2 },
      })
    const { queries } = queriesOf({
      usageSince: 0,
      tasks: [
        {
          kind: 'workflow',
          row: taskUnit({
            taskId: 'old',
            subjectRevision: 1,
            startedAt: 10 * H,
            finishedAt: 14 * H,
            autoMs: H,
          }),
        },
        {
          kind: 'workflow',
          row: taskUnit({
            taskId: 'new',
            subjectRevision: 2,
            startedAt: 20 * H,
            finishedAt: 24 * H,
            autoMs: H,
          }),
        },
      ],
      gateRounds: [mapRound('old', 11 * H), mapRound('new', 21 * H)],
      followups: [
        {
          taskId: 'old',
          startedAt: 11.2 * H,
          endedAt: 11.2 * H + 10 * M,
          tokens: 900,
          costNano: 0,
        },
        { taskId: 'new', startedAt: 21.2 * H, endedAt: 21.2 * H + 2 * M, tokens: 100, costNano: 0 },
      ],
    })
    const whole = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(whole.mindmap).toMatchObject({
      maps: 2,
      followupGenerationTokens: 500,
      followupGenerationMs: 6 * M,
    })
    const split = (await queries.summary(admin, 'workflow', 'wf-1', {
      ...WINDOW,
      compare: 'version',
      split: 2,
    })) as ProcessWorkflowSummary
    expect(split.counts.total).toBe(1)
    expect(split.mindmap).toMatchObject({
      maps: 1,
      followupGenerationTokens: 100,
      followupGenerationMs: 2 * M,
    })
  })

  test('split at a revision: at or above is current, below is the baseline', async () => {
    const { queries } = queriesOf()
    const summary = await queries.summary(admin, 'workflow', 'wf-1', {
      ...WINDOW,
      compare: 'version',
      split: 2,
    })
    expect(summary.compare).toEqual({ mode: 'version', split: 2, baselineUnits: 2 })
    expect(summary.counts.total).toBe(1)
    expect(summary.metrics.units).toEqual({ value: 1, baseline: 2 })
    expect(summary.metrics.tokensPerUnit).toEqual({ value: 2_410, baseline: 200 })
    // Both groups stay listed so the split can be moved.
    expect(summary.revisions).toEqual([
      { revision: 2, units: 1 },
      { revision: 1, units: 2 },
    ])
  })

  test('a workgroup cannot be split at a revision', async () => {
    const { queries } = queriesOf()
    expect(
      queries.summary(admin, 'workgroup', 'wg-1', { ...WINDOW, compare: 'version', split: 2 }),
    ).rejects.toThrow(ValidationError)
  })

  test('the origin filter narrows the statistics but not the origin counts', async () => {
    const { queries } = queriesOf()
    const summary = (await queries.summary(admin, 'workflow', 'wf-1', {
      ...WINDOW,
      origin: 'scheduled',
    })) as ProcessWorkflowSummary
    expect(summary.counts).toMatchObject({ total: 1, failed: 1 })
    expect(summary.origins).toEqual([
      { origin: 'manual', units: 2 },
      { origin: 'scheduled', units: 1 },
    ])
  })
})

describe('RFC-616 subject listing', () => {
  test('one row per workflow; a deleted workflow keeps its metrics without a name', async () => {
    const { queries } = queriesOf()
    const list = await queries.subjects(admin, { kind: 'workflow', from: 0, to: 1_000 * H })
    expect(list).toMatchObject({ kind: 'workflow', scope: 'all', partial: false })
    expect(list.items.map((item) => [item.subjectId, item.name, item.units])).toEqual([
      ['wf-1', 'Requirement to merge', 3],
      ['wf-2', null, 1],
    ])
    // The listing and the summary agree on the same numbers.
    expect(list.items[0]).toMatchObject({
      successRate: 1 / 2,
      leadP50: 10 * H,
      waitShare: 4 / 10,
      tokensPerUnit: 1_305,
      costNanoPerUnit: 13_050,
      firstPassRate: 0,
      interventionsPerUnit: 5 / 2,
    })
  })

  test('tasks without a source id form their own row', async () => {
    const { queries } = queriesOf({
      tasks: [
        { kind: 'workflow', row: taskUnit({ taskId: 'loose', subjectId: null, finishedAt: H }) },
      ],
    })
    const list = await queries.subjects(admin, { kind: 'workflow', from: 0, to: 10 * H })
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ subjectId: null, name: null, units: 1 })
    const summary = await queries.summary(admin, 'workflow', null, { ...WINDOW })
    expect(summary.counts.total).toBe(1)
  })
})

describe('RFC-616 units', () => {
  const many = () =>
    Array.from({ length: PROCESS_UNIT_PAGE_SIZE + 5 }, (_, index) => ({
      kind: 'workflow' as const,
      row: taskUnit({
        taskId: `t${String(index).padStart(2, '0')}`,
        status: index % 5 === 0 ? 'failed' : index % 7 === 0 ? 'running' : 'done',
        origin: index % 2 === 0 ? 'manual' : 'api',
        startedAt: index * H,
        finishedAt: index % 7 === 0 && index % 5 !== 0 ? null : index * H + H,
        autoMs: 30 * M,
      }),
    }))

  test('newest first, twenty-five a page, with a cursor', async () => {
    const { queries } = queriesOf({ tasks: many() })
    const first = await queries.units(admin, 'workflow', 'wf-1', { ...WINDOW, status: 'all' })
    expect(first.items).toHaveLength(PROCESS_UNIT_PAGE_SIZE)
    expect(first.items[0]!.unitId).toBe('t29')
    expect(first.nextCursor).not.toBeNull()
    const second = await queries.units(admin, 'workflow', 'wf-1', {
      ...WINDOW,
      status: 'all',
      cursor: first.nextCursor!,
    })
    expect(second.items.map((item) => item.unitId)).toEqual(['t04', 't03', 't02', 't01', 't00'])
    expect(second.nextCursor).toBeNull()
    expect(
      queries.units(admin, 'workflow', 'wf-1', { ...WINDOW, status: 'all', cursor: 'garbage' }),
    ).rejects.toThrow(ValidationError)
  })

  test('filters by outcome and by origin', async () => {
    const { queries } = queriesOf({ tasks: many() })
    const of = async (status: 'succeeded' | 'unsuccessful' | 'active', origin?: 'manual' | 'api') =>
      (
        await queries.units(admin, 'workflow', 'wf-1', {
          ...WINDOW,
          status,
          ...(origin === undefined ? {} : { origin }),
        })
      ).items
    expect((await of('unsuccessful')).map((item) => item.unitId)).toEqual([
      't25',
      't20',
      't15',
      't10',
      't05',
      't00',
    ])
    expect((await of('active')).map((item) => item.unitId)).toEqual(['t28', 't21', 't14', 't07'])
    expect((await of('succeeded')).every((item) => item.status === 'succeeded')).toBe(true)
    expect((await of('unsuccessful', 'api')).map((item) => item.unitId)).toEqual([
      't25',
      't15',
      't05',
    ])
  })

  test('a row carries the unit time split, tokens and gate rounds', async () => {
    const { queries } = queriesOf()
    const page = await queries.units(admin, 'workflow', 'wf-1', { ...WINDOW, status: 'all' })
    const row = page.items.find((item) => item.unitId === 't1')!
    expect(row).toMatchObject({
      taskId: 't1',
      status: 'succeeded',
      outcome: 'done',
      origin: 'manual',
      ownerUserId: 'alice',
      revision: 2,
      leadMs: 10 * H,
      autoMs: 3 * H,
      waits: [
        { kind: 'review', ms: 3 * H },
        { kind: 'clarify', ms: H },
      ],
      otherMs: 3 * H,
      tokens: 2_410,
      gateRounds: [
        { kind: 'review', rounds: 2 },
        { kind: 'clarify', rounds: 1 },
      ],
      autoRetries: 1,
      manualRetries: 1,
      firstPass: false,
    })
    // A running unit's lead time runs to now and it is not judged yet.
    expect(page.items.find((item) => item.unitId === 't3')).toMatchObject({
      status: 'active',
      leadMs: NOW - 40 * H,
      firstPass: null,
    })
    expect(page.identities.map((identity) => identity.id).sort()).toEqual(['alice', 'dave'])
  })

  test('unit detail lists the stages the unit touched', async () => {
    const { queries } = queriesOf()
    const detail = (await queries.unit(admin, 'workflow', 't1'))!
    expect(detail.unit.unitId).toBe('t1')
    const stage = (key: string) => detail.stages.find((item) => item.key === key)!
    expect(detail.stages.map((item) => item.key)).toEqual([
      'design',
      'review',
      'loop',
      'code',
      'call',
      'system:commit-push',
      'system:other',
    ])
    expect(stage('design')).toMatchObject({
      runs: 3,
      failedRuns: 0,
      durationMs: 90 * M,
      tokens: 1_550,
    })
    expect(stage('code')).toMatchObject({ runs: 2, failedRuns: 1, autoRetries: 1, tokens: 400 })
    expect(stage('loop')).toMatchObject({ runs: 0, durationMs: 1.5 * H })
    expect(stage('review')).toMatchObject({ gateRounds: 2, gateWaitMs: 3 * H, comments: 4 })
    expect(stage('call')).toMatchObject({
      runs: 1,
      tokens: 410,
      gateRounds: 1,
      gateWaitMs: H,
      questions: 3,
    })
    expect(detail.stages.reduce((sum, item) => sum + item.tokens, 0)).toBe(detail.unit.tokens)
  })

  test('two rounds open at once at one stage are waited for once', async () => {
    // Regression: the unit detail summed the spans, so two parallel askers through one
    // mediator node made the task wait twice as long as it lasted.
    const round = (askingShardKey: string, openedAt: number, closedAt: number) =>
      gateRound({
        taskId: 'w1',
        kind: 'clarify',
        stageNodeId: 'ask',
        relatedNodeId: 'code',
        askingShardKey,
        gateNodeRunId: `ask-${askingShardKey}`,
        instanceKey: `code|${askingShardKey}`,
        openedAt,
        closedAt,
        outcome: 'continue',
        deciderUserId: 'alice',
      })
    const { queries } = queriesOf({
      usageSince: 0,
      tasks: [
        {
          kind: 'workflow',
          row: taskUnit({ taskId: 'w1', startedAt: 10 * H, finishedAt: 20 * H, autoMs: 2 * H }),
        },
      ],
      // 11 h → 13 h and 12 h → 15 h: four hours of waiting, not five.
      gateRounds: [round('a', 11 * H, 13 * H), round('b', 12 * H, 15 * H)],
    })
    const detail = (await queries.unit(admin, 'workflow', 'w1'))!
    expect(detail.stages.find((stage) => stage.key === 'ask')).toMatchObject({
      gateRounds: 2,
      gateWaitMs: 4 * H,
    })
    // The same four hours the unit row and the stage summary report.
    expect(detail.unit.waits).toEqual([{ kind: 'clarify', ms: 4 * H }])
    const summary = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(stageOf(summary, 'ask')).toMatchObject({
      gateRoundsPerUnit: 2,
      gateWaitMsPerUnit: 4 * H,
    })
  })

  test('a stage that ran and never asked, or was never reworked, reports zero — not "unknown"', async () => {
    const { queries } = queriesOf()
    const summary = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    // `code` ran in the scenario's tasks, asked nobody, and spent tokens none of which was rework.
    expect(stageOf(summary, 'code')).toMatchObject({ clarifyRate: 0, reworkTokenShare: 0 })
    // A wrapper has no runs and no tokens of its own: there is nothing to take a share of.
    expect(stageOf(summary, 'loop')).toMatchObject({ clarifyRate: null, reworkTokenShare: null })
  })

  test('a unit of another kind, or one the viewer cannot see, is not found', async () => {
    const { queries } = queriesOf()
    expect(await queries.unit(admin, 'workgroup', 't1')).toBeNull()
    expect(await queries.unit(admin, 'workflow', 'g1')).toBeNull()
    expect(await queries.unit(admin, 'workflow', 'missing')).toBeNull()
    expect(await queries.unit(alice, 'workflow', 't2')).toBeNull()
    expect(await queries.unit(alice, 'workflow', 't1')).not.toBeNull()
  })
})

// design §4.1: a rerun can act on a wrapper as a whole. The reason is then on the wrapper's own row, and the
// rows inside the new invocation are minted as first executions again.
describe('RFC-616 reruns that act on a wrapper', () => {
  const loopDefinition = {
    $schema_version: 7,
    inputs: [],
    edges: [],
    nodes: [
      { id: 'loop', kind: 'wrapper-loop', nodeIds: ['code'], maxIterations: 5 },
      { id: 'code', kind: 'agent-single', title: 'Code' },
      { id: 'review', kind: 'review', title: 'Loop review' },
    ],
  } as unknown as WorkflowDefinition
  /** One succeeded task whose loop ran once (100 tokens) before whatever `extra` adds. */
  const looped = (extra: Partial<FakeProcessData>): Partial<FakeProcessData> => ({
    usageSince: 0,
    definitions: new Map([['w1', loopDefinition]]),
    tasks: [
      {
        kind: 'workflow',
        row: taskUnit({ taskId: 'w1', startedAt: 10 * H, finishedAt: 20 * H, autoMs: 2 * H }),
      },
    ],
    ...extra,
    wrappers: [
      wrapperRun({
        taskId: 'w1',
        runId: 'loop-1',
        nodeId: 'loop',
        seq: 1,
        startedAt: 10 * H,
        finishedAt: 11 * H,
      }),
      ...(extra.wrappers ?? []),
    ],
    nodeRuns: [
      nodeRun({
        taskId: 'w1',
        nodeRunId: 'code-1',
        nodeId: 'code',
        containerRunId: 'loop-1',
        startedAt: 10 * H,
        finishedAt: 11 * H,
      }),
      ...(extra.nodeRuns ?? []),
    ],
    usage: [usageRow({ taskId: 'w1', nodeRunId: 'code-1', tokens: 100 }), ...(extra.usage ?? [])],
  })
  const secondInvocation = (rerunCause: string) => ({
    wrappers: [
      wrapperRun({
        taskId: 'w1',
        runId: 'loop-2',
        nodeId: 'loop',
        rerunCause,
        seq: 5,
        startedAt: 13 * H,
        finishedAt: 14 * H,
      }),
    ],
    // Inside the new invocation the node has no earlier row: it is minted as a first execution again.
    nodeRuns: [
      nodeRun({
        taskId: 'w1',
        nodeRunId: 'code-2',
        nodeId: 'code',
        containerRunId: 'loop-2',
        startedAt: 13 * H,
        finishedAt: 14 * H,
      }),
    ],
    usage: [usageRow({ taskId: 'w1', nodeRunId: 'code-2', tokens: 60 })],
  })
  const tokensByCause = (summary: Awaited<ReturnType<typeof summaryOf>>) =>
    Object.fromEntries(
      summary.causes
        .filter((slice) => slice.tokens > 0)
        .map((slice) => [slice.cause, slice.tokens]),
    )
  const summaryOf = async (seed: Partial<FakeProcessData>) =>
    (await queriesOf(seed).queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
  const listRowOf = async (seed: Partial<FakeProcessData>) =>
    (await queriesOf(seed).queries.subjects(admin, { kind: 'workflow', from: 0, to: 1_000 * H }))
      .items[0]!

  test('a review that sends back what a loop exposes makes the whole new invocation review rework', async () => {
    const seed = looped({
      ...secondInvocation('review-iterate'),
      gateRounds: [
        gateRound({
          taskId: 'w1',
          gateNodeRunId: 'rr',
          stageNodeId: 'review',
          relatedNodeId: 'loop',
          openedAt: 11 * H,
          closedAt: 13 * H,
          outcome: 'iterated',
          deciderUserId: 'bob',
        }),
        gateRound({
          taskId: 'w1',
          gateNodeRunId: 'rr',
          stageNodeId: 'review',
          relatedNodeId: 'loop',
          ordinal: 2,
          openedAt: 14 * H,
          closedAt: 15 * H,
          deciderUserId: 'bob',
        }),
      ],
    })
    const summary = await summaryOf(seed)
    expect(tokensByCause(summary)).toEqual({ first: 100, 'review-rework': 60 })
    expect(summary.metrics.firstPassRate).toEqual({ value: 0, baseline: null })
    expect(stageOf(summary, 'code')).toMatchObject({ runsPerUnit: 2, reworkTokenShare: 60 / 160 })
    // Two invocations of one round each: the loop is not "re-run nobody asked for".
    expect(stageOf(summary, 'loop')).toMatchObject({ loop: { roundsMean: 1, roundsMax: 1 } })
    // The listing, which reads grouped executions instead of single runs, says the same.
    expect((await listRowOf(seed)).firstPassRate).toBe(0)
  })

  test('a manual retry of a wrapper is one retry; its placeholder is neither an invocation nor a failure', async () => {
    const seed = looped({
      wrappers: [
        // The placeholder sits on the wrapper's own slot: failed, never started.
        wrapperRun({
          taskId: 'w1',
          runId: 'loop-placeholder',
          nodeId: 'loop',
          rerunCause: 'retry-node',
          seq: 4,
          status: 'failed',
          startedAt: null,
          finishedAt: 12 * H,
          rounds: 0,
        }),
        ...secondInvocation('revival').wrappers,
      ],
      nodeRuns: secondInvocation('revival').nodeRuns,
      usage: secondInvocation('revival').usage,
    })
    const summary = await summaryOf(seed)
    expect(summary.stability).toMatchObject({ manualRetries: 1, recoveries: 1 })
    expect(summary.interventions.manualRetriesPerUnit).toBe(1)
    expect(tokensByCause(summary)).toEqual({ first: 100, 'other-rerun': 60 })
    // Two real invocations of one round each; a placeholder with no rounds would drag the mean to 2/3.
    expect(stageOf(summary, 'loop')).toMatchObject({ loop: { roundsMean: 1, roundsMax: 1 } })
    expect(summary.metrics.firstPassRate).toEqual({ value: 0, baseline: null })
    expect(await listRowOf(seed)).toMatchObject({ firstPassRate: 0, interventionsPerUnit: 1 })
  })

  test('a retry that revives a canceled wrapper leaves no placeholder: the recorded operation is the retry', async () => {
    const retried = (operations: number) =>
      looped({
        ...secondInvocation('revival'),
        operations: Array.from({ length: operations }, (_, index) => ({
          action: 'task.retry-node' as const,
          subjectKind: 'task' as const,
          subjectId: 'w1',
          actorUserId: 'alice',
          firstAt: 12 * H + index,
          lastAt: 12 * H + index,
        })),
      })
    expect((await summaryOf(retried(0))).stability.manualRetries).toBe(0)
    const summary = await summaryOf(retried(2))
    expect(summary.stability.manualRetries).toBe(2)
    expect(summary.metrics.firstPassRate).toEqual({ value: 0, baseline: null })
    // A retry that left both a placeholder and a recorded operation is still one retry.
    const both = retried(1)
    both.nodeRuns = [
      ...both.nodeRuns!,
      nodeRun({
        taskId: 'w1',
        nodeRunId: 'code-placeholder',
        nodeId: 'code',
        containerRunId: 'loop-1',
        rerunCause: 'retry-node',
        status: 'failed',
        startedAt: null,
        finishedAt: 12 * H,
      }),
    ]
    expect((await summaryOf(both)).stability.manualRetries).toBe(1)
  })

  test('a loop that ran out of rounds breaks first pass although no node failed', async () => {
    const seed = looped({ ...secondInvocation('revival') })
    seed.wrappers![0] = { ...seed.wrappers![0]!, status: 'exhausted' }
    const summary = await summaryOf(seed)
    expect(summary.stability.failureCodes).toEqual([])
    expect(summary.metrics.firstPassRate).toEqual({ value: 0, baseline: null })
    expect((await listRowOf(seed)).firstPassRate).toBe(0)
    // Without the exhausted invocation the same task is a first pass: a recovery alone does not break it.
    const clean = looped({ ...secondInvocation('revival') })
    expect((await summaryOf(clean)).metrics.firstPassRate).toEqual({ value: 1, baseline: null })
  })
})

// design §12: what the numbers do when a fact is missing or a source is down.
describe('RFC-616 degradations', () => {
  const single = (extra: Partial<FakeProcessData>): Partial<FakeProcessData> => ({
    usageSince: 0,
    tasks: [
      {
        kind: 'workflow',
        row: taskUnit({ taskId: 'u1', startedAt: 10 * H, finishedAt: 12 * H, autoMs: H }),
      },
    ],
    nodeRuns: [
      nodeRun({
        taskId: 'u1',
        nodeRunId: 'r-a',
        nodeId: 'a',
        startedAt: 10 * H,
        finishedAt: 10.5 * H,
      }),
    ],
    ...extra,
  })

  test('usage whose node run is gone stays in the total, on the unattributed stage', async () => {
    const { queries } = queriesOf(
      single({
        usage: [
          usageRow({ taskId: 'u1', nodeRunId: 'r-a', tokens: 100 }),
          usageRow({ taskId: 'u1', nodeRunId: 'gone', tokens: 40 }),
        ],
      }),
    )
    const summary = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(summary.metrics.tokensPerUnit!.value).toBe(140)
    expect(stageOf(summary, 'a')).toMatchObject({ tokensPerUnit: 100, tokenShare: 100 / 140 })
    expect(stageOf(summary, 'unattributed')).toMatchObject({
      kind: 'unattributed',
      tokensPerUnit: 40,
      tokenShare: 40 / 140,
    })
    // Nothing says it was a rerun, so it is a first execution.
    expect(summary.causes.find((slice) => slice.cause === 'first')!.tokens).toBe(140)
  })

  test('follow-up generation is placed call by call: on the round it fell into, else on other platform work', async () => {
    const { queries } = queriesOf(
      single({
        definitions: new Map([
          [
            'u1',
            {
              $schema_version: 7,
              inputs: [],
              edges: [],
              nodes: [
                { id: 'a', kind: 'agent-single', title: 'A' },
                { id: 'ask', kind: 'clarify', title: 'Ask' },
              ],
            } as unknown as WorkflowDefinition,
          ],
        ]),
        gateRounds: [
          gateRound({
            taskId: 'u1',
            kind: 'clarify',
            stageNodeId: 'ask',
            relatedNodeId: 'a',
            gateNodeRunId: 'ask-run',
            openedAt: 10.5 * H,
            closedAt: 11.5 * H,
            outcome: 'continue',
            deciderUserId: 'alice',
            mindmap: true,
            measures: { questions: 2 },
          }),
        ],
        usage: [
          usageRow({ taskId: 'u1', nodeRunId: 'r-a', tokens: 100 }),
          // The call store reports both follow-up calls as one system row without a node run.
          usageRow({ taskId: 'u1', purpose: 'system', systemKind: 'clarify-followup', tokens: 60 }),
        ],
        followups: [
          { taskId: 'u1', startedAt: 11 * H, endedAt: 11 * H + M, tokens: 45, costNano: 450 },
          { taskId: 'u1', startedAt: 11.8 * H, endedAt: 11.8 * H + M, tokens: 15, costNano: 150 },
        ],
      }),
    )
    const summary = (await queries.summary(
      admin,
      'workflow',
      'wf-1',
      WINDOW,
    )) as ProcessWorkflowSummary
    expect(summary.metrics.tokensPerUnit!.value).toBe(160)
    // 11:00 is inside the round that was open from 10:30 to 11:30; 11:48 is inside none.
    expect(stageOf(summary, 'ask')).toMatchObject({ kind: 'clarify', tokensPerUnit: 45 })
    expect(stageOf(summary, 'system:other')).toMatchObject({ kind: 'system', tokensPerUnit: 15 })
    expect(summary.causes.map((slice) => [slice.cause, slice.tokens])).toEqual([
      ['first', 100],
      ['review-rework', 0],
      ['clarify-rerun', 0],
      ['auto-retry', 0],
      ['other-rerun', 0],
      ['system', 60],
    ])
  })

  test('a fact source that fails fails the request; a missing fact is never answered as zero', async () => {
    const fake = fakeProcessSources(scenario())
    const queries = createProcessQueries({
      sources: {
        ...fake.sources,
        gates: {
          ...fake.sources.gates,
          rounds: async () => {
            throw new Error('gate ledger unavailable')
          },
        },
      },
      clock: () => NOW,
    })
    await expect(queries.summary(admin, 'workflow', 'wf-1', WINDOW)).rejects.toThrow(
      'gate ledger unavailable',
    )
    await expect(
      queries.subjects(admin, { kind: 'workflow', from: 0, to: 1_000 * H }),
    ).rejects.toThrow('gate ledger unavailable')
    await expect(
      queries.units(admin, 'workflow', 'wf-1', { ...WINDOW, status: 'all' }),
    ).rejects.toThrow('gate ledger unavailable')
    await expect(queries.unit(admin, 'workflow', 't1')).rejects.toThrow('gate ledger unavailable')
  })
})
