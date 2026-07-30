import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { mcps, mcpRuntimeTestSessions, mcpRuntimeTestTurns } from '../src/db/schema'
import {
  claimNewMcpRuntimeTestSession,
  confirmMcpRuntimeTestResume,
  getMcpRuntimeTestOwner,
  preclaimMcpRuntimeTestResume,
  releaseMcpRuntimeTestLease,
} from '../src/services/mcpRuntimeTestOwner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const D1 = '1'.repeat(64)
const D2 = '2'.repeat(64)
const D3 = '3'.repeat(64)
const D4 = '4'.repeat(64)

function seededOwnerDb() {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(mcps)
    .values({
      id: 'mcp-1',
      name: 'fixture',
      description: '',
      type: 'remote',
      config: JSON.stringify({ url: 'https://example.test/mcp' }),
      enabled: true,
      ownerUserId: SYSTEM_USER_ID,
      visibility: 'private',
    })
    .run()
  db.insert(mcpRuntimeTestSessions)
    .values({
      id: 'test-session',
      mcpId: 'mcp-1',
      ownerUserId: SYSTEM_USER_ID,
      clientCreateId: 'create-1',
      clientCreateDigest: D1,
      status: 'active',
      mcpConfigHash: D1,
      runtimeRowId: 'runtime-1',
      runtimeName: 'opencode',
      runtimeProtocol: 'opencode',
      runtimeSnapshotJson: '{}',
      runtimeFingerprint: D2,
      runtimeBinaryPath: '/sealed/opencode',
      runtimeBinaryDigest: D2,
      mcpExecutionDigest: D3,
      sessionContractDigest: D4,
      nativeSessionState: 'pending',
      inFlightTurnId: 'turn-1',
      turnSeq: 1,
      sessionVersion: 1,
      scratchRoot: '/tmp/rfc238-owner-session',
      sessionStoreRoot: '/tmp/rfc238-owner-store',
      cleanupState: 'not-started',
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  db.insert(mcpRuntimeTestTurns)
    .values({
      id: 'turn-1',
      sessionId: 'test-session',
      seq: 1,
      clientMessageId: 'message-1',
      promptText: 'first',
      status: 'running',
      hardDeadlineAt: 600_001,
      captureState: 'live',
      startedAt: 2,
      createdAt: 1,
    })
    .run()
  return db
}

const immutable = {
  testSessionId: 'test-session',
  createdTurnId: 'turn-1',
  identityDigest: D1,
  runtimeBinaryDigest: D2,
  sessionContractDigest: D4,
  sessionStoreKey: 'm_test_session',
  protocolCodec: 'opencode-mcp-test-control-v1',
} as const

describe('RFC-238 OpenCode playground owner and lease', () => {
  test('claims new identity, resumes exact ownership, and rejects stale or mismatched leases', () => {
    const db = seededOwnerDb()
    const firstToken = claimNewMcpRuntimeTestSession(db, {
      ...immutable,
      runtimeSessionId: 'native-session',
      turnId: 'turn-1',
      projectId: 'project-1',
      reportedVersion: '1.0.0',
      leaseNonceDigest: D3,
      leasedAt: 3,
    })
    expect(getMcpRuntimeTestOwner(db, 'test-session')).toMatchObject({
      runtimeSessionId: 'native-session',
      testSessionId: 'test-session',
      leaseTurnId: 'turn-1',
      leaseNonceDigest: D3,
    })
    expect(
      releaseMcpRuntimeTestLease(db, {
        ...firstToken,
        leaseNonceDigest: D4,
      }),
    ).toBe(false)
    expect(releaseMcpRuntimeTestLease(db, firstToken)).toBe(true)

    db.update(mcpRuntimeTestTurns)
      .set({
        status: 'succeeded',
        captureState: 'complete',
        finishedAt: 4,
        durationMs: 2,
      })
      .where(eq(mcpRuntimeTestTurns.id, 'turn-1'))
      .run()
    db.insert(mcpRuntimeTestTurns)
      .values({
        id: 'turn-2',
        sessionId: 'test-session',
        seq: 2,
        clientMessageId: 'message-2',
        promptText: 'second',
        status: 'running',
        hardDeadlineAt: 600_005,
        captureState: 'live',
        startedAt: 6,
        createdAt: 5,
      })
      .run()
    db.update(mcpRuntimeTestSessions)
      .set({
        inFlightTurnId: 'turn-2',
        turnSeq: 2,
        sessionVersion: 2,
        nativeSessionState: 'ready',
        runtimeSessionId: 'native-session',
        updatedAt: 5,
      })
      .where(eq(mcpRuntimeTestSessions.id, 'test-session'))
      .run()

    expect(() =>
      preclaimMcpRuntimeTestResume(db, {
        ...immutable,
        identityDigest: D4,
        runtimeSessionId: 'native-session',
        turnId: 'turn-2',
        leaseNonceDigest: D2,
        leasedAt: 6,
      }),
    ).toThrow('execution-identity-control-failed')

    const resumed = preclaimMcpRuntimeTestResume(db, {
      ...immutable,
      runtimeSessionId: 'native-session',
      turnId: 'turn-2',
      leaseNonceDigest: D2,
      leasedAt: 6,
    })
    expect(resumed.leaseTurnId).toBe('turn-2')
    expect(
      confirmMcpRuntimeTestResume(db, {
        runtimeSessionId: 'native-session',
        testSessionId: 'test-session',
        turnId: 'turn-2',
        leaseNonceDigest: D2,
        projectId: 'project-1',
        reportedVersion: '1.0.1',
      }),
    ).toMatchObject({
      currentTurnId: 'turn-2',
      reportedVersion: '1.0.1',
    })
    expect(
      releaseMcpRuntimeTestLease(db, {
        runtimeSessionId: 'native-session',
        testSessionId: 'test-session',
        turnId: 'turn-2',
        leaseNonceDigest: D2,
      }),
    ).toBe(true)
  })
})
