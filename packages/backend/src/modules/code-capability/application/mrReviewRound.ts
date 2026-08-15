// RFC-304 §6.1 — one round of `mr-review`, assembled.
//
// This is the T4a1z assembly: every stage already exists and is tested on its
// own, and this runs them in order. It stays thin deliberately — anything that
// looks like a decision here should have been a pure function upstream, because
// a decision reachable only through the whole chain is a decision nobody tests.
//
// The ordering carries meaning that is easy to lose:
//
//   prepare-worktree BEFORE fetch-diff, because a stale head must abort the
//   round before it spends a model call on a revision that is already obsolete;
//
//   gate BEFORE resolve-positions, because gating is about which findings are
//   worth showing and positioning is about where — running them the other way
//   would compute positions for findings that are then thrown away, and would
//   report anchoring failures for remarks nobody was going to see;
//
//   publish LAST and once, so the overview can state what actually happened.

import { fetchDiff } from '@/modules/code-capability/application/fetchDiff'
import { prepareWorktree } from '@/modules/code-capability/application/prepareWorktree'
import {
  publishReview,
  type PlacedFinding,
  type UnplacedFinding,
} from '@/modules/code-capability/application/publishReview'
import { runReviewStage } from '@/modules/code-capability/application/reviewStage'
import type { AiCaller, RetryBudget } from '@/modules/code-capability/application/determinismGuard'
import { hunkDigestFor, resolveAnchoredLine } from '@/modules/code-capability/domain/anchorLine'
import { applyGate, type GateConfig } from '@/modules/code-capability/domain/findingGate'
import { apiProjectAddress, type RoundTarget } from '@/modules/code-capability/domain/resolveTarget'
import {
  fingerprintFor,
  renderFindingComment,
  renderOverviewPrelude,
} from '@/modules/code-capability/domain/reviewComment'
import type { GitlabDiffRefs } from '@/modules/code-capability/domain/reviewPosition'
import type { ReviewFinding } from '@/modules/code-capability/domain/reviewEnvelope'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'

export interface MrReviewRoundInput {
  codeHost: CodeHostPort
  git: GitPort
  target: RoundTarget
  repoPath: string
  worktreePath: string
  makeCaller: (prompt: string) => AiCaller
  protocolBlock: string
  nonce: string
  budget: RetryBudget
  gate: GateConfig
  signal?: AbortSignal
}

export type MrReviewRoundResult =
  | { state: 'published'; posted: number; carried: number; failure: string | null }
  /** The head moved; the caller re-arms the work item at `fetchedSha`. */
  | { state: 'stale'; fetchedSha: string }
  /** Stopped before publishing anything. `stage` says where. */
  | { state: 'aborted'; stage: string; message: string }

/**
 * Read the MR itself.
 *
 * GitLab needs `diff_refs` for every inline position; without them each comment
 * is rejected one at a time. GitHub does not, but the title is worth having on
 * both — a reviewer told what the MR is FOR reads its diff differently.
 */
