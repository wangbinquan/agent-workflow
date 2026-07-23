// RFC-169 (T12, backend small-piece ①) — the SKILL.md write/delete guard.
//
// Before RFC-169 the file-tree write path had NO SKILL.md check (adding a file
// named `SKILL.md` truncated the main file) and the delete path only did a raw
// `=== 'SKILL.md'` compare, bypassable via `./SKILL.md`, a trailing separator
// (`SKILL.md/` → safeJoin resolves back to the root file), or a case variant on
// a case-insensitive filesystem. This locks both the lexical guard
// (isProtectedSkillMainFile, shared) and the backend realpath/dev+inode
// fallback that catches filesystem-equivalent names (APFS `ſKILL.md`).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isProtectedSkillMainFile } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createManagedSkill,
  deleteSkillFile,
  getSkill,
  skillRoot,
  writeSkillFile,
  type SkillFsOptions,
} from '../src/services/skill'
import { ConflictError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('isProtectedSkillMainFile (lexical, shared)', () => {
  test('rejects the root main file and its pure aliases', () => {
    for (const p of [
      'SKILL.md',
      './SKILL.md',
      'SKILL.md/',
      './SKILL.md//',
      'SKILL.md/.',
      'skill.md',
      'Skill.md',
      'SKILL.MD',
      './skill.md',
    ]) {
      expect(isProtectedSkillMainFile(p)).toBe(true)
    }
  })

  test('allows genuine support files and nested SKILL.md', () => {
    for (const p of [
      'skillset.md',
      'docs/SKILL.md',
      'templates/a.txt',
      'a/skill.md',
      'SKILLXMD',
      '../SKILL.md', // traversal — not the root main file (rejected by safeJoin elsewhere)
    ]) {
      expect(isProtectedSkillMainFile(p)).toBe(false)
    }
  })
})

describe('writeSkillFile / deleteSkillFile SKILL.md guard', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: SkillFsOptions
  let skillId: string

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-skill-guard-'))
    db = createInMemoryDb(MIGRATIONS)
    fsOpts = { appHome }
    const skill = await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: 'orig body',
      frontmatterExtra: {},
    })
    skillId = skill.id
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
  })

  const ALIASES = ['SKILL.md', './SKILL.md', 'SKILL.md/', 'skill.md', 'Skill.md', './SKILL.md//']

  test('write is refused for every SKILL.md alias', async () => {
    for (const alias of ALIASES) {
      await expect(writeSkillFile(db, fsOpts, skillId, alias, 'HACKED')).rejects.toBeInstanceOf(
        ConflictError,
      )
    }
  })

  test('delete is refused for every SKILL.md alias', async () => {
    for (const alias of ALIASES) {
      await expect(deleteSkillFile(db, fsOpts, skillId, alias)).rejects.toBeInstanceOf(
        ConflictError,
      )
    }
  })

  test('genuine support files write and delete normally', async () => {
    await writeSkillFile(db, fsOpts, skillId, 'skillset.md', 'not the main file')
    await writeSkillFile(db, fsOpts, skillId, 'docs/SKILL.md', 'nested is fine')
    await deleteSkillFile(db, fsOpts, skillId, 'skillset.md')
    await deleteSkillFile(db, fsOpts, skillId, 'docs/SKILL.md')
  })

  // Filesystem-identity fallback (APFS `ſKILL.md` U+017F). OS-dependent: on a
  // case/form-insensitive fs the alias resolves to SKILL.md's inode and must be
  // refused; on a case-sensitive fs it's a genuinely different file and allowed.
  test('fs-identity: `ſKILL.md` refused only where the fs folds it onto SKILL.md', async () => {
    const skill = await getSkill(db, 'foo')
    if (skill === null) throw new Error('skill missing')
    const root = skillRoot(skill, fsOpts)
    const mainIno = statSync(join(root, 'SKILL.md')).ino
    let foldsOntoMain = false
    try {
      foldsOntoMain = statSync(join(root, 'ſKILL.md')).ino === mainIno
    } catch {
      foldsOntoMain = false // ENOENT → case-sensitive fs
    }
    if (foldsOntoMain) {
      await expect(writeSkillFile(db, fsOpts, skillId, 'ſKILL.md', 'HACK')).rejects.toBeInstanceOf(
        ConflictError,
      )
    } else {
      // Different file — allowed. (Then it exists and can be deleted normally.)
      await writeSkillFile(db, fsOpts, skillId, 'ſKILL.md', 'a real other file')
      await deleteSkillFile(db, fsOpts, skillId, 'ſKILL.md')
    }
  })
})
