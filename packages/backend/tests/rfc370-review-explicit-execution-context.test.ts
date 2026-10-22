// RFC-370 hosted acceptance (2026-10-18) — a review gate opens under the
// driving owner's execution context on both providers.
//
// WHY THIS FILE EXISTS (regression intent): on CrewStation (PostgreSQL) every
// workflow reaching a review gate failed with "scheduler error": "ownerless
// task mutation refused durable owner". The review module ignored the explicit
// execution context the scheduler passes (`runReviewNode`, declared by the
// port) and read the ambient one through the public participants, whose lookup
// was the SQLite compatibility wrapper: it hides every context without a
// legacy SQLite connection, i.e. every PostgreSQL daemon context. The park then
// ran as an ownerless control-plane write and the task's own claimed owner
// refused it; the standalone SQLite daemon never showed it. The dispatch now
// fences with the explicit context first (explicit > ambient > ownerless, as
// `fenceTaskWrite`), and the public lookup is the provider-neutral one.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import { currentTaskExecutionContext as currentPublicTaskExecutionContext } from '@/modules/task-execution/public/participants'
import {
  canonicalJson,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import { describeEachProvider } from './helpers/eachProvider'

const APP_HOME = mkdtempSync(join(tmpdir(), 'aw-rfc370-review-context-'))
afterAll(() => rmSync(APP_HOME, { recursive: true, force: true }))

const WRITER = 'writer'
const REVIEW = 'review_gate'

function definition(): WorkflowDefinition {
  return {
    $schema_version: 6,
    inputs: [],
    nodes: [
      { id: WRITER, kind: 'agent-single', agentName: 'agent-writer' } as WorkflowNode,
      { id: REVIEW, kind: 'review', title: 'Approve' } as unknown as WorkflowNode,
    ],
    edges: [
      {
        id: 'writer_to_review',
        source: { nodeId: WRITER, portName: 'answer' },
        target: { nodeId: REVIEW, portName: '__review_input__' },
      },
    ],
  } as unknown as WorkflowDefinition
}

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

function launch(taskId: string): CanonicalContinuationRequest {
  return {
    taskId,
    kind: 'launch',
    source: 'rest',
    actorUserId: 'actor-1',
    expectedTaskRevision: 1,
    scope: {
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPath: rootPath(taskId),
      operationGeneration: 0,
    },
    payload: { v: 1 },
  }
}

/** A running task whose durable owner is claimed, with the writer's answer done. */
async function seedClaimedReviewTask(db: PersistenceDb) {
  const taskId = `t370rv_${ulid()}`
  const snapshot = JSON.stringify(definition())
  const { workflows, tasks, nodeRuns, nodeRunOutputs } = tablesOf(db)
  await insertOne(db, workflows, {
    id: `wf_${taskId}`,
    name: 'rfc370-review-context',
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 6,
  })
  await insertOne(db, tasks, {
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now() - 1_000,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(rootPath(taskId)),
  })
  const writerRun = ulid()
  await insertOne(db, nodeRuns, {
    id: writerRun,
    taskId,
    nodeId: WRITER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  await insertOne(db, nodeRunOutputs, {
    nodeRunId: writerRun,
    portName: 'answer',
    content: 'The report uses **red**.',
    kind: 'markdown',
  })
  const persistence = createTaskExecutionPersistence(db)
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `gen-${ulid()}`,
    persistence,
  })
  const intentId = `intent_${ulid()}`
  await persistence.intents.submit({ request: launch(taskId), intentId })
  const claimed = await module.claimPersisted({ intentId })
  module.claimGate.leave(claimed.permit)
  const context = createTaskExecutionContext({ intentId, token: claimed.token, persistence })
  return { taskId, context }
}

function request(taskId: string) {
  return {
    taskId,
    appHome: APP_HOME,
    definition: definition(),
    node: definition().nodes.find((node) => node.id === REVIEW)!,
    iteration: 0,
    scopeRoot: APP_HOME,
  }
}

describeEachProvider(
  'RFC-370 a review gate opens under the explicit execution context',
  (harness) => {
    test('the owner context passed by the scheduler parks the gate without an ambient context', async () => {
      const seeded = await seedClaimedReviewTask(harness.db)
      const mechanics = createCollaborationRuntimeMechanics(harness.db)
      await expect(
        mechanics.dispatchReviewNode({
          ...request(seeded.taskId),
          executionContext: seeded.context,
        }),
      ).resolves.toMatchObject({ kind: 'awaiting_review', message: 'awaiting_review' })
      const { tasks, nodeRuns, docVersions } = tablesOf(harness.db)
      const task = await harness.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, seeded.taskId))
      expect(task[0]?.status).toBe('awaiting_review')
      const review = await harness.db
        .select({ status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.nodeId, REVIEW))
      expect(review.filter((row) => row.status === 'awaiting_review')).toHaveLength(1)
      const documents = await harness.db
        .select({ decision: docVersions.decision })
        .from(docVersions)
        .where(eq(docVersions.taskId, seeded.taskId))
      expect(documents).toEqual([{ decision: 'pending' }])
    })

    // A PostgreSQL daemon context carries no SQLite legacy connection; the
    // public ambient lookup hid exactly such contexts.
    test('the ambient provider context of the drive alone still parks the gate', async () => {
      const seeded = await seedClaimedReviewTask(harness.db)
      expect(seeded.context.legacyConnection).toBeUndefined()
      const mechanics = createCollaborationRuntimeMechanics(harness.db)
      await expect(
        runWithTaskExecutionContext(seeded.context, () =>
          mechanics.dispatchReviewNode(request(seeded.taskId)),
        ),
      ).resolves.toMatchObject({ kind: 'awaiting_review' })
      const { tasks } = tablesOf(harness.db)
      const task = await harness.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, seeded.taskId))
      expect(task[0]?.status).toBe('awaiting_review')
    })

    test('the public ambient lookup returns a provider context', async () => {
      const seeded = await seedClaimedReviewTask(harness.db)
      expect(
        runWithTaskExecutionContext(seeded.context, () =>
          currentPublicTaskExecutionContext(seeded.taskId),
        ),
      ).toBe(seeded.context)
      expect(currentPublicTaskExecutionContext(seeded.taskId)).toBeUndefined()
    })

    test('without any context the claimed owner still refuses the ownerless write', async () => {
      const seeded = await seedClaimedReviewTask(harness.db)
      const mechanics = createCollaborationRuntimeMechanics(harness.db)
      await expect(mechanics.dispatchReviewNode(request(seeded.taskId))).rejects.toThrow(
        'ownerless task mutation refused durable owner',
      )
      const { tasks } = tablesOf(harness.db)
      const task = await harness.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, seeded.taskId))
      expect(task[0]?.status).toBe('running')
    })
  },
)
