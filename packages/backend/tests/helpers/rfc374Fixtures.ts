// RFC-374: shared real persistence fixtures; assertions never depend on an absolute allocated seq.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { eq } from 'drizzle-orm'
import { backfillNodeRunSequences } from '@/modules/task-execution/application/nodeRunSeqBackfill'
import { createNodeRunSeqBackfillStore } from '@/modules/task-execution/infrastructure/nodeRunSeqBackfillStore'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import type { NodeRunMintInput } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'

export async function seedSequenceTask(db: PersistenceDb): Promise<string> {
  const workflowId = ulid(),
    id = ulid()
  const { workflows, tasks } = tablesOf(db)
  await insertOne(db, workflows, {
    id: workflowId,
    name: workflowId,
    definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[],"outputs":[]}',
  })
  await insertOne(db, tasks, {
    id,
    executionLineageId: id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
    ]),
    name: id,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/rfc374/repo',
    worktreePath: '/tmp/rfc374/task',
    baseBranch: 'main',
    branch: id,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return id
}

export async function mintSequenceRun(
  db: PersistenceDb,
  taskId: string,
  input: Partial<NodeRunMintInput> = {},
): Promise<string> {
  return databaseSessionFor(db).transaction((tx) =>
    createNodeRunMintParticipantInTx(tx).mint({
      taskId,
      nodeId: 'n',
      iteration: 0,
      status: 'done',
      cause: 'initial',
      ...input,
    }),
  )
}

/**
 * What the mint program does before its insert. A test that seeds a later generation with a direct
 * `insert(nodeRuns)` takes its seq here; without one the row reads as a legacy row, older than every
 * minted row.
 */
export async function allocateNodeRunSeq(
  db: PersistenceDb,
  taskId: string,
  nodeRunId: string,
): Promise<number> {
  const allocation = await databaseSessionFor(db).transaction(async (tx) => {
    const { nodeRunSeqAllocations } = tablesOf(tx)
    return await first(
      tx
        .insert(nodeRunSeqAllocations)
        .values({ taskId, nodeRunId, allocatedAt: Date.now() })
        .returning({ seq: nodeRunSeqAllocations.seq }),
    )
  })
  if (allocation === undefined) throw new Error('node-run-seq-allocation-missing')
  return allocation.seq
}

/** Simulate rows written by the old binary, then exercise the real startup catch-up before resuming. */
export async function catchUpLegacySequenceTask(db: PersistenceDb, taskId: string): Promise<void> {
  const { nodeRuns } = tablesOf(db)
  await db.update(nodeRuns).set({ seq: null }).where(eq(nodeRuns.taskId, taskId))
  await backfillNodeRunSequences(createNodeRunSeqBackfillStore(db))
}
