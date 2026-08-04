// RFC-254 T2 (D12) — environment-variable name comparison must fold case on
// Windows, and every allow/deny/reserved table must go through that one rule.
//
// This is a SECURITY property, not a portability nicety, and it fails in both
// directions depending on the table:
//   - an allow-list keyed on `PATH` drops the real `Path` the OS handed us;
//   - a deny-list keyed on `NODE_OPTIONS` admits `Node_Options`, which loads
//     arbitrary code before the guarded program's first line.
//
// AC-2 demands the oracle be what a CHILD PROCESS ACTUALLY SEES rather than the
// object we assembled, so the last case here spawns one and reads its environ.

import { describe, expect, test } from 'bun:test'
import {
  canonicalEnvKey,
  configDirEnvProblem,
  envNameMatches,
  envRecordDelete,
  envRecordGet,
} from '@agent-workflow/shared'

describe('RFC-254 T2 — env name folding', () => {
  test('folding is a no-op on POSIX and upper-cases on Windows', () => {
    expect(canonicalEnvKey('Path', 'linux')).toBe('Path')
    expect(canonicalEnvKey('Path', 'darwin')).toBe('Path')
    expect(canonicalEnvKey('Path', 'win32')).toBe('PATH')
  })

  test('membership follows the platform rule', () => {
    const names = ['OPENCODE_PERMISSION', 'IS_SANDBOX']
    expect(envNameMatches(names, 'OPENCODE_PERMISSION', 'linux')).toBe(true)
    expect(envNameMatches(names, 'OpenCode_Permission', 'linux')).toBe(false)
    // ...and on Windows the mixed-case spelling IS the same variable.
    expect(envNameMatches(names, 'OpenCode_Permission', 'win32')).toBe(true)
    expect(envNameMatches(names, 'is_sandbox', 'win32')).toBe(true)
  })

  describe('envRecordDelete', () => {
    test('POSIX removes only the byte-exact name', () => {
      const out = envRecordDelete({ FOO: '1', Foo: '2' }, ['FOO'], 'linux')
      expect(out).toEqual({ Foo: '2' })
    })

    test('Windows removes every case variant — the scrub cannot be dodged', () => {
      // The defect this replaces: `delete env.OPENCODE_PERMISSION` leaves an
      // inherited `OpenCode_Permission` in place, and OpenCode merges
      // OPENCODE_PERMISSION AFTER the controlled config, so that survivor
      // silently overrides the platform's permission rules.
      const out = envRecordDelete(
        { OPENCODE_PERMISSION: 'a', OpenCode_Permission: 'b', KEEP: 'c' },
        ['OPENCODE_PERMISSION'],
        'win32',
      )
      expect(out).toEqual({ KEEP: 'c' })
    })

    test('it returns a new record rather than mutating the input', () => {
      const input = { FOO: '1' }
      const out = envRecordDelete(input, ['FOO'], 'linux')
      expect(input).toEqual({ FOO: '1' })
      expect(out).toEqual({})
    })
  })

  test('lookup finds a differently-cased name only on Windows', () => {
    const env = { SystemRoot: 'C:\\Windows' }
    expect(envRecordGet(env, 'SYSTEMROOT', 'win32')).toBe('C:\\Windows')
    expect(envRecordGet(env, 'SYSTEMROOT', 'linux')).toBeUndefined()
    expect(envRecordGet(env, 'SystemRoot', 'linux')).toBe('C:\\Windows')
  })

  test('reserved config-dir names collide case-insensitively on EVERY platform', () => {
    // Config is data that travels between machines: a name accepted on a Linux
    // daemon and later run on a Windows one would become a silent collision
    // with the variable it shadows, so validation is deliberately conservative
    // regardless of the validating host.
    expect(configDirEnvProblem('PWD')).toBe('reserved')
    expect(configDirEnvProblem('Pwd')).toBe('reserved')
    expect(configDirEnvProblem('pwd')).toBe('reserved')
    expect(configDirEnvProblem('MY_OWN_DIR')).toBeNull()
    expect(configDirEnvProblem('1BAD')).toBe('invalid-name')
  })

  test('a real child sees exactly the surviving variables (AC-2 oracle)', async () => {
    // Assembling a record and asserting on the record proves nothing about what
    // the OS hands the child. Spawn one and read its environ back.
    const assembled = envRecordDelete(
      { AW_T2_KEEP: 'kept', AW_T2_DROP: 'dropped' },
      ['AW_T2_DROP'],
      process.platform,
    ) as Record<string, string>
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({keep:process.env.AW_T2_KEEP ?? null, drop:process.env.AW_T2_DROP ?? null}))',
      ],
      env: { ...assembled, PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ keep: 'kept', drop: null })
  }, 30_000)
})
