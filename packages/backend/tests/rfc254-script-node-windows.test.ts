// RFC-254 T22/T23 (D3) — script nodes on Windows.
//
// Two facts drive everything here:
//   1. There is no `python3` on Windows, and the name that DOES exist may be a
//      Microsoft Store alias that is not an interpreter at all.
//   2. There IS a `bash.exe` on Windows — `System32\bash.exe`, the WSL
//      launcher. Finding it would run the author's script inside a different
//      operating system, against a different view of the worktree. So bash is
//      derived from `git`, never searched for by name.
//
// Everything takes an injected platform + `which`, so the win32 branches run on
// the POSIX CI legs.

import { describe, expect, test } from 'bun:test'
import {
  WINDOWS_INTERPRETER_CANDIDATES,
  gitBashFromGitPath,
  interpreterCandidatePaths,
} from '@/services/scriptRun'
import { buildScriptPath } from '@/util/platformExec'
import { SCRIPT_RESERVED_ENV_KEYS, scriptReservedEnvKeyIssue } from '@agent-workflow/shared'

const win = (p: string) => p.replaceAll('/', '\\')

describe('RFC-254 T22 — interpreter resolution', () => {
  test('POSIX resolves the single conventional name, unchanged', () => {
    expect(
      interpreterCandidatePaths('python', 'linux', 'python3', () => '/usr/bin/python3'),
    ).toEqual(['/usr/bin/python3'])
    expect(interpreterCandidatePaths('bash', 'linux', 'bash', () => '/bin/bash')).toEqual([
      '/bin/bash',
    ])
    expect(interpreterCandidatePaths('node', 'linux', 'node', () => null)).toEqual([])
  })

  test('Windows python tries python3 → python → py, in order', () => {
    expect(WINDOWS_INTERPRETER_CANDIDATES.python).toEqual(['python3', 'python', 'py'])
    const found: Record<string, string> = {
      python3: win('C:/Store/python3.exe'),
      python: win('C:/Python/python.exe'),
      py: win('C:/Windows/py.exe'),
    }
    expect(
      interpreterCandidatePaths('python', 'win32', 'python3', (c) => found[c] ?? null),
    ).toEqual([win('C:/Store/python3.exe'), win('C:/Python/python.exe'), win('C:/Windows/py.exe')])
  })

  test('Windows python dedupes when two names resolve to the same file', () => {
    const same = win('C:/Python/python.exe')
    expect(interpreterCandidatePaths('python', 'win32', 'python3', () => same)).toEqual([same])
  })

  test('Windows bash comes from git and NEVER from a bare bash lookup', () => {
    // The whole point: `which('bash')` on Windows finds the WSL launcher.
    const which = (cmd: string): string | null => {
      if (cmd === 'git') return win('C:/Program Files/Git/cmd/git.exe')
      if (cmd === 'bash') return win('C:/Windows/System32/bash.exe')
      return null
    }
    const candidates = interpreterCandidatePaths('bash', 'win32', 'bash', which)
    expect(candidates).toEqual([win('C:/Program Files/Git/bin/bash.exe')])
    expect(candidates.some((c) => c.toLowerCase().includes('system32'))).toBe(false)
  })

  test('Windows bash yields nothing when git is absent — no guessing', () => {
    // An empty candidate list makes the node fail at startup with an
    // interpreter-missing error, which is the actionable outcome. Inventing a
    // conventional path would fail later and less legibly.
    expect(interpreterCandidatePaths('bash', 'win32', 'bash', () => null)).toEqual([])
  })

  test('the git → bash derivation is shape-checked, not string-glued', () => {
    const dirname = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('\\')))
    expect(gitBashFromGitPath(win('C:/Program Files/Git/cmd/git.exe'), dirname)).toBe(
      win('C:/Program Files/Git/bin/bash.exe'),
    )
    expect(gitBashFromGitPath('', dirname)).toBeNull()
  })
})

describe('RFC-254 T23 — script environment', () => {
  test('POSIX PATH is byte-for-byte the historical list', () => {
    expect(buildScriptPath('/opt/py/bin', 'linux', undefined)).toBe(
      '/opt/py/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    )
  })

  test('Windows PATH leads with the interpreter directory and joins with ;', () => {
    const path = buildScriptPath(win('C:/Python'), 'win32', win('C:/Windows'))
    expect(path.split(';')[0]).toBe(win('C:/Python'))
    expect(path).toContain(win('C:/Windows/System32'))
  })

  test('the Windows platform keys are reserved so an author cannot redirect the run', () => {
    // USERPROFILE is the one that matters most: leaving it pointed at the real
    // profile while HOME points into the run directory means half the script's
    // tooling writes outside the sandbox.
    for (const key of ['USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'PATHEXT', 'PYTHONUTF8']) {
      expect(SCRIPT_RESERVED_ENV_KEYS).toContain(key)
      expect(scriptReservedEnvKeyIssue(key)).not.toBeNull()
    }
  })

  test('reservation is case-insensitive, so `UserProfile` is refused too', () => {
    expect(scriptReservedEnvKeyIssue('UserProfile')).not.toBeNull()
    expect(scriptReservedEnvKeyIssue('userprofile')).not.toBeNull()
  })

  test('ordinary author keys stay allowed', () => {
    expect(scriptReservedEnvKeyIssue('MY_API_BASE')).toBeNull()
  })
})
