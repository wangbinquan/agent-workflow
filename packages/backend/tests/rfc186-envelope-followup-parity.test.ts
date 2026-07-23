// RFC-186 PR-1 — workgroup turn envelope-retry aligned to the normal-node
// FOLLOWUP_POLICY machinery (design.md §2.2/§2.3).
//
// Why this test exists: the workgroup turn drivers used to decide retry-vs-fatal
// via an order-sensitive `errorMessage.startsWith(...)` chain plus a per-code
// `failureCode === 'envelope-missing'` special-case (audit design/workgroup-e2e-audit.md
// §2 P1-5) — a fragile fork of the normal-node path that repeatedly re-discovered
// solved bugs and let a single format slip fatal a whole multi-agent task
// (tasks 01KXFXEDC1DXZH6Z86B8E0RBDE / …DP7BXB). RFC-186 collapses that onto the
// SAME FOLLOWUP_POLICY table normal nodes use. These locks pin the unified
// decision + the removal of the string-prefix chain.

import { FOLLOWUP_POLICY, type FailureCode, type FollowupFailureCode } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { followupForFailure, wgFollowupNotice } from '../src/services/workgroup/engine'
import { renderWgProtocolBlock } from '../src/services/workgroup/context'
import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'

// Every narrow envelope failure in the shared policy table is retryable in the
// workgroup turn; permanent identity codes and anything WITHOUT a structured
// code (iso-setup / injection / crash / merge-conflict → undefined) are fatal.
describe('RFC-186 — followupForFailure unifies on FOLLOWUP_POLICY', () => {
  const ALL_CODES = Object.keys(FOLLOWUP_POLICY) as FollowupFailureCode[]

  test('every envelope follow-up code routes to retry with its table reason', () => {
    for (const code of ALL_CODES) {
      const fu = followupForFailure(code)
      expect(fu.retry).toBe(true)
      if (fu.retry) expect(fu.reason).toBe(FOLLOWUP_POLICY[code].reason)
    }
    // sanity: the table must at least cover the two production killers.
    expect(ALL_CODES).toContain('envelope-missing')
    expect(ALL_CODES).toContain('clarify-questions-malformed')
  })

  test('undefined failureCode (unstructured/fatal) is NOT retried', () => {
    expect(followupForFailure(undefined)).toEqual({ retry: false })
  })

  test('an unknown code not in the table is fatal (no accidental retry of real fatals)', () => {
    // e.g. a hypothetical hook-side fatal string that is not a FailureCode.
    expect(followupForFailure('wg-iso-setup' as FailureCode)).toEqual({ retry: false })
  })

  test('wgFollowupNotice covers every render reason with a wg-appropriate correction', () => {
    // Exhaustive over the 6-value EnvelopeFollowupReason domain via the policy table.
    const reasons = new Set(Object.values(FOLLOWUP_POLICY).map((p) => p.reason))
    for (const reason of reasons) {
      const notice = wgFollowupNotice(reason)
      expect(notice.length).toBeGreaterThan(0)
      // the notice must keep the model pointed at the wg envelope contract.
      expect(notice).toMatch(/workflow-output|workflow-clarify|port/)
    }
  })
})

// The literal <workflow-output> shape example must be present in EVERY role's
// protocol block (9874fffd added it generically; this locks it so a future
// refactor can't silently drop the template that fixed the first green).
describe('RFC-186 — protocol block carries the literal <workflow-output> example', () => {
  function cfg(mode: 'leader_worker' | 'free_collab'): WorkgroupRuntimeConfig {
    return {
      workgroupId: 'wg1',
      workgroupName: 'squad',
      mode,
      leaderMemberId: 'm-lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 10,
      completionGate: false,
      autonomous: true,
      instructions: '',
      goal: 'g',
      members: [
        {
          id: 'm-lead',
          memberType: 'agent',
          agentName: 'planner',
          userId: null,
          displayName: 'planner',
          roleDesc: '',
        },
      ],
    } as WorkgroupRuntimeConfig
  }

  test.each(['leader', 'worker', 'fc_member'] as const)(
    '%s block shows the literal <workflow-output>…<port name=…> shape',
    (role) => {
      const block = renderWgProtocolBlock(
        role,
        cfg(role === 'fc_member' ? 'free_collab' : 'leader_worker'),
      )
      expect(block).toContain('<workflow-output>')
      expect(block).toContain('<port name=')
      expect(block).toContain('</workflow-output>')
    },
  )
})

// Source locks — the string-prefix chain + per-code special-case must be GONE
// from the turn drivers (they are the fragility RFC-186 removed), and the budget
// must be the aligned value.
describe('RFC-186 — source locks (workgroup engine, RFC-217 T3 split layout)', () => {
  // RFC-217 T3 dissolved workgroupRunner.ts into engine + strategies +
  // memberTurns; the banned branches must stay out of ALL of them.
  const wg = (...seg: string[]): string =>
    readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'workgroup', ...seg), 'utf8')
  const src = wg('engine.ts').concat(
    wg('memberTurns.ts'),
    wg('strategies', 'leaderWorker.ts'),
    wg('strategies', 'freeCollab.ts'),
  )

  // Match the LIVE branch form (`&& attempt`), not the explanatory comments that
  // document what was removed.
  test('the clarify-questions startsWith branch is removed (unified on FOLLOWUP_POLICY)', () => {
    expect(src).not.toContain("startsWith('clarify-questions-') && attempt")
  })

  test('the per-code envelope-missing branch is removed (folded into followupForFailure)', () => {
    expect(src).not.toContain("result.failureCode === 'envelope-missing' && attempt")
  })

  test('turn drivers route through followupForFailure (RFC-217 T3: ONE consult in the skeleton)', () => {
    // 收编后所有 driver 经 executeTurn 走同一次 FOLLOWUP_POLICY consult —— runner
    // 里不允许再长出第二个消费点（那意味着有人绕开骨架手写失败路由）。
    const skeleton = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'workgroup', 'turnExecution.ts'),
      'utf8',
    )
    expect((skeleton.match(/followupForFailure\(result\.failureCode\)/g) ?? []).length).toBe(1)
    expect((src.match(/followupForFailure\(result\.failureCode\)/g) ?? []).length).toBe(0)
  })

  test('retry budget rides the shared normal-node budget (parity by construction)', () => {
    // 调度架构审视 2026-07-14：字面量 `= 3` 收敛为跨引擎共享常量——parity 从
    // 「注释对齐」升级为「同一符号」；常量取值 3 由
    // retry-budget-single-source.test.ts / envelope-followup-source-grep 锁定。
    // RFC-217 T5 起该常量的家在 turnExecution.ts（executeTurn 的 retryPolicy 单源）。
    const skeleton = wg('turnExecution.ts')
    expect(skeleton).toContain('const WG_PROTOCOL_RETRIES = DEFAULT_PROTOCOL_RETRY_BUDGET')
    expect(skeleton).not.toContain('const WG_PROTOCOL_RETRIES = 3')
  })

  test('failed message turn is surfaced to the room, not silently swallowed', () => {
    expect(src).toContain('message turn for')
  })
})
