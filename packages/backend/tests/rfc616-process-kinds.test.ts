// RFC-616 §6.2 / §6.3 — workgroups and digital employees over in-memory fact
// sources.
//
// Workgroup: host runs are attributed to the leader and the members by the
// shared rule (a card run by an agent two members share stays unattributed),
// completion-gate decisions are paired with their holder runs, an assignment
// handed to a person is a wait, and per-person rows fold away for viewers who
// may not see them. Digital employee: a case's status follows the terminal
// kind table, first pass is judged from the rework work items the type
// declares, blocked spans come from lifecycle events, and delivery is split
// where the first region's main lane ends.
import { describe, expect, test } from 'bun:test'
import type {
  ProcessEmployeeSummary,
  ProcessWorkgroupSummary,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { createProcessQueries } from '@/modules/run-observability/application/process/processQueries'
import { createProcessTexts } from '@/modules/run-observability/application/process/processTexts'
import type {
  ProcessEmployeeCaseRow,
  ProcessEmployeeManifest,
  ProcessEmployeeRoundRow,
  ProcessTextItem,
  ProcessWorkgroupAssignmentRow,
} from '@/platform/contracts/processFacts'
import {
  fakeProcessSources,
  gateRound,
  nodeRun,
  person,
  taskUnit,
  usageRow,
  type FakeProcessData,
} from './helpers/processMetricsFakes'

const M = 60_000
const H = 60 * M
const NOW = 500 * H
const WINDOW = { from: 0, to: 1_000 * H, tzOffset: 0, compare: 'off' as const }

const admin = person('admin', 'admin')
const alice = person('alice', 'user')

const LEADER = '__wg_leader__'
const MEMBER = '__wg_member__'

function assignment(
  over: Partial<ProcessWorkgroupAssignmentRow> & { taskId: string; assignmentId: string },
): ProcessWorkgroupAssignmentRow {
  return {
    round: 1,
    source: 'leader',
    assigneeMemberId: null,
    status: 'done',
    createdAt: 0,
    updatedAt: 0,
    deliveredAt: null,
    deliveredByUserId: null,
    ...over,
  }
}

function workgroupScenario(): Partial<FakeProcessData> {
  const roster = (taskId: string) => ({
    taskId,
    mode: 'leader_worker' as const,
    leaderMemberId: 'm-lead',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent' as const,
        displayName: 'planner',
        agentId: 'ag-plan',
        agentName: 'planner',
        userId: null,
        roleNote: null,
      },
      {
        id: 'm-a',
        memberType: 'agent' as const,
        displayName: 'coder-a',
        agentId: 'ag-code',
        agentName: 'coder',
        userId: null,
        roleNote: 'backend',
      },
      // Two members share one agent: a single-card run of that agent cannot be told apart.
      {
        id: 'm-b',
        memberType: 'agent' as const,
        displayName: 'audit-b',
        agentId: 'ag-audit',
        agentName: 'auditor',
        userId: null,
        roleNote: null,
      },
      {
        id: 'm-c',
        memberType: 'agent' as const,
        displayName: 'audit-c',
        agentId: 'ag-audit',
        agentName: 'auditor',
        userId: null,
        roleNote: null,
      },
      {
        id: 'm-h',
        memberType: 'human' as const,
        displayName: 'Zhang Wei',
        agentId: null,
        agentName: null,
        userId: 'zhang',
        roleNote: 'product',
      },
    ],
    maxRounds: 20,
    pauseReason: null,
    configRevision: taskId === 'g1' ? 3 : 1,
    planRejections: 0,
  })
  return {
    usageSince: 0,
    tasks: [
      {
        kind: 'workgroup',
        row: taskUnit({
          taskId: 'g1',
          subjectId: 'wg-1',
          subjectName: 'Payments squad',
          subjectRevision: null,
          engineKind: 'workgroup-turns',
          startedAt: 10 * H,
          finishedAt: 20 * H,
          autoMs: 4 * H,
        }),
      },
      {
        kind: 'workgroup',
        row: taskUnit({
          taskId: 'g2',
          subjectId: 'wg-1',
          subjectName: 'Payments squad',
          subjectRevision: null,
          engineKind: 'workgroup-turns',
          status: 'failed',
          errorSummary: 'workgroup hit max_rounds (20)',
          ownerUserId: 'dave',
          startedAt: 30 * H,
          finishedAt: 32 * H,
          autoMs: 2 * H,
        }),
      },
    ],
    rosters: [roster('g1'), roster('g2')],
    assignments: [
      assignment({ taskId: 'g1', assignmentId: 'as-1', round: 1, assigneeMemberId: 'm-a' }),
      assignment({ taskId: 'g1', assignmentId: 'as-2', round: 1, assigneeMemberId: 'm-b' }),
      assignment({
        taskId: 'g1',
        assignmentId: 'as-3',
        round: 2,
        source: 'human',
        assigneeMemberId: 'm-a',
      }),
      // Handed to a person at 13 h, delivered by them at 15 h.
      assignment({
        taskId: 'g1',
        assignmentId: 'as-4',
        round: 2,
        assigneeMemberId: 'm-h',
        status: 'delivered',
        createdAt: 13 * H,
        updatedAt: 15 * H,
        deliveredAt: 15 * H,
        deliveredByUserId: 'zhang',
      }),
      // Handed to a person and withdrawn: a wait, but not a delivery.
      assignment({
        taskId: 'g1',
        assignmentId: 'as-5',
        round: 2,
        source: 'self_claim',
        assigneeMemberId: 'm-h',
        status: 'canceled',
        createdAt: 15 * H,
        updatedAt: 15.5 * H,
      }),
      assignment({ taskId: 'g2', assignmentId: 'bs-1', round: 1, assigneeMemberId: 'm-a' }),
    ],
    nodeRuns: [
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'l1',
        nodeId: LEADER,
        rerunCause: 'wg-leader-round',
        wgRound: 1,
        startedAt: 10 * H,
        finishedAt: 10.5 * H,
      }),
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'a1',
        nodeId: MEMBER,
        rerunCause: 'wg-assignment',
        wgRound: 1,
        shardKey: 'as-1',
        agentOverrideId: 'ag-code',
        startedAt: 10.5 * H,
        finishedAt: 12 * H,
      }),
      // The auditor agent is shared by m-b and m-c: this run belongs to "one of them".
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'b1',
        nodeId: MEMBER,
        rerunCause: 'wg-assignment',
        wgRound: 1,
        shardKey: 'as-2',
        agentOverrideId: 'ag-audit',
        startedAt: 10.5 * H,
        finishedAt: 11 * H,
      }),
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'l2',
        nodeId: LEADER,
        rerunCause: 'wg-leader-round',
        wgRound: 2,
        startedAt: 12 * H,
        finishedAt: 12.5 * H,
      }),
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'l2r',
        nodeId: LEADER,
        rerunCause: 'wg-protocol-retry',
        wgRound: 2,
        startedAt: 12.5 * H,
        finishedAt: 13 * H,
      }),
      // A batch run names its member in the shard key, whatever agent ran it.
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'a2',
        nodeId: MEMBER,
        rerunCause: 'wg-assignment',
        wgRound: 2,
        shardKey: 'batch:m-c:as-3',
        agentOverrideId: 'ag-audit',
        status: 'failed',
        failureCode: 'timeout',
        startedAt: 13 * H,
        finishedAt: 14 * H,
      }),
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'm1',
        nodeId: MEMBER,
        rerunCause: 'wg-message-turn',
        wgRound: 2,
        shardKey: 'msg:m-a:0003',
        startedAt: 14 * H,
        finishedAt: 14.5 * H,
      }),
      // The completion gate holder sits on the leader node and is not a leader round.
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'gate-1',
        nodeId: LEADER,
        rerunCause: 'wg-gate',
        wgRound: 2,
        status: 'awaiting_review',
        startedAt: null,
        finishedAt: null,
      }),
      nodeRun({
        taskId: 'g2',
        nodeRunId: 'l1b',
        nodeId: LEADER,
        rerunCause: 'wg-leader-round',
        wgRound: 1,
        startedAt: 30 * H,
        finishedAt: 31 * H,
      }),
    ],
    gateRuns: [
      {
        taskId: 'g1',
        nodeRunId: 'gate-1',
        kind: 'completion',
        openedAt: 16 * H,
        closedAt: 17 * H,
        round: 2,
        canceled: false,
      },
      {
        taskId: 'g1',
        nodeRunId: 'gate-2',
        kind: 'completion',
        openedAt: 18 * H,
        closedAt: 19 * H,
        round: 5,
        canceled: false,
      },
    ],
    gateDecisions: [
      { taskId: 'g1', at: 17 * H, userId: 'bob', approved: false },
      { taskId: 'g1', at: 19 * H, userId: 'bob', approved: true },
    ],
    gateRounds: [
      // The leader asked a person; a member asked too.
      gateRound({
        taskId: 'g1',
        kind: 'clarify',
        stageNodeId: '__wg_clarify__',
        relatedNodeId: LEADER,
        gateNodeRunId: 'cq-1',
        instanceKey: `${LEADER}|`,
        openedAt: 10.5 * H,
        closedAt: 11 * H,
        outcome: 'continue',
        deciderUserId: 'bob',
        measures: { questions: 2 },
      }),
      gateRound({
        taskId: 'g1',
        kind: 'clarify',
        stageNodeId: '__wg_clarify__',
        relatedNodeId: MEMBER,
        askingShardKey: 'as-1',
        gateNodeRunId: 'cq-2',
        instanceKey: `${MEMBER}|as-1`,
        openedAt: 11 * H,
        closedAt: 11.5 * H,
        outcome: 'continue',
        deciderUserId: 'bob',
        measures: { questions: 4 },
      }),
    ],
    humanMessages: new Map([
      ['g1', 4],
      ['g2', 0],
    ]),
    usage: [
      usageRow({ taskId: 'g1', nodeRunId: 'l1', tokens: 100 }),
      usageRow({ taskId: 'g1', nodeRunId: 'l2', tokens: 60 }),
      usageRow({ taskId: 'g1', nodeRunId: 'l2r', tokens: 40 }),
      usageRow({ taskId: 'g1', nodeRunId: 'a1', tokens: 500 }),
      usageRow({ taskId: 'g1', nodeRunId: 'b1', tokens: 150 }),
      usageRow({ taskId: 'g1', nodeRunId: 'a2', tokens: 90 }),
      usageRow({ taskId: 'g1', nodeRunId: 'm1', tokens: 30 }),
      usageRow({ taskId: 'g1', purpose: 'system', systemKind: 'memory-distiller', tokens: 30 }),
      usageRow({ taskId: 'g2', nodeRunId: 'l1b', tokens: 200 }),
    ],
    identities: [{ id: 'bob', username: 'bob', displayName: 'Bob' }],
  }
}

