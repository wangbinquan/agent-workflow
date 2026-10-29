// RFC-395 D13: the NodeRun companion tables (config / runtime state / result) were reshaped, and
// drizzle builds INSERT / UPDATE from the table's own columns, silently dropping any other key of a
// non-literal payload. The write protocol is the single sink for those tables, so it must reject a
// payload that names a column the table does not have instead of losing the value. The DTO edge
// (`nodeRunTableWrite`) still renames its stable names (opencodeSessionId → session_id,
// isoWorktreePath → isolation_root_ref) and keeps writing.
import { expect, test } from 'bun:test'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import {
  compareAndWriteMergeStateInTx,
  writeNodeRunProjectionInTx,
  writeNodeRunTablesInTx,
  type NodeRunTableWrite,
} from '@/modules/task-execution/infrastructure/nodeRunWriteProtocol'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import type { RunSlot } from '@/modules/task-execution/application/ports/runSelection'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture } from './helpers/model'

const slot: RunSlot = {
  kind: 'node',
  nodeId: 'worker',
  frame: { containerRunId: null, iteration: 0 },
}

describeEachProvider('RFC-395 D13 NodeRun companion writes take only their own columns', (h) => {
  function transaction<T>(body: (tx: PersistenceTx) => Promise<T>): Promise<T> {
    return h.session.transaction(async (tx) => {
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
    await insertOne(h.db, tablesOf(h.db).nodeRuns, {
      id: 'r1',
      taskId: 't',
      nodeId: 'worker',
      seq: 1,
      role: 'node-attempt',
      slotKey: encodeCanonicalRunSlot(slot),
      generationSeq: 0,
      attemptIndex: 0,
      recordMode: 'executable',
      provenanceQuality: 'recorded',
      envelopeNonce: 'nonce-r1',
      status: 'running',
    })
  }
  async function companionRows() {
    const { nodeRunConfigs, nodeRunRuntimeStates, nodeRunResults } = tablesOf(h.db)
    return {
      config: await h.db.select().from(nodeRunConfigs),
      runtime: await h.db.select().from(nodeRunRuntimeStates),
      result: await h.db.select().from(nodeRunResults),
    }
  }

  test('a payload naming a column the companion table does not have is rejected, not dropped', async () => {
    await seed()
    // Each payload pairs a real column with a key that moved or never existed; a wider object
    // passed by reference type-checks, so only the protocol can stop the silent loss.
    const wider: ReadonlyArray<[string, NodeRunTableWrite]> = [
      [
        'config.preSnapshotReposJson',
        { config: { runtimeParamsJson: '{}', preSnapshotReposJson: '{}' } as never },
      ],
      ['runtime.opencodeSessionId', { runtime: { pid: 7, opencodeSessionId: 's1' } as never }],
      ['result.preSnapshot', { result: { tokTotal: 3, preSnapshot: 'stash' } as never }],
    ]
    for (const [column, write] of wider)
      await expect(transaction((tx) => writeNodeRunTablesInTx(tx, 'r1', write))).rejects.toThrow(
        `node-run-write-unknown-column:${column}`,
      )
    await expect(
      transaction((tx) =>
        compareAndWriteMergeStateInTx(tx, 'r1', null, 'isolating', {
          runtime: { isoWorktreePath: '/iso' } as never,
        }),
      ),
    ).rejects.toThrow('node-run-write-unknown-column:runtime.isoWorktreePath')
    // Nothing reached the companion tables, not even the valid half of a rejected payload.
    expect(await companionRows()).toEqual({ config: [], runtime: [], result: [] })
  })

  test('exact payloads and the DTO edge still write every value', async () => {
    await seed()
    await transaction((tx) =>
      writeNodeRunTablesInTx(tx, 'r1', {
        config: { runtimeParamsJson: '{"model":"m"}' },
        result: { tokTotal: 3 },
      }),
    )
    await transaction((tx) =>
      writeNodeRunProjectionInTx(tx, 'r1', {
        runtime: { pid: 7, opencodeSessionId: 's1', isoWorktreePath: '/iso' },
        result: { tokTotal: 5 },
      }),
    )
    await transaction((tx) => compareAndWriteMergeStateInTx(tx, 'r1', null, 'isolating'))
    const rows = await companionRows()
    expect(rows.config).toEqual([expect.objectContaining({ runtimeParamsJson: '{"model":"m"}' })])
    expect(rows.runtime).toEqual([
      expect.objectContaining({
        pid: 7,
        sessionId: 's1',
        isolationRootRef: '/iso',
        mergeState: 'isolating',
      }),
    ])
    expect(rows.result).toEqual([expect.objectContaining({ tokTotal: 5 })])
  })
})
