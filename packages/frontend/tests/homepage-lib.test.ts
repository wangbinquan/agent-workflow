// RFC-032 PR3 lib/homepage — locks the merge ordering, greeting boundary
// table, and relative-time token mapping.
//
// Why this test exists: these three helpers feed every visual on the
// homepage hero + 3 sections. A regression in merge ordering would
// silently re-order the "Waiting on you" list; a busted greeting
// boundary would render "Good evening" at 11am; a busted
// formatRelativeTime would put "yesterday" stamps on tasks that just
// finished. The pure-function shape makes them cheap to test
// exhaustively (no React, no fake clock).

import { describe, expect, test } from 'vitest'
import type { ClarifyRoundSummary, ReviewSummary } from '@agent-workflow/shared'
import {
  INBOX_PREVIEW_LIMIT,
  formatRelativeTime,
  mergeInboxItems,
  pickGreetingKey,
} from '@/lib/homepage'

function review(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    nodeRunId: 'nr1',
    taskId: 'task_a',
    taskName: 'fixture-task',
    workflowId: 'wf_1',
    workflowName: 'wf-name',
    reviewNodeId: 'rev_node',
    title: 'r-title',
    description: '',
    currentVersionIndex: 1,
    reviewIteration: 0,
    decision: 'pending',
    awaitingReview: true,
    shardKey: null,
    createdAt: 1_700_000_000_000,
    decidedAt: null,
    ...overrides,
  }
}

// RFC-058: ClarifyRoundSummary uses unified field names. The factory accepts
// either the new names directly (preferred) OR a legacy alias bag that the
// helper translates so older test cases below remain readable.
type LegacyClarifyOverrides = Partial<{
  id: string
  taskId: string
  taskName: string
  sourceAgentNodeId: string
  sourceAgentNodeTitle: string | null
  sourceShardKey: string | null
  clarifyNodeId: string
  clarifyNodeTitle: string | null
  clarifyNodeRunId: string
  iterationIndex: number
  questionCount: number
  status: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned'
  createdAt: number
  answeredAt: number | null
}>

function clarify(overrides: LegacyClarifyOverrides = {}): ClarifyRoundSummary {
  return {
    id: overrides.id ?? 'sess_1',
    taskId: overrides.taskId ?? 'task_b',
    taskName: overrides.taskName ?? 'fixture-task',
    kind: 'self',
    askingNodeId: overrides.sourceAgentNodeId ?? 'agent_x',
    askingNodeTitle: overrides.sourceAgentNodeTitle ?? null,
    askingShardKey: overrides.sourceShardKey ?? null,
    intermediaryNodeId: overrides.clarifyNodeId ?? 'c1',
    intermediaryNodeTitle: overrides.clarifyNodeTitle ?? null,
    intermediaryNodeRunId: overrides.clarifyNodeRunId ?? 'cn1',
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: overrides.iterationIndex ?? 0,
    questionCount: overrides.questionCount ?? 2,
    status: overrides.status ?? 'awaiting_human',
    terminatedAs: null,
    directive: null,
    createdAt: overrides.createdAt ?? 1_700_000_500_000,
    answeredAt: overrides.answeredAt ?? null,
  }
}

