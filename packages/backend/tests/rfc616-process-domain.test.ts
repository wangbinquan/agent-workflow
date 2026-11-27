// RFC-616 §7 — the process metrics engine (pure functions).
//
// Locks the rules every number on the process metrics pages is computed by:
// the time split (the three parts always add up to the lead time), the cause of
// an execution (manual-retry placeholders are not executions, runs inside a
// re-executed wrapper are reruns), first-pass, the human gate statistics (void
// rounds only count as waiting time), the per-stage aggregation and the token
// split that must add up to the headline number.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROCESS_SYSTEM_WORK_KINDS, type WorkflowDefinition } from '@agent-workflow/shared'
import {
  classifyExecutions,
  classifyFailureCodes,
  executionInputOfRun,
  judgeCause,
  judgeWrapperInvocations,
  NO_WRAPPERS,
} from '@/modules/run-observability/domain/process/causes'
import { comparedMetrics, previousWindow } from '@/modules/run-observability/domain/process/compare'
import {
  clarifySummaryOf,
  decisionGateOf,
  firstOpenOf,
  mindmapSummaryOf,
  reviewSummaryOf,
} from '@/modules/run-observability/domain/process/gateSummary'
import {
  NO_USAGE,
  usageRecorded,
  type ProcessExecution,
  type ProcessGateRound,
  type ProcessOperation,
  type ProcessUnit,
  type ProcessUnitFacts,
} from '@/modules/run-observability/domain/process/model'
import {
  completeStages,
  systemStageOf,
  workflowStageCatalog,
} from '@/modules/run-observability/domain/process/stages'
import { stageRowsOf } from '@/modules/run-observability/domain/process/stageSummary'
import { apportion, ratio, statOf } from '@/modules/run-observability/domain/process/stats'
import { splitUnitTime, unionLength } from '@/modules/run-observability/domain/process/timeline'
import {
  causeSlicesOf,
  commonMetrics,
  interventionsOf,
  stabilityOf,
  systemWorkOf,
  timeSplitOf,
  trendOf,
  unitCounts,
  unitNumbers,
  unitRowOf,
  NO_ROW_EXTRAS,
} from '@/modules/run-observability/domain/process/unitSummary'

const M = 60_000
const H = 60 * M
const NOW = 100 * H

function unit(over: Partial<ProcessUnit> = {}): ProcessUnit {
  return {
    id: 'u1',
    taskId: 'u1',
    subjectId: 'wf',
    subjectRevision: 1,
    name: 'unit',
    status: 'succeeded',
    outcome: 'done',
    origin: 'manual',
    ownerUserId: 'owner',
    startedAt: 0,
    endedAt: 10 * H,
    autoMs: 2 * H,
    limitCanceled: false,
    ...over,
  }
}

function facts(over: Partial<ProcessUnitFacts> = {}): ProcessUnitFacts {
  return {
    unit: unit(),
    executions: [],
    failureCodes: [],
    gates: [],
    usage: [],
    usageTotals: NO_USAGE,
    hasUsageRecord: true,
    operations: [],
    manualRetries: 0,
    failedWrappers: 0,
    runsWithoutCause: 0,
    wrappers: [],
    ...over,
  }
}

function gate(over: Partial<ProcessGateRound> = {}): ProcessGateRound {
  return {
    stageKey: 'review',
    relatedStageKey: 'design',
    kind: 'review',
    subject: { kind: 'node-run', id: 'run-review' },
    instanceKey: 'run-review',
    ordinal: 1,
    void: false,
    openedAt: 0,
    closedAt: H,
    outcome: 'approved',
    deciderUserId: 'alice',
    mindmap: false,
    measures: {},
    people: [],
    ...over,
  }
}

function exec(over: Partial<ProcessExecution> = {}): ProcessExecution {
  return {
    stageKey: 'design',
    cause: 'first',
    round: null,
    runs: 1,
    endedRuns: 1,
    failedRuns: 0,
    interruptedRuns: 0,
    activeMs: 10 * M,
    ...over,
  }
}

const usage = (tokens: number, costNano = 0) => ({
  calls: 1,
  tokens,
  costNano,
  incompleteCalls: 0,
  unpricedCalls: 0,
})

const numbers = (list: readonly ProcessUnitFacts[]) => list.map((item) => unitNumbers(item, NOW))

describe('RFC-616 statistics', () => {
  test('no sample is null, never zero', () => {
    expect(statOf([])).toEqual({ n: 0, p50: null, p90: null, mean: null })
    expect(ratio(1, 0)).toBeNull()
    expect(ratio(0, 4)).toBe(0)
    expect(ratio(1, 4)).toBe(0.25)
  })

  test('median and P90 use the nearest rank', () => {
    expect(statOf([5])).toEqual({ n: 1, p50: 5, p90: 5, mean: 5 })
    expect(statOf([4, 1, 3, 2])).toEqual({ n: 4, p50: 2, p90: 4, mean: 3 })
    expect(statOf([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]).p90).toBe(90)
  })

  test('apportion keeps the total exact', () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3])
    expect(apportion(100, [3, 3, 3, 1])).toEqual([30, 30, 30, 10])
    expect(apportion(0, [1, 2])).toEqual([0, 0])
    expect(apportion(7, [0, 0])).toEqual([0, 0])
    const parts = apportion(1_000_003, [17, 5, 3, 0, 91])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_000_003)
    expect(parts[3]).toBe(0)
  })
})

