// Output payloads use the production content codec, preserving the original UTF-8 bytes.
import { and, eq } from 'drizzle-orm'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  inlineContentColumns,
  databaseContentText,
} from '@/platform/content/infrastructure/contentStore'
import {
  createFixtureAdapter,
  physicalFixtureValues,
  encodeFixture,
  fixtureRows,
  fixtureTransaction,
  type FixtureHandle,
  type FixturePatch,
} from './core'
import type { NodeRunOutputFixtureSpec } from './nodeRunOutput.spec'
export type { NodeRunOutputFixtureSpec } from './nodeRunOutput.spec'
export type NodeRunOutputFixtureRow = PersistenceTables['nodeRunOutputs']['$inferSelect'] & {
  content: string
}
const adapter = createFixtureAdapter<
  NodeRunOutputFixtureSpec,
  PersistenceTables['nodeRunOutputs'],
  NodeRunOutputFixtureRow
>({
  table: (db) => tablesOf(db).nodeRunOutputs,
  physicalTable: 'node_run_outputs',
  keys: ['nodeRunId', 'portName'],
  async prepare(_db, row, spec) {
    Object.assign(row, inlineContentColumns(Buffer.from(spec.content, 'utf8'), 'text/plain'))
  },
  async afterPatch(db, row, spec) {
    if (spec.content === undefined) return
    if (typeof spec.content !== 'string') throw new Error('fixture-output-content-must-be-text')
    const table = tablesOf(db).nodeRunOutputs
    await db
      .update(table)
      .set(inlineContentColumns(Buffer.from(spec.content, 'utf8'), 'text/plain'))
      .where(and(eq(table.nodeRunId, row.nodeRunId), eq(table.portName, row.portName)))
  },
  async project(db, row) {
    return { ...row, content: await databaseContentText(db, row) }
  },
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
    const { nodeRunOutputs: table } = tablesOf(tx)
    for (const spec of fixtureRows(input)) {
      const set = {
        ...physicalFixtureValues(table, encodeFixture('node_run_outputs', patch)),
        ...(typeof patch.content === 'string'
          ? inlineContentColumns(Buffer.from(patch.content, 'utf8'), 'text/plain')
          : {}),
      }
      await tx
        .insert(table)
        .values({
          ...physicalFixtureValues(table, encodeFixture('node_run_outputs', spec)),
          nodeRunId: spec.nodeRunId,
          portName: spec.portName,
          ...inlineContentColumns(Buffer.from(spec.content, 'utf8'), 'text/plain'),
        })
        .onConflictDoUpdate({ target: [table.nodeRunId, table.portName], set })
    }
  })
}
