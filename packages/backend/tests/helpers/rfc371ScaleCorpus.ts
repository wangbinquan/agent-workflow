// RFC-371: explicit synthetic original-table corpus; never seed an existing Task population.
import { eq, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  tasks,
  nodeRuns,
  observationInvocations,
  observationUsageCaptures,
  observationUsageCurrent,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { UsageContributionEvidence } from '@/modules/run-observability/domain/usageSelection'
import {
  COMPLETE_NOW,
  completeFixtureId,
  completeTaskRecord,
  seedCompleteTask,
} from './rfc371CompleteTaskFixture'

export const SCALE_BUCKETS = { input: '1', cacheRead: '3', cacheWrite: '5', output: '7' } as const
export const SCALE_ACTOR_USER = {
  id: 'complete-task-reader',
  username: 'complete-task-reader',
  displayName: 'Complete reader',
  role: 'admin' as const,
  status: 'active' as const,
}
export const scaleTaskId = (n: number) =>
  n === 0 ? 'complete-original-task' : completeFixtureId('scale-task', n)
export function scalePopulation(taskCount: number, records: number) {
  if (
    !Number.isSafeInteger(taskCount) ||
    taskCount < 1 ||
    !Number.isSafeInteger(records) ||
    records < taskCount ||
    records % taskCount !== 0
  )
    throw new RangeError('Invalid exact scale population')
  return records / taskCount
}
export function scaleExpected(records: number) {
  const n = BigInt(records)
  return {
    tokens: {
      input: String(n),
      cacheRead: String(n * 3n),
      cacheWrite: String(n * 5n),
      output: String(n * 7n),
      total: String(n * 16n),
    },
    costPico: n * 50_000_000n,
  }
}
export function scaleRecord(task: number, meter: number) {
  const record = completeTaskRecord(0, 1)
  return {
    ...record,
    measurement: {
      ...record.measurement,
      taskId: scaleTaskId(task),
      invocationId: completeFixtureId('invocation', task),
      nodeRunId: completeFixtureId('run', task),
      recordId: completeFixtureId('meter', meter),
      occurredAt: COMPLETE_NOW + meter,
      observedAt: COMPLETE_NOW + meter,
    },
  }
}
export function scaleSelfTotal(n: number): UsageContributionEvidence {
  return {
    sourceId: 'synthetic-scale-original-source',
    measurement: {
      invocationId: 'synthetic-scale-single-invocation',
      recordId: completeFixtureId('self-total', n),
      model: null,
      scope: {
        root: 'synthetic-scale-root',
        session: completeFixtureId('leaf', n),
        parentSession: 'synthetic-scale-root',
        ancestors: ['synthetic-scale-root'],
        turn: 'synthetic-turn',
        turnIndex: 1,
        level: 'self-total',
      },
      coveredThroughTurn: 1,
    },
    contribution: SCALE_BUCKETS,
    complete: true,
  }
}
export async function scaleOriginalCounts(db: ProviderNeutralDatabase) {
  const [row] = await db.all<Record<string, number | string>>(sql`SELECT
    (SELECT count(*) FROM tasks) AS tasks,
    (SELECT count(*) FROM node_runs) AS attempts,
    (SELECT count(*) FROM observation_invocations) AS invocations,
    (SELECT count(*) FROM observation_usage_captures) AS captures,
    (SELECT count(*) FROM observation_usage_current) AS records`)
  if (!row) throw new Error('Original scale counts missing')
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)]))
}
export async function seedScaleCorpus(input: {
  db: ProviderNeutralDatabase
  taskCount: number
  records: number
  progress?: (phase: string, count: number) => void
}) {
  const { db, taskCount, records } = input,
    perTask = scalePopulation(taskCount, records)
  const original = await scaleOriginalCounts(db)
  if (Object.values(original).some((n) => n !== '0'))
    throw new Error('Scale corpus requires an empty original Task population')
  await seedCompleteTask({ db }, 1, 1)
  const task = await db.select().from(tasks).get(),
    run = await db.select().from(nodeRuns).get(),
    invocation = await db.select().from(observationInvocations).get(),
    capture = await db.select().from(observationUsageCaptures).get()
  if (!task || !run || !invocation || !capture) throw new Error('Original scale template missing')
  const accepted = JSON.parse(invocation.document),
    captured = JSON.parse(capture.document)
  const captureDocument = (n: number) =>
    JSON.stringify({
      ...captured,
      evidence: {
        ...captured.evidence,
        invocationId: completeFixtureId('invocation', n),
        taskId: scaleTaskId(n),
        capture: {
          ...captured.evidence.capture,
          rootSessionId: completeFixtureId('root', n),
          scannedSteps: perTask,
          observedAt: COMPLETE_NOW + perTask,
        },
      },
    })
  await db
    .update(tasks)
    .set({ finishedAt: COMPLETE_NOW + perTask + 1, runningMs: perTask + 1 })
    .where(eq(tasks.id, task.id))
    .run()
  await db
    .update(observationUsageCaptures)
    .set({ document: captureDocument(0), summary: captureDocument(0) })
    .where(eq(observationUsageCaptures.invocationId, capture.invocationId))
    .run()
  for (let start = 1; start < taskCount; start += 50) {
    const indexes = Array.from({ length: Math.min(50, taskCount - start) }, (_, i) => start + i)
    await db
      .insert(tasks)
      .values(
        indexes.map((n) => ({
          ...task,
          id: scaleTaskId(n),
          rootTaskId: scaleTaskId(n),
          name: '合成规模验收 Task ' + n,
          finishedAt: COMPLETE_NOW + perTask + 1,
          runningMs: perTask + 1,
          workflowSnapshot: JSON.stringify({
            nodes: [{ id: completeFixtureId('node', n), kind: 'agent-single' }],
          }),
        })),
      )
      .run()
    await db
      .insert(nodeRuns)
      .values(
        indexes.map((n) => ({
          ...run,
          id: completeFixtureId('run', n),
          taskId: scaleTaskId(n),
          nodeId: completeFixtureId('node', n),
        })),
      )
      .run()
    await db
      .insert(observationInvocations)
      .values(
        indexes.map((n) => {
          const document = JSON.stringify({
            ...accepted,
            invocationId: completeFixtureId('invocation', n),
            taskId: scaleTaskId(n),
            nodeRunId: completeFixtureId('run', n),
          })
          return {
            ...invocation,
            id: completeFixtureId('invocation', n),
            taskId: scaleTaskId(n),
            canonicalExecution: sha256Hex(
              JSON.stringify(['local', completeFixtureId('invocation', n)]),
            ),
            fingerprint: document,
            document,
          }
        }),
      )
      .run()
    await db
      .insert(observationUsageCaptures)
      .values(
        indexes.map((n) => ({
          ...capture,
          invocationId: completeFixtureId('invocation', n),
          taskId: scaleTaskId(n),
          sourceCursor: completeFixtureId('cursor', n),
          document: captureDocument(n),
          summary: captureDocument(n),
        })),
      )
      .run()
    if (
      start + indexes.length === taskCount ||
      Math.floor(start / 10000) !== Math.floor((start + indexes.length) / 10000)
    )
      input.progress?.('tasks', start + indexes.length)
  }
  for (let start = 1; start < records; start += 50) {
    await db
      .insert(observationUsageCurrent)
      .values(
        Array.from({ length: Math.min(50, records - start) }, (_, i) => {
          const ordinal = start + i,
            n = Math.floor(ordinal / perTask),
            meter = ordinal % perTask,
            row = scaleRecord(n, meter)
          return {
            id: sha256Hex(
              JSON.stringify([
                row.sourceId,
                row.measurement.invocationId,
                row.measurement.recordId,
              ]),
            ),
            taskId: scaleTaskId(n),
            sourceId: row.sourceId,
            document: JSON.stringify(row),
          }
        }),
      )
      .run()
    if (start + 50 >= records || Math.floor(start / 100000) !== Math.floor((start + 50) / 100000))
      input.progress?.('records', Math.min(start + 50, records))
  }
  const actual = await scaleOriginalCounts(db)
  const expected = {
    tasks: String(taskCount),
    attempts: String(taskCount),
    invocations: String(taskCount),
    captures: String(taskCount),
    records: String(records),
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Original scale population does not match the declared EOF')
  return actual
}
