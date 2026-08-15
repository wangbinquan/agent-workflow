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
}

export interface UnplacedFinding {
  body: string
  label: string
  /** Why it could not be attached to a line. */
  reason: string
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

export interface PublishReviewResult {
  posted: number
  /** Everything that ended up in the overview instead of on a line. */
  carriedInOverview: UnplacedFinding[]
  overviewPosted: boolean
  /** Set when publishing stopped early; the round failed, but visibly. */
  failure: { code: string; message: string } | null
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
    for (const item of input.placed) {
      const built = buildGithubPosition(item.anchor)
      if (!built.ok) {
        carried.push({ body: item.body, label: item.label, reason: built.reason })
        continue
      }
      comments.push({ ...built.position, body: item.body })
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
        failure: { code: result.code, message: result.message },
      }
    }
    return {
      posted: comments.length,
      carriedInOverview: carried,
      overviewPosted: true,
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
      failure: {
        code: 'diff-refs-missing',
        message: 'GitLab inline comments need the MR diff_refs (base/start/head sha)',
      },
    }
  }

  // Indexed rather than `for…of` + `indexOf`: two findings can legitimately be
  // the same object reference, and `indexOf` would then resolve to the FIRST
  // one — re-listing already-posted comments as unposted in the overview.
  for (let index = 0; index < input.placed.length; index++) {
    const item = input.placed[index]!
    const built = buildGitlabPosition(item.anchor, input.diffRefs)
    if (!built.ok) {
      carried.push({ body: item.body, label: item.label, reason: built.reason })
      continue
    }
    const result = await codeHost.call({
      action: 'comment.create-inline',
      params: { ...base, body: item.body, position: JSON.stringify(built.position) },
    })
    if (result.ok) {
      posted += 1
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
    overviewPosted: overview.ok,
    failure: failure ?? (overview.ok ? null : { code: overview.code, message: overview.message }),
  }
}
