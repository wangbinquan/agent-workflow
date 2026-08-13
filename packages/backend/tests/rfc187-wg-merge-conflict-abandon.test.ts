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
    // RFC-287 T6 改锚：该处置已从「函数体里的 conflict-human 分支」变成 spec 上的
    // `disposition.onConflictHuman` 声明。语义逐字不变——abandon 紧接着 failed，
    // 且错误信息仍是 merge-back-conflict。
    expect(SCHED).toMatch(
      /onConflictHuman:[\s\S]{0,900}wg-merge-conflict-unresolved[\s\S]{0,400}merge-back-conflict/,
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
    // RFC-287 T6 改锚：清理已由骨架统一执行（`if (!keep) discardIso`，且释放先于
    // 清理——见 rfc287-t1-release-before-discard 的跨文件结构锁）。三条路径的
    // **语义差别**逐条仍锁如下，与上面那段注释一一对应：
    //
    // ① 撞冲突：keep=false —— 本线许不起「留着给人解」的承诺，abandon 且照常清理。
    expect(SCHED).toMatch(/onConflictHuman:[\s\S]{0,200}keep: false/)
    // ② 合并抛出：keep=true + **重抛** —— merge_state 留 'pending-merge' 交 entry
    //    replay，且被保留的 iso 撑着它（不打 markMergeFailed，与 DAG 各线相反）。
    expect(SCHED).toMatch(/onThrow: \(\) => \(\{ keep: true, then: 'rethrow' as const \}\)/)
    // ③ 未回收的 child：仍是保留 iso 的那一维（§10.11 第五维，与合并处置正交）。
    expect(SCHED).toMatch(/keepFromOutcome: \(s\) =>[\s\S]{0,120}processUnreaped === true/)
    // 反向：撞冲突那条路径上**绝不**出现保留声明（abandon 块必须保持清理）。
    // 射程只取 onConflictHuman 声明自身（到它的 produce 收尾为止）——迁移后
    // onThrow 的 `keep: true` 就紧挨在它后面，用宽窗口会把兄弟声明误判成违规。
    const conflictDecl = /onConflictHuman: \(detail\) => \(\{[\s\S]*?\n {12}\}\),/.exec(SCHED)
    expect(conflictDecl).not.toBeNull()
    expect(conflictDecl?.[0] ?? '').not.toMatch(/keep: true/)
  })
})