describe('RFC-032 mergeInboxItems — locks newest-first ordering and limit', () => {
  test('empty + empty → empty', () => {
    expect(mergeInboxItems([], [])).toEqual([])
  })

  test('items are sorted by timestamp desc across both feeds', () => {
    const result = mergeInboxItems(
      [
        review({ nodeRunId: 'old', createdAt: 1000 }),
        review({ nodeRunId: 'new', createdAt: 3000 }),
      ],
      [clarify({ clarifyNodeRunId: 'mid', createdAt: 2000 })],
    )
    expect(result.map((r) => r.id)).toEqual(['new', 'mid', 'old'])
    expect(result[0]?.kind).toBe('review')
    expect(result[1]?.kind).toBe('clarify')
  })

  test('clarify subtitle carries source-agent label + shard/iter; "shard X" when shardKey set, "iter N" when null', () => {
    const result = mergeInboxItems(
      [],
      [
        clarify({ clarifyNodeRunId: 'a', sourceAgentNodeId: 'coder', sourceShardKey: 'shard-1' }),
        clarify({
          clarifyNodeRunId: 'b',
          sourceAgentNodeId: 'designer',
          sourceShardKey: null,
          iterationIndex: 3,
          createdAt: 1,
        }),
      ],
    )
    const subtitles = result.map((r) => r.subtitle)
    // Subtitle format: "← {agentLabel} · {shard|iter}". Locks both halves
    // present so a future refactor can't drop the agent attribution.
    expect(subtitles.some((s) => s.includes('coder') && s.includes('shard shard-1'))).toBe(true)
    expect(subtitles.some((s) => s.includes('designer') && s.includes('iter 3'))).toBe(true)
  })

  test('output capped at INBOX_PREVIEW_LIMIT', () => {
    const reviews = Array.from({ length: 12 }, (_, i) =>
      review({ nodeRunId: `r${i}`, createdAt: i }),
    )
    const result = mergeInboxItems(reviews, [])
    expect(result.length).toBe(INBOX_PREVIEW_LIMIT)
  })

  test('custom limit is honoured', () => {
    const reviews = [
      review({ nodeRunId: 'r1', createdAt: 5 }),
      review({ nodeRunId: 'r2', createdAt: 10 }),
    ]
    expect(mergeInboxItems(reviews, [], 1).map((r) => r.id)).toEqual(['r2'])
  })

  // Clarify row identity (RFC-037 follow-up):
  // - title = the clarify node's own display name (clarifyNodeTitle), falling
  //   back to clarifyNodeId. Previously the title was the source-agent's
  //   name, which made the inbox read "Coder" while clicking the row took
  //   the user to a "Ask user about the DB" clarify page — different identity
  //   to the row promised.
  // - subtitle keeps the source-agent label so users still know which agent
  //   is asking ("← {agentLabel} · {shard|iter}").
  test('clarify row title prefers clarifyNodeTitle; subtitle carries the source-agent label', () => {
    const result = mergeInboxItems(
      [],
      [
        clarify({
          clarifyNodeRunId: 'cn1',
          clarifyNodeId: 'clarify_db',
          clarifyNodeTitle: 'Ask user about the DB',
          sourceAgentNodeId: 'agent_xy_01',
          sourceAgentNodeTitle: 'Implementation Coder',
        }),
      ],
    )
    expect(result[0]?.title).toBe('Ask user about the DB')
    expect(result[0]?.subtitle).toContain('Implementation Coder')
  })

  test('clarify row title falls back to clarifyNodeId when clarifyNodeTitle is null', () => {
    const result = mergeInboxItems(
      [],
      [
        clarify({
          clarifyNodeRunId: 'cn1',
          clarifyNodeId: 'clarify_db',
          clarifyNodeTitle: null,
          sourceAgentNodeId: 'agent_xy_01',
        }),
      ],
    )
    expect(result[0]?.title).toBe('clarify_db')
  })

  test('clarify row title falls back to clarifyNodeId when clarifyNodeTitle is empty', () => {
    const result = mergeInboxItems(
      [],
      [
        clarify({
          clarifyNodeRunId: 'cn1',
          clarifyNodeId: 'clarify_db',
          clarifyNodeTitle: '',
        }),
      ],
    )
    expect(result[0]?.title).toBe('clarify_db')
  })

  test('clarify row title falls back to clarifyNodeId when clarifyNodeTitle field is omitted (legacy backend)', () => {
    const result = mergeInboxItems(
      [],
      [
        clarify({
          clarifyNodeRunId: 'cn1',
          clarifyNodeId: 'clarify_legacy',
          sourceAgentNodeId: 'agent_legacy',
          // clarifyNodeTitle / sourceAgentNodeTitle intentionally omitted —
          // simulates a pre-upgrade backend.
        }),
      ],
    )
    expect(result[0]?.title).toBe('clarify_legacy')
    // Subtitle still carries the raw source agent id as fallback context.
    expect(result[0]?.subtitle).toContain('agent_legacy')
  })

  // Locks in the fix for the "inbox tab switch leaves stale rows" bug.
  // The backend can return several `awaiting_human` clarify sessions
  // sharing one `clarifyNodeRunId` (loop iterations / retries). If we
  // key React rows by node-run id, duplicate keys break reconciliation
  // and stale rows linger in the DOM after a tab switch. The merge
  // therefore exposes `rowKey = session.id` (always unique) alongside
  // `id = clarifyNodeRunId` (the navigation target).
  test('clarify rows expose session-id as rowKey, even when clarifyNodeRunId repeats', () => {
    const result = mergeInboxItems(
      [],
      [
        clarify({ id: 'sess_a', clarifyNodeRunId: 'shared_nrun', createdAt: 3 }),
        clarify({ id: 'sess_b', clarifyNodeRunId: 'shared_nrun', createdAt: 2 }),
        clarify({ id: 'sess_c', clarifyNodeRunId: 'shared_nrun', createdAt: 1 }),
      ],
    )
    expect(result.length).toBe(3)
    expect(result.map((r) => r.rowKey)).toEqual(['sess_a', 'sess_b', 'sess_c'])
    expect(new Set(result.map((r) => r.rowKey)).size).toBe(3)
    // Navigation target stays on node-run id so the detail page route
    // (/clarify/$nodeRunId) keeps working.
    expect(result.every((r) => r.id === 'shared_nrun')).toBe(true)
  })

  test('review rows expose nodeRunId as rowKey (unique per pending review)', () => {
    const result = mergeInboxItems([review({ nodeRunId: 'r_only' })], [])
    expect(result[0]?.rowKey).toBe('r_only')
    expect(result[0]?.id).toBe('r_only')
  })
})

