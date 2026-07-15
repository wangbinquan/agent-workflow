// RFC-187 T8 (audit design/workgroup-e2e-audit.md §4-4) — a workgroup host run whose
// merge-back conflicts unresolvably used to strand its node_run at
// merge_state='conflict-human'.
//
// That state is a PROMISE: "a human will finish this merge in the PRESERVED resolve-iso,
// and a later resume will re-merge it" — which is why the DAG path sets `keepIso` and
// parks awaiting_human. The workgroup host hook keeps no such promise: it returns `failed`
// for the turn and its `finally` discards the iso unconditionally. So the promise was left
// with its iso deleted and refs unpinned/GC'd — and `replayConflictHumanResolutions` runs
// for EVERY task at runTask entry (scheduler.ts, before the workgroup branch), so the next
// resume hunted commits that no longer exist, threw, and failTask'd the WHOLE task.
//
// Fix: the workgroup path explicitly ABANDONS the merge state (legal: `abandon` accepts
// isolating|pending-merge|conflict-human → abandoned), which is the honest description —
// this delta really is dropped.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  allowedFromForMergeEvent,
  MERGE_STATES,
  targetForMergeEvent,
  type MergeState,
} from '@agent-workflow/shared'

describe('RFC-187 T8 — conflict-human → abandoned is a legal, terminal settle', () => {
  test('abandon accepts conflict-human and lands on abandoned', () => {
    const ev = { kind: 'abandon', reason: 'wg-merge-conflict-unresolved' } as const
    expect(targetForMergeEvent(ev)).toBe('abandoned')
    const allowed = allowedFromForMergeEvent(ev)
    // the wg hook abandons FROM conflict-human — that must be a legal source.
    expect(JSON.stringify(allowed)).toContain('conflict-human')
  })

  test('sanity: conflict-human is a real merge state', () => {
    expect(MERGE_STATES as readonly MergeState[]).toContain('conflict-human')
  })
})

describe('RFC-187 T8 — source lock (the wg hook abandons instead of stranding)', () => {
  const SCHED = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    'utf8',
  )

  test('the workgroup conflict-human branch abandons the merge state before failing', () => {
    expect(SCHED).toContain("event: { kind: 'abandon', reason: 'wg-merge-conflict-unresolved' }")
    // it must sit in the wg hook's conflict-human branch, i.e. right before the
    // merge-back-conflict failure it returns.
    expect(SCHED).toMatch(
      /merge\.kind === 'conflict-human'[\s\S]{0,1800}wg-merge-conflict-unresolved[\s\S]{0,600}merge-back-conflict/,
    )
  })

  test('the wg hook still discards its iso unconditionally (why the abandon is required)', () => {
    // if this ever becomes keepIso-style preservation, the abandon above must be
    // revisited — the two decisions are one contract.
    expect(SCHED).toMatch(/finally \{[\s\S]{0,200}discardNodeIso\(iso, log\)/)
  })
})
