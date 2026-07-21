// RFC-170 G3-1 / design/test-guard-audit-2026-07-21 gap B5-security-8 — unit
// coverage for the write/delete containment primitive.
//
// The skill write/delete paths were caught following symlinks out of the skill
// root (writeFileSync / unlinkSync / rmSync all dereference), while the read
// path already resolved + verified containment. `realpathWriteInside` closes
// that asymmetry. The skill-file-symlink-containment integration test exercises
// it through the real service; this file locks the primitive directly so a
// regression is pinpointed at the helper, not diagnosed through commitSkillVersion.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertWriteAncestorInside, realpathWriteInside } from '../src/util/safePath'
import { ValidationError } from '../src/util/errors'

describe('realpathWriteInside', () => {
  let root: string
  let outside: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aw-safepath-root-'))
    outside = mkdtempSync(join(tmpdir(), 'aw-safepath-outside-'))
    writeFileSync(join(outside, 'secret'), 'host', 'utf-8')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  test('allows a brand-new file directly under root', () => {
    expect(realpathWriteInside(root, join(root, 'new.txt'))).toBe(join(root, 'new.txt'))
  })

  test('allows a new file in a new subdirectory that does not exist yet', () => {
    // The deepest existing ancestor is `root` itself — contained.
    expect(() => realpathWriteInside(root, join(root, 'a', 'b', 'c.txt'))).not.toThrow()
  })

  test('refuses a leaf that is a symlink escaping root', () => {
    symlinkSync(join(outside, 'secret'), join(root, 'link'))
    expect(() => realpathWriteInside(root, join(root, 'link'))).toThrow(ValidationError)
  })

  test('refuses when a parent directory component is a symlink escaping root', () => {
    symlinkSync(outside, join(root, 'sub'))
    expect(() => realpathWriteInside(root, join(root, 'sub', 'child.txt'))).toThrow(ValidationError)
  })

  test('allows a leaf symlink that stays inside root', () => {
    writeFileSync(join(root, 'real.txt'), 'x', 'utf-8')
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'))
    expect(() => realpathWriteInside(root, join(root, 'link.txt'))).not.toThrow()
  })

  test('assertWriteAncestorInside refuses before any directory is created through a link', () => {
    symlinkSync(outside, join(root, 'sub'))
    expect(() => assertWriteAncestorInside(root, join(root, 'sub', 'deep', 'x.txt'))).toThrow(
      ValidationError,
    )
    // The refusal happened without materialising anything in the host dir.
    mkdirSync(join(root, 'legit'), { recursive: true })
    expect(() => assertWriteAncestorInside(root, join(root, 'legit', 'y.txt'))).not.toThrow()
  })
})
