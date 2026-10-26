// RFC-349 — native runtime-session ownership is a provider-selected Promise
// atom. SQLite locks the complete reset/resume behavior; the PostgreSQL oracle
// proves the same claim is compiled against the real PostgreSQL projection.

import { nodeRunFixture, patchNodeRunFixture, taskFixture, workflowFixture } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first as firstRow } from '@/platform/persistence/queryHelpers'
import { expect, test } from 'bun:test'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import { describeEachProvider } from './helpers/eachProvider'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import {
  claimNewRuntimeSession,
  confirmRuntimeSessionResume,
  getRuntimeSessionLease,
  markRuntimeSessionResetPending,
  preclaimRuntimeSessionResume,
  releaseRuntimeSessionLease,
  repairRuntimeSessionLeasesAfterOrphanReap,
  rotateRuntimeSessionLease,
} from '@/services/runtimeSessionLease'

async function seedTaskRuns(db: PersistenceDb) {
  await workflowFixture(db, { id: 'workflow-lease', name: 'workflow-lease', definition: '{}' })
  await taskFixture(db, {
    id: 'task-lease',
    name: 'task-lease',
    workflowId: 'workflow-lease',
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: 'aw/lease',
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
  await nodeRunFixture(
    db,
    ['run-1', 'run-2', 'run-3'].map((id) => ({
      id,
      taskId: 'task-lease',
      nodeId: 'node-a',
      status: 'running' as const,
    })),
  )
  return db
}

describeEachProvider('RFC-349 runtime-session lease native transaction', (harness) => {
  test('claim uses the selected schema and generation-fenced transaction', async () => {
    await seedTaskRuns(harness.db)
    const recording = harness.recordStatements()
    const operations = createRuntimeSessionLeaseOperations(harness.db)
    await expect(
      claimNewRuntimeSession(operations, {
        protocol: 'opencode',
        sessionId: 'native-pg',
        taskId: 'task-lease',
        nodeId: 'node-a',
        currentNodeRunId: 'run-1',
        leaseNonceDigest: 'nonce-pg',
        leasedAt: 30,
      }),
    ).resolves.toEqual({
      protocol: 'opencode',
      sessionId: 'native-pg',
      nodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-pg',
    })

    const statements = recording.statements.map((execution) => execution.sql.toLowerCase())
    if (harness.capabilities.isolation === 'read-committed')
      expect(statements).toContain('set transaction isolation level serializable')
    else expect(statements).toContain('begin immediate')
    expect(statements.some((sql) => sql.includes('task_execution_owners'))).toBe(true)
    expect(
      statements.some(
        (sql) => sql.includes('insert into') && sql.includes('"runtime_session_leases"'),
      ),
    ).toBe(true)
    if (harness.capabilities.isolation === 'read-committed')
      expect(statements.some((sql) => sql.includes('generations'))).toBe(true)
  })
})

describeEachProvider('RFC-349 runtime-session lease provider operations', (harness) => {
  test('SQLite preserves claim, reset rotation, resume, and terminal repair semantics', async () => {
    const db = await seedTaskRuns(harness.db)
    const operations = createRuntimeSessionLeaseOperations(db)
    const first = await claimNewRuntimeSession(operations, {
      protocol: 'claude-code',
      sessionId: 'native-before-reset',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-1',
      leasedAt: 10,
    })
    const { nodeRunEvents } = tablesOf(db)
    await insertOne(db, nodeRunEvents, {
      nodeRunId: 'run-1',
      ts: 1,
      kind: 'text',
      payload: '{}',
      sessionId: first.sessionId,
    })

    await expect(
      claimNewRuntimeSession(operations, {
        protocol: 'claude-code',
        sessionId: first.sessionId,
        taskId: 'task-lease',
        nodeId: 'node-a',
        currentNodeRunId: 'run-2',
        leaseNonceDigest: 'nonce-conflict',
      }),
    ).rejects.toMatchObject({ code: 'runtime-session-conflict', reason: 'owner-conflict' })
    await expect(
      rotateRuntimeSessionLease(operations, first, 'native-after-reset'),
    ).rejects.toMatchObject({
      reason: 'lease-mismatch',
    })

    await expect(markRuntimeSessionResetPending(operations, first)).resolves.toBe(true)
    const rotated = await rotateRuntimeSessionLease(operations, first, 'native-after-reset')
    await expect(
      getRuntimeSessionLease(operations, 'claude-code', first.sessionId),
    ).resolves.toBeUndefined()
    await expect(
      getRuntimeSessionLease(operations, 'claude-code', rotated.sessionId),
    ).resolves.toMatchObject({ createdNodeRunId: 'run-1', leaseNodeRunId: 'run-1' })
    expect(
      await firstRow(db.select({ sessionId: nodeRunEvents.sessionId }).from(nodeRunEvents)),
    ).toEqual({
      sessionId: rotated.sessionId,
    })
    await expect(releaseRuntimeSessionLease(operations, rotated)).resolves.toBe(true)

    const resumed = await preclaimRuntimeSessionResume(operations, {
      protocol: 'claude-code',
      sessionId: rotated.sessionId,
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-2',
      leaseNonceDigest: 'nonce-2',
      leasedAt: 20,
    })
    await expect(confirmRuntimeSessionResume(operations, resumed)).resolves.toBe(true)
    await patchNodeRunFixture(db, { id: 'run-2' }, { status: 'failed' })
    await expect(repairRuntimeSessionLeasesAfterOrphanReap(operations, true)).resolves.toBe(1)
    await expect(releaseRuntimeSessionLease(operations, resumed)).resolves.toBe(false)
  })

  test('facade rejects malformed claims before reaching provider infrastructure', async () => {
    const operations = createRuntimeSessionLeaseOperations(await seedTaskRuns(harness.db))
    await expect(
      claimNewRuntimeSession(operations, {
        protocol: 'opencode',
        sessionId: '',
        taskId: 'task-lease',
        nodeId: 'node-a',
        currentNodeRunId: 'run-1',
        leaseNonceDigest: 'nonce',
      }),
    ).rejects.toMatchObject({ code: 'runtime-session-conflict', reason: 'invalid-input' })
  })
})
