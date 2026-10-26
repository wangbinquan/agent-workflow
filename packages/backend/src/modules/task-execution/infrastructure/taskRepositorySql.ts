import { taskMountWorktreePath } from '../domain/taskMountPath'
import { requestedSourceCachedRepoSql } from '@/platform/persistence/taskRepositorySurface'
import { engineForHandle, tablesOf } from '@/platform/persistence/sessionTables'
import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'
import {
  eq,
  getTableColumns,
  isNull,
  sql,
  type Column,
  type GetColumnData,
  type SQLWrapper,
} from 'drizzle-orm'
import type { SelectResultFields } from 'drizzle-orm/query-builders/select.types'

/** Native target rows stay split; this selection is the existing Task read contract. */
export function taskReadColumns(db: object) {
  const {
    tasks,
    taskDefinitions: definition,
    taskLaunchContexts: launch,
    taskWorkspaces: workspace,
    taskRepositoryMounts: mounts,
    workgroupTaskState: state,
  } = tablesOf(db)
  const field = <C extends Column>(column: C, table: SQLWrapper, taskId: SQLWrapper) =>
    sql<GetColumnData<C>>`(select ${column} from ${table} where ${taskId} = ${tasks.id})`.mapWith(
      column,
    )
  const definitionField = <C extends Column>(column: C) =>
    field(column, definition, definition.taskId)
  const launchField = <C extends Column>(column: C) => field(column, launch, launch.taskId)
  const workspaceField = <C extends Column>(column: C) => field(column, workspace, workspace.taskId)
  const source = sql`(select ${workspace.requestedSource} from ${workspace} where ${workspace.taskId} = ${tasks.id})`
  const sourceText = (key: string) => engineForHandle(db).jsonMemberText(source, key)
  const primary = <T>(column: SQLWrapper, fallback: SQLWrapper) => sql<T>`case
    when exists (select 1 from ${mounts} where ${mounts.taskId} = ${tasks.id} and ${mounts.ordinal} = 0)
      then (select ${column} from ${mounts} where ${mounts.taskId} = ${tasks.id} and ${mounts.ordinal} = 0)
      else ${fallback} end`
  const subjectKind = definitionField(definition.subjectKind)
  const sourceId = definitionField(definition.sourceId)
  const sourceName = definitionField(definition.sourceName)
  const taskBranch = workspaceField(workspace.taskBranch)
  return {
    ...getTableColumns(tasks),
    subjectKind,
    sourceId,
    sourceName,
    definitionOrigin: definitionField(definition.definitionOrigin),
    engineKind: definitionField(definition.engineKind),
    workflowId: sql<string>`case ${subjectKind}
      when 'workflow' then ${sourceId}
      when 'unknown' then ${sourceId}
      when 'agent' then ${TASK_DEFINITION_HOSTS.agent.id}
      when 'workgroup' then ${TASK_DEFINITION_HOSTS.workgroup.id}
      when 'digital-employee' then ${TASK_DEFINITION_HOSTS['digital-employee'].id}
      when 'code-round' then ${TASK_DEFINITION_HOSTS['code-round'].id} end`,
    workflowVersion: sql<number | null>`${definitionField(definition.sourceRevision)}`.mapWith(
      Number,
    ),
    codeRoundId: sql<
      string | null
    >`case when ${subjectKind} = 'code-round' then ${sourceId} else null end`,
    workgroupId: sql<
      string | null
    >`case when ${subjectKind} = 'workgroup' then ${sourceId} else null end`,
    sourceAgentId: sql<
      string | null
    >`case when ${subjectKind} = 'agent' then ${sourceId} else null end`,
    sourceAgentName: sql<
      string | null
    >`case when ${subjectKind} = 'agent' then ${sourceName} else null end`,
    workflowSnapshot: definitionField(definition.workflowSnapshot),
    inputs: definitionField(definition.inputs),
    maxDurationMs: definitionField(definition.maxDurationMs),
    maxTotalTokens: definitionField(definition.maxTotalTokens),
    schemaVersion: definitionField(definition.schemaVersion),
    refClosureJson: definitionField(definition.refClosureJson),
    launchOrigin: launchField(launch.launchOrigin),
    scheduledTaskId: launchField(launch.scheduledTaskId),
    webhookTriggerId: launchField(launch.webhookTriggerId),
    webhookFireId: launchField(launch.webhookFireId),
    eventSubscriptionId: launchField(launch.eventSubscriptionId),
    eventDeliveryId: launchField(launch.eventDeliveryId),
    digitalEmployeeRoundId: launchField(launch.digitalEmployeeRoundId),
    digitalEmployeeCaseId: launchField(launch.digitalEmployeeCaseId),
    parentNodeRunId: launchField(launch.parentNodeRunId),
    triggerContextJson: launchField(launch.triggerContextJson),
    platformInputPathsJson: launchField(launch.platformInputPathsJson),
    sourceTerminationBinding: launchField(launch.sourceTerminationBinding),
    sourceTerminationLaunchRev: launchField(launch.sourceTerminationLaunchRev),
    executionLineageId: launchField(launch.executionLineageId),
    lineageSlotPathJson: launchField(launch.lineageSlotPathJson),
    repoGroupId: workspaceField(workspace.repoGroupId),
    repoGroupName: workspaceField(workspace.repoGroupName),
    gitUserName: workspaceField(workspace.gitUserName),
    gitUserEmail: workspaceField(workspace.gitUserEmail),
    autoCommitPush: workspaceField(workspace.autoCommitPush),
    spaceKind: workspaceField(workspace.spaceKind),
    workingBranch: workspaceField(workspace.workingBranch),
    requestedSource: workspaceField(workspace.requestedSource),
    workgroupLaunchConfigJson: definitionField(definition.workgroupConfigJson),
    workgroupConfigJson: field(state.runtimeConfigJson, state, state.taskId),
    worktreePath: sql<string>`coalesce(${tasks.workspaceRootRef}, '')`,
    repoPath: primary<string>(mounts.repoPath, sourceText('repoPath')),
    repoUrl: primary<string | null>(mounts.repoUrl, sourceText('repoUrl')),
    cachedRepoId: primary<string | null>(mounts.cachedRepoId, sourceText('cachedRepoId')),
    baseBranch: primary<string>(
      sql`coalesce(${mounts.baseBranch}, '')`,
      engineForHandle(db).jsonPathText(source, ['requestedRef', 'value']),
    ),
    branch: primary<string>(sql`coalesce(${mounts.branch}, ${taskBranch})`, taskBranch),
    baseCommit: primary<string | null>(mounts.baseCommit, sourceText('legacyBaseCommit')),
    repoCount:
      sql<number>`(select case when count(*) = 0 then 1 else count(*) end from ${mounts} where ${mounts.taskId} = ${tasks.id})`.mapWith(
        Number,
      ),
  }
}

