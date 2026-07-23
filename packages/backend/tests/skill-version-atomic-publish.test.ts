// RFC-170 §6a/§13 — commitSkillVersion publishes live files/ ATOMICALLY.
//
// The old publish was `rmSync(filesDir); cpSync(staging → filesDir)` — a window
// where files/ is missing/partial if the process dies mid-copy (the backstop was
// a boot-time reconcile). This test locks in the atomic swap (swapInStaged): the
// live tree is produced correctly AND no op-scoped/staging siblings are left
// behind, and pins the source so a future refactor can't silently revert to the
// non-atomic copy.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createManagedSkill } from '../src/services/skill'
import { commitSkillVersion } from '../src/services/skillVersion'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('commitSkillVersion atomic publish', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }
  let skillId: string

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-atomic-pub-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    const skill = await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: 'v1 body',
      frontmatterExtra: {},
    })
    skillId = skill.id
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('a version commit publishes the new live tree and leaves NO op-scoped/staging siblings', () => {
    const skillDir = join(appHome, 'skills', skillId)
    const filesDir = join(skillDir, 'files')

    commitSkillVersion(
      db,
      fsOpts,
      skillId,
      (staging) => {
        writeFileSync(join(staging, 'SKILL.md'), '---\nname: foo\n---\nv2 body', 'utf-8')
      },
      { source: 'editor', authorUserId: null },
    )

    // Live reflects the new content.
    expect(readFileSync(join(filesDir, 'SKILL.md'), 'utf-8')).toContain('v2 body')
    // The skill dir holds ONLY the canonical files/ + versions/ — every op-scoped
    // staged/backup sibling (files.op-*.staged/.backup) and the legacy .staging-*
    // dir have been cleaned up by swapInStaged + cleanupOpDirs.
    const entries = readdirSync(skillDir)
    expect(entries.sort()).toEqual(['files', 'versions'])
    expect(entries.some((e) => e.includes('.op-') || e.startsWith('.staging-'))).toBe(false)
  })

  test('source uses swapInStaged, not the old non-atomic cpSync(staging → filesDir)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'skillVersion.ts'),
      'utf-8',
    )
    expect(src).toContain('swapInStaged(filesDir, publishId)')
    // The old non-atomic publish pattern must not come back.
    expect(src).not.toMatch(/cpSync\(\s*staging\s*,\s*filesDir/)
  })
})
