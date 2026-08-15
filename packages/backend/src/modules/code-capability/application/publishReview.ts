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
import { decideBatch, type DraftOutcome } from '@/modules/code-capability/domain/batchPublish'
import {
  normalizeRemoteComments,
  observeJustPublished,
} from '@/modules/code-capability/domain/publishReconcileRemote'
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

/**
 * Map this batch's fingerprints to the comments now on the merge request.
 *
 * Both hosts need this, for different reasons. GitHub's review response carries
 * the review rather than its comments' ids. GitLab's `bulk_publish` turns drafts
 * into notes whose discussion ids are new — the draft ids are dead. Either way
 * the only authority on "which thread carries this finding" is the MR itself.
 *
 * Only fingerprints from THIS batch are adopted: a long-lived PR carries
 * comments from earlier rounds, and claiming one of those as a thread this
 * round created would attach the wrong id to a finding — later resolving or
 * replying to a remark somebody else's round made.
 */
async function readBackIds(
  codeHost: CodeHostPort,
  provider: 'gitlab' | 'github',
  base: { project: string; mr: string },
  batch: readonly string[],
): Promise<Record<string, string>> {
  if (batch.length === 0) return {}
  const listed = await codeHost.call({
    action: 'comment.list',
    params: { ...base, per_page: '100' },
  })
  if (!listed.ok) return {}
  return observeJustPublished(batch, normalizeRemoteComments(provider, listed.body)).present
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
    // GitHub's review response carries the review, not the ids of the comments
    // inside it, so the ids are read back. That extra call is the only way to
    // get them: without it every GitHub finding lands in the ledger with a null
    // thread, and `settle-stale` can never say "this is gone" — the remark just
    // goes quiet when the problem is fixed.
    //
    // The read-back is keyed by the fingerprint marker each body carries, which
    // is the same mechanism §7.2 recovery uses. A failure here does NOT fail the
    // round: the comments are already published and visible, and retracting a
    // review over a bookkeeping read would be far worse than a ledger row with
    // no thread id.
    const ids = await readBackIds(codeHost, 'github', base, submitted)
    return {
      posted: comments.length,
      carriedInOverview: carried,
      overviewPosted: true,
      publishedFindings: submitted.map((fingerprint) => ({
        fingerprint,
        externalId: ids[fingerprint] ?? null,
      })),
      failure: null,
    }
  }

  // GitLab: stage every comment as a draft, then publish them in ONE call.
  //
  // The obvious implementation — one `comment.create-inline` per finding — has a
  // partial window that is visible to the author: a failure halfway leaves the
  // first few remarks on the MR and nothing explaining the rest. Drafts move
  // that window somewhere harmless. A failure during staging is compensated by
  // deleting the drafts that DID land, so the MR looks untouched; only after
  // every draft is staged does the single publish make the review appear.
  //
  // Compensation is not optional politeness: an abandoned batch of drafts stays
  // visible on the MR as notes that will never be published, which reads as the
  // bot having got halfway and given up.
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

  const outcomes: DraftOutcome[] = []
  for (const item of input.placed) {
    const built = buildGitlabPosition(item.anchor, input.diffRefs)
    if (!built.ok) {
      // Not a draft failure — it was never stageable. It rides the overview,
      // and must NOT enter `outcomes`, or `decideBatch` would compensate a
      // batch that is actually fine.
      carried.push({
        body: item.body,
        label: item.label,
        reason: built.reason,
        fingerprint: item.fingerprint,
      })
      continue
    }
    const result = await codeHost.call({
      action: 'review.draft-create',
      params: { ...base, body: item.body, position: JSON.stringify(built.position) },
    })
    outcomes.push(
      result.ok
        ? { fingerprint: item.fingerprint, ok: true, draftId: threadIdFrom(result.body) ?? '' }
        : {
            fingerprint: item.fingerprint,
            ok: false,
            error: `${result.code}: ${result.message}`,
          },
    )
  }

  const decision = decideBatch(outcomes)
  const publishedFindings: PublishedFinding[] = []

  // A draft that was created but whose id we could not read cannot be deleted —
  // it stays on the MR as an orphan. Counted rather than ignored: that is the
  // one outcome this whole mechanism exists to prevent, so if it happens the
  // failure message has to say so instead of claiming a clean withdrawal.
  let orphaned = 0

  if (decision.action === 'compensate') {
    // Delete what landed, so the MR shows nothing rather than half a review.
    for (const draftId of decision.deleteDraftIds) {
      if (draftId === '') {
        orphaned += 1
        continue
      }
      const discarded = await codeHost.call({
        action: 'review.draft-discard',
        params: { ...base, draft: draftId },
      })
      if (!discarded.ok) orphaned += 1
    }
    // Everything moves to the overview: the findings are real and the author
    // should still see them, even though none could be placed on a line.
    for (const item of input.placed) {
      if (!outcomes.some((o) => o.fingerprint === item.fingerprint)) continue
      carried.push({
        body: item.body,
        label: item.label,
        reason: 'this review could not be staged on the merge request',
        fingerprint: item.fingerprint,
      })
    }
    failure = {
      code: 'draft-staging-failed',
      message:
        orphaned === 0
          ? `${decision.failedFingerprints.length} comment(s) could not be staged; the partial batch was withdrawn`
          : `${decision.failedFingerprints.length} comment(s) could not be staged, and ${orphaned} draft(s) could NOT be withdrawn — they remain on the merge request and must be removed by hand`,
    }
  } else if (decision.action === 'publish') {
    const published = await codeHost.call({ action: 'review.draft-publish', params: base })
    if (published.ok) {
      posted = decision.draftIds.length
      // Read back, do NOT reuse the draft id. `bulk_publish` turns draft notes
      // into ordinary notes and the resulting DISCUSSION has its own id; the
      // draft id is dead the moment it publishes. Recording it would give every
      // finding a thread reference that `thread.resolve` rejects — a ledger
      // full of ids that look right and resolve nothing.
      //
      // The draft ids are still needed above, for compensation: withdrawing a
      // staged batch addresses drafts, not discussions.
      const ids = await readBackIds(
        codeHost,
        'gitlab',
        base,
        decision.draftIds.length > 0 ? outcomes.filter((o) => o.ok).map((o) => o.fingerprint) : [],
      )
      for (const outcome of outcomes) {
        if (!outcome.ok) continue
        publishedFindings.push({
          fingerprint: outcome.fingerprint,
          externalId: ids[outcome.fingerprint] ?? null,
        })
      }
    } else {
      // Staged but not published. The drafts are on the MR and invisible to
      // nobody but the author's reviewers — withdraw them for the same reason
      // as above.
      for (const draftId of decision.draftIds) {
        if (draftId === '') {
          orphaned += 1
          continue
        }
        const discarded = await codeHost.call({
          action: 'review.draft-discard',
          params: { ...base, draft: draftId },
        })
        if (!discarded.ok) orphaned += 1
      }
      for (const item of input.placed) {
        if (!outcomes.some((o) => o.ok && o.fingerprint === item.fingerprint)) continue
        carried.push({
          body: item.body,
          label: item.label,
          reason: `publishing the staged review failed (${published.code})`,
          fingerprint: item.fingerprint,
        })
      }
      failure = {
        code: published.code,
        message:
          orphaned === 0
            ? published.message
            : `${published.message} (and ${orphaned} staged draft(s) could NOT be withdrawn — they remain on the merge request)`,
      }
    }
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
