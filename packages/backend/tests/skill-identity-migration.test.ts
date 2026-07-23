// RFC-223 PR-5 — fail-closed filesystem identity barrier.
//
// Locks the migrate op at every crash seam, deterministic all-row preflight,
// same physical name/id paths, conservative legacy-husk handling, exact
// postconditions, and the committed version-write publish window that the old
// best-effort reconciler deliberately cannot repair.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skillOperationLocks, skillOperations, skills, skillVersions } from '../src/db/schema'
import { dbTxSync } from '../src/db/txSync'
import { runSkillIdentityMigrationBarrier } from '../src/services/skillIdentityMigration'
import {
  skillFilesAbs,
  skillFilesRel,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '../src/services/skillIdentityPaths'
import { hashDir } from '../src/services/skillHash'
import { advancePhase, beginOperation, getActiveOp } from '../src/services/skillOperations'
import { opBackupDir, opStagedDir } from '../src/services/skillFsPublish'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface SeedOptions {
  id?: string
  name?: string
  versions?: number
  versionState?: 'legacy-unbackfilled' | 'snapshot-authoritative'
  createRoot?: boolean
  createFiles?: boolean
  supportOnly?: boolean
  managedPath?: string | null
}

describe('RFC-223 PR-5 skill identity migration barrier', () => {
  let db: DbClient
  let appHome: string

  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-skill-identity-'))
    db = createInMemoryDb(MIGRATIONS)
  })

  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
  })

  test('happy path migrates a multi-version root and is idempotent', () => {
    const row = seedLegacySkill(db, appHome, {
      id: 'skill-id-happy',
      name: 'happy',
      versions: 3,
    })

    const first = runSkillIdentityMigrationBarrier(db, { appHome })
    expect(first).toEqual({
      recoveredOperations: 0,
      removedHusks: 0,
      migratedSkills: 1,
      verifiedSkills: 1,
      verifiedVersions: 3,
    })
    expect(existsSync(join(appHome, 'skills', 'happy'))).toBe(false)
    expect(readFileSync(join(skillFilesAbs(appHome, row.id), 'SKILL.md'), 'utf-8')).toContain(
      'happy live',
    )
    expect(
      db
        .select({ managedPath: skills.managedPath })
        .from(skills)
        .where(eq(skills.id, row.id))
        .get(),
    ).toEqual({ managedPath: skillFilesRel(row.id) })
    expect(
      db
        .select({
          versionIndex: skillVersions.versionIndex,
          filesPath: skillVersions.filesPath,
        })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, row.id))
        .all()
        .sort((a, b) => a.versionIndex - b.versionIndex),
    ).toEqual([
      { versionIndex: 1, filesPath: skillVersionRelPath(row.id, 1) },
      { versionIndex: 2, filesPath: skillVersionRelPath(row.id, 2) },
      { versionIndex: 3, filesPath: skillVersionRelPath(row.id, 3) },
    ])

    expect(runSkillIdentityMigrationBarrier(db, { appHome })).toEqual({
      recoveredOperations: 0,
      removedHusks: 0,
      migratedSkills: 0,
      verifiedSkills: 1,
      verifiedVersions: 3,
    })
  })

  for (const crashPhase of ['intent', 'fs-moved', 'fs-staged', 'db-committed', 'done'] as const) {
    test(`crash after ${crashPhase} is recoverable and re-entrant`, () => {
      const row = seedLegacySkill(db, appHome, {
        id: `skill-id-${crashPhase}`,
        name: `phase-${crashPhase}`,
        versions: 2,
      })
      expect(() =>
        runSkillIdentityMigrationBarrier(db, {
          appHome,
          hooks: {
            afterPhase: (phase) => {
              if (phase === crashPhase) throw new Error(`crash:${phase}`)
            },
          },
        }),
      ).toThrow(`crash:${crashPhase}`)

      const active = getActiveOp(db, row.id)
      if (crashPhase === 'done') {
        expect(active).toBeNull()
        expect(lockCount(db)).toBe(0)
      } else {
        expect(active?.kind).toBe('migrate')
        expect(lockCount(db)).toBe(1)
      }

      const recovered = runSkillIdentityMigrationBarrier(db, { appHome })
      expect(recovered.recoveredOperations).toBe(crashPhase === 'done' ? 0 : 1)
      expect(getActiveOp(db, row.id)).toBeNull()
      expect(lockCount(db)).toBe(0)
      expect(existsSync(skillRootAbs(appHome, row.id))).toBe(true)
      expect(existsSync(join(appHome, 'skills', row.name))).toBe(false)
      expect(
        db.select({ path: skills.managedPath }).from(skills).where(eq(skills.id, row.id)).get(),
      ).toEqual({ path: skillFilesRel(row.id) })
    })
  }

  test('same physical name/id path records intent, survives crash, and canonicalizes DB', () => {
    const same = '11111111111111111111111111'
    seedLegacySkill(db, appHome, {
      id: same,
      name: same,
      versions: 1,
      managedPath: `skills/${same}/files/`,
    })

    expect(() =>
      runSkillIdentityMigrationBarrier(db, {
        appHome,
        hooks: {
          afterPhase: (phase) => {
            if (phase === 'fs-staged') throw new Error('same-path-crash')
          },
        },
      }),
    ).toThrow('same-path-crash')
    expect(getActiveOp(db, same)?.phase).toBe('fs-staged')
    expect(existsSync(skillRootAbs(appHome, same))).toBe(true)

    const report = runSkillIdentityMigrationBarrier(db, { appHome })
    expect(report.recoveredOperations).toBe(1)
    expect(report.migratedSkills).toBe(1)
    expect(
      db.select({ path: skills.managedPath }).from(skills).where(eq(skills.id, same)).get(),
    ).toEqual({ path: skillFilesRel(same) })
    expect(lockCount(db)).toBe(0)
  })

  test('all-row preflight rejects a later collision before an earlier row can rename', () => {
    const first = seedLegacySkill(db, appHome, {
      id: 'aaa-first-id',
      name: 'aaa-first-name',
      versions: 1,
    })
    const blocked = seedLegacySkill(db, appHome, {
      id: 'zzz-blocked-id',
      name: 'zzz-blocked-name',
      versions: 1,
    })
    writeTree(skillRootAbs(appHome, blocked.id), 'untracked-target')

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(/claim different roots/)
    expect(existsSync(join(appHome, 'skills', first.name))).toBe(true)
    expect(existsSync(skillRootAbs(appHome, first.id))).toBe(false)
    expect(activeOperationCount(db)).toBe(0)
    expect(lockCount(db)).toBe(0)
  })

  test('cross-occupied two-node name/id cycle refuses deterministically with zero mutation', () => {
    seedLegacySkill(db, appHome, { id: 'beta', name: 'alpha', versions: 1 })
    seedLegacySkill(db, appHome, { id: 'alpha', name: 'beta', versions: 1 })
    const alphaBefore = hashDir(join(appHome, 'skills', 'alpha'))
    const betaBefore = hashDir(join(appHome, 'skills', 'beta'))

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /physical-ownership|resolves to canonical root/,
    )
    expect(hashDir(join(appHome, 'skills', 'alpha'))).toBe(alphaBefore)
    expect(hashDir(join(appHome, 'skills', 'beta'))).toBe(betaBefore)
    expect(activeOperationCount(db)).toBe(0)
  })

  test('fully canonical display-name alias is not an ownership path', () => {
    const owner = seedCanonicalSkill(db, appHome, 'display-owner', {
      id: 'DISPLAY-OWNER-ID',
      name: 'owner display',
    })
    const alias = seedCanonicalSkill(db, appHome, 'display-alias', {
      id: 'display-alias-id',
      // Same entry on a case-insensitive FS; a missing, distinct spelling on a
      // case-sensitive FS. Either way this canonical row owns only its id root.
      name: owner.id.toLowerCase(),
    })

    expect(runSkillIdentityMigrationBarrier(db, { appHome })).toMatchObject({
      migratedSkills: 0,
      verifiedSkills: 2,
    })
    expect(readFileSync(join(skillFilesAbs(appHome, owner.id), 'payload.txt'), 'utf-8')).toBe(
      'old-v1',
    )
    expect(readFileSync(join(skillFilesAbs(appHome, alias.id), 'payload.txt'), 'utf-8')).toBe(
      'old-v1',
    )
  })

  test('canonical empty husk cleanup never removes another row display alias', () => {
    const owner = seedCanonicalSkill(db, appHome, 'husk-alias-owner', {
      id: 'husk-owner-id',
      name: 'owner',
    })
    const huskId = 'canonical-empty-husk-id'
    db.insert(skills)
      .values({
        id: huskId,
        name: owner.id,
        sourceKind: 'managed',
        managedPath: skillFilesRel(huskId),
        contentVersion: 0,
        reservationState: 'ready',
        versionState: 'legacy-unbackfilled',
      })
      .run()
    mkdirSync(skillRootAbs(appHome, huskId), { recursive: true })
    const ownerHash = hashDir(skillRootAbs(appHome, owner.id))

    expect(runSkillIdentityMigrationBarrier(db, { appHome }).removedHusks).toBe(1)
    expect(db.select().from(skills).where(eq(skills.id, huskId)).get()).toBeUndefined()
    expect(hashDir(skillRootAbs(appHome, owner.id))).toBe(ownerHash)
  })

  test('noncanonical legacy alias of another canonical root fails before mutation', () => {
    const owner = seedCanonicalSkill(db, appHome, 'legacy-alias-owner', {
      id: 'legacy-owner-id',
      name: 'owner',
    })
    db.insert(skills)
      .values({
        id: 'legacy-alias-row',
        name: owner.id,
        sourceKind: 'managed',
        managedPath: `skills/${owner.id}/files`,
        contentVersion: 0,
        reservationState: 'ready',
        versionState: 'legacy-unbackfilled',
      })
      .run()
    const ownerHash = hashDir(skillRootAbs(appHome, owner.id))

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /physical-ownership|resolves to canonical root/,
    )
    expect(hashDir(skillRootAbs(appHome, owner.id))).toBe(ownerHash)
    expect(activeOperationCount(db)).toBe(0)
  })

  test('active legacy op cannot claim another row canonical root', () => {
    const owner = seedCanonicalSkill(db, appHome, 'active-alias-owner', {
      id: 'active-owner-id',
      name: 'owner',
    })
    const targetId = 'active-legacy-target'
    db.insert(skills)
      .values({
        id: targetId,
        name: 'target',
        sourceKind: 'managed',
        managedPath: skillFilesRel(targetId),
        contentVersion: 0,
        reservationState: 'reserving',
        versionState: 'legacy-unbackfilled',
      })
      .run()
    mkdirSync(skillRootAbs(appHome, targetId), { recursive: true })
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId: targetId,
        kind: 'reserve',
        preconditionJson: JSON.stringify({ name: owner.id }),
      }),
    )
    const ownerHash = hashDir(skillRootAbs(appHome, owner.id))

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /targets canonical root|physical-ownership/,
    )
    expect(hashDir(skillRootAbs(appHome, owner.id))).toBe(ownerHash)
    expect(getActiveOp(db, targetId)?.opId).toBe(opId)
    expect(lockCount(db)).toBe(1)
  })

  test('active legacy op cannot coexist with a distinct canonical root for its row', () => {
    const row = seedLegacySkill(db, appHome, {
      id: 'active-double-root-id',
      name: 'active-double-root-name',
      versions: 1,
    })
    const canonicalRoot = skillRootAbs(appHome, row.id)
    writeTree(canonicalRoot, 'canonical-orphan')
    const legacyRoot = join(appHome, 'skills', row.name)
    const legacyHash = hashDir(legacyRoot)
    const canonicalHash = hashDir(canonicalRoot)
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId: row.id,
        kind: 'version-write',
        targetVersion: 2,
        preconditionJson: JSON.stringify({ name: row.name }),
      }),
    )

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(/claim different roots/)
    expect(hashDir(legacyRoot)).toBe(legacyHash)
    expect(hashDir(canonicalRoot)).toBe(canonicalHash)
    expect(getActiveOp(db, row.id)?.opId).toBe(opId)
    expect(lockCount(db)).toBe(1)
  })

  for (const kind of ['reserve', 'version-write', 'delete'] as const) {
    test(`${kind} recovery rejects a payload from another path generation`, () => {
      const row = seedCanonicalSkill(db, appHome, `wrong-generation-${kind}`)
      if (kind === 'reserve') {
        db.update(skills).set({ reservationState: 'reserving' }).where(eq(skills.id, row.id)).run()
      }
      const opId = dbTxSync(db, (tx) =>
        beginOperation(tx, {
          skillId: row.id,
          kind,
          targetVersion: kind === 'version-write' ? 2 : undefined,
          preconditionJson: JSON.stringify({ name: 'wrong-legacy-generation' }),
        }),
      )
      const rootHash = hashDir(skillRootAbs(appHome, row.id))

      expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
        /payload does not match its DB path generation/,
      )
      expect(hashDir(skillRootAbs(appHome, row.id))).toBe(rootHash)
      expect(getActiveOp(db, row.id)?.opId).toBe(opId)
      expect(lockCount(db)).toBe(1)
    })
  }

  test('migrate recovery binds legacyName to the immutable row generation', () => {
    const row = seedCanonicalSkill(db, appHome, 'wrong-generation-migrate')
    db.update(skills)
      .set({ managedPath: 'skills/wrong-legacy-generation/files' })
      .where(eq(skills.id, row.id))
      .run()
    db.update(skillVersions)
      .set({ filesPath: 'skills/wrong-legacy-generation/versions/v1/files' })
      .where(eq(skillVersions.skillId, row.id))
      .run()
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId: row.id,
        kind: 'migrate',
        candidateFingerprint: 'a'.repeat(64),
        preconditionJson: JSON.stringify({
          skillId: row.id,
          legacyName: 'wrong-legacy-generation',
        }),
      }),
    )
    const rootHash = hashDir(skillRootAbs(appHome, row.id))

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /disagrees with DB path authority/,
    )
    expect(hashDir(skillRootAbs(appHome, row.id))).toBe(rootHash)
    expect(getActiveOp(db, row.id)?.opId).toBe(opId)
    expect(lockCount(db)).toBe(1)
  })

  test('reserve fs-staged may contain the fully committed v1 publish window', () => {
    const id = 'reserve-fs-staged-v1'
    const files = skillFilesAbs(appHome, id)
    const version = skillVersionAbs(appHome, id, 1)
    writeTree(files, 'reserve-v1')
    cpSync(files, version, { recursive: true })
    db.insert(skills)
      .values({
        id,
        name: 'reserve-v1',
        sourceKind: 'managed',
        managedPath: skillFilesRel(id),
        contentVersion: 1,
        reservationState: 'reserving',
        versionState: 'snapshot-authoritative',
      })
      .run()
    db.insert(skillVersions)
      .values({
        id: ulid(),
        skillId: id,
        versionIndex: 1,
        filesPath: skillVersionRelPath(id, 1),
        source: 'initial',
        authorUserId: '__system__',
        contentHash: hashDir(version),
      })
      .run()
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId: id,
        kind: 'reserve',
        preconditionJson: JSON.stringify({ skillId: id }),
      }),
    )
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))

    expect(runSkillIdentityMigrationBarrier(db, { appHome }).recoveredOperations).toBe(1)
    expect(db.select().from(skills).where(eq(skills.id, id)).get()).toBeUndefined()
    expect(existsSync(skillRootAbs(appHome, id))).toBe(false)
    expect(lockCount(db)).toBe(0)
  })

  test('missing root refuses unless it is the exact historical empty ZIP husk', () => {
    const blocked = seedLegacySkill(db, appHome, {
      id: 'missing-authoritative',
      name: 'missing-authoritative-name',
      versions: 1,
      createRoot: false,
    })
    rmSync(join(appHome, 'skills', blocked.name), { recursive: true, force: true })
    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /no recoverable filesystem directory/,
    )
    expect(
      db.select({ id: skills.id }).from(skills).where(eq(skills.id, blocked.id)).get(),
    ).toEqual({ id: blocked.id })

    db.delete(skillVersions).where(eq(skillVersions.skillId, blocked.id)).run()
    db.delete(skills).where(eq(skills.id, blocked.id)).run()
    const husk = seedLegacySkill(db, appHome, {
      id: 'empty-husk',
      name: 'empty-husk-name',
      versions: 0,
      versionState: 'legacy-unbackfilled',
      createRoot: false,
    })
    const report = runSkillIdentityMigrationBarrier(db, { appHome })
    expect(report.removedHusks).toBe(1)
    expect(db.select().from(skills).where(eq(skills.id, husk.id)).get()).toBeUndefined()
  })

  test('recursively empty legacy husk is removed, but support bytes without SKILL.md survive', () => {
    const empty = seedLegacySkill(db, appHome, {
      id: 'empty-dir-husk',
      name: 'empty-dir-husk-name',
      versions: 0,
      versionState: 'legacy-unbackfilled',
      createFiles: false,
    })
    mkdirSync(join(appHome, 'skills', empty.name, 'nested', 'empty'), { recursive: true })
    const support = seedLegacySkill(db, appHome, {
      id: 'support-only-id',
      name: 'support-only',
      versions: 0,
      versionState: 'legacy-unbackfilled',
      supportOnly: true,
    })

    const report = runSkillIdentityMigrationBarrier(db, { appHome })
    expect(report.removedHusks).toBe(1)
    expect(db.select().from(skills).where(eq(skills.id, empty.id)).get()).toBeUndefined()
    expect(existsSync(join(appHome, 'skills', empty.name))).toBe(false)
    expect(readFileSync(join(skillFilesAbs(appHome, support.id), 'ref.md'), 'utf-8')).toBe(
      'support',
    )
  })

  test('a symlink root is evidence: husk sweep preserves it and migration refuses before rename', () => {
    const row = seedLegacySkill(db, appHome, {
      id: 'symlink-husk-id',
      name: 'symlink-husk-name',
      versions: 0,
      versionState: 'legacy-unbackfilled',
      createRoot: false,
    })
    const target = join(appHome, 'empty-target')
    mkdirSync(target)
    const legacyRoot = join(appHome, 'skills', row.name)
    mkdirSync(dirname(legacyRoot), { recursive: true })
    symlinkSync(target, legacyRoot, 'dir')

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(/not a real directory/)
    expect(db.select().from(skills).where(eq(skills.id, row.id)).get()).toBeDefined()
    expect(existsSync(legacyRoot)).toBe(true)
    expect(existsSync(skillRootAbs(appHome, row.id))).toBe(false)
  })

  test('a symlinked skills root fails closed before recovery or filesystem mutation', () => {
    const skillsRoot = join(appHome, 'skills')
    const external = join(appHome, 'external-skills-target')
    rmSync(skillsRoot, { recursive: true, force: true })
    mkdirSync(external)
    symlinkSync(external, skillsRoot, 'dir')

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /skills root is not a real directory/,
    )
    expect(readdirSync(external)).toEqual([])
    expect(activeOperationCount(db)).toBe(0)
    expect(lockCount(db)).toBe(0)
  })

  test('a symlinked delete trash fails closed before recovery or filesystem mutation', () => {
    const skillsRoot = join(appHome, 'skills')
    const external = join(appHome, 'external-trash-target')
    mkdirSync(skillsRoot, { recursive: true })
    mkdirSync(external)
    symlinkSync(external, join(skillsRoot, '.trash'), 'dir')

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /skill delete trash is not a real directory/,
    )
    expect(readdirSync(external)).toEqual([])
    expect(activeOperationCount(db)).toBe(0)
    expect(lockCount(db)).toBe(0)
  })

  test('a dangling legacy-name symlink remains evidence for a canonical row', () => {
    const row = seedCanonicalSkill(db, appHome, 'dangling-legacy-link')
    const legacyRoot = join(appHome, 'skills', row.name)
    symlinkSync(join(appHome, 'missing-link-target'), legacyRoot, 'dir')

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /unclaimed display-name directory/,
    )
    expect(lstatSync(legacyRoot).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(skillFilesAbs(appHome, row.id), 'SKILL.md'), 'utf-8')).toContain(
      'old-v1',
    )
    expect(activeOperationCount(db)).toBe(0)
    expect(lockCount(db)).toBe(0)
  })

  test('husk DB delete remains authoritative if empty-root cleanup faults', () => {
    const row = seedLegacySkill(db, appHome, {
      id: 'husk-cleanup-fault-id',
      name: 'husk-cleanup-fault-name',
      versions: 0,
      versionState: 'legacy-unbackfilled',
      createFiles: false,
    })
    const legacyRoot = join(appHome, 'skills', row.name)
    expect(() =>
      runSkillIdentityMigrationBarrier(db, {
        appHome,
        __beforeHuskFsCleanupForTest: () => {
          throw new Error('husk-cleanup-fault')
        },
      }),
    ).toThrow('husk-cleanup-fault')
    expect(db.select().from(skills).where(eq(skills.id, row.id)).get()).toBeUndefined()
    expect(existsSync(legacyRoot)).toBe(true)

    expect(runSkillIdentityMigrationBarrier(db, { appHome })).toMatchObject({
      verifiedSkills: 0,
      migratedSkills: 0,
    })
  })

  test('migration fingerprint drift fails closed and preserves active op plus lock', () => {
    const row = seedLegacySkill(db, appHome, {
      id: 'fingerprint-id',
      name: 'fingerprint-name',
      versions: 1,
    })
    expect(() =>
      runSkillIdentityMigrationBarrier(db, {
        appHome,
        hooks: {
          afterPhase: (phase) => {
            if (phase === 'fs-staged') throw new Error('crash-after-fs-staged')
          },
        },
      }),
    ).toThrow('crash-after-fs-staged')
    writeFileSync(join(skillFilesAbs(appHome, row.id), 'tampered.txt'), 'drift')

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /fingerprint|changed while its identity migration/i,
    )
    expect(getActiveOp(db, row.id)?.phase).toBe('fs-staged')
    expect(lockCount(db)).toBe(1)
  })

  test('postcondition rejects exact protocol residue but ignores support files with similar names', () => {
    const row = seedLegacySkill(db, appHome, {
      id: 'residue-id',
      name: 'residue-name',
      versions: 1,
    })
    runSkillIdentityMigrationBarrier(db, { appHome })
    const fake = `files.op-${ulid()}.staged-not-an-op`
    writeFileSync(join(skillFilesAbs(appHome, row.id), fake), 'user support file')
    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).not.toThrow()

    mkdirSync(join(skillRootAbs(appHome, row.id), `files.op-${ulid()}.backup`))
    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(/operation residue/)
  })
})

