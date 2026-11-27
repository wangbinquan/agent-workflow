// RFC-616 §11 (design/RFC-616-process-metrics/design.md) — the process metrics
// tab of run observation, rendered against a faked server.
//
// Locks what a reader sees and what the page asks the server: the listing of
// the three subject kinds; one subject's views; the comparison and filter
// controls travelling in the URL and the request; per-person detail hidden from
// viewers who may not see it; "not applicable" and "no sample" never shown as
// zero; the unit rows expanding into stages; and the text-theme analysis being
// started by hand and watched until it finishes.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  ProcessEmployeeSummary,
  ProcessHint,
  ProcessInsightView,
  ProcessStageRow,
  ProcessStat,
  ProcessSubjectList,
  ProcessSubjectRow,
  ProcessUnitPage,
  ProcessUnitRow,
  ProcessWorkflowSummary,
  ProcessWorkgroupSummary,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import {
  RunObservability,
  type ObservationSearch,
} from '../src/components/observability/RunObservability'
import { INSIGHT_POLL_MS } from '../src/components/process-metrics/ProcessInsights'
import i18n from '../src/i18n'
import { validateObservationSearch } from '../src/routes/observability'
import { setBaseUrl, setToken } from '../src/stores/auth'

// The canvas and the duty map are heavy, separately tested components. Here they
// are replaced by stand-ins that show exactly what the page hands them.
vi.mock('@/components/canvas/WorkflowCanvas', () => ({
  WorkflowCanvas: (props: {
    surface: string
    readOnly?: boolean
    nodeHeat?: Record<string, { level: number; label: string }>
    onSelect?: (selection: { kind: 'node'; id: string } | null) => void
  }) => (
    <div
      data-testid="canvas-stub"
      data-surface={props.surface}
      data-readonly={String(props.readOnly)}
    >
      {Object.entries(props.nodeHeat ?? {}).map(([id, heat]) => (
        <button
          key={id}
          type="button"
          data-node={id}
          data-heat={heat.level}
          onClick={() => props.onSelect?.({ kind: 'node', id })}
        >
          {id}:{heat.label}
        </button>
      ))}
    </div>
  ),
}))
vi.mock('@/components/digital-employees/EmployeeCapabilityPanorama', () => ({
  EmployeeCapabilityPanorama: (props: {
    type: { workItems: string[] }
    selectedWorkItemRef: string | null
    onSelect: (ref: string) => void
    toolState: (tool: { workItemRef: string }) => { detail: string; heat?: number }
  }) => (
    <div data-testid="duty-map-stub" data-selected={props.selectedWorkItemRef ?? ''}>
      {props.type.workItems.map((ref) => {
        const state = props.toolState({ workItemRef: ref })
        return (
          <button
            key={ref}
            type="button"
            data-item={ref}
            data-heat={state.heat ?? ''}
            onClick={() => props.onSelect(ref)}
          >
            {ref}:{state.detail}
          </button>
        )
      })}
    </div>
  ),
}))

const M = 60_000
const H = 60 * M
const BASE = '/api/observability/process'

const stat = (p50: number | null, p90: number | null = p50, n = 3): ProcessStat => ({
  n: p50 === null ? 0 : n,
  p50,
  p90,
  mean: p50,
})

function subjectRow(over: Partial<ProcessSubjectRow>): ProcessSubjectRow {
  return {
    subjectId: 'wf-1',
    name: '需求到合入',
    units: 48,
    successRate: 0.83,
    leadP50: 9 * H + 40 * M,
    waitShare: 0.64,
    tokensPerUnit: 2_900_000,
    costNanoPerUnit: 41_200_000_000,
    unpriced: false,
    interventionsPerUnit: 4.6,
    firstPassRate: 0.31,
    mode: null,
    roundsPerUnit: null,
    assignmentsPerUnit: null,
    coordinationShare: null,
    mergeRate: null,
    blockedRate: null,
    ...over,
  }
}

function subjectList(over: Partial<ProcessSubjectList>): ProcessSubjectList {
  return {
    asOf: 1,
    from: 0,
    to: 1,
    kind: 'workflow',
    scope: 'all',
    partial: false,
    unitLimit: 5_000,
    items: [],
    ...over,
  }
}

function stage(over: Partial<ProcessStageRow> & { key: string }): ProcessStageRow {
  return {
    label: over.key,
    kind: 'agent-single',
    parentKey: null,
    order: 0,
    removed: false,
    units: 40,
    runsPerUnit: 2.9,
    durationMs: stat(38 * M, 72 * M),
    tokensPerUnit: 820_000,
    costNanoPerUnit: 11_000_000_000,
    tokenShare: 0.28,
    failureRate: 0.04,
    autoRetryRate: 0.06,
    topFailureCode: null,
    topFailureShare: null,
    rejectRate: null,
    clarifyRate: null,
    reworkTokenShare: null,
    gateRoundsPerUnit: null,
    gateWaitMsPerUnit: null,
    gateFirstPassRate: null,
    loop: null,
    fanout: null,
    baseline: null,
    ...over,
  }
}

