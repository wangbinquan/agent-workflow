import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
// RFC-170 §9 — the `reserve` (creation) op: a mid-create skill is invisible
// (reservation_state='reserving') until published+ready, and a crash mid-create
// is recovered — pre-db-committed drops the reserving row+files, post-db-committed
// finishes (the skill stays a complete, visible skill).

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { expect, test, beforeEach, afterEach } from 'bun:test'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createManagedSkill,
  createManagedSkillWithFiles,
  listSkills,
} from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import {
  advancePhase,
  beginOperation,
  getActiveOp,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { recoverSkillOperations } from '../src/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'
import { SKILL_OP_RECOVERY_REGISTRY } from '../src/modules/resource-catalog/infrastructure/legacy/skillOpRegistry'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-170 reserve op', (harness) => {
  let db: PersistenceDb
  let appHome: string
  let fsOpts: { appHome: string }

  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-reserve-'))
    fsOpts = { appHome }
    db = harness.db
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const rowState = async (id: string) => {
    const { skills } = tablesOf(db)
    return (
      await first(
        db
          .select({ reservationState: skills.reservationState })
          .from(skills)
          .where(eq(skills.id, id)),
      )
    )?.reservationState
  }

  async function getSkill(name: string) {
    return (await listSkills(db)).find((skill) => skill.name === name) ?? null
  }

  test('createManagedSkill publishes a ready, visible skill with a v1', async () => {
    const s = await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd',
      bodyMd: 'body',
      frontmatterExtra: {},
    })
    expect(s.name).toBe('foo')
    expect(await rowState(s.id)).toBe('ready')
    expect(await getSkill('foo')).not.toBeNull()
    expect((await listSkills(db)).map((x) => x.name)).toContain('foo')
    // v1 archived.
    const dir = join(appHome, 'skills', s.id, 'versions', 'v1', 'files')
    expect(existsSync(dir)).toBe(true)
  })

  test('a reserving skill is invisible to getSkill + listSkills', async () => {
    // Plant a row still at 'reserving'.
    const id = ulid()
    const { skills } = tablesOf(db)
    await insertOne(db, skills, {
      id,
      name: 'pending',
      ...contentRowColumns(legacyContentRef('skill-path', 'local-file', 'skills/pending/files')),
      reservationState: 'reserving',
    })
    expect(await getSkill('pending')).toBeNull()
    expect((await listSkills(db)).map((x) => x.name)).not.toContain('pending')
  })

  test('recovery ROLLBACK: crash pre-db-committed drops the reserving row + files', async () => {
    const id = ulid()
    const skillDir = join(appHome, 'skills', 'half')
    // Plant a crashed reserve at fs-staged: reserving row + files on disk.
    const opId = await databaseSessionFor(db).transaction(async (tx) => {
      const { skills } = tablesOf(tx)
      await insertOne(tx, skills, {
        id,
        name: 'half',
        ...contentRowColumns(legacyContentRef('skill-path', 'local-file', 'skills/half/files')),
        reservationState: 'reserving',
      })
      return await beginOperation(tx, {
        skillId: id,
        kind: 'reserve',
        preconditionJson: JSON.stringify({ name: 'half' }),
      })
    })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(skillDir, 'files'), { recursive: true })
    writeFileSync(join(skillDir, 'files', 'SKILL.md'), 'x', 'utf-8')
    await databaseSessionFor(db).transaction(
      async (tx) => await advancePhase(tx, opId, 'fs-staged'),
    )

    await recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    const { skills } = tablesOf(db)
    // Reserving row + files gone — the create never completed.
    expect(await first(db.select().from(skills).where(eq(skills.id, id)))).toBeUndefined()
    expect(existsSync(skillDir)).toBe(false)
  })

  test('recovery ROLLFORWARD: crash after db-committed keeps the skill ready', async () => {
    const id = ulid()
    const opId = await databaseSessionFor(db).transaction(async (tx) => {
      const { skills } = tablesOf(tx)
      await insertOne(tx, skills, {
        id,
        name: 'done1',
        ...contentRowColumns(legacyContentRef('skill-path', 'local-file', 'skills/done1/files')),
        reservationState: 'reserving',
      })
      return await beginOperation(tx, {
        skillId: id,
        kind: 'reserve',
        preconditionJson: JSON.stringify({ name: 'done1' }),
      })
    })
    // Reached db-committed (ready set) but crashed before finishOperation.
    await databaseSessionFor(db).transaction(
      async (tx) => await advancePhase(tx, opId, 'fs-staged'),
    )
    await databaseSessionFor(db).transaction(
      async (tx) => await advancePhase(tx, opId, 'fs-published'),
    )
    await databaseSessionFor(db).transaction(async (tx) => {
      const { skills } = tablesOf(tx)
      await tx.update(skills).set({ reservationState: 'ready' }).where(eq(skills.id, id))
      await advancePhase(tx, opId, 'db-committed')
    })

    await recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    // Skill stays ready + visible; the op finishes.
    expect(await rowState(id)).toBe('ready')
    expect(await getSkill('done1')).not.toBeNull()
  })

  test('in-process fault after db-committed preserves ready row/root/op for rollforward', async () => {
    await expect(
      createManagedSkillWithFiles(
        db,
        fsOpts,
        { name: 'committed-create', description: 'd' },
        (filesDir) => {
          writeFileSync(
            join(filesDir, 'SKILL.md'),
            '---\nname: committed-create\ndescription: d\n---\nbody',
          )
        },
        {
          __afterDbCommitForTest: () => {
            throw new Error('finish-fault')
          },
        },
      ),
    ).rejects.toThrow('finish-fault')
    const { skillOperationLocks } = tablesOf(db),
      { skills } = tablesOf(db)
    const row = (await first(db.select().from(skills).where(eq(skills.name, 'committed-create'))))!
    expect(row.reservationState).toBe('ready')
    expect(existsSync(join(appHome, 'skills', row.id, 'files', 'SKILL.md'))).toBe(true)
    expect((await getActiveOp(db, row.id))?.phase).toBe('db-committed')
    expect(await db.select().from(skillOperationLocks)).toHaveLength(1)

    await recoverSkillOperations(db, { appHome }, SKILL_OP_RECOVERY_REGISTRY)
    expect(await getActiveOp(db, row.id)).toBeNull()
    expect(await db.select().from(skillOperationLocks)).toHaveLength(0)
    expect(await getSkill('committed-create')).not.toBeNull()
  })
})
