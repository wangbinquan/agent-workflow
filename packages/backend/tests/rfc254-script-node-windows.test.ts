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
  describeInterpreterResolution,
  gitBashCandidatesFromGitPath,
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
    // 规范布局的首选仍是 `<root>\bin\bash.exe`；其余候选是 PATH 顺序保险（见下一条）。
    expect(candidates[0]).toBe(win('C:/Program Files/Git/bin/bash.exe'))
    // 承重不变量：任何候选都不许落到 WSL 启动器上——它们全部只在 git 自己的安装树下。
    expect(candidates.some((c) => c.toLowerCase().includes('system32'))).toBe(false)
  })

  // 2026-08-09 回归锁：真 bug，不是假想。GH `windows-latest` 上 `Bun.which('git')`
  // 命中的是 `mingw64\bin\git.exe` 而不是 `cmd\git.exe`，旧实现固定往上两级，于是
  // 推出不存在的 `…\Git\mingw64\bin\bash.exe`，**所有 bash 脚本节点**以
  // `script-interpreter-missing` 失败（run 31324148366 的逐环诊断实证）。
  // Git for Windows 把 cmd\ 、mingw64\bin\ 、usr\bin\ 都放进 PATH，命中哪个纯看
  // PATH 顺序 —— 所以这不是 CI 特例，是任何 mingw64\bin 靠前的 Windows 机器。
  test('Windows bash 在 git 由 mingw64\\bin 命中时仍能找到真正的 bash', () => {
    const which = (cmd: string): string | null =>
      cmd === 'git' ? win('C:/Program Files/Git/mingw64/bin/git.exe') : null
    const candidates = interpreterCandidatePaths('bash', 'win32', 'bash', which)
    expect(candidates).toContain(win('C:/Program Files/Git/bin/bash.exe'))
    expect(candidates).toContain(win('C:/Program Files/Git/usr/bin/bash.exe'))
    expect(candidates.some((c) => c.toLowerCase().includes('system32'))).toBe(false)
  })

  test('候选集覆盖 usr\\bin 布局，且逐级向上不越过 3 层', () => {
    const dirname = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('\\')))
    const got = gitBashCandidatesFromGitPath(win('C:/Program Files/Git/cmd/git.exe'), dirname)
    expect(got[0]).toBe(win('C:/Program Files/Git/bin/bash.exe'))
    expect(got).toContain(win('C:/Program Files/Git/usr/bin/bash.exe'))
    // 3 层封顶 × 每层 2 个后缀 ⇒ 至多 6 个，不会一路走到盘根去捞 `C:\bin\bash.exe`
    expect(got.length).toBeLessThanOrEqual(6)
    expect(got.every((c) => c.startsWith(win('C:/Program Files')))).toBe(true)
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

  test('natural Windows profile/temp/tool keys stay authorable; product keys remain reserved', () => {
    for (const key of ['USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'PATHEXT']) {
      expect(SCRIPT_RESERVED_ENV_KEYS).not.toContain(key)
      expect(scriptReservedEnvKeyIssue(key)).toBeNull()
    }
    expect(SCRIPT_RESERVED_ENV_KEYS).toContain('PYTHONUTF8')
    expect(scriptReservedEnvKeyIssue('PYTHONUTF8')).not.toBeNull()
  })

  test('reservation remains case-insensitive for a retained product key', () => {
    expect(scriptReservedEnvKeyIssue('PythonUtf8')).not.toBeNull()
    expect(scriptReservedEnvKeyIssue('pythonutf8')).not.toBeNull()
  })

  test('ordinary author keys stay allowed', () => {
    expect(scriptReservedEnvKeyIssue('MY_API_BASE')).toBeNull()
  })
})

// 2026-08-09 —— RFC-253 T41 的 e2e 第一次在真 Windows 上执行脚本节点就红了，而
// `script-interpreter-missing` 当时只报得出 `no bash interpreter available on this host`：
// 解析链四环（which 命中什么 / 推导出什么 / 是否存在 / --version 是否通过）失败时长得
// 一模一样，为了知道是哪一环断的，多推了一轮 CI。这组用例锁住「结论必须带过程」。
describe('interpreter 解析失败必须带出逐环结果', () => {
  const noExists = () => false
  const yesExists = () => true

  test('win32 bash：which(git) 落空时点名是这一环', () => {
    const d = describeInterpreterResolution('bash', {}, 'win32', () => null, noExists)
    expect(d).toContain('platform=win32')
    expect(d).toContain('which(git)=null')
    // 没有 git 就没有推导，不该编出一个路径来
    expect(d).not.toContain('derived=')
  })

  test('win32 bash：推导出候选但都不存在时，候选集与逐个 exists 都在', () => {
    const d = describeInterpreterResolution(
      'bash',
      {},
      'win32',
      () => 'C:\\Program Files\\Git\\cmd\\git.exe',
      noExists,
    )
    expect(d).toContain('cmd\\\\git.exe')
    expect(d).toContain('bin\\\\bash.exe')
    expect(d).toContain('each exists=')
    expect(d).toContain('false')
  })

  test('win32 bash：git 路径没有可用祖先时明说，而不是谎报一个路径', () => {
    const d = describeInterpreterResolution('bash', {}, 'win32', () => 'git.exe', noExists)
    expect(d).toContain('derived=[]')
  })

  test('非 bash 走候选链，逐个报 exists', () => {
    const d = describeInterpreterResolution(
      'python',
      {},
      'win32',
      (cmd) => (cmd === 'py' ? 'C:\\Windows\\py.exe' : null),
      yesExists,
    )
    expect(d).toContain('candidates=')
    expect(d).toContain('py.exe')
    expect(d).toContain('exists=true')
  })

  test('候选为空时明说是 PATH 上没有，而不是含糊其辞', () => {
    const d = describeInterpreterResolution('node', {}, 'linux', () => null, noExists)
    expect(d).toContain('candidates=[]')
    expect(d).toContain('nothing on PATH')
  })

  test('管理员覆盖失败时点名是覆盖项，并给出它是否存在', () => {
    const d = describeInterpreterResolution(
      'bash',
      { bash: '/opt/nope/bash' },
      'linux',
      () => null,
      noExists,
    )
    expect(d).toContain('administrator override')
    expect(d).toContain('/opt/nope/bash')
    expect(d).toContain('exists=false')
  })
})
