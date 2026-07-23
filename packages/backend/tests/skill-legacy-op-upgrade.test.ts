// RFC-223 PR-5 / R4-4 — upgrade recovery for every historical `{name}` op phase.
//
// Durable path columns may contain absolute paths from the machine/appHome where
// a backup was created. Recovery must decode the legacy identity, rebase only
// into the current restored appHome, settle the op, and then let the single
// barrier migrate the surviving root to skills/{id}. Sentinels in oldHome prove
// no historical absolute path is ever touched.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skillOperationLocks, skills, skillVersions } from '../src/db/schema'
import { dbTxSync } from '../src/db/txSync'
import { deleteManagedSkillOp } from '../src/services/skillDeleteOp'
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

describe('RFC-223 legacy reserve op upgrade matrix', () => {
  let db: DbClient
  let oldHome: string
  let appHome: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    oldHome = mkdtempSync(join(tmpdir(), 'aw-old-reserve-'))
    appHome = mkdtempSync(join(tmpdir(), 'aw-new-reserve-'))
  })
  afterEach(() => {
    rmSync(oldHome, { recursive: true, force: true })
    rmSync(appHome, { recursive: true, force: true })
  })

  for (const phase of ['intent', 'fs-staged', 'fs-published', 'db-committed'] as const) {
    test(`${phase}: legacy payload recovers under restored appHome only`, () => {
      const id = `reserve-${phase}`
      const name = `legacy-reserve-${phase}`
      seedLegacyRow(db, appHome, id, name, {
        reservationState: phase === 'db-committed' ? 'ready' : 'reserving',
        withVersion: phase === 'fs-published' || phase === 'db-committed',
      })
      const opId = dbTxSync(db, (tx) =>
        beginOperation(tx, {
          skillId: id,
          kind: 'reserve',
          preconditionJson: JSON.stringify({ name }),
        }),
      )
      if (phase !== 'intent') dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))
      if (phase === 'fs-published' || phase === 'db-committed') {
        dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-published'))
      }
      if (phase === 'db-committed') {
        dbTxSync(db, (tx) => {
          tx.update(skills).set({ reservationState: 'ready' }).where(eq(skills.id, id)).run()
          advancePhase(tx, opId, 'db-committed')
        })
      }

      const oldSentinel = join(oldHome, 'skills', name, 'sentinel.txt')
      mkdirSync(dirname(oldSentinel), { recursive: true })
      writeFileSync(oldSentinel, 'old-home')

      const report = runSkillIdentityMigrationBarrier(db, { appHome })
      expect(report.recoveredOperations).toBe(1)
      expect(readFileSync(oldSentinel, 'utf-8')).toBe('old-home')
      expect(getActiveOp(db, id)).toBeNull()
      expect(lockCount(db)).toBe(0)
      if (phase === 'db-committed') {
        expect(db.select().from(skills).where(eq(skills.id, id)).get()).toBeDefined()
        expect(existsSync(skillRootAbs(appHome, id))).toBe(true)
      } else {
        expect(db.select().from(skills).where(eq(skills.id, id)).get()).toBeUndefined()
        expect(existsSync(join(appHome, 'skills', name))).toBe(false)
      }
    })
  }
})

