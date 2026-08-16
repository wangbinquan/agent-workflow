// RFC-304 §11.1/§11.2 — the one place the platform speaks on a merge request.
//
// Before this, four call sites each did `comment.create` directly. That is how
// a bot ends up posting a feed: nobody decides to, it just follows from every
// site being able to. The rules in `botSummary` and `triggerSource` cannot be
// enforced by a rule that lives beside a call site which does not consult it —
// so the enforcement has to be the only road.
//
// Three ways to speak, and the difference between them is the whole design:
//
//   `updateSummary`  — the standing overview. Edited in place, notifies nobody
//                      on either host, never budgeted.
//   `answer`         — a receipt for a manual instruction. Edited in place, so
//                      "received → working → done" costs ONE notification.
//   `say`            — an ordinary new comment. Budgeted, and the budget is
//                      what everything above exists to protect.
//
// A conflict report and a three-attempt hand-off go through `say` and bypass
// the budget, because they are the messages the quieting exists to preserve.

import {
  bypassesBudget,
  foldSummaryEntry,
  isSummaryComment,
  judgeNotificationBudget,
  parseSummary,
  renderSummary,
  type SummaryEntry,
} from '@/modules/code-capability/domain/botSummary'
import {
  readReceiptMarker,
  renderReceipt,
  type ReceiptState,
} from '@/modules/code-capability/domain/triggerSource'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'

export interface MrVoiceEnv {
  codeHost: CodeHostPort
  /** Addressing params for this merge request, as `codeHost` expects them. */
  target: Readonly<Record<string, string>>
  /**
   * Notifications already produced for this merge request.
   *
   * Omit it and `say` counts them off the merge request itself — see
   * `countNotificationsSpent`. It stays overridable for the cases that already
   * know (and for tests, which must not need a fake listing to exercise the
   * budget rule).
   */
  notificationsSpent?: number
  budget?: number
  /** Records a notification so the budget survives the round. */
  onNotified?: () => Promise<void> | void
}

/**
 * The hidden marker on an ordinary comment.
 *
 * Without it the platform cannot recognise its own ordinary comments, and the
 * budget has nothing to count. `updateSummary` and `answer` already leave a
 * marker each, which is how those two are found for editing; this is the same
 * device for the one kind that is never edited.
 */
const NOTE_MARKER_PREFIX = '<!-- aw-note:'

function noteMarker(kind: string): string {
  return `${NOTE_MARKER_PREFIX}${kind} -->`
}

/** Whether this comment is one the platform wrote. */
function isPlatformComment(body: string): boolean {
  return (
    body.includes(NOTE_MARKER_PREFIX) || isSummaryComment(body) || readReceiptMarker(body) !== null
  )
}

interface HostComment {
  id: string
  body: string
}

/**
 * Existing comments, or an empty list.
 *
 * A failed or unparsable listing yields `[]` rather than throwing: the caller's
 * next move is to post or edit, and treating "cannot read" as fatal would make
 * a transient code-host hiccup fail an otherwise finished round. The cost of
 * the empty answer is at worst one duplicate comment, which is strictly better
 * than losing the work that produced it.
 */
async function listComments(env: MrVoiceEnv): Promise<HostComment[]> {
  const res = await env.codeHost.call({ action: 'comment.list', params: { ...env.target } })
  if (!res.ok) return []
  try {
    const parsed: unknown = JSON.parse(res.body)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((raw): HostComment[] => {
      if (typeof raw !== 'object' || raw === null) return []
      const row = raw as Record<string, unknown>
      const id = row.id
      const body = row.body ?? row.note
      if ((typeof id !== 'string' && typeof id !== 'number') || typeof body !== 'string') return []
      return [{ id: String(id), body }]
    })
  } catch {
    return []
  }
}

async function editOrCreate(
  env: MrVoiceEnv,
  existing: HostComment | undefined,
  body: string,
): Promise<{ ok: boolean; created: boolean }> {
  if (existing !== undefined) {
    const res = await env.codeHost.call({
      action: 'comment.update',
      params: { ...env.target, comment: existing.id, body },
    })
    // An edit notifies nobody on either host, so it is never budgeted.
    return { ok: res.ok, created: false }
  }
  const res = await env.codeHost.call({
    action: 'comment.create',
    params: { ...env.target, body },
  })
  return { ok: res.ok, created: true }
}

/**
 * T60 — fold one line into the standing overview.
 *
 * Reads the current overview back from the host rather than trusting a cached
 * copy: another round on the same merge request may have edited it since, and
 * a cached write would silently drop that round's line.
 */
