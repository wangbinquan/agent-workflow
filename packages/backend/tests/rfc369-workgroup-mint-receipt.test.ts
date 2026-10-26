// CI 36665459531: same-task fan-out lost a member before runHostNode while PG
// repeatedly reported 40001 on the post-insert nonce read. Keep the real dual
// provider mint/receipt/rollback contract and prevent that unnecessary predicate
// read from returning; RFC-185 retains its three-member execution assertions.
import { taskFixture, workflowFixture } from './helpers/model'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { createWorkgroupTurnsPersistence } from '@/modules/resource-catalog/infrastructure/workgroupTurnsOperations'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import type { WorkgroupHostLedgerOperation } from '@/modules/task-execution/public/commands'
import { WORKGROUP_TURN_MEMBER_NODE_ID } from '@/modules/task-execution/public/commands'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import { insertOne } from '@/platform/persistence/singleInsert'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { o2Ports } from './helpers/o2Closure'

async function seedTask(db: PersistenceDb): Promise<string> {
  const taskId = ulid(),
    workflowId = ulid()
  await workflowFixture(db, { id: workflowId, name: 'mint-receipt', definition: '{}' })
  await taskFixture(db, {
    id: taskId,
    name: 'same-member fan-out',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/nonexistent/mint-receipt',
    worktreePath: '/nonexistent/mint-receipt-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
  })
  return taskId
}

function mintOperation(shardKey: string): WorkgroupHostLedgerOperation {
  const runId = ulid()
  return {
    kind: 'mint-host-run',
    operationKey: `mint:${runId}`,
    runId,
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    status: 'pending',
    cause: 'wg-assignment',
    retryIndex: 0,
    shardKey,
    agentOverrideName: 'same-member',
    agentOverrideId: 'same-agent',
    wgRound: 1,
  }
}

