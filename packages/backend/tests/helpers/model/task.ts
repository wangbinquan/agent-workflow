// Stable fixture specs write the same aggregate split as production task creation.
import { eq } from 'drizzle-orm'
import {
  splitTaskCreation,
  taskMountsAtCreation,
} from '@/modules/task-execution/domain/taskCreation'
import { taskDefinitionOrigin } from '@/modules/task-execution/domain/taskSubject'
import { decodeTaskSubject } from '@/modules/task-execution/infrastructure/migration/task/subject'
import {
  taskReadColumns,
  type TaskReadRow,
} from '@/modules/task-execution/infrastructure/taskRepositorySql'
import { writeTaskWorkspaceDirectoriesInTx } from '@/modules/task-execution/infrastructure/taskWorkspaceDirectoryParticipant'
import {
  encodeRequestedSource,
  requestedSourceAtCreation,
} from '@/modules/task-execution/domain/requestedSourceCodec'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { insertOne } from '@/platform/persistence/singleInsert'
import {
  createFixtureAdapter,
  encodeFixture,
  fixtureJson,
  physicalFixtureValues,
  type FixtureHandle,
} from './core'
import {
  readTaskRepoFixtures,
  patchTaskRepoFixture,
  taskRepoFixtureMount,
  type TaskRepoFixtureRow,
} from './taskRepo'
import type { TaskFixtureSpec } from './task.spec'
export type { TaskFixtureSpec } from './task.spec'
export type TaskFixtureRow = TaskReadRow & { repos: TaskRepoFixtureRow[] }
async function split(db: FixtureHandle, spec: TaskFixtureSpec) {
  const tables = tablesOf(db)
  const { workflows } = tablesOf(db)
  const parent = spec.parentTaskId
    ? await first(
        db
          .select(taskReadColumns(db))
          .from(tables.tasks)
          .where(eq(tables.tasks.id, spec.parentTaskId)),
      )
    : undefined
  const parentRun = spec.parentNodeRunId
    ? await first(
        db.select().from(tables.nodeRuns).where(eq(tables.nodeRuns.id, spec.parentNodeRunId)),
      )
    : undefined
  const workflow = await first(
    db
      .select({ builtin: workflows.builtin })
      .from(workflows)
      .where(eq(workflows.id, spec.workflowId)),
  )
  const subject = decodeTaskSubject(spec)
  const runtimeConfigJson =
    spec.workgroupConfigJson === undefined ? null : fixtureJson(spec.workgroupConfigJson)
  let launchConfigJson = runtimeConfigJson
  if (runtimeConfigJson !== null) {
    try {
      JSON.parse(runtimeConfigJson)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // Malformed historical runtime state is distinct from a valid authored launch config.
      launchConfigJson = null
    }
  }
  const values = splitTaskCreation({
    subject,
    core: {
      id: spec.id,
      name: spec.name ?? 'task-' + spec.id.slice(-10),
      status: spec.status,
      startedAt: spec.startedAt,
      ownerUserId: spec.ownerUserId ?? null,
      catalogVisibility: spec.catalogVisibility ?? 'public',
      branchStartedAt: spec.branchStartedAt ?? spec.startedAt,
      parentTaskId: spec.parentTaskId,
      parentNodeRunId: spec.parentNodeRunId,
      invocationDepth: spec.invocationDepth,
      finishedAt: spec.finishedAt,
      errorSummary: spec.errorSummary,
      errorMessage: spec.errorMessage,
      workspacePrunedAt: spec.workspacePrunedAt,
    },
    definition: {
      definitionOrigin: taskDefinitionOrigin(subject, workflow?.builtin === true),
      workflowSnapshot: fixtureJson(spec.workflowSnapshot) ?? 'null',
      workflowVersion: spec.workflowVersion ?? null,
      inputs: fixtureJson(spec.inputs) ?? 'null',
      maxDurationMs: spec.maxDurationMs,
      maxTotalTokens: spec.maxTotalTokens,
      workgroupConfigJson: launchConfigJson,
      refClosureJson: spec.refClosureJson === undefined ? null : fixtureJson(spec.refClosureJson),
    },
    launch: parent
      ? {
          kind: 'child',
          parent,
          parentNodeRunId: spec.parentNodeRunId ?? spec.id,
          continuationSlotKey: parentRun?.continuationSlotKey ?? spec.parentNodeRunId ?? spec.id,
          parentRunLineageSlotPathJson: parentRun?.lineageSlotPathJson ?? null,
        }
      : { kind: 'root', launchOrigin: spec.launchOrigin ?? 'manual' },
    launchContext: {
      ...spec,
      triggerContextJson:
        spec.triggerContextJson === undefined ? null : fixtureJson(spec.triggerContextJson),
      platformInputPathsJson:
        spec.platformInputPathsJson === undefined ? null : fixtureJson(spec.platformInputPathsJson),
    },
    workspace: {
      ...spec,
      baseCommit: spec.baseCommit ?? null,
      spaceKind: spec.spaceKind ?? 'remote',
    },
    repos: (spec.repos ?? []).map((repo) => taskRepoFixtureMount({ ...repo, taskId: spec.id })),
    nodePaths: [],
  })
  // Explicit history facts, including NULL, are not repaired by a fixture.
  return {
    ...values,
    ...(runtimeConfigJson === null
      ? {}
      : { workgroupState: { taskId: spec.id, runtimeConfigJson, updatedAt: spec.startedAt } }),
    task: {
      ...values.task,
      ...(spec.rootTaskId === undefined ? {} : { rootTaskId: spec.rootTaskId }),
    },
    launchContext: {
      ...values.launchContext,
      parentNodeRunId: spec.parentNodeRunId ?? null,
      ...(spec.executionLineageId === undefined
        ? {}
        : { executionLineageId: spec.executionLineageId }),
      ...(spec.lineageSlotPathJson === undefined
        ? {}
        : { lineageSlotPathJson: fixtureJson(spec.lineageSlotPathJson) }),
    },
  }
}
const adapter = createFixtureAdapter<TaskFixtureSpec, PersistenceTables['tasks'], TaskFixtureRow>({
  table: (db) => tablesOf(db).tasks,
  physicalTable: 'tasks',
  keys: ['id'],
  columns: taskReadColumns,
  async prepare(db, row, spec) {
    Object.assign(row, (await split(db, spec)).task)
  },
  async afterWrite(db, row, spec) {
    const tables = tablesOf(db)
    const values = await split(db, spec)
    await insertOne(db, tables.taskDefinitions, values.definition)
    await insertOne(
      db,
      tables.taskLaunchContexts,
      physicalFixtureValues(
        tables.taskLaunchContexts,
        values.launchContext,
      ) as typeof tables.taskLaunchContexts.$inferInsert,
    )
    await insertOne(db, tables.taskWorkspaces, values.workspace)
    await insertOne(db, tables.taskExecutionGenerations, values.generation)
    if (values.mounts.length)
      await db.insert(tables.taskRepositoryMounts).values([...values.mounts])
    if (values.workgroupState) await insertOne(db, tables.workgroupTaskState, values.workgroupState)
    await writeTaskWorkspaceDirectoriesInTx(
      db,
      row.id,
      values.mounts.map((mount) => mount.mountPath ?? ''),
      [],
    )
    const extra = encodeFixture('tasks', spec)
    delete extra.workgroupConfigJson
    const definition = physicalFixtureValues(tables.taskDefinitions, extra)
    if (Object.keys(definition).length)
      await db
        .update(tables.taskDefinitions)
        .set(definition)
        .where(eq(tables.taskDefinitions.taskId, row.id))
  },
  async afterPatch(db, row, spec) {
    const tables = tablesOf(db)
    const encoded = encodeFixture('tasks', spec)
    for (const table of [
      tables.taskDefinitions,
      tables.taskLaunchContexts,
      tables.taskWorkspaces,
    ]) {
      const values = physicalFixtureValues(table, encoded)
      if (table === tables.taskDefinitions) delete values.workgroupConfigJson
      if (Object.keys(values).length)
        await db.update(table).set(values).where(eq(table.taskId, row.id))
    }
    if (spec.workflowVersion !== undefined)
      await db
        .update(tables.taskDefinitions)
        .set({ sourceRevision: spec.workflowVersion })
        .where(eq(tables.taskDefinitions.taskId, row.id))
    if (spec.worktreePath !== undefined)
      await db
        .update(tables.tasks)
        .set({ workspaceRootRef: spec.worktreePath === '' ? null : spec.worktreePath })
        .where(eq(tables.tasks.id, row.id))
    const [current] = await db
      .select(taskReadColumns(db))
      .from(tables.tasks)
      .where(eq(tables.tasks.id, row.id))
    if (!current) throw new Error('fixture-task-missing')
    if (typeof spec.worktreePath === 'string' && spec.worktreePath !== '') {
      const existing = await first(
        db
          .select({ repoKey: tables.taskRepositoryMounts.repoKey })
          .from(tables.taskRepositoryMounts)
          .where(eq(tables.taskRepositoryMounts.taskId, row.id))
          .limit(1),
      )
      if (!existing) {
        const mounts = taskMountsAtCreation(
          row.id,
          {
            ...current,
            ...spec,
            worktreePath: spec.worktreePath,
          } as Parameters<typeof taskMountsAtCreation>[1],
          [],
        )
        if (mounts.length) await db.insert(tables.taskRepositoryMounts).values(mounts)
        await writeTaskWorkspaceDirectoriesInTx(
          db,
          row.id,
          mounts.map((mount) => mount.mountPath),
          [],
        )
      }
    }
    const subjectKeys = [
      'workflowId',
      'workgroupId',
      'codeRoundId',
      'sourceAgentId',
      'sourceAgentName',
    ]
    if (subjectKeys.some((key) => key in spec)) {
      const subject = decodeTaskSubject({ ...current, ...encoded })
      await db
        .update(tables.taskDefinitions)
        .set({
          subjectKind: subject.kind,
          sourceId: subject.sourceId,
          sourceName: subject.kind === 'agent' ? subject.sourceName : null,
          definitionOrigin: taskDefinitionOrigin(subject, false),
        })
        .where(eq(tables.taskDefinitions.taskId, row.id))
    }
    const sourceKeys = ['repoPath', 'repoUrl', 'cachedRepoId', 'baseBranch', 'baseCommit']
    if (sourceKeys.some((key) => key in spec)) {
      const request = requestedSourceAtCreation({ ...current, ...encoded })
      await db
        .update(tables.taskWorkspaces)
        .set({ requestedSource: encodeRequestedSource(request) })
        .where(eq(tables.taskWorkspaces.taskId, row.id))
    }
    const mountKeys = [...sourceKeys, 'branch', 'workingBranch']
    if (mountKeys.some((key) => key in spec))
      await patchTaskRepoFixture(
        db,
        { taskId: row.id, repoIndex: 0 },
        Object.fromEntries(Object.entries(spec).filter(([key]) => mountKeys.includes(key))),
      )
    if (spec.branch !== undefined)
      await db
        .update(tables.taskWorkspaces)
        .set({ taskBranch: spec.branch })
        .where(eq(tables.taskWorkspaces.taskId, row.id))
    if (spec.workgroupConfigJson !== undefined) {
      const runtimeConfigJson = encoded.workgroupConfigJson as string | null
      await db
        .insert(tables.workgroupTaskState)
        .values({ taskId: row.id, runtimeConfigJson, updatedAt: row.startedAt })
        .onConflictDoUpdate({
          target: tables.workgroupTaskState.taskId,
          set: { runtimeConfigJson },
        })
    }
  },
  async project(db, row) {
    const { tasks } = tablesOf(db)
    const [result] = await db.select(taskReadColumns(db)).from(tasks).where(eq(tasks.id, row.id))
    if (!result) throw new Error('fixture-task-missing')
    return {
      ...result,
      repos: await readTaskRepoFixtures(
        db,
        { taskId: row.id },
        { orderBy: [{ field: 'repoIndex' }] },
      ),
    }
  },
})
export const taskFixture = adapter.insert
export const patchTaskFixture = adapter.patch
export const readTaskFixtures = adapter.read
