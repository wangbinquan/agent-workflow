// RFC-253 — the script node executor.
//
// Everything between "the scheduler decided this node runs now" and "a terminal
// node_run row exists": resolve the interpreter, prepare the dependency
// environment, assemble the environment, materialise the body, run it, and
// turn stdout into port values.
//
// It deliberately does NOT reuse the agent branch's loop body (design-gate F6):
// that code is unreachable for a non-agent kind. It reuses the same PRIMITIVES
// the agent branch uses — the isolation helpers, the semaphores, the node_run
// minting — which is where the real invariants live.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import {
  planScriptPortEnv,
  readScriptBody,
  readScriptDependencies,
  readScriptEnv,
  readScriptLanguage,
  resolveScriptReadonly,
  scriptEnvSuffix,
  scriptOutputMode,
  scriptReservedEnvKeyIssue,
  SCRIPT_DEFAULT_OUTPUT_PORT,
  SCRIPT_ENV_FILE_PREFIX,
  type ScriptFailureCode,
  type ScriptLanguage,
  type WorkflowNode,
} from '@agent-workflow/shared'
import type { Logger } from '@/util/log'
import { runManagedProcess, type ManagedProcessResult } from './execution/managedProcess'
import type { ScriptDepsEnv } from './scriptDepsEnv'
import { platformSpawnOptionsForHost } from '@/util/platformExec'

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
  const INTERMEDIATE = new Set(['bin', 'cmd', 'mingw64', 'mingw32', 'usr'])
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
    const proc = Bun.spawn({
      ...platformSpawnOptionsForHost(),
      cmd: [path, '--version'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // impl-gate 3.4: this runs BEFORE the scheduler's concurrency permit and had
    // no deadline, so an administrator override pointing at anything that waits
    // for input (an interactive wrapper, a shim that prompts) wedged the node's
    // dispatch forever and did so outside every concurrency bound.
    const deadline = setTimeout(() => {
      try {
        proc.kill(9)
      } catch {
        // Already gone.
      }
    }, INTERPRETER_PROBE_TIMEOUT_MS)
    deadline.unref()
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(deadline)
    // python2 and some bash builds print the version on stderr.
    const version = (out.trim().length > 0 ? out : err).split('\n')[0]?.trim() ?? ''
    return { path, version }
  } catch {
    return null
  }
}

export interface ScriptEnvAssembly {
  env: Record<string, string>
  /** Files that must exist before the child starts: absolute path → content. */
  spillFiles: Array<{ path: string; content: string }>
}

/**
 * Build the child's complete, natural environment.
 *
 * RFC-276 fixes the order: inherit daemon env, apply the author's overlay, then
 * write product-protocol keys last. This intentionally restores the operator's
 * normal HOME, PATH, credentials, proxies, and toolchain discovery.
 */
export function assembleScriptEnv(input: {
  node: WorkflowNode
  inputs: Record<string, string>
  runDir: string
  inputDir: string
  worktreePath: string
  repos: ReadonlyArray<{ name: string; path: string }>
  taskId: string
  nodeId: string
  nodeRunId: string
  iteration: number
  retryIndex: number
  shardKey: string | null
  envelopeNonce: string
  interpreterPath: string
  depsEnv: ScriptDepsEnv | null
  gitUserName?: string | null
  gitUserEmail?: string | null
}): ScriptEnvAssembly {
  const plan = planScriptPortEnv(input.inputs)
  const language = readScriptLanguage(input.node) ?? 'python'
  const mode = scriptOutputMode(input.node)

  // 1. Natural daemon environment.
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string'
    }),
  )

  // 2. Author overlay, excluding product-owned and pre-execution injection keys.
  for (const [key, value] of Object.entries(readScriptEnv(input.node))) {
    if (scriptReservedEnvKeyIssue(key) !== null) continue
    env[key] = value
  }

  // 3. Platform protocol/correctness keys, last-write-wins.
  env.PWD = input.worktreePath
  if (process.platform === 'win32') {
    // Windows Python defaults to the legacy code page for stdout, which would
    // corrupt the "stdout IS the port value" contract for any non-ASCII output.
    env.PYTHONUTF8 = '1'
  }
  env.AW_TASK_ID = input.taskId
  env.AW_NODE_ID = input.nodeId
  env.AW_NODE_RUN_ID = input.nodeRunId
  env.AW_ITERATION = String(input.iteration)
  env.AW_RETRY_INDEX = String(input.retryIndex)
  env.AW_SHARD_KEY = input.shardKey ?? ''
  env.AW_WORKTREE = input.worktreePath
  env.AW_REPOS_JSON = JSON.stringify(input.repos)
  env.AW_RUN_DIR = input.runDir
  env.AW_INPUT_DIR = input.inputDir
  env.AW_OUTPUT_MODE = mode === 'envelope' ? 'envelope' : 'stdout'
  env.AW_ENVELOPE_NONCE = input.envelopeNonce
  env.AW_PORT_NAMES = JSON.stringify(plan.suffixByPort)
  for (const [key, value] of Object.entries(plan.inline)) env[key] = value

  const spillFiles: Array<{ path: string; content: string }> = []
  for (const spill of plan.spilled) {
    // Implementation-gate finding (2026-08-04): the port NAME must never be a
    // path component. It comes from an edge's target port, which the workflow
    // author controls, so a port called `../../..` would place this write —
    // with attacker-chosen content, as the daemon — outside the run directory.
    // The env suffix is already folded to `[A-Z0-9_]` and is unique per port by
    // construction (the validator rejects two ports that fold together), so it
    // is both safe and injective. `AW_PORT_NAMES` still carries the original
    // name → suffix map, so a script can find its file.
    const target = join(input.inputDir, scriptEnvSuffix(spill.portName))
    env[spill.envName] = target
    spillFiles.push({ path: target, content: spill.value })
  }

  if (input.depsEnv !== null) {
    env.AW_DEPS_DIR = input.depsEnv.libDir
    if (language === 'python') env.PYTHONPATH = input.depsEnv.libDir
    if (language === 'node') env.NODE_PATH = input.depsEnv.libDir
  }

  // RFC-067 task-scoped git identity, same pair-or-nothing rule as the runner.
  const name = input.gitUserName
  const email = input.gitUserEmail
  if (
    typeof name === 'string' &&
    name.length > 0 &&
    typeof email === 'string' &&
    email.length > 0
  ) {
    env.GIT_AUTHOR_NAME = name
    env.GIT_AUTHOR_EMAIL = email
    env.GIT_COMMITTER_NAME = name
    env.GIT_COMMITTER_EMAIL = email
  }

  return { env, spillFiles }
}

