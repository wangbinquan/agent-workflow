// RFC-221 — locks the one-way bootstrap handoff and the password/OIDC
// anti-lockout policy. A fresh migrated DB is token-only; the first admin row
// and completion marker commit together, and login-policy writes are
// transactionally constrained by enabled providers.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { hashPassword } from '../src/auth/passwords'
import { createInMemoryDb } from '../src/db/client'
import { authLoginPolicy, oidcProviders, userSessions, users } from '../src/db/schema'
import {
  completeBootstrapWithAdmin,
  createPasswordLoginSession,
  getAuthMethodDiscovery,
  getAuthLoginPolicy,
  setPasswordLoginEnabled,
} from '../src/services/authLoginPolicy'
import { createUser } from '../src/services/users'
import { DomainError } from '../src/util/errors'
import { freezeAt } from './migration-freeze'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error(`expected ${code}`)
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    expect(error.code).toBe(code)
  }
}

describe('RFC-221 migration 0110', () => {
  test('fresh database starts with bootstrap required', () => {
    const raw = new Database(':memory:')
    const db = drizzle(raw)
    migrate(db, { migrationsFolder: MIGRATIONS })
    const row = raw.query("SELECT * FROM auth_login_policy WHERE id = 'global'").get() as {
      password_login_enabled: number
      bootstrap_completed_at: number | null
    }
    expect(row.password_login_enabled).toBe(1)
    expect(row.bootstrap_completed_at).toBeNull()
  })

  test('legacy active admin with a password is backfilled ready', async () => {
    const raw = new Database(':memory:')
    const db = drizzle(raw)
    migrate(db, { migrationsFolder: freezeAt(108) })
    const now = Date.now()
    raw
      .query(
        `INSERT INTO users
          (id, username, email, display_name, password_hash, role, status,
           force_password_change, created_by, created_at, updated_at,
           last_login_at, schema_version)
         VALUES (?, ?, NULL, ?, ?, 'admin', 'active', 0, NULL, ?, ?, NULL, 1)`,
      )
      .run(
        'legacy-admin',
        'legacy-admin',
        'Legacy Admin',
        await hashPassword('password123'),
        now,
        now,
      )
    migrate(db, { migrationsFolder: MIGRATIONS })
    const row = raw
      .query("SELECT bootstrap_completed_at FROM auth_login_policy WHERE id = 'global'")
      .get() as { bootstrap_completed_at: number | null }
    expect(row.bootstrap_completed_at).toBe(0)
  })
})

