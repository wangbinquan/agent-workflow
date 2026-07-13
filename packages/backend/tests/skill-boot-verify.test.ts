// RFC-170 §invariant④ / §10 (T-BOOT) — managed snapshot integrity reverify +
// the isSkillAvailableThisBoot gate. A durable 'snapshot-authoritative' flag is
// NOT enough (G6-4): a snapshot corrupted offline must be caught THIS boot and
// quarantined, never signed/injected.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills } from '../src/db/schema'
import {
  createManagedSkill,
  getSkill,
  listSkills,
  type SkillFsOptions,
} from '../src/services/skill'
import {
  activateBootReverifyForTest,
  isSkillAvailableThisBoot,
  isSkillBootVerified,
  isSkillInjectableThisBoot,
  markSkillBootVerified,
  resetSkillBootVerifyForTest,
  runBootSnapshotReverify,
  verifyManagedSnapshot,
} from '../src/services/skillBootVerify'
import { readFileSync } from 'node:fs'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function versionStateOf(db: DbClient, id: string): string {
  return (
    db.select({ v: skills.versionState }).from(skills).where(eq(skills.id, id)).all() as Array<{
      v: string
    }>
  )[0]!.v
}
function snapshotSkillMd(appHome: string, name: string, v: number): string {
  return join(appHome, 'skills', name, 'versions', `v${v}`, 'files', 'SKILL.md')
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
    expect(isSkillAvailableThisBoot({ id: skill!.id, sourceKind: 'managed' })).toBe(true)
  })

  test('once ACTIVE, a managed skill needs authoritative + boot-verified', async () => {
    const skill = await getSkill(db, 'foo')
    resetSkillBootVerifyForTest()
    activateBootReverifyForTest() // gate ON, set empty
    const row = {
      id: skill!.id,
      sourceKind: 'managed' as const,
      versionState: 'snapshot-authoritative',
    }
    expect(isSkillAvailableThisBoot(row)).toBe(false) // authoritative but NOT in set
    expect(
      verifyManagedSnapshot(db, fsOpts, { id: skill!.id, name: 'foo', contentVersion: 1 }),
    ).toBe('verified')
    expect(isSkillAvailableThisBoot(row)).toBe(true) // now verified → available
  })

  test('a non-degraded external skill is available when active (not gated on the set)', () => {
    activateBootReverifyForTest()
    expect(isSkillAvailableThisBoot({ id: 'x', sourceKind: 'external', sourceState: null })).toBe(
      true,
    )
    expect(
      isSkillAvailableThisBoot({ id: 'x', sourceKind: 'external', sourceState: 'degraded' }),
    ).toBe(false) // degraded external → unavailable
  })

  test('verifyManagedSnapshot QUARANTINES a tampered snapshot (hash mismatch)', async () => {
    const skill = await getSkill(db, 'foo')
    // Tamper the snapshot SKILL.md → hash no longer matches content_hash.
    writeFileSync(snapshotSkillMd(appHome, 'foo', 1), '---\nname: foo\n---\nTAMPERED', 'utf-8')
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
    resetSkillBootVerifyForTest()
    // Corrupt bar's snapshot; foo stays intact.
    writeFileSync(snapshotSkillMd(appHome, 'bar', 1), '---\nname: bar\n---\nCORRUPT', 'utf-8')
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
        sourceKind: 'managed',
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
    resetSkillBootVerifyForTest()
    writeFileSync(snapshotSkillMd(appHome, 'bar', 1), '---\nname: bar\n---\nCORRUPT', 'utf-8')
    runBootSnapshotReverify(db, fsOpts) // foo → verified, bar → quarantined, gate ON
    // foo (verified) is visible; bar (quarantined) is hidden by the gate.
    expect(await getSkill(db, 'foo')).not.toBeNull()
    expect(await getSkill(db, 'bar')).toBeNull()
    const names = (await listSkills(db)).map((s) => s.name)
    expect(names).toContain('foo')
    expect(names).not.toContain('bar')
  })

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
    // External / project are not snapshot-gated here.
    expect(isSkillInjectableThisBoot({ id: 'e', sourceKind: 'external' })).toBe(true)
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
    expect(src).toMatch(/throw new SkillQuarantinedError\(name\)/)
  })
})
