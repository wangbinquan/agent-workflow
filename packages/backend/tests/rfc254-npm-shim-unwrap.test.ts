// RFC-254 T32 — `npm` is a batch shim on Windows, and the two obvious ways to
// cope with that are both wrong.
//
// WHY THIS FILE EXISTS
// --------------------
// `node:child_process.spawn('npm', …)` refuses `npm.cmd` with
//   EFTYPE: inappropriate file type or format, uv_spawn
// so plugin installation and its availability probe both failed on every
// Windows host — not an edge case, the whole feature.
//
// The tempting fixes are `shell: true` or `Bun.spawn` (which accepts `.cmd` and
// hands it to cmd.exe). Both make the call succeed and both re-tokenize the
// arguments. Measured on Windows 11:
//   ['a&whoami'] → the argument becomes `a` and `whoami` EXECUTES
//   ['x|y']      → the pipe is interpreted
//   ['%PATH%']   → the variable expands and splits on spaces
// The argument at the install site is a user-supplied package spec
// (`github:owner/repo#ref`), so that is a command-injection channel.
//
// `resolveNpmCommand` therefore bypasses the shim: npm ships `npm-cli.js` next
// to it, and running that with the current runtime keeps the call shell-free,
// which is what preserves argv. These tests inject the platform so the Windows
// branch is exercised on every host — a POSIX-only CI would otherwise never
// execute the code this is all about.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { resolveNpmCommand } from '@/services/pluginInstaller'

const RUNTIME = '/opt/bun/bin/bun'

function deps(overrides: {
  platform: NodeJS.Platform
  which?: (cmd: string) => string | null
  present?: string[]
}) {
  const present = new Set(overrides.present ?? [])
  return {
    platform: overrides.platform,
    which: overrides.which ?? (() => null),
    exists: (path: string) => present.has(path),
    runtimePath: RUNTIME,
  }
}

describe('RFC-254 npm shim unwrapping', () => {
  test('POSIX is untouched — the command is the binary, as before', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(resolveNpmCommand('npm', deps({ platform }))).toEqual(['npm'])
      expect(resolveNpmCommand('/usr/local/bin/npm', deps({ platform }))).toEqual([
        '/usr/local/bin/npm',
      ])
    }
  })

  test('Windows unwraps npm.cmd to the JS entry beside it', () => {
    const shim = 'C:\\Program Files\\nodejs\\npm.cmd'
    const entry = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    const cmd = resolveNpmCommand(
      'npm',
      deps({ platform: 'win32', which: () => shim, present: [entry] }),
    )
    expect(cmd).toEqual([RUNTIME, entry])
    // The point of the whole exercise: nothing in the command is a batch file,
    // so no cmd.exe is involved and the caller's argv arrives intact.
    expect(cmd?.some((part) => /\.(?:cmd|bat)$/i.test(part))).toBe(false)
  })

  test('Windows accepts an already-real executable without unwrapping', () => {
    const exe = 'C:\\tools\\npm.exe'
    expect(resolveNpmCommand(exe, deps({ platform: 'win32' }))).toEqual([exe])
  })

  test('fails CLOSED when the shim cannot be unwrapped', () => {
    // Shim found, JS entry missing → null, so the caller reports npm as
    // unavailable. Returning the shim anyway would push the problem down to a
    // spawn that either dies with EFTYPE or, worse, gets "fixed" later with a
    // shell.
    expect(
      resolveNpmCommand(
        'npm',
        deps({ platform: 'win32', which: () => 'C:\\Program Files\\nodejs\\npm.cmd' }),
      ),
    ).toBeNull()
    // Nothing on PATH at all → also null, not a guess.
    expect(resolveNpmCommand('npm', deps({ platform: 'win32' }))).toBeNull()
  })

  test('the second layout (npm under lib/node_modules) is found too', () => {
    const shim = 'C:\\nodejs\\bin\\npm.cmd'
    // `join` normalizes the `..` away, so this is the path that is probed.
    const entry = 'C:\\nodejs\\lib\\node_modules\\npm\\bin\\npm-cli.js'
    expect(
      resolveNpmCommand('npm', deps({ platform: 'win32', which: () => shim, present: [entry] })),
    ).toEqual([RUNTIME, entry])
  })

  test('the production sites do not reach for a shell', () => {
    // A source-level backstop for the one property that matters and cannot be
    // asserted from outside: no `shell: true`, and no Bun.spawn (which would
    // accept the .cmd and hand it to cmd.exe) in this module.
    // `import.meta.dir` + `resolve`, NOT `new URL(...).pathname`: the latter
    // yields `/C:/aw/...` on Windows and `Bun.file` cannot open it. That exact
    // trap is already recorded from the real-machine acceptance — and this test
    // walked straight back into it, which is why the repo prefers the resolve
    // form everywhere.
    const source = Bun.file(resolve(import.meta.dir, '..', 'src', 'services', 'pluginInstaller.ts'))
    return source.text().then((raw) => {
      // Strip comments first. The module's own documentation NAMES both of the
      // things it must not do — that is the point of the documentation — and a
      // raw substring search cannot tell an explanation from a call. (Same trap
      // recorded in dev-gotchas: counting occurrences without removing prose.)
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code).not.toContain('shell: true')
      expect(code).not.toContain('Bun.spawn')
    })
  })
})
