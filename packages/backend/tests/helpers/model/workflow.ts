// RFC-395 II-a A1: Workflow fixtures keep public projection names while storage changes in II-b.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { createFixtureAdapter, decodeFixture } from './core'
import type { WorkflowFixtureSpec } from './workflow.spec'
export type { WorkflowFixtureSpec } from './workflow.spec'
export type WorkflowFixtureRow = PersistenceTables['workflows']['$inferSelect']
const adapter = createFixtureAdapter<
  WorkflowFixtureSpec,
  PersistenceTables['workflows'],
  WorkflowFixtureRow
>({
  table: (db) => tablesOf(db).workflows,
  physicalTable: 'workflows',
  keys: ['id'],
  project: async (_db, row) => decodeFixture('workflows', row) as WorkflowFixtureRow,
})
export const workflowFixture = adapter.insert
export const patchWorkflowFixture = adapter.patch
export const readWorkflowFixtures = adapter.read