function queriesOf(seed: Partial<FakeProcessData>) {
  const fake = fakeProcessSources(seed)
  return createProcessQueries({ sources: fake.sources, clock: () => NOW })
}

describe('RFC-616 workgroup summary', () => {
  const summaryFor = async (actor = admin) =>
    (await queriesOf(workgroupScenario()).summary(
      actor,
      'workgroup',
      'wg-1',
      WINDOW,
    )) as ProcessWorkgroupSummary

  test('headline numbers: rounds, assignments, coordination and protocol retries', async () => {
    const summary = await summaryFor()
    expect(summary).toMatchObject({
      kind: 'workgroup',
      subjectName: 'Payments squad',
      mode: 'leader_worker',
      counts: { total: 2, succeeded: 1, failed: 1 },
      revisions: [],
    })
    const value = (id: keyof typeof summary.metrics) => summary.metrics[id]!.value
    // g1 ran two leader rounds, g2 one.
    expect(value('roundsPerUnit')).toBe(1.5)
    // g2 failed for running out of rounds.
    expect(value('roundCapRate')).toBe(1 / 2)
    expect(value('assignmentsPerUnit')).toBe(3)
    // Leader tokens (100 + 60 + 40 + 200) over all tokens (1000 + 200).
    expect(value('coordinationShare')).toBe(400 / 1_200)
    // One protocol retry among eight host runs: seven in g1 (the run of the shared agent counts,
    // the gate holder is not a run) and one in g2.
    expect(value('protocolRetryRate')).toBe(1 / 8)
    expect(value('tokensPerUnit')).toBe(600)
    expect(summary.assignmentSources).toEqual({ leader: 2, human: 0.5, self: 0.5 })
  })

  test('a range in which the group ran nothing keeps its name', async () => {
    // Regression: the name is frozen on the tasks, so an empty range titled the page "deleted workgroup".
    const quiet = { ...WINDOW, from: 200 * H, to: 300 * H }
    const summaryOf = async (actor: typeof admin, subjectId: string) =>
      (await queriesOf(workgroupScenario()).summary(
        actor,
        'workgroup',
        subjectId,
        quiet,
      )) as ProcessWorkgroupSummary
    expect(await summaryOf(admin, 'wg-1')).toMatchObject({
      subjectName: 'Payments squad',
      // Nothing ran: there is no mode to report, and no rounds to show for one.
      mode: null,
      rounds: [],
      counts: { total: 0 },
    })
    // A viewer who can see none of the group's tasks learns nothing about it, the name included.
    expect((await summaryOf(person('zed', 'user'), 'wg-1')).subjectName).toBeNull()
    // A group that never ran has no task to take a name from.
    expect((await summaryOf(admin, 'wg-never')).subjectName).toBeNull()
  })

  test('tokens by who spent them add up to the headline number', async () => {
    const summary = await summaryFor()
    expect(summary.actors).toEqual([
      { actor: 'leader', tokens: 200, costNano: 2_000 },
      // a1 (m-a), a2 (m-c through its batch key) and m1 (m-a).
      { actor: 'member', tokens: 310, costNano: 3_100 },
      { actor: 'system', tokens: 15, costNano: 150 },
      // b1: the auditor agent is shared, so its card run belongs to nobody in particular.
      { actor: 'unattributed', tokens: 75, costNano: 750 },
    ])
    expect(summary.actors.reduce((sum, slice) => sum + slice.tokens, 0)).toBe(
      summary.metrics.tokensPerUnit!.value!,
    )
  })

  test('rounds: assignments, duration and the leader share of each', async () => {
    const summary = await summaryFor()
    expect(summary.rounds).toEqual([
      // Round 1: both tasks reached it. g1 two cards, g2 one.
      {
        round: 1,
        units: 2,
        assignmentsMean: 3 / 2,
        // g1: 10 h → 12 h; g2: 30 h → 31 h.
        durationMs: 1.5 * H,
        tokens: (100 + 500 + 150 + 200) / 2,
        leaderTokenShare: 300 / 950,
      },
      {
        round: 2,
        units: 1,
        assignmentsMean: 3,
        durationMs: 2.5 * H,
        tokens: 60 + 40 + 90 + 30,
        leaderTokenShare: 100 / 220,
      },
    ])
    expect(summary.budget).toBeNull()
  })

  test('members: attribution follows the room, and the shared agent stays unattributed', async () => {
    const summary = await summaryFor()
    const row = (key: string) => summary.members.find((member) => member.key === key)
    expect(summary.members.map((member) => member.key)).toEqual([
      'leader',
      'member:m-a',
      'member:m-b',
      'member:m-c',
      'member:m-h',
      'unattributed',
    ])
    expect(row('leader')).toMatchObject({
      name: 'planner',
      role: 'leader',
      assignmentsPerUnit: null,
      // Leader rounds of both tasks, plus the protocol retry.
      protocolRetryRate: 1 / 4,
      clarifyPerUnit: 1 / 2,
    })
    expect(row('member:m-a')).toMatchObject({
      name: 'coder-a',
      role: 'member-agent',
      roleNote: 'backend',
      // as-1 and as-3 in g1, bs-1 in g2.
      assignmentsPerUnit: 3 / 2,
      durationMs: { n: 1, p50: 2 * H },
      failureRate: 0,
      clarifyPerUnit: 1 / 2,
    })
    expect(row('member:m-c')).toMatchObject({ role: 'member-agent', failureRate: 1 })
    expect(row('member:m-h')).toMatchObject({
      name: 'Zhang Wei',
      role: 'member-human',
      roleNote: 'product',
      assignmentsPerUnit: 1,
      tokensPerUnit: null,
      deliveryMs: { n: 1, p50: 2 * H },
    })
    expect(row('unattributed')).toMatchObject({
      role: 'unattributed',
      durationMs: { n: 1, p50: H / 2 },
    })
    // m-b took a card, and that is counted. The run of it used the agent m-b shares with m-c, so its
    // time and tokens are on the unattributed row and m-b has no execution numbers of its own.
    expect(row('member:m-b')).toMatchObject({
      name: 'audit-b',
      role: 'member-agent',
      // One card in g1, none in g2; m-b is a member of both.
      assignmentsPerUnit: 1 / 2,
      durationMs: { n: 0, p50: null },
      tokensPerUnit: null,
      failureRate: null,
    })
  })

  test('human gates: delivery, completion decisions paired with their holder runs, clarify by asker', async () => {
    const summary = await summaryFor()
    expect(summary.human).toEqual({
      messagesPerUnit: 2,
      directAssignmentsPerUnit: 1 / 2,
      configChangesPerUnit: 1,
      deliveryMs: { n: 1, p50: 2 * H, p90: 2 * H, mean: 2 * H },
    })
    expect(summary.completion).toEqual({
      rounds: 2,
      waitMs: { n: 2, p50: H, p90: H, mean: H },
      rejections: 1,
      rejectRate: 1 / 2,
      // Rejected in round 2, confirmed again in round 5.
      extraRoundsAfterReject: 3,
    })
    expect(summary.planConfirm).toBeNull()
    expect(summary.clarify).toMatchObject({ rounds: 2, questionsPerRound: 3 })
    expect(summary.clarifyByAsker).toEqual({ leader: 1 / 2, member: 1 / 2 })
    // 10 h lead, 4 h running; delivery 13–15.5 h, completion 16–17 h and 18–19 h, clarify 10.5–11.5 h.
    expect(summary.time).toEqual({
      sampleUnits: 1,
      leadMs: 10 * H,
      autoMs: 4 * H,
      waits: [
        { kind: 'clarify', ms: H },
        { kind: 'completion', ms: 2 * H },
        { kind: 'delivery', ms: 2.5 * H },
      ],
      otherMs: 0.5 * H,
    })
    expect(summary.interventions.gates).toEqual([
      { kind: 'clarify', perUnit: 1 },
      { kind: 'completion', perUnit: 1 },
      // The withdrawn assignment is a wait, not a delivery.
      { kind: 'delivery', perUnit: 1 / 2 },
    ])
  })

  test('a viewer who may not see per-person detail gets the human members folded together', async () => {
    const seed = workgroupScenario()
    const summary = (await queriesOf(seed).summary(
      alice,
      'workgroup',
      'wg-1',
      WINDOW,
    )) as ProcessWorkgroupSummary
    // alice owns g1 only.
    expect(summary.scope).toBe('own')
    expect(summary.counts.total).toBe(1)
    expect(summary.members.map((member) => member.key)).toContain('member-human')
    expect(summary.members.some((member) => member.key === 'member:m-h')).toBe(false)
    expect(summary.members.find((member) => member.key === 'member-human')).toMatchObject({
      name: null,
      role: 'member-human',
      deliveryMs: { n: 1, p50: 2 * H },
    })
    expect(summary.clarify!.people).toBeNull()
  })

  test('the listing row and the unit rows agree with the summary', async () => {
    const queries = queriesOf(workgroupScenario())
    const list = await queries.subjects(admin, { kind: 'workgroup', from: 0, to: 1_000 * H })
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({
      subjectId: 'wg-1',
      name: 'Payments squad',
      mode: 'leader_worker',
      units: 2,
      roundsPerUnit: 1.5,
      assignmentsPerUnit: 3,
      coordinationShare: 400 / 1_200,
      tokensPerUnit: 600,
      unpriced: false,
    })
    const page = await queries.units(admin, 'workgroup', 'wg-1', { ...WINDOW, status: 'all' })
    expect(
      page.items.map((item) => [item.unitId, item.rounds, item.assignments, item.capped]),
    ).toEqual([
      ['g2', 1, 1, true],
      ['g1', 2, 5, false],
    ])
    const detail = (await queries.unit(admin, 'workgroup', 'g1'))!
    expect(detail.unit).toMatchObject({
      rounds: 2,
      assignments: 5,
      completionRejections: 1,
      capped: false,
    })
    expect(detail.stages.find((stage) => stage.key === 'leader')).toMatchObject({
      runs: 3,
      autoRetries: 1,
      tokens: 200,
    })
    expect(await queries.unit(admin, 'workflow', 'g1')).toBeNull()
  })

  test('dynamic workflow: generated nodes are folded onto the member whose agent runs them', async () => {
    const generated = {
      $schema_version: 7,
      inputs: [],
      edges: [],
      nodes: [
        { id: 'n1', kind: 'agent-single', agentId: 'ag-code' },
        { id: 'n2', kind: 'agent-single', agentId: 'ag-unknown' },
      ],
    } as unknown as WorkflowDefinition
    const summary = (await queriesOf({
      usageSince: 0,
      tasks: [
        {
          kind: 'workgroup',
          row: taskUnit({
            taskId: 'd1',
            subjectId: 'wg-2',
            subjectName: 'Refactor pool',
            engineKind: 'dw-generate',
            startedAt: H,
            finishedAt: 5 * H,
            autoMs: 2 * H,
          }),
        },
      ],
      definitions: new Map([['d1', generated]]),
      rosters: [
        {
          taskId: 'd1',
          mode: 'dynamic_workflow',
          leaderMemberId: null,
          members: [
            {
              id: 'm-a',
              memberType: 'agent',
              displayName: 'coder-a',
              agentId: 'ag-code',
              agentName: 'coder',
              userId: null,
              roleNote: null,
            },
          ],
          maxRounds: null,
          pauseReason: null,
          configRevision: 1,
          planRejections: 1,
        },
      ],
      nodeRuns: [
        nodeRun({
          taskId: 'd1',
          nodeRunId: 'o1',
          nodeId: '__dw_orchestrator__',
          rerunCause: 'dw-generate',
          startedAt: H,
          finishedAt: 1.5 * H,
        }),
        nodeRun({
          taskId: 'd1',
          nodeRunId: 'x1',
          nodeId: 'n1',
          startedAt: 3 * H,
          finishedAt: 4 * H,
        }),
        nodeRun({
          taskId: 'd1',
          nodeRunId: 'x2',
          nodeId: 'n2',
          startedAt: 4 * H,
          finishedAt: 4.5 * H,
        }),
      ],
      gateRuns: [
        {
          taskId: 'd1',
          nodeRunId: 'p1',
          kind: 'plan-confirm',
          openedAt: 1.5 * H,
          closedAt: 2 * H,
          round: null,
          canceled: false,
        },
        {
          taskId: 'd1',
          nodeRunId: 'p2',
          kind: 'plan-confirm',
          openedAt: 2.2 * H,
          closedAt: 3 * H,
          round: null,
          canceled: false,
        },
      ],
    }).summary(admin, 'workgroup', 'wg-2', WINDOW)) as ProcessWorkgroupSummary
    expect(summary.mode).toBe('dynamic_workflow')
    expect(summary.rounds).toEqual([])
    expect(summary.members.find((member) => member.key === 'member:m-a')).toMatchObject({
      name: 'coder-a',
      durationMs: { n: 1, p50: H },
    })
    expect(summary.members.find((member) => member.key === 'unattributed')).toMatchObject({
      durationMs: { n: 1, p50: H / 2 },
    })
    // The first confirmation was a rejection, the second let the plan run.
    expect(summary.planConfirm).toMatchObject({ rounds: 2, rejections: 1, rejectRate: 1 / 2 })
    // Platform work keeps its own kind in the unit detail: the page names it, not a raw key.
    expect(summary.members.map((member) => member.key)).not.toContain('system:orchestrator')
  })

  test('free collaboration reports the run budget instead of rounds', async () => {
    const summary = (await queriesOf({
      usageSince: 0,
      tasks: [
        {
          kind: 'workgroup',
          row: taskUnit({
            taskId: 'f1',
            subjectId: 'wg-3',
            subjectName: 'Sweepers',
            engineKind: 'workgroup-turns',
            startedAt: H,
            finishedAt: 3 * H,
            autoMs: H,
          }),
        },
      ],
      rosters: [
        {
          taskId: 'f1',
          mode: 'free_collab',
          leaderMemberId: null,
          members: [
            {
              id: 'm-a',
              memberType: 'agent',
              displayName: 'a',
              agentId: 'ag-a',
              agentName: 'a',
              userId: null,
              roleNote: null,
            },
          ],
          maxRounds: 40,
          pauseReason: null,
          configRevision: 1,
          planRejections: 0,
        },
      ],
      assignments: [
        assignment({
          taskId: 'f1',
          assignmentId: 'c1',
          source: 'self_claim',
          assigneeMemberId: 'm-a',
        }),
      ],
      nodeRuns: [
        nodeRun({
          taskId: 'f1',
          nodeRunId: 'r1',
          nodeId: MEMBER,
          rerunCause: 'wg-assignment',
          shardKey: 'batch:m-a:c1',
          startedAt: H,
          finishedAt: 2 * H,
        }),
        nodeRun({
          taskId: 'f1',
          nodeRunId: 'r2',
          nodeId: MEMBER,
          rerunCause: 'wg-message-turn',
          shardKey: 'msg:m-a:1',
          startedAt: 2 * H,
          finishedAt: 2.5 * H,
        }),
        nodeRun({
          taskId: 'f1',
          nodeRunId: 'r3',
          nodeId: MEMBER,
          rerunCause: 'wg-protocol-retry',
          shardKey: 'msg:m-a:1',
          startedAt: 2.5 * H,
          finishedAt: 3 * H,
        }),
      ],
    }).summary(admin, 'workgroup', 'wg-3', WINDOW)) as ProcessWorkgroupSummary
    expect(summary.mode).toBe('free_collab')
    expect(summary.rounds).toEqual([])
    // Two member runs count against the budget; the protocol retry does not.
    expect(summary.budget).toEqual({ usedMean: 2, limitMean: 40 })
    expect(summary.metrics.roundsPerUnit!.value).toBeNull()
    // Regression: a mode without a leader still listed an empty leader row, an empty leader
    // slice and a coordination share of 0%.
    expect(summary.members.map((member) => member.key)).toEqual(['member:m-a'])
    expect(summary.actors.map((slice) => slice.actor)).toEqual(['member'])
    expect(summary.metrics.coordinationShare!.value).toBeNull()
    // One protocol retry among the three turns.
    expect(summary.metrics.protocolRetryRate!.value).toBe(1 / 3)
    expect(summary.members[0]).toMatchObject({ protocolRetryRate: 1 / 3 })
  })

  test('outside leader dispatch the stored leader is a member like the others', async () => {
    // A group switched to free collaboration keeps the leader it had; that member takes cards now.
    const seed = workgroupScenario()
    seed.tasks = seed.tasks!.slice(0, 1)
    seed.rosters = [{ ...seed.rosters![0]!, mode: 'free_collab' }]
    seed.nodeRuns = [
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'p1',
        nodeId: MEMBER,
        rerunCause: 'wg-message-turn',
        shardKey: 'msg:m-lead:0001',
        startedAt: 10 * H,
        finishedAt: 11 * H,
      }),
    ]
    seed.usage = [usageRow({ taskId: 'g1', nodeRunId: 'p1', tokens: 80 })]
    seed.gateRuns = []
    seed.gateDecisions = []
    seed.gateRounds = []
    const summary = (await queriesOf(seed).summary(
      admin,
      'workgroup',
      'wg-1',
      WINDOW,
    )) as ProcessWorkgroupSummary
    expect(summary.members.find((member) => member.key === 'leader')).toBeUndefined()
    expect(summary.members.find((member) => member.key === 'member:m-lead')).toMatchObject({
      name: 'planner',
      role: 'member-agent',
      tokensPerUnit: 80,
    })
    expect(summary.actors).toEqual([{ actor: 'member', tokens: 80, costNano: 800 }])
    expect(summary.metrics.coordinationShare!.value).toBeNull()
  })

  test('the protocol retry rate counts protocol retries only, not retries of a failed process', async () => {
    // Regression: both are "automatic retries", and the rate counted both.
    const seed = workgroupScenario()
    seed.nodeRuns = [
      ...seed.nodeRuns!,
      nodeRun({
        taskId: 'g1',
        nodeRunId: 'a1r',
        nodeId: MEMBER,
        rerunCause: 'process-retry',
        wgRound: 1,
        shardKey: 'as-1',
        agentOverrideId: 'ag-code',
        startedAt: 12 * H,
        finishedAt: 12.25 * H,
      }),
    ]
    const queries = queriesOf(seed)
    const summary = (await queries.summary(
      admin,
      'workgroup',
      'wg-1',
      WINDOW,
    )) as ProcessWorkgroupSummary
    // Still the one protocol retry of the leader, now among nine host runs.
    expect(summary.metrics.protocolRetryRate!.value).toBe(1 / 9)
    const row = (key: string) => summary.members.find((member) => member.key === key)!
    expect(row('leader').protocolRetryRate).toBe(1 / 4)
    // m-a ran four times, one of them a retry of a failed process: no protocol retry.
    expect(row('member:m-a').protocolRetryRate).toBe(0)
    // The stability block still counts every automatic retry.
    expect(summary.stability.autoRetries).toBe(2)
    // The listing reads grouped executions and says the same.
    const list = await queries.subjects(admin, { kind: 'workgroup', from: 0, to: 1_000 * H })
    expect(list.items[0]).toMatchObject({ subjectId: 'wg-1' })
  })

  test('a round lasts until its last turn ends, also a turn that cannot be told apart between two members', async () => {
    // Regression: b1 ran with the agent m-b and m-c share; the round span skipped it.
    const seed = workgroupScenario()
    seed.nodeRuns = seed.nodeRuns!.map((run) =>
      run.nodeRunId === 'b1' ? { ...run, finishedAt: 12.75 * H } : run,
    )
    const summary = (await queriesOf(seed).summary(
      admin,
      'workgroup',
      'wg-1',
      WINDOW,
    )) as ProcessWorkgroupSummary
    // g1: 10 h → 12.75 h; g2: 30 h → 31 h.
    expect(summary.rounds[0]).toMatchObject({ round: 1, durationMs: (2.75 * H + H) / 2 })
    // The completion gate holder of round 2 is nobody's turn and does not stretch the round.
    expect(summary.rounds[1]).toMatchObject({ round: 2, durationMs: 2.5 * H })
  })

  test('a gate the platform closed when the task ended is not a decision', async () => {
    // Regression: canceling a task that waits at a gate closes the holder run; that read as one
    // more completion round without an outcome, and as an approved plan.
    const seed = workgroupScenario()
    // g2 ran for one of its two hours and waited at the gate for the other.
    seed.tasks = seed.tasks!.map((task) =>
      task.row.taskId === 'g2' ? { ...task, row: { ...task.row, autoMs: H } } : task,
    )
    seed.gateRuns = [
      ...seed.gateRuns!,
      {
        taskId: 'g2',
        nodeRunId: 'gate-x',
        kind: 'completion',
        openedAt: 31 * H,
        closedAt: 32 * H,
        round: 1,
        canceled: true,
      },
    ]
    const summary = (await queriesOf(seed).summary(
      admin,
      'workgroup',
      'wg-1',
      WINDOW,
    )) as ProcessWorkgroupSummary
    // Still g1's two decisions only.
    expect(summary.completion).toMatchObject({ rounds: 2, rejections: 1, rejectRate: 1 / 2 })
    expect(summary.interventions.gates.find((gate) => gate.kind === 'completion')).toEqual({
      kind: 'completion',
      perUnit: 1,
    })
    // The hour g2 waited at the gate is still time it spent waiting on people.
    const page = await queriesOf(seed).units(admin, 'workgroup', 'wg-1', {
      ...WINDOW,
      status: 'all',
    })
    expect(page.items.find((item) => item.unitId === 'g2')).toMatchObject({
      waits: [{ kind: 'completion', ms: H }],
      gateRounds: [],
    })
  })
})