export type TaskReadRow = SelectResultFields<ReturnType<typeof taskReadColumns>>

/** SQL-only readers use the same projection, including full-row and aliased reads. */
export function taskReadSql(
  db: object,
  alias: string,
  projection: Readonly<Record<string, SQLWrapper>> = taskReadColumns(db),
) {
  const { tasks } = tablesOf(db)
  const fields = Object.entries(projection).map(
    ([name, field]) =>
      sql`${field} as ${sql.identifier(name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))}`,
  )
  return sql`(select ${sql.join(fields, sql`, `)} from ${tasks}) ${sql.identifier(alias)}`
}

export function taskMountReadColumns(db: object) {
  const { tasks, taskRepositoryMounts: mounts } = tablesOf(db)
  const root = sql`(select ${tasks.workspaceRootRef} from ${tasks} where ${tasks.id} = ${mounts.taskId})`
  return {
    ...getTableColumns(mounts),
    repoIndex: sql<number>`${mounts.ordinal}`.mapWith(Number),
    baseBranch: sql<string>`coalesce(${mounts.baseBranch}, '')`,
    branch: sql<string>`coalesce(${mounts.branch}, '')`,
    worktreeDirName: sql<string>`${mounts.mountPath}`,
    workspaceRootRef: sql<string | null>`${root}`,
  }
}
type TaskMountStoredReadRow = SelectResultFields<ReturnType<typeof taskMountReadColumns>>
export type TaskMountReadRow = Omit<TaskMountStoredReadRow, 'workspaceRootRef'> & {
  readonly worktreePath: string
}

export function projectTaskMountReadRow<
  Row extends { readonly workspaceRootRef: string | null; readonly mountPath: string },
>(row: Row) {
  const { workspaceRootRef, ...mount } = row
  return { ...mount, worktreePath: taskMountWorktreePath(workspaceRootRef, row.mountPath) }
}

/** Preparation consumes the frozen request, never ordinal-0 materialization. */
export function taskRequestedSourceColumns(db: object) {
  const { tasks, taskWorkspaces: workspace } = tablesOf(db)
  const source = sql`(select ${workspace.requestedSource} from ${workspace} where ${workspace.taskId} = ${tasks.id})`
  const text = (key: string) => engineForHandle(db).jsonMemberText(source, key)
  const fields = taskReadColumns(db)
  return {
    requestedSource: fields.requestedSource,
    repoUrl: sql<string | null>`${text('repoUrl')}`,
    cachedRepoId: sql<string | null>`${text('cachedRepoId')}`,
    baseBranch: sql<string>`${engineForHandle(db).jsonPathText(source, ['requestedRef', 'value'])}`,
    repoGroupId: fields.repoGroupId,
    repoGroupName: fields.repoGroupName,
    spaceKind: fields.spaceKind,
  }
}

export function taskWorkspaceUnboundSql(root: SQLWrapper) {
  return isNull(root)
}
export function taskWorkspaceRootMatchesSql(root: SQLWrapper, expected: string) {
  return expected === '' ? taskWorkspaceUnboundSql(root) : eq(root, expected)
}

export function taskRequestedSourceReferenceSql(db: object, cachedRepoId: SQLWrapper) {
  const { taskWorkspaces: workspace, taskRepositoryMounts: mounts } = tablesOf(db)
  return sql`coalesce((select true from ${workspace} where ${requestedSourceCachedRepoSql(db)} = ${cachedRepoId}
    and not exists (select 1 from ${mounts} where ${mounts.taskId} = ${workspace.taskId}) limit 1), false)`
}

/** SQL facets consume the frozen target discriminator on a task projection. */
export function taskSubjectSqlColumns(alias: string) {
  return {
    subjectKind: sql.raw(`${alias}.subject_kind`),
    workflowId: sql.raw(`${alias}.workflow_id`),
  }
}
export function taskSubjectKindSql(columns: { readonly subjectKind: SQLWrapper }) {
  return sql<string>`${columns.subjectKind}`
}
export function taskWorkflowNameSql(
  columns: { readonly subjectKind: SQLWrapper },
  liveName: SQLWrapper,
) {
  const arms = Object.entries(TASK_DEFINITION_HOSTS).map(
    ([kind, host]) => sql`WHEN ${kind} THEN ${host.name}`,
  )
  return sql<
    string | null
  >`CASE ${columns.subjectKind} WHEN 'unknown' THEN NULL ${sql.join(arms, sql` `)} ELSE ${liveName} END`
}
