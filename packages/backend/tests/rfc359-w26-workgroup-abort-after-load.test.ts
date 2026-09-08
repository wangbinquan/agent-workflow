// The real persistence port supplies every row and commit. Only host arrival
// and load continuation are held to expose cancellation during an async read.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import {
  nodeRuns,
  tasks,
  workflows,
  workgroupAssignments,
  workgroupMessages,
  workgroupTaskState,
} from '@/db/schema'
import { createAgent } from '@/services/agent'
import { createLogger } from '@/util/log'
import { WG_MEMBER_NODE_ID } from '@/services/workgroup/launch'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import type {
  WorkgroupTurnHostRequest,
  WorkgroupTurnHostResult,
} from '@/modules/task-execution/public/commands'
import {
  createWorkgroupTurnsOperations,
  type WorkgroupTurnsPersistencePort,
} from '@/modules/resource-catalog/application/workgroups/workgroupTurnsDriver'
import { createWorkgroupTurnsPersistence } from '@/modules/resource-catalog/infrastructure/workgroupTurnsOperations'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

async function scenario(harness: ProviderHarness, holdSettlement: boolean) {
  const db = harness.db
  const taskId = 'w26-abort-task'
  const cardId = 'w26-abort-card'
  const pastRunId = 'w26-past-run'
  const now = 1_700_000_000_000
  // Same ordinary agent and free-collaboration setup as RFC-215 C-3(c).
  const agent = await createAgent(db, {
    name: 'wg-a',
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'work',
  })
  const config: WorkgroupRuntimeConfig = {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'free_collab',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 30,
    completionGate: false,
    instructions: 'x',
    goal: 'ship it',
    members: [
      {
        id: 'm-a',
        memberType: 'agent',
        agentName: 'wg-a',
        agentId: agent.id,
        userId: null,
        displayName: 'alpha',
        roleDesc: '',
      },
    ],
  }
  await db
    .insert(workflows)
    .values({ id: 'w26-abort-workflow', name: 'host', definition: '{}', builtin: true })
  await db.insert(tasks).values({
    id: taskId,
    name: 'wg-batch-task',
    workflowId: 'w26-abort-workflow',
    workflowSnapshot: '{}',
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: now,
    workgroupId: config.workgroupId,
    workgroupConfigJson: JSON.stringify(config),
  })
  await db.insert(nodeRuns).values({
    id: pastRunId,
    taskId,
    nodeId: WG_MEMBER_NODE_ID,
    status: 'done',
    rerunCause: 'wg-message-turn',
    shardKey: 'msg:m-a:0',
    startedAt: now,
  })
  await db.insert(workgroupAssignments).values({
    id: cardId,
    taskId,
    round: 0,
    source: 'self_claim',
    assigneeMemberId: null,
    title: 'parallel card',
    briefMd: 'brief of parallel card',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  })
  await db.insert(workgroupMessages).values({
    id: 'w26-human-message',
    taskId,
    round: 0,
    authorKind: 'human',
    authorUserId: 'u1',
    kind: 'chat',
    bodyMd: '@alpha please look',
    mentionsJson: JSON.stringify(['m-a']),
    createdAt: now,
  })

  const controller = new AbortController()
  const loadWindow = deferred()
  const settlementEntered = deferred()
  const settlementReleased = deferred()
  const settlementCommitted = deferred()
  const loadReturned = deferred()
  const requests: WorkgroupTurnHostRequest[] = []
  const pauseWrites: Array<string | null> = []
  const windows: Array<{ before: boolean; after: boolean; assignmentStatus: string | undefined }> =
    []
  let loadCalls = 0
  const actual = createWorkgroupTurnsPersistence({
    db,
    hostLedgerFactory: composeWorkgroupHostLedgerParticipantFactory({
      collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
    }),
    clarifyAskGate: createWorkgroupClarifyAskGate(db),
  })
  const persistence: WorkgroupTurnsPersistencePort = {
    ...actual,
    async load(id) {
      const ordinal = ++loadCalls
      const before = controller.signal.aborted
      const snapshot = await actual.load(id)
      if (ordinal === 3) {
        // The message turn has finished; the batch is still awaiting its host.
        // Keep this exact real snapshot while that original request completes.
        loadWindow.resolve()
        await settlementEntered.promise
        if (!holdSettlement) {
          await settlementCommitted.promise
          await tick()
        }
        windows.push({
          before,
          after: controller.signal.aborted,
          assignmentStatus: snapshot?.assignments.find((card) => card.id === cardId)?.status,
        })
        loadReturned.resolve()
      }
      return snapshot
    },
    async commit(input) {
      const settlesBatch = input.operations.some(
        (operation) =>
          operation.kind === 'transition-assignment' &&
          operation.assignmentId === cardId &&
          operation.to === 'done',
      )
      if (settlesBatch) {
        settlementEntered.resolve()
        if (holdSettlement) await settlementReleased.promise
      }
      const receipt = await actual.commit(input)
      for (const operation of input.operations) {
        if (operation.kind === 'set-pause-reason') pauseWrites.push(operation.reason)
      }
      if (settlesBatch) settlementCommitted.resolve()
      return receipt
    },
  }
  const originalHost = (request: WorkgroupTurnHostRequest): Promise<WorkgroupTurnHostResult> => {
    requests.push(request)
    if (requests.length >= 2) queueMicrotask(() => controller.abort())
    return Promise.resolve<WorkgroupTurnHostResult>(
      (request.hostOutputPorts ?? []).includes('wg_task_results')
        ? {
            status: 'done',
            outputs: { wg_task_results: JSON.stringify([{ task: 1, summary: 'card ok' }]) },
          }
        : { status: 'done', outputs: { wg_messages: '[]' } },
    )
  }
  const drive = createWorkgroupTurnsOperations(persistence).drive({
    taskId,
    signal: controller.signal,
    log: createLogger('w26-abort-load'),
    host: {
      async runHost(request) {
        if ((request.hostOutputPorts ?? []).includes('wg_task_results')) await loadWindow.promise
        return await originalHost(request)
      },
    },
  })
  return {
    taskId,
    cardId,
    pastRunId,
    drive,
    controller,
    requests,
    pauseWrites,
    windows,
    settlementReleased,
    settlementCommitted,
    loadReturned,
    loadWindow,
  }
}

