// RFC-239 (design gate 2nd-round P1-3 / 3rd-round P1-N4) — ONE canonical repo
// label per task repo, shared by the text diff's `# === Repo: <label> ===`
// markers and the structural diff's `label/` id prefixes, so the frontend can
// join the two sides by exact label equality.
//
// Before this, the two sides disagreed on the fallback (structural:
// `basename(repoPath)`, text: full `repoPath`) and a label containing CR/LF
// could break the single-line marker regex. Sanitization happens BEFORE
// uniquing: two labels that only differ by stripped characters (`ab` vs
// `a\nb`) would otherwise collapse into the same string and cross-join files
// between repos.

import { basename } from 'node:path'

export interface RepoForLabel {
  worktreeDirName?: string | null
  repoPath: string
}

/** Strip characters that break the diff marker line or path-prefix parsing:
 *  CR/LF (marker is single-line) and `/` (labels prefix repo-relative paths as
 *  `label/…` — a slash would shift the split point). */
function sanitizeLabel(raw: string): string {
  return raw.replace(/[\r\n/\\]+/g, '-').trim()
}

/** A label made only of replacement dashes/whitespace carries no identity. */
function hasSubstance(label: string): boolean {
  return /[^\s-]/.test(label)
}

/**
 * Canonical labels for a task's repos, index-aligned with the input. Compute
 * over the FULL repo list (not a filtered subset) so both consumers hand the
 * same repo the same label even when their usable-filters differ.
 */
export function canonicalRepoLabels(repos: readonly RepoForLabel[]): string[] {
  const labels: string[] = []
  const used = new Map<string, number>()
  for (const repo of repos) {
    const raw = repo.worktreeDirName ?? ''
    let label = sanitizeLabel(raw)
    if (!hasSubstance(label)) label = sanitizeLabel(basename(repo.repoPath))
    if (!hasSubstance(label)) label = 'repo'
    const n = used.get(label) ?? 0
    used.set(label, n + 1)
    // Post-sanitization uniquing: creation-time `-2/-3` dedup only guarantees
    // uniqueness BEFORE stripping, so collisions can reappear here.
    if (n > 0) label = `${label}-${n + 1}`
    labels.push(label)
  }
  return labels
}
