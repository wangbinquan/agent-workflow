// Canonical workflow bytes and the current-revision dependency index share a transaction.
import { workflowDependencyIndexEntries } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { createFixtureAdapter, decodeFixture, type FixtureHandle } from './core'
import type { WorkflowFixtureSpec } from './workflow.spec'
export type { WorkflowFixtureSpec } from './workflow.spec'
export type WorkflowFixtureRow = PersistenceTables['workflows']['$inferSelect']
async function rebuild(db: FixtureHandle, id: string) {
  const { workflows } = tablesOf(db)
  const { workflowDependencyIndex } = tablesOf(db)
  const [row] = await db.select().from(workflows).where(eq(workflows.id, id))
  if (!row) throw new Error('fixture-workflow-missing')
  let entries: ReturnType<typeof workflowDependencyIndexEntries>
  try {
    entries = workflowDependencyIndexEntries(row.definition)
  } catch (error) {
    // Corrupt-history tests retain their source bytes and have no derivable selector index.
    if (
      !(error instanceof SyntaxError) &&
      !(error instanceof Error && error.message === 'v2-workflow-definition-shape')
    )
      throw error
    entries = []
  }
  await db.delete(workflowDependencyIndex).where(eq(workflowDependencyIndex.workflowId, id))
  if (entries.length)
    await db
      .insert(workflowDependencyIndex)
      .values(entries.map((entry) => ({ workflowId: id, revision: row.version, ...entry })))
}
const adapter = createFixtureAdapter<
  WorkflowFixtureSpec,
  PersistenceTables['workflows'],
  WorkflowFixtureRow
>({
  table: (db) => tablesOf(db).workflows,
  physicalTable: 'workflows',
  keys: ['id'],
  afterWrite: (db, row) => rebuild(db, row.id),
  async afterPatch(db, row, spec) {
    if (spec.definition !== undefined || spec.version !== undefined) await rebuild(db, row.id)
  },
  project: async (_db, row) => decodeFixture('workflows', row) as WorkflowFixtureRow,
})
export const workflowFixture = adapter.insert
export const patchWorkflowFixture = adapter.patch
export const readWorkflowFixtures = adapter.read
