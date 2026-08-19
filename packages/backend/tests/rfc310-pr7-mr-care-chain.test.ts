// RFC-310 PR-7 T76/T73/T75 —— MR care 编排链。
//
// 锁：①redispatch 只在「MR 已建 + 静止态」接管：facts 过期 → collect-mr-facts；
// apply 结算的 dispositions 未回复 → 逐 thread reply-feedback；selectable
// feedback 无规则接手 → 诚实 wait（不代替 policy 决定）；machine holds 清零 →
// publish-readiness。②collect arm 的台账联动：新 head obsolete 旧行、逐 thread
// 幂等 upsert、selectable 数投影 mr.unhandledFeedbackCount。③reply arm 走
// effect 台账（idempotencyKey）+ 台账 state 推进（addressed/needs-human），
// 正文只回复绝不 resolve。多轮推进收单 test 防 --randomize。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { ulid } from 'ulid'

import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import {
  MR_FACTS_STALE_MS,
  prepareFeedbackSelection,
  releaseFeedbackSelection,
  redispatchMrCare,
} from '../src/modules/development-automation/application/mrCareChain'
import type { MissionRow } from '../src/modules/development-automation/application/ports/missionStore'
import type {
  MergeRequestFactsCollectorPort,
  MrEffectsPort,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import {
  canonicalDigest,
  canonicalStringify,
} from '../src/modules/development-automation/domain/canonicalJson'
import type { NextDecision } from '../src/modules/development-automation/domain/decision'
import type { FactCellValue } from '../src/modules/development-automation/domain/facts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import { createAttemptContextStore } from '../src/modules/development-automation/infrastructure/attemptSupport'
import {
  createAutomationPolicy,
  publishAutomationPolicy,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

const MR_HEAD = 'cd'.repeat(20)

function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'test' }
}

const WAIT_MR_CARE: NextDecision = {
  kind: 'wait',
  reason: 'mr-care-not-wired',
  resumeAt: null,
  wakeSources: ['webhook', 'manual'],
  attemptOrdinal: 0,
}

