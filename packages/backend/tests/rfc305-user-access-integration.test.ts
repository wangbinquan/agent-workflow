// RFC-305 integration lock: role/grants/revision/audit are one transaction;
// current session/PAT authority is rebuilt from that state on every request.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  grantableAdditionalPermissions,
  PERMISSIONS,
  type Permission,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  composeIdentityAccess,
  type IdentityAccessFixtureRuntime,
} from '../src/modules/identity-access/composition'
import { UpdateUserAccess } from '../src/modules/identity-access/application/commands/updateUserAccess'
import {
  subjectRefOf,
  trustedContextMetadata,
} from '../src/modules/identity-access/application/operationContext'
import { IdentityAccessObservability } from '../src/modules/identity-access/infrastructure/identityAccessObservability'
import { SQLiteUserAccessTransactionRunner } from '../src/modules/identity-access/infrastructure/sqliteUserAccessRepository'
import { createUser, patchUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'
import { createPat } from '../src/auth/patStore'
import { resolveActor } from '../src/auth/session'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-305 identity-access integration', () => {
  let db: DbClient
  let identityAccess: IdentityAccessFixtureRuntime
  let delegatedAttempt: number

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    identityAccess = composeIdentityAccess(db)
    delegatedAttempt = 0
  })

  async function resolveInheritedActor(userId: string) {
    delegatedAttempt += 1
    return (
      (
        await identityAccess.delegatedRequests.forCall({
          kind: 'call-workflow',
          ownerUserId: userId,
          parentTaskId: 'rfc305-parent-task',
          parentNodeRunId: `rfc305-parent-node-${delegatedAttempt}`,
        })
      )?.actor ?? null
    )
  }

  async function fixture(): Promise<{
    adminId: string
    userId: string
    update: (
      expectedRevision: number,
      additionalPermissions: Permission[],
      role?: 'admin' | 'manager' | 'user',
    ) => Promise<void>
  }> {
    const admin = await createUser(db, {
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const user = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const module = identityAccess
    return {
      adminId: admin.id,
      userId: user.id,
      update: async (expectedRevision, additionalPermissions, role = 'user') => {
        const context = module.contexts.fromAuthenticatedPrincipal(
          { userId: admin.id, source: 'session' },
          'http',
          1_000 + expectedRevision,
        )
        await module.updateUserAccess.execute(context, {
          targetUserId: user.id,
          access: { role, additionalPermissions, expectedRevision },
        })
      },
    }
  }

  test('exact update advances revision once, preserves no-op, and rejects stale overwrite', async () => {
    const f = await fixture()
    await f.update(0, ['scripts:author'])

    const row = db.$client
      .query('SELECT role, access_revision FROM users WHERE id = ?')
      .get(f.userId) as { role: string; access_revision: number }
    expect(row).toEqual({ role: 'user', access_revision: 1 })
    expect(
      db.$client
        .query('SELECT permission FROM user_permission_grants WHERE user_id = ?')
        .all(f.userId),
    ).toEqual([{ permission: 'scripts:author' }])

    const beforeAudit = auditCount(db, f.userId)
    await f.update(1, ['scripts:author'])
    expect(auditCount(db, f.userId)).toBe(beforeAudit)
    expect(
      db.$client.query('SELECT access_revision FROM users WHERE id = ?').get(f.userId),
    ).toEqual({ access_revision: 1 })

    await expect(f.update(0, [])).rejects.toMatchObject({
      code: 'user-access-stale',
      kind: 'conflict',
    })
    expect(
      db.$client
        .query('SELECT permission FROM user_permission_grants WHERE user_id = ?')
        .all(f.userId),
    ).toEqual([{ permission: 'scripts:author' }])
  })

  test('same-revision concurrent administrators produce one commit and one conflict', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([
      f.update(0, ['scripts:author']),
      f.update(0, ['repos:update']),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      reason: { code: 'user-access-stale', kind: 'conflict' },
    })
    expect(
      db.$client.query('SELECT access_revision FROM users WHERE id = ?').get(f.userId),
    ).toEqual({ access_revision: 1 })
    expect(auditCountAtRevision(db, f.userId, 1)).toBe(1)
  })

  test('audit failure rolls back role, grants and revision as one unit', async () => {
    const f = await fixture()
    db.$client.exec(`
      CREATE TRIGGER rfc305_fail_audit
      BEFORE INSERT ON user_access_audit
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;
    `)

    await expect(f.update(0, ['scripts:author'])).rejects.toThrow()
    expect(
      db.$client.query('SELECT role, access_revision FROM users WHERE id = ?').get(f.userId),
    ).toEqual({ role: 'user', access_revision: 0 })
    // RFC-312 —— 新建 user/manager 默认拿到一条 `users:presence` grant（建号时发放，可按账号收回），
    // 所以回滚的目标态不是空集，而是建号完成态。本用例锁的是**原子性**，不是集合内容。
    expect(
      db.$client
        .query('SELECT permission FROM user_permission_grants WHERE user_id = ?')
        .all(f.userId),
    ).toEqual([{ permission: 'users:presence' }])
  })

  test('post-commit targeted refresh failure is observable without rolling back access', async () => {
    const f = await fixture()
    const observer = new IdentityAccessObservability()
    const update = new UpdateUserAccess({
      transactions: new SQLiteUserAccessTransactionRunner(db),
      auditId: () => 'audit-targeted-refresh-failure',
      systemUserId: '__system__',
      events: {
        authorityRevisionChanged(): void {
          throw new Error('websocket registry unavailable')
        },
      },
      observer,
    })
    const context = identityAccess.contexts.fromAuthenticatedPrincipal(
      { userId: f.adminId, source: 'session' },
      'http',
      1_500,
    )

    const result = await update.execute(context, {
      targetUserId: f.userId,
      access: {
        role: 'user',
        additionalPermissions: ['scripts:author'],
        expectedRevision: 0,
      },
    })

    expect(result).toMatchObject({ changed: true, accessChanged: true })
    expect(grantsFor(db, f.userId)).toEqual(['scripts:author'])
    expect(
      db.$client.query('SELECT access_revision FROM users WHERE id = ?').get(f.userId),
    ).toEqual({ access_revision: 1 })
    expect(auditCountAtRevision(db, f.userId, 1)).toBe(1)
    expect(observer.snapshot()).toEqual({
      accessUpdate: { success: 1, noOp: 0, conflict: 0, rejected: 0 },
      authorityReresolution: 0,
      invalidStoredGrant: 0,
      wsTargetedRefreshFailure: 1,
    })
  })

  test('unknown stored rows fail closed while every catalog grant resolves', async () => {
    const f = await fixture()
    db.$client
      .query(
        'INSERT INTO user_permission_grants ' +
          '(user_id, permission, granted_by_user_id, granted_at) VALUES (?, ?, ?, ?)',
      )
      .run(f.userId, 'settings:write', f.adminId, 1)
    db.$client
      .query(
        'INSERT INTO user_permission_grants ' +
          '(user_id, permission, granted_by_user_id, granted_at) VALUES (?, ?, ?, ?)',
      )
      .run(f.userId, 'future:unknown', f.adminId, 1)
    db.$client
      .query(
        'INSERT INTO user_permission_grants ' +
          '(user_id, permission, granted_by_user_id, granted_at) VALUES (?, ?, ?, ?)',
      )
      .run(f.userId, 'scripts:author', f.adminId, 1)

    const current = await identityAccess.resolveAuthority.execute(f.userId)
    // RFC-312 —— 新建 user/manager 默认拿到一条 `users:presence` grant（建号时发放，可按账号收回），故此处多一项。
    expect(current?.additionalPermissions).toEqual([
      'users:presence',
      'settings:write',
      'scripts:author',
    ])
  })

  test('session and existing PAT gain/revoke only their current account cap', async () => {
    const f = await fixture()
    const session = await createSession({ db, userId: f.userId })
    const pat = await createPat({
      db,
      userId: f.userId,
      name: 'automation',
      purpose: 'general',
      scopes: ['repos:update', 'scripts:author'],
    })
    const daemon = Buffer.from('daemon-not-used')

    const beforeSession = await resolveActor(db, session.token, daemon, identityAccess)
    const beforePat = await resolveActor(db, pat.token, daemon, identityAccess)
    expect(beforeSession?.permissions.has('repos:update')).toBe(false)
    expect(beforePat?.permissions.has('repos:update')).toBe(false)

    await f.update(0, ['repos:update', 'scripts:author'])
    const grantedSession = await resolveActor(db, session.token, daemon, identityAccess)
    const grantedPat = await resolveActor(db, pat.token, daemon, identityAccess)
    expect(grantedSession?.permissions.has('repos:update')).toBe(true)
    expect(grantedSession?.permissions.has('scripts:author')).toBe(true)
    expect(grantedPat?.permissions.has('repos:update')).toBe(true)
    expect(grantedPat?.permissions.has('scripts:author')).toBe(false)
    expect(grantedSession?.authorityRevision).toBe(1)

    await f.update(1, [])
    const revokedSession = await resolveActor(db, session.token, daemon, identityAccess)
    const revokedPat = await resolveActor(db, pat.token, daemon, identityAccess)
    expect(revokedSession?.permissions.has('repos:update')).toBe(false)
    expect(revokedPat?.permissions.has('repos:update')).toBe(false)
    expect(revokedSession?.authorityRevision).toBe(2)
  })

  test('a user preset plus every explicit grant has the full catalog without a role bypass', async () => {
    const f = await fixture()
    const grants = grantableAdditionalPermissions('user')
    // RFC-304 made it 27 by adding the three DEPARTMENT-layer write points as
    // preset differences. RFC-309 merged the template layers and put the single
    // write point in the USER BASELINE, so those three stopped being
    // differences: 78 catalog points − 54 baseline = 24.
    //
    // What a user still cannot do without a grant is author SCRIPTS — which is
    // a field inside a template rather than a template verb, and is still in
    // this list as `scripts:author`.
    // RFC-310 +1：repository-employee-assignments:update（manager 档差集）；
    // PR-9 +1：development-missions:cutover（admin 档 runbook 点）。
    // RFC-312 +1：`users:presence` 不进 user 静态 preset（进了就永远收不回来），故成为差集项。
    expect(grants).toHaveLength(27)
    await f.update(0, [...grants])

    const actor = await resolveInheritedActor(f.userId)
    expect(actor).not.toBeNull()
    expect(actor!.user.role).toBe('user')
    for (const permission of grants) expect(actor!.permissions.has(permission)).toBe(true)
    expect([...actor!.permissions].sort()).toEqual([...PERMISSIONS].sort())
    expect(actor!.permissions.has('resource-acl:bypass')).toBe(true)
    expect(actor!.permissions.has('users:write')).toBe(true)
    expect(actor!.authorityRevision).toBe(1)
  })

  test('invited and disabled accounts retain grants but cannot produce delegated authority', async () => {
    const f = await fixture()
    const invited = await createUser(db, {
      username: 'invited',
      displayName: 'Invited',
      role: 'user',
      additionalPermissions: ['scripts:author'],
      createdBy: f.adminId,
    })
    expect(invited.status).toBe('invited')
    expect(await resolveInheritedActor(invited.id)).toBeNull()
    expect(grantsFor(db, invited.id).sort()).toEqual(['scripts:author', 'users:presence'])

    await patchUser(db, invited.id, { status: 'active' }, 2_000, f.adminId)
    const active = await resolveInheritedActor(invited.id)
    expect(active?.permissions.has('scripts:author')).toBe(true)
    await patchUser(db, invited.id, { status: 'disabled' }, 2_001, f.adminId)
    expect(await resolveInheritedActor(invited.id)).toBeNull()
    expect(grantsFor(db, invited.id).sort()).toEqual(['scripts:author', 'users:presence'])
  })

  test('audit records actor, exact diff and revision without profile or credential values', async () => {
    const f = await fixture()
    await f.update(0, ['scripts:author'])
    await f.update(1, ['repos:update'])

    const row = db.$client
      .query('SELECT * FROM user_access_audit WHERE target_user_id = ? AND access_revision = 2')
      .get(f.userId) as Record<string, unknown>
    expect(row).toMatchObject({
      target_user_id: f.userId,
      actor_user_id: f.adminId,
      actor_kind: 'session',
      before_role: 'user',
      after_role: 'user',
      added_permissions_json: '["repos:update"]',
      removed_permissions_json: '["scripts:author"]',
      access_revision: 2,
    })
    expect(row.operation_id).toBeString()
    expect(row.correlation_id).toBe(row.operation_id)
    expect(Object.keys(row)).not.toContain('password_hash')
    expect(Object.keys(row)).not.toContain('display_name')
    expect(Object.keys(row)).not.toContain('email')
  })

  test('stale access keeps the co-submitted profile patch atomic', async () => {
    const f = await fixture()
    await f.update(0, ['scripts:author'])
    const module = identityAccess
    const stale = module.contexts.fromAuthenticatedPrincipal(
      { userId: f.adminId, source: 'session' },
      'http',
      2_000,
    )
    await expect(
      module.updateUserAccess.execute(stale, {
        targetUserId: f.userId,
        displayName: 'Must Not Commit',
        access: { role: 'user', additionalPermissions: [], expectedRevision: 0 },
      }),
    ).rejects.toMatchObject({ code: 'user-access-stale' })

    expect(
      db.$client
        .query('SELECT display_name, access_revision FROM users WHERE id = ?')
        .get(f.userId),
    ).toEqual({ display_name: 'Alice', access_revision: 1 })
    expect(grantsFor(db, f.userId)).toEqual(['scripts:author'])
    expect(auditCount(db, f.userId)).toBe(2) // create + the one committed update
  })

  test('legacy role writes replace the preset, canonicalize explicit grants and use the sole writer', async () => {
    const f = await fixture()
    await f.update(0, ['scripts:author', 'repos:update'])
    const module = identityAccess
    const promote = module.contexts.fromAuthenticatedPrincipal(
      { userId: f.adminId, source: 'session' },
      'http',
      3_000,
    )
    await module.updateUserAccess.execute(promote, {
      targetUserId: f.userId,
      legacyRole: 'manager',
    })
    expect(grantsFor(db, f.userId)).toEqual([])

    const downgrade = module.contexts.fromAuthenticatedPrincipal(
      { userId: f.adminId, source: 'session' },
      'http',
      3_001,
    )
    await module.updateUserAccess.execute(downgrade, {
      targetUserId: f.userId,
      legacyRole: 'user',
    })
    const actor = await resolveInheritedActor(f.userId)
    expect(actor?.user.role).toBe('user')
    expect(actor?.permissions.has('scripts:author')).toBe(false)
    expect(actor?.permissions.has('repos:update')).toBe(false)
    expect(
      db.$client.query('SELECT access_revision FROM users WHERE id = ?').get(f.userId),
    ).toEqual({ access_revision: 3 })
  })

  test('exact replace preserves metadata for an unchanged grant', async () => {
    const f = await fixture()
    await f.update(0, ['scripts:author', 'repos:update'])
    const before = db.$client
      .query(
        'SELECT granted_by_user_id, granted_at FROM user_permission_grants ' +
          'WHERE user_id = ? AND permission = ?',
      )
      .get(f.userId, 'scripts:author')
    await f.update(1, ['scripts:author'])
    const after = db.$client
      .query(
        'SELECT granted_by_user_id, granted_at FROM user_permission_grants ' +
          'WHERE user_id = ? AND permission = ?',
      )
      .get(f.userId, 'scripts:author')
    expect(after).toEqual(before)
  })

  test('invalid create and audit failure leave no user, grant or audit residue', async () => {
    const f = await fixture()
    const module = identityAccess
    const context = module.contexts.fromAuthenticatedPrincipal(
      { userId: f.adminId, source: 'session' },
      'http',
      4_000,
    )
    const beforeUsers = tableCount(db, 'users')
    const beforeAudits = tableCount(db, 'user_access_audit')
    await expect(
      module.createManagedUser.execute(context, {
        id: 'invalid-create',
        username: 'invalid-create',
        email: null,
        displayName: 'Invalid Create',
        passwordHash: 'hash',
        role: 'user',
        status: 'active',
        forcePasswordChange: false,
        createdBy: f.adminId,
        schemaVersion: 1,
        additionalPermissions: ['account:self'],
      }),
    ).rejects.toMatchObject({ code: 'user-permission-not-grantable' })
    expect(tableCount(db, 'users')).toBe(beforeUsers)
    expect(tableCount(db, 'user_access_audit')).toBe(beforeAudits)

    db.$client.exec(`
      CREATE TRIGGER rfc305_fail_create_audit
      BEFORE INSERT ON user_access_audit
      BEGIN
        SELECT RAISE(ABORT, 'create audit unavailable');
      END;
    `)
    await expect(
      module.createManagedUser.execute(context, {
        id: 'audit-failed-create',
        username: 'audit-failed-create',
        email: null,
        displayName: 'Audit Failed Create',
        passwordHash: 'hash',
        role: 'user',
        status: 'active',
        forcePasswordChange: false,
        createdBy: f.adminId,
        schemaVersion: 1,
        additionalPermissions: ['scripts:author'],
      }),
    ).rejects.toThrow()
    expect(tableCount(db, 'users')).toBe(beforeUsers)
    expect(grantsFor(db, 'audit-failed-create')).toEqual([])
    expect(tableCount(db, 'user_access_audit')).toBe(beforeAudits)
  })

  test('delegated source factory mints current opaque contexts with stable attempt identity', async () => {
    const f = await fixture()
    const module = identityAccess
    const first = await module.delegatedRequests.forSchedule({
      ownerUserId: f.userId,
      scheduleId: 'schedule-1',
      invocation: { kind: 'automatic', occurrenceAt: 1_700_000_000_000 },
    })
    const retried = await module.delegatedRequests.forSchedule({
      ownerUserId: f.userId,
      scheduleId: 'schedule-1',
      invocation: { kind: 'automatic', occurrenceAt: 1_700_000_000_000 },
    })
    expect(first).not.toBeNull()
    expect(retried).not.toBeNull()
    expect(first!.context.operationId).not.toBe(retried!.context.operationId)
    expect(first!.context).toHaveProperty('idempotencyKey')
    expect(retried!.context).toHaveProperty('idempotencyKey')
    expect((first!.context as { readonly idempotencyKey: string }).idempotencyKey).toBe(
      (retried!.context as { readonly idempotencyKey: string }).idempotencyKey,
    )
    expect(subjectRefOf(first!.context.authority).userId).toBe(f.userId)
    expect(trustedContextMetadata(first!.context)).toEqual({
      source: 'schedule',
      transport: 'delegated',
    })

    await patchUser(db, f.userId, { status: 'disabled' }, 4_001, f.adminId)
    expect(
      await module.delegatedRequests.forSchedule({
        ownerUserId: f.userId,
        scheduleId: 'schedule-1',
        invocation: { kind: 'manual' },
      }),
    ).toBeNull()
  })

  test('diagnostics count update outcomes, re-resolution and invalid stored grants', async () => {
    const f = await fixture()
    const module = identityAccess
    await f.update(0, ['scripts:author'])
    await f.update(1, ['scripts:author'])
    await expect(f.update(0, [])).rejects.toMatchObject({ code: 'user-access-stale' })
    await expect(f.update(1, ['account:self'])).rejects.toMatchObject({
      code: 'user-permission-not-grantable',
    })

    await module.resolveAuthority.execute(f.userId)
    db.$client
      .query(
        'INSERT INTO user_permission_grants ' +
          '(user_id, permission, granted_by_user_id, granted_at) VALUES (?, ?, ?, ?)',
      )
      .run(f.userId, 'future:unknown', f.adminId, 1)
    await module.resolveAuthority.execute(f.userId)

    expect(module.diagnostics.snapshot()).toEqual({
      accessUpdate: { success: 1, noOp: 1, conflict: 1, rejected: 1 },
      authorityReresolution: 2,
      invalidStoredGrant: 1,
      wsTargetedRefreshFailure: 0,
    })
  })
})

function auditCount(db: DbClient, userId: string): number {
  const row = db.$client
    .query('SELECT COUNT(*) AS count FROM user_access_audit WHERE target_user_id = ?')
    .get(userId) as { count: number }
  return row.count
}

function auditCountAtRevision(db: DbClient, userId: string, revision: number): number {
  const row = db.$client
    .query(
      'SELECT COUNT(*) AS count FROM user_access_audit ' +
        'WHERE target_user_id = ? AND access_revision = ?',
    )
    .get(userId, revision) as { count: number }
  return row.count
}

function grantsFor(db: DbClient, userId: string): string[] {
  return (
    db.$client
      .query('SELECT permission FROM user_permission_grants WHERE user_id = ? ORDER BY permission')
      .all(userId) as Array<{ permission: string }>
  ).map((row) => row.permission)
}

function tableCount(db: DbClient, table: 'users' | 'user_access_audit'): number {
  const row = db.$client.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number
  }
  return row.count
}