async function readMr(
  codeHost: CodeHostPort,
  target: RoundTarget,
): Promise<{ diffRefs?: GitlabDiffRefs; title: string | null } | { error: string }> {
  const project = apiProjectAddress(target)
  if (!project.ok) return { error: project.message }

  const result = await codeHost.call({
    action: 'mr.get',
    params: { project: project.value, mr: target.anchorId },
  })
  if (!result.ok) return { error: `${result.code}: ${result.message}` }

  let body: unknown
  try {
    body = JSON.parse(result.body)
  } catch {
    return { error: 'the code host returned a merge request body that is not JSON' }
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const title = typeof record.title === 'string' ? record.title : target.meta.title

  if (target.provider !== 'gitlab') return { title }

  const refs =
    typeof record.diff_refs === 'object' && record.diff_refs !== null
      ? (record.diff_refs as Record<string, unknown>)
      : null
  const baseSha = typeof refs?.base_sha === 'string' ? refs.base_sha : ''
  const startSha = typeof refs?.start_sha === 'string' ? refs.start_sha : ''
  const headSha = typeof refs?.head_sha === 'string' ? refs.head_sha : ''
  if (baseSha === '' || startSha === '' || headSha === '') {
    // Named here rather than left to fail at publish: all three are required,
    // and "the MR did not report its diff refs" is a far more useful thing to
    // read than N identical rejected-position errors.
    return { error: 'the merge request did not report diff_refs (base/start/head sha)' }
  }
  return { diffRefs: { baseSha, startSha, headSha }, title }
}

export async function runMrReviewRound(input: MrReviewRoundInput): Promise<MrReviewRoundResult> {
  const { codeHost, target } = input

  // In PR-4a the reviewer reads only the diff, so nothing below opens the
  // worktree. This stage still runs first, and not as ceremony: fetching the
  // head is what detects that the head MOVED, and that check has to happen
  // before the round spends a model call — and before it posts — on a revision
  // that is already obsolete. When sharded review lands (PR-4b) the worktree
  // itself starts being read; until then the staleness guard is the whole value.
  const worktree = await prepareWorktree({
    git: input.git,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    target,
  })
  if (worktree.state === 'stale') return { state: 'stale', fetchedSha: worktree.fetchedSha }
  if (worktree.state !== 'ready') {
    return { state: 'aborted', stage: 'prepare-worktree', message: worktree.message }
  }

  const mr = await readMr(codeHost, target)
  if ('error' in mr) return { state: 'aborted', stage: 'mr.get', message: mr.error }

  const diff = await fetchDiff({ codeHost, target })
  if (!diff.ok) return { state: 'aborted', stage: 'fetch-diff', message: diff.message }

  const review = await runReviewStage({
    makeCaller: input.makeCaller,
    nonce: input.nonce,
    budget: input.budget,
    unifiedDiff: diff.unifiedDiff,
    hunks: diff.hunks,
    omitted: diff.omitted,
    mrTitle: mr.title,
    protocolBlock: input.protocolBlock,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  })

  if (review.outcome.status === 'canceled') {
    return { state: 'aborted', stage: 'review', message: 'the round was canceled' }
  }
  if (review.outcome.status === 'exhausted') {
    // Constitution R5: no value escapes an exhausted stage, so there is nothing
    // to publish. Reported with the rejection count so the failure is legible.
    return {
      state: 'aborted',
      stage: 'review',
      message: `the reviewer did not produce a valid result after ${review.outcome.totalCalls} attempts`,
    }
  }

  const gated = applyGate<ReviewFinding>(review.outcome.value.findings, input.gate)

  // Positions AFTER the gate: computing them first would anchor findings that
  // are then discarded, and would report anchoring failures for remarks nobody
  // was going to see.
  const placed: PlacedFinding[] = []
  const unplaced: UnplacedFinding[] = []
  for (const finding of gated.published) {
    const anchor = resolveAnchoredLine(
      { file: finding.file, line: finding.line, side: finding.side },
      diff.hunks,
    )
    // The hunk's own TEXT, not its coordinates: a rebase shifts every line
    // number while changing no code, and a fingerprint that moved with them
    // would republish the whole previous review as new on every push.
    const digest = hunkDigestFor(
      { file: finding.file, line: finding.line, side: finding.side },
      diff.hunks,
    )
    const body = renderFindingComment(finding, fingerprintFor(finding, digest))
    const label = `${finding.file}:${finding.line}`

    if (anchor === null) {
      unplaced.push({ body, label, reason: 'this line is not part of the diff under review' })
      continue
    }
    placed.push({ body, anchor, label })
  }

  const prelude = renderOverviewPrelude({
    posted: placed.length,
    carried: unplaced.length,
    truncated: gated.truncated,
    belowThreshold: gated.belowThreshold,
    omitted: diff.omitted,
    diffClipped: review.diffClipped,
    headSha: target.headSha,
  })

  const published = await publishReview({
    codeHost,
    target,
    placed,
    unplaced,
    ...(mr.diffRefs !== undefined ? { diffRefs: mr.diffRefs } : {}),
    overviewPrelude: prelude,
  })

  return {
    state: 'published',
    posted: published.posted,
    carried: published.carriedInOverview.length,
    failure:
      published.failure === null ? null : `${published.failure.code}: ${published.failure.message}`,
  }
}