export async function updateSummary(
  env: MrVoiceEnv,
  entry: SummaryEntry,
  // Defaulted, because for its whole life this parameter had exactly one
  // implementation anywhere — a test stub returning `[]`. A caller that had to
  // supply the parser was a caller that could fold every round into nothing,
  // which is what an overview must never do.
  parsePrevious: (body: string) => SummaryEntry[] = parseSummary,
): Promise<{ ok: boolean }> {
  const comments = await listComments(env)
  const existing = comments.find((c) => isSummaryComment(c.body))
  const previous = existing === undefined ? [] : parsePrevious(existing.body)
  const next = foldSummaryEntry(previous, entry)

  const result = await editOrCreate(env, existing, renderSummary(next))
  // Creating the overview the FIRST time does notify, and is counted. After
  // that it is edits forever, which is the point.
  if (result.created && result.ok) await env.onNotified?.()
  return { ok: result.ok }
}

/**
 * T59 — answer a manual instruction on its own receipt.
 *
 * Never budgeted after the first post: the whole exchange lives on one comment,
 * so quieting it would only make a person who is actively waiting wait in
 * silence — the failure this rule exists to fix.
 */
export async function answer(
  env: MrVoiceEnv,
  operationId: string,
  state: ReceiptState,
  opts: {
    /**
     * Whether a missing receipt may be created.
     *
     * False is how the closing update stays honest about WHO asked. Only the
     * ingress creates receipts, and only for an instruction a person typed — so
     * at the end of a round, "is there a receipt with this id" is exactly the
     * question "was anybody waiting for this". Creating one here instead would
     * post a comment on every automatic round, which is the behaviour §11.2
     * separates the two paths to avoid.
     */
    createIfMissing?: boolean
  } = {},
): Promise<{ ok: boolean; existed: boolean }> {
  const comments = await listComments(env)
  const existing = comments.find((c) => readReceiptMarker(c.body) === operationId)
  if (existing === undefined && opts.createIfMissing === false) {
    return { ok: true, existed: false }
  }

  const result = await editOrCreate(env, existing, renderReceipt(operationId, state))
  if (result.created && result.ok) await env.onNotified?.()
  return { ok: result.ok, existed: existing !== undefined }
}

export type SayOutcome =
  | { posted: true }
  /** The budget is spent and this message is not one of the protected kinds. */
  | { posted: false; reason: 'budget-exhausted' }
  | { posted: false; reason: 'host-refused' }

/**
 * An ordinary new comment — the only path that produces a notification.
 *
 * `kind` decides whether the budget applies. `conflict` and `handed-off` bypass
 * it because they are exactly what the budget protects: a merge request quiet
 * enough that these two are still read.
 */
export async function say(env: MrVoiceEnv, kind: string, body: string): Promise<SayOutcome> {
  if (!bypassesBudget(kind)) {
    const spent = env.notificationsSpent ?? (await countNotificationsSpent(env))
    const verdict = judgeNotificationBudget(spent, env.budget)
    if (!verdict.mayNotify) return { posted: false, reason: 'budget-exhausted' }
  }
  const res = await env.codeHost.call({
    action: 'comment.create',
    // Marked, so this comment counts against the budget the next time one is
    // judged. An unmarked comment is invisible to the count, which is how the
    // budget stayed at zero spent forever.
    params: { ...env.target, body: `${noteMarker(kind)}\n${body}` },
  })
  if (!res.ok) return { posted: false, reason: 'host-refused' }
  await env.onNotified?.()
  return { posted: true }
}

/**
 * How many notifications the platform has already produced on this merge
 * request — counted off the merge request itself.
 *
 * §11.1 puts the budget per MR, and the merge request is where the evidence
 * lives: one platform-authored COMMENT is exactly one notification, because
 * creating notifies and every subsequent edit does not. So the count is the
 * number of comments carrying one of the platform's markers.
 *
 * The alternative was a counter column. This needs no migration, cannot drift
 * from what a reader actually sees, and self-heals — delete the bot's comments
 * and the budget genuinely is spent again, which matches what a person means
 * when they clear a merge request of noise.
 *
 * A listing that fails counts as zero rather than as exhausted: the budget
 * exists to protect the conflict report and the hand-off, and a transient
 * code-host hiccup must not be what silences them.
 */
export async function countNotificationsSpent(env: MrVoiceEnv): Promise<number> {
  const comments = await listComments(env)
  return comments.filter((c) => isPlatformComment(c.body)).length
}
