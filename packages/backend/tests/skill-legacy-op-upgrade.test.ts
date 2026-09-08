// RFC-223 PR-5 / R4-4 — upgrade recovery for every historical `{name}` op phase.
//
// Durable path columns may contain absolute paths from the machine/appHome where
// a backup was created. Recovery must decode the legacy identity, rebase only
// into the current restored appHome, settle the op, and then let the single
// barrier migrate the surviving root to skills/{id}. Sentinels in oldHome prove
// no historical absolute path is ever touched.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { describeEachProvider } from './helpers/eachProvider'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
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
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { skillOperationLocks, skills, skillVersions } from '../src/db/schema'
import { deleteManagedSkillOp } from '../src/modules/resource-catalog/infrastructure/legacy/skillDeleteOp'
import { runSkillIdentityMigrationBarrier } from '../src/services/skillIdentityMigration'
import {
  skillFilesAbs,
  skillFilesRel,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '../src/services/skillIdentityPaths'
import { hashDir } from '../src/modules/resource-catalog/infrastructure/legacy/skillHash'
import {
  advancePhase,
  beginOperation,
  getActiveOp,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillOperations'
import {
  opBackupDir,
  opStagedDir,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillFsPublish'

describeEachProvider('RFC-223 legacy reserve op upgrade matrix', (harness) => {
  let db: ProviderNeutralDatabase
  let oldHome: string
  let appHome: string

  beforeEach(() => {
    db = harness.db
    oldHome = mkdtempSync(join(tmpdir(), 'aw-old-reserve-'))
    appHome = mkdtempSync(join(tmpdir(), 'aw-new-reserve-'))
  })
  afterEach(() => {
    rmSync(oldHome, { recursive: true, force: true })
    rmSync(appHome, { recursive: true, force: true })
  })

  for (const phase of ['intent', 'fs-staged', 'fs-published', 'db-committed'] as const) {
    test(`${phase}: legacy payload recovers under restored appHome only`, async () => {
      const id = `reserve-${phase}`
      const name = `legacy-reserve-${phase}`
      await seedLegacyRow(db, appHome, id, name, {
        reservationState: phase === 'db-committed' ? 'ready' : 'reserving',
        withVersion: phase === 'fs-published' || phase === 'db-committed',
      })
      const opId = await databaseSessionFor(db).transaction(
        async (tx) =>
          await beginOperation(tx, {
            skillId: id,
            kind: 'reserve',
            preconditionJson: JSON.stringify({ name }),
          }),
      )
      if (phase !== 'intent')
        await databaseSessionFor(db).transaction(
          async (tx) => await advancePhase(tx, opId, 'fs-staged'),
        )
      if (phase === 'fs-published' || phase === 'db-committed') {
        await databaseSessionFor(db).transaction(
          async (tx) => await advancePhase(tx, opId, 'fs-published'),
        )
      }
      if (phase === 'db-committed') {
        await databaseSessionFor(db).transaction(async (tx) => {
          await tx.update(skills).set({ reservationState: 'ready' }).where(eq(skills.id, id)).run()
          await advancePhase(tx, opId, 'db-committed')
        })
      }

      const oldSentinel = join(oldHome, 'skills', name, 'sentinel.txt')
      mkdirSync(dirname(oldSentinel), { recursive: true })
      writeFileSync(oldSentinel, 'old-home')

      const report = await runSkillIdentityMigrationBarrier(db, { appHome })
      expect(report.recoveredOperations).toBe(1)
      expect(readFileSync(oldSentinel, 'utf-8')).toBe('old-home')
      expect(await getActiveOp(db, id)).toBeNull()
      expect(await lockCount(db)).toBe(0)
      if (phase === 'db-committed') {
        expect(await db.select().from(skills).where(eq(skills.id, id)).get()).toBeDefined()
        expect(existsSync(skillRootAbs(appHome, id))).toBe(true)
      } else {
        expect(await db.select().from(skills).where(eq(skills.id, id)).get()).toBeUndefined()
        expect(existsSync(join(appHome, 'skills', name))).toBe(false)
      }
    })
  }
})

describeEachProvider('RFC-223 legacy delete op upgrade matrix', (harness) => {
  let db: ProviderNeutralDatabase
  let oldHome: string
  let appHome: string

  beforeEach(() => {
    db = harness.db
    oldHome = mkdtempSync(join(tmpdir(), 'aw-old-delete-'))
    appHome = mkdtempSync(join(tmpdir(), 'aw-new-delete-'))
  })
  afterEach(() => {
    rmSync(oldHome, { recursive: true, force: true })
    rmSync(appHome, { recursive: true, force: true })
  })

  for (const phase of ['intent', 'fs-staged', 'db-committed'] as const) {
    test(`${phase}: absolute backup path rebases safely and preserves oldHome`, async () => {
      const id = `delete-${phase}`
      const name = `legacy-delete-${phase}`
      await seedLegacyRow(db, appHome, id, name, { withVersion: true })
      const opId = await databaseSessionFor(db).transaction(
        async (tx) =>
          await beginOperation(tx, {
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
        await databaseSessionFor(db).transaction(
          async (tx) => await advancePhase(tx, opId, 'fs-staged', { backupPath: storedOldTrash }),
        )
      }
      if (phase === 'db-committed') {
        await databaseSessionFor(db).transaction(async (tx) => {
          await tx.delete(skills).where(eq(skills.id, id)).run()
          await advancePhase(tx, opId, 'db-committed')
        })
      }

      mkdirSync(storedOldTrash, { recursive: true })
      writeFileSync(join(storedOldTrash, 'sentinel.txt'), 'old-home-trash')
      const report = await runSkillIdentityMigrationBarrier(db, { appHome })
      expect(report.recoveredOperations).toBe(1)
      expect(readFileSync(join(storedOldTrash, 'sentinel.txt'), 'utf-8')).toBe('old-home-trash')
      expect(await getActiveOp(db, id)).toBeNull()
      expect(await lockCount(db)).toBe(0)
      if (phase === 'db-committed') {
        expect(await db.select().from(skills).where(eq(skills.id, id)).get()).toBeUndefined()
        expect(existsSync(currentTrash)).toBe(false)
      } else {
        expect(existsSync(skillRootAbs(appHome, id))).toBe(true)
        expect(existsSync(currentTrash)).toBe(false)
      }
    })
  }

  test('in-process throw after db-committed preserves op/lock for barrier rollforward', async () => {
    const id = 'delete-committed-fault'
    const name = 'delete-committed-fault-name'
    await seedCanonicalRow(db, appHome, id, name)

    await expect(
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
    ).rejects.toThrow('fault-after-delete-commit')
    expect(await db.select().from(skills).where(eq(skills.id, id)).get()).toBeUndefined()
    expect((await getActiveOp(db, id))?.phase).toBe('db-committed')
    expect(await lockCount(db)).toBe(1)

    const report = await runSkillIdentityMigrationBarrier(db, { appHome })
    expect(report.recoveredOperations).toBe(1)
    expect(await getActiveOp(db, id)).toBeNull()
    expect(await lockCount(db)).toBe(0)
  })

  test('db-committed legacy delete rejects a canonical orphan and preserves all evidence', async () => {
    const id = 'delete-canonical-orphan'
    const name = 'delete-canonical-orphan-name'
    await seedLegacyRow(db, appHome, id, name, { withVersion: true })
    const opId = await databaseSessionFor(db).transaction(
      async (tx) =>
        await beginOperation(tx, {
          skillId: id,
          kind: 'delete',
          preconditionJson: JSON.stringify({ name }),
        }),
    )
    const legacyRoot = join(appHome, 'skills', name)
    const trash = join(appHome, 'skills', '.trash', `${id}-${opId}`)
    mkdirSync(dirname(trash), { recursive: true })
    renameSync(legacyRoot, trash)
    await databaseSessionFor(db).transaction(
      async (tx) => await advancePhase(tx, opId, 'fs-staged', { backupPath: trash }),
    )
    await databaseSessionFor(db).transaction(async (tx) => {
      await tx.delete(skills).where(eq(skills.id, id)).run()
      await advancePhase(tx, opId, 'db-committed')
    })
    const canonicalRoot = skillRootAbs(appHome, id)
    writeTree(canonicalRoot, 'canonical-orphan')
    const trashHash = hashDir(trash)
    const canonicalHash = hashDir(canonicalRoot)

    await expect(runSkillIdentityMigrationBarrier(db, { appHome })).rejects.toThrow(
      /committed row deletion but canonical root remains/,
    )
    expect(hashDir(trash)).toBe(trashHash)
    expect(hashDir(canonicalRoot)).toBe(canonicalHash)
    expect((await getActiveOp(db, id))?.phase).toBe('db-committed')
    expect(await lockCount(db)).toBe(1)
  })
})

describeEachProvider('RFC-223 legacy version-write op upgrade matrix', (harness) => {
  let db: ProviderNeutralDatabase
  let oldHome: string
  let appHome: string

  beforeEach(() => {
    db = harness.db
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
    test(`${phase}: legacy absolute staged/candidate paths recover only in newHome`, async () => {
      const id = `version-${phase}`
      const name = `legacy-version-${phase}`
      await seedLegacyRow(db, appHome, id, name, { withVersion: true })
      const publishId = ulid()
      const currentFiles = join(appHome, 'skills', name, 'files')
      const currentStaging = opStagedDir(currentFiles, publishId)
      const currentVersion = join(appHome, 'skills', name, 'versions', 'v2', 'files')
      const storedStaging = opStagedDir(join(oldHome, 'skills', name, 'files'), publishId)
      const storedVersion = join(oldHome, 'skills', name, 'versions', 'v2', 'files')

      const opId = await databaseSessionFor(db).transaction(
        async (tx) =>
          await beginOperation(tx, {
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
        await databaseSessionFor(db).transaction(
          async (tx) => await advancePhase(tx, opId, 'fs-staged'),
        )
      }
      if (phase === 'fs-versioned' || phase === 'db-committed' || phase === 'fs-published') {
        cpSync(currentStaging, currentVersion, { recursive: true })
        await databaseSessionFor(db).transaction(
          async (tx) => await advancePhase(tx, opId, 'fs-versioned'),
        )
      }
      if (phase === 'db-committed' || phase === 'fs-published') {
        const contentHash = hashDir(currentVersion)
        await databaseSessionFor(db).transaction(async (tx) => {
          await tx.update(skills).set({ contentVersion: 2 }).where(eq(skills.id, id)).run()
          await tx
            .insert(skillVersions)
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
          await advancePhase(tx, opId, 'db-committed')
        })
      }
      if (phase === 'fs-published') {
        const backup = opBackupDir(currentFiles, publishId)
        renameSync(currentFiles, backup)
        renameSync(currentStaging, currentFiles)
        await databaseSessionFor(db).transaction(
          async (tx) => await advancePhase(tx, opId, 'fs-published'),
        )
      }

      writeTree(storedStaging, 'old-home-staging-sentinel')
      writeTree(storedVersion, 'old-home-version-sentinel')
      const report = await runSkillIdentityMigrationBarrier(db, { appHome })
      expect(report.recoveredOperations).toBe(1)
      expect(readFileSync(join(storedStaging, 'payload.txt'), 'utf-8')).toBe(
        'old-home-staging-sentinel',
      )
      expect(readFileSync(join(storedVersion, 'payload.txt'), 'utf-8')).toBe(
        'old-home-version-sentinel',
      )
      expect(await getActiveOp(db, id)).toBeNull()
      expect(await lockCount(db)).toBe(0)
      expect(existsSync(skillRootAbs(appHome, id))).toBe(true)
      if (phase === 'db-committed' || phase === 'fs-published') {
        expect(readFileSync(join(skillFilesAbs(appHome, id), 'payload.txt'), 'utf-8')).toBe(
          `new-${phase}`,
        )
        expect(
          (
            await db
              .select({ path: skillVersions.filesPath })
              .from(skillVersions)
              .where(eq(skillVersions.skillId, id))
              .all()
          )
            .map((row) => row.path)
            .sort(),
        ).toEqual([skillVersionRelPath(id, 1), skillVersionRelPath(id, 2)])
      } else {
        expect(
          await db.select().from(skillVersions).where(eq(skillVersions.skillId, id)).all(),
        ).toHaveLength(1)
      }
    })
  }
})

async function seedLegacyRow(
  db: ProviderNeutralDatabase,
  appHome: string,
  id: string,
  name: string,
  opts: {
    reservationState?: 'ready' | 'reserving'
    withVersion: boolean
  },
): Promise<void> {
  const filesDir = join(appHome, 'skills', name, 'files')
  writeTree(filesDir, 'legacy-live-v1')
  await db
    .insert(skills)
    .values({
      id,
      name,
      managedPath: `skills/${name}/files`,
      contentVersion: opts.withVersion ? 1 : 0,
      reservationState: opts.reservationState ?? 'ready',
      versionState: opts.withVersion ? 'snapshot-authoritative' : 'legacy-unbackfilled',
    })
    .run()
  if (opts.withVersion) {
    const versionDir = join(appHome, 'skills', name, 'versions', 'v1', 'files')
    cpSync(filesDir, versionDir, { recursive: true })
    await db
      .insert(skillVersions)
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

async function seedCanonicalRow(
  db: ProviderNeutralDatabase,
  appHome: string,
  id: string,
  name: string,
): Promise<void> {
  const filesDir = skillFilesAbs(appHome, id)
  const versionDir = skillVersionAbs(appHome, id, 1)
  writeTree(filesDir, 'canonical-live')
  cpSync(filesDir, versionDir, { recursive: true })
  await db
    .insert(skills)
    .values({
      id,
      name,
      managedPath: skillFilesRel(id),
      contentVersion: 1,
      reservationState: 'ready',
      versionState: 'snapshot-authoritative',
    })
    .run()
  await db
    .insert(skillVersions)
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

async function lockCount(db: ProviderNeutralDatabase): Promise<number> {
  return (await db.select().from(skillOperationLocks).all()).length
}
