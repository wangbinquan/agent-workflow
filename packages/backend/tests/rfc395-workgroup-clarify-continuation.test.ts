import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'
import { composeCollaborationTaskRolePolicy } from '@/modules/resource-catalog/composition'
// RFC-395 II-b T18 WGF: a task is already awaiting_human while its asking
// host/turn driver is still unwinding. Seal and dispatch are separate commits.
// Force the old driver's next snapshot into that gap, with dispatch on either
// side of snapshot delivery. There must be exactly one answer continuation,
// and the production queue renderer must give that run its Q&A.

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ClarifyAnswer, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { createClarifyRound } from '@/modules/collaboration/infrastructure/clarify/service'
import {
  autoDispatchClarifyRound,
  autoDispatchClarifyRoundWithDecision,
} from '@/modules/collaboration/infrastructure/clarify/autoDispatch'
import { buildClarifyQueueContext } from '@/modules/collaboration/infrastructure/clarify/queue'
import { prepareClarifyDecision } from '@/modules/collaboration/infrastructure/clarifyDecision'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { createWorkgroupTurnsOperations } from '@/modules/resource-catalog/application/workgroups/workgroupTurnsDriver'
import { createWorkgroupTurnsPersistence } from '@/modules/resource-catalog/infrastructure/workgroupTurnsOperations'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import { createHumanGatePersistenceParticipantInTx } from '@/modules/task-execution/infrastructure/humanGatePersistenceParticipant'
import { buildWorkgroupHostSnapshot } from '@/modules/task-execution/infrastructure/workgroupRuntimeConfig'
import type {
  WorkgroupTurnHostRequest,
  WorkgroupTurnHostResult,
} from '@/modules/task-execution/public/commands'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import {
  agentFixture,
  clarifyRoundFixture,
  nodeRunFixture,
  patchNodeRunFixture,
  patchTaskFixture,
  readClarifyRoundFixtures,
  readNodeRunFixtures,
  readTaskFixtures,
} from './helpers/model'
import { mkQ, seedTask } from './helpers/questionDispatchFixture'

const LEADER = '__wg_leader__'
const CLARIFY = '__wg_clarify__'
const actor = { userId: 'u1', role: 'owner' as const }
const answers: ClarifyAnswer[] = [
  {
    questionId: 'release-strategy',
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: 'WGF_BLUE_GREEN_ANSWER',
  },
]
const memoryDistillEnqueuer = { enqueue: async () => null }
const log = createLogger('wgf-clarify-continuation-test')

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

