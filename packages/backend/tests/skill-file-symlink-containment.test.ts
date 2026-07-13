// RFC-170 G3-1 (security regression) — readSkillFile must not follow a symlink
// out of the skill root. A skill directory (external ones especially, but the
// read path is shared) can contain a symlink pointing at a host file; a SHARED
// skill would otherwise leak e.g. ~/.ssh/id_rsa to any authorized/public reader.
// Design-gate round 3 caught this while adversarially reviewing RFC-170.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createManagedSkill,
  getSkill,
  readSkillFile,
  skillRoot,
  writeSkillFile,
  type SkillFsOptions,
} from '../src/services/skill'
import { ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('readSkillFile symlink containment', () => {
  let db: DbClient
  let appHome: string
  let outsideDir: string
  let fsOpts: SkillFsOptions

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-skill-symlink-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'aw-outside-'))
    writeFileSync(join(outsideDir, 'host-secret.txt'), 'TOP SECRET HOST FILE', 'utf-8')
    db = createInMemoryDb(MIGRATIONS)
    fsOpts = { appHome }
    await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: 'body',
      frontmatterExtra: {},
    })
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  test('a symlink escaping the skill root is refused (no host-file leak)', async () => {
    const skill = await getSkill(db, 'foo')
    if (skill === null) throw new Error('skill missing')
    const root = skillRoot(skill, fsOpts)
    // Plant an escaping symlink directly in the skill files dir.
    symlinkSync(join(outsideDir, 'host-secret.txt'), join(root, 'escape'))
    await expect(readSkillFile(db, fsOpts, 'foo', 'escape')).rejects.toBeInstanceOf(ValidationError)
  })

  test('a genuine in-root file reads normally', async () => {
    await writeSkillFile(db, fsOpts, 'foo', 'docs/note.txt', 'hello inside')
    expect(await readSkillFile(db, fsOpts, 'foo', 'docs/note.txt')).toBe('hello inside')
    expect(await readSkillFile(db, fsOpts, 'foo', 'SKILL.md')).toContain('body')
  })

  test('a symlink that stays INSIDE the root still resolves and reads', async () => {
    const skill = await getSkill(db, 'foo')
    if (skill === null) throw new Error('skill missing')
    const root = skillRoot(skill, fsOpts)
    writeFileSync(join(root, 'real.txt'), 'inside target', 'utf-8')
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'))
    expect(await readSkillFile(db, fsOpts, 'foo', 'link.txt')).toBe('inside target')
  })
})
