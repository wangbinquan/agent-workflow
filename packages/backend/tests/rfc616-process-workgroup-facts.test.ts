// RFC-616 (design/RFC-616-process-metrics/design.md §6.2, §14 "工作组事实"): the
// workgroup facts process metrics are computed from, on both providers. The
// ledgers are written here by the code that writes them in production — the
// turn engine, the task room's commands and the node-run mint — so each fact is
// checked against what the platform really records:
//   - rosters: the running configuration, including a mid-task edit;
//   - assignments: one row per card, a person's delivery taken from the delivery
//     message (the card itself moves on to `done`);
//   - gate runs: the holder run of a completion gate or a plan confirmation,
//     opened when it was minted and closed by the decision;
//   - gate decisions: the room message a completion-gate decision leaves behind;
//   - activity and texts: what people wrote, and only that.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  WORKFLOW_SCHEMA_VERSION,
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  attributeWorkgroupHostRun,
  processCauseOf,
  uniqueAgentMembersOf,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type {
  WorkgroupTurnHostRequest,
  WorkgroupTurnHostResult,
  WorkgroupTurnLogger,
  WorkgroupTurnsOutcome,
} from '@/modules/task-execution/application/ports/workgroupTurnsOperations'
import {
  createProcessTaskFacts,
  createProcessWorkgroupFacts,
} from '@/modules/task-execution/composition/processFacts'
import { DW_GATE_CAUSE } from '@/modules/task-execution/domain/dynamicWorkflowGeneration'
import { DW_ORCHESTRATOR_NODE_ID } from '@/modules/task-execution/domain/dynamicWorkflowOrchestrator'
import { createHumanGatePersistenceParticipantInTx } from '@/modules/task-execution/infrastructure/humanGatePersistenceParticipant'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { PROCESS_FACT_ID_BATCH } from '@/platform/contracts/processFacts'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { describeEachProvider } from './helpers/eachProvider'
import { casGateStatus, setDwStateTx, setPauseReason } from './helpers/legacyWorkgroupState'
import {
  agentFixture,
  patchTaskFixture,
  readNodeRunFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { taskChildrenFixture } from './helpers/model/taskChildren'
import { withTargetMintIdentity } from './helpers/rfc395Mint'
import { composeTestWorkgroupTaskRoom } from './helpers/workgroupTaskRoom'
import { runWorkgroupTurns } from './helpers/workgroupTurns'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = Date.UTC(2026, 9, 1)

const body = (value: unknown) => ({ kind: 'json-body' as const, body: JSON.stringify(value) })

interface TestUser {
  readonly id: string
  readonly authority: DirectAuthenticatedAuthority
}

async function seedUser(db: PersistenceDb, id: string): Promise<TestUser> {
  const { users } = tablesOf(db)
  await insertOne(db, users, {
    id,
    username: id,
    displayName: id,
    role: 'user',
    createdAt: T0,
    updatedAt: T0,
  })
  const actor = buildActor({
    source: 'session',
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
  })
  // The room reads the flat `userId` of the authority projection as well as `user.id`.
  return {
    id,
    authority: Object.freeze({ ...actor, userId: id }) as unknown as DirectAuthenticatedAuthority,
  }
}

/** A leader-mode group: a leader, one worker and one person, with a completion gate. */
function squad(humanUserId: string, overrides: Record<string, unknown> = {}) {
  return {
    workgroupId: 'wg-rfc616',
    workgroupName: 'release squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 6,
    completionGate: true,
    goal: 'ship the release',
    instructions: 'be precise',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'lead-agent',
        agentId: 'agent-lead',
        userId: null,
        displayName: 'lead',
        roleDesc: '',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'coder-agent',
        agentId: 'agent-coder',
        userId: null,
        displayName: 'coder',
        roleDesc: 'writes the code',
      },
      {
        id: 'm-pm',
        memberType: 'human',
        agentName: null,
        agentId: null,
        userId: humanUserId,
        displayName: 'pm',
        roleDesc: 'accepts the result',
      },
    ],
    ...overrides,
  }
}

async function seedGroupTask(
  db: PersistenceDb,
  id: string,
  ownerUserId: string | null,
  config: object | string,
): Promise<string> {
  await workflowFixture(db, { id: `wf-${id}`, name: `wf-${id}`, definition: '{}' })
  await taskFixture(db, {
    id,
    name: `room ${id}`,
    workflowId: `wf-${id}`,
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: T0,
    ownerUserId,
    workgroupId: 'wg-rfc616',
    workgroupConfigJson: typeof config === 'string' ? config : JSON.stringify(config),
  })
  return id
}

