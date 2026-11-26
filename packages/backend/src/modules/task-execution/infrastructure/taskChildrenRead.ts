import { and, desc, eq, sql } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { TaskChildrenRead } from '../application/ports/taskChildren'
import { taskVisibilityCondition } from './taskAuthorization'

export function createTaskChildrenRead(db: PersistenceDb): TaskChildrenRead {
  return {
    async page({ parentTaskId, viewer, take, after }) {
      const { tasks } = tablesOf(db)
      return await db
        .select({ id: tasks.id, status: tasks.status, startedAt: tasks.startedAt })
        .from(tasks)
        .where(
          and(
            eq(tasks.parentTaskId, parentTaskId),
            eq(tasks.catalogVisibility, 'public'),
            taskVisibilityCondition(db, viewer),
            after === null
              ? undefined
              : sql`(${tasks.startedAt}, ${tasks.id}) < (${after.startedAt}, ${after.id})`,
          ),
        )
        .orderBy(desc(tasks.startedAt), desc(tasks.id))
        .limit(take)
    },
  }
}
