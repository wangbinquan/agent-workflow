// Regression lock — 2026-07-15 production incident: on a LIVE daemon (RFC-170
// boot availability gate active) every ZIP-import CREATE failed with
// "skill write failed: skill disappeared right after insert".
//
// Root cause: the zip create branch wrote live files/ directly and inserted a
// bare skills row (schema-default versionState='legacy-unbackfilled', no v1
// snapshot, never boot-verified) — the gated getSkill re-read hid the row and
// the importer threw. Unit tests stayed green because the gate is inactive
// until runBootSnapshotReverify/activateBootReverifyForTest runs, so EVERY
// test here activates the gate first. Also locks the fallout fixes:
//   - the failure path used to leave a husk row (no files) squatting the name
//     forever → backfillLegacySkillVersions sweeps such husks at boot;
//   - the failure path used to rm the target files dir, which could delete a
//     concurrent winner's just-published live files → creates now roll back
//     inside the funnel only, and a gate-hidden occupier is reported as an
//     accurate conflict without touching its files;
//   - 'quarantined' was a one-way state (boot rescan skipped it) → a restored
//     snapshot that re-matches content_hash now exits quarantine at boot.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { zipSync, type Zippable } from 'fflate'
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills, skillVersions } from '../src/db/schema'
import { commitSkillZipBuffer, type SkillZipFsOptions } from '../src/services/skill-zip'
import {
  createManagedSkill,
  createManagedSkillWithFiles,
  getSkill,
  listSkills,
} from '../src/services/skill'
import { backfillLegacySkillVersions } from '../src/services/skillVersion'
import {
  activateBootReverifyForTest,
  isSkillBootVerified,
  resetSkillBootVerifyForTest,
  runBootSnapshotReverify,
} from '../src/services/skillBootVerify'
import { buildActor, type Actor } from '../src/auth/actor'
import type { SkillZipDecisionMap } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}
const ALICE = actor('alice')

interface H {
  db: DbClient
  fsOpts: SkillZipFsOptions
  cleanup: () => void
}

function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-zip-gate-'))
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

/** Raw row lookup — deliberately bypasses the gated getSkill. */
function rawRow(db: DbClient, name: string) {
  return (
    db.select().from(skills).where(eq(skills.name, name)).all() as Array<typeof skills.$inferSelect>
  )[0]
}

/** rawRow that must exist (throws instead of returning undefined). */
function mustRow(db: DbClient, name: string) {
  const row = rawRow(db, name)
  if (row === undefined) throw new Error(`expected a skills row for '${name}'`)
  return row
}

/** Insert a bare skills row the way the pre-fix zip importer did. */
function insertBareRow(
  db: DbClient,
  name: string,
  over: Partial<typeof skills.$inferInsert> = {},
): string {
  const id = ulid()
  const now = Date.now()
  db.insert(skills)
    .values({
      id,
      name,
      description: 'bare',
      sourceKind: 'managed',
      managedPath: `skills/${name}/files`,
      visibility: 'public',
      createdAt: now,
      updatedAt: now,
      ...over,
    })
    .run()
  return id
}

