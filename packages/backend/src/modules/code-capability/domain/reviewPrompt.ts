// RFC-304 §6.1 — what the `review` stage actually asks.
//
// A pure function, so the wording is a reviewable artifact rather than a string
// buried in an orchestration path. The envelope protocol block is NOT built
// here: the platform already has one builder (`buildProtocolBlock` in shared)
// and every node's instruction has to stay byte-identical to it, so the caller
// appends it to what this returns.
//
// Three decisions in the wording carry real weight:
//
//   1. It says outright that finding nothing is a complete answer. Without
//      that, a model asked to review will find something — and an invented
//      finding is indistinguishable from a real one at every stage after this.
//   2. It lists the files the diff touches. Remarks about anything else degrade
//      (AC-4), so naming the set is the cheapest way to spend the model's
//      attention where it can produce an anchored comment.
//   3. It names the files that were omitted. Otherwise the model sees a changed
//      binary or an unrendered bundle missing from the diff and reasons about
//      an MR it thinks is smaller than it is.

import { changedPaths } from '@/modules/code-capability/domain/diffHunks'
import type { DiffHunk } from '@/modules/code-capability/domain/anchorResolve'
import type { DiffOmission } from '@/modules/code-capability/domain/mrDiffNormalize'

/**
 * How much diff text one prompt carries.
 *
 * Sharding (`split-diff`) is what handles a genuinely large MR; this is the
 * backstop for the un-sharded path, and it exists to make over-length VISIBLE
 * rather than to solve it. A silently clipped diff produces a review that reads
 * as complete and covers a prefix.
 */
export const REVIEW_DIFF_BUDGET_CHARS = 200_000

export interface ReviewPromptInput {
  unifiedDiff: string
  hunks: readonly DiffHunk[]
  omitted: ReadonlyArray<{ path: string; omission: DiffOmission }>
  mrTitle: string | null
  /** Overrides the default budget; tests use it, sharding will not need it. */
  budgetChars?: number
}

export interface ReviewPromptResult {
  prompt: string
  /** True when the diff did not fit. The overview comment must say so. */
  diffClipped: boolean
}

function describeOmission(omission: DiffOmission): string {
  if (omission === 'binary') return 'binary'
  if (omission === 'too-large') return 'too large for the host to render'
  return ''
}

export function buildReviewPrompt(input: ReviewPromptInput): ReviewPromptResult {
  const budget = input.budgetChars ?? REVIEW_DIFF_BUDGET_CHARS
  const clipped = input.unifiedDiff.length > budget
  const diffText = clipped ? input.unifiedDiff.slice(0, budget) : input.unifiedDiff

  const paths = changedPaths(input.hunks)
  const lines: string[] = []

  lines.push('Review the following merge request diff and report what is wrong with it.')
  lines.push('')
  if (input.mrTitle !== null && input.mrTitle.trim() !== '') {
    lines.push(`The merge request is titled: ${input.mrTitle.trim()}`)
    lines.push('')
  }

  lines.push('## What to report')
  lines.push('')
  lines.push(
    'Report defects: things that are wrong, will break, or will mislead the next reader. Correctness first, then things that will cause a real problem later.',
  )
  // The single most important sentence in this prompt.
  lines.push('')
  lines.push(
    'If the diff has nothing wrong with it, report no findings at all. An empty review is a complete and expected answer — do NOT manufacture a finding to have something to say.',
  )
  lines.push('')
  lines.push('Do not report matters of style or preference, and do not restate what the diff does.')

  lines.push('')
  lines.push('## Where a finding can be placed')
  lines.push('')
  if (paths.length > 0) {
    lines.push(
      'Each finding is placed on a line of one of these files, which are the files this diff changes:',
    )
    lines.push('')
    for (const path of paths) lines.push(`  - ${path}`)
    lines.push('')
    lines.push(
      'A finding on any other file, or on a line this diff does not touch, cannot be shown next to the code and will be reported separately instead. Prefer placing a finding on a changed line.',
    )
  } else {
    lines.push('This diff changes no readable lines, so no finding can be placed against code.')
  }

  if (input.omitted.length > 0) {
    lines.push('')
    lines.push(
      'These files changed but their contents are not in the diff below, so nothing about them can be reviewed:',
    )
    lines.push('')
    for (const file of input.omitted) {
      lines.push(`  - ${file.path} (${describeOmission(file.omission)})`)
    }
  }

  if (clipped) {
    lines.push('')
    lines.push(
      `## Note: this diff was clipped at ${budget} characters and continues beyond what follows. Review what is here; do not guess at the rest.`,
    )
  }

  lines.push('')
  lines.push('## The diff')
  lines.push('')
  lines.push('```diff')
  lines.push(diffText)
  lines.push('```')

  return { prompt: lines.join('\n'), diffClipped: clipped }
}