describeEachProvider('RFC-359 W26 workgroup cancellation after load', (harness) => {
  test('cancellation during the real load continuation wins over its stale running-card snapshot', async () => {
    const run = await scenario(harness, false)
    try {
      const result = await run.drive
      expect(result.kind).toBe('canceled')
      expect(run.windows).toEqual([{ before: false, after: true, assignmentStatus: 'running' }])
      expect(run.controller.signal.aborted).toBe(true)
      expect(run.requests).toHaveLength(2)
      expect(
        run.requests.map((request) => (request.hostOutputPorts ?? []).includes('wg_task_results')),
      ).toEqual([false, true])
      const cards = await harness.db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.taskId, run.taskId))
      expect(cards.map((card) => ({ id: card.id, status: card.status }))).toEqual([
        { id: run.cardId, status: 'done' },
      ])
      const hosts = await harness.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, run.taskId))
      expect(hosts.filter((row) => row.id !== run.pastRunId).map((row) => row.status)).toEqual([
        'pending',
        'pending',
      ])
      expect(run.pauseWrites).toEqual([])
      const state = await harness.db
        .select()
        .from(workgroupTaskState)
        .where(eq(workgroupTaskState.taskId, run.taskId))
      expect(state[0]?.pauseReason).toBeNull()
    } finally {
      run.loadWindow.resolve()
      run.settlementReleased.resolve()
      run.controller.abort()
      await run.drive
    }
  })

  test('the post-load cancellation waits for the original in-flight commit before returning', async () => {
    const run = await scenario(harness, true)
    let returned = false
    void run.drive.then(() => {
      returned = true
    })
    try {
      await run.loadReturned.promise
      await tick()
      expect(run.windows).toEqual([{ before: false, after: true, assignmentStatus: 'running' }])
      expect(run.requests).toHaveLength(2)
      expect(run.controller.signal.aborted).toBe(true)
      expect(returned).toBe(false)
      const before = await harness.db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.id, run.cardId))
      expect(before[0]?.status).toBe('running')
      run.settlementReleased.resolve()
      expect((await run.drive).kind).toBe('canceled')
      await run.settlementCommitted.promise
      const after = await harness.db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.id, run.cardId))
      expect(after[0]?.status).toBe('done')
      expect(run.pauseWrites).toEqual([])
    } finally {
      run.loadWindow.resolve()
      run.settlementReleased.resolve()
      run.controller.abort()
      await run.drive
    }
  })
})
