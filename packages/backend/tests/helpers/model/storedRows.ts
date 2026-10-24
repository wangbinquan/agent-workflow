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

/** RFC-395 II-b O2: the pre-closure query shape is the equal-createdAt oracle. */
export async function readStoredClarifyNavRows(db: FixtureHandle, taskId: string) {
  const { clarifyRounds } = tablesOf(db)
  return db
    .select({
      intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId,
      status: clarifyRounds.status,
      createdAt: clarifyRounds.createdAt,
    })
    .from(clarifyRounds)
    .where(fixturePredicate(clarifyRounds, 'clarify_rounds', { taskId }))
}

export async function readStoredClarifyRoundRows(db: FixtureHandle, taskId: string) {
  const { clarifyRounds } = tablesOf(db)
  return db
    .select()
    .from(clarifyRounds)
    .where(fixturePredicate(clarifyRounds, 'clarify_rounds', { taskId }))
}
