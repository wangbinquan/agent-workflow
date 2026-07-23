// RFC-205 — sandbox policy: the single source of truth for what an agent
// process may touch inside ~/.agent-workflow, rendered per mechanism.
//
// Threat model (proposal §1): an agent runs at the daemon's uid, so without an
// OS boundary it can read secret.key (A1), db.sqlite (A2), backups/ (A3), the
// mirror origin credential (A4 — killed separately by G1 un-disking), and every
// OTHER task's worktree/run dir (A5). The policy denies the platform home
// wholesale and allows back exactly what THIS task's agent legitimately needs:
//
//   - its own worktree(s)      (read-write — that's the job)
//   - its own run dir          (read-write — config dir, transcripts, inventory)
//   - the mirror repos dir     (read-write — the worktree's gitdir/index lives
//     in <mirror>/.git/worktrees/<id>/ and commits write .git/objects + refs;
//     read-only here would break `git commit` (design Q4). Credential safety
//     comes from G1: nothing secret is ON DISK in the mirror anymore.)
//
// skills/ is NOT allowed back: managed skills are copied into the run dir
// before spawn and external skills no longer exist (RFC-178) — the agent has
// zero runtime dependency on the source dir (design Q5).
//
// Everything outside appHome ($HOME auth baselines, /tmp, toolchains) stays
// untouched — this is a targeted boundary, not a jail.

import { isAbsolute, join, normalize, relative, sep } from 'node:path'

export interface SandboxPolicyInput {
  /** ~/.agent-workflow (or the test appHome). */
  appHome: string
  /** THIS task's worktree roots (multi-repo tasks have several). */
  taskWorktrees: readonly string[]
  /** THIS run's private dir: runs/{taskId}/{nodeRunId}. */
  runDir: string
  /**
   * Immutable artifacts nested below an allowed subtree. These paths remain
   * readable but must not be replaceable by the sandboxed process.
   */
  readOnlySubtrees?: readonly string[]
}

export interface SandboxPolicy {
  /** Deny read+write on these whole subtrees. */
  denySubtrees: string[]
  /** Deny read+write on these single files (literal paths). */
  denyFiles: string[]
  /** Allowed back INSIDE denied subtrees (must win over the denies). */
  allowSubtrees: string[]
  /** Read-only overlays applied after every read-write allow-back. */
  readOnlySubtrees: string[]
}

function isStrictDescendant(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function validatePolicyPath(path: string, label: string): void {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path === '/'
  ) {
    throw new TypeError(`invalid sandbox ${label} path`)
  }
}

/** The one place the deny/allow sets are computed. Pure — no fs access. */
export function computeSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const h = input.appHome
  validatePolicyPath(h, 'appHome')
  validatePolicyPath(input.runDir, 'runDir')
  for (const path of input.taskWorktrees) validatePolicyPath(path, 'taskWorktree')
  // RFC-205 impl-gate P0-3 (Codex 2026-07-22): deny the WHOLE appHome, not an
  // enumerated list. The old list missed `iso/` (RFC-130's REAL agent cwd →
  // cross-task read/write of every OTHER task's isolation tree), the `.gitcred-*`
  // credential leases (plaintext PAT, glob-readable), `scratch/` and `fusions/`.
  // A deny-list is unmaintainable — one new appHome subdir re-opens the hole.
  // Deny everything, then allow back ONLY what THIS run legitimately needs.
  const denySubtrees = [h]
  const denyFiles = [
    // Redundant under the whole-appHome deny, but kept explicit as defense in
    // depth and as documentation of the crown jewels.
    join(h, 'secret.key'), // A1
    join(h, 'db.sqlite'), // A2
    join(h, 'db.sqlite-wal'),
    join(h, 'db.sqlite-shm'),
    join(h, 'token'),
    join(h, 'config.json'),
  ]
  // Allow back: this run's worktree(s) + run dir, and the shared git mirror (the
  // object store git commit reads/writes — credential-free after RFC-204 sealing).
  const allowSubtrees = [...input.taskWorktrees, input.runDir, join(h, 'repos')]
  const readOnlySubtrees = [...(input.readOnlySubtrees ?? [])]
  const unique = new Set<string>()
  for (const path of readOnlySubtrees) {
    validatePolicyPath(path, 'readOnlySubtree')
    if (unique.has(path)) throw new TypeError('duplicate sandbox readOnlySubtree path')
    unique.add(path)
    if (!allowSubtrees.some((allowed) => isStrictDescendant(allowed, path))) {
      throw new TypeError('sandbox readOnlySubtree must be nested below an allowed subtree')
    }
  }
  return { denySubtrees, denyFiles, allowSubtrees, readOnlySubtrees }
}

