// RFC-395 II-a A1: NodeRunOutput fixtures keep public projection names while storage changes in II-b.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  createFixtureAdapter,
  decodeFixture,
  encodeFixture,
  fixtureRows,
  fixtureTransaction,
  type FixtureHandle,
  type FixturePatch,
} from './core'
import type { NodeRunOutputFixtureSpec } from './nodeRunOutput.spec'
export type { NodeRunOutputFixtureSpec } from './nodeRunOutput.spec'
export type NodeRunOutputFixtureRow = PersistenceTables['nodeRunOutputs']['$inferSelect']
const adapter = createFixtureAdapter<
  NodeRunOutputFixtureSpec,
  PersistenceTables['nodeRunOutputs'],
  NodeRunOutputFixtureRow
>({
  table: (db) => tablesOf(db).nodeRunOutputs,
  physicalTable: 'node_run_outputs',
  keys: ['nodeRunId', 'portName'],
  project: async (_db, row) => decodeFixture('node_run_outputs', row) as NodeRunOutputFixtureRow,
})
export const nodeRunOutputFixture = adapter.insert
export const patchNodeRunOutputFixture = adapter.patch
export const readNodeRunOutputFixtures = adapter.read

export async function upsertNodeRunOutputFixture(
  db: FixtureHandle,
  input: NodeRunOutputFixtureSpec | readonly NodeRunOutputFixtureSpec[],
  patch: FixturePatch<NodeRunOutputFixtureSpec>,
): Promise<void> {
  await fixtureTransaction(db, async (tx) => {
    const { nodeRunOutputs } = tablesOf(tx)
    for (const spec of fixtureRows(input)) {
      await tx
        .insert(nodeRunOutputs)
        .values(
          encodeFixture(
            'node_run_outputs',
            spec,
          ) as PersistenceTables['nodeRunOutputs']['$inferInsert'],
        )
        .onConflictDoUpdate({
          target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
          set: encodeFixture('node_run_outputs', patch),
        })
    }
  })
}