const label = (text: string) => ({ 'zh-CN': text, 'en-US': text })
const manifest: ProcessEmployeeManifest = {
  typeId: 'development',
  typeRevision: 11,
  regions: [
    {
      regionId: 'delivery',
      label: label('Deliver an MR'),
      order: 0,
      lanes: [{ laneId: 'main', label: label('Main'), order: 0, kind: 'spine' }],
    },
    {
      regionId: 'care',
      label: label('Look after the MR'),
      order: 1,
      lanes: [
        { laneId: 'review', label: label('Review feedback'), order: 0, kind: 'branch' },
        { laneId: 'pipeline', label: label('Pipeline'), order: 1, kind: 'branch' },
      ],
    },
  ],
  workItems: [
    {
      workItemRef: 'implement',
      regionId: 'delivery',
      laneId: 'main',
      order: 0,
      label: label('Implement'),
      nodeKind: 'business-tool',
    },
    {
      workItemRef: 'plan-review',
      regionId: 'delivery',
      laneId: 'main',
      order: 1,
      label: label('Plan review'),
      nodeKind: 'collaboration',
    },
    {
      workItemRef: 'open-mr',
      regionId: 'delivery',
      laneId: 'main',
      order: 2,
      label: label('Open MR'),
      nodeKind: 'system',
    },
    {
      workItemRef: 'repair-feedback',
      regionId: 'care',
      laneId: 'review',
      order: 0,
      label: label('Fix review issues'),
      nodeKind: 'business-tool',
    },
    {
      workItemRef: 'repair-pipeline',
      regionId: 'care',
      laneId: 'pipeline',
      order: 0,
      label: label('Fix the pipeline'),
      nodeKind: 'business-tool',
    },
  ],
  reworkWorkItemRefs: ['repair-feedback', 'repair-pipeline'],
}

