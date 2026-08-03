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
  /**
   * RFC-251 — subtrees inside the denied appHome that must be READABLE but
   * never writable, and which are NOT nested below any RW allow-back.
   *
   * `readOnlySubtrees` cannot express this: it is an RO hole punched inside an
   * RW allow (and is validated as a strict descendant of one). The plugin cache
   * has no RW parent by design — the whole appHome is denied and plugins must
   * never be writable by the model — so it needs its own read-only allow-back.
   */
  readOnlyAllowSubtrees?: readonly string[]
  /**
   * RFC-253 — deny ALL network access for the contained process.
   *
   * Off by default: the outer sandbox has never restricted the network (this
   * was verified, not assumed — neither renderer emitted a single network
   * rule before this flag), and turning it on unconditionally would break
   * every agent that reaches a model API.
   */
  networkDeny?: boolean
  /**
   * RFC-253 — the process may READ the task worktrees and the git mirror but
   * must not write either.
   *
   * A read-only script node skips the isolated worktree entirely and runs
   * against the canonical tree, so "read-only" cannot be a convention the
   * script is trusted to honour — without this the canonical worktree is a
   * read-WRITE allow-back and a `readonly: true` node is strictly more
   * dangerous than a normal one (it writes canonical with no merge-back
   * discipline). The git mirror travels with it: leaving `repos` writable
   * would still allow `git update-ref` and repo-config writes.
   */
  readOnlyWorktrees?: boolean
}