describeEachProvider('RFC-395 WGF leader answer continuation', (h) => {
  async function setup() {
    const taskId = ulid()
    await seedTask(h.db, taskId)
    const agentId = ulid()
    const agentName = `wgf-leader-${agentId.toLowerCase()}`
    await agentFixture(h.db, {
      id: agentId,
      name: agentName,
      description: '',
      bodyMd: 'Coordinate the release.',
    })
    const config: WorkgroupRuntimeConfig = {
      workgroupId: `group-${taskId}`,
      workgroupName: 'WGF',
      mode: 'leader_worker',
      leaderMemberId: 'lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 10,
      completionGate: false,
      clarifyBudget: 2,
      instructions: 'Ask for the release strategy, then finish.',
      goal: 'Ship the release.',
      members: [
        {
          id: 'lead',
          memberType: 'agent',
          agentId,
          agentName,
          userId: null,
          displayName: 'lead',
          roleDesc: 'coordinate',
        },
        {
          id: 'human',
          memberType: 'human',
          agentId: null,
          agentName: null,
          userId: actor.userId,
          displayName: 'owner',
          roleDesc: 'answer',
        },
      ],
    }
    const definition = buildWorkgroupHostSnapshot(config)
    await patchTaskFixture(
      h.db,
      { id: taskId },
      {
        status: 'running',
        workgroupId: config.workgroupId,
        workgroupConfigJson: JSON.stringify(config),
        workflowSnapshot: JSON.stringify(definition),
      },
    )
    const persistence = createWorkgroupTurnsPersistence({
      db: h.db,
      hostLedgerFactory: composeWorkgroupHostLedgerParticipantFactory({
        collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
      }),
      clarifyAskGate: createWorkgroupClarifyAskGate(h.db),
    })
    return { taskId, definition, persistence, ...epoch2RuntimeTestPorts(h.db) }
  }

  for (const dispatchOrder of ['after-driver', 'before-snapshot-delivery'] as const) {
    test(`seal gap: dispatch ${dispatchOrder} cannot mint a competing leader`, async () => {
      const f = await setup()
      const opened = deferred<Awaited<ReturnType<typeof createClarifyRound>>>()
      const releaseAskingHost = deferred()
      const gapRead = deferred()
      const releaseSnapshot = deferred()
      let inspectGap = false
      let gapParked: boolean | undefined
      const calls: Array<{ id: string; cause: string | null; prompt: string }> = []
      const driver = createWorkgroupTurnsOperations({
        ...f.persistence,
        async load(taskId) {
          const snapshot = await f.persistence.load(taskId)
          if (inspectGap) {
            inspectGap = false
            gapParked = snapshot?.leaderClarifyParked
            gapRead.resolve()
            if (dispatchOrder === 'before-snapshot-delivery') await releaseSnapshot.promise
          }
          return snapshot
        },
      })
      const host = {
        async runHost(request: WorkgroupTurnHostRequest): Promise<WorkgroupTurnHostResult> {
          const [run] = await readNodeRunFixtures(h.db, { id: request.nodeRunId })
          if (!run) throw new Error('host run was not committed')
          const queue = await buildClarifyQueueContext({
            db: h.db,
            taskId: f.taskId,
            definition: f.definition,
            consumerNodeId: LEADER,
            dispatchedRunId: run.id,
            iteration: 0,
            envelopeNonce: run.envelopeNonce ?? '',
          })
          calls.push({
            id: run.id,
            cause: run.rerunCause,
            prompt: request.promptTemplate + (queue?.block ?? ''),
          })
          await patchNodeRunFixture(h.db, { id: run.id }, { status: 'done' })
          if (calls.length === 1) {
            const round = await createClarifyRound({
              taskRolePolicy: composeCollaborationTaskRolePolicy(),
              db: h.db,
              taskLock: createHumanGatePersistenceParticipantInTx,
              historyRestrictions: f.historyRestrictions,
              content: f.content,
              taskId: f.taskId,
              kind: 'self',
              askingNodeId: LEADER,
              askingNodeRunId: run.id,
              askingShardKey: null,
              intermediaryNodeId: CLARIFY,
              questions: [mkQ('release-strategy')],
              iteration: 0,
            })
            opened.resolve(round)
            // Production parks the task inside gate-open before returning from
            // runHost. The HTTP answer can commit while this host unwinds.
            await releaseAskingHost.promise
            return { status: 'awaiting' as const, outputs: {} }
          }
          return {
            status: 'done' as const,
            outputs: { wg_decision: JSON.stringify({ action: 'done', summary: 'released' }) },
          }
        },
      }
      const firstDrive = driver.drive({ taskId: f.taskId, log, host })
      const round = await Promise.race([
        opened.promise,
        firstDrive.then(() => {
          throw new Error('driver ended before asking')
        }),
      ])
      const [parked] = await readTaskFixtures(h.db, { id: f.taskId })
      expect(parked?.status).toBe('awaiting_human')
      const prepared = await prepareClarifyDecision({
        taskExecutionParticipants,
        db: h.db,
        taskLock: createHumanGatePersistenceParticipantInTx,
        historyRestrictions: f.historyRestrictions,
        taskId: f.taskId,
        originNodeRunId: round.intermediaryNodeRunId,
        roundId: round.round.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        answers,
        directive: 'stop',
        taskRevision: parked!.lifecycleEventRevision,
        decision: {},
      })
      const dispatch = await autoDispatchClarifyRound({
        taskExecutionParticipants,
        db: h.db,
        memoryDistillEnqueuer,
        originNodeRunId: round.intermediaryNodeRunId,
        answers,
        directive: 'stop',
        actor,
        decisionParticipant: prepared.participant,
        committedOperationId: prepared.operationId,
        async afterSealCommit() {
          inspectGap = true
          releaseAskingHost.resolve()
          await gapRead.promise
          if (dispatchOrder === 'after-driver') await firstDrive
        },
      })
      releaseSnapshot.resolve()
      const firstOutcome = await firstDrive
      const final = await driver.drive({ taskId: f.taskId, log, host })
      const runs = (await readNodeRunFixtures(h.db, { taskId: f.taskId })).filter(
        (run) => run.nodeId === LEADER,
      )
      // Report all facts on failure: the pre-fix version deterministically
      // produces 3 runs, including a fresh wg-leader-round competing with the
      // clarify-answer run (and aging its Q&A in the delayed-snapshot ordering).
      expect(
        runs.map((run) => ({
          id: run.id,
          seq: run.seq,
          cause: run.rerunCause,
          round: run.wgRound,
        })),
        JSON.stringify({ gapParked, calls, firstOutcome, final }),
      ).toHaveLength(2)
      expect(gapParked).toBe(true)
      expect(firstOutcome.kind).toBe('awaiting_human')
      expect(final.kind).toBe('ok')
      expect(dispatch.dispatch.reruns).toHaveLength(1)
      expect(calls.map((call) => call.id)).toEqual([
        runs[0]!.id,
        dispatch.dispatch.reruns[0]!.nodeRunId,
      ])
      expect(calls.map((call) => call.cause)).toEqual(['wg-leader-round', 'clarify-answer'])
      expect(calls[0]!.prompt).not.toContain('## Clarify Q&A')
      expect(calls[1]!.prompt).toContain('## Clarify Q&A')
      expect(calls[1]!.prompt).toContain('WGF_BLUE_GREEN_ANSWER')
      expect(runs.every((run) => run.status === 'done')).toBe(true)
      // Epoch 1 counts the adopted clarify continuation as the next leader
      // round; preserve that budget rather than counting a competing wake.
      expect(runs.map((run) => run.wgRound)).toEqual([1, 2])
      expect((await f.persistence.load(f.taskId))?.leaderClarifyParked).toBe(false)
      const [sealed] = await readClarifyRoundFixtures(h.db, { id: round.round.id })
      expect(sealed?.status).toBe('answered')
      const { taskQuestions } = tablesOf(h.db)
      const entries = await h.db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.taskId, f.taskId))
      expect(entries).toHaveLength(1)
      expect(entries[0]!.dispatchedAt).not.toBeNull()
      expect(entries[0]!.triggerRunId).toBe(calls[1]!.id)

      // Recovery/HTTP replay may log the same origin twice. Its durable receipt
      // must replay the existing dispatch, never mint another continuation.
      const replay = await autoDispatchClarifyRoundWithDecision({
        taskExecutionParticipants,
        db: h.db,
        taskLock: createHumanGatePersistenceParticipantInTx,
        historyRestrictions: f.historyRestrictions,
        memoryDistillEnqueuer,
        originNodeRunId: round.intermediaryNodeRunId,
        answers,
        directive: 'stop',
        actor,
      })
      expect(replay.receipt.replayed).toBe(true)
      expect(replay.dispatch.reruns).toEqual(dispatch.dispatch.reruns)
      expect(
        (await readNodeRunFixtures(h.db, { taskId: f.taskId })).filter(
          (run) => run.nodeId === LEADER,
        ),
      ).toHaveLength(2)
    })
  }

  test('only an open sealed-undispatched self answer extends the leader park', async () => {
    const cases = [
      {
        status: 'answered',
        sealed: true,
        confirmation: 'open',
        dispatched: false,
        leader: true,
        parked: true,
      },
      {
        status: 'answered',
        sealed: false,
        confirmation: 'open',
        dispatched: false,
        leader: true,
        parked: false,
      },
      {
        status: 'answered',
        sealed: true,
        confirmation: 'confirmed',
        dispatched: false,
        leader: true,
        parked: false,
      },
      {
        status: 'answered',
        sealed: true,
        confirmation: 'open',
        dispatched: true,
        leader: true,
        parked: false,
      },
      {
        status: 'canceled',
        sealed: true,
        confirmation: 'open',
        dispatched: false,
        leader: true,
        parked: false,
      },
      {
        status: 'abandoned',
        sealed: true,
        confirmation: 'open',
        dispatched: false,
        leader: true,
        parked: false,
      },
      {
        status: 'answered',
        sealed: true,
        confirmation: 'open',
        dispatched: false,
        leader: false,
        parked: false,
      },
    ] as const
    for (const scenario of cases) {
      const f = await setup()
      // Only cross rounds may be abandoned; self rounds use canceled.
      const kind = scenario.status === 'abandoned' ? 'cross' : 'self'
      const askingRunId = ulid()
      const gateRunId = ulid()
      const askingNodeId = scenario.leader ? LEADER : '__wg_member__'
      await nodeRunFixture(h.db, [
        { id: askingRunId, taskId: f.taskId, nodeId: askingNodeId, status: 'done', wgRound: 1 },
        { id: gateRunId, taskId: f.taskId, nodeId: CLARIFY, status: 'done' },
      ])
      await clarifyRoundFixture(h.db, {
        id: ulid(),
        taskId: f.taskId,
        kind,
        askingNodeId,
        askingNodeRunId: askingRunId,
        intermediaryNodeId: CLARIFY,
        intermediaryNodeRunId: gateRunId,
        questions: [mkQ('release-strategy')],
        answers,
        status: scenario.status,
      })
      const { taskQuestions } = tablesOf(h.db)
      await insertOne(h.db, taskQuestions, {
        id: ulid(),
        taskId: f.taskId,
        originNodeRunId: gateRunId,
        questionId: 'release-strategy',
        questionTitle: 'Release strategy',
        sourceKind: kind,
        roleKind: kind === 'self' ? 'self' : 'questioner',
        iteration: 0,
        loopIter: 0,
        defaultTargetNodeId: askingNodeId,
        confirmation: scenario.confirmation,
        sealedAt: scenario.sealed ? 1 : null,
        dispatchedAt: scenario.dispatched ? 2 : null,
        createdAt: 1,
        updatedAt: 1,
      })
      expect(
        (await f.persistence.load(f.taskId))?.leaderClarifyParked,
        JSON.stringify(scenario),
      ).toBe(scenario.parked)
    }
  })
})
