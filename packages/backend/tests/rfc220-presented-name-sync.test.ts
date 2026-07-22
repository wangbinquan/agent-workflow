// RFC-220 T3 — D7 presented-name follow + provisioning atomicity
// (design §5.3/§6.2, locks §12 S7/S13/S14).
//
// The data-integrity invariants:
//   - Three-way snapshot merge: an in-app rename survives until the IdP-side
//     value actually CHANGES (never compared against displayName directly).
//   - Snapshot domain: '' = observed-but-absent sentinel (a newly provisioned
//     identity whose claim appears later must refresh), NULL = legacy row
//     (first sight records only — overwriting could clobber a pre-RFC-220
//     in-app rename).
//   - User row + identity row commit in ONE transaction; a write-time
//     subjectClaim mismatch rolls back BOTH (no identity-less active users,
//     no half-activated invites).

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { userIdentities, users } from '../src/db/schema'
import {
  bindInvitedUserWithIdentity,
  createIdentity,
  createUserWithIdentity,
  syncPreferredSnapshot,
} from '../src/services/userIdentities'
import { applyEmailTrust } from '../src/services/oidc/provisioning'
import { DomainError } from '../src/util/errors'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createOidcProvidersService } from '../src/services/oidcProviders'
import { randomBytes } from 'node:crypto'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function makeProvider(db: DbClient, subjectClaim: string | null = null) {
  const svc = createOidcProvidersService({ db, secretBox: createSecretBoxFromKey(randomBytes(32)) })
  return svc.create({
    slug: 'idp',
    displayName: 'IdP',
    issuerUrl: 'https://idp.test',
    clientId: 'c',
    clientSecret: 's',
    scopes: 'read',
    provisioning: 'auto',
    allowedEmailDomains: [],
    iconUrl: null,
    enabled: true,
    usernameClaim: 'login sig',
    subjectClaim,
  })
}

async function seedUser(db: DbClient, id: string, displayName: string) {
  await db.insert(users).values({
    id,
    username: `u-${id}`,
    email: null,
    displayName,
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
}

async function displayNameOf(db: DbClient, userId: string): Promise<string> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  return rows[0]!.displayName
}

async function snapshotOf(db: DbClient, providerId: string, subject: string) {
  const rows = await db.select().from(userIdentities).where(eq(userIdentities.providerId, providerId))
  return rows.find((r) => r.subject === subject) ?? null
}

describe('RFC-220 S14 — syncPreferredSnapshot', () => {
  let db: DbClient
  let providerId: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    providerId = (await makeProvider(db)).id
  })

  async function seedIdentity(snapshot: string | null) {
    await seedUser(db, 'u1', 'Original Name')
    await createIdentity(db, {
      userId: 'u1',
      providerId,
      subject: 's1',
      email: null,
      emailVerified: false,
      preferredSnapshot: snapshot,
    })
  }

  const baseArgs = {
    subject: 's1',
    userId: 'u1',
    emailVerified: false,
    usernameClaimConfigured: true,
  }

  test('unchanged snapshot → nothing moves (in-app rename survives)', async () => {
    await seedIdentity('zhang hello')
    // simulate an in-app rename after the last login
    await db.update(users).set({ displayName: 'My Custom Name' }).where(eq(users.id, 'u1'))
    const r = syncPreferredSnapshot(db, { ...baseArgs, providerId, composed: 'zhang hello' })
    expect(r.displayNameRefreshed).toBe(false)
    expect(await displayNameOf(db, 'u1')).toBe('My Custom Name')
  })

  test('changed IdP value → displayName + snapshot refresh together', async () => {
    await seedIdentity('zhang hello')
    const r = syncPreferredSnapshot(db, { ...baseArgs, providerId, composed: 'zhang 新签名' })
    expect(r.displayNameRefreshed).toBe(true)
    expect(await displayNameOf(db, 'u1')).toBe('zhang 新签名')
    expect((await snapshotOf(db, providerId, 's1'))!.preferredSnapshot).toBe('zhang 新签名')
    // the users.updatedAt stamp moved with it (same transaction)
    const row = await db.select().from(users).where(eq(users.id, 'u1')).limit(1)
    expect(row[0]!.updatedAt).toBeGreaterThan(0)
  })

  test('legacy NULL snapshot: first sight records only, never overwrites (存量保护)', async () => {
    await seedIdentity(null)
    const r = syncPreferredSnapshot(db, { ...baseArgs, providerId, composed: 'zhang hello' })
    expect(r.displayNameRefreshed).toBe(false)
    expect(await displayNameOf(db, 'u1')).toBe('Original Name')
    expect((await snapshotOf(db, providerId, 's1'))!.preferredSnapshot).toBe('zhang hello')
    // …and the SECOND login with a changed value does refresh
    const r2 = syncPreferredSnapshot(db, { ...baseArgs, providerId, composed: 'zhang 变了' })
    expect(r2.displayNameRefreshed).toBe(true)
    expect(await displayNameOf(db, 'u1')).toBe('zhang 变了')
  })

  test("'' sentinel: claim absent at creation, appearing later DOES refresh (哨兵锁)", async () => {
    await seedIdentity('')
    const r = syncPreferredSnapshot(db, { ...baseArgs, providerId, composed: 'zhang hello' })
    expect(r.displayNameRefreshed).toBe(true)
    expect(await displayNameOf(db, 'u1')).toBe('zhang hello')
  })

  test('IdP value disappearing tracks the snapshot but never clears the name', async () => {
    await seedIdentity('zhang hello')
    const r = syncPreferredSnapshot(db, { ...baseArgs, providerId, composed: null })
    expect(r.displayNameRefreshed).toBe(false)
    expect(await displayNameOf(db, 'u1')).toBe('Original Name')
    expect((await snapshotOf(db, providerId, 's1'))!.preferredSnapshot).toBe('')
  })

  test('usernameClaim not configured → D7 never runs (回归锁)', async () => {
    await seedIdentity('zhang hello')
    const r = syncPreferredSnapshot(db, {
      ...baseArgs,
      providerId,
      composed: 'zhang 变了',
      usernameClaimConfigured: false,
    })
    expect(r.displayNameRefreshed).toBe(false)
    expect(await displayNameOf(db, 'u1')).toBe('Original Name')
    expect((await snapshotOf(db, providerId, 's1'))!.preferredSnapshot).toBe('zhang hello')
  })

  test('email_verified follows normalized claims bidirectionally (S7 存量同步)', async () => {
    await seedIdentity('zhang hello')
    syncPreferredSnapshot(db, { ...baseArgs, providerId, composed: 'zhang hello', emailVerified: true })
    expect((await snapshotOf(db, providerId, 's1'))!.emailVerified).toBe(1)
    syncPreferredSnapshot(db, { ...baseArgs, providerId, composed: 'zhang hello', emailVerified: false })
    expect((await snapshotOf(db, providerId, 's1'))!.emailVerified).toBe(0)
  })
})

