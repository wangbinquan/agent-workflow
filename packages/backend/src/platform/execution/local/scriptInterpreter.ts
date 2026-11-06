// RFC-454 — which interpreter runs a script on this host: the language registry (binary, extension, argv), the
// Windows candidate locations and the version probe. Moved verbatim from task-execution's
// `infrastructure/local/scriptRun.ts`: the script node and event-center's custom observer programs both need it, and
// event-center → task-execution is not a target DAG edge (the observer used to reach it through `services/scriptRun`).
// A host mechanism: it imports no module.

import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import type { ScriptLanguage } from '@agent-workflow/shared'
import { spawnVersionProbe } from '@/util/process'

/**
 * File extension + argv shape per language.
 *
 * Exported so the T43 snippet test can run a generated snippet EXACTLY the way
 * production runs a body — a hand-copied table in the test would let the
 * snippets keep passing after this one changed (the `.mjs` extension is the
 * live example: it makes node scripts ESM, so a `require()` snippet does not
 * even start).
 */
export const INTERPRETER_SPEC: Record<
  ScriptLanguage,
  { binary: string; ext: string; argv: (bin: string, script: string) => string[] }
> = {
  // `-u` keeps python's stdout unbuffered so the event stream is live rather
  // than arriving in one lump when the process exits.
  python: { binary: 'python3', ext: 'py', argv: (bin, s) => [bin, '-u', s] },
  bash: { binary: 'bash', ext: 'sh', argv: (bin, s) => [bin, s] },
  node: { binary: 'node', ext: 'mjs', argv: (bin, s) => [bin, s] },
}

/**
 * RFC-254 T22 (D3) — where each interpreter actually lives on Windows.
 *
 * python: there is no `python3` on Windows. Real installs expose `python`, and
 * the Microsoft Store ships a `python3` App Execution Alias that is NOT an
 * interpreter — it exits non-zero and opens the Store — so the `--version`
 * probe each candidate already goes through is what filters it out. `py` (the
 * PEP-397 launcher) is the last resort because it is present even when neither
 * name is on PATH.
 *
 * bash: resolved from GIT, never from a bare `which('bash')`. Windows ships
 * `System32\bash.exe`, which is the WSL launcher — finding it would silently
 * run the author's script inside a DIFFERENT OPERATING SYSTEM, with a different
 * filesystem view of the worktree. The Git for Windows shell sits two levels
 * up from `git.exe` (`<root>\cmd\git.exe` → `<root>\bin\bash.exe`), which is
 * exactly how OpenCode itself locates it (`core/src/shell.ts:123-130`).
 * windows-2025 runners additionally carry an MSYS2 bash, so "some bash exists"
 * is never sufficient evidence.
 */
export const WINDOWS_INTERPRETER_CANDIDATES: Readonly<Record<ScriptLanguage, string[]>> = {
  python: ['python3', 'python', 'py'],
  bash: [],
  node: ['node'],
}

/**
 * Derive Git for Windows' `bash.exe` candidates from a resolved `git` path.
 *
 * Git for Windows puts THREE directories on PATH — `cmd\`, `mingw64\bin\`
 * (or `mingw32\bin\`) and sometimes `usr\bin\` — and which one `which('git')`
 * hits depends purely on PATH ORDER. The first version of this function assumed
 * the `<root>\cmd\git.exe` shape and went up exactly two levels, so on a host
 * where `mingw64\bin` sorts first it computed
 * `<root>\mingw64\bin\bash.exe`, which does not exist, and every bash script
 * node failed with `script-interpreter-missing`. That is exactly what the
 * GitHub `windows-latest` runner does — RFC-253 T41's e2e caught it the first
 * time anything in this repo actually EXECUTED a script node on real Windows
 * (run 31324148366: `which(git)="…\Git\mingw64\bin\git.exe"
 * derived="…\Git\mingw64\bin\bash.exe" exists=false`).
 *
 * So: walk UP from git's directory (capped at 3 ancestors, which covers
 * `<root>\mingw64\bin`) and offer `<ancestor>\bin\bash.exe` plus
 * `<ancestor>\usr\bin\bash.exe` at each level. This is still not guessing —
 * every candidate goes through `existsSync` + a `--version` probe before it is
 * used, and every candidate stays UNDER git's own install root, so the WSL
 * launcher at `System32\bash.exe` remains unreachable by construction.
 */
