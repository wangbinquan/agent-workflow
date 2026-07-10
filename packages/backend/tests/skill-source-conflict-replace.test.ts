import { rimrafDir } from './helpers/cleanup'
// RFC-102: replaceSourceConflict — resolving a source same-name conflict by
// replacing the OCCUPYING skill with the source's version of `name`.
//
// Locks the two-gate model: the route enforces source-registrar rights, the
// service enforces WRITE permission on the occupying skill (owner/admin). The
// replace keeps the name so agent references survive (no skill-in-use block),
// re-homes the skill to the source (sourceId), and is idempotent. Red here =
// the "no permission ⇒ cannot replace" guarantee or the re-home drifted.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, skillSources } from '../src/db/schema'
import { createSkillSource, replaceSourceConflict } from '../src/services/skill-source'
import { createManagedSkill, getSkill, type SkillFsOptions } from '../src/services/skill'
import { buildActor, type Actor } from '../src/auth/actor'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}
const ALICE = actor('alice')
const BOB = actor('bob')
const ADMIN = actor('admin-1', 'admin')

interface H {
  db: DbClient
  parent: string
  fsOpts: SkillFsOptions
  cleanup: () => void
}

function build(): H {
  const parent = mkdtempSync(join(tmpdir(), 'aw-src-replace-'))
  const appHome = mkdtempSync(join(tmpdir(), 'aw-src-replace-home-'))
  return {
    db: createInMemoryDb(MIGRATIONS),
    parent,
    fsOpts: { appHome },
    cleanup: () => {
      rimrafDir(parent)
      rimrafDir(appHome)
    },
  }
}

function addSourceSkill(parent: string, name: string, description = 'from source'): void {
  mkdirSync(join(parent, name), { recursive: true })
  writeFileSync(
    join(parent, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  )
}

async function seedManaged(h: H, name: string, owner: Actor) {
  return createManagedSkill(
    h.db,
    h.fsOpts,
    { name, description: `${owner.user.id} managed`, bodyMd: 'b', frontmatterExtra: {} },
    { ownerUserId: owner.user.id },
  )
}

let h: H
beforeEach(() => {
  h = build()
})
afterEach(() => h.cleanup())

describe('replaceSourceConflict (RFC-102)', () => {
  test('owner of the occupier replaces it; the skill re-homes to the source', async () => {
    await seedManaged(h, 'dup', ALICE)
    addSourceSkill(h.parent, 'dup', 'from source')
    const { source, outcome } = await createSkillSource(
      h.db,
      { path: h.parent },
      { createdBy: ALICE.user.id },
    )
    // First scan skips dup as a manual conflict.
    expect(outcome.skipped.find((s) => s.proposedName === 'dup')?.reason).toBe(
      'name-conflict-manual',
    )

    const res = await replaceSourceConflict(h.db, h.fsOpts, ALICE, source.id, 'dup')
    expect(res.replaced).toBe('dup')
    expect(res.imported.sourceKind).toBe('external')
    expect(res.imported.sourceId).toBe(source.id)

    const row = await getSkill(h.db, 'dup')
    expect(row!.sourceId).toBe(source.id)
    expect(row!.sourceKind).toBe('external')
    expect(row!.description).toBe('from source')
  })

  test('non-owner of the occupier is rejected (403) and the occupier is untouched', async () => {
    await seedManaged(h, 'dup', ALICE)
    addSourceSkill(h.parent, 'dup')
    // BOB registered the source but does NOT own the occupying skill.
    const { source } = await createSkillSource(h.db, { path: h.parent }, { createdBy: BOB.user.id })
    const err = await replaceSourceConflict(h.db, h.fsOpts, BOB, source.id, 'dup').catch((e) => e)
    expect(err.code).toBe('forbidden')

    const row = await getSkill(h.db, 'dup')
    expect(row!.ownerUserId).toBe(ALICE.user.id)
    expect(row!.sourceKind).toBe('managed')
  })

  test('admin can replace another user occupier', async () => {
    await seedManaged(h, 'dup', ALICE)
    addSourceSkill(h.parent, 'dup', 'src')
    const { source } = await createSkillSource(
      h.db,
      { path: h.parent },
      { createdBy: ALICE.user.id },
    )
    const res = await replaceSourceConflict(h.db, h.fsOpts, ADMIN, source.id, 'dup')
    expect(res.imported.sourceId).toBe(source.id)
    expect(res.imported.sourceKind).toBe('external')
  })

  test('occupier referenced by an agent can still be replaced (name preserved)', async () => {
    await seedManaged(h, 'dup', ALICE)
    const now = Date.now()
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'agent-using-dup',
      skills: JSON.stringify(['dup']),
      visibility: 'public',
      createdAt: now,
      updatedAt: now,
    })
    addSourceSkill(h.parent, 'dup', 'src')
    const { source } = await createSkillSource(
      h.db,
      { path: h.parent },
      { createdBy: ALICE.user.id },
    )
    // deleteSkill would throw skill-in-use here; replace must NOT.
    const res = await replaceSourceConflict(h.db, h.fsOpts, ALICE, source.id, 'dup')
    expect(res.replaced).toBe('dup')
    // 'dup' still exists (now external from the source) so the agent ref holds.
    const row = await getSkill(h.db, 'dup')
    expect(row!.sourceId).toBe(source.id)
  })

  test('idempotent when the name already belongs to the source', async () => {
    addSourceSkill(h.parent, 'solo')
    const { source } = await createSkillSource(
      h.db,
      { path: h.parent },
      { createdBy: ALICE.user.id },
    )
    // 'solo' was imported on first scan (no conflict); replace is a no-op converge.
    const res = await replaceSourceConflict(h.db, h.fsOpts, ALICE, source.id, 'solo')
    expect(res.replaced).toBe('solo')
    expect(res.imported.sourceId).toBe(source.id)
  })

  test('replacing a name absent from the source dir → stale (422)', async () => {
    addSourceSkill(h.parent, 'real')
    const { source } = await createSkillSource(
      h.db,
      { path: h.parent },
      { createdBy: ALICE.user.id },
    )
    const err = await replaceSourceConflict(h.db, h.fsOpts, ALICE, source.id, 'ghost').catch(
      (e) => e,
    )
    expect(err.code).toBe('skill-source-conflict-stale')
  })

  test('replacing under a disabled source is rejected (no resurrection)', async () => {
    await seedManaged(h, 'dup', ALICE)
    addSourceSkill(h.parent, 'dup')
    const { source } = await createSkillSource(
      h.db,
      { path: h.parent },
      { createdBy: ALICE.user.id },
    )
    await h.db.update(skillSources).set({ enabled: false }).where(eq(skillSources.id, source.id))
    const err = await replaceSourceConflict(h.db, h.fsOpts, ALICE, source.id, 'dup').catch((e) => e)
    expect(err.code).toBe('skill-source-disabled')
    // Occupier untouched — not resurrected from the disabled folder.
    expect((await getSkill(h.db, 'dup'))!.sourceKind).toBe('managed')
  })
})
