// RFC-304 T44 — who may turn a proposed change into a push.
//
// The two delivery forms need different answers, and the reason is not policy
// preference — it is who performs the write:
//
//   suggestion — the HOST applies it, as the person who clicked. It lands under
//                their name with their permissions, and the host already
//                refuses if they cannot write. So the platform adds no gate of
//                its own: doing so would block a reviewer from applying a
//                one-line fix to a branch they can push to directly.
//   patch      — the PLATFORM pushes, with its own credentials. Nobody's own
//                permissions are consulted by anything downstream, so the only
//                thing standing between a comment and a commit on somebody's
//                branch is this function.
//
// ## Why the author, and not "anyone who can write"
//
// A reviewer with write access can push to the branch themselves. What they
// cannot do — what nobody should be able to do — is have the PLATFORM push to
// somebody else's in-progress branch on their say-so. The author is mid-thought
// on that branch; an unexpected commit means a rebase conflict at best and a
// silently overwritten local change at worst.
//
// ## Bot-opened merge requests
//
// On an MR the platform itself opened, `mr.author` is the platform. Treating
// that as the authority would mean the platform authorising its own pushes,
// which is not an authorisation at all. `initiatorUserId` is the human who
// asked for the work (proposal C3), and they are the one whose confirmation
// means something.

export interface PushAuthorityContext {
  /** Account that left the confirming comment. */
  commenter: string | null
  /** The merge request's author, as the host reports it. */
  mrAuthor: string | null
  /**
   * The human this work is on behalf of, when the MR was opened by a machine.
   * Null on an ordinary human-opened MR.
   */
  initiator: string | null
  /** The platform's own account, so it never authorises itself. */
  botUsername: string | null
}

export type PushAuthorityVerdict =
  | { allowed: true; because: 'author' | 'initiator' }
  /** `message` is posted to the thread verbatim — the person asked, and gets an answer. */
  | { allowed: false; message: string }

/**
 * May this commenter have the platform push the pending change?
 *
 * Every refusal explains itself on the thread. A confirmation that is silently
 * ignored teaches people the feature is unreliable, which costs more than the
 * refusal it was trying to be polite about.
 */
export function judgePushAuthority(ctx: PushAuthorityContext): PushAuthorityVerdict {
  const commenter = normalize(ctx.commenter)
  if (commenter === null) {
    return {
      allowed: false,
      message: 'This confirmation could not be attributed to an account, so nothing was pushed.',
    }
  }

  // The platform must never authorise itself. Without this, one of its own
  // comments quoting the instructions could confirm its own change.
  if (commenter === normalize(ctx.botUsername)) {
    return {
      allowed: false,
      message: 'That confirmation came from this platform’s own account, so nothing was pushed.',
    }
  }

  // The initiator takes precedence over the author, not the other way round: on
  // a bot-opened MR the author IS the platform, and checking the author first
  // would let it authorise itself through the front door.
  const initiator = normalize(ctx.initiator)
  if (initiator !== null) {
    return commenter === initiator
      ? { allowed: true, because: 'initiator' }
      : {
          allowed: false,
          message: `Only ${initiator}, who asked for this change, can confirm pushing it. Nothing was pushed.`,
        }
  }

  const author = normalize(ctx.mrAuthor)
  if (author === null) {
    return {
      allowed: false,
      message:
        'The merge request’s author could not be determined, so this change was not pushed. Apply the diff yourself, or re-run once the merge request is readable.',
    }
  }

  return commenter === author
    ? { allowed: true, because: 'author' }
    : {
        allowed: false,
        message: `Only ${author}, who owns this branch, can confirm pushing to it. An unexpected commit on a branch someone is working on costs them a rebase at best. Nothing was pushed — copy the diff if you want to apply it yourself.`,
      }
}

/** Host usernames are case-insensitive in practice; blanks are absent. */
function normalize(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}
