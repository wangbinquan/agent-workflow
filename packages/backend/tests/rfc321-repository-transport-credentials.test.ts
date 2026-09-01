// RFC-321 — only absence may fall through from personal to global. Storage
// tests also prove personal secrets are sealed and isolated per user.

import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import {
  repositoryTransportConnections,
  userRepositoryTransportCredentials,
} from '../src/db/schema'
import { composeRepositoryTransportCredentials } from '../src/modules/source-control/composition'
import { selectRepositoryTransportCredential } from '../src/modules/source-control/domain/repositoryTransportCredential'
import { SQLiteRepositoryTransportCredentialRepository } from '../src/modules/source-control/infrastructure/sqliteRepositoryTransportCredentialRepository'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DIGEST = 'a'.repeat(64)
const PERSONAL_TOKEN = 'aw-personal-fixture-token-9999'
const GLOBAL_TOKEN = 'aw-global-fixture-token-1111'

function subject(user: Awaited<ReturnType<typeof createUser>>) {
  return { kind: 'user' as const, userId: user.id }
}

function repositoryOf(db: ReturnType<typeof createInMemoryDb>) {
  return new SQLiteRepositoryTransportCredentialRepository(db)
}

describe('RFC-321 credential selector truth table', () => {
  const binding = {
    provider: 'gitlab' as const,
    connectionGeneration: 'generation',
    endpointBindingDigest: DIGEST,
  }
  const global = {
    credentialRef: 'global-ref',
    connectionGeneration: 'generation',
    endpointBindingDigest: DIGEST,
    credentialRevision: 4,
  }

  test('personal wins and system subjects skip the personal layer', () => {
    const personal = { ...global, credentialRef: 'personal-ref', credentialRevision: 2 }
    expect(
      selectRepositoryTransportCredential({
        subjectKind: 'user',
        binding,
        personal,
        global,
      }),
    ).toMatchObject({ ok: true, source: 'personal', credentialRef: 'personal-ref' })
    expect(
      selectRepositoryTransportCredential({
        subjectKind: 'system',
        binding,
        personal,
        global,
      }),
    ).toMatchObject({ ok: true, source: 'global', credentialRef: 'global-ref' })
  })

  test('only null absence falls through; stale personal fails before global', () => {
    expect(
      selectRepositoryTransportCredential({
        subjectKind: 'user',
        binding,
        personal: null,
        global,
      }),
    ).toMatchObject({ ok: true, source: 'global' })
    expect(
      selectRepositoryTransportCredential({
        subjectKind: 'user',
        binding,
        personal: { ...global, endpointBindingDigest: 'b'.repeat(64) },
        global,
      }),
    ).toEqual({ ok: false, code: 'code-host-push-credential-stale' })
    expect(
      selectRepositoryTransportCredential({
        subjectKind: 'user',
        binding: null,
        personal: null,
        global: null,
      }),
    ).toEqual({ ok: true, source: 'legacy', credentialRevision: null })
  })
})

