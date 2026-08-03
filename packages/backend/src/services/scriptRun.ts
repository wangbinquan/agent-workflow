// RFC-253 — the script node executor.
//
// Everything between "the scheduler decided this node runs now" and "a terminal
// node_run row exists": resolve the interpreter, prepare the dependency
// environment, assemble a minimal environment, materialise the body, run it
// under containment, and turn stdout into port values.
//
// It deliberately does NOT reuse the agent branch's loop body (design-gate F6):
// that code is unreachable for a non-agent kind. It reuses the same PRIMITIVES
// the agent branch uses — the isolation helpers, the semaphores, the node_run
// minting — which is where the real invariants live.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  planScriptPortEnv,
  readScriptBody,
  readScriptDependencies,
  readScriptEnv,
  readScriptLanguage,
  resolveScriptNetwork,
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
import type { SandboxCtx } from './sandbox'
import { runContainedProcess, type ContainedSpawnResult } from './execution/containedSpawn'
import type { ScriptDepsEnv } from './scriptDepsEnv'

/** File extension + argv shape per language. */
const INTERPRETER_SPEC: Record<
  ScriptLanguage,
  { binary: string; ext: string; argv: (bin: string, script: string) => string[] }
> = {
  // `-u` keeps python's stdout unbuffered so the event stream is live rather
  // than arriving in one lump when the process exits.
  python: { binary: 'python3', ext: 'py', argv: (bin, s) => [bin, '-u', s] },
  bash: { binary: 'bash', ext: 'sh', argv: (bin, s) => [bin, s] },
  node: { binary: 'node', ext: 'mjs', argv: (bin, s) => [bin, s] },
}

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
  const path = override !== undefined && override.length > 0 ? override : Bun.which(spec.binary)
  if (path === null || path === undefined || path.length === 0) return null
  if (!existsSync(path)) return null
  try {
    const proc = Bun.spawn({ cmd: [path, '--version'], stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
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
 * Build the child's COMPLETE environment.
 *
 * Two rules carry the security weight:
 *   - the daemon's own `process.env` is never inherited (AC-16), so a secret in
 *     the daemon environment cannot leak into a user's script;
 *   - the node's `env` overlay is applied FIRST and the platform keys last
 *     (design-gate P1). The reverse order would let `PYTHONPATH` or `HOME`
 *     from user data undo the read-only dependency boundary and the private
 *     run directory. The validator additionally refuses those keys at save
 *     time, so this ordering is defence in depth rather than the only line.
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

  const env: Record<string, string> = {}
  // 1. user overlay, MINUS every reserved key.
  //
  // Ordering alone is not enough (caught by rfc253-script-execution): the
  // platform only sets `PYTHONPATH` when a dependency environment exists, so a
  // user-supplied `PYTHONPATH` would survive on every node WITHOUT dependencies
  // and hijack module resolution before the script's first line. Dropping the
  // reserved set here makes "the platform owns these keys" true unconditionally
  // rather than true-where-the-platform-happens-to-write.
  for (const [key, value] of Object.entries(readScriptEnv(input.node))) {
    if (scriptReservedEnvKeyIssue(key) !== null) continue
    env[key] = value
  }

  // 2. platform keys, last-write-wins.
  const interpreterDir = input.interpreterPath.slice(0, input.interpreterPath.lastIndexOf('/'))
  env.PATH = [interpreterDir, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((p) => p.length > 0)
    .join(':')
  env.HOME = join(input.runDir, 'home')
  env.TMPDIR = join(input.runDir, 'tmp')
  env.LANG = 'C.UTF-8'
  env.LC_ALL = 'C.UTF-8'
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
  sandbox?: SandboxCtx
  onStdoutLine?: (line: string) => Promise<void> | void
  onStderrLine?: (line: string) => Promise<void> | void
  onSpawned?: (info: { pid: number; spawnBinaryPath: string }) => Promise<void> | void
  gitUserName?: string | null
  gitUserEmail?: string | null
  log?: Logger
}

export interface ScriptRunOutcome {
  result: ContainedSpawnResult
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
  mkdirSync(join(req.runDir, 'home'), { recursive: true })
  mkdirSync(join(req.runDir, 'tmp'), { recursive: true })
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

  const result = await runContainedProcess({
    argv: spec.argv(req.interpreter.path, scriptPath),
    cwd: req.worktreePath,
    env: assembly.env,
    captureRawStdout: true,
    ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    ...(req.killEscalationGraceMs === undefined
      ? {}
      : { killEscalationGraceMs: req.killEscalationGraceMs }),
    ...(req.signal === undefined ? {} : { signal: req.signal }),
    ...(req.sandbox === undefined ? {} : { sandbox: req.sandbox }),
    ...(req.onSpawned === undefined ? {} : { onSpawned: req.onSpawned }),
    ...(req.onStdoutLine === undefined ? {} : { onStdoutLine: req.onStdoutLine }),
    ...(req.onStderrLine === undefined ? {} : { onStderrLine: req.onStderrLine }),
    ...(req.log === undefined ? {} : { log: req.log }),
  })

  return { result, failureCode: classifyScriptOutcome(result) }
}

/** Map a spawn outcome onto the script failure vocabulary. */
export function classifyScriptOutcome(result: ContainedSpawnResult): ScriptFailureCode | null {
  switch (result.outcome) {
    case 'timeout':
      return 'script-timeout'
    case 'spawn-failed':
      return 'script-spawn-failed'
    case 'aborted':
      // A cancel is not a failure of the script; the caller writes `canceled`.
      return null
    case 'child-unkillable':
    case 'exited':
      return result.exitCode === 0 ? null : 'script-nonzero-exit'
  }
}

export {
  SCRIPT_DEFAULT_OUTPUT_PORT,
  SCRIPT_ENV_FILE_PREFIX,
  readScriptDependencies,
  resolveScriptNetwork,
  resolveScriptReadonly,
}
