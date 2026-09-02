import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  clarifyRounds,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  taskNodeClarifyDirectives,
  tasks,
  workflows,
} from '@/db/schema'
import {
  composePostgresqlWorkgroupTaskRoomClarifyParticipantFactory,
  composeSqliteWorkgroupTaskRoomClarifyParticipantFactory,
  createPostgresqlClarifyRepairParticipant,
  createPostgresqlCollaborationRuntimeMechanics,
  createPostgresqlReviewRepairParticipant,
  createSqliteClarifyRepairParticipant,
  createSqliteReviewRepairParticipant,
} from '@/modules/collaboration/composition'
import { createSqliteCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/sqliteCollaborationRuntimeMechanics'
import type { PostgresqlWorkgroupTaskRoomClarifyParticipantFactory as TaskExecutionClarifyParticipantFactory } from '@/modules/task-execution/composition/workgroupTaskRoomTask'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { insertClarifyRoundRaw } from './clarify-fixtures'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = (path: string): string =>
  readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8')

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(
    Promise.resolve(values.map(() => ({})) as readonly Record<string, unknown>[]),
    {
      async values() {
        return values
      },
    },
  )
}

function postgresqlFixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
    // RFC-349: the one-shot live-write marker and the per-transaction
    // generation fence are infrastructure, not part of the adapter contract
    // each case queues responses for. Answer them without consuming the queue.
    if (query.includes('database_generations')) return rows([['rfc349_collaboration_runtime']])
    return rows(responses.shift() ?? [])
  }
  const connection: PostgresqlReservedConnection = { unsafe: run, release() {} }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: run,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'rfc349_collaboration_runtime',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 collaboration runtime mechanics', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  async function seedTask(config: unknown): Promise<string> {
    const taskId = ulid()
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: `rfc349-collaboration-${taskId}`,
      definition: '{}',
      builtin: true,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'rfc349 collaboration runtime',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read-wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now(),
      workgroupId: 'wg-rfc349',
      workgroupConfigJson: JSON.stringify(config),
    })
    return taskId
  }

  test('SQLite composition owns live suppression and closes orphaned clarify rounds', async () => {
    const taskId = await seedTask({ members: [{ memberType: 'agent' }] })
    const runtime = createSqliteCollaborationRuntimeMechanics(db)

    await expect(runtime.isTaskClarifySuppressed({ taskId })).resolves.toBe(true)
    await db
      .update(tasks)
      .set({
        workgroupConfigJson: JSON.stringify({
          members: [{ memberType: 'agent' }, { memberType: 'human' }],
          clarifyBudget: 2,
        }),
      })
      .where(eq(tasks.id, taskId))
    await expect(
      runtime.isTaskClarifySuppressed({ taskId, nodeId: '__wg_leader__', shardKey: null }),
    ).resolves.toBe(false)

    const runId = ulid()
    const roundId = ulid()
    await insertClarifyRoundRaw(db, {
      id: roundId,
      taskId,
      kind: 'self',
      askingNodeId: '__wg_leader__',
      askingNodeRunId: runId,
      askingShardKey: null,
      intermediaryNodeId: '__wg_clarify__',
      intermediaryNodeRunId: runId,
      loopIter: 0,
      iteration: 0,
      questionsJson: '[]',
      status: 'awaiting_human',
      createdAt: Date.now(),
    })

    await expect(
      runtime.dismissOpenClarifyParksForAutonomous({ taskId, mode: 'leader_worker' }),
    ).resolves.toEqual({
      dismissedSessions: 1,
      canceledParkRuns: [],
      requeuedAssignments: [],
    })
    const round = db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)).get()
    expect(round?.status).toBe('canceled')
  })

  test('reopens a closed clarify round only through an exact selected-provider CAS', async () => {
    const taskId = await seedTask({ members: [{ memberType: 'agent' }] })
    const roundId = ulid()
    const runId = ulid()
    await insertClarifyRoundRaw(db, {
      id: roundId,
      taskId,
      kind: 'self',
      askingNodeId: '__wg_leader__',
      askingNodeRunId: runId,
      askingShardKey: null,
      intermediaryNodeId: '__wg_clarify__',
      intermediaryNodeRunId: runId,
      loopIter: 0,
      iteration: 0,
      questionsJson: '[]',
      answersJson: '[]',
      status: 'answered',
      createdAt: 1,
      answeredAt: 2,
    })

    const sqlite = createSqliteClarifyRepairParticipant(db)
    await expect(sqlite.hasOpenForNodeRun({ taskId, nodeRunId: runId })).resolves.toBe(false)
    await expect(sqlite.latestClosedForNodeRun({ taskId, nodeRunId: runId })).resolves.toEqual({
      roundId,
      status: 'answered',
    })
    await expect(
      sqlite.reopen({
        taskId,
        roundId,
        expectedStatus: 'canceled',
        occurredAt: 3,
      }),
    ).resolves.toBe(false)
    await expect(
      sqlite.reopen({
        taskId,
        roundId,
        expectedStatus: 'answered',
        occurredAt: 3,
      }),
    ).resolves.toBe(true)
    expect(
      db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)).get(),
    ).toMatchObject({
      status: 'awaiting_human',
      answersJson: null,
      answeredAt: null,
    })

    selectDatabaseSchemaProvider('postgresql')
    const postgresql = postgresqlFixture([
      [['round-open']],
      [['round-pg', 'answered']],
      [],
      [['rfc349_collaboration_runtime']],
      [['round-pg']],
      [],
    ])
    const repair = createPostgresqlClarifyRepairParticipant(postgresql.db)
    await expect(
      repair.hasOpenForNodeRun({ taskId: 'task-pg', nodeRunId: 'run-pg' }),
    ).resolves.toBe(true)
    await expect(
      repair.latestClosedForNodeRun({ taskId: 'task-pg', nodeRunId: 'run-pg' }),
    ).resolves.toEqual({ roundId: 'round-pg', status: 'answered' })
    await expect(
      repair.reopen({
        taskId: 'task-pg',
        roundId: 'round-pg',
        expectedStatus: 'answered',
        occurredAt: 4,
      }),
    ).resolves.toBe(true)
    expect(postgresql.executions.map((entry) => entry.sql)).toEqual([
      expect.stringContaining('select'),
      expect.stringContaining('select'),
      'begin',
      expect.stringContaining('WITH marked AS (UPDATE "agent_workflow_meta"'),
      expect.stringContaining('SELECT generation_id FROM "agent_workflow_meta"'),
      expect.stringContaining('update "agent_workflow"."clarify_rounds"'),
      'commit',
    ])
    expect(postgresql.executions[5]?.sql).toContain('returning')
  })

  test('owns review repair inspection, approval outputs, and document unapproval', async () => {
    const taskId = await seedTask({ members: [{ memberType: 'agent' }] })
    const nodeRunId = ulid()
    const docVersionId = ulid()
    await db.insert(nodeRuns).values({
      id: nodeRunId,
      taskId,
      nodeId: 'review',
      status: 'awaiting_review',
    })
    await db.insert(docVersions).values({
      id: docVersionId,
      taskId,
      reviewNodeId: 'review',
      reviewNodeRunId: nodeRunId,
      sourceNodeId: 'writer',
      sourcePortName: 'document',
      versionIndex: 3,
      reviewIteration: 2,
      bodyPath: `runs/${taskId}/review/review/document/v3.md`,
      sourceFilePath: 'docs/result.md',
      decision: 'approved',
    })

    const sqlite = createSqliteReviewRepairParticipant(db)
    const identity = { taskId, docVersionId, nodeRunId }
    await expect(sqlite.inspect(identity)).resolves.toEqual({
      decision: 'approved',
      versionIndex: 3,
      reviewIteration: 2,
      sourceFilePath: 'docs/result.md',
      hasApprovedDocOutput: false,
      hasApprovalMetaOutput: false,
    })
    await expect(sqlite.completeApproved({ ...identity, occurredAt: 9 })).resolves.toBe(true)
    await expect(sqlite.inspect(identity)).resolves.toMatchObject({
      hasApprovedDocOutput: true,
      hasApprovalMetaOutput: true,
    })
    const outputs = db
      .select({ portName: nodeRunOutputs.portName, content: nodeRunOutputs.content })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
      .all()
    expect(Object.fromEntries(outputs.map(({ portName, content }) => [portName, content]))).toEqual(
      {
        approved_doc: 'docs/result.md',
        approval_meta: JSON.stringify({
          decision: 'approved',
          decidedAt: 9,
          decidedBy: 'rfc057-repair',
          reviewIteration: 2,
          versionIndex: 3,
        }),
      },
    )
    await expect(sqlite.unapprove(identity)).resolves.toBe(true)
    await expect(sqlite.unapprove(identity)).resolves.toBe(false)
    expect(
      db
        .select({ decision: docVersions.decision })
        .from(docVersions)
        .where(eq(docVersions.id, docVersionId))
        .get(),
    ).toEqual({ decision: 'pending' })

    selectDatabaseSchemaProvider('postgresql')
    const postgresql = postgresqlFixture([
      [['approved', 3, 2, 'docs/result.md']],
      [['approved_doc'], ['approval_meta']],
    ])
    await expect(
      createPostgresqlReviewRepairParticipant(postgresql.db).inspect({
        taskId: 'task-pg',
        docVersionId: 'doc-pg',
        nodeRunId: 'review-run-pg',
      }),
    ).resolves.toEqual({
      decision: 'approved',
      versionIndex: 3,
      reviewIteration: 2,
      sourceFilePath: 'docs/result.md',
      hasApprovedDocOutput: true,
      hasApprovalMetaOutput: true,
    })
    expect(postgresql.executions).toHaveLength(2)

    const postgresqlComplete = postgresqlFixture([
      [],
      [['approved', 3, 2, 'docs/result.md']],
      [],
      [['rfc349_collaboration_runtime']],
      [],
      [['rfc349_collaboration_runtime']],
      [],
      [],
    ])
    await expect(
      createPostgresqlReviewRepairParticipant(postgresqlComplete.db).completeApproved({
        taskId: 'task-pg',
        docVersionId: 'doc-pg',
        nodeRunId: 'review-run-pg',
        occurredAt: 9,
      }),
    ).resolves.toBe(true)
    expect(postgresqlComplete.executions.map(({ sql }) => sql)).toEqual([
      'begin',
      expect.stringContaining('select'),
      expect.stringContaining('select'),
      // One process-wide live-write marker, then a generation fence per write.
      expect.stringContaining('WITH marked AS (UPDATE "agent_workflow_meta"'),
      expect.stringContaining('SELECT generation_id FROM "agent_workflow_meta"'),
      expect.stringContaining('insert into "agent_workflow"."node_run_outputs"'),
      expect.stringContaining('SELECT generation_id FROM "agent_workflow_meta"'),
      expect.stringContaining('insert into "agent_workflow"."node_run_outputs"'),
      'commit',
    ])

    const postgresqlUnapprove = postgresqlFixture([
      [],
      [['rfc349_collaboration_runtime']],
      [['doc-pg']],
      [],
    ])
    await expect(
      createPostgresqlReviewRepairParticipant(postgresqlUnapprove.db).unapprove({
        taskId: 'task-pg',
        docVersionId: 'doc-pg',
        nodeRunId: 'review-run-pg',
      }),
    ).resolves.toBe(true)
    expect(postgresqlUnapprove.executions.map(({ sql }) => sql)).toEqual([
      // The one-shot marker commits on its own reserved session, ahead of the
      // transaction it belongs to.
      expect.stringContaining('WITH marked AS (UPDATE "agent_workflow_meta"'),
      'BEGIN',
      expect.stringContaining('SELECT generation_id FROM "agent_workflow_meta"'),
      expect.stringContaining('update "agent_workflow"."doc_versions"'),
      'COMMIT',
    ])
  })

  test('provider factories remain inside collaboration and expose no SQLite fallback', () => {
    const reservedTransactionFactory: TaskExecutionClarifyParticipantFactory =
      composePostgresqlWorkgroupTaskRoomClarifyParticipantFactory()
    const contract = SRC('modules/collaboration/application/ports/collaborationRuntimeMechanics.ts')
    const sqlite = SRC(
      'modules/collaboration/infrastructure/sqliteCollaborationRuntimeMechanics.ts',
    )
    const postgres = SRC(
      'modules/collaboration/infrastructure/postgresqlCollaborationRuntimeMechanics.ts',
    )
    const projection = SRC(
      'modules/collaboration/infrastructure/postgresqlCollaborationCommittedEventProjection.ts',
    )

    expect(contract).not.toContain('DbClient')
    expect(contract).not.toContain('PostgresqlDatabaseClient')
    expect(sqlite).not.toContain('@/modules/resource-catalog/')
    expect(postgres).not.toContain('@/modules/task-execution/application/')
    expect(postgres).not.toContain('createSqliteCollaborationRuntimeMechanics')
    expect(postgres).not.toContain('as unknown as DbClient')
    expect(postgres).toContain('prepareReviewGateOpen')
    expect(postgres).toContain('prepareClarifyGateOpen')
    expect(postgres).toContain('withPostgresqlSerializableTaskExecution')
    expect(postgres).toContain('createPostgresqlNodeRunMintParticipantInTx')
    expect(postgres).toContain('nodeRunLifecycle.inTransaction')
    expect(projection).not.toContain('DbClient')
    expect(projection).not.toContain('createSqlite')
    expect(typeof reservedTransactionFactory.inTransaction).toBe('function')
  })

  test('reserved transaction participant projects per-asker stops and CAS-cancels open self clarifies', async () => {
    const taskId = await seedTask({ members: [{ memberType: 'agent' }] })
    await insertClarifyRoundRaw(db, {
      id: 'round-open-a',
      taskId,
      kind: 'self',
      askingNodeId: '__wg_member__',
      askingNodeRunId: 'asking-run-a',
      askingShardKey: 'asg:a',
      intermediaryNodeId: '__wg_clarify__',
      intermediaryNodeRunId: 'park-run-a',
      questionsJson: '[]',
      status: 'awaiting_human',
    })
    await insertClarifyRoundRaw(db, {
      id: 'round-open-b',
      taskId,
      kind: 'self',
      askingNodeId: '__wg_member__',
      askingNodeRunId: 'asking-run-b',
      askingShardKey: 'batch:a,b',
      intermediaryNodeId: '__wg_clarify__',
      intermediaryNodeRunId: 'park-run-b',
      questionsJson: '[]',
      status: 'awaiting_human',
    })
    await insertClarifyRoundRaw(db, {
      id: 'round-answered',
      taskId,
      kind: 'self',
      askingNodeId: '__wg_member__',
      askingNodeRunId: 'asking-run-old',
      askingShardKey: 'asg:old',
      intermediaryNodeId: '__wg_clarify__',
      intermediaryNodeRunId: 'park-run-old',
      questionsJson: '[]',
      answersJson: '[]',
      status: 'answered',
    })
    await db.insert(taskNodeClarifyDirectives).values([
      {
        taskId,
        nodeId: '__wg_member__',
        shardKey: 'asg:a',
        directive: 'stop',
        updatedAt: 1,
      },
      {
        taskId,
        nodeId: '__wg_member__',
        shardKey: 'asg:b',
        directive: 'continue',
        updatedAt: 2,
      },
      {
        taskId,
        nodeId: '__wg_leader__',
        shardKey: '',
        directive: 'stop',
        updatedAt: 3,
      },
    ])

    let projectionPromise!: ReturnType<
      ReturnType<
        ReturnType<typeof composeSqliteWorkgroupTaskRoomClarifyParticipantFactory>['inTransaction']
      >['loadProjection']
    >
    let dismissalPromise!: ReturnType<
      ReturnType<
        ReturnType<typeof composeSqliteWorkgroupTaskRoomClarifyParticipantFactory>['inTransaction']
      >['dismissOpenSelfClarifies']
    >
    dbTxSync(db, (transaction) => {
      const participant =
        composeSqliteWorkgroupTaskRoomClarifyParticipantFactory().inTransaction(transaction)
      projectionPromise = participant.loadProjection(taskId)
      dismissalPromise = participant.dismissOpenSelfClarifies({ taskId, occurredAt: 4 })
    })

    await expect(projectionPromise).resolves.toEqual({
      askingNodeRunIds: ['asking-run-a', 'asking-run-b'],
      stopDirectives: [
        {
          nodeId: '__wg_member__',
          shardKey: 'asg:a',
          directive: 'stop',
        },
      ],
    })
    await expect(dismissalPromise).resolves.toEqual({
      dismissedSessions: 2,
      parks: [
        {
          nodeRunId: 'park-run-a',
          nodeId: '__wg_clarify__',
          assignmentShardKey: 'asg:a',
        },
        {
          nodeRunId: 'park-run-b',
          nodeId: '__wg_clarify__',
          assignmentShardKey: 'batch:a,b',
        },
      ],
    })
    const states = db
      .select({ id: clarifyRounds.id, status: clarifyRounds.status })
      .from(clarifyRounds)
      .all()
    expect(Object.fromEntries(states.map((round) => [round.id, round.status]))).toEqual({
      'round-answered': 'answered',
      'round-open-a': 'canceled',
      'round-open-b': 'canceled',
    })
  })

  test('PostgreSQL composition executes the closed live-suppression query', async () => {
    const fake = postgresqlFixture([
      [[JSON.stringify({ members: [{ memberType: 'agent' }], clarifyBudget: 3 })]],
    ])
    const runtime = createPostgresqlCollaborationRuntimeMechanics(fake.db, {
      taskRuntime: {
        humanGates: {
          async parkPrepared() {},
        },
      },
      nodeRunLifecycle: {
        inTransaction() {
          throw new Error('not used by live-suppression query')
        },
      },
    })

    await expect(runtime.isTaskClarifySuppressed({ taskId: 'task-pg' })).resolves.toBe(true)
    expect(fake.executions).toHaveLength(1)
    expect(fake.executions[0]?.sql).toContain('"agent_workflow"."tasks"')
    expect(fake.executions[0]?.parameters).toEqual(['task-pg', 1])
  })
})