describe('RFC-223 PR-5 committed version-write recovery', () => {
  let db: DbClient
  let appHome: string

  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-version-recovery-'))
    db = createInMemoryDb(MIGRATIONS)
  })

  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  for (const crashWindow of ['before-publish', 'between-renames'] as const) {
    test(`${crashWindow} converges live from the committed target and clears exact residue`, () => {
      const row = seedCanonicalSkill(db, appHome, `version-${crashWindow}`)
      const planted = plantCommittedVersionWrite(db, appHome, row.id)
      if (crashWindow === 'between-renames') {
        renameSync(planted.filesDir, opBackupDir(planted.filesDir, planted.publishId))
      }

      const report = runSkillIdentityMigrationBarrier(db, { appHome })
      expect(report.recoveredOperations).toBe(1)
      expect(readFileSync(join(planted.filesDir, 'SKILL.md'), 'utf-8')).toContain('new-v2')
      expect(hashDir(planted.filesDir)).toBe(hashDir(planted.versionDir))
      expect(getActiveOp(db, row.id)).toBeNull()
      expect(lockCount(db)).toBe(0)
      expect(
        readdirSync(skillRootAbs(appHome, row.id)).filter((name) => name.startsWith('files.op-')),
      ).toEqual([])
    })
  }

  test('committed snapshot mismatch refuses and preserves recovery evidence', () => {
    const row = seedCanonicalSkill(db, appHome, 'version-mismatch')
    const planted = plantCommittedVersionWrite(db, appHome, row.id)
    writeFileSync(join(planted.versionDir, 'tampered.txt'), 'tampered')

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /does not match committed content hash/,
    )
    expect(getActiveOp(db, row.id)?.phase).toBe('db-committed')
    expect(lockCount(db)).toBe(1)
    expect(existsSync(planted.staging)).toBe(true)
  })

  test('non-current target or mismatched files_path cannot become canonical live', () => {
    for (const defect of ['non-current', 'wrong-path'] as const) {
      const isolatedHome = mkdtempSync(join(tmpdir(), `aw-version-authority-${defect}-`))
      const isolatedDb = createInMemoryDb(MIGRATIONS)
      try {
        const row = seedCanonicalSkill(isolatedDb, isolatedHome, defect)
        plantCommittedVersionWrite(isolatedDb, isolatedHome, row.id)
        if (defect === 'non-current') {
          isolatedDb.update(skills).set({ contentVersion: 1 }).where(eq(skills.id, row.id)).run()
        } else {
          isolatedDb
            .update(skillVersions)
            .set({ filesPath: skillVersionRelPath(row.id, 999) })
            .where(and(eq(skillVersions.skillId, row.id), eq(skillVersions.versionIndex, 2)))
            .run()
        }

        expect(() =>
          runSkillIdentityMigrationBarrier(isolatedDb, { appHome: isolatedHome }),
        ).toThrow(
          defect === 'non-current'
            ? /disagrees with version authority/
            : /payload does not match its DB path generation/,
        )
        expect(getActiveOp(isolatedDb, row.id)?.phase).toBe('db-committed')
        expect(lockCount(isolatedDb)).toBe(1)
      } finally {
        rmSync(isolatedHome, { recursive: true, force: true })
      }
    }
  })

  test('a fingerprint-matching candidate-root symlink is never published or retired', () => {
    const row = seedCanonicalSkill(db, appHome, 'candidate-symlink')
    const planted = plantCommittedVersionWrite(db, appHome, row.id)
    const externalCandidate = join(appHome, 'external-version-candidate')
    cpSync(planted.versionDir, externalCandidate, { recursive: true })
    rmSync(planted.versionDir, { recursive: true, force: true })
    symlinkSync(externalCandidate, planted.versionDir, 'dir')

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(/not a real directory/)
    expect(readFileSync(join(planted.filesDir, 'SKILL.md'), 'utf-8')).toContain('old-v1')
    expect(getActiveOp(db, row.id)?.phase).toBe('db-committed')
    expect(lockCount(db)).toBe(1)
    expect(lstatSync(planted.versionDir).isSymbolicLink()).toBe(true)
  })

  test('an intermediate versions symlink fails before hash/copy/remove', () => {
    const row = seedCanonicalSkill(db, appHome, 'intermediate-symlink')
    const planted = plantCommittedVersionWrite(db, appHome, row.id)
    const versions = join(skillRootAbs(appHome, row.id), 'versions')
    const externalVersions = join(appHome, 'external-versions-tree')
    renameSync(versions, externalVersions)
    symlinkSync(externalVersions, versions, 'dir')
    const externalHash = hashDir(externalVersions)

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /path component is not a real directory/,
    )
    expect(hashDir(externalVersions)).toBe(externalHash)
    expect(readFileSync(join(planted.filesDir, 'SKILL.md'), 'utf-8')).toContain('old-v1')
    expect(getActiveOp(db, row.id)?.phase).toBe('db-committed')
    expect(lockCount(db)).toBe(1)
  })
})

