// RFC-304 §11.1/§11.2 (T59/T60) — what the platform says on a merge request.
//
// These two rules exist because of one failure mode with two faces. The design
// section works it out on an ordinary day: one developer, 3 active merge
// requests, 3 pushes each = 9 review notifications, plus 2 reviewer replies,
// plus 2 requirement threads, plus a two-round CI incident — 15+ machine
// utterances before cascades. People mute that.
//
// And the cost of being muted is NOT the annoyance. It is that the two messages
// which genuinely need a person — the three-attempt hand-off and the conflict
// report — are muted along with everything else. Noise does not irritate the
// reader; it destroys the signal it is mixed with.
//
// The two faces:
//   T60 — say less: one overview comment, edited, not a feed.
//   T59 — but say MORE where a person is waiting. Silence on a manual
//         instruction does not reduce noise, it multiplies it: a reviewer who
//         gets no answer @-mentions again, producing another round.

import { describe, expect, test } from 'bun:test'
import {
  bypassesBudget,
  DEFAULT_NOTIFICATION_BUDGET,
  foldSummaryEntry,
  isSummaryComment,
  judgeNotificationBudget,
  renderSummary,
  SUMMARY_MAX_ENTRIES,
  type SummaryEntry,
} from '../src/modules/code-capability/domain/botSummary'
import {
  answer,
  say,
  updateSummary,
  type MrVoiceEnv,
} from '../src/modules/code-capability/application/mrVoice'
import type { CodeHostCall } from '../src/modules/code-capability/ports/codeHostPort'
import {
  failureVisibilityOf,
  isManualInstruction,
  readReceiptMarker,
  receiptMarker,
  renderReceipt,
  TRIGGER_SOURCES,
  type TriggerSource,
} from '../src/modules/code-capability/domain/triggerSource'

describe('RFC-304 T59 — who is owed an answer', () => {
  test('a webhook is not a question, so nothing is posted', () => {
    // Pushing a commit is a human action and produces a webhook, but nobody
    // ASKED the platform anything. A failure comment per red pipeline is
    // exactly what gets a bot muted.
    const v = failureVisibilityOf({ source: 'webhook', operationId: 'op-1' })
    expect(v.kind).toBe('platform-only')
  })

  test('every non-webhook source IS a question', () => {
    // Enumerated rather than spot-checked: a new trigger source added later
    // defaults to being answered, which is the safe direction. Forgetting to
    // classify a new manual path as manual is how someone ends up @-mentioning
    // into silence.
    for (const source of TRIGGER_SOURCES) {
      expect(isManualInstruction(source), source).toBe(source !== 'webhook')
    }
  })

  test('a manual instruction is answered on its own receipt', () => {
    const v = failureVisibilityOf({ source: 'mention', operationId: 'op-7' })
    expect(v).toEqual({ kind: 'receipt', operationId: 'op-7' })
  })

  test('a manual instruction with NO receipt id falls back to platform-only', () => {
    // Not "post a fresh comment". Appending is precisely what the receipt
    // exists to prevent, and a duplicate under a lost id is indistinguishable
    // to the reader from the platform having answered twice.
    const v = failureVisibilityOf({ source: 'confirmation', operationId: null })
    expect(v.kind).toBe('platform-only')
    expect(v.kind === 'platform-only' && v.reason).toContain('duplicate')
  })

  test('the receipt marker round-trips so a later round can find it', () => {
    // Without this the "update in place" promise degrades into one comment per
    // attempt — the behaviour being replaced.
    const body = renderReceipt('op-42', { kind: 'received' })
    expect(readReceiptMarker(body)).toBe('op-42')
    expect(body).toContain(receiptMarker('op-42'))
  })

  test('each state REPLACES the body rather than appending', () => {
    // A reader sees the current state, not a transcript of every state passed
    // through. Same marker, so the same comment is edited.
    const received = renderReceipt('op-1', { kind: 'received' })
    const done = renderReceipt('op-1', { kind: 'done', detail: 'Pushed the fix.' })

    expect(readReceiptMarker(done)).toBe('op-1')
    expect(done).not.toContain('queued')
    expect(received).not.toContain('Pushed the fix.')
  })

  test('a failure names the attempt, not the request', () => {
    // A reader who cannot tell "your instruction was wrong" from "my attempt
    // did not work" will re-send the same instruction.
    const body = renderReceipt('op-1', { kind: 'failed', detail: 'the gate stayed red' })
    expect(body).toContain('That did not work')
    expect(body).toContain('the gate stayed red')
  })

  test('awaiting does not read as a failure', () => {
    // Waiting on a person is not an error, and phrasing it as one sends
    // somebody to debug a platform that is behaving correctly.
    const body = renderReceipt('op-1', {
      kind: 'awaiting',
      detail: 'Reply `/aw apply` and I will push it.',
    })
    expect(body).not.toContain('did not work')
    expect(body).toContain('/aw apply')
  })
})

