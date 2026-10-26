import type { TaskCreationInput } from '@/modules/task-execution/application/ports/taskCreation'
import {
  createTaskCreationParticipantInTx,
  taskExecutionGenerationsParticipant,
} from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'

const taskInput = (id: string): TaskCreationInput => ({
  subject: { kind: 'workflow', sourceId: 'workflow' },
  core: {
    id,
    name: id,
    status: 'failed',
    startedAt: 10,
    ownerUserId: null,
    catalogVisibility: 'public',
    branchStartedAt: 10,
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
    branch: `agent-workflow/${id}`,
    baseCommit: null,
    spaceKind: 'scratch',
  },
  repos: [],
  nodePaths: [],
})

describeEachProvider('RFC-395 T generation zero and operation replay', (harness) => {
  test('creation writes generation 0 in the root transaction and a rollback removes both', async () => {
    const { tasks, taskExecutionGenerations } = tablesOf(harness.db)
    await expect(
      harness.session.transaction(async (tx) => {
        await createTaskCreationParticipantInTx(tx).create(taskInput('rollback'))
        expect((await tx.select().from(taskExecutionGenerations))[0]).toMatchObject({
          generationSeq: 0,
          cause: 'task-created',
          previousGenerationSeq: null,
          operationRef: null,
          createdAt: 10,
        })
        throw new Error('abort-creation')
      }),
    ).rejects.toThrow('abort-creation')
    expect(await harness.db.select().from(tasks)).toEqual([])
    expect(await harness.db.select().from(taskExecutionGenerations)).toEqual([])
  })
  test('same operation replays its original time; stale predecessor and changed facts reject', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('generation')),
    )
    const input = {
      taskId: 'generation',
      cause: 'retry' as const,
      operationRef: 'retry:one',
      previousGenerationSeq: 0,
      createdAt: 20,
    }
    const open = (value: typeof input | (Omit<typeof input, 'cause'> & { cause: 'resume' })) =>
      harness.session.transaction(async (tx) => {
        await taskAggregateWrite.lockTaskAggregateRoot(tx, value.taskId)
        return taskExecutionGenerationsParticipant.openGeneration(tx, value)
      })
    const first = await open(input)
    expect(first.generationSeq).toBe(1)
    expect(await open({ ...input, createdAt: 99 })).toEqual(first)
    await expect(open({ ...input, cause: 'resume' })).rejects.toThrow(
      'task-generation-operation-conflict',
    )
    await expect(open({ ...input, operationRef: 'retry:two' })).rejects.toThrow(
      'task-generation-stale-predecessor',
    )
    const { taskExecutionGenerations } = tablesOf(harness.db)
    expect(
      await harness.db
        .select()
        .from(taskExecutionGenerations)
        .where(eq(taskExecutionGenerations.taskId, 'generation')),
    ).toHaveLength(2)
  })
  test('concurrent replay allocates one generation', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('race')),
    )
    const input = {
      taskId: 'race',
      cause: 'resume' as const,
      operationRef: 'resume:one',
      previousGenerationSeq: 0,
      createdAt: 20,
    }
    const rows = await Promise.all(
      [1, 2].map(() =>
        harness.session.transaction(async (tx) => {
          // The participant requires its caller to hold the task root, as the runtime does.
          await taskAggregateWrite.lockTaskAggregateRoot(tx, input.taskId)
          return taskExecutionGenerationsParticipant.openGeneration(tx, input)
        }),
      ),
    )
    expect(rows[0]).toEqual(rows[1])
    const { taskExecutionGenerations } = tablesOf(harness.db)
    expect(
      await harness.db
        .select()
        .from(taskExecutionGenerations)
        .where(eq(taskExecutionGenerations.taskId, input.taskId)),
    ).toHaveLength(2)
  })
})

