// RFC-098 WP-8 (scheduler audit S-15) — process-tree governance primitives.
// RFC-windows PR-1 — platform branching moved to util/platform.ts (single source);
// this module keeps its public API stable (callers in services/* import from
// here) and delegates the primitives that differ by OS. POSIX behaviour is
// byte-for-byte identical to the pre-RFC-windows implementation.

// Re-export the platform primitives so existing callers keep their import path
// (`@/util/process`). The implementations live in util/platform.ts.
export {
  isProcessAlive,
  killProcessTree,
  pidCommandLooksLikeAgentChild,
  pidCommandContainsBinary,
  pidCommandLine,
  isWindows,
} from './platform'
export type { KillTreeSignal } from './platform'
import {
  isProcessAlive,
  killProcessTree,
  pidCommandLooksLikeAgentChild,
  pidCommandContainsBinary,
} from './platform'

/**
 * PID-reuse noise gate 1: node_runs rows whose `startedAt` is older than this
 * window are never killed — after 48h the OS has very likely recycled the pid
 * onto an unrelated process.
 */
export const STALE_RUN_PID_MAX_AGE_MS = 48 * 3_600_000

export type StaleRunKillOutcome =
  | 'no-pid'
  | 'not-alive'
  | 'window-expired'
  | 'command-mismatch'
  | 'killed'
  | 'kill-failed'

export interface StaleRunKillOpts {
  /** Override Date.now() for the startedAt window check (tests). */
  now?: number
  /** Bounded SIGTERM grace before the SIGKILL escalation. Default 1s. */
  termWaitMs?: number
}

/**
 * Kill-then-proceed governance for a stale node_runs row (RFC-098 WP-8):
 * when the row's recorded child process is still alive, group-kill it
 * (SIGTERM → bounded wait → SIGKILL) so a survivor from a previous daemon
 * cannot keep writing into a worktree we are about to roll back / hand to a
 * fresh attempt. Both PID-reuse noise gates (startedAt window + command
 * shape) must pass before any signal is sent. Best-effort by contract — the
 * caller proceeds with its rollback / status flip regardless of the outcome.
 *
 * RFC-windows: the per-platform kill mechanism (POSIX group-kill / Windows
 * taskkill tree) and the command-fingerprint lookup (ps / wmic) are delegated
 * to util/platform.ts; this orchestrator is platform-agnostic.
 */
export async function killStaleRunProcessTree(
  run: { pid: number | null; startedAt: number | null; spawnBinaryPath?: string | null },
  opts: StaleRunKillOpts = {},
): Promise<StaleRunKillOutcome> {
  const pid = run.pid
  if (typeof pid !== 'number' || pid <= 0) return 'no-pid'
  if (!isProcessAlive(pid)) return 'not-alive'
  const now = opts.now ?? Date.now()
  // The startedAt window is the TIME-based PID-reuse guard and ALWAYS applies
  // (Codex T9 review P1): after the window, the OS has likely recycled the pid,
  // so we never signal — `spawn_binary_path` is NOT a unique identity (cmd[0] may
  // be a bare `opencode` PATH lookup, or an absolute binary SHARED by concurrent
  // tasks), and skipping the window here could SIGKILL an unrelated recycled pid.
  if (typeof run.startedAt !== 'number' || now - run.startedAt >= STALE_RUN_PID_MAX_AGE_MS) {
    return 'window-expired'
  }
  // RFC-108 T9 (AR-14): command-shape gate. When we recorded the spawn binary,
  // match the live pid's command against THAT exact path (more specific than the
  // fuzzy `/opencode|bun/` regex — fewer false "our child" verdicts on an
  // in-window pid running some other bun/opencode). Mismatch ⟹ recycled pid
  // (safe → 'command-mismatch'); match ⟹ ours → kill. A 'kill-failed' from here
  // is the DANGER signal callers act on (refuse the resume rather than git-reset
  // under a live writer).
  const matchesShape =
    typeof run.spawnBinaryPath === 'string' && run.spawnBinaryPath.length > 0
      ? pidCommandContainsBinary(pid, run.spawnBinaryPath)
      : pidCommandLooksLikeAgentChild(pid)
  if (!matchesShape) return 'command-mismatch'

  killProcessTree(pid, 'SIGTERM')
  const termWaitMs = opts.termWaitMs ?? 1_000
  const termDeadline = Date.now() + termWaitMs
  while (Date.now() < termDeadline) {
    if (!isProcessAlive(pid)) return 'killed'
    await Bun.sleep(50)
  }
  killProcessTree(pid, 'SIGKILL')
  const killDeadline = Date.now() + 500
  while (Date.now() < killDeadline) {
    if (!isProcessAlive(pid)) return 'killed'
    await Bun.sleep(50)
  }
  return 'kill-failed'
}
