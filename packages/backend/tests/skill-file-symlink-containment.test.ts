// RFC-170 G3-1 (security regression) — readSkillFile must not follow a symlink
// out of the skill root. A skill directory (external ones especially, but the
// read path is shared) can contain a symlink pointing at a host file; a SHARED
// skill would otherwise leak e.g. ~/.ssh/id_rsa to any authorized/public reader.
// Design-gate round 3 caught this while adversarially reviewing RFC-170.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createManagedSkill,
  deleteSkillFile,
  getSkill,
  readSkillContent,
  readSkillFile,
  skillRoot,
  writeSkillContent,
  writeSkillFile,
  type SkillFsOptions,
} from '../src/services/skill'
import { getSkillVersionContent } from '../src/services/skillVersion'
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

  // RFC-170 G1-1: readSkillFile/listSkillFiles read the AUTHORITATIVE snapshot
  // (versions/v1/files) for managed skills, so plant test fixtures THERE.
  function snapshotRoot(): string {
    return join(appHome, 'skills', 'foo', 'versions', 'v1', 'files')
  }

  test('a symlink escaping the skill root is refused (no host-file leak)', async () => {
    // Plant an escaping symlink in the snapshot the read path actually reads.
    symlinkSync(join(outsideDir, 'host-secret.txt'), join(snapshotRoot(), 'escape'))
    await expect(readSkillFile(db, fsOpts, 'foo', 'escape')).rejects.toBeInstanceOf(ValidationError)
  })

  test('a genuine in-root file reads normally', async () => {
    await writeSkillFile(db, fsOpts, 'foo', 'docs/note.txt', 'hello inside')
    expect(await readSkillFile(db, fsOpts, 'foo', 'docs/note.txt')).toBe('hello inside')
    expect(await readSkillFile(db, fsOpts, 'foo', 'SKILL.md')).toContain('body')
  })

  test('a symlink that stays INSIDE the root still resolves and reads', async () => {
    const root = snapshotRoot()
    writeFileSync(join(root, 'real.txt'), 'inside target', 'utf-8')
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'))
    expect(await readSkillFile(db, fsOpts, 'foo', 'link.txt')).toBe('inside target')
  })

  test('readSkillContent refuses a SKILL.md symlinked to a host file (G3-1 content GET)', async () => {
    // RFC-170 G1-1: readSkillContent reads the AUTHORITATIVE version snapshot
    // (versions/v1/files), so plant the escaping symlink THERE — the containment
    // (realpathInside on the read root) must still refuse it (defense-in-depth
    // against a tampered/corrupted snapshot; snapshots are normally symlink-free).
    const v1SkillMd = join(appHome, 'skills', 'foo', 'versions', 'v1', 'files', 'SKILL.md')
    rmSync(v1SkillMd)
    symlinkSync(join(outsideDir, 'host-secret.txt'), v1SkillMd)
    await expect(readSkillContent(db, fsOpts, 'foo')).rejects.toBeInstanceOf(ValidationError)
  })

  test('readSkillContent IGNORES a tampered LIVE symlink (reads the clean snapshot, G1-1)', async () => {
    const skill = await getSkill(db, 'foo')
    if (skill === null) throw new Error('skill missing')
    const root = skillRoot(skill, fsOpts) // LIVE files dir
    // Tamper live SKILL.md with a host-file symlink — readSkillContent must NOT
    // read it (it reads the snapshot), so no leak AND no error: the live tamper
    // is simply not the read source anymore.
    rmSync(join(root, 'SKILL.md'))
    symlinkSync(join(outsideDir, 'host-secret.txt'), join(root, 'SKILL.md'))
    const content = await readSkillContent(db, fsOpts, 'foo')
    expect(content.bodyMd).toContain('body') // clean snapshot body
    expect(content.bodyMd).not.toContain('TOP SECRET') // no host-file leak
  })

  test('getSkillVersionContent refuses a historical SKILL.md symlinked out (G3-1 history GET)', () => {
    // createManagedSkill committed v1; its files dir is versions/v1/files.
    const v1SkillMd = join(appHome, 'skills', 'foo', 'versions', 'v1', 'files', 'SKILL.md')
    rmSync(v1SkillMd)
    symlinkSync(join(outsideDir, 'host-secret.txt'), v1SkillMd)
    expect(() => getSkillVersionContent(db, fsOpts, 'foo', 1)).toThrow(ValidationError)
  })

  // ---------------------------------------------------------------------------
  // RFC-170 G3-1 WRITE/DELETE parity — design/test-guard-audit-2026-07-21 gap
  // B5-security-8. The read path resolved symlinks + verified containment; the
  // write and delete callbacks only did a LEXICAL safeJoin, and writeFileSync /
  // unlinkSync / rmSync FOLLOW symlinks — so a symlink planted in the live
  // files/ tree (which commitSkillVersion cpSync's into staging as-is) let a
  // write escape to an arbitrary host path, as the daemon uid (often root).
  //
  // These plant fixtures in the LIVE files/ dir (skills/foo/files) because that
  // is what the write/delete path copies into staging — NOT the version snapshot
  // the read tests above use.
  // ---------------------------------------------------------------------------
  function liveRoot(): string {
    return join(appHome, 'skills', 'foo', 'files')
  }

  test('writeSkillFile refuses to follow a leaf symlink that escapes the root', async () => {
    const secret = join(outsideDir, 'host-secret.txt')
    writeFileSync(secret, 'ORIGINAL HOST CONTENT', 'utf-8')
    // A symlink in the live tree pointing at a host file.
    symlinkSync(secret, join(liveRoot(), 'escape'))

    await expect(writeSkillFile(db, fsOpts, 'foo', 'escape', 'PWNED')).rejects.toBeInstanceOf(
      ValidationError,
    )
    // The host file must be untouched — the write did not follow the link.
    expect(readFileSync(secret, 'utf-8')).toBe('ORIGINAL HOST CONTENT')
  })

  test('writeSkillFile refuses when a parent directory component is an escaping symlink', async () => {
    // `sub` is a symlink to a host directory; writing sub/child would follow it.
    symlinkSync(outsideDir, join(liveRoot(), 'sub'))
    await expect(
      writeSkillFile(db, fsOpts, 'foo', 'sub/child.txt', 'PWNED'),
    ).rejects.toBeInstanceOf(ValidationError)
    // No file was created in the host directory through the link.
    expect(existsSync(join(outsideDir, 'child.txt'))).toBe(false)
  })

  test('deleteSkillFile refuses an escaping symlink (fail-closed) and never touches its target', async () => {
    const secret = join(outsideDir, 'host-secret.txt')
    writeFileSync(secret, 'ORIGINAL HOST CONTENT', 'utf-8')
    symlinkSync(secret, join(liveRoot(), 'escape'))

    // Fail closed: rather than risk rmSync/statSync following the link, the
    // delete is refused outright. The host file is untouched either way — the
    // whole point. (Such a link cannot legitimately exist in a managed skill;
    // zip import does not create symlinks.)
    await expect(deleteSkillFile(db, fsOpts, 'foo', 'escape')).rejects.toBeInstanceOf(
      ValidationError,
    )
    expect(readFileSync(secret, 'utf-8')).toBe('ORIGINAL HOST CONTENT')
  })

  // RFC-170 impl-gate (Codex 2026-07-22): the SKILL.md writer inside
  // commitSkillVersion (writeSkillContent's callback) used a raw writeFileSync
  // with no containment — distinct from the writeSkillFile path guarded above.
  // commitSkillVersion cpSync's the live files/ (symlinks and all) into staging,
  // so a live SKILL.md symlinked to a host file let the write escape.
  test('writeSkillContent refuses when the LIVE SKILL.md is an escaping symlink', async () => {
    const secret = join(outsideDir, 'host-secret.txt')
    writeFileSync(secret, 'ORIGINAL HOST CONTENT', 'utf-8')
    const liveSkillMd = join(liveRoot(), 'SKILL.md')
    rmSync(liveSkillMd)
    symlinkSync(secret, liveSkillMd)
    await expect(
      writeSkillContent(db, fsOpts, 'foo', { bodyMd: 'PWNED body', description: '' }),
    ).rejects.toBeInstanceOf(ValidationError)
    // The host file must be untouched — the SKILL.md write did not follow the link.
    expect(readFileSync(secret, 'utf-8')).toBe('ORIGINAL HOST CONTENT')
  })

  test('positive control — a write/delete of an in-root path still works', async () => {
    await writeSkillFile(db, fsOpts, 'foo', 'docs/keep.txt', 'kept')
    expect(await readSkillFile(db, fsOpts, 'foo', 'docs/keep.txt')).toBe('kept')
    await deleteSkillFile(db, fsOpts, 'foo', 'docs/keep.txt')
    await expect(readSkillFile(db, fsOpts, 'foo', 'docs/keep.txt')).rejects.toBeInstanceOf(Error)
  })
})
