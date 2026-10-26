import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq, sql, type SQL } from 'drizzle-orm'
import {
  decodeTaskWorkgroupConfig,
  decodeTaskWorkgroupLaunchConfig,
  type TaskWorkgroupConfig,
  type TaskWorkgroupLaunchConfig,
} from '../domain/taskWorkgroupConfig'
import { taskReadColumns } from './taskRepositorySql'
export function taskWorkgroupConfigFromRow(row: {
  readonly workgroupConfigJson?: string | null
  readonly workgroupLaunchConfigJson: string | null
}): TaskWorkgroupConfig {
  return {
    launch: decodeTaskWorkgroupLaunchConfig(row.workgroupLaunchConfigJson),
    runtime: decodeTaskWorkgroupConfig(row.workgroupConfigJson).runtime,
  }
}

/** Read immutable launch fields and editable runtime configuration independently. */
export function taskWorkgroupConfigSelection(db: object): SQL<TaskWorkgroupConfig | null> {
  const columns = taskReadColumns(db)
  // Frame the two raw documents by character count; preserve invalid runtime JSON
  // for the existing decoder, and keep an absent config SQL NULL on both engines.
  const launch = columns.workgroupLaunchConfigJson
  const runtime = columns.workgroupConfigJson
  return sql<string | null>`case when ${launch} is null and ${runtime} is null then null
    else cast(length(coalesce(${launch}, '')) as text) || ':' || coalesce(${launch}, '') || coalesce(${runtime}, '') end`.mapWith(
    (raw: string): TaskWorkgroupConfig => {
      const separator = raw.indexOf(':')
      const length = Number(raw.slice(0, separator))
      const characters = [...raw.slice(separator + 1)]
      return taskWorkgroupConfigFromRow({
        workgroupLaunchConfigJson: characters.slice(0, length).join('') || null,
        workgroupConfigJson: characters.slice(length).join('') || null,
      })
    },
  )
}

/** Preserve the runtime document revision used by the public CAS contract. */
export function taskWorkgroupRuntimeRevisionMatches(db: object, expectedRevision: string): SQL {
  return eq(taskReadColumns(db).workgroupConfigJson, expectedRevision)
}

export function taskWorkgroupLaunchSelection(db: object): SQL<TaskWorkgroupLaunchConfig | null> {
  const { tasks } = tablesOf(db)
  const { taskDefinitions } = tablesOf(db)
  return sql<
    string | null
  >`(select ${taskDefinitions.workgroupConfigJson} from ${taskDefinitions} where ${taskDefinitions.taskId} = ${tasks.id})`.mapWith(
    decodeTaskWorkgroupLaunchConfig,
  )
}

/** Keep the catalog's native JSON expression and its empty-name behavior exactly. */
export function taskWorkgroupNameExpression(_db: PersistenceDb, alias: string): SQL {
  return sql.raw(`${alias}.workgroup_name`)
}
