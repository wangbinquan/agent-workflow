// RFC-036 — sessionStore CRUD + lookup invariants.

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createLoginSession,
  createSession,
  hashToken,
  listActiveSessionsForUser,
  lookupActiveSession,
  revokeAllSessionsForUser,
  revokeSession,
  SESSION_DEFAULT_TTL_MS,
} from '../src/auth/sessionStore'
import { users } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedActiveUser(db: DbClient, id = '01HQUSER'): Promise<string> {
  await db.insert(users).values({
    id,
    username: id.toLowerCase(),
    email: `${id.toLowerCase()}@example.com`,
    displayName: id,
    passwordHash: null,
    role: 'user',
    status: 'active',
    forcePasswordChange: false,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
    lastLoginAt: null,
    schemaVersion: 1,
  })
  return id
}

describe('sessionStore', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('createSession returns aws_s_ token and stores its hash', async () => {
    const userId = await seedActiveUser(db)
    const { token, session } = await createSession({ db, userId })
    expect(token.startsWith('aws_s_')).toBe(true)
    expect(token.length).toBe('aws_s_'.length + 64)
    expect(session.userId).toBe(userId)
    expect(session.expiresAt - session.createdAt).toBe(SESSION_DEFAULT_TTL_MS)
    // confirm only the hash is in the row, not the raw token
    const stored = await lookupRawHash(db, token)
    expect(stored).toBe(true)
    expect(db.select().from(users).where(idEq(userId)).get()?.lastLoginAt).toBeNull()
  })

  test('createLoginSession atomically stamps the authenticated user', async () => {
    const userId = await seedActiveUser(db)
    const { token, session } = createLoginSession({
      db,
      userId,
      userAgent: 'oidc-test',
      now: 12_345,
    })

    expect(await lookupRawHash(db, token)).toBe(true)
    expect(session).toMatchObject({
      userId,
      userAgent: 'oidc-test',
      createdAt: 12_345,
      lastUsedAt: 12_345,
    })
    expect(db.select().from(users).where(idEq(userId)).get()?.lastLoginAt).toBe(12_345)
  })

  test('lookupActiveSession returns null for unknown token', async () => {
    await seedActiveUser(db)
    expect(await lookupActiveSession(db, 'aws_s_unknown')).toBe(null)
  })

  test('lookupActiveSession returns null for non-aws_s_ prefix', async () => {
    await seedActiveUser(db)
    const { token } = await createSession({ db, userId: '01HQUSER' })
    // strip prefix to break recognition
    expect(await lookupActiveSession(db, token.slice('aws_s_'.length))).toBe(null)
  })

  test('lookupActiveSession returns null when user is disabled', async () => {
    const id = await seedActiveUser(db)
    const { token } = await createSession({ db, userId: id })
    await db.update(users).set({ status: 'disabled' }).where(idEq(id))
    expect(await lookupActiveSession(db, token)).toBe(null)
  })

  test('lookupActiveSession bumps last_used_at on each hit', async () => {
    const id = await seedActiveUser(db)
    const { token } = await createSession({ db, userId: id, now: 1_000 })
    const first = await lookupActiveSession(db, token, 5_000)
    expect(first?.session.lastUsedAt).toBe(5_000)
    const second = await lookupActiveSession(db, token, 7_500)
    expect(second?.session.lastUsedAt).toBe(7_500)
  })

  test('expired session returns null', async () => {
    const id = await seedActiveUser(db)
    const { token } = await createSession({ db, userId: id, ttlMs: 1_000, now: 0 })
    expect(await lookupActiveSession(db, token, 2_000)).toBe(null)
  })

  test('revokeSession invalidates the session immediately', async () => {
    const id = await seedActiveUser(db)
    const { token, session } = await createSession({ db, userId: id })
    expect(await lookupActiveSession(db, token)).not.toBe(null)
    await revokeSession(db, session.id, Date.now())
    expect(await lookupActiveSession(db, token)).toBe(null)
  })

  test('revokeAllSessionsForUser nukes every session for the user', async () => {
    const id = await seedActiveUser(db)
    await createSession({ db, userId: id })
    await createSession({ db, userId: id })
    await createSession({ db, userId: id })
    const before = await listActiveSessionsForUser(db, id)
    expect(before.length).toBe(3)
    await revokeAllSessionsForUser(db, id)
    const after = await listActiveSessionsForUser(db, id)
    expect(after.length).toBe(0)
  })
})

async function lookupRawHash(db: DbClient, raw: string): Promise<boolean> {
  // Look directly at user_sessions to confirm only the hash was persisted.
  const { userSessions } = await import('../src/db/schema')
  const rows = (await db.select().from(userSessions)) as { tokenHash: string }[]
  return rows.some((r) => r.tokenHash === hashToken(raw))
}

function idEq(id: string) {
  return eq(users.id, id)
}
