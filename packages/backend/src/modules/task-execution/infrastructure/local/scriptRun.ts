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

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
import {
  runManagedProcess,
  type ManagedProcessResult,
} from '@/platform/execution/local/managedProcess'
import type { ScriptDepsEnv } from './scriptDepsEnv'
import {
  INTERPRETER_SPEC,
  type ResolvedInterpreter,
} from '@/platform/execution/local/scriptInterpreter'

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
  /**
   * RFC-304 T7: the three things this function used to read off a
   * `WorkflowNode` are now passed as data, so a caller that has no node — a
   * capability HOOK, which mounts on a stage boundary rather than a canvas —
   * can reuse this exact assembly instead of growing a second one. Design D4 is
   * explicit that a second script-execution implementation is NOT acceptable.
   * The script-node caller reads them off its node as before.
   */
  language: ScriptLanguage
  outputMode: 'envelope' | 'stdout'
  /** Author-supplied env overlay; reserved/product keys are filtered here. */
  envOverlay: Record<string, string>
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
  const language = input.language
  const mode = input.outputMode

  // 1. Natural daemon environment.
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string'
    }),
  )

  // 2. Author overlay, excluding product-owned and pre-execution injection keys.
  for (const [key, value] of Object.entries(input.envOverlay)) {
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
  beforeSpawn?: (info: { argv: readonly string[]; cwd: string }) => Promise<void> | void
  onStdoutLine?: (line: string) => Promise<void> | void
  onStderrLine?: (line: string) => Promise<void> | void
  onSpawned?: (info: {
    pid: number
    spawnBinaryPath: string
    launchNonce?: string
  }) => Promise<void> | void
  requireSpawnReceipt?: boolean
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
    // The node-shaped reads stay HERE, where a node exists.
    language: readScriptLanguage(req.node) ?? 'python',
    outputMode: scriptOutputMode(req.node) === 'envelope' ? 'envelope' : 'stdout',
    envOverlay: readScriptEnv(req.node),
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

  const argv = spec.argv(req.interpreter.path, scriptPath)
  const result = await runManagedProcess({
    argv,
    cwd: req.worktreePath,
    env: assembly.env,
    captureRawStdout: true,
    ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    ...(req.killEscalationGraceMs === undefined
      ? {}
      : { killEscalationGraceMs: req.killEscalationGraceMs }),
    ...(req.signal === undefined ? {} : { signal: req.signal }),
    ...(req.beforeSpawn === undefined
      ? {}
      : { beforeSpawn: () => req.beforeSpawn?.({ argv, cwd: req.worktreePath }) }),
    ...(req.onSpawned === undefined ? {} : { onSpawned: req.onSpawned }),
    ...(req.requireSpawnReceipt === true ? { requireSpawnReceipt: true } : {}),
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