/**
 * The production task room with a clock the test moves. Resuming the task after
 * a command is left out (the helper's default): this file reads the ledgers the
 * commands write, not what runs afterwards.
 */
function roomFor(db: PersistenceDb, clock: { value: number }) {
  return composeTestWorkgroupTaskRoom(db, { now: () => clock.value })
}

/**
 * Open the completion gate the way the turn engine does (`openCompletionGate`):
 * the gate state walks to `awaiting_confirmation` and a holder run is minted on
 * the leader node, already waiting, stamped with the round the gate opened in.
 */
async function openCompletionGate(
  db: PersistenceDb,
  taskId: string,
  wgRound: number,
): Promise<string> {
  await casGateStatus(db, taskId, { from: ['idle', 'rejected'], to: 'declared' })
  await casGateStatus(db, taskId, { from: ['declared'], to: 'awaiting_confirmation' })
  await patchTaskFixture(db, { id: taskId }, { status: 'awaiting_review' })
  return await new DrizzleNodeRunLifecyclePersistence(db).mint(
    withTargetMintIdentity({
      taskId,
      nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
      role: 'synthetic',
      syntheticKind: 'wg-gate',
      status: 'awaiting_review',
      cause: 'wg-gate',
      overrides: { identity: { shardKey: null, wgRound } },
    }),
  )
}

async function startedAtOf(db: PersistenceDb, nodeRunId: string): Promise<number> {
  const [run] = await readNodeRunFixtures(db, { id: nodeRunId })
  if (run?.startedAt == null) throw new Error(`node run '${nodeRunId}' has no start time`)
  return run.startedAt
}

const log: WorkgroupTurnLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
}

/** A host that answers each leader and member turn from a script. */
function scriptedHost(script: {
  leader: WorkgroupTurnHostResult[]
  member: WorkgroupTurnHostResult[]
}) {
  return {
    runHostNode: (request: WorkgroupTurnHostRequest): Promise<WorkgroupTurnHostResult> => {
      const queue = request.nodeId === WORKGROUP_TURN_LEADER_NODE_ID ? script.leader : script.member
      return Promise.resolve(
        queue.shift() ?? {
          status: 'failed',
          outputs: {},
          errorMessage: `no scripted result for ${request.nodeId}`,
        },
      )
    },
  }
}

function outcomeWhy(outcome: WorkgroupTurnsOutcome): string {
  return outcome.detail === undefined
    ? `outcome.kind=${outcome.kind}`
    : `outcome.kind=${outcome.kind} summary=${outcome.detail.summary} message=${outcome.detail.message}`
}

