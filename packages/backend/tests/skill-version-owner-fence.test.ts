// RFC-170 (Codex 4th-review [high]) — the version-write funnel re-checks the
// skill owner INSIDE the version-bump tx. The route authorizes the actor
// (requireResourceOwner) BEFORE the service runs; between that check and the final
// write there is an `await` gap in which the owner can be transferred, demoting the
// actor to a view-only grantee. Without an in-tx recheck the demoted ex-owner's
// resumed write still passes (id/contentVersion/metaRevision unchanged) and commits
// a post-revocation version. `commitSkillVersion` now honors an `expectedOwnerUserId`
// (the owner the caller authorized against) and 409s on owner drift.
//
// SCOPE: this locks the FUNNEL-side machinery + its owner-drift semantics. Wiring
// the six writers (combined-save / file / restore / ZIP / fusion / create) to pass
// `expectedOwnerUserId` is tracked in IMPLEMENTATION §7 (deferred while a parallel
// RFC-178 refactor holds skill.ts). commitSkillVersion is exercised directly here.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills } from '../src/db/schema'
import { createManagedSkill } from '../src/services/skill'
import { commitSkillVersion } from '../src/services/skillVersion'
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
