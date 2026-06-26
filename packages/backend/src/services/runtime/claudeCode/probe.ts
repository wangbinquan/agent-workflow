// RFC-111 PR-B — Claude Code binary discovery + version probe + min-version gate.
// Mirrors util/opencode.ts. Unlike opencode (hard-fail at daemon startup), the
// claude probe is SOFT (D10): a missing/old claude only fails a node whose agent
// selected the claude runtime; opencode-only installs are unaffected.

import { createLogger } from '@/util/log'

const log = createLogger('claude-code')

/**
 * Minimum supported Claude Code version. Verified hands-on at 2.1.193 (all
 * headless flags present, design §6.1). Conservative floor; bump as the contract
 * is re-validated against newer releases.
 */
export const MIN_CLAUDE_CODE_VERSION = '2.0.0'

export interface ClaudeProbe {
  binary: string
  version: string | null
  compatible: boolean
  incompatibleReason?: string
  /**
   * Auth source as Claude Code reports it (`apiKeySource` from the init event /
   * env). Surfaced to the settings card; `none` does NOT mean "unauthed" — a
   * subscription login still reports `none` (design §4.1). Optional: only the
   * runtime route fills this via a real probe run; the version probe leaves it
   * undefined.
   */
  apiKeySource?: string
}

/** Spawn `<binary> --version`, parse the semver. Output form: `2.1.193 (Claude Code)`. */
export async function probeClaudeCode(claudePath?: string): Promise<ClaudeProbe> {
  const binary = claudePath ?? 'claude'
  let version: string | null = null
  try {
    const proc = Bun.spawn({ cmd: [binary, '--version'], stdout: 'pipe', stderr: 'pipe' })
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (exitCode === 0) {
      version = extractVersion(out)
    } else {
      log.warn('claude --version non-zero exit', { binary, exitCode })
    }
  } catch (err) {
    log.warn('claude binary not executable', { binary, error: (err as Error).message })
  }

  if (version === null) {
    return { binary, version, compatible: false }
  }
  if (compareSemver(version, MIN_CLAUDE_CODE_VERSION) < 0) {
    return {
      binary,
      version,
      compatible: false,
      incompatibleReason: `Claude Code ${version} is older than required minimum ${MIN_CLAUDE_CODE_VERSION}`,
    }
  }
  return { binary, version, compatible: true }
}

/** Extract first "X.Y.Z" from arbitrary output. */
export function extractVersion(s: string): string | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/** Compare two "major.minor.patch" strings (sortable: negative / 0 / positive). */
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
