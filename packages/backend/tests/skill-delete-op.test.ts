// RFC-170 §6a — the `delete` op (crash-safe managed-skill deletion) + its boot
// recovery. Forward: root → trash → DELETE row → drop trash, lock freed. Recovery:
// a crash pre-db-committed restores the root from trash (delete never committed);
// post-db-committed drops the trash (row already gone).

import { buildActor } from '../src/auth/actor'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { skills } from '../src/db/schema'
import { createManagedSkill, deleteSkill } from '../src/services/skill'
import { getSkill } from './helpers/resourceLookup'
import { deleteManagedSkillOp } from '../src/services/skillDeleteOp'
import { advancePhase, beginOperation, getActiveOp } from '../src/services/skillOperations'
import { recoverSkillOperations } from '../src/services/skillOpRecoveryDriver'
import { SKILL_OP_RECOVERY_REGISTRY } from '../src/services/skillOpRegistry'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-170 delete op', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }
  let skillId: string

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-del-op-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    const skill = await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: 'body',
      frontmatterExtra: {},
    })
    skillId = skill.id
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const root = () => join(appHome, 'skills', skillId)

  test('forward: deleteManagedSkillOp removes row + files, releases lock, leaves no trash', async () => {
    const skill = await getSkill(db, 'foo')
    expect(skill).not.toBeNull()
    deleteManagedSkillOp(db, fsOpts, { id: skill!.id })
    expect(await getSkill(db, 'foo')).toBeNull()
    expect(existsSync(root())).toBe(false)
    expect(getActiveOp(db, skill!.id)).toBeNull() // op done, lock freed
    // No leftover trash under skills/.trash.
    const trashDir = join(appHome, 'skills', '.trash')
    if (existsSync(trashDir)) {
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(trashDir)).toHaveLength(0)
    }
  })

  test('deleteSkill (managed) routes through the op and removes the skill', async () => {
    await deleteSkill(db, fsOpts, skillId, T6_ACTOR)
    expect(await getSkill(db, 'foo')).toBeNull()
    expect(existsSync(root())).toBe(false)
  })

  test('recovery ROLLBACK: crash pre-db-committed restores the root; skill survives', async () => {
    const skill = await getSkill(db, 'foo')
    const currentSkillId = skill!.id
    // Plant a crashed op at fs-staged: root moved to trash, row still present.
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId: currentSkillId,
        kind: 'delete',
        preconditionJson: JSON.stringify({ skillId: currentSkillId }),
      }),
    )
    const trash = join(appHome, 'skills', '.trash', `${currentSkillId}-${opId}`)
    mkdirSync(dirname(trash), { recursive: true })
    renameSync(root(), trash)
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged', { backupPath: trash }))
    expect(existsSync(root())).toBe(false)

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    // Root restored, row intact, lock freed — the delete never committed.
    expect(existsSync(root())).toBe(true)
    expect(readFileSync(join(root(), 'files', 'SKILL.md'), 'utf-8')).toContain('body')
    expect(await getSkill(db, 'foo')).not.toBeNull()
    expect(getActiveOp(db, currentSkillId)).toBeNull()
    expect(existsSync(trash)).toBe(false)
  })

  test('recovery ROLLFORWARD: crash post-db-committed drops the trash; skill stays gone', async () => {
    const skill = await getSkill(db, 'foo')
    const currentSkillId = skill!.id
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId: currentSkillId,
        kind: 'delete',
        preconditionJson: JSON.stringify({ skillId: currentSkillId }),
      }),
    )
    const trash = join(appHome, 'skills', '.trash', `${currentSkillId}-${opId}`)
    mkdirSync(dirname(trash), { recursive: true })
    renameSync(root(), trash)
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged', { backupPath: trash }))
    // Simulate db-committed reached (row deleted) but crash before trash cleanup.
    dbTxSync(db, (tx) => {
      tx.delete(skills).where(eq(skills.id, currentSkillId)).run()
      advancePhase(tx, opId, 'db-committed')
    })
    expect(existsSync(trash)).toBe(true)

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    // Trash dropped, skill stays deleted, lock freed — the delete completes.
    expect(existsSync(trash)).toBe(false)
    expect(await getSkill(db, 'foo')).toBeNull()
    expect(getActiveOp(db, currentSkillId)).toBeNull()
  })
})
