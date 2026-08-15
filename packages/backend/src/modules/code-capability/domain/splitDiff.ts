// RFC-304 §6.1 (T23) — cutting one MR's diff into shards a model can actually read.
//
// ## Why shard at all
//
// A large MR does not fit one prompt, and the part that gets cut is invisible:
// the review comes back confident and complete-looking, having seen the first
// third of the change. Sharding makes the omission structural rather than
// silent — every file lands in exactly one shard, and the shard count is a
// number an operator can see.
//
// ## Why by directory
//
// Review quality depends on context. `src/auth/session.ts` and
// `src/auth/token.ts` are the pair where a bug lives *between* the two files,
// so splitting them across shards is how a review misses it. Grouping by
// directory keeps the files that are most likely to be about the same thing in
// front of the same reviewer.
//
// ## Determinism (constitution R5)
//
// The same diff must produce the same shards, every time, on every machine — a
// re-run that reshuffles files produces different findings for identical input,
// and then "did the code change or did the sharding?" is unanswerable. So:
// files sort by path, directories sort by path, and the packing is a plain
// left-to-right walk with no map iteration order anywhere in it.
//
// ## What the cap means
//
// `maxLinesPerShard` bounds the diff LINES in a shard, not files or bytes.
// Lines are what fills a context window, and a 4000-line generated file next to
// nine small ones would otherwise ride along as "ten files, one shard".
//
// A single file that exceeds the cap on its own still gets its own shard rather
// than being cut mid-hunk: half a hunk is not reviewable, and a finding
// anchored inside the missing half cannot be positioned. The shard is reported
// as `oversize` so the caller can say so instead of pretending it fit.

import type { FileDiff } from '@/modules/code-capability/domain/mrDiffNormalize'

export interface DiffShard {
  /**
   * Stable identity for this shard, derived from its content rather than its
   * position: a shard key that shifted when an unrelated file was added would
   * break resume, which addresses shards by key.
   */
  key: string
  /** The directory these files share, '' for repository root. */
  directory: string
  files: readonly FileDiff[]
  lineCount: number
  /**
   * True when this shard exceeds the cap because a single file does.
   *
   * Surfaced rather than swallowed: the review of an oversize shard may still
   * be clipped by the model's own limit, and that has to be sayable in the
   * overview.
   */
  oversize: boolean
}

export interface SplitDiffOptions {
  /** Diff lines per shard. */
  maxLinesPerShard: number
  /**
   * Hard ceiling on shard count.
   *
   * Each shard costs a model call AND its own disposable worktree (design §6.1
   * P1), so an unbounded split turns one enormous MR into hundreds of processes
   * and a full disk. Files beyond the ceiling are packed into the last shard,
   * which is then `oversize` — degraded, and visibly so.
   */
  maxShards: number
}

export const DEFAULT_SPLIT: SplitDiffOptions = { maxLinesPerShard: 1500, maxShards: 12 }

/** The path a file is filed under — new side when it exists, else old. */
export function filePathOf(file: FileDiff): string {
  return file.newPath ?? file.oldPath ?? ''
}

function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * Diff lines in a patch.
 *
 * Counts every line including hunk headers, because the header is text the
 * model reads too. An empty patch counts as zero rather than one: an omitted
 * binary file contributes nothing to review and should not consume budget.
 */
export function patchLineCount(patch: string): number {
  if (patch === '') return 0
  let lines = 1
  for (let i = 0; i < patch.length; i++) {
    if (patch.charCodeAt(i) === 10) lines += 1
  }
  // A trailing newline does not start a further line.
  return patch.endsWith('\n') ? lines - 1 : lines
}

/**
 * Split a normalized diff into review shards.
 *
 * Files with no readable content (binary, too large to fetch) are dropped here:
 * they carry no diff to review, and passing them through would spend a shard on
 * nothing. `fetch-diff` already reports them separately, so they still reach
 * the author through the overview's omission list.
 */
export function splitDiff(
  files: readonly FileDiff[],
  options: SplitDiffOptions = DEFAULT_SPLIT,
): DiffShard[] {
  const reviewable = files.filter((f) => f.omission === 'none' && f.patch !== '')
  if (reviewable.length === 0) return []

  const cap = Math.max(1, options.maxLinesPerShard)
  const ceiling = Math.max(1, options.maxShards)

  // Group by directory, then sort both levels by path. Sorting the directory
  // NAMES rather than iterating the map is what makes this insertion-order
  // independent — a map walk would reshuffle when the host returns files in a
  // different order, which GitLab and GitHub genuinely do.
  const byDirectory = new Map<string, FileDiff[]>()
  for (const file of reviewable) {
    const directory = directoryOf(filePathOf(file))
    const bucket = byDirectory.get(directory)
    if (bucket === undefined) byDirectory.set(directory, [file])
    else bucket.push(file)
  }

  const shards: Array<{ directory: string; files: FileDiff[]; lines: number; oversize: boolean }> =
    []

  for (const directory of [...byDirectory.keys()].sort()) {
    const bucket = [...byDirectory.get(directory)!].sort((a, b) =>
      filePathOf(a) < filePathOf(b) ? -1 : 1,
    )

    let current: (typeof shards)[number] | null = null
    for (const file of bucket) {
      const lines = patchLineCount(file.patch)

      // Bigger than a whole shard by itself: its own shard, uncut. Cutting it
      // mid-hunk would produce a diff nothing can anchor against.
      if (lines > cap) {
        shards.push({ directory, files: [file], lines, oversize: true })
        current = null
        continue
      }

      if (current === null || current.lines + lines > cap) {
        current = { directory, files: [file], lines, oversize: false }
        shards.push(current)
        continue
      }
      current.files.push(file)
      current.lines += lines
    }
  }

  // Over the ceiling: fold the tail into the last kept shard rather than
  // dropping it. A dropped file is an unreviewed file that nothing reports.
  if (shards.length > ceiling) {
    const kept = shards.slice(0, ceiling)
    const last = kept[ceiling - 1]!
    for (const extra of shards.slice(ceiling)) {
      last.files.push(...extra.files)
      last.lines += extra.lines
    }
    last.oversize = true
    shards.length = 0
    shards.push(...kept)
  }

  return shards.map((shard, index) => ({
    // The index is part of the key because two shards can legitimately share a
    // directory (one split by the cap), and a bare directory key would then
    // collide — the second would overwrite the first's attempt rows.
    key: `${index}:${shard.directory === '' ? '.' : shard.directory}`,
    directory: shard.directory,
    files: shard.files,
    lineCount: shard.lines,
    oversize: shard.oversize,
  }))
}