export function gitBashCandidatesFromGitPath(
  gitPath: string,
  dirnameOf: (p: string) => string,
): string[] {
  if (gitPath.length === 0) return []
  const out: string[] = []
  let dir = dirnameOf(gitPath)
  // 向上走的**终止条件是形状**，不是层数：只要当前目录名还是 Git for Windows 的已知
  // 中间层就继续，否则立刻停。这样 `<root>\\cmd\\git.exe` 只上一层、
  // `<root>\\mingw64\\bin\\git.exe` 上两层，而**永远走不到盘根**——先前用「上 3 层」
  // 封顶的写法会一路捞出 `C:\\bin\\bash.exe`，那既越过了 git 的安装树，也就失去了
  // 「WSL 启动器不可达」这个承重不变量的依据。
  // 2026-10-14：Git for Windows 新版把工具链目录从 `mingw64` 换成 `ucrt64`（ARM64 版是
  // `clangarm64`，另有 `clang64`），`windows-latest` 上 `which('git')` 随之命中
  // `<root>\\ucrt64\\bin\\git.exe`；名单只认 mingw 时走到 `ucrt64` 就停，所有 bash 脚本节点
  // 都以 `script-interpreter-missing` 失败。
  const INTERMEDIATE = new Set([
    'bin',
    'cmd',
    'mingw64',
    'mingw32',
    'ucrt64',
    'clang64',
    'clangarm64',
    'usr',
  ])
  for (;;) {
    const parent = dirnameOf(dir)
    if (parent.length === 0 || parent === dir) break
    const name = dir
      .slice(parent.length)
      .replace(/^[\\/]+/, '')
      .toLowerCase()
    if (!INTERMEDIATE.has(name)) break
    for (const suffix of ['bin\\bash.exe', 'usr\\bin\\bash.exe']) {
      const candidate = `${parent}\\${suffix}`
      if (!out.includes(candidate)) out.push(candidate)
    }
    dir = parent
  }
  return out
}

/**
 * Back-compat single-answer form: the FIRST candidate, or null.
 *
 * Kept because it names the canonical `<root>\cmd\git.exe` → `<root>\bin\bash.exe`
 * shape that most Windows installs still hit; callers that need the full
 * PATH-order-independent set use {@link gitBashCandidatesFromGitPath}.
 */
export function gitBashFromGitPath(
  gitPath: string,
  dirnameOf: (p: string) => string,
): string | null {
  return gitBashCandidatesFromGitPath(gitPath, dirnameOf)[0] ?? null
}

/** Deadline for the one-shot `--version` probe (impl-gate 3.4). */
export const INTERPRETER_PROBE_TIMEOUT_MS = 10_000

export interface ResolvedInterpreter {
  path: string
  /** `--version` output, first line, trimmed. Participates in the deps env key. */
  version: string
}

/**
 * Resolve a language to an absolute interpreter path.
 *
 * An administrator override wins over PATH: the daemon's PATH is whatever the
 * service manager handed it, which is frequently not the interpreter the
 * operator means (pyenv shims, homebrew, a container image's own python).
 */
export async function resolveScriptInterpreter(
  language: ScriptLanguage,
  overrides: Partial<Record<ScriptLanguage, string>>,
): Promise<ResolvedInterpreter | null> {
  const spec = INTERPRETER_SPEC[language]
  const override = overrides[language]
  const candidates =
    override !== undefined && override.length > 0
      ? [override]
      : interpreterCandidatePaths(language, process.platform, spec.binary, (cmd) => Bun.which(cmd))
  for (const candidate of candidates) {
    const probed = await probeInterpreter(candidate)
    if (probed !== null) return probed
  }
  return null
}

/**
 * The ordered list of paths to try for `language` on this platform.
 *
 * POSIX yields the single conventional name, exactly as before. Windows yields
 * the D3 candidate chain (python3 → python → py), and for bash yields ONLY the
 * path derived from `git` — never a bare `which('bash')`, which on Windows
 * finds `System32\bash.exe`, the WSL launcher, and would run the author's
 * script inside a different operating system entirely.
 */
