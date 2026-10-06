// Shared pure Git version values. Native probing and cache remain in the local facade.

export interface GitSemver {
  major: number
  minor: number
  patch: number
  raw: string
}

export interface GitCapabilities {
  version: GitSemver | null
  /** ≥ 2.13 — required for `git submodule update --jobs N`. */
  supportsSubmoduleJobs: boolean
  /** ≥ 2.5 — required for stable worktree + submodule interaction. */
  supportsRecurseInWorktree: boolean
  /**
   * RFC-130 D7: ≥ 2.38 — required for `git merge-tree --write-tree`, the in-memory
   * 3-way merge that RFC-130's serial merge-back depends on. Below this the daemon
   * refuses isolated execution (fail-loud, not silent corruption).
   */
  supportsMergeTreeWriteTree: boolean
}

/** Parse `git version 2.39.3 (Apple Git-145)` → semver. */
export function parseGitVersion(raw: string): GitSemver | null {
  const m = raw.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = m[3] === undefined ? 0 : Number(m[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null
  }
  return { major, minor, patch, raw: raw.trim() }
}

/** True iff `v` is ≥ the (major, minor) tuple. */
export function gitVersionAtLeast(v: GitSemver | null, major: number, minor: number): boolean {
  if (!v) return false
  if (v.major > major) return true
  if (v.major < major) return false
  return v.minor >= minor
}

export function capabilitiesFromVersion(v: GitSemver | null): GitCapabilities {
  return {
    version: v,
    supportsSubmoduleJobs: gitVersionAtLeast(v, 2, 13),
    supportsRecurseInWorktree: gitVersionAtLeast(v, 2, 5),
    supportsMergeTreeWriteTree: gitVersionAtLeast(v, 2, 38),
  }
}

/**
 * Display floor for user-facing refusal messages. MUST stay in lockstep with
 * the `gitVersionAtLeast(v, 2, 38)` tuple behind `supportsMergeTreeWriteTree`.
 */
export const MIN_GIT_VERSION = '2.38.0'

/**
 * RFC-130 D7 boot gate: `null` when the local git can run
 * `git merge-tree --write-tree` (the in-memory merge-back EVERY node run needs);
 * otherwise the human-readable refusal reason. Pre-2.38 `merge-tree` has no
 * option parsing at all, so on an old host the daemon would boot fine and every
 * task would die AFTER its agent already ran, with the cryptic
 * `merge-back-failed: git merge-tree: usage: git merge-tree <base-tree> ...`.
 */
export function mergeTreeGateError(caps: GitCapabilities): string | null {
  if (caps.supportsMergeTreeWriteTree) return null
  const found = caps.version?.raw ?? 'git not found or `git --version` failed'
  return (
    `git >= ${MIN_GIT_VERSION} is required — isolated merge-back runs ` +
    `\`git merge-tree --write-tree\` (RFC-130 D7); found: ${found}`
  )
}
