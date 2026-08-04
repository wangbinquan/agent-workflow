// RFC-254 T18 — the two Windows facts the daemon's git layer has to know.
//
// 1. There is no `/dev/null` on Windows. The empty side of a
//    `git diff --no-index` has to be the reserved device name `NUL`, or the
//    command reports a nonexistent path instead of an empty file — and the
//    caller reads that as "no changes" rather than "everything is new".
// 2. Git for Windows refuses paths past the legacy 260-character MAX_PATH
//    unless `core.longpaths` is on, and this platform's own layout spends
//    ~120 characters before any repository content
//    (`%USERPROFILE%\.agent-workflow\worktrees\<repo-slug>\<task-id>\...`).
//
// Both are asserted with an injected platform so the win32 branch is exercised
// on the POSIX CI legs; a helper that reads `process.platform` internally would
// leave the Windows half untested until a Windows runner existed.

import { describe, expect, test } from 'bun:test'
import { hardenGitArgs, hardenedGitLeadingArgs } from '@/util/gitHardening'
import { nullDevice } from '@/util/platformExec'

const HOME = '/tmp/aw-rfc254-git-test-home'

describe('RFC-254 T18 — git on Windows', () => {
  test('the empty diff side is NUL on Windows and /dev/null elsewhere', () => {
    expect(nullDevice('win32')).toBe('NUL')
    expect(nullDevice('linux')).toBe('/dev/null')
    expect(nullDevice('darwin')).toBe('/dev/null')
  })

  test('git.ts no longer hardcodes the POSIX device in its diff argv', () => {
    // Source-level anchor: the two `git diff --no-index` call sites are inside
    // a long function that is awkward to drive directly, and the whole point of
    // T18 is that NO literal survives. A behavioural test that only covered one
    // of the two would have let the other rot.
    const source = Bun.file(
      new URL('../src/util/git.ts', import.meta.url).pathname,
    ).text() as unknown as Promise<string>
    return source.then((text) => {
      expect(text).not.toContain("'/dev/null'")
      expect(text).toContain('NULL_DEVICE_FOR_HOST')
    })
  })

  test('Windows gets core.longpaths; POSIX argv is byte-for-byte unchanged', () => {
    const win = hardenedGitLeadingArgs('status', HOME, 'win32')
    const posix = hardenedGitLeadingArgs('status', HOME, 'linux')

    expect(win).toContain('core.longpaths=true')
    expect(posix).not.toContain('core.longpaths=true')
    // The POSIX shape is a load-bearing contract locked by RFC-252's suite;
    // this asserts T18 added a branch rather than reordering the existing one.
    expect(posix).toEqual([
      '-c',
      `core.hooksPath=${HOME}/gitguard/empty-hooks`,
      '-c',
      'core.fsmonitor=false',
    ])
  })

  test('longpaths rides the same single injection point as the hardening flags', () => {
    // If a second injection point ever appears, the two copies drift — that is
    // exactly how RFC-242 lost three of three checks in a duplicated projection.
    const args = hardenGitArgs(['-C', '/repo', 'status'], HOME, 'win32')
    expect(args.slice(0, 2)).toEqual(['-c', `core.hooksPath=${HOME}/gitguard/empty-hooks`])
    expect(args).toContain('core.longpaths=true')
    expect(args).toContain('core.fsmonitor=false')
    // ...and the caller's own args still follow, unmodified and in order.
    expect(args.slice(-3)).toEqual(['-C', '/repo', 'status'])
  })

  test('the commit exemption survives the new platform branch', () => {
    // `commit` is the ONE subcommand RFC-252 exempts from core.hooksPath, so a
    // user's own pre-commit hook still runs. Adding a platform branch above it
    // must not re-add the override on either OS.
    const posixExempt = hardenedGitLeadingArgs('commit', HOME, 'linux')
    const winExempt = hardenedGitLeadingArgs('commit', HOME, 'win32')
    expect(posixExempt.join(' ')).not.toContain('core.hooksPath')
    expect(winExempt.join(' ')).not.toContain('core.hooksPath')
    expect(winExempt).toContain('core.longpaths=true')
  })
})
