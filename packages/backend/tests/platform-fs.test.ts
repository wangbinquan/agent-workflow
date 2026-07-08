// RFC-windows PR-2 — filesystem + ACL oracle (T6).
//
// 为什么这条测试存在：PR-2 把 file:// 字符串拼接（`file://${path}`，Windows
// 上产 `file://C:\…` 畸形）改成 `toFileUrl`/`fromFileUrl`（node:url 跨平台）；
// external skill symlink 改 `linkSkillDir`（POSIX symlink / Windows junction，
// 无需开发者模式）；敏感文件 `chmod 600` 改 `secureFile`（Windows icacls，
// 因 chmod 在 Windows 是 no-op=安全回归）；长路径 `toLongPath`（`\\?\` 前缀）。
// 这条测试锁四件事的跨平台正确性 + doctor 的 ACL 决策。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { fromFileUrl, linkSkillDir, toFileUrl, toLongPath, isWindows } from '../src/util/platform'
import { secureDir, secureFile } from '../src/util/fs-perms'
import { evaluateWindowsAclDecision, checkLongPaths } from '../src/cli/doctor'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aw-pr2-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('RFC-windows PR-2 T7 — file:// round-trip (toFileUrl / fromFileUrl)', () => {
  test('POSIX absolute path round-trips', () => {
    if (isWindows()) return // `/x/y` is not a Node-absolute path on Windows
    const path = '/x/y/z/plugin.mjs'
    const url = toFileUrl(path)
    expect(url).toBe('file:///x/y/z/plugin.mjs')
    expect(fromFileUrl(url)).toBe(path)
  })

  test('Windows drive path round-trips (canonical file:///C:/...)', () => {
    if (!isWindows()) return // only meaningful on Windows
    const path = 'C:\\Users\\me\\plugin.mjs'
    const url = toFileUrl(path)
    expect(url).toBe('file:///C:/Users/me/plugin.mjs')
    expect(fromFileUrl(url)).toBe(path)
  })

  test('fromFileUrl passes through a non-file spec verbatim', () => {
    expect(fromFileUrl('/just/a/path')).toBe('/just/a/path')
    expect(fromFileUrl('relative/path')).toBe('relative/path')
  })

  test('toFileUrl on POSIX produces the same string the old concat did (golden parity)', () => {
    if (isWindows()) return
    // Pre-RFC: `file://${path}` for absolute POSIX path === pathToFileURL href.
    const path = '/abs/path/to/plugin'
    expect(toFileUrl(path)).toBe(`file://${path}`)
  })
})

describe('RFC-windows PR-2 T8 — linkSkillDir (symlink / junction)', () => {
  test('links an external skill dir into the per-run skills dir', () => {
    const src = join(tmp, 'source-skill')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), 'body')
    const dst = join(tmp, 'skills', 'my-skill')
    mkdirSync(join(tmp, 'skills'), { recursive: true })

    linkSkillDir(src, dst)

    // The linked dir is readable + the file inside is reachable.
    expect(readFileSync(join(dst, 'SKILL.md'), 'utf-8')).toBe('body')
  })
})

describe('RFC-windows PR-2 T9 — secureFile / secureDir', () => {
  test('secureFile restricts a file (no throw)', () => {
    const f = join(tmp, 'secret.key')
    writeFileSync(f, 'x'.repeat(32))
    expect(() => secureFile(f)).not.toThrow()
  })
  test('secureDir restricts a dir (no throw)', () => {
    const d = join(tmp, 'plugins', '01XYZ')
    mkdirSync(d, { recursive: true })
    expect(() => secureDir(d)).not.toThrow()
  })
})

describe('RFC-windows PR-2 T9 — doctor Windows ACL decision', () => {
  test('broad group present → not ok', () => {
    const out = 'token.txt BUILTIN\\Administrators:F\nBUILTIN\\Users:(RX)\n'
    const r = evaluateWindowsAclDecision(out, 'token file')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('BUILTIN\\Users')
  })
  test('no broad group → ok', () => {
    const out = 'token.txt DESKTOP\\me:F\n'
    const r = evaluateWindowsAclDecision(out, 'token file')
    expect(r.ok).toBe(true)
  })
  test('Everyone is flagged', () => {
    const r = evaluateWindowsAclDecision('Everyone:(R)', 'token file')
    expect(r.ok).toBe(false)
  })
  test('Authenticated Users is flagged', () => {
    const r = evaluateWindowsAclDecision('Authenticated Users:(R)', 'token file')
    expect(r.ok).toBe(false)
  })
})

describe('RFC-windows PR-2 T10 — toLongPath + checkLongPaths', () => {
  test('toLongPath is a no-op on POSIX', () => {
    if (isWindows()) return
    expect(toLongPath('/x/y')).toBe('/x/y')
  })
  test('toLongPath prefixes a Windows drive path with \\\\?\\', () => {
    if (!isWindows()) return
    expect(toLongPath('C:\\x\\y')).toBe('\\\\?\\C:\\x\\y')
    // already-prefixed path is not double-prefixed
    expect(toLongPath('\\\\?\\C:\\x\\y')).toBe('\\\\?\\C:\\x\\y')
  })
  test('checkLongPaths is always ok (informational)', () => {
    const r = checkLongPaths()
    expect(r.ok).toBe(true)
  })
})