/** SBPL string literal escaping: backslash and double-quote. */
function sbplString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Render the macOS Seatbelt profile. SBPL evaluates rules LAST-MATCH-WINS, so
 * the order is load-bearing: allow-default, then the denies, then the
 * allow-backs (which must override the denies for their subtrees).
 */
export function renderSeatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = ['(version 1)', '(allow default)']
  const denyTargets = [
    ...policy.denySubtrees.map((p) => `(subpath ${sbplString(p)})`),
    ...policy.denyFiles.map((p) => `(literal ${sbplString(p)})`),
  ]
  for (const t of denyTargets) {
    lines.push(`(deny file-read* file-write* ${t})`)
  }
  for (const p of policy.allowSubtrees) {
    lines.push(`(allow file-read* file-write* (subpath ${sbplString(p)}))`)
  }
  // A read-only subtree is nested below an allow-back. Seatbelt is
  // last-match-wins per operation, so revoke write after every RW allow, then
  // restore read after the appHome-wide deny.
  for (const p of policy.readOnlySubtrees) {
    lines.push(`(deny file-write* (subpath ${sbplString(p)}))`)
    lines.push(`(allow file-read* (subpath ${sbplString(p)}))`)
  }
  return lines.join('\n')
}

/**
 * Render the bwrap argv (everything between `bwrap` and `--`). Order is
 * load-bearing: later mounts stack over earlier ones, so the appHome tmpfs
 * comes first and the allow-back binds after it.
 *
 * `--bind / /` keeps the rest of the filesystem (auth baselines, /tmp,
 * toolchains) read-write; `--dev /dev` restores a usable /dev over the bind;
 * `--tmpfs appHome` masks the platform dir wholesale; then this task's
 * worktrees + run dir + the mirrors dir are bound back read-write. deny FILES
 * need no explicit handling on linux — they live under appHome and the tmpfs
 * already hides them.
 */
export function renderBwrapArgs(policy: SandboxPolicy, opts: { appHome: string }): string[] {
  // RFC-205 impl-gate P0-5 (Codex 2026-07-22): `--bind / /` maps the host root
  // (incl. /proc) into the namespace, so without a private PID namespace + a fresh
  // /proc an agent could read /proc/<daemonPid>/root/.../secret.key or
  // /proc/<daemonPid>/fd/<sqlite-fd> — bypassing the appHome tmpfs entirely.
  // --unshare-pid gives a private PID namespace (bwrap becomes its init/reaper;
  // --die-with-parent + the runner's setsid process-group kill still reap it);
  // --proc mounts a fresh /proc AFTER the bind so it only shows namespace-local PIDs.
  const args = [
    '--die-with-parent',
    '--unshare-pid',
    '--bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
  ]
  args.push('--tmpfs', opts.appHome)
  // The mirrors dir is an allow in spirit but lives OUTSIDE the deny list on
  // darwin (deny-list model) — on linux the tmpfs hides it, so bind it back.
  args.push('--bind', join(opts.appHome, 'repos'), join(opts.appHome, 'repos'))
  for (const p of policy.allowSubtrees) {
    args.push('--bind', p, p)
  }
  // Mount ordering is the security boundary: a RO overlay must be stacked
  // after every enclosing RW bind or a later RW mount would silently undo it.
  for (const p of policy.readOnlySubtrees) {
    args.push('--ro-bind', p, p)
  }
  return args
}
