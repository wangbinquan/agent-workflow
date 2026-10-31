import { composeTaskMemorySnapshotPort } from '@/modules/memory/composition'
import { createTaskArchiveNodeRunSectionReader } from '@/modules/task-execution/infrastructure/taskArchiveContentCoordinator'
import { seedNodeRunDisplayEvidence } from './helpers/rfc395Q1Evidence'
import { buildActor } from '@/auth/actor'
import { composeRunObservation } from '@/modules/run-observability/composition/runObservation'
import { DrizzleMemoryDistillWorkStore } from '@/modules/memory/infrastructure/memoryDistillWorkStore'
import { createClarifyAnswerQueries } from '@/modules/collaboration/infrastructure/clarifyAnswerQueries'
import { deriveFrontier } from '@/modules/task-execution/composition/dagFrontier'
import {
  TaskNodeRunsSchema,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { taskNodeRunsProjection } from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { isTargetNodeConsumed } from '@/modules/collaboration/infrastructure/clarify/rerunLedger'
// RFC-395 N-b wave-2 fixes: executable reads, wrapper slots, real mounts and recorded inputs.
import { expect, test } from 'bun:test'
import { eq, asc } from 'drizzle-orm'

import { tablesOf } from '@/platform/persistence/sessionTables'
import { createTaskCreationParticipantInTx } from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { DrizzleWrapperRunPersistence } from '@/modules/task-execution/infrastructure/wrapperRunPersistence'
import { DrizzleNodeActivationSnapshotReader } from '@/modules/task-execution/infrastructure/nodeActivationSnapshotReader'
import { nodeRunMintIdentityForSlot } from '@/modules/task-execution/application/nodeRunMintIdentity'
import type { NodeRunMintInput } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import type { RunSlot } from '@/modules/task-execution/application/ports/runSelection'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/runSelection/table/reader'
import { createNodeRunQueries } from '@/modules/task-execution/infrastructure/nodeRunQueries'
import { resolveSchedulerRunRow } from '@/modules/task-execution/application/resolveSchedulerRunRow'
import { resolveNodeActivationForDispatch } from '@/modules/task-execution/application/resolveNodeActivation'
import { buildFreshestSettledPerNode } from '@/modules/task-execution/application/runProvenance'
import { selectResumeRollbackTargets } from '@/modules/task-execution/application/resumeRollbackTargets'
import {
  freshestPriorRunWithOutput,
  readPortRowAtFrame,
  resolveUpstreamInputs,
} from '@/modules/task-execution/composition/nodeMechanics'
import { hasTaskRollbackCheckpoint } from '@/modules/task-execution/domain/taskCheckpointRollback'
import { taskRollbackPlan } from '@/modules/task-execution/infrastructure/taskRollbackCodec'
import { createWorkgroupHostLedgerParticipantInTx } from '@/modules/task-execution/infrastructure/workgroupHostLedgerParticipant'
import { createTaskDeletionParticipantInTx } from '@/modules/task-execution/infrastructure/taskDeletionParticipant'
import { pruneNodeRunSequenceAllocations } from '@/modules/task-execution/infrastructure/nodeRunSequenceMaintenance'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import { createTaskObservationFacts } from '@/modules/task-execution/infrastructure/taskObservationFacts'
import { contentRefColumns } from '@/platform/content/contentStore'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'

const frame = { containerRunId: null, iteration: 0 }
const log = createLogger('rfc395-w2fix-nb-test')
const nodeSlot = (nodeId: string): RunSlot => ({ kind: 'node', nodeId, frame })
const definition: WorkflowDefinition = {
  $schema_version: 6,
  inputs: [],
  nodes: [
    { id: 'git', kind: 'wrapper-git', nodeIds: [] },
    { id: 'agent', kind: 'agent-single', agent: 'auditor' },
    { id: 'fanout', kind: 'wrapper-fanout', nodeIds: [] },
  ] as WorkflowNode[],
  edges: [
    {
      id: 'git-to-agent',
      source: { nodeId: 'git', portName: 'git_diff' },
      target: { nodeId: 'agent', portName: 'diff' },
    },
    {
      id: 'git-to-fanout',
      source: { nodeId: 'git', portName: 'git_diff' },
      target: { nodeId: 'fanout', portName: 'items' },
    },
  ],
}
const clarify = {
  async loadProjection() {
    return { askingNodeRunIds: [], stopDirectives: [] }
  },
  async dismissOpenSelfClarifies() {
    return { dismissedSessions: 0, parks: [] }
  },
}

describeEachProvider('RFC-395 N-b wave-2 functional regressions', (h) => {
  async function seed() {
    await h.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create({
        subject: { kind: 'workflow', sourceId: 'w' },
        core: {
          id: 't',
          name: 'task',
          status: 'failed',
          startedAt: 1,
          ownerUserId: null,
          catalogVisibility: 'public',
          branchStartedAt: 1,
        },
        definition: {
          definitionOrigin: 'authored',
          workflowSnapshot: JSON.stringify(definition),
          workflowVersion: 1,
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
  }
  async function mint(id: string, slot: RunSlot, rest: Partial<NodeRunMintInput> = {}) {
    return new DrizzleNodeRunLifecyclePersistence(h.db).mint({
      ...nodeRunMintIdentityForSlot(slot, { kind: 'current' }),
      id,
      taskId: 't',
      nodeId: 'nodeId' in slot ? slot.nodeId : slot.discriminator,
      status: 'pending',
      cause: 'initial',
      ...rest,
    })
  }
  async function history(id: string, nodeId: string, seq: number, slot?: RunSlot) {
    const { nodeRuns } = tablesOf(h.db)
    const { encodeCanonicalRunSlot } =
      await import('@/modules/task-execution/domain/runSelection/slotKey')
    await h.db.insert(nodeRuns).values({
      id,
      taskId: 't',
      nodeId,
      seq,
      generationSeq: 0,
      role:
        slot === undefined ? null : slot.kind === 'workgroup-host' ? 'synthetic' : 'node-attempt',
      slotKey: slot === undefined ? null : encodeCanonicalRunSlot(slot),
      attemptIndex: null,
      scopePath: null,
      envelopeNonce: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      status: 'done',
    })
    await seedNodeRunDisplayEvidence(h.db, 't', id)
  }
  async function mount(path: string) {
    const { taskRepositoryMounts } = tablesOf(h.db)
    await h.db.insert(taskRepositoryMounts).values({
      taskId: 't',
      repoKey: 'opaque',
      ordinal: 0,
      mountPath: path,
      repoPath: '',
      baseBranch: null,
      branch: null,
      baseCommit: null,
      branchState: 'none',
    })
  }

  for (const consumer of ['agent', 'fanout'])
    test(`git wrapper output feeds ${consumer} and preserves consumed provenance`, async () => {
      await seed()
      await mint('git-run', { kind: 'container', nodeId: 'git', frame }, { status: 'done' })
      const nodes = new DrizzleNodeExecutionPersistence(h.db)
      await nodes.upsertOutputs({
        nodeRunId: 'git-run',
        outputs: [{ portName: 'git_diff', content: '["change"]' }],
      })
      const result = await resolveUpstreamInputs(
        nodes,
        't',
        definition.edges,
        consumer,
        frame,
        log,
        definition,
        new Map(),
      )
      expect(result).toEqual({
        inputs: { [consumer === 'agent' ? 'diff' : 'items']: '["change"]' },
        consumed: { git: 'git-run' },
      })
      expect(
        await readPortRowAtFrame(nodes, 't', 'git', 'git_diff', frame, 'wrapper-git'),
      ).toMatchObject({ runId: 'git-run', content: '["change"]' })
      expect(
        await new DrizzleWrapperRunPersistence(h.db).resolveConsumed({
          taskId: 't',
          sources: [{ nodeId: 'git', nodeKind: 'wrapper-git', frame }],
        }),
      ).toEqual({ git: 'git-run' })
      await nodes.upsertOutputs({
        nodeRunId: 'git-run',
        outputs: [{ portName: 'git_diff', content: 'closed', active: false }],
      })
      const activation = await resolveNodeActivationForDispatch({
        reader: new DrizzleNodeActivationSnapshotReader(h.db),
        taskId: 't',
        definition,
        node: definition.nodes.find((node) => node.id === consumer)!,
        frame,
      })
      expect(activation.activation.kind).toBe('skipped')
      expect(activation.consumed).toEqual({ git: 'git-run' })
    })

  test('relative spilled prompt is persisted without reading its nonexistent file', async () => {
    await seed()
    await mint('prompt', nodeSlot('agent'))
    const nodes = new DrizzleNodeExecutionPersistence(h.db, {
      read: async () => {
        throw new Error('unexpected eager read')
      },
    })
    await nodes.patch({
      nodeRunId: 'prompt',
      values: { config: { promptText: null, promptPath: 't/prompts/not-on-disk.md' } },
    })
    expect(await nodes.read('prompt')).toMatchObject({
      promptText: null,
      promptPath: 't/prompts/not-on-disk.md',
    })
    const { nodeRunConfigs } = tablesOf(h.db)
    const [config] = await h.db.select().from(nodeRunConfigs)
    expect(
      contentRefColumns.decode(config!.promptRefJson, config!.promptInlineBytes),
    ).toMatchObject({
      kind: 'local-file',
      location: { codec: 'prompt', value: { promptPath: 't/prompts/not-on-disk.md' } },
    })
  })

  test('dispatch, prior output and rollback selection exclude known-slot history-only rows', async () => {
    await seed()
    await mint('old', nodeSlot('agent'), { status: 'done' })
    const nodes = new DrizzleNodeExecutionPersistence(h.db)
    await nodes.upsertOutputs({
      nodeRunId: 'old',
      outputs: [{ portName: 'out', content: 'prior' }],
    })
    await mint('pending', nodeSlot('agent'))
    await history('legacy', 'agent', 100, nodeSlot('agent'))
    const rows = await nodes.list({ taskId: 't' })
    const resolved = await resolveSchedulerRunRow({
      lifecycle: new DrizzleNodeRunLifecyclePersistence(h.db),
      projections: nodes,
      selection: nodes.selection,
      taskId: 't',
      nodeId: 'agent',
      containerRunId: null,
      iteration: 0,
      consumedUpstreamJson: '{}',
      rows,
      inheritReviewIteration: true,
      clearAgentOverride: true,
      trackRetryIndex: true,
      broadcastPending: null,
    })
    expect(resolved.nodeRunId).toBe('pending')
    expect(
      (
        await freshestPriorRunWithOutput(nodes, {
          taskId: 't',
          nodeId: 'agent',
          iteration: 0,
          shardKey: null,
          id: 'later',
          seq: 101,
        })
      )?.id,
    ).toBe('old')
    await new DrizzleNodeRunLifecyclePersistence(h.db).set({
      nodeRunId: 'pending',
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'fixture',
    })
    const checkpoints = await createNodeRunQueries(h.db).listWithCheckpoints({ taskId: 't' })
    expect(
      (await selectResumeRollbackTargets(checkpoints, nodes.selection, 't')).map((row) => row.id),
    ).toEqual(['pending'])
  })

  test('history-only host rows do not stop the workgroup ledger and gates keep their own slot', async () => {
    await seed()
    const host: RunSlot = { kind: 'workgroup-host', nodeId: '__wg_leader__', shardKey: null }
    await mint('host', host, { status: 'done', cause: 'wg-leader-round' })
    await history('host-history', '__wg_leader__', 100, host)
    await h.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
      const ledger = createWorkgroupHostLedgerParticipantInTx(tx, clarify)
      expect((await ledger.load('t'))?.hostRuns.map((row) => row.id)).toEqual(['host'])
      expect(
        await ledger.apply({
          taskId: 't',
          operations: [
            {
              kind: 'mint-host-run',
              operationKey: 'gate',
              runId: 'gate',
              nodeId: '__wg_leader__',
              status: 'awaiting_review',
              cause: 'wg-gate',
              retryIndex: 0,
              shardKey: null,
              agentOverrideName: null,
              agentOverrideId: null,
              wgRound: 1,
            },
          ],
        }),
      ).toMatchObject({ committed: true })
    })
    const reader = createRunSelectionReader(h.db)
    expect((await reader.current('t', host))?.id).toBe('host')
    expect(
      (await reader.familyHistory('t', { syntheticKind: 'wg-gate' })).map((row) => row.id),
    ).toEqual(['gate'])
  })

  for (const path of ['', 'nested/repo'])
    test(`runtime checkpoints preserve real mount ${JSON.stringify(path)} and isolation evidence`, async () => {
      await seed()
      await mount(path)
      await mint('wrapper', { kind: 'container', nodeId: 'git', frame })
      const nodes = new DrizzleNodeExecutionPersistence(h.db)
      const wrappers = new DrizzleWrapperRunPersistence(h.db)
      expect(
        (await wrappers.findResumable({ taskId: 't', nodeId: 'git', ...frame }))?.previous
          .hasIsolationBase,
      ).toBe(false)
      const empty = await createNodeRunQueries(h.db).readWithCheckpoints('wrapper')
      expect(hasTaskRollbackCheckpoint(empty!.rollback)).toBe(false)
      await nodes.patch({
        nodeRunId: 'wrapper',
        values: {
          checkpoint: {
            checkpoints: [
              { mountPath: path, preSnapshot: '', isolationBase: '', nodeTree: 'tree' },
            ],
          },
        },
      })
      const row = await createNodeRunQueries(h.db).readWithCheckpoints('wrapper')
      expect(row?.checkpointInheritance).toEqual([{ mountPath: path, preSnapshot: '' }])
      expect(hasTaskRollbackCheckpoint(row!.rollback)).toBe(true)
      expect(
        (await wrappers.findResumable({ taskId: 't', nodeId: 'git', ...frame }))?.previous
          .hasIsolationBase,
      ).toBe(true)
      const gate = (await createNodeRunQueries(h.db).humanGateProjection(['wrapper']))[0]!
      expect([gate.preSnapshot, gate.preSnapshotReposJson]).toEqual(
        path === '' ? ['', null] : [null, JSON.stringify({ [path]: '' })],
      )
      const plan = taskRollbackPlan(
        { worktreePath: '/task', repos: [{ mountPath: path, worktreePath: '/task/repo' }] },
        { id: 'wrapper', checkpoints: [{ mountPath: path, preSnapshot: 'snapshot' }] },
      )
      expect(plan.targets).toEqual([
        { mountPath: path, worktreePath: '/task/repo', snapshot: 'snapshot' },
      ])
    })

  test('zero-mount reads have no invented rollback or isolation checkpoint', async () => {
    await seed()
    await mint('wrapper', { kind: 'container', nodeId: 'git', frame })
    const queries = createNodeRunQueries(h.db)
    const row = (await queries.readWithCheckpoints('wrapper'))!
    expect(row.checkpoints).toEqual([])
    expect(row.checkpointInheritance).toEqual([])
    expect(hasTaskRollbackCheckpoint(row.rollback)).toBe(false)
    expect(taskRollbackPlan({ worktreePath: '/task', repos: [] }, row.rollback).targets).toEqual([])
    expect((await queries.humanGateProjection(['wrapper']))[0]).toMatchObject({
      preSnapshot: null,
      preSnapshotReposJson: null,
    })
  })

  test('aggregator records two shards of the same node without feeding legacy freshness', async () => {
    await seed()
    await mint('wrapper', { kind: 'container', nodeId: 'git', frame })
    for (const shardKey of ['a', 'b'])
      await mint(
        shardKey,
        { kind: 'shard', nodeId: 'worker', iteration: 0, shardKey },
        {
          status: 'done',
          containerRunId: 'wrapper',
          overrides: { identity: { parentNodeRunId: 'wrapper', shardKey } },
        },
      )
    const inputs = ['a', 'b'].map((id) => ({
      inputKind: 'aggregator-shard' as const,
      producerNodeId: 'worker',
      producerRunId: id,
      producerShardKey: id,
    }))
    await mint(
      'agg',
      { kind: 'aggregator', nodeId: 'aggregate', iteration: 0 },
      {
        containerRunId: 'wrapper',
        overrides: { identity: { parentNodeRunId: 'wrapper' }, inputs: { recordedInputs: inputs } },
      },
    )
    const { nodeRunInputs, nodeRuns } = tablesOf(h.db)
    expect(
      (await h.db.select().from(nodeRunInputs)).map((row) => [
        row.inputKind,
        row.producerRunId,
        row.producerShardSlot,
      ]),
    ).toEqual(
      inputs.map((row) => [
        'aggregator-shard',
        row.producerRunId,
        `shard-v1:key:${JSON.stringify(row.producerShardKey)}`,
      ]),
    )
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'agg')))[0]?.inputsRecorded,
    ).toBe(true)
    const reader = createRunSelectionReader(h.db)
    expect(await reader.consumed('agg')).toEqual([])
    const view = await reader.shardSet('t', {
      wrapperRunId: 'wrapper',
      iteration: 0,
      shards: [],
      aggregatorNodeId: 'aggregate',
    })
    expect(view.aggregatorInputs).toEqual(
      inputs.map(({ producerNodeId, producerRunId }) => ({ producerNodeId, producerRunId })),
    )
    expect(view.aggregatorInputEvidence).toBe('aggregator-shard')
  })

  test('deletion releases large output and prompt publications in the deleting transaction', async () => {
    await seed()
    await mint('run', nodeSlot('agent'))
    const nodes = new DrizzleNodeExecutionPersistence(h.db)
    await nodes.patch({ nodeRunId: 'run', values: { config: { promptText: 'p'.repeat(70_000) } } })
    await nodes.upsertOutputs({
      nodeRunId: 'run',
      outputs: [{ portName: 'out', content: 'o'.repeat(70_000) }],
    })
    const { contentPublications, tasks } = tablesOf(h.db)
    expect((await h.db.select().from(contentPublications)).map((row) => row.state)).toEqual([
      'ready',
      'ready',
    ])
    await expect(
      h.session.transaction(async (tx) => {
        await createTaskDeletionParticipantInTx(tx).deleteRoot('t')
        throw new Error('rollback-delete')
      }),
    ).rejects.toThrow('rollback-delete')
    expect(
      (await h.db.select().from(contentPublications)).every((row) => row.state === 'ready'),
    ).toBe(true)
    expect(await h.db.select().from(tasks)).toHaveLength(1)
    await h.session.transaction((tx) => createTaskDeletionParticipantInTx(tx).deleteRoot('t'))
    expect(
      (await h.db.select().from(contentPublications)).every((row) => row.state === 'releasing'),
    ).toBe(true)
    expect(await h.db.select().from(tasks)).toEqual([])
  })

  test('sequence maintenance retains the high-water row and the next mint stays monotonic', async () => {
    await seed()
    await mint('one', nodeSlot('agent'))
    await mint('two', nodeSlot('agent'))
    const { nodeRunSeqAllocations } = tablesOf(h.db)
    const before = await h.db
      .select()
      .from(nodeRunSeqAllocations)
      .orderBy(asc(nodeRunSeqAllocations.seq))
    expect(await pruneNodeRunSequenceAllocations(h.db)).toBe(before.length - 1)
    expect(await h.db.select().from(nodeRunSeqAllocations)).toEqual([before.at(-1)!])
    await mint('three', nodeSlot('agent'))
    expect((await createNodeRunQueries(h.db).read('three'))!.seq).toBeGreaterThan(
      before.at(-1)!.seq,
    )
  })

  test('session sibling order and original epoch-1 attempt facts survive unknown identity', async () => {
    await seed()
    await mint('z-first', nodeSlot('agent'), { status: 'done' })
    await mint('a-later', nodeSlot('agent'), { status: 'done' })
    const nodes = new DrizzleNodeExecutionPersistence(h.db)
    for (const id of ['z-first', 'a-later'])
      await nodes.patch({
        nodeRunId: id,
        values: { runtime: { opencodeSessionId: 'session' }, config: { promptText: id } },
      })
    const { nodeRuns } = tablesOf(h.db)
    await h.db
      .update(nodeRuns)
      .set({ recordMode: 'history-only', attemptIndex: null, scopePath: null })
      .where(eq(nodeRuns.id, 'z-first'))
    await seedNodeRunDisplayEvidence(h.db, 't', 'z-first')
    const source = await createTaskExecutionReadModels(h.db).sessions.find({
      taskId: 't',
      nodeRunId: 'z-first',
      rootPrefixCap: 10,
      tailCap: 10,
    })
    expect(source.status).toBe('found')
    if (source.status === 'found') {
      expect(source.siblings.map((row) => row.id)).toEqual(['z-first', 'a-later'])
      expect(source.siblings[0]?.retryIndex).toBe(7)
    }
    const display = TaskNodeRunsSchema.parse(
      await taskNodeRunsProjection(
        {
          memorySnapshots: composeTaskMemorySnapshotPort(),
          db: h.db,
          clarifyNav: { latestRoundStatusByRun: async () => new Map() },
        },
        't',
      ),
    )
    expect(display.runs.find((row) => row.id === 'z-first')).toMatchObject({
      retryIndex: 7,
      scopePath: 'legacy:2',
    })
    expect(display.runs.find((row) => row.id === 'z-first')).not.toHaveProperty('identity')
    expect(display.runs.find((row) => row.id === 'z-first')).not.toHaveProperty('recordMode')
    expect((await createTaskObservationFacts(h.db).attempts('t'))[0]).toMatchObject({
      nodeRunId: 'z-first',
      retryIndex: 7,
    })
    const observation = composeRunObservation({
      db: h.db,
      tasks: createTaskObservationFacts(h.db),
      runtimes: { directory: async () => ({ runtimes: [] }) },
    })
    await observation.calls.accept({
      id: 'unknown-attempt-call',
      purpose: 'task',
      taskId: 't',
      nodeRunId: 'z-first',
      agentId: null,
      agentName: 'auditor',
      runtimeId: null,
      runtimeName: null,
      protocol: 'claude-code',
      startedAt: 1,
    })
    const actor = buildActor({
      user: {
        id: 'admin',
        username: 'admin',
        displayName: 'admin',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    expect((await observation.queries.task(actor, 't'))?.calls[0]).toMatchObject({
      id: 'unknown-attempt-call',
      nodeId: 'agent',
      attempt: 8,
    })
  })

  test('missing converted evidence fails history while execution still excludes the row', async () => {
    await seed()
    await history('broken-history', 'agent', 100)
    const { executionLegacyEvidence } = tablesOf(h.db)
    await h.db
      .delete(executionLegacyEvidence)
      .where(eq(executionLegacyEvidence.recordId, 'broken-history'))
    const queries = createNodeRunQueries(h.db)
    await expect(queries.listHistory({ taskId: 't' })).rejects.toThrow(
      'node-run-display-evidence-missing:broken-history',
    )
    await expect(queries.listHistoryFields({ taskId: 't' }, ['id'])).rejects.toThrow(
      'node-run-display-evidence-missing:broken-history',
    )
    await expect(
      h.session.snapshotRead((tx) => createTaskArchiveNodeRunSectionReader().load(tx, ['t'])),
    ).rejects.toThrow('node-run-display-evidence-missing:broken-history')
    expect(await queries.list({ taskId: 't' })).toEqual([])
    expect(await queries.listFields({ taskId: 't' }, ['id', 'promptText'])).toEqual([])
  })

  test('history sorting and session grouping use the original values before limiting', async () => {
    await seed()
    await mint('live', nodeSlot('agent'), { status: 'done' })
    await new DrizzleNodeExecutionPersistence(h.db).patch({
      nodeRunId: 'live',
      values: { runtime: { opencodeSessionId: 'original-session' } },
    })
    await history('older-history', 'agent', 100)
    const { executionLegacyEvidence } = tablesOf(h.db)
    await h.db
      .delete(executionLegacyEvidence)
      .where(eq(executionLegacyEvidence.recordId, 'older-history'))
    await seedNodeRunDisplayEvidence(h.db, 't', 'older-history', {
      retry_index: 9,
      scope_path: 'scope/2',
      opencode_session_id: 'original-session',
      failure_code: 'original-failure',
    })
    const queries = createNodeRunQueries(h.db)
    expect(
      await queries.listHistoryFields({ taskId: 't', order: 'retry-desc', limit: 1 }, [
        'id',
        'retryIndex',
        'scopePath',
        'failureCode',
      ]),
    ).toEqual([
      { id: 'older-history', retryIndex: 9, scopePath: 'scope/2', failureCode: 'original-failure' },
    ])
    const exported = await h.session.snapshotRead((tx) =>
      createTaskArchiveNodeRunSectionReader().load(tx, ['t']),
    )
    expect(exported.rows.execution_legacy_evidence.map((row) => row.recordId)).toEqual([
      'older-history',
    ])
    expect(
      exported.rows.node_runs.find((row) => row.id === 'older-history')?.attemptIndex,
    ).toBeNull()
    const source = await createTaskExecutionReadModels(h.db).sessions.find({
      taskId: 't',
      nodeRunId: 'older-history',
      rootPrefixCap: 10,
      tailCap: 10,
    })
    expect(source.status).toBe('found')
    if (source.status === 'found')
      expect(source.siblings.map((row) => row.id)).toEqual(['live', 'older-history'])
  })

  test('freshest settled rows exclude same-frame historical children', async () => {
    const base = {
      id: 'top',
      seq: 1,
      nodeId: 'node',
      taskId: 't',
      parentNodeRunId: null,
      containerRunId: null,
      iteration: 0,
      status: 'done' as const,
      consumedUpstreamRunsJson: null,
      mergeState: null,
      shardKey: null,
      supersededByReview: null,
      wrapperProgressJson: null,
    }
    const rows = [base, { ...base, id: 'child', seq: 2, parentNodeRunId: 'parent' }]
    expect(
      (await buildFreshestSettledPerNode(rows, new Set(['node']), frame)).get('node')?.id,
    ).toBe('top')
  })
  test('clarify aging drops an absent cross-iteration anchor but keeps a present seq bound', async () => {
    const row = {
      id: 'done',
      seq: 2,
      nodeId: 'agent',
      iteration: 1,
      parentNodeRunId: null,
      status: 'done',
      supersededByReview: null,
    } as Parameters<typeof isTargetNodeConsumed>[3][number]
    expect(await isTargetNodeConsumed('agent', 1, null, [row], new Set(['done']))).toBe(false)
    expect(
      await isTargetNodeConsumed('agent', 1, 'another-iteration', [row], new Set(['done'])),
    ).toBe(true)
    expect(
      await isTargetNodeConsumed(
        'agent',
        1,
        'anchor',
        [row, { ...row, id: 'anchor', seq: 3, status: 'pending' }],
        new Set(['done']),
      ),
    ).toBe(false)
  })

  test('executable list and family reads bound root IN queries as well as companions', async () => {
    await seed()
    const { nodeRuns } = tablesOf(h.db)
    const { encodeCanonicalRunSlot } =
      await import('@/modules/task-execution/domain/runSelection/slotKey')
    for (let offset = 0; offset < 405; offset += 50)
      await h.db.insert(nodeRuns).values(
        Array.from({ length: Math.min(50, 405 - offset) }, (_, i) => ({
          id: `run-${offset + i}`,
          taskId: 't',
          nodeId: 'agent',
          seq: offset + i + 1,
          role: 'node-attempt' as const,
          slotKey: encodeCanonicalRunSlot(nodeSlot('agent')),
          generationSeq: 0,
          attemptIndex: offset + i,
          scopePath: '',
          envelopeNonce: 'nonce',
          recordMode: 'executable' as const,
          provenanceQuality: 'recorded' as const,
          status: 'done' as const,
        })),
      )
    const recording = h.recordStatements()
    try {
      const rows = await new DrizzleNodeExecutionPersistence(h.db).list({ taskId: 't' })
      expect(rows).toHaveLength(405)
      const family = await createRunSelectionReader(h.db).familyHistory(
        't',
        { runIds: rows.map((row) => row.id).reverse() },
        { executableOnly: true },
      )
      expect(family.map((row) => row.id)).toEqual(rows.map((row) => row.id))
      const statements = recording.statements
      expect(
        statements.filter((row) => /node_runs/.test(row.sql) && /\bin\s*\(/i.test(row.sql)).length,
      ).toBeGreaterThanOrEqual(2)
      expect(Math.max(...statements.map((row) => row.params))).toBeLessThanOrEqual(402)
    } finally {
      recording.stop()
    }
  })

  test('memory distillation keeps a newer history-only node and its prompt', async () => {
    await seed()
    await mint('earlier', nodeSlot('agent'), { status: 'done' })
    await history('legacy-latest', 'agent', 100)
    const { nodeRunConfigs } = tablesOf(h.db)
    const { decodePrompt } = await import('@/platform/content/locations/prompt')
    const prompt = contentRefColumns.encode(
      decodePrompt({ promptText: 'historical prompt', promptPath: null })!,
    )
    await h.db.insert(nodeRunConfigs).values({
      nodeRunId: 'legacy-latest',
      promptRefJson: prompt.json,
      promptInlineBytes: Buffer.from(prompt.inlineBytes!),
    })
    const store = new DrizzleMemoryDistillWorkStore(h.db, createClarifyAnswerQueries(h.db))
    expect(await store.listTaskNodeStatuses(['t'])).toEqual([
      {
        taskId: 't',
        nodeId: 'agent',
        nodeRunId: 'legacy-latest',
        status: 'done',
        retryIndex: 7,
        finishedAt: null,
      },
    ])
    expect((await store.listNodeRuns(['legacy-latest']))[0]?.promptText).toBe('historical prompt')
  })

  test('a newer selection missing from a frontier snapshot does not erase its node', async () => {
    await seed()
    await mint('old', nodeSlot('agent'))
    const nodes = new DrizzleNodeExecutionPersistence(h.db)
    const rows = await nodes.list({ taskId: 't' })
    await mint('new', nodeSlot('agent'))
    const node = definition.nodes.find((candidate) => candidate.id === 'agent')!
    const frontier = await deriveFrontier(
      nodes.selection,
      't',
      rows,
      definition,
      [node],
      new Set(['agent']),
      frame,
      new Map(),
      new Set(),
      new Set(),
      new Set(),
    )
    expect(frontier.pendingAnchors.get('agent')).toBe('old')
  })
})
