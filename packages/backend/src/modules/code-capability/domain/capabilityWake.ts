// RFC-304 §3.1 — which capability cells a delivery wakes.
//
// Capabilities are NOT workflow triggers. A trigger is something a person wrote
// for one workflow; a capability cell is "this repository has MR review turned
// on", and it wakes on the events that capability is about. Routing them
// through the trigger table would make every team hand-write the same event
// list and get it subtly different.
//
// Pure, because the rule is the interesting part and it has to be readable
// without a dispatcher, a delivery and a database around it.
//
// ## The two directions this can be wrong
//
//   waking too eagerly  — a review round per comment on a busy MR, which is how
//                         the bot becomes the thing everyone mutes;
//   waking too rarely   — the author pushes a fix and nothing responds, which
//                         reads as the platform being broken.
//
// The default set below is deliberately the narrow one: an MR appearing, and an
// MR changing. Everything else a team wants is an explicit opt-in on the cell.

/** Events that start a review when a cell does not say otherwise. */
export const DEFAULT_MR_REVIEW_EVENTS: readonly string[] = ['mr_opened', 'mr_updated']

/**
 * The default event set PER CAPABILITY (RFC-304 T46b).
 *
 * One shared default was right while `mr-review` was the only capability and
 * wrong the moment a second arrived. Each capability is entered by a different
 * kind of thing happening, and a `requirement` cell subscribed to `mr_opened`
 * would never hear its own entry event — the person labels an issue and nothing
 * happens, with the matrix still reporting `ready`.
 *
 *   mr-review       an MR appearing or changing.
 *   mr-comment-fix  somebody commenting on one. Narrower than it looks: the
 *                   `mr-monitor` claim rule and the bot-author guard already
 *                   keep this from firing on the platform's own remarks.
 *   requirement     an issue being LABELLED. Not `issue_comment`: a comment on
 *                   an issue is how a clarifying question gets answered, and
 *                   treating it as an entry point would start a second round
 *                   for every reply.
 *   ci-fix          a pipeline failing.
 *   mr-monitor      everything that could mean work — it decides, and most of
 *                   the time it decides `noop`.
 */
export const DEFAULT_EVENTS_BY_CAPABILITY: Readonly<Record<string, readonly string[]>> = {
  'mr-review': DEFAULT_MR_REVIEW_EVENTS,
  'mr-comment-fix': ['note'],
  requirement: ['issue_labeled'],
  'ci-fix': ['pipeline_failed'],
  'mr-monitor': ['mr_opened', 'mr_updated', 'note', 'pipeline_failed', 'pipeline_succeeded'],
}

/**
 * Which anchor a capability's work item hangs off.
 *
 * A `requirement` is about an ISSUE; everything else is about a merge request.
 * Getting this wrong does not error — it creates a work item keyed to a merge
 * request number that happens to equal an issue number, which is a different
 * object with the same digits.
 */
export function anchorKindFor(capability: string): 'mr' | 'issue' {
  return capability === 'requirement' ? 'issue' : 'mr'
}

export interface WakeableCell {
  capability: string
  enabled: boolean
  readiness: string
  /** Parsed `trigger_config_json`. */
  triggerConfig: Readonly<Record<string, unknown>>
}

export interface WakeEvent {
  eventType: string
  /** Present on MR-associated events; absent means there is nothing to review. */
  mrIid?: string | undefined
  /** Present on issue-associated events; what an issue-anchored round works on. */
  issueIid?: string | undefined
  /** The account that caused the event, for the bot-loop guard. */
  authorUsername?: string | undefined
}

export type WakeVerdict =
  | { wake: true }
  | {
      wake: false
      reason:
        | 'not-ready'
        | 'event-not-subscribed'
        | 'no-mr'
        | 'no-issue'
        | 'own-comment'
        | 'bot-authored-mr'
    }

/**
 * Which events this cell subscribes to.
 *
 * A cell may narrow or widen the default by listing `events`. A present but
 * EMPTY list means "none" rather than "default" — someone who cleared the list
 * meant to stop it, and silently restoring the default would override them.
 */
export function subscribedEvents(cell: WakeableCell): readonly string[] {
  const configured = cell.triggerConfig.events
  if (!Array.isArray(configured)) {
    // An unknown capability falls back to the review set rather than to
    // nothing: a cell that silently subscribes to no events is a repository
    // that reports `ready` and never responds, which is the hardest failure
    // here to notice.
    return DEFAULT_EVENTS_BY_CAPABILITY[cell.capability] ?? DEFAULT_MR_REVIEW_EVENTS
  }
  return configured.filter((e): e is string => typeof e === 'string')
}

/**
 * Should this delivery start a round for this cell?
 *
 * `ready` rather than `enabled`, matching `wantsCapability`: acting on an
 * enabled-but-misconfigured cell produces a round that fails later, on the MR,
 * in front of the author.
 */
