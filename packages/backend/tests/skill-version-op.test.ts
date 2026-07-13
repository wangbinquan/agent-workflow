// RFC-170 §6a/T7② — commitSkillVersion runs under a version-write op: it takes a
// serialising lease (concurrent same-skill write → busy 409), the lock is freed
// after, `skipOp` lets a caller that already holds the lock (reserve) reuse it,
// and a crashed version-write is recovered (rollback discards the uncommitted
// staged/version dirs; rollforward frees the lock — reconcile republishes live).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { createManagedSkill, getSkill } from '../src/services/skill'
import { commitSkillVersion } from '../src/services/skillVersion'
import { advancePhase, beginOperation, getActiveOp } from '../src/services/skillOperations'
import { recoverSkillOperations } from '../src/services/skillOpRecoveryDriver'
import { SKILL_OP_RECOVERY_REGISTRY } from '../src/services/skillOpRegistry'
import { ConflictError } from '../src/util/errors'

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
      'foo',
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
      commitSkillVersion(db, fsOpts, 'foo', () => {}, { source: 'editor', authorUserId: 'u' }),
    ).toThrow(ConflictError)
  })

  test('skipOp bypasses the lock — a caller holding the op can still commit', () => {
    // Reserve-style: caller holds the lock, then commits v-next with skipOp.
    dbTxSync(db, (tx) => beginOperation(tx, { skillId, kind: 'reserve' }))
    expect(() =>
      commitSkillVersion(
        db,
        fsOpts,
        'foo',
        (s) => {
          writeFileSync(join(s, 'SKILL.md'), '---\nname: foo\n---\nvia-skipop', 'utf-8')
        },
        { source: 'editor', authorUserId: 'u', skipOp: true },
      ),
    ).not.toThrow()
  })

  test('recovery ROLLBACK: crash pre-db-committed discards staged + orphan version dir', () => {
    const staging = join(appHome, 'skills', 'foo', 'files.op-VW1.staged')
    const versionDir = join(appHome, 'skills', 'foo', 'versions', 'v2', 'files')
    mkdirSync(staging, { recursive: true })
    mkdirSync(versionDir, { recursive: true })
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId,
        kind: 'version-write',
        stagingPath: staging,
        candidatePath: versionDir,
        preconditionJson: JSON.stringify({ name: 'foo' }),
      }),
    )
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-versioned'))

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    expect(existsSync(staging)).toBe(false) // staged discarded
    expect(existsSync(versionDir)).toBe(false) // orphan version dir discarded
    expect(getActiveOp(db, skillId)).toBeNull() // lock freed
  })

  test('recovery ROLLFORWARD: crash post-db-committed just frees the lock', () => {
    const staging = join(appHome, 'skills', 'foo', 'files.op-VW2.staged')
    mkdirSync(staging, { recursive: true })
    const opId = dbTxSync(db, (tx) =>
      beginOperation(tx, {
        skillId,
        kind: 'version-write',
        stagingPath: staging,
        preconditionJson: JSON.stringify({ name: 'foo' }),
      }),
    )
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-versioned'))
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'db-committed'))

    recoverSkillOperations(db, fsOpts, SKILL_OP_RECOVERY_REGISTRY)

    expect(getActiveOp(db, skillId)).toBeNull() // lock freed, op finished
    expect(existsSync(staging)).toBe(false) // leftover staged cleaned
  })
})
