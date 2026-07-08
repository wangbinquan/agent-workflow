// util/platform.ts — the SINGLE source of platform branching for the daemon.
//
// RFC-windows PR-1: every `process.platform === 'win32'` check in the business
// layer must live here (or in runtime/wsl-opencode/). Callers in runner /
// scheduler / routes / services call these primitives and never inspect the
// platform themselves — same discipline as RFC-143's "判别归零" rule, applied
// to the OS axis. Source-text lock in tests/platform.test.ts guards this.
//
// POSIX behaviour is byte-for-byte identical to the pre-RFC-windows implementations
// that lived in util/process.ts (which now delegates here). Windows branches
// realise the same semantics via Job-Object-equivalent / wmic / taskkill
// mechanisms — see design/RFC-windows-windows-adaptation/design.md §3.

import { cpSync, lstatSync, symlinkSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** True iff the daemon is running under Windows. */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

// ─────────────────────────────────────────────────────────────────────────────
// External-skill linking (RFC-windows PR-2 T8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Link an external skill's source dir into the per-run skills dir.
 *
 * - POSIX: `symlinkSync(target, dst, 'dir')` (byte-for-byte original) — IO
 *   economy, the per-run dir just holds a pointer to the source tree.
 * - Windows: directory **junction** (`symlinkSync(target, dst, 'junction')`)
 *   — junctions do NOT require Developer Mode or admin privileges the way dir
 *   symlinks do. File targets (rare for skills, which are dirs) fall back to a
 *   recursive copy, same as a managed skill.
 */
export function linkSkillDir(target: string, dst: string): void {
  if (isWindows()) {
    try {
      const st = lstatSync(target)
      if (st.isDirectory()) {
        symlinkSync(target, dst, 'junction')
        return
      }
    } catch {
      // target missing — fall through to copy, which throws a clear ENOENT.
    }
    cpSync(target, dst, { recursive: true })
    return
  }
  symlinkSync(target, dst, 'dir')
}

// ─────────────────────────────────────────────────────────────────────────────
// file:// plugin spec (RFC-windows PR-2 T7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a `file://` URL from an absolute filesystem path.
 *
 * Cross-platform correct via `node:url.pathToFileURL`: POSIX `/x/y` →
 * `file:///x/y`; Windows `C:\x\y` → `file:///C:/x/y`. Replaces the pre-RFC
 * string concat `` `file://${path}` `` which produced a malformed
 * `file://C:\…` on Windows. On POSIX the output is identical to the concat for
 * absolute paths, so opencode's `OPENCODE_CONFIG_CONTENT` golden lock stays
 * byte-for-byte green.
 */
export function toFileUrl(path: string): string {
  return pathToFileURL(path).href
}

/**
 * Resolve a `file://` URL (or pass through a plain path) to a filesystem path.
 *
 * `node:url.fileURLToPath` handles the Windows `file:///C:/x/y` → `C:\x\y`
 * mapping that `new URL(spec).pathname` got wrong (`/C:/x/y`). Specs that don't
 * start with `file:` are returned verbatim.
 *
 * Never throws: `fileURLToPath` requires a platform-valid absolute path, so it
 * throws on Windows for a `file:///aw/x` spec with no drive (which appears in
 * test fixtures and in opencode log lines echoing a non-Windows-path spec).
 * When that happens we fall back to the pre-RFC pure-string strip
 * (`spec.replace(/^file:\/\//, '')`) — cross-platform, lossy but sufficient
 * for the suffix-match the caller (detectPluginLoadFailure) does.
 */
export function fromFileUrl(spec: string): string {
  if (!spec.startsWith('file:')) return spec
  try {
    return fileURLToPath(spec)
  } catch {
    return spec.replace(/^file:\/\//, '')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Long paths (RFC-windows PR-2 T10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prefix a Windows path with `\\?\` to bypass the 260-char MAX_PATH limit.
 *
 * Only applies on Windows; on POSIX the path is returned unchanged. Already-
 * prefixed paths and UNC paths are handled. Callers should use this when
 * constructing deep worktree / run dirs. Note: the daemon manifest should also
 * declare `longPathAware` (PR-5) so the loader respects long paths without the
 * prefix; this helper is the belt-and-suspenders for paths the daemon passes to
 * child processes / native APIs.
 */
export function toLongPath(p: string): string {
  if (!isWindows()) return p
  if (p.startsWith('\\\\?\\')) return p
  const norm = p.replace(/\//g, '\\')
  // Drive path: C:\… → \\?\C:\…
  if (/^[A-Za-z]:\\/.test(norm)) return `\\\\?\\${norm}`
  // UNC: \\server\share\… → \\?\UNC\server\share\…
  if (norm.startsWith('\\\\')) return `\\\\?\\UNC\\${norm.slice(2)}`
  return p
}

// ─────────────────────────────────────────────────────────────────────────────
// Liveness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True iff `pid` is a live process this user can signal (or at least exists).
 * Cross-platform: `process.kill(pid, 0)` works on both POSIX and Windows
 * (EPERM ⇒ exists but unowned, ESRCH ⇒ gone).
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Process-tree kill
// ─────────────────────────────────────────────────────────────────────────────

export type KillTreeSignal = 'SIGTERM' | 'SIGKILL'

/**
 * Best-effort kill of `pid`'s WHOLE process tree.
 *
 * - POSIX: the runner spawns opencode with `detached: true` (setsid() → the
 *   child is its own group leader), so `process.kill(-pid, sig)` reaches
 *   grandchildren too. Falls back to a single-pid kill when the group signal
 *   fails. Byte-for-byte identical to the pre-RFC-windows implementation.
 * - Windows: there are no process groups / setsid. `taskkill /T /F /PID` kills
 *   the whole tree (the closest equivalent without a kernel Job Object).
 *   Job-Object hardening for grandchildren that detach from the tree is
 *   tracked as future work (design §3.1 / §9); `/T` is sufficient for the
 *   common case and ships without a native addon.
 */
export function killProcessTree(pid: number, signal: KillTreeSignal): boolean {
  if (isWindows()) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    // Windows ignores the `signal` argument — there is no graceful SIGTERM, so
    // both SIGTERM and SIGKILL map to a forced tree kill. The runner's
    // SIGTERM→SIGKILL escalation is a no-op escalation on Windows (by design:
    // graceful shutdown goes through the HTTP /shutdown channel instead, see
    // design §3.2). We still honour the call for parity with the POSIX API.
    try {
      const res = Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)])
      return res.exitCode === 0
    } catch {
      return false
    }
  }

  // POSIX (byte-for-byte original).
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

// ─────────────────────────────────────────────────────────────────────────────
// PID command-line fingerprint (stale-process identity gate, RFC-108 T9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The raw command-line string of `pid`, or null if it cannot be obtained.
 *
 * - POSIX: `ps -p <pid> -o command=` (byte-for-byte original).
 * - Windows: `wmic process where ProcessId=<pid> get CommandLine` (present on
 *   Win7+, deprecated on new Win11 but still shipped) with a PowerShell
 *   `Get-CimInstance Win32_Process` fallback.
 */
export function pidCommandLine(pid: number): string | null {
  if (isWindows()) {
    // 1. wmic (broad compatibility).
    try {
      const res = Bun.spawnSync([
        'wmic',
        'process',
        'where',
        `ProcessId=${pid}`,
        'get',
        'CommandLine',
        '/format:list',
      ])
      if (res.exitCode === 0) {
        const out = res.stdout.toString()
        // /format:list → "CommandLine=<...>\r\n"
        const m = out.match(/CommandLine=(.*)/)
        const cmd = m?.[1]
        if (typeof cmd === 'string' && cmd.trim().length > 0) return cmd.trim()
      }
    } catch {
      /* fall through to PowerShell */
    }
    // 2. PowerShell CIM fallback (wmic absent / future Win deprecation).
    try {
      const res = Bun.spawnSync([
        'powershell',
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ])
      if (res.exitCode === 0) {
        const out = res.stdout.toString().trim()
        if (out.length > 0) return out
      }
    } catch {
      /* give up */
    }
    return null
  }

  // POSIX (byte-for-byte original).
  try {
    const res = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='])
    if (res.exitCode !== 0) return null
    return res.stdout.toString()
  } catch {
    return null
  }
}

/**
 * RFC-108 T9 fuzzy gate: does the live pid's command look like one of our
 * children (the real `opencode` binary, or `bun` running a test fixture /
 * source checkout)? POSIX: `/opencode|bun/i` over `ps` output (original).
 * Windows: same regex over the wmic/CIM command line.
 */
export function pidCommandLooksLikeAgentChild(pid: number): boolean {
  const cmd = pidCommandLine(pid)
  if (cmd === null) return false
  return /opencode|bun/i.test(cmd)
}

/**
 * RFC-108 T9 SPECIFIC gate: does the live pid's command contain the EXACT
 * binary path we spawned for this run? POSIX: case-sensitive `.includes`
 * (original). Windows: case-insensitive — Windows paths are case-insensitive
 * and the path wmic echoes back may differ in case / separator from the spawn
 * argument, so a case-sensitive match would falsely report 'command-mismatch'
 * (recycled pid) for our own child.
 */
export function pidCommandContainsBinary(pid: number, binaryPath: string): boolean {
  const cmd = pidCommandLine(pid)
  if (cmd === null) return false
  if (isWindows()) {
    // Normalise backslashes to a common separator and compare case-insensitively.
    const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/')
    return norm(cmd).includes(norm(binaryPath))
  }
  return cmd.includes(binaryPath)
}
