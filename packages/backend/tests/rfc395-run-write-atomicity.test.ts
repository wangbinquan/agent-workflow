import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
// RFC-397：租约顶层使用 READ COMMITTED；刻意建立的外层 SERIALIZABLE 覆盖继续保留。
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
// RFC-395 N-a: CAS and all subordinate writes share the owner's real transaction.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import {
  compareAndWriteNodeRunInTx,
  compareAndWriteMergeStateInTx,
  compareAndWriteRunSessionInTx,
  writeNodeRunTablesInTx,
  writeNodeRunProjectionInTx,
  nodeRunTableWrite,
  type NodeRunTableWrite,
} from '@/modules/task-execution/infrastructure/nodeRunWriteProtocol'
import {
  createContentStore,
  createLocalFileContentTransport,
} from '@/platform/content/infrastructure/contentStore'
import { decodePrompt } from '@/platform/content/locations/prompt'
import { sha256Hex } from '@/util/hash'
import { resetLoggerForTest, setLoggerStdoutWriterForTest } from '@/util/log'
import {
  readNodeRunPromptContent,
  storeNodeRunPromptContent,
} from '@/modules/task-execution/application/nodeRunPrompt'
import { createFileNodeRunPromptContent } from '@/modules/task-execution/infrastructure/local/fileNodeRunPromptContent'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import { fenceTaskWrite } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { o2Ports } from './helpers/o2Closure'
import {
  createConsumedInputsParticipantInTx,
  recordNodeRunInputsInTx,
} from '@/modules/task-execution/infrastructure/consumedInputsParticipant'
import { createRunSelectionParticipantInTx } from '@/modules/task-execution/infrastructure/runSelection/table/selectionWrite'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/runSelection/table/reader'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { DrizzleWrapperRunPersistence } from '@/modules/task-execution/infrastructure/wrapperRunPersistence'
import {
  readNodeRunSnapshotRows,
  readNodeRunSnapshot,
  projectNodeRunReadFacts,
} from '@/modules/task-execution/infrastructure/nodeRunSnapshot'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import type { RunSlot } from '@/modules/task-execution/application/ports/runSelection'
import { DrizzleNodeRunRuntimePersistence } from '@/modules/task-execution/infrastructure/nodeRunRuntimePersistence'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { createRuntimeSessionCapturePersistence } from '@/modules/task-execution/infrastructure/runtimeSessionCapturePersistence'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture } from './helpers/model'

/** PostgreSQL qualifies tables with the application schema; order checks compare table names. */
const statementText = (sql: string): string => sql.toLowerCase().replaceAll('"agent_workflow".', '')

const slot: RunSlot = {
  kind: 'node',
  nodeId: 'worker',
  frame: { containerRunId: null, iteration: 0 },
}

