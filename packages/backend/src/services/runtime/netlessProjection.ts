// RFC-224 / RFC-242 — the SINGLE path-projection authority for every sealed
// no-network child boundary (`sealedSubprocess.ts` manifests), shared by the
// verified OpenCode plan and the Claude Code local-MCP fence.
//
// Why one module. Everything a manifest lists under `worktreePath` /
// `scratchPath` / `gitCommonDirs` becomes a WRITABLE allow-back that is applied
// AFTER the realHome/appHome masks — i.e. any path that reaches these functions
// is, by construction, an exception to the containment boundary. RFC-242's
// adversarial review found a second copy of the Git projection in
// `claudeCode/netlessMcp.ts` that had dropped three of the original's checks,
// which let an attacker-writable `.git` pointer inside the agent's own worktree
// name an arbitrary external directory and have the platform grant the fenced
// child write access to it. Two copies of a boundary rule drift; there is now
// exactly one.
//
// The two invariants every helper here enforces:
//   1. never follow a symlink into an allow-back — an attacker who can create a
//      link inside a writable subtree must not be able to redirect the next
//      run's boundary;
//   2. a path that Git (or the caller) merely REPORTS is not yet trusted — it
//      must canonicalize to itself and, when it points outside the worktree,
//      the worktree must be registered in it.

import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runGit } from '@/util/git'
import { executionIdentityFailure } from './opencode/failure'

/** Path-segment charset for a directory this module creates under a seal root. */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** `path` is `root` itself or a descendant of it (lexical, both canonical). */
export function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Absolute, NUL-free, lexically normalized — the shape every boundary path must have. */
export function isLexicallyCanonical(path: string): boolean {
  return isAbsolute(path) && !path.includes('\0') && resolve(path) === path
}

/**
 * Canonicalize an EXISTING directory the daemon owns (run root, worktree,
 * appHome). The final component must not itself be a symlink — following one
 * would let whoever can write the parent redirect the boundary — but symlinked
 * ANCESTORS are resolved, because the platform's own roots legitimately live
 * under them (macOS `/var` → `/private/var`).
 */