export interface ScriptRunRequest {
  node: WorkflowNode
  inputs: Record<string, string>
  runDir: string
  worktreePath: string
  repos: ReadonlyArray<{ name: string; path: string }>
  taskId: string
  nodeId: string
  nodeRunId: string
  iteration: number
  retryIndex: number
  shardKey: string | null
  envelopeNonce: string
  interpreter: ResolvedInterpreter
  depsEnv: ScriptDepsEnv | null
  timeoutMs?: number
  killEscalationGraceMs?: number
  signal?: AbortSignal
  onStdoutLine?: (line: string) => Promise<void> | void
  onStderrLine?: (line: string) => Promise<void> | void
  onSpawned?: (info: { pid: number; spawnBinaryPath: string }) => Promise<void> | void
  gitUserName?: string | null
  gitUserEmail?: string | null
  log?: Logger
}

export interface ScriptRunOutcome {
  result: ManagedProcessResult
  /** Set when the run failed for a script-specific reason. */
  failureCode: ScriptFailureCode | null
}

/**
 * Materialise and execute one script. Port extraction is the caller's job —
 * this function owns the process, not the protocol.
 */
export async function runScriptProcess(req: ScriptRunRequest): Promise<ScriptRunOutcome> {
  const language = readScriptLanguage(req.node) ?? 'python'
  const spec = INTERPRETER_SPEC[language]
  const inputDir = join(req.runDir, 'inputs')

  // The body lives in the RUN directory, never in the worktree: a script file
  // dropped into the worktree would show up in `git_diff` as a change the node
  // "made", which it did not.
  mkdirSync(inputDir, { recursive: true })
  const scriptPath = join(req.runDir, `script.${spec.ext}`)
  writeFileSync(scriptPath, readScriptBody(req.node), 'utf8')

  const assembly = assembleScriptEnv({
    node: req.node,
    inputs: req.inputs,
    runDir: req.runDir,
    inputDir,
    worktreePath: req.worktreePath,
    repos: req.repos,
    taskId: req.taskId,
    nodeId: req.nodeId,
    nodeRunId: req.nodeRunId,
    iteration: req.iteration,
    retryIndex: req.retryIndex,
    shardKey: req.shardKey,
    envelopeNonce: req.envelopeNonce,
    interpreterPath: req.interpreter.path,
    depsEnv: req.depsEnv,
    gitUserName: req.gitUserName ?? null,
    gitUserEmail: req.gitUserEmail ?? null,
  })
  for (const file of assembly.spillFiles) writeFileSync(file.path, file.content, 'utf8')

  const result = await runManagedProcess({
    argv: spec.argv(req.interpreter.path, scriptPath),
    cwd: req.worktreePath,
    env: assembly.env,
    captureRawStdout: true,
    ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    ...(req.killEscalationGraceMs === undefined
      ? {}
      : { killEscalationGraceMs: req.killEscalationGraceMs }),
    ...(req.signal === undefined ? {} : { signal: req.signal }),
    ...(req.onSpawned === undefined ? {} : { onSpawned: req.onSpawned }),
    ...(req.onStdoutLine === undefined ? {} : { onStdoutLine: req.onStdoutLine }),
    ...(req.onStderrLine === undefined ? {} : { onStderrLine: req.onStderrLine }),
    ...(req.log === undefined ? {} : { log: req.log }),
  })

  return { result, failureCode: classifyScriptOutcome(result) }
}

/** Map a spawn outcome onto the script failure vocabulary. */
export function classifyScriptOutcome(result: ManagedProcessResult): ScriptFailureCode | null {
  switch (result.outcome) {
    case 'timeout':
      return 'script-timeout'
    case 'spawn-failed':
      return 'script-spawn-failed'
    case 'aborted':
      // A cancel is not a failure of the script; the caller writes `canceled`.
      return null
    case 'child-unkillable':
      // impl-gate (Codex 6): a surviving descendant holding the pipes open is
      // never a success, even when the parent exited 0 — output may be
      // truncated and something is still running in the worktree.
      return 'script-spawn-failed'
    case 'exited':
      return result.exitCode === 0 ? null : 'script-nonzero-exit'
  }
}

export {
  SCRIPT_DEFAULT_OUTPUT_PORT,
  SCRIPT_ENV_FILE_PREFIX,
  readScriptDependencies,
  resolveScriptReadonly,
}
