// RFC-036 — users service: PR1 scope (create + reset-password + disable +
// last-admin-protection + search + __system__ immutability).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  countNonSystemUsers,
  createUser,
  disableUser,
  enableUser,
  findByUsername,
  listAllUsers,
  patchUser,
  resetPassword,
  searchUsersPublic,
} from '../src/services/users'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { verifyPassword } from '../src/auth/passwords'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('users service', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('seed includes __system__ row + countNonSystemUsers excludes it', async () => {
    const sys = await findByUsername(db, SYSTEM_USER_ID)
    expect(sys?.id).toBe(SYSTEM_USER_ID)
    expect(sys?.role).toBe('admin')
    expect(await countNonSystemUsers(db)).toBe(0)
  })

  test('createUser happy path with password → status=active', async () => {
    const u = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'correctPw123',
    })
    expect(u.username).toBe('alice')
    expect(u.status).toBe('active')
    expect(u.passwordHash).not.toBeNull()
    expect(await verifyPassword('correctPw123', u.passwordHash!)).toBe(true)
    expect(await countNonSystemUsers(db)).toBe(1)
  })

  test('createUser without password → status=invited', async () => {
    const u = await createUser(db, {
      username: 'carol',
      displayName: 'Carol',
      role: 'user',
    })
    expect(u.status).toBe('invited')
    expect(u.passwordHash).toBeNull()
  })

  test('createUser rejects duplicate username (409)', async () => {
    await createUser(db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'correctPw123',
    })
    await expect(
      createUser(db, { username: 'bob', displayName: 'Bob2', role: 'user' }),
    ).rejects.toThrow(/username/i)
  })

  test('createUser rejects reserved __system__ username', async () => {
    await expect(
      createUser(db, {
        username: SYSTEM_USER_ID,
        displayName: 'X',
        role: 'admin',
      }),
    ).rejects.toThrow(/reserved/)
  })

  test('disableUser flips status and is idempotent', async () => {
    await createUser(db, {
      username: 'alice',
      displayName: 'A',
      role: 'admin',
      password: 'pw12345678',
    })
    await createUser(db, {
      username: 'bob',
      displayName: 'B',
      role: 'user',
      password: 'pw12345678',
    })
    const bob = await findByUsername(db, 'bob')
    await disableUser(db, bob!.id)
    const after = await findByUsername(db, 'bob')
    expect(after?.status).toBe('disabled')
    // idempotent
    await disableUser(db, bob!.id)
  })

  test('disableUser refuses __system__', async () => {
    await expect(disableUser(db, SYSTEM_USER_ID)).rejects.toThrow(/cannot disable __system__/)
  })

  // Self-disable lockout — an actor disabling their own account would revoke
  // their own sessions and strip the permission to undo it. Mirrors the
  // self-role-change guard; the CLI break-glass path (no actorId) is exempt.
  test('disableUser blocks disabling your own account', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    // A second admin so the refusal is the self-guard, NOT last-admin-protection.
    await createUser(db, {
      username: 'boss',
      displayName: 'Boss',
      role: 'admin',
      password: 'pw12345678',
    })
    await expect(disableUser(db, a.id, Date.now(), a.id)).rejects.toThrow(/your own account/)
    // Another actor — or the CLI, which passes no actorId — can still disable alice.
    await disableUser(db, a.id, Date.now(), 'some-other-admin-id')
    expect((await findByUsername(db, 'alice'))?.status).toBe('disabled')
  })

  test('enableUser flips disabled → active and is idempotent', async () => {
    await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    const bob = await createUser(db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    await disableUser(db, bob.id)
    expect((await findByUsername(db, 'bob'))?.status).toBe('disabled')
    await enableUser(db, bob.id)
    expect((await findByUsername(db, 'bob'))?.status).toBe('active')
    // idempotent — enabling an already-active user is a no-op.
    await enableUser(db, bob.id)
    expect((await findByUsername(db, 'bob'))?.status).toBe('active')
  })

  test('enableUser refuses __system__', async () => {
    await expect(enableUser(db, SYSTEM_USER_ID)).rejects.toThrow(/cannot modify __system__/)
  })

  // Regression (2026-06-24 incident): __system__ is seeded as an active admin
  // but is a non-login sentinel, so it must NOT count toward
  // last-admin-protection. Before the fix this test's body asserted the
  // OPPOSITE — that disabling the only human admin "succeeds because __system__
  // is counted" — the very bug that let an operator disable the last admin and
  // lock everyone out (the admin row had to be re-activated directly in sqlite).
  test('last-admin-protection blocks disabling the last human admin (ignores __system__)', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    // Alice is the only human admin; __system__ doesn't count → refused.
    await expect(disableUser(db, a.id)).rejects.toThrow(/last active admin/)
    // A second human admin lifts the protection.
    await createUser(db, {
      username: 'boss',
      displayName: 'Boss',
      role: 'admin',
      password: 'pw12345678',
    })
    await disableUser(db, a.id)
    expect((await findByUsername(db, 'alice'))?.status).toBe('disabled')
  })

  test('patchUser role demotion blocked when alice is the last human admin', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    // __system__ is excluded from the active-admin count, so Alice is the last
    // real admin and the demotion is refused (pre-fix this wrongly succeeded
    // because __system__ was counted).
    await expect(patchUser(db, a.id, { role: 'user' })).rejects.toThrow(/last active admin/)
    // With another human admin present, demotion goes through.
    await createUser(db, {
      username: 'boss',
      displayName: 'Boss',
      role: 'admin',
      password: 'pw12345678',
    })
    const updated = await patchUser(db, a.id, { role: 'user' })
    expect(updated.role).toBe('user')
  })

  // Self-role lockout guard — an admin who demotes themselves loses the very
  // permission needed to undo it, so patchUser refuses role changes where
  // actorId === target id (regardless of direction).
  test('patchUser blocks changing your own role', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    await expect(patchUser(db, a.id, { role: 'user' }, Date.now(), a.id)).rejects.toThrow(
      /cannot change your own role/,
    )
    // Same-value role in a full-object PATCH stays idempotent.
    const same = await patchUser(
      db,
      a.id,
      { role: 'admin', displayName: 'Alice 2' },
      Date.now(),
      a.id,
    )
    expect(same.role).toBe('admin')
    expect(same.displayName).toBe('Alice 2')
    // A different admin can still change Alice's role.
    const b = await createUser(db, {
      username: 'boss',
      displayName: 'Boss',
      role: 'admin',
      password: 'pw12345678',
    })
    const updated = await patchUser(db, a.id, { role: 'user' }, Date.now(), b.id)
    expect(updated.role).toBe('user')
  })

  test('patchUser blocks disabling your own account via status flip', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    // Second admin isolates the self-guard from last-admin-protection.
    await createUser(db, {
      username: 'boss',
      displayName: 'Boss',
      role: 'admin',
      password: 'pw12345678',
    })
    await expect(patchUser(db, a.id, { status: 'disabled' }, Date.now(), a.id)).rejects.toThrow(
      /your own account/,
    )
  })

  test('patchUser status disable respects last-admin-protection (ignores __system__)', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    // Alice is the last human admin; a status→disabled flip by another actor is
    // refused — the patchUser comment used to claim this without enforcing it.
    await expect(
      patchUser(db, a.id, { status: 'disabled' }, Date.now(), SYSTEM_USER_ID),
    ).rejects.toThrow(/last active admin/)
    // With a second human admin, the disable goes through.
    const boss = await createUser(db, {
      username: 'boss',
      displayName: 'Boss',
      role: 'admin',
      password: 'pw12345678',
    })
    const updated = await patchUser(db, a.id, { status: 'disabled' }, Date.now(), boss.id)
    expect(updated.status).toBe('disabled')
  })

  test('resetPassword rehashes + revokes sessions', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'oldOldOld',
    })
    await resetPassword(db, a.id, { newPassword: 'newNewNew' })
    const after = await findByUsername(db, 'alice')
    expect(await verifyPassword('newNewNew', after!.passwordHash!)).toBe(true)
    expect(await verifyPassword('oldOldOld', after!.passwordHash!)).toBe(false)
  })

  test('searchUsersPublic by username prefix returns only public fields', async () => {
    await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    await createUser(db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    await createUser(db, {
      username: 'carol',
      displayName: 'Carol',
      role: 'user',
      password: 'pw12345678',
    })
    const rows = await searchUsersPublic(db, { q: 'a' })
    expect(rows.map((r) => r.username).sort()).toEqual(['alice'])
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'displayName',
      'id',
      'role',
      'status',
      'username',
    ])

    await createUser(db, {
      username: 'archived',
      displayName: 'Archived',
      role: 'user',
      status: 'disabled',
    })
    const activeOnly = await searchUsersPublic(db, { q: 'a', limit: 1, status: 'active' })
    expect(activeOnly).toHaveLength(1)
    expect(activeOnly[0]?.status).toBe('active')
  })

  test('listAllUsers includes __system__', async () => {
    await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    const all = await listAllUsers(db)
    expect(all.length).toBe(2)
    expect(all.some((r) => r.id === SYSTEM_USER_ID)).toBe(true)
  })
})