export async function canonicalNetlessDirectory(path: string): Promise<string> {
  if (!isLexicallyCanonical(path)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const metadata = await lstat(path).catch(() => null)
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const canonical = await realpath(path)
  if (!isLexicallyCanonical(canonical)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return canonical
}

/**
 * Create (or re-open) a private 0700 directory at `<canonicalRoot>/<segments…>`
 * WITHOUT ever following a link, and prove the result is still under that root.
 *
 * This is the re-entry fence. A node run that is resumed inline (clarify)
 * reuses its run root, so the previous run's model-controlled child had write
 * access to the scratch subtree and could replace `home` / `tmp` with a symlink
 * pointing anywhere. `mkdir(…, {recursive:true})` accepts such a link and
 * `realpath` then happily reports the external target, which the manifest would
 * publish as HOME/TMPDIR — and `netlessWritableSubtrees` grants those write
 * access after the masks. Fail closed instead: a symlink here is tampering, not
 * a state to repair.
 */
export async function ensurePrivateNetlessDirectory(
  canonicalRoot: string,
  ...segments: readonly string[]
): Promise<string> {
  if (!isLexicallyCanonical(canonicalRoot) || segments.length === 0) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  let cursor = canonicalRoot
  for (const segment of segments) {
    if (!SAFE_SEGMENT_RE.test(segment)) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    cursor = join(cursor, segment)
    // Non-recursive on purpose: every level is verified as it is created.
    await mkdir(cursor, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const metadata = await lstat(cursor)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    await chmod(cursor, 0o700)
  }
  // Belt and braces: even with every level lstat-checked, prove the whole path
  // resolves to itself before it can become an allow-back.
  if ((await realpath(cursor)) !== cursor) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return cursor
}

/**
 * A `.git` pointer file is writable from inside the agent's own worktree, so
 * Git will faithfully report whatever repository that pointer names. Never turn
 * an arbitrary valid repository into a writable allow-back: the common dir must
 * also register THIS exact canonical worktree.
 */
export async function assertRegisteredGitWorktree(canonicalRepo: string): Promise<void> {
  const listed = await runGit(canonicalRepo, ['worktree', 'list', '--porcelain', '-z'])
  if (listed.exitCode !== 0) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  for (const record of listed.stdout.split('\0')) {
    if (!record.startsWith('worktree ')) continue
    const registeredPath = record.slice('worktree '.length)
    if (!isLexicallyCanonical(registeredPath)) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    const metadata = await lstat(registeredPath).catch(() => null)
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) continue
    if ((await realpath(registeredPath)) === canonicalRepo) return
  }
  return executionIdentityFailure('execution-identity-store-unsafe')
}

export interface NetlessGitProjectionInput {
  /** Runner-owned repo topology. `undefined` = unit fixtures predating it. */
  repoWorktreePaths: readonly string[] | undefined
  /** Canonical cwd of the fenced child; must be one of the repos above. */
  primaryWorktree: string
  /**
   * What to do when Git cannot describe a repo AT ALL (non-zero exit / empty
   * output): `fail-closed` is the verified OpenCode plan, whose worktrees are
   * always real repositories. `skip-projection` only ever REMOVES an allow-back
   * — the child loses a git capability, never gains reach — so the Claude fence
   * uses it to keep a non-git scratch worktree runnable.
   *
   * It is NOT a tolerance for a REPORTED common dir: once Git names one, every
   * check below is mandatory on both runtimes.
   */
  undescribableRepo: 'fail-closed' | 'skip-projection'
}

/**
 * Resolve only daemon-owned Git metadata projections. The child boundary
 * already exposes each worktree's files, but a linked worktree keeps objects,
 * refs, index and config in an external common dir hidden by the appHome/HOME
 * masks — without this projection every child `git` call fails.
 *
 * Asking Git avoids parsing the attacker-controlled `.git` pointer text
 * ourselves, but Git's ANSWER is derived from that same attacker-controlled
 * text, so the answer is validated: lexically canonical, not a symlink, equal
 * to its own realpath, and — when it lands outside the worktree — registering
 * this worktree.
 */
export async function resolveNetlessGitCommonDirs(
  input: NetlessGitProjectionInput,
): Promise<string[]> {
  if (input.repoWorktreePaths === undefined) return []
  if (input.repoWorktreePaths.length === 0 || input.repoWorktreePaths.length > 64) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }

  const canonicalRepos: string[] = []
  const commonDirs: string[] = []
  for (const repoPath of input.repoWorktreePaths) {
    if (!isLexicallyCanonical(repoPath)) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    const metadata = await lstat(repoPath).catch(() => null)
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const canonicalRepo = await realpath(repoPath)
    canonicalRepos.push(canonicalRepo)

    const common = await runGit(canonicalRepo, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    const reportedCommonDir = common.stdout.trim()
    if (common.exitCode !== 0 || reportedCommonDir.length === 0) {
      if (input.undescribableRepo === 'skip-projection') continue
      return executionIdentityFailure('execution-identity-source-changed')
    }
    if (!isLexicallyCanonical(reportedCommonDir)) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const commonMetadata = await lstat(reportedCommonDir).catch(() => null)
    if (
      commonMetadata === null ||
      commonMetadata.isSymbolicLink() ||
      !commonMetadata.isDirectory()
    ) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const canonicalCommonDir = await realpath(reportedCommonDir)
    if (canonicalCommonDir !== reportedCommonDir) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    if (!contained(canonicalRepo, canonicalCommonDir)) {
      await assertRegisteredGitWorktree(canonicalRepo)
    }
    commonDirs.push(canonicalCommonDir)
  }
  if (!canonicalRepos.includes(input.primaryWorktree)) {
    return executionIdentityFailure('execution-identity-source-changed')
  }

  // Only EXTERNAL common dirs need projecting: a plain clone keeps `.git`
  // inside a worktree that is already bound. Sorted + deduped because the
  // manifest rejects repeats outright.
  return [
    ...new Set(
      commonDirs.filter(
        (commonDir) => !canonicalRepos.some((repoPath) => contained(repoPath, commonDir)),
      ),
    ),
  ].sort()
}
