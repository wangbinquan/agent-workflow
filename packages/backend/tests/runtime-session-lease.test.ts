import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import {
  mcps,
  mcpRuntimeTestSessionLeases,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  nodeRuns,
  runtimeSessionLeases,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import {
  claimNewMcpRuntimeTestSessionLease,
  preclaimMcpRuntimeTestSessionLease,
  releaseMcpRuntimeTestSessionLease,
  repairMcpRuntimeTestSessionLeaseAfterReap,
} from '../src/services/mcpRuntimeTestLease'
import {
  claimNewRuntimeSession,
  confirmRuntimeSessionResume,
  getRuntimeSessionLease,
  preclaimRuntimeSessionResume,
  releaseRuntimeSessionLease,
  repairRuntimeSessionLeasesAfterOrphanReap,
} from '../src/services/runtimeSessionLease'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HASH = 'a'.repeat(64)

function seedTaskRuns() {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(workflows)
    .values({ id: 'workflow-lease', name: 'workflow-lease', definition: '{}' })
    .run()
  db.insert(tasks)
    .values({
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
    .run()
  db.insert(nodeRuns)
    .values(
      ['run-1', 'run-2', 'run-3'].map((id) => ({
        id,
        taskId: 'task-lease',
        nodeId: 'node-a',
        status: 'running' as const,
      })),
    )
    .run()
  return db
}

function seedMcpTurn() {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(users)
    .values({
      id: 'user-lease',
      username: 'user-lease',
      displayName: 'Lease User',
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  db.insert(mcps)
    .values({
      id: 'mcp-lease',
      name: 'mcp-lease',
      type: 'local',
      config: '{}',
      ownerUserId: 'user-lease',
      visibility: 'private',
    })
    .run()
  db.insert(mcpRuntimeTestSessions)
    .values({
      id: 'test-session-lease',
      mcpId: 'mcp-lease',
      ownerUserId: 'user-lease',
      clientCreateId: 'create-lease',
      clientCreateDigest: HASH,
      status: 'active',
      mcpConfigHash: HASH,
      runtimeRowId: 'runtime-lease',
      runtimeName: 'opencode',
      runtimeProtocol: 'opencode',
      runtimeSnapshotJson: '{}',
      runtimeBinaryPath: '/mock/opencode',
      runtimeSessionId: 'native-mcp-lease',
      nativeSessionState: 'ready',
      inFlightTurnId: 'turn-1',
      turnSeq: 1,
      sessionVersion: 1,
      scratchRoot: '/tmp/test-session-lease',
      cleanupState: 'not-started',
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  db.insert(mcpRuntimeTestTurns)
    .values({
      id: 'turn-1',
      sessionId: 'test-session-lease',
      seq: 1,
      clientMessageId: 'message-1',
      promptText: 'first',
      status: 'running',
      hardDeadlineAt: 10_000,
      captureState: 'live',
      startedAt: 1,
      createdAt: 1,
    })
    .run()
  return db
}

describe('natural runtime session leases', () => {
  test('business sessions allow one writer, resume after release, and repair terminal holders', () => {
    const db = seedTaskRuns()
    const first = claimNewRuntimeSession(db, {
      protocol: 'opencode',
      sessionId: 'native-business-1',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-1',
      leasedAt: 10,
    })
    expect(getRuntimeSessionLease(db, 'opencode', 'native-business-1')).toMatchObject({
      createdNodeRunId: 'run-1',
      leaseNodeRunId: 'run-1',
    })
    expect(
      db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-1'))
        .get(),
    ).toEqual({ sessionId: 'native-business-1' })
    expect(() =>
      claimNewRuntimeSession(db, {
        protocol: 'opencode',
        sessionId: 'native-business-1',
        taskId: 'task-lease',
        nodeId: 'node-a',
        currentNodeRunId: 'run-2',
        leaseNonceDigest: 'nonce-conflict',
      }),
    ).toThrow('runtime-session-conflict')

    expect(releaseRuntimeSessionLease(db, first)).toBe(true)
    const resumed = preclaimRuntimeSessionResume(db, {
      protocol: 'opencode',
      sessionId: 'native-business-1',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-2',
      leaseNonceDigest: 'nonce-2',
      leasedAt: 20,
    })
    expect(confirmRuntimeSessionResume(db, resumed)).toBe(true)
    expect(() =>
      preclaimRuntimeSessionResume(db, {
        protocol: 'opencode',
        sessionId: 'native-business-1',
        taskId: 'task-lease',
        nodeId: 'node-a',
        currentNodeRunId: 'run-3',
        leaseNonceDigest: 'nonce-3',
      }),
    ).toThrow('runtime-session-conflict')
    expect(releaseRuntimeSessionLease(db, resumed)).toBe(true)

    const stranded = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'native-business-2',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-3',
      leaseNonceDigest: 'nonce-terminal',
      leasedAt: 30,
    })
    db.update(nodeRuns).set({ status: 'failed' }).where(eq(nodeRuns.id, 'run-3')).run()
    expect(repairRuntimeSessionLeasesAfterOrphanReap(db, true)).toBe(1)
    expect(releaseRuntimeSessionLease(db, stranded)).toBe(false)
    expect(
      db
        .select({ holder: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, 'claude-code'),
            eq(runtimeSessionLeases.sessionId, 'native-business-2'),
          ),
        )
        .get(),
    ).toEqual({ holder: null })
  })

  test('MCP turns resume under the same single-writer lease and release after proven reap', () => {
    const db = seedMcpTurn()
    const first = claimNewMcpRuntimeTestSessionLease(db, {
      protocol: 'opencode',
      runtimeSessionId: 'native-mcp-lease',
      testSessionId: 'test-session-lease',
      turnId: 'turn-1',
      leaseNonceDigest: HASH,
      leasedAt: 10,
    })
    expect(releaseMcpRuntimeTestSessionLease(db, first)).toBe(true)

    db.update(mcpRuntimeTestTurns)
      .set({ status: 'succeeded', captureState: 'complete', finishedAt: 2, durationMs: 1 })
      .where(eq(mcpRuntimeTestTurns.id, 'turn-1'))
      .run()
    db.insert(mcpRuntimeTestTurns)
      .values({
        id: 'turn-2',
        sessionId: 'test-session-lease',
        seq: 2,
        clientMessageId: 'message-2',
        promptText: 'second',
        status: 'running',
        hardDeadlineAt: 10_000,
        captureState: 'live',
        startedAt: 3,
        createdAt: 3,
      })
      .run()
    db.update(mcpRuntimeTestSessions)
      .set({ inFlightTurnId: 'turn-2', turnSeq: 2, sessionVersion: 2, updatedAt: 3 })
      .where(eq(mcpRuntimeTestSessions.id, 'test-session-lease'))
      .run()

    const second = preclaimMcpRuntimeTestSessionLease(db, {
      protocol: 'opencode',
      runtimeSessionId: 'native-mcp-lease',
      testSessionId: 'test-session-lease',
      turnId: 'turn-2',
      leaseNonceDigest: HASH,
      leasedAt: 20,
    })
    expect(() =>
      preclaimMcpRuntimeTestSessionLease(db, {
        protocol: 'opencode',
        runtimeSessionId: 'native-mcp-lease',
        testSessionId: 'test-session-lease',
        turnId: 'turn-2',
        leaseNonceDigest: 'b'.repeat(64),
      }),
    ).toThrow('mcp-test-session-conflict')
    expect(
      repairMcpRuntimeTestSessionLeaseAfterReap(db, 'test-session-lease', 'turn-2', true),
    ).toBe(true)
    expect(releaseMcpRuntimeTestSessionLease(db, second)).toBe(false)
    expect(
      db
        .select({
          currentTurnId: mcpRuntimeTestSessionLeases.currentTurnId,
          holder: mcpRuntimeTestSessionLeases.leaseTurnId,
        })
        .from(mcpRuntimeTestSessionLeases)
        .get(),
    ).toEqual({ currentTurnId: 'turn-2', holder: null })
  })
})
