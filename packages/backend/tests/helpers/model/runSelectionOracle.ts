// Frozen algorithms consume target projections; source-only facts are retained as explicit evidence.
import { and, asc, eq, not } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { assignLegacySequences } from '@/modules/task-execution/infrastructure/migration/run/sequence'
import { inlineContentColumns } from '@/platform/content/infrastructure/contentStore'
import { structurallySupersededCondition } from './frozenSelection/supersessionSql'
import { readNodeRunFixtures, patchNodeRunFixture } from './nodeRun'
import { fixtureTransaction } from './core'
import { consumedProducerIds } from './checkpoint'
import type { OracleRunRow } from '@/modules/task-execution/infrastructure/migration/oracle/rows'
export async function readRunSelectionOracleFixtures(
  db: PersistenceDb,
  taskId: string,
): Promise<readonly OracleRunRow[]> {
  return (await readNodeRunFixtures(db, { taskId })).map((row) => ({
    ...row,
    consumedUpstreamRunsJson:
      row.consumedEdges === undefined
        ? null
        : JSON.stringify(consumedProducerIds(row.consumedEdges)),
  }))
}
/** Apply the real V2 sequence decision; a live target row never receives NULL seq. */
export async function patchLegacyRunSelectionFixture(
  db: PersistenceDb,
  runId: string,
  values: { readonly seq?: null; readonly consumedUpstreamRunsJson?: string | null },
): Promise<void> {
  await fixtureTransaction(db, async (tx) => {
    const t = tablesOf(tx)
    const [run] = await tx.select().from(t.nodeRuns).where(eq(t.nodeRuns.id, runId))
    if (!run) throw new Error('fixture-node-run-missing')
    await tx
      .insert(t.executionLegacyEvidence)
      .values({
        taskId: run.taskId,
        recordKind: 'fixture-source',
        recordId: runId,
        sourceContract: 'epoch1-fixture',
        provenanceQuality: 'legacy-derived',
        missingFieldsJson: '[]',
        ...inlineContentColumns(Buffer.from(JSON.stringify(values)), 'application/json'),
      })
      .onConflictDoUpdate({
        target: [
          t.executionLegacyEvidence.recordKind,
          t.executionLegacyEvidence.recordId,
          t.executionLegacyEvidence.sourceContract,
        ],
        set: inlineContentColumns(Buffer.from(JSON.stringify(values)), 'application/json'),
      })
    if (values.seq === null) {
      const rows = await tx
        .select({ id: t.nodeRuns.id, seq: t.nodeRuns.seq })
        .from(t.nodeRuns)
        .where(eq(t.nodeRuns.taskId, run.taskId))
      let highWater = Math.max(0, ...rows.map((row) => row.seq))
      const assigned = assignLegacySequences(
        rows.map((row) => (row.id === runId ? { ...row, seq: null } : row)),
        { next: () => ++highWater },
      )
      await patchNodeRunFixture(tx, { id: runId }, { seq: assigned.seqById.get(runId)! })
    }
    if (values.consumedUpstreamRunsJson !== undefined) {
      const raw = values.consumedUpstreamRunsJson
      if (raw === null) {
        await tx.delete(t.nodeRunInputs).where(eq(t.nodeRunInputs.consumerRunId, runId))
        await tx.update(t.nodeRuns).set({ inputsRecorded: false }).where(eq(t.nodeRuns.id, runId))
      } else {
        const parsed: unknown = JSON.parse(raw)
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          Object.values(parsed).some((value) => typeof value !== 'string')
        )
          throw new Error('fixture-inputs-require-frozen-conversion')
        await patchNodeRunFixture(
          tx,
          { id: runId },
          {
            consumedEdges: Object.entries(parsed).map(([producerNodeId, producerRunId]) => ({
              producerNodeId,
              producerRunId: producerRunId as string,
            })),
          },
        )
      }
    }
  })
}
export async function readUnsupersededRunSelectionFixtureIds(
  db: PersistenceDb,
  taskId: string,
): Promise<readonly string[]> {
  const { nodeRuns } = tablesOf(db)
  return (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), not(structurallySupersededCondition(db))))
  )
    .map((row) => row.id)
    .sort()
}
export async function readRunSelectionTimelineFixtureIds(
  db: PersistenceDb,
  taskId: string,
): Promise<string[]> {
  const { nodeRuns } = tablesOf(db)
  return (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
      .orderBy(engineOf(db).ascNullsFirst(nodeRuns.startedAt), asc(nodeRuns.seq), asc(nodeRuns.id))
  ).map((row) => row.id)
}
