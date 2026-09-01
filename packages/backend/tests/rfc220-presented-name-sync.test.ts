// RFC-220 / RFC-335 — OIDC profile reconciliation + provisioning atomicity.
//
// The data-integrity invariants:
//   - Display and Git names are independent and authoritative on every login.
//   - preferred_snapshot is diagnostic compatibility state, never a merge gate.
//   - User row + identity row commit in ONE transaction; a write-time
//     subjectClaim mismatch rolls back BOTH (no identity-less active users,
//     no half-activated invites).

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { userIdentities, users } from '../src/db/schema'
import {
  bindInvitedUserWithIdentity as bindInvitedUserWithIdentityService,
  createIdentity as createIdentityService,
  createUserWithIdentity as createUserWithIdentityService,
  syncPreferredSnapshot as syncPreferredSnapshotService,
} from '../src/services/userIdentities'
import { createIdentityAccessRuntime } from '../src/modules/identity-access/composition'
import { applyEmailTrust } from '../src/services/oidc/provisioning'
import { DomainError } from '../src/util/errors'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createOidcProvidersService } from '../src/services/oidcProviders'
import { randomBytes } from 'node:crypto'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function identityAccessFixture(db: DbClient) {
  return createIdentityAccessRuntime({ db })
}

function createIdentity(db: DbClient, args: Parameters<typeof createIdentityService>[1]) {
  return createIdentityService(db, args, identityAccessFixture(db))
}

function createUserWithIdentity(
  db: DbClient,
  args: Parameters<typeof createUserWithIdentityService>[1],
) {
  return createUserWithIdentityService(db, args, identityAccessFixture(db))
}

function bindInvitedUserWithIdentity(
  db: DbClient,
  args: Parameters<typeof bindInvitedUserWithIdentityService>[1],
) {
  return bindInvitedUserWithIdentityService(db, args, identityAccessFixture(db))
}

async function syncPreferredSnapshot(
  db: DbClient,
  args: Parameters<typeof syncPreferredSnapshotService>[0],
) {
  return await syncPreferredSnapshotService(args, identityAccessFixture(db))
}

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

async function seedUser(
  db: DbClient,
  id: string,
  displayName: string,
  email: string | null = null,
  gitName: string = displayName,
) {
  await db.insert(users).values({
    id,
    username: `u-${id}`,
    email,
    displayName,
    gitName,
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

async function emailOf(db: DbClient, userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]!.email
}

async function displayNameOf(db: DbClient, userId: string): Promise<string> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  return rows[0]!.displayName
}

async function gitNameOf(db: DbClient, userId: string): Promise<string> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  return rows[0]!.gitName
}

async function snapshotOf(db: DbClient, providerId: string, subject: string) {
  const rows = await db
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.providerId, providerId))
  return rows.find((r) => r.subject === subject) ?? null
}

