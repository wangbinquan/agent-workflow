// RFC-170 (Codex 4th-review [high]) — the version-write funnel re-checks the
// skill owner INSIDE the version-bump tx. The route authorizes the actor
// (requireResourceOwner) BEFORE the service runs; between that check and the final
// write there is an `await` gap in which the owner can be transferred, demoting the
// actor to a view-only grantee. Without an in-tx recheck the demoted ex-owner's
// resumed write still passes (id/contentVersion/metaRevision unchanged) and commits
// a post-revocation version. `commitSkillVersion` now honors an `expectedOwnerUserId`
// (the owner the caller authorized against) and 409s on owner drift.
//
// SCOPE: the funnel-side machinery + the COMBINED-SAVE primary path are wired (the
// POST /save route → saveSkillWithToken → writeSkillContent forward the authorized
// owner). The remaining writers (file / restore / ZIP / fusion) still pass no
// `expectedOwnerUserId` — tracked in IMPLEMENTATION §7. Below: the funnel guard is
// exercised directly, then the combined-save wiring at the service boundary.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills } from '../src/db/schema'
import {
  createManagedSkill,
  deleteSkillFile,
  readSkillContent,
  saveSkillWithToken,
  writeSkillFile,
} from '../src/services/skill'
import { commitSkillVersion, restoreSkillVersion } from '../src/services/skillVersion'
import { ConflictError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-170 (4th-review [high]) — version-write in-tx owner-drift fence', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-owner-fence-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    await createManagedSkill(
      db,
      fsOpts,
      { name: 'foo', description: 'd', bodyMd: 'b0', frontmatterExtra: {} },
      { ownerUserId: 'A' },
    )
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const editBody =
    (next: string) =>
    (staging: string): void =>
      writeFileSync(join(staging, 'SKILL.md'), `---\nname: foo\ndescription: d\n---\n${next}`)

  test('owner transferred since authorization (expectedOwnerUserId drift) → 409', async () => {
    // Owner transferred A → B out-of-band (a transfer landing in the save's await gap).
    await db.update(skills).set({ ownerUserId: 'B' }).where(eq(skills.name, 'foo'))
    expect(() =>
      commitSkillVersion(db, fsOpts, 'foo', editBody('b1'), {
        source: 'editor',
        authorUserId: 'A',
        expectedOwnerUserId: 'A', // the owner the (now demoted) actor was authorized against
      }),
    ).toThrow(ConflictError)
  })

  test('owner unchanged since authorization → commit succeeds', () => {
    const v = commitSkillVersion(db, fsOpts, 'foo', editBody('b1'), {
      source: 'editor',
      authorUserId: 'A',
      expectedOwnerUserId: 'A', // matches the current owner
    })
    expect(v.versionIndex).toBeGreaterThan(1)
  })

  test('an IDENTICAL-content no-op with a drifted owner is fenced too (not a silent no-op)', async () => {
    await db.update(skills).set({ ownerUserId: 'B' }).where(eq(skills.name, 'foo'))
    // Same body as v1 ⇒ the write is a no-op; the owner-drift guard must still 409
    // (the no-op short-circuit shares the same fence helper).
    expect(() =>
      commitSkillVersion(db, fsOpts, 'foo', editBody('b0'), {
        source: 'editor',
        authorUserId: 'A',
        expectedOwnerUserId: 'A',
      }),
    ).toThrow(ConflictError)
  })

  test('no expectedOwnerUserId → funnel stays unfenced (backward compatible)', async () => {
    await db.update(skills).set({ ownerUserId: 'B' }).where(eq(skills.name, 'foo'))
    // A legacy / system caller that does not opt into the owner fence still commits.
    const v = commitSkillVersion(db, fsOpts, 'foo', editBody('b2'), {
      source: 'editor',
      authorUserId: 'A',
    })
    expect(v.versionIndex).toBeGreaterThan(1)
  })
})

// The combined-save PRIMARY path is now wired: the POST /save route passes the
// owner it authorized against (existing.ownerUserId) into saveSkillWithToken →
// writeSkillContent → commitSkillVersion's owner fence. These lock that wiring at
// the service boundary (the route just forwards existing.ownerUserId).
describe('RFC-170 (4th-review [high]) — combined-save owner-fence wiring', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-owner-wire-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    await createManagedSkill(
      db,
      fsOpts,
      { name: 'foo', description: 'd', bodyMd: 'b0', frontmatterExtra: {} },
      { ownerUserId: 'A' },
    )
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('owner transferred after authorization → combined-save 409s (demoted ex-owner cannot write)', async () => {
    const read = await readSkillContent(db, fsOpts, 'foo')
    // The route authorized actor A against owner A; owner then transfers A → B in
    // the save's await window (token is unaffected — owner is orthogonal to it).
    await db.update(skills).set({ ownerUserId: 'B' }).where(eq(skills.name, 'foo'))
    await expect(
      saveSkillWithToken(db, fsOpts, 'foo', { bodyMd: 'x' }, read.token!, 'A', 'A'),
    ).rejects.toBeInstanceOf(ConflictError)
    // The stale write did NOT apply.
    expect((await readSkillContent(db, fsOpts, 'foo')).bodyMd.trim()).toBe('b0')
  })

  test('owner unchanged → combined-save succeeds under the owner fence', async () => {
    const read = await readSkillContent(db, fsOpts, 'foo')
    const saved = await saveSkillWithToken(
      db,
      fsOpts,
      'foo',
      { bodyMd: 'x' },
      read.token!,
      'A',
      'A',
    )
    expect(saved.bodyMd.trim()).toBe('x')
  })
})

// The other common managed writers now forward the authorized owner too: file
// PUT/DELETE (writeSkillFile/deleteSkillFile) and version restore
// (restoreSkillVersion). ZIP overwrite + fusion approve remain (IMPLEMENTATION §7).
describe('RFC-170 (4th-review [high]) — secondary-writer owner-fence wiring (file / restore)', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-owner-sec-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    await createManagedSkill(
      db,
      fsOpts,
      { name: 'foo', description: 'd', bodyMd: 'b0', frontmatterExtra: {} },
      { ownerUserId: 'A' },
    )
    // v2 (a support file) while the owner is still A — establishes a prior version.
    await writeSkillFile(db, fsOpts, 'foo', 'templates/a.txt', 'aaa', 'A', 'A')
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('writeSkillFile: owner transferred after authorization → 409', async () => {
    await db.update(skills).set({ ownerUserId: 'B' }).where(eq(skills.name, 'foo'))
    await expect(
      writeSkillFile(db, fsOpts, 'foo', 'templates/b.txt', 'bbb', 'A', 'A'),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('deleteSkillFile: owner transferred after authorization → 409', async () => {
    await db.update(skills).set({ ownerUserId: 'B' }).where(eq(skills.name, 'foo'))
    await expect(
      deleteSkillFile(db, fsOpts, 'foo', 'templates/a.txt', 'A', 'A'),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('restoreSkillVersion: owner transferred after authorization → 409', async () => {
    await db.update(skills).set({ ownerUserId: 'B' }).where(eq(skills.name, 'foo'))
    expect(() => restoreSkillVersion(db, fsOpts, 'foo', 1, 'A', undefined, 'A')).toThrow(
      ConflictError,
    )
  })

  test('owner unchanged → file write + restore succeed under the fence', async () => {
    await writeSkillFile(db, fsOpts, 'foo', 'templates/c.txt', 'ccc', 'A', 'A')
    const restored = restoreSkillVersion(db, fsOpts, 'foo', 1, 'A', undefined, 'A')
    expect(restored.version.versionIndex).toBeGreaterThan(1)
  })
})