function seedLegacySkill(
  db: DbClient,
  appHome: string,
  options: SeedOptions = {},
): { id: string; name: string } {
  const id = options.id ?? `skill-${ulid()}`
  const name = options.name ?? `legacy-${ulid()}`
  const versions = options.versions ?? 1
  const versionState = options.versionState ?? 'snapshot-authoritative'
  const managedPath =
    options.managedPath === undefined ? `skills/${name}/files` : options.managedPath
  db.insert(skills)
    .values({
      id,
      name,
      description: '',
      sourceKind: 'managed',
      managedPath,
      contentVersion: versions,
      reservationState: 'ready',
      versionState,
    })
    .run()

  const root = join(appHome, 'skills', name)
  if (options.createRoot !== false) {
    mkdirSync(root, { recursive: true })
    if (options.createFiles !== false) {
      mkdirSync(join(root, 'files'), { recursive: true })
      if (options.supportOnly) {
        writeFileSync(join(root, 'files', 'ref.md'), 'support')
      } else {
        writeFileSync(join(root, 'files', 'SKILL.md'), `# ${name} live\n`)
      }
    }
  }
  for (let version = 1; version <= versions; version++) {
    const versionDir = join(root, 'versions', `v${version}`, 'files')
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(join(versionDir, 'SKILL.md'), `# ${name} v${version}\n`)
    db.insert(skillVersions)
      .values({
        id: ulid(),
        skillId: id,
        versionIndex: version,
        filesPath: `skills/${name}/versions/v${version}/files`,
        source: version === 1 ? 'initial' : 'editor',
        authorUserId: '__system__',
        contentHash: hashDir(versionDir),
      })
      .run()
  }
  return { id, name }
}

