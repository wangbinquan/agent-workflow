// RFC-170 §2/T4 — combined save gated by the composite precondition token.
// A save with the token from the detail read succeeds and returns a fresh token;
// a stale token (another write advanced the version) → 409 with NO write applied;
// a malformed token → 400. This is the OCC that stops a paused editor from
// silently overwriting a concurrent change / a delete-recreate ABA.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createManagedSkill,
  deleteSkill,
  getSkill,
  importExternalSkill,
  readSkillContent,
  saveSkillWithToken,
  updateSkill,
  writeSkillContent,
} from '../src/services/skill'
import { ConflictError, ValidationError } from '../src/util/errors'
import { decodeSkillToken } from '../src/services/skillToken'

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

  // RFC-170 T-BSAFE③ (Codex F1-review): the outer skillTokenMatches in
  // saveSkillWithToken is only a pre-check; the ATOMIC guard is commitSkillVersion's
  // in-tx composite fence, which saveSkillWithToken now feeds via writeSkillContent's
  // `expected`. These lock that a stale expected — the state a request would resume
  // with after a concurrent write slipped between its pre-check and its own tx — is
  // rejected, so the async gap can't LWW-clobber / ABA-redirect.
  test('managed: writeSkillContent with a stale expected.contentVersion → 409 (in-tx concurrent-save fence)', async () => {
    const foo = (await getSkill(db, 'foo'))!
    // Another writer advances the version out-of-band (no expected → unfenced).
    await writeSkillContent(db, fsOpts, 'foo', { bodyMd: 'other-writer' }, 'u2')
    // Request A resumes with its pre-drift expected (the old contentVersion).
    await expect(
      writeSkillContent(db, fsOpts, 'foo', { bodyMd: 'mine' }, 'u', {
        skillId: foo.id,
        contentVersion: foo.contentVersion,
        metaRevision: 0, // fresh skill; a body write does not bump meta_revision
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    // B's content stands; A's stale write did NOT apply.
    expect((await readSkillContent(db, fsOpts, 'foo')).bodyMd.trim()).toBe('other-writer')
  })

  test('managed: writeSkillContent with a stale skillId (delete→recreate ABA) → 409', async () => {
    const staleId = (await getSkill(db, 'foo'))!.id
    await deleteSkill(db, fsOpts, 'foo')
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
      writeSkillContent(db, fsOpts, 'foo', { bodyMd: 'mine' }, 'u', {
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
    await deleteSkill(db, fsOpts, 'foo')
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
      writeSkillContent(db, fsOpts, 'foo', { description: 'd0', bodyMd: 'body0' }, 'u', {
        skillId: staleId,
        contentVersion: recreated.contentVersion,
        metaRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})

// RFC-170 T-BSAFE③ (§2 "external metadata-only") — combined-save is the SINGLE
// save funnel for external skills too. Their body is authored on disk
// (externalPath is authoritative), so a bodyMd patch is rejected; only the DB
// description is writable (hand-external), and the same composite-token OCC holds.
describe('RFC-170 T-BSAFE③ — external combined-save (metadata-only)', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }
  let extDir: string

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-combined-save-ext-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    extDir = mkdtempSync(join(tmpdir(), 'aw-ext-src-'))
    writeFileSync(join(extDir, 'SKILL.md'), '---\nname: e\ndescription: x\n---\nexternal body')
    await importExternalSkill(db, { name: 'e', externalPath: extDir, description: 'x' })
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
    rmSync(extDir, { recursive: true, force: true })
  })

  test('hand-external: a description-only save succeeds and advances the token', async () => {
    const read = await readSkillContent(db, fsOpts, 'e')
    const saved = await saveSkillWithToken(
      db,
      fsOpts,
      'e',
      { description: 'edited' },
      read.token!,
      'u',
    )
    expect(saved.token).toBeDefined()
    expect(saved.token).not.toBe(read.token) // meta_revision bumped → token drifted
    expect((await getSkill(db, 'e'))!.description).toBe('edited')
  })

  test('hand-external: a bodyMd patch is rejected (409) — the body is authored on disk', async () => {
    const read = await readSkillContent(db, fsOpts, 'e')
    await expect(
      saveSkillWithToken(db, fsOpts, 'e', { bodyMd: 'hijack' }, read.token!, 'u'),
    ).rejects.toBeInstanceOf(ConflictError)
    // The on-disk body is untouched.
    expect((await readSkillContent(db, fsOpts, 'e')).bodyMd.trim()).toBe('external body')
  })

  test('hand-external: a STALE token → 409 and NO description write is applied (OCC honored)', async () => {
    const read = await readSkillContent(db, fsOpts, 'e')
    // Another writer advances meta_revision out-of-band.
    await updateSkill(db, 'e', { description: 'other-writer' })
    await expect(
      saveSkillWithToken(db, fsOpts, 'e', { description: 'mine' }, read.token!, 'u'),
    ).rejects.toBeInstanceOf(ConflictError)
    // The other writer's description stands; our stale write did NOT apply.
    expect((await getSkill(db, 'e'))!.description).toBe('other-writer')
  })

  // RFC-170 T-BSAFE③ (Codex F1-review): updateSkill resolves by name, so the
  // combined-save external branch binds it to the token's immutable skillId — a
  // same-name delete→recreate can't redirect a description write to a new skill.
  test('hand-external: updateSkill with a mismatched expectedSkillId → 409 (ABA guard)', async () => {
    await expect(
      updateSkill(db, 'e', { description: 'hijack' }, { expectedSkillId: 'NOT-THE-ID' }),
    ).rejects.toBeInstanceOf(ConflictError)
    // Description untouched.
    expect((await getSkill(db, 'e'))!.description).toBe('x')
  })

  // RFC-170 (Codex re-review F2-followup): a hand-external's description authority
  // is the DB (skills.description), NOT the disk SKILL.md frontmatter. The fenced
  // content read (which the frontend seeds its draft from) must return the DB value
  // — else a DB-only edit reads back the stale disk value and Save rolls it back.
  test('hand-external: readSkillContent returns the DB description, not the stale disk frontmatter', async () => {
    // Diverge DB from disk: the disk SKILL.md still says 'x'; a DB-only edit moves
    // skills.description to 'db-edited'.
    await updateSkill(db, 'e', { description: 'db-edited' })
    const content = await readSkillContent(db, fsOpts, 'e')
    expect(content.description).toBe('db-edited')
  })

  test('hand-external: a description save is not rolled back by a subsequent read (DB authority end-to-end)', async () => {
    const read1 = await readSkillContent(db, fsOpts, 'e')
    await saveSkillWithToken(db, fsOpts, 'e', { description: 'saved-desc' }, read1.token!, 'u')
    const read2 = await readSkillContent(db, fsOpts, 'e')
    expect(read2.description).toBe('saved-desc') // NOT rolled back to disk 'x'
    expect((await getSkill(db, 'e'))!.description).toBe('saved-desc')
  })

  // RFC-170 (Codex re-review-3): readSkillContent must read the hand-external
  // description and the token's metaRevision from ONE row snapshot — else a
  // concurrent save between two reads pairs an old description with a new token
  // (silent rollback). This locks that they advance TOGETHER (same generation).
  test('hand-external: readSkillContent couples description + token metaRevision to one generation', async () => {
    const before = await readSkillContent(db, fsOpts, 'e')
    const beforeTok = decodeSkillToken(before.token!)!
    await updateSkill(db, 'e', { description: 'gen2' }) // bumps description + metaRevision atomically
    const after = await readSkillContent(db, fsOpts, 'e')
    const afterTok = decodeSkillToken(after.token!)!
    expect(after.description).toBe('gen2')
    expect(afterTok.metaRevision).toBe(beforeTok.metaRevision + 1)
  })
})
