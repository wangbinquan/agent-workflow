// RFC-395 II-a: physical-row oracles retain epoch-1 bytes and defaults without target projections.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { fixturePredicate, type FixtureHandle } from './core'

export async function readStoredTaskRows(db: FixtureHandle, where?: object) {
  const { tasks } = tablesOf(db)
  return db
    .select()
    .from(tasks)
    .where(fixturePredicate(tasks, 'tasks', where))
    .orderBy(tasks.id)
}

export async function readStoredNodeRunRows(db: FixtureHandle) {
  const { nodeRuns } = tablesOf(db)
  return db.select().from(nodeRuns).orderBy(nodeRuns.id)
}
