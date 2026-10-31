import { composeTaskMemorySnapshotPort } from '@/modules/memory/composition'
import { seedNodeRunDisplayEvidence } from './helpers/rfc395Q1Evidence'
import { loadTaskFailureCodes } from '@/services/task'
import { taskNodeRunsProjection } from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { compareRunSequence } from '@/modules/task-execution/domain/runSelection/ordering'
import { requireRunSequence } from '@/modules/task-execution/domain/runSequence'
import { createTaskObservationFacts } from '@/modules/task-execution/infrastructure/taskObservationFacts'
import { deriveFrontier } from '@/modules/task-execution/composition/dagFrontier'
import type { WorkflowDefinition } from '@agent-workflow/shared'
// RFC-395 N-b2: real mint transactions, explicit identities and command generations.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import { nodeRunMintIdentityForSlot } from '@/modules/task-execution/application/nodeRunMintIdentity'
import { buildNodeRunMintRecord } from '@/modules/task-execution/application/buildNodeRunMintRecord'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/runSelection/table/reader'
import { createRunSelectionParticipantInTx } from '@/modules/task-execution/infrastructure/runSelection/table/selectionWrite'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import type { RunSlot } from '@/modules/task-execution/application/ports/runSelection'
import { TASK_EXECUTION_GENERATION_CAUSES } from '@/modules/task-execution/application/ports/taskExecutionGenerations'
import { createNodeRunQueries } from '@/modules/task-execution/infrastructure/nodeRunQueries'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture } from './helpers/model'

const nodeSlot: RunSlot = {
  kind: 'node',
  nodeId: 'worker',
  frame: { containerRunId: null, iteration: 0 },
}