function caseRow(
  over: Partial<ProcessEmployeeCaseRow> & { caseId: string },
): ProcessEmployeeCaseRow {
  return {
    name: `case ${over.caseId}`,
    employeeId: 'emp-1',
    employeeName: 'Java backend',
    employeeRevision: 3,
    typeId: 'development',
    typeRevision: 11,
    origin: 'manual',
    ownerUserId: 'alice',
    state: 'terminal',
    terminalKind: 'merged',
    blockReason: null,
    createdAt: 0,
    terminalAt: 0,
    ...over,
  }
}

function round(
  over: Partial<ProcessEmployeeRoundRow> & { caseId: string; roundId: string; workItemRef: string },
): ProcessEmployeeRoundRow {
  return { state: 'completed', attemptOrdinal: 0, createdAt: 0, settledAt: 0, ...over }
}

const lifecycle = (caseId: string, at: number, previousState: string | null, state: string) => ({
  subjectRef: caseId,
  occurredAt: at,
  eventTypeId: 'platform.employee-case.state-changed',
  summaryJson: JSON.stringify({ previousState, state }),
})

function employeeScenario(): Partial<FakeProcessData> {
  return {
    usageSince: 0,
    manifests: new Map([['development@11', manifest]]),
    cases: [
      // Merged in one go.
      { row: caseRow({ caseId: 'k1', createdAt: 10 * H, terminalAt: 20 * H }) },
      // Merged after fixing review feedback twice and one block.
      {
        row: caseRow({
          caseId: 'k2',
          ownerUserId: 'dave',
          employeeRevision: 4,
          createdAt: 30 * H,
          terminalAt: 60 * H,
        }),
      },
      {
        row: caseRow({
          caseId: 'k3',
          terminalKind: 'execution-failed',
          createdAt: 70 * H,
          terminalAt: 72 * H,
        }),
      },
      {
        row: caseRow({
          caseId: 'k4',
          terminalKind: 'closed',
          createdAt: 80 * H,
          terminalAt: 81 * H,
        }),
      },
      {
        row: caseRow({
          caseId: 'k5',
          terminalKind: 'completed',
          createdAt: 90 * H,
          terminalAt: 91 * H,
        }),
      },
      {
        row: caseRow({
          caseId: 'k6',
          state: 'blocked',
          terminalKind: null,
          blockReason: 'external dependency unavailable',
          createdAt: 100 * H,
          terminalAt: null,
        }),
      },
    ],
    rounds: [
      round({
        caseId: 'k1',
        roundId: 'k1-i',
        workItemRef: 'implement',
        createdAt: 10 * H,
        settledAt: 12 * H,
      }),
      round({
        caseId: 'k1',
        roundId: 'k1-p',
        workItemRef: 'plan-review',
        createdAt: 12 * H,
        settledAt: 14 * H,
      }),
      round({
        caseId: 'k1',
        roundId: 'k1-m',
        workItemRef: 'open-mr',
        createdAt: 14 * H,
        settledAt: 15 * H,
      }),
      round({
        caseId: 'k2',
        roundId: 'k2-i',
        workItemRef: 'implement',
        attemptOrdinal: 2,
        createdAt: 30 * H,
        settledAt: 34 * H,
      }),
      round({
        caseId: 'k2',
        roundId: 'k2-m',
        workItemRef: 'open-mr',
        createdAt: 34 * H,
        settledAt: 35 * H,
      }),
      round({
        caseId: 'k2',
        roundId: 'k2-f1',
        workItemRef: 'repair-feedback',
        state: 'failed',
        createdAt: 40 * H,
        settledAt: 41 * H,
      }),
      round({
        caseId: 'k2',
        roundId: 'k2-f2',
        workItemRef: 'repair-feedback',
        createdAt: 42 * H,
        settledAt: 44 * H,
      }),
      // A superseded plan is not a round.
      round({
        caseId: 'k2',
        roundId: 'k2-x',
        workItemRef: 'repair-pipeline',
        state: 'obsolete',
        createdAt: 45 * H,
        settledAt: null,
      }),
      round({
        caseId: 'k3',
        roundId: 'k3-i',
        workItemRef: 'implement',
        state: 'failed',
        createdAt: 70 * H,
        settledAt: 72 * H,
      }),
      round({
        caseId: 'k6',
        roundId: 'k6-i',
        workItemRef: 'implement',
        state: 'running',
        createdAt: 100 * H,
        settledAt: null,
      }),
    ],
    metering: [
      { caseId: 'k1', roundId: 'k1-i', durationMs: 2 * H, totalTokens: 1_000 },
      { caseId: 'k2', roundId: 'k2-i', durationMs: 4 * H, totalTokens: 3_000 },
      { caseId: 'k2', roundId: 'k2-f2', durationMs: 2 * H, totalTokens: 900 },
    ],
    hostTasks: [
      { roundId: 'k1-i', taskId: 'h-k1-i' },
      { roundId: 'k1-p', taskId: 'h-k1-p' },
      // Three attempts of one round: the first is the first execution, the rest are retries.
      { roundId: 'k2-i', taskId: 'h-k2-i-1' },
      { roundId: 'k2-i', taskId: 'h-k2-i-2' },
      { roundId: 'k2-i', taskId: 'h-k2-i-3' },
      { roundId: 'k2-f2', taskId: 'h-k2-f2' },
    ],
    usage: [
      usageRow({ taskId: 'h-k1-i', tokens: 1_000 }),
      usageRow({ taskId: 'h-k2-i-1', tokens: 1_500 }),
      usageRow({ taskId: 'h-k2-i-2', tokens: 900 }),
      usageRow({ taskId: 'h-k2-i-3', tokens: 600 }),
      usageRow({ taskId: 'h-k2-f2', tokens: 900 }),
    ],
    gateRounds: [
      // The plan review of k1 happened in the host task of its plan-review round.
      gateRound({
        taskId: 'h-k1-p',
        gateNodeRunId: 'plan-run',
        openedAt: 12 * H,
        closedAt: 14 * H,
        outcome: 'approved',
        deciderUserId: 'bob',
        measures: { comments: 3, commenters: 1 },
        people: [{ userId: 'bob', comments: 3, answers: 0 }],
      }),
    ],
    approvals: [{ caseId: 'k2', submittedAt: 46 * H, settledAt: 50 * H, status: 'approved' }],
    events: [
      lifecycle('k2', 30 * H, null, 'active'),
      lifecycle('k2', 36 * H, 'active', 'blocked'),
      lifecycle('k2', 39 * H, 'blocked', 'active'),
      lifecycle('k2', 60 * H, 'active', 'terminal'),
      lifecycle('k6', 100 * H, null, 'active'),
      lifecycle('k6', 104 * H, 'active', 'blocked'),
    ],
    feedback: new Map<string, number | null>([
      ['k1', 0],
      ['k2', 8],
      ['k3', null],
    ]),
    operations: [
      {
        action: 'employee-case.resume',
        subjectKind: 'employee-case',
        subjectId: 'k2',
        actorUserId: 'bob',
        firstAt: 39 * H,
        lastAt: 39 * H,
      },
      {
        action: 'employee-case.terminate',
        subjectKind: 'employee-case',
        subjectId: 'k4',
        actorUserId: 'bob',
        firstAt: 81 * H,
        lastAt: 81 * H,
      },
      // Bob opened k1's plan half an hour after it was ready; the record hangs on the run that held it.
      {
        action: 'review.view',
        subjectKind: 'node-run',
        subjectId: 'plan-run',
        actorUserId: 'bob',
        firstAt: 12.5 * H,
        lastAt: 13 * H,
      },
    ],
    identities: [{ id: 'bob', username: 'bob', displayName: 'Bob' }],
  }
}