const definition = {
  $schema_version: 7,
  inputs: [],
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition

const base = {
  asOf: 1,
  from: 0,
  to: 1,
  scope: 'all' as const,
  note: {
    units: 48,
    partial: false,
    unitLimit: 2_000,
    unitsWithoutUsage: 0,
    unitsWithoutRuntime: 0,
    runsWithoutCause: 0,
    usageLowerBound: false,
    unpriced: false,
  },
  identities: [
    { id: 'u-li', username: 'lina', displayName: '李娜' },
    { id: 'u-wang', username: 'wangqiang', displayName: '王强' },
  ],
  compare: { mode: 'off' as const, split: null, baselineUnits: 0 },
  counts: { total: 48, succeeded: 40, failed: 5, canceled: 3, active: 0 },
  time: {
    sampleUnits: 40,
    leadMs: 580 * M,
    autoMs: 162 * M,
    waits: [
      { kind: 'review' as const, ms: 238 * M },
      { kind: 'clarify' as const, ms: 133 * M },
    ],
    otherMs: 47 * M,
  },
  causes: [
    { cause: 'first' as const, tokens: 1_450_000, costNano: 20_000_000_000, durationShare: 0.5 },
    {
      cause: 'review-rework' as const,
      tokens: 840_000,
      costNano: 11_900_000_000,
      durationShare: 0.29,
    },
    {
      cause: 'clarify-rerun' as const,
      tokens: 330_000,
      costNano: 4_000_000_000,
      durationShare: 0.11,
    },
    { cause: 'auto-retry' as const, tokens: 170_000, costNano: 2_000_000_000, durationShare: 0.06 },
    { cause: 'other-rerun' as const, tokens: 60_000, costNano: 800_000_000, durationShare: 0.03 },
    { cause: 'system' as const, tokens: 50_000, costNano: 700_000_000, durationShare: null },
  ],
  interventions: {
    gates: [
      { kind: 'review' as const, perUnit: 2.7 },
      { kind: 'clarify' as const, perUnit: 1.5 },
    ],
    manualRetriesPerUnit: 0.4,
    operationsPerUnit: 0.1,
  },
  trend: [
    {
      week: '2026-10-05',
      units: 6,
      leadP50: 12 * H,
      tokensPerUnit: 3_400_000,
      firstPassRate: 0.22,
    },
    { week: '2026-10-12', units: 0, leadP50: null, tokensPerUnit: null, firstPassRate: null },
    { week: '2026-10-19', units: 9, leadP50: 9 * H, tokensPerUnit: 2_900_000, firstPassRate: 0.31 },
  ],
  stability: {
    failureCodes: [
      { code: 'envelope-missing', runs: 14 },
      { code: 'timeout', runs: 3 },
    ],
    autoRetries: 21,
    interruptions: 2,
    recoveries: 5,
    manualRetries: 7,
    limitCancellations: 1,
    operations: 4,
  },
  hints: [
    {
      id: 'wait-dominant' as const,
      severity: 'high' as const,
      target: 'gates' as const,
      params: { share: 0.64, gate: 'review', gateShare: 0.41 },
    },
    {
      id: 'output-rejected' as const,
      severity: 'high' as const,
      target: 'stages' as const,
      params: { stageKey: 'design', rate: 0.62, rounds: 48 },
    },
    {
      id: 'auto-retry-high' as const,
      severity: 'mid' as const,
      target: 'stages' as const,
      params: { stageKey: 'audit', rate: 0.18, code: 'envelope-missing', codeShare: 0.61 },
    },
    {
      id: 'rework-cost' as const,
      severity: 'info' as const,
      target: 'overview' as const,
      params: { share: 0.29, tokens: 840_000, costNano: 11_900_000_000 },
    },
  ] as ProcessHint[],
  revisions: [
    { revision: 57, units: 30 },
    { revision: 56, units: 18 },
  ],
}

const compared = (value: number | null, baseline: number | null = null) => ({ value, baseline })

function workflowSummary(over: Partial<ProcessWorkflowSummary> = {}): ProcessWorkflowSummary {
  return {
    ...base,
    kind: 'workflow',
    subjectId: 'wf-1',
    subjectName: '需求到合入',
    metrics: {
      units: compared(48),
      successRate: compared(0.83),
      leadP50: compared(580 * M),
      leadP90: compared(31 * H),
      flowEfficiency: compared(0.28),
      tokensPerUnit: compared(2_900_000),
      costNanoPerUnit: compared(41_200_000_000),
      firstPassRate: compared(0.31),
      interventionsPerUnit: compared(4.6),
    },
    origins: [
      { origin: 'manual', units: 40 },
      { origin: 'scheduled', units: 8 },
    ],
    stages: [
      stage({ key: 'design', label: '方案设计', rejectRate: 0.62, clarifyRate: 0.71 }),
      stage({
        key: 'review1',
        label: '方案评审',
        kind: 'review',
        order: 1,
        runsPerUnit: null,
        durationMs: stat(null),
        tokensPerUnit: null,
        costNanoPerUnit: null,
        tokenShare: null,
        failureRate: null,
        autoRetryRate: null,
        gateRoundsPerUnit: 1.9,
        gateWaitMsPerUnit: 185 * M,
        gateFirstPassRate: 0.38,
      }),
      stage({
        key: 'loop',
        label: '实现循环',
        kind: 'wrapper-loop',
        order: 2,
        runsPerUnit: null,
        durationMs: stat(90 * M),
        tokensPerUnit: null,
        tokenShare: null,
        failureRate: null,
        autoRetryRate: null,
        loop: {
          roundsMean: 2.6,
          roundsMax: 5,
          maxIterations: 5,
          capRate: 0.14,
          capIncludesFullRuns: false,
        },
      }),
      stage({
        key: 'audit',
        label: '代码审计',
        parentKey: 'loop',
        order: 3,
        durationMs: stat(22 * M, 51 * M),
        tokensPerUnit: 480_000,
        tokenShare: 0.17,
        failureRate: 0.09,
        autoRetryRate: 0.18,
        topFailureCode: 'envelope-missing',
        topFailureShare: 0.61,
      }),
      stage({
        key: 'system:commit-push',
        label: 'system:commit-push',
        kind: 'system',
        order: 4,
        durationMs: stat(3 * M),
        tokensPerUnit: 120_000,
        tokenShare: 0.04,
      }),
      stage({
        key: 'old-node',
        label: 'old-node',
        kind: 'unattributed',
        removed: true,
        order: 5,
        units: 2,
        tokensPerUnit: 10_000,
        tokenShare: 0.001,
      }),
    ],
    definition,
    review: {
      rounds: 163,
      voidRounds: 4,
      durationMs: stat(185 * M, 860 * M, 163),
      responseMs: stat(40 * M, 3 * H, 20),
      handlingMs: stat(2 * H, 9 * H, 20),
      roundsPerUnit: 3.3,
      firstPassRate: 0.52,
      commentsPerRound: 4.3,
      commentsPerCommenter: 2.6,
      commentersPerRound: 1.7,
      reworkMs: stat(41 * M),
      decisions: { approved: 99, iterated: 51, rejected: 13 },
      commentsByRound: [
        { ordinal: 1, rounds: 50, comments: 320 },
        { ordinal: 2, rounds: 30, comments: 81 },
      ],
      documentAcceptRate: null,
      byStage: [
        {
          stageKey: 'review1',
          relatedStageKey: 'design',
          roundsPerUnit: 1.9,
          durationMs: stat(185 * M, 860 * M),
          commentsPerRound: 4.9,
          firstPassRate: 0.38,
        },
      ],
      people: [
        { userId: 'u-li', decisions: 58, comments: 212, answers: 0, responseP50: 100 * M },
        { userId: 'u-wang', decisions: 41, comments: 96, answers: 0, responseP50: null },
      ],
    },
    clarify: {
      rounds: 72,
      voidRounds: 0,
      triggerRate: 0.71,
      unitsAsking: 34,
      roundsPerUnit: 1.5,
      questionsPerRound: 3.2,
      answerMs: stat(88 * M, 545 * M, 72),
      responseMs: stat(null),
      handlingMs: stat(null),
      stopRate: 0.12,
      answers: { recommended: 58, other: 21, custom: 17, skipped: 4 },
      answersWithRecommendation: 100,
      recommendedRate: 0.58,
      byStage: [{ stageKey: 'clarify', askingStageKey: 'design', roundsPerUnit: 1.5 }],
      people: [{ userId: 'u-li', decisions: 0, comments: 0, answers: 120, responseP50: null }],
    },
    mindmap: null,
    ...over,
  }
}

function workgroupSummary(over: Partial<ProcessWorkgroupSummary> = {}): ProcessWorkgroupSummary {
  return {
    ...base,
    kind: 'workgroup',
    subjectId: 'wg-1',
    subjectName: '支付模块攻坚组',
    mode: 'leader_worker',
    revisions: [],
    hints: [
      {
        id: 'coordination-high',
        severity: 'high',
        target: 'rounds',
        params: { share: 0.22 },
      },
    ],
    time: {
      sampleUnits: 18,
      leadMs: 330 * M,
      autoMs: 155 * M,
      waits: [
        { kind: 'clarify', ms: 30 * M },
        { kind: 'completion', ms: 46 * M },
        { kind: 'delivery', ms: 69 * M },
      ],
      otherMs: 30 * M,
    },
    metrics: {
      units: compared(21),
      successRate: compared(0.86),
      leadP50: compared(330 * M),
      leadP90: compared(13 * H),
      tokensPerUnit: compared(2_660_000),
      roundsPerUnit: compared(6.8),
      roundCapRate: compared(0.05),
      assignmentsPerUnit: compared(14.2),
      coordinationShare: compared(0.22),
      protocolRetryRate: compared(0.06),
    },
    actors: [
      { actor: 'leader', tokens: 580_000, costNano: 8_000_000_000 },
      { actor: 'member', tokens: 1_930_000, costNano: 27_000_000_000 },
      { actor: 'system', tokens: 150_000, costNano: 2_000_000_000 },
    ],
    rounds: [
      {
        round: 1,
        units: 21,
        assignmentsMean: 3.1,
        durationMs: 52 * M,
        tokens: 610_000,
        leaderTokenShare: 0.15,
      },
      {
        round: 2,
        units: 20,
        assignmentsMean: 2.6,
        durationMs: 47 * M,
        tokens: 520_000,
        leaderTokenShare: 0.17,
      },
    ],
    budget: null,
    assignmentSources: { leader: 11.9, human: 1.6, self: 0.7 },
    members: [
      {
        key: 'leader',
        name: 'planner',
        role: 'leader',
        roleNote: null,
        assignmentsPerUnit: null,
        durationMs: stat(6 * M),
        tokensPerUnit: 580_000,
        failureRate: 0.02,
        protocolRetryRate: 0.16,
        clarifyPerUnit: 0.4,
        deliveryMs: stat(null),
      },
      {
        key: 'member:m-a',
        name: 'coder-a',
        role: 'member-agent',
        roleNote: '后端实现',
        assignmentsPerUnit: 5.2,
        durationMs: stat(24 * M),
        tokensPerUnit: 940_000,
        failureRate: 0.08,
        protocolRetryRate: 0.04,
        clarifyPerUnit: 0.6,
        deliveryMs: stat(null),
      },
      {
        key: 'member:m-h',
        name: '张伟',
        role: 'member-human',
        roleNote: '产品把关',
        assignmentsPerUnit: 1.6,
        durationMs: stat(null),
        tokensPerUnit: null,
        failureRate: null,
        protocolRetryRate: null,
        clarifyPerUnit: null,
        deliveryMs: stat(112 * M),
      },
    ],
    human: {
      messagesPerUnit: 2.1,
      directAssignmentsPerUnit: 1.6,
      configChangesPerUnit: 0.2,
      deliveryMs: stat(112 * M),
    },
    completion: {
      rounds: 26,
      waitMs: stat(48 * M, 380 * M, 26),
      rejections: 5,
      rejectRate: 0.19,
      extraRoundsAfterReject: 1.8,
    },
    planConfirm: null,
    clarify: null,
    clarifyByAsker: null,
    ...over,
  }
}

function employeeSummary(over: Partial<ProcessEmployeeSummary> = {}): ProcessEmployeeSummary {
  const label = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })
  return {
    ...base,
    kind: 'digital-employee',
    subjectId: 'emp-1',
    subjectName: '研发数字员工 · Java 后端',
    hints: [],
    counts: { total: 36, succeeded: 28, failed: 4, canceled: 2, active: 2 },
    metrics: {
      units: compared(36),
      successRate: compared(0.82),
      leadP50: compared(30 * H),
      leadP90: compared(70 * H),
      tokensPerUnit: compared(4_100_000),
      costNanoPerUnit: compared(58_300_000_000),
      firstPassRate: compared(0.38),
      mergeRate: compared(0.74),
      blockedRate: compared(0.21),
    },
    typeId: 'type-x',
    typeRevision: 3,
    outcomes: { merged: 25, noChange: 3, otherFinished: 2, failed: 4 },
    cycle: {
      sampleUnits: 25,
      beforeBoundaryMs: 200 * M,
      afterBoundaryMs: 1560 * M,
      waitMs: 350 * M,
      boundaryKey: 'open-mr',
    },
    firstPassApplicable: true,
    regions: [
      {
        regionId: 'delivery',
        label: label('交付一个 MR', 'Deliver an MR'),
        order: 0,
        lanes: [{ laneId: 'main', label: label('主干', 'Main'), order: 0, kind: 'spine' }],
      },
      {
        regionId: 'care',
        label: label('持续看护 MR', 'Look after the MR'),
        order: 1,
        lanes: [
          {
            laneId: 'review',
            label: label('检视意见', 'Review feedback'),
            order: 0,
            kind: 'branch',
          },
        ],
      },
    ],
    workItems: [
      {
        key: 'implement',
        label: label('分析与实现', 'Implement'),
        kind: 'work-item-tool',
        regionId: 'delivery',
        laneId: 'main',
        order: 0,
        rework: false,
        units: 34,
        roundsPerUnit: 1.6,
        roundMs: stat(52 * M, 2 * H),
        attemptsPerRound: 1.2,
        tokensPerUnit: 1_610_000,
        failureRate: 0.09,
        autoRetryRate: 0.16,
        gateRoundsPerUnit: null,
        gateWaitMsPerUnit: null,
      },
      {
        key: 'open-mr',
        label: label('提交 MR', 'Open MR'),
        kind: 'work-item-system',
        regionId: 'delivery',
        laneId: 'main',
        order: 1,
        rework: false,
        units: 30,
        roundsPerUnit: 1,
        roundMs: stat(M),
        attemptsPerRound: 1,
        tokensPerUnit: 0,
        failureRate: 0.02,
        autoRetryRate: 0,
        gateRoundsPerUnit: null,
        gateWaitMsPerUnit: null,
      },
      {
        key: 'repair-feedback',
        label: label('修复检视问题', 'Fix review issues'),
        kind: 'work-item-tool',
        regionId: 'care',
        laneId: 'review',
        order: 2,
        rework: true,
        units: 20,
        roundsPerUnit: 1.9,
        roundMs: stat(27 * M),
        attemptsPerRound: 1,
        tokensPerUnit: 710_000,
        failureRate: 0.06,
        autoRetryRate: 0,
        gateRoundsPerUnit: null,
        gateWaitMsPerUnit: null,
      },
    ],
    review: null,
    feedbackPerUnit: 7.2,
    approvals: { perUnit: 0.3, waitMs: stat(310 * M) },
    blocked: {
      units: 7,
      perUnit: 0.3,
      durationMs: stat(130 * M),
      resumes: 6,
      terminations: 1,
      current: [
        { reason: '外部依赖不可用', units: 1 },
        { reason: '需要补充信息', units: 1 },
      ],
    },
    ...over,
  }
}

function unitRow(over: Partial<ProcessUnitRow> & { unitId: string }): ProcessUnitRow {
  return {
    taskId: over.unitId,
    name: `任务 ${over.unitId}`,
    status: 'succeeded',
    outcome: 'done',
    origin: 'manual',
    ownerUserId: 'u-li',
    revision: 57,
    startedAt: Date.UTC(2026, 10, 24, 9, 12),
    endedAt: Date.UTC(2026, 10, 24, 17, 4),
    leadMs: 472 * M,
    autoMs: 125 * M,
    waits: [
      { kind: 'review', ms: 185 * M },
      { kind: 'clarify', ms: 120 * M },
    ],
    otherMs: 42 * M,
    tokens: 2_400_000,
    costNano: 33_800_000_000,
    usageLowerBound: false,
    unpriced: false,
    gateRounds: [
      { kind: 'review', rounds: 2 },
      { kind: 'clarify', rounds: 1 },
    ],
    autoRetries: 1,
    manualRetries: 1,
    firstPass: false,
    rounds: null,
    assignments: null,
    completionRejections: null,
    capped: false,
    rework: [],
    ...over,
  }
}

const unitPage = (over: Partial<ProcessUnitPage>): ProcessUnitPage => ({
  asOf: 1,
  items: [],
  nextCursor: null,
  identities: base.identities,
  stageLabels: {},
  ...over,
})

const insightView = (over: Partial<ProcessInsightView> = {}): ProcessInsightView => ({
  asOf: 1,
  scope: 'all',
  schedule: 'manual',
  result: null,
  active: null,
  failure: null,
  stale: false,
  ...over,
})

interface Call {
  readonly method: string
  readonly url: URL
  readonly body: unknown
}
const calls: Call[] = []
type Answer = { status?: number; body: unknown }
type Handler = (call: Call) => Answer | Promise<Answer>
const handlers = new Map<string, Handler>()
const on = (method: string, path: string, handler: Handler) =>
  handlers.set(`${method} ${path}`, handler)
const get = (path: string, handler: Handler) => on('GET', path, handler)
const requestsTo = (path: string, method = 'GET') =>
  calls.filter((call) => call.method === method && call.url.pathname === path)
const lastTo = (path: string) => requestsTo(path).at(-1)!