describeEachProvider('RFC-369 workgroup mint receipts under sibling writes', (harness) => {
  const hostLedgerFactory = composeWorkgroupHostLedgerParticipantFactory({
    collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
  })

  test.each([1, 2, 3, 4, 5])(
    'round %i: independent clients mint siblings exactly once and return their durable nonce',
    async () => {
      const db = harness.db
      const taskId = await seedTask(db)
      const bodyRuns = [0, 0, 0]
      const clients = bodyRuns.map(() =>
        harness.applicationBinding.provider === 'postgresql'
          ? createPostgresqlDatabaseClient(harness.applicationBinding.runtime)
          : db,
      )
      const persistences = clients.map((client, index) =>
        createWorkgroupTurnsPersistence({
          db: client,
          hostLedgerFactory: {
            inTransaction(tx) {
              const participant = hostLedgerFactory.inTransaction(tx)
              return {
                ...participant,
                async lockTask(taskId) {
                  bodyRuns[index]! += 1
                  await participant.lockTask(taskId)
                },
              }
            },
          },
          clarifyAskGate: { allowed: async () => false },
        }),
      )
      const operations = ['a', 'b', 'c'].map(mintOperation)
      const recording = harness.recordStatements()
      let receipts: Array<Awaited<ReturnType<(typeof persistences)[number]['commit']>>>
      try {
        receipts = await Promise.all(
          operations.map((operation, index) =>
            persistences[index]!.commit({ taskId, operations: [operation] }),
          ),
        )
      } finally {
        recording.stop()
      }
      expect(bodyRuns).toEqual([1, 1, 1])
      expect(receipts.every((receipt) => receipt.committed)).toBe(true)
      const returned = receipts.flatMap((receipt) => (receipt.committed ? receipt.mintedRuns : []))
      expect(returned).toHaveLength(3)
      const { nodeRuns } = tablesOf(db)
      const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      expect(rows).toHaveLength(3)
      expect(new Set(rows.map((row) => row.shardKey))).toEqual(new Set(['a', 'b', 'c']))
      expect(new Set(returned.map((receipt) => receipt.envelopeNonce)).size).toBe(3)
      for (const receipt of returned) {
        expect(receipt.envelopeNonce).toMatch(/^[a-f0-9]{16}$/)
        expect(rows.find((row) => row.id === receipt.runId)?.envelopeNonce).toBe(
          receipt.envelopeNonce,
        )
      }
      // Audit executed SQL, including any serialization replay, rather than a
      // source-text assertion or a copied query. Epoch-2 companion/selection writes
      // validate the new run under its task lock; those exact-id checks are required.
      // Receipt construction must still return the minted nonce without a dedicated
      // nonce lookup (the RFC-369 regression), a task-wide scan or a sibling read.
      const mintedIds = new Set(operations.map((operation) => operation.runId))
      const runReads = recording.selects().filter((statement) => /"node_runs"/.test(statement.sql))
      for (const statement of runReads) {
        if (/ for update$/.test(statement.sql)) {
          // Read-committed providers also lock the exact minted run in the RFC-395 lock order.
          expect(harness.capabilities.isolation).toBe('read-committed')
          expect(statement.sql).toMatch(
            /^select 1 from (?:"agent_workflow"\.)?"node_runs" where (?:"agent_workflow"\.)?"node_runs"\."id" = (?:\?|\$1) for update$/,
          )
          expect(mintedIds.has(String(statement.values[0]))).toBe(true)
          expect(statement.rows).toBe(1)
          continue
        }
        // PostgreSQL qualifies the table (and the column reference) with the application schema.
        expect(statement.sql).toMatch(
          /^select (?:"task_id"|"id", "task_id", .+) from (?:"agent_workflow"\.)?"node_runs" where (?:"agent_workflow"\.)?"node_runs"\."id" = (?:\?|\$1) limit (?:\?|\$2)$/,
        )
        expect(mintedIds.has(String(statement.values[0]))).toBe(true)
        expect(statement.values[1]).toBe(1)
        expect(statement.rows).toBe(1)
      }
    },
  )

  test('owned ledger admission fences before the root; a stale owner cannot mint', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const now = Date.now()
    const identity = createWorkerIdentity({ ownerId: 'owner', daemonGeneration: 'daemon' })
    const { taskExecutionOwners, nodeRuns } = tablesOf(db)
    await insertOne(db, taskExecutionOwners, {
      taskId,
      ownerId: identity.ownerId,
      daemonGeneration: identity.daemonGeneration,
      epoch: 1,
      state: 'claimed',
      leaseUntil: now + 60_000,
      revision: 1,
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    const context = createTaskExecutionContext({
      intentId: 'intent',
      token: createOwnershipToken({
        taskId,
        identity,
        epoch: 1,
        leaseUntil: now + 60_000,
        ownerRevision: 1,
      }),
      persistence: createTaskExecutionPersistence(db, {
        historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
        recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
      }),
    })
    const persistence = createWorkgroupTurnsPersistence({
      db,
      hostLedgerFactory,
      clarifyAskGate: { allowed: async () => false },
    })
    const recording = harness.recordStatements()
    try {
      await runWithTaskExecutionContext(context, () =>
        persistence.commit({ taskId, operations: [mintOperation('owned')] }),
      )
    } finally {
      recording.stop()
    }
    const statements = recording.statements.map(({ sql }) =>
      sql.replaceAll('"agent_workflow".', ''),
    )
    const owner = statements.findIndex((sql) => sql.startsWith('update "task_execution_owners"'))
    const run = statements.findIndex((sql) => sql.startsWith('insert into "node_runs"'))
    expect(owner).toBeGreaterThanOrEqual(0)
    expect(run).toBeGreaterThan(owner)
    if (harness.applicationBinding.provider === 'postgresql') {
      const root = statements.findIndex(
        (sql) => sql.includes('from "tasks"') && sql.includes('for update'),
      )
      expect(root).toBeGreaterThan(owner)
      expect(run).toBeGreaterThan(root)
      expect(
        statements.filter((sql) => sql.includes('from "tasks"') && sql.includes('for update')),
      ).toHaveLength(1)
    }
    await db
      .update(taskExecutionOwners)
      .set({ epoch: 2 })
      .where(eq(taskExecutionOwners.taskId, taskId))
    await expect(
      runWithTaskExecutionContext(context, () =>
        persistence.commit({ taskId, operations: [mintOperation('stale')] }),
      ),
    ).rejects.toThrow('mutation was fenced')
    expect(await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).toHaveLength(1)
  })

  test('rolled-back mint exposes no row and a new attempt returns only its committed nonce', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const operation = mintOperation('rollback')
    let rolledBackNonce: string | undefined
    await expect(
      harness.session.serializable(async (tx) => {
        const participant = hostLedgerFactory.inTransaction(tx)
        await participant.lockTask(taskId)
        const receipt = await participant.apply({ taskId, operations: [operation] })
        if (!receipt.committed) throw new Error('unexpected mint fence conflict')
        rolledBackNonce = receipt.mintedRuns[0]?.envelopeNonce
        throw new Error('rollback after mint')
      }),
    ).rejects.toThrow('rollback after mint')
    const { nodeRuns } = tablesOf(db)
    expect(await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).toHaveLength(0)
    const persistence = createWorkgroupTurnsPersistence({
      db,
      hostLedgerFactory,
      clarifyAskGate: { allowed: async () => false },
    })
    const receipt = await persistence.commit({ taskId, operations: [operation] })
    expect(receipt.committed).toBe(true)
    if (!receipt.committed) throw new Error('unexpected mint fence conflict')
    const returned = receipt.mintedRuns[0]
    expect(returned).toBeDefined()
    expect(rolledBackNonce).toMatch(/^[a-f0-9]{16}$/)
    expect(returned?.envelopeNonce).not.toBe(rolledBackNonce)
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.envelopeNonce).toBe(returned?.envelopeNonce)
  })
})