describe('rfc310 pr7 — mr care redispatch (pure with store)', () => {
  // Regression: a feedback selection is only an action-scoped lease. Launch
  // or contract failure must make the exact revision selectable again instead
  // of leaving it permanently hidden in `selected`.
  test('feedback action selection is released back to observed by exact action run', async () => {
    const fx = await buildPr3Fixture()
    const now = 10_000_000
    fx.store.createMission({
      id: 'm-selection-lease',
      revision: 0,
      epoch: 0,
      status: 'watching',
      automationMode: 'active',
      transitionFence: 'none',
      repositoryId: 'repo-selection-lease',
      sourceKind: 'direct',
      sourceContentDigest: 'b'.repeat(64),
      requestedSourceKey: null,
      externalId: null,
      resolvedSourceKey: null,
      resolvedAdapterId: null,
      resolvedAdapterRevision: null,
      deliveryKind: 'create-merge-request',
      deliveryTargetRef: null,
      deliverySourceBranch: 'aw/mission/selection-lease',
      adoptedMrRef: null,
      assignmentId: null,
      employeeId: null,
      employeeRevision: null,
      policyId: fx.policyId,
      policyRevision: 1,
      requirementBundleRef: null,
      repositoryFactsRef: null,
      uploadPlanRef: null,
      uploadPlacementRef: null,
      uploadPublicationRef: null,
      mrClaimId: 'claim-selection-lease',
      currentActionRunId: null,
      readinessJson: null,
      blockCode: null,
      blockDetail: null,
      terminalKind: null,
      terminalUploadFulfillment: null,
      terminalAt: null,
      launchIdempotencyKey: 'idem-selection-lease',
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    })
    const mission = fx.store.getMission('m-selection-lease')!
    fx.store.upsertFeedbackObservation({
      id: 'fb-selection-lease',
      missionId: mission.id,
      threadRef: 'th-selection',
      revision: '1:7',
      headSha: MR_HEAD,
      fingerprint: 'a'.repeat(64),
      authorClass: 'human',
      now,
    })

    expect(
      prepareFeedbackSelection(
        { store: fx.store, now: () => now + 1 },
        mission,
        defaultAutomationPolicyContent(),
        'run-feedback-1',
      ),
    ).toEqual([{ threadRef: 'th-selection', revision: '1:7' }])
    expect(fx.store.listFeedback(mission.id)[0]).toMatchObject({
      state: 'selected',
      actionRunId: 'run-feedback-1',
    })

    expect(
      releaseFeedbackSelection(
        { store: fx.store, now: () => now + 2 },
        mission.id,
        'a-different-run',
      ),
    ).toBe(0)
    expect(
      releaseFeedbackSelection(
        { store: fx.store, now: () => now + 3 },
        mission.id,
        'run-feedback-1',
      ),
    ).toBe(1)
    expect(fx.store.listFeedback(mission.id)[0]).toMatchObject({
      state: 'observed',
      actionRunId: null,
    })
  })

  test('takeover, staleness, reply dispatch, feedback wait, readiness push', async () => {
    const fx = await buildPr3Fixture()
    const policy = defaultAutomationPolicyContent()
    const now = 10_000_000
    const mission = { id: 'm-care', mrClaimId: 'claim-1', status: 'watching' } as MissionRow
    const deps = { store: fx.store }

    // 无 claim / 非静止态 → 不接管。
    expect(
      redispatchMrCare(
        deps,
        { ...mission, mrClaimId: null } as MissionRow,
        {},
        policy,
        WAIT_MR_CARE,
        {
          now,
        },
      ),
    ).toEqual(WAIT_MR_CARE)
    const action: NextDecision = {
      kind: 'run-agent-action',
      capabilityId: 'mr.feedback.apply',
      templateRef: 't@1',
      workSetRef: 'none',
    }
    expect(redispatchMrCare(deps, mission, {}, policy, action, { now })).toEqual(action)

    // facts 缺/过期 → collect-mr-facts。
    expect(redispatchMrCare(deps, mission, {}, policy, WAIT_MR_CARE, { now })).toEqual({
      kind: 'collect-mr-facts',
    })
    expect(
      redispatchMrCare(
        deps,
        mission,
        { '__mr.factsCollectedAt': cell(String(now - MR_FACTS_STALE_MS - 1)) },
        policy,
        WAIT_MR_CARE,
        { now },
      ),
    ).toEqual({ kind: 'collect-mr-facts' })

    const fresh = { '__mr.factsCollectedAt': cell(String(now)) }
    // selectable feedback 无规则接手 → 诚实 wait。
    expect(
      redispatchMrCare(
        deps,
        mission,
        { ...fresh, 'mr.unhandledFeedbackCount': cell(2) },
        policy,
        { kind: 'block', reason: 'no-rule-matched' },
        { now },
      ),
    ).toMatchObject({ kind: 'wait', reason: 'feedback-awaiting-policy' })

    // No required pipeline gates means there is no pipeline snapshot to wait
    // for. Fresh MR facts with no feedback must publish readiness immediately.
    expect(redispatchMrCare(deps, mission, fresh, policy, WAIT_MR_CARE, { now })).toEqual({
      kind: 'publish-readiness',
    })

    // dispositions 未回复 → reply-feedback（台账行定位）。
    const missionId = 'm-care'
    fx.store.createMission({
      id: missionId,
      revision: 0,
      epoch: 0,
      status: 'watching',
      automationMode: 'active',
      transitionFence: 'none',
      repositoryId: 'repo-care',
      sourceKind: 'direct',
      sourceContentDigest: 'a'.repeat(64),
      requestedSourceKey: null,
      externalId: null,
      resolvedSourceKey: null,
      resolvedAdapterId: null,
      resolvedAdapterRevision: null,
      deliveryKind: 'create-merge-request',
      deliveryTargetRef: null,
      deliverySourceBranch: 'aw/mission/x',
      adoptedMrRef: null,
      assignmentId: null,
      employeeId: null,
      employeeRevision: null,
      policyId: fx.policyId,
      policyRevision: 1,
      requirementBundleRef: null,
      repositoryFactsRef: null,
      uploadPlanRef: null,
      uploadPlacementRef: null,
      uploadPublicationRef: null,
      mrClaimId: 'claim-1',
      currentActionRunId: null,
      readinessJson: null,
      blockCode: null,
      blockDetail: null,
      terminalKind: null,
      terminalUploadFulfillment: null,
      terminalAt: null,
      launchIdempotencyKey: 'idem-care',
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    })
    fx.store.upsertFeedbackObservation({
      id: 'fb-1',
      missionId,
      threadRef: 'th-1',
      revision: '2:99',
      headSha: MR_HEAD,
      fingerprint: 'f'.repeat(64),
      authorClass: 'human',
      now,
    })
    const withDispositions = {
      ...fresh,
      '__feedback.lastDispositions': cell(
        JSON.stringify([{ threadRef: 'th-1', revision: '2:99', disposition: 'addressed' }]),
      ),
    }
    expect(
      redispatchMrCare(deps, mission, withDispositions, policy, WAIT_MR_CARE, { now }),
    ).toEqual({ kind: 'reply-feedback', feedbackReceiptRef: 'fb-1' })
    // 已 addressed 的行不再重复派；无 required pipeline gate 时直接推进
    // readiness，而不是停回永远不会再被唤醒的 wait。
    fx.store.setFeedbackState({ id: 'fb-1', state: 'addressed', now })
    expect(
      redispatchMrCare(deps, mission, withDispositions, policy, WAIT_MR_CARE, { now }),
    ).toEqual({ kind: 'publish-readiness' })

    // machine holds 清零（watching + allPass）→ publish-readiness。
    expect(
      redispatchMrCare(
        deps,
        mission,
        {
          ...fresh,
          'pipeline.completeness': cell('complete'),
          'pipeline.requiredGatesAllPass': cell(true),
        },
        policy,
        WAIT_MR_CARE,
        { now },
      ),
    ).toEqual({ kind: 'publish-readiness' })
  })
})