export function judgeWake(
  cell: WakeableCell,
  event: WakeEvent,
  options: { botUsername?: string | undefined } = {},
): WakeVerdict {
  if (!cell.enabled || cell.readiness !== 'ready') return { wake: false, reason: 'not-ready' }

  if (!subscribedEvents(cell).includes(event.eventType)) {
    return { wake: false, reason: 'event-not-subscribed' }
  }

  // Every MR-anchored round needs something to work on and somewhere to
  // publish. An MR-shaped event without an iid cannot supply either (design
  // §6.1 records this for fork PR CI events, whose `pull_requests[]` arrives
  // empty).
  //
  // Issue-anchored capabilities are checked against the ISSUE instead: a
  // `requirement` woken by a label has no merge request and never will until it
  // opens one, so demanding an iid here would reject its only entry point.
  if (anchorKindFor(cell.capability) === 'issue') {
    if (event.issueIid === undefined || event.issueIid === '') {
      return { wake: false, reason: 'no-issue' }
    }
  } else if (event.mrIid === undefined || event.mrIid === '') {
    return { wake: false, reason: 'no-mr' }
  }

  // The bot's own comments must not wake it. Without this a round publishes,
  // the publication is itself an event, and the next round starts — a loop that
  // costs money continuously and buries the MR under its own output.
  if (
    options.botUsername !== undefined &&
    options.botUsername !== '' &&
    event.authorUsername === options.botUsername
  ) {
    return { wake: false, reason: 'own-comment' }
  }

  // Opt-in only (E2): a machine's MR is supervised by DEFAULT, and this skips it
  // only for a team that has both switched it on AND named the accounts. Two
  // deliberate steps, because "we stopped reviewing a whole class of change" is
  // not something anybody should discover by accident.
  if (
    skipsBotAuthoredMr(cell) &&
    event.authorUsername !== undefined &&
    botAuthorsOf(cell).includes(event.authorUsername)
  ) {
    return { wake: false, reason: 'bot-authored-mr' }
  }

  return { wake: true }
}

/** The cells a delivery wakes, in a stable order. */
export function cellsWokenBy(
  cells: readonly WakeableCell[],
  event: WakeEvent,
  options: { botUsername?: string | undefined } = {},
): WakeableCell[] {
  return cells
    .filter((cell) => judgeWake(cell, event, options).wake)
    .sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0))
}

/** An open merge request, as the host lists it. */
export interface OpenMrCandidate {
  mrIid: string
  headSha: string
}

export type CiEventTarget =
  /** Exactly one open MR has this commit at its head — safe to review. */
  | { kind: 'unique'; mrIid: string }
  /** No open MR has it: a branch build, a closed MR, or a stale pipeline. */
  | { kind: 'none' }
  /**
   * Several do. NOT reviewed: the same commit heads more than one open MR when
   * a branch is shared or a stack of MRs is chained, and picking one would post
   * a review on an MR whose author never triggered anything.
   */
  | { kind: 'ambiguous'; mrIids: readonly string[] }

/**
 * Which merge request a CI event belongs to, when the event does not say.
 *
 * A pipeline event from a FORK carries no MR number — GitHub's
 * `pull_requests[]` arrives empty for fork PRs, because the pipeline ran in the
 * fork's own repository. So the only link back is the commit, and the mapping
 * is head-sha → open MR.
 *
 * Unique-match-only is the whole point. Reviewing on a guess means commenting
 * on somebody else's merge request in their name, which is worse than not
 * reacting to a CI event at all — the second is a missing feature, the first is
 * the platform doing something nobody asked for on a change nobody submitted.
 */
export function resolveCiEventMr(
  candidates: readonly OpenMrCandidate[],
  headSha: string,
): CiEventTarget {
  if (headSha === '') return { kind: 'none' }
  const matches = candidates.filter((c) => c.headSha === headSha).map((c) => c.mrIid)
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length === 1) return { kind: 'unique', mrIid: matches[0]! }
  return { kind: 'ambiguous', mrIids: [...matches].sort() }
}

/**
 * Whether this cell declines to review merge requests opened by a machine.
 *
 * Default FALSE, deliberately. The user's decision (E2, recorded in design
 * §11.1) is that bot-authored MRs are supervised by DEFAULT — a machine's code
 * is not more trustworthy than a person's, and the case for reviewing it is if
 * anything stronger. So this is an opt-in for teams whose bots open MRs the
 * review has nothing useful to say about (dependency bumps, generated
 * lockfiles), never a default that quietly stops reviewing a class of change.
 */
export function skipsBotAuthoredMr(cell: WakeableCell): boolean {
  return cell.triggerConfig.skipBotAuthoredMr === true
}

/**
 * The accounts this cell treats as machines.
 *
 * Configured rather than inferred. GitLab's payload has no reliable bot marker,
 * and guessing from a username ("*-bot") would silently stop reviewing a person
 * called `alice-bot` while missing a machine called `deploy`.
 */
export function botAuthorsOf(cell: WakeableCell): readonly string[] {
  const configured = cell.triggerConfig.botAuthors
  if (!Array.isArray(configured)) return []
  return configured.filter((a): a is string => typeof a === 'string' && a !== '')
}