function mount(initial: string) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const url = new URL(String(raw))
    const method = init?.method ?? 'GET'
    const call: Call = {
      method,
      url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    }
    calls.push(call)
    const handler = handlers.get(`${method} ${url.pathname}`)
    if (!handler) throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    const { status = 200, body } = await handler(call)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: '/observability',
    validateSearch: (raw: Record<string, unknown>) => validateObservationSearch(raw),
    component: function Page() {
      const search = page.useSearch() as ObservationSearch
      const navigate = page.useNavigate()
      return (
        <RunObservability search={search} onChange={(next) => void navigate({ search: next })} />
      )
    },
  })
  const task = createRoute({
    getParentRoute: () => root,
    path: '/tasks/$id',
    component: () => <p>Task page</p>,
  })
  const employeeCase = createRoute({
    getParentRoute: () => root,
    path: '/tasks/employee-cases/$caseId',
    component: () => <p>Case page</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page, task, employeeCase]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as AnyRouter} />
    </QueryClientProvider>,
  )
  return router
}

const searchOf = (router: AnyRouter) => router.state.location.search as Record<string, unknown>
const tile = (label: string) => {
  const element = screen
    .getByText(label, { selector: '.metric-tile__label' })
    .closest('.metric-tile')
  if (element === null) throw new Error(`no tile labelled ${label}`)
  return element as HTMLElement
}
const tileValue = (label: string) => tile(label).querySelector('.metric-tile__value')!.textContent
const tileText = (label: string) => tile(label).textContent

beforeEach(async () => {
  setBaseUrl('http://localhost')
  setToken('test-token')
  await i18n.changeLanguage('zh-CN')
  calls.length = 0
  handlers.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setToken('')
})

describe('RFC-616 process tab: the listing', () => {
  test('workflows by default, with a row per workflow and the scope of the numbers', async () => {
    get(`${BASE}/subjects`, () => ({
      body: subjectList({
        items: [
          subjectRow({}),
          subjectRow({
            subjectId: 'wf-gone',
            name: null,
            units: 3,
            waitShare: null,
            firstPassRate: null,
          }),
          subjectRow({ subjectId: null, name: null, units: 1 }),
        ],
      }),
    }))
    mount('/observability?tab=process')
    const table = await screen.findByRole('table', { name: '工作流的过程度量' })
    const request = lastTo(`${BASE}/subjects`)
    expect(request.url.searchParams.get('kind')).toBe('workflow')
    expect(
      Number(request.url.searchParams.get('to')) - Number(request.url.searchParams.get('from')),
    ).toBe(7 * 24 * H)
    const rows = within(table).getAllByRole('row')
    expect(rows[0]!.textContent).toBe(
      '工作流任务成功率总历时中位数等人占比每任务 Token每任务成本人工介入一次通过率',
    )
    expect(rows[1]!.textContent).toBe('需求到合入4883%9 小时 40 分64%2.9M¥41.204.6 次31%')
    // A deleted workflow keeps its numbers; a number without a sample is a dash, never zero.
    expect(rows[2]!.textContent).toBe('已删除的工作流383%9 小时 40 分—2.9M¥41.204.6 次—')
    expect(rows[3]!.textContent).toContain('没有来源工作流的任务')
    expect(screen.getByText('统计范围：全部任务')).toBeTruthy()
    // The process tab is computed on demand and says so.
    expect(screen.getByText(/过程度量不自动刷新/)).toBeTruthy()
  })

  test('switching the kind asks for that kind and shows its own columns', async () => {
    get(`${BASE}/subjects`, (call) => {
      const kind = call.url.searchParams.get('kind')
      if (kind === 'workgroup')
        return {
          body: subjectList({
            kind: 'workgroup',
            scope: 'own',
            items: [
              subjectRow({
                subjectId: 'wg-1',
                name: '支付模块攻坚组',
                units: 21,
                successRate: 0.86,
                leadP50: 330 * M,
                mode: 'leader_worker',
                roundsPerUnit: 6.8,
                assignmentsPerUnit: 14.2,
                coordinationShare: 0.22,
                interventionsPerUnit: 5.1,
              }),
            ],
          }),
        }
      if (kind === 'digital-employee')
        return {
          body: subjectList({
            kind: 'digital-employee',
            partial: true,
            items: [
              subjectRow({
                subjectId: 'emp-1',
                name: '研发数字员工 · Java 后端',
                units: 34,
                leadP50: 30 * H,
                tokensPerUnit: 4_100_000,
                costNanoPerUnit: 58_300_000_000,
                firstPassRate: 0.38,
                mergeRate: 0.74,
                blockedRate: 0.21,
              }),
            ],
          }),
        }
      return { body: subjectList({ items: [] }) }
    })
    const router = mount('/observability?tab=process')
    expect(await screen.findByText('这个时间范围内没有工作流任务')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '工作组' }))
    const groups = await screen.findByRole('table', { name: '工作组的过程度量' })
    expect(searchOf(router).kind).toBe('workgroup')
    expect(within(groups).getAllByRole('row')[1]!.textContent).toBe(
      '支付模块攻坚组Leader 派单2186%5 小时 30 分6.8 轮14.2 张22%5.1 次',
    )
    expect(screen.getByText('统计范围：你发起或参与的任务')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '数字员工' }))
    const employees = await screen.findByRole('table', { name: '数字员工的过程度量' })
    expect(within(employees).getAllByRole('row')[1]!.textContent).toBe(
      '研发数字员工 · Java 后端3474%1 天 6 小时4.1M¥58.3038%21%',
    )
    expect(screen.getByText(/符合条件的交办超过 5000 个/)).toBeTruthy()
  })

  test('opening a row puts the subject in the URL and asks for its summary; back returns to the listing', async () => {
    get(`${BASE}/subjects`, () => ({ body: subjectList({ items: [subjectRow({})] }) }))
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    const router = mount('/observability?tab=process&range=30d')
    fireEvent.click(await screen.findByRole('button', { name: '查看 需求到合入 的度量' }))
    expect(await screen.findByRole('heading', { name: '需求到合入', level: 2 })).toBeTruthy()
    expect(searchOf(router)).toMatchObject({
      tab: 'process',
      kind: 'workflow',
      subject: 'wf-1',
      range: '30d',
    })
    const request = lastTo(`${BASE}/subjects/workflow/wf-1`)
    expect(Object.fromEntries(request.url.searchParams)).toMatchObject({ compare: 'off' })
    expect(request.url.searchParams.has('tzOffset')).toBe(true)
    expect(request.url.searchParams.has('split')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /返回工作流列表/ }))
    expect(await screen.findByRole('table', { name: '工作流的过程度量' })).toBeTruthy()
    expect(searchOf(router).subject).toBeUndefined()
    expect(searchOf(router).kind).toBe('workflow')
  })

  test('choosing the active tab again returns to where the tab starts, keeping the kind and the range', async () => {
    // Regression: choosing the active tab did nothing. On the tasks tab it used to lead from an
    // opened task back to the list; the process tab leads from a subject back to the listing.
    get(`${BASE}/subjects`, () => ({
      body: subjectList({
        kind: 'workgroup',
        items: [subjectRow({ subjectId: 'wg-1', name: '支付模块攻坚组', mode: 'leader_worker' })],
      }),
    }))
    get(`${BASE}/subjects/workgroup/wg-1`, () => ({ body: workgroupSummary() }))
    const router = mount(
      '/observability?tab=process&range=90d&kind=workgroup&subject=wg-1&view=members&compare=period',
    )
    await screen.findByRole('heading', { name: '支付模块攻坚组', level: 2 })
    fireEvent.click(screen.getByRole('tab', { name: '过程度量' }))
    expect(await screen.findByRole('table', { name: '工作组的过程度量' })).toBeTruthy()
    expect(searchOf(router)).toEqual({ tab: 'process', range: '90d', kind: 'workgroup' })
  })

  test('`-` in the URL is the group of units without a source', async () => {
    get(`${BASE}/subjects/workflow/-`, () => ({
      body: workflowSummary({ subjectId: null, subjectName: null }),
    }))
    mount('/observability?tab=process&kind=workflow&subject=-')
    expect(
      await screen.findByRole('heading', { name: '没有来源工作流的任务', level: 2 }),
    ).toBeTruthy()
  })
})

