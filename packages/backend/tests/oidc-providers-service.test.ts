// RFC-036 — OIDC providers service CRUD: create / patch (clientSecret keep
// vs overwrite) / delete with force / encrypted-at-rest invariant.

import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '@/db/query'
import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import {
  createOidcProvidersService,
  type OidcProvidersService,
} from '../src/services/oidcProviders'
import { oidcProviders, userIdentities, users } from '../src/db/schema'
import { createIdentity } from '../src/services/userIdentities'
import { DomainError } from '../src/util/errors'

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    throw new Error('expected promise to reject')
  } catch (err) {
    if (err instanceof DomainError) {
      expect(err.code).toBe(code)
    } else {
      throw err
    }
  }
}

interface Harness {
  db: ProviderNeutralDatabase
  svc: OidcProvidersService
}

function buildHarness(__db: ProviderNeutralDatabase): Harness {
  const db = __db
  const secretBox = createSecretBoxFromKey(randomBytes(32))
  return { db, svc: createOidcProvidersService({ db, secretBox }) }
}

const SAMPLE = {
  slug: 'github-corp',
  displayName: 'GitHub Corp',
  issuerUrl: 'https://github.corp.test',
  clientId: 'Iv1.example',
  clientSecret: 'super-secret-value',
  scopes: 'openid profile email',
  provisioning: 'allowlist' as const,
  allowedEmailDomains: ['@corp.test'],
  iconUrl: null,
  enabled: true,
}

describeEachProvider('OidcProvidersService', (harness) => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness(harness.db)
  })

  test('create + findById materializes everything except the encrypted secret', async () => {
    const created = await h.svc.create(SAMPLE)
    expect(created.slug).toBe(SAMPLE.slug)
    expect(created.clientId).toBe(SAMPLE.clientId)
    expect(created.allowedEmailDomains).toEqual(SAMPLE.allowedEmailDomains)
    expect(created.enabled).toBe(true)
    expect((created as unknown as { clientSecret?: string }).clientSecret).toBeUndefined()
    // confirm secret is encrypted at rest (raw column does not contain plaintext)
    const rows = await h.db.select().from(oidcProviders)
    expect(rows[0]?.clientSecretEnc).not.toContain(SAMPLE.clientSecret)
    // round-trip via resolveClientSecret
    expect(await h.svc.resolveClientSecret(created.id)).toBe(SAMPLE.clientSecret)
  })

  test('create rejects duplicate slug', async () => {
    await h.svc.create(SAMPLE)
    await expectCode(h.svc.create({ ...SAMPLE }), 'oidc-slug-taken')
  })

  test('patch empty clientSecret keeps existing; non-empty overwrites', async () => {
    const created = await h.svc.create(SAMPLE)
    await h.svc.patch(created.id, { clientSecret: '' })
    expect(await h.svc.resolveClientSecret(created.id)).toBe(SAMPLE.clientSecret)
    await h.svc.patch(created.id, { clientSecret: 'rotated' })
    expect(await h.svc.resolveClientSecret(created.id)).toBe('rotated')
  })

  test('patch validates slug uniqueness', async () => {
    const a = await h.svc.create(SAMPLE)
    await h.svc.create({ ...SAMPLE, slug: 'other', clientSecret: 's2' })
    await expectCode(h.svc.patch(a.id, { slug: 'other' }), 'oidc-slug-taken')
  })

  test('delete rejects with 409 when identities still linked; force cascades', async () => {
    const created = await h.svc.create(SAMPLE)
    // Seed a user + identity binding so the FK is non-empty.
    await h.db.insert(users).values({
      id: 'user-1',
      username: 'alice',
      email: 'alice@corp.test',
      displayName: 'Alice',
      passwordHash: null,
      role: 'admin',
      status: 'active',
      forcePasswordChange: false,
      createdBy: null,
      createdAt: 0,
      updatedAt: 0,
      lastLoginAt: null,
      schemaVersion: 1,
    })
    await createIdentity(h.db, {
      userId: 'user-1',
      providerId: created.id,
      subject: 'gh-1',
      email: 'alice@corp.test',
      emailVerified: true,
    })
    await expectCode(h.svc.remove(created.id), 'provider-still-linked')
    await h.svc.remove(created.id, true)
    const remaining = await h.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.providerId, created.id))
    expect(remaining.length).toBe(0)
  })

  test('listPublic returns enabled only with public fields', async () => {
    const a = await h.svc.create(SAMPLE)
    await h.svc.create({ ...SAMPLE, slug: 'disabled-one', enabled: false })
    const pub = await h.svc.listPublic()
    expect(pub.length).toBe(1)
    expect(pub[0]?.slug).toBe(a.slug)
    expect(Object.keys(pub[0] ?? {}).sort()).toEqual(['displayName', 'iconUrl', 'slug'])
  })
})
