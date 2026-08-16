// RFC-304 §6.4 T53 — did this "fix" actually fix anything, or just stop asking?
//
// The cheapest way to make a red pipeline green is to delete the test. An agent
// told to make CI pass will find that path, and the result looks exactly like
// success: the pipeline is green, the diff is small, and the justification
// reads plausibly.
//
// ## The honest division of labour
//
// The design is explicit about which half a program can judge, and it matters
// enough to restate here:
//
//   "did this diff delete an assertion / add a skip / shrink the tests?"
//       → a PROGRAM can answer this. Structure, not meaning.
//
//   "…and was that the right thing to do?"
//       → a program CANNOT answer this. Some tests genuinely should be deleted.
//
// The first draft of the design failed the round for a missing justification
// field, which is a soft constraint dressed up as a hard check: the agent
// writes a paragraph and passes. Requiring text proves nothing about the text.
//
// So this module answers only the first question, and answers it as a SIGNAL
// rather than a verdict. What adjudicates is `redBeforeGreenAfter` — running
// the affected test on the frozen baseline and on the frozen fix — because that
// turns "proof" from the agent's own account into a fact anyone can re-run.

import { normalizeDiffHeaderPath } from '@/modules/code-capability/domain/diffHunks'

/** A structural signal that a change may have removed coverage. */
export interface CheatSignal {
  kind: 'assertion-removed' | 'test-skipped' | 'tests-shrunk' | 'assertion-loosened'
  file: string
  /** What was seen, quoted, so a human can judge it in one glance. */
  detail: string
}

/** Paths that look like test code. */
export function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:tests?|spec|__tests__|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb)$|(?:^|\/)test_[^/]+\.py$/.test(
    path,
  )
}

/** Lines that assert something. Deliberately broad across ecosystems. */
const ASSERTION =
  /\b(?:expect|assert|assertEquals|assertThat|should|require\.(?:Equal|NoError)|t\.(?:Error|Fatal)|XCTAssert|EXPECT_|ASSERT_)\b/

/**
 * Lines that turn a test off.
 *
 * No leading anchor, and that is the whole story of this line. It began as
 * `\b(?:…)` , which silently disabled every alternative starting with a
 * non-word character — `#[ignore]` (Rust) and `@Ignore` (Java) follow
 * whitespace, so there is no word boundary and a whole ecosystem's skip marker
 * went undetected. Replacing it with `\B` broke the opposite half: `test.skip`
 * DOES have a boundary before the dot. Each alternative now anchors only where
 * it needs to.
 */