describe('RFC-616 process tab: a workflow', () => {
  const open = (query = '') => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    return mount(`/observability?tab=process&kind=workflow&subject=wf-1${query}`)
  }

  test('the overview: headline numbers, where time and tokens went, stability, the first hints', async () => {
    open()
    await screen.findByRole('heading', { name: '需求到合入', level: 2 })
    expect(tileValue('任务')).toBe('48')
    expect(tileText('任务')).toContain('成功 40 · 失败 5 · 取消 3 · 进行中 0 · 成功率 83%')
    expect(tileValue('总历时（成功任务）')).toBe('9 小时 40 分')
    expect(tileText('总历时（成功任务）')).toContain('P90 为 1 天 7 小时')
    expect(tileValue('流动效率')).toBe('28%')
    expect(tileValue('每任务 Token')).toBe('2.9M')
    expect(tileText('每任务 Token')).toContain('成本 ¥41.20')
    expect(tileValue('一次通过率')).toBe('31%')
    expect(tileValue('人工介入')).toBe('4.6 次 / 任务')
    // The last figure counts resumes, repairs, workflow syncs and cancels: the label says so.
    expect(tileText('人工介入')).toContain(
      '评审 2.7 · 反问 1.5 · 人工重试 0.4 · 续跑、修复、同步与取消 0.1',
    )
    // No comparison is on, so no tile carries a change line.
    expect(document.querySelector('.metric-tile__delta')).toBeNull()

    const time = screen.getByRole('group', { name: '时间花在哪里' })
    expect(
      within(time)
        .getAllByRole('button')
        .map((part) => part.getAttribute('aria-label')),
    ).toEqual([
      '自动执行: 2 小时 42 分 · 28%',
      '等待评审: 3 小时 58 分 · 41%',
      '等待反问回答: 2 小时 13 分 · 23%',
      '排队与中断: 47 分钟 · 8%',
    ])
    // Four causes get a colour; other reruns and system work are one muted part…
    const tokens = screen.getByRole('group', { name: 'Token 花在哪里' })
    expect(
      within(tokens)
        .getAllByRole('button')
        .map((part) => part.getAttribute('aria-label')),
    ).toEqual([
      '首次执行: 1.45M · 50%',
      '评审返工: 840K · 29%',
      '反问后续跑: 330K · 11%',
      '失败重试: 170K · 6%',
      '其它重跑与系统工作: 110K · 4%',
    ])
    // …and the table under the bar lists every cause on its own.
    const causes = screen.getByRole('table', { name: 'Token 按执行原因' })
    expect(
      within(causes)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      '原因Token成本占执行时长',
      '首次执行1.45M¥20.0050%',
      '评审返工840K¥11.9029%',
      '反问后续跑330K¥4.0011%',
      '失败重试170K¥2.006%',
      '其它重跑（连带、恢复续跑）60K¥0.803%',
      '系统工作50K¥0.70—',
    ])

    expect(tileValue('自动重试')).toBe('21')
    expect(tileValue('因超限被取消')).toBe('1')
    const codes = screen.getByRole('table', { name: '主要失败码' })
    expect(within(codes).getAllByRole('row')[1]!.textContent).toBe('envelope-missing14')

    // Three of the four hints, most severe first, written out with their numbers.
    const hints = [...document.querySelectorAll('.process-hint')]
    expect(hints.map((hint) => hint.getAttribute('data-hint'))).toEqual([
      'wait-dominant',
      'output-rejected',
      'auto-retry-high',
    ])
    expect(hints[0]!.textContent).toContain('优先处理')
    expect(hints[0]!.textContent).toContain('等人时间占总历时的 64%')
    expect(hints[0]!.textContent).toContain('其中等待评审占 41%。')
    expect(hints[1]!.textContent).toContain('方案设计的产出有 62% 被打回')
    expect(hints[2]!.textContent).toContain('代码审计的自动重试率 18%')
    expect(hints[2]!.textContent).toContain('主要失败码是 envelope-missing，占这个环节失败的 61%。')
  })

  test('the trend shows one metric at a time, with its data table', async () => {
    open()
    await screen.findByRole('heading', { name: '需求到合入', level: 2 })
    const lead = screen.getByRole('table', { name: '趋势 · 总历时中位数' })
    expect(
      within(lead)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['周（起始日）总历时中位数', '10-0512 小时 0 分', '10-12—', '10-199 小时 0 分'])
    fireEvent.click(screen.getByRole('radio', { name: '一次通过率' }))
    const rate = await screen.findByRole('table', { name: '趋势 · 一次通过率' })
    expect(within(rate).getAllByRole('row')[3]!.textContent).toBe('10-1931%')
  })

  test('a hint leads to the view it is about', async () => {
    const router = open()
    await screen.findByRole('heading', { name: '需求到合入', level: 2 })
    fireEvent.click(screen.getByRole('button', { name: '去看：人工介入' }))
    await waitFor(() => expect(searchOf(router).view).toBe('gates'))
    expect(await screen.findByText('一轮 = 一版内容就绪到作出决定')).toBeTruthy()
    // Switching views does not ask the server again: every view reads the same summary.
    expect(requestsTo(`${BASE}/subjects/workflow/wf-1`)).toHaveLength(1)
  })

  test('comparison and the origin filter travel in the URL and in the request', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, (call) => {
      const mode = call.url.searchParams.get('compare')
      const summary = workflowSummary()
      return {
        body:
          mode === 'off'
            ? summary
            : {
                ...summary,
                compare: {
                  mode,
                  split: mode === 'version' ? Number(call.url.searchParams.get('split')) : null,
                  baselineUnits: 18,
                },
                metrics: {
                  ...summary.metrics,
                  units: compared(48, 44),
                  leadP50: compared(580 * M, 674 * M),
                  tokensPerUnit: compared(2_900_000, 2_500_000),
                },
              },
      }
    })
    const router = mount('/observability?tab=process&kind=workflow&subject=wf-1')
    await screen.findByRole('heading', { name: '需求到合入', level: 2 })
    fireEvent.click(screen.getByRole('radio', { name: '对比上一时段' }))
    await waitFor(() => expect(searchOf(router).compare).toBe('period'))
    await waitFor(() =>
      expect(tileText('总历时（成功任务）')).toContain('降 14% · 较上一时段（变好）'),
    )
    expect(tileText('每任务 Token')).toContain('升 16% · 较上一时段（变差）')
    // More units is not "better" or "worse".
    expect(tileText('任务')).toContain('升 9% · 较上一时段')
    expect(tileText('任务')).not.toContain('变好')
    expect(screen.getByText('对比的是紧邻的上一个等长时段，共 18 个任务。')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: '以版本为分界' }))
    await waitFor(() => expect(searchOf(router)).toMatchObject({ compare: 'version', split: 57 }))
    await waitFor(() =>
      expect(lastTo(`${BASE}/subjects/workflow/wf-1`).url.searchParams.get('split')).toBe('57'),
    )
    expect(await screen.findByText('分界之前的版本共 18 个任务，作为对比基线。')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: '不对比' }))
    await waitFor(() => expect(searchOf(router).compare).toBeUndefined())
    expect(searchOf(router).split).toBeUndefined()
  })

  test('a deep link restores the comparison, the split and the origin filter', async () => {
    open('&compare=version&split=56&origin=scheduled&view=stages')
    await screen.findByRole('heading', { name: '需求到合入', level: 2 })
    expect(
      Object.fromEntries(lastTo(`${BASE}/subjects/workflow/wf-1`).url.searchParams),
    ).toMatchObject({
      compare: 'version',
      split: '56',
      origin: 'scheduled',
    })
    expect(screen.getByRole('tab', { name: '阶段分析' }).getAttribute('aria-selected')).toBe('true')
  })

  test('what the statistics do not cover is said in words', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({
      body: workflowSummary({
        scope: 'own',
        note: {
          units: 2_000,
          partial: true,
          unitLimit: 2_000,
          unitsWithoutUsage: 2,
          unitsWithoutRuntime: 1,
          runsWithoutCause: 9,
          usageLowerBound: true,
          unpriced: true,
        },
      }),
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1')
    await screen.findByRole('heading', { name: '需求到合入', level: 2 })
    expect(screen.getByText(/符合条件的任务超过 2000 个，统计只包含最近的 2000 个/)).toBeTruthy()
    const note = screen.getByText(/^数据说明：/).textContent
    expect(note).toContain(
      '有 2 个任务开始于最早的调用记录之前，自己也没有调用记录，不进 Token 统计。',
    )
    expect(note).toContain('有 1 个任务没有运行时长记录，不进时间拆分。')
    expect(note).toContain('有 9 次执行没有记录原因，按首次执行计。')
    expect(note).toContain('部分调用的用量不完整，Token 合计是下界。')
    expect(note).toContain('部分调用没有定价，成本合计是下界。')
    expect(note).toContain('进行中的任务只在明细里列出，不进统计。')
    expect(screen.getByText(/统计范围：你发起或参与的任务/)).toBeTruthy()
  })

  test('stage analysis: the canvas is coloured by the chosen metric and a node shows all of its numbers', async () => {
    open('&view=stages')
    const canvas = await screen.findByTestId('canvas-stub')
    expect(canvas.getAttribute('data-surface')).toBe('task')
    expect(canvas.getAttribute('data-readonly')).toBe('true')
    // Running time: design 38 min, audit 22 min; the loop spans 90 min. Platform work and removed nodes are not on the canvas.
    expect([...canvas.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      'design:38 分钟',
      'loop:1 小时 30 分',
      'audit:22 分钟',
    ])
    expect(canvas.querySelector('[data-node="loop"]')!.getAttribute('data-heat')).toBe('5')
    // Regression: the scale once named 3 minutes, the running time of "commit and push" — platform
    // work that is not on the canvas. Its two ends name what the canvas draws.
    expect(screen.getByText('低 22 分钟')).toBeTruthy()
    expect(screen.queryByText('低 3 分钟')).toBeNull()
    expect(screen.getByText('高 1 小时 30 分')).toBeTruthy()
    // Until a node is picked, the one that stands out most is described.
    expect(screen.getByRole('heading', { name: '所选节点 · 实现循环' })).toBeTruthy()

    fireEvent.click(canvas.querySelector('[data-node="audit"]')!)
    expect(await screen.findByRole('heading', { name: '所选节点 · 代码审计' })).toBeTruthy()
    const facts = document.querySelector('.process-facts')!.textContent
    expect(facts).toContain('执行时长（中位 / P90）22 分钟 / 51 分钟')
    expect(facts).toContain('Token480K · 占 17%')
    expect(facts).toContain('失败率9%（主要是 envelope-missing，占 61%）')
    expect(facts).toContain('自动重试率18%')

    fireEvent.click(screen.getByRole('radio', { name: '被打回率' }))
    await waitFor(() =>
      expect(
        [...screen.getByTestId('canvas-stub').querySelectorAll('button')].map(
          (node) => node.textContent,
        ),
      ).toEqual(['design:62%']),
    )
    fireEvent.click(screen.getByRole('radio', { name: '等人时长' }))
    await waitFor(() =>
      expect(screen.getByTestId('canvas-stub').textContent).toBe('review1:3 小时 5 分'),
    )
  })

  test('stage analysis as a table: wrappers are group rows, platform work is named, removed nodes are marked', async () => {
    open('&view=stages')
    await screen.findByTestId('canvas-stub')
    fireEvent.click(screen.getByRole('radio', { name: '表格' }))
    const table = await screen.findByRole('table', { name: '各节点指标' })
    const rows = within(table)
      .getAllByRole('row')
      .map((row) => row.textContent)
    expect(rows[1]).toBe('方案设计Agent2.938 分钟 / 1 小时 12 分820K28%4%6%62%71%—')
    expect(rows[2]).toBe(
      '方案评审评审——————1.9 轮 · 等人 3 小时 5 分'.replace('——————', '—'.repeat(8)),
    )
    expect(rows[3]).toBe(
      '循环 · 实现循环 平均 2.6 轮 · 最多 5 轮 · 上限 5 轮 · 触顶 14% · 每次历时中位数 1 小时 30 分',
    )
    expect(rows[4]).toContain('代码审计Agent')
    expect(rows[5]).toContain('提交与推送平台工作')
    expect(rows[6]).toContain('old-node （已从工作流移除）未归属')
    expect(within(table).getAllByRole('rowheader')[3]!.className).toBe('process-metrics__indent')
    expect(screen.queryByTestId('canvas-stub')).toBeNull()
  })

  test('without a readable definition the canvas gives way to the table', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary({ definition: null }) }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=stages')
    expect(await screen.findByText(/工作流定义读不出来，画布不显示/)).toBeTruthy()
    expect(screen.queryByTestId('canvas-stub')).toBeNull()
    expect(screen.getByRole('table', { name: '各节点指标' })).toBeTruthy()
  })

  test('human steps: reviews and questions, with per-person rows for those who may see them', async () => {
    open('&view=gates')
    await screen.findByText('一轮 = 一版内容就绪到作出决定')
    expect(tileValue('评审时长')).toBe('3 小时 5 分')
    expect(tileText('评审时长')).toContain('P90 为 14 小时 20 分')
    expect(tileValue('首轮通过率')).toBe('52%')
    expect(tileValue('每任务评审轮次')).toBe('3.3')
    expect(tileValue('每轮意见数')).toBe('4.3')
    expect(tileText('每轮意见数')).toContain('人均 2.6 条（每轮 1.7 人提意见）')
    expect(tileValue('返工耗时')).toBe('41 分钟')
    const decisions = screen.getByRole('group', { name: '决定分布' })
    expect(
      within(decisions)
        .getAllByRole('button')
        .map((part) => part.getAttribute('aria-label')),
    ).toEqual(['通过: 99 次 · 61%', '迭代（带意见重做）: 51 次 · 31%', '退回: 13 次 · 8%'])
    // Comments per round: 320 over 50 rounds, then 81 over 30.
    const convergence = screen.getByRole('group', { name: '意见数随轮次收敛' })
    expect(
      within(convergence)
        .getAllByRole('button')
        .map((bar) => bar.getAttribute('aria-label')),
    ).toEqual(['第 1 轮: 6.4 · 50 轮评审', '第 2 轮: 2.7 · 30 轮评审'])
    expect(screen.getByText('另有 4 轮被作废（上游刷新或连带退回），只计入等人时间。')).toBeTruthy()
    const byStage = screen.getByRole('table', { name: '按评审节点' })
    expect(within(byStage).getAllByRole('row')[1]!.textContent).toBe(
      '方案评审方案设计1.93 小时 5 分 / 14 小时 20 分4.938%',
    )
    const people = screen.getAllByRole('table', { name: '按人' })
    expect(
      within(people[0]!)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      '成员作出决定提出意见响应时长中位数',
      '李娜@lina582121 小时 40 分',
      '王强@wangqiang4196—',
    ])

    expect(tileValue('触发率')).toBe('71%')
    expect(tileValue('选择“停止反问”')).toBe('12%')
    const answers = screen.getByRole('group', { name: '回答是怎么给的' })
    expect(within(answers).getAllByRole('button')[0]!.getAttribute('aria-label')).toBe(
      '采纳推荐项: 58 个问题 · 58%',
    )
    expect(screen.getByText(/带推荐项的问题里，采纳推荐项的占 58%。/)).toBeTruthy()
    // No mind map was used: the card is not shown at all.
    expect(screen.queryByRole('heading', { name: '脑图' })).toBeNull()
  })

  test('a viewer who may not see per-person detail gets the averages and a notice', async () => {
    const summary = workflowSummary({ scope: 'own', identities: [] })
    get(`${BASE}/subjects/workflow/wf-1`, () => ({
      body: {
        ...summary,
        review: { ...summary.review!, people: null },
        clarify: { ...summary.clarify!, people: null },
      },
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=gates')
    await screen.findByText('一轮 = 一版内容就绪到作出决定')
    expect(screen.queryByRole('table', { name: '按人' })).toBeNull()
    expect(
      screen.getAllByText('按人的明细只对管理者和管理员显示。你看到的是上面的人均值。'),
    ).toHaveLength(2)
    expect(tileText('每轮意见数')).toContain('人均 2.6 条')
  })

  test('a workflow without human gates says so', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({
      body: workflowSummary({ review: null, clarify: null, mindmap: null }),
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=gates')
    expect(await screen.findByText('这个时间范围内没有人工门')).toBeTruthy()
  })

  test('mind maps have their own card when they were used', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({
      body: workflowSummary({
        mindmap: {
          maps: 51,
          depthMean: 1.8,
          depthMax: 4,
          mapsPerNode: 1.5,
          followupsPerMap: 2.3,
          questionsPerMap: 7.4,
          initialQuestionsPerMap: 4.1,
          followupQuestionsPerMap: 3.3,
          durationMs: stat(88 * M),
          followupGenerationMs: 38_000,
          followupGenerationTokens: 21_000,
          maturity: { decided: 64, provisional: 22, unmarked: 10, skipped: 4 },
          categoryCoverage: 0.86,
        },
      }),
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=gates')
    await screen.findByRole('heading', { name: '脑图' })
    expect(tileValue('平均深度')).toBe('1.8 层')
    expect(tileText('平均深度')).toContain('最大 4 层')
    expect(tileValue('追问生成')).toBe('38 秒')
    expect(tileText('追问生成')).toContain('约 21K Token')
    expect(tileText('问题数')).toContain('初始 4.1 · 追问生成 3.3')
    expect(screen.getByText('预设分类覆盖率 86%：配置的分类里，有问题落入的占比。')).toBeTruthy()
  })
})

describe('RFC-616 process tab: a workgroup', () => {
  const open = (query = '', summary = workgroupSummary()) => {
    get(`${BASE}/subjects/workgroup/wg-1`, () => ({ body: summary }))
    return mount(`/observability?tab=process&kind=workgroup&subject=wg-1${query}`)
  }

  test('the overview: rounds, cards, coordination; tokens by who spent them; no version split', async () => {
    open()
    await screen.findByRole('heading', { name: '支付模块攻坚组', level: 2 })
    expect(screen.getByText(/工作组 · Leader 派单/)).toBeTruthy()
    expect(tileValue('轮数')).toBe('6.8 轮')
    expect(tileText('轮数')).toContain('触顶 5%')
    expect(tileValue('派单')).toBe('14.2 张 / 任务')
    expect(tileText('派单')).toContain('Leader 派 11.9 · 人直接派 1.6 · 自领 0.7')
    expect(tileValue('协调开销')).toBe('22%')
    expect(tileValue('协议重试率')).toBe('6%')
    const tokens = screen.getByRole('group', { name: 'Token 花在哪里' })
    expect(
      within(tokens)
        .getAllByRole('button')
        .map((part) => part.getAttribute('aria-label')),
    ).toEqual([
      'Leader（协调）: 580K · 22%',
      '成员（执行派单）: 1.93M · 73%',
      '系统工作（合并冲突、提交、记忆提取等）: 150K · 6%',
    ])
    // Five kinds of time, four colours: nothing repeats a colour.
    const time = screen.getByRole('group', { name: '时间花在哪里' })
    const fills = within(time)
      .getAllByRole('button')
      .map((part) => part.className.replace('segbar__seg ', ''))
    expect(fills).toEqual([
      'viz-fill--cat-1',
      'viz-fill--cat-3',
      'viz-fill--cat-4',
      'viz-fill--cat-2',
      'viz-fill--other',
    ])
    expect(screen.queryByRole('radio', { name: /为分界/ })).toBeNull()
    expect(screen.getByRole('radio', { name: '对比上一时段' })).toBeTruthy()
  })

  test('rounds: cards per round as a chart and a table', async () => {
    open('&view=rounds')
    const chart = await screen.findByRole('group', { name: '每轮派单数' })
    expect(
      within(chart)
        .getAllByRole('button')
        .map((bar) => bar.getAttribute('aria-label')),
    ).toEqual(['第 1 轮: 3.1 张 · 21 个任务跑到这一轮', '第 2 轮: 2.6 张 · 20 个任务跑到这一轮'])
    const table = screen.getByRole('table', { name: '按轮次' })
    expect(within(table).getAllByRole('row')[1]!.textContent).toBe('第 1 轮213.152 分钟610K15%')
  })

  test('a mode without leader rounds says what stands in for them', async () => {
    open(
      '&view=rounds',
      workgroupSummary({
        mode: 'free_collab',
        rounds: [],
        budget: { usedMean: 22.4, limitMean: 40 },
      }),
    )
    expect(await screen.findByText(/自由协作模式没有 Leader 轮次/)).toBeTruthy()
    expect(tileValue('已用')).toBe('22.4')
    expect(tileValue('上限')).toBe('40')
    expect(screen.queryByRole('group', { name: '每轮派单数' })).toBeNull()
  })

  test('a range in which the group ran nothing shows no rounds and names no mode', async () => {
    // Regression: a null mode fell into the free-collaboration branch and said so.
    open('&view=rounds', workgroupSummary({ mode: null, rounds: [], budget: null }))
    expect(await screen.findByText('这个时间范围内没有工作组任务')).toBeTruthy()
    expect(screen.queryByText(/自由协作模式/)).toBeNull()
    expect(screen.queryByText(/动态工作流模式/)).toBeNull()
    // The group keeps its name; the line under it names no mode.
    expect(screen.getByRole('heading', { name: '支付模块攻坚组', level: 2 })).toBeTruthy()
    expect(screen.queryByText(/工作组 · Leader 派单/)).toBeNull()
  })

  test('members: each column is coloured on its own scale and a person is never ranked with agents', async () => {
    open('&view=members')
    const table = await screen.findByRole('table', { name: '成员 × 指标' })
    const rows = within(table).getAllByRole('row')
    expect(rows.map((row) => row.textContent)).toEqual([
      '成员角色接单执行时长（中位）Token失败率协议重试率反问',
      'plannerLeader—6 分钟580K2%16%0.4',
      'coder-aAgent 成员 · 后端实现5.224 分钟940K8%4%0.6',
      '张伟人类成员 · 产品把关1.6交付 1 小时 52 分————',
    ])
    const cells = (row: number) =>
      [...rows[row]!.querySelectorAll('td')].slice(1).map((cell) => cell.className)
    // The leader takes no cards; its running time is the shortest, its retry rate the highest.
    expect(cells(1)).toEqual([
      'viz-num',
      'viz-num viz-heat--1',
      'viz-num viz-heat--1',
      'viz-num viz-heat--1',
      'viz-num viz-heat--5',
      'viz-num viz-heat--1',
    ])
    expect(cells(2)[0]).toBe('viz-num viz-heat--5')
    // The person's delivery time carries no colour.
    expect(cells(3)).toEqual([
      'viz-num viz-heat--1',
      'viz-num',
      'viz-num',
      'viz-num',
      'viz-num',
      'viz-num',
    ])
  })

  test('human steps: messages, deliveries and the completion confirmation', async () => {
    open('&view=gates')
    await screen.findByRole('heading', { name: '人的介入' })
    expect(tileValue('人发的消息')).toBe('2.1')
    expect(tileValue('人类成员交付时长')).toBe('1 小时 52 分')
    expect(tileValue('驳回率')).toBe('19%')
    expect(tileText('驳回率')).toContain('5 次驳回 / 26 次确认')
    expect(tileValue('驳回后多跑')).toBe('1.8 轮')
    expect(screen.queryByRole('heading', { name: '方案确认' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '反问' })).toBeNull()
  })
})

describe('RFC-616 process tab: a digital employee', () => {
  const open = (query = '', summary = employeeSummary()) => {
    get(`${BASE}/subjects/digital-employee/emp-1`, () => ({ body: summary }))
    return mount(`/observability?tab=process&kind=digital-employee&subject=emp-1${query}`)
  }

  test('the overview: outcomes, the merge rate and where the delivery time goes', async () => {
    open()
    await screen.findByRole('heading', { name: '研发数字员工 · Java 后端', level: 2 })
    expect(tileValue('交办')).toBe('36')
    expect(tileText('交办')).toContain('已合入 25 · 无需修改 3 · 其他结束 2 · 执行失败 4')
    expect(tileText('交办')).toContain('进行中 2')
    expect(tileValue('合入率')).toBe('74%')
    expect(tileValue('交付周期')).toBe('1 天 6 小时')
    expect(tileValue('每次交办 Token')).toBe('4.1M')
    expect(tileValue('一次通过率')).toBe('38%')
    expect(tileValue('阻塞率')).toBe('21%')
    const outcomes = screen.getByRole('group', { name: '交办的结局' })
    expect(
      within(outcomes)
        .getAllByRole('button')
        .map((part) => part.getAttribute('aria-label')),
    ).toEqual([
      '已合入: 25 次 · 74%',
      '无需修改: 3 次 · 9%',
      '其他结束: 2 次 · 6%',
      '执行失败: 4 次 · 12%',
    ])
    const cycle = screen.getByRole('group', { name: '交付周期花在哪里' })
    expect(
      within(cycle)
        .getAllByRole('button')
        .map((part) => part.getAttribute('aria-label')),
    ).toEqual(['交办到“提交 MR”: 3 小时 20 分 · 11%', '“提交 MR”到合入: 1 天 2 小时 · 89%'])
    expect(screen.getByText('已合入交办的中位数（25 个样本）；其中等人 5 小时 50 分')).toBeTruthy()
    expect(screen.getByRole('radio', { name: '以员工修订为分界' })).toBeTruthy()
  })

  test('a type that declares no rework has no first-pass rate, in words rather than as zero', async () => {
    open(
      '',
      employeeSummary({
        firstPassApplicable: false,
        feedbackPerUnit: null,
        metrics: { ...employeeSummary().metrics, firstPassRate: compared(null) },
      }),
    )
    await screen.findByRole('heading', { name: '研发数字员工 · Java 后端', level: 2 })
    expect(tileValue('一次通过率')).toBe('不适用')
    expect(tileText('一次通过率')).toContain('这名员工所属的分类没有声明返工类工作项')
    // The trend offers no first-pass metric either.
    expect(screen.queryByRole('radio', { name: '一次通过率' })).toBeNull()
  })

  test("the duty map is the employee type's own, coloured by the chosen metric", async () => {
    get('/api/digital-employee-types/type-x%403', () => ({
      body: { workItems: ['implement', 'open-mr', 'repair-feedback'] },
    }))
    open('&view=duties')
    const map = await screen.findByTestId('duty-map-stub')
    // Time per round: 52 min, 1 min, 27 min.
    expect(
      [...map.querySelectorAll('button')].map((item) => [
        item.textContent,
        item.getAttribute('data-heat'),
      ]),
    ).toEqual([
      ['implement:52 分钟', '5'],
      ['open-mr:1 分钟', '1'],
      ['repair-feedback:27 分钟', '3'],
    ])
    expect(map.getAttribute('data-selected')).toBe('implement')
    expect(screen.getByRole('heading', { name: '所选工作项 · 分析与实现' })).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Token' }))
    await waitFor(() =>
      expect(
        [...screen.getByTestId('duty-map-stub').querySelectorAll('button')].map((item) => [
          item.textContent,
          item.getAttribute('data-heat'),
        ]),
      ).toEqual([
        ['implement:1.61M', '5'],
        // A system work item spends no tokens: not applicable, so no colour.
        ['open-mr:—', ''],
        ['repair-feedback:710K', '1'],
      ]),
    )
    fireEvent.click(
      screen.getByTestId('duty-map-stub').querySelector('[data-item="repair-feedback"]')!,
    )
    expect(await screen.findByRole('heading', { name: '所选工作项 · 修复检视问题' })).toBeTruthy()
    expect(document.querySelector('.process-facts')!.textContent).toContain('类别返工类工作项')

    const table = screen.getByRole('table', { name: '各工作项指标' })
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      '工作项泳道 · 执行者轮数每轮时长Token失败率人工门',
      '交付一个 MR',
      '分析与实现主干 · 工具1.652 分钟 / 2 小时 0 分1.61M9%—',
      // Median and P90 are both printed, also when they are equal.
      '提交 MR主干 · 平台11 分钟 / 1 分钟02%—',
      '持续看护 MR',
      '修复检视问题 （返工类）检视意见 · 工具1.927 分钟 / 27 分钟710K6%—',
    ])
  })

  test('when the type cannot be read the table still carries every number', async () => {
    get('/api/digital-employee-types/type-x%403', () => ({
      status: 403,
      body: { code: 'forbidden', message: 'no' },
    }))
    open('&view=duties')
    expect(await screen.findByText(/职责图读不出来/)).toBeTruthy()
    expect(screen.queryByTestId('duty-map-stub')).toBeNull()
    expect(screen.getByRole('table', { name: '各工作项指标' })).toBeTruthy()
  })

  test('human steps: feedback, approvals and blocks; a type without feedback says so', async () => {
    open('&view=gates')
    await screen.findByRole('heading', { name: 'MR 上的人工介入' })
    expect(tileValue('人提的检视意见')).toBe('7.2 条 / 交办')
    expect(tileValue('外部审批')).toBe('0.3 次 / 交办')
    expect(tileText('外部审批')).toContain('等待中位数 5 小时 10 分')
    expect(tileValue('阻塞时长')).toBe('2 小时 10 分')
    expect(tileValue('人工恢复')).toBe('6')
    const reasons = screen.getByRole('table', { name: '当前仍在阻塞的交办：原因' })
    expect(
      within(reasons)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['当前仍在阻塞的交办：原因交办占比', '外部依赖不可用150%', '需要补充信息150%'])
    cleanup()
    handlers.clear()
    open('&view=gates', employeeSummary({ feedbackPerUnit: null }))
    await screen.findByRole('heading', { name: 'MR 上的人工介入' })
    expect(tileValue('人提的检视意见')).toBe('不适用')
  })

  test('a plan review is tabled by work item, in the words of an assignment', async () => {
    // Regression: the table spoke of "review nodes", "reviewed nodes" and "rounds per task".
    const review = workflowSummary().review!
    open(
      '&view=gates',
      employeeSummary({
        review: {
          ...review,
          byStage: [{ ...review.byStage[0]!, stageKey: 'implement', relatedStageKey: 'implement' }],
        },
      }),
    )
    await screen.findByRole('heading', { name: '方案审核' })
    const table = screen.getByRole('table', { name: '按工作项' })
    const [head, row] = within(table).getAllByRole('row')
    expect(
      within(head!)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['工作项', '每次交办轮次', '评审时长（中位 / P90）', '每轮意见数', '首轮通过率'])
    expect(within(row!).getByRole('rowheader').textContent).toBe('分析与实现')
    expect(screen.queryByText('被评审的节点')).toBeNull()
  })
})

describe('RFC-616 process tab: units', () => {
  test('tasks newest first, filtered by outcome, expanding into their stages, loaded page by page', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    get(`${BASE}/subjects/workflow/wf-1/units`, (call) => {
      const cursor = call.url.searchParams.get('cursor')
      const status = call.url.searchParams.get('status')
      if (status === 'unsuccessful')
        return {
          body: unitPage({
            items: [
              unitRow({
                unitId: 't-failed',
                name: '对账文件解析容错',
                status: 'failed',
                outcome: 'failed',
              }),
            ],
          }),
        }
      return cursor === null
        ? {
            body: unitPage({
              items: [
                unitRow({ unitId: 't-1', name: '订单导出支持异步分片' }),
                unitRow({
                  unitId: 't-2',
                  name: '消息推送限流',
                  status: 'active',
                  outcome: 'running',
                  ownerUserId: 'u-wang',
                  origin: 'scheduled',
                  endedAt: null,
                  autoMs: null,
                  otherMs: null,
                  waits: [],
                  usageLowerBound: true,
                  firstPass: null,
                }),
              ],
              nextCursor: 'next-1',
            }),
          }
        : {
            body: unitPage({
              items: [unitRow({ unitId: 't-3', name: '发票抬头校验', origin: 'subtask' })],
            }),
          }
    })
    get(`${BASE}/units/workflow/t-1`, () => ({
      body: {
        asOf: 1,
        unit: unitRow({ unitId: 't-1' }),
        identities: [],
        stages: [
          {
            key: 'design',
            label: '方案设计',
            kind: 'agent-single',
            parentKey: null,
            removed: false,
            runs: 3,
            failedRuns: 1,
            autoRetries: 1,
            durationMs: 38 * M,
            tokens: 820_000,
            gateRounds: 0,
            gateWaitMs: 0,
            comments: 0,
            questions: 0,
          },
          {
            key: 'review1',
            label: '方案评审',
            kind: 'review',
            parentKey: null,
            removed: false,
            runs: 0,
            failedRuns: 0,
            autoRetries: 0,
            durationMs: 0,
            tokens: 0,
            gateRounds: 2,
            gateWaitMs: 185 * M,
            comments: 9,
            questions: 0,
          },
        ],
      },
    }))
    const router = mount('/observability?tab=process&kind=workflow&subject=wf-1&view=units')
    const table = await screen.findByRole('table', { name: '任务明细' })
    const rows = () => within(table).getAllByRole('row')
    expect(rows()[0]!.textContent).toBe(
      '展开任务状态来源发起人开始总历时时间构成Token成本评审轮次反问轮次重试',
    )
    expect(rows()[1]!.textContent).toContain('订单导出支持异步分片')
    expect(rows()[1]!.textContent).toContain('手动李娜@lina')
    expect(rows()[1]!.textContent).toContain('7 小时 52 分')
    expect(rows()[1]!.textContent).toContain('2.4M¥33.80212')
    expect(within(rows()[1]!).getByRole('img').getAttribute('aria-label')).toBe(
      '时间构成: 自动执行 26%, 等待评审 39%, 等待反问回答 25%, 排队与中断 9%',
    )
    // A running task is listed; what it has no record of is said, not drawn as zero.
    expect(rows()[2]!.textContent).toContain('没有运行时长记录')
    expect(rows()[2]!.textContent).toContain('定时')
    expect(
      within(rows()[1]!).getByRole('link', { name: '订单导出支持异步分片' }).getAttribute('href'),
    ).toBe('/tasks/t-1')

    fireEvent.click(screen.getByRole('button', { name: '展开 订单导出支持异步分片 的各环节' }))
    await waitFor(() => expect(searchOf(router).unit).toBe('t-1'))
    const stages = await screen.findByRole('table', { name: '各环节' })
    expect(
      within(stages)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      '环节执行次数时长Token备注',
      '方案设计338 分钟820K失败 1 次 · 自动重试 1 次',
      '方案评审———2 轮人工门 · 等人 3 小时 5 分 · 9 条意见',
    ])
    fireEvent.click(screen.getByRole('button', { name: '收起 订单导出支持异步分片 的各环节' }))
    await waitFor(() => expect(searchOf(router).unit).toBeUndefined())

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('发票抬头校验')).toBeTruthy()
    expect(lastTo(`${BASE}/subjects/workflow/wf-1/units`).url.searchParams.get('cursor')).toBe(
      'next-1',
    )
    expect(rows()).toHaveLength(4)
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: '失败或取消' }))
    expect(await screen.findByText('对账文件解析容错')).toBeTruthy()
    expect(lastTo(`${BASE}/subjects/workflow/wf-1/units`).url.searchParams.get('status')).toBe(
      'unsuccessful',
    )
  })

  test('workgroup tasks show rounds, cards and how the completion went', async () => {
    get(`${BASE}/subjects/workgroup/wg-1`, () => ({ body: workgroupSummary() }))
    get(`${BASE}/subjects/workgroup/wg-1/units`, () => ({
      body: unitPage({
        items: [
          unitRow({
            unitId: 'g-1',
            name: '支付回调改为幂等',
            rounds: 7,
            assignments: 15,
            completionRejections: 1,
          }),
          unitRow({
            unitId: 'g-2',
            name: '对账差异自动归因',
            rounds: 6,
            assignments: 12,
            completionRejections: 0,
          }),
          unitRow({
            unitId: 'g-3',
            name: '结算单批量重算',
            status: 'failed',
            outcome: 'failed',
            rounds: 20,
            assignments: 31,
            completionRejections: 0,
            capped: true,
          }),
        ],
      }),
    }))
    mount('/observability?tab=process&kind=workgroup&subject=wg-1&view=units')
    const table = await screen.findByRole('table', { name: '任务明细' })
    const text = within(table)
      .getAllByRole('row')
      .map((row) => row.textContent)
    expect(text[1]).toMatch(/715.*1 次驳回$/)
    expect(text[2]).toMatch(/612.*直接通过$/)
    expect(text[3]).toMatch(/2031.*触顶$/)
  })

  test("a digital employee's assignments link to the case and list their rework", async () => {
    get(`${BASE}/subjects/digital-employee/emp-1`, () => ({ body: employeeSummary() }))
    get(`${BASE}/subjects/digital-employee/emp-1/units`, () => ({
      body: unitPage({
        items: [
          unitRow({
            unitId: 'case-1',
            taskId: null,
            name: '订单导出支持异步分片',
            outcome: 'merged',
            rework: [{ key: 'repair-feedback', rounds: 2 }],
          }),
          unitRow({
            unitId: 'case-2',
            taskId: null,
            name: '会员积分过期任务',
            status: 'active',
            outcome: 'blocked',
            endedAt: null,
          }),
        ],
        stageLabels: {
          'repair-feedback': { 'zh-CN': '修复检视问题', 'en-US': 'Fix review issues' },
        },
      }),
    }))
    mount('/observability?tab=process&kind=digital-employee&subject=emp-1&view=units')
    const table = await screen.findByRole('table', { name: '交办明细' })
    const rows = within(table).getAllByRole('row')
    expect(rows[0]!.textContent).toBe('展开交办状态发起人开始总历时返工Token成本')
    expect(rows[1]!.textContent).toContain('已合入')
    expect(rows[1]!.textContent).toContain('修复检视问题 2 轮')
    expect(rows[2]!.textContent).toContain('阻塞')
    expect(
      within(rows[1]!).getByRole('link', { name: '订单导出支持异步分片' }).getAttribute('href'),
    ).toBe('/tasks/employee-cases/case-1')
  })
})