describeEachProvider('RFC-395 target run mint identities', (h) => {
  async function seed() {
    const definition = { $schema_version: 4, nodes: [], edges: [], inputs: [] }
    await workflowFixture(h.db, { id: 'w', name: 'w', definition })
    await taskFixture(h.db, {
      id: 't',
      workflowId: 'w',
      workflowSnapshot: definition,
      repoPath: '',
      worktreePath: '',
      baseBranch: '',
      branch: 'task/t',
      status: 'running',
      inputs: {},
      startedAt: 1,
    })
  }
  const identities: readonly RunSlot[] = [
    nodeSlot,
    { kind: 'container', nodeId: 'wrapper', frame: { containerRunId: null, iteration: 0 } },
    { kind: 'shard', nodeId: 'shard', iteration: 0, shardKey: 'a' },
    { kind: 'aggregator', nodeId: 'aggregate', iteration: 0 },
    ...(
      [
        'repo-prep',
        'commit-push',
        'merge-resolve',
        'dw-gate',
        'wg-gate',
        'dw-orchestrator',
      ] as const
    ).map((syntheticKind) => ({
      kind: 'synthetic' as const,
      owner: { kind: 'task' as const, id: 't' },
      syntheticKind,
      discriminator: syntheticKind,
    })),
    {
      kind: 'synthetic',
      owner: { kind: 'attempt', id: 'parent' },
      syntheticKind: 'commit-session',
      discriminator: 'session',
    },
    { kind: 'workgroup-host', nodeId: 'host', shardKey: 'member-a' },
  ]
  test.each(identities)(
    'persists the explicit %j slot, nonce and role without a name heuristic',
    async (slot) => {
      await seed()
      const mint = new DrizzleNodeRunLifecyclePersistence(h.db)
      await mint.mint({
        ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
        id: 'parent',
        taskId: 't',
        nodeId: 'worker',
        status: 'pending',
        cause: 'initial',
      })
      const identity = nodeRunMintIdentityForSlot(slot, { kind: 'current' })
      const id = await mint.mint({
        ...identity,
        taskId: 't',
        nodeId: 'nodeId' in slot ? slot.nodeId : slot.discriminator,
        status: 'pending',
        cause: 'initial',
        overrides: {
          identity: {
            shardKey:
              slot.kind === 'shard' || slot.kind === 'workgroup-host' ? slot.shardKey : null,
          },
          inputs: { consumedUpstreamRunsJson: '{}' },
        },
      })
      const { nodeRuns, nodeRunInputs } = tablesOf(h.db)
      const [row] = await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, id))
      expect(row).toMatchObject({
        role: identity.role,
        slotKey: encodeCanonicalRunSlot(slot),
        generationSeq: 0,
        attemptIndex: 0,
        envelopeNonce: identity.envelopeNonce,
        inputsRecorded: true,
        recordMode: 'executable',
        provenanceQuality: 'recorded',
      })
      expect(row!.seq).toBeGreaterThan(0)
      expect(row!.envelopeNonce).toMatch(/^[a-f0-9]{16}$/)
      expect(
        await h.db.select().from(nodeRunInputs).where(eq(nodeRunInputs.consumerRunId, id)),
      ).toEqual([])
      expect(await createRunSelectionReader(h.db).current('t', slot)).toMatchObject({ id })
    },
  )
  test('ordinary attempts stay in the generation; explicit commands advance once and replay it', async () => {
    await seed()
    const mint = new DrizzleNodeRunLifecyclePersistence(h.db)
    let generationSeq = 0
    for (const cause of TASK_EXECUTION_GENERATION_CAUSES) {
      const operation = { kind: 'operation' as const, cause, operationRef: `operation:${cause}` }
      const first = await mint.mint({
        ...nodeRunMintIdentityForSlot(nodeSlot, operation),
        taskId: 't',
        nodeId: 'worker',
        status: 'pending',
        cause: 'retry-node',
      })
      const replay = await mint.mint({
        ...nodeRunMintIdentityForSlot(nodeSlot, operation),
        taskId: 't',
        nodeId: 'worker',
        status: 'pending',
        cause: 'process-retry',
        retryIndex: 9,
      })
      const ordinary = await mint.mint({
        ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
        taskId: 't',
        nodeId: 'worker',
        status: 'pending',
        cause: 'initial',
      })
      generationSeq++
      for (const id of [first, replay, ordinary])
        expect((await createNodeRunQueries(h.db).read(id))?.generationSeq).toBe(generationSeq)
    }
    const { taskExecutionGenerations } = tablesOf(h.db)
    expect(await h.db.select().from(taskExecutionGenerations)).toHaveLength(8)
  })
  test('inputs, allocation, generation and selection roll back together on a bad producer', async () => {
    await seed()
    const tables = tablesOf(h.db)
    await expect(
      h.session.transaction(async (tx) => {
        await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
        await createNodeRunMintParticipantInTx(tx).mint({
          ...nodeRunMintIdentityForSlot(nodeSlot, {
            kind: 'operation',
            cause: 'retry',
            operationRef: 'bad-input',
          }),
          id: 'rejected',
          taskId: 't',
          nodeId: 'worker',
          status: 'pending',
          cause: 'retry-node',
          overrides: { inputs: { consumedUpstreamRunsJson: '{"missing":"absent"}' } },
        })
      }),
    ).rejects.toThrow('node-run-input-producer-mismatch')
    for (const table of [
      tables.nodeRuns,
      tables.nodeRunInputs,
      tables.nodeRunSelections,
      tables.nodeRunSeqAllocations,
    ])
      expect(await h.db.select().from(table)).toEqual([])
    expect(await h.db.select().from(tables.taskExecutionGenerations)).toHaveLength(1)
  })
  test('cleared slots retain their revision and a subsequent mint reselects atomically', async () => {
    await seed()
    const mint = new DrizzleNodeRunLifecyclePersistence(h.db)
    const first = await mint.mint({
      ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
      taskId: 't',
      nodeId: 'worker',
      status: 'pending',
      cause: 'initial',
    })
    await h.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
      await createRunSelectionParticipantInTx().apply(tx, [
        {
          kind: 'clear',
          taskId: 't',
          slot: nodeSlot,
          expectedRevision: 1,
          generationSeq: 0,
          cause: 'clear',
        },
      ])
    })
    const second = await mint.mint({
      ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
      taskId: 't',
      nodeId: 'worker',
      status: 'pending',
      cause: 'initial',
    })
    expect(second).not.toBe(first)
    expect(await createRunSelectionReader(h.db).current('t', nodeSlot)).toMatchObject({
      id: second,
      revision: 3,
    })
  })
  test('repo-prep keeps retry-index priority even when a lower retry is minted later', async () => {
    await seed()
    const slot: RunSlot = {
      kind: 'synthetic',
      owner: { kind: 'task', id: 't' },
      syntheticKind: 'repo-prep',
      discriminator: '__repo_prep__',
    }
    const mint = new DrizzleNodeRunLifecyclePersistence(h.db)
    const high = await mint.mint({
      ...nodeRunMintIdentityForSlot(slot, { kind: 'current' }),
      taskId: 't',
      nodeId: '__repo_prep__',
      status: 'failed',
      cause: 'initial',
      retryIndex: 8,
    })
    const later = await mint.mint({
      ...nodeRunMintIdentityForSlot(slot, { kind: 'current' }),
      taskId: 't',
      nodeId: '__repo_prep__',
      status: 'pending',
      cause: 'initial',
      retryIndex: 1,
    })
    expect(await createRunSelectionReader(h.db).current('t', slot)).toMatchObject({
      id: high,
      retryIndex: 8,
      revision: 1,
    })
    // A known slot does not make migrated history executable or replace the frame selection.
    const { nodeRuns } = tablesOf(h.db)
    await h.db.update(nodeRuns).set({ recordMode: 'history-only' }).where(eq(nodeRuns.id, later))
    expect(
      (
        await createRunSelectionReader(h.db).currentInFrame('t', {
          containerRunId: null,
          iteration: 0,
        })
      ).get('__repo_prep__'),
    ).toMatchObject({ id: high })
  })
  test('frontier honors the persisted choice and clear tombstone instead of reconstructing latest rows', async () => {
    await seed()
    const mint = new DrizzleNodeRunLifecyclePersistence(h.db)
    const pending = await mint.mint({
      ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
      taskId: 't',
      nodeId: 'worker',
      status: 'pending',
      cause: 'initial',
    })
    await mint.mint({
      ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
      taskId: 't',
      nodeId: 'worker',
      status: 'failed',
      cause: 'initial',
    })
    const reader = createRunSelectionReader(h.db)
    await h.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
      const run = (await createNodeRunQueries(tx).read(pending))!
      await createRunSelectionParticipantInTx().apply(tx, [
        {
          kind: 'select',
          taskId: 't',
          slot: nodeSlot,
          run,
          expectedRevision: 2,
          generationSeq: 0,
          cause: 'explicit-choice',
        },
      ])
    })
    const definition = {
      nodes: [{ id: 'worker', kind: 'agent-single' }],
      edges: [],
      inputs: [],
    } as unknown as WorkflowDefinition
    const rows = await createNodeRunQueries(h.db).list({ taskId: 't' })
    const frontier = () =>
      deriveFrontier(
        reader,
        't',
        rows,
        definition,
        definition.nodes,
        new Set(['worker']),
        { containerRunId: null, iteration: 0 },
        new Map(),
        new Set(),
        new Set(),
        new Set(),
      )
    expect((await frontier()).pendingAnchors.get('worker')).toBe(pending)
    await h.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
      await createRunSelectionParticipantInTx().apply(tx, [
        {
          kind: 'clear',
          taskId: 't',
          slot: nodeSlot,
          expectedRevision: 3,
          generationSeq: 0,
          cause: 'clear',
        },
      ])
    })
    expect((await frontier()).pendingAnchors.has('worker')).toBe(false)
    expect(await reader.current('t', nodeSlot)).toBeNull()
  })
  test('nullable identity remains visible in history and observation without becoming attempt zero', async () => {
    await seed()
    const { nodeRuns } = tablesOf(h.db)
    await h.db.insert(nodeRuns).values({
      id: 'unknown',
      failureCode: 'historical-failure',
      taskId: 't',
      nodeId: 'worker',
      seq: 1,
      generationSeq: 0,
      status: 'failed',
      role: null,
      slotKey: null,
      attemptIndex: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      scopePath: null,
      envelopeNonce: null,
    })
    await seedNodeRunDisplayEvidence(h.db, 't', 'unknown')
    expect(await createRunSelectionReader(h.db).familyHistory('t', {})).toMatchObject([
      { id: 'unknown', identity: 'unknown', retryIndex: null },
    ])
    expect(await createTaskObservationFacts(h.db).attempts('t')).toEqual([
      { nodeRunId: 'unknown', nodeId: 'worker', retryIndex: 7 },
    ])
    expect(
      await loadTaskFailureCodes(h.db, [{ id: 't', status: 'failed', failedNodeId: 'worker' }]),
    ).toEqual(new Map([['t', 'historical-failure']]))
    expect(await createNodeRunQueries(h.db).read('unknown')).toBeNull()
    expect(
      await createNodeRunQueries(h.db).listHistoryFields({ taskId: 't' }, [
        'id',
        'retryIndex',
        'promptText',
      ]),
    ).toEqual([{ id: 'unknown', retryIndex: 7, promptText: null }])
    const display = await taskNodeRunsProjection(
      {
        memorySnapshots: composeTaskMemorySnapshotPort(),
        db: h.db,
        clarifyNav: { latestRoundStatusByRun: async () => new Map() },
      },
      't',
    )
    expect(display.runs).toMatchObject([
      {
        id: 'unknown',
        retryIndex: 7,
        scopePath: 'legacy:2',
      },
    ])

    expect(display.runs[0]).not.toHaveProperty('identity')
    expect(display.runs[0]).not.toHaveProperty('recordMode')
    expect(
      (
        await h.db
          .select({ attemptIndex: nodeRuns.attemptIndex, scopePath: nodeRuns.scopePath })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, 'unknown'))
      )[0],
    ).toEqual({ attemptIndex: null, scopePath: null })
    expect(
      await createRunSelectionReader(h.db).currentInFrame('t', {
        containerRunId: null,
        iteration: 0,
      }),
    ).toEqual(new Map())
  })
  test('table slot and prompt reads are bounded and do not hydrate aggregate companions', async () => {
    await seed()
    await new DrizzleNodeRunLifecyclePersistence(h.db).mint({
      ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
      taskId: 't',
      nodeId: 'worker',
      status: 'pending',
      cause: 'initial',
    })
    const recording = h.recordStatements()
    try {
      const history = await createRunSelectionReader(h.db).slotHistory('t', nodeSlot)
      expect(history).toHaveLength(1)
      expect(recording.selects()).toHaveLength(1)
      expect(recording.selects()[0]!.values).toContain(encodeCanonicalRunSlot(nodeSlot))
      expect(recording.selects()[0]!.sql).not.toContain('prompt_inline_bytes')
    } finally {
      recording.stop()
    }
    const prompts = h.recordStatements()
    try {
      expect(
        await createNodeRunQueries(h.db).listFields({ taskId: 't' }, ['id', 'promptText']),
      ).toHaveLength(1)
      expect(prompts.selects()).toHaveLength(1)
      const query = prompts.selects()[0]!.sql
      expect(query).not.toContain('node_run_repo_checkpoints')
      expect(query).not.toContain('node_run_inputs')
      expect(query).not.toContain('node_run_runtime_states')
    } finally {
      prompts.stop()
    }
  })
  test('a task with no mounts rejects a requested root checkpoint without leaving a partial mint', async () => {
    await seed()
    const { taskRepositoryMounts, nodeRuns, nodeRunRepoCheckpoints } = tablesOf(h.db)
    await h.db.delete(taskRepositoryMounts).where(eq(taskRepositoryMounts.taskId, 't'))
    await expect(
      new DrizzleNodeRunLifecyclePersistence(h.db).mint({
        ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
        taskId: 't',
        nodeId: 'worker',
        status: 'pending',
        cause: 'initial',
        overrides: { checkpoint: { checkpoints: [{ mountPath: '', preSnapshot: 'snapshot' }] } },
      }),
    ).rejects.toThrow('node-run-checkpoint-mount-missing:')
    expect(await h.db.select().from(nodeRuns)).toEqual([])
    expect(await h.db.select().from(nodeRunRepoCheckpoints)).toEqual([])
  })
  test('inheritance copies the real non-root repo checkpoint and never invents a root mount', async () => {
    await seed()
    const { taskRepositoryMounts, nodeRunRepoCheckpoints } = tablesOf(h.db)
    await h.db.insert(taskRepositoryMounts).values({
      taskId: 't',
      repoKey: 'opaque',
      ordinal: 0,
      mountPath: 'src',
      repoPath: '',
      branchState: 'none',
    })
    const id = await new DrizzleNodeRunLifecyclePersistence(h.db).mint({
      ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
      taskId: 't',
      nodeId: 'worker',
      status: 'pending',
      cause: 'retry-node',
      inheritFrom: {
        reviewIteration: 0,
        parentNodeRunId: null,
        containerRunId: null,
        shardKey: null,
        checkpointInheritance: [{ mountPath: 'src', preSnapshot: '' }],
      },
    })
    expect(await h.db.select().from(nodeRunRepoCheckpoints)).toMatchObject([
      { nodeRunId: id, repoKey: 'opaque', preSnapshot: '' },
    ])
  })
})

