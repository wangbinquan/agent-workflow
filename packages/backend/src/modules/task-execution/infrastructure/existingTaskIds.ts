import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { inArray } from 'drizzle-orm'

export async function existingTaskIds(
  db: PersistenceDb,
  taskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const found = new Set<string>()
  const ids = [...new Set(taskIds)]
  const { tasks } = tablesOf(db)
  for (let start = 0; start < ids.length; start += 500) {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.id, ids.slice(start, start + 500)))
    for (const row of rows) found.add(row.id)
  }
  return found
}
