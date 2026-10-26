// Target checkpoint fixtures read native companions in one snapshot, ordered by mount identity.
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskMountKeysReader } from '@/modules/task-execution/infrastructure/taskCheckpointPersistence'
import {
  databaseSessionFor,
  databaseTransactionIsActive,
} from '@/platform/persistence/databaseTransaction'
import type { FixtureHandle } from './core'
import type { TaskRepositoryCheckpoint } from '@/modules/task-execution/domain/taskCheckpoint'

export type RunCheckpointFixture = TaskRepositoryCheckpoint
export interface ConsumedEdgeFixture {
  producerNodeId: string
  producerRunId: string
  producerShardKey?: string | null
}
export { encodeConsumedEdges } from '@/modules/task-execution/infrastructure/runSelection/consumedCodec'

/** Compare the recorded component per mount without exposing epoch-1 JSON columns. */
export function checkpointValues<K extends Exclude<keyof RunCheckpointFixture, 'mountPath'>>(
  checkpoints: readonly RunCheckpointFixture[] | undefined,
  field: K,
): Record<string, Exclude<RunCheckpointFixture[K], undefined>> {
  return Object.fromEntries(
    (checkpoints ?? [])
      .filter((checkpoint) => checkpoint[field] !== undefined)
      .map((checkpoint) => [
        checkpoint.mountPath,
        checkpoint[field] as Exclude<RunCheckpointFixture[K], undefined>,
      ]),
  )
}
/** Select producer identities when an assertion does not depend on the shard. */
export function consumedProducerIds(
  edges: readonly ConsumedEdgeFixture[] | undefined,
): Record<string, string> {
  return Object.fromEntries((edges ?? []).map((edge) => [edge.producerNodeId, edge.producerRunId]))
}

/** Native checkpoint rows, including absent companions, for storage assertions. */
export async function readStoredCheckpointFixture(db: FixtureHandle, id: string) {
  const read = async (tx: FixtureHandle) => {
    const { nodeRuns, nodeRunRuntimeStates, nodeRunRepoCheckpoints } = tablesOf(tx)
    const [run] = await tx
      .select({ id: nodeRuns.id, taskId: nodeRuns.taskId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, id))
    if (!run) throw new Error(`missing checkpoint fixture ${id}`)
    const mounts = await taskMountKeysReader.list(tx, run.taskId)
    const [runtime] = await tx
      .select({ mergeState: nodeRunRuntimeStates.mergeState })
      .from(nodeRunRuntimeStates)
      .where(eq(nodeRunRuntimeStates.nodeRunId, id))
    const checkpoints = await tx
      .select()
      .from(nodeRunRepoCheckpoints)
      .where(eq(nodeRunRepoCheckpoints.nodeRunId, id))
    const byKey = new Map(checkpoints.map((row) => [row.repoKey, row]))
    return {
      id,
      mergeState: runtime?.mergeState ?? null,
      checkpoints: mounts.flatMap((mount) => {
        const row = byKey.get(mount.repoKey)
        return row ? [row] : []
      }),
    }
  }
  return databaseTransactionIsActive(db) ? read(db) : databaseSessionFor(db).snapshotRead(read)
}
/** Legacy DTO text is reconstructed from the recorded flag and ordered input rows. */
export async function readStoredConsumedInputsFixture(db: FixtureHandle, id: string) {
  const { readNodeRunFixtures } = await import('./nodeRun')
  const [run] = await readNodeRunFixtures(db, { id })
  if (!run) throw new Error(`missing consumed-input fixture ${id}`)
  return run.consumedEdges === undefined
    ? null
    : JSON.stringify(consumedProducerIds(run.consumedEdges))
}
