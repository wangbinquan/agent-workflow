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
  /** Notifications already produced for this merge request. */
  notificationsSpent: number
  budget?: number
  /** Records a notification so the budget survives the round. */
  onNotified?: () => Promise<void> | void
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
  parsePrevious: (body: string) => SummaryEntry[],
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
): Promise<{ ok: boolean }> {
  const comments = await listComments(env)
  const existing = comments.find((c) => readReceiptMarker(c.body) === operationId)
  const result = await editOrCreate(env, existing, renderReceipt(operationId, state))
  if (result.created && result.ok) await env.onNotified?.()
  return { ok: result.ok }
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
    const verdict = judgeNotificationBudget(env.notificationsSpent, env.budget)
    if (!verdict.mayNotify) return { posted: false, reason: 'budget-exhausted' }
  }
  const res = await env.codeHost.call({
    action: 'comment.create',
    params: { ...env.target, body },
  })
  if (!res.ok) return { posted: false, reason: 'host-refused' }
  await env.onNotified?.()
  return { posted: true }
}
