// RFC-304 §11.1 (T60) — one comment the platform keeps up to date, not a feed.
//
// The arithmetic from the design section: one developer with 3 active merge
// requests pushing 3 times a day is 9 review notifications, plus 2 reviewer
// replies, plus 2 requirement threads, plus a two-round CI incident — at least
// 15 machine utterances in an ordinary day, before baseline-change re-reviews
// and conflict reports. And the platform's own push is itself a merge-request
// update, which by default triggers another review: a cascade.
//
// People mute bots that behave like that. The cost of being muted is not the
// noise — it is that the THREE-ATTEMPT hand-off and the conflict report, the
// two messages that genuinely need a person, are muted along with everything
// else. Noise does not annoy the reader; it destroys the signal.
//
// So: one overview comment per merge request, EDITED each round. Line-level
// findings stay separate, because those are anchored to code and a reader wants
// them where the code is.

/** One line of the overview — what a capability did this round. */
export interface SummaryEntry {
  capability: string
  /** Present tense, one line, no trailing period. */
  line: string
  /** Newest first; the overview is read top-down. */
  at: number
}

/**
 * The marker, which is also where the overview keeps its state.
 *
 * The entries travel as JSON inside the HTML comment rather than being scraped
 * back out of the rendered list. Two reasons, and both bite in practice: every
 * wording change would otherwise be a migration of a format living on other
 * people's merge requests, and a human who edits the bot's comment — to reply
 * under it, to fix a typo — would corrupt the state rather than just the prose.
 *
 * Neither GitLab nor GitHub renders an HTML comment, so this is invisible.
 */
const SUMMARY_MARKER = '<!-- aw-summary:'

/**
 * How many rounds the overview keeps.
 *
 * Bounded because a long-lived merge request would otherwise grow a comment
 * nobody can scroll. The cap is generous enough to cover a working day of the
 * arithmetic above.
 */
export const SUMMARY_MAX_ENTRIES = 20

export function isSummaryComment(body: string): boolean {
  return body.includes(SUMMARY_MARKER)
}

/**
 * The overview body.
 *
 * Newest first, capped, and it says how many older entries were dropped rather
 * than silently truncating — a reader who cannot tell whether "3 entries" means
 * "3 things happened" or "3 of 40 shown" will trust neither reading.
 */
export function renderSummary(entries: readonly SummaryEntry[]): string {
  const ordered = [...entries].sort((a, b) => b.at - a.at)
  const shown = ordered.slice(0, SUMMARY_MAX_ENTRIES)
  const dropped = ordered.length - shown.length

  const lines = [
    // Only what is SHOWN goes into the state, so the marker is bounded by the
    // same cap as the text. Carrying every entry ever written would grow the
    // comment without bound on exactly the long-lived merge request the cap
    // exists for, while the visible list stayed at twenty.
    `${SUMMARY_MARKER}${JSON.stringify({ entries: shown })} -->`,
    '**What the platform has done here**',
    '',
    ...shown.map((e) => `- \`${e.capability}\` — ${e.line}`),
  ]
  if (dropped > 0) {
    lines.push('', `…and ${String(dropped)} earlier ${dropped === 1 ? 'entry' : 'entries'}.`)
  }
  return lines.join('\n')
}

/**
 * Read an overview's state back out of its marker.
 *
 * Never throws. A comment somebody edited by hand, or one written by an older
 * format, parses as no entries — the overview loses its history and the next
 * update rewrites the marker. That is the right trade: failing a round on the
 * way out because a person edited the bot's comment would be far worse than
 * forgetting what the bot said last week.
 */
export function parseSummary(body: string): SummaryEntry[] {
  const start = body.indexOf(SUMMARY_MARKER)
  if (start < 0) return []
  const from = start + SUMMARY_MARKER.length
  const end = body.indexOf('-->', from)
  if (end < 0) return []

  try {
    const parsed: unknown = JSON.parse(body.slice(from, end).trim())
    if (typeof parsed !== 'object' || parsed === null) return []
    const entries = (parsed as { entries?: unknown }).entries
    if (!Array.isArray(entries)) return []
    return entries.flatMap((raw): SummaryEntry[] => {
      if (typeof raw !== 'object' || raw === null) return []
      const row = raw as Record<string, unknown>
      // Each field checked rather than cast: the state comes back off a merge
      // request, which anybody with write access can edit.
      if (typeof row.capability !== 'string' || row.capability === '') return []
      if (typeof row.line !== 'string') return []
      if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return []
      return [{ capability: row.capability, line: row.line, at: row.at }]
    })
  } catch {
    return []
  }
}

/**
 * Fold a new entry into the existing overview.
 *
 * Per capability: a second review this hour REPLACES the first line rather than
 * stacking, because "reviewed, found 3 things" followed by "reviewed, found 3
 * things" tells the reader nothing the first line did not. A capability that
 * genuinely did something different says so in its line.
 */
export function foldSummaryEntry(
  existing: readonly SummaryEntry[],
  entry: SummaryEntry,
): SummaryEntry[] {
  const others = existing.filter((e) => e.capability !== entry.capability)
  return [entry, ...others].sort((a, b) => b.at - a.at)
}

/**
 * RFC-304 §11.1 — the per-merge-request notification budget.
 *
 * Distinct from the entry cap above: that bounds the LENGTH of the overview,
 * this bounds how often the platform is allowed to produce a NOTIFICATION.
 * Editing a comment notifies nobody on either host, so once the budget is
 * spent the platform keeps updating the overview and stops posting anything
 * new — the information stays current, the pings stop.
 */
export const DEFAULT_NOTIFICATION_BUDGET = 10

export interface BudgetVerdict {
  /** May the platform post something that notifies? */
  mayNotify: boolean
  /** Always true: the overview is updated regardless. */
  mayUpdateSummary: boolean
  remaining: number
}

export function judgeNotificationBudget(
  spent: number,
  budget = DEFAULT_NOTIFICATION_BUDGET,
): BudgetVerdict {
  const remaining = Math.max(0, budget - spent)
  return {
    mayNotify: remaining > 0,
    // Never gated. Suppressing the update too would leave the overview stale
    // while the platform kept working — a reader would be looking at a comment
    // that says nothing is happening, which is worse than a ping.
    mayUpdateSummary: true,
    remaining,
  }
}

/**
 * Whether a conflict report or hand-off may ignore the budget.
 *
 * These two are the reason the budget exists at all: everything else is being
 * quieted so that these still get through. A budget that silenced them would
 * have inverted its own purpose.
 */
export function bypassesBudget(kind: string): boolean {
  return kind === 'conflict' || kind === 'handed-off'
}