describe('RFC-616 process tab: improvements', () => {
  const result: NonNullable<ProcessInsightView['result']> = {
    id: 'an-1',
    trigger: 'manual',
    windowFrom: 0,
    windowTo: 1,
    finishedAt: Date.UTC(2026, 10, 25, 8, 40),
    groups: [
      {
        source: 'review',
        items: 132,
        truncated: true,
        otherItems: 77,
        themes: [
          {
            name: '异常与边界情况没有覆盖',
            items: 31,
            share: 0.23,
            stages: ['review1', 'system:commit-push'],
            quotes: [{ text: '回调重复到达时怎么处理没有写。', unitId: 't-1' }],
            advice: '在方案设计的提示词里加一节失败场景模板。',
          },
        ],
      },
      { source: 'clarify', items: 4, truncated: false, otherItems: 4, themes: [] },
    ],
    stageLabels: { review1: '方案评审' },
  }

  test('every hint is listed, then the analysis: asked for by hand, watched until it finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let view = insightView()
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    get(`${BASE}/subjects/workflow/wf-1/insight`, () => ({ body: view }))
    on('POST', `${BASE}/subjects/workflow/wf-1/insight`, () => {
      view = insightView({ active: { id: 'an-1', status: 'pending', requestedAt: 1 } })
      return { status: 202, body: { id: 'an-1', status: 'pending' } }
    })
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=insights')
    expect(await screen.findByText('还没有分析过')).toBeTruthy()
    expect(document.querySelectorAll('.process-hint')).toHaveLength(4)
    expect(screen.getByText(/评审返工占全部 Token 的 29%/)).toBeTruthy()
    expect(screen.getByText('相当于每个任务约 840K Token、¥11.90。')).toBeTruthy()
    expect(screen.getByText(/触发方式：手动/)).toBeTruthy()
    expect(screen.getByText(/范围：全部任务，结果对管理者和管理员可见/)).toBeTruthy()
    // Nothing has asked for an analysis yet: opening the page never starts one.
    expect(requestsTo(`${BASE}/subjects/workflow/wf-1/insight`, 'POST')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '分析' }))
    expect(await screen.findByRole('button', { name: '排队中…' })).toBeTruthy()
    const posted = requestsTo(`${BASE}/subjects/workflow/wf-1/insight`, 'POST')
    expect(posted).toHaveLength(1)
    expect(posted[0]!.body).toMatchObject({ from: expect.any(Number), to: expect.any(Number) })
    expect((screen.getByRole('button', { name: '排队中…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    view = insightView({ active: { id: 'an-1', status: 'running', requestedAt: 1 } })
    await vi.advanceTimersByTimeAsync(INSIGHT_POLL_MS)
    expect(await screen.findByRole('button', { name: '分析中…' })).toBeTruthy()
    view = insightView({ result })
    await vi.advanceTimersByTimeAsync(INSIGHT_POLL_MS)
    expect(await screen.findByRole('button', { name: '重新分析' })).toBeTruthy()

    const review = document.querySelector('[data-source="review"]')!
    expect(review.textContent).toContain('评审意见里反复出现的主题')
    expect(review.textContent).toContain('132 条评审意见 文本太多，只分析了最近的一部分。')
    expect(review.textContent).toContain('异常与边界情况没有覆盖')
    expect(review.textContent).toContain('31 条评审意见 · 涉及：方案评审、提交与推送')
    expect(review.querySelector('.meter__value')!.textContent).toBe('23%')
    expect(review.querySelector('blockquote')!.textContent).toContain(
      '回调重复到达时怎么处理没有写。',
    )
    expect(
      within(review as HTMLElement)
        .getByRole('link', { name: '来自任务' })
        .getAttribute('href'),
    ).toBe('/tasks/t-1')
    expect(review.textContent).toContain('模型建议：在方案设计的提示词里加一节失败场景模板。')
    expect(review.textContent).toContain('另有 77 条没有归入主题。')
    expect(document.querySelector('[data-source="clarify"]')!.textContent).toContain(
      '模型没有归纳出反复出现的主题。',
    )
    // Once nothing is in flight the page stops asking.
    const polls = requestsTo(`${BASE}/subjects/workflow/wf-1/insight`).length
    await vi.advanceTimersByTimeAsync(INSIGHT_POLL_MS * 3)
    expect(requestsTo(`${BASE}/subjects/workflow/wf-1/insight`)).toHaveLength(polls)
  })

  test('nothing to read is said plainly; a failed attempt keeps the last good result; new text is flagged', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary({ scope: 'own' }) }))
    get(`${BASE}/subjects/workflow/wf-1/insight`, () => ({
      body: insightView({
        scope: 'own',
        schedule: 'weekly',
        result,
        stale: true,
        failure: { code: 'invalid-output', message: 'raw', at: 2 },
      }),
    }))
    on('POST', `${BASE}/subjects/workflow/wf-1/insight`, () => ({
      status: 202,
      body: { id: '', status: 'empty' },
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=insights')
    expect(await screen.findByText('最近一次分析失败')).toBeTruthy()
    expect(screen.getByText(/模型两次都没有按要求的格式回答。/)).toBeTruthy()
    expect(screen.getByText(/上一次成功的结果继续显示在下面。/)).toBeTruthy()
    expect(screen.getByText('上次分析之后又有新的文本，可以重新分析。')).toBeTruthy()
    expect(screen.getByText(/范围：你可见的任务，结果只对你可见/)).toBeTruthy()
    expect(screen.getByText(/触发方式：每周定时/)).toBeTruthy()
    expect(document.querySelector('[data-source="review"]')).not.toBeNull()
    // Regression: the card never said which range the result on screen was made for.
    expect(
      screen.getByText(
        new RegExp(
          `分析的是 ${new Date(result.windowFrom).toLocaleDateString('zh-CN')} 至 ${new Date(
            result.windowTo,
          ).toLocaleDateString('zh-CN')} 的文本`,
        ),
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新分析' }))
    expect(await screen.findByText('这个时间范围内没有可分析的文本。')).toBeTruthy()
    // Regression: "nothing to read" is an answer about one range and stayed on after another
    // range was chosen.
    fireEvent.click(screen.getByRole('radio', { name: '近 24 小时' }))
    await waitFor(() => expect(screen.queryByText('这个时间范围内没有可分析的文本。')).toBeNull())
    expect(await screen.findByRole('button', { name: '重新分析' })).toBeTruthy()
  })
})

// What the implementation gate found on the page, each locked where it would show.
describe('RFC-616 process tab: gate findings', () => {
  test('the stage table reads as a tree, whatever order the stages arrive in', async () => {
    // The definition stores a wrapper drawn around existing nodes after them.
    get(`${BASE}/subjects/workflow/wf-1`, () => ({
      body: workflowSummary({
        stages: [
          stage({ key: 'design', label: '方案设计', order: 0 }),
          stage({ key: 'code', label: '编码', parentKey: 'loop', order: 1 }),
          stage({
            key: 'loop',
            label: '实现循环',
            kind: 'wrapper-loop',
            parentKey: 'git',
            order: 2,
            runsPerUnit: null,
            tokensPerUnit: null,
            tokenShare: null,
            loop: {
              roundsMean: 2,
              roundsMax: 2,
              maxIterations: 5,
              capRate: 0,
              capIncludesFullRuns: false,
            },
          }),
          stage({
            key: 'git',
            label: '改动范围',
            kind: 'wrapper-git',
            order: 3,
            runsPerUnit: null,
            tokensPerUnit: null,
            tokenShare: null,
          }),
        ],
      }),
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=stages')
    await screen.findByTestId('canvas-stub')
    fireEvent.click(screen.getByRole('radio', { name: '表格' }))
    const table = await screen.findByRole('table', { name: '各节点指标' })
    const headers = within(table).getAllByRole('rowheader')
    const starts = ['方案设计', 'Git 包装器 · 改动范围', '循环 · 实现循环', '编码']
    expect(headers).toHaveLength(starts.length)
    headers.forEach((cell, index) =>
      expect(cell.textContent!.startsWith(starts[index]!)).toBe(true),
    )
    // One step of indentation per level; a mean equal to the maximum is not said twice.
    expect(headers.map((cell) => cell.style.getPropertyValue('--depth'))).toEqual([
      '',
      '',
      '1',
      '2',
    ])
    expect(headers[2]!.textContent).toContain('平均 2 轮 · 上限 5 轮')
    expect(headers[2]!.textContent).not.toContain('最多')
  })

  test('controls sit in the shared filter bar, and a long picker scrolls inside itself', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=stages')
    await screen.findByTestId('canvas-stub')
    const filters = screen.getByRole('group', { name: '筛选与对比' })
    expect(filters.className).toContain('filter-bar')
    expect(within(filters).getByRole('radiogroup', { name: '对比方式' })).toBeTruthy()
    const stageControls = screen.getByRole('group', { name: '阶段分析的呈现与着色' })
    const heat = within(stageControls).getByRole('radiogroup', { name: '着色指标' })
    // Regression: five metrics pushed the page wider than a phone. The picker's own box scrolls.
    expect(heat.parentElement!.className).toContain('page-filter')
    expect(screen.getByRole('radiogroup', { name: '时间范围' }).parentElement!.className).toContain(
      'page-filter',
    )
    // The subject is a level-two heading of the shared page header.
    const heading = screen.getByRole('heading', { name: '需求到合入', level: 2 })
    expect(heading.closest('.page__header')).not.toBeNull()
  })

  test('while a comparison is being computed the page says so, and describes the answer it still shows', async () => {
    let release: (answer: Answer) => void = () => {}
    get(`${BASE}/subjects/workflow/wf-1`, (call) => {
      if (call.url.searchParams.get('compare') !== 'period') return { body: workflowSummary() }
      return new Promise<Answer>((resolve) => {
        release = resolve
      })
    })
    mount('/observability?tab=process&kind=workflow&subject=wf-1')
    await screen.findByRole('heading', { name: '需求到合入', level: 2 })
    expect(screen.queryByText('正在计算…')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '对比上一时段' }))
    // The previous answer stays on screen: it compared nothing, so nothing is said about a baseline.
    expect(await screen.findByText('正在计算…')).toBeTruthy()
    expect(screen.queryByText(/对比的那一组里没有样本/)).toBeNull()
    expect(screen.queryByText(/对比的是紧邻的上一个等长时段/)).toBeNull()
    release({
      body: workflowSummary({ compare: { mode: 'period', split: null, baselineUnits: 37 } }),
    })
    expect(await screen.findByText('对比的是紧邻的上一个等长时段，共 37 个任务。')).toBeTruthy()
    expect(screen.queryByText('正在计算…')).toBeNull()
  })

  test('the task list has one legend for every row, and a linked task outside the loaded page is shown first, opened', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    get(`${BASE}/subjects/workflow/wf-1/units`, () => ({
      body: unitPage({
        items: [
          // The newest task waited for nothing; an older one waited for an answer.
          unitRow({ unitId: 't-1', name: '最新的任务', waits: [], otherMs: 347 * M }),
          unitRow({
            unitId: 't-2',
            name: '问过人的任务',
            waits: [{ kind: 'clarify', ms: 120 * M }],
            otherMs: 227 * M,
          }),
        ],
        nextCursor: 'more',
      }),
    }))
    const stages = [
      {
        key: 'member-human',
        label: 'member-human',
        kind: 'member-human' as const,
        parentKey: null,
        removed: false,
        runs: 1,
        failedRuns: 0,
        autoRetries: 0,
        durationMs: 10 * M,
        tokens: 0,
        gateRounds: 0,
        gateWaitMs: 0,
        comments: 0,
        questions: 0,
      },
    ]
    get(`${BASE}/units/workflow/t-old`, () => ({
      body: {
        asOf: 1,
        unit: unitRow({ unitId: 't-old', name: '三个月前的任务' }),
        identities: [],
        stages,
      },
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=units&unit=t-old')
    const table = await screen.findByRole('table', { name: '任务明细' })
    // Regression: the legend was built from the first row, which has no waiting at all.
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('.filter-bar .viz-legend li')].map(
          (item) => item.textContent,
        ),
      ).toEqual(['自动执行', '等待评审', '等待反问回答', '排队与中断']),
    )
    // Regression: a link to a task beyond the first page opened nothing.
    const units = () => [...table.querySelectorAll<HTMLElement>('tr[data-unit]')]
    await waitFor(() =>
      expect(units().map((row) => row.dataset.unit)).toEqual(['t-old', 't-1', 't-2']),
    )
    const linked = units()[0]!
    expect(linked.textContent).toContain('三个月前的任务')
    expect(linked.textContent).toContain('链接指向的这一项')
    expect(within(linked).getByRole('button').getAttribute('aria-expanded')).toBe('true')
    const opened = await screen.findByRole('table', { name: '各环节' })
    // A member the server may not name is called by its role, never by its key.
    expect(within(opened).getAllByRole('rowheader')[0]!.textContent).toBe('人类成员')

    // Regression: Refresh re-read nothing within the same minute (the range moves in whole
    // minutes), and never an opened task. It reads the summary, the list and the opened task.
    const summaries = requestsTo(`${BASE}/subjects/workflow/wf-1`).length
    const before = requestsTo(`${BASE}/units/workflow/t-old`).length
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() =>
      expect(requestsTo(`${BASE}/units/workflow/t-old`).length).toBeGreaterThan(before),
    )
    expect(requestsTo(`${BASE}/subjects/workflow/wf-1`).length).toBeGreaterThan(summaries)
  })

  test('a link to a task that is gone says so instead of showing nothing', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    get(`${BASE}/subjects/workflow/wf-1/units`, () => ({
      body: unitPage({ items: [unitRow({ unitId: 't-1', name: '最新的任务' })] }),
    }))
    get(`${BASE}/units/workflow/t-gone`, () => ({
      status: 404,
      body: { ok: false, code: 'process-unit-not-found', message: 'Unit not found' },
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=units&unit=t-gone')
    expect(await screen.findByText('链接指向的任务不存在，或你无权查看。')).toBeTruthy()
    expect(screen.getByText('最新的任务')).toBeTruthy()
  })

  test('a workgroup and a digital employee show the numbers every kind has: efficiency, interventions, time and tokens by cause', async () => {
    const common = {
      flowEfficiency: compared(0.47),
      firstPassRate: compared(0.4),
      interventionsPerUnit: compared(3.2),
    }
    const group = workgroupSummary()
    get(`${BASE}/subjects/workgroup/wg-1`, () => ({
      body: { ...group, metrics: { ...group.metrics, ...common } },
    }))
    mount('/observability?tab=process&kind=workgroup&subject=wg-1')
    await screen.findByRole('heading', { name: '支付模块攻坚组', level: 2 })
    const groupCommon = screen.getByTestId('process-overview-common')
    expect(
      [...groupCommon.querySelectorAll('.metric-tile__label')].map((label) => label.textContent),
    ).toEqual(['流动效率', '每任务 Token', '一次通过率', '人工介入'])
    expect(tileValue('流动效率')).toBe('47%')
    expect(tileValue('人工介入')).toBe('3.2 次 / 任务')
    // Its own split says who spent the tokens; why they were spent follows under its own name.
    expect(screen.getByRole('group', { name: 'Token 花在哪里' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Token 按执行原因' })).toBeTruthy()
    cleanup()

    const employee = employeeSummary()
    get(`${BASE}/subjects/digital-employee/emp-1`, () => ({
      body: { ...employee, metrics: { ...employee.metrics, ...common } },
    }))
    mount('/observability?tab=process&kind=digital-employee&subject=emp-1')
    await screen.findByRole('heading', { name: '研发数字员工 · Java 后端', level: 2 })
    expect(
      [
        ...screen.getByTestId('process-overview-common').querySelectorAll('.metric-tile__label'),
      ].map((label) => label.textContent),
    ).toEqual(['流动效率', '人工介入'])
    expect(screen.getByRole('group', { name: '时间花在哪里' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Token 花在哪里' })).toBeTruthy()
  })
})

// Found by looking at the rendered pages (1280 px and 390 px, both themes), not by a failing test.
describe('RFC-616 process tab: findings of the visual pass', () => {
  const styles = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
    'utf8',
  )
  const rule = (selector: string) => {
    const start = styles.indexOf(`${selector} {`)
    expect(start, selector).toBeGreaterThanOrEqual(0)
    return styles.slice(start, styles.indexOf('}', start))
  }

  test('the back control keeps its own width at the left of the subject header', async () => {
    // Regression: the header is a column, so the button stretched across the page and its text
    // sat in the middle, away from the title it belongs to.
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1')
    await screen.findByRole('heading', { name: '需求到合入', level: 2 })
    const back = screen.getByRole('button', { name: '返回工作流列表' })
    expect(back.parentElement!.className).toBe('page__heading-back')
    expect(back.closest('.page__header')).not.toBeNull()
    expect(rule('.page__heading-back')).toContain('align-self: flex-start')
  })

  test('a number that is not there is a dash on its own, never a dash with a unit', async () => {
    // Regression: "— 次 / 任务" for a group without one ended task.
    const group = workgroupSummary()
    const metrics = { ...group.metrics } as Record<string, unknown>
    delete metrics.interventionsPerUnit
    get(`${BASE}/subjects/workgroup/wg-1`, () => ({ body: { ...group, metrics } }))
    mount('/observability?tab=process&kind=workgroup&subject=wg-1')
    await screen.findByRole('heading', { name: '支付模块攻坚组', level: 2 })
    expect(tileValue('人工介入')).toBe('—')
  })

  test('an assignment is counted "每次交办", the way it is said', async () => {
    // Regression: "每交办 Token" and "每交办轮次" — the unit name glued behind "每" does not read.
    get(`${BASE}/subjects/digital-employee/emp-1`, () => ({ body: employeeSummary() }))
    mount('/observability?tab=process&kind=digital-employee&subject=emp-1')
    await screen.findByRole('heading', { name: '研发数字员工 · Java 后端', level: 2 })
    const labels = [...document.querySelectorAll('.metric-tile__label')].map(
      (label) => label.textContent,
    )
    expect(labels).toContain('每次交办 Token')
    expect(document.body.textContent).not.toContain('每交办')
    expect(screen.getByRole('radio', { name: '每次交办 Token' })).toBeTruthy()
  })

  test('in the task list a name keeps a readable width and a short label stays on one line', async () => {
    // Regression: with ten columns beside it the task name was squeezed to one character a line,
    // and "手动" broke in two. The name column has a minimum width; the table scrolls in its
    // viewport instead.
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    get(`${BASE}/subjects/workflow/wf-1/units`, () => ({
      body: unitPage({ items: [unitRow({ unitId: 't-1', name: '订单导出支持异步分片' })] }),
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=units')
    const link = await screen.findByRole('link', { name: '订单导出支持异步分片' })
    const row = link.closest('tr')!
    expect(link.closest('th')!.className).toBe('process-metrics__name')
    expect(within(row).getByText('手动').className).toBe('data-table__nowrap')
    expect(rule('.data-table .process-metrics__name')).toMatch(/min-width: \d+em/)
    // The list sits in the shared viewport, which is what scrolls.
    expect(row.closest('.table-viewport')).not.toBeNull()
  })
})

// Found on a real installation with real runtime calls (2026-11-26): no price line was configured
// there, which is how every installation starts, and every cost on these pages read "¥0.00". Run
// observation's other tabs never let unpriced tokens read as free (`usageCost`): nothing priced is
// "未定价", a part priced is "¥x 起". These pages now say the same.
describe('RFC-616 process tab: a cost without a price', () => {
  test('the listing says "unpriced" or "from", never a bare zero', async () => {
    get(`${BASE}/subjects`, () => ({
      body: subjectList({
        items: [
          subjectRow({ subjectId: 'wf-1', name: '没有定价', costNanoPerUnit: 0, unpriced: true }),
          subjectRow({ subjectId: 'wf-2', name: '部分定价', unpriced: true }),
          subjectRow({ subjectId: 'wf-3', name: '全部定价' }),
          // Priced, and it really cost nothing.
          subjectRow({ subjectId: 'wf-4', name: '免费模型', costNanoPerUnit: 0 }),
        ],
      }),
    }))
    mount('/observability?tab=process')
    const table = await screen.findByRole('table', { name: '工作流的过程度量' })
    const cell = (name: string) => {
      const row = within(table)
        .getAllByRole('row')
        .find((candidate) => candidate.textContent?.startsWith(name))!
      return within(row).getAllByRole('cell')[5]!.textContent
    }
    expect(cell('没有定价')).toBe('未定价')
    expect(cell('部分定价')).toBe('¥41.20 起')
    expect(cell('全部定价')).toBe('¥41.20')
    expect(cell('免费模型')).toBe('¥0.00')
  })

  test('the overview tile, the cause table and a hint follow the note of the summary', async () => {
    const template = workflowSummary()
    get(`${BASE}/subjects/workflow/wf-1`, () => ({
      body: workflowSummary({
        note: { ...template.note, unpriced: true },
        metrics: { ...template.metrics, costNanoPerUnit: { value: 0, baseline: null } },
        causes: template.causes.map((slice) => ({
          ...slice,
          costNano: 0,
          // One cause that used no tokens at all: it cost nothing, priced or not.
          tokens: slice.cause === 'other-rerun' ? 0 : slice.tokens,
        })),
        hints: [
          {
            id: 'rework-cost',
            severity: 'info',
            target: 'overview',
            params: { share: 0.29, tokens: 840_000, costNano: 0 },
          },
        ],
      }),
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1')
    await screen.findByRole('heading', { name: '需求到合入', level: 2 })
    expect(tileText('每任务 Token')).toContain('成本 未定价')
    const causes = screen.getByRole('table', { name: 'Token 按执行原因' })
    const rows = within(causes)
      .getAllByRole('row')
      .map((row) => row.textContent)
    expect(rows[1]).toBe('首次执行1.45M未定价50%')
    expect(rows[5]).toBe('其它重跑（连带、恢复续跑）0¥0.003%')
    expect(screen.getByText('相当于每个任务约 840K Token、未定价。')).toBeTruthy()
  })

  test('a task row says it the same way, with the reason on hover', async () => {
    get(`${BASE}/subjects/workflow/wf-1`, () => ({ body: workflowSummary() }))
    get(`${BASE}/subjects/workflow/wf-1/units`, () => ({
      body: unitPage({
        items: [
          unitRow({ unitId: 't-1', name: '没有定价的任务', costNano: 0, unpriced: true }),
          unitRow({ unitId: 't-2', name: '部分定价的任务', unpriced: true }),
          unitRow({ unitId: 't-3', name: '全部定价的任务' }),
        ],
      }),
    }))
    mount('/observability?tab=process&kind=workflow&subject=wf-1&view=units')
    const table = await screen.findByRole('table', { name: '任务明细' })
    const rowOf = (name: string) =>
      within(table)
        .getAllByRole('row')
        .find((candidate) => candidate.textContent?.includes(name))!
    expect(within(rowOf('没有定价的任务')).getByText('未定价').getAttribute('title')).toBe(
      '部分 Token 没有价格，金额为已定价部分',
    )
    expect(within(rowOf('部分定价的任务')).getByText('¥33.80 起')).toBeTruthy()
    expect(rowOf('全部定价的任务').textContent).toContain('¥33.80')
    expect(rowOf('全部定价的任务').textContent).not.toContain('起')
  })
})
