// RFC-170 F3 — file PUT/DELETE + restore honor the composite precondition token.
// The version-write funnel OCC-checks it in the bump tx (the SAME fence as
// combined-save): a stale token (another writer advanced the version) → 409, a
// malformed token → 400, no token → unfenced (backward compatible). This lets the
// frontend's single canonical token store guard concurrent file/version edits so a
// paused SkillFileTree can't clobber a save that landed in between.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createManagedSkill,
  deleteSkillFile,
  getSkillPreconditionTokenById,
  writeSkillFile,
} from '../src/services/skill'
import { restoreSkillVersion } from '../src/services/skillVersion'
import { ConflictError, ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-170 F3 — file/restore composite-token OCC', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }
  let skillId: string

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-f3-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    const skill = await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    skillId = skill.id
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  async function token(): Promise<string> {
    const t = await getSkillPreconditionTokenById(db, skillId)
    if (t === null) throw new Error('expected a token')
    return t
  }

  test('writeSkillFile with the current token succeeds; the token then advances', async () => {
    const t0 = await token()
    await writeSkillFile(db, fsOpts, skillId, 'a.txt', 'aaa', 'u', undefined, t0)
    const t1 = await token()
    expect(t1).not.toBe(t0) // contentVersion bumped → the canonical token advances
  })

  test('writeSkillFile with a STALE token → 409, no write applied', async () => {
    const t0 = await token()
    await writeSkillFile(db, fsOpts, skillId, 'a.txt', 'aaa', 'u', undefined, t0) // advances to v2
    await expect(
      writeSkillFile(db, fsOpts, skillId, 'b.txt', 'bbb', 'u', undefined, t0), // t0 now stale
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('writeSkillFile with a malformed token → 400', async () => {
    await expect(
      writeSkillFile(db, fsOpts, skillId, 'a.txt', 'aaa', 'u', undefined, 'not-a-token!!'),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  test('deleteSkillFile with a STALE token → 409', async () => {
    const t0 = await token()
    await writeSkillFile(db, fsOpts, skillId, 'a.txt', 'aaa', 'u', undefined, t0) // advances
    await expect(
      deleteSkillFile(db, fsOpts, skillId, 'a.txt', 'u', undefined, t0), // t0 stale
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('restoreSkillVersion with a STALE token → 409', async () => {
    const t0 = await token()
    await writeSkillFile(db, fsOpts, skillId, 'a.txt', 'aaa', 'u', undefined, t0) // v2, advances
    expect(() =>
      restoreSkillVersion(db, fsOpts, skillId, 1, 'u', undefined, undefined, t0),
    ).toThrow(ConflictError)
  })

  test('no token → file writes remain unfenced (backward compatible)', async () => {
    await writeSkillFile(db, fsOpts, skillId, 'a.txt', 'aaa', 'u')
    await deleteSkillFile(db, fsOpts, skillId, 'a.txt', 'u')
  })
})
