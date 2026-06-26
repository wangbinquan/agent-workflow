// RFC-098 WP-8 (scheduler audit S-15) — process-tree governance primitives.
//
// `isProcessAlive` moved here from util/lock.ts (still re-exported there for
// the daemon single-instance lock callers) so service-level pid governance —
// orphan reaping (services/orphans.ts), resume/retry pre-rollback kills
// (services/task.ts) and the runner's kill escalation (services/runner.ts) —
// shares one liveness / kill vocabulary without importing the lock module.

export type KillTreeSignal = 'SIGTERM' | 'SIGKILL'

/** True iff `pid` is a live process this user can signal (or at least exists). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    // EPERM means the process exists but we don't have permission to signal it.
    return e.code === 'EPERM'
  }
}

/**
 * Best-effort kill of `pid`'s WHOLE process group. The runner spawns opencode
 * with `detached: true` (POSIX `setsid()` → the child is its own group
 * leader), so `process.kill(-pid, sig)` reaches grandchildren too — the
 * docker-MCP / shell-tool descendants that a single-pid SIGKILL would orphan.
 * Falls back to a single-pid kill when the group signal fails (ESRCH after
 * exit, EPERM, or a pre-RFC-098 pid that is not a group leader). Returns
 * false when no signal could be delivered at all.
 */
export function killProcessTree(pid: number, signal: KillTreeSignal): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}

/**
 * PID-reuse noise gate 1: node_runs rows whose `startedAt` is older than this
 * window are never killed — after 48h the OS has very likely recycled the pid
 * onto an unrelated process.
 */
export const STALE_RUN_PID_MAX_AGE_MS = 48 * 3_600_000

/**
 * PID-reuse noise gate 2: `ps -p <pid> -o command=` must look like one of our
 * children (the real `opencode` binary, or `bun` running a test fixture /
 * source checkout). Anything else ⟹ the pid was recycled; leave it alone.
 */
export function pidCommandLooksLikeAgentChild(pid: number): boolean {
  try {
    const res = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='])
    if (res.exitCode !== 0) return false
    return /opencode|bun/i.test(res.stdout.toString())
  } catch {
    return false
  }
}

/**
 * RFC-108 T9 (AR-14): the SPECIFIC variant — does the live pid's `ps` command
 * contain the EXACT binary path we spawned for this run? This distinguishes
 * "our child is still alive" from "the pid was recycled onto an unrelated
 * process" far more reliably than the fuzzy `/opencode|bun/` regex (which a
 * recycled pid running any `bun`/`opencode` would also match). Substring match
 * keeps it portable across macOS/Linux `ps`.
 */
export function pidCommandContainsBinary(pid: number, binaryPath: string): boolean {
  try {
    const res = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='])
    if (res.exitCode !== 0) return false
    return res.stdout.toString().includes(binaryPath)
  } catch {
    return false
  }
}

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
 * fresh attempt. Both PID-reuse noise gates (startedAt window + `ps` command
 * shape) must pass before any signal is sent. Best-effort by contract — the
 * caller proceeds with its rollback / status flip regardless of the outcome.
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
