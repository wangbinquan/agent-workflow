// RFC-170 §2/T4 — combined save gated by the composite precondition token.
// A save with the token from the detail read succeeds and returns a fresh token;
// a stale token (another write advanced the version) → 409 with NO write applied;
// a malformed token → 400. This is the OCC that stops a paused editor from
// silently overwriting a concurrent change / a delete-recreate ABA.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createManagedSkill,
  readSkillContent,
  saveSkillWithToken,
  writeSkillContent,
} from '../src/services/skill'
import { ConflictError, ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-170 T4 — combined save with token OCC', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-combined-save-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd0',
      bodyMd: 'body0',
      frontmatterExtra: {},
    })
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('save with the current token succeeds and returns a fresh (advanced) token', async () => {
    const read = await readSkillContent(db, fsOpts, 'foo')
    const saved = await saveSkillWithToken(db, fsOpts, 'foo', { bodyMd: 'body1' }, read.token!, 'u')
    expect(saved.bodyMd).toBe('body1')
    // The returned token advanced (content_version bumped) — not the same string.
    expect(saved.token).toBeDefined()
    expect(saved.token).not.toBe(read.token)
  })

  test('a STALE token → 409 ConflictError and NO write is applied', async () => {
    const read = await readSkillContent(db, fsOpts, 'foo')
    // Someone else advances the version out-of-band.
    await writeSkillContent(db, fsOpts, 'foo', { bodyMd: 'other-writer' }, 'u2')
    // Our save still holds the pre-write token → must be rejected.
    await expect(
      saveSkillWithToken(db, fsOpts, 'foo', { bodyMd: 'mine' }, read.token!, 'u'),
    ).rejects.toBeInstanceOf(ConflictError)
    // The other writer's content stands; our stale write did NOT apply.
    expect((await readSkillContent(db, fsOpts, 'foo')).bodyMd).toBe('other-writer')
  })

  test('a malformed token → 400 ValidationError', async () => {
    await expect(
      saveSkillWithToken(db, fsOpts, 'foo', { bodyMd: 'x' }, 'not-a-valid-token!!', 'u'),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  test('the fresh token from a save is usable for the next save (chained edits)', async () => {
    const read = await readSkillContent(db, fsOpts, 'foo')
    const s1 = await saveSkillWithToken(db, fsOpts, 'foo', { bodyMd: 'v1' }, read.token!, 'u')
    // Immediately reuse the returned token — no reload needed.
    const s2 = await saveSkillWithToken(db, fsOpts, 'foo', { bodyMd: 'v2' }, s1.token!, 'u')
    expect(s2.bodyMd).toBe('v2')
  })
})
