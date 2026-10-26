// Historical selection evidence only. Live fixtures remain in ../index.ts.
import { and, asc, eq, not } from 'drizzle-orm'
import { frozenTablesOf } from '@/platform/persistence/migration/epoch1/tables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { insertOne } from '@/platform/persistence/singleInsert'
import type { NodeRunFixtureSpec, TaskFixtureSpec, WorkflowFixtureSpec } from '../index'
import { fixtureJson, type FixtureJson } from '../core'

import { structurallySupersededCondition } from './epoch1SupersessionSql'
import type { OracleRunRow } from '@/modules/task-execution/infrastructure/migration/oracle/rows'

function optionalJson(value: FixtureJson | undefined): string | null | undefined {
  return value === undefined ? undefined : fixtureJson(value)
}

export async function workflowFixture(db: PersistenceDb, spec: WorkflowFixtureSpec) {
  const { definition, ...rest } = spec
  await insertOne(db, frozenTablesOf(db).workflows, {
    ...rest,
    definition: fixtureJson(definition)!,
  })
}
export async function taskFixture(db: PersistenceDb, spec: TaskFixtureSpec) {
  const {
    workflowSnapshot,
    inputs,
    workgroupConfigJson,
    lineageSlotPathJson,
    refClosureJson,
    triggerContextJson,
    platformInputPathsJson,
    repos,
    ...rest
  } = spec
  if (repos !== undefined && repos.length > 0)
    throw new Error('frozen selection fixture has no repository consumer')
  await insertOne(db, frozenTablesOf(db).tasks, {
    ...rest,
    name: spec.name ?? spec.id,
    lineageSlotPathJson: optionalJson(lineageSlotPathJson),
    refClosureJson: optionalJson(refClosureJson),
    triggerContextJson: optionalJson(triggerContextJson),
    platformInputPathsJson: optionalJson(platformInputPathsJson),
    workflowSnapshot: fixtureJson(workflowSnapshot)!,
    inputs: fixtureJson(inputs)!,
    ...(workgroupConfigJson === undefined
      ? {}
      : { workgroupConfigJson: fixtureJson(workgroupConfigJson) }),
  })
}
export async function nodeRunFixture(db: PersistenceDb, spec: NodeRunFixtureSpec) {
  const {
    consumedEdges,
    lineageSlotPathJson,
    runtimeParamsJson,
    inventorySnapshotJson,
    runtimeInventoryJson,
    startupVerificationJson,
    wrapperProgressJson,
    injectedMemories,
    portValidationFailures,
    commitPush,
    checkpoints,
    ...rest
  } = spec
  if (checkpoints !== undefined && checkpoints.length > 0)
    throw new Error('frozen selection fixture has no checkpoint consumer')
  await insertOne(db, frozenTablesOf(db).nodeRuns, {
    ...rest,
    lineageSlotPathJson: optionalJson(lineageSlotPathJson),
    runtimeParamsJson: optionalJson(runtimeParamsJson),
    inventorySnapshotJson: optionalJson(inventorySnapshotJson),
    runtimeInventoryJson: optionalJson(runtimeInventoryJson),
    startupVerificationJson: optionalJson(startupVerificationJson),
    wrapperProgressJson: optionalJson(wrapperProgressJson),
    injectedMemoriesJson: optionalJson(injectedMemories),
    portValidationFailuresJson: optionalJson(portValidationFailures),
    commitPushJson: optionalJson(commitPush),
    ...(consumedEdges === undefined
      ? {}
      : {
          consumedUpstreamRunsJson: JSON.stringify(
            Object.fromEntries(
              consumedEdges.map((edge) => [edge.producerNodeId, edge.producerRunId]),
            ),
          ),
        }),
  })
}
export async function patchNodeRunFixture(
  db: PersistenceDb,
  where: { id: string },
  values: Partial<Pick<OracleRunRow, 'status' | 'reviewIteration' | 'seq' | 'shardValueHash'>>,
) {
  const { nodeRuns } = frozenTablesOf(db)
  await db.update(nodeRuns).set(values).where(eq(nodeRuns.id, where.id))
}
export async function patchLegacyRunSelectionFixture(
  db: PersistenceDb,
  id: string,
  values: { seq?: null; consumedUpstreamRunsJson?: string | null },
) {
  const { nodeRuns } = frozenTablesOf(db)
  await db.update(nodeRuns).set(values).where(eq(nodeRuns.id, id))
}
export async function readNodeRunFixtures(db: PersistenceDb, where: { taskId: string }) {
  const { nodeRuns } = frozenTablesOf(db)
  return db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, where.taskId))
    .orderBy(asc(nodeRuns.id))
}
export async function readRunSelectionOracleFixtures(
  db: PersistenceDb,
  taskId: string,
): Promise<readonly OracleRunRow[]> {
  return readNodeRunFixtures(db, { taskId })
}
export async function readUnsupersededRunSelectionFixtureIds(db: PersistenceDb, taskId: string) {
  const { nodeRuns } = frozenTablesOf(db)
  return (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), not(structurallySupersededCondition(db))))
  )
    .map((row) => row.id)
    .sort()
}
export async function readRunSelectionTimelineFixtureIds(db: PersistenceDb, taskId: string) {
  const { nodeRuns } = frozenTablesOf(db)
  return (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
      .orderBy(
        engineOf(db).ascNullsFirst(nodeRuns.startedAt),
        engineOf(db).ascNullsFirst(nodeRuns.seq),
        asc(nodeRuns.id),
      )
  ).map((row) => row.id)
}
export type { NodeRunFixtureSpec } from '../index'
