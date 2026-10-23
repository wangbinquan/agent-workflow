// RFC-395 II-a A1: one checkpoint list encodes today's root/map storage without exposing it to tests.
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { TaskCheckpointColumns } from '@/modules/task-execution/infrastructure/taskCheckpointCodec'
import type { FixtureHandle } from './core'
import type { TaskRepositoryCheckpoint } from '@/modules/task-execution/domain/taskCheckpoint'
export {
  encodeTaskCheckpoints as encodeCheckpoints,
  encodeTaskCheckpointPatch as encodeCheckpointPatch,
  decodeTaskCheckpoints as decodeCheckpoints,
} from '@/modules/task-execution/infrastructure/taskCheckpointCodec'

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

/** Raw epoch-1 oracle for compatibility tests; deliberately does not decode/re-encode checkpoints. */
export async function readStoredCheckpointFixture(db: FixtureHandle, id: string) {
  const { nodeRuns } = tablesOf(db)
  const [row] = await db
    .select({
      id: nodeRuns.id,
      mergeState: nodeRuns.mergeState,
      preSnapshot: nodeRuns.preSnapshot,
      preSnapshotReposJson: nodeRuns.preSnapshotReposJson,
      isoBaseSnapshot: nodeRuns.isoBaseSnapshot,
      isoBaseSnapshotReposJson: nodeRuns.isoBaseSnapshotReposJson,
      isoNodeTree: nodeRuns.isoNodeTree,
      isoNodeTreeReposJson: nodeRuns.isoNodeTreeReposJson,
      isoSubmodulesJson: nodeRuns.isoSubmodulesJson,
      isoSubmodulesReposJson: nodeRuns.isoSubmodulesReposJson,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, id))
    .limit(1)
  if (row === undefined) throw new Error(`missing checkpoint fixture ${id}`)
  return row
}

/** Malformed/legacy bytes cannot be expressed by the target-shaped fixture codec. */
export async function patchStoredCheckpointFixture(
  db: FixtureHandle,
  id: string,
  columns: Partial<TaskCheckpointColumns>,
): Promise<void> {
  const { nodeRuns } = tablesOf(db)
  await db.update(nodeRuns).set(columns).where(eq(nodeRuns.id, id))
}

/** RFC-395 II-a A3: byte assertions must not pass through the lenient consumed decoder. */
export async function readStoredConsumedInputsFixture(db: FixtureHandle, id: string) {
  const { nodeRuns } = tablesOf(db)
  const [row] = await db
    .select({ bytes: nodeRuns.consumedUpstreamRunsJson })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, id))
    .limit(1)
  if (row === undefined) throw new Error(`missing consumed-input fixture ${id}`)
  return row.bytes
}
