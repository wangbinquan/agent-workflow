// RFC-304 §6.1 — `resolve-positions` + `publish`: putting the review on the MR.
//
// The two providers are genuinely different here and the difference is not
// cosmetic (see `hasPartialPublishWindow`):
//
//   GitLab  one request per comment. A failure halfway leaves the earlier
//           comments posted, so there IS a partial window.
//   GitHub  one review request carries every comment plus the commit id, so it
//           either all lands or none of it does.
//
// The invariant that holds across both: **a finding is never silently lost**.
// Anything that could not be placed on a line — because its position could not
// be built, or because publishing stopped — is carried in the overview comment
// instead. That is why the overview is written LAST and composed from what
// actually happened, rather than pre-rendered from what was hoped for. A review
// that posts four of seven findings and says nothing about the other three is
// worse than one that posts none, because the author reasonably reads the four
// as the whole answer.

import {
  buildGithubPosition,
  buildGitlabPosition,
  type AnchoredLine,
  type GitlabDiffRefs,
} from '@/modules/code-capability/domain/reviewPosition'
import { apiProjectAddress, type RoundTarget } from '@/modules/code-capability/domain/resolveTarget'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'

export interface PlacedFinding {
  /** Rendered comment body. */
  body: string
  anchor: AnchoredLine
  /** For the overview's "could not place" list. */
  label: string
  /**
   * The finding's identity across rounds.
   *
   * Carried here rather than recomputed after publishing because the ledger row
   * has to name the same finding the comment does — and the fingerprint depends
   * on the hunk text, which this stage no longer has.
   */
  fingerprint: string
}

export interface UnplacedFinding {
  body: string
  label: string
  /** Why it could not be attached to a line. */
  reason: string
  fingerprint: string
}

export interface PublishReviewInput {
  codeHost: CodeHostPort
  target: RoundTarget
  placed: readonly PlacedFinding[]
  /** Already known to be unattachable — degraded at `resolve-positions`. */
  unplaced: readonly UnplacedFinding[]
  /** GitLab only; GitHub carries the commit id on the review itself. */
  diffRefs?: GitlabDiffRefs
  /** Rendered by the caller; this stage appends what it could not place. */
  overviewPrelude: string
}

/**
 * What one published finding became on the host.
 *
 * `externalId` is the thread the finding owns, and it is what `settle-stale`
 * later resolves or replies to. It is null on GitHub: `review.submit` posts the
 * whole batch in one request and its response carries the review, not the
 * individual comment ids, and the action registry has no list action to read
 * them back with. A GitHub finding therefore settles as `skip` rather than
 * getting a "no longer present" reply — a real gap, recorded here instead of
 * looking like a lifecycle that silently does nothing.
 */
export interface PublishedFinding {
  fingerprint: string
  externalId: string | null
}

export interface PublishReviewResult {
  posted: number
  /** Everything that ended up in the overview instead of on a line. */
  carriedInOverview: UnplacedFinding[]
  overviewPosted: boolean
  /** Per finding, in publish order — what the ledger records. */
  publishedFindings: PublishedFinding[]
  /** Set when publishing stopped early; the round failed, but visibly. */
  failure: { code: string; message: string } | null
}

/**
 * The host's id for a thread just created.
 *
 * Returns null rather than throwing on anything unexpected: a response we
 * cannot read means the comment still landed, and failing the round over an
 * unrecognised body would retract a review the author can already see.
 */
function threadIdFrom(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return null
    const id = (parsed as { id?: unknown }).id
    if (typeof id === 'string') return id
    if (typeof id === 'number') return String(id)
    return null
  } catch {
    return null
  }
}

function renderOverview(prelude: string, carried: readonly UnplacedFinding[]): string {
  if (carried.length === 0) return prelude
  const lines = [prelude, '', '---', '', 'These findings could not be placed on a line:', '']
  for (const item of carried) {
    lines.push(`- **${item.label}** — ${item.reason}`)
    lines.push('')
    lines.push(item.body)
    lines.push('')
  }
  return lines.join('\n')
}

