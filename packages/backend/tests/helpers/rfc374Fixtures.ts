// RFC-374: shared real persistence fixtures; assertions never depend on an absolute allocated seq.
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { eq } from 'drizzle-orm'
import { backfillNodeRunSequences } from '@/modules/task-execution/application/nodeRunSeqBackfill'
import { createNodeRunSeqBackfillStore } from '@/modules/task-execution/infrastructure/nodeRunSeqBackfillStore'
import { nodeRunSeqAllocations, nodeRuns, tasks, workflows } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import type { NodeRunMintInput } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'

export async function seedSequenceTask(db: ProviderNeutralDatabase): Promise<string> {
  const workflowId = ulid(),
    id = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[],"outputs":[]}',
  })
  await db.insert(tasks).values({
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
  db: ProviderNeutralDatabase,
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
  db: ProviderNeutralDatabase,
  taskId: string,
  nodeRunId: string,
): Promise<number> {
  const allocation = await databaseSessionFor(db).transaction(
    async (tx) =>
      await tx
        .insert(nodeRunSeqAllocations)
        .values({ taskId, nodeRunId, allocatedAt: Date.now() })
        .returning({ seq: nodeRunSeqAllocations.seq })
        .get(),
  )
  if (allocation === undefined) throw new Error('node-run-seq-allocation-missing')
  return allocation.seq
}

/** Simulate rows written by the old binary, then exercise the real startup catch-up before resuming. */
export async function catchUpLegacySequenceTask(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<void> {
  await db.update(nodeRuns).set({ seq: null }).where(eq(nodeRuns.taskId, taskId))
  await backfillNodeRunSequences(createNodeRunSeqBackfillStore(db))
}
