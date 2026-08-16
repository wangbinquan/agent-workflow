// RFC-304 T43 — the human's "yes, push it", and what it is a yes TO.
//
// The patch path exists because some changes cannot be a one-click suggestion.
// It posts a diff and waits. Then someone replies, and this module decides
// whether that reply is a confirmation — a decision that ends in a push to
// somebody's branch, which is why both halves of it are conservative.
//
// ## Why the keyword must START the comment
//
// A review thread is full of sentences that contain the word "apply". The
// platform's own posted diff will say "reply with /aw apply to push this",
// which someone will quote. A substring match would push on a quote of the
// instructions. So the rule is the one this repo already uses for webhook
// command triggers (`matching.ts`): the comment must BEGIN with the command.
//
// ## Why a confirmation names an artifact
//
// "Yes" is only meaningful against the thing that was shown. Between posting
// the diff and reading the reply, the author can push, which changes the base
// and makes the frozen patch describe a file that no longer looks like that.
// The posted comment therefore carries the artifact's short digest, and a
// confirmation is checked against the artifact still pending on that thread:
// if it was superseded, the reply is refused with an explanation rather than
// silently pushing the older change (C7).
//
// A human MAY also paste the digest explicitly, which is the only way to say
// "I mean that one" when two are in flight. When they do, it has to match.

/** The marker the posted patch comment carries, so a reply can be tied to it. */
export const PATCH_ARTIFACT_MARKER_PREFIX = '<!-- aw-patch:'

/** Commands that mean "push it". Configurable; these are the defaults. */
export const DEFAULT_CONFIRM_KEYWORDS: readonly string[] = ['/aw apply', '/aw push']

/**
 * How much of a digest is shown to people.
 *
 * 12 hex characters, the same length git uses for an abbreviated sha and for
 * the same reason: long enough that a collision is not a practical concern,
 * short enough to read out loud and to paste without wrapping.
 */
export const SHORT_DIGEST_LENGTH = 12

export function shortDigest(digest: string): string {
  return digest.slice(0, SHORT_DIGEST_LENGTH)
}

/** The hidden marker embedded in a posted patch comment. */
export function patchArtifactMarker(digest: string): string {
  return `${PATCH_ARTIFACT_MARKER_PREFIX}${shortDigest(digest)} -->`
}

/** Read the artifact a posted comment refers to, if it is one of ours. */
export function readPatchArtifactMarker(body: string): string | null {
  const match = /<!-- aw-patch:([0-9a-f]{4,64}) -->/.exec(body)
  return match?.[1] ?? null
}

export type Confirmation =
  /** `digest` is present only when the human named one explicitly. */
  | { confirmed: true; digest: string | null }
  | {
      confirmed: false
      /**
       * `not-a-command` covers ordinary discussion — by far the common case, and
       * deliberately not reported anywhere: a thread where every unrelated
       * comment produced a "that was not a command" reply would be unusable.
       */
      reason: 'not-a-command'
    }

/**
 * Is this comment a confirmation?
 *
 * Case-insensitive on the keyword (people type `/AW Apply`) but anchored to the
 * start. Leading whitespace is allowed — a comment box that inserts a newline
 * should not change the meaning of what was typed.
 */
export function parseConfirmation(
  body: string,
  keywords: readonly string[] = DEFAULT_CONFIRM_KEYWORDS,
): Confirmation {
  const trimmed = body.trim()
  const lower = trimmed.toLowerCase()

  const matched = keywords.find((keyword) => lower.startsWith(keyword.toLowerCase()))
  if (matched === undefined) return { confirmed: false, reason: 'not-a-command' }

  // Anything after the command may name the artifact. Only a bare hex token is
  // read as one: prose after the command is a comment on the change, not an
  // identifier, and treating a stray word as a digest would turn every
  // "/aw apply thanks!" into a mismatch.
  const rest = trimmed.slice(matched.length).trim()
  const digest = /^([0-9a-f]{4,64})\b/.exec(rest.toLowerCase())?.[1] ?? null

  return { confirmed: true, digest }
}

export type ConfirmationVerdict =
  /** Push exactly this artifact. */
  | { decision: 'push'; artifactDigest: string }
  /** Say why, and do not push. `message` is posted verbatim to the thread. */
  | { decision: 'refuse'; message: string }
  /** Not a command at all — stay silent. */
  | { decision: 'ignore' }

export interface PendingPatch {
  /** Full digest of the frozen artifact. */
  digest: string
  /** The head the artifact was built on. */
  baseSha: string
  /** The work item generation it belongs to; a later push bumps this. */
  generation: number
}

export interface ConfirmationContext {
  /** The artifact still pending on this thread, if any. */
  pending: PendingPatch | null
  /** The work item's generation right now. */
  currentGeneration: number
  /** The merge request's head right now. */
  currentHeadSha: string
  keywords?: readonly string[]
}

/**
 * Decide what a reply means.
 *
 * Every refusal explains itself on the thread. A confirmation that quietly does
 * nothing is the worst outcome available: the person believes they approved the
 * change, and nothing arrives — so they wait, and then they stop trusting the
 * mechanism.
 */
export function judgeConfirmation(body: string, ctx: ConfirmationContext): ConfirmationVerdict {
  const parsed = parseConfirmation(body, ctx.keywords ?? DEFAULT_CONFIRM_KEYWORDS)
  if (!parsed.confirmed) return { decision: 'ignore' }

  if (ctx.pending === null) {
    return {
      decision: 'refuse',
      message:
        'There is no change waiting for confirmation on this thread — it may have already been pushed, or superseded by a newer revision.',
    }
  }

  if (parsed.digest !== null && !ctx.pending.digest.startsWith(parsed.digest)) {
    return {
      decision: 'refuse',
      message: `That identifier does not match the change waiting here (\`${shortDigest(ctx.pending.digest)}\`). Nothing was pushed.`,
    }
  }

  // The generation check, and the reason the digest is frozen at all. A push by
  // the author between the diff being posted and this reply means the change
  // was computed against a file that has since moved; applying it now would
  // reintroduce or clobber whatever they just did.
  if (ctx.pending.generation !== ctx.currentGeneration) {
    return {
      decision: 'refuse',
      message:
        'This merge request changed after that diff was posted, so the change no longer applies to the current code. Nothing was pushed — a fresh one will be prepared.',
    }
  }

  if (ctx.pending.baseSha !== ctx.currentHeadSha) {
    // Distinct from the generation check on purpose: the generation is the
    // platform's own bookkeeping, and this compares against what the code host
    // reports right now. They disagree exactly when the platform has not yet
    // processed an event, which is the window this guard exists for.
    return {
      decision: 'refuse',
      message: `The branch has moved since that diff was prepared (it was built on \`${ctx.pending.baseSha.slice(0, 12)}\`, the branch is now at \`${ctx.currentHeadSha.slice(0, 12)}\`). Nothing was pushed.`,
    }
  }

  return { decision: 'push', artifactDigest: ctx.pending.digest }
}