describeEachProvider('RFC-395 NodeRun multi-table atomicity', (h) => {
  function transaction<T>(body: (tx: PersistenceTx) => Promise<T>): Promise<T> {
    return h.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
      return body(tx)
    })
  }
  function serializable<T>(body: (tx: PersistenceTx) => Promise<T>): Promise<T> {
    return h.session.serializable(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
      return body(tx)
    })
  }
  async function seed() {
    const definition = {
      $schema_version: 2,
      nodes: [{ id: 'worker', kind: 'agent-single', agentName: 'worker' }],
      edges: [],
      inputs: [],
    }
    await workflowFixture(h.db, { id: 'w', name: 'w', definition })
    await taskFixture(h.db, {
      id: 't',
      workflowId: 'w',
      workflowSnapshot: definition,
      repoPath: '',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'task',
      status: 'running',
      inputs: {},
      startedAt: 1,
    })
    const { nodeRuns } = tablesOf(h.db)
    await insertOne(h.db, nodeRuns, {
      id: 'r',
      taskId: 't',
      nodeId: 'worker',
      seq: -1,
      role: 'node-attempt',
      slotKey: encodeCanonicalRunSlot(slot),
      generationSeq: 0,
      attemptIndex: 0,
      recordMode: 'executable',
      provenanceQuality: 'recorded',
      envelopeNonce: 'nonce-r',
      status: 'running',
      inputsRecorded: false,
    })
  }
  const tables = () => tablesOf(h.db)
  async function seedOwner() {
    const identity = createWorkerIdentity({ ownerId: 'owner-t', daemonGeneration: 'generation-t' })
    await insertOne(h.db, tablesOf(h.db).taskExecutionOwners, {
      taskId: 't',
      ownerId: identity.ownerId,
      daemonGeneration: identity.daemonGeneration,
      epoch: 1,
      state: 'claimed',
      leaseUntil: Date.now() + 60_000,
      revision: 1,
      lastHeartbeatAt: Date.now(),
      updatedAt: Date.now(),
    })
    return createTaskExecutionContext({
      intentId: 'intent-t',
      token: createOwnershipToken({
        taskId: 't',
        identity,
        epoch: 1,
        leaseUntil: Date.now() + 60_000,
        ownerRevision: 1,
      }),
      persistence: createTaskExecutionPersistence(h.db, {
        humanGateOpen: composeHumanGateOpenParticipantFactory(),
        historyRestrictions: epoch2RuntimeTestPorts(h.db).historyRestrictions,
        recoveryHumanGates: o2Ports(h.db).collaborationReads.recovery,
      }),
    })
  }
  // T18 P3-B / T29: replacing a run's ports holds the owner, task and run locks
  // across read/release/delete/insert, so competing whole sets cannot interleave.
  test('concurrent output replacements retain exactly one complete port set', async () => {
    await seed()
    const context = await seedOwner()
    const writer = new DrizzleNodeExecutionPersistence(h.db)
    const sets = [
      [
        { portName: 'shared', content: 'left' },
        { portName: 'left-only', content: 'left extra' },
      ],
      [
        { portName: 'shared', content: 'right' },
        { portName: 'right-only', content: 'right extra' },
      ],
    ]
    await Promise.all(
      sets.map((outputs) =>
        writer.replaceOutputs({ nodeRunId: 'r', outputs, executionContext: context, now: 10 }),
      ),
    )
    const outputs = (await writer.listOutputs('r')).map(({ portName, content }) => ({
      portName,
      content,
    }))
    const winner = outputs.find((row) => row.portName === 'shared')?.content
    expect(winner === 'left' || winner === 'right').toBe(true)
    expect(outputs).toEqual(
      sets[winner === 'left' ? 0 : 1]!.slice().sort((a, b) => a.portName.localeCompare(b.portName)),
    )
  })
  test('missed status/review CAS leaves all companions absent; matching CAS commits them', async () => {
    await seed()
    const { nodeRuns, nodeRunConfigs, nodeRunRuntimeStates, nodeRunResults } = tables()
    const write = {
      config: { runtime: 'claude-code', runtimeParamsJson: '{ "model": "frozen" }' },
      runtime: { pid: 12, sessionId: 'session' },
      result: { tokTotal: 0, rolledBack: false },
    }
    await expect(
      transaction((tx) =>
        compareAndWriteNodeRunInTx(
          tx,
          'r',
          eq(nodeRuns.status, 'pending'),
          { status: 'done' },
          write,
        ),
      ),
    ).rejects.toThrow('changed concurrently')
    expect(await h.db.select().from(nodeRunConfigs)).toEqual([])
    expect(await h.db.select().from(nodeRunRuntimeStates)).toEqual([])
    expect(await h.db.select().from(nodeRunResults)).toEqual([])
    await transaction((tx) =>
      compareAndWriteNodeRunInTx(
        tx,
        'r',
        eq(nodeRuns.reviewIteration, 0),
        { status: 'done', reviewIteration: 1 },
        write,
      ),
    )
    expect((await h.db.select().from(nodeRuns))[0]).toMatchObject({
      status: 'done',
      reviewIteration: 1,
    })
    expect((await h.db.select().from(nodeRunConfigs))[0]).toMatchObject(write.config)
    expect((await h.db.select().from(nodeRunRuntimeStates))[0]).toMatchObject(write.runtime)
    expect((await h.db.select().from(nodeRunResults))[0]).toMatchObject(write.result)
  })
  test('a late input failure rolls back identity, frozen config, runtime and results', async () => {
    await seed()
    const { nodeRuns, nodeRunConfigs, nodeRunRuntimeStates, nodeRunResults, nodeRunInputs } =
      tables()
    await expect(
      transaction((tx) =>
        compareAndWriteNodeRunInTx(
          tx,
          'r',
          eq(nodeRuns.status, 'running'),
          { status: 'done' },
          {
            config: { runtime: 'opencode' },
            runtime: { sessionId: 's' },
            result: { tokTotal: 8 },
            inputs: [
              { inputKind: 'frame-input', producerNodeId: 'missing', producerRunId: 'missing' },
            ],
          },
        ),
      ),
    ).rejects.toThrow('node-run-input-producer-mismatch')
    expect((await h.db.select().from(nodeRuns))[0]).toMatchObject({
      status: 'running',
      inputsRecorded: false,
    })
    for (const table of [nodeRunConfigs, nodeRunRuntimeStates, nodeRunResults, nodeRunInputs])
      expect(await h.db.select().from(table)).toEqual([])
  })
  test('outer owner failure rolls back already written companions', async () => {
    await seed()
    await expect(
      transaction(async (tx) => {
        await writeNodeRunTablesInTx(tx, 'r', {
          runtime: { wrapperProgressJson: '{}' },
          result: { rolledBack: false },
        })
        throw new Error('task-owner-cas-missed')
      }),
    ).rejects.toThrow('task-owner-cas-missed')
    expect(await h.db.select().from(tables().nodeRunRuntimeStates)).toEqual([])
    expect(await h.db.select().from(tables().nodeRunResults)).toEqual([])
  })
  test('missing runtime row is NULL merge state; a stale merge CAS cannot replace companions', async () => {
    await seed()
    await transaction((tx) =>
      compareAndWriteMergeStateInTx(tx, 'r', null, 'isolating', {
        runtime: { isolationRootRef: '/isolation', wrapperProgressJson: '{}' },
        result: { tokTotal: 5 },
      }),
    )
    await expect(
      transaction((tx) =>
        compareAndWriteMergeStateInTx(tx, 'r', null, 'isolating', {
          runtime: { isolationRootRef: '/wrong' },
          result: { tokTotal: 100 },
        }),
      ),
    ).rejects.toThrow('merge state changed concurrently')
    expect((await h.db.select().from(tables().nodeRunRuntimeStates))[0]).toMatchObject({
      mergeState: 'isolating',
      isolationRootRef: '/isolation',
      wrapperProgressJson: '{}',
    })
    expect((await h.db.select().from(tables().nodeRunResults))[0]?.tokTotal).toBe(5)
  })
  test('superseded merge settles abandoned without writing requested extras', async () => {
    await seed()
    const { nodeRuns } = tables()
    await insertOne(h.db, nodeRuns, {
      id: 'new',
      taskId: 't',
      nodeId: 'worker',
      seq: 2,
      role: 'node-attempt',
      slotKey: encodeCanonicalRunSlot(slot),
      generationSeq: 0,
      attemptIndex: 1,
      recordMode: 'executable',
      provenanceQuality: 'recorded',
      envelopeNonce: 'nonce-new',
      status: 'pending',
    })
    await transaction((tx) =>
      compareAndWriteMergeStateInTx(tx, 'r', null, 'isolating', {
        runtime: { isolationRootRef: '/original' },
      }),
    )
    await expect(
      new DrizzleMergeStateLifecyclePersistence(h.db).transition({
        nodeRunId: 'r',
        event: { kind: 'mark-pending-merge' },
        extra: { runtime: { isoWorktreePath: '/wrong' } },
      }),
    ).rejects.toThrow('superseded by a newer generation')
    expect((await h.db.select().from(tables().nodeRunRuntimeStates))[0]).toMatchObject({
      mergeState: 'abandoned',
      isolationRootRef: '/original',
    })
  })
  test('inputs retain kinds, ordinals and empty-shard identity; NULL differs from recorded empty', async () => {
    await seed()
    const { nodeRuns, nodeRunInputs } = tables()
    for (const [id, shardKey, seq] of [
      ['p0', null, 1],
      ['p1', '', 2],
    ] as const) {
      const source: RunSlot = { kind: 'shard', nodeId: 'source', iteration: 0, shardKey }
      await insertOne(h.db, nodeRuns, {
        id,
        taskId: 't',
        nodeId: 'source',
        seq,
        role: 'node-attempt',
        slotKey: encodeCanonicalRunSlot(source),
        generationSeq: 0,
        attemptIndex: 0,
        shardKey,
        recordMode: 'executable',
        provenanceQuality: 'recorded',
        envelopeNonce: `nonce-${id}`,
        status: 'done',
      })
    }
    await transaction((tx) =>
      recordNodeRunInputsInTx(tx, 'r', [
        {
          inputKind: 'frame-input',
          producerNodeId: 'source',
          producerRunId: 'p0',
        },
        {
          inputKind: 'aggregator-shard',
          producerNodeId: 'source',
          producerRunId: 'p0',
          producerShardKey: null,
        },
        {
          inputKind: 'aggregator-shard',
          producerNodeId: 'source',
          producerRunId: 'p1',
          producerShardKey: '',
        },
        {
          inputKind: 'review-source',
          producerNodeId: 'source',
          producerRunId: 'p1',
          producerShardKey: '',
        },
        {
          inputKind: 'wrapper-parameter',
          producerNodeId: 'source',
          producerRunId: 'p1',
        },
        {
          inputKind: 'gate-open',
          producerNodeId: 'source',
          producerRunId: 'p1',
        },
      ]),
    )
    const rows = await h.db.select().from(nodeRunInputs)
    expect(rows.map((row) => row.ordinal).sort()).toEqual([0, 1, 2, 3, 4, 5])
    expect(new Set(rows.map((row) => row.producerShardSlot)).size).toBe(2)
    expect(await createRunSelectionReader(h.db).consumed('r')).toEqual([
      { producerNodeId: 'source', producerRunId: 'p0' },
    ])
    expect(
      projectNodeRunReadFacts((await readNodeRunSnapshotRows(h.db, 'r'))!).consumedUpstreamRunsJson,
    ).toBe('{"source":"p0"}')
    await expect(
      transaction((tx) =>
        recordNodeRunInputsInTx(tx, 'r', [
          { inputKind: 'frame-input', producerNodeId: 'source', producerRunId: 'p0' },
          { inputKind: 'frame-input', producerNodeId: 'source', producerRunId: 'p0' },
        ]),
      ),
    ).rejects.toThrow('node-run-input-duplicate')
    expect(await h.db.select().from(nodeRunInputs)).toHaveLength(6)
    const participant = createConsumedInputsParticipantInTx()
    await transaction((tx) => participant.record(tx, 'r', { edges: [] }))
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'r')))[0]?.inputsRecorded,
    ).toBe(true)
    await transaction((tx) => participant.record(tx, 'r', { legacyJson: null }))
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'r')))[0]?.inputsRecorded,
    ).toBe(false)
    expect(await h.db.select().from(nodeRunInputs)).toEqual([])
  })
  test('checkpoint writes key by real mount, preserve empty markers and roll back on missing mounts', async () => {
    await seed()
    const { taskRepositoryMounts, nodeRunRepoCheckpoints } = tables()
    await insertOne(h.db, taskRepositoryMounts, {
      taskId: 't',
      repoKey: 'repo-svc',
      ordinal: 0,
      mountPath: 'svc',
      repoPath: '/repo',
      branchState: 'none',
      branch: null,
    })
    await transaction((tx) =>
      writeNodeRunTablesInTx(tx, 'r', {
        checkpoint: {
          checkpoints: [
            {
              mountPath: 'svc',
              preSnapshot: '',
              isolationBase: 'base',
              submodules: { poolDirs: {}, subBases: {} },
            },
          ],
        },
      }),
    )
    expect((await h.db.select().from(nodeRunRepoCheckpoints))[0]).toMatchObject({
      repoKey: 'repo-svc',
      preSnapshot: '',
      isolationBase: 'base',
    })
    await transaction((tx) =>
      writeNodeRunTablesInTx(tx, 'r', {
        checkpoint: {
          checkpoints: [{ mountPath: 'svc', nodeTree: 'tree' }],
          pendingSubResolves: [
            { mountPath: 'svc', poolDirs: {}, subBases: {}, pendingSubResolves: ['sub'] },
          ],
        },
      }),
    )
    expect((await h.db.select().from(nodeRunRepoCheckpoints))[0]).toMatchObject({
      preSnapshot: '',
      isolationBase: 'base',
      nodeTree: 'tree',
      submodules: '{"poolDirs":{},"subBases":{},"pendingSubResolves":["sub"]}',
    })
    await expect(
      transaction((tx) =>
        writeNodeRunTablesInTx(tx, 'r', {
          result: { tokTotal: 88 },
          checkpoint: { checkpoints: [{ mountPath: '', nodeTree: 'wrong-root' }] },
        }),
      ),
    ).rejects.toThrow('node-run-checkpoint-mount-missing:')
    expect(await h.db.select().from(tables().nodeRunResults)).toEqual([])
    await transaction((tx) =>
      writeNodeRunTablesInTx(tx, 'r', {
        checkpoint: { checkpoints: [], checkpointComponents: ['nodeTree'] },
      }),
    )
    expect((await h.db.select().from(nodeRunRepoCheckpoints))[0]).toMatchObject({
      preSnapshot: '',
      isolationBase: 'base',
      nodeTree: null,
    })
  })
  test('session linking checks running identity and expected NULL inside SERIALIZABLE', async () => {
    await seed()
    expect(
      await serializable((tx) =>
        compareAndWriteRunSessionInTx(tx, 'r', null, 's', {
          taskId: 't',
          nodeId: 'worker',
          status: 'pending',
        }),
      ),
    ).toBe(false)
    expect(
      await serializable((tx) =>
        compareAndWriteRunSessionInTx(tx, 'r', null, 's', {
          taskId: 't',
          nodeId: 'worker',
          status: 'running',
        }),
      ),
    ).toBe(true)
    expect(await serializable((tx) => compareAndWriteRunSessionInTx(tx, 'r', null, 'wrong'))).toBe(
      false,
    )
    expect(await serializable((tx) => compareAndWriteRunSessionInTx(tx, 'r', 's', 'next'))).toBe(
      true,
    )
    expect((await h.db.select().from(tables().nodeRunRuntimeStates))[0]?.sessionId).toBe('next')
  })
  test('projection identity and frozen runtime stay in the same transaction', async () => {
    await seed()
    await expect(
      transaction(async (tx) => {
        await writeNodeRunProjectionInTx(tx, 'r', {
          identity: { errorMessage: 'projected' },
          config: { runtime: 'opencode' },
          runtime: { opencodeSessionId: 'native' },
        })
        throw new Error('projection-owner-rollback')
      }),
    ).rejects.toThrow('projection-owner-rollback')
    expect((await h.db.select().from(tables().nodeRuns))[0]?.errorMessage).toBeNull()
    expect(await h.db.select().from(tables().nodeRunConfigs)).toEqual([])
    const params = {
      model: 'frozen',
      variant: null,
      temperature: null,
      steps: null,
      maxSteps: null,
      isSandbox: false,
    }
    const adapter = new DrizzleNodeRunRuntimePersistence(
      h.db,
      (runtime) => runtime === 'opencode',
      (_tx, assertScope) => async () => {
        assertScope()
        return {
          protocol: 'opencode',
          binary: '/frozen/bin',
          params,
          configDir: DEFAULT_CONFIG_DIR_PROFILE.opencode,
        }
      },
    )
    await adapter.withSelection('r', async (session) => {
      expect(await session.load()).toEqual({
        runtime: null,
        runtimeBinary: null,
        runtimeParamsJson: null,
      })
      const frozen = await session.select(null, null)
      await session.freeze({
        nodeRunId: 'r',
        runtime: frozen.protocol,
        runtimeBinary: frozen.binary,
        runtimeParamsJson: JSON.stringify(frozen.params),
      })
    })
    await serializable((tx) => compareAndWriteRunSessionInTx(tx, 'r', null, 'native'))
    expect(await adapter.findBySessionId('native')).toEqual(await adapter.load('r'))
    expect(await adapter.load('r')).toMatchObject({
      runtimeBinary: '/frozen/bin',
      runtimeParamsJson: JSON.stringify(params),
    })
  })
  test('lease claim, reset, rotation and release still own the same native session', async () => {
    await seed()
    const leases = createRuntimeSessionLeaseOperations(h.db)
    const token = await leases.claimNew({
      protocol: 'opencode',
      sessionId: 's0',
      taskId: 't',
      nodeId: 'worker',
      currentNodeRunId: 'r',
      leaseNonceDigest: 'digest-r',
      leasedAt: 10,
    })
    expect((await readNodeRunSnapshotRows(h.db, 'r'))?.runtime?.sessionId).toBe('s0')
    expect(await leases.markResetPending(token)).toBe(true)
    expect((await readNodeRunSnapshotRows(h.db, 'r'))?.runtime?.sessionId).toBeNull()
    const rotated = await leases.rotate(token, 's1')
    expect(await leases.load('opencode', 's0')).toBeUndefined()
    expect((await readNodeRunSnapshotRows(h.db, 'r'))?.runtime?.sessionId).toBe('s1')
    expect(await leases.release(rotated)).toBe(true)
    expect(await leases.load('opencode', 's1')).toMatchObject({
      leaseNodeRunId: null,
      leaseNonceDigest: null,
      resetPending: false,
    })
  })
  test('rotation relabels history-only lineage and discard clears its session without making it executable', async () => {
    await seed()
    const { nodeRuns, nodeRunRuntimeStates } = tables()
    await insertOne(h.db, nodeRuns, {
      id: 'lineage',
      taskId: 't',
      nodeId: 'worker',
      seq: -2,
      generationSeq: 0,
      role: null,
      slotKey: null,
      attemptIndex: null,
      scopePath: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      envelopeNonce: null,
      status: 'failed',
    })
    await insertOne(h.db, nodeRunRuntimeStates, { nodeRunId: 'lineage', sessionId: 's0' })
    const leases = createRuntimeSessionLeaseOperations(h.db)
    const token = await leases.claimNew({
      protocol: 'opencode',
      sessionId: 's0',
      taskId: 't',
      nodeId: 'worker',
      currentNodeRunId: 'r',
      leaseNonceDigest: 'digest-r',
      leasedAt: 10,
    })
    expect(await leases.markResetPending(token)).toBe(true)
    const rotated = await leases.rotate(token, 's1')
    expect((await readNodeRunSnapshotRows(h.db, 'lineage'))?.runtime?.sessionId).toBe('s1')
    expect((await readNodeRunSnapshotRows(h.db, 'lineage'))?.run.recordMode).toBe('history-only')
    await expect(
      transaction((tx) =>
        writeNodeRunTablesInTx(tx, 'lineage', {
          result: { tokTotal: 1 },
        }),
      ),
    ).rejects.toThrow('node-run-history-only')
    await expect(
      serializable((tx) =>
        compareAndWriteRunSessionInTx(tx, 'lineage', 's1', 's2', {
          taskId: 't',
          nodeId: 'worker',
          status: 'failed',
        }),
      ),
    ).rejects.toThrow('node-run-history-only')
    expect(
      await serializable((tx) => compareAndWriteRunSessionInTx(tx, 'lineage', 'wrong', null)),
    ).toBe(false)
    expect(await leases.discard(rotated)).toBe(true)
    expect((await readNodeRunSnapshotRows(h.db, 'r'))?.runtime?.sessionId).toBeNull()
    // Orphan recovery can discard a lease whose linked run is itself historical.
    await insertOne(h.db, tablesOf(h.db).runtimeSessionLeases, {
      protocol: 'opencode',
      sessionId: 's1',
      taskId: 't',
      nodeId: 'worker',
      createdNodeRunId: 'lineage',
      leaseNodeRunId: 'lineage',
      leaseNonceDigest: 'lineage-digest',
      leasedAt: 10,
      resetPending: false,
    })
    expect(
      await leases.discard({
        ...rotated,
        nodeRunId: 'lineage',
        leaseNonceDigest: 'lineage-digest',
      }),
    ).toBe(true)
    expect((await readNodeRunSnapshotRows(h.db, 'lineage'))?.runtime?.sessionId).toBeNull()
  })
  test.each(['merge', 'freeze', 'selection-freeze', 'wrapper', 'lease', 'capture'] as const)(
    '%s adapter takes the owned fence before the task root and never reacquires the root',
    async (adapter) => {
      await seed()
      const context = await seedOwner()
      const runtime = new DrizzleNodeRunRuntimePersistence(
        h.db,
        () => false,
        () => async () => {
          throw new Error('runtime-selection-not-requested')
        },
      )
      const input = {
        nodeRunId: 'r',
        runtime: 'opencode' as const,
        runtimeBinary: '/bin/runtime',
        runtimeParamsJson: '{}',
      }
      const recording = h.recordStatements()
      try {
        await runWithTaskExecutionContext(context, async () => {
          switch (adapter) {
            case 'merge':
              await new DrizzleMergeStateLifecyclePersistence(h.db).transition({
                nodeRunId: 'r',
                event: { kind: 'begin-isolation' },
              })
              break
            case 'freeze':
              await runtime.freeze(input)
              break
            case 'selection-freeze':
              await runtime.withSelection('r', (session) => session.freeze(input))
              break
            case 'wrapper':
              await new DrizzleWrapperRunPersistence(h.db).clearReuseDisabled({ nodeRunId: 'r' })
              break
            case 'lease':
              await createRuntimeSessionLeaseOperations(h.db).claimNew({
                protocol: 'opencode',
                sessionId: 's0',
                taskId: 't',
                nodeId: 'worker',
                currentNodeRunId: 'r',
                leaseNonceDigest: 'digest-r',
                leasedAt: 10,
              })
              break
            case 'capture':
              await createRuntimeSessionCapturePersistence(h.db).appendEvents({
                taskId: 't',
                nodeRunId: 'r',
                events: [
                  { ts: 1, kind: 'text', payload: '{}', sessionId: 's0', parentSessionId: null },
                ],
              })
          }
        })
      } finally {
        recording.stop()
      }
      const statements = recording.statements.map(({ sql }) => statementText(sql))
      if (adapter === 'lease')
        expect(statements).not.toContain('set transaction isolation level serializable')
      const owner = statements.findIndex((statement) =>
        statement.includes('update "task_execution_owners"'),
      )
      expect(owner).toBeGreaterThanOrEqual(0)
      if (h.capabilities.isolation === 'read-committed') {
        const roots = statements.flatMap((statement, index) =>
          statement.includes('from "tasks"') && statement.includes('for update') ? [index] : [],
        )
        expect(roots).toHaveLength(1)
        expect(roots[0]!).toBeGreaterThan(owner)
      }
    },
  )
  test('recording inputs after an owned run CAS does not reacquire the root', async () => {
    await seed()
    const context = await seedOwner()
    const recording = h.recordStatements()
    try {
      await h.session.transaction(async (tx) => {
        await fenceTaskWrite(tx, { taskId: 't', context })
        await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
        const { nodeRuns } = tablesOf(tx)
        await tx.update(nodeRuns).set({ reviewIteration: 1 }).where(eq(nodeRuns.id, 'r'))
        await createConsumedInputsParticipantInTx().record(tx, 'r', { edges: [] })
      })
    } finally {
      recording.stop()
    }
    const statements = recording.statements.map(({ sql }) => statementText(sql))
    const runWrite = statements.findIndex((statement) => statement.includes('update "node_runs"'))
    const inputs = statements.findIndex((statement) =>
      statement.includes('delete from "node_run_inputs"'),
    )
    expect(runWrite).toBeGreaterThanOrEqual(0)
    expect(inputs).toBeGreaterThan(runWrite)
    expect(
      statements
        .slice(runWrite)
        .some(
          (statement) => statement.includes('from "tasks"') && statement.includes('for update'),
        ),
    ).toBe(false)
    expect((await readNodeRunSnapshotRows(h.db, 'r'))?.run.inputsRecorded).toBe(true)
  })
  test('real SQL keeps one transaction and root/subordinate/run/selection acquisition order', async () => {
    await seed()
    const recording = h.recordStatements()
    try {
      await transaction(async (tx) => {
        await writeNodeRunTablesInTx(tx, 'r', {
          checkpoint: { checkpoints: [] },
          result: { tokTotal: 1 },
        })
        await createRunSelectionParticipantInTx().apply(tx, [
          {
            kind: 'select',
            taskId: 't',
            slot,
            run: {
              id: 'r',
              taskId: 't',
              slot,
              containerRunId: null,
              parentNodeRunId: null,
              shardKey: null,
            },
            expectedRevision: 0,
            generationSeq: 0,
            cause: 'atomic',
          },
        ])
      })
    } finally {
      recording.stop()
    }
    const sql = recording.statements.map((statement) => statementText(statement.sql))
    expect(sql.filter((statement) => /^\s*begin\b/.test(statement))).toHaveLength(1)
    expect(sql.some((statement) => /savepoint/.test(statement))).toBe(false)
    const mounts = sql.findIndex((statement) => statement.includes('from "task_repository_mounts"'))
    const result = sql.findIndex((statement) =>
      statement.includes('insert into "node_run_results"'),
    )
    const selection = sql.findIndex((statement) =>
      statement.includes('insert into "node_run_selections"'),
    )
    expect(mounts).toBeGreaterThanOrEqual(0)
    expect(result).toBeGreaterThan(mounts)
    expect(selection).toBeGreaterThan(result)
    if (h.capabilities.isolation === 'read-committed') {
      const root = sql.findIndex(
        (statement) => statement.includes('from "tasks"') && statement.includes('for update'),
      )
      const run = sql.findIndex(
        (statement) => statement.includes('from "node_runs"') && statement.includes('for update'),
      )
      expect(root).toBeGreaterThanOrEqual(0)
      expect(
        sql.filter(
          (statement) => statement.includes('from "tasks"') && statement.includes('for update'),
        ),
      ).toHaveLength(1)
      expect(mounts).toBeGreaterThan(root)
      expect(run).toBeGreaterThan(mounts)
      expect(selection).toBeGreaterThan(run)
    }
  })
  test('projection keeps missing rows NULL and prompt bytes including BOM/empty text', async () => {
    await seed()
    const empty = (await readNodeRunSnapshotRows(h.db, 'r'))!
    expect(projectNodeRunReadFacts(empty)).toMatchObject({
      promptText: null,
      mergeState: null,
      opencodeSessionId: null,
      tokTotal: null,
      consumedUpstreamRunsJson: null,
      checkpoints: [],
    })
    const bytes = new TextEncoder().encode('\uFEFFprompt')
    const write = nodeRunTableWrite(
      { config: { promptText: '\uFEFFprompt' } },
      {
        version: 1,
        kind: 'inline',
        location: { codec: 'inline', value: null },
        bytes,
        contentId: null,
        contentVersion: null,
        sha256: null,
        size: bytes.length,
        mediaType: 'text/plain',
      },
    )
    await transaction((tx) => writeNodeRunTablesInTx(tx, 'r', write))
    expect(projectNodeRunReadFacts((await readNodeRunSnapshotRows(h.db, 'r'))!).promptText).toBe(
      '\uFEFFprompt',
    )
    expect(() => nodeRunTableWrite({ config: { promptPath: '/not-published' } })).toThrow(
      'node-run-prompt-reference-required',
    )
    const store = createContentStore({
      db: h.db,
      policy: { inlineMaxBytes: 0, externalKind: 'database-bytes' },
    })
    for (const [index, text] of ['', '\uFEFFexternal'].entries()) {
      const bytes = new TextEncoder().encode(text)
      await store.put(
        {
          publication: {
            owner: 'node-run-prompt',
            logicalKey: `r/${index}`,
            scope: 't',
            attempt: `a${index}`,
            epoch: 1,
            sha256: sha256Hex(bytes),
            size: bytes.byteLength,
          },
          source: { kind: 'bytes', bytes },
          contentVersion: 1,
          mediaType: 'text/plain',
          references: 'shared',
        },
        async (tx, ref) => {
          await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
          await writeNodeRunTablesInTx(tx, 'r', nodeRunTableWrite({}, ref))
        },
      )
      expect(await readNodeRunSnapshot(h.db, 'r', store)).toMatchObject({
        promptText: text,
        promptPath: null,
      })
    }
  })
  test('legacy spilled prompts stay lazy with real content bindings, including missing and unreadable files', async () => {
    await seed()
    const home = mkdtempSync(join(tmpdir(), 'rfc395-na-prompt-'))
    const runs = join(home, 'runs')
    const promptContent = createFileNodeRunPromptContent(runs)
    const contentStore = createContentStore({
      db: h.db,
      policy: { inlineMaxBytes: 0, externalKind: 'local-file' },
      transports: { 'local-file': createLocalFileContentTransport(join(home, 'content'), runs) },
    })
    const logs: string[] = []
    resetLoggerForTest()
    setLoggerStdoutWriterForTest((line) => logs.push(line))
    try {
      const text = '\uFEFF' + 'prompt'.repeat(1024)
      const storage = storeNodeRunPromptContent(promptContent, 't', 'r', text)
      expect(storage.promptText).toBeNull()
      expect(storage.promptPath).not.toBeNull()
      await transaction((tx) =>
        writeNodeRunTablesInTx(tx, 'r', nodeRunTableWrite({}, decodePrompt(storage))),
      )
      const snapshot = await readNodeRunSnapshot(h.db, 'r', contentStore)
      expect(snapshot).toMatchObject(storage)
      expect(readNodeRunPromptContent(promptContent, snapshot)).toBe(text)

      promptContent.write(storage.promptPath!, '')
      expect(
        readNodeRunPromptContent(promptContent, await readNodeRunSnapshot(h.db, 'r', contentStore)),
      ).toBe('')
      rmSync(join(runs, storage.promptPath!))
      const missing = await readNodeRunSnapshot(h.db, 'r', contentStore)
      expect(missing).toMatchObject(storage)
      expect(readNodeRunPromptContent(promptContent, missing)).toBeNull()

      // A directory at the stored file path deterministically fails the real file read.
      mkdirSync(join(runs, storage.promptPath!))
      const unreadable = await readNodeRunSnapshot(h.db, 'r', contentStore)
      expect(unreadable).toMatchObject(storage)
      expect(logs).toEqual([])
      expect(readNodeRunPromptContent(promptContent, unreadable)).toBeNull()
      expect(logs.join('\n')).toContain('prompt file unreadable')
      expect(logs.join('\n')).toContain(storage.promptPath!)
    } finally {
      resetLoggerForTest()
      rmSync(home, { recursive: true, force: true })
    }
  })
  test('wrapper resumability uses a persisted selection, never the newest unselected run', async () => {
    await seed()
    const container: RunSlot = {
      kind: 'container',
      nodeId: 'wrapper',
      frame: { containerRunId: null, iteration: 0 },
    }
    const { nodeRuns } = tables()
    for (const [seq, id, status] of [
      [2, 'g0', 'interrupted'],
      [3, 'g1', 'done'],
    ] as const)
      await insertOne(h.db, nodeRuns, {
        id,
        taskId: 't',
        nodeId: 'wrapper',
        seq,
        role: 'container',
        slotKey: encodeCanonicalRunSlot(container),
        generationSeq: 0,
        attemptIndex: 0,
        recordMode: 'executable',
        provenanceQuality: 'recorded',
        envelopeNonce: `nonce-${id}`,
        status,
      })
    await transaction(async (tx) => {
      await writeNodeRunTablesInTx(tx, 'g0', {
        runtime: {
          wrapperProgressJson: '{"kind":"fanout","phase":"awaiting","reuseDisabled":true}',
        },
        inputs: [
          { inputKind: 'frame-input', producerNodeId: 'worker', producerRunId: 'r' },
          { inputKind: 'aggregator-shard', producerNodeId: 'wrapper', producerRunId: 'g1' },
        ],
      })
      await createRunSelectionParticipantInTx().apply(tx, [
        {
          kind: 'select',
          taskId: 't',
          slot: container,
          run: {
            id: 'g0',
            taskId: 't',
            slot: container,
            containerRunId: null,
            parentNodeRunId: null,
            shardKey: null,
          },
          expectedRevision: 0,
          generationSeq: 0,
          cause: 'adopt',
        },
      ])
    })
    const adapter = new DrizzleWrapperRunPersistence(h.db)
    expect(
      await adapter.findResumable({
        taskId: 't',
        nodeId: 'wrapper',
        iteration: 0,
        containerRunId: null,
      }),
    ).toMatchObject({
      id: 'g0',
      status: 'interrupted',
      previous: { consumedUpstreamRunsJson: '{"worker":"r"}' },
    })
    await adapter.clearReuseDisabled({ nodeRunId: 'g0' })
    expect((await readNodeRunSnapshotRows(h.db, 'g0'))?.runtime?.wrapperProgressJson).toBe(
      '{"kind":"fanout","phase":"awaiting"}',
    )
  })
})

test('generic runtime writes exclude mergeState; the merge CAS remains the only typed write path', () => {
  const includesMergeState: 'mergeState' extends keyof NonNullable<NodeRunTableWrite['runtime']>
    ? true
    : false = false
  expect(includesMergeState).toBe(false)
})

test('N-a protocol and adapters contain no legacy single-row companion writes or oracle imports', () => {
  const root = new URL('../src/modules/task-execution/infrastructure/', import.meta.url)
  const protocol = readFileSync(new URL('nodeRunWriteProtocol.ts', root), 'utf8')
  expect(protocol).not.toContain('databaseSessionFor(')
  expect(protocol).not.toContain('.transaction(')
  for (const file of [
    'mergeStateLifecyclePersistence.ts',
    'nodeRunRuntimePersistence.ts',
    'wrapperRunPersistence.ts',
    'runtimeSessionLeaseOperations.ts',
    'crewstation/processEffectProjection.ts',
    'crewstation/bootRecovery.ts',
  ]) {
    const source = readFileSync(new URL(file, root), 'utf8')
    expect(source).not.toContain('/oracle/')
    expect(source).not.toMatch(
      /\.update\(nodeRun(?:Configs|RuntimeStates|Results|RepoCheckpoints)\)/,
    )
  }
})
