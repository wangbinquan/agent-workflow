import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'
import { composeCollaborationTaskRolePolicy } from '@/modules/resource-catalog/composition'
import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { o2Ports } from './helpers/o2Closure'
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
import {
  nodeRunFixture,
  nodeRunOutputFixture,
  readNodeRunFixtures,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
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
  await workflowFixture(db, {
    id: `wf_${taskId}`,
    name: 'rfc370-review-context',
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 6,
  })
  await taskFixture(db, {
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
  await nodeRunFixture(db, {
    id: writerRun,
    taskId,
    nodeId: WRITER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  await nodeRunOutputFixture(db, {
    nodeRunId: writerRun,
    portName: 'answer',
    content: 'The report uses **red**.',
    kind: 'markdown',
  })
  const persistence = createTaskExecutionPersistence(db, {
    humanGateOpen: composeHumanGateOpenParticipantFactory(),
    historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
    recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
  })
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
      const mechanics = createCollaborationRuntimeMechanics(harness.db, {
        taskExecutionParticipants,
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(harness.db),
        taskLock: o2Ports(harness.db).taskLock,
        ...{ upstreamAgents: o2Ports(harness.db).upstreamAgents },
      })
      await expect(
        mechanics.dispatchReviewNode({
          ...request(seeded.taskId),
          executionContext: seeded.context,
        }),
      ).resolves.toMatchObject({ kind: 'awaiting_review', message: 'awaiting_review' })
      const { docVersions } = tablesOf(harness.db)
      const task = await readTaskFixtures(harness.db, { id: seeded.taskId }).then((rows) =>
        rows.map((row) => ({ status: row.status })),
      )
      expect(task[0]?.status).toBe('awaiting_review')
      const review = await readNodeRunFixtures(harness.db, { nodeId: REVIEW }).then((rows) =>
        rows.map((row) => ({ status: row.status })),
      )
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
      const mechanics = createCollaborationRuntimeMechanics(harness.db, {
        taskExecutionParticipants,
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(harness.db),
        taskLock: o2Ports(harness.db).taskLock,
        ...{ upstreamAgents: o2Ports(harness.db).upstreamAgents },
      })
      await expect(
        runWithTaskExecutionContext(seeded.context, () =>
          mechanics.dispatchReviewNode(request(seeded.taskId)),
        ),
      ).resolves.toMatchObject({ kind: 'awaiting_review' })
      const task = await readTaskFixtures(harness.db, { id: seeded.taskId }).then((rows) =>
        rows.map((row) => ({ status: row.status })),
      )
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
      const mechanics = createCollaborationRuntimeMechanics(harness.db, {
        taskExecutionParticipants,
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(harness.db),
        taskLock: o2Ports(harness.db).taskLock,
        ...{ upstreamAgents: o2Ports(harness.db).upstreamAgents },
      })
      await expect(mechanics.dispatchReviewNode(request(seeded.taskId))).rejects.toThrow(
        'ownerless task mutation refused durable owner',
      )
      const task = await readTaskFixtures(harness.db, { id: seeded.taskId }).then((rows) =>
        rows.map((row) => ({ status: row.status })),
      )
      expect(task[0]?.status).toBe('running')
    })
  },
)
