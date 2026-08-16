// RFC-304 §6.4 (E9) — what "three attempts" is three attempts AT.
//
// The retry quota is keyed by `(work item, FAILURE FINGERPRINT)`, not by the
// work item's lifetime, and that choice is the whole point of this module.
//
// Keyed by work item alone, a long-lived merge request permanently loses
// automatic repair the third time it meets ANY CI problem — including three
// unrelated ones months apart. Worse, nobody can see it happen: the quota was
// spent by failures the author has long forgotten, and the platform simply
// stops helping with no explanation that connects to anything they did.
//
// Keyed by the failure, the quota means what a person would assume it means:
// "we tried to fix THIS three times and could not". A new failure — the author
// pushed something that broke differently — starts fresh, because it is a
// different problem.
//
// ## Why normalise rather than hash the raw message
//
// Compilers put line numbers, absolute paths, timings and process ids in error
// text. Hashing that raw makes every re-run a "new" failure, and the quota
// never engages: the platform would retry the same broken fix forever.

import { sha256Hex } from '@/util/hash'
import type { ClassifiedIssue } from '@/modules/code-capability/domain/monitorContracts'

/**
 * Volatile fragments that must not enter a fingerprint.
 *
 * Each of these makes an identical failure look new on the next run, which is
 * the failure mode that silently disables the quota.
 */
const VOLATILE: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // ORDER IS THE CONTRACT: most specific first, because each rule consumes what
  // it matches. Note also that `normalizeFailureMessage` LOWERCASES before
  // running these, so a pattern written against `2026-08-16T02:00:00Z` sees
  // `t`/`z` — the `i` flag below is load-bearing, not decoration. The timestamp rule sits above the line/column rule for exactly
  // this reason — `02:00:00` inside an ISO timestamp is `:\d+:\d+` too, and
  // with the order reversed the line rule ate half of every timestamp and left
  // the date behind, so two runs a day apart fingerprinted differently.
  { pattern: /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}\S*/gi, replacement: '<timestamp>' },
  // Absolute paths — the worktree is per-round, so every run has a new one.
  { pattern: /\/(?:tmp|var|home|Users)\/[^\s:'"]+/g, replacement: '<path>' },
  // Line and column references.
  { pattern: /:\d+:\d+/g, replacement: ':<line>:<col>' },
  { pattern: /\bline \d+/gi, replacement: 'line <n>' },
  // Durations.
  { pattern: /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|minutes)\b/gi, replacement: '<duration>' },
  // Process and job ids, and hex blobs (shas, addresses).
  { pattern: /\b(?:pid|job|run|build)[ =#]?\d+/gi, replacement: '<id>' },
  { pattern: /\b[0-9a-f]{7,40}\b/gi, replacement: '<hex>' },
  // Bare numbers last, so every rule above wins over this one.
  { pattern: /\b\d+\b/g, replacement: '<n>' },
]

/** Strip the parts of an error message that change between identical runs. */
export function normalizeFailureMessage(message: string): string {
  let text = message.trim().toLowerCase()
  for (const { pattern, replacement } of VOLATILE) text = text.replace(pattern, replacement)
  return text.replace(/\s+/g, ' ').slice(0, 500)
}

export interface FailureFingerprint {
  /** Stable hash; the quota's key. */
  digest: string
  /** Human-readable, for the summary a person reads when the quota runs out. */
  summary: string
}

/**
 * The fingerprint of a round's classified failures.
 *
 * Built from the SET of issue types plus the first issue's file and message —
 * the design's own definition. Types are sorted and de-duplicated so that a
 * classifier emitting them in a different order does not mint a new failure;
 * only the first issue's detail is used because a compile break cascades, and
 * hashing all forty downstream errors would make the fingerprint change every
 * time one of them moved.
 */
export function fingerprintFailures(issues: readonly ClassifiedIssue[]): FailureFingerprint {
  if (issues.length === 0) {
    // A gate that failed with nothing classified. Given its own stable
    // fingerprint rather than an empty one: it IS a distinct recurring failure
    // ("the pipeline is red and we cannot tell why"), and it should consume a
    // quota like any other rather than retrying forever.
    return { digest: sha256Hex('unclassified'), summary: 'unclassified failure' }
  }

  const types = [...new Set(issues.map((issue) => issue.type))].sort()
  const first = issues[0]!
  const file = first.file ?? ''
  const message = normalizeFailureMessage(first.message)

  return {
    digest: sha256Hex(`${types.join(',')}|${file}|${message}`),
    summary: `${types.join(', ')}${file === '' ? '' : ` in ${file}`}`,
  }
}

/** The default number of automatic attempts at one failure (E9). */
export const DEFAULT_FIX_ATTEMPTS = 3

export type QuotaVerdict =
  | { allowed: true; attempt: number; remaining: number }
  /** `message` is posted to the merge request; see `renderQuotaExhausted`. */
  | { allowed: false; attempts: number }

/**
 * May another automatic attempt be made at this failure?
 *
 * `attemptsSoFar` counts rounds already spent on THIS fingerprint. The caller
 * reads it from the ledger; this function only decides.
 */
export function judgeFixQuota(
  attemptsSoFar: number,
  limit: number = DEFAULT_FIX_ATTEMPTS,
): QuotaVerdict {
  return attemptsSoFar < limit
    ? { allowed: true, attempt: attemptsSoFar + 1, remaining: limit - attemptsSoFar - 1 }
    : { allowed: false, attempts: attemptsSoFar }
}

export interface AttemptRecord {
  attempt: number
  /** What was tried, in the agent's words. */
  summary: string
  /** Why it did not work — the gate's verdict, not the agent's opinion. */
  outcome: string
}

/**
 * The comment posted when the quota runs out.
 *
 * Two things it must contain, and the second is the one that gets forgotten:
 * every attempt (so the next person does not repeat them), and WHAT RESETS the
 * quota. Without the reset condition the reader concludes automatic repair is
 * permanently off for this merge request, which is not true and would be a
 * reason to distrust the whole feature.
 */
export function renderQuotaExhausted(
  fingerprint: FailureFingerprint,
  attempts: readonly AttemptRecord[],
): string {
  const tried = attempts
    .map((record) => `${String(record.attempt)}. ${record.summary}\n   → ${record.outcome}`)
    .join('\n')

  return [
    `Automatic repair stopped after ${String(attempts.length)} attempts at the same failure (${fingerprint.summary}).`,
    '',
    'What was tried:',
    tried,
    '',
    'This one needs a person. The quota counts attempts at THIS failure — if the',
    'pipeline starts failing differently, automatic repair starts again from zero.',
  ].join('\n')
}
