// RFC-170 §9 — the `reserve` (creation) op: a mid-create skill is invisible
// (reservation_state='reserving') until published+ready, and a crash mid-create
// is recovered — pre-db-committed drops the reserving row+files, post-db-committed
// finishes (the skill stays a complete, visible skill).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { skillOperationLocks, skills } from '../src/db/schema'
import {
  createManagedSkill,
  createManagedSkillWithFiles,
  getSkill,
  listSkills,
} from '../src/services/skill'
import {
  advancePhase,
  beginOperation,
  getActiveOp,
} from '../src/services/skillOperations'
import { recoverSkillOperations } from '../src/services/skillOpRecoveryDriver'
import { SKILL_OP_RECOVERY_REGISTRY } from '../src/services/skillOpRegistry'
import { runSkillIdentityMigrationBarrier } from '../src/services/skillIdentityMigration'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-170 reserve op', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }

  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-reserve-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const rowState = (id: string) =>
    (
      db
        .select({ reservationState: skills.reservationState })
        .from(skills)
        .where(eq(skills.id, id))
        .get() as { reservationState: string } | undefined
    )?.reservationState

  test('createManagedSkill publishes a ready, visible skill with a v1', async () => {
    const s = await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd',
      bodyMd: 'body',
      frontmatterExtra: {},
    })
    expect(s.name).toBe('foo')
    expect(rowState(s.id)).toBe('ready')
    expect(await getSkill(db, 'foo')).not.toBeNull()
    expect((await listSkills(db)).map((x) => x.name)).toContain('foo')
    // v1 archived.
    const dir = join(appHome, 'skills', s.id, 'versions', 'v1', 'files')
    expect(existsSync(dir)).toBe(true)
  })

  test('a reserving skill is invisible to getSkill + listSkills', async () => {
    // Plant a row still at 'reserving'.
    const id = ulid()
    db.insert(skills)
      .values({
        id,
        name: 'pending',
        sourceKind: 'managed',
        managedPath: 'skills/pending/files',
        reservationState: 'reserving',
      })
      .run()
    expect(await getSkill(db, 'pending')).toBeNull()
    expect((await listSkills(db)).map((x) => x.name)).not.toContain('pending')
  })

  test('recovery ROLLBACK: crash pre-db-committed drops the reserving row + files', async () => {
    const id = ulid()
    const skillDir = join(appHome, 'skills', 'half')
    // Plant a crashed reserve at fs-staged: reserving row + files on disk.
    const opId = dbTxSync(db, (tx) => {
      tx.insert(skills)
        .values({
          id,
          name: 'half',
          sourceKind: 'managed',
          managedPath: 'skills/half/files',
          reservationState: 'reserving',
        })
        .run()
      return beginOperation(tx, {
        skillId: id,
        kind: 'reserve',
        preconditionJson: JSON.stringify({ name: 'half' }),
      })
    })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(skillDir, 'files'), { recursive: true })
    writeFileSync(join(skillDir, 'files', 'SKILL.md'), 'x', 'utf-8')
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    // Reserving row + files gone — the create never completed.
    expect(db.select().from(skills).where(eq(skills.id, id)).get()).toBeUndefined()
    expect(existsSync(skillDir)).toBe(false)
  })

  test('recovery ROLLFORWARD: crash after db-committed keeps the skill ready', async () => {
    const id = ulid()
    const opId = dbTxSync(db, (tx) => {
      tx.insert(skills)
        .values({
          id,
          name: 'done1',
          sourceKind: 'managed',
          managedPath: 'skills/done1/files',
          reservationState: 'reserving',
        })
        .run()
      return beginOperation(tx, {
        skillId: id,
        kind: 'reserve',
        preconditionJson: JSON.stringify({ name: 'done1' }),
      })
    })
    // Reached db-committed (ready set) but crashed before finishOperation.
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-published'))
    dbTxSync(db, (tx) => {
      tx.update(skills).set({ reservationState: 'ready' }).where(eq(skills.id, id)).run()
      advancePhase(tx, opId, 'db-committed')
    })

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    // Skill stays ready + visible; the op finishes.
    expect(rowState(id)).toBe('ready')
    expect(await getSkill(db, 'done1')).not.toBeNull()
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
    const row = db
      .select()
      .from(skills)
      .where(eq(skills.name, 'committed-create'))
      .get()!
    expect(row.reservationState).toBe('ready')
    expect(existsSync(join(appHome, 'skills', row.id, 'files', 'SKILL.md'))).toBe(true)
    expect(getActiveOp(db, row.id)?.phase).toBe('db-committed')
    expect(db.select().from(skillOperationLocks).all()).toHaveLength(1)

    runSkillIdentityMigrationBarrier(db, { appHome })
    expect(getActiveOp(db, row.id)).toBeNull()
    expect(db.select().from(skillOperationLocks).all()).toHaveLength(0)
    expect(await getSkill(db, 'committed-create')).not.toBeNull()
  })
})
