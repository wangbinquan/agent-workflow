// RFC-304 §6.3 T49 — where a clarifying question goes, and where it does not.
//
// The user's ruling (design D2) is one sentence: **ask where it was asked from**.
// Everything here follows from it, including the part that looks unhelpful.
//
//   entered by labelling an issue  → the question is an ISSUE COMMENT. Only.
//   entered from /code or the API  → the question is a platform clarification.
//
// ## The fallback that must not exist
//
// The obvious kindness is "post to the issue if we can, otherwise fall back to
// the platform". The design gate struck that out (P1) and the reason is worth
// keeping in front of whoever reads this next: the person who labelled the issue
// is watching the issue. They may not have an account on this platform at all.
// A question that quietly lands somewhere else is a question they never see, and
// the requirement sits `awaiting` until someone happens to notice.
//
// So an issue-entered capability with no working write-back channel REFUSES TO
// START, and says why. That is a worse-looking outcome and a better one: the
// person is told immediately, at the moment they asked, in the place they asked.

export type ClarifyOrigin =
  /** Labelled an issue. The write-back handle is how the answer gets home. */
  | { kind: 'issue'; hasWritebackHandle: boolean; frameworkSupportsWriteback: boolean }
  /** Started from the platform's own UI or API. */
  | { kind: 'platform' }

export type ClarifyRoute =
  /** Post the question as a comment on the originating issue. */
  | { route: 'issue-comment' }
  /** Ask through the platform's own clarification surface. */
  | { route: 'platform' }
  /**
   * The capability must not start. `message` is shown where the person asked —
   * on the issue if it can be posted there, and in the enable/launch response
   * either way.
   */
  | { route: 'refuse'; message: string }

/**
 * Where does a question for this requirement go?
 *
 * Total on `ClarifyOrigin`, and deliberately without a default arm: adding an
 * entry point later must be a compile error here, not a silent inheritance of
 * whichever branch happened to be last.
 */
export function routeClarify(origin: ClarifyOrigin): ClarifyRoute {
  if (origin.kind === 'platform') return { route: 'platform' }

  if (!origin.hasWritebackHandle) {
    return {
      route: 'refuse',
      message: [
        'This requirement was submitted by labelling an issue, so any question about it',
        'has to come back to that issue — but this entry point has no way to write back.',
        '',
        'Nothing was started. Configure the write-back channel for this repository, or',
        'submit the requirement from the platform instead, where questions can be asked',
        'and answered in one place.',
      ].join('\n'),
    }
  }

  if (!origin.frameworkSupportsWriteback) {
    return {
      route: 'refuse',
      message: [
        'This requirement was submitted by labelling an issue, but the framework configured',
        'for this repository does not implement writing back to one.',
        '',
        'Nothing was started. A question asked anywhere else would be a question you never',
        'see — you are watching the issue, and may not have an account here at all.',
      ].join('\n'),
    }
  }

  return { route: 'issue-comment' }
}

/**
 * Whether this entry point is usable at all, for the readiness matrix.
 *
 * Same rule as `routeClarify`, asked before anything runs. A cell that reports
 * `ready` and then refuses at round start has told the operator the opposite of
 * the truth at the only moment they were looking.
 */
export function issueEntryUsable(origin: ClarifyOrigin): { usable: boolean; reason?: string } {
  const route = routeClarify(origin)
  return route.route === 'refuse' ? { usable: false, reason: route.message } : { usable: true }
}

/**
 * The question, as posted to an issue.
 *
 * Carries a round marker so the ANSWER can be tied back to the question it
 * answers (T49). Without it, a busy issue with two outstanding questions has no
 * way to tell which reply belongs to which — and the platform would either
 * guess or ask again.
 */
export const CLARIFY_MARKER_PREFIX = '<!-- aw-clarify:'

export function clarifyMarker(roundId: string, questionId: string): string {
  return `${CLARIFY_MARKER_PREFIX}${roundId}:${questionId} -->`
}

export function readClarifyMarker(body: string): { roundId: string; questionId: string } | null {
  const match = /<!-- aw-clarify:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+) -->/.exec(body)
  if (match?.[1] === undefined || match[2] === undefined) return null
  return { roundId: match[1], questionId: match[2] }
}

export interface ClarifyQuestion {
  id: string
  text: string
}

/**
 * Render the questions as one issue comment.
 *
 * One comment for the whole set, not one per question: three separate comments
 * on an issue read as three separate demands, and the person answers the last
 * one and forgets the others. Numbered so a reply can say "2: yes".
 */
export function renderClarifyComment(
  roundId: string,
  questions: readonly ClarifyQuestion[],
): string {
  const numbered = questions.map((q, index) => `${String(index + 1)}. ${q.text.trim()}`).join('\n')

  return [
    questions.length === 1
      ? 'Before implementing this, one thing needs deciding:'
      : `Before implementing this, ${String(questions.length)} things need deciding:`,
    '',
    numbered,
    '',
    'Reply here and work will continue. Nothing is being implemented until then.',
    '',
    // One marker for the comment, keyed by the first question: the reply is a
    // free-text answer to the whole set, and tying it to the ROUND is what the
    // resume needs. Per-question markers would suggest a per-question reply
    // protocol the platform does not implement.
    clarifyMarker(roundId, questions[0]?.id ?? 'q1'),
  ].join('\n')
}