const SKIP =
  /(?:\.skip\b|\.todo\b|\bxit\b|\bxdescribe\b|@[Ii]gnore\b|@[Ss]kip\b|t\.Skip\(|pytest\.mark\.skip|#\[\s*ignore\s*\]|\bfixme\b)/

/**
 * A numeric or comparison constant in an assertion.
 *
 * Used to spot a threshold being widened — `toBeLessThan(100)` becoming
 * `toBeLessThan(10000)` is a passing test that no longer tests anything.
 */
const NUMBER = /-?\d+(?:\.\d+)?/g

interface ParsedLine {
  file: string
  side: 'added' | 'removed'
  text: string
}

/**
 * Walk a unified diff, yielding changed lines with the file they belong to.
 *
 * Hand-rolled rather than via `parsePatch` because this needs only the added
 * and removed lines and their file, and it must not throw on a diff shape the
 * library dislikes: refusing to analyse is the one outcome that would let a
 * deleted test through silently.
 */
function changedLines(unifiedDiff: string): ParsedLine[] {
  const out: ParsedLine[] = []
  let file = ''
  for (const raw of unifiedDiff.split('\n')) {
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) {
      // `normalizeDiffHeaderPath` returns null for the absent side of an
      // add/delete, so the name set by the other header survives. Reused rather
      // than re-derived: the `a/`-prefix rule is subtle enough that a second
      // copy eventually gets it wrong, and this one would then attribute a
      // deleted test to the wrong file.
      const path = normalizeDiffHeaderPath(raw.slice(4).trim())
      if (path !== null) file = path
      continue
    }
    if (raw.startsWith('@@') || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) out.push({ file, side: 'added', text: raw.slice(1) })
    else if (raw.startsWith('-')) out.push({ file, side: 'removed', text: raw.slice(1) })
  }
  return out
}

/**
 * Structural signals in a change. Not a verdict — see the header.
 *
 * Only TEST files are examined. An assertion removed from production code is
 * ordinary refactoring; the same line removed from a test is the thing this
 * looks for, and conflating them would flag half of all honest changes.
 */
export function findCheatSignals(unifiedDiff: string): CheatSignal[] {
  const signals: CheatSignal[] = []
  const lines = changedLines(unifiedDiff).filter((line) => isTestPath(line.file))

  const netByFile = new Map<string, number>()

  for (const line of lines) {
    const delta = line.side === 'added' ? 1 : -1
    netByFile.set(line.file, (netByFile.get(line.file) ?? 0) + delta)

    if (line.side === 'removed' && ASSERTION.test(line.text)) {
      signals.push({
        kind: 'assertion-removed',
        file: line.file,
        detail: line.text.trim().slice(0, 200),
      })
    }
    if (line.side === 'added' && SKIP.test(line.text)) {
      signals.push({
        kind: 'test-skipped',
        file: line.file,
        detail: line.text.trim().slice(0, 200),
      })
    }
  }

  for (const [file, net] of netByFile) {
    // Net shrinkage of a test file, over and above any assertion already
    // flagged. A threshold rather than "any decrease": tidying an import or
    // collapsing a fixture legitimately removes lines, and flagging every one
    // of those would train the reader to ignore this check.
    if (net <= -5) {
      signals.push({
        kind: 'tests-shrunk',
        file,
        detail: `${String(-net)} more lines removed than added`,
      })
    }
  }

  signals.push(...findLoosenedAssertions(lines))
  return signals
}

/**
 * An assertion whose constant grew.
 *
 * Matched by PAIRING a removed line with an added one that is identical except
 * for its numbers — which is what an agent widening a threshold produces. Any
 * looser matching (say, "an assertion line changed") would flag every honest
 * update to an expected value, and this check would stop being read.
 */
function findLoosenedAssertions(lines: readonly ParsedLine[]): CheatSignal[] {
  const removed = lines.filter((l) => l.side === 'removed' && ASSERTION.test(l.text))
  const added = lines.filter((l) => l.side === 'added' && ASSERTION.test(l.text))
  const out: CheatSignal[] = []

  for (const before of removed) {
    const skeleton = before.text.replace(NUMBER, '#')
    const match = added.find(
      (after) => after.file === before.file && after.text.replace(NUMBER, '#') === skeleton,
    )
    if (match === undefined) continue

    const beforeNumbers = (before.text.match(NUMBER) ?? []).map(Number)
    const afterNumbers = (match.text.match(NUMBER) ?? []).map(Number)
    if (beforeNumbers.length !== afterNumbers.length) continue

    // "Loosened" in either direction: a lower bound dropped or an upper bound
    // raised both widen what passes, and which is which depends on the matcher.
    // Any change to a threshold in a round whose job was to make CI green is
    // worth a look.
    const changed = beforeNumbers.some((value, index) => value !== afterNumbers[index])
    if (changed) {
      out.push({
        kind: 'assertion-loosened',
        file: before.file,
        detail: `${before.text.trim().slice(0, 100)} → ${match.text.trim().slice(0, 100)}`,
      })
    }
  }
  return out
}

/**
 * The adjudicating layer: was the test red before and green after?
 *
 * This is the only input here with the authority to allow a flagged change
 * through, and the reason is that it is a FACT rather than an account. The
 * agent's justification is for the human reading the merge request; this is
 * what the program decides on.
 */
export type BaselineEvidence =
  /** Failed on the frozen baseline, passes on the frozen fix. */
  | { kind: 'red-before-green-after' }
  /**
   * Passed on the baseline too — so this change is what broke or removed it.
   * The strongest possible evidence that the "fix" is not one.
   */
  | { kind: 'was-already-green' }
  /** Could not be re-run mechanically. Not evidence either way. */
  | { kind: 'inconclusive'; reason: string }

export type AntiCheatVerdict =
  /** Nothing structural was flagged, or the evidence cleared it. */
  | { decision: 'allow'; signals: readonly CheatSignal[] }
  /**
   * Flagged AND the baseline shows the test was already passing. A program
   * decision, on a re-runnable fact.
   */
  | { decision: 'reject'; signals: readonly CheatSignal[]; message: string }
  /**
   * Flagged and the evidence is inconclusive. NOT rejected and NOT pushed —
   * a person looks. The design is explicit that the hard block is used for
   * "do not push automatically", never for "this justification is false".
   */
  | { decision: 'escalate'; signals: readonly CheatSignal[]; message: string }

/**
 * What to do about a change that touched tests.
 *
 * Note what this deliberately does NOT do: it never consults a justification
 * field. Requiring one and checking it is non-empty would hand the decision
 * back to the agent's own account of itself — the exact failure the design
 * called out in its first draft.
 */
export function judgeAntiCheat(
  signals: readonly CheatSignal[],
  evidence: BaselineEvidence,
): AntiCheatVerdict {
  if (signals.length === 0) return { decision: 'allow', signals }

  if (evidence.kind === 'red-before-green-after') {
    // The test failed before and passes now. Whatever it did to the test file,
    // it fixed the thing the test was checking.
    return { decision: 'allow', signals }
  }

  if (evidence.kind === 'was-already-green') {
    return {
      decision: 'reject',
      signals,
      message: [
        'This change removes or weakens test coverage, and the test it targets was',
        'already passing on the baseline — so the change is what broke or deleted it,',
        'not a fix for it.',
        '',
        describeSignals(signals),
      ].join('\n'),
    }
  }

  return {
    decision: 'escalate',
    signals,
    message: [
      'This change removes or weakens test coverage, and the platform could not',
      `re-run the affected test to check whether that was justified (${evidence.reason}).`,
      '',
      'Nothing was pushed. Someone needs to look at this one.',
      '',
      describeSignals(signals),
    ].join('\n'),
  }
}

/** The signals, as a list a reviewer can scan. */
export function describeSignals(signals: readonly CheatSignal[]): string {
  const label: Record<CheatSignal['kind'], string> = {
    'assertion-removed': 'assertion removed',
    'test-skipped': 'test skipped',
    'tests-shrunk': 'test file shrank',
    'assertion-loosened': 'assertion loosened',
  }
  return signals.map((s) => `- ${label[s.kind]} in ${s.file}: ${s.detail}`).join('\n')
}
