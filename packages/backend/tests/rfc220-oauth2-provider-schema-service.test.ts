// RFC-220 T1 — storage layer for pure OAuth 2.0 provider support.
//
// Locks (design §12 S1/S2/S9):
//   S1  schema: http(s)-only endpoint URLs (authorizeUrl is followed via a raw
//       browser redirect — a javascript: value would execute on the login
//       page), claim-name whitelist + prototype-pollution blocklist, the D7
//       space-separated username claim LIST grammar (max 519 = 8×64+7).
//   S2  service: 7-field roundtrip, PATCH null-clears, redacted output, and
//       the subject namespace lock — subjectClaim may NOT change while any
//       identity is linked (old rows would stay keyed in the previous
//       namespace: duplicate accounts or login-as-someone-else, design §2.3).
//   S9  migration 0108: per-column assertions on BOTH tables (a count-style
//       assertion would stay green with a single column missing).

import { beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { CreateOidcProviderBodySchema } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createOidcProvidersService,
  redactedProvider,
  type OidcProvidersService,
} from '../src/services/oidcProviders'
import { users } from '../src/db/schema'
import { createIdentity } from '../src/services/userIdentities'
import { DomainError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  svc: OidcProvidersService
}

function buildHarness(): Harness {
  const db = createInMemoryDb(MIGRATIONS)
  const secretBox = createSecretBoxFromKey(randomBytes(32))
  return { db, svc: createOidcProvidersService({ db, secretBox }) }
}

const BASE = {
  slug: 'pure-oauth',
  displayName: 'Pure OAuth IdP',
  issuerUrl: 'https://idp.corp.test',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  scopes: 'read:user',
  provisioning: 'auto' as const,
  allowedEmailDomains: [],
  iconUrl: null,
  enabled: true,
}

const MANUAL = {
  authorizationEndpoint: 'https://idp.corp.test/oauth/authorize',
  tokenEndpoint: 'https://idp.corp.test/oauth/token',
  userinfoEndpoint: 'https://idp.corp.test/api/user',
  jwksUri: 'https://idp.corp.test/jwks.json',
  trustEmailVerified: true,
  usernameClaim: 'login signature',
  subjectClaim: 'id',
}

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

