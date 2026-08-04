// 2026-08-04 incident: Bun's posix_spawn ENOENT names argv[0] even when the
// actually-missing path is the WORKING DIRECTORY (measured:
// `Bun.spawn({cmd:['/bin/echo'], cwd:'/nonexistent'})` →
// "ENOENT: no such file or directory, posix_spawn '/bin/echo'"). On a sandboxed
// runner spawn argv[0] is the sandbox wrapper, so a vanished task worktree read
// as `posix_spawn '/usr/bin/bwrap'` and sent the operator chasing a healthy
// bubblewrap install. explainSpawnEnoent probes both paths and blames the
// right one; outputTail packs a stream into a single-line capped excerpt for
// the smoke's evidence detail.

import { describe, expect, test } from 'bun:test'
import { explainSpawnEnoent, outputTail } from '../src/util/spawnDiagnostics'

const ENOENT_BWRAP = "ENOENT: no such file or directory, posix_spawn '/usr/bin/bwrap'"

describe('explainSpawnEnoent', () => {
  test('missing cwd with an existing executable blames the cwd, not argv[0]', () => {
    const out = explainSpawnEnoent(
      ENOENT_BWRAP,
      { argv0: '/usr/bin/bwrap', cwd: '/root/.agent-workflow/iso/T/R' },
      { exists: (p) => p === '/usr/bin/bwrap' },
    )
    expect(out).toContain("working directory does not exist: '/root/.agent-workflow/iso/T/R'")
    expect(out).toContain("executable '/usr/bin/bwrap' exists")
    expect(out.startsWith(ENOENT_BWRAP)).toBe(true)
  })

  test('missing absolute executable is named as the cause', () => {
    const out = explainSpawnEnoent(
      ENOENT_BWRAP,
      { argv0: '/usr/bin/bwrap', cwd: '/tmp' },
      { exists: (p) => p === '/tmp' },
    )
    expect(out).toContain("executable not found: '/usr/bin/bwrap'")
    expect(out).not.toContain('working directory does not exist')
  })

  test('bare argv0 resolves through which()', () => {
    const out = explainSpawnEnoent(
      'ENOENT: no such file or directory, posix_spawn bwrap',
      { argv0: 'bwrap', cwd: '/tmp' },
      { exists: () => true, which: () => null },
    )
    expect(out).toContain("executable not found: 'bwrap'")
  })

  test('both missing reports both findings', () => {
    const out = explainSpawnEnoent(
      ENOENT_BWRAP,
      { argv0: '/usr/bin/bwrap', cwd: '/gone' },
      { exists: () => false },
    )
    expect(out).toContain("working directory does not exist: '/gone'")
    expect(out).toContain("executable not found: '/usr/bin/bwrap'")
  })

  test('non-ENOENT messages pass through untouched', () => {
    const raw = 'Executable not found in $PATH: "bwrap"'
    expect(explainSpawnEnoent(raw, { argv0: 'bwrap', cwd: '/tmp' }, { exists: () => false })).toBe(
      raw,
    )
  })

  test('ENOENT with neither path provably missing passes through untouched', () => {
    expect(
      explainSpawnEnoent(
        ENOENT_BWRAP,
        { argv0: '/usr/bin/bwrap', cwd: '/tmp' },
        { exists: () => true },
      ),
    ).toBe(ENOENT_BWRAP)
  })
})

describe('outputTail', () => {
  test('collapses newlines/whitespace into one line and trims', () => {
    expect(outputTail('a\n\n  b\t c \n')).toBe('a b c')
  })

  test('strips ANSI escape sequences', () => {
    const esc = String.fromCharCode(27)
    expect(outputTail(`${esc}[31mred error${esc}[0m done`)).toBe('red error done')
  })

  test('keeps the TAIL (errors come last) with a leading ellipsis when over cap', () => {
    const text = `${'x'.repeat(500)} FINAL_ERROR`
    const tail = outputTail(text, 40)
    expect(tail.startsWith('…')).toBe(true)
    expect(tail).toContain('FINAL_ERROR')
    expect(tail.length).toBe(41) // ellipsis + cap
  })

  test('short input returns unchanged', () => {
    expect(outputTail('short', 300)).toBe('short')
  })
})