import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import {
  targetRegistryView,
  validateTargetRow,
} from '@/platform/persistence/migration/conversion/targetRows'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { recordNodeRunInputsInTx } from '@/modules/task-execution/infrastructure/consumedInputsParticipant'
import {
  readNodeRunSnapshotRows,
  projectNodeRunReadFacts,
} from '@/modules/task-execution/infrastructure/nodeRunSnapshot'

const runInput = (id: string, nodeId = 'worker') => ({
  id,
  taskId: 'selection',
  envelopeNonce: `nonce:${id}`,
  nodeId,
  seq: id === 'run' ? 1 : 2,
  role: 'node-attempt' as const,
  slotKey: encodeCanonicalRunSlot({
    kind: 'node',
    nodeId,
    frame: { containerRunId: null, iteration: 0 },
  }),
  generationSeq: 0,
  attemptIndex: 0,
  status: 'pending' as const,
  startedAt: 10,
  recordMode: 'executable' as const,
  provenanceQuality: 'recorded' as const,
})

test('V2 row validation admits a NULL selection tombstone and retains the selected-id codec', () => {
  const target = targetRegistryView(persistenceSchema)
  const row = {
    task_id: 'selection',
    slot_key: runInput('run').slotKey,
    selected_run_id: null,
    revision: 1,
    generation_seq: 0,
    cause: 'clear',
    selected_at: 10,
  }
  expect(() => validateTargetRow(target, 'node_run_selections', row)).not.toThrow()
  expect(() =>
    validateTargetRow(target, 'node_run_selections', { ...row, selected_run_id: 42 }),
  ).toThrow()
})

describeEachProvider('RFC-395 T selection tombstones and recorded-input default', (harness) => {
  test('a cleared slot survives MATCH SIMPLE while a non-null selection must match task and slot', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('selection')),
    )
    const { nodeRuns, nodeRunSelections } = tablesOf(harness.db)
    const run = runInput('run')
    await harness.db.insert(nodeRuns).values([run, runInput('other', 'other-worker')])
    await harness.db.insert(nodeRunSelections).values({
      taskId: 'selection',
      slotKey: run.slotKey,
      selectedRunId: 'run',
      revision: 1,
      generationSeq: 0,
      cause: 'mint',
      selectedAt: 10,
    })
    await harness.db
      .update(nodeRunSelections)
      .set({ selectedRunId: null, revision: 2, cause: 'clear' })
      .where(eq(nodeRunSelections.taskId, 'selection'))
    expect(await harness.db.select().from(nodeRunSelections)).toMatchObject([
      { selectedRunId: null, revision: 2 },
    ])
    await expect(
      harness.session.transaction(async (tx) => {
        await tx
          .update(nodeRunSelections)
          .set({ selectedRunId: 'other' })
          .where(eq(nodeRunSelections.taskId, 'selection'))
      }),
    ).rejects.toThrow()
    expect(await harness.db.select().from(nodeRunSelections)).toMatchObject([
      { selectedRunId: null, revision: 2 },
    ])
  })
  test('an omitted input flag means unrecorded; an explicitly recorded empty set means {}', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('selection')),
    )
    const { nodeRuns } = tablesOf(harness.db)
    await harness.db.insert(nodeRuns).values(runInput('run'))
    let rows = await readNodeRunSnapshotRows(harness.db, 'run')
    expect(rows?.run.inputsRecorded).toBe(false)
    expect(projectNodeRunReadFacts(rows!).consumedUpstreamRunsJson).toBeNull()
    await harness.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 'selection')
      await recordNodeRunInputsInTx(tx, 'run', [])
    })
    rows = await readNodeRunSnapshotRows(harness.db, 'run')
    expect(rows?.run.inputsRecorded).toBe(true)
    expect(projectNodeRunReadFacts(rows!).consumedUpstreamRunsJson).toBe('{}')
    await harness.db.insert(nodeRuns).values({ ...runInput('explicit'), inputsRecorded: true })
    expect(
      projectNodeRunReadFacts((await readNodeRunSnapshotRows(harness.db, 'explicit'))!)
        .consumedUpstreamRunsJson,
    ).toBe('{}')
  })
})
