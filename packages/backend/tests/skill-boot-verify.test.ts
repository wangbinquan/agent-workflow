// RFC-170 §invariant④ / §10 (T-BOOT) — managed snapshot integrity reverify +
// the isSkillAvailableThisBoot gate. A durable 'snapshot-authoritative' flag is
// NOT enough (G6-4): a snapshot corrupted offline must be caught THIS boot and
// quarantined, never signed/injected.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills, skillVersions } from '../src/db/schema'
import { commitSkillVersion, ensureInitialSkillVersion } from '../src/services/skillVersion'
import { createManagedSkill, listSkills, type SkillFsOptions } from '../src/services/skill'
import { getSkill } from './helpers/resourceLookup'
import {
  activateBootReverifyForTest,
  activateBootReverify,
  isSkillAvailableThisBoot,
  isSkillBootVerified,
  isSkillInjectableThisBoot,
  markSkillBootVerified,
  resetSkillBootVerifyForTest,
  runBootSnapshotReverify,
  verifyManagedSnapshot,
} from '../src/services/skillBootVerify'
import { readFileSync } from 'node:fs'
import { hashDir } from '../src/services/skillHash'
import {
  skillFilesAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '../src/services/skillIdentityPaths'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function versionStateOf(db: DbClient, id: string): string {
  return (
    db.select({ v: skills.versionState }).from(skills).where(eq(skills.id, id)).all() as Array<{
      v: string
    }>
  )[0]!.v
}
function snapshotSkillMd(appHome: string, skillId: string, v: number): string {
  return join(appHome, 'skills', skillId, 'versions', `v${v}`, 'files', 'SKILL.md')
}

describe('RFC-170 T-BOOT — skillBootVerify', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: SkillFsOptions

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-boot-verify-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    resetSkillBootVerifyForTest()
    await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
    resetSkillBootVerifyForTest()
  })

  test('a freshly-created managed skill is snapshot-authoritative + boot-verified', async () => {
    const skill = await getSkill(db, 'foo')
    expect(versionStateOf(db, skill!.id)).toBe('snapshot-authoritative') // set by commitSkillVersion
    expect(isSkillBootVerified(skill!.id)).toBe(true) // marked after publish
  })

  test('the gate is INACTIVE by default (returns available, no test breakage)', async () => {
    const skill = await getSkill(db, 'foo')
    resetSkillBootVerifyForTest() // clear the set + deactivate
    // Even with an empty set, an inactive gate does not restrict.
    expect(isSkillAvailableThisBoot({ id: skill!.id })).toBe(true)
  })

  test('once ACTIVE, a managed skill needs authoritative + boot-verified', async () => {
    const skill = await getSkill(db, 'foo')
    resetSkillBootVerifyForTest()
    activateBootReverifyForTest() // gate ON, set empty
    const row = {
      id: skill!.id,
      versionState: 'snapshot-authoritative',
    }
    expect(isSkillAvailableThisBoot(row)).toBe(false) // authoritative but NOT in set
    expect(
      verifyManagedSnapshot(db, fsOpts, { id: skill!.id, name: 'foo', contentVersion: 1 }),
    ).toBe('verified')
    expect(isSkillAvailableThisBoot(row)).toBe(true) // now verified → available
  })

  test('verifyManagedSnapshot QUARANTINES a tampered snapshot (hash mismatch)', async () => {
    const skill = await getSkill(db, 'foo')
    // Tamper the snapshot SKILL.md → hash no longer matches content_hash.
    writeFileSync(snapshotSkillMd(appHome, skill!.id, 1), '---\nname: foo\n---\nTAMPERED', 'utf-8')
    expect(
      verifyManagedSnapshot(db, fsOpts, { id: skill!.id, name: 'foo', contentVersion: 1 }),
    ).toBe('quarantined')
    expect(versionStateOf(db, skill!.id)).toBe('quarantined')
    expect(isSkillBootVerified(skill!.id)).toBe(false)
  })

  test('runBootSnapshotReverify verifies the good + quarantines the tampered', async () => {
    await createManagedSkill(db, fsOpts, {
      name: 'bar',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    const bar = await getSkill(db, 'bar')
    resetSkillBootVerifyForTest()
    // Corrupt bar's snapshot; foo stays intact.
    writeFileSync(snapshotSkillMd(appHome, bar!.id, 1), '---\nname: bar\n---\nCORRUPT', 'utf-8')
    const r = runBootSnapshotReverify(db, fsOpts)
    expect(r.verified).toBe(1)
    expect(r.quarantined).toBe(1)
    const foo = await getSkill(db, 'foo')
    expect(isSkillBootVerified(foo!.id)).toBe(true)
    // bar's row is quarantined (getSkill still returns it — it filters reservation,
    // not version_state; the gate is what hides it).
    expect(
      isSkillAvailableThisBoot({
        id: foo!.id,
        versionState: 'snapshot-authoritative',
      }),
    ).toBe(true)
  })

  test('when ACTIVE, getSkill + listSkills hide a quarantined managed skill', async () => {
    await createManagedSkill(db, fsOpts, {
      name: 'bar',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    const bar = await getSkill(db, 'bar')
    resetSkillBootVerifyForTest()
    writeFileSync(snapshotSkillMd(appHome, bar!.id, 1), '---\nname: bar\n---\nCORRUPT', 'utf-8')
    runBootSnapshotReverify(db, fsOpts) // foo → verified, bar → quarantined, gate ON
    // foo (verified) is visible; bar (quarantined) is hidden by the gate.
    expect(await getSkill(db, 'foo')).not.toBeNull()
    expect(await getSkill(db, 'bar')).toBeNull()
    const names = (await listSkills(db)).map((s) => s.name)
    expect(names).toContain('foo')
    expect(names).not.toContain('bar')
  })

  test('production activation hides persisted skills until their per-skill verification', async () => {
    const skill = await getSkill(db, 'foo')
    activateBootReverify()
    expect(await getSkill(db, 'foo')).toBeNull()
    expect(isSkillBootVerified(skill!.id)).toBe(false)

    expect(runBootSnapshotReverify(db, fsOpts)).toEqual({ verified: 1, quarantined: 0 })
    expect(await getSkill(db, 'foo')).not.toBeNull()
  })

  test('every historical version is verified, not only current', async () => {
    const skill = await getSkill(db, 'foo')
    commitSkillVersion(
      db,
      fsOpts,
      skill!.id,
      (staging) => writeFileSync(join(staging, 'SKILL.md'), 'v2'),
      { source: 'editor', authorUserId: '__system__' },
    )
    writeFileSync(snapshotSkillMd(appHome, skill!.id, 1), 'corrupt-old-v1')
    activateBootReverify()

    expect(runBootSnapshotReverify(db, fsOpts)).toEqual({ verified: 0, quarantined: 1 })
    expect(versionStateOf(db, skill!.id)).toBe('quarantined')
  })

  test('live files must match the current committed snapshot', async () => {
    const skill = await getSkill(db, 'foo')
    writeFileSync(join(skillFilesAbs(appHome, skill!.id), 'SKILL.md'), 'live-only-tamper')
    activateBootReverify()

    expect(runBootSnapshotReverify(db, fsOpts)).toEqual({ verified: 0, quarantined: 1 })
    expect(isSkillBootVerified(skill!.id)).toBe(false)
  })

  test('an extra symlink is quarantined even though the historical hash is unchanged', async () => {
    const skill = await getSkill(db, 'foo')
    const snapshot = skillVersionAbs(appHome, skill!.id, 1)
    const before = hashDir(snapshot)
    const external = join(appHome, 'external-secret')
    writeFileSync(external, 'secret')
    symlinkSync(external, join(snapshot, 'extra-link'))
    expect(hashDir(snapshot)).toBe(before) // legacy hash deliberately skips it
    activateBootReverify()

    expect(runBootSnapshotReverify(db, fsOpts)).toEqual({ verified: 0, quarantined: 1 })
    expect(versionStateOf(db, skill!.id)).toBe('quarantined')
  })

  test('one skill I/O failure is quarantined without preventing later healthy rows', async () => {
    const bad = await getSkill(db, 'foo')
    const good = await createManagedSkill(db, fsOpts, {
      name: 'later-good',
      description: 'd',
      bodyMd: 'good',
      frontmatterExtra: {},
    })
    const external = join(appHome, 'external-versions')
    mkdirSync(external)
    rmSync(join(appHome, 'skills', bad!.id, 'versions'), { recursive: true, force: true })
    symlinkSync(external, join(appHome, 'skills', bad!.id, 'versions'), 'dir')
    activateBootReverify()

    expect(runBootSnapshotReverify(db, fsOpts)).toEqual({ verified: 1, quarantined: 1 })
    expect(isSkillBootVerified(bad!.id)).toBe(false)
    expect(isSkillBootVerified(good.id)).toBe(true)
  })

  test('verification retries a fresh generation instead of quarantining a concurrent commit', async () => {
    const skill = await getSkill(db, 'foo')
    activateBootReverify()
    let bumped = false
    expect(
      verifyManagedSnapshot(
        db,
        {
          appHome,
          __beforeFinalizeForTest: () => {
            if (bumped) return
            bumped = true
            commitSkillVersion(
              db,
              fsOpts,
              skill!.id,
              (staging) => writeFileSync(join(staging, 'SKILL.md'), 'concurrent-v2'),
              { source: 'editor', authorUserId: '__system__' },
            )
          },
        },
        { id: skill!.id, name: skill!.name, contentVersion: 1 },
      ),
    ).toBe('verified')
    expect(
      db
        .select({ version: skills.contentVersion })
        .from(skills)
        .where(eq(skills.id, skill!.id))
        .get(),
    ).toEqual({ version: 2 })
    expect(versionStateOf(db, skill!.id)).toBe('snapshot-authoritative')
    expect(isSkillBootVerified(skill!.id)).toBe(true)
  })

  for (const anomaly of ['gap', 'future'] as const) {
    test(`version history ${anomaly} is quarantined before admission`, async () => {
      const skill = await getSkill(db, 'foo')
      if (anomaly === 'gap') {
        commitSkillVersion(
          db,
          fsOpts,
          skill!.id,
          (staging) => writeFileSync(join(staging, 'SKILL.md'), 'v2'),
          { source: 'editor', authorUserId: '__system__' },
        )
        db.delete(skillVersions)
          .where(
            eq(
              skillVersions.id,
              db
                .select({
                  id: skillVersions.id,
                  versionIndex: skillVersions.versionIndex,
                })
                .from(skillVersions)
                .where(eq(skillVersions.skillId, skill!.id))
                .all()
                .find((row) => row.versionIndex === 1)!.id,
            ),
          )
          .run()
      } else {
        const v1 = skillVersionAbs(appHome, skill!.id, 1)
        const v2 = skillVersionAbs(appHome, skill!.id, 2)
        cpSync(v1, v2, { recursive: true })
        db.insert(skillVersions)
          .values({
            id: ulid(),
            skillId: skill!.id,
            versionIndex: 2,
            filesPath: skillVersionRelPath(skill!.id, 2),
            source: 'editor',
            authorUserId: '__system__',
            contentHash: hashDir(v2),
          })
          .run()
      }
      activateBootReverify()
      expect(runBootSnapshotReverify(db, fsOpts)).toEqual({ verified: 0, quarantined: 1 })
    })
  }

  // RFC-170 T9 — the runtime injection predicate + resolver gate.
  test('isSkillInjectableThisBoot: managed needs verified when active; external/inactive pass', async () => {
    const skill = await getSkill(db, 'foo')
    // Inactive → always injectable.
    expect(isSkillInjectableThisBoot({ id: skill!.id, sourceKind: 'managed' })).toBe(true)
    resetSkillBootVerifyForTest()
    activateBootReverifyForTest()
    expect(isSkillInjectableThisBoot({ id: skill!.id, sourceKind: 'managed' })).toBe(false) // unverified
    markSkillBootVerified(skill!.id)
    expect(isSkillInjectableThisBoot({ id: skill!.id, sourceKind: 'managed' })).toBe(true) // verified
    // Project (repo-local self-discovered) skills are not snapshot-gated here.
    expect(isSkillInjectableThisBoot({ id: 'p', sourceKind: 'project' })).toBe(true)
  })

  test('scheduler resolveSkills fails closed on a non-injectable managed skill (source lock)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    // The pre-spawn resolver gates managed skills on the injection predicate and
    // throws the non-swallowable SkillQuarantinedError (fail-closed).
    expect(src).toMatch(/isSkillInjectableThisBoot\(\{ id: row\.id, sourceKind: 'managed' \}\)/)
    // RFC-223 (PR-1): resolveSkills looks the managed skill up BY ID, so the
    // quarantine error carries the row's name.
    expect(src).toMatch(/throw new SkillQuarantinedError\(row\.name\)/)
  })

  // RFC-170 T4a — a legacy managed skill (pre-version-tracking, no snapshot,
  // version_state='legacy-unbackfilled') would be hidden by the gate after an
  // upgrade; the boot pass backfills its v1 snapshot → authoritative + verified →
  // available. Here we exercise the backfill the boot pass runs.
  test('legacy-unbackfilled managed skill becomes available after v1 backfill', async () => {
    const id = ulid()
    // A pre-RFC-101 skill: managed, live files, NO version row, legacy state.
    mkdirSync(join(appHome, 'skills', id, 'files'), { recursive: true })
    writeFileSync(
      join(appHome, 'skills', id, 'files', 'SKILL.md'),
      '---\nname: legacy\ndescription: d\n---\nold body',
      'utf-8',
    )
    await db.insert(skills).values({
      id,
      name: 'legacy',
      description: 'd',
      sourceKind: 'managed',
      managedPath: `skills/${id}/files`,
      versionState: 'legacy-unbackfilled',
      contentVersion: 0,
    })
    resetSkillBootVerifyForTest()
    activateBootReverifyForTest()
    // Before backfill (gate active): legacy state is not authoritative → hidden.
    expect(await getSkill(db, 'legacy')).toBeNull()
    // The boot pass backfills v1 (ensureInitialSkillVersion → commitSkillVersion).
    ensureInitialSkillVersion(db, fsOpts, id)
    // Now authoritative + boot-verified → visible + injectable.
    expect(await getSkill(db, 'legacy')).not.toBeNull()
    expect(isSkillBootVerified(id)).toBe(true)
  })

  test('boot pass backfills legacy skills BEFORE the reverify (source lock)', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
    // The legacy v1 backfill (+ husk sweep — backfillLegacySkillVersions) must
    // precede runBootSnapshotReverify (so a backfilled skill is
    // authoritative+verified when the gate activates).
    const backfillIdx = src.indexOf('backfillLegacySkillVersions(db')
    const reverifyIdx = src.indexOf('runBootSnapshotReverify(db')
    expect(backfillIdx).toBeGreaterThan(0)
    expect(backfillIdx).toBeLessThan(reverifyIdx)
  })
})
