// RFC-034: probe `git --version` once at daemon start and cache the result so
// callers (gitRepoCache cold/warm paths, createWorktree) can decide whether
// `--jobs` and worktree-in-submodule are safe on the local git binary.
//
// Why: `git submodule --jobs` is stable from 2.13; worktree + submodule
// interaction is stable from 2.5. Older git is rare on macOS/Linux dev
// machines but the platform must not crash hard when it shows up.

import { runGit } from '@/util/git'
import type { GitCapabilities, GitSemver } from '@/platform/contracts/gitVersion'
import { capabilitiesFromVersion, parseGitVersion } from '@/platform/contracts/gitVersion'
export type { GitCapabilities, GitSemver } from '@/platform/contracts/gitVersion'
export {
  capabilitiesFromVersion,
  gitVersionAtLeast,
  MIN_GIT_VERSION,
  mergeTreeGateError,
  parseGitVersion,
} from '@/platform/contracts/gitVersion'

let cached: GitCapabilities | null = null

/** Run `git --version`, parse, cache. Idempotent — call multiple times safely. */
/** RFC-208: the platform-level git boot probe must be finite. */
export const GIT_PROBE_TIMEOUT_MS = 20_000

export async function detectGitCapabilities(): Promise<GitCapabilities> {
  let v: GitSemver | null = null
  try {
    // runGit(cwd, ['--version']) is fine — git ignores -C for --version
    //
    // RFC-208: bounded. This runs at boot while the daemon holds the PID lock,
    // so a hanging git wrapper wedges startup exactly the way a hanging
    // external wrapper does — daemon alive, port never listening, restart
    // useless. A timeout surfaces as exitCode != 0, which the existing gate
    // renders as "no capabilities" and refuses to boot on (fail-closed).
    const r = await runGit(process.cwd(), ['--version'], { timeoutMs: GIT_PROBE_TIMEOUT_MS })
    v = r.exitCode === 0 ? parseGitVersion(r.stdout) : null
  } catch {
    // git missing entirely (spawn failure): same "no capabilities" shape — the
    // boot gate turns it into a clear refusal instead of an unhandled throw.
  }
  cached = capabilitiesFromVersion(v)
  return cached
}

/** Read whatever `detectGitCapabilities` last produced. `null` until first probe. */
export function getCachedGitCapabilities(): GitCapabilities | null {
  return cached
}

/** Test hook: force the cache to a known value (bypassing real git probe). */
export function __setCachedGitCapabilitiesForTesting(caps: GitCapabilities | null): void {
  cached = caps
}
