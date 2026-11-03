import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
// RFC-170 §6a/T7② — a skill version write is serialised by the skill's lock (a
// concurrent same-skill write → busy 409) and its crash is recovered: rollback
// discards the uncommitted staged/version dirs; rollforward verifies the committed
// snapshot and publishes canonical live before freeing the lock.
//
// RFC-401 T5：新写入经 skill 写入场景（journal + 持久 claim + 同一把锁），恢复是 AtomicApply 的 skill 场景；RFC-401 之前写下
// 的旧 version-write operation 仍由启动时的兼容执行器 `recoverSkillOperations` 排空（下面两条手工构造旧记录的用例）。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { expect, test, beforeEach, afterEach } from 'bun:test'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
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
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createManagedSkill } from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import { commitSkillVersion } from '../src/modules/resource-catalog/infrastructure/legacy/skillVersion'
import {
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import { hashDir } from '../src/modules/resource-catalog/infrastructure/legacy/skillHash'
import { opStagedDir } from '../src/modules/resource-catalog/infrastructure/legacy/skillFsPublish'
import {
  advancePhase,
  beginOperation,
  getActiveOp,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { recoverSkillOperations } from '../src/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'
import { SKILL_OP_RECOVERY_REGISTRY } from '../src/modules/resource-catalog/infrastructure/legacy/skillOpRegistry'
import { ConflictError } from '../src/util/errors'
import { isSkillBootVerified } from '../src/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { describeEachProvider } from './helpers/eachProvider'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { skillApplyRecoveryContentFor } from '../src/modules/resource-catalog/infrastructure/skillApplyContent'
import { createSkillApplyRecoveryScene } from '../src/modules/resource-catalog/infrastructure/skillApplyRecovery'

describeEachProvider('RFC-170 T7② — version-write op', (harness) => {
  let db: PersistenceDb
  let appHome: string
  let fsOpts: { appHome: string }
  let skillId: string

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-vw-op-'))
    fsOpts = { appHome }
    db = harness.db
    const skill = await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd',
      bodyMd: 'body0',
      frontmatterExtra: {},
    })
    skillId = skill.id
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const recoverJournals = () =>
    createAtomicApplyRecovery([
      createSkillApplyRecoveryScene({ db, content: skillApplyRecoveryContentFor(db, appHome) }),
    ]).converge({ skill: [] })
  const locks = async () => {
    const { skillOperationLocks } = tablesOf(db)
    return db.select().from(skillOperationLocks)
  }
  const versionJournal = async () => {
    const { skillApplyJournal } = tablesOf(db)
    return (
      await db.select().from(skillApplyJournal).where(eq(skillApplyJournal.skillId, skillId))
    ).find((row) => row.operation === 'version')
  }

  test('a normal commit settles its journal and frees the lock (no legacy operation)', async () => {
    await commitSkillVersion(
      db,
      fsOpts,
      skillId,
      (s) => {
        writeFileSync(join(s, 'SKILL.md'), '---\nname: foo\n---\nv1', 'utf-8')
      },
      { source: 'editor', authorUserId: 'u' },
    )
    expect(await getActiveOp(db, skillId)).toBeNull()
    expect((await versionJournal())?.state).toBe('committed')
    expect(await locks()).toEqual([])
  })

  test('a held lock makes a concurrent commit busy (409)', async () => {
    // Someone else holds the skill's op lock.
    await databaseSessionFor(db).transaction(
      async (tx) => await beginOperation(tx, { skillId, kind: 'delete' }),
    )
    await expect(
      commitSkillVersion(db, fsOpts, skillId, () => {}, {
        source: 'editor',
        authorUserId: 'u',
      }),
    ).rejects.toThrow(ConflictError)
  })

  test('recovery ROLLBACK: crash pre-db-committed discards staged + orphan version dir', async () => {
    const publishId = ulid()
    const staging = opStagedDir(skillFilesAbs(appHome, skillId), publishId)
    const versionDir = skillVersionAbs(appHome, skillId, 2)
    mkdirSync(staging, { recursive: true })
    mkdirSync(versionDir, { recursive: true })
    const opId = await databaseSessionFor(db).transaction(
      async (tx) =>
        await beginOperation(tx, {
          skillId,
          kind: 'version-write',
          targetVersion: 2,
          stagingPath: staging,
          candidatePath: versionDir,
          preconditionJson: JSON.stringify({ skillId }),
        }),
    )
    await databaseSessionFor(db).transaction(
      async (tx) => await advancePhase(tx, opId, 'fs-versioned'),
    )

    await recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    expect(existsSync(staging)).toBe(false) // staged discarded
    expect(existsSync(versionDir)).toBe(false) // orphan version dir discarded
    expect(await getActiveOp(db, skillId)).toBeNull() // lock freed
  })

  test('pre-commit cleanup fault preserves the lock until recovery proves cleanup', async () => {
    await expect(
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
    ).rejects.toThrow('producer-fault')
    expect((await versionJournal())?.state).toBe('prepared')
    expect(await locks()).toHaveLength(1)
    expect(
      readdirSync(skillRootAbs(appHome, skillId)).some((name) =>
        /^files\.op-.*\.staged$/.test(name),
      ),
    ).toBe(true)

    expect(await recoverJournals()).toEqual({ failed: 1, rolledForward: 0 })
    expect((await versionJournal())?.state).toBe('failed')
    expect(await locks()).toHaveLength(0)
    expect(
      readdirSync(skillRootAbs(appHome, skillId)).some((name) =>
        /^files\.op-.*\.(?:staged|backup|candidate)$/.test(name),
      ),
    ).toBe(false)
  })

  test('recovery ROLLFORWARD: crash post-db-committed publishes live then frees the lock', async () => {
    const publishId = ulid()
    const filesDir = skillFilesAbs(appHome, skillId)
    const staging = opStagedDir(filesDir, publishId)
    const versionDir = skillVersionAbs(appHome, skillId, 2)
    cpSync(filesDir, staging, { recursive: true })
    writeFileSync(join(staging, 'SKILL.md'), '---\nname: foo\n---\nrecovered-v2', 'utf-8')
    cpSync(staging, versionDir, { recursive: true })
    const contentHash = hashDir(versionDir)
    const opId = await databaseSessionFor(db).transaction(
      async (tx) =>
        await beginOperation(tx, {
          skillId,
          kind: 'version-write',
          targetVersion: 2,
          stagingPath: staging,
          candidatePath: versionDir,
          preconditionJson: JSON.stringify({ skillId }),
        }),
    )
    await databaseSessionFor(db).transaction(
      async (tx) => await advancePhase(tx, opId, 'fs-staged'),
    )
    await databaseSessionFor(db).transaction(
      async (tx) => await advancePhase(tx, opId, 'fs-versioned'),
    )
    await databaseSessionFor(db).transaction(async (tx) => {
      const { skills, skillVersions } = tablesOf(tx)
      await tx.update(skills).set({ contentVersion: 2 }).where(eq(skills.id, skillId))
      await insertOne(tx, skillVersions, {
        id: ulid(),
        skillId,
        versionIndex: 2,
        ...contentRowColumns(
          legacyContentRef('skill-path', 'local-file', skillVersionRelPath(skillId, 2)),
        ),
        source: 'editor',
        authorUserId: 'u',
        contentHash,
      })
      await advancePhase(tx, opId, 'db-committed')
    })

    await recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    expect(await getActiveOp(db, skillId)).toBeNull() // lock freed, op finished
    expect(existsSync(staging)).toBe(false) // leftover staged cleaned
    expect(readFileSync(join(filesDir, 'SKILL.md'), 'utf-8')).toContain('recovered-v2')
  })

  test('a vanished staged tree cannot no-op publish old live as the new authority', async () => {
    expect(isSkillBootVerified(skillId)).toBe(true)
    await expect(
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
    ).rejects.toThrow(/no staged tree|live publish does not match committed content hash/)
    expect((await versionJournal())?.state).toBe('committed')
    expect(await locks()).toHaveLength(1)
    expect(isSkillBootVerified(skillId)).toBe(false)
    expect(readFileSync(join(skillFilesAbs(appHome, skillId), 'SKILL.md'), 'utf-8')).toContain(
      'body0',
    )

    // 恢复从已提交的版本快照重建暂存树再发布，不会把旧 live 当成新一代。
    expect(await recoverJournals()).toEqual({ failed: 0, rolledForward: 1 })
    expect(await locks()).toEqual([])
    expect(isSkillBootVerified(skillId)).toBe(true)
    expect(readFileSync(join(skillFilesAbs(appHome, skillId), 'SKILL.md'), 'utf-8')).toContain(
      'new-v2',
    )
  })

  test('a post-DB-commit fault keeps the lock and hides the old admission until recovery', async () => {
    expect(isSkillBootVerified(skillId)).toBe(true)
    await expect(
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
    ).rejects.toThrow('post-commit-fault')
    expect((await versionJournal())?.state).toBe('committed')
    const { skills } = tablesOf(db)
    expect(await locks()).toHaveLength(1)
    expect(isSkillBootVerified(skillId)).toBe(false)
    expect(
      await first(
        db.select({ version: skills.contentVersion }).from(skills).where(eq(skills.id, skillId)),
      ),
    ).toEqual({ version: 2 })
    // RFC-401 T5：不再等到重启——恢复（维护作业或启动步骤）前滚发布并释放锁。
    expect(await recoverJournals()).toEqual({ failed: 0, rolledForward: 1 })
    expect(await locks()).toEqual([])
    expect(isSkillBootVerified(skillId)).toBe(true)
    expect(readFileSync(join(skillFilesAbs(appHome, skillId), 'SKILL.md'), 'utf-8')).toContain(
      'new-v2',
    )
  })
})
