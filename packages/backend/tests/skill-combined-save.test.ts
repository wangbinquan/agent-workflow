// RFC-170 §2/T4 — combined save gated by the composite precondition token.
// A save with the token from the detail read succeeds and returns a fresh token;
// a stale token (another write advanced the version) → 409 with NO write applied;
// a malformed token → 400. This is the OCC that stops a paused editor from
// silently overwriting a concurrent change / a delete-recreate ABA.

import { buildActor } from '../src/auth/actor'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createManagedSkill,
  deleteSkill,
  readSkillContent,
  saveSkillWithToken,
  writeSkillContent,
} from '../src/services/skill'
import { getSkill } from './helpers/resourceLookup'
import { ConflictError, ValidationError } from '../src/util/errors'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-170 T4 — combined save with token OCC', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }
  let skillId: string

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-combined-save-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    const skill = await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd0',
      bodyMd: 'body0',
      frontmatterExtra: {},
    })
    skillId = skill.id
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('save with the current token succeeds and returns a fresh (advanced) token', async () => {
    const read = await readSkillContent(db, fsOpts, skillId)
    const saved = await saveSkillWithToken(
      db,
      fsOpts,
      skillId,
      { bodyMd: 'body1' },
      read.token!,
      'u',
    )
    expect(saved.bodyMd).toBe('body1')
    // The returned token advanced (content_version bumped) — not the same string.
    expect(saved.token).toBeDefined()
    expect(saved.token).not.toBe(read.token)
  })

  test('a STALE token → 409 ConflictError and NO write is applied', async () => {
    const read = await readSkillContent(db, fsOpts, skillId)
    // Someone else advances the version out-of-band.
    await writeSkillContent(db, fsOpts, skillId, { bodyMd: 'other-writer' }, 'u2')
    // Our save still holds the pre-write token → must be rejected.
    await expect(
      saveSkillWithToken(db, fsOpts, skillId, { bodyMd: 'mine' }, read.token!, 'u'),
    ).rejects.toBeInstanceOf(ConflictError)
    // The other writer's content stands; our stale write did NOT apply.
    expect((await readSkillContent(db, fsOpts, skillId)).bodyMd).toBe('other-writer')
  })

  test('a malformed token → 400 ValidationError', async () => {
    await expect(
      saveSkillWithToken(db, fsOpts, skillId, { bodyMd: 'x' }, 'not-a-valid-token!!', 'u'),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  test('the fresh token from a save is usable for the next save (chained edits)', async () => {
    const read = await readSkillContent(db, fsOpts, skillId)
    const s1 = await saveSkillWithToken(db, fsOpts, skillId, { bodyMd: 'v1' }, read.token!, 'u')
    // Immediately reuse the returned token — no reload needed.
    const s2 = await saveSkillWithToken(db, fsOpts, skillId, { bodyMd: 'v2' }, s1.token!, 'u')
    expect(s2.bodyMd).toBe('v2')
  })

  // RFC-170 T-BSAFE③ (Codex F1-review): the outer skillTokenMatches in
  // saveSkillWithToken is only a pre-check; the ATOMIC guard is commitSkillVersion's
  // in-tx composite fence, which saveSkillWithToken now feeds via writeSkillContent's
  // `expected`. These lock that a stale expected — the state a request would resume
  // with after a concurrent write slipped between its pre-check and its own tx — is
  // rejected, so the async gap can't LWW-clobber / ABA-redirect.
  test('managed: writeSkillContent with a stale expected.contentVersion → 409 (in-tx concurrent-save fence)', async () => {
    const foo = (await getSkill(db, 'foo'))!
    // Another writer advances the version out-of-band (no expected → unfenced).
    await writeSkillContent(db, fsOpts, skillId, { bodyMd: 'other-writer' }, 'u2')
    // Request A resumes with its pre-drift expected (the old contentVersion).
    await expect(
      writeSkillContent(db, fsOpts, skillId, { bodyMd: 'mine' }, 'u', {
        skillId: foo.id,
        contentVersion: foo.contentVersion,
        metaRevision: 0, // fresh skill; a body write does not bump meta_revision
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    // B's content stands; A's stale write did NOT apply.
    expect((await readSkillContent(db, fsOpts, skillId)).bodyMd.trim()).toBe('other-writer')
  })

  test('managed: writeSkillContent with a stale skillId (delete→recreate ABA) → 409', async () => {
    const staleId = (await getSkill(db, 'foo'))!.id
    await deleteSkill(db, fsOpts, staleId, T6_ACTOR)
    await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd0',
      bodyMd: 'body0',
      frontmatterExtra: {},
    })
    const recreated = (await getSkill(db, 'foo'))!
    // contentVersion + metaRevision are made to MATCH the recreated row so ONLY the
    // stale skillId differs — isolating the ABA leg of the fence.
    await expect(
      writeSkillContent(db, fsOpts, recreated.id, { bodyMd: 'mine' }, 'u', {
        skillId: staleId,
        contentVersion: recreated.contentVersion,
        metaRevision: 0, // recreated skill is fresh (meta_revision 0)
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  // RFC-170 (Codex re-review): the editor no-op short-circuit (identical content →
  // don't inflate history) must ALSO fence. A delete→recreate with byte-identical
  // content in the await window would otherwise hit the no-op and return the
  // substitute skill's row/token to the stale request. The prior ABA test writes
  // changed content (skips the no-op); this one writes IDENTICAL content.
  test('managed: an IDENTICAL-content write with a stale skillId → 409 (no-op path is fenced too)', async () => {
    const staleId = (await getSkill(db, 'foo'))!.id
    await deleteSkill(db, fsOpts, staleId, T6_ACTOR)
    await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd0',
      bodyMd: 'body0',
      frontmatterExtra: {},
    })
    const recreated = (await getSkill(db, 'foo'))!
    // Same description + body ⇒ the write is a NO-OP (hash matches the recreated
    // skill's SKILL.md). Only the stale skillId differs — must still 409.
    await expect(
      writeSkillContent(db, fsOpts, recreated.id, { description: 'd0', bodyMd: 'body0' }, 'u', {
        skillId: staleId,
        contentVersion: recreated.contentVersion,
        metaRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})
