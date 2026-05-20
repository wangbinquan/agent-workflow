// opencode binary discovery + version probe + min-version gate.
//
// Min version was verified hands-on in P-0-01 (design.md §18 #1).
// Bumping requires re-validating the 4 isolation experiments.

import { createLogger } from './log'

const log = createLogger('opencode')

/**
 * Minimum supported opencode version.
 * Below this the daemon refuses to start (design.md §11.2).
 */
export const MIN_OPENCODE_VERSION = '1.14.0'

/**
 * Exclusive upper bound — a permissive tripwire for the next major-ish
 * upstream change. Currently set to the next minor (`1.16.0`), allowing every
 * `1.14.x` AND `1.15.x` release.
 *
 * Historical context: opencode 1.14.51 shipped commit 7f2b5ee8c (the Effect-TS
 * rewrite of `packages/opencode/src/cli/cmd/run.ts`), which changed root
 * resolution from `process.cwd()` to `process.env.PWD ?? process.cwd()`.
 * Combined with `Bun.spawn({cwd: ...})` (which updates the child's
 * `process.cwd()` but inherits `PWD` from the parent), opencode loaded TWO
 * Instances and dropped `--format json` events on the floor. Root cause was
 * traced to OUR spawn missing an explicit `PWD = cwd`; the fix landed in
 * `services/runner.ts` + `services/memoryDistiller.ts` (search "PWD:
 * opts.worktreePath" / "PWD: input.cwd" — they carry the full rationale).
 *
 * 1.15.0+ additionally absorbs upstream commit e11e089e4 ("Add Effect-native
 * core event system") which makes the SSE path resilient to the PWD-vs-cwd
 * mismatch even without our spawn fix. Combined with our spawn fix, 1.15.x
 * is verified-working — reproduced 2026-05-20 against 1.15.5 with the same
 * worktree + clarify-iteration fixture that broke 1.14.51.
 *
 * The cap now exists only as a "you just bumped past a minor — manually
 * re-verify" tripwire; bump it forward once you've smoke-tested a 1.16.x
 * or 2.x against a clarify-iteration agent node end-to-end.
 */
export const MAX_OPENCODE_VERSION_EXCLUSIVE = '1.16.0'

export interface OpencodeProbe {
  /** Resolved binary path (absolute when overridden, "opencode" when on PATH). */
  binary: string
  /** Parsed "X.Y.Z" string, or null if not found / parse failed. */
  version: string | null
  /**
   * True iff `MIN_OPENCODE_VERSION <= version < MAX_OPENCODE_VERSION_EXCLUSIVE`.
   * False on probe failure, too old, OR known-broken upper range.
   */
  compatible: boolean
  /**
   * When the binary is present but in the known-broken range, this carries a
   * human-readable reason so the daemon log / runtime route surfaces "why
   * incompatible" rather than just "<= min".
   */
  incompatibleReason?: string
}

/**
 * Spawn `<binary> --version`, parse the semver prefix.
 * Returns null if the binary cannot be executed or output is unparseable.
 */
export async function probeOpencode(opencodePath?: string): Promise<OpencodeProbe> {
  const binary = opencodePath ?? 'opencode'
  let version: string | null = null
  try {
    const proc = Bun.spawn({
      cmd: [binary, '--version'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (exitCode === 0) {
      version = extractVersion(out)
    } else {
      log.warn('opencode --version non-zero exit', { binary, exitCode })
    }
  } catch (err) {
    log.warn('opencode binary not executable', { binary, error: (err as Error).message })
  }

  if (version === null) {
    return { binary, version, compatible: false }
  }
  if (compareSemver(version, MIN_OPENCODE_VERSION) < 0) {
    return {
      binary,
      version,
      compatible: false,
      incompatibleReason: `opencode ${version} is older than required minimum ${MIN_OPENCODE_VERSION}`,
    }
  }
  if (compareSemver(version, MAX_OPENCODE_VERSION_EXCLUSIVE) >= 0) {
    return {
      binary,
      version,
      compatible: false,
      incompatibleReason: `opencode ${version} is at/above the unverified ceiling ${MAX_OPENCODE_VERSION_EXCLUSIVE}. Pin to ${MIN_OPENCODE_VERSION}..<${MAX_OPENCODE_VERSION_EXCLUSIVE} or smoke-test a clarify-iteration agent node end-to-end against this version before bumping the cap.`,
    }
  }
  return { binary, version, compatible: true }
}

/** Extract first "X.Y.Z" from arbitrary output. */
export function extractVersion(s: string): string | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/**
 * Compare two semver strings (major.minor.patch only; prerelease ignored).
 * Returns negative / 0 / positive (sortable).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (pa === null || pb === null) return 0
  for (let i = 0; i < 3; i++) {
    const ai = pa[i]
    const bi = pb[i]
    if (ai === undefined || bi === undefined) continue
    if (ai !== bi) return ai - bi
  }
  return 0
}

function parse(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  const out: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (out.some((n) => !Number.isFinite(n))) return null
  return out
}
