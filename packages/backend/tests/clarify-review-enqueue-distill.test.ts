import { nodeRunFixture, readTaskFixtures, taskFixture, workflowFixture } from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-041 — verify that completing a clarify session and submitting a
// review decision both enqueue a `memory_distill_jobs` row (best-effort,
// must not break the original decision path).

import { describeEachProvider } from './helpers/eachProvider'
import { createSqliteMemoryDistillEnqueuer } from './helpers/memoryDistill'
import { beforeEach, describe, expect, test } from 'bun:test'
import { insertClarifyRoundRaw } from './clarify-fixtures'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { autoDispatchClarifyRound } from '@/modules/collaboration/infrastructure/clarify/autoDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

async function seedFixture(db: PersistenceDb): Promise<{
  taskId: string
  workflowId: string
  intermediaryNodeRunId: string
  askingNodeRunId: string
  clarifySessionId: string
}> {
  const wfId = ulid()
  await workflowFixture(db, {
    id: wfId,
    name: 'wf',
    definition: JSON.stringify({
      schemaVersion: 1,
      name: 'wf',
      nodes: [
        { id: 'agent-1', kind: 'agent-single', agentName: 'codegen' },
        { id: 'clarify-1', kind: 'clarify' },
      ],
      edges: [],
    }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const taskId = ulid()
  // RFC-359: preserve migration 0210's original SQLite root fields and JSON key order.
  // continuationSlotKey hashes this raw string.
  const lineageSlotPathJson = JSON.stringify([
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
  ])
  await taskFixture(db, {
    id: taskId,
    executionLineageId: taskId,
    lineageSlotPathJson,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify({
      schemaVersion: 1,
      nodes: [
        { id: 'agent-1', kind: 'agent-single', agentName: 'codegen' },
        { id: 'clarify-1', kind: 'clarify' },
      ],
    }),
    repoPath: '/tmp/wt',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    baseCommit: null,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
  // Both providers start from the original SQLite-materialized row.
  expect(
    (
      await readTaskFixtures(db, { id: taskId }).then((rows) =>
        rows.map((row) => ({
          executionLineageId: row.executionLineageId,
          lineageSlotPathJson: row.lineageSlotPathJson,
        })),
      )
    )[0],
  ).toEqual({ executionLineageId: taskId, lineageSlotPathJson })
  const sourceRunId = ulid()
  await nodeRunFixture(db, {
    id: sourceRunId,
    taskId,
    nodeId: 'agent-1',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'awaiting_human',
  })
  const clarifyRunId = ulid()
  const sessionId = ulid()
  // RFC-217 T8：clarify_rounds 唯一数据源（原双写镜像退役为单播）。
  await insertClarifyRoundRaw(db, {
    id: sessionId,
    taskId,
    kind: 'self',
    askingNodeId: 'agent-1',
    askingNodeRunId: sourceRunId,
    intermediaryNodeId: 'clarify-1',
    intermediaryNodeRunId: clarifyRunId,
    targetConsumerNodeId: null,
    iteration: 0,
    loopIter: 0,
    questions: JSON.stringify([{ id: 'q1', title: 'what?', kind: 'open' }]),
    status: 'awaiting_human',
  })
  return {
    taskId,
    workflowId: wfId,
    intermediaryNodeRunId: clarifyRunId,
    askingNodeRunId: sourceRunId,
    clarifySessionId: sessionId,
  }
}

describeEachProvider(
  'autoDispatchClarifyRound enqueues a distill job (RFC-132 缺口① 回归锁)',
  (harness) => {
    let db: PersistenceDb
    beforeEach(() => {
      db = harness.db
      resetBroadcastersForTests()
    })

    test('after a successful finalize, exactly one feedback-source-job row exists with the matching debounce key', async () => {
      const fx = await seedFixture(db)
      await autoDispatchClarifyRound({
        db,
        memoryDistillEnqueuer: createSqliteMemoryDistillEnqueuer(db),
        originNodeRunId: fx.intermediaryNodeRunId,
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [],
            selectedOptionLabels: [],
            customText: 'an answer',
          },
        ],
        actor: { userId: 'u1', role: 'owner' },
      }).catch(() => {
        /* a post-seal dispatch conflict must not hide the enqueue assertion below */
      })
      const { memoryDistillJobs } = tablesOf(db)
      const jobs = await db.select().from(memoryDistillJobs)
      expect(jobs.length).toBe(1)
      expect(jobs[0]!.sourceKind).toBe('clarify')
      expect(jobs[0]!.sourceEventId).toBe(fx.clarifySessionId)
      expect(jobs[0]!.debounceKey).toBe(`${fx.taskId}:clarify`)
      expect(jobs[0]!.taskId).toBe(fx.taskId)
    })

    test('clarify session row reflects the answered status (independent of the enqueue side-effect)', async () => {
      const fx = await seedFixture(db)
      await autoDispatchClarifyRound({
        db,
        memoryDistillEnqueuer: createSqliteMemoryDistillEnqueuer(db),
        originNodeRunId: fx.intermediaryNodeRunId,
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [],
            selectedOptionLabels: [],
            customText: 'an answer',
          },
        ],
        actor: { userId: 'u1', role: 'owner' },
      }).catch(() => {
        /* seal commits before any post-seal dispatch conflict — the row assertions stand */
      })
      const { clarifyRounds } = tablesOf(db)
      const row = (
        await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, fx.clarifySessionId))
      )[0]!
      expect(row.status).toBe('answered')
      expect(row.answeredAt).not.toBeNull()
    })
  },
)

describe('source-code grep guard — review distill is a durable committed-event consumer', () => {
  // RFC-341 moves distill out of the request owner. review.ts commits the
  // immutable decision event; the durable consumer owns the only production
  // enqueue call so a crash after commit cannot lose the side effect.
  test('review.ts never enqueues inline and the committed-event consumer owns the call', async () => {
    const fs = await import('node:fs')
    const review = fs.readFileSync(
      resolve(import.meta.dir, '../src/modules/collaboration/infrastructure/review.ts'),
      'utf8',
    )
    const consumer = fs.readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'collaboration',
        'application',
        'collaborationCommittedEventConsumers.ts',
      ),
      'utf8',
    )
    const bootstrap = readDaemonGraphSource()
    expect(review).not.toContain('enqueueDistillJob(')
    expect(consumer.match(/await input\.enqueueReviewDistill\(/g) ?? []).toHaveLength(1)
    expect(
      bootstrap.match(/\.\.\.createCollaborationDurableConsumerDefinitions\(\{/g) ?? [],
    ).toHaveLength(1)
    expect(bootstrap).toContain('async enqueueReviewDistill(request) {')
  })
})
