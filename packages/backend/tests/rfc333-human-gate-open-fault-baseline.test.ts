// RFC-333 — deterministic human-gate open fault witnesses.
//
// Both providers install real row triggers at the same later write. The original
// rollback, retry, filesystem and committed-frame assertions share the same
// public entry points; only trigger DDL and native fixture teardown differ.

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  joinMarkdownDocs,
  type TaskWsMessage,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '../src/db/query'
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
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const REVIEW_DOCS = ['# Alpha\n\nalpha', '# Beta\n\nbeta', '# Gamma\n\ngamma']

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof Error)) throw error
    let failure = error
    while (failure.cause instanceof Error) failure = failure.cause
    return failure
  }
  throw new Error('expected operation to fail')
}

/** Fixture DDL bypasses the business SQL compiler on the selected real database. */
async function installFaultTrigger(
  harness: ProviderHarness,
  fault: {
    readonly name: string
    readonly table: string
    readonly event: string
    readonly when?: string
    readonly message: string
  },
  sqliteStatement: string,
): Promise<() => Promise<void>> {
  const native = harness.capabilities.isolation === 'exclusive'
  const functionName = `${fault.name}_fn`
  let functionInstalled = false
  let triggerInstalled = false
  const remove = async (): Promise<void> => {
    if (triggerInstalled) {
      await harness.executeFixtureDdl(
        native
          ? `DROP TRIGGER ${fault.name}`
          : `DROP TRIGGER "${fault.name}" ON "agent_workflow"."${fault.table}"`,
      )
      triggerInstalled = false
    }
    if (functionInstalled) {
      await harness.executeFixtureDdl(`DROP FUNCTION "agent_workflow"."${functionName}"()`)
      functionInstalled = false
    }
  }
  try {
    if (native) {
      await harness.executeFixtureDdl(sqliteStatement)
    } else {
      await harness.executeFixtureDdl(`
        CREATE FUNCTION "agent_workflow"."${functionName}"() RETURNS trigger
        LANGUAGE plpgsql AS $rfc333_fault$
        BEGIN
          RAISE EXCEPTION USING MESSAGE = '${fault.message}', ERRCODE = 'P0001';
        END;
        $rfc333_fault$;
      `)
      functionInstalled = true
      await harness.executeFixtureDdl(`
        CREATE TRIGGER "${fault.name}"
        BEFORE ${fault.event} ON "agent_workflow"."${fault.table}"
        FOR EACH ROW${fault.when === undefined ? '' : ` WHEN (${fault.when})`}
        EXECUTE FUNCTION "agent_workflow"."${functionName}"();
      `)
    }
    triggerInstalled = true
    return remove
  } catch (error) {
    await remove()
    throw error
  }
}

