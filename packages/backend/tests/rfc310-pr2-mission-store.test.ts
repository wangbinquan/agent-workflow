// RFC-310 PR-2 T23/T25/T27/T28 —— MissionStore 持久化不变量。
//
// 锁存储层兜底（唯一索引→typed 结果）：launch idempotency、OCC/epoch、active
// MR claim 唯一、effect idempotency 与状态机、attempt ordinal 唯一、decision
// input 去重、deferred wake 的 fire/early/ordinal 不清零、writable action 单活。
// 并发用 Promise.all 同 revision 争写——bun:sqlite 同步执行下仍必须恰一成功。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb } from '../src/db/client'
import { createSqliteMissionStore } from '../src/modules/development-automation/infrastructure/sqliteMissionStore'
import {
  evaluateWake,
  nextAttemptOrdinal,
} from '../src/modules/development-automation/domain/deferredWake'
import type {
  MissionRow,
  MissionStore,
} from '../src/modules/development-automation/application/ports/missionStore'

const MIGRATIONS = resolve(import.meta.dirname, '..', 'db', 'migrations')

function missionRow(overrides: Partial<MissionRow> = {}): MissionRow {
  const now = Date.now()
  return {
    id: ulid(),
    revision: 0,
    epoch: 0,
    status: 'working',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: 'repo-1',
    sourceKind: 'direct',
    sourceContentDigest: 'a'.repeat(64),
    requestedSourceKey: null,
    externalId: null,
    resolvedSourceKey: null,
    resolvedAdapterId: null,
    resolvedAdapterRevision: null,
    deliveryKind: 'create-merge-request',
    deliveryTargetRef: null,
    deliverySourceBranch: null,
    adoptedMrRef: null,
    assignmentId: null,
    employeeId: null,
    employeeRevision: null,
    policyId: null,
    policyRevision: null,
    requirementBundleRef: null,
    repositoryFactsRef: null,
    uploadPlanRef: null,
    uploadPlacementRef: null,
    uploadPublicationRef: null,
    mrClaimId: null,
    currentActionRunId: null,
    readinessJson: null,
    blockCode: null,
    blockDetail: null,
    terminalKind: null,
    terminalUploadFulfillment: null,
    terminalAt: null,
    launchIdempotencyKey: `idem-${ulid()}`,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function newStore(): { store: MissionStore; missionId: string } {
  const db = createInMemoryDb(MIGRATIONS)
  const store = createSqliteMissionStore(db)
  const row = missionRow()
  store.createMission(row)
  return { store, missionId: row.id }
}

describe('rfc310 pr2 mission store', () => {
  test('launch idempotency: same key returns the existing mission', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const store = createSqliteMissionStore(db)
    const row = missionRow({ launchIdempotencyKey: 'idem-fixed-0001' })
    const first = store.createMission(row)
    expect(first.created).toBe(true)
    const second = store.createMission(missionRow({ launchIdempotencyKey: 'idem-fixed-0001' }))
    expect(second.created).toBe(false)
    expect(second.mission.id).toBe(row.id)
  })

  test('OCC: concurrent updates against the same revision — exactly one wins', async () => {
    const { store, missionId } = newStore()
    const results = await Promise.all([
      Promise.resolve().then(() => store.occUpdate(missionId, 0, 0, { status: 'publishing' })),
      Promise.resolve().then(() => store.occUpdate(missionId, 0, 0, { status: 'blocked' })),
    ])
    const wins = results.filter((r) => r.ok)
    expect(wins).toHaveLength(1)
    const losses = results.filter((r) => !r.ok)
    expect(losses).toHaveLength(1)
    if (!losses[0]!.ok) expect(losses[0]!.code).toBe('revision-conflict')
  })

  test('OCC: epoch conflict is reported distinctly (stale continuation fenced)', () => {
    const { store, missionId } = newStore()
    const bumped = store.bumpEpoch(missionId, 0, { transitionFence: 'cancel-pending' })
    expect(bumped).toEqual({ ok: true, revision: 1 })
    const stale = store.occUpdate(missionId, 1, 0, { status: 'publishing' })
    expect(stale).toEqual({ ok: false, code: 'epoch-conflict' })
  })

  test('active MR claim is unique; released claim frees the slot', () => {
    const { store, missionId } = newStore()
    const other = missionRow()
    store.createMission(other)
    const claim = {
      codeHostEndpointRef: 'ep-1',
      stableProjectRef: 'proj-1',
      mrIid: '42',
      headSha: null,
      now: Date.now(),
    }
    expect(store.claimMr({ ...claim, id: 'c1', missionId, epoch: 0 })).toEqual({ ok: true })
    expect(store.claimMr({ ...claim, id: 'c2', missionId: other.id, epoch: 0 })).toEqual({
      ok: false,
      code: 'mr-owned-by-another-mission',
    })
    store.releaseMr('c1', Date.now())
    expect(store.claimMr({ ...claim, id: 'c3', missionId: other.id, epoch: 0 })).toEqual({
      ok: true,
    })
  })

  test('wake hints dedupe by delivery key; consume marks them', () => {
    const { store, missionId } = newStore()
    const a = store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'code-host',
      deliveryKey: 'd-1',
      now: Date.now(),
    })
    const b = store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'code-host',
      deliveryKey: 'd-1',
      now: Date.now(),
    })
    expect(a.accepted).toBe(true)
    expect(b.accepted).toBe(false)
    expect(store.consumeWakeHints(missionId, Date.now())).toBe(1)
    expect(store.consumeWakeHints(missionId, Date.now())).toBe(0)
  })

  test('deferred wake: timer fire honours resumeAt; early external wake keeps ordinal', () => {
    const { store, missionId } = newStore()
    const decisionId = ulid()
    store.armWake({
      id: 'w1',
      missionId,
      decisionId,
      reason: 'pipeline-running',
      resumeAt: 1_000,
      wakeSources: ['pipeline'],
      attemptOrdinal: 3,
      now: 0,
    })
    const row = store.getWake(missionId, decisionId)!
    expect(evaluateWake(row, { kind: 'timer', now: 500 })).toEqual({ fire: false, code: 'not-due' })
    expect(evaluateWake(row, { kind: 'external', source: 'pipeline' })).toEqual({
      fire: true,
      early: true,
    })
    expect(evaluateWake(row, { kind: 'external', source: 'manual' })).toEqual({
      fire: false,
      code: 'source-not-subscribed',
    })
    // early fire 不清零 ordinal：下一次 arm 只能 +1。
    expect(nextAttemptOrdinal(row)).toBe(4)
    expect(store.fireWake('w1', 600)).toBe(true)
    expect(store.fireWake('w1', 601)).toBe(false) // 已 fired，非 armed
    expect(store.listDueWakes(2_000)).toHaveLength(0)
    store.settleWake('w1', 700)
    expect(store.getWake(missionId, decisionId)?.state).toBe('settled')
  })

  test('decision input digest dedupes repeat reconciles of the same snapshot', () => {
    const { store, missionId } = newStore()
    const base = {
      missionId,
      missionRevision: 0,
      policyId: null,
      policyRevision: null,
      employeeId: null,
      employeeRevision: null,
      factSnapshotId: null,
      factDigest: 'b'.repeat(64),
      workSetJson: null,
      guardTraceJson: '[]',
      ruleTraceJson: '[]',
      selectedJson: '{"kind":"collect-mr-facts"}',
      canonicalDigest: 'c'.repeat(64),
      decisionInputDigest: 'd'.repeat(64),
      now: Date.now(),
    }
    const first = store.insertDecision({ ...base, id: 'dec-1' })
    const second = store.insertDecision({ ...base, id: 'dec-2' })
    expect(first).toEqual({ created: true, decisionId: 'dec-1' })
    expect(second).toEqual({ created: false, decisionId: 'dec-1' })
  })

  test('single writable action per mission is index-enforced; read-only runs are free', () => {
    const { store, missionId } = newStore()
    const mk = (id: string, decisionId: string, writable: boolean) =>
      store.createActionRun({
        id,
        missionId,
        missionRevision: 0,
        decisionId,
        capabilityId: 'change.implement',
        capabilityContractVersion: 1,
        templateId: null,
        templateRevision: null,
        workSetDigest: null,
        inputFactDigest: 'e'.repeat(64),
        baselineRef: null,
        writable,
        now: Date.now(),
      })
    expect(mk('run-1', 'dec-a', true)).toEqual({ ok: true })
    expect(mk('run-2', 'dec-b', true)).toEqual({
      ok: false,
      code: 'writable-action-already-active',
    })
    expect(mk('run-3', 'dec-c', false)).toEqual({ ok: true })
    store.settleActionRun({
      id: 'run-1',
      status: 'settled',
      resultRef: null,
      failureJson: null,
      now: Date.now(),
    })
    expect(mk('run-4', 'dec-d', true)).toEqual({ ok: true })
  })

  test('agent attempt ordinal is unique per action run', () => {
    const { store, missionId } = newStore()
    store.createActionRun({
      id: 'run-x',
      missionId,
      missionRevision: 0,
      decisionId: 'dec-x',
      capabilityId: 'change.implement',
      capabilityContractVersion: 1,
      templateId: null,
      templateRevision: null,
      workSetDigest: null,
      inputFactDigest: 'f'.repeat(64),
      baselineRef: null,
      writable: true,
      now: Date.now(),
    })
    const claim = (id: string) =>
      store.claimAttempt({
        id,
        actionRunId: 'run-x',
        rerunSeq: 0,
        attemptSeq: 0,
        executionRef: null,
        baselineRef: 'base-1',
        nonceDigest: 'n'.repeat(64),
        inputDigest: 'g'.repeat(64),
        now: Date.now(),
      })
    expect(claim('att-1')).toEqual({ ok: true })
    expect(claim('att-2')).toEqual({ ok: false, code: 'attempt-ordinal-taken' })
  })

  test('effect idempotency + closed state machine', () => {
    const { store, missionId } = newStore()
    const prepare = (id: string) =>
      store.prepareEffect({
        id,
        missionId,
        actionRunId: null,
        effectKind: 'mr.ensure',
        intentDigest: 'h'.repeat(64),
        idempotencyKey: 'effect-key-1',
        epoch: 0,
        now: Date.now(),
      })
    const first = prepare('ef-1')
    expect(first.created).toBe(true)
    const second = prepare('ef-2')
    expect(second).toEqual({ created: false, effect: first.effect })

    // prepared → confirmed 是非法（必须先 dispatched）。dev-gotchas 定式：码在
    // `.code`，别断言 message。
    const codeOf = (fn: () => void): string => {
      try {
        fn()
        return '<no-throw>'
      } catch (error) {
        return (error as { code?: string }).code ?? '<no-code>'
      }
    }
    expect(codeOf(() => store.confirmEffect('ef-1', 'receipt-1', Date.now()))).toBe(
      'development-effect-illegal-transition',
    )
    store.markEffectDispatched('ef-1', Date.now())
    expect(store.listPreparedEffects()).toHaveLength(0)
    store.confirmEffect('ef-1', 'receipt-1', Date.now())
    expect(store.getEffect('ef-1')?.state).toBe('confirmed')
    expect(codeOf(() => store.invalidateEffect('ef-1', Date.now()))).toBe(
      'development-effect-illegal-transition',
    )
    expect(store.listUnsettledEffects(missionId)).toHaveLength(0)
  })
})
