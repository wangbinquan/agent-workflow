// RFC-349 — authentication exposes one Promise application runtime while
// SQLite remains an infrastructure adapter with transactional policy/session
// and revocation behavior.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createSqliteAuthRuntime } from '@/auth/composition'
import { createInMemoryDb } from '@/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-349 auth provider contract', () => {
  test('application and HTTP auth seams contain no provider handle', () => {
    const application = [
      'src/auth/application/authPersistence.ts',
      'src/auth/application/authRuntime.ts',
      'src/auth/application/patPolicy.ts',
      'src/auth/application/tokenCallAudit.ts',
    ]
    const routes = ['src/routes/auth.ts', 'src/routes/oidc-auth.ts', 'src/routes/users.ts']
    for (const relativePath of application) {
      const source = readFileSync(resolve(import.meta.dir, '..', relativePath), 'utf8')
      expect(source).not.toContain('DbClient')
      expect(source).not.toContain('PostgresqlDatabaseClient')
      expect(source).not.toContain("from '@/db/")
    }
    for (const relativePath of routes) {
      const source = readFileSync(resolve(import.meta.dir, '..', relativePath), 'utf8')
      expect(source).not.toContain('deps.db')
      expect(source).not.toContain("from '@/auth/sessionStore'")
      expect(source).not.toContain("from '@/auth/loginPolicy'")
    }
  })

  test('legacy auth names are thin facades over explicit SQLite infrastructure', () => {
    const facades = [
      'src/auth/loginPolicy.ts',
      'src/auth/patStore.ts',
      'src/auth/sessionStore.ts',
      'src/auth/session.ts',
      'src/services/accountAuthPolicy.ts',
    ]
    for (const relativePath of facades) {
      const source = readFileSync(resolve(import.meta.dir, '..', relativePath), 'utf8')
      expect(source).not.toContain('DbClient')
      expect(source).not.toContain("from '@/db/schema'")
      expect(source).not.toContain("from '@/db/txSync'")
      expect(source).not.toContain('.select(')
      expect(source).not.toContain('.insert(')
    }

    const sqlitePolicy = readFileSync(
      resolve(import.meta.dir, '..', 'src/auth/infrastructure/legacySqliteLoginPolicy.ts'),
      'utf8',
    )
    expect(sqlitePolicy).toContain('DbClient')
    expect(sqlitePolicy).toContain('dbTxSync')
  })

  test('SQLite bootstrap, password login and revocation share the Promise runtime', async () => {
    const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })
    const revalidations: string[] = []
    const auth = createSqliteAuthRuntime({
      db,
      revalidate: (reason) => revalidations.push(reason),
    })

    expect(auth.provider).toBe('sqlite')
    const bootstrap = auth.completeBootstrap(
      {
        id: 'auth-admin',
        username: 'auth-admin',
        displayName: 'Auth Admin',
        email: 'AUTH@example.test',
        passwordHash: 'verified-hash',
      },
      10,
    )
    expect(bootstrap).toBeInstanceOf(Promise)
    await bootstrap

    await expect(auth.findUserByUsername('auth-admin')).resolves.toMatchObject({
      id: 'auth-admin',
      email: 'auth@example.test',
      role: 'admin',
      status: 'active',
    })
    await expect(auth.getLoginPolicy()).resolves.toMatchObject({
      bootstrapCompletedAt: 10,
      passwordLoginEnabled: true,
    })

    const login = await auth.createPasswordLoginSession({
      userId: 'auth-admin',
      verifiedPasswordHash: 'verified-hash',
      userAgent: 'rfc349-test',
      now: 20,
      ttlMs: 1_000,
    })
    await expect(auth.lookupActiveSession(login.token, 21)).resolves.toMatchObject({
      user: { id: 'auth-admin', lastLoginAt: 20 },
      session: { userId: 'auth-admin', lastUsedAt: 21, expiresAt: 1_020 },
    })

    await auth.revokeSession((await auth.lookupActiveSession(login.token, 22))!.session.id, 23)
    await expect(auth.lookupActiveSession(login.token, 24)).resolves.toBeNull()
    expect(revalidations).toEqual(['bootstrap-completed', 'session-revoked'])
  })

  test('PAT resolution and password ownership fences stay provider-neutral', async () => {
    const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })
    const auth = createSqliteAuthRuntime({ db, revalidate: () => {} })
    await auth.completeBootstrap(
      {
        id: 'pat-admin',
        username: 'pat-admin',
        displayName: 'PAT Admin',
        passwordHash: 'old-hash',
      },
      1,
    )

    const created = await auth.createPat({
      userId: 'pat-admin',
      name: 'automation',
      scopes: ['tasks:execute'],
      purpose: 'general',
      now: 2,
    })
    await expect(auth.lookupActivePat(created.token, 3)).resolves.toMatchObject({
      user: { id: 'pat-admin' },
      scopes: ['tasks:execute'],
      purpose: 'general',
      patId: created.meta.id,
    })

    await auth.writeLocalPasswordIfUnmanaged({
      userId: 'pat-admin',
      passwordHash: 'new-hash',
      forcePasswordChange: false,
      activate: false,
      updatedAt: 4,
    })
    await expect(auth.findUserById('pat-admin')).resolves.toMatchObject({
      passwordHash: 'new-hash',
      updatedAt: 4,
    })
  })
})
