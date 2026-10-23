import { sql, type SQL } from 'drizzle-orm'
import { workflowCatalogPredicate } from '@/platform/persistence/workflowCatalogPredicate'
import {
  TASK_DEFINITION_HOSTS,
  TASK_SUBJECT_DISCRIMINATORS,
  type StoredTaskSubject,
} from '../domain/taskSubject'

export type TaskSubjectSqlColumns = { readonly [K in keyof Required<StoredTaskSubject>]: SQL }

/** Epoch-1 SQL adapter for the same ordered rules used by decodeTaskSubject. */
export function taskSubjectKindSql(columns: TaskSubjectSqlColumns): SQL<string> {
  const arms = TASK_SUBJECT_DISCRIMINATORS.map((rule) => {
    const column = columns[rule.field]
    const matches =
      'equals' in rule
        ? sql`${column} = ${rule.equals}`
        : sql`${column} IS NOT NULL AND ${column} <> ''`
    return sql`WHEN ${matches} THEN ${rule.kind}`
  })
  return sql<string>`CASE ${sql.join(arms, sql` `)} ELSE 'workflow' END`
}

export function taskSubjectSqlColumns(alias: string): TaskSubjectSqlColumns {
  const column = (name: string) => sql.raw(`${alias}.${name}`)
  return {
    workflowId: column('workflow_id'),
    codeRoundId: column('code_round_id'),
    workgroupId: column('workgroup_id'),
    sourceAgentName: column('source_agent_name'),
    sourceAgentId: column('source_agent_id'),
  }
}

/** Host ids are namespaces; even malformed historical subjects must not resolve a catalog host row. */
export function authoredTaskWorkflowSql(columns: TaskSubjectSqlColumns): SQL {
  return workflowCatalogPredicate(
    columns.workflowId,
    sql`${taskSubjectKindSql(columns)} = 'workflow'`,
  )
}

export function taskWorkflowNameSql(
  columns: TaskSubjectSqlColumns,
  liveName: SQL,
): SQL<string | null> {
  const arms = Object.entries(TASK_DEFINITION_HOSTS).map(
    ([kind, host]) => sql`WHEN ${kind} THEN ${host.name}`,
  )
  return sql<
    string | null
  >`CASE ${taskSubjectKindSql(columns)} ${sql.join(arms, sql` `)} ELSE ${liveName} END`
}
