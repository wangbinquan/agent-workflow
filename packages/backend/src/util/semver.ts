// RFC-143 PR-5 — the SINGLE semver helper pair for runtime version probes.
// Was duplicated byte-for-byte in util/opencode.ts and runtime/claudeCode/
// probe.ts (dedup-audit entry); both probes now import from here. util/opencode
// re-exports for its existing import sites (opencode-version.test.ts).
//
// Leaf module: zero imports.

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
