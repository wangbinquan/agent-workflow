// RFC-304 §invoke — turning a LOCAL `git diff` into the per-file shape the
// review stages read.
//
// `normalizeMrDiff` does this for a code host's payload, where the provider has
// already split the change by file. A self-review has no provider payload: the
// change is in a worktree, and what the platform holds is the raw output of
// `git diff <baseline> <snapshot>`. Without this the invoked sub-sequence could
// not be handed a diff at all, which is why `self-review` had no way to run
// even once the stages were wired.
//
// Deliberately a splitter rather than a parser: it finds file boundaries and
// keeps each body verbatim. The hunks inside are read downstream by
// `parseDiffHunks`, and re-deriving them here would be a second implementation
// of the same thing — the two would drift, and a review would then place
// comments on lines the placement logic disagrees about.

import type { FileDiff } from '@/modules/code-capability/domain/mrDiffNormalize'

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` → null (the side does not exist). */
function sidePath(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '/dev/null') return null
  // git quotes paths containing unusual bytes; the quotes are not part of it.
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
  return unquoted.replace(/^[ab]\//, '')
}

/**
 * Split a unified diff into one entry per file.
 *
 * Robust to what `git diff` actually emits around the interesting part: mode
 * changes, `similarity index`, binary markers, and files with no `---`/`+++`
 * pair at all (a pure rename or mode change). Those still produce an entry,
 * because "this file changed and here is nothing to read" is information the
 * review should see rather than a file silently missing from the diff.
 */
export function parseLocalDiffFiles(unifiedDiff: string): FileDiff[] {
  if (unifiedDiff.trim() === '') return []

  const lines = unifiedDiff.split('\n')
  const starts: number[] = []
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('diff --git ')) starts.push(index)
  }
  if (starts.length === 0) return []

  const files: FileDiff[] = []
  for (const [n, start] of starts.entries()) {
    const end = starts[n + 1] ?? lines.length
    const block = lines.slice(start, end)

    // The header line carries both paths; the `---`/`+++` pair carries them
    // again AND says which side is /dev/null. Prefer the pair, fall back to the
    // header for the cases that have no pair.
    const header = /^diff --git ("?[ab]\/.*?"?) ("?[ab]\/.*"?)$/.exec(block[0] ?? '')
    let oldPath = sidePath(header?.[1])
    let newPath = sidePath(header?.[2])

    const bodyStart = block.findIndex((l) => l.startsWith('@@ '))
    for (const line of block.slice(1, bodyStart === -1 ? block.length : bodyStart)) {
      if (line.startsWith('--- ')) oldPath = sidePath(line.slice(4))
      else if (line.startsWith('+++ ')) newPath = sidePath(line.slice(4))
    }

    files.push({
      oldPath,
      newPath,
      // Everything from the first hunk header on. The stages read hunks; the
      // `diff --git` / `index` preamble is noise to them and would only make
      // the prompt longer.
      patch: bodyStart === -1 ? '' : block.slice(bodyStart).join('\n').replace(/\n+$/, ''),
      // Nothing is omitted here: a local diff is complete by construction,
      // unlike a provider payload that can truncate large files. Binary files
      // are the one exception git marks itself, and it marks them by emitting
      // no hunks — which is what the empty patch above already says.
      omission: block.some((l) => l.startsWith('Binary files ')) ? 'binary' : 'none',
    })
  }
  return files
}
