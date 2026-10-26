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
//     forever → B's frozen conversion archives proved empty husks before activation;
//   - the failure path used to rm the target files dir, which could delete a
//     concurrent winner's just-published live files → creates now roll back
//     inside the funnel only, and a gate-hidden occupier is reported as an
//     accurate conflict without touching its files;
//   - 'quarantined' was a one-way state (boot rescan skipped it) → a restored
//     snapshot that re-matches content_hash now exits quarantine at boot.

import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { zipSync, type Zippable } from 'fflate'
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  commitSkillZipBuffer,
  type SkillZipFsOptions,
} from '../src/modules/resource-catalog/infrastructure/legacy/skill-zip'
import {
  createManagedSkill,
  createManagedSkillWithFiles,
  listSkills,
} from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import { getSkill } from './helpers/resourceLookup'

import {
  activateBootReverifyForTest,
  isSkillBootVerified,
  resetSkillBootVerifyForTest,
  runBootSnapshotReverify,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { buildActor, type Actor } from '../src/auth/actor'
import type { SkillZipDecisionMap } from '@agent-workflow/shared'

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}
const ALICE = actor('alice')

interface H {
  db: PersistenceDb
  fsOpts: SkillZipFsOptions
  cleanup: () => void
}

function build(db: PersistenceDb): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-zip-gate-'))
  return {
    db,
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
async function rawRow(db: PersistenceDb, name: string) {
  const { skills } = tablesOf(db)
  return (await db.select().from(skills).where(eq(skills.name, name)))[0]
}

/** rawRow that must exist (throws instead of returning undefined). */
async function mustRow(db: PersistenceDb, name: string) {
  const row = await rawRow(db, name)
  if (row === undefined) throw new Error(`expected a skills row for '${name}'`)
  return row
}

describeEachProvider('zip import create under the ACTIVE boot availability gate', (harness) => {
  let h: H
  beforeEach(() => {
    h = build(harness.db)
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
    const row = await mustRow(h.db, 'pack-a')
    expect(row.versionState).toBe('snapshot-authoritative')
    expect(row.reservationState).toBe('ready')
    expect(isSkillBootVerified(row.id)).toBe(true)
    const { skillVersions } = tablesOf(h.db)
    const versions = await h.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, row.id))
    expect(versions.length).toBe(1)
    const snapDir = join(h.fsOpts.appHome, 'skills', row.id, 'versions', 'v1', 'files')
    expect(existsSync(join(snapDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(snapDir, 'ref.md'))).toBe(true)
    const liveDir = join(h.fsOpts.appHome, 'skills', row.id, 'files')
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
    expect(await rawRow(h.db, 'boom')).toBeUndefined()
    expect(existsSync(join(h.fsOpts.appHome, 'skills', 'boom'))).toBe(false)
  })

  test('a gate-hidden occupier yields an accurate conflict and its files are NOT touched', async () => {
    // A real skill that the gate currently hides (e.g. not yet re-verified this
    // boot). The pre-fix code path saw "name free", failed on the UNIQUE
    // constraint, then rm'd the occupier's live files in its catch cleanup.
    resetSkillBootVerifyForTest() // gate off so create works
    await createManagedSkill(
      h.db,
      h.fsOpts,
      {
        name: 'occupied',
        description: 'mine',
        bodyMd: 'b',
        frontmatterExtra: {},
      },
      { ownerUserId: ALICE.user.id },
    )
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
    expect(await rawRow(h.db, 'occupied')).toBeDefined()
    expect(
      existsSync(
        join(h.fsOpts.appHome, 'skills', (await mustRow(h.db, 'occupied')).id, 'files', 'SKILL.md'),
      ),
    ).toBe(true)
  })
})

// Legacy promote/husk/support-only cases moved to skill-identity-migration.test.ts.

describeEachProvider('quarantine recovery via boot rescan', (harness) => {
  let h: H
  beforeEach(() => {
    h = build(harness.db)
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
    const id = (await mustRow(h.db, 'quar')).id
    const { skills } = tablesOf(h.db)
    // Simulate an earlier boot having quarantined it (snapshot intact on disk).
    await h.db.update(skills).set({ versionState: 'quarantined' }).where(eq(skills.id, id))
    resetSkillBootVerifyForTest()

    await runBootSnapshotReverify(h.db, { appHome: h.fsOpts.appHome })
    expect((await mustRow(h.db, 'quar')).versionState).toBe('snapshot-authoritative')
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
    const id = (await mustRow(h.db, 'frozen')).id
    const { skills } = tablesOf(h.db)
    await h.db
      .update(skills)
      .set({ versionState: 'quarantined', reservationState: 'reserving' })
      .where(eq(skills.id, id))
    resetSkillBootVerifyForTest()

    await runBootSnapshotReverify(h.db, { appHome: h.fsOpts.appHome })
    const row = await mustRow(h.db, 'frozen')
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
    const id = (await mustRow(h.db, 'rot')).id
    const { skills } = tablesOf(h.db)
    await h.db.update(skills).set({ versionState: 'quarantined' }).where(eq(skills.id, id))
    writeFileSync(
      join(h.fsOpts.appHome, 'skills', id, 'versions', 'v1', 'files', 'SKILL.md'),
      'tampered',
      'utf-8',
    )
    resetSkillBootVerifyForTest()

    await runBootSnapshotReverify(h.db, { appHome: h.fsOpts.appHome })
    expect((await mustRow(h.db, 'rot')).versionState).toBe('quarantined')
    expect(await getSkill(h.db, 'rot')).toBeNull()
  })
})

test('the pre-fix bare-insert path is gone from the importer source', async () => {
  const src = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'resource-catalog',
      'infrastructure',
      'legacy',
      'skill-zip.ts',
    ),
    'utf-8',
  )
  // Code-shape locks (comments may still MENTION the incident): no direct
  // skills-table insert and no post-insert "disappeared" throw in the importer.
  expect(src).not.toMatch(/\.insert\(skills\)/)
  expect(src).not.toMatch(/new Error\('skill disappeared/)
})
