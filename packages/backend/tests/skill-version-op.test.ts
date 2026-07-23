// RFC-170 §6a/T7② — commitSkillVersion runs under a version-write op: it takes a
// serialising lease (concurrent same-skill write → busy 409), the lock is freed
// after, `skipOp` lets a caller that already holds the lock (reserve) reuse it,
// and a crashed version-write is recovered (rollback discards the uncommitted
// staged/version dirs; rollforward verifies the committed snapshot and publishes
// canonical live before freeing the lock).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { skillOperationLocks, skills, skillVersions } from '../src/db/schema'
import { createManagedSkill } from '../src/services/skill'
import { getSkill } from './helpers/resourceLookup'
import { commitSkillVersion } from '../src/services/skillVersion'
import {
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '../src/services/skillIdentityPaths'
import { hashDir } from '../src/services/skillHash'
import { opStagedDir } from '../src/services/skillFsPublish'
import { advancePhase, beginOperation, getActiveOp } from '../src/services/skillOperations'
import { recoverSkillOperations } from '../src/services/skillOpRecoveryDriver'
import { SKILL_OP_RECOVERY_REGISTRY } from '../src/services/skillOpRegistry'
import { ConflictError } from '../src/util/errors'
import { isSkillBootVerified } from '../src/services/skillBootVerify'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-170 T7② — version-write op', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }
  let skillId: string

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-vw-op-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd',
      bodyMd: 'body0',
      frontmatterExtra: {},
    })
    skillId = (await getSkill(db, 'foo'))!.id
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('a normal commit opens+closes a version-write op (no active op, lock freed after)', () => {
    commitSkillVersion(
      db,
      fsOpts,
      skillId,
      (s) => {
        writeFileSync(join(s, 'SKILL.md'), '---\nname: foo\n---\nv1', 'utf-8')
      },
      { source: 'editor', authorUserId: 'u' },
    )
    expect(getActiveOp(db, skillId)).toBeNull()
  })

  test('a held lock makes a concurrent commit busy (409)', () => {
    // Someone else holds the skill's op lock.
    dbTxSync(db, (tx) => beginOperation(tx, { skillId, kind: 'delete' }))
    expect(() =>
      commitSkillVersion(db, fsOpts, skillId, () => {}, {
        source: 'editor',
        authorUserId: 'u',
      }),
    ).toThrow(ConflictError)
  })

  test('skipOp bypasses the lock — a caller holding the op can still commit', () => {
    // Reserve-style: caller holds the lock, then commits v-next with skipOp.
    dbTxSync(db, (tx) => beginOperation(tx, { skillId, kind: 'reserve' }))
    expect(() =>
      commitSkillVersion(
        db,
        fsOpts,
        skillId,
        (s) => {
          writeFileSync(join(s, 'SKILL.md'), '---\nname: foo\n---\nvia-skipop', 'utf-8')
        },
        { source: 'editor', authorUserId: 'u', skipOp: true },
      ),
    ).not.toThrow()
  })

  test('recovery ROLLBACK: crash pre-db-committed discards staged + orphan version dir', () => {
    const publishId = ulid()
    const staging = opStagedDir(skillFilesAbs(appHome, skillId), publishId)
    const versionDir = skillVersionAbs(appHome, skillId, 2)
    mkdirSync(staging, { recursive: true })
    mkdirSync(versionDir, { recursive: true })
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId,
        kind: 'version-write',
        targetVersion: 2,
        stagingPath: staging,
        candidatePath: versionDir,
        preconditionJson: JSON.stringify({ skillId }),
      }),
    )
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-versioned'))

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    expect(existsSync(staging)).toBe(false) // staged discarded
    expect(existsSync(versionDir)).toBe(false) // orphan version dir discarded
    expect(getActiveOp(db, skillId)).toBeNull() // lock freed
  })

  test('pre-commit cleanup fault preserves op/lock until recovery proves cleanup', () => {
    expect(() =>
      commitSkillVersion(
        db,
        fsOpts,
        skillId,
        () => {
          throw new Error('producer-fault')
        },
        {
          source: 'editor',
          authorUserId: 'u',
          __beforeRollbackCleanupForTest: () => {
            throw new Error('cleanup-fault')
          },
        },
      ),
    ).toThrow('producer-fault')
    expect(getActiveOp(db, skillId)?.phase).toBe('intent')
    expect(db.select().from(skillOperationLocks).all()).toHaveLength(1)
    expect(
      readdirSync(skillRootAbs(appHome, skillId)).some((name) =>
        /^files\.op-.*\.staged$/.test(name),
      ),
    ).toBe(true)

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)
    expect(getActiveOp(db, skillId)).toBeNull()
    expect(db.select().from(skillOperationLocks).all()).toHaveLength(0)
    expect(
      readdirSync(skillRootAbs(appHome, skillId)).some((name) =>
        /^files\.op-.*\.(?:staged|backup|candidate)$/.test(name),
      ),
    ).toBe(false)
  })

  test('recovery ROLLFORWARD: crash post-db-committed publishes live then frees the lock', () => {
    const publishId = ulid()
    const filesDir = skillFilesAbs(appHome, skillId)
    const staging = opStagedDir(filesDir, publishId)
    const versionDir = skillVersionAbs(appHome, skillId, 2)
    cpSync(filesDir, staging, { recursive: true })
    writeFileSync(join(staging, 'SKILL.md'), '---\nname: foo\n---\nrecovered-v2', 'utf-8')
    cpSync(staging, versionDir, { recursive: true })
    const contentHash = hashDir(versionDir)
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId,
        kind: 'version-write',
        targetVersion: 2,
        stagingPath: staging,
        candidatePath: versionDir,
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
          authorUserId: 'u',
          contentHash,
        })
        .run()
      advancePhase(tx, opId, 'db-committed')
    })

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    expect(getActiveOp(db, skillId)).toBeNull() // lock freed, op finished
    expect(existsSync(staging)).toBe(false) // leftover staged cleaned
    expect(readFileSync(join(filesDir, 'SKILL.md'), 'utf-8')).toContain('recovered-v2')
  })

  test('a vanished staged tree cannot no-op publish old live as the new authority', () => {
    expect(isSkillBootVerified(skillId)).toBe(true)
    expect(() =>
      commitSkillVersion(
        db,
        fsOpts,
        skillId,
        (staging) => {
          writeFileSync(join(staging, 'SKILL.md'), '---\nname: foo\n---\nnew-v2')
        },
        {
          source: 'editor',
          authorUserId: 'u',
          txExtra: () => {
            const staged = readdirSync(skillRootAbs(appHome, skillId)).find((name) =>
              /^files\.op-.*\.staged$/.test(name),
            )
            if (staged === undefined) throw new Error('staged fixture missing')
            rmSync(join(skillRootAbs(appHome, skillId), staged), {
              recursive: true,
              force: true,
            })
          },
        },
      ),
    ).toThrow(/live publish does not match committed content hash/)
    expect(getActiveOp(db, skillId)?.phase).toBe('db-committed')
    expect(db.select().from(skillOperationLocks).all()).toHaveLength(1)
    expect(isSkillBootVerified(skillId)).toBe(false)
    expect(readFileSync(join(skillFilesAbs(appHome, skillId), 'SKILL.md'), 'utf-8')).toContain(
      'body0',
    )

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)
    expect(getActiveOp(db, skillId)).toBeNull()
    expect(readFileSync(join(skillFilesAbs(appHome, skillId), 'SKILL.md'), 'utf-8')).toContain(
      'new-v2',
    )
  })

  test('a post-DB-commit fault preserves op/lock and hides the old admission', () => {
    expect(isSkillBootVerified(skillId)).toBe(true)
    expect(() =>
      commitSkillVersion(
        db,
        fsOpts,
        skillId,
        (staging) => {
          writeFileSync(join(staging, 'SKILL.md'), '---\nname: foo\n---\nnew-v2')
        },
        {
          source: 'editor',
          authorUserId: 'u',
          __afterDbCommitForTest: () => {
            throw new Error('post-commit-fault')
          },
        },
      ),
    ).toThrow('post-commit-fault')
    expect(getActiveOp(db, skillId)?.phase).toBe('db-committed')
    expect(db.select().from(skillOperationLocks).all()).toHaveLength(1)
    expect(isSkillBootVerified(skillId)).toBe(false)
    expect(
      db
        .select({ version: skills.contentVersion })
        .from(skills)
        .where(eq(skills.id, skillId))
        .get(),
    ).toEqual({ version: 2 })
  })
})