export async function publishReview(input: PublishReviewInput): Promise<PublishReviewResult> {
  const { codeHost, target } = input
  const carried: UnplacedFinding[] = [...input.unplaced]

  const project = apiProjectAddress(target)
  if (!project.ok) {
    return {
      posted: 0,
      carriedInOverview: carried,
      overviewPosted: false,
      publishedFindings: [],
      failure: { code: 'unaddressable', message: project.message },
    }
  }

  const base = { project: project.value, mr: target.anchorId }
  let posted = 0
  let failure: PublishReviewResult['failure'] = null

  if (target.provider === 'github') {
    // One request. `commit_id` sits on the review rather than on each comment,
    // which is what makes the whole thing atomic.
    const comments: Array<Record<string, unknown>> = []
    const submitted: string[] = []
    for (const item of input.placed) {
      const built = buildGithubPosition(item.anchor)
      if (!built.ok) {
        carried.push({
          body: item.body,
          label: item.label,
          reason: built.reason,
          fingerprint: item.fingerprint,
        })
        continue
      }
      comments.push({ ...built.position, body: item.body })
      submitted.push(item.fingerprint)
    }

    const result = await codeHost.call({
      action: 'review.submit',
      params: {
        ...base,
        body: renderOverview(input.overviewPrelude, carried),
        review_event: 'COMMENT',
        comments: JSON.stringify(comments),
        commit_id: target.headSha,
      },
    })
    if (!result.ok) {
      return {
        posted: 0,
        carriedInOverview: carried,
        overviewPosted: false,
        publishedFindings: [],
        failure: { code: result.code, message: result.message },
      }
    }
    return {
      posted: comments.length,
      carriedInOverview: carried,
      overviewPosted: true,
      // Recorded WITHOUT thread ids — see `PublishedFinding`. The ledger still
      // gets its rows, so dedup across rounds works on GitHub; only the
      // settle-stale reply is unavailable there.
      publishedFindings: submitted.map((fingerprint) => ({ fingerprint, externalId: null })),
      failure: null,
    }
  }

  // GitLab: one request per comment, so failures are partial by nature.
  if (input.diffRefs === undefined) {
    // Refused rather than attempted: GitLab rejects a position without
    // `diff_refs`, so every comment would fail one at a time and the round
    // would look like a host outage instead of a missing input.
    return {
      posted: 0,
      carriedInOverview: carried,
      overviewPosted: false,
      publishedFindings: [],
      failure: {
        code: 'diff-refs-missing',
        message: 'GitLab inline comments need the MR diff_refs (base/start/head sha)',
      },
    }
  }

  // Indexed rather than `for…of` + `indexOf`: two findings can legitimately be
  // the same object reference, and `indexOf` would then resolve to the FIRST
  // one — re-listing already-posted comments as unposted in the overview.
  const publishedFindings: PublishedFinding[] = []
  for (let index = 0; index < input.placed.length; index++) {
    const item = input.placed[index]!
    const built = buildGitlabPosition(item.anchor, input.diffRefs)
    if (!built.ok) {
      carried.push({
        body: item.body,
        label: item.label,
        reason: built.reason,
        fingerprint: item.fingerprint,
      })
      continue
    }
    const result = await codeHost.call({
      action: 'comment.create-inline',
      params: { ...base, body: item.body, position: JSON.stringify(built.position) },
    })
    if (result.ok) {
      posted += 1
      // The discussion id, straight from the response that created it. This is
      // the thread `settle-stale` resolves when the finding stops appearing, so
      // losing it here would leave a resolved-looking MR carrying threads for
      // problems that are long gone.
      publishedFindings.push({
        fingerprint: item.fingerprint,
        externalId: threadIdFrom(result.body),
      })
      continue
    }
    // Stop, but do NOT drop what is left: everything unposted moves into the
    // overview so the author still sees it.
    failure = { code: result.code, message: result.message }
    for (const remaining of input.placed.slice(index)) {
      carried.push({
        body: remaining.body,
        label: remaining.label,
        reason: `publishing stopped after a host error (${result.code})`,
        fingerprint: remaining.fingerprint,
      })
    }
    break
  }

  const overview = await codeHost.call({
    action: 'comment.create',
    params: { ...base, body: renderOverview(input.overviewPrelude, carried) },
  })

  return {
    posted,
    carriedInOverview: carried,
    publishedFindings,
    overviewPosted: overview.ok,
    failure: failure ?? (overview.ok ? null : { code: overview.code, message: overview.message }),
  }
}
