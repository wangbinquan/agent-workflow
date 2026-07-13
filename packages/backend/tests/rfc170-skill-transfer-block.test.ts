// RFC-170 §8 (G3-2) — an external skill's injected body comes from a mutable
// externalPath the original registrar/importer still controls. Transferring the
// ACL owner would make "only the owner may change the resource" a false promise,
// so `updateResourceAcl` REJECTS owner transfer for a non-managed skill
// (authority_kind ∈ {source-external, hand-external}) with a 403. Grant and
// visibility edits stay allowed; managed skills (and the other five resource
// types, which carry no skill authority) are unrestricted.
//
// This is the load-bearing enforcement behind the frontend `canTransferOwner`
// capability gate (skill-capabilities.ts) — the UI merely reflects it.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills, users } from '../src/db/schema'
import { getResourceAcl, updateResourceAcl, type AclRow } from '../src/services/resourceAcl'
import {
  getSkill,
  getSkillPreconditionToken,
  importExternalSkill,
  updateSkill,
} from '../src/services/skill'
import { ForbiddenError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actorOfUser(id: string, role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-4)}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}
async function seedUser(db: DbClient, id: string, role: 'admin' | 'user'): Promise<void> {
  await db.insert(users).values({
    id,
    username: `u-${id}`,
    displayName: id,
    role,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

type Authority = 'managed' | 'source-external' | 'hand-external'

describe('RFC-170 §8 (G3-2) — external skill owner-transfer block', () => {
  let db: DbClient
  let owner: Actor
  const OWNER = 'user-owner'
  const TARGET = 'user-target'

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, OWNER, 'user')
    await seedUser(db, TARGET, 'user')
    owner = actorOfUser(OWNER, 'user')
  })

  async function seedSkill(authorityKind: Authority): Promise<AclRow> {
    const id = ulid()
    await db.insert(skills).values({
      id,
      name: `sk-${id.slice(-6).toLowerCase()}`,
      description: 'd',
      sourceKind: authorityKind === 'managed' ? 'managed' : 'external',
      authorityKind,
      managedPath: authorityKind === 'managed' ? `skills/x/files` : null,
      externalPath: authorityKind === 'managed' ? null : '/ext/x',
      ownerUserId: OWNER,
      visibility: 'public',
    })
    return { id, ownerUserId: OWNER, visibility: 'public' }
  }

  test('source-external: owner transfer is 403 ForbiddenError (owner unchanged)', async () => {
    const row = await seedSkill('source-external')
    await expect(
      updateResourceAcl(db, owner, 'skill', row, { ownerUserId: TARGET }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    // The rejected transfer applied nothing — OWNER still owns it.
    expect((await getResourceAcl(db, owner, 'skill', row)).ownerUserId).toBe(OWNER)
  })

  test('hand-external: owner transfer is 403 ForbiddenError', async () => {
    const row = await seedSkill('hand-external')
    await expect(
      updateResourceAcl(db, owner, 'skill', row, { ownerUserId: TARGET }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  test('the block carries the stable diagnostic code', async () => {
    const row = await seedSkill('source-external')
    let code: string | undefined
    try {
      await updateResourceAcl(db, owner, 'skill', row, { ownerUserId: TARGET })
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe('skill-external-transfer-blocked')
  })

  test('managed: owner transfer SUCCEEDS (unrestricted)', async () => {
    const row = await seedSkill('managed')
    const res = await updateResourceAcl(db, owner, 'skill', row, { ownerUserId: TARGET })
    expect(res.ownerUserId).toBe(TARGET)
  })

  test('external: grant + visibility edits still go through (only transfer is blocked)', async () => {
    const row = await seedSkill('source-external')
    // No ownerUserId in the body → not a transfer → allowed.
    const res = await updateResourceAcl(db, owner, 'skill', row, {
      userIds: [TARGET],
      visibility: 'private',
    })
    expect(res.visibility).toBe('private')
    const acl = await getResourceAcl(db, owner, 'skill', row)
    expect(acl.users.map((u) => u.id)).toContain(TARGET)
    expect(acl.ownerUserId).toBe(OWNER) // still the original owner
  })

  test('external: a no-op ownerUserId (same owner) is NOT a transfer → allowed', async () => {
    const row = await seedSkill('hand-external')
    // Re-asserting the current owner must not trip the guard.
    const res = await updateResourceAcl(db, owner, 'skill', row, {
      ownerUserId: OWNER,
      visibility: 'private',
    })
    expect(res.ownerUserId).toBe(OWNER)
    expect(res.visibility).toBe('private')
  })
})

// RFC-170 §8 (G3-2, §2) — a source-external skill's DB metadata is owned by its
// registered source directory; a direct PUT would be clobbered on the next
// reconcile, so `updateSkill` rejects a description write. hand-external (DB
// metadata authority) + managed accept it. This is the backend enforcement
// behind the read-only description field in the detail UI.
describe('RFC-170 §8 (G3-2) — source-external metadata write is read-only', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
  })

  async function seedSkill(authorityKind: Authority): Promise<string> {
    const id = ulid()
    const name = `sk-${id.slice(-6).toLowerCase()}`
    await db.insert(skills).values({
      id,
      name,
      description: 'orig',
      sourceKind: authorityKind === 'managed' ? 'managed' : 'external',
      authorityKind,
      managedPath: authorityKind === 'managed' ? `skills/${name}/files` : null,
      externalPath: authorityKind === 'managed' ? null : '/ext/x',
    })
    return name
  }

  test('source-external: a description write is 403 ForbiddenError (unchanged)', async () => {
    const name = await seedSkill('source-external')
    await expect(updateSkill(db, name, { description: 'hacked' })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    expect((await getSkill(db, name))!.description).toBe('orig') // nothing written
  })

  test('source-external: the block carries the stable diagnostic code', async () => {
    const name = await seedSkill('source-external')
    let code: string | undefined
    try {
      await updateSkill(db, name, { description: 'x' })
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe('skill-source-external-metadata-readonly')
  })

  test('source-external: an EMPTY patch (no description) is a no-op, not rejected', async () => {
    const name = await seedSkill('source-external')
    const res = await updateSkill(db, name, {})
    expect(res.description).toBe('orig')
  })

  test('hand-external: description IS writable (DB metadata authority)', async () => {
    const name = await seedSkill('hand-external')
    const res = await updateSkill(db, name, { description: 'edited' })
    expect(res.description).toBe('edited')
  })

  test('managed: description IS writable', async () => {
    const name = await seedSkill('managed')
    const res = await updateSkill(db, name, { description: 'edited' })
    expect(res.description).toBe('edited')
  })
})

// RFC-170 §8 (Codex F1/F2) — regression via the REAL constructors (not seeded
// authority values): a fresh import must land as external authority (NOT the
// 'managed' column default, which would bypass every §8 guard), and a metadata
// write must advance the token so the OCC actually sees description drift.
describe('RFC-170 §8 (Codex F1/F2) — real constructor authority + token drift', () => {
  let db: DbClient
  let owner: Actor
  const OWNER = 'user-owner'
  const TARGET = 'user-target'
  let extDir: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, OWNER, 'user')
    await seedUser(db, TARGET, 'user')
    owner = actorOfUser(OWNER, 'user')
    extDir = mkdtempSync(join(tmpdir(), 'aw-ext-skill-'))
    writeFileSync(join(extDir, 'SKILL.md'), '---\nname: ext\ndescription: d\n---\nbody')
  })
  afterEach(() => rmSync(extDir, { recursive: true, force: true }))

  test('importExternalSkill lands as hand-external (NOT managed) + records the content controller', async () => {
    const created = await importExternalSkill(
      db,
      { name: 'ext', externalPath: extDir, description: 'd' },
      { ownerUserId: OWNER },
    )
    // Was the bug: authorityKind defaulted to 'managed' → all §8 guards bypassed.
    expect(created.authorityKind).toBe('hand-external')
  })

  test('a freshly-imported external skill BLOCKS owner transfer (403) — the real bug', async () => {
    await importExternalSkill(
      db,
      { name: 'ext', externalPath: extDir, description: 'd' },
      { ownerUserId: OWNER },
    )
    const row: AclRow = {
      id: (await getSkill(db, 'ext'))!.id,
      ownerUserId: OWNER,
      visibility: 'public',
    }
    await expect(
      updateResourceAcl(db, owner, 'skill', row, { ownerUserId: TARGET }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  test('a managed metadata write advances the precondition token (F2 — token was inert)', async () => {
    // Seed a managed skill directly (description is writable for managed).
    const id = ulid()
    await db.insert(skills).values({
      id,
      name: 'm',
      description: 'orig',
      sourceKind: 'managed',
      authorityKind: 'managed',
      managedPath: 'skills/m/files',
    })
    const before = await getSkillPreconditionToken(db, 'm')
    await updateSkill(db, 'm', { description: 'changed' })
    const after = await getSkillPreconditionToken(db, 'm')
    expect(before).not.toBeNull()
    expect(after).not.toBe(before) // token drifted on the metadata change
  })
})