/**
 * Why a language resolved to no usable interpreter — the trace, not just the verdict.
 *
 * 起因（2026-08-09）：RFC-253 T41 的 e2e 第一次在真 Windows 上执行脚本节点就红了，而
 * `script-interpreter-missing` 当时只说得出 `no bash interpreter available on this host`。
 * 那句话对排障的人零价值 —— 解析链有四环（`which` 命中什么 / 由它推导出什么路径 /
 * 该路径是否存在 / `--version` 探测是否通过），四环失败长得一模一样。排一次障要么读源码
 * 反推，要么像本轮一样多推一轮 CI 才拿得到原因。
 *
 * 只在**失败路径**上调用，成功路径一个字节不变。
 */
export function describeInterpreterResolution(
  language: ScriptLanguage,
  overrides: Partial<Record<ScriptLanguage, string>>,
  platform: NodeJS.Platform = process.platform,
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
  exists: (p: string) => boolean = existsSync,
): string {
  const override = overrides[language]
  if (override !== undefined && override.length > 0) {
    return `administrator override ${JSON.stringify(override)} (exists=${exists(override)}) failed its --version probe`
  }
  const parts: string[] = [`platform=${platform}`]
  if (platform === 'win32' && language === 'bash') {
    const git = which('git')
    parts.push(`which(git)=${git === null || git.length === 0 ? 'null' : JSON.stringify(git)}`)
    if (git !== null && git.length > 0) {
      const derived = gitBashCandidatesFromGitPath(git, win32.dirname)
      parts.push(
        derived.length === 0
          ? 'derived=[] (git path had no usable ancestor)'
          : `derived=${JSON.stringify(derived)} (each exists=${derived.map((d) => exists(d)).join(',')})`,
      )
    }
  } else {
    const candidates = interpreterCandidatePaths(
      language,
      platform,
      INTERPRETER_SPEC[language].binary,
      which,
    )
    parts.push(
      candidates.length === 0
        ? 'candidates=[] (nothing on PATH)'
        : `candidates=${JSON.stringify(candidates)} (each exists=${candidates.map((c) => exists(c)).join(',')})`,
    )
  }
  return parts.join(' ')
}

export function interpreterCandidatePaths(
  language: ScriptLanguage,
  platform: NodeJS.Platform,
  posixBinary: string,
  which: (cmd: string) => string | null,
): string[] {
  if (platform !== 'win32') {
    const resolved = which(posixBinary)
    return resolved === null || resolved.length === 0 ? [] : [resolved]
  }
  if (language === 'bash') {
    const git = which('git')
    if (git === null || git.length === 0) return []
    // `win32.dirname`, NOT the ambient `dirname`: `node:path`'s default export
    // is the HOST's flavour, so on a POSIX box it sees no separators in
    // `C:\...\git.exe` and returns '.'. Windows paths need the win32 parser
    // regardless of who is doing the parsing.
    return gitBashCandidatesFromGitPath(git, win32.dirname)
  }
  const out: string[] = []
  for (const name of WINDOWS_INTERPRETER_CANDIDATES[language]) {
    const resolved = which(name)
    if (resolved !== null && resolved.length > 0 && !out.includes(resolved)) out.push(resolved)
  }
  return out
}

async function probeInterpreter(path: string): Promise<ResolvedInterpreter | null> {
  if (path.length === 0) return null
  if (!existsSync(path)) return null
  try {
    // impl-gate 3.4 曾补 deadline（本探针跑在调度并发许可之前，等输入的
    // wrapper 会把节点 dispatch 挂死在一切并发边界之外）；RFC-284 T17 进一步
    // 收编 spawnVersionProbe 的 models 形态：双流 capped 并发读（python2 与
    // 部分 bash 把版本打在 stderr）+ detached 组杀替代原单 pid kill(9)——
    // fork 后持管道的孙进程曾能让无界 text() 再次挂死 + 泄漏。
    // 不查 exitCode，与原语义一致。
    const r = await spawnVersionProbe([path, '--version'], {
      timeoutMs: INTERPRETER_PROBE_TIMEOUT_MS,
      maxBytes: 64 * 1024,
    })
    // python2 and some bash builds print the version on stderr.
    const version = (r.stdout.trim().length > 0 ? r.stdout : r.stderr).split('\n')[0]?.trim() ?? ''
    return { path, version }
  } catch {
    return null
  }
}
