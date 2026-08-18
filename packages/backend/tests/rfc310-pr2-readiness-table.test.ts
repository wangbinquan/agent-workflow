// RFC-310 PR-2 T29 —— computeReadiness 真值表（design.md §2.4 固定算法）。
//
// 锁的核心安全性质：unknown/unavailable/partial/queued/running 永不折算
// pass；automationReady 先于 host mergeability；human hold 只产生
// waiting-committer；host unknown 时即便零 hold 也不 ready；upload
// fulfillment pending 是 machine hold。

import { describe, expect, test } from 'bun:test'

import {
  computeReadiness,
  type ReadinessInput,
} from '../src/modules/development-automation/domain/readiness'
import type { GateStatus } from '../src/modules/development-automation/domain/pipelineManifest'

const CLEAN: ReadinessInput = {
  evaluatedForHead: 'a'.repeat(40),
  factDigest: 'd'.repeat(64),
  activeAction: false,
  unconfirmedEffects: 0,
  unhandledFeedback: 0,
  conflict: false,
  requiredGates: [{ gateKey: 'ci', status: 'pass' }],
  pipelineComplete: true,
  factsComplete: true,
  headConsistent: true,
  uploadFulfillmentPending: false,
  approvalsOutstanding: 0,
  unresolvedHumanThreads: 0,
  committerPolicyHold: false,
  hostMergeable: 'yes',
}

describe('rfc310 pr2 readiness truth table', () => {
  test('clean input is ready-to-merge', () => {
    const r = computeReadiness(CLEAN)
    expect(r).toMatchObject({ automationReady: true, status: 'ready-to-merge' })
    expect(r.machineHolds).toEqual([])
    expect(r.humanHolds).toEqual([])
  })

  test.each([
    'fail',
    'running',
    'queued',
    'unknown',
    'unavailable',
    'canceled',
    'skipped',
  ] as GateStatus[])('required gate %s is a machine hold — only explicit pass counts', (status) => {
    const r = computeReadiness({ ...CLEAN, requiredGates: [{ gateKey: 'ci', status }] })
    expect(r.automationReady).toBe(false)
    expect(r.status).toBe('working')
    expect(r.machineHolds.some((h) => h.kind === 'required-gate-not-pass')).toBe(true)
  })

  test('partial pipeline evidence and inconsistent head are machine holds', () => {
    expect(computeReadiness({ ...CLEAN, pipelineComplete: false }).automationReady).toBe(false)
    expect(computeReadiness({ ...CLEAN, headConsistent: false }).automationReady).toBe(false)
    expect(computeReadiness({ ...CLEAN, factsComplete: false }).automationReady).toBe(false)
  })

  test.each([
    ['activeAction', { activeAction: true }],
    ['unconfirmedEffects', { unconfirmedEffects: 2 }],
    ['unhandledFeedback', { unhandledFeedback: 1 }],
    ['conflict', { conflict: true }],
    ['uploadFulfillmentPending', { uploadFulfillmentPending: true }],
  ] as const)('%s blocks automationReady', (_label, patch) => {
    const r = computeReadiness({ ...CLEAN, ...patch })
    expect(r.automationReady).toBe(false)
    expect(r.status).toBe('working')
  })

  test('human holds alone produce waiting-committer, never ready', () => {
    for (const patch of [
      { approvalsOutstanding: 1 },
      { unresolvedHumanThreads: 2 },
      { committerPolicyHold: true },
    ]) {
      const r = computeReadiness({ ...CLEAN, ...patch })
      expect(r.automationReady).toBe(true)
      expect(r.status).toBe('waiting-committer')
      expect(r.humanHolds.length).toBeGreaterThan(0)
    }
  })

  test('host mergeable unknown/no never yields ready-to-merge even with zero holds', () => {
    expect(computeReadiness({ ...CLEAN, hostMergeable: 'unknown' }).status).toBe('working')
    expect(computeReadiness({ ...CLEAN, hostMergeable: 'no' }).status).toBe('working')
  })

  test('machine holds dominate human holds in the reported status', () => {
    const r = computeReadiness({
      ...CLEAN,
      conflict: true,
      approvalsOutstanding: 1,
    })
    expect(r.status).toBe('working')
    expect(r.machineHolds.length).toBeGreaterThan(0)
    expect(r.humanHolds.length).toBeGreaterThan(0)
  })
})