describe('RFC-221 auth policy service', () => {
  test('login discovery returns one internally consistent policy/provider snapshot', () => {
    const fresh = createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })
    expect(getAuthMethodDiscovery(fresh, true)).toEqual({
      mode: 'bootstrap',
      providers: [],
      passwordLoginEnabled: false,
      daemonTokenEnabled: true,
    })

    const ready = createInMemoryDb(MIGRATIONS)
    expect(getAuthMethodDiscovery(ready, true)).toEqual({
      mode: 'ready',
      providers: [],
      passwordLoginEnabled: true,
      daemonTokenEnabled: false,
    })
    ready
      .insert(oidcProviders)
      .values({
        id: 'provider-discovery',
        slug: 'corp',
        displayName: 'Corporate SSO',
        issuerUrl: 'https://idp.example.test',
        clientId: 'client',
        clientSecretEnc: 'sealed',
        scopes: 'openid',
        provisioning: 'invite',
        allowedEmailDomainsJson: '[]',
        iconUrl: null,
        enabled: true,
        userinfoRequestStyle: 'get_bearer',
        trustEmailVerified: false,
        createdAt: 1,
        updatedAt: 1,
        schemaVersion: 1,
      })
      .run()
    setPasswordLoginEnabled(ready, false)
    expect(getAuthMethodDiscovery(ready, true)).toEqual({
      mode: 'ready',
      providers: [{ slug: 'corp', displayName: 'Corporate SSO', iconUrl: null }],
      passwordLoginEnabled: false,
      daemonTokenEnabled: false,
    })
    expect(getAuthMethodDiscovery(ready, false)).toEqual({
      mode: 'ready',
      providers: [],
      passwordLoginEnabled: false,
      daemonTokenEnabled: false,
    })
  })

  test('first admin + completion marker commit as one irreversible handoff', async () => {
    const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })
    expect(getAuthLoginPolicy(db).bootstrapCompletedAt).toBeNull()
    const created = completeBootstrapWithAdmin(
      db,
      {
        username: 'first-admin',
        displayName: 'First Admin',
        email: 'ADMIN@example.test',
        passwordHash: await hashPassword('password123'),
      },
      1234,
    )
    expect(created.role).toBe('admin')
    expect(created.status).toBe('active')
    expect(created.email).toBe('admin@example.test')
    expect(getAuthLoginPolicy(db)).toEqual({
      passwordLoginEnabled: true,
      bootstrapCompletedAt: 1234,
      updatedAt: 1234,
    })
    expectCode(
      () =>
        completeBootstrapWithAdmin(db, {
          username: 'second-admin',
          displayName: 'Second',
          passwordHash: 'prepared',
        }),
      'bootstrap-already-complete',
    )
    const humans = db.select().from(users).where(eq(users.role, 'admin')).all()
    expect(humans.filter((row) => row.id !== '__system__')).toHaveLength(1)
  })

  test('password login cannot be disabled without an enabled provider', () => {
    const db = createInMemoryDb(MIGRATIONS)
    expectCode(() => setPasswordLoginEnabled(db, false), 'password-login-requires-enabled-oidc')
    db.insert(oidcProviders)
      .values({
        id: 'provider-1',
        slug: 'corp',
        displayName: 'Corporate SSO',
        issuerUrl: 'https://idp.example.test',
        clientId: 'client',
        clientSecretEnc: 'sealed',
        scopes: 'openid',
        provisioning: 'invite',
        allowedEmailDomainsJson: '[]',
        iconUrl: null,
        enabled: true,
        userinfoRequestStyle: 'get_bearer',
        trustEmailVerified: false,
        createdAt: 1,
        updatedAt: 1,
        schemaVersion: 1,
      })
      .run()
    expect(setPasswordLoginEnabled(db, false).passwordLoginEnabled).toBe(false)
    expect(setPasswordLoginEnabled(db, true).passwordLoginEnabled).toBe(true)
  })

  test('password-session commit rechecks policy and leaves zero side effects', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const user = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'password123',
    })
    db.insert(oidcProviders)
      .values({
        id: 'provider-1',
        slug: 'corp',
        displayName: 'Corporate SSO',
        issuerUrl: 'https://idp.example.test',
        clientId: 'client',
        clientSecretEnc: 'sealed',
        scopes: 'openid',
        provisioning: 'invite',
        allowedEmailDomainsJson: '[]',
        iconUrl: null,
        enabled: true,
        userinfoRequestStyle: 'get_bearer',
        trustEmailVerified: false,
        createdAt: 1,
        updatedAt: 1,
        schemaVersion: 1,
      })
      .run()
    setPasswordLoginEnabled(db, false)
    expectCode(
      () =>
        createPasswordLoginSession(db, {
          userId: user.id,
          verifiedPasswordHash: user.passwordHash!,
        }),
      'password-login-disabled',
    )
    expect(db.select().from(userSessions).all()).toHaveLength(0)
    expect(db.select().from(users).where(eq(users.id, user.id)).get()?.lastLoginAt).toBeNull()
  })

  test('historical in-memory fixtures are ready unless bootstrap is explicit', () => {
    const ready = createInMemoryDb(MIGRATIONS)
    const required = createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })
    expect(ready.select().from(authLoginPolicy).get()?.bootstrapCompletedAt).toBe(0)
    expect(required.select().from(authLoginPolicy).get()?.bootstrapCompletedAt).toBeNull()
  })
})
