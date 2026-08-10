import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor, SYSTEM_USER_ID } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { mcps, mcpRuntimeTestSessions, resourceGrants, runtimes, users } from '../src/db/schema'
import { deleteMcp, getMcpById, updateMcp } from '../src/services/mcp'
import {
  deletePreparedMcpRuntimeTestsInTx,
  transitionMcpAclRuntimeTestsInTx,
} from '../src/services/mcpRuntimeTestTransitions'
import { updateResourceAcl } from '../src/services/resourceAcl'
import {
  invalidateInheritedRuntimeProbeReceipts,
  updateRuntime,
} from '../src/services/runtimeRegistry'
import { disableUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HASH = 'a'.repeat(64)

const admin = buildActor({
  user: {
    id: SYSTEM_USER_ID,
    username: SYSTEM_USER_ID,
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
})

function insertUser(db: DbClient, id: string): void {
  db.insert(users)
    .values({
      id,
      username: id,
      displayName: id,
      role: 'user',
      status: 'active',
      forcePasswordChange: false,
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
}

function insertMcp(db: DbClient, ownerUserId = SYSTEM_USER_ID): void {
  db.insert(mcps)
    .values({
      id: 'mcp-1',
      name: 'fixture',
      description: 'before',
      type: 'remote',
      config: JSON.stringify({ url: 'https://example.test/mcp' }),
      enabled: true,
      ownerUserId,
      visibility: 'private',
      aclRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
}

function insertRuntime(
  db: DbClient,
  input: { name?: string; binaryPath?: string | null } = {},
): void {
  db.insert(runtimes)
    .values({
      id: `runtime-${input.name ?? 'opencode'}`,
      name: input.name ?? 'opencode',
      protocol: 'opencode',
      binaryPath: input.binaryPath === undefined ? '/mock/opencode' : input.binaryPath,
      model: 'openai/old-model',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
}

function insertIdleSession(
  db: DbClient,
  input: {
    id: string
    ownerUserId?: string
    runtimeName?: string
    runtimeRowId?: string
  },
): void {
  db.insert(mcpRuntimeTestSessions)
    .values({
      id: input.id,
      mcpId: 'mcp-1',
      ownerUserId: input.ownerUserId ?? SYSTEM_USER_ID,
      clientCreateId: `create-${input.id}`,
      clientCreateDigest: HASH,
      status: 'active',
      mcpConfigHash: HASH,
      runtimeRowId: input.runtimeRowId ?? 'runtime-opencode',
      runtimeName: input.runtimeName ?? 'opencode',
      runtimeProtocol: 'opencode',
      runtimeSnapshotJson: '{}',
      runtimeBinaryPath: '/mock/opencode',
      runtimeSessionId: `native-${input.id}`,
      nativeSessionState: 'ready',
      turnSeq: 1,
      sessionVersion: 1,
      idleDeadlineAt: 600_001,
      scratchRoot: `/tmp/${input.id}`,
      cleanupState: 'not-started',
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
}

function lifecycle(db: DbClient, id: string) {
  return db
    .select({
      status: mcpRuntimeTestSessions.status,
      endReason: mcpRuntimeTestSessions.endReason,
      blocked: mcpRuntimeTestSessions.continuationBlockedReason,
    })
    .from(mcpRuntimeTestSessions)
    .where(eq(mcpRuntimeTestSessions.id, id))
    .get()
}

describe('RFC-238 canonical mutation lifecycle transitions', () => {
  test('MCP update and session invalidation roll back as one transaction', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    insertMcp(db)
    insertIdleSession(db, { id: 'session-rollback' })
    db.$client.exec(`
      CREATE TRIGGER fail_rfc238_transition
      BEFORE UPDATE ON mcp_runtime_test_sessions
      BEGIN
        SELECT RAISE(ABORT, 'forced transition failure');
      END;
    `)

    await expect(updateMcp(db, 'mcp-1', { description: 'after' })).rejects.toThrow(
      'forced transition failure',
    )
    expect((await getMcpById(db, 'mcp-1'))?.description).toBe('before')
    expect(lifecycle(db, 'session-rollback')).toMatchObject({
      status: 'active',
      endReason: null,
      blocked: null,
    })
  })

  test('final MCP delete and prepared transcript teardown roll back together', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    insertMcp(db)
    insertIdleSession(db, { id: 'session-delete-rollback' })
    db.update(mcpRuntimeTestSessions)
      .set({
        status: 'ended',
        endReason: 'user',
        idleDeadlineAt: null,
        cleanupState: 'complete',
        endedAt: 2,
        updatedAt: 2,
      })
      .where(eq(mcpRuntimeTestSessions.id, 'session-delete-rollback'))
      .run()
    db.$client.exec(`
      CREATE TRIGGER fail_rfc238_mcp_delete
      BEFORE DELETE ON mcps
      BEGIN
        SELECT RAISE(ABORT, 'forced MCP delete failure');
      END;
    `)
    const row = await getMcpById(db, 'mcp-1')
    if (row === null) throw new Error('MCP fixture missing')

    await expect(
      deleteMcp(db, row.id, admin, {
        existing: row,
        beforeDeleteInTx: (tx) => deletePreparedMcpRuntimeTestsInTx(tx, row.id),
      }),
    ).rejects.toThrow('forced MCP delete failure')
    expect(await getMcpById(db, row.id)).not.toBeNull()
    expect(lifecycle(db, 'session-delete-rollback')).toMatchObject({
      status: 'ended',
      endReason: 'user',
    })
  })

  test('MCP ACL revocation ends only lost viewers and blocks retained viewers', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    insertUser(db, 'owner-a')
    insertUser(db, 'viewer-b')
    insertMcp(db, 'owner-a')
    db.insert(resourceGrants)
      .values({
        resourceType: 'mcp',
        resourceId: 'mcp-1',
        userId: 'viewer-b',
        addedBy: SYSTEM_USER_ID,
        addedAt: 1,
      })
      .run()
    insertIdleSession(db, { id: 'session-owner', ownerUserId: 'owner-a' })
    insertIdleSession(db, { id: 'session-viewer', ownerUserId: 'viewer-b' })
    const row = await getMcpById(db, 'mcp-1')
    if (row === null) throw new Error('MCP fixture missing')

    await updateResourceAcl(
      db,
      admin,
      'mcp',
      row,
      {
        expectedResourceId: row.id,
        expectedAclRevision: 0,
        userIds: [],
      },
      {
        updatedAt: 2,
        afterWriteInTx: (tx, change) =>
          transitionMcpAclRuntimeTestsInTx(tx, {
            mcpId: change.resourceId,
            ownerUserId: change.ownerUserId,
            visibility: change.visibility,
            grantedUserIds: change.grantedUserIds,
            now: change.now,
          }),
      },
    )

    expect(lifecycle(db, 'session-owner')).toMatchObject({
      status: 'ending',
      endReason: 'mcp-config-changed',
      blocked: 'mcp-config-changed',
    })
    expect(lifecycle(db, 'session-viewer')).toMatchObject({
      status: 'ending',
      endReason: 'access-revoked',
    })
  })

  test('runtime profile, inherited binary, and user disable mutations persist end intent', async () => {
    {
      const db = createInMemoryDb(MIGRATIONS)
      insertMcp(db)
      insertRuntime(db)
      insertIdleSession(db, { id: 'session-profile' })
      await updateRuntime(db, 'opencode', { model: 'openai/new-model' })
      expect(lifecycle(db, 'session-profile')).toMatchObject({
        status: 'ending',
        endReason: 'runtime-profile-changed',
        blocked: 'runtime-profile-changed',
      })
    }

    {
      const db = createInMemoryDb(MIGRATIONS)
      insertMcp(db)
      insertRuntime(db, { binaryPath: null })
      insertIdleSession(db, { id: 'session-inherited' })
      await invalidateInheritedRuntimeProbeReceipts(db, ['opencode'])
      expect(lifecycle(db, 'session-inherited')).toMatchObject({
        status: 'ending',
        endReason: 'runtime-profile-changed',
        blocked: 'runtime-profile-changed',
      })
    }

    {
      const db = createInMemoryDb(MIGRATIONS)
      insertUser(db, 'viewer')
      insertMcp(db)
      insertIdleSession(db, { id: 'session-user', ownerUserId: 'viewer' })
      await disableUser(db, 'viewer', 2, SYSTEM_USER_ID)
      expect(lifecycle(db, 'session-user')).toMatchObject({
        status: 'ending',
        endReason: 'access-revoked',
      })
    }
  })
})
