// RFC-036 — patStore CRUD + lookup invariants.

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createPat, listPatsForUser, lookupActivePat, revokePat } from '../src/auth/patStore'
import { users } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedActiveUser(db: DbClient, id = '01HQPATUSR'): Promise<string> {
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

describe('patStore', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('createPat returns aws_pat_ token and stores hash + scopes JSON', async () => {
    const id = await seedActiveUser(db)
    const { token, meta } = await createPat({
      db,
      userId: id,
      name: 'ci-launcher',
      scopes: ['tasks:execute', 'agents:read'],
      purpose: 'general',
    })
    expect(token.startsWith('aws_pat_')).toBe(true)
    expect(token.length).toBe('aws_pat_'.length + 64)
    expect(meta.name).toBe('ci-launcher')
    expect(meta.scopes).toEqual(['tasks:execute', 'agents:read'])
  })

  test('lookupActivePat returns null for unknown / non-aws_pat_', async () => {
    await seedActiveUser(db)
    expect(await lookupActivePat(db, 'aws_pat_unknown')).toBe(null)
    expect(await lookupActivePat(db, 'aws_s_xxx')).toBe(null)
  })

  test('lookupActivePat returns null for expired PAT', async () => {
    const id = await seedActiveUser(db)
    const { token } = await createPat({
      db,
      userId: id,
      name: 'ci',
      expiresAt: 1_000,
      now: 0,
      purpose: 'general',
    })
    expect(await lookupActivePat(db, token, 2_000)).toBe(null)
  })

  test('lookupActivePat returns null after revoke', async () => {
    const id = await seedActiveUser(db)
    const { token, meta } = await createPat({ db, userId: id, name: 'ci', purpose: 'general' })
    expect(await lookupActivePat(db, token)).not.toBe(null)
    await revokePat(db, meta.id)
    expect(await lookupActivePat(db, token)).toBe(null)
  })

  test('lookupActivePat returns null when user is disabled', async () => {
    const id = await seedActiveUser(db)
    const { token } = await createPat({ db, userId: id, name: 'ci', purpose: 'general' })
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, id))
    expect(await lookupActivePat(db, token)).toBe(null)
  })

  test('lookupActivePat bumps last_used_at on each hit', async () => {
    const id = await seedActiveUser(db)
    const { token } = await createPat({
      db,
      userId: id,
      name: 'ci',
      now: 1_000,
      purpose: 'general',
    })
    await lookupActivePat(db, token, 5_000)
    const after = await listPatsForUser(db, id)
    expect(after[0]?.lastUsedAt).toBe(5_000)
  })

  test('listPatsForUser returns all PATs (revoked included for UI history)', async () => {
    const id = await seedActiveUser(db)
    const { meta: a } = await createPat({ db, userId: id, name: 'a', purpose: 'general' })
    await createPat({ db, userId: id, name: 'b', purpose: 'general' })
    await revokePat(db, a.id)
    const list = await listPatsForUser(db, id)
    expect(list.length).toBe(2)
  })

  test('scopes JSON malformed → empty scopes (no crash)', async () => {
    const id = await seedActiveUser(db)
    const { token } = await createPat({ db, userId: id, name: 'ci', purpose: 'general' })
    const { userPats } = await import('../src/db/schema')
    // Manually corrupt the row.
    await db.update(userPats).set({ scopesJson: '{not-json' }).where(eq(userPats.userId, id))
    const resolved = await lookupActivePat(db, token)
    expect(resolved?.scopes).toEqual([])
  })
})