/** Close the same native handle at the original finally boundary; PG owns its runtime. */
function closeNativeFixture(harness: ProviderHarness): void {
  if (harness.capabilities.isolation !== 'exclusive') return
  const native: unknown = Reflect.get(harness.db, '$client')
  if (!(native instanceof Database)) throw new Error('expected original SQLite fixture handle')
  native.close()
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
  db: ProviderNeutralDatabase,
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
    // Preserve the original SQLite task-root trigger bytes on both providers.
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
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

async function seedClarify(db: ProviderNeutralDatabase): Promise<{
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
    // Preserve the original SQLite task-root trigger bytes on both providers.
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
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

describeEachProvider('RFC-333 open fault witnesses', (harness) => {
  test('review member 2 failure leaves only a retryable prepared operation and private staging', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc333-review-open-'))
    const appHome = join(root, 'home')
    const worktree = join(root, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    const db = harness.db
    const uninstallProjection = await installCommittedEventProjectionHarness(db)
    const frames: TaskWsMessage[] = []
    let unsubscribe = (): void => {}
    let removeFault = async (): Promise<void> => {}
    try {
      const { taskId, definition, reviewNode } = await seedReview(db, worktree)
      unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (frame) => frames.push(frame))
      removeFault = await installFaultTrigger(
        harness,
        {
          name: 'rfc333_second_doc_down',
          table: 'doc_versions',
          event: 'INSERT',
          when: 'NEW.item_index = 1',
          message: 'rfc333-second-doc',
        },
        `
        CREATE TRIGGER rfc333_second_doc_down
        BEFORE INSERT ON doc_versions
        FOR EACH ROW WHEN NEW.item_index = 1
        BEGIN SELECT RAISE(ABORT, 'rfc333-second-doc'); END;
      `,
      )

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
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)).get())!
      const allFiles = filesBelow(appHome)
      const canonicalFiles = allFiles.filter(
        (file) => file.startsWith('runs/') && !file.startsWith('runs/.human-gate-staging/'),
      )
      const stagedFiles = allFiles.filter((file) => file.startsWith('runs/.human-gate-staging/'))
      const operation = await db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.taskId, taskId))
        .get()
      const artifacts = await db
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

      await removeFault()
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
        await db.select().from(docVersions).where(eq(docVersions.taskId, taskId)).all(),
      ).toHaveLength(3)
      expect(
        (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).all()).filter(
          (row) => row.nodeId === 'review',
        ),
      ).toHaveLength(1)
      expect(await db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
        status: 'awaiting_review',
        lifecycleEventRevision: 2,
      })
      expect(
        await db
          .select()
          .from(collaborationGateOperations)
          .where(eq(collaborationGateOperations.id, operation!.id))
          .get(),
      ).toMatchObject({ state: 'completed', resultGateRevision: 1 })
      expect(
        (
          await db
            .select()
            .from(collaborationGateArtifacts)
            .where(eq(collaborationGateArtifacts.operationId, operation!.id))
            .all()
        ).map((artifact) => artifact.state),
      ).toEqual(['finalized', 'finalized', 'finalized'])
      expect(
        filesBelow(appHome).filter((file) => file.startsWith('runs/.human-gate-staging/')),
      ).toEqual([])
      expect(frames.filter((frame) => frame.type === 'review.created')).toHaveLength(1)
    } finally {
      unsubscribe()
      uninstallProjection()
      try {
        await removeFault()
      } finally {
        try {
          closeNativeFixture(harness)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
  })

  test('task park failure rolls the complete review projection back to prepared', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc333-review-task-park-'))
    const appHome = join(root, 'home')
    const worktree = join(root, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    const db = harness.db
    const uninstallProjection = await installCommittedEventProjectionHarness(db)
    const frames: TaskWsMessage[] = []
    let unsubscribe = (): void => {}
    let removeFault = async (): Promise<void> => {}
    try {
      const { taskId, definition, reviewNode } = await seedReview(db, worktree)
      unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (frame) => frames.push(frame))
      removeFault = await installFaultTrigger(
        harness,
        {
          name: 'rfc333_task_park_down',
          table: 'tasks',
          event: 'UPDATE OF status',
          when: `NEW.id = '${taskId}'`,
          message: 'rfc333-task-park',
        },
        `
        CREATE TRIGGER rfc333_task_park_down
        BEFORE UPDATE OF status ON tasks
        FOR EACH ROW WHEN NEW.id = '${taskId}'
        BEGIN SELECT RAISE(ABORT, 'rfc333-task-park'); END;
      `,
      )

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
      expect(
        await db.select().from(docVersions).where(eq(docVersions.taskId, taskId)).all(),
      ).toEqual([])
      expect(
        (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).all()).filter(
          (row) => row.nodeId === 'review',
        ),
      ).toEqual([])
      expect((await db.select().from(tasks).where(eq(tasks.id, taskId)).get())?.status).toBe(
        'running',
      )
      const operation = (await db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.taskId, taskId))
        .get())!
      expect(operation.state).toBe('prepared')
      expect(
        (
          await db
            .select()
            .from(collaborationGateArtifacts)
            .where(eq(collaborationGateArtifacts.operationId, operation.id))
            .all()
        ).map((artifact) => artifact.state),
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
      try {
        await removeFault()
      } finally {
        try {
          closeNativeFixture(harness)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
  })

  test('clarify round failure leaves only a retryable prepared manifest, then retries atomically', async () => {
    const db = harness.db
    const uninstallProjection = await installCommittedEventProjectionHarness(db)
    const frames: TaskWsMessage[] = []
    let unsubscribe = (): void => {}
    let removeFault = async (): Promise<void> => {}
    try {
      const { taskId, sourceRunId } = await seedClarify(db)
      unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (frame) => frames.push(frame))
      removeFault = await installFaultTrigger(
        harness,
        {
          name: 'rfc333_clarify_round_down',
          table: 'clarify_rounds',
          event: 'INSERT',
          message: 'rfc333-clarify-round',
        },
        `
        CREATE TRIGGER rfc333_clarify_round_down
        BEFORE INSERT ON clarify_rounds
        BEGIN SELECT RAISE(ABORT, 'rfc333-clarify-round'); END;
      `,
      )

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
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)).get())!
      const questions = await db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.taskId, taskId))
        .all()
      const operations = await db
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

      await removeFault()
      const retried = await createClarifyRound(request)
      expect(retried.round.id).toBe(operations[0]!.id + ':round')
      expect(
        (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).all()).filter(
          (row) => row.nodeId === 'clarify',
        ),
      ).toHaveLength(1)
      expect(
        await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)).all(),
      ).toHaveLength(1)
      expect(
        await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId)).all(),
      ).toHaveLength(1)
      expect(await db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
        status: 'awaiting_human',
      })
      expect(
        await db
          .select()
          .from(collaborationGateOperations)
          .where(eq(collaborationGateOperations.taskId, taskId))
          .get(),
      ).toMatchObject({ state: 'completed', resultGateRevision: 1 })
      expect(frames.filter((frame) => frame.type === 'clarify.created')).toHaveLength(1)
    } finally {
      unsubscribe()
      uninstallProjection()
      try {
        await removeFault()
      } finally {
        closeNativeFixture(harness)
      }
    }
  })
})
