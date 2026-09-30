// CI 36665459531: same-task fan-out lost a member before runHostNode while PG
// repeatedly reported 40001 on the post-insert nonce read. Keep the real dual
// provider mint/receipt/rollback contract and prevent that unnecessary predicate
// read from returning; RFC-185 retains its three-member execution assertions.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { nodeRuns, tasks, workflows } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { createWorkgroupTurnsPersistence } from '@/modules/resource-catalog/infrastructure/workgroupTurnsOperations'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import type { WorkgroupHostLedgerOperation } from '@/modules/task-execution/public/commands'
import { WORKGROUP_TURN_MEMBER_NODE_ID } from '@/modules/task-execution/public/commands'
import { describeEachProvider } from './helpers/eachProvider'

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const taskId = ulid(),
    workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'mint-receipt', definition: '{}' })
  await db.insert(tasks).values({
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

  test('three concurrent sibling mints return their exact durable nonce without reading node_runs', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const persistence = createWorkgroupTurnsPersistence({
      db,
      hostLedgerFactory,
      clarifyAskGate: { allowed: async () => false },
    })
    const operations = ['a', 'b', 'c'].map(mintOperation)
    const recording = harness.recordStatements()
    let receipts: Array<Awaited<ReturnType<typeof persistence.commit>>>
    try {
      receipts = await Promise.all(
        operations.map((operation) => persistence.commit({ taskId, operations: [operation] })),
      )
    } finally {
      recording.stop()
    }
    expect(receipts.every((receipt) => receipt.committed)).toBe(true)
    const returned = receipts.flatMap((receipt) => (receipt.committed ? receipt.mintedRuns : []))
    expect(returned).toHaveLength(3)
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
    // source-text assertion or a copied query. Task lineage reads stay allowed.
    expect(recording.selects().filter((statement) => /"node_runs"/.test(statement.sql))).toEqual([])
  })

  test('rolled-back mint exposes no row and a new attempt returns only its committed nonce', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const operation = mintOperation('rollback')
    let rolledBackNonce: string | undefined
    await expect(
      harness.session.serializable(async (tx) => {
        const receipt = await hostLedgerFactory
          .inTransaction(tx)
          .apply({ taskId, operations: [operation] })
        if (!receipt.committed) throw new Error('unexpected mint fence conflict')
        rolledBackNonce = receipt.mintedRuns[0]?.envelopeNonce
        throw new Error('rollback after mint')
      }),
    ).rejects.toThrow('rollback after mint')
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
