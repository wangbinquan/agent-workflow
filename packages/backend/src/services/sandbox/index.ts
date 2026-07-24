// RFC-205 T3 — the spawn-boundary wrapper.
//
// SpawnPlan stays byte-identical (golden argv locks, shell stubs,
// spawnBinaryPath = plan.cmd[0], version-registry keys — see design §1 红线);
// the sandbox is applied at the LAST moment, wrapping the final argv that
// reaches Bun.spawn. No ctx (tests, sandboxMode=off, mechanism unavailable)
// → the argv passes through untouched.

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  computeSandboxPolicy,
  renderBwrapArgs,
  renderSeatbeltProfile,
  type SandboxPolicy,
} from './policy'
import type { SandboxStatus } from './probe'

export type SandboxMode = 'enforce' | 'warn' | 'off'

export interface SandboxCtx {
  mode: SandboxMode
  status: SandboxStatus
  appHome: string
  /** THIS task's worktree roots. */
  taskWorktrees: readonly string[]
  /** THIS run's private dir. */
  runDir: string
  /** Immutable artifacts below an allowed subtree, overlaid read-only. */
  readOnlySubtrees?: readonly string[]
  /** Provider-owned renderer for mechanisms added after the built-ins. */
  wrapCommand?: (cmd: readonly string[], policy: SandboxPolicy) => string[]
}

/** Should this spawn be wrapped at all? (off / unavailable → no) */
export function sandboxActive(ctx: SandboxCtx | undefined): boolean {
  return ctx !== undefined && ctx.mode !== 'off' && ctx.status.available
}

/**
 * RFC-205 impl-gate P0-1 (Codex 2026-07-22): true when the mode is `enforce` but
 * the platform sandbox is unavailable — the spawn MUST fail closed instead of
 * running the agent unsandboxed. The launch-time 409 only guards NEW tasks; every
 * launch/resume/retry/auto-resume path funnels through the runner spawn, so the
 * single decision point there calls this to close the resume/retry/auto-resume
 * bypass. (`warn` + unavailable degrades loudly; `off` never blocks.)
 */
export function sandboxEnforceBlocked(ctx: SandboxCtx | undefined): boolean {
  return ctx !== undefined && ctx.mode === 'enforce' && !ctx.status.available
}

/**
 * Wrap a final argv in the platform sandbox. Returns a NEW array — the input
 * (plan.cmd) is never mutated (spawnBinaryPath/registry keep reading it).
 */
export function wrapSandbox(cmd: readonly string[], ctx: SandboxCtx | undefined): string[] {
  if (!sandboxActive(ctx) || ctx === undefined) return [...cmd]
  // Seatbelt matches KERNEL paths: a profile written against a symlinked
  // prefix (macOS $TMPDIR = /var → /private/var; a symlinked $HOME) silently
  // matches NOTHING and the deny evaporates — caught live by the gated
  // integration test. Resolve every policy root to its real path; a path that
  // does not exist yet (runDir pre-mkdir) stays as given.
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const policy = computeSandboxPolicy({
    appHome: real(ctx.appHome),
    taskWorktrees: ctx.taskWorktrees.map(real),
    runDir: real(ctx.runDir),
    readOnlySubtrees: ctx.readOnlySubtrees?.map(real),
  })
  if (ctx.wrapCommand !== undefined) return ctx.wrapCommand(cmd, policy)
  if (ctx.status.mechanism === 'seatbelt') {
    return ['/usr/bin/sandbox-exec', '-p', renderSeatbeltProfile(policy), ...cmd]
  }
  if (ctx.status.mechanism === 'bwrap') {
    return ['bwrap', ...renderBwrapArgs(policy, { appHome: ctx.appHome }), '--', ...cmd]
  }
  return [...cmd]
}

// ---------------------------------------------------------------------------
// Daemon-level provider: start.ts sets it once (config mode + boot probe);
// the runner derives a per-run ctx from it. Tests never set it → every
// existing spawn stays byte-identical (design D1).
// ---------------------------------------------------------------------------

export interface SandboxProvider {
  mode: SandboxMode
  status: SandboxStatus
  appHome: string
  /**
   * RFC-227 extension seam. OpenCode consumes only the capability receipt and
   * opaque child plan; platform-specific process/path code remains owned by
   * the provider that registers the matching subprocess renderer.
   */
  runtimeContainment?: {
    providerId: string
    capabilities: Readonly<Record<string, 'strong' | 'best-effort' | 'absent'>>
    childProviderPlan?: unknown
  }
  /** Outer-process renderer for a provider not built into RFC-205. */
  wrapCommand?: (cmd: readonly string[], policy: SandboxPolicy) => string[]
}

let provider: SandboxProvider | null = null

export function setSandboxProvider(p: SandboxProvider | null): void {
  provider = p
}

export function getSandboxProvider(): SandboxProvider | null {
  return provider
}

/**
 * Per-run ctx. Worktree allow-scope rule: a multi-repo node's cwd is
 * `worktrees/multi/{taskId}/{repo}` — allow the whole task dir (its siblings
 * are the SAME task's other repos); a single-repo cwd IS the task dir
 * (`worktrees/{slug}/{taskId}`). Detected by "parent dir named after the task".
 */
export function buildRunSandboxCtx(
  p: SandboxProvider | null,
  taskId: string,
  worktreePath: string,
  runDir: string,
): SandboxCtx | undefined {
  if (p === null) return undefined
  const parent = dirname(worktreePath)
  const taskWorktrees = basename(parent) === taskId ? [parent] : [worktreePath]
  // Scratch-space tasks are the one case where the task's BASE repo lives
  // INSIDE appHome (scratch/{taskId}) — an RFC-130 iso worktree's `.git` file
  // points at scratch/{taskId}/.git/worktrees/{runId}, so without this
  // allow-back every git command in the agent's cwd dies EPERM under the
  // appHome-wide deny while file writes still succeed (2026-07-22 task
  // …QGENNV: members declared the workspace unusable and worked in the
  // user's REAL repo instead, which sits outside the boundary). Allow back
  // ONLY the git common dir, NOT the canonical working tree: canonical files
  // are writable solely through the daemon's writeSem merge-back, and an iso
  // agent handed the whole canonical tree could race sibling nodes or leave
  // dirt that survives a failed run (RFC-130 boundary; Codex impl-gate P1
  // 2026-07-22). Gated on existence: non-scratch tasks have no such dir, and
  // bwrap `--bind` of a missing source path errors the spawn.
  const scratchGitDir = join(p.appHome, 'scratch', taskId, '.git')
  if (existsSync(scratchGitDir) && !taskWorktrees.includes(scratchGitDir)) {
    taskWorktrees.push(scratchGitDir)
  }
  return {
    mode: p.mode,
    status: p.status,
    appHome: p.appHome,
    taskWorktrees,
    runDir,
    ...(p.wrapCommand === undefined ? {} : { wrapCommand: p.wrapCommand }),
  }
}