describe('RFC-223 legacy delete op upgrade matrix', () => {
  let db: DbClient
  let oldHome: string
  let appHome: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    oldHome = mkdtempSync(join(tmpdir(), 'aw-old-delete-'))
    appHome = mkdtempSync(join(tmpdir(), 'aw-new-delete-'))
  })
  afterEach(() => {
    rmSync(oldHome, { recursive: true, force: true })
    rmSync(appHome, { recursive: true, force: true })
  })

  for (const phase of ['intent', 'fs-staged', 'db-committed'] as const) {
    test(`${phase}: absolute backup path rebases safely and preserves oldHome`, () => {
      const id = `delete-${phase}`
      const name = `legacy-delete-${phase}`
      seedLegacyRow(db, appHome, id, name, { withVersion: true })
      const opId = dbTxSync(db, (tx) =>
        beginOperation(tx, {
          skillId: id,
          kind: 'delete',
          preconditionJson: JSON.stringify({ name }),
        }),
      )
      const currentRoot = join(appHome, 'skills', name)
      const currentTrash = join(appHome, 'skills', '.trash', `${id}-${opId}`)
      const storedOldTrash = join(oldHome, 'skills', '.trash', `${id}-${opId}`)
      if (phase !== 'intent') {
        mkdirSync(dirname(currentTrash), { recursive: true })
        renameSync(currentRoot, currentTrash)
        dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged', { backupPath: storedOldTrash }))
      }
      if (phase === 'db-committed') {
        dbTxSync(db, (tx) => {
          tx.delete(skills).where(eq(skills.id, id)).run()
          advancePhase(tx, opId, 'db-committed')
        })
      }

      mkdirSync(storedOldTrash, { recursive: true })
      writeFileSync(join(storedOldTrash, 'sentinel.txt'), 'old-home-trash')
      const report = runSkillIdentityMigrationBarrier(db, { appHome })
      expect(report.recoveredOperations).toBe(1)
      expect(readFileSync(join(storedOldTrash, 'sentinel.txt'), 'utf-8')).toBe('old-home-trash')
      expect(getActiveOp(db, id)).toBeNull()
      expect(lockCount(db)).toBe(0)
      if (phase === 'db-committed') {
        expect(db.select().from(skills).where(eq(skills.id, id)).get()).toBeUndefined()
        expect(existsSync(currentTrash)).toBe(false)
      } else {
        expect(existsSync(skillRootAbs(appHome, id))).toBe(true)
        expect(existsSync(currentTrash)).toBe(false)
      }
    })
  }

  test('in-process throw after db-committed preserves op/lock for barrier rollforward', () => {
    const id = 'delete-committed-fault'
    const name = 'delete-committed-fault-name'
    seedCanonicalRow(db, appHome, id, name)

    expect(() =>
      deleteManagedSkillOp(
        db,
        { appHome },
        { id },
        {
          afterPhase: (phase) => {
            if (phase === 'db-committed') throw new Error('fault-after-delete-commit')
          },
        },
      ),
    ).toThrow('fault-after-delete-commit')
    expect(db.select().from(skills).where(eq(skills.id, id)).get()).toBeUndefined()
    expect(getActiveOp(db, id)?.phase).toBe('db-committed')
    expect(lockCount(db)).toBe(1)

    const report = runSkillIdentityMigrationBarrier(db, { appHome })
    expect(report.recoveredOperations).toBe(1)
    expect(getActiveOp(db, id)).toBeNull()
    expect(lockCount(db)).toBe(0)
  })

  test('db-committed legacy delete rejects a canonical orphan and preserves all evidence', () => {
    const id = 'delete-canonical-orphan'
    const name = 'delete-canonical-orphan-name'
    seedLegacyRow(db, appHome, id, name, { withVersion: true })
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId: id,
        kind: 'delete',
        preconditionJson: JSON.stringify({ name }),
      }),
    )
    const legacyRoot = join(appHome, 'skills', name)
    const trash = join(appHome, 'skills', '.trash', `${id}-${opId}`)
    mkdirSync(dirname(trash), { recursive: true })
    renameSync(legacyRoot, trash)
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged', { backupPath: trash }))
    dbTxSync(db, (tx) => {
      tx.delete(skills).where(eq(skills.id, id)).run()
      advancePhase(tx, opId, 'db-committed')
    })
    const canonicalRoot = skillRootAbs(appHome, id)
    writeTree(canonicalRoot, 'canonical-orphan')
    const trashHash = hashDir(trash)
    const canonicalHash = hashDir(canonicalRoot)

    expect(() => runSkillIdentityMigrationBarrier(db, { appHome })).toThrow(
      /committed row deletion but canonical root remains/,
    )
    expect(hashDir(trash)).toBe(trashHash)
    expect(hashDir(canonicalRoot)).toBe(canonicalHash)
    expect(getActiveOp(db, id)?.phase).toBe('db-committed')
    expect(lockCount(db)).toBe(1)
  })
})