function seedCanonicalSkill(
  db: DbClient,
  appHome: string,
  label: string,
  identity: { id?: string; name?: string } = {},
): { id: string; name: string } {
  const id = identity.id ?? `canonical-${label}`
  const name = identity.name ?? `display-${label}`
  const filesDir = skillFilesAbs(appHome, id)
  const versionDir = skillVersionAbs(appHome, id, 1)
  writeTree(filesDir, 'old-v1')
  cpSync(filesDir, versionDir, { recursive: true })
  db.insert(skills)
    .values({
      id,
      name,
      description: '',
      sourceKind: 'managed',
      managedPath: skillFilesRel(id),
      contentVersion: 1,
      reservationState: 'ready',
      versionState: 'snapshot-authoritative',
    })
    .run()
  db.insert(skillVersions)
    .values({
      id: ulid(),
      skillId: id,
      versionIndex: 1,
      filesPath: skillVersionRelPath(id, 1),
      source: 'initial',
      authorUserId: '__system__',
      contentHash: hashDir(versionDir),
    })
    .run()
  return { id, name }
}

function plantCommittedVersionWrite(
  db: DbClient,
  appHome: string,
  skillId: string,
): {
  publishId: string
  filesDir: string
  staging: string
  versionDir: string
} {
  const publishId = ulid()
  const filesDir = skillFilesAbs(appHome, skillId)
  const staging = opStagedDir(filesDir, publishId)
  const versionDir = skillVersionAbs(appHome, skillId, 2)
  writeTree(staging, 'new-v2')
  cpSync(staging, versionDir, { recursive: true })
  const hash = hashDir(versionDir)
  const opId = dbTxSync(db, (tx) =>
    beginOperation(tx, {
      skillId,
      kind: 'version-write',
      targetVersion: 2,
      stagingPath: relative(appHome, staging),
      candidatePath: relative(appHome, versionDir),
      preconditionJson: JSON.stringify({ skillId }),
    }),
  )
  dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))
  dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-versioned'))
  dbTxSync(db, (tx) => {
    tx.update(skills).set({ contentVersion: 2 }).where(eq(skills.id, skillId)).run()
    tx.insert(skillVersions)
      .values({
        id: ulid(),
        skillId,
        versionIndex: 2,
        filesPath: skillVersionRelPath(skillId, 2),
        source: 'editor',
        authorUserId: '__system__',
        contentHash: hash,
      })
      .run()
    advancePhase(tx, opId, 'db-committed')
  })
  return { publishId, filesDir, staging, versionDir }
}

function writeTree(root: string, marker: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `# ${marker}\n`)
  writeFileSync(join(root, 'payload.txt'), marker)
}

function lockCount(db: DbClient): number {
  return db.select().from(skillOperationLocks).all().length
}

function activeOperationCount(db: DbClient): number {
  return db.select().from(skillOperations).where(eq(skillOperations.active, 1)).all().length
}
