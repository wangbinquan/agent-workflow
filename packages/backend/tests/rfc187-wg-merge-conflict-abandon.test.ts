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

  test('the wg hook discards on the conflict path; only a merge THROW keeps the iso', () => {
    // The original contract read "discards unconditionally — if this ever
    // becomes keepIso-style preservation, the abandon above must be revisited".
    // RFC-210's impl-gate remediation DID revisit it (review round 2, P1): a
    // merge/snapshot THROW now keeps the iso, because the publish path
    // hard-fails BEFORE any node tree is persisted and the iso can be the sole
    // copy of the run's submodule work. The abandon rationale is intact
    // because the two paths differ in what they leave behind:
    //  - conflict-human (this abandon): the hook cannot preserve a resolve-iso
    //    promise, so it abandons AND STILL DISCARDS — keepHookIso is never set
    //    on this path;
    //  - merge THROW: merge_state stays 'pending-merge' (replayable state) and
    //    the KEPT iso backs it; the replay's own success path closes the
    //    lifecycle (replayPendingMerges → discardNodeIso, RFC-210 round 5).
    const wgFinally = /finally \{([\s\S]{0,900}?)discardNodeIso\(iso, log, state\.writeSem\)/.exec(
      SCHED,
    )
    expect(wgFinally).not.toBeNull()
    // The discard is gated on the merge-throw flag and nothing else.
    expect(wgFinally?.[1] ?? '').toContain('if (!keepHookIso)')
    // The flag is set ONLY in the merge-throw rethrow, never on the conflict
    // path (the abandon block must stay a discarding path).
    const flagSets = SCHED.match(/keepHookIso = true/g) ?? []
    expect(flagSets).toHaveLength(1)
    expect(SCHED).toMatch(/keepHookIso = true\s*\n\s*throw err/)
    expect(SCHED).not.toMatch(/wg-merge-conflict-unresolved[\s\S]{0,600}?keepHookIso = true/)
  })
})