describe('RFC-616 digital employee summary', () => {
  const summaryFor = async (seed = employeeScenario(), actor = admin) =>
    (await queriesOf(seed).summary(
      actor,
      'digital-employee',
      'emp-1',
      WINDOW,
    )) as ProcessEmployeeSummary

  test('outcomes follow the terminal kind table', async () => {
    const summary = await summaryFor()
    expect(summary).toMatchObject({
      kind: 'digital-employee',
      subjectName: 'Java backend',
      typeId: 'development',
      typeRevision: 11,
      firstPassApplicable: true,
      // merged ×2 and "completed" succeed; execution-failed fails; closed is a cancel; blocked is active.
      counts: { total: 6, succeeded: 3, failed: 1, canceled: 1, active: 1 },
      outcomes: { merged: 2, noChange: 0, otherFinished: 2, failed: 1 },
    })
    const value = (id: keyof typeof summary.metrics) => summary.metrics[id]!.value
    expect(value('successRate')).toBe(3 / 5)
    expect(value('mergeRate')).toBe(2 / 5)
    // k2 and k6 were blocked.
    expect(value('blockedRate')).toBe(2 / 6)
    // Only merged cases are judged: k1 passed first time, k2 needed rework and was blocked.
    expect(value('firstPassRate')).toBe(1 / 2)
    // Ended cases: 1000 + 3900 + 0 + 0 + 0.
    expect(value('tokensPerUnit')).toBe(980)
    expect(summary.revisions).toEqual([
      { revision: 4, units: 1 },
      { revision: 3, units: 5 },
    ])
  })

  // Regression (2026-11-26): the first assignments of an installation showed no tokens, because
  // an assignment starts before the calls of its own tool runs do.
  test('an assignment whose tool runs made the oldest recorded calls is in the token sample; one with no call before them is not', async () => {
    const summary = await summaryFor({
      // The oldest call on record belongs to k1's first round, a minute after k1 was created.
      usageSince: 10 * H + M,
      manifests: new Map([['development@11', manifest]]),
      cases: [
        { row: caseRow({ caseId: 'k1', createdAt: 10 * H, terminalAt: 20 * H }) },
        // Ended before any call was recorded, and left none.
        { row: caseRow({ caseId: 'k0', createdAt: 8 * H, terminalAt: 9 * H }) },
      ],
      rounds: [
        round({
          caseId: 'k1',
          roundId: 'k1-i',
          workItemRef: 'implement',
          createdAt: 10 * H,
          settledAt: 12 * H,
        }),
        round({
          caseId: 'k0',
          roundId: 'k0-i',
          workItemRef: 'implement',
          createdAt: 8 * H,
          settledAt: 9 * H,
        }),
      ],
      metering: [{ caseId: 'k1', roundId: 'k1-i', durationMs: 2 * H, totalTokens: 1_000 }],
      hostTasks: [{ roundId: 'k1-i', taskId: 'h-k1-i' }],
      usage: [usageRow({ taskId: 'h-k1-i', tokens: 1_000 })],
    })
    expect(summary.counts).toMatchObject({ total: 2, succeeded: 2 })
    expect(summary.note).toMatchObject({ unitsWithoutUsage: 1 })
    expect(summary.metrics.tokensPerUnit!.value).toBe(1_000)
  })

  test('work items: rounds, attempts, tokens and which ones are rework', async () => {
    const summary = await summaryFor()
    expect(summary.regions.map((region) => region.regionId)).toEqual(['delivery', 'care'])
    expect(summary.workItems.map((item) => item.key)).toEqual([
      'implement',
      'plan-review',
      'open-mr',
      'repair-feedback',
      'repair-pipeline',
    ])
    const item = (key: string) => summary.workItems.find((entry) => entry.key === key)!
    expect(item('implement')).toMatchObject({
      label: label('Implement'),
      kind: 'work-item-tool',
      regionId: 'delivery',
      laneId: 'main',
      rework: false,
      units: 4,
      roundsPerUnit: 1,
      // Settled rounds: 2 h, 4 h, 2 h (the running one of k6 is not settled).
      roundMs: { n: 3, p50: 2 * H, p90: 4 * H },
      // Four rounds, two extra attempts.
      attemptsPerRound: 6 / 4,
      autoRetryRate: 2 / 6,
      failureRate: 1 / 3,
    })
    expect(item('plan-review')).toMatchObject({
      kind: 'work-item-collaboration',
      roundMs: { n: 1, p50: 2 * H },
      gateRoundsPerUnit: 1,
      gateWaitMsPerUnit: 2 * H,
    })
    expect(item('open-mr')).toMatchObject({ kind: 'work-item-system', units: 2, roundsPerUnit: 1 })
    expect(item('repair-feedback')).toMatchObject({
      rework: true,
      units: 1,
      roundsPerUnit: 2,
      failureRate: 1 / 2,
      tokensPerUnit: 900,
    })
    // Declared, never run (its only round was superseded).
    expect(item('repair-pipeline')).toMatchObject({ rework: true, units: 0, roundsPerUnit: null })
  })

  test('platform work done for a tool run is system work in the token split', async () => {
    // Regression: every token of a tool run was put on the round's own cause, so a digital
    // employee never showed any system work.
    const seed = employeeScenario()
    seed.usage = [
      ...seed.usage!,
      usageRow({ taskId: 'h-k1-i', purpose: 'system', systemKind: 'memory-distill', tokens: 35 }),
      usageRow({ taskId: 'h-k1-i', purpose: 'system', systemKind: 'change-narrative', tokens: 15 }),
    ]
    const summary = await summaryFor(seed)
    const tokens = Object.fromEntries(summary.causes.map((slice) => [slice.cause, slice.tokens]))
    // Per ended case: 1,050 + 3,900 over five.
    expect(summary.metrics.tokensPerUnit!.value).toBe(990)
    expect(tokens.system).toBe(10)
    // …and the split says what the platform was doing for the tool run.
    expect(summary.systemWork.map((slice) => [slice.kind, slice.tokens])).toEqual([
      ['memory-distill', 7],
      ['change-narrative', 3],
    ])
    expect(Object.values(tokens).reduce((total, value) => total + value, 0)).toBe(990)
    // The work item still carries all of it: the platform worked for that work item.
    expect(summary.workItems.find((item) => item.key === 'implement')!.tokensPerUnit).toBe(
      (1_050 + 3_000) / 3,
    )
  })

  test('retried attempts of a round are automatic retries in the token split', async () => {
    const summary = await summaryFor()
    const tokens = Object.fromEntries(summary.causes.map((slice) => [slice.cause, slice.tokens]))
    // First attempts: 1000 + 1500 + 900 = 3400; later attempts: 900 + 600 = 1500; over five ended cases.
    expect(tokens).toMatchObject({ first: 680, 'auto-retry': 300 })
    expect(summary.causes.reduce((sum, slice) => sum + slice.tokens, 0)).toBe(980)
  })

  test('delivery is split where the first region ends; waiting comes from reviews, approvals and blocks', async () => {
    const summary = await summaryFor()
    expect(summary.cycle).toEqual({
      sampleUnits: 2,
      // To "Open MR" settled: k1 5 h, k2 5 h.
      beforeBoundaryMs: 5 * H,
      // From there to merged: k1 5 h, k2 25 h — the median by nearest rank is the lower one.
      afterBoundaryMs: 5 * H,
      // k1 waited 2 h on the plan review; k2 3 h blocked + 4 h approval.
      waitMs: 2 * H,
      boundaryKey: 'open-mr',
    })
    expect(summary.review).toMatchObject({
      rounds: 1,
      firstPassRate: 1,
      commentsPerRound: 3,
      byStage: [{ stageKey: 'plan-review', relatedStageKey: 'plan-review', roundsPerUnit: 1 }],
      // Regression: the view records of a case's tool runs never reached the case, so these stayed empty.
      responseMs: { n: 1, p50: 0.5 * H },
      handlingMs: { n: 1, p50: 1.5 * H },
      people: [{ userId: 'bob', decisions: 1, comments: 3, responseP50: 0.5 * H }],
    })
    expect(summary.approvals).toEqual({
      perUnit: 1 / 5,
      waitMs: { n: 1, p50: 4 * H, p90: 4 * H, mean: 4 * H },
    })
    expect(summary.blocked).toEqual({
      units: 2,
      perUnit: 2 / 6,
      // Only the block that ended has a duration: 36 h → 39 h.
      durationMs: { n: 1, p50: 3 * H, p90: 3 * H, mean: 3 * H },
      resumes: 1,
      terminations: 1,
      current: [{ reason: 'external dependency unavailable', units: 1 }],
    })
    // Feedback is averaged over the ended cases whose type provides it: (0 + 8) / 2.
    expect(summary.feedbackPerUnit).toBe(4)
  })

  test('interventions: a resumed block is one intervention, not the block and the resume', async () => {
    // Regression: only a blocked case can be resumed, so the resume record and the blocked round
    // it closed are the same act; counting both made every resumed block two interventions.
    const summary = await summaryFor()
    expect(summary.interventions).toEqual({
      gates: [
        { kind: 'review', perUnit: 1 / 5 },
        { kind: 'approval', perUnit: 1 / 5 },
        { kind: 'blocked', perUnit: 1 / 5 },
      ],
      manualRetriesPerUnit: 0,
      // k4 was ended by a person; Bob's resume of k2 is the blocked round above.
      operationsPerUnit: 1 / 5,
    })
    // k1 its plan review, k2 the block and the approval, k4 the termination.
    expect(summary.metrics.interventionsPerUnit!.value).toBe(4 / 5)
  })

  test('a block that lasts until the case is ended was never handled: ending it is the intervention', async () => {
    const seed = employeeScenario()
    seed.cases = [
      ...seed.cases!,
      {
        row: caseRow({
          caseId: 'k7',
          terminalKind: 'closed',
          createdAt: 110 * H,
          terminalAt: 116 * H,
        }),
      },
    ]
    seed.events = [
      ...seed.events!,
      lifecycle('k7', 110 * H, null, 'active'),
      lifecycle('k7', 112 * H, 'active', 'blocked'),
      lifecycle('k7', 116 * H, 'blocked', 'terminal'),
    ]
    seed.operations = [
      ...seed.operations!,
      {
        action: 'employee-case.terminate',
        subjectKind: 'employee-case',
        subjectId: 'k7',
        actorUserId: 'bob',
        firstAt: 116 * H,
        lastAt: 116 * H,
      },
    ]
    const summary = await summaryFor(seed)
    // Six ended cases now; k7 adds one intervention (the termination), not two.
    expect(summary.metrics.interventionsPerUnit!.value).toBe(5 / 6)
    expect(summary.interventions.gates.find((gate) => gate.kind === 'blocked')).toEqual({
      kind: 'blocked',
      perUnit: 1 / 6,
    })
    expect(summary.blocked).toMatchObject({
      // It is still a case that was blocked …
      units: 3,
      // … but "blocked until resumed" has one sample only: k2's three hours.
      durationMs: { n: 1, p50: 3 * H },
      resumes: 1,
      terminations: 2,
    })
    // The four hours it sat blocked are time the case spent waiting.
    const page = await queriesOf(seed).units(admin, 'digital-employee', 'emp-1', {
      ...WINDOW,
      status: 'all',
    })
    expect(page.items.find((item) => item.unitId === 'k7')).toMatchObject({
      status: 'canceled',
      waits: [{ kind: 'blocked', ms: 4 * H }],
      gateRounds: [],
    })
  })

  test('a type that declares no rework work items has no first-pass rate', async () => {
    const seed = employeeScenario()
    seed.manifests = new Map([['development@11', { ...manifest, reworkWorkItemRefs: null }]])
    const summary = await summaryFor(seed)
    expect(summary.firstPassApplicable).toBe(false)
    expect(summary.metrics.firstPassRate).toEqual({ value: null, baseline: null })
    expect(summary.workItems.every((item) => !item.rework)).toBe(true)
  })

  test('without a manifest the work items are listed by reference', async () => {
    const seed = employeeScenario()
    seed.manifests = new Map()
    const summary = await summaryFor(seed)
    expect(summary.regions).toEqual([])
    expect(summary.cycle).toMatchObject({
      sampleUnits: 2,
      beforeBoundaryMs: null,
      boundaryKey: null,
    })
    expect(summary.workItems.map((item) => item.key).sort()).toEqual([
      'implement',
      'open-mr',
      'plan-review',
      'repair-feedback',
    ])
    expect(summary.workItems[0]).toMatchObject({ regionId: null, laneId: null })
    // The manifest could not be read: nothing says a work item was removed from it.
    const detail = await queriesOf(seed).unit(admin, 'digital-employee', 'k2')
    expect(detail!.stages.map((stage) => stage.removed)).toEqual(detail!.stages.map(() => false))
    expect(detail!.stages.length).toBeGreaterThan(0)
  })

  test('the listing row, the unit rows and the unit detail', async () => {
    const queries = queriesOf(employeeScenario())
    const list = await queries.subjects(admin, { kind: 'digital-employee', from: 0, to: 1_000 * H })
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({
      subjectId: 'emp-1',
      name: 'Java backend',
      units: 6,
      mergeRate: 2 / 5,
      blockedRate: 2 / 6,
      firstPassRate: 1 / 2,
      tokensPerUnit: 980,
      unpriced: false,
    })
    const page = await queries.units(admin, 'digital-employee', 'emp-1', {
      ...WINDOW,
      status: 'all',
    })
    const row = (id: string) => page.items.find((item) => item.unitId === id)!
    expect(page.items.map((item) => item.unitId)).toEqual(['k6', 'k5', 'k4', 'k3', 'k2', 'k1'])
    expect(row('k2')).toMatchObject({
      taskId: null,
      status: 'succeeded',
      outcome: 'merged',
      revision: 4,
      tokens: 3_900,
      autoRetries: 2,
      firstPass: false,
      rework: [{ key: 'repair-feedback', rounds: 2 }],
    })
    expect(row('k1')).toMatchObject({ firstPass: true, rework: [] })
    expect(row('k4')).toMatchObject({ status: 'canceled', outcome: 'closed', firstPass: null })
    expect(row('k6')).toMatchObject({ status: 'active', outcome: 'blocked' })
    expect(page.stageLabels).toEqual({ 'repair-feedback': label('Fix review issues') })
    expect(
      (
        await queries.units(admin, 'digital-employee', 'emp-1', {
          ...WINDOW,
          status: 'unsuccessful',
        })
      ).items.map((item) => item.unitId),
    ).toEqual(['k4', 'k3'])

    const detail = (await queries.unit(admin, 'digital-employee', 'k2'))!
    expect(detail.stages.map((stage) => [stage.key, stage.runs, stage.tokens])).toEqual([
      ['implement', 3, 3_000],
      ['open-mr', 1, 0],
      ['repair-feedback', 2, 900],
    ])
    expect(await queries.unit(alice, 'digital-employee', 'k2')).toBeNull()
  })

  test('a range without cases keeps the employee name', async () => {
    const quiet = { ...WINDOW, from: 200 * H, to: 300 * H }
    const summaryOf = async (actor: typeof admin, subjectId: string) =>
      (await queriesOf(employeeScenario()).summary(
        actor,
        'digital-employee',
        subjectId,
        quiet,
      )) as ProcessEmployeeSummary
    expect(await summaryOf(admin, 'emp-1')).toMatchObject({
      subjectName: 'Java backend',
      counts: { total: 0 },
    })
    expect((await summaryOf(person('zed', 'user'), 'emp-1')).subjectName).toBeNull()
    expect((await summaryOf(admin, 'emp-never')).subjectName).toBeNull()
  })

  test('a member sees only their own cases', async () => {
    const summary = await summaryFor(employeeScenario(), alice)
    expect(summary.scope).toBe('own')
    expect(summary.counts.total).toBe(5)
    expect(summary.review!.people).toBeNull()
  })
})