async function seedUserAndIdentity(h: Harness, providerId: string): Promise<void> {
  await h.db.insert(users).values({
    id: 'user-1',
    username: 'alice',
    email: 'alice@corp.test',
    displayName: 'Alice',
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
  await createIdentity(h.db, {
    userId: 'user-1',
    providerId,
    subject: 'sub-1',
    email: 'alice@corp.test',
    emailVerified: true,
  })
}

// ---------------------------------------------------------------------------
// S1 — schema validation
// ---------------------------------------------------------------------------

describe('RFC-220 S1 — CreateOidcProviderBodySchema field validation', () => {
  const parse = (extra: Record<string, unknown>) =>
    CreateOidcProviderBodySchema.safeParse({ ...BASE, ...extra })

  test('legacy body without any new field still parses (wire compat)', () => {
    expect(parse({}).success).toBe(true)
  })

  test('endpoint fields accept https, reject javascript:/ftp:/empty/oversize', () => {
    expect(parse({ tokenEndpoint: 'https://a.test/token' }).success).toBe(true)
    expect(parse({ tokenEndpoint: 'http://a.test/token' }).success).toBe(true)
    expect(parse({ tokenEndpoint: null }).success).toBe(true)
    expect(parse({ authorizationEndpoint: 'javascript:alert(1)' }).success).toBe(false)
    expect(parse({ userinfoEndpoint: 'ftp://a.test/u' }).success).toBe(false)
    expect(parse({ jwksUri: '' }).success).toBe(false)
    expect(parse({ tokenEndpoint: `https://a.test/${'x'.repeat(2048)}` }).success).toBe(false)
  })

  test('subjectClaim: plain key names only, prototype-pollution keys rejected', () => {
    expect(parse({ subjectClaim: 'id' }).success).toBe(true)
    expect(parse({ subjectClaim: 'user.id-x_1' }).success).toBe(true)
    expect(parse({ subjectClaim: '__proto__' }).success).toBe(false)
    expect(parse({ subjectClaim: 'constructor' }).success).toBe(false)
    expect(parse({ subjectClaim: 'prototype' }).success).toBe(false)
    expect(parse({ subjectClaim: 'a b' }).success).toBe(false)
    expect(parse({ subjectClaim: 'x'.repeat(65) }).success).toBe(false)
    expect(parse({ subjectClaim: '' }).success).toBe(false)
  })

  test('usernameClaim: space-separated list grammar (D7)', () => {
    expect(parse({ usernameClaim: 'preferred_username' }).success).toBe(true)
    expect(parse({ usernameClaim: 'name signature' }).success).toBe(true)
    expect(parse({ usernameClaim: 'a b c d e f g h' }).success).toBe(true)
    // 8 × 64-char tokens + 7 spaces = 519 — the documented upper bound parses.
    expect(parse({ usernameClaim: Array(8).fill('x'.repeat(64)).join(' ') }).success).toBe(true)
    expect(parse({ usernameClaim: 'a b c d e f g h i' }).success).toBe(false)
    expect(parse({ usernameClaim: 'a  b' }).success).toBe(false)
    expect(parse({ usernameClaim: ' a' }).success).toBe(false)
    expect(parse({ usernameClaim: 'a ' }).success).toBe(false)
    expect(parse({ usernameClaim: 'name __proto__' }).success).toBe(false)
    expect(parse({ usernameClaim: '' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S2 — service roundtrip + subject namespace lock
// ---------------------------------------------------------------------------

describe('RFC-220 S2 — provider service', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  test('create defaults new fields to null/false when omitted', async () => {
    const p = await h.svc.create(BASE)
    expect(p.authorizationEndpoint).toBeNull()
    expect(p.tokenEndpoint).toBeNull()
    expect(p.userinfoEndpoint).toBeNull()
    expect(p.jwksUri).toBeNull()
    expect(p.trustEmailVerified).toBe(false)
    expect(p.usernameClaim).toBeNull()
    expect(p.subjectClaim).toBeNull()
  })

  test('create + materialize roundtrips all 7 new fields', async () => {
    const p = await h.svc.create({ ...BASE, ...MANUAL })
    expect(p.authorizationEndpoint).toBe(MANUAL.authorizationEndpoint)
    expect(p.tokenEndpoint).toBe(MANUAL.tokenEndpoint)
    expect(p.userinfoEndpoint).toBe(MANUAL.userinfoEndpoint)
    expect(p.jwksUri).toBe(MANUAL.jwksUri)
    expect(p.trustEmailVerified).toBe(true)
    expect(p.usernameClaim).toBe(MANUAL.usernameClaim)
    expect(p.subjectClaim).toBe(MANUAL.subjectClaim)
    const redacted = redactedProvider(p)
    expect(redacted.userinfoEndpoint).toBe(MANUAL.userinfoEndpoint)
    expect(redacted.subjectClaim).toBe(MANUAL.subjectClaim)
    expect(redacted.clientSecret).toBe('***')
  })

  test('patch sets, keeps, and null-clears the new fields', async () => {
    const p = await h.svc.create({ ...BASE, ...MANUAL })
    const afterSet = await h.svc.patch(p.id, { userinfoEndpoint: 'https://idp.corp.test/v2/me' })
    expect(afterSet.userinfoEndpoint).toBe('https://idp.corp.test/v2/me')
    // untouched fields survive a partial patch
    expect(afterSet.tokenEndpoint).toBe(MANUAL.tokenEndpoint)
    expect(afterSet.usernameClaim).toBe(MANUAL.usernameClaim)
    const afterClear = await h.svc.patch(p.id, {
      userinfoEndpoint: null,
      usernameClaim: null,
      trustEmailVerified: false,
    })
    expect(afterClear.userinfoEndpoint).toBeNull()
    expect(afterClear.usernameClaim).toBeNull()
    expect(afterClear.trustEmailVerified).toBe(false)
  })

  test('subjectClaim change is refused while identities exist (all three shapes)', async () => {
    const p = await h.svc.create({ ...BASE, ...MANUAL }) // subjectClaim: 'id'
    await seedUserAndIdentity(h, p.id)
    // value → value
    await expectCode(
      h.svc.patch(p.id, { subjectClaim: 'uid' }),
      'subject-claim-locked-by-identities',
    )
    // value → null
    await expectCode(
      h.svc.patch(p.id, { subjectClaim: null }),
      'subject-claim-locked-by-identities',
    )
    // equal-value rewrite is NOT a change — passes
    const same = await h.svc.patch(p.id, { subjectClaim: 'id', displayName: 'renamed' })
    expect(same.subjectClaim).toBe('id')
    expect(same.displayName).toBe('renamed')
    // and a locked patch must not have applied its other fields either
    expect(same.userinfoEndpoint).toBe(MANUAL.userinfoEndpoint)
  })

  test('subjectClaim null → value is also a namespace change and locked', async () => {
    const p = await h.svc.create(BASE) // subjectClaim: null
    await seedUserAndIdentity(h, p.id)
    await expectCode(
      h.svc.patch(p.id, { subjectClaim: 'id' }),
      'subject-claim-locked-by-identities',
    )
  })

  test('subjectClaim changes freely while no identity exists', async () => {
    const p = await h.svc.create(BASE)
    const a = await h.svc.patch(p.id, { subjectClaim: 'id' })
    expect(a.subjectClaim).toBe('id')
    const b = await h.svc.patch(p.id, { subjectClaim: null })
    expect(b.subjectClaim).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// S9 — migration 0108: per-column assertions on both tables
// ---------------------------------------------------------------------------

describe('RFC-220 S9 — migration columns', () => {
  test('oidc_providers gained all 7 columns with expected nullability/defaults', () => {
    const { db } = buildHarness()
    const cols = db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      sql`PRAGMA table_info(oidc_providers)`,
    )
    const byName = new Map(cols.map((c) => [c.name, c]))
    for (const name of [
      'authorization_endpoint',
      'token_endpoint',
      'userinfo_endpoint',
      'jwks_uri',
      'username_claim',
      'subject_claim',
    ]) {
      const col = byName.get(name)
      expect(col).toBeDefined()
      expect(col!.notnull).toBe(0)
      expect(col!.dflt_value).toBeNull()
    }
    const trust = byName.get('trust_email_verified')
    expect(trust).toBeDefined()
    expect(trust!.notnull).toBe(1)
    expect(String(trust!.dflt_value)).toBe('false')
  })

  test('user_identities gained nullable preferred_snapshot with no default', () => {
    const { db } = buildHarness()
    const cols = db.all<{ name: string; notnull: number; dflt_value: string | null }>(
      sql`PRAGMA table_info(user_identities)`,
    )
    const snap = cols.find((c) => c.name === 'preferred_snapshot')
    expect(snap).toBeDefined()
    expect(snap!.notnull).toBe(0)
    expect(snap!.dflt_value).toBeNull()
  })
})
