// RFC-061 PR-B T9-extra — runner-v2 invocation prep (pure functions, no subprocess).
//
// Step 1 of the T10/T11 playbook's "runner-v2.ts" stretches across two
// commits: this file lands the PURE setup (env / cwd / args / inline
// config) so the next session can wire the actual subprocess spawn +
// envelope parser without re-deriving the OPENCODE_CONFIG_CONTENT /
// OPENCODE_CONFIG_DIR contract from scratch.
//
// Everything here is testable without spawning anything.

import { join } from 'node:path'

import type { Agent, Mcp, Plugin, Scope } from '@agent-workflow/shared'
import type { ResolvedSkill, AgentOverrides } from '../services/runner'
import { buildInlineConfig } from '../services/runner'

export interface RunnerV2InvocationInputs {
  /** App home (~/.agent-workflow) for OPENCODE_CONFIG_DIR base. */
  appHome: string
  taskId: string
  /** RFC-061 attemptId replaces the legacy nodeRunId for path isolation. */
  attemptId: string
  scope: Scope
  /** Task worktree path; becomes the opencode subprocess cwd. */
  worktreePath: string
  /** Primary agent definition (frontmatter + body). */
  agent: Agent
  /**
   * Per-node overrides (model / variant / temperature). Today's RFC-061
   * dispatch context threads this through SpawnRequest extras.
   */
  overrides?: AgentOverrides
  /** RFC-022: dependent agents in BFS closure. */
  dependents?: readonly Agent[]
  /** RFC-028: enabled MCPs to inject into OPENCODE_CONFIG_CONTENT. */
  mcps?: readonly Mcp[]
  /** RFC-031: enabled plugins. */
  plugins?: readonly Plugin[]
  /** Already-composed prompt (computeTickActions baked it). */
  prompt: string
  /** RFC-026: resume a prior opencode session id (clarify rerun). */
  resumeSessionId?: string
  /**
   * RFC-029: when false (default true for agent-single), skip
   * `--dangerously-skip-permissions`. v2 keeps the legacy default.
   */
  dangerouslySkipPermissions?: boolean
  /** Optional override for the opencode CLI head (tests). */
  opencodeCmd?: readonly string[]
}

export interface RunnerV2Invocation {
  /** Per-attempt opencode config dir (OPENCODE_CONFIG_DIR env var). */
  configDir: string
  /** Per-attempt run root for inventory plugin output / logs. */
  runRoot: string
  /** Inline opencode config JSON (OPENCODE_CONFIG_CONTENT env var). */
  inlineConfig: ReturnType<typeof buildInlineConfig>
  /** Subprocess argv. */
  command: string[]
  /** Subprocess cwd. */
  cwd: string
  /** Env vars to set on the subprocess (merged with process.env at spawn time). */
  env: Record<string, string>
}

/**
 * Build the OPENCODE_CONFIG_CONTENT JSON + OPENCODE_CONFIG_DIR path +
 * subprocess argv + cwd + env. Pure: no file system writes, no
 * subprocess spawn. The caller (runner-v2 subprocess loop, to be
 * landed in a follow-up commit) writes inlineConfig + skills to disk
 * then spawns with these args/env/cwd.
 *
 * Path layout:
 *   <appHome>/runs/<taskId>/<attemptId>/        ← runRoot
 *   <appHome>/runs/<taskId>/<attemptId>/.opencode  ← configDir
 *
 * The configDir is per-attempt so concurrent opencode subprocesses can't
 * race on shared skill / agent dirs (RFC-016 isolation contract).
 */
export function prepareRunnerV2Invocation(inputs: RunnerV2InvocationInputs): RunnerV2Invocation {
  const runRoot = join(inputs.appHome, 'runs', inputs.taskId, inputs.attemptId)
  const configDir = join(runRoot, '.opencode')

  const inlineConfig = buildInlineConfig(
    inputs.agent,
    inputs.overrides,
    inputs.dependents ?? [],
    inputs.mcps ?? [],
    inputs.plugins ?? [],
  )

  const command = buildOpencodeCommand({
    opencodeCmd: inputs.opencodeCmd ?? ['opencode'],
    agentName: inputs.agent.name,
    prompt: inputs.prompt,
    dangerouslySkipPermissions: inputs.dangerouslySkipPermissions ?? true,
    resumeSessionId: inputs.resumeSessionId,
  })

  const env: Record<string, string> = {
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
  }

  return {
    configDir,
    runRoot,
    inlineConfig,
    command,
    cwd: inputs.worktreePath,
    env,
  }
}

/**
 * Mirror of services/runner.ts:buildCommand but parameterized on a
 * minimal contract so callers can use it without a full RunNodeOptions.
 * Exported so tests can lock the exact argv shape independent of the
 * surrounding spawn machinery.
 */
export function buildOpencodeCommand(opts: {
  opencodeCmd: readonly string[]
  agentName: string
  prompt: string
  dangerouslySkipPermissions: boolean
  resumeSessionId?: string
}): string[] {
  const cmd: string[] = [
    ...opts.opencodeCmd,
    'run',
    opts.prompt,
    '--agent',
    opts.agentName,
    '--format',
    'json',
    '--thinking',
  ]
  if (opts.dangerouslySkipPermissions) cmd.push('--dangerously-skip-permissions')
  if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
    cmd.push('--session', opts.resumeSessionId)
  }
  return cmd
}

/**
 * Re-export of types/utilities the next session's runner-v2 subprocess
 * loop will need. Centralizing them here avoids scheduler-v2/ files
 * having to reach back into legacy services for imports.
 */
export { buildInlineConfig }
export type { ResolvedSkill, AgentOverrides }