describe('RFC-335 — syncPreferredSnapshot refreshes both names every login', () => {
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
    email: null,
  }

  test('unchanged IdP values still replace later in-app edits', async () => {
    await seedIdentity('zhang hello')
    await db
      .update(users)
      .set({ displayName: 'My Custom Name', gitName: 'My Git Name' })
      .where(eq(users.id, 'u1'))
    const r = await syncPreferredSnapshot(db, {
      ...baseArgs,
      providerId,
      displayName: 'zhang hello',
      gitName: 'Zhang Git',
    })
    expect(r).toMatchObject({ displayNameRefreshed: true, gitNameRefreshed: true })
    expect(await displayNameOf(db, 'u1')).toBe('zhang hello')
    expect(await gitNameOf(db, 'u1')).toBe('Zhang Git')
  })

  test('display and Git names refresh independently with the snapshot', async () => {
    await seedIdentity('zhang hello')
    const r = await syncPreferredSnapshot(db, {
      ...baseArgs,
      providerId,
      displayName: 'zhang 新签名',
      gitName: 'Zhang Wei',
    })
    expect(r).toMatchObject({ displayNameRefreshed: true, gitNameRefreshed: true })
    expect(await displayNameOf(db, 'u1')).toBe('zhang 新签名')
    expect(await gitNameOf(db, 'u1')).toBe('Zhang Wei')
    expect((await snapshotOf(db, providerId, 's1'))!.preferredSnapshot).toBe('zhang 新签名')
    // the users.updatedAt stamp moved with it (same transaction)
    const row = await db.select().from(users).where(eq(users.id, 'u1')).limit(1)
    expect(row[0]!.updatedAt).toBeGreaterThan(0)
  })

  test('legacy NULL snapshot does not suppress first-login refresh', async () => {
    await seedIdentity(null)
    const r = await syncPreferredSnapshot(db, {
      ...baseArgs,
      providerId,
      displayName: 'zhang hello',
      gitName: 'Zhang Git',
    })
    expect(r).toMatchObject({ displayNameRefreshed: true, gitNameRefreshed: true })
    expect(await displayNameOf(db, 'u1')).toBe('zhang hello')
    expect(await gitNameOf(db, 'u1')).toBe('Zhang Git')
    expect((await snapshotOf(db, providerId, 's1'))!.preferredSnapshot).toBe('zhang hello')
  })

  test('identical values are idempotent and avoid an account update', async () => {
    await seedIdentity('zhang hello')
    await db
      .update(users)
      .set({ displayName: 'zhang hello', gitName: 'Zhang Git', updatedAt: 11 })
      .where(eq(users.id, 'u1'))
    const r = await syncPreferredSnapshot(db, {
      ...baseArgs,
      providerId,
      displayName: 'zhang hello',
      gitName: 'Zhang Git',
    })
    expect(r).toMatchObject({ displayNameRefreshed: false, gitNameRefreshed: false })
    const row = await db.select().from(users).where(eq(users.id, 'u1')).limit(1)
    expect(row[0]!.updatedAt).toBe(11)
  })

  test('email_verified follows normalized claims bidirectionally (S7 存量同步)', async () => {
    await seedIdentity('zhang hello')
    await syncPreferredSnapshot(db, {
      ...baseArgs,
      providerId,
      displayName: 'Original Name',
      gitName: 'Original Name',
      emailVerified: true,
    })
    expect((await snapshotOf(db, providerId, 's1'))!.emailVerified).toBe(1)
    await syncPreferredSnapshot(db, {
      ...baseArgs,
      providerId,
      displayName: 'Original Name',
      gitName: 'Original Name',
      emailVerified: false,
    })
    expect((await snapshotOf(db, providerId, 's1'))!.emailVerified).toBe(0)
  })
})

