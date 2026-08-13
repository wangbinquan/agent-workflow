import { describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import {
  mcps,
  mcpRuntimeTestSessionLeases,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  nodeRunEvents,
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
  rotateMcpRuntimeTestSessionLease,
} from '../src/services/mcpRuntimeTestLease'
import {
  claimNewRuntimeSession,
  confirmRuntimeSessionResume,
  discardRuntimeSessionLease,
  getRuntimeSessionLease,
  markRuntimeSessionResetPending,
  preclaimRuntimeSessionResume,
  releaseRuntimeSessionLease,
  repairRuntimeSessionLeasesAfterOrphanReap,
  rotateRuntimeSessionLease,
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

function seedMcpTurn(protocol: 'opencode' | 'claude-code' = 'opencode') {
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
      runtimeName: protocol,
      runtimeProtocol: protocol,
      runtimeSnapshotJson: '{}',
      runtimeBinaryPath: `/mock/${protocol}`,
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
  test('business conversation reset atomically rotates the holder and run pointer', () => {
    const db = seedTaskRuns()
    const first = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'native-before-reset',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-reset',
      leasedAt: 10,
    })

    expect(() => rotateRuntimeSessionLease(db, first, 'native-after-reset')).toThrow(
      'runtime-session-conflict',
    )

    expect(markRuntimeSessionResetPending(db, first)).toBe(true)
    expect(
      db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-1'))
        .get(),
    ).toEqual({ sessionId: null })
    const rotated = rotateRuntimeSessionLease(db, first, 'native-after-reset')

    expect(rotated).toEqual({ ...first, sessionId: 'native-after-reset' })
    expect(getRuntimeSessionLease(db, 'claude-code', 'native-before-reset')).toBeUndefined()
    expect(getRuntimeSessionLease(db, 'claude-code', 'native-after-reset')).toMatchObject({
      createdNodeRunId: 'run-1',
      leaseNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-reset',
    })
    expect(
      db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-1'))
        .get(),
    ).toEqual({ sessionId: 'native-after-reset' })
    expect(releaseRuntimeSessionLease(db, first)).toBe(false)
    expect(releaseRuntimeSessionLease(db, rotated)).toBe(true)
  })

  test('resumed reset preserves creator provenance and retags prior logical rounds', () => {
    const db = seedTaskRuns()
    const first = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'native-lineage-a',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-lineage-1',
      leasedAt: 10,
    })
    db.insert(nodeRunEvents)
      .values({
        nodeRunId: 'run-1',
        ts: 1,
        kind: 'text',
        payload: '{"round":1}',
        sessionId: 'native-lineage-a',
        parentSessionId: null,
      })
      .run()
    expect(releaseRuntimeSessionLease(db, first)).toBe(true)
    const resumed = preclaimRuntimeSessionResume(db, {
      protocol: 'claude-code',
      sessionId: 'native-lineage-a',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-2',
      leaseNonceDigest: 'nonce-lineage-2',
      leasedAt: 20,
    })
    expect(confirmRuntimeSessionResume(db, resumed)).toBe(true)
    db.insert(nodeRunEvents)
      .values({
        nodeRunId: 'run-2',
        ts: 2,
        kind: 'text',
        payload: '{"round":2}',
        sessionId: 'native-lineage-a',
        parentSessionId: null,
      })
      .run()
    expect(markRuntimeSessionResetPending(db, resumed)).toBe(true)

    const rotated = rotateRuntimeSessionLease(db, resumed, 'native-lineage-b')
    expect(getRuntimeSessionLease(db, 'claude-code', 'native-lineage-b')).toMatchObject({
      createdNodeRunId: 'run-1',
      leaseNodeRunId: 'run-2',
    })
    expect(
      db
        .select({ id: nodeRuns.id, sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.nodeId, 'node-a'))
        .all()
        .filter((row) => row.id === 'run-1' || row.id === 'run-2'),
    ).toEqual([
      { id: 'run-1', sessionId: 'native-lineage-b' },
      { id: 'run-2', sessionId: 'native-lineage-b' },
    ])
    expect(
      db
        .select({ sessionId: nodeRunEvents.sessionId })
        .from(nodeRunEvents)
        .all()
        .map((row) => row.sessionId),
    ).toEqual(['native-lineage-b', 'native-lineage-b'])
    expect(releaseRuntimeSessionLease(db, rotated)).toBe(true)
  })

  test('business conversation reset collision rolls back the outgoing lease', () => {
    const db = seedTaskRuns()
    const first = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'native-before-reset',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-reset',
      leasedAt: 10,
    })
    const occupied = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'native-after-reset',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-2',
      leaseNonceDigest: 'nonce-occupied',
      leasedAt: 20,
    })

    expect(markRuntimeSessionResetPending(db, first)).toBe(true)
    expect(() => rotateRuntimeSessionLease(db, first, 'native-after-reset')).toThrow(
      'runtime-session-conflict',
    )
    expect(getRuntimeSessionLease(db, 'claude-code', 'native-before-reset')).toMatchObject({
      leaseNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-reset',
    })
    expect(
      db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-1'))
        .get(),
    ).toEqual({ sessionId: null })

    expect(discardRuntimeSessionLease(db, first)).toBe(true)
    expect(getRuntimeSessionLease(db, 'claude-code', first.sessionId)).toBeUndefined()
    expect(releaseRuntimeSessionLease(db, occupied)).toBe(true)
  })

  test('pending business reset keeps the outgoing lease held while clearing stale resume', () => {
    const db = seedTaskRuns()
    const first = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'native-reset-without-result',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-pending',
      leasedAt: 10,
    })

    expect(markRuntimeSessionResetPending(db, first)).toBe(true)
    expect(getRuntimeSessionLease(db, 'claude-code', first.sessionId)).toMatchObject({
      leaseNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-pending',
      resetPending: true,
    })
    expect(
      db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-1'))
        .get(),
    ).toEqual({ sessionId: null })
    expect(releaseRuntimeSessionLease(db, first)).toBe(false)
    expect(discardRuntimeSessionLease(db, first)).toBe(true)
    expect(getRuntimeSessionLease(db, 'claude-code', first.sessionId)).toBeUndefined()
  })

  test('migration fence rejects neutral or non-boolean reset_pending states', () => {
    const db = seedTaskRuns()
    const first = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'native-reset-trigger',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-reset-trigger',
    })
    expect(releaseRuntimeSessionLease(db, first)).toBe(true)
    expect(() =>
      db.run(sql`UPDATE runtime_session_leases SET reset_pending = 1
        WHERE protocol = 'claude-code' AND session_id = 'native-reset-trigger'`),
    ).toThrow()
    expect(() =>
      db.run(sql`UPDATE runtime_session_leases SET reset_pending = 2
        WHERE protocol = 'claude-code' AND session_id = 'native-reset-trigger'`),
    ).toThrow()
    db.delete(runtimeSessionLeases)
      .where(eq(runtimeSessionLeases.sessionId, 'native-reset-trigger'))
      .run()
    expect(getRuntimeSessionLease(db, 'claude-code', 'native-reset-trigger')).toBeUndefined()
  })

  test('boot repair deletes a reset-pending outgoing id instead of making it resumable', () => {
    const db = seedTaskRuns()
    const first = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'native-reset-crash',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-reset-crash',
      leasedAt: 10,
    })

    expect(markRuntimeSessionResetPending(db, first)).toBe(true)
    db.update(nodeRuns).set({ status: 'interrupted' }).where(eq(nodeRuns.id, 'run-1')).run()
    expect(repairRuntimeSessionLeasesAfterOrphanReap(db, true)).toBe(1)
    expect(getRuntimeSessionLease(db, 'claude-code', first.sessionId)).toBeUndefined()
    expect(() =>
      preclaimRuntimeSessionResume(db, {
        protocol: 'claude-code',
        sessionId: first.sessionId,
        taskId: 'task-lease',
        nodeId: 'node-a',
        currentNodeRunId: 'run-2',
        leaseNonceDigest: 'nonce-stale-resume',
      }),
    ).toThrow('runtime-session-conflict')
  })

  test('boot repair discards an identity-invalid lease even if the early fence write was lost', () => {
    const db = seedTaskRuns()
    const first = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'native-invalid-unfenced',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-invalid-unfenced',
    })
    db.update(nodeRuns)
      .set({ status: 'failed', failureCode: 'runtime-session-identity-invalid' })
      .where(eq(nodeRuns.id, 'run-1'))
      .run()

    expect(repairRuntimeSessionLeasesAfterOrphanReap(db, true)).toBe(1)
    expect(getRuntimeSessionLease(db, 'claude-code', first.sessionId)).toBeUndefined()
    expect(
      db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-1'))
        .get(),
    ).toEqual({ sessionId: null })
  })

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

  test('MCP conversation reset atomically rotates its unique native lease', () => {
    const db = seedMcpTurn('claude-code')
    const first = claimNewMcpRuntimeTestSessionLease(db, {
      protocol: 'claude-code',
      runtimeSessionId: 'native-mcp-lease',
      testSessionId: 'test-session-lease',
      turnId: 'turn-1',
      leaseNonceDigest: HASH,
      leasedAt: 10,
    })
    db.update(mcpRuntimeTestSessions)
      .set({ nativeSessionState: 'unusable' })
      .where(eq(mcpRuntimeTestSessions.id, 'test-session-lease'))
      .run()

    const rotated = rotateMcpRuntimeTestSessionLease(db, first, 'native-mcp-after-reset')

    expect(rotated.runtimeSessionId).toBe('native-mcp-after-reset')
    expect(
      db
        .select({ runtimeSessionId: mcpRuntimeTestSessions.runtimeSessionId })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, 'test-session-lease'))
        .get(),
    ).toEqual({ runtimeSessionId: 'native-mcp-after-reset' })
    expect(
      db
        .select({ runtimeSessionId: mcpRuntimeTestSessionLeases.runtimeSessionId })
        .from(mcpRuntimeTestSessionLeases)
        .where(eq(mcpRuntimeTestSessionLeases.testSessionId, 'test-session-lease'))
        .get(),
    ).toEqual({ runtimeSessionId: 'native-mcp-after-reset' })
    expect(releaseMcpRuntimeTestSessionLease(db, first)).toBe(false)
    expect(releaseMcpRuntimeTestSessionLease(db, rotated)).toBe(true)
  })

  test('MCP lease claims must match the logical session runtime protocol', () => {
    const db = seedMcpTurn('opencode')
    expect(() =>
      claimNewMcpRuntimeTestSessionLease(db, {
        protocol: 'claude-code',
        runtimeSessionId: 'native-mcp-lease',
        testSessionId: 'test-session-lease',
        turnId: 'turn-1',
        leaseNonceDigest: HASH,
      }),
    ).toThrow('mcp-test-session-conflict')
  })

  test('MCP conversation reset requires a durable unusable fence before rotation', () => {
    const db = seedMcpTurn('claude-code')
    const first = claimNewMcpRuntimeTestSessionLease(db, {
      protocol: 'claude-code',
      runtimeSessionId: 'native-mcp-lease',
      testSessionId: 'test-session-lease',
      turnId: 'turn-1',
      leaseNonceDigest: HASH,
    })
    expect(() => rotateMcpRuntimeTestSessionLease(db, first, 'unannounced-native-id')).toThrow(
      'mcp-test-session-conflict',
    )
    expect(
      db
        .select({ runtimeSessionId: mcpRuntimeTestSessions.runtimeSessionId })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, 'test-session-lease'))
        .get(),
    ).toEqual({ runtimeSessionId: 'native-mcp-lease' })
  })

  test('MCP conversation reset collision rolls back pointer, lease, and fence state', () => {
    const db = seedMcpTurn('claude-code')
    const first = claimNewMcpRuntimeTestSessionLease(db, {
      protocol: 'claude-code',
      runtimeSessionId: 'native-mcp-lease',
      testSessionId: 'test-session-lease',
      turnId: 'turn-1',
      leaseNonceDigest: HASH,
    })
    db.update(mcpRuntimeTestSessions)
      .set({ nativeSessionState: 'unusable' })
      .where(eq(mcpRuntimeTestSessions.id, 'test-session-lease'))
      .run()

    db.insert(users)
      .values({
        id: 'user-other',
        username: 'user-other',
        displayName: 'Other Lease User',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    db.insert(mcpRuntimeTestSessions)
      .values({
        id: 'test-session-other',
        mcpId: 'mcp-lease',
        ownerUserId: 'user-other',
        clientCreateId: 'create-other',
        clientCreateDigest: HASH,
        status: 'active',
        mcpConfigHash: HASH,
        runtimeRowId: 'runtime-lease',
        runtimeName: 'claude-code',
        runtimeProtocol: 'claude-code',
        runtimeSnapshotJson: '{}',
        runtimeBinaryPath: '/mock/claude-code',
        runtimeSessionId: 'native-mcp-taken',
        nativeSessionState: 'ready',
        inFlightTurnId: 'turn-other',
        turnSeq: 1,
        sessionVersion: 1,
        scratchRoot: '/tmp/test-session-other',
        cleanupState: 'not-started',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    db.insert(mcpRuntimeTestTurns)
      .values({
        id: 'turn-other',
        sessionId: 'test-session-other',
        seq: 1,
        clientMessageId: 'message-other',
        promptText: 'other',
        status: 'running',
        hardDeadlineAt: 10_000,
        captureState: 'live',
        startedAt: 1,
        createdAt: 1,
      })
      .run()
    claimNewMcpRuntimeTestSessionLease(db, {
      protocol: 'claude-code',
      runtimeSessionId: 'native-mcp-taken',
      testSessionId: 'test-session-other',
      turnId: 'turn-other',
      leaseNonceDigest: 'b'.repeat(64),
    })

    expect(() => rotateMcpRuntimeTestSessionLease(db, first, 'native-mcp-taken')).toThrow()
    expect(
      db
        .select({
          runtimeSessionId: mcpRuntimeTestSessions.runtimeSessionId,
          nativeSessionState: mcpRuntimeTestSessions.nativeSessionState,
        })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, 'test-session-lease'))
        .get(),
    ).toEqual({ runtimeSessionId: 'native-mcp-lease', nativeSessionState: 'unusable' })
    expect(
      db
        .select({
          runtimeSessionId: mcpRuntimeTestSessionLeases.runtimeSessionId,
          holder: mcpRuntimeTestSessionLeases.leaseTurnId,
        })
        .from(mcpRuntimeTestSessionLeases)
        .where(eq(mcpRuntimeTestSessionLeases.testSessionId, 'test-session-lease'))
        .get(),
    ).toEqual({ runtimeSessionId: 'native-mcp-lease', holder: 'turn-1' })
  })
})