// The implementation gate found these wired but never exercised: a mistake in any of them
// would have shown wrong text to the model, a wrong baseline, or a hint nobody could trust.
describe('RFC-616 text collection for workgroups and digital employees', () => {
  const everyone = { userId: 'admin', canReadAll: true }
  const words = (
    source: ProcessTextItem['source'],
    target: { taskId?: string; caseId?: string },
    at: number,
    text: string,
    stageRef: string | null = null,
  ): ProcessTextItem => ({
    source,
    taskId: target.taskId ?? null,
    caseId: target.caseId ?? null,
    stageRef,
    at,
    text,
  })
  const listed = (
    items: readonly { source: string; unitId: string; stageKey: string | null; text: string }[],
  ) => items.map((item) => [item.source, item.unitId, item.stageKey, item.text])

  test('a workgroup: what people wrote in the room and answered; reviews are not read, and only the leader is a nameable stage', async () => {
    const seed = workgroupScenario()
    seed.workgroupTexts = [
      words('workgroup-message', { taskId: 'g1' }, 11 * H, 'Split the migration in two.'),
      words('workgroup-rejection', { taskId: 'g1' }, 17 * H, 'The rollback path is not tested.'),
      words('workgroup-message', { taskId: 'g2' }, 30.5 * H, 'Stop, the scope changed.'),
      // Another group's room.
      words('workgroup-message', { taskId: 'other' }, 12 * H, 'not ours'),
    ]
    seed.gateTexts = [
      words('clarify', { taskId: 'g1' }, 10.6 * H, 'Use the staging database.', LEADER),
      words('clarify', { taskId: 'g1' }, 11.2 * H, 'Keep the old column for now.', MEMBER),
      // A workgroup task holds no review; a stray one is not asked for.
      words('review', { taskId: 'g1' }, 12 * H, 'never read'),
    ]
    const texts = createProcessTexts(fakeProcessSources(seed).sources)
    const all = await texts.collect(everyone, 'workgroup', 'wg-1', WINDOW)
    expect(all).toMatchObject({ subjectName: 'Payments squad', units: 2, stageLabels: {} })
    expect(listed(all.items)).toEqual([
      ['workgroup-message', 'g1', null, 'Split the migration in two.'],
      ['workgroup-rejection', 'g1', null, 'The rollback path is not tested.'],
      ['workgroup-message', 'g2', null, 'Stop, the scope changed.'],
      ['clarify', 'g1', 'leader', 'Use the staging database.'],
      // "A member" asked: no one stage can be named.
      ['clarify', 'g1', null, 'Keep the old column for now.'],
    ])
    // A member's analysis reads only the rooms of their own tasks: g2 is Dave's.
    const own = await texts.collect(
      { userId: 'dave', canReadAll: false },
      'workgroup',
      'wg-1',
      WINDOW,
    )
    expect(own.units).toBe(1)
    expect(listed(own.items)).toEqual([
      ['workgroup-message', 'g2', null, 'Stop, the scope changed.'],
    ])
    // Outside the range there is nothing to read.
    expect(
      (await texts.collect(everyone, 'workgroup', 'wg-1', { from: 200 * H, to: 300 * H })).items,
    ).toEqual([])
  })

  test('a digital employee: feedback through its type, and the plan reviews held in the tool runs of its rounds', async () => {
    const seed = employeeScenario()
    seed.employeeTexts = [
      words(
        'employee-feedback',
        { caseId: 'k2' },
        40 * H,
        'Null check is missing.',
        'repair-feedback',
      ),
      words('employee-feedback', { caseId: 'k1' }, 16 * H, 'Looks good, merge it.'),
      // A case of another employee.
      words('employee-feedback', { caseId: 'elsewhere' }, 16 * H, 'not ours'),
    ]
    seed.gateTexts = [
      // h-k1-p is the tool run of k1's plan-review round.
      words('review', { taskId: 'h-k1-p' }, 13 * H, 'The plan has no rollback step.', 'plan'),
      // A question answered inside a tool run is not part of an employee's analysis.
      words('clarify', { taskId: 'h-k1-p' }, 13.5 * H, 'never read'),
      // A review in a task that is no tool run of this employee.
      words('review', { taskId: 'unrelated' }, 13 * H, 'not ours'),
    ]
    const texts = createProcessTexts(fakeProcessSources(seed).sources)
    const all = await texts.collect(everyone, 'digital-employee', 'emp-1', WINDOW)
    expect(all).toMatchObject({ subjectName: 'Java backend', units: 6 })
    expect(listed(all.items)).toEqual([
      ['employee-feedback', 'k2', 'repair-feedback', 'Null check is missing.'],
      ['employee-feedback', 'k1', null, 'Looks good, merge it.'],
      // Placed on the case and the work item of the round, not on the tool run's node.
      ['review', 'k1', 'plan-review', 'The plan has no rollback step.'],
    ])
    // Work items are named from the employee type's own map.
    expect(all.stageLabels).toMatchObject({
      'plan-review': label('Plan review'),
      'repair-feedback': label('Fix review issues'),
    })
    // Dave owns k2 only.
    const own = await texts.collect(
      { userId: 'dave', canReadAll: false },
      'digital-employee',
      'emp-1',
      WINDOW,
    )
    expect(own.units).toBe(1)
    expect(listed(own.items)).toEqual([
      ['employee-feedback', 'k2', 'repair-feedback', 'Null check is missing.'],
    ])
    // A case always belongs to an employee: "no subject" has nothing to read.
    expect(await texts.collect(everyone, 'digital-employee', null, WINDOW)).toEqual({
      subjectName: null,
      items: [],
      stageLabels: {},
      units: 0,
    })
  })
})