describe('rfc310 pr7 — collect-mr-facts arm ledger integration', () => {
  test('collect upserts threads idempotently, obsoletes old head, projects unhandled count; reply arm settles ledger', async () => {
    const fx = await buildPr3Fixture()
    const noMatch = await createAutomationPolicy(fx.db, {
      name: 'pol-pr7-care',
      ownerUserId: 'admin',
      draft: {
        ...defaultAutomationPolicyContent(),
        actionPriority: {
          rules: [
            {
              ruleId: 'never',
              when: [{ kind: 'boolean-is', fact: 'requirement.bundleComplete', value: false }],
              capabilityId: 'change.implement',
            },
          ],
        },
      },
    })
    await publishAutomationPolicy(fx.db, { id: noMatch.id, publishedBy: 'admin' })

    const missionId = ulid()
    const now = Date.now()
    fx.store.createMission({
      id: missionId,
      revision: 0,
      epoch: 0,
      status: 'watching',
      automationMode: 'active',
      transitionFence: 'none',
      repositoryId: 'repo-care2',
      sourceKind: 'direct',
      sourceContentDigest: 'a'.repeat(64),
      requestedSourceKey: null,
      externalId: null,
      resolvedSourceKey: null,
      resolvedAdapterId: null,
      resolvedAdapterRevision: null,
      deliveryKind: 'create-merge-request',
      deliveryTargetRef: null,
      deliverySourceBranch: 'aw/mission/y',
      adoptedMrRef: null,
      assignmentId: null,
      employeeId: null,
      employeeRevision: null,
      policyId: noMatch.id,
      policyRevision: 1,
      requirementBundleRef: null,
      repositoryFactsRef: null,
      uploadPlanRef: null,
      uploadPlacementRef: null,
      uploadPublicationRef: null,
      mrClaimId: 'claim-2',
      currentActionRunId: null,
      readinessJson: null,
      blockCode: null,
      blockDetail: null,
      terminalKind: null,
      terminalUploadFulfillment: null,
      terminalAt: null,
      launchIdempotencyKey: `idem-${missionId}`,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    })
    const seed = {
      'requirement.bundleComplete': cell(true),
      '__mr.ref': cell('7'),
    }
    const snapId = ulid()
    fx.store.insertFactSnapshot({
      id: snapId,
      missionId,
      missionRevision: 0,
      capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
      cellsJson: canonicalStringify(seed),
      refsJson: '{}',
      digest: canonicalDigest(seed),
      now,
    })
    {
      const m = fx.store.getMission(missionId)!
      fx.store.occUpdate(missionId, m.revision, m.epoch, { requirementBundleRef: snapId })
    }

    const replies: unknown[] = []
    let collectCount = 0
    let humanResolved = false
    const collector: MergeRequestFactsCollectorPort = {
      async collect() {
        collectCount += 1
        return {
          cells: {
            'mr.exists': cell(true),
            'mr.draft': cell(false),
            'mr.mergeable': cell('yes'),
            'mr.terminalState': cell('active'),
            '__mr.factsCollectedAt': cell(String(Date.now())),
          },
          snapshotRef: 's'.repeat(64),
          headSha: MR_HEAD,
          targetSha: null,
          threads: [
            {
              threadRef: 'th-a',
              revision: '1:10',
              authorClass: 'human',
              resolved: humanResolved,
              bodyDigest: 'b'.repeat(64),
              body: 'Please update the implementation.',
              path: 'src/App.java',
            },
            {
              threadRef: 'th-bot',
              revision: '1:11',
              authorClass: 'bot',
              resolved: false,
              bodyDigest: 'c'.repeat(64),
              body: 'A second review note.',
              path: null,
            },
          ],
        }
      },
    }
    const mrEffects: MrEffectsPort = {
      async reply(_repo, input) {
        replies.push(input)
        return { ok: true, noteRef: 'note-9' }
      },
      async observe() {
        throw new Error('not used')
      },
      async ensure() {
        throw new Error('not used')
      },
    }
    const deps = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      mergeRequestFacts: collector,
      mrEffects,
    })

    // 轮 1：care 链派 collect-mr-facts → 台账 upsert + unhandled 投影（默认
    // policy 只允许 human：bot thread 不计）。
    const r1 = await runMissionReconcile(deps, missionId)
    expect((r1 as { selected: NextDecision }).selected).toEqual({ kind: 'collect-mr-facts' })
    const rows = fx.store.listFeedback(missionId)
    expect(rows).toHaveLength(2)
    // MR 采集结果与 repository facts 合并写入 repositoryFactsRef（arm 裁量注释）。
    const cells = fx.snapshots.getCells(fx.store.getMission(missionId)!.repositoryFactsRef!)!
    expect(cells['mr.unhandledFeedbackCount']).toMatchObject({ value: 1 })
    expect(cells['__mr.unresolvedFeedback']).toMatchObject({ state: 'known' })

    // 重复采集不重复建行（webhook 重放语义）。
    await runMissionReconcile(deps, missionId) // 轮 2 大概率 wait（facts 新鲜）
    expect(fx.store.listFeedback(missionId)).toHaveLength(2)

    // Webhook 是事实失效信号。即使上一份 MR snapshot 仍在 freshness TTL 内，
    // 也必须重新采集；否则 hint 被消费后相同 wait 决策去重，新评论会永久漏掉。
    fx.store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'webhook',
      deliveryKey: 'webhook:new-review-inside-freshness-window',
      now: now + 1,
    })
    const wakeRefresh = await runMissionReconcile(deps, missionId)
    expect((wakeRefresh as { selected: NextDecision }).selected).toEqual({
      kind: 'collect-mr-facts',
    })
    expect(collectCount).toBe(2)

    // 结算 dispositions（模拟 apply validated）→ care 派 reply → effect + 台账。
    const humanRow = rows.find((r) => r.threadRef === 'th-a')!
    {
      const m = fx.store.getMission(missionId)!
      const merged = {
        ...fx.snapshots.getCells(m.requirementBundleRef!)!,
        '__feedback.lastDispositions': cell(
          JSON.stringify([{ threadRef: 'th-a', revision: '1:10', disposition: 'addressed' }]),
        ),
      }
      const id2 = ulid()
      fx.store.insertFactSnapshot({
        id: id2,
        missionId,
        missionRevision: m.revision,
        capturedAt: new Date().toISOString().replace('Z', '+00:00'),
        cellsJson: canonicalStringify(merged),
        refsJson: '{}',
        digest: canonicalDigest(merged),
        now: Date.now(),
      })
      fx.store.occUpdate(m.id, m.revision, m.epoch, { requirementBundleRef: id2 })
    }
    const r3 = await runMissionReconcile(deps, missionId)
    expect((r3 as { selected: NextDecision }).selected).toEqual({
      kind: 'reply-feedback',
      feedbackReceiptRef: humanRow.id,
    })
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ threadRef: 'th-a', selfMarker: missionId })
    const settled = fx.store.listFeedback(missionId).find((r) => r.id === humanRow.id)!
    expect(settled.state).toBe('addressed')
    expect(settled.replyEffectId).not.toBeNull()
    expect(fx.store.listUnsettledEffects(missionId)).toEqual([])

    // `needs-human` is a human readiness hold, not a completed machine fix.
    // It must remove the mission from ready-to-merge until the provider says
    // that exact thread revision is resolved.
    fx.store.setFeedbackState({ id: humanRow.id, state: 'needs-human', now: now + 2 })
    {
      const m = fx.store.getMission(missionId)!
      const merged = {
        ...fx.snapshots.getCells(m.requirementBundleRef!)!,
        '__feedback.lastDispositions': cell(
          JSON.stringify([{ threadRef: 'th-a', revision: '1:10', disposition: 'needs-human' }]),
        ),
      }
      const id3 = ulid()
      fx.store.insertFactSnapshot({
        id: id3,
        missionId,
        missionRevision: m.revision,
        capturedAt: new Date().toISOString().replace('Z', '+00:00'),
        cellsJson: canonicalStringify(merged),
        refsJson: '{}',
        digest: canonicalDigest(merged),
        now: now + 2,
      })
      fx.store.occUpdate(m.id, m.revision, m.epoch, { requirementBundleRef: id3 })
    }
    await runMissionReconcile(deps, missionId)
    const held = fx.store.getMission(missionId)!
    expect(held.status).toBe('waiting-committer')
    expect(JSON.parse(held.readinessJson!)).toMatchObject({
      automationReady: true,
      status: 'waiting-committer',
      humanHolds: [{ kind: 'thread-unresolved', detail: '1 thread(s)' }],
    })

    humanResolved = true
    fx.store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'webhook',
      deliveryKey: 'webhook:human-thread-resolved',
      now: now + 3,
    })
    await runMissionReconcile(deps, missionId)
    const released = fx.store.getMission(missionId)!
    expect(released.status).toBe('ready-to-merge')
    expect(JSON.parse(released.readinessJson!)).toMatchObject({
      automationReady: true,
      status: 'ready-to-merge',
      humanHolds: [],
    })
  })
})
