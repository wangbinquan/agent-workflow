// RFC-019: backend commit logic — decision matrix + per-skill failure
// isolation + filesystem layout invariants.
//
// RFC-102: ZIP overwrite now requires write permission (owner/admin). Every
// pre-existing call passes an ADMIN actor so the legacy decision-matrix
// behaviour is unchanged (admin bypasses the permission gate); the dedicated
// "RFC-102 overwrite permission" block below locks in the new gate with
// non-admin owners while keeping inaccessible and missing targets
// indistinguishable.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { zipSync, type Zippable } from 'fflate'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills } from '../src/db/schema'
import {
  commitSkillZipBuffer,
  parseSkillZipBuffer,
  type SkillZipFsOptions,
} from '../src/services/skill-zip'
import { getSkill, getSkillById, createManagedSkill } from '../src/services/skill'
import { commitSkillVersion } from '../src/services/skillVersion'
import { buildActor, type Actor } from '../src/auth/actor'
import type { SkillZipDecision, SkillZipDecisionMap } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}
const ADMIN = actor('admin-1', 'admin')
const ALICE = actor('alice')
const BOB = actor('bob')

interface H {
  db: DbClient
  fsOpts: SkillZipFsOptions
  cleanup: () => void
}

function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-zip-commit-'))
  return {
    db: createInMemoryDb(MIGRATIONS),
    fsOpts: { appHome },
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

function buildZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const z: Zippable = {}
  for (const [k, v] of Object.entries(files)) {
    z[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v
  }
  return zipSync(z)
}

const skillMd = (name: string, desc = 'd') =>
  `---\nname: ${name}\ndescription: ${desc}\n---\nbody for ${name}\n`

type OverwriteDecision = Extract<SkillZipDecision, { action: 'overwrite' }>

async function previewOverwrite(
  h: H,
  actor: Actor,
  buffer: Uint8Array,
  candidateName: string,
  targetSkillId?: string,
): Promise<OverwriteDecision> {
  const { response } = await parseSkillZipBuffer(h.db, actor, buffer)
  const candidate = response.skills.find((row) => row.name === candidateName)
  const target =
    candidate?.overwriteCandidates.find((row) => row.skillId === targetSkillId) ??
    (targetSkillId === undefined && candidate?.overwriteCandidates.length === 1
      ? candidate.overwriteCandidates[0]
      : undefined)
  if (target === undefined) throw new Error(`missing overwrite preview for ${candidateName}`)
  return {
    action: 'overwrite',
    skillId: target.skillId,
    expectedOwnerUserId: target.ownerUserId,
    expectedVisibility: target.visibility,
    expectedAclRevision: target.expectedAclRevision,
    expectedToken: target.expectedToken,
  }
}

describe('commitSkillZipBuffer', () => {
  let h: H
  beforeEach(() => {
    h = build()
  })
  afterEach(() => h.cleanup())

  test('all candidates with import decision are created', async () => {
    const buf = buildZip({
      'skill-a/SKILL.md': skillMd('skill-a', 'a desc'),
      'skill-a/extra.md': '# extra',
      'skill-b/SKILL.md': skillMd('skill-b', 'b desc'),
    })
    const decisions: SkillZipDecisionMap = {
      'skill-a': { action: 'import' },
      'skill-b': { action: 'import' },
    }
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, decisions, { actor: ADMIN })
    expect(r.created.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b'])
    expect(r.updated).toEqual([])
    expect(r.failed).toEqual([])
    const skillA = r.created.find((skill) => skill.name === 'skill-a')!
    expect(existsSync(join(h.fsOpts.appHome, 'skills', skillA.id, 'files', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(h.fsOpts.appHome, 'skills', skillA.id, 'files', 'extra.md'))).toBe(true)
  })

  test('skip decision leaves DB + FS untouched for that candidate', async () => {
    const buf = buildZip({ 'skill-x/SKILL.md': skillMd('skill-x') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { 'skill-x': { action: 'skip' } },
      { actor: ADMIN },
    )
    expect(r.created).toEqual([])
    expect(r.skipped.map((s) => s.name)).toEqual(['skill-x'])
    expect(await getSkill(h.db, 'skill-x')).toBeNull()
  })

  test('overwrite replaces managed skill content and keeps DB id stable', async () => {
    const before = await createManagedSkill(h.db, h.fsOpts, {
      name: 'skill-o',
      description: 'old desc',
      bodyMd: 'old body',
      frontmatterExtra: {},
    })
    // Drop a sentinel file to verify it gets removed by the overwrite step.
    const sentinelPath = join(h.fsOpts.appHome, 'skills', before.id, 'files', 'sentinel.txt')
    writeFileSync(sentinelPath, 'remove-me')

    const buf = buildZip({
      'skill-o/SKILL.md': skillMd('skill-o', 'new desc'),
      'skill-o/fresh.md': '# fresh',
    })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { 'skill-o': await previewOverwrite(h, ADMIN, buf, 'skill-o') },
      { actor: ADMIN },
    )
    expect(r.updated.map((s) => s.id)).toEqual([before.id])
    expect(r.updated[0]!.description).toBe('new desc')

    const skillRoot = join(h.fsOpts.appHome, 'skills', before.id, 'files')
    expect(existsSync(join(skillRoot, 'sentinel.txt'))).toBe(false)
    expect(existsSync(join(skillRoot, 'fresh.md'))).toBe(true)
    const md = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8')
    expect(md).toContain('description: new desc')
    expect(md).toContain('name: skill-o')
  })

  // RFC-170 (ZIP→version funnel): an overwrite now routes through commitSkillVersion
  // instead of a direct FS+DB write — so it bumps content_version, archives the new
  // tree as an immutable version snapshot, and (via the funnel) picks up the in-tx
  // composite/owner fence + op-scoped crash rollback.
  test('overwrite goes through the version funnel — bumps content_version + snapshots the tree', async () => {
    const before = await createManagedSkill(h.db, h.fsOpts, {
      name: 'skill-v',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    expect(before.contentVersion).toBe(1)
    const buf = buildZip({
      'skill-v/SKILL.md': skillMd('skill-v', 'd2'),
      'skill-v/x.md': '# x',
    })
    await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { 'skill-v': await previewOverwrite(h, ADMIN, buf, 'skill-v') },
      { actor: ADMIN },
    )
    const after = await getSkill(h.db, 'skill-v')
    expect(after!.contentVersion).toBe(2) // versioned via commitSkillVersion, not a raw write
    // The immutable v2 snapshot exists (the funnel archived the overwritten tree).
    const snap = join(h.fsOpts.appHome, 'skills', before.id, 'versions', 'v2', 'files', 'SKILL.md')
    expect(existsSync(snap)).toBe(true)
    expect(readFileSync(snap, 'utf-8')).toContain('description: d2')
  })

  test('rename re-targets to new name; original skill name stays free', async () => {
    const buf = buildZip({ 'skill-orig/SKILL.md': skillMd('skill-orig', 'desc') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { 'skill-orig': { action: 'rename', newName: 'skill-new' } },
      { actor: ADMIN },
    )
    expect(r.created.map((s) => s.name)).toEqual(['skill-new'])
    expect(await getSkill(h.db, 'skill-orig')).toBeNull()
    expect(
      existsSync(join(h.fsOpts.appHome, 'skills', r.created[0]!.id, 'files', 'SKILL.md')),
    ).toBe(true)
  })

  test('rename to a name already in DB fails with skill-rename-conflict', async () => {
    await createManagedSkill(
      h.db,
      h.fsOpts,
      {
        name: 'taken',
        description: '',
        bodyMd: '',
        frontmatterExtra: {},
      },
      { ownerUserId: ADMIN.user.id },
    )
    const buf = buildZip({ 'skill-from-zip/SKILL.md': skillMd('skill-from-zip') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { 'skill-from-zip': { action: 'rename', newName: 'taken' } },
      { actor: ADMIN },
    )
    expect(r.failed[0]!.code).toBe('skill-rename-conflict')
  })

  test('two renames to the same target inside one batch — second fails', async () => {
    const buf = buildZip({
      'a/SKILL.md': skillMd('a'),
      'b/SKILL.md': skillMd('b'),
    })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      {
        a: { action: 'rename', newName: 'merged' },
        b: { action: 'rename', newName: 'merged' },
      },
      { actor: ADMIN },
    )
    expect(r.created.map((s) => s.name)).toEqual(['merged'])
    expect(r.failed.map((f) => f.code)).toEqual(['skill-rename-conflict'])
  })

  test('rename newName fails kebab-case → skill-name-invalid', async () => {
    const buf = buildZip({ 'skill-r/SKILL.md': skillMd('skill-r') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { 'skill-r': { action: 'rename', newName: 'Bad Name' as never } },
      { actor: ADMIN },
    )
    expect(r.failed[0]!.code).toBe('skill-name-invalid')
    expect(r.created).toEqual([])
  })

  test('candidate without a decision is reported as skipped', async () => {
    const buf = buildZip({
      'a/SKILL.md': skillMd('a'),
      'b/SKILL.md': skillMd('b'),
    })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { a: { action: 'import' } },
      { actor: ADMIN },
    )
    expect(r.created.map((s) => s.name)).toEqual(['a'])
    expect(r.skipped.find((s) => s.name === 'b')).toBeDefined()
  })

  test('decision targeting a non-existent candidate is reported as skipped', async () => {
    const buf = buildZip({ 'only/SKILL.md': skillMd('only') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      {
        only: { action: 'import' },
        ghost: { action: 'import' },
      },
      { actor: ADMIN },
    )
    expect(r.skipped.find((s) => s.name === 'ghost')).toBeDefined()
  })

  test('parseSkillZipBuffer flags DB conflict on candidate view', async () => {
    await createManagedSkill(
      h.db,
      h.fsOpts,
      {
        name: 'dup',
        description: '',
        bodyMd: '',
        frontmatterExtra: {},
      },
      { ownerUserId: ADMIN.user.id },
    )
    const buf = buildZip({
      'dup/SKILL.md': skillMd('dup'),
      'fresh/SKILL.md': skillMd('fresh'),
    })
    const { response } = await parseSkillZipBuffer(h.db, ADMIN, buf)
    const dup = response.skills.find((s) => s.name === 'dup')!
    expect(dup.conflict).toBe('managed')
    const fresh = response.skills.find((s) => s.name === 'fresh')!
    expect(fresh.conflict).toBeUndefined()
    expect(fresh.overwriteCandidates).toEqual([])
  })

  test('frontmatterExtra round-trips into rewritten SKILL.md', async () => {
    const buf = buildZip({
      'skill-fm/SKILL.md':
        '---\nname: skill-fm\ndescription: d\nauthor: alice\nversion: 1\n---\nbody\n',
    })
    const result = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { 'skill-fm': { action: 'import' } },
      { actor: ADMIN },
    )
    const md = readFileSync(
      join(h.fsOpts.appHome, 'skills', result.created[0]!.id, 'files', 'SKILL.md'),
      'utf-8',
    )
    expect(md).toContain('author: alice')
    expect(md).toContain('version: 1')
    expect(md).toContain('name: skill-fm')
  })
})

// RFC-102: the write-permission gate on ZIP overwrite. Owners (and admins) may
// replace a same-named managed skill; everyone else receives the same stale
// response as a missing target but may still rename-import a private copy.
describe('RFC-102 overwrite permission', () => {
  let h: H
  beforeEach(() => {
    h = build()
  })
  afterEach(() => h.cleanup())

  /** A managed skill owned by ALICE. */
  async function seedAliceSkill(name = 'owned') {
    return createManagedSkill(
      h.db,
      h.fsOpts,
      { name, description: 'alice owns', bodyMd: 'alice body', frontmatterExtra: {} },
      { ownerUserId: ALICE.user.id },
    )
  }

  test('non-owner and missing targets are indistinguishable', async () => {
    const target = await seedAliceSkill('owned')
    const buf = buildZip({ 'owned/SKILL.md': skillMd('owned', 'bob tries') })
    // Replaying another actor's preview cannot turn it into write authority.
    const stolenPreview = await previewOverwrite(h, ALICE, buf, 'owned')
    const hidden = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { owned: stolenPreview },
      { actor: BOB },
    )
    expect(hidden.updated).toEqual([])
    expect(hidden.created).toEqual([])
    expect(hidden.failed).toHaveLength(1)

    h.db.delete(skills).where(eq(skills.id, target.id)).run()
    const missing = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { owned: stolenPreview },
      { actor: BOB },
    )
    expect(missing.updated).toEqual([])
    expect(missing.created).toEqual([])
    expect(missing.failed).toHaveLength(1)
    expect({
      code: hidden.failed[0]!.code,
      message: hidden.failed[0]!.message,
    }).toEqual({
      code: missing.failed[0]!.code,
      message: missing.failed[0]!.message,
    })
    expect(hidden.failed[0]!.code).toBe('skill-overwrite-stale')
    // Alice's content is untouched.
    expect(
      readFileSync(join(h.fsOpts.appHome, 'skills', target.id, 'files', 'SKILL.md'), 'utf8'),
    ).toContain('alice owns')
  })

  test('owner overwrite succeeds', async () => {
    const before = await seedAliceSkill('owned')
    const buf = buildZip({ 'owned/SKILL.md': skillMd('owned', 'alice updates') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { owned: await previewOverwrite(h, ALICE, buf, 'owned') },
      { actor: ALICE },
    )
    expect(r.failed).toEqual([])
    expect(r.updated.map((s) => s.id)).toEqual([before.id])
    expect(r.updated[0]!.description).toBe('alice updates')
  })

  test('admin overwrite of another user skill succeeds', async () => {
    await seedAliceSkill('owned')
    const buf = buildZip({ 'owned/SKILL.md': skillMd('owned', 'admin updates') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { owned: await previewOverwrite(h, ADMIN, buf, 'owned') },
      { actor: ADMIN },
    )
    expect(r.failed).toEqual([])
    expect(r.updated.map((s) => s.name)).toEqual(['owned'])
  })

  test('non-owner may still rename-import a private copy', async () => {
    await seedAliceSkill('owned')
    const buf = buildZip({ 'owned/SKILL.md': skillMd('owned', 'bob copy') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { owned: { action: 'rename', newName: 'owned-bob' } },
      { actor: BOB },
    )
    expect(r.failed).toEqual([])
    expect(r.created.map((s) => s.name)).toEqual(['owned-bob'])
    // Alice's original is still there, owned by alice.
    expect((await getSkill(h.db, 'owned'))!.ownerUserId).toBe(ALICE.user.id)
  })

  test('parse exposes only exact targets the actor may overwrite', async () => {
    await seedAliceSkill('owned')
    const buf = buildZip({ 'owned/SKILL.md': skillMd('owned') })

    const asAlice = await parseSkillZipBuffer(h.db, ALICE, buf)
    expect(asAlice.response.skills[0]!.conflict).toBe('managed')
    expect(asAlice.response.skills[0]!.overwriteCandidates).toHaveLength(1)
    expect(asAlice.response.skills[0]!.overwriteCandidates[0]!.ownerUserId).toBe(ALICE.user.id)

    const asBob = await parseSkillZipBuffer(h.db, BOB, buf)
    expect(asBob.response.skills[0]!.conflict).toBeUndefined()
    expect(asBob.response.skills[0]!.overwriteCandidates).toEqual([])

    const asAdmin = await parseSkillZipBuffer(h.db, ADMIN, buf)
    expect(asAdmin.response.skills[0]!.conflict).toBeUndefined()
    expect(asAdmin.response.skills[0]!.overwriteCandidates).toHaveLength(1)
  })
})

// RFC-223 AC19 / R5-1: ZIP import resolves the create slot by actor owner,
// while overwrite is a two-step exact-id operation whose owner/ACL/content
// snapshot is rechecked at apply. These cases must be green before the global
// name-unique index is removed.
describe('RFC-223 AC19 owner-scoped ZIP import', () => {
  let h: H
  beforeEach(() => {
    h = build()
  })
  afterEach(() => h.cleanup())

  async function seed(owner: Actor, name: string, description: string) {
    return createManagedSkill(
      h.db,
      h.fsOpts,
      { name, description, bodyMd: description, frontmatterExtra: {} },
      { ownerUserId: owner.user.id },
    )
  }

  test('ordinary import claims only the actor owner/name slot', async () => {
    const aliceSkill = await seed(ALICE, 'shared-name', 'alice original')
    const zip = buildZip({
      'shared-name/SKILL.md': skillMd('shared-name', 'bob imported'),
    })

    const preview = await parseSkillZipBuffer(h.db, BOB, zip)
    expect(preview.response.skills[0]).toMatchObject({
      name: 'shared-name',
      overwriteCandidates: [],
    })
    expect(preview.response.skills[0]!.conflict).toBeUndefined()

    const result = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      zip,
      { 'shared-name': { action: 'import' } },
      { actor: BOB },
    )
    expect(result.failed).toEqual([])
    expect(result.created).toHaveLength(1)
    expect(result.created[0]).toMatchObject({
      name: 'shared-name',
      ownerUserId: BOB.user.id,
    })
    expect(await getSkillById(h.db, aliceSkill.id)).toMatchObject({
      description: 'alice original',
      ownerUserId: ALICE.user.id,
    })
  })

  test('admin preview keeps A/B same-name targets distinct and overwrites only the chosen id', async () => {
    const aliceSkill = await seed(ALICE, 'same', 'alice original')
    const bobSkill = await seed(BOB, 'same', 'bob original')
    const zip = buildZip({ 'same/SKILL.md': skillMd('same', 'chosen update') })

    const preview = await parseSkillZipBuffer(h.db, ADMIN, zip)
    const row = preview.response.skills[0]!
    expect(row.conflict).toBeUndefined()
    expect(row.overwriteCandidates.map((candidate) => candidate.skillId).sort()).toEqual(
      [aliceSkill.id, bobSkill.id].sort(),
    )

    const result = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      zip,
      { same: await previewOverwrite(h, ADMIN, zip, 'same', bobSkill.id) },
      { actor: ADMIN },
    )
    expect(result.failed).toEqual([])
    expect(result.updated.map((skill) => skill.id)).toEqual([bobSkill.id])
    expect(await getSkillById(h.db, aliceSkill.id)).toMatchObject({
      description: 'alice original',
    })
    expect(await getSkillById(h.db, bobSkill.id)).toMatchObject({
      description: 'chosen update',
    })
  })

  test('content version drift after preview fails closed without overwriting the newer tree', async () => {
    const target = await seed(ALICE, 'versioned', 'v1')
    const staleZip = buildZip({ 'versioned/SKILL.md': skillMd('versioned', 'stale') })
    const staleDecision = await previewOverwrite(h, ADMIN, staleZip, 'versioned', target.id)

    const staleResult = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      staleZip,
      { versioned: staleDecision },
      {
        actor: ADMIN,
        __beforeOverwriteVersionForTest: ({ skillId }) => {
          commitSkillVersion(
            h.db,
            h.fsOpts,
            skillId,
            (staging) => {
              writeFileSync(join(staging, 'SKILL.md'), skillMd('versioned', 'v2'))
            },
            {
              source: 'editor',
              authorUserId: ADMIN.user.id,
              setDescription: 'v2',
            },
          )
        },
      },
    )
    expect(staleResult.updated).toEqual([])
    expect(staleResult.failed.map((failure) => failure.code)).toEqual(['skill-overwrite-stale'])
    expect(await getSkillById(h.db, target.id)).toMatchObject({
      description: 'v2',
      contentVersion: 2,
    })
  })

  test('owner drift after preview fails closed for a resource admin', async () => {
    const target = await seed(ALICE, 'owner-drift', 'original')
    const zip = buildZip({ 'owner-drift/SKILL.md': skillMd('owner-drift', 'stale') })
    const decision = await previewOverwrite(h, ADMIN, zip, 'owner-drift', target.id)

    const result = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      zip,
      { 'owner-drift': decision },
      {
        actor: ADMIN,
        __beforeOverwriteVersionForTest: ({ skillId }) => {
          h.db
            .update(skills)
            .set({ ownerUserId: BOB.user.id, aclRevision: decision.expectedAclRevision + 1 })
            .where(eq(skills.id, skillId))
            .run()
        },
      },
    )
    expect(result.updated).toEqual([])
    expect(result.failed.map((failure) => failure.code)).toEqual(['skill-overwrite-stale'])
    expect(await getSkillById(h.db, target.id)).toMatchObject({
      description: 'original',
      ownerUserId: BOB.user.id,
    })
  })

  test('visibility/ACL revision drift after preview fails closed', async () => {
    const target = await seed(ALICE, 'visibility-drift', 'original')
    const zip = buildZip({
      'visibility-drift/SKILL.md': skillMd('visibility-drift', 'stale'),
    })
    const decision = await previewOverwrite(h, ADMIN, zip, 'visibility-drift', target.id)

    const result = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      zip,
      { 'visibility-drift': decision },
      {
        actor: ADMIN,
        __beforeOverwriteVersionForTest: ({ skillId }) => {
          h.db
            .update(skills)
            .set({ visibility: 'private', aclRevision: decision.expectedAclRevision + 1 })
            .where(eq(skills.id, skillId))
            .run()
        },
      },
    )
    expect(result.updated).toEqual([])
    expect(result.failed.map((failure) => failure.code)).toEqual(['skill-overwrite-stale'])
    expect(await getSkillById(h.db, target.id)).toMatchObject({
      description: 'original',
      visibility: 'private',
    })
  })
})