describeEachProvider('RFC-616 process workgroup facts', (harness) => {
  describe('rosters', () => {
    test('the running configuration: members, mode, leader, round limit, and what a mid-task edit changed', async () => {
      const db = harness.db
      const owner = await seedUser(db, 'u-owner')
      await seedUser(db, 'u-late')
      const config = squad(owner.id)
      const taskId = await seedGroupTask(db, 'roster', owner.id, {
        ...config,
        members: [
          ...config.members,
          // A member recorded before members carried a canonical agent id.
          {
            id: 'm-legacy',
            memberType: 'agent',
            agentName: 'old-agent',
            userId: null,
            displayName: 'legacy',
            roleDesc: '',
          },
        ],
      })
      const facts = createProcessWorkgroupFacts(db)

      expect(await facts.rosters([taskId])).toEqual([
        {
          taskId,
          mode: 'leader_worker',
          leaderMemberId: 'm-lead',
          members: [
            {
              id: 'm-lead',
              memberType: 'agent',
              displayName: 'lead',
              agentId: 'agent-lead',
              agentName: 'lead-agent',
              userId: null,
              roleNote: null,
            },
            {
              id: 'm-coder',
              memberType: 'agent',
              displayName: 'coder',
              agentId: 'agent-coder',
              agentName: 'coder-agent',
              userId: null,
              roleNote: 'writes the code',
            },
            {
              id: 'm-pm',
              memberType: 'human',
              displayName: 'pm',
              agentId: null,
              agentName: null,
              userId: owner.id,
              roleNote: 'accepts the result',
            },
            {
              id: 'm-legacy',
              memberType: 'agent',
              displayName: 'legacy',
              agentId: null,
              agentName: 'old-agent',
              userId: null,
              roleNote: null,
            },
          ],
          maxRounds: 6,
          pauseReason: null,
          configRevision: 1,
          planRejections: 0,
        },
      ])

      // A person edits the running configuration in the room.
      const room = roomFor(db, { value: T0 + HOUR })
      await room.commands.updateConfig(owner.authority, {
        taskId,
        submission: body({
          maxRounds: 9,
          removeMemberIds: ['m-coder'],
          addMembers: [
            {
              memberType: 'human',
              userId: 'u-late',
              displayName: 'late',
              roleDesc: 'reviews the release',
            },
          ],
        }),
      })
      await setPauseReason(db, taskId, 'max-rounds-wrapup')

      const [edited] = await facts.rosters([taskId])
      expect(edited).toMatchObject({
        mode: 'leader_worker',
        leaderMemberId: 'm-lead',
        maxRounds: 9,
        pauseReason: 'max-rounds-wrapup',
        configRevision: 2,
      })
      expect(edited?.members.map((member) => member.displayName)).toEqual([
        'lead',
        'pm',
        'legacy',
        'late',
      ])
      expect(edited?.members.at(-1)).toMatchObject({
        memberType: 'human',
        agentId: null,
        agentName: null,
        userId: 'u-late',
        roleNote: 'reviews the release',
      })
      // The launch facts of the task stay as frozen: the group name is not part of the edit.
      const viewer = { userId: owner.id, canReadAll: false }
      expect((await createProcessTaskFacts(db).unit(viewer, taskId))?.subjectName).toBe(
        'release squad',
      )
    })

    test('an unreadable running configuration leaves the frozen mode and leader; other tasks have no roster', async () => {
      const db = harness.db
      const owner = await seedUser(db, 'u-owner')
      // Valid JSON that is not a running configuration: only the launch fields can be read.
      await seedGroupTask(db, 'half', owner.id, {
        workgroupId: 'wg-rfc616',
        workgroupName: 'half squad',
        mode: 'leader_worker',
        goal: 'ship',
        leaderMemberId: 'm-lead',
      })
      await seedGroupTask(db, 'garbled', owner.id, '{not json')
      // A workgroup task that has neither a launch document nor a state row.
      await taskChildrenFixture(db, {
        id: 'bare',
        status: 'done',
        startedAt: T0,
        subjectKind: 'workgroup',
      })
      await workflowFixture(db, { id: 'wf-plain', name: 'wf-plain', definition: '{}' })
      await taskFixture(db, {
        id: 'plain-flow',
        workflowId: 'wf-plain',
        workflowSnapshot: '{}',
        repoPath: '/tmp/never-read',
        worktreePath: '/tmp/never-read-wt',
        baseBranch: 'main',
        branch: 'agent-workflow/plain-flow',
        status: 'done',
        inputs: '{}',
        startedAt: T0,
      })

      const rosters = await createProcessWorkgroupFacts(db).rosters([
        'half',
        'garbled',
        'bare',
        'plain-flow',
        'missing',
      ])
      const unread = {
        members: [],
        maxRounds: null,
        pauseReason: null,
        configRevision: 1,
        planRejections: 0,
      }
      expect(Object.fromEntries(rosters.map((roster) => [roster.taskId, roster]))).toEqual({
        half: { taskId: 'half', mode: 'leader_worker', leaderMemberId: 'm-lead', ...unread },
        garbled: { taskId: 'garbled', mode: null, leaderMemberId: null, ...unread },
        bare: { taskId: 'bare', mode: null, leaderMemberId: null, ...unread },
      })
    })
  })

  describe('assignments', () => {
    test('one row per card; a delivery by a person is read from the delivery message', async () => {
      const db = harness.db
      const owner = await seedUser(db, 'u-owner')
      const taskId = await seedGroupTask(db, 'cards', owner.id, squad(owner.id))
      const clock = { value: T0 }
      const room = roomFor(db, clock)
      const { workgroupAssignments, workgroupMessages } = tablesOf(db)
      // Cards the leader dealt in round 1: one to an agent, two to the person.
      for (const card of [
        { id: 'card-agent', assigneeMemberId: 'm-coder', status: 'done' as const },
        { id: 'card-human', assigneeMemberId: 'm-pm', status: 'dispatched' as const },
        { id: 'card-dropped', assigneeMemberId: 'm-pm', status: 'dispatched' as const },
      ])
        await insertOne(db, workgroupAssignments, {
          ...card,
          taskId,
          round: 1,
          source: 'leader',
          title: card.id,
          briefMd: '',
          createdAt: T0 + 10 * MINUTE,
          updatedAt: T0 + 10 * MINUTE,
        })

      // A person hands the worker another card by mentioning them.
      clock.value = T0 + 20 * MINUTE
      const posted = await room.commands.postMessage(owner.authority, {
        taskId,
        submission: body({ body: '@coder also cover the retry path' }),
      })
      expect(posted.assignmentIds).toHaveLength(1)
      const mentionedCard = posted.assignmentIds[0]!
      // The person delivers their own card, and cancels the other one.
      clock.value = T0 + 30 * MINUTE
      await room.commands.deliverAssignment(owner.authority, {
        taskId,
        assignmentId: 'card-human',
        submission: body({ body: 'the spec is attached' }),
      })
      clock.value = T0 + 40 * MINUTE
      await room.commands.cancelAssignment(owner.authority, {
        taskId,
        assignmentId: 'card-dropped',
      })
      // A later delivery message for the same card does not move the delivery time.
      await insertOne(db, workgroupMessages, {
        id: 'late-delivery',
        taskId,
        round: 1,
        authorKind: 'human',
        authorMemberId: 'm-pm',
        authorUserId: 'u-someone-else',
        kind: 'delivery',
        bodyMd: 'again',
        mentionsJson: '[]',
        assignmentId: 'card-human',
        createdAt: T0 + 50 * MINUTE,
      })
      // The leader's next turn reads the delivery and closes the card.
      await db
        .update(workgroupAssignments)
        .set({ status: 'done', updatedAt: T0 + 60 * MINUTE })
        .where(eq(workgroupAssignments.id, 'card-human'))

      const rows = await createProcessWorkgroupFacts(db).assignments([taskId])
      expect(Object.fromEntries(rows.map((row) => [row.assignmentId, row]))).toEqual({
        'card-agent': {
          taskId,
          assignmentId: 'card-agent',
          round: 1,
          source: 'leader',
          assigneeMemberId: 'm-coder',
          status: 'done',
          createdAt: T0 + 10 * MINUTE,
          updatedAt: T0 + 10 * MINUTE,
          deliveredAt: null,
          deliveredByUserId: null,
        },
        'card-human': {
          taskId,
          assignmentId: 'card-human',
          round: 1,
          source: 'leader',
          assigneeMemberId: 'm-pm',
          // The card has moved on; the delivery is still known.
          status: 'done',
          createdAt: T0 + 10 * MINUTE,
          updatedAt: T0 + 60 * MINUTE,
          deliveredAt: T0 + 30 * MINUTE,
          deliveredByUserId: owner.id,
        },
        'card-dropped': {
          taskId,
          assignmentId: 'card-dropped',
          round: 1,
          source: 'leader',
          assigneeMemberId: 'm-pm',
          status: 'canceled',
          createdAt: T0 + 10 * MINUTE,
          updatedAt: T0 + 40 * MINUTE,
          deliveredAt: null,
          deliveredByUserId: null,
        },
        [mentionedCard]: {
          taskId,
          assignmentId: mentionedCard,
          // No leader round has run yet.
          round: 0,
          source: 'human',
          assigneeMemberId: 'm-coder',
          status: 'dispatched',
          createdAt: T0 + 20 * MINUTE,
          updatedAt: T0 + 20 * MINUTE,
          deliveredAt: null,
          deliveredByUserId: null,
        },
      })
    })
  })

  describe('completion gate', () => {
    test('each holder run is one gate interval; the decision message closes it and says who decided what', async () => {
      const db = harness.db
      const owner = await seedUser(db, 'u-owner')
      const taskId = await seedGroupTask(db, 'gated', owner.id, squad(owner.id))
      const approvedId = await seedGroupTask(db, 'gated-ok', owner.id, squad(owner.id))
      const clock = { value: T0 }
      const room = roomFor(db, clock)
      const facts = createProcessWorkgroupFacts(db)
      // A configuration edit is a person's `system` message too, and is no decision.
      await room.commands.updateConfig(owner.authority, {
        taskId,
        submission: body({ maxRounds: 8 }),
      })

      const before = Date.now()
      const firstHolder = await openCompletionGate(db, taskId, 2)
      const after = Date.now()
      const firstOpenedAt = await startedAtOf(db, firstHolder)
      // The mint stamps the holder's start time: that is when the gate opened.
      expect(firstOpenedAt).toBeGreaterThanOrEqual(before)
      expect(firstOpenedAt).toBeLessThanOrEqual(after)
      expect(await facts.gateRuns([taskId])).toEqual([
        {
          taskId,
          nodeRunId: firstHolder,
          kind: 'completion',
          openedAt: firstOpenedAt,
          closedAt: null,
          round: 2,
          canceled: false,
        },
      ])
      expect(await facts.gateDecisions([taskId])).toEqual([])

      // The person rejects; the leader works two more rounds and the gate opens again.
      const rejectedAt = after + 5 * MINUTE
      clock.value = rejectedAt
      await room.commands.confirmGate(owner.authority, {
        taskId,
        submission: body({ decision: 'reject', comment: 'the concurrent path is not covered' }),
      })
      const secondHolder = await openCompletionGate(db, taskId, 4)
      const secondOpenedAt = await startedAtOf(db, secondHolder)

      expect(await facts.gateRuns([taskId])).toEqual([
        {
          taskId,
          nodeRunId: firstHolder,
          kind: 'completion',
          openedAt: firstOpenedAt,
          // Closed in the same transaction that wrote the decision message.
          closedAt: rejectedAt,
          round: 2,
          canceled: false,
        },
        {
          taskId,
          nodeRunId: secondHolder,
          kind: 'completion',
          openedAt: secondOpenedAt,
          closedAt: null,
          round: 4,
          canceled: false,
        },
      ])
      expect(await facts.gateDecisions([taskId])).toEqual([
        { taskId, at: rejectedAt, userId: owner.id, approved: false },
      ])

      // An approval on another task.
      const approvedHolder = await openCompletionGate(db, approvedId, 1)
      const approvedAt = Date.now() + 5 * MINUTE
      clock.value = approvedAt
      await room.commands.confirmGate(owner.authority, {
        taskId: approvedId,
        submission: body({ decision: 'approve' }),
      })
      expect(await facts.gateRuns([approvedId])).toEqual([
        {
          taskId: approvedId,
          nodeRunId: approvedHolder,
          kind: 'completion',
          openedAt: await startedAtOf(db, approvedHolder),
          closedAt: approvedAt,
          round: 1,
          canceled: false,
        },
      ])
      const decisions = await facts.gateDecisions([taskId, approvedId])
      expect(Object.fromEntries(decisions.map((row) => [row.taskId, row]))).toEqual({
        [taskId]: { taskId, at: rejectedAt, userId: owner.id, approved: false },
        [approvedId]: { taskId: approvedId, at: approvedAt, userId: owner.id, approved: true },
      })

      // Only the rejection leaves words to analyse; the approval and the edit note do not.
      expect(await facts.texts([taskId, approvedId])).toEqual([
        {
          source: 'workgroup-rejection',
          taskId,
          caseId: null,
          stageRef: null,
          at: rejectedAt,
          text: 'the concurrent path is not covered',
        },
      ])
      // None of the three messages is talk.
      expect(await facts.activity([taskId, approvedId])).toEqual([
        { taskId, humanMessages: 0 },
        { taskId: approvedId, humanMessages: 0 },
      ])

      // The holder runs sit on the leader node. They reach the execution facts
      // with their own cause, which is how the engine keeps them out of the leader's executions.
      const executions = await createProcessTaskFacts(db).executions([taskId])
      expect([...executions].sort((a, b) => (a.wgRound ?? 0) - (b.wgRound ?? 0))).toEqual([
        {
          taskId,
          nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
          rerunCause: 'wg-gate',
          containerRunId: null,
          wgRound: 2,
          runs: 1,
          endedRuns: 1,
          failedRuns: 0,
          interruptedRuns: 0,
          activeMs: rejectedAt - firstOpenedAt,
        },
        {
          taskId,
          nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
          rerunCause: 'wg-gate',
          containerRunId: null,
          wgRound: 4,
          runs: 1,
          endedRuns: 0,
          failedRuns: 0,
          interruptedRuns: 0,
          activeMs: 0,
        },
      ])
      expect(processCauseOf('wg-gate')).toBeNull()
    })

    test('a real group run: the engine opens the gate in the round it ended, the room closes it', async () => {
      const db = harness.db
      const owner = await seedUser(db, 'u-owner')
      const leaderAgent = { id: 'agent-rfc616-lead', name: 'rfc616-lead' }
      const workerAgent = { id: 'agent-rfc616-worker', name: 'rfc616-worker' }
      for (const agent of [leaderAgent, workerAgent])
        await agentFixture(db, {
          ...agent,
          description: '',
          bodyMd: agent.name,
          createdAt: T0,
          updatedAt: T0,
        })
      const taskId = await seedGroupTask(
        db,
        'driven',
        owner.id,
        squad(owner.id, {
          // Only the leader's cards start member turns in this script.
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          members: [
            {
              id: 'm-leader',
              memberType: 'agent',
              agentName: leaderAgent.name,
              agentId: leaderAgent.id,
              userId: null,
              displayName: 'lead',
              roleDesc: 'coordinates',
            },
            {
              id: 'm-worker',
              memberType: 'agent',
              agentName: workerAgent.name,
              agentId: workerAgent.id,
              userId: null,
              displayName: 'worker',
              roleDesc: 'implements',
            },
            {
              id: 'm-pm',
              memberType: 'human',
              agentName: null,
              agentId: null,
              userId: owner.id,
              displayName: 'pm',
              roleDesc: 'accepts the result',
            },
          ],
          leaderMemberId: 'm-leader',
        }),
      )

      // Round 1: the leader deals one card and the worker reports. Round 2: the leader declares done.
      const before = Date.now()
      const outcome = await runWorkgroupTurns({
        db,
        taskId,
        log,
        hooks: scriptedHost({
          leader: [
            {
              status: 'done',
              outputs: {
                wg_decision: JSON.stringify({ action: 'continue' }),
                wg_assignments: JSON.stringify([
                  { member: 'worker', title: 'do the thing', brief: 'details here' },
                ]),
              },
            },
            {
              status: 'done',
              outputs: { wg_decision: JSON.stringify({ action: 'done', summary: 'all set' }) },
            },
          ],
          member: [
            { status: 'done', outputs: { wg_result: JSON.stringify({ summary: 'done it' }) } },
          ],
        }),
      })
      const after = Date.now()
      // The group has a person and a completion gate, so "done" waits for the person.
      expect(outcome.kind, outcomeWhy(outcome)).toBe('awaiting_review')

      const workgroups = createProcessWorkgroupFacts(db)
      const tasks = createProcessTaskFacts(db)
      const cards = await workgroups.assignments([taskId])
      expect(cards).toHaveLength(1)
      expect(cards[0]).toMatchObject({
        taskId,
        round: 1,
        source: 'leader',
        assigneeMemberId: 'm-worker',
        status: 'done',
        deliveredAt: null,
        deliveredByUserId: null,
      })

      const gates = await workgroups.gateRuns([taskId])
      expect(gates).toHaveLength(1)
      expect(gates[0]).toMatchObject({ taskId, kind: 'completion', closedAt: null, round: 2 })
      expect(gates[0]!.openedAt).toBeGreaterThanOrEqual(before)
      expect(gates[0]!.openedAt).toBeLessThanOrEqual(after)

      // The host runs, attributed with the rule the room uses.
      const [roster] = await workgroups.rosters([taskId])
      const hostRoster = {
        leaderMemberId: roster?.leaderMemberId ?? null,
        assignmentIds: new Set(cards.map((card) => card.assignmentId)),
        uniqueAgentMemberById: uniqueAgentMembersOf(roster?.members ?? []),
      }
      const runs = await tasks.nodeRuns([taskId], {
        nodeIds: [WORKGROUP_TURN_LEADER_NODE_ID, WORKGROUP_TURN_MEMBER_NODE_ID],
      })
      expect(
        runs.map((run) => [
          run.rerunCause,
          run.wgRound,
          run.agentOverrideId,
          attributeWorkgroupHostRun(run, hostRoster)?.memberId ?? null,
        ]),
      ).toEqual([
        ['wg-leader-round', 1, leaderAgent.id, 'm-leader'],
        ['wg-assignment', 1, workerAgent.id, 'm-worker'],
        ['wg-leader-round', 2, leaderAgent.id, 'm-leader'],
        // The gate holder is nobody's turn.
        ['wg-gate', 2, null, null],
      ])
      expect(runs[1]?.shardKey).toBe(cards[0]!.assignmentId)
      // Grouped the same way: one group per (node, cause, round).
      expect(
        (await tasks.executions([taskId]))
          .map((row) => [row.nodeId, row.rerunCause, row.wgRound, row.runs].join(' | '))
          .sort(),
      ).toEqual(
        [
          `${WORKGROUP_TURN_LEADER_NODE_ID} | wg-gate | 2 | 1`,
          `${WORKGROUP_TURN_LEADER_NODE_ID} | wg-leader-round | 1 | 1`,
          `${WORKGROUP_TURN_LEADER_NODE_ID} | wg-leader-round | 2 | 1`,
          `${WORKGROUP_TURN_MEMBER_NODE_ID} | wg-assignment | 1 | 1`,
        ].sort(),
      )

      // The person approves in the room.
      await patchTaskFixture(db, { id: taskId }, { status: 'awaiting_review' })
      const approvedAt = after + 5 * MINUTE
      await roomFor(db, { value: approvedAt }).commands.confirmGate(owner.authority, {
        taskId,
        submission: body({ decision: 'approve' }),
      })
      const [closed] = await workgroups.gateRuns([taskId])
      const [decision] = await workgroups.gateDecisions([taskId])
      expect(closed).toMatchObject({ nodeRunId: gates[0]!.nodeRunId, closedAt: approvedAt })
      expect(decision).toEqual({ taskId, at: approvedAt, userId: owner.id, approved: true })
      // A decision and the gate it closed carry the same instant: that is how they pair.
      expect(closed?.closedAt).toBe(decision?.at)
    })
  })

  describe('a gate nobody decided', () => {
    test('a holder the platform closes when the task ends is marked as not decided', async () => {
      // Regression: the terminal sweep closes a parked holder with a finish time, exactly like
      // a decision does; only its status says that nobody decided.
      const db = harness.db
      const owner = await seedUser(db, 'u-owner')
      const taskId = await seedGroupTask(db, 'gated-then-canceled', owner.id, squad(owner.id))
      const facts = createProcessWorkgroupFacts(db)
      const holder = await openCompletionGate(db, taskId, 3)
      const openedAt = await startedAtOf(db, holder)

      // The task is canceled while the gate waits: the sweep the lifecycle consumer runs.
      const endedAt = openedAt + 10 * MINUTE
      const swept = await databaseSessionFor(db).transaction((tx) =>
        createHumanGatePersistenceParticipantInTx(tx).cancelTaskGateRuns({
          taskId,
          now: endedAt,
          cause: 'task-canceled',
        }),
      )
      expect(swept.map((row) => row.nodeRunId)).toEqual([holder])

      expect(await facts.gateRuns([taskId])).toEqual([
        {
          taskId,
          nodeRunId: holder,
          kind: 'completion',
          openedAt,
          closedAt: endedAt,
          round: 3,
          canceled: true,
        },
      ])
      expect(await facts.gateDecisions([taskId])).toEqual([])
    })
  })

  describe('plan confirmation', () => {
    test('a dynamic workflow: the holder run is the interval, the rejected plans are counted in the state', async () => {
      const db = harness.db
      const owner = await seedUser(db, 'u-owner')
      const taskId = await seedGroupTask(
        db,
        'planned',
        owner.id,
        squad(owner.id, { mode: 'dynamic_workflow', leaderMemberId: null, completionGate: false }),
      )
      const facts = createProcessWorkgroupFacts(db)
      expect((await facts.rosters([taskId]))[0]).toMatchObject({
        mode: 'dynamic_workflow',
        leaderMemberId: null,
        planRejections: 0,
      })

      // The generate engine parks a generated plan behind the confirm gate (`openDwGate`).
      await setDwStateTx(db, taskId, {
        phase: 'awaiting_confirm',
        generateAttempts: 0,
        rejectRounds: 0,
        generatedDef: {
          $schema_version: WORKFLOW_SCHEMA_VERSION,
          inputs: [],
          nodes: [],
          edges: [],
        },
      })
      const lifecycle = new DrizzleNodeRunLifecyclePersistence(db)
      const before = Date.now()
      const holder = await lifecycle.mint(
        withTargetMintIdentity({
          taskId,
          nodeId: DW_ORCHESTRATOR_NODE_ID,
          role: 'synthetic',
          syntheticKind: 'dw-gate',
          status: 'pending',
          cause: DW_GATE_CAUSE,
        }),
      )
      await lifecycle.set({
        nodeRunId: holder,
        to: 'awaiting_review',
        allowedFrom: ['pending'],
        reason: 'dw-gate-open',
      })
      const after = Date.now()
      await patchTaskFixture(db, { id: taskId }, { status: 'awaiting_review' })
      const openedAt = await startedAtOf(db, holder)
      expect(openedAt).toBeGreaterThanOrEqual(before)
      expect(openedAt).toBeLessThanOrEqual(after)
      expect(await facts.gateRuns([taskId])).toEqual([
        // The plan confirmation carries no round.
        {
          taskId,
          nodeRunId: holder,
          kind: 'plan-confirm',
          openedAt,
          closedAt: null,
          round: null,
          canceled: false,
        },
      ])

      // The person sends the plan back.
      const rejectedAt = after + 5 * MINUTE
      const receipt = await roomFor(db, { value: rejectedAt }).commands.confirmDynamicWorkflow(
        owner.authority,
        {
          taskId,
          submission: body({ decision: 'reject', comment: 'split it into smaller steps' }),
        },
      )
      expect(receipt).toEqual({ decision: 'reject' })

      expect(await facts.gateRuns([taskId])).toEqual([
        {
          taskId,
          nodeRunId: holder,
          kind: 'plan-confirm',
          openedAt,
          closedAt: rejectedAt,
          round: null,
          canceled: false,
        },
      ])
      expect((await facts.rosters([taskId]))[0]?.planRejections).toBe(1)
      // A plan confirmation writes no room message: nothing here is a completion-gate decision.
      expect(await facts.gateDecisions([taskId])).toEqual([])
      expect(await facts.texts([taskId])).toEqual([])
    })
  })

  describe('what people wrote', () => {
    test('activity counts chat and dispatch messages written by people; texts carry exactly those', async () => {
      const db = harness.db
      const owner = await seedUser(db, 'u-owner')
      const taskId = await seedGroupTask(db, 'talk', owner.id, squad(owner.id))
      const quietId = await seedGroupTask(db, 'quiet', owner.id, squad(owner.id))
      const clock = { value: T0 + 10 * MINUTE }
      const room = roomFor(db, clock)
      await room.commands.postMessage(owner.authority, {
        taskId,
        submission: body({ body: 'please keep the changelog short' }),
      })
      clock.value = T0 + 20 * MINUTE
      await room.commands.postMessage(owner.authority, {
        taskId,
        submission: body({ body: '@coder cover the retry path' }),
      })
      // Other things a person does in the room are not talk.
      clock.value = T0 + 30 * MINUTE
      await room.commands.updateConfig(owner.authority, {
        taskId,
        submission: body({ maxRounds: 9 }),
      })
      const { workgroupMessages } = tablesOf(db)
      const other = { taskId, round: 1, mentionsJson: '[]', createdAt: T0 + 40 * MINUTE }
      // Neither is what members and the platform itself write, whatever the kind.
      await insertOne(db, workgroupMessages, {
        ...other,
        id: 'member-chat',
        authorKind: 'member',
        authorMemberId: 'm-coder',
        kind: 'chat',
        bodyMd: 'on it',
      })
      await insertOne(db, workgroupMessages, {
        ...other,
        id: 'member-dispatch',
        authorKind: 'member',
        authorMemberId: 'm-lead',
        kind: 'dispatch',
        bodyMd: '@coder do the thing',
      })
      await insertOne(db, workgroupMessages, {
        ...other,
        id: 'goal-seed',
        authorKind: 'system',
        kind: 'chat',
        bodyMd: 'ship the release',
      })
      await insertOne(db, workgroupMessages, {
        ...other,
        id: 'human-delivery',
        authorKind: 'human',
        authorMemberId: 'm-pm',
        authorUserId: owner.id,
        kind: 'delivery',
        bodyMd: 'the spec is attached',
      })
      // The quiet room only ever heard from the platform.
      await insertOne(db, workgroupMessages, {
        ...other,
        taskId: quietId,
        id: 'quiet-nudge',
        authorKind: 'system',
        kind: 'nudge',
        bodyMd: 'declare done or dispatch',
      })

      const facts = createProcessWorkgroupFacts(db)
      // Every asked task gets a count, a room nobody wrote in included.
      expect(await facts.activity([taskId, quietId, 'missing'])).toEqual([
        { taskId, humanMessages: 2 },
        { taskId: quietId, humanMessages: 0 },
        { taskId: 'missing', humanMessages: 0 },
      ])
      expect(await facts.texts([taskId, quietId])).toEqual([
        {
          source: 'workgroup-message',
          taskId,
          caseId: null,
          stageRef: null,
          at: T0 + 10 * MINUTE,
          text: 'please keep the changelog short',
        },
        {
          source: 'workgroup-message',
          taskId,
          caseId: null,
          stageRef: null,
          at: T0 + 20 * MINUTE,
          text: '@coder cover the retry path',
        },
      ])
    })
  })

  describe('id lists', () => {
    test('more than 500 ids are refused; an empty list reads nothing', async () => {
      const facts = createProcessWorkgroupFacts(harness.db)
      const tooMany = Array.from({ length: PROCESS_FACT_ID_BATCH + 1 }, (_, index) => `id-${index}`)
      const atLimit = tooMany.slice(1)
      const readers: Record<string, (ids: readonly string[]) => Promise<readonly unknown[]>> = {
        rosters: (ids) => facts.rosters(ids),
        assignments: (ids) => facts.assignments(ids),
        gateRuns: (ids) => facts.gateRuns(ids),
        gateDecisions: (ids) => facts.gateDecisions(ids),
        activity: (ids) => facts.activity(ids),
        texts: (ids) => facts.texts(ids),
      }
      for (const [name, read] of Object.entries(readers)) {
        await expect(read(tooMany), name).rejects.toBeInstanceOf(RangeError)
        expect(await read([]), name).toEqual([])
        // Exactly at the limit is a legal batch; activity answers for every task asked.
        expect(await read(atLimit), name).toHaveLength(name === 'activity' ? atLimit.length : 0)
      }
      // A repeated id is read once.
      expect(await facts.activity(['same', 'same'])).toEqual([{ taskId: 'same', humanMessages: 0 }])
    })
  })
})
