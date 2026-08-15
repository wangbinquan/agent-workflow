// RFC-304 §6.1 — what a review finding looks like once it is on the MR.
//
// Pure rendering, kept apart from publishing so the wording is reviewable and
// so the fingerprint — the thing dedup and reconcile key off across rounds — is
// attached in exactly one place.
//
// Two properties matter more than the prose:
//
//   1. The fingerprint is derived from what makes a finding THE SAME finding
//      across rounds: its file, its title, and the content of the hunk it sits
//      in. NOT its line number — a rebase moves every line, and a fingerprint
//      that moved with it would republish the whole review as new on every
//      push, which is how a bot earns a mute.
//   2. The overview names the revision it reviewed and every way the round fell
//      short of reviewing all of it. A review that reads as complete when it
//      skipped two files is worse than one that admits the gap, because the
//      author acts on the silence.

import { withFingerprintMarker } from '@/modules/code-capability/domain/publishReconcileRemote'
import { sha256Hex } from '@/util/hash'
import type { FindingSeverity } from '@/modules/code-capability/domain/findingGate'

export interface RenderableFinding {
  file: string
  line: number
  severity: FindingSeverity
  title: string
  body: string
}

/**
 * A stable identity for "the same finding, seen again".
 *
 * `hunkDigest` is supplied by the caller from the diff the finding sits in; it
 * is what keeps the fingerprint stable across a rebase that shifts line numbers
 * while leaving the code alone. Encoded rather than joined, for the reason
 * recorded in `dev-gotchas.md`: any separator can appear inside a title.
 */
export function fingerprintFor(finding: RenderableFinding, hunkDigest: string): string {
  const key = JSON.stringify([finding.file, finding.title.trim().toLowerCase(), hunkDigest])
  // Through `sha256Hex`, not a local `createHash` — RFC-284 T7 locks the
  // single-step hex idiom to that one helper, and a second spelling of the same
  // thing is how two call sites drift apart.
  //
  // sha256 rather than a fast non-cryptographic hash because this value is
  // PERSISTED in the findings ledger. A hash whose algorithm is not a contract
  // (`Bun.hash`) would re-key every row the day a runtime upgrade changed its
  // default: the whole ledger detaches, every open finding republishes as new,
  // and nothing in the system reports an error while it happens.
  //
  // Truncated to 16 hex chars: this is an identity, not a security primitive,
  // and it rides in an HTML comment on every published comment.
  return sha256Hex(key).slice(0, 16)
}

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  blocker: 'Blocker',
  major: 'Major',
  minor: 'Minor',
  info: 'Note',
}

/**
 * Render one finding as a comment body, fingerprint attached.
 *
 * The severity leads because it is what a reader triages on, and the title is
 * bold on its own line so a thread is scannable when collapsed.
 */
export function renderFindingComment(finding: RenderableFinding, fingerprint: string): string {
  const body = [
    `**${SEVERITY_LABEL[finding.severity]} — ${finding.title.trim()}**`,
    '',
    finding.body.trim(),
  ].join('\n')
  return withFingerprintMarker(body, fingerprint)
}

export interface OverviewInput {
  /** How many findings were placed on a line. */
  posted: number
  /** Findings that could not be placed and ride the overview. */
  carried: number
  /** Above the threshold but cut by the per-round cap. */
  truncated: number
  /** Dropped for being below the configured severity threshold. */
  belowThreshold: number
  /** Files whose contents the host did not provide. */
  omitted: ReadonlyArray<{ path: string; omission: string }>
  /** True when the diff did not fit the review prompt. */
  diffClipped: boolean
  headSha: string
}

/**
 * The overview comment's opening.
 *
 * Every number here exists to stop the review from reading as more complete
 * than it was. "Reviewed, 3 findings" next to a diff that was clipped and two
 * files that were never read is a claim the round cannot support — and the
 * author has no way to know unless it is said.
 */
export function renderOverviewPrelude(input: OverviewInput): string {
  const lines: string[] = []
  const total = input.posted + input.carried

  lines.push(
    total === 0
      ? `Reviewed \`${input.headSha.slice(0, 8)}\` — no findings this round.`
      : `Reviewed \`${input.headSha.slice(0, 8)}\` — ${total} finding${total === 1 ? '' : 's'}.`,
  )

  const caveats: string[] = []
  if (input.truncated > 0) {
    // Distinct from below-threshold on purpose: these WOULD have been shown.
    caveats.push(
      `${input.truncated} further finding${input.truncated === 1 ? ' was' : 's were'} withheld by the per-round limit`,
    )
  }
  if (input.belowThreshold > 0) {
    caveats.push(`${input.belowThreshold} below the configured severity threshold`)
  }
  if (input.diffClipped) {
    caveats.push('the diff was too large to review in full, so only its first part was read')
  }
  if (input.omitted.length > 0) {
    const names = input.omitted.map((f) => `\`${f.path}\` (${f.omission})`).join(', ')
    caveats.push(`these changed files carried no readable diff and were not reviewed: ${names}`)
  }

  if (caveats.length > 0) {
    lines.push('')
    for (const caveat of caveats) lines.push(`- ${caveat}`)
  }
  return lines.join('\n')
}