describe('RFC-223 legacy version-write op upgrade matrix', () => {
  let db: DbClient
  let oldHome: string
  let appHome: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    oldHome = mkdtempSync(join(tmpdir(), 'aw-old-version-'))
    appHome = mkdtempSync(join(tmpdir(), 'aw-new-version-'))
  })
  afterEach(() => {
    rmSync(oldHome, { recursive: true, force: true })
    rmSync(appHome, { recursive: true, force: true })
  })

  for (const phase of [
    'intent',
    'fs-staged',
    'fs-versioned',
    'db-committed',
    'fs-published',
  ] as const) {
    test(`${phase}: legacy absolute staged/candidate paths recover only in newHome`, () => {
      const id = `version-${phase}`
      const name = `legacy-version-${phase}`
      seedLegacyRow(db, appHome, id, name, { withVersion: true })
      const publishId = ulid()
      const currentFiles = join(appHome, 'skills', name, 'files')
      const currentStaging = opStagedDir(currentFiles, publishId)
      const currentVersion = join(appHome, 'skills', name, 'versions', 'v2', 'files')
      const storedStaging = opStagedDir(join(oldHome, 'skills', name, 'files'), publishId)
      const storedVersion = join(oldHome, 'skills', name, 'versions', 'v2', 'files')

      const opId = dbTxSync(db, (tx) =>
        beginOperation(tx, {
          skillId: id,
          kind: 'version-write',
          targetVersion: 2,
          stagingPath: storedStaging,
          candidatePath: storedVersion,
          preconditionJson: JSON.stringify({ name }),
        }),
      )
      if (phase !== 'intent') {
        writeTree(currentStaging, `new-${phase}`)
        dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))
      }
      if (phase === 'fs-versioned' || phase === 'db-committed' || phase === 'fs-published') {
        cpSync(currentStaging, currentVersion, { recursive: true })
        dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-versioned'))
      }
      if (phase === 'db-committed' || phase === 'fs-published') {
        const contentHash = hashDir(currentVersion)
        dbTxSync(db, (tx) => {
          tx.update(skills).set({ contentVersion: 2 }).where(eq(skills.id, id)).run()
          tx.insert(skillVersions)
            .values({
              id: ulid(),
              skillId: id,
              versionIndex: 2,
              filesPath: `skills/${name}/versions/v2/files`,
              source: 'editor',
              authorUserId: '__system__',
              contentHash,
            })
            .run()
          advancePhase(tx, opId, 'db-committed')
        })
      }
      if (phase === 'fs-published') {
        const backup = opBackupDir(currentFiles, publishId)
        renameSync(currentFiles, backup)
        renameSync(currentStaging, currentFiles)
        dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-published'))
      }

      writeTree(storedStaging, 'old-home-staging-sentinel')
      writeTree(storedVersion, 'old-home-version-sentinel')
      const report = runSkillIdentityMigrationBarrier(db, { appHome })
      expect(report.recoveredOperations).toBe(1)
      expect(readFileSync(join(storedStaging, 'payload.txt'), 'utf-8')).toBe(
        'old-home-staging-sentinel',
      )
      expect(readFileSync(join(storedVersion, 'payload.txt'), 'utf-8')).toBe(
        'old-home-version-sentinel',
      )
      expect(getActiveOp(db, id)).toBeNull()
      expect(lockCount(db)).toBe(0)
      expect(existsSync(skillRootAbs(appHome, id))).toBe(true)
      if (phase === 'db-committed' || phase === 'fs-published') {
        expect(readFileSync(join(skillFilesAbs(appHome, id), 'payload.txt'), 'utf-8')).toBe(
          `new-${phase}`,
        )
        expect(
          db
            .select({ path: skillVersions.filesPath })
            .from(skillVersions)
            .where(eq(skillVersions.skillId, id))
            .all()
            .map((row) => row.path)
            .sort(),
        ).toEqual([skillVersionRelPath(id, 1), skillVersionRelPath(id, 2)])
      } else {
        expect(
          db.select().from(skillVersions).where(eq(skillVersions.skillId, id)).all(),
        ).toHaveLength(1)
      }
    })
  }
})

function seedLegacyRow(
  db: DbClient,
  appHome: string,
  id: string,
  name: string,
  opts: {
    reservationState?: 'ready' | 'reserving'
    withVersion: boolean
  },
): void {
  const filesDir = join(appHome, 'skills', name, 'files')
  writeTree(filesDir, 'legacy-live-v1')
  db.insert(skills)
    .values({
      id,
      name,
      sourceKind: 'managed',
      managedPath: `skills/${name}/files`,
      contentVersion: opts.withVersion ? 1 : 0,
      reservationState: opts.reservationState ?? 'ready',
      versionState: opts.withVersion ? 'snapshot-authoritative' : 'legacy-unbackfilled',
    })
    .run()
  if (opts.withVersion) {
    const versionDir = join(appHome, 'skills', name, 'versions', 'v1', 'files')
    cpSync(filesDir, versionDir, { recursive: true })
    db.insert(skillVersions)
      .values({
        id: ulid(),
        skillId: id,
        versionIndex: 1,
        filesPath: `skills/${name}/versions/v1/files`,
        source: 'initial',
        authorUserId: '__system__',
        contentHash: hashDir(versionDir),
      })
      .run()
  }
}

function seedCanonicalRow(db: DbClient, appHome: string, id: string, name: string): void {
  const filesDir = skillFilesAbs(appHome, id)
  const versionDir = skillVersionAbs(appHome, id, 1)
  writeTree(filesDir, 'canonical-live')
  cpSync(filesDir, versionDir, { recursive: true })
  db.insert(skills)
    .values({
      id,
      name,
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
}

function writeTree(root: string, marker: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `# ${marker}\n`)
  writeFileSync(join(root, 'payload.txt'), marker)
}

function lockCount(db: DbClient): number {
  return db.select().from(skillOperationLocks).all().length
}
