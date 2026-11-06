// RFC-210 / RFC-377 — effective submodule parameters (RFC-451: moved verbatim from services/gitRepoCache).
// Platform workspace isolation, the source-control mirror cache and the worktree materializers all resolve
// submodule policy here; git primitives stay in util/git and receive it as an injected resolver.

import { existsSync } from 'node:fs'
import { loadConfig } from '@/config'
import { getCachedGitCapabilities } from '@/platform/workspace/local/gitVersion'
import type { SubmoduleMode } from '@/services/gitSubmodule'
import { Paths } from '@/util/paths'

/**
 * Resolve effective submodule mode + jobs from caller config + local git caps.
 * Pre-2.5 git can't run worktree+submodule reliably → force never.
 * Pre-2.13 git lacks `--jobs` → clamp to 1.
 */
/**
 * RFC-210 G9: read the submodule settings off disk.
 *
 * This is the wiring RFC-034 documented but never built. The reason it was
 * missing is structural: neither `scheduler.ts` nor `nodeIsolation.ts` imports
 * config at all, so nobody along the call chain was in a position to pass it —
 * every caller ended up handing `resolveSubmoduleParams` a pair of `undefined`s
 * and getting the hard-coded defaults back.
 *
 * `existsSync` FIRST: `loadConfig` writes a default config file when the path is
 * missing, and a git helper must not have that side effect. A malformed config
 * degrades to defaults rather than failing the git operation around it.
 */
function submoduleConfigFromDisk(): { mode?: SubmoduleMode; jobs?: number; remote?: boolean } {
  try {
    if (!existsSync(Paths.config)) return {}
    const cfg = loadConfig(Paths.config)
    const out: { mode?: SubmoduleMode; jobs?: number; remote?: boolean } = {}
    if (cfg.gitRecurseSubmodules !== undefined) out.mode = cfg.gitRecurseSubmodules
    if (cfg.gitSubmoduleJobs !== undefined) out.jobs = cfg.gitSubmoduleJobs
    if (cfg.gitSubmoduleRemote !== undefined) out.remote = cfg.gitSubmoduleRemote
    return out
  } catch {
    return {}
  }
}

export function resolveSubmoduleParams(
  inMode: SubmoduleMode | undefined,
  inJobs: number | undefined,
): { mode: SubmoduleMode; jobs: number; remote: boolean } {
  const caps = getCachedGitCapabilities()
  // Precedence: explicit argument > settings > built-in default. Both settings
  // are optional and absent from a default config.json, so an untouched install
  // resolves to exactly the pre-RFC-210 values.
  const fromDisk = submoduleConfigFromDisk()
  let mode: SubmoduleMode = inMode ?? fromDisk.mode ?? 'auto'
  if (caps && !caps.supportsRecurseInWorktree) {
    mode = 'never'
  }
  let jobs = Math.max(1, Math.min(32, Math.floor(inJobs ?? fromDisk.jobs ?? 4)))
  if (caps && !caps.supportsSubmoduleJobs) {
    jobs = 1
  }
  // RFC-210 G8: `--remote` pulls each submodule to its upstream branch tip
  // instead of the commit the superproject records. Off by default — it makes a
  // task's baseline drift with whatever upstream did, which costs reproducibility.
  return { mode, jobs, remote: fromDisk.remote ?? false }
}
