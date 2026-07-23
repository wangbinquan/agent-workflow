// RFC-034 T4 — gitSubmodule.syncSubmodules behavior across mode × .gitmodules
// presence × git outcome. Uses an in-memory runGit stub so we can assert
// exact argv ordering and verify stderr redaction without spinning real git.

import { describe, expect, test, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  syncSubmodules,
  detectSubmodules,
  readDeclaredSubmodulePaths,
} from '../src/services/gitSubmodule'

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
  if (tmp) rmSync(tmp, { recursive: true, force: true })
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

// RFC-210 — declaration parser ownership classification (Codex review rounds
// 9/10/11). `git config -f .gitmodules --get-regexp` reads the file directly,
// so a real dir with a `.gitmodules` (no repo) is enough. These lock the
// error-vs-absent distinction and the name-validation edge cases that decide
// whether an initialized gitlink is treated as managed or left untouched.
describe('readDeclaredSubmodulePaths', () => {
  function dirWith(gitmodules: string | null): string {
    tmp = join(tmpdir(), `aw-decl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmp, { recursive: true })
    if (gitmodules !== null) writeFileSync(join(tmp, '.gitmodules'), gitmodules)
    return tmp
  }

  test('no .gitmodules ⟹ ok with an empty set', async () => {
    const r = await readDeclaredSubmodulePaths(dirWith(null))
    expect(r.ok).toBe(true)
    expect(r.paths.size).toBe(0)
  })

  test('a valid entry contributes its path', async () => {
    const r = await readDeclaredSubmodulePaths(dirWith('[submodule "vendor"]\n\tpath = vendor\n'))
    expect(r.ok).toBe(true)
    expect(r.paths.has('vendor')).toBe(true)
  })

  test('an EMPTY-name subsection is ignored, matching git (round 10, P1)', async () => {
    // git config parses this fine (exit 0) but git's submodule machinery drops
    // the empty-name entry; trusting it would re-mark a stray repo as managed.
    const r = await readDeclaredSubmodulePaths(dirWith('[submodule ""]\n\tpath = nestedrepo\n'))
    expect(r.ok).toBe(true)
    expect(r.paths.has('nestedrepo')).toBe(false)
  })

  test('a name containing a Unicode line separator is preserved (round 11, P2)', async () => {
    // git accepts U+2029 in a subsection name and emits its key (measured);
    // JS `.` would not match it, so a `.`-based regex would go null and drop
    // this MANAGED submodule's path. `[\s\S]` matches it — path preserved.
    const name = `a\u2029b`
    const r = await readDeclaredSubmodulePaths(dirWith(`[submodule "${name}"]\n\tpath = uni\n`))
    expect(r.ok).toBe(true)
    expect(r.paths.has('uni')).toBe(true)
  })

  test('an unparseable .gitmodules ⟹ ok:false (round 9, P1)', async () => {
    const r = await readDeclaredSubmodulePaths(dirWith('[submodule "x"\n\tpath = x\n'))
    expect(r.ok).toBe(false)
    expect(r.paths.size).toBe(0)
  })
})