describe('RFC-220 S7 — applyEmailTrust', () => {
  const claims = { sub: 's', email: 'a@b.test', email_verified: false, name: null }
  test('four quadrants', () => {
    expect(applyEmailTrust(claims, true).email_verified).toBe(true)
    expect(applyEmailTrust(claims, false).email_verified).toBe(false)
    expect(applyEmailTrust({ ...claims, email: null }, true).email_verified).toBe(false)
    // already-verified stays verified regardless
    expect(applyEmailTrust({ ...claims, email_verified: true }, false).email_verified).toBe(true)
  })
})

describe('RFC-220 S13 — write-time subjectClaim revalidation + atomic provisioning', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('createIdentity refuses when provider.subjectClaim moved after the claims snapshot', async () => {
    const provider = await makeProvider(db, 'id')
    await seedUser(db, 'u1', 'X')
    const err = await createIdentity(db, {
      userId: 'u1',
      providerId: provider.id,
      subject: '42',
      email: null,
      emailVerified: false,
      expectedSubjectClaim: null, // callback resolved claims BEFORE the admin set 'id'
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('provider-config-changed')
    expect(await snapshotOf(db, provider.id, '42')).toBeNull()
  })

  test('createUserWithIdentity is atomic: a config mismatch leaves NO user row behind', async () => {
    const provider = await makeProvider(db, 'id')
    const before = (await db.select().from(users)).length
    const err = await createUserWithIdentity(db, {
      username: 'ghost',
      displayName: 'Ghost',
      email: null,
      identity: {
        providerId: provider.id,
        subject: '42',
        email: null,
        emailVerified: false,
        preferredSnapshot: '',
        expectedSubjectClaim: null, // stale snapshot → mismatch inside the tx
      },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('provider-config-changed')
    expect((await db.select().from(users)).length).toBe(before) // rolled back
    expect(await snapshotOf(db, provider.id, '42')).toBeNull()
  })

  test('bindInvitedUserWithIdentity is atomic: mismatch keeps the invite intact', async () => {
    const provider = await makeProvider(db, 'id')
    await db.insert(users).values({
      id: 'inv1',
      username: 'invited',
      email: 'inv@corp.test',
      displayName: 'Invited',
      passwordHash: null,
      role: 'user',
      status: 'invited',
      forcePasswordChange: false,
      createdBy: null,
      createdAt: 0,
      updatedAt: 0,
      lastLoginAt: null,
      schemaVersion: 1,
    })
    const err = await bindInvitedUserWithIdentity(db, {
      userId: 'inv1',
      identity: {
        providerId: provider.id,
        subject: '42',
        email: 'inv@corp.test',
        emailVerified: true,
        preferredSnapshot: '',
        expectedSubjectClaim: null,
      },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('provider-config-changed')
    const row = await db.select().from(users).where(eq(users.id, 'inv1')).limit(1)
    expect(row[0]!.status).toBe('invited') // activation rolled back with the identity
  })

  test('matching expectation writes user + identity + snapshot seed together', async () => {
    const provider = await makeProvider(db, 'id')
    const { userId } = await createUserWithIdentity(db, {
      username: 'zhang',
      displayName: 'zhang hello',
      email: null,
      identity: {
        providerId: provider.id,
        subject: '42',
        email: null,
        emailVerified: false,
        preferredSnapshot: 'zhang hello',
        expectedSubjectClaim: 'id',
      },
    })
    expect(await displayNameOf(db, userId)).toBe('zhang hello')
    const identity = await snapshotOf(db, provider.id, '42')
    expect(identity!.userId).toBe(userId)
    expect(identity!.preferredSnapshot).toBe('zhang hello')
  })

  test('legacy createIdentity callers (no expectation) skip the recheck', async () => {
    const provider = await makeProvider(db, 'id')
    await seedUser(db, 'u1', 'X')
    const row = await createIdentity(db, {
      userId: 'u1',
      providerId: provider.id,
      subject: 'legacy',
      email: null,
      emailVerified: false,
    })
    expect(row.preferredSnapshot).toBeNull() // legacy rows stay in the NULL domain
  })
})