describe('RFC-616 comparisons for workgroups and digital employees', () => {
  test('a workgroup against the previous period: its own metrics get a baseline too', async () => {
    // [25 h, 40 h) holds g2; the fifteen hours before it hold g1.
    const summary = (await queriesOf(workgroupScenario()).summary(admin, 'workgroup', 'wg-1', {
      from: 25 * H,
      to: 40 * H,
      tzOffset: 0,
      compare: 'period',
    })) as ProcessWorkgroupSummary
    expect(summary.compare).toEqual({ mode: 'period', split: null, baselineUnits: 1 })
    expect(summary.counts).toMatchObject({ total: 1, failed: 1 })
    expect(summary.metrics.units).toEqual({ value: 1, baseline: 1 })
    expect(summary.metrics.roundsPerUnit).toEqual({ value: 1, baseline: 2 })
    expect(summary.metrics.assignmentsPerUnit).toEqual({ value: 1, baseline: 5 })
    expect(summary.metrics.tokensPerUnit).toEqual({ value: 200, baseline: 1_000 })
    // g2 spent everything on its leader; g1 a fifth.
    expect(summary.metrics.coordinationShare).toEqual({ value: 1, baseline: 200 / 1_000 })
    expect(summary.metrics.roundCapRate).toEqual({ value: 1, baseline: 0 })
    // The members table describes the compared range only: g2 ran its leader and nothing else.
    expect(summary.members.find((member) => member.key === 'leader')).toMatchObject({
      tokensPerUnit: 200,
    })
    expect(summary.members.find((member) => member.key === 'unattributed')).toBeUndefined()
    // A workgroup records no revision: nothing to list, in any comparison.
    expect(summary.revisions).toEqual([])
  })

  test('a digital employee against the previous period', async () => {
    // [60 h, 110 h) holds k3 … k6; the fifty hours before it hold k1 and k2.
    const summary = (await queriesOf(employeeScenario()).summary(
      admin,
      'digital-employee',
      'emp-1',
      {
        from: 60 * H,
        to: 110 * H,
        tzOffset: 0,
        compare: 'period',
      },
    )) as ProcessEmployeeSummary
    expect(summary.compare).toEqual({ mode: 'period', split: null, baselineUnits: 2 })
    expect(summary.counts).toMatchObject({
      total: 4,
      succeeded: 1,
      failed: 1,
      canceled: 1,
      active: 1,
    })
    expect(summary.metrics.units).toEqual({ value: 4, baseline: 2 })
    // No case of the range was merged; both earlier ones were.
    expect(summary.metrics.mergeRate).toEqual({ value: 0, baseline: 1 })
    expect(summary.metrics.blockedRate).toEqual({ value: 1 / 4, baseline: 1 / 2 })
    // The first-pass rate is judged on merged cases: none here, one of two before.
    expect(summary.metrics.firstPassRate).toEqual({ value: null, baseline: 1 / 2 })
    expect(summary.metrics.tokensPerUnit).toEqual({ value: 0, baseline: (1_000 + 3_900) / 2 })
    // The revision picker lists the range's own cases only (all on revision 3).
    expect(summary.revisions).toEqual([{ revision: 3, units: 4 }])
  })

  test('a digital employee split at a revision: at or above is current, below is the baseline', async () => {
    const summary = (await queriesOf(employeeScenario()).summary(
      admin,
      'digital-employee',
      'emp-1',
      {
        ...WINDOW,
        compare: 'version',
        split: 4,
      },
    )) as ProcessEmployeeSummary
    // Only k2 ran on revision 4.
    expect(summary.compare).toEqual({ mode: 'version', split: 4, baselineUnits: 5 })
    expect(summary.counts).toMatchObject({ total: 1, succeeded: 1 })
    expect(summary.outcomes).toMatchObject({ merged: 1 })
    expect(summary.metrics.units).toEqual({ value: 1, baseline: 5 })
    expect(summary.metrics.tokensPerUnit).toEqual({ value: 3_900, baseline: 1_000 / 4 })
    expect(summary.metrics.mergeRate).toEqual({ value: 1, baseline: 1 / 4 })
    // k2 needed rework and was blocked; of the older revision's cases only k1 was merged.
    expect(summary.metrics.firstPassRate).toEqual({ value: 0, baseline: 1 })
    // Work items describe the current group: k2 never held a plan review.
    expect(summary.workItems.find((item) => item.key === 'plan-review')?.units ?? 0).toBe(0)
    expect(summary.workItems.find((item) => item.key === 'repair-feedback')).toMatchObject({
      units: 1,
      roundsPerUnit: 2,
    })
    // Both groups stay listed so the split can be moved.
    expect(summary.revisions).toEqual([
      { revision: 4, units: 1 },
      { revision: 3, units: 5 },
    ])
  })
})

