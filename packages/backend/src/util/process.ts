import { platformSpawnOptionsForHost } from '@/util/platformExec'
import { adoptProcessTree, type ProcessTreeOwnership } from '@/util/windowsJobObject'

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
  // Windows has no POSIX process groups, so use the Job Object / taskkill path.
  if (process.platform === 'win32') return killProcessTreeWin32(pid)
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
 * RFC-254 T4 (design gate P0-D) — the Windows tree-kill path.
 *
 * Preference order, and why:
 *   1. The run's Job Object, when one was adopted at spawn. Termination is
 *      atomic over the whole job, so nothing forked mid-call escapes.
 *   2. `taskkill /T /F` otherwise. That walks a SNAPSHOT of the tree, so a
 *      process spawned during the walk survives, so it remains best-effort.
 *
 * The signal is deliberately not forwarded: Windows draws no SIGTERM/SIGKILL
 * distinction for a non-console child, and the caller's grace window has
 * already elapsed by the time this runs. Upstream OpenCode simplifies the same
 * way (`core/src/shell.ts:35-45`).
 */
function killProcessTreeWin32(pid: number): boolean {
  const owned = ownedTrees.get(pid)
  if (owned !== undefined) {
    owned.terminate()
    ownedTrees.delete(pid)
    return true
  }
  try {
    const res = Bun.spawnSync({
      ...platformSpawnOptionsForHost(),
      cmd: ['taskkill', '/pid', String(pid), '/T', '/F'],
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return res.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Job Objects adopted at spawn, keyed by the pid the caller already knows.
 *
 * Keyed by pid rather than threaded through every spawn site because the kill
 * and liveness paths are pid-keyed already: both `killProcessTree` and the
 * orphan reaper start from a pid read back out of the database.
 */
const ownedTrees = new Map<number, ProcessTreeOwnership>()

/**
 * Adopt a freshly spawned pid into a kill-on-close Job Object (win32 only).
 *
 * Returns true when Job Object ownership is active. False means the caller
 * falls back to enumerative cleanup.
 */
export function adoptSpawnedProcessTree(pid: number): boolean {
  if (process.platform !== 'win32') return false
  const owned = adoptProcessTree(pid)
  if (owned === null) return false
  ownedTrees.set(pid, owned)
  return true
}

export function releaseProcessTreeOwnership(pid: number): void {
  const owned = ownedTrees.get(pid)
  if (owned === undefined) return
  ownedTrees.delete(pid)
  // Dropping the map entry is not enough: `bun:ffi` hands back a bare number,
  // so nothing finalizes the Win32 handle and it would leak for the daemon's
  // whole lifetime — and a KILL_ON_JOB_CLOSE job whose last handle is never
  // closed also never fires. `dispose()` closes it, which for this job kind
  // means "stop tracking AND stop the tree" (see its doc); callers reach here
  // only after the tree is finished.
  owned.dispose()
}

/**
 * Authoritative "is this tree still alive" answer.
 *
 * POSIX: the process group IS the tree, so signalling it with 0 is exact.
 * Windows: the answer is the Job Object's active-process count; WITHOUT a job
 * there is no authoritative answer at all, which is why `null` is a distinct
 * outcome from `false`.
 */
export function isProcessTreeAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (process.platform === 'win32') {
    const owned = ownedTrees.get(pid)
    if (owned === undefined) return null
    const count = owned.liveCount()
    return count === null ? null : count > 0
  }
  try {
    process.kill(-pid, 0)
    return true
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return e.code === 'EPERM'
  }
}

/**
 * PID-reuse noise gate 1: node_runs rows whose `startedAt` is older than this
 * window are never killed — after 48h the OS has very likely recycled the pid
 * onto an unrelated process.
 */
export const STALE_RUN_PID_MAX_AGE_MS = 48 * 3_600_000

/**
 * RFC-254: a process's command line, cross-platform. POSIX uses `ps`; Windows
 * has no `ps` and WMIC is deprecated/removed on newer builds, so it reads the
 * CommandLine via PowerShell CIM. Empty string on any failure (caller decides).
 */
function pidCommandLine(pid: number): string {
  if (process.platform === 'win32') {
    const res = Bun.spawnSync([
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ])
    return res.exitCode === 0 ? res.stdout.toString() : ''
  }
  const res = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='])
  return res.exitCode === 0 ? res.stdout.toString() : ''
}

/**
 * PID-reuse noise gate 2: the pid's command line must look like one of our
 * children (the real `opencode` binary, or `bun` running a test fixture /
 * source checkout). Anything else ⟹ the pid was recycled; leave it alone.
 */
export function pidCommandLooksLikeAgentChild(pid: number): boolean {
  try {
    return /opencode|bun/i.test(pidCommandLine(pid))
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
    // RFC-254: cross-platform command-line read (POSIX `ps` / win32 CIM). Without
    // the win32 path this identity gate was a no-op on Windows (always false), so
    // a recycled PID could be killed as if it were our stale run.
    return pidCommandLine(pid).includes(binaryPath)
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

// ─────────────────────────────────────────────────────────────────────────
// RFC-284 T7（2026-08-12 审计 N20）——「promise vs 定时 fallback」竞速的唯一
// 拼写。此前 util/git.ts 与 gitRepoCache.ts 各持一份逐字相同的 250ms drained
// race（管道排水兜底）。语义与原实现逐字节一致：定时器不 clear、不 unref
// （竞速已决后空转触发无害——保持原语义，勿"顺手优化"）。
export function raceWithFallback<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
}