export interface SandboxPolicy {
  /** Deny read+write on these whole subtrees. */
  denySubtrees: string[]
  /** Deny read+write on these single files (literal paths). */
  denyFiles: string[]
  /** Allowed back INSIDE denied subtrees (must win over the denies). */
  allowSubtrees: string[]
  /** Literal ancestor directories needed only for symlink-safe path traversal. */
  allowMetadataFiles: string[]
  /** Read-only overlays applied after every read-write allow-back. */
  readOnlySubtrees: string[]
  /** RFC-251 — read-only allow-backs that have no RW parent (e.g. plugin cache). */
  readOnlyAllowSubtrees: string[]
  /** RFC-253 — render a total network fence for this process. */
  networkDeny: boolean
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

function metadataAncestors(parent: string, child: string): string[] {
  if (!isStrictDescendant(parent, child)) return []
  const components = relative(parent, child).split(sep).filter(Boolean)
  const ancestors = [parent]
  let cursor = parent
  for (const component of components.slice(0, -1)) {
    cursor = join(cursor, component)
    ancestors.push(cursor)
  }
  return ancestors
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
  //
  // RFC-253: a read-only consumer keeps ONLY its private run dir writable; the
  // worktrees and the mirror move to the read-only allow-back list below.
  const readOnlyWorktrees = input.readOnlyWorktrees === true
  const allowSubtrees = readOnlyWorktrees
    ? [input.runDir]
    : [...input.taskWorktrees, input.runDir, join(h, 'repos')]
  // Seatbelt's appHome-wide deny also blocks lstat/realpath on parent
  // directories. The verified store boundary deliberately walks every
  // ancestor to reject symlink substitution, so restore metadata access to
  // those exact literals only. This does not grant directory enumeration,
  // file contents, or writes, and bwrap does not consume this field.
  const allowMetadataFiles = [
    ...new Set(allowSubtrees.flatMap((path) => metadataAncestors(h, path))),
  ]
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
  // RFC-251: read-only allow-backs stand on their own — they must live INSIDE a
  // denied subtree (otherwise they are already reachable and the entry is
  // meaningless noise) and must not overlap an RW allow (which would silently
  // grant write on linux, where the later RW bind wins).
  const readOnlyAllowSubtrees = [
    ...(input.readOnlyAllowSubtrees ?? []),
    ...(readOnlyWorktrees ? [...input.taskWorktrees, join(h, 'repos')] : []),
  ]
  const seenReadOnlyAllow = new Set<string>()
  for (const path of readOnlyAllowSubtrees) {
    validatePolicyPath(path, 'readOnlyAllowSubtree')
    if (seenReadOnlyAllow.has(path)) throw new TypeError('duplicate sandbox readOnlyAllowSubtree')
    seenReadOnlyAllow.add(path)
    if (!denySubtrees.some((denied) => isStrictDescendant(denied, path))) {
      throw new TypeError('sandbox readOnlyAllowSubtree must be nested below a denied subtree')
    }
    if (allowSubtrees.some((allowed) => allowed === path || isStrictDescendant(allowed, path))) {
      throw new TypeError('sandbox readOnlyAllowSubtree must not overlap a read-write allow')
    }
  }
  return {
    denySubtrees,
    denyFiles,
    allowSubtrees,
    allowMetadataFiles,
    readOnlySubtrees,
    readOnlyAllowSubtrees,
    networkDeny: input.networkDeny === true,
  }
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
  for (const p of policy.allowMetadataFiles) {
    lines.push(`(allow file-read-metadata (literal ${sbplString(p)}))`)
  }
  // A read-only subtree is nested below an allow-back. Seatbelt is
  // last-match-wins per operation, so revoke write after every RW allow, then
  // restore read after the appHome-wide deny.
  for (const p of policy.readOnlySubtrees) {
    lines.push(`(deny file-write* (subpath ${sbplString(p)}))`)
    lines.push(`(allow file-read* (subpath ${sbplString(p)}))`)
  }
  // RFC-251: read-only allow-back with no RW parent. Restore READ only — write
  // stays covered by the enclosing appHome deny above, and we never emit an
  // allow for it, so last-match-wins leaves writes denied.
  for (const p of policy.readOnlyAllowSubtrees) {
    lines.push(`(allow file-read* (subpath ${sbplString(p)}))`)
  }
  // RFC-253 — total network fence. MUST be last: SBPL is last-match-wins and
  // the profile opens with `(allow default)`, so a deny emitted earlier would
  // be overridden by nothing here but would be fragile against any future rule
  // appended below it. `network*` covers network-outbound/inbound/bind.
  if (policy.networkDeny) {
    lines.push('(deny network*)')
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
  // RFC-253 — total network fence.
  //
  // `--unshare-net` alone is NOT enough: it isolates the network namespace,
  // which covers ABSTRACT unix sockets, while PATHNAME sockets are governed by
  // the mount namespace. `--bind / /` maps the host root in, so without the two
  // tmpfs mounts below a "netless" process could still reach the session D-Bus
  // (`/run/user/<uid>/bus`, which can execute commands via systemd) or
  // `/var/run/docker.sock`. Masking those two directories closes the local-RPC
  // side door. This remains a best-effort boundary — the root is still bound —
  // and the RFC says so rather than claiming full isolation.
  if (policy.networkDeny) {
    args.push('--unshare-net', '--tmpfs', '/run', '--tmpfs', '/var/run')
  }
  args.push('--tmpfs', opts.appHome)
  // The mirrors dir is an allow in spirit but lives OUTSIDE the deny list on
  // darwin (deny-list model) — on linux the tmpfs hides it, so bind it back.
  //
  // RFC-253: when the policy moved the mirror to the read-only list, binding it
  // read-write here would undo that below — the ro-bind loop runs after this
  // one, but re-binding the same path read-write first is exactly the mount
  // ordering trap this file warns about. Skip it and let the ro-bind provide it.
  const mirrorDir = join(opts.appHome, 'repos')
  if (!policy.readOnlyAllowSubtrees.includes(mirrorDir)) {
    args.push('--bind', mirrorDir, mirrorDir)
  }
  for (const p of policy.allowSubtrees) {
    args.push('--bind', p, p)
  }
  // Mount ordering is the security boundary: a RO overlay must be stacked
  // after every enclosing RW bind or a later RW mount would silently undo it.
  for (const p of policy.readOnlySubtrees) {
    args.push('--ro-bind', p, p)
  }
  // RFC-251: read-only allow-backs from under the appHome tmpfs. Without these
  // the plugin cache simply does not exist inside the namespace and every
  // `file://<cachedPath>` import fails with ENOENT (confirmed on real Linux
  // with bubblewrap 0.11.0). `computeSandboxPolicy` already rejects overlap
  // with an RW allow, so ordering against those binds cannot matter here.
  for (const p of policy.readOnlyAllowSubtrees) {
    args.push('--ro-bind', p, p)
  }
  return args
}
