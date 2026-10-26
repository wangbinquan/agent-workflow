import { tablesOf } from '@/platform/persistence/sessionTables'
import { contentRefColumns } from '@/platform/content/contentStore'
import { decodePrompt } from '@/platform/content/locations/prompt'
// RFC-395 wave-2 fixes: recorded checkpoints and publication lifetimes survive the target split.
import { hasTaskRollbackCheckpoint } from '@/modules/task-execution/domain/taskCheckpointRollback'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createTaskCreationParticipantInTx } from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import type { RunSlot } from '@/modules/task-execution/application/ports/runSelection'
import { describeEachProvider } from './helpers/eachProvider'
const slot: RunSlot = {
  kind: 'node',
  nodeId: 'worker',
  frame: { containerRunId: null, iteration: 0 },
}
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { createNodeRunQueries } from '@/modules/task-execution/infrastructure/nodeRunQueries'
import { createTaskArchiveNodeRunSectionReader } from '@/modules/task-execution/infrastructure/taskArchiveContentCoordinator'
import { TASK_ARCHIVE_V3_TABLES } from '@/platform/contracts/taskArchive'

describeEachProvider('RFC-395 N-b checkpoint and content target adapters', (h) => {
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

  test('checkpoint reads use repoKey with a non-root mount and retain empty bytes', async () => {
    await seed()
    const { taskRepositoryMounts, nodeRunRepoCheckpoints } = tablesOf(h.db)
    await h.db.insert(taskRepositoryMounts).values({
      taskId: 't',
      repoKey: 'opaque-key',
      ordinal: 4,
      mountPath: 'nested/repository',
      repoPath: '',
      baseBranch: null,
      branch: null,
      baseCommit: null,
      branchState: 'none',
    })
    await h.db.insert(nodeRunRepoCheckpoints).values({
      taskId: 't',
      nodeRunId: 'r1',
      repoKey: 'opaque-key',
      preSnapshot: '',
      isolationBase: 'base',
      nodeTree: 'tree',
    })
    const row = await createNodeRunQueries(h.db).readWithCheckpoints('r1')
    expect(row?.checkpoints).toEqual([
      { mountPath: 'nested/repository', preSnapshot: '', isolationBase: 'base', nodeTree: 'tree' },
    ])
    expect(row?.checkpointInheritance).toEqual([
      { mountPath: 'nested/repository', preSnapshot: '' },
    ])
    expect(hasTaskRollbackCheckpoint(row!.rollback)).toBe(true)
    expect(
      hasTaskRollbackCheckpoint(
        (await createNodeRunQueries(h.db).readWithCheckpoints('r2'))!.rollback,
      ),
    ).toBe(false)
    expect((await createNodeRunQueries(h.db).readWithCheckpoints('r2'))?.checkpoints).toEqual([])
  })
  test('batched projection keeps seq order and NULL versus recorded-empty inputs', async () => {
    await seed()
    const persistence = new DrizzleNodeExecutionPersistence(h.db)
    expect((await persistence.list({ taskId: 't' })).map((row) => row.id)).toEqual(['r1', 'r2'])
    expect((await persistence.read('r1'))?.consumedUpstreamRunsJson).toBeNull()
    await persistence.patch({
      nodeRunId: 'r1',
      values: { inputs: { consumedUpstreamRunsJson: '[]' } },
    })
    expect((await persistence.read('r1'))?.consumedUpstreamRunsJson).toBe('{}')
    const { nodeRuns, nodeRunInputs } = tablesOf(h.db)
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'r1')))[0]?.inputsRecorded,
    ).toBe(true)
    expect(await h.db.select().from(nodeRunInputs)).toEqual([])
  })
  test('content replacement can return to prior bytes and a failed outer transaction restores old refs', async () => {
    await seed()
    const persistence = new DrizzleNodeExecutionPersistence(h.db)
    const a = '\ufeff' + 'A'.repeat(70_000)
    const b = 'B'.repeat(70_000)
    for (const content of [a, b, a]) {
      await persistence.upsertOutputs({ nodeRunId: 'r1', outputs: [{ portName: 'out', content }] })
      expect((await persistence.listOutputs('r1'))[0]?.content).toBe(content)
    }
    const { contentPublications } = tablesOf(h.db)
    const before = await h.db.select().from(contentPublications)
    expect(before.filter((row) => row.state === 'ready')).toHaveLength(1)
    expect(before.some((row) => row.state === 'releasing')).toBe(true)
    await expect(
      h.session.transaction(async () => {
        await persistence.replaceOutputs({
          nodeRunId: 'r1',
          outputs: [{ portName: 'new', content: 'rollback'.repeat(12_000) }],
        })
        throw new Error('rollback-output')
      }),
    ).rejects.toThrow('rollback-output')
    expect(await h.db.select().from(contentPublications)).toEqual(before)
    expect((await persistence.listOutputs('r1')).map((row) => [row.portName, row.content])).toEqual(
      [['out', a]],
    )
  })
  test('archive section includes all 12 arrays and native output content bytes', async () => {
    await seed()
    await new DrizzleNodeExecutionPersistence(h.db).upsertOutputs({
      nodeRunId: 'r1',
      outputs: [{ portName: 'out', content: 'bytes' }],
    })
    const nodes = new DrizzleNodeExecutionPersistence(h.db)
    const t = tablesOf(h.db)
    await h.db.insert(t.taskRepositoryMounts).values({
      taskId: 't',
      repoKey: 'repo',
      ordinal: 0,
      mountPath: '',
      repoPath: '',
      baseBranch: null,
      branch: null,
      baseCommit: null,
      branchState: 'none',
    })
    await nodes.patch({
      nodeRunId: 'r1',
      values: {
        config: { promptText: 'prompt' },
        runtime: { opencodeSessionId: 'session' },
        result: { tokInput: 3 },
        checkpoint: { checkpoints: [{ mountPath: '', preSnapshot: 'snap' }] },
        inputs: { consumedUpstreamRunsJson: '{"worker":"r2"}' },
      },
    })
    await h.db.insert(t.nodeRunSelections).values({
      taskId: 't',
      slotKey: encodeCanonicalRunSlot(slot),
      selectedRunId: 'r1',
      revision: 1,
      generationSeq: 0,
      cause: 'fixture',
      selectedAt: 1,
    })
    await nodes.appendEvents({
      nodeRunId: 'r1',
      events: [{ ts: 1, kind: 'text', payload: 'event', sourceKey: 'source' }],
    })
    await h.db
      .insert(tablesOf(h.db).nodeRunSeqAllocations)
      .values({ taskId: 't', nodeRunId: 'r1', allocatedAt: 1 })
    const evidence = contentRefColumns.encode(
      decodePrompt({ promptText: 'evidence', promptPath: null })!,
    )
    await h.db.insert(t.executionLegacyEvidence).values({
      taskId: 't',
      recordKind: 'run',
      recordId: 'r1',
      sourceContract: 'epoch1',
      provenanceQuality: 'unknown',
      missingFieldsJson: '[]',
      contentRefJson: evidence.json,
      contentInlineBytes: Buffer.from(evidence.inlineBytes!),
    })
    const section = await h.session.snapshotRead((tx) =>
      createTaskArchiveNodeRunSectionReader().load(tx, ['t']),
    )
    expect(section.owner).toBe('N')
    expect(Object.keys(section.rows)).toEqual(Object.keys(TASK_ARCHIVE_V3_TABLES.nodeRuns))
    expect(section.rows.node_runs.map((row) => row.id).sort()).toEqual(['r1', 'r2'])
    for (const rows of Object.values(section.rows)) expect(rows.length).toBeGreaterThan(0)
    expect(section.rows.node_run_inputs[0]).toMatchObject({ producerRunId: 'r2' })
    expect(section.rows.node_run_repo_checkpoints[0]).toMatchObject({
      repoKey: 'repo',
      preSnapshot: 'snap',
    })
    expect(section.rows.node_run_outputs[0]?.contentRefJson).toBeString()
    expect(section.rows.node_run_outputs[0]?.contentInlineBytes).toBeInstanceOf(Uint8Array)
  })
})