describe('zip import create under the ACTIVE boot availability gate', () => {
  let h: H
  beforeEach(() => {
    h = build()
    resetSkillBootVerifyForTest()
    activateBootReverifyForTest()
  })
  afterEach(() => {
    h.cleanup()
    resetSkillBootVerifyForTest()
  })

  test('create succeeds, is immediately visible, and has an authoritative v1 snapshot', async () => {
    const buf = buildZip({
      'pack-a/SKILL.md': skillMd('pack-a', 'a desc'),
      'pack-a/ref.md': '# reference',
    })
    const decisions: SkillZipDecisionMap = { 'pack-a': { action: 'import' } }
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, decisions, { actor: ALICE })

    expect(r.failed).toEqual([])
    expect(r.created.map((s) => s.name)).toEqual(['pack-a'])
    expect(r.created[0]!.description).toBe('a desc')

    // Visible through the gated readers (the incident's failing re-read).
    const skill = await getSkill(h.db, 'pack-a')
    expect(skill).not.toBeNull()
    expect((await listSkills(h.db)).map((s) => s.name)).toContain('pack-a')

    // Full RFC-170 create shape: authoritative + boot-verified + v1 snapshot.
    const row = mustRow(h.db, 'pack-a')
    expect(row.versionState).toBe('snapshot-authoritative')
    expect(row.reservationState).toBe('ready')
    expect(isSkillBootVerified(row.id)).toBe(true)
    const versions = h.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillName, 'pack-a'))
      .all()
    expect(versions.length).toBe(1)
    const snapDir = join(h.fsOpts.appHome, 'skills', 'pack-a', 'versions', 'v1', 'files')
    expect(existsSync(join(snapDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(snapDir, 'ref.md'))).toBe(true)
    const liveDir = join(h.fsOpts.appHome, 'skills', 'pack-a', 'files')
    expect(readFileSync(join(liveDir, 'ref.md'), 'utf-8')).toBe('# reference')
    // Importer became owner (RFC-099 D18).
    expect(row.ownerUserId).toBe('alice')
  })

  test('a failing files producer rolls the whole create back (no row, no files, no husk)', async () => {
    await expect(
      createManagedSkillWithFiles(
        h.db,
        h.fsOpts,
        { name: 'boom', description: 'd', ownerUserId: 'alice' },
        () => {
          throw new Error('producer exploded')
        },
      ),
    ).rejects.toThrow('producer exploded')
    expect(rawRow(h.db, 'boom')).toBeUndefined()
    expect(existsSync(join(h.fsOpts.appHome, 'skills', 'boom'))).toBe(false)
  })

  test('a gate-hidden occupier yields an accurate conflict and its files are NOT touched', async () => {
    // A real skill that the gate currently hides (e.g. not yet re-verified this
    // boot). The pre-fix code path saw "name free", failed on the UNIQUE
    // constraint, then rm'd the occupier's live files in its catch cleanup.
    resetSkillBootVerifyForTest() // gate off so create works
    await createManagedSkill(h.db, h.fsOpts, {
      name: 'occupied',
      description: 'mine',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    resetSkillBootVerifyForTest()
    activateBootReverifyForTest() // gate on, bootVerifiedSet empty → hidden
    expect(await getSkill(h.db, 'occupied')).toBeNull()

    const buf = buildZip({ 'occupied/SKILL.md': skillMd('occupied') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { occupied: { action: 'import' } },
      { actor: ALICE },
    )
    expect(r.created).toEqual([])
    expect(r.failed.length).toBe(1)
    expect(r.failed[0]!.code).toBe('skill-rename-conflict')
    expect(r.failed[0]!.message).toContain('unavailable')
    // Occupier intact: row still there, live files never deleted.
    expect(rawRow(h.db, 'occupied')).toBeDefined()
    expect(existsSync(join(h.fsOpts.appHome, 'skills', 'occupied', 'files', 'SKILL.md'))).toBe(true)
  })

  test('the pre-fix bare-insert path is gone from the importer source', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'skill-zip.ts'),
      'utf-8',
    )
    // Code-shape locks (comments may still MENTION the incident): no direct
    // skills-table insert and no post-insert "disappeared" throw in the importer.
    expect(src).not.toMatch(/\.insert\(skills\)/)
    expect(src).not.toMatch(/new Error\('skill disappeared/)
  })
})

describe('backfillLegacySkillVersions — legacy promote + husk sweep', () => {
  let h: H
  beforeEach(() => {
    h = build()
    resetSkillBootVerifyForTest()
  })
  afterEach(() => {
    h.cleanup()
    resetSkillBootVerifyForTest()
  })

  test('husk (no files, no versions) is deleted; healthy legacy is promoted; reserving is untouched', () => {
    // ① husk: what the pre-fix zip failure path left behind — row without files.
    insertBareRow(h.db, 'husk')
    // ② healthy legacy: pre-RFC-101 skill — row + live files, no version rows.
    insertBareRow(h.db, 'legacy-ok')
    const legacyFiles = join(h.fsOpts.appHome, 'skills', 'legacy-ok', 'files')
    mkdirSync(legacyFiles, { recursive: true })
    writeFileSync(join(legacyFiles, 'SKILL.md'), skillMd('legacy-ok'), 'utf-8')
    // ③ reserving: an in-flight create's row — the sweep must never touch it.
    insertBareRow(h.db, 'mid-create', { reservationState: 'reserving' })

    const r = backfillLegacySkillVersions(h.db, { appHome: h.fsOpts.appHome })
    expect(r.husksRemoved).toBe(1)
    expect(r.backfilled).toBe(1)

    expect(rawRow(h.db, 'husk')).toBeUndefined() // name freed
    const legacy = mustRow(h.db, 'legacy-ok')
    expect(legacy.versionState).toBe('snapshot-authoritative')
    expect(isSkillBootVerified(legacy.id)).toBe(true)
    expect(
      existsSync(
        join(h.fsOpts.appHome, 'skills', 'legacy-ok', 'versions', 'v1', 'files', 'SKILL.md'),
      ),
    ).toBe(true)
    const reserving = mustRow(h.db, 'mid-create')
    expect(reserving.versionState).toBe('legacy-unbackfilled')
  })

  test('a legacy row with support files but no SKILL.md is NOT deleted (Codex P1)', () => {
    // Same DB shape as a husk, but the dir still has recoverable content —
    // e.g. a pre-RFC-101 skill whose main file was lost. Deleting it would
    // destroy the support files + the resource identity; the sweep must leave
    // it for a human to repair.
    insertBareRow(h.db, 'wounded')
    const woundedFiles = join(h.fsOpts.appHome, 'skills', 'wounded', 'files')
    mkdirSync(woundedFiles, { recursive: true })
    writeFileSync(join(woundedFiles, 'reference.md'), '# still valuable', 'utf-8')

    const r = backfillLegacySkillVersions(h.db, { appHome: h.fsOpts.appHome })
    expect(r.husksRemoved).toBe(0)
    expect(r.backfilled).toBe(0)
    expect(mustRow(h.db, 'wounded').versionState).toBe('legacy-unbackfilled')
    expect(readFileSync(join(woundedFiles, 'reference.md'), 'utf-8')).toBe('# still valuable')
  })

  test('after the sweep the freed name can be re-imported via zip (end-to-end heal)', async () => {
    insertBareRow(h.db, 'reclaim')
    backfillLegacySkillVersions(h.db, { appHome: h.fsOpts.appHome })
    activateBootReverifyForTest()

    const buf = buildZip({ 'reclaim/SKILL.md': skillMd('reclaim', 'fresh') })
    const r = await commitSkillZipBuffer(
      h.db,
      h.fsOpts,
      buf,
      { reclaim: { action: 'import' } },
      { actor: ALICE },
    )
    expect(r.failed).toEqual([])
    expect(r.created.map((s) => s.name)).toEqual(['reclaim'])
    expect(await getSkill(h.db, 'reclaim')).not.toBeNull()
  })
})