describe('RFC-320 — OIDC email snapshot merge', () => {
  let db: DbClient
  let providerId: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    providerId = (await makeProvider(db)).id
  })

  const callbackFence = {
    expectedSubjectClaim: null,
    expectedUsernameClaim: 'login sig',
    expectedGitNameClaim: null,
    expectedEmailClaim: null,
  }

  async function seedEmailIdentity(userEmail: string | null, snapshotEmail: string | null) {
    await seedUser(db, 'u1', 'Alice', userEmail)
    await createIdentity(db, {
      userId: 'u1',
      providerId,
      subject: 's1',
      email: snapshotEmail,
      emailVerified: true,
      preferredSnapshot: 'alice',
    })
  }

  test('empty account email is filled immediately and audited', async () => {
    await seedEmailIdentity(null, null)
    const result = await syncPreferredSnapshot(db, {
      providerId,
      subject: 's1',
      userId: 'u1',
      displayName: 'Alice',
      gitName: 'Alice Git',
      email: 'alice@example.test',
      emailVerified: true,
      ...callbackFence,
    })
    expect(result.emailRefreshed).toBe(true)
    expect(await emailOf(db, 'u1')).toBe('alice@example.test')
    expect((await snapshotOf(db, providerId, 's1'))!.email).toBe('alice@example.test')
    expect(
      db.$client
        .query('SELECT actor_kind FROM user_access_audit WHERE target_user_id = ?')
        .get('u1'),
    ).toEqual({ actor_kind: 'system' })
  })

  test('unchanged IdP email preserves an in-app edit; a later IdP change wins', async () => {
    await seedEmailIdentity('local@example.test', 'idp-old@example.test')
    await syncPreferredSnapshot(db, {
      providerId,
      subject: 's1',
      userId: 'u1',
      displayName: 'Alice',
      gitName: 'Alice Git',
      email: 'idp-old@example.test',
      emailVerified: true,
      ...callbackFence,
    })
    expect(await emailOf(db, 'u1')).toBe('local@example.test')

    await syncPreferredSnapshot(db, {
      providerId,
      subject: 's1',
      userId: 'u1',
      displayName: 'Alice',
      gitName: 'Alice Git',
      email: 'idp-new@example.test',
      emailVerified: true,
      ...callbackFence,
    })
    expect(await emailOf(db, 'u1')).toBe('idp-new@example.test')
  })

  test('legacy null snapshot records first sight without replacing an existing account email', async () => {
    await seedEmailIdentity('local@example.test', null)
    const result = await syncPreferredSnapshot(db, {
      providerId,
      subject: 's1',
      userId: 'u1',
      displayName: 'Alice',
      gitName: 'Alice Git',
      email: 'idp@example.test',
      emailVerified: true,
      ...callbackFence,
    })
    expect(result.emailRefreshed).toBe(false)
    expect(await emailOf(db, 'u1')).toBe('local@example.test')
    expect((await snapshotOf(db, providerId, 's1'))!.email).toBe('idp@example.test')
  })

  test('unique conflict rolls back both user and identity snapshots', async () => {
    await seedEmailIdentity('old@example.test', 'old@example.test')
    await seedUser(db, 'u2', 'Bob', 'taken@example.test')
    let error: unknown = null
    try {
      await syncPreferredSnapshot(db, {
        providerId,
        subject: 's1',
        userId: 'u1',
        displayName: 'Alice',
        gitName: 'Alice Git',
        email: 'taken@example.test',
        emailVerified: true,
        ...callbackFence,
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('oidc-email-conflict')
    expect(await emailOf(db, 'u1')).toBe('old@example.test')
    expect((await snapshotOf(db, providerId, 's1'))!.email).toBe('old@example.test')
  })

  test('link and invite branches run profile sync inside their insert transaction', async () => {
    await seedUser(db, 'linked', 'Linked')
    await createIdentity(db, {
      userId: 'linked',
      providerId,
      subject: 'linked-sub',
      email: 'linked@example.test',
      emailVerified: true,
      displayName: 'Linked IdP',
      gitName: 'Linked Git',
      preferredSnapshot: 'linked',
      ...callbackFence,
    })
    expect(await emailOf(db, 'linked')).toBe('linked@example.test')

    await db.insert(users).values({
      id: 'invited',
      username: 'invited',
      email: null,
      displayName: 'Invited',
      gitName: 'Invited',
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
    await bindInvitedUserWithIdentity(db, {
      userId: 'invited',
      identity: {
        providerId,
        subject: 'invited-sub',
        email: 'invited@example.test',
        emailVerified: true,
        displayName: 'Invited IdP',
        gitName: 'Invited Git',
        preferredSnapshot: 'invited',
        ...callbackFence,
      },
    })
    expect(await emailOf(db, 'invited')).toBe('invited@example.test')
    const invited = await db.select().from(users).where(eq(users.id, 'invited')).limit(1)
    expect(invited[0]!.status).toBe('active')
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
    const auditsBefore = db.$client.query('SELECT COUNT(*) AS n FROM user_access_audit').get() as {
      n: number
    }
    const err = await createUserWithIdentity(db, {
      username: 'ghost',
      displayName: 'Ghost',
      gitName: 'Ghost Git',
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
    expect(db.$client.query('SELECT COUNT(*) AS n FROM user_access_audit').get()).toEqual(
      auditsBefore,
    )
    expect(await snapshotOf(db, provider.id, '42')).toBeNull()
  })

  test('bindInvitedUserWithIdentity is atomic: mismatch keeps the invite intact', async () => {
    const provider = await makeProvider(db, 'id')
    await db.insert(users).values({
      id: 'inv1',
      username: 'invited',
      email: 'inv@corp.test',
      displayName: 'Invited',
      gitName: 'Invited',
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
      gitName: 'Zhang Git',
      email: null,
      identity: {
        providerId: provider.id,
        subject: '42',
        email: null,
        emailVerified: false,
        displayName: 'zhang hello',
        gitName: 'Zhang Git',
        preferredSnapshot: 'zhang hello',
        expectedSubjectClaim: 'id',
      },
    })
    expect(await displayNameOf(db, userId)).toBe('zhang hello')
    const identity = await snapshotOf(db, provider.id, '42')
    expect(identity!.userId).toBe(userId)
    expect(identity!.preferredSnapshot).toBe('zhang hello')
    expect(
      db.$client
        .query(
          'SELECT actor_kind, before_role, after_role, access_revision FROM user_access_audit WHERE target_user_id = ?',
        )
        .get(userId),
    ).toEqual({
      actor_kind: 'system',
      before_role: 'guest',
      after_role: 'guest',
      access_revision: 0,
    })
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
