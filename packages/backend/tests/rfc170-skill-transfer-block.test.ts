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

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills, users } from '../src/db/schema'
import { getResourceAcl, updateResourceAcl, type AclRow } from '../src/services/resourceAcl'
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