describe('quarantine recovery via boot rescan', () => {
  let h: H
  beforeEach(() => {
    h = build()
    resetSkillBootVerifyForTest()
  })
  afterEach(() => {
    h.cleanup()
    resetSkillBootVerifyForTest()
  })

  test('a quarantined skill whose snapshot matches content_hash again is restored at boot', async () => {
    await createManagedSkill(h.db, h.fsOpts, {
      name: 'quar',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    const id = mustRow(h.db, 'quar').id
    // Simulate an earlier boot having quarantined it (snapshot intact on disk).
    h.db.update(skills).set({ versionState: 'quarantined' }).where(eq(skills.id, id)).run()
    resetSkillBootVerifyForTest()

    runBootSnapshotReverify(h.db, { appHome: h.fsOpts.appHome })
    expect(mustRow(h.db, 'quar').versionState).toBe('snapshot-authoritative')
    expect(await getSkill(h.db, 'quar')).not.toBeNull()
  })

  test('an op-recovery quarantine on a never-published (reserving) row is NOT lifted (Codex P1)', async () => {
    // Impossible-state reserve op: v1 snapshot exists and hashes clean, but the
    // row never reached 'ready'. A content-hash match proves integrity only —
    // not the create/reservation invariants — and resolveSkills gates injection
    // on bootVerifiedSet alone, so lifting this quarantine could stage a
    // never-published skill into a spawn. It must stay fail-closed.
    await createManagedSkill(h.db, h.fsOpts, {
      name: 'frozen',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    const id = mustRow(h.db, 'frozen').id
    h.db
      .update(skills)
      .set({ versionState: 'quarantined', reservationState: 'reserving' })
      .where(eq(skills.id, id))
      .run()
    resetSkillBootVerifyForTest()

    runBootSnapshotReverify(h.db, { appHome: h.fsOpts.appHome })
    const row = mustRow(h.db, 'frozen')
    expect(row.versionState).toBe('quarantined')
    expect(isSkillBootVerified(id)).toBe(false) // never enters the injectable set
    expect(await getSkill(h.db, 'frozen')).toBeNull()
  })

  test('a quarantined skill with a still-corrupt snapshot stays quarantined and hidden', async () => {
    await createManagedSkill(h.db, h.fsOpts, {
      name: 'rot',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    const id = mustRow(h.db, 'rot').id
    h.db.update(skills).set({ versionState: 'quarantined' }).where(eq(skills.id, id)).run()
    writeFileSync(
      join(h.fsOpts.appHome, 'skills', 'rot', 'versions', 'v1', 'files', 'SKILL.md'),
      'tampered',
      'utf-8',
    )
    resetSkillBootVerifyForTest()

    runBootSnapshotReverify(h.db, { appHome: h.fsOpts.appHome })
    expect(mustRow(h.db, 'rot').versionState).toBe('quarantined')
    expect(await getSkill(h.db, 'rot')).toBeNull()
  })
})