describe('RFC-321 personal credential repository', () => {
  test('one runtime supply owns personal-first Git selection without selected-personal fallback', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 20))
    const module = composeRepositoryTransportCredentials(repositoryOf(db), box)
    const alice = await createUser(db, {
      username: 'rfc321-runtime-alice',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    await module.adminConnections.synchronize({
      provider: 'gitlab',
      connectionGeneration: 'generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://gitlab.example/api/v4',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://gitlab.example'],
      globalTokenEnc: box.seal(GLOBAL_TOKEN),
      globalTokenHint: '1111',
      updatedAt: 1,
      updatedBy: null,
    })

    expect(
      await module.credentialSupply.resolveExecution({ kind: 'user', userId: alice.id }, 'gitlab'),
    ).toMatchObject({
      ok: true,
      credential: { credentialSource: 'global', token: GLOBAL_TOKEN },
    })
    await module.ownCredentials.put(subject(alice), 'gitlab', {
      token: PERSONAL_TOKEN,
      connectionGeneration: 'generation',
      endpointBindingDigest: DIGEST,
    })
    expect(
      await module.credentialSupply.resolveExecution({ kind: 'user', userId: alice.id }, 'gitlab'),
    ).toMatchObject({
      ok: true,
      credential: { credentialSource: 'personal', token: PERSONAL_TOKEN },
    })
    expect(
      await module.credentialSupply.resolveExecution({ kind: 'system' }, 'gitlab'),
    ).toMatchObject({
      ok: true,
      credential: { credentialSource: 'global', token: GLOBAL_TOKEN },
    })
    expect(
      await module.ownCredentials.resolvePersonalForTest(subject(alice), 'gitlab', {
        connectionGeneration: 'generation',
        endpointBindingDigest: DIGEST,
      }),
    ).toMatchObject({
      ok: true,
      credential: { credentialSource: 'personal', token: PERSONAL_TOKEN },
    })

    db.update(userRepositoryTransportCredentials)
      .set({ endpointBindingDigest: 'b'.repeat(64) })
      .where(eq(userRepositoryTransportCredentials.userId, alice.id))
      .run()
    expect(
      await module.credentialSupply.resolveExecution({ kind: 'user', userId: alice.id }, 'gitlab'),
    ).toEqual({ ok: false, code: 'code-host-push-credential-stale' })

    db.update(userRepositoryTransportCredentials)
      .set({ endpointBindingDigest: DIGEST, tokenEnc: 'corrupt-ciphertext' })
      .where(eq(userRepositoryTransportCredentials.userId, alice.id))
      .run()
    expect(
      await module.credentialSupply.resolveExecution({ kind: 'user', userId: alice.id }, 'gitlab'),
    ).toEqual({ ok: false, code: 'code-host-push-credential-unavailable' })
    expect(
      await module.ownCredentials.resolvePersonalForTest(subject(alice), 'gitlab', {
        connectionGeneration: 'generation',
        endpointBindingDigest: DIGEST,
      }),
    ).toEqual({ ok: false, code: 'code-host-push-credential-unavailable' })
  })

  test('seals, replaces, isolates, and deletes each user credential', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 21))
    const module = composeRepositoryTransportCredentials(repositoryOf(db), box)
    const alice = await createUser(db, {
      username: 'rfc321-alice',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const bob = await createUser(db, {
      username: 'rfc321-bob',
      displayName: 'Bob',
      role: 'user',
      password: 'longEnoughPassword',
    })
    await module.adminConnections.synchronize({
      provider: 'gitlab',
      connectionGeneration: 'generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://gitlab.example/api/v4',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://gitlab.example'],
      globalTokenEnc: box.seal(GLOBAL_TOKEN),
      globalTokenHint: '1111',
      updatedAt: 1,
      updatedBy: null,
    })

    expect((await module.ownCredentials.list(subject(alice))).items[0]).toMatchObject({
      provider: 'gitlab',
      configured: false,
      tokenHint: null,
      fallback: 'platform-global',
    })
    const saved = await module.ownCredentials.put(subject(alice), 'gitlab', {
      token: PERSONAL_TOKEN,
      connectionGeneration: 'generation',
      endpointBindingDigest: DIGEST,
    })
    expect(saved).toMatchObject({ configured: true, tokenHint: '9999', stale: false })
    expect((await module.ownCredentials.list(subject(bob))).items[0]).toMatchObject({
      configured: false,
    })

    const row = db
      .select()
      .from(userRepositoryTransportCredentials)
      .where(eq(userRepositoryTransportCredentials.userId, alice.id))
      .get()!
    expect(row.tokenEnc).not.toContain(PERSONAL_TOKEN)
    expect(box.unseal(row.tokenEnc)).toBe(PERSONAL_TOKEN)
    expect(row.credentialRevision).toBe(1)

    await module.ownCredentials.put(subject(alice), 'gitlab', {
      token: 'aw-personal-replacement-8888',
      connectionGeneration: 'generation',
      endpointBindingDigest: DIGEST,
    })
    expect(
      db
        .select({ revision: userRepositoryTransportCredentials.credentialRevision })
        .from(userRepositoryTransportCredentials)
        .where(eq(userRepositoryTransportCredentials.userId, alice.id))
        .get(),
    ).toEqual({ revision: 2 })
    expect(await module.ownCredentials.remove(subject(alice), 'gitlab')).toEqual({ removed: true })
    expect(await module.ownCredentials.remove(subject(alice), 'gitlab')).toEqual({ removed: false })
  })

  test('generation/digest mismatch is a conflict and projection rebind revokes personal rows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 22))
    const module = composeRepositoryTransportCredentials(repositoryOf(db), box)
    const alice = await createUser(db, {
      username: 'rfc321-stale',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const globalTokenEnc = box.seal(GLOBAL_TOKEN)
    const projection = {
      provider: 'github' as const,
      connectionGeneration: 'generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://api.github.com',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://github.com'],
      globalTokenEnc,
      globalTokenHint: '1111',
      updatedAt: 1,
      updatedBy: null,
    }
    await module.adminConnections.synchronize(projection)
    await expect(
      module.ownCredentials.put(subject(alice), 'github', {
        token: PERSONAL_TOKEN,
        connectionGeneration: 'generation',
        endpointBindingDigest: 'b'.repeat(64),
      }),
    ).rejects.toThrow('connection changed')
    await module.ownCredentials.put(subject(alice), 'github', {
      token: PERSONAL_TOKEN,
      connectionGeneration: 'generation',
      endpointBindingDigest: DIGEST,
    })
    await module.adminConnections.synchronize({
      ...projection,
      endpointBindingDigest: 'c'.repeat(64),
      updatedAt: 2,
    })
    expect(db.select().from(userRepositoryTransportCredentials).all()).toEqual([])
    expect(
      db
        .select({ revision: repositoryTransportConnections.credentialRevision })
        .from(repositoryTransportConnections)
        .get(),
    ).toEqual({ revision: 1 })
  })
})
