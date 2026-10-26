import { createNodeRunQueries } from '@/modules/task-execution/infrastructure/nodeRunQueries'
import { producerShardSlot } from '@/modules/task-execution/domain/runInputShard'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createTaskCreationParticipantInTx } from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import type { RunSlot } from '@/modules/task-execution/application/ports/runSelection'
import { describeEachProvider } from './helpers/eachProvider'
const slot: RunSlot = {
  kind: 'node',
  nodeId: 'worker',
  frame: { containerRunId: null, iteration: 0 },
}
import type {
  HistoryRestrictionPort,
  HistoryRestrictionRequest,
} from '@/platform/contracts/historyRestriction'
import { assertTaskHistoryExecutableInTx } from '@/modules/task-execution/infrastructure/taskRecoveryOperations'
import { createRunSelectionParticipantInTx } from '@/modules/task-execution/infrastructure/runSelection/table/selectionWrite'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'

describeEachProvider('RFC-395 N-b execution restrictions', (h) => {
  async function seed() {
    await h.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create({
        subject: { kind: 'workflow', sourceId: 'w' },
        core: {
          id: 't',
          name: 't',
          status: 'failed',
          startedAt: 1,
          ownerUserId: null,
          catalogVisibility: 'public',
          branchStartedAt: 1,
        },
        definition: {
          definitionOrigin: 'authored',
          workflowSnapshot: '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[]}',
          workflowVersion: 4,
          inputs: '{}',
        },
        launch: { kind: 'root', launchOrigin: 'api' },
        launchContext: {},
        workspace: {
          repoPath: '',
          worktreePath: '',
          baseBranch: '',
          branch: 'task/t',
          baseCommit: null,
          spaceKind: 'scratch',
        },
        repos: [],
        nodePaths: [],
      }),
    )
    const { nodeRuns } = tablesOf(h.db)
    for (const [seq, id] of ['r1', 'r2'].entries())
      await h.db.insert(nodeRuns).values({
        id,
        taskId: 't',
        nodeId: 'worker',
        seq: seq + 1,
        role: 'node-attempt',
        slotKey: encodeCanonicalRunSlot(slot),
        generationSeq: 0,
        attemptIndex: seq,
        scopePath: '',
        recordMode: 'executable',
        provenanceQuality: 'recorded',
        envelopeNonce: `nonce-${id}`,
        status: 'running',
        inputsRecorded: false,
      })
  }

  async function select() {
    await h.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
      await createRunSelectionParticipantInTx().apply(tx, [
        {
          kind: 'select',
          taskId: 't',
          slot,
          run: {
            id: 'r2',
            taskId: 't',
            slot,
            containerRunId: null,
            parentNodeRunId: null,
            shardKey: null,
          },
          expectedRevision: 0,
          generationSeq: 0,
          cause: 'test',
        },
      ])
    })
  }
  test('selected runs are checked but their unselected history-only producers do not block execution', async () => {
    await seed()
    await select()
    const { nodeRuns, nodeRunInputs } = tablesOf(h.db)
    await h.db.insert(nodeRuns).values({
      id: 'unrelated',
      taskId: 't',
      nodeId: 'unknown',
      seq: 3,
      role: null,
      slotKey: null,
      generationSeq: 0,
      attemptIndex: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      status: 'done',
    })
    await h.db
      .update(nodeRuns)
      .set({ recordMode: 'history-only', envelopeNonce: null })
      .where(eq(nodeRuns.id, 'r1'))
    await h.db.insert(nodeRunInputs).values({
      taskId: 't',
      consumerRunId: 'r2',
      producerRunId: 'r1',
      producerRunRef: 'r1',
      inputKind: 'frame-input',
      producerNodeId: 'worker',
      producerShardSlot: producerShardSlot(null),
      ordinal: 0,
      provenanceQuality: 'recorded',
    })
    expect(
      (await createNodeRunQueries(h.db).list({ taskId: 't' })).map((row) => row.id).sort(),
    ).toEqual(['r2'])
    const requests: HistoryRestrictionRequest[] = []
    const port: HistoryRestrictionPort = {
      async check(_tx, request) {
        requests.push(request)
        return { allowed: true }
      },
    }
    await h.session.snapshotRead((tx) => assertTaskHistoryExecutableInTx(tx, port, 'resume', 't'))
    expect(requests).toEqual([{ action: 'resume', taskId: 't', nodeRunIds: ['r2'], gates: [] }])
  })
  test('a history-only explicit retry is refused before any caller write', async () => {
    await seed()
    const { nodeRuns, tasks } = tablesOf(h.db)
    await h.db.update(nodeRuns).set({ recordMode: 'history-only' }).where(eq(nodeRuns.id, 'r1'))
    const port: HistoryRestrictionPort = {
      async check() {
        return { allowed: true }
      },
    }
    await expect(
      h.session.transaction(async (tx) => {
        await assertTaskHistoryExecutableInTx(tx, port, 'retry', 't', ['r1'])
        await tx.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, 't'))
      }),
    ).rejects.toMatchObject({ code: 'history-only' })
    expect((await h.db.select().from(tasks).where(eq(tasks.id, 't')))[0]?.status).toBe('failed')
  })
  test('missing provider and provider read failures propagate', async () => {
    await seed()
    await expect(
      // @ts-expect-error Verify the runtime refusal for an untyped caller missing its provider.
      h.session.snapshotRead((tx) => assertTaskHistoryExecutableInTx(tx, undefined, 'resume', 't')),
    ).rejects.toThrow('task-history-restriction-provider-required')
    await expect(
      h.session.snapshotRead((tx) =>
        assertTaskHistoryExecutableInTx(
          tx,
          {
            async check() {
              throw new Error('restriction-read-failed')
            },
          },
          'retry',
          't',
          ['r1'],
        ),
      ),
    ).rejects.toThrow('restriction-read-failed')
  })
  test('matched provider restriction preserves evidence and refuses the request', async () => {
    await seed()
    const port: HistoryRestrictionPort = {
      async check() {
        return {
          allowed: false,
          code: 'history-only',
          restrictions: [
            {
              runId: 'migration',
              unitId: 'unit',
              ordinal: 0,
              sourceTable: 'node_runs',
              sourcePhase: 'current',
              sourceKey: 'mk1:r1',
              decisionCode: 'history-only',
              history: {
                taskId: 't',
                runId: 'r1',
                execution: 'retryable-history',
                missingFields: ['envelope_nonce'],
              },
            },
          ],
        }
      },
    }
    await expect(
      h.session.snapshotRead((tx) =>
        assertTaskHistoryExecutableInTx(tx, port, 'retry', 't', ['r1']),
      ),
    ).rejects.toMatchObject({ code: 'history-only' })
  })
  test('unselected pending adoption and rollback targets remain admission dependencies', async () => {
    await seed()
    const { nodeRuns } = tablesOf(h.db)
    await h.db
      .update(nodeRuns)
      .set({
        status: 'pending',
        nodeId: 'pending-worker',
        slotKey: encodeCanonicalRunSlot({ ...slot, nodeId: 'pending-worker' }),
      })
      .where(eq(nodeRuns.id, 'r1'))
    await h.db.update(nodeRuns).set({ status: 'failed' }).where(eq(nodeRuns.id, 'r2'))
    const requests: HistoryRestrictionRequest[] = []
    await h.session.snapshotRead((tx) =>
      assertTaskHistoryExecutableInTx(
        tx,
        {
          async check(_tx, request) {
            requests.push(request)
            return { allowed: true }
          },
        },
        'resume',
        't',
      ),
    )
    expect(requests[0]?.nodeRunIds).toEqual(['r1', 'r2'])
  })
})