// Found on a real installation (2026-11-26): with no price line configured every listing showed
// "¥0.00". The rows of all three kinds carry the flag; the workflow row is in rfc616-process-queries.
describe('RFC-616 a listing row whose cost rests on calls without a price', () => {
  const unpriced = (seed: Partial<FakeProcessData>): Partial<FakeProcessData> => ({
    ...seed,
    usage: seed.usage!.map((row, index) =>
      index === 0 ? { ...row, unpricedCalls: 1, costNano: 0 } : row,
    ),
  })

  test('a workgroup', async () => {
    const list = await queriesOf(unpriced(workgroupScenario())).subjects(admin, {
      kind: 'workgroup',
      from: 0,
      to: 1_000 * H,
    })
    expect(list.items.map((row) => [row.subjectId, row.unpriced])).toEqual([['wg-1', true]])
  })

  test('a digital employee, through the host tasks of its rounds', async () => {
    const list = await queriesOf(unpriced(employeeScenario())).subjects(admin, {
      kind: 'digital-employee',
      from: 0,
      to: 1_000 * H,
    })
    expect(list.items.map((row) => [row.subjectId, row.unpriced])).toEqual([['emp-1', true]])
  })
})

describe('RFC-616 hints of a computed summary', () => {
  test('a workgroup whose leader spends a fifth of the tokens gets the coordination hint, with the number the tile shows', async () => {
    // Five tasks like g1's first round: the leader 300 tokens, one member 700.
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5']
    const seed = workgroupScenario()
    const roster = seed.rosters![0]!
    const summary = (await queriesOf({
      usageSince: 0,
      tasks: ids.map((taskId, index) => ({
        kind: 'workgroup' as const,
        row: taskUnit({
          taskId,
          subjectId: 'wg-1',
          subjectName: 'Payments squad',
          subjectRevision: null,
          engineKind: 'workgroup-turns',
          startedAt: (10 + index) * H,
          finishedAt: (11 + index) * H,
          autoMs: H,
        }),
      })),
      rosters: ids.map((taskId) => ({ ...roster, taskId })),
      assignments: ids.map((taskId) =>
        assignment({ taskId, assignmentId: `as-${taskId}`, round: 1, assigneeMemberId: 'm-a' }),
      ),
      nodeRuns: ids.flatMap((taskId, index) => [
        nodeRun({
          taskId,
          nodeRunId: `l-${taskId}`,
          nodeId: LEADER,
          rerunCause: 'wg-leader-round',
          wgRound: 1,
          startedAt: (10 + index) * H,
          finishedAt: (10.25 + index) * H,
        }),
        nodeRun({
          taskId,
          nodeRunId: `a-${taskId}`,
          nodeId: MEMBER,
          rerunCause: 'wg-assignment',
          wgRound: 1,
          shardKey: `as-${taskId}`,
          agentOverrideId: 'ag-code',
          startedAt: (10.25 + index) * H,
          finishedAt: (11 + index) * H,
        }),
      ]),
      usage: ids.flatMap((taskId) => [
        usageRow({ taskId, nodeRunId: `l-${taskId}`, tokens: 300 }),
        usageRow({ taskId, nodeRunId: `a-${taskId}`, tokens: 700 }),
      ]),
    }).summary(admin, 'workgroup', 'wg-1', WINDOW)) as ProcessWorkgroupSummary
    expect(summary.metrics.coordinationShare!.value).toBe(0.3)
    expect(summary.hints).toEqual([
      { id: 'coordination-high', severity: 'high', target: 'rounds', params: { share: 0.3 } },
    ])
  })

  test('a digital employee whose cases keep getting blocked gets the blocked hint; four cases are too few', async () => {
    const blockedCases = (count: number) => {
      const ids = Array.from({ length: count }, (_, index) => `b${index + 1}`)
      return {
        usageSince: 0,
        manifests: new Map([['development@11', manifest]]),
        cases: ids.map((caseId, index) => ({
          row: caseRow({
            caseId,
            terminalKind: 'merged',
            createdAt: (10 + index * 10) * H,
            terminalAt: (18 + index * 10) * H,
          }),
        })),
        // Every second case was blocked for two hours and resumed.
        events: ids.flatMap((caseId, index) =>
          index % 2 === 0
            ? [
                lifecycle(caseId, (10 + index * 10) * H, null, 'active'),
                lifecycle(caseId, (12 + index * 10) * H, 'active', 'blocked'),
                lifecycle(caseId, (14 + index * 10) * H, 'blocked', 'active'),
              ]
            : [lifecycle(caseId, (10 + index * 10) * H, null, 'active')],
        ),
      } satisfies Partial<FakeProcessData>
    }
    const summaryOf = async (count: number) =>
      (await queriesOf(blockedCases(count)).summary(
        admin,
        'digital-employee',
        'emp-1',
        WINDOW,
      )) as ProcessEmployeeSummary
    const five = await summaryOf(5)
    // b1, b3 and b5 were blocked.
    expect(five.metrics.blockedRate!.value).toBe(3 / 5)
    expect(five.hints.find((hint) => hint.id === 'blocked-high')).toEqual({
      id: 'blocked-high',
      severity: 'high',
      target: 'gates',
      params: { rate: 3 / 5, p50: 2 * H, current: 0 },
    })
    // The same share over four cases is below the minimum sample.
    const four = await summaryOf(4)
    expect(four.metrics.blockedRate!.value).toBe(2 / 4)
    expect(four.hints.find((hint) => hint.id === 'blocked-high')).toBeUndefined()
  })
})