describe('RFC-304 T60 — one overview, edited', () => {
  const entry = (over: Partial<SummaryEntry> = {}): SummaryEntry => ({
    capability: 'mr-review',
    line: 'reviewed 12 files, left 3 comments',
    at: 1000,
    ...over,
  })

  test('the overview is findable again, which is what makes editing possible', () => {
    expect(isSummaryComment(renderSummary([entry()]))).toBe(true)
    expect(isSummaryComment('an ordinary human comment')).toBe(false)
  })

  test('newest first — the reader wants what just happened', () => {
    const body = renderSummary([
      entry({ capability: 'old', at: 1 }),
      entry({ capability: 'new', at: 99 }),
    ])
    expect(body.indexOf('`new`')).toBeLessThan(body.indexOf('`old`'))
  })

  test('a second round of one capability REPLACES its line', () => {
    // "reviewed, found 3 things" twice tells the reader nothing the first line
    // did not. A capability that did something different says so in its line.
    const folded = foldSummaryEntry(
      [entry({ capability: 'mr-review', line: 'first pass', at: 1 })],
      entry({ capability: 'mr-review', line: 'second pass', at: 2 }),
    )
    expect(folded).toHaveLength(1)
    expect(folded[0]?.line).toBe('second pass')
  })

  test('a different capability is added, not merged', () => {
    const folded = foldSummaryEntry(
      [entry({ capability: 'mr-review', at: 1 })],
      entry({ capability: 'ci-fix', at: 2 }),
    )
    expect(folded.map((e) => e.capability)).toEqual(['ci-fix', 'mr-review'])
  })

  test('an over-long history says how many it dropped', () => {
    // Silent truncation makes "3 entries" ambiguous between "3 things happened"
    // and "3 of 40 shown", and the reader can trust neither.
    const many = Array.from({ length: SUMMARY_MAX_ENTRIES + 5 }, (_, i) =>
      entry({ capability: `cap-${String(i)}`, at: i }),
    )
    const body = renderSummary(many)
    expect(body).toContain('5 earlier entries')
  })

  test('exactly at the cap it says nothing about dropping', () => {
    const exact = Array.from({ length: SUMMARY_MAX_ENTRIES }, (_, i) =>
      entry({ capability: `cap-${String(i)}`, at: i }),
    )
    expect(renderSummary(exact)).not.toContain('earlier')
  })
})

describe('RFC-304 T60 — the notification budget', () => {
  test('spending the budget stops NOTIFICATIONS, never the overview update', () => {
    // Suppressing the update too would leave the overview stale while the
    // platform kept working — a reader looking at a comment that says nothing
    // is happening, which is worse than a ping.
    const spent = judgeNotificationBudget(DEFAULT_NOTIFICATION_BUDGET)
    expect(spent.mayNotify).toBe(false)
    expect(spent.mayUpdateSummary).toBe(true)
    expect(spent.remaining).toBe(0)
  })

  test('under budget, both are allowed', () => {
    const v = judgeNotificationBudget(1)
    expect(v.mayNotify).toBe(true)
    expect(v.remaining).toBe(DEFAULT_NOTIFICATION_BUDGET - 1)
  })

  test('over-spending does not produce a negative remainder', () => {
    expect(judgeNotificationBudget(DEFAULT_NOTIFICATION_BUDGET + 5).remaining).toBe(0)
  })

  test('the two messages the budget exists to protect bypass it', () => {
    // The whole point of quieting everything else is that THESE still arrive.
    // A budget that silenced them would have inverted its own purpose.
    expect(bypassesBudget('conflict')).toBe(true)
    expect(bypassesBudget('handed-off')).toBe(true)
    expect(bypassesBudget('review')).toBe(false)
  })
})