test('role/frame validation accepts synthetic and container roots while rejecting uncontained running attempts', () => {
  const base = {
    taskId: 't',
    nodeId: 'worker',
    status: 'running' as const,
    cause: 'initial' as const,
  }
  expect(() =>
    buildNodeRunMintRecord({
      ...base,
      ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
    }),
  ).toThrow('containerRunId')
  const synthetic: RunSlot = {
    kind: 'synthetic',
    owner: { kind: 'task', id: 't' },
    syntheticKind: 'commit-push',
    discriminator: 'ordinary-name',
  }
  expect(
    buildNodeRunMintRecord({
      ...base,
      ...nodeRunMintIdentityForSlot(synthetic, { kind: 'current' }),
    }).role,
  ).toBe('synthetic')
  expect(() =>
    buildNodeRunMintRecord({
      ...base,
      status: 'pending',
      ...nodeRunMintIdentityForSlot(nodeSlot, { kind: 'current' }),
      role: 'container',
    }),
  ).toThrow('node-run-role-slot-mismatch')
})

test('target mint ordering uses seq alone and rejects missing sequence instead of ID/time fallbacks', () => {
  const fresh = { id: 'a-clock-rewound', seq: 2 },
    old = { id: 'z', seq: 1 }
  expect(compareRunSequence(fresh, old)).toBeGreaterThan(0)
  expect(compareRunSequence(old, fresh)).toBeLessThan(0)
  expect(compareRunSequence({ id: 'other-id', seq: 2 } as typeof fresh, fresh)).toBe(0)
  expect(() => requireRunSequence({ id: 'legacy', seq: null as unknown as number })).toThrow(
    'run-sequence-required:legacy',
  )
})