describe('RFC-616 time split', () => {
  test('union counts overlaps once and ignores empty spans', () => {
    expect(
      unionLength([
        { from: 0, to: 10 },
        { from: 5, to: 15 },
        { from: 20, to: 30 },
        { from: 40, to: 40 },
      ]),
    ).toBe(25)
    expect(unionLength([])).toBe(0)
  })

  test('without gates everything that is not running is "other"', () => {
    expect(splitUnitTime(unit(), [], NOW)).toEqual({
      leadMs: 10 * H,
      autoMs: 2 * H,
      waits: [],
      waitMs: 0,
      otherMs: 8 * H,
    })
  })

  test('one gate', () => {
    const time = splitUnitTime(unit(), [gate({ openedAt: 3 * H, closedAt: 6 * H })], NOW)
    expect(time.waits).toEqual([{ kind: 'review', ms: 3 * H }])
    expect(time.otherMs).toBe(5 * H)
  })

  test('gates of two kinds that overlap are scaled to the union', () => {
    const time = splitUnitTime(
      unit(),
      [
        gate({ kind: 'review', openedAt: H, closedAt: 4 * H }),
        gate({ kind: 'clarify', openedAt: 3 * H, closedAt: 5 * H }),
      ],
      NOW,
    )
    expect(time.waitMs).toBe(4 * H)
    // Three and two hours of gates cover four hours together: 4 h split 3 : 2.
    expect(time.waits).toEqual([
      { kind: 'review', ms: 8_640_000 },
      { kind: 'clarify', ms: 5_760_000 },
    ])
    expect(time.otherMs).toBe(4 * H)
  })

  test('waiting that overlaps running is counted as running', () => {
    const time = splitUnitTime(
      unit({ autoMs: 9 * H }),
      [gate({ openedAt: 0, closedAt: 5 * H })],
      NOW,
    )
    expect(time).toMatchObject({ autoMs: 9 * H, waitMs: H, otherMs: 0 })
  })

  test('a gate is clipped to the life of the unit', () => {
    const time = splitUnitTime(unit(), [gate({ openedAt: -H, closedAt: 12 * H })], NOW)
    expect(time).toMatchObject({ waitMs: 8 * H, otherMs: 0 })
  })

  test('an open gate waits until the unit ended, or until now', () => {
    expect(splitUnitTime(unit(), [gate({ openedAt: 7 * H, closedAt: null })], NOW).waitMs).toBe(
      3 * H,
    )
    const active = splitUnitTime(
      unit({ status: 'active', endedAt: null, autoMs: H }),
      [gate({ openedAt: 2 * H, closedAt: null })],
      4 * H,
    )
    expect(active).toMatchObject({ leadMs: 4 * H, waitMs: 2 * H, otherMs: H })
  })

  test('a void round still counts as waiting', () => {
    const time = splitUnitTime(
      unit(),
      [gate({ void: true, ordinal: 0, openedAt: H, closedAt: 2 * H })],
      NOW,
    )
    expect(time.waitMs).toBe(H)
  })

  test('without a running-time record auto and other are unknown', () => {
    const time = splitUnitTime(
      unit({ autoMs: null }),
      [gate({ openedAt: 0, closedAt: 4 * H })],
      NOW,
    )
    expect(time).toMatchObject({ autoMs: null, otherMs: null, waitMs: 4 * H })
  })

  test('the three parts always add up to the lead time', () => {
    const cases: [number, [number, number | null][]][] = [
      [0, []],
      [10 * H, [[0, 10 * H]]],
      [3 * H + 7, [[H, 2 * H + 11]]],
      [
        5 * H,
        [
          [0, H],
          [2 * H, null],
          [H + 13, 3 * H + 1],
        ],
      ],
      [99 * H, [[9 * H, 9.5 * H]]],
    ]
    for (const [autoMs, spans] of cases) {
      const time = splitUnitTime(
        unit({ autoMs }),
        spans.map(([openedAt, closedAt], index) =>
          gate({ kind: index % 2 === 0 ? 'review' : 'clarify', openedAt, closedAt }),
        ),
        NOW,
      )
      const waits = time.waits.reduce((sum, wait) => sum + wait.ms, 0)
      expect(waits).toBe(time.waitMs)
      expect(time.autoMs! + waits + time.otherMs!).toBe(time.leadMs)
      expect(time.otherMs!).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('RFC-616 execution causes', () => {
  const wrapper = (
    runId: string,
    nodeId: string,
    containerRunId: string | null,
    iteration: number,
    seq: number,
    rerunCause: string | null = 'wrapper-init',
  ) => ({ runId, nodeId, containerRunId, iteration, seq, rerunCause })
  const wrappers = [
    wrapper('A1', 'loop', null, 0, 1),
    wrapper('B1', 'inner', 'A1', 0, 2),
    wrapper('B2', 'inner', 'A1', 1, 3),
    wrapper('A2', 'loop', null, 0, 5),
    wrapper('C1', 'inner', 'A2', 0, 6),
  ]
  const innerCauses = (rows: Parameters<typeof judgeWrapperInvocations>[0]) =>
    Object.fromEntries(judgeWrapperInvocations(rows).innerCause)

  test('a wrapper re-executed in the same frame, and everything nested in it, is a rerun', () => {
    // B1 and B2 sit in different outer iterations: each is the first of its own frame.
    expect(innerCauses(wrappers)).toEqual({
      A1: 'first',
      B1: 'first',
      B2: 'first',
      A2: 'cascade',
      C1: 'cascade',
    })
    expect(judgeWrapperInvocations([])).toEqual({ innerCause: new Map(), manualRetries: 0 })
  })

  test('a wrapper re-invoked for a stated reason hands that reason to what runs inside it', () => {
    // A review sent back what the loop exposes; a person retried the fan-out; a restart revived the git wrapper.
    expect(
      innerCauses([
        wrapper('L1', 'loop', null, 0, 1),
        wrapper('L2', 'loop', null, 0, 4, 'review-iterate'),
        wrapper('N1', 'inner', 'L2', 0, 5),
        wrapper('F1', 'fan', null, 0, 6),
        wrapper('F2', 'fan', null, 0, 9, 'revival'),
        wrapper('G1', 'git', null, 0, 10),
        wrapper('G2', 'git', null, 0, 11, 'clarify-answer'),
        wrapper('H2', 'other', null, 0, 12, 'process-retry'),
      ]),
    ).toEqual({
      L1: 'first',
      L2: 'review-rework',
      // The first invocation of a wrapper nested in a re-invoked one is part of the same rework.
      N1: 'review-rework',
      F1: 'first',
      F2: 'recovery',
      G1: 'first',
      G2: 'clarify-rerun',
      // A stated reason holds even for the only invocation of its frame.
      H2: 'auto-retry',
    })
  })

  test('a placeholder on a wrapper slot is one manual retry and not an invocation', () => {
    const judged = judgeWrapperInvocations([
      wrapper('L1', 'loop', null, 0, 1),
      wrapper('P', 'loop', null, 0, 2, 'retry-node'),
      wrapper('Q', 'loop', null, 0, 3, 'retry-node-cascade'),
      wrapper('L2', 'loop', null, 0, 4, 'revival'),
    ])
    expect(Object.fromEntries(judged.innerCause)).toEqual({ L1: 'first', L2: 'recovery' })
    // Only the row of the node the person picked is a retry; a cascaded placeholder is not.
    expect(judged.manualRetries).toBe(1)
    // The retry counts with those aimed at ordinary nodes.
    expect(
      classifyExecutions(
        [
          {
            stageKey: 'design',
            rerunCause: 'retry-node',
            containerRunId: null,
            round: null,
            runs: 1,
            endedRuns: 0,
            failedRuns: 1,
            interruptedRuns: 0,
            activeMs: 0,
          },
        ],
        judged,
      ),
    ).toEqual({ executions: [], manualRetries: 2, runsWithoutCause: 0 })
  })

  test('a manual-retry placeholder is not an execution but is one manual retry', () => {
    const judged = judgeWrapperInvocations(wrappers)
    expect(
      judgeCause({ rerunCause: 'retry-node', stageKey: 'design', containerRunId: null }, judged),
    ).toEqual({ cause: null, manualRetry: true, withoutCause: false })
    expect(
      judgeCause({ rerunCause: 'retry-node-cascade', stageKey: 'x', containerRunId: null }, judged),
    ).toEqual({ cause: null, manualRetry: false, withoutCause: false })
  })

  test("repository preparation's retry row is the re-execution itself", () => {
    expect(
      judgeCause(
        { rerunCause: 'retry-node', stageKey: 'system:repo-prep', containerRunId: null },
        NO_WRAPPERS,
      ),
    ).toEqual({ cause: 'recovery', manualRetry: true, withoutCause: false })
  })

  test('first executions inside a re-executed wrapper take its cause', () => {
    const judged = judgeWrapperInvocations([
      ...wrappers,
      wrapper('R2', 'reviewed', null, 0, 8, 'review-reject'),
    ])
    const judge = (rerunCause: string | null, containerRunId: string | null) =>
      judgeCause({ rerunCause, stageKey: 'code', containerRunId }, judged).cause
    expect(judge('initial', 'A1')).toBe('first')
    expect(judge('initial', 'B2')).toBe('first')
    expect(judge('initial', 'A2')).toBe('cascade')
    expect(judge('fanout-shard', 'C1')).toBe('cascade')
    expect(judge('initial', 'R2')).toBe('review-rework')
    // A row inside an invocation nobody knows about is judged on its own cause.
    expect(judge('initial', 'unknown')).toBe('first')
    // Only first executions are re-judged.
    expect(judge('revival', 'A2')).toBe('recovery')
    expect(judge('review-iterate', 'A2')).toBe('review-rework')
    expect(judge('process-retry', 'R2')).toBe('auto-retry')
  })

  test('a row without a cause is a first execution and is tallied', () => {
    expect(
      judgeCause({ rerunCause: null, stageKey: 'code', containerRunId: null }, NO_WRAPPERS),
    ).toEqual({ cause: 'first', manualRetry: false, withoutCause: true })
  })

  test('classifyExecutions merges by stage, cause and round and never counts a placeholder', () => {
    const row = (over: Partial<Parameters<typeof classifyExecutions>[0][number]>) => ({
      stageKey: 'design',
      rerunCause: 'initial',
      containerRunId: null,
      round: null,
      runs: 1,
      endedRuns: 1,
      failedRuns: 0,
      interruptedRuns: 0,
      activeMs: 100,
      ...over,
    })
    const result = classifyExecutions(
      [
        row({}),
        row({ activeMs: 50 }),
        row({ rerunCause: 'retry-node', failedRuns: 1, endedRuns: 0, activeMs: 0 }),
        row({ rerunCause: 'retry-node-cascade', stageKey: 'code', failedRuns: 1 }),
        row({ rerunCause: 'revival', failedRuns: 1 }),
        row({ rerunCause: null, stageKey: 'code', runs: 2 }),
        row({ rerunCause: 'wg-leader-round', stageKey: 'leader', round: 1 }),
        row({ rerunCause: 'wg-leader-round', stageKey: 'leader', round: 2 }),
      ],
      NO_WRAPPERS,
    )
    expect(result.manualRetries).toBe(1)
    expect(result.runsWithoutCause).toBe(2)
    const find = (stageKey: string, cause: string, round: number | null = null) =>
      result.executions.find(
        (item) => item.stageKey === stageKey && item.cause === cause && item.round === round,
      )
    expect(find('design', 'first')).toMatchObject({ runs: 2, activeMs: 150, failedRuns: 0 })
    expect(find('design', 'recovery')).toMatchObject({ runs: 1, failedRuns: 1 })
    expect(find('leader', 'first', 1)).toMatchObject({ runs: 1 })
    expect(find('leader', 'first', 2)).toMatchObject({ runs: 1 })
    // The two placeholder rows left no execution and no failure behind.
    expect(result.executions.reduce((sum, item) => sum + item.failedRuns, 0)).toBe(1)
    expect(result.executions.reduce((sum, item) => sum + item.runs, 0)).toBe(7)
  })

  test('a node run becomes an execution input', () => {
    const run = {
      stageKey: 'code',
      rerunCause: 'initial',
      containerRunId: null,
      round: null,
      status: 'failed',
      startedAt: 1_000,
      finishedAt: 4_000,
    }
    expect(executionInputOfRun(run)).toMatchObject({
      runs: 1,
      endedRuns: 1,
      failedRuns: 1,
      interruptedRuns: 0,
      activeMs: 3_000,
    })
    expect(executionInputOfRun({ ...run, status: 'interrupted', finishedAt: null })).toMatchObject({
      endedRuns: 0,
      failedRuns: 0,
      interruptedRuns: 1,
      activeMs: 0,
    })
  })

  test('failure codes are merged by stage and skip placeholder rows', () => {
    expect(
      classifyFailureCodes([
        { stageKey: 'code', rerunCause: 'initial', code: 'envelope-missing', runs: 2 },
        { stageKey: 'code', rerunCause: 'process-retry', code: 'envelope-missing', runs: 1 },
        { stageKey: 'code', rerunCause: 'retry-node', code: 'queued', runs: 4 },
        { stageKey: 'audit', rerunCause: null, code: 'timeout', runs: 1 },
      ]),
    ).toEqual([
      { stageKey: 'code', code: 'envelope-missing', runs: 3 },
      { stageKey: 'audit', code: 'timeout', runs: 1 },
    ])
  })
})

describe('RFC-616 stage catalogue', () => {
  const definition = {
    $schema_version: 7,
    inputs: [],
    edges: [],
    nodes: [
      { id: 'design', kind: 'agent-single', title: 'Design', agentName: 'designer' },
      { id: 'loop', kind: 'wrapper-loop', nodeIds: ['code'], maxIterations: 5 },
      { id: 'code', kind: 'agent-single', agentName: 'coder' },
      {
        id: 'forever',
        kind: 'wrapper-loop',
        nodeIds: [],
        maxIterations: 3,
        continueOnMaxIterations: true,
      },
      {
        id: 'ask',
        kind: 'clarify',
        interactionMode: 'mindmap',
        mindmap: { categories: ['scope', ['api', 'errors'], ['api', 'auth']] },
      },
    ],
  } as unknown as WorkflowDefinition

  test('synthetic node ids belong to fixed system stages', () => {
    expect(systemStageOf('design')).toBeNull()
    expect(systemStageOf('__repo_prep__')).toBe('system:repo-prep')
    expect(systemStageOf('__commit_push__')).toBe('system:commit-push')
    expect(systemStageOf('__commit_push__:code')).toBe('system:commit-push')
    expect(systemStageOf('__merge_resolve__:x:y')).toBe('system:merge-resolve')
    expect(systemStageOf('__dw_orchestrator__')).toBe('system:orchestrator')
    expect(systemStageOf('__something_new__')).toBe('system:other')
  })

  test('nodes, wrappers, system stages and removed nodes', () => {
    const catalog = workflowStageCatalog(definition, [
      'design',
      'code',
      'old-node',
      '__commit_push__:code',
      '__repo_prep__',
    ])
    const byKey = new Map(catalog.stages.map((stage) => [stage.key, stage]))
    expect(byKey.get('design')).toMatchObject({
      label: 'Design',
      kind: 'agent-single',
      removed: false,
    })
    expect(byKey.get('code')).toMatchObject({ label: 'coder', parentKey: 'loop' })
    expect(byKey.get('loop')).toMatchObject({
      label: 'loop',
      kind: 'wrapper-loop',
      parentKey: null,
    })
    expect(byKey.get('old-node')).toMatchObject({ removed: true, label: 'old-node' })
    expect(byKey.get('system:commit-push')).toMatchObject({ kind: 'system', removed: false })
    expect(byKey.get('system:repo-prep')!.order).toBeLessThan(
      byKey.get('system:commit-push')!.order,
    )
    expect(catalog.stageOf('__commit_push__:code')).toBe('system:commit-push')
    expect(catalog.stageOf('old-node')).toBe('old-node')
    expect(catalog.loops.get('loop')).toEqual({ maxIterations: 5, continuesAtCap: false })
    expect(catalog.loops.get('forever')).toEqual({ maxIterations: 3, continuesAtCap: true })
    // "scope" and "api": two top-level categories.
    expect([...catalog.mindmapCategories.get('ask')!].sort()).toEqual(['api', 'scope'])
  })

  test('without a definition the catalogue is the executed ids, and none of them is "removed"', () => {
    // Regression: an unreadable frozen definition marked every node as removed from the workflow.
    const catalog = workflowStageCatalog(null, ['b', 'a', '__repo_prep__'])
    expect(catalog.stages.map((stage) => stage.key)).toEqual(['system:repo-prep', 'a', 'b'])
    expect(catalog.stages.map((stage) => stage.removed)).toEqual([false, false, false])
    expect(catalog.stageOf('a')).toBe('a')
    // The same for a key met later, when no definition was read.
    expect(
      completeStages(catalog.stages, ['late'], false).find((stage) => stage.key === 'late'),
    ).toMatchObject({ removed: false })
    // With a definition, an id it does not list was removed.
    expect(
      workflowStageCatalog(definition, ['gone']).stages.find((stage) => stage.key === 'gone'),
    ).toMatchObject({ removed: true })
  })

  test('every referenced stage gets a row', () => {
    const stages = completeStages(workflowStageCatalog(definition, []).stages, [
      'design',
      'system:other',
      'unattributed',
      'ghost',
    ])
    const kinds = Object.fromEntries(stages.map((stage) => [stage.key, stage.kind]))
    expect(kinds['system:other']).toBe('system')
    expect(kinds.unattributed).toBe('unattributed')
    expect(stages.find((stage) => stage.key === 'ghost')).toMatchObject({ removed: true })
    expect(stages.filter((stage) => stage.key === 'design')).toHaveLength(1)
  })
})

describe('RFC-616 unit numbers', () => {
  test('first pass: review rework, automatic retries, failures and manual retries each break it', () => {
    const firstPass = (over: Partial<ProcessUnitFacts>) => unitNumbers(facts(over), NOW).firstPass
    expect(firstPass({ executions: [exec()] })).toBe(true)
    expect(firstPass({ executions: [exec(), exec({ cause: 'review-rework' })] })).toBe(false)
    expect(firstPass({ executions: [exec(), exec({ cause: 'auto-retry' })] })).toBe(false)
    expect(firstPass({ executions: [exec({ failedRuns: 1 })] })).toBe(false)
    expect(firstPass({ executions: [exec()], manualRetries: 1 })).toBe(false)
    // A loop that ran out of rounds, or a wrapper that failed as a whole, leaves no failed node behind.
    expect(firstPass({ executions: [exec()], failedWrappers: 1 })).toBe(false)
  })

  test('first pass: recovery, cascades and reruns after an answer do not break it', () => {
    const firstPass = (executions: ProcessExecution[]) =>
      unitNumbers(facts({ executions }), NOW).firstPass
    expect(firstPass([exec(), exec({ cause: 'recovery', interruptedRuns: 1 })])).toBe(true)
    expect(firstPass([exec(), exec({ cause: 'cascade' })])).toBe(true)
    expect(firstPass([exec(), exec({ cause: 'clarify-rerun' })])).toBe(true)
    expect(firstPass([exec(), exec({ cause: 'system' })])).toBe(true)
  })

  test('first pass is only judged for succeeded units, and a kind can judge it itself', () => {
    expect(unitNumbers(facts({ unit: unit({ status: 'failed' }) }), NOW).firstPass).toBeNull()
    expect(
      unitNumbers(facts({ unit: unit({ status: 'active', endedAt: null }) }), NOW).firstPass,
    ).toBeNull()
    expect(unitNumbers(facts({ firstPassOverride: false }), NOW).firstPass).toBe(false)
    expect(unitNumbers(facts({ firstPassOverride: null }), NOW).firstPass).toBeNull()
  })

  test('interventions: closed valid gate rounds, manual retries and recorded operations', () => {
    const operation = (action: ProcessOperation['action']): ProcessOperation => ({
      action,
      subjectKind: 'task',
      subjectId: 'u1',
      actorUserId: 'alice',
      firstAt: 1,
      lastAt: 1,
    })
    const item = unitNumbers(
      facts({
        gates: [
          gate(),
          gate({ kind: 'clarify', outcome: 'continue' }),
          gate({ void: true, ordinal: 0 }),
          gate({ closedAt: null, outcome: null }),
          gate({ inherited: true, kind: 'review' }),
        ],
        manualRetries: 2,
        operations: [
          operation('task.resume'),
          operation('task.repair'),
          operation('task.retry-node'),
        ],
      }),
      NOW,
    )
    expect(item.gateRounds.get('review')).toBe(2)
    expect(item.gateRounds.get('clarify')).toBe(1)
    // retry-node is counted from the ledger (manualRetries), not from the operation.
    expect(item.operations).toBe(2)
    expect(item.interventions).toBe(3 + 2 + 2)
  })

  test('headline numbers follow the sampling rules', () => {
    const list = numbers([
      facts({
        unit: unit({ id: 'a', endedAt: 4 * H, autoMs: 2 * H }),
        usageTotals: usage(100, 10),
      }),
      facts({
        unit: unit({ id: 'b', endedAt: 8 * H, autoMs: 2 * H }),
        usageTotals: usage(300, 30),
        executions: [exec({ cause: 'review-rework' })],
      }),
      facts({ unit: unit({ id: 'c', status: 'failed', endedAt: H }), usageTotals: usage(500, 50) }),
      facts({
        unit: unit({ id: 'd', status: 'active', endedAt: null }),
        usageTotals: usage(9_999, 999),
      }),
      facts({
        unit: unit({ id: 'e', status: 'canceled', endedAt: H }),
        usageTotals: usage(7_777, 777),
        hasUsageRecord: false,
      }),
    ])
    expect(unitCounts(list)).toEqual({ total: 5, succeeded: 2, failed: 1, canceled: 1, active: 1 })
    const metrics = commonMetrics(list)
    expect(metrics.units).toBe(5)
    expect(metrics.successRate).toBe(2 / 4)
    // Lead time and first pass: succeeded units only.
    expect(metrics.leadP50).toBe(4 * H)
    expect(metrics.leadP90).toBe(8 * H)
    expect(metrics.flowEfficiency).toBe((4 * H) / (12 * H))
    expect(metrics.firstPassRate).toBe(1 / 2)
    // Tokens: ended units with usage records (a, b, c) — not the active one, not the one before records began.
    expect(metrics.tokensPerUnit).toBe(300)
    expect(metrics.costNanoPerUnit).toBe(30)
  })

  test('an empty set has no rates', () => {
    const metrics = commonMetrics([])
    expect(metrics).toMatchObject({
      units: 0,
      successRate: null,
      leadP50: null,
      flowEfficiency: null,
      tokensPerUnit: null,
      firstPassRate: null,
      interventionsPerUnit: null,
    })
    expect(timeSplitOf([])).toEqual({
      sampleUnits: 0,
      leadMs: null,
      autoMs: 0,
      waits: [],
      otherMs: 0,
    })
  })

  test('the time split averages succeeded units that have a running-time record', () => {
    const list = numbers([
      facts({
        unit: unit({ id: 'a', endedAt: 10 * H, autoMs: 2 * H }),
        gates: [gate({ openedAt: H, closedAt: 5 * H })],
      }),
      facts({ unit: unit({ id: 'b', endedAt: 6 * H, autoMs: 4 * H }) }),
      facts({ unit: unit({ id: 'c', endedAt: 50 * H, autoMs: null }) }),
      facts({ unit: unit({ id: 'd', status: 'failed', endedAt: 90 * H, autoMs: H }) }),
    ])
    expect(timeSplitOf(list)).toEqual({
      sampleUnits: 2,
      leadMs: 8 * H,
      autoMs: 3 * H,
      waits: [{ kind: 'review', ms: 2 * H }],
      otherMs: 3 * H,
    })
  })

  test('the parts of the time split add up to the lead time exactly', () => {
    // Regression: each mean was rounded on its own, so three units of 100, 101 and 100 ms came
    // out as 34 ms running + 67 ms other for a lead time of 100 ms.
    const list = numbers([
      facts({ unit: unit({ id: 'a', endedAt: 100, autoMs: 33 }) }),
      facts({
        unit: unit({ id: 'b', endedAt: 101, autoMs: 34 }),
        gates: [gate({ openedAt: 10, closedAt: 21 })],
      }),
      facts({ unit: unit({ id: 'c', endedAt: 100, autoMs: 34 }) }),
    ])
    const split = timeSplitOf(list)
    expect(split.leadMs).toBe(100)
    expect(
      split.autoMs + split.otherMs + split.waits.reduce((total, wait) => total + wait.ms, 0),
    ).toBe(100)
    // Each part stays within a millisecond of its own mean: 33.67 running, 3.67 waiting, 63 other.
    expect(split).toMatchObject({ autoMs: 33, waits: [{ kind: 'review', ms: 4 }], otherMs: 63 })
  })

  test('tokens by cause add up to the headline number exactly', () => {
    const slice = (cause: ProcessExecution['cause'], tokens: number) => ({
      stageKey: 'design',
      cause,
      tokens,
      costNano: tokens * 3,
    })
    const list = numbers([
      facts({
        unit: unit({ id: 'a' }),
        usage: [slice('first', 101), slice('review-rework', 50), slice('system', 7)],
        usageTotals: usage(158, 474),
        executions: [exec({ activeMs: 300 }), exec({ cause: 'review-rework', activeMs: 100 })],
      }),
      facts({
        unit: unit({ id: 'b' }),
        usage: [
          slice('first', 200),
          slice('cascade', 11),
          slice('recovery', 4),
          slice('auto-retry', 2),
        ],
        usageTotals: usage(217, 651),
        executions: [exec({ cause: 'recovery', activeMs: 100 })],
      }),
      facts({ unit: unit({ id: 'c' }), usage: [slice('first', 33)], usageTotals: usage(33, 99) }),
    ])
    const slices = causeSlicesOf(list)
    expect(slices.map((item) => item.cause)).toEqual([
      'first',
      'review-rework',
      'clarify-rerun',
      'auto-retry',
      'other-rerun',
      'system',
    ])
    expect(slices.reduce((sum, item) => sum + item.tokens, 0)).toBe(
      commonMetrics(list).tokensPerUnit!,
    )
    expect(slices.reduce((sum, item) => sum + item.costNano, 0)).toBe(
      commonMetrics(list).costNanoPerUnit!,
    )
    // Cascade and recovery are shown together.
    const other = slices.find((item) => item.cause === 'other-rerun')!
    expect(other.tokens).toBe(5)
    // Durations are a share of the summed node-run time, never an absolute value.
    expect(slices.find((item) => item.cause === 'first')!.durationShare).toBe(300 / 500)
    expect(slices.find((item) => item.cause === 'review-rework')!.durationShare).toBe(100 / 500)
    expect(other.durationShare).toBe(100 / 500)
    expect(slices.reduce((sum, item) => sum + (item.durationShare ?? 0), 0)).toBeCloseTo(1)
  })

  // "System work" alone says neither what ran nor where to change it: on real tasks it was 13–55%
  // of the tokens, all memory extraction, shown as part of one unnamed "other reruns and system
  // work" (user report, 2026-11-27). The summary now lists what the slice was spent on.
  test('system work is listed by what it was for, largest first, and adds up to the system slice exactly', () => {
    const system = (systemKind: string | undefined, tokens: number) => ({
      stageKey: 'system:other',
      cause: 'system' as const,
      ...(systemKind === undefined ? {} : { systemKind }),
      tokens,
      costNano: tokens * 3,
    })
    const first = { stageKey: 'design', cause: 'first' as const, tokens: 100, costNano: 300 }
    const list = numbers([
      facts({
        unit: unit({ id: 'a' }),
        usage: [first, system('memory-distill', 40), system('commit-push', 7)],
        usageTotals: usage(147, 441),
      }),
      facts({
        unit: unit({ id: 'b' }),
        // Two slices of one kind on different stages are one kind; a slice without a kind is "other".
        usage: [
          first,
          system('memory-distill', 21),
          { ...system('memory-distill', 10), stageKey: 'design' },
          system(undefined, 3),
        ],
        usageTotals: usage(134, 402),
      }),
      facts({ unit: unit({ id: 'c' }), usage: [first], usageTotals: usage(100, 300) }),
      // Not ended: in no token statistic, so not in this one either.
      facts({
        unit: unit({ id: 'd', status: 'active', endedAt: null }),
        usage: [system('merge-resolve', 9_000)],
        usageTotals: usage(9_000, 27_000),
      }),
    ])
    const causes = causeSlicesOf(list)
    const slice = causes.find((item) => item.cause === 'system')!
    // 81 system tokens over three sampled units.
    expect(slice.tokens).toBe(27)
    const work = systemWorkOf(list, causes)
    expect(work.map((item) => item.kind)).toEqual(['memory-distill', 'commit-push', 'other'])
    expect(work.reduce((sum, item) => sum + item.tokens, 0)).toBe(slice.tokens)
    expect(work.reduce((sum, item) => sum + item.costNano, 0)).toBe(slice.costNano)
    // 71 : 7 : 3 of the 27, rounded so that they still add up.
    expect(work.map((item) => item.tokens)).toEqual([24, 2, 1])
  })

  test('the kinds the page names are the kinds the platform records its own calls with', () => {
    // The page names a kind by a string. If a recorder renames its kind, the tokens are still
    // listed (under the raw kind) but lose their product name and the hint where to change them.
    const source = (path: string) => readFileSync(join(import.meta.dir, '../src', path), 'utf8')
    const recorded = [
      ['modules/memory/application/distill/memoryDistiller.ts', "kind: 'memory-distill',"],
      ['modules/workspace-insight/application/changeNarrative.ts', "kind: 'change-narrative',"],
      [
        'modules/task-execution/infrastructure/clarifyFollowupGeneration.ts',
        "kind: 'clarify-followup',",
      ],
      [
        'modules/run-observability/application/process/sources.ts',
        "export const CLARIFY_FOLLOWUP_KIND = 'clarify-followup'",
      ],
    ] as const
    for (const [path, fragment] of recorded) expect(source(path), path).toContain(fragment)
    for (const kind of ['memory-distill', 'change-narrative', 'clarify-followup'] as const)
      expect(PROCESS_SYSTEM_WORK_KINDS).toContain(kind)
    // A call tied to a task is recorded through one place, which stores the demand's kind.
    expect(source('modules/task-execution/composition/systemAgentObservations.ts')).toContain(
      'systemKind: demand?.kind ?? request.feature,',
    )
  })

  test('no system tokens: nothing to list', () => {
    const list = numbers([
      facts({
        unit: unit({ id: 'a' }),
        usage: [{ stageKey: 'design', cause: 'first', tokens: 10, costNano: 30 }],
        usageTotals: usage(10, 30),
      }),
    ])
    expect(systemWorkOf(list, causeSlicesOf(list))).toEqual([])
    expect(systemWorkOf([], causeSlicesOf([]))).toEqual([])
  })

  test('interventions per unit and stability', () => {
    const list = numbers([
      facts({
        unit: unit({ id: 'a' }),
        gates: [gate(), gate({ kind: 'clarify' })],
        manualRetries: 1,
        executions: [
          exec({ cause: 'auto-retry', runs: 2 }),
          exec({ cause: 'recovery', interruptedRuns: 1 }),
        ],
        failureCodes: [
          { stageKey: 'code', code: 'envelope-missing', runs: 3 },
          { stageKey: 'audit', code: 'timeout', runs: 1 },
        ],
      }),
      facts({
        unit: unit({ id: 'b', status: 'canceled', limitCanceled: true }),
        failureCodes: [{ stageKey: 'code', code: 'envelope-missing', runs: 1 }],
      }),
    ])
    expect(interventionsOf(list)).toEqual({
      gates: [
        { kind: 'review', perUnit: 0.5 },
        { kind: 'clarify', perUnit: 0.5 },
      ],
      manualRetriesPerUnit: 0.5,
      operationsPerUnit: 0,
    })
    expect(stabilityOf(list)).toEqual({
      failureCodes: [
        { code: 'envelope-missing', runs: 4 },
        { code: 'timeout', runs: 1 },
      ],
      autoRetries: 2,
      interruptions: 1,
      recoveries: 1,
      manualRetries: 1,
      limitCancellations: 1,
      operations: 0,
    })
  })

  test('the weekly trend has one point per calendar week, weeks start on Monday', () => {
    const monday = Date.UTC(2026, 9, 5) // 2026-10-05 is a Monday
    const day = 24 * H
    const list = numbers([
      facts({ unit: unit({ id: 'a', startedAt: monday, endedAt: monday + 2 * H }) }),
      facts({
        unit: unit({ id: 'b', startedAt: monday + 6 * day, endedAt: monday + 6 * day + 4 * H }),
      }),
      facts({
        unit: unit({ id: 'c', startedAt: monday + 15 * day, endedAt: monday + 15 * day + H }),
      }),
    ])
    const trend = trendOf(list, monday, monday + 21 * day, 0)
    expect(trend.map((point) => [point.week, point.units])).toEqual([
      ['2026-10-05', 2],
      ['2026-10-12', 0],
      ['2026-10-19', 1],
    ])
    expect(trend[0]!.leadP50).toBe(2 * H)
    expect(trend[1]).toMatchObject({ leadP50: null, tokensPerUnit: null, firstPassRate: null })
    // Sunday 23:00 UTC is already Monday at UTC+8.
    const sunday = monday - H
    expect(
      trendOf(
        numbers([facts({ unit: unit({ startedAt: sunday, endedAt: sunday + H }) })]),
        sunday,
        monday,
        480,
      )[0]!.week,
    ).toBe('2026-10-05')
  })

  test('a unit row carries only the row extras', () => {
    const item = unitNumbers(
      facts({ usageTotals: { ...usage(42, 7), incompleteCalls: 1 }, gates: [gate()] }),
      NOW,
    )
    const row = unitRowOf(item, {
      ...NO_ROW_EXTRAS,
      rounds: 3,
      // A richer extras object must not leak its other fields into the response.
      ...({ leaderTokens: 99 } as object),
    })
    expect(row).toMatchObject({
      unitId: 'u1',
      status: 'succeeded',
      tokens: 42,
      usageLowerBound: true,
      unpriced: false,
      gateRounds: [{ kind: 'review', rounds: 1 }],
      rounds: 3,
      firstPass: true,
    })
    expect(Object.keys(row)).not.toContain('leaderTokens')
  })
})

describe('RFC-616 human gates', () => {
  const view = (subjectId: string, actorUserId: string, firstAt: number, lastAt: number) =>
    ({
      action: 'review.view',
      subjectKind: 'node-run',
      subjectId,
      actorUserId,
      firstAt,
      lastAt,
    }) satisfies ProcessOperation

  test('the first open is the earliest view that overlaps the round', () => {
    const round = gate({ openedAt: 10 * M, closedAt: 60 * M })
    expect(firstOpenOf(round, [], 'review.view')).toBeNull()
    // A view that ended before the round was ready belongs to the previous round.
    expect(firstOpenOf(round, [view('run-review', 'a', 0, 5 * M)], 'review.view')).toBeNull()
    // A session that began earlier and was still open counts from the moment the round was ready.
    expect(firstOpenOf(round, [view('run-review', 'a', 0, 20 * M)], 'review.view')).toBe(10 * M)
    expect(
      firstOpenOf(
        round,
        [view('run-review', 'a', 40 * M, 41 * M), view('run-review', 'b', 25 * M, 26 * M)],
        'review.view',
      ),
    ).toBe(25 * M)
    expect(firstOpenOf(round, [view('other-run', 'a', 20 * M, 21 * M)], 'review.view')).toBeNull()
    expect(firstOpenOf(round, [view('run-review', 'a', 70 * M, 71 * M)], 'review.view')).toBeNull()
    expect(
      firstOpenOf(round, [view('run-review', 'a', 20 * M, 21 * M)], 'review.view', 'b'),
    ).toBeNull()
    expect(
      firstOpenOf(gate({ closedAt: null }), [view('run-review', 'a', 0, 1)], 'review.view'),
    ).toBeNull()
  })

  test('review: rounds, first pass, comments, rework and decisions', () => {
    const unitA = facts({
      unit: unit({ id: 'a' }),
      operations: [view('run-1', 'alice', 30 * M, 31 * M)],
      gates: [
        gate({
          subject: { kind: 'node-run', id: 'run-1' },
          instanceKey: 'run-1',
          ordinal: 1,
          openedAt: 0,
          closedAt: H,
          outcome: 'iterated',
          measures: { comments: 6, commenters: 2 },
          people: [
            { userId: 'alice', comments: 4, answers: 0 },
            { userId: 'bob', comments: 2, answers: 0 },
          ],
        }),
        gate({
          subject: { kind: 'node-run', id: 'run-1' },
          instanceKey: 'run-1',
          ordinal: 2,
          openedAt: 2 * H,
          closedAt: 3 * H,
          outcome: 'approved',
          measures: { comments: 0 },
        }),
        // Voided by a sibling's rejection: counts as waiting only.
        gate({
          subject: { kind: 'node-run', id: 'run-9' },
          instanceKey: 'run-9',
          ordinal: 0,
          void: true,
          outcome: 'voided',
          deciderUserId: null,
          measures: { comments: 5, commenters: 1 },
        }),
      ],
    })
    const unitB = facts({
      unit: unit({ id: 'b' }),
      gates: [
        gate({
          stageKey: 'review2',
          relatedStageKey: 'code',
          subject: { kind: 'node-run', id: 'run-2' },
          instanceKey: 'run-2',
          openedAt: 0,
          closedAt: 2 * H,
          outcome: 'approved',
          deciderUserId: 'bob',
          measures: { comments: 2, commenters: 1, documents: 4, documentsAccepted: 3 },
          people: [{ userId: 'bob', comments: 2, answers: 0 }],
        }),
        gate({ inherited: true, instanceKey: 'child', outcome: 'rejected' }),
        gate({
          subject: { kind: 'node-run', id: 'run-3' },
          instanceKey: 'run-3',
          closedAt: null,
          outcome: null,
          deciderUserId: null,
        }),
      ],
    })
    const summary = reviewSummaryOf([unitA, unitB], { people: true })!
    expect(summary.rounds).toBe(3)
    expect(summary.voidRounds).toBe(1)
    expect(summary.durationMs).toEqual({ n: 3, p50: H, p90: 2 * H, mean: Math.round((4 * H) / 3) })
    expect(summary.roundsPerUnit).toBe(3 / 2)
    // Instances run-1 (iterated first) and run-2 (approved first); run-3 is undecided.
    expect(summary.firstPassRate).toBe(1 / 2)
    expect(summary.commentsPerRound).toBe(8 / 3)
    // Rounds with comments: 6 by 2 people and 2 by 1 person.
    expect(summary.commentsPerCommenter).toBe((3 + 2) / 2)
    expect(summary.commentersPerRound).toBe(3 / 2)
    expect(summary.reworkMs).toEqual({ n: 1, p50: H, p90: H, mean: H })
    expect(summary.decisions).toEqual({ approved: 2, iterated: 1, rejected: 0 })
    expect(summary.commentsByRound).toEqual([
      { ordinal: 1, rounds: 2, comments: 8 },
      { ordinal: 2, rounds: 1, comments: 0 },
    ])
    expect(summary.documentAcceptRate).toBe(3 / 4)
    expect(summary.responseMs).toEqual({ n: 1, p50: 30 * M, p90: 30 * M, mean: 30 * M })
    expect(summary.handlingMs).toEqual({ n: 1, p50: 30 * M, p90: 30 * M, mean: 30 * M })
    expect(summary.byStage).toEqual([
      {
        stageKey: 'review',
        relatedStageKey: 'design',
        roundsPerUnit: 2,
        durationMs: { n: 2, p50: H, p90: H, mean: H },
        commentsPerRound: 3,
        firstPassRate: 0,
      },
      {
        stageKey: 'review2',
        relatedStageKey: 'code',
        roundsPerUnit: 1,
        durationMs: { n: 1, p50: 2 * H, p90: 2 * H, mean: 2 * H },
        commentsPerRound: 2,
        firstPassRate: 1,
      },
    ])
    expect(summary.people).toEqual([
      { userId: 'alice', decisions: 2, comments: 4, answers: 0, responseP50: 30 * M },
      { userId: 'bob', decisions: 1, comments: 4, answers: 0, responseP50: null },
    ])
    expect(reviewSummaryOf([unitA, unitB], { people: false })!.people).toBeNull()
    expect(reviewSummaryOf([facts()], { people: true })).toBeNull()
  })

  test('clarify: trigger rate, answer mix and void rounds', () => {
    const asked = (id: string, gates: ProcessGateRound[]) => facts({ unit: unit({ id }), gates })
    const clarify = (over: Partial<ProcessGateRound>) =>
      gate({
        kind: 'clarify',
        stageKey: 'ask',
        relatedStageKey: 'design',
        instanceKey: 'design|',
        outcome: 'continue',
        ...over,
      })
    const summary = clarifySummaryOf(
      [
        asked('a', [
          clarify({
            openedAt: 0,
            closedAt: 2 * H,
            measures: {
              questions: 4,
              answersRecommended: 2,
              answersOther: 1,
              answersCustom: 1,
              questionsWithRecommendation: 3,
            },
            people: [{ userId: 'alice', comments: 0, answers: 4 }],
          }),
          clarify({
            ordinal: 2,
            openedAt: 3 * H,
            closedAt: 4 * H,
            outcome: 'stop',
            measures: { questions: 2, answersSkipped: 2 },
          }),
          clarify({ void: true, ordinal: 0, outcome: 'canceled', closedAt: 9 * H }),
        ]),
        asked('b', [clarify({ closedAt: null, outcome: null })]),
        asked('c', []),
        asked('d', []),
      ],
      { people: true },
    )!
    expect(summary.rounds).toBe(2)
    expect(summary.voidRounds).toBe(1)
    expect(summary.unitsAsking).toBe(2)
    expect(summary.triggerRate).toBe(2 / 4)
    expect(summary.roundsPerUnit).toBe(2)
    expect(summary.questionsPerRound).toBe(3)
    // The canceled round's nine hours are not part of the answer time.
    expect(summary.answerMs).toEqual({ n: 2, p50: H, p90: 2 * H, mean: 1.5 * H })
    expect(summary.stopRate).toBe(1 / 2)
    expect(summary.answers).toEqual({ recommended: 2, other: 1, custom: 1, skipped: 2 })
    // The rate is a share of the answers to questions that offered a recommendation.
    expect(summary.answersWithRecommendation).toBe(3)
    expect(summary.recommendedRate).toBe(2 / 3)
    expect(summary.byStage).toEqual([
      { stageKey: 'ask', askingStageKey: 'design', roundsPerUnit: 2 },
    ])
    expect(summary.people![0]).toMatchObject({ userId: 'alice', answers: 4 })
    expect(clarifySummaryOf([facts()], { people: true })).toBeNull()
  })

  test('mindmap: depth, follow-ups, maturity and category coverage', () => {
    const map = (over: Partial<ProcessGateRound>) =>
      gate({
        kind: 'clarify',
        stageKey: 'ask',
        instanceKey: 'design|',
        mindmap: true,
        outcome: 'continue',
        ...over,
      })
    const summary = mindmapSummaryOf(
      [
        facts({
          gates: [
            map({
              closedAt: 2 * H,
              measures: {
                questions: 6,
                questionsInitial: 4,
                questionsFollowup: 2,
                followupRequests: 1,
                depthSum: 9,
                depthMax: 3,
                maturityDecided: 4,
                maturityProvisional: 1,
                maturityUnmarked: 0,
                answersSkipped: 1,
              },
              // One of the two configured categories.
              categories: ['scope'],
            }),
            map({
              ordinal: 2,
              openedAt: 3 * H,
              closedAt: 4 * H,
              measures: {
                questions: 2,
                questionsInitial: 2,
                depthSum: 2,
                depthMax: 1,
              },
              // Both configured ones, the same one twice over in other words, and three the
              // node does not configure.
              categories: ['api', 'scope', 'billing', 'rollout', 'naming'],
            }),
            // A questionnaire round is not a mindmap.
            gate({ kind: 'clarify', stageKey: 'ask', mindmap: false, measures: { questions: 50 } }),
          ],
        }),
      ],
      {
        followups: [
          { durationMs: 30_000, tokens: 20_000 },
          { durationMs: null, tokens: 10_000 },
        ],
        categories: new Map([['ask', new Set(['scope', 'api'])]]),
      },
    )!
    expect(summary.maps).toBe(2)
    expect(summary.depthMean).toBe(11 / 8)
    expect(summary.depthMax).toBe(3)
    expect(summary.mapsPerNode).toBe(2)
    expect(summary.followupsPerMap).toBe(1 / 2)
    expect(summary.questionsPerMap).toBe(4)
    expect(summary.initialQuestionsPerMap).toBe(3)
    expect(summary.followupQuestionsPerMap).toBe(1)
    expect(summary.followupGenerationMs).toBe(30_000)
    expect(summary.followupGenerationTokens).toBe(15_000)
    expect(summary.maturity).toEqual({ decided: 4, provisional: 1, unmarked: 0, skipped: 1 })
    // Configured categories that have a question: (1 + 2) of (2 + 2).
    expect(summary.categoryCoverage).toBe(3 / 4)
    expect(mindmapSummaryOf([facts()], { followups: [], categories: new Map() })).toBeNull()
    // Regression: questions filed under names the node does not configure cover nothing. Three
    // such names used to read as "three of three covered".
    const off = mindmapSummaryOf(
      [facts({ gates: [map({ closedAt: H, categories: ['scope', 'x', 'y'] })] })],
      { followups: [], categories: new Map([['ask', new Set(['scope', 'api', 'data'])]]) },
    )!
    expect(off.categoryCoverage).toBe(1 / 3)
    // A node that configures no categories has no coverage to state.
    expect(
      mindmapSummaryOf([facts({ gates: [map({ closedAt: H, categories: ['x'] })] })], {
        followups: [],
        categories: new Map(),
      })!.categoryCoverage,
    ).toBeNull()
  })

  test('a yes/no gate: rejections and what a rejection cost in rounds', () => {
    const completion = (over: Partial<ProcessGateRound>) =>
      gate({
        kind: 'completion',
        stageKey: 'leader',
        relatedStageKey: null,
        instanceKey: 'completion',
        ...over,
      })
    const summary = decisionGateOf(
      [
        facts({
          gates: [
            completion({ openedAt: 0, closedAt: H, outcome: 'rejected', round: 4 }),
            completion({ openedAt: 3 * H, closedAt: 5 * H, outcome: 'approved', round: 6 }),
          ],
        }),
        facts({
          gates: [completion({ openedAt: 0, closedAt: 3 * H, outcome: 'approved', round: 2 })],
        }),
        facts({ gates: [completion({ openedAt: 0, closedAt: null, outcome: null, round: 1 })] }),
      ],
      'completion',
    )!
    expect(summary).toEqual({
      rounds: 3,
      waitMs: { n: 3, p50: 2 * H, p90: 3 * H, mean: 2 * H },
      rejections: 1,
      rejectRate: 1 / 3,
      extraRoundsAfterReject: 2,
    })
    expect(decisionGateOf([facts()], 'completion')).toBeNull()
  })
})

describe('RFC-616 stage rows', () => {
  const stage = (
    key: string,
    kind: 'agent-single' | 'review' | 'wrapper-loop' | 'wrapper-fanout',
    order: number,
  ) => ({
    key,
    label: key,
    kind,
    parentKey: null,
    order,
    removed: false,
  })

  test('durations over succeeded units, tokens over the token sample, rates over every unit', () => {
    const slice = (stageKey: string, cause: ProcessExecution['cause'], tokens: number) => ({
      stageKey,
      cause,
      tokens,
      costNano: tokens,
    })
    const list = numbers([
      facts({
        unit: unit({ id: 'a' }),
        executions: [
          exec({ stageKey: 'design', runs: 1, activeMs: 10 * M }),
          exec({ stageKey: 'design', cause: 'review-rework', runs: 1, activeMs: 20 * M }),
        ],
        usage: [
          slice('design', 'first', 600),
          slice('design', 'review-rework', 200),
          slice('code', 'first', 200),
        ],
        usageTotals: usage(1_000),
        gates: [
          gate({
            stageKey: 'review',
            relatedStageKey: 'design',
            openedAt: H,
            closedAt: 3 * H,
            outcome: 'iterated',
          }),
          gate({
            stageKey: 'review',
            relatedStageKey: 'design',
            ordinal: 2,
            openedAt: 4 * H,
            closedAt: 5 * H,
          }),
          gate({
            kind: 'clarify',
            stageKey: 'ask',
            relatedStageKey: 'design',
            outcome: 'continue',
          }),
        ],
      }),
      facts({
        unit: unit({ id: 'b', status: 'failed' }),
        executions: [
          exec({ stageKey: 'design', runs: 2, endedRuns: 2, failedRuns: 1, activeMs: 99 * M }),
          exec({ stageKey: 'design', cause: 'auto-retry', runs: 1, endedRuns: 1, activeMs: M }),
        ],
        failureCodes: [
          { stageKey: 'design', code: 'envelope-missing', runs: 3 },
          { stageKey: 'design', code: 'timeout', runs: 1 },
        ],
        usage: [slice('design', 'first', 400)],
        usageTotals: usage(400),
      }),
    ])
    const rows = stageRowsOf({
      stages: [stage('design', 'agent-single', 0), stage('review', 'review', 1)],
      numbers: list,
      now: NOW,
    })
    const design = rows[0]!
    expect(design).toMatchObject({
      key: 'design',
      units: 2,
      runsPerUnit: 5 / 2,
      // Only the succeeded unit contributes a duration: 10 + 20 minutes.
      durationMs: { n: 1, p50: 30 * M, p90: 30 * M, mean: 30 * M },
      tokensPerUnit: 600,
      tokenShare: 1_200 / 1_400,
      failureRate: 1 / 5,
      autoRetryRate: 1 / 5,
      topFailureCode: 'envelope-missing',
      topFailureShare: 3 / 4,
      rejectRate: 1 / 2,
      clarifyRate: 1 / 2,
      reworkTokenShare: 200 / 1_200,
      baseline: null,
    })
    const review = rows[1]!
    expect(review).toMatchObject({
      key: 'review',
      units: 1,
      runsPerUnit: null,
      gateRoundsPerUnit: 2,
      gateWaitMsPerUnit: 3 * H,
      gateFirstPassRate: 0,
      tokensPerUnit: null,
    })
  })

  test("a stage's waiting time is read from succeeded units only; its rounds from every unit", () => {
    // Regression: failed units, and gates still open in running ones, were averaged into the wait.
    const reviewed = (unitOver: Partial<ProcessUnit>, gates: ProcessGateRound[]) =>
      facts({ unit: unit(unitOver), executions: [exec()], gates })
    const list = numbers([
      // Succeeded: one round that took two hours.
      reviewed({ id: 'ok' }, [gate({ openedAt: H, closedAt: 3 * H })]),
      // Failed after a round that took five hours.
      reviewed({ id: 'bad', status: 'failed', outcome: 'failed' }, [
        gate({ openedAt: H, closedAt: 6 * H, outcome: 'rejected' }),
      ]),
      // Still running, its second round open since hour 4: the wait grows with the clock.
      reviewed({ id: 'open', status: 'active', outcome: 'awaiting_review', endedAt: null }, [
        gate({ openedAt: H, closedAt: 2 * H, outcome: 'iterated' }),
        gate({ ordinal: 2, openedAt: 4 * H, closedAt: null, outcome: null }),
      ]),
    ])
    const row = (now: number) =>
      stageRowsOf({ stages: [stage('review', 'review', 1)], numbers: list, now }).find(
        (item) => item.key === 'review',
      )!
    expect(row(NOW)).toMatchObject({
      // Three closed rounds over the three units that held a gate here.
      gateRoundsPerUnit: 1,
      gateWaitMsPerUnit: 2 * H,
    })
    expect(row(NOW + 100 * H).gateWaitMsPerUnit).toBe(2 * H)
    // No succeeded unit: there is no waiting time to state, not a zero.
    const none = stageRowsOf({
      stages: [stage('review', 'review', 1)],
      numbers: list.slice(1),
      now: NOW,
    }).find((item) => item.key === 'review')!
    expect(none).toMatchObject({ gateRoundsPerUnit: 1, gateWaitMsPerUnit: null })
  })

  test('a wrapper shows its own span, and loop and fan-out facts', () => {
    const list = numbers([
      facts({
        unit: unit({ id: 'a' }),
        executions: [exec({ stageKey: 'code', activeMs: 5 * M })],
        wrappers: [
          { stageKey: 'loop', status: 'done', rounds: 2, shards: 0, durationMs: 40 * M },
          { stageKey: 'fan', status: 'failed', rounds: 1, shards: 4, durationMs: 9 * M },
        ],
      }),
      facts({
        unit: unit({ id: 'b' }),
        wrappers: [
          { stageKey: 'loop', status: 'exhausted', rounds: 5, shards: 0, durationMs: 80 * M },
          { stageKey: 'fan', status: 'done', rounds: 1, shards: 2, durationMs: 3 * M },
        ],
      }),
    ])
    const rows = stageRowsOf({
      stages: [stage('loop', 'wrapper-loop', 0), stage('fan', 'wrapper-fanout', 1)],
      numbers: list,
      loops: new Map([['loop', { maxIterations: 5, continuesAtCap: false }]]),
      now: NOW,
    })
    expect(rows[0]).toMatchObject({
      durationMs: { n: 2, p50: 40 * M, p90: 80 * M, mean: 60 * M },
      loop: {
        roundsMean: 3.5,
        roundsMax: 5,
        maxIterations: 5,
        capRate: 1 / 2,
        capIncludesFullRuns: false,
      },
    })
    expect(rows[1]!.fanout).toEqual({ shardsMean: 3, shardFailureRate: 1 / 2 })
  })

  test('a loop that continues at the cap counts full runs as capped', () => {
    const list = numbers([
      facts({
        wrappers: [{ stageKey: 'loop', status: 'done', rounds: 3, shards: 0, durationMs: 1 }],
      }),
      facts({
        wrappers: [{ stageKey: 'loop', status: 'done', rounds: 1, shards: 0, durationMs: 1 }],
      }),
    ])
    const [row] = stageRowsOf({
      stages: [stage('loop', 'wrapper-loop', 0)],
      numbers: list,
      loops: new Map([['loop', { maxIterations: 3, continuesAtCap: true }]]),
      now: NOW,
    })
    expect(row!.loop).toMatchObject({ capRate: 1 / 2, capIncludesFullRuns: true })
  })

  test('the baseline fills the two compared columns', () => {
    const one = (id: string, activeMs: number, tokens: number) =>
      facts({
        unit: unit({ id }),
        executions: [exec({ stageKey: 'design', activeMs })],
        usage: [{ stageKey: 'design', cause: 'first', tokens, costNano: 0 }],
        usageTotals: usage(tokens),
      })
    const [row] = stageRowsOf({
      stages: [stage('design', 'agent-single', 0)],
      numbers: numbers([one('a', 10 * M, 100)]),
      baseline: numbers([one('x', 30 * M, 500)]),
      now: NOW,
    })
    expect(row!.baseline).toEqual({ durationP50: 30 * M, tokensPerUnit: 500 })
  })
})

describe('RFC-616 comparison', () => {
  test('every current metric is paired with the baseline', () => {
    expect(comparedMetrics({ units: 4, firstPassRate: null }, { units: 2 })).toEqual({
      units: { value: 4, baseline: 2 },
      firstPassRate: { value: null, baseline: null },
    })
    expect(comparedMetrics({ units: 4 }, null)).toEqual({ units: { value: 4, baseline: null } })
  })

  test('the previous window has the same length and ends where this one starts', () => {
    expect(previousWindow(100, 130)).toEqual({ from: 70, to: 100 })
    expect(previousWindow(10, 50)).toEqual({ from: 0, to: 10 })
  })
})

// Found on a freshly installed database (2026-11-26): the first two tasks ever run showed no
// tokens although every one of their calls was recorded. The rule compared a task's start with
// the start of the oldest recorded call, and a task's own first call always starts after the task.
describe('RFC-616 whether a unit has a usage record', () => {
  const calls = (count: number) => ({ ...NO_USAGE, calls: count, tokens: count * 100 })

  test('a unit that started at or after the oldest recorded call has one, with or without calls', () => {
    expect(usageRecorded(50, NO_USAGE, 50)).toBe(true)
    expect(usageRecorded(51, calls(2), 50)).toBe(true)
  })

  test('a unit that started before the oldest recorded call has one when a call of its own is on record', () => {
    // The first task of an installation: its call is the oldest one, a second after it started.
    expect(usageRecorded(49, calls(1), 50)).toBe(true)
  })

  test('a unit with no recorded call that started before the oldest one has none', () => {
    expect(usageRecorded(49, NO_USAGE, 50)).toBe(false)
  })

  test('with no call recorded at all, no unit has one', () => {
    expect(usageRecorded(49, NO_USAGE, null)).toBe(false)
  })
})
