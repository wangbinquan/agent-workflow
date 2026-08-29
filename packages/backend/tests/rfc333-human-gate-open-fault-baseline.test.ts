// RFC-333 — deterministic human-gate open fault witnesses.
//
// The tests use real SQLite triggers at the exact later write, as required by
// docs/dev-gotchas.md. T6 flips review-open to the target invariant; clarify
// remains the T7 debt witness until its vertical cut lands.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  joinMarkdownDocs,
  type TaskWsMessage,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents as agentsTable,
  clarifyRounds,
  collaborationGateArtifacts,
  collaborationGateOperations,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { createClarifyRound } from '../src/services/clarify/service'
import { dispatchReviewNode } from '../src/services/review'
import { resetBroadcastersForTests, TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'
import { installCommittedEventProjectionHarness } from './helpers/committedEventHarness'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const REVIEW_DOCS = ['# Alpha\n\nalpha', '# Beta\n\nbeta', '# Gamma\n\ngamma']

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected operation to fail')
}

function filesBelow(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) found.push(relative(root, absolute).replaceAll('\\', '/'))
    }
  }
  walk(root)
  return found.sort()
}

async function seedReview(
  db: DbClient,
  worktree: string,
): Promise<{
  taskId: string
  definition: WorkflowDefinition
  reviewNode: WorkflowNode
}> {
  const agentId = ulid()
  await db.insert(agentsTable).values({
    id: agentId,
    name: 'rfc333-review-source',
    description: '',
    outputs: JSON.stringify(['cases']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify({ outputKinds: { cases: 'list<markdown>' } }),
    bodyMd: '',
  })
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: [
      {
        id: 'source',
        kind: 'agent-single',
        agentId,
        agentName: 'rfc333-review-source',
        promptTemplate: '',
      } as WorkflowNode,
      {
        id: 'review',
        kind: 'review',
        inputSource: { nodeId: 'source', portName: 'cases' },
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc333-review-open-fault',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc333-review-open-fault',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: worktree,
    worktreePath: worktree,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const sourceRunId = ulid()
  await db.insert(nodeRuns).values({
    id: sourceRunId,
    taskId,
    nodeId: 'source',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 10,
    finishedAt: Date.now(),
  })
  await db.insert(nodeRunOutputs).values({
    nodeRunId: sourceRunId,
    portName: 'cases',
    content: joinMarkdownDocs(REVIEW_DOCS),
  })
  return {
    taskId,
    definition,
    reviewNode: definition.nodes.find((node) => node.id === 'review')!,
  }
}

async function seedClarify(db: DbClient): Promise<{
  taskId: string
  sourceRunId: string
}> {
  const definition: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'source', kind: 'agent-single', agentName: 'source' } as WorkflowNode,
      { id: 'clarify', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc333-clarify-open-fault',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 3,
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc333-clarify-open-fault',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/rfc333-clarify',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const sourceRunId = ulid()
  await db.insert(nodeRuns).values({
    id: sourceRunId,
    taskId,
    nodeId: 'source',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  return { taskId, sourceRunId }
}

afterEach(() => resetBroadcastersForTests())

describe('RFC-333 open fault witnesses', () => {
  test('review member 2 failure leaves only a retryable prepared operation and private staging', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc333-review-open-'))
    const appHome = join(root, 'home')
    const worktree = join(root, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    const db = createInMemoryDb(MIGRATIONS)
    const uninstallProjection = installCommittedEventProjectionHarness(db)
    const frames: TaskWsMessage[] = []
    let unsubscribe = (): void => {}
    try {
      const { taskId, definition, reviewNode } = await seedReview(db, worktree)
      unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (frame) => frames.push(frame))
      db.$client.exec(`
        CREATE TRIGGER rfc333_second_doc_down
        BEFORE INSERT ON doc_versions
        FOR EACH ROW WHEN NEW.item_index = 1
        BEGIN SELECT RAISE(ABORT, 'rfc333-second-doc'); END;
      `)

      const error = await failureOf(() =>
        dispatchReviewNode({
          db,
          taskId,
          appHome,
          scopeRoot: worktree,
          definition,
          node: reviewNode,
          iteration: 0,
        }),
      )
      expect(error.message).toContain('rfc333-second-doc')

      const docs = await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))
      const reviewRuns = await db
        .select()
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .then((rows) => rows.filter((row) => row.nodeId === 'review'))
      const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()!
      const allFiles = filesBelow(appHome)
      const canonicalFiles = allFiles.filter(
        (file) => file.startsWith('runs/') && !file.startsWith('runs/.human-gate-staging/'),
      )
      const stagedFiles = allFiles.filter((file) => file.startsWith('runs/.human-gate-staging/'))
      const operation = db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.taskId, taskId))
        .get()
      const artifacts = db
        .select()
        .from(collaborationGateArtifacts)
        .where(eq(collaborationGateArtifacts.operationId, operation!.id))
        .all()

      const observed = {
        docRows: docs.length,
        canonicalFiles: canonicalFiles.length,
        stagedFiles: stagedFiles.length,
        reviewRuns: reviewRuns.map((row) => row.status),
        taskStatus: task.status,
        wsFrames: frames.length,
        operationState: operation?.state,
        artifactStates: artifacts.map((artifact) => artifact.state),
      }
      expect(observed).toEqual({
        docRows: 0,
        canonicalFiles: 0,
        stagedFiles: 3,
        reviewRuns: [],
        taskStatus: 'running',
        wsFrames: 0,
        operationState: 'prepared',
        artifactStates: ['staged', 'staged', 'staged'],
      })

      db.$client.exec('DROP TRIGGER rfc333_second_doc_down')
      const retried = await dispatchReviewNode({
        db,
        taskId,
        appHome,
        scopeRoot: worktree,
        definition,
        node: reviewNode,
        iteration: 0,
      })
      expect(retried.kind).toBe('awaiting_review')
      expect(
        db.select().from(docVersions).where(eq(docVersions.taskId, taskId)).all(),
      ).toHaveLength(3)
      expect(
        db
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.taskId, taskId))
          .all()
          .filter((row) => row.nodeId === 'review'),
      ).toHaveLength(1)
      expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
        status: 'awaiting_review',
        lifecycleEventRevision: 2,
      })
      expect(
        db
          .select()
          .from(collaborationGateOperations)
          .where(eq(collaborationGateOperations.id, operation!.id))
          .get(),
      ).toMatchObject({ state: 'completed', resultGateRevision: 1 })
      expect(
        db
          .select()
          .from(collaborationGateArtifacts)
          .where(eq(collaborationGateArtifacts.operationId, operation!.id))
          .all()
          .map((artifact) => artifact.state),
      ).toEqual(['finalized', 'finalized', 'finalized'])
      expect(
        filesBelow(appHome).filter((file) => file.startsWith('runs/.human-gate-staging/')),
      ).toEqual([])
      expect(frames).toHaveLength(1)
    } finally {
      unsubscribe()
      uninstallProjection()
      db.$client.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('task park failure rolls the complete review projection back to prepared', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc333-review-task-park-'))
    const appHome = join(root, 'home')
    const worktree = join(root, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    const db = createInMemoryDb(MIGRATIONS)
    const uninstallProjection = installCommittedEventProjectionHarness(db)
    const frames: TaskWsMessage[] = []
    let unsubscribe = (): void => {}
    try {
      const { taskId, definition, reviewNode } = await seedReview(db, worktree)
      unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (frame) => frames.push(frame))
      db.$client.exec(`
        CREATE TRIGGER rfc333_task_park_down
        BEFORE UPDATE OF status ON tasks
        FOR EACH ROW WHEN NEW.id = '${taskId}'
        BEGIN SELECT RAISE(ABORT, 'rfc333-task-park'); END;
      `)

      const error = await failureOf(() =>
        dispatchReviewNode({
          db,
          taskId,
          appHome,
          scopeRoot: worktree,
          definition,
          node: reviewNode,
          iteration: 0,
        }),
      )
      expect(error.message).toContain('rfc333-task-park')
      expect(db.select().from(docVersions).where(eq(docVersions.taskId, taskId)).all()).toEqual([])
      expect(
        db
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.taskId, taskId))
          .all()
          .filter((row) => row.nodeId === 'review'),
      ).toEqual([])
      expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe('running')
      const operation = db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.taskId, taskId))
        .get()!
      expect(operation.state).toBe('prepared')
      expect(
        db
          .select()
          .from(collaborationGateArtifacts)
          .where(eq(collaborationGateArtifacts.operationId, operation.id))
          .all()
          .map((artifact) => artifact.state),
      ).toEqual(['staged', 'staged', 'staged'])
      expect(
        filesBelow(appHome).filter(
          (file) => file.startsWith('runs/') && !file.startsWith('runs/.human-gate-staging/'),
        ),
      ).toEqual([])
      expect(frames).toEqual([])
    } finally {
      unsubscribe()
      uninstallProjection()
      db.$client.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('clarify round failure leaves only a retryable prepared manifest, then retries atomically', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const uninstallProjection = installCommittedEventProjectionHarness(db)
    const frames: TaskWsMessage[] = []
    let unsubscribe = (): void => {}
    try {
      const { taskId, sourceRunId } = await seedClarify(db)
      unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (frame) => frames.push(frame))
      db.$client.exec(`
        CREATE TRIGGER rfc333_clarify_round_down
        BEFORE INSERT ON clarify_rounds
        BEGIN SELECT RAISE(ABORT, 'rfc333-clarify-round'); END;
      `)

      const request = {
        kind: 'self' as const,
        db,
        taskId,
        askingNodeId: 'source',
        askingNodeRunId: sourceRunId,
        askingShardKey: null,
        intermediaryNodeId: 'clarify',
        iteration: 0,
        questions: [
          {
            id: 'question-1',
            title: 'Which database?',
            kind: 'single' as const,
            recommended: false,
            options: [
              {
                label: 'SQLite',
                description: '',
                recommended: true,
                recommendationReason: 'fixture',
              },
              {
                label: 'Postgres',
                description: '',
                recommended: false,
                recommendationReason: '',
              },
            ],
          },
        ],
      }
      const error = await failureOf(() => createClarifyRound(request))
      expect(error.message).toContain('rfc333-clarify-round')

      const rounds = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
      const clarifyRuns = await db
        .select()
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .then((rows) => rows.filter((row) => row.nodeId === 'clarify'))
      const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()!
      const questions = db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.taskId, taskId))
        .all()
      const operations = db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.taskId, taskId))
        .all()

      const observed = {
        rounds: rounds.length,
        clarifyRuns: clarifyRuns.map((row) => row.status),
        questions: questions.length,
        taskStatus: task.status,
        wsFrames: frames.length,
      }
      expect(observed).toEqual({
        rounds: 0,
        clarifyRuns: [],
        questions: 0,
        taskStatus: 'running',
        wsFrames: 0,
      })
      expect(operations).toHaveLength(1)
      expect(operations[0]).toMatchObject({ state: 'prepared', gateKind: 'clarify' })

      db.$client.exec('DROP TRIGGER rfc333_clarify_round_down')
      const retried = await createClarifyRound(request)
      expect(retried.round.id).toBe(operations[0]!.id + ':round')
      expect(
        db
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.taskId, taskId))
          .all()
          .filter((row) => row.nodeId === 'clarify'),
      ).toHaveLength(1)
      expect(
        db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)).all(),
      ).toHaveLength(1)
      expect(
        db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId)).all(),
      ).toHaveLength(1)
      expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
        status: 'awaiting_human',
      })
      expect(
        db
          .select()
          .from(collaborationGateOperations)
          .where(eq(collaborationGateOperations.taskId, taskId))
          .get(),
      ).toMatchObject({ state: 'completed', resultGateRevision: 1 })
      expect(frames).toHaveLength(1)
      expect(frames[0]?.type).toBe('clarify.created')
    } finally {
      unsubscribe()
      uninstallProjection()
      db.$client.close()
    }
  })
})