describe('RFC-032 pickGreetingKey — hourly boundary table', () => {
  test('00:00 → evening (early morning still reads as last night)', () => {
    expect(pickGreetingKey(new Date(2026, 4, 18, 0, 0, 0))).toBe('evening')
  })
  test('05:59 → evening (still in the pre-dawn band)', () => {
    expect(pickGreetingKey(new Date(2026, 4, 18, 5, 59, 0))).toBe('evening')
  })
  test('06:00 → morning', () => {
    expect(pickGreetingKey(new Date(2026, 4, 18, 6, 0, 0))).toBe('morning')
  })
  test('11:59 → morning', () => {
    expect(pickGreetingKey(new Date(2026, 4, 18, 11, 59, 0))).toBe('morning')
  })
  test('12:00 → afternoon', () => {
    expect(pickGreetingKey(new Date(2026, 4, 18, 12, 0, 0))).toBe('afternoon')
  })
  test('17:59 → afternoon', () => {
    expect(pickGreetingKey(new Date(2026, 4, 18, 17, 59, 0))).toBe('afternoon')
  })
  test('18:00 → evening', () => {
    expect(pickGreetingKey(new Date(2026, 4, 18, 18, 0, 0))).toBe('evening')
  })
  test('23:59 → evening', () => {
    expect(pickGreetingKey(new Date(2026, 4, 18, 23, 59, 0))).toBe('evening')
  })
})

describe('RFC-032 formatRelativeTime — token + opts mapping', () => {
  const now = 1_700_000_000_000
  test('< 60s → relativeJustNow (no n)', () => {
    expect(formatRelativeTime(now, now)).toEqual({ key: 'relativeJustNow' })
    expect(formatRelativeTime(now, now - 30_000)).toEqual({ key: 'relativeJustNow' })
  })
  test('60s..59min → relativeMinAgo with n=minutes', () => {
    expect(formatRelativeTime(now, now - 60_000)).toEqual({
      key: 'relativeMinAgo',
      opts: { n: 1 },
    })
    expect(formatRelativeTime(now, now - 30 * 60_000)).toEqual({
      key: 'relativeMinAgo',
      opts: { n: 30 },
    })
  })
  test('1h..23h → relativeHourAgo with n=hours', () => {
    expect(formatRelativeTime(now, now - 60 * 60_000)).toEqual({
      key: 'relativeHourAgo',
      opts: { n: 1 },
    })
    expect(formatRelativeTime(now, now - 5 * 3_600_000)).toEqual({
      key: 'relativeHourAgo',
      opts: { n: 5 },
    })
  })
  test('≥ 24h → relativeDayAgo with n=days', () => {
    expect(formatRelativeTime(now, now - 86_400_000)).toEqual({
      key: 'relativeDayAgo',
      opts: { n: 1 },
    })
    expect(formatRelativeTime(now, now - 7 * 86_400_000)).toEqual({
      key: 'relativeDayAgo',
      opts: { n: 7 },
    })
  })
  test('negative dt is clamped → just now (clock skew defence)', () => {
    expect(formatRelativeTime(now, now + 5000)).toEqual({ key: 'relativeJustNow' })
  })
})
