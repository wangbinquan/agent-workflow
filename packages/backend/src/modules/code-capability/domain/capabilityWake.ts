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
  /** The account that caused the event, for the bot-loop guard. */
  authorUsername?: string | undefined
}

export type WakeVerdict =
  | { wake: true }
  | { wake: false; reason: 'not-ready' | 'event-not-subscribed' | 'no-mr' | 'own-comment' }

/**
 * Which events this cell subscribes to.
 *
 * A cell may narrow or widen the default by listing `events`. A present but
 * EMPTY list means "none" rather than "default" — someone who cleared the list
 * meant to stop it, and silently restoring the default would override them.
 */
export function subscribedEvents(cell: WakeableCell): readonly string[] {
  const configured = cell.triggerConfig.events
  if (!Array.isArray(configured)) return DEFAULT_MR_REVIEW_EVENTS
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

  // Every `mr-review` round needs something to review and somewhere to publish.
  // An MR-shaped event without an iid cannot supply either (design §6.1 records
  // this for fork PR CI events, whose `pull_requests[]` arrives empty).
  if (event.mrIid === undefined || event.mrIid === '') return { wake: false, reason: 'no-mr' }

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
