// RFC-334 T3 — the neutral cap is a platform contract while retry shape/state
// remains TaskExecution-owned. These are the RFC-313 behavior oracles moved to
// their final owners; no budget or state transition is relaxed.

import { DEFAULT_PROTOCOL_RETRY_BUDGET, type EnvelopeFollowupReason } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_SESSION_RESTART_BUDGET,
  decideRetryShape,
  type EnvelopeFollowupOutcome,
  type RetryShapeState,
} from '../src/modules/task-execution/domain/envelopeRetryPolicy'
import {
  RETRY_ATTEMPT_CAP_CEILING,
  RetryAttemptCapPolicyV1Schema,
  retryAttemptCap,
  retryAttemptCapFromPolicy,
} from '../src/platform/contracts/retryAttemptCap'
import { ASSEMBLY_MAX_ATTEMPTS } from '../src/services/schedulerAssembly'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8')
const FRESH_START: RetryShapeState = { followupChainLen: 0, restartsUsed: 0 }
const followupable = (
  reason: EnvelopeFollowupReason = 'envelope-missing',
  failures: ReadonlyArray<{ port: string; kind: string; subReason: string }> = [],
): EnvelopeFollowupOutcome => ({ followup: true, reason, failures })
const notFollowupable: EnvelopeFollowupOutcome = { followup: false }

describe('RFC-334 neutral retry-attempt-cap contract', () => {
  test('strict V1 codec accepts the exact shape and rejects drift', () => {
    const policy = RetryAttemptCapPolicyV1Schema.parse({
      schemaVersion: 1,
      followupBudget: 3,
      restartBudget: 1,
    })
    expect(retryAttemptCapFromPolicy(policy)).toBe(8)
    expect(() => RetryAttemptCapPolicyV1Schema.parse({ ...policy, extra: true })).toThrow()
    expect(() =>
      RetryAttemptCapPolicyV1Schema.parse({ schemaVersion: 1, followupBudget: 3 }),
    ).toThrow()
    expect(() => RetryAttemptCapPolicyV1Schema.parse({ ...policy, restartBudget: '1' })).toThrow()
  })

  test('normalization, defaults, R=0 compatibility and ceiling stay exact', () => {
    expect(retryAttemptCap(-5, -5)).toBe(1)
    expect(retryAttemptCap(Number.NaN, 2)).toBe(3)
    expect(retryAttemptCap(Number.POSITIVE_INFINITY, 2)).toBe(3)
    expect(retryAttemptCap(2.9, 0)).toBe(3)
    expect(retryAttemptCap(DEFAULT_PROTOCOL_RETRY_BUDGET, DEFAULT_SESSION_RESTART_BUDGET)).toBe(8)
    expect(retryAttemptCap(DEFAULT_PROTOCOL_RETRY_BUDGET, 0)).toBe(
      1 + DEFAULT_PROTOCOL_RETRY_BUDGET,
    )
    expect(retryAttemptCap(50, 10)).toBe(RETRY_ATTEMPT_CAP_CEILING)
    expect(RETRY_ATTEMPT_CAP_CEILING).toBe(99)
    expect(RETRY_ATTEMPT_CAP_CEILING).toBeLessThan(ASSEMBLY_MAX_ATTEMPTS)
    for (const followupBudget of [0, 3, 50, 63, 64, 98]) {
      expect(retryAttemptCap(followupBudget, 0)).toBe(1 + followupBudget)
    }
  })

  test('the only production consumers are TaskExecution and DigitalEmployee', () => {
    const nodeMechanics = read(
      'packages/backend/src/modules/task-execution/composition/nodeMechanics.ts',
    )
    const employee = read(
      'packages/backend/src/modules/digital-employee/application/runtimeService.ts',
    )
    const shared = read('packages/shared/src/prompt.ts')
    expect(nodeMechanics).toContain("from '@/platform/contracts/retryAttemptCap'")
    expect(employee).toContain("from '@/platform/contracts/retryAttemptCap'")
    expect(shared).not.toContain('export function retryAttemptCap')
    expect(shared).not.toContain('export const RETRY_ATTEMPT_CAP_CEILING')
  })
})

describe('RFC-334 TaskExecution envelope retry policy', () => {
  test('three-way decision and state transitions stay exact', () => {
    expect(
      decideRetryShape({
        followup: followupable(),
        state: FRESH_START,
        followupBudget: 3,
        restartBudget: 1,
      }),
    ).toEqual({
      shape: { kind: 'followup', reason: 'envelope-missing', failures: [] },
      next: { followupChainLen: 1, restartsUsed: 0 },
    })
    expect(
      decideRetryShape({
        followup: followupable('envelope-port-malformed'),
        state: { followupChainLen: 3, restartsUsed: 0 },
        followupBudget: 3,
        restartBudget: 1,
      }),
    ).toEqual({
      shape: { kind: 'restart', reason: 'envelope-port-malformed' },
      next: { followupChainLen: 0, restartsUsed: 1 },
    })
    expect(
      decideRetryShape({
        followup: notFollowupable,
        state: { followupChainLen: 2, restartsUsed: 0 },
        followupBudget: 3,
        restartBudget: 1,
      }),
    ).toEqual({ shape: { kind: 'fresh' }, next: { followupChainLen: 0, restartsUsed: 0 } })
  })

  test('restart suppression and exhausted-budget fallback preserve accounting', () => {
    expect(
      decideRetryShape({
        followup: followupable(),
        state: { followupChainLen: 3, restartsUsed: 0 },
        followupBudget: 3,
        restartBudget: 1,
        suppressRestart: true,
      }),
    ).toEqual({
      shape: { kind: 'followup', reason: 'envelope-missing', failures: [] },
      next: { followupChainLen: 4, restartsUsed: 0 },
    })
    const exhausted = decideRetryShape({
      followup: followupable(),
      state: { followupChainLen: 3, restartsUsed: 1 },
      followupBudget: 3,
      restartBudget: 1,
    })
    expect(exhausted.shape.kind).toBe('followup')
    expect(exhausted.next.restartsUsed).toBe(1)
  })

  test('restartBudget=0 never emits restart', () => {
    for (const followupChainLen of [0, 1, 3, 10]) {
      const out = decideRetryShape({
        followup: followupable(),
        state: { followupChainLen, restartsUsed: 0 },
        followupBudget: 3,
        restartBudget: 0,
      })
      expect(out.shape.kind).not.toBe('restart')
    }
  })

  test('all finite budget combinations consume exactly the neutral cap', () => {
    for (let followupBudget = 0; followupBudget <= 5; followupBudget += 1) {
      for (let restartBudget = 0; restartBudget <= 3; restartBudget += 1) {
        const cap = retryAttemptCap(followupBudget, restartBudget)
        let state: RetryShapeState = { ...FRESH_START }
        let attempts = 1
        let restarts = 0
        for (let attempt = 0; attempt < cap - 1; attempt += 1) {
          const out = decideRetryShape({
            followup: followupable(),
            state,
            followupBudget,
            restartBudget,
          })
          if (out.shape.kind === 'restart') restarts += 1
          state = out.next
          attempts += 1
        }
        expect(attempts).toBe(cap)
        expect(restarts).toBe(restartBudget)
      }
    }
  })
})
