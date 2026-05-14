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

export interface OpencodeProbe {
  /** Resolved binary path (absolute when overridden, "opencode" when on PATH). */
  binary: string
  /** Parsed "X.Y.Z" string, or null if not found / parse failed. */
  version: string | null
  /** True iff version >= MIN_OPENCODE_VERSION. False if probe failed or too old. */
  compatible: boolean
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
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (exitCode === 0) {
      version = extractVersion(out)
    } else {
      log.warn('opencode --version non-zero exit', { binary, exitCode })
    }
  } catch (err) {
    log.warn('opencode binary not executable', { binary, error: (err as Error).message })
  }

  const compatible = version !== null && compareSemver(version, MIN_OPENCODE_VERSION) >= 0
  return { binary, version, compatible }
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
