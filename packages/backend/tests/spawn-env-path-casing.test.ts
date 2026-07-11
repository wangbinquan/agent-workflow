// Regression: Windows GUI-launch PATH-casing spawn bug.
//
// Why this test exists: `Bun.spawn`'s child PATH resolution is CASE-SENSITIVE -
// libuv consults only a var literally named `PATH` (uppercase). Windows stores
// the registry PATH as `Path` (mixed case), and a GUI/explorer-launched daemon
// (double-clicked .exe / Start-menu shortcut) inherits it under that casing, so
// `{ ...process.env }` copies a `Path` key and the child is spawned with NO
// resolvable `PATH` -> `ENOENT: no such file or directory, uv_spawn '<binary>'`
// for every bare command that resolves to a `.cmd`/`.bat` shim (opencode, claude
// - both npm-installed). `git.exe` happens to survive (CreateProcess runs a
// real PE directly), which is why the failure looked opencode/claude-specific.
//
// A shell-launched daemon (bash, CI) gets `PATH` (uppercase) and is unaffected -
// which is why this only bites the distributed .exe, and why the boot
// `--version` probe (spawns with NO `env` option, inheriting the OS env
// directly / case-insensitively) still passes while the Settings "Test" button
// (passes `env: { ...process.env }`) fails with exactly that ENOENT.
//
// Fix: `normalizePathKey` (util/platform.ts) promotes a mixed-case `Path` to
// uppercase `PATH` on the spawn-env object. This test locks (1) the helper, (2)
// the end-to-end spawn behavior it exists to fix, and (3) that every env built
// from `...process.env` for a `Bun.spawn` child actually calls it.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { normalizePathKey } from '@/util/platform'

const isWindows = process.platform === 'win32'

describe('normalizePathKey', () => {
  test('promotes a mixed-case Path to uppercase PATH (the Windows GUI-launch case)', () => {
    const env: Record<string, string | undefined> = { Path: 'C:\\bin', OTHER: 'x' }
    normalizePathKey(env)
    expect(env.PATH).toBe('C:\\bin')
    expect(env.Path).toBeUndefined()
    expect(env.OTHER).toBe('x') // untouched
  })

  test('no-op when PATH is already uppercase (POSIX / bash-launched Windows)', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin', OTHER: 'x' }
    normalizePathKey(env)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.Path).toBeUndefined()
  })

  test('no-op when no path-keyed var is present at all', () => {
    const env: Record<string, string | undefined> = { OTHER: 'x' }
    normalizePathKey(env)
    expect(env.PATH).toBeUndefined()
    expect(env.OTHER).toBe('x')
  })

  test('does not promote a path key whose value is undefined', () => {
    const env: Record<string, string | undefined> = { Path: undefined, OTHER: 'x' }
    normalizePathKey(env)
    expect(env.PATH).toBeUndefined()
  })
})

describe('Windows GUI-launch PATH-casing spawn behavior', () => {
  // Reproduces the exact failure mode the distributed .exe hits: a bare command
  // resolved through a `.cmd`/`.bat` (Windows) / shebang (POSIX) shim cannot be
  // spawned when the child env carries PATH under Windows' canonical `Path`
  // casing - and CAN be spawned once normalizePathKey promotes it to `PATH`.
  test('bare-command spawn ENOENTs with a Path-cased env; normalizePathKey fixes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-path-case-'))
    const name = 'aw-path-case-stub'
    try {
      // A stub that just exits 0. Windows: a .cmd shim (the .cmd-only failure
      // mode is what bites opencode/claude). POSIX: a shebang script (any bare
      // command needs PATH, so the Path-casing failure reproduces here too).
      if (isWindows) {
        writeFileSync(join(dir, `${name}.cmd`), '@exit /b 0\r\n')
      } else {
        const p = join(dir, name)
        writeFileSync(p, '#!/bin/sh\nexit 0\n')
        chmodSync(p, 0o755)
      }

      const spawnWith = async (
        env: Record<string, string>,
      ): Promise<{ threw: boolean; code?: number; msg?: string }> => {
        try {
          const proc = Bun.spawn({
            cmd: [name],
            cwd: dir,
            stdout: 'pipe',
            stderr: 'pipe',
            env,
          })
          const code = await proc.exited
          return { threw: false, code }
        } catch (err) {
          return { threw: true, msg: (err as Error).message }
        }
      }

      // RED: env with ONLY a mixed-case `Path` (what `{ ...process.env }`
      // produces on a GUI-launched Windows daemon). libuv's case-sensitive PATH
      // lookup misses it; CreateProcess then finds the .cmd but can't run it
      // directly -> uv_spawn ENOENT. This is the user-reported error verbatim.
      const red = await spawnWith({ Path: dir })
      expect(red.threw).toBe(true)
      // Bun's missing-binary error differs by OS: Windows surfaces the raw
      // libuv "ENOENT: ... uv_spawn '<name>'"; POSIX normalizes to
      // "Executable not found in $PATH: ...". Match both so the lock is
      // portable (the throw itself is the bug signal; the exact wording isn't).
      expect(red.msg).toMatch(/ENOENT|uv_spawn|not found/i)

      // GREEN: the same env after normalizePathKey promotes `Path` -> `PATH`.
      const greenEnv: Record<string, string> = { Path: dir }
      normalizePathKey(greenEnv)
      expect(greenEnv.PATH).toBe(dir)
      const green = await spawnWith(greenEnv)
      expect(green.threw).toBe(false)
      expect(green.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('spawn env builders call normalizePathKey', () => {
  // Source-level guard: if a future refactor drops the normalizePathKey call
  // from any env built from `...process.env` for a Bun.spawn child, the
  // Windows GUI-launch bug silently returns. Mirrors the source-grep style of
  // opencode-spawn-pwd-env.test.ts / git-noninteractive-env.test.ts.
  const SITES = [
    'src/services/runtime/opencode/spawn.ts',
    'src/services/runtime/claudeCode/spawn.ts',
    'src/util/git.ts',
  ] as const
  for (const rel of SITES) {
    test(`${rel} calls normalizePathKey on its spawn env`, () => {
      const src = readFileSync(resolve(import.meta.dir, '..', rel), 'utf-8')
      expect(src).toContain('normalizePathKey')
    })
  }
})
