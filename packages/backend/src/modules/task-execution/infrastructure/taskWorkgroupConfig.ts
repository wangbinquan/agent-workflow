import { eq, sql, type SQL } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import {
  decodeTaskWorkgroupConfig,
  decodeTaskWorkgroupLaunchConfig,
  type TaskWorkgroupConfig,
  type TaskWorkgroupLaunchConfig,
} from '../domain/taskWorkgroupConfig'
export { taskWorkgroupConfigFromRow } from '@agent-workflow/shared'

/**
 * SQL NULL bypasses mapWith and projects null. Whole-row decoding instead returns the empty
 * view (null launch fields/config/raw/revision); consumers intentionally accept both at this
 * adapter boundary so missing-row and historical NULL behavior stay unchanged in II-a.
 */
export function taskWorkgroupConfigSelection(db: object): SQL<TaskWorkgroupConfig | null> {
  const { tasks } = tablesOf(db)
  return sql<string | null>`${tasks.workgroupConfigJson}`.mapWith(decodeTaskWorkgroupConfig)
}

/** The runtime revision is still an exact text comparison in epoch 1. */
export function taskWorkgroupRuntimeRevisionMatches(db: object, expectedRevision: string): SQL {
  const { tasks } = tablesOf(db)
  return eq(tasks.workgroupConfigJson, expectedRevision)
}

export function taskWorkgroupLaunchSelection(db: object): SQL<TaskWorkgroupLaunchConfig | null> {
  const { tasks } = tablesOf(db)
  return sql<string | null>`${tasks.workgroupConfigJson}`.mapWith(decodeTaskWorkgroupLaunchConfig)
}

/** Keep the catalog's native JSON expression and its empty-name behavior exactly. */
export function taskWorkgroupNameExpression(db: PersistenceDb, alias: string): SQL {
  return sql`NULLIF(${engineOf(db).jsonMemberText(
    sql.raw(`${alias}.workgroup_config_json`),
    'workgroupName',
  )}, '')`
}
