// RFC-395 II-a A1: runs allocate seq in caller order; tests supply checkpoints and consumed edges.
import { eq } from 'drizzle-orm'
import { decodeConsumedEdges } from '@/modules/task-execution/infrastructure/runSelection/consumedCodec'
import { nodeRunLineageColumns } from '@/modules/task-execution/application/buildNodeRunMintRecord'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import {
  createFixtureAdapter,
  decodeFixture,
  fixtureTransaction,
  patchFixtureRows,
  encodeFixture,
  type FixtureHandle,
  type FixturePatch,
} from './core'
import {
  encodeCheckpoints,
  encodeCheckpointPatch,
  decodeCheckpoints,
  encodeConsumedEdges,
  type RunCheckpointFixture,
  type ConsumedEdgeFixture,
} from './checkpoint'
import type { NodeRunFixtureSpec } from './nodeRun.spec'
export type { NodeRunFixtureSpec } from './nodeRun.spec'
type StoredRun = PersistenceTables['nodeRuns']['$inferSelect']
type DeletedRunFields =
  | 'preSnapshot'
  | 'preSnapshotReposJson'
  | 'isoBaseSnapshot'
  | 'isoBaseSnapshotReposJson'
  | 'isoNodeTree'
  | 'isoNodeTreeReposJson'
  | 'isoSubmodulesJson'
  | 'isoSubmodulesReposJson'
  | 'consumedUpstreamRunsJson'
  | 'injectedMemoriesJson'
  | 'portValidationFailuresJson'
  | 'commitPushJson'
export type NodeRunFixtureRow = Omit<StoredRun, DeletedRunFields> & {
  checkpoints: RunCheckpointFixture[]
  consumedEdges: ConsumedEdgeFixture[] | undefined
  injectedMemories: string | null
  portValidationFailures: string | null
  commitPush: string | null
}
async function mounts(db: FixtureHandle, taskId: string): Promise<string[]> {
  const { taskRepos } = tablesOf(db)
  return (
    await db
      .select({ mountPath: taskRepos.mountPath })
      .from(taskRepos)
      .where(eq(taskRepos.taskId, taskId))
  ).map((row) => row.mountPath)
}
const adapter = createFixtureAdapter<
  NodeRunFixtureSpec,
  PersistenceTables['nodeRuns'],
  NodeRunFixtureRow
>({
  table: (db) => tablesOf(db).nodeRuns,
  physicalTable: 'node_runs',
  keys: ['id'],
  async prepare(db, row, spec) {
    const { nodeRunSeqAllocations, tasks } = tablesOf(db)
    if (spec.seq === undefined) {
      const allocation = await first(
        db
          .insert(nodeRunSeqAllocations)
          .values({ taskId: spec.taskId, nodeRunId: String(row.id), allocatedAt: Date.now() })
          .returning({ seq: nodeRunSeqAllocations.seq }),
      )
      if (!allocation) throw new Error('node-run-seq-allocation-missing')
      row.seq = allocation.seq
    }
    const record = {
      nodeId: spec.nodeId,
      iteration: spec.iteration ?? 0,
      shardKey: spec.shardKey ?? null,
      continuationSlotKey: (row.continuationSlotKey as string | null | undefined) ?? null,
      lineageSlotPathJson: (row.lineageSlotPathJson as string | null | undefined) ?? null,
    }
    const task =
      record.lineageSlotPathJson !== null
        ? undefined
        : await first(
            db
              .select({
                lineageSlotPathJson: tasks.lineageSlotPathJson,
                workflowVersion: tasks.workflowVersion,
              })
              .from(tasks)
              .where(eq(tasks.id, spec.taskId)),
          )
    Object.assign(row, nodeRunLineageColumns(record, task))
    if (spec.checkpoints !== undefined)
      Object.assign(row, encodeCheckpoints(spec.checkpoints, await mounts(db, spec.taskId)))
    if (spec.consumedEdges !== undefined)
      row.consumedUpstreamRunsJson = encodeConsumedEdges(spec.consumedEdges)
  },
  async project(db, row) {
    const consumedEdges: ConsumedEdgeFixture[] | undefined =
      row.consumedUpstreamRunsJson == null
        ? undefined
        : decodeConsumedEdges(row.consumedUpstreamRunsJson).map((edge) => ({ ...edge }))
    if (consumedEdges) {
      const { nodeRuns } = tablesOf(db)
      for (const edge of consumedEdges) {
        const producer = await first(
          db
            .select({ shardKey: nodeRuns.shardKey })
            .from(nodeRuns)
            .where(eq(nodeRuns.id, edge.producerRunId)),
        )
        edge.producerShardKey = producer?.shardKey ?? null
      }
    }
    return {
      ...decodeFixture('node_runs', row),
      checkpoints: decodeCheckpoints(row, await mounts(db, row.taskId)),
      consumedEdges,
    } as NodeRunFixtureRow
  },
})
export const nodeRunFixture = adapter.insert
export const readNodeRunFixtures = adapter.read
export async function patchNodeRunFixture(
  db: FixtureHandle,
  where: object | undefined,
  spec: FixturePatch<NodeRunFixtureSpec>,
): Promise<number> {
  if (spec.checkpoints === undefined && spec.consumedEdges === undefined)
    return adapter.patch(db, where, spec)
  return fixtureTransaction(db, async (tx) => {
    const rows = await adapter.read(tx, where)
    let count = 0
    for (const row of rows) {
      const patch = encodeFixture('node_runs', spec)
      if (Array.isArray(spec.checkpoints))
        Object.assign(patch, encodeCheckpointPatch(spec.checkpoints, await mounts(tx, row.taskId)))
      if (Array.isArray(spec.consumedEdges))
        patch.consumedUpstreamRunsJson = encodeConsumedEdges(spec.consumedEdges)
      count += await patchFixtureRows(tx, tablesOf(tx).nodeRuns, 'node_runs', { id: row.id }, patch)
    }
    return count
  })
}
