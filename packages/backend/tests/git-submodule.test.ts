import { rimrafDir } from './helpers/cleanup'
// RFC-034 T4 — gitSubmodule.syncSubmodules behavior across mode × .gitmodules
// presence × git outcome. Uses an in-memory runGit stub so we can assert
// exact argv ordering and verify stderr redaction without spinning real git.

import { describe, expect, test, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { syncSubmodules, detectSubmodules } from '../src/services/gitSubmodule'

let tmp: string

function makeRepo(withGitmodules: boolean): string {
  tmp = join(tmpdir(), `aw-gsubm-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmp, { recursive: true })
  if (withGitmodules) {
    writeFileSync(
      join(tmp, '.gitmodules'),
      '[submodule "sub"]\n  path = sub\n  url = https://token:secret@host/sub.git\n',
    )
  }
  return tmp
}

afterEach(() => {
  if (tmp) rimrafDir(tmp)
})

describe('detectSubmodules', () => {
  test('returns true when .gitmodules exists', () => {
    const r = makeRepo(true)
    expect(detectSubmodules(r)).toBe(true)
  })
  test('returns false when .gitmodules missing', () => {
    const r = makeRepo(false)
    expect(detectSubmodules(r)).toBe(false)
  })
})

describe('syncSubmodules mode=never', () => {
  test('short-circuits — no git invoked, hasGitmodules=false even when present', async () => {
    const r = makeRepo(true)
    const calls: string[][] = []
    const result = await syncSubmodules(r, {
      mode: 'never',
      jobs: 4,
      runGitImpl: async (_cwd, args) => {
        calls.push(args)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    expect(result).toEqual({ ok: true, error: null, hasGitmodules: false })
    expect(calls.length).toBe(0)
  })
})

describe('syncSubmodules mode=auto', () => {
  test('skips when .gitmodules absent — no git invoked', async () => {
    const r = makeRepo(false)
    const calls: string[][] = []
    const result = await syncSubmodules(r, {
      mode: 'auto',
      jobs: 4,
      runGitImpl: async (_cwd, args) => {
        calls.push(args)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    expect(result).toEqual({ ok: true, error: null, hasGitmodules: false })
    expect(calls.length).toBe(0)
  })

  test('runs sync + update when .gitmodules present (jobs>1 → --jobs N)', async () => {
    const r = makeRepo(true)
    const calls: string[][] = []
    const result = await syncSubmodules(r, {
      mode: 'auto',
      jobs: 8,
      runGitImpl: async (_cwd, args) => {
        calls.push(args)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    expect(result.ok).toBe(true)
    expect(result.hasGitmodules).toBe(true)
    expect(calls).toEqual([
      ['submodule', 'sync', '--recursive'],
      ['submodule', 'update', '--init', '--recursive', '--jobs', '8'],
    ])
  })

  test('jobs=1 → no --jobs flag emitted', async () => {
    const r = makeRepo(true)
    const calls: string[][] = []
    await syncSubmodules(r, {
      mode: 'auto',
      jobs: 1,
      runGitImpl: async (_cwd, args) => {
        calls.push(args)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    expect(calls[1]).toEqual(['submodule', 'update', '--init', '--recursive'])
  })
})

describe('syncSubmodules mode=always', () => {
  test('runs even without .gitmodules; hasGitmodules=false but ok=true', async () => {
    const r = makeRepo(false)
    const calls: string[][] = []
    const result = await syncSubmodules(r, {
      mode: 'always',
      jobs: 2,
      runGitImpl: async (_cwd, args) => {
        calls.push(args)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    expect(result.ok).toBe(true)
    expect(result.hasGitmodules).toBe(false)
    expect(calls.length).toBe(2)
  })
})

describe('syncSubmodules failure paths', () => {
  test('sync failure surfaces redacted stderr', async () => {
    const r = makeRepo(true)
    const result = await syncSubmodules(r, {
      mode: 'auto',
      jobs: 4,
      runGitImpl: async (_cwd, args) => {
        if (args[1] === 'sync') {
          return {
            stdout: '',
            stderr: 'fatal: bad URL https://user:tok@host/x.git\n',
            exitCode: 1,
          }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('***')
    expect(result.error).not.toContain('user:tok')
  })

  test('update failure surfaces redacted stderr; sync still ran first', async () => {
    const r = makeRepo(true)
    const calls: string[][] = []
    const result = await syncSubmodules(r, {
      mode: 'auto',
      jobs: 4,
      runGitImpl: async (_cwd, args) => {
        calls.push(args)
        if (args[1] === 'update') {
          return {
            stdout: '',
            stderr: 'fatal: could not read Username for https://abc:xyz@host/y.git\n',
            exitCode: 128,
          }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    expect(calls[0]?.[1]).toBe('sync')
    expect(calls[1]?.[1]).toBe('update')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('***')
    expect(result.error).not.toContain('abc:xyz')
  })

  test('custom redactStderr is honored', async () => {
    const r = makeRepo(true)
    const result = await syncSubmodules(r, {
      mode: 'auto',
      jobs: 4,
      redactStderr: () => 'REDACTED',
      runGitImpl: async () => ({ stdout: '', stderr: 'sensitive', exitCode: 1 }),
    })
    expect(result.error).toBe('REDACTED')
  })

  test('empty stderr on failure still produces a placeholder error string', async () => {
    const r = makeRepo(true)
    const result = await syncSubmodules(r, {
      mode: 'auto',
      jobs: 4,
      runGitImpl: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    })
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error!.length).toBeGreaterThan(0)
  })
})