// The join: the rules above only bind if the platform SPEAKS through them.
// Four call sites used to `comment.create` directly, which is how a bot ends up
// posting a feed — nobody decides to, it just follows from every site being
// able to. These tests drive the real service against a fake code host.
describe('RFC-304 §11 — mrVoice is the only road', () => {
  interface Recorded {
    calls: CodeHostCall[]
    notified: number
  }

  const hostWith = (
    comments: Array<{ id: string; body: string }>,
  ): { env: MrVoiceEnv; rec: Recorded } => {
    const rec: Recorded = { calls: [], notified: 0 }
    const env: MrVoiceEnv = {
      codeHost: {
        call: async (call) => {
          rec.calls.push(call)
          if (call.action === 'comment.list') {
            return { ok: true, status: 200, body: JSON.stringify(comments), truncated: false }
          }
          return { ok: true, status: 201, body: '{"id":"new"}', truncated: false }
        },
      },
      target: { __project__: 'p', mr: '412' },
      notificationsSpent: 0,
      onNotified: () => {
        rec.notified += 1
      },
    }
    return { env, rec }
  }

  const parsePrevious = (): SummaryEntry[] => []

  test('a second overview EDITS the first rather than posting again', async () => {
    const { env, rec } = hostWith([{ id: 'c-1', body: renderSummary([]) }])
    await updateSummary(env, { capability: 'mr-review', line: 'reviewed', at: 1 }, parsePrevious)

    const actions = rec.calls.map((c) => c.action)
    expect(actions).toContain('comment.update')
    expect(actions).not.toContain('comment.create')
    // An edit notifies nobody, so it must not spend the budget.
    expect(rec.notified).toBe(0)
  })

  test('the FIRST overview is created and counted once', async () => {
    const { env, rec } = hostWith([])
    await updateSummary(env, { capability: 'mr-review', line: 'reviewed', at: 1 }, parsePrevious)
    expect(rec.calls.map((c) => c.action)).toContain('comment.create')
    expect(rec.notified).toBe(1)
  })

  test('a receipt for a known operation edits that exact comment', async () => {
    // Not "the newest bot comment" — a merge request can carry several open
    // receipts, and answering the wrong one is worse than not answering.
    // The target is FIRST and a decoy is last, on purpose: an implementation
    // that grabbed "the newest bot comment" would pass a fixture ordered the
    // other way round while answering the wrong person in production.
    const { env, rec } = hostWith([
      { id: 'c-1', body: renderReceipt('op-mine', { kind: 'received' }) },
      { id: 'c-2', body: renderReceipt('op-other', { kind: 'received' }) },
    ])
    await answer(env, 'op-mine', { kind: 'done', detail: 'Pushed.' })

    const update = rec.calls.find((c) => c.action === 'comment.update')
    expect(update?.params.comment).toBe('c-1')
  })

  test('an ordinary comment is refused once the budget is spent', async () => {
    const { env, rec } = hostWith([])
    const out = await say(
      { ...env, notificationsSpent: DEFAULT_NOTIFICATION_BUDGET },
      'review',
      'x',
    )
    expect(out).toEqual({ posted: false, reason: 'budget-exhausted' })
    expect(rec.calls.map((c) => c.action)).not.toContain('comment.create')
  })

  test('a conflict report is posted even with the budget spent', async () => {
    // The message the quieting exists to preserve. A budget that silenced this
    // would have inverted its own purpose.
    const { env, rec } = hostWith([])
    const out = await say(
      { ...env, notificationsSpent: DEFAULT_NOTIFICATION_BUDGET + 50 },
      'conflict',
      'this branch conflicts',
    )
    expect(out).toEqual({ posted: true })
    expect(rec.calls.map((c) => c.action)).toContain('comment.create')
  })

  test('an unreadable comment list does not fail the round', async () => {
    // The caller's next move is to post or edit either way. Treating "cannot
    // read" as fatal would let a transient code-host hiccup fail an otherwise
    // finished round; the worst case here is one duplicate comment.
    const rec: CodeHostCall[] = []
    const env: MrVoiceEnv = {
      codeHost: {
        call: async (call) => {
          rec.push(call)
          if (call.action === 'comment.list') {
            return { ok: true, status: 200, body: 'not json at all', truncated: false }
          }
          return { ok: true, status: 201, body: '{}', truncated: false }
        },
      },
      target: { __project__: 'p', mr: '412' },
      notificationsSpent: 0,
    }
    await expect(answer(env, 'op-1', { kind: 'received' })).resolves.toEqual({ ok: true })
    expect(rec.map((c) => c.action)).toContain('comment.create')
  })
})
