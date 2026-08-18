// RFC-310 PR-7 T73/T74/T72(DA 半) —— feedback 台账 + MR facts 投影。
//
// 锁：①观察入账幂等（(mission,thread,revision,head) 唯一键——webhook 重放/
// 重复采集 created:false，不重复起 action）；②obsolete 只打旧 head 的未终结
// （observed/selected）行——addressed/needs-human 是历史事实不被涂改；③作者
// 三分类 closed（self-marker 防自循环、bot 命名启发式、其余 human）；④可选集
// 语义：requireLatestRevision **先**折叠 thread 到最大 revision（旧修订即便
// observed 也永不入选），再过滤 state/authorClass，createdAt 升序截 batchLimit；
// ⑤MR 投影：approvalHold/targetSha 读不到就不产 cell（indeterminate 让规则
// 老实停，不伪造 known false）；mergeable/terminalState 词表映射照 catalog。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb } from '../src/db/client'
import type { FeedbackLedgerRow } from '../src/modules/development-automation/application/ports/missionStore'
import {
  classifyFeedbackAuthor,
  feedbackClosedRefs,
  feedbackFingerprint,
  selectableFeedback,
} from '../src/modules/development-automation/domain/feedbackLedger'
import { projectMrCells } from '../src/modules/development-automation/domain/mrFacts'
import { createSqliteMissionStore } from '../src/modules/development-automation/infrastructure/sqliteMissionStore'

setDefaultTimeout(120_000)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEAD_A = 'aa'.repeat(20)
const HEAD_B = 'bb'.repeat(20)

function missionRow(
  id: string,
): Parameters<ReturnType<typeof createSqliteMissionStore>['createMission']>[0] {
  const now = Date.now()
  return {
    id,
    revision: 0,
    epoch: 0,
    status: 'watching',
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
    launchIdempotencyKey: `idem-${id}`,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  }
}

function observation(
  missionId: string,
  overrides: Partial<{
    id: string
    threadRef: string
    revision: string
    headSha: string
    authorClass: 'human' | 'bot' | 'self'
    now: number
  }> = {},
) {
  return {
    id: overrides.id ?? ulid(),
    missionId,
    threadRef: overrides.threadRef ?? 'thread-1',
    revision: overrides.revision ?? 'rev-1',
    headSha: overrides.headSha ?? HEAD_A,
    fingerprint: 'f'.repeat(64),
    authorClass: overrides.authorClass ?? ('human' as const),
    now: overrides.now ?? Date.now(),
  }
}

describe('rfc310 pr7 T73 — feedback ledger store', () => {
  test('observation upsert is idempotent; state machine records; obsolete hits only stale-head open rows', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const store = createSqliteMissionStore(db)
    const missionId = ulid()
    store.createMission(missionRow(missionId))

    // 入账 + 重放幂等（同 thread/revision/head）。
    const first = observation(missionId)
    expect(store.upsertFeedbackObservation(first)).toEqual({ created: true })
    expect(store.upsertFeedbackObservation({ ...first, id: ulid() })).toEqual({ created: false })
    // 新 revision / 新 head 是新观察。
    expect(store.upsertFeedbackObservation(observation(missionId, { revision: 'rev-2' }))).toEqual({
      created: true,
    })
    expect(
      store.upsertFeedbackObservation(
        observation(missionId, { threadRef: 'thread-2', revision: 'rev-9', headSha: HEAD_B }),
      ),
    ).toEqual({ created: true })

    // state 机：selected → addressed 带 actionRun/replyEffect 归属。
    const rows = store.listFeedback(missionId)
    expect(rows).toHaveLength(3)
    const target = rows.find((r) => r.revision === 'rev-2')!
    store.setFeedbackState({
      id: target.id,
      state: 'selected',
      actionRunId: 'run-9',
      now: Date.now(),
    })
    store.setFeedbackState({
      id: target.id,
      state: 'addressed',
      replyEffectId: 'eff-1',
      now: Date.now(),
    })
    const after = store.listFeedback(missionId).find((r) => r.id === target.id)!
    expect(after).toMatchObject({
      state: 'addressed',
      actionRunId: 'run-9',
      replyEffectId: 'eff-1',
    })

    // obsolete：HEAD_B 为当前 head → HEAD_A 的 observed 行标 obsolete；
    // addressed（已终结）不被涂改。
    const changed = store.obsoleteFeedbackForOtherHeads(missionId, HEAD_B, Date.now())
    expect(changed).toBe(1)
    const final = store.listFeedback(missionId)
    // 查找键用 (threadRef, revision) 双键——单 revision 键会在多 thread 下撞行
    //（此前用 revision 单键 + 默认 rev-1 的 thread-2 行，同毫秒排序下间歇误中）。
    expect(final.find((r) => r.threadRef === 'thread-1' && r.revision === 'rev-1')!.state).toBe(
      'obsolete',
    )
    expect(final.find((r) => r.threadRef === 'thread-1' && r.revision === 'rev-2')!.state).toBe(
      'addressed',
    )
    expect(final.find((r) => r.threadRef === 'thread-2')!.state).toBe('observed')
    // 幂等：再跑无行可打。
    expect(store.obsoleteFeedbackForOtherHeads(missionId, HEAD_B, Date.now())).toBe(0)
  })
})

describe('rfc310 pr7 T73 — pure judgements', () => {
  test('fingerprint stability, author classification, selectable semantics', () => {
    // 指纹：同输入恒同、任一维变即变。
    const base = { threadRef: 't-1', revision: 'r-1', headSha: HEAD_A, bodyDigest: 'd'.repeat(64) }
    expect(feedbackFingerprint(base)).toBe(feedbackFingerprint({ ...base }))
    expect(feedbackFingerprint(base)).not.toBe(feedbackFingerprint({ ...base, revision: 'r-2' }))
    expect(feedbackFingerprint(base)).toMatch(/^[0-9a-f]{64}$/)

    // 作者分类：self-marker 逐字命中 > bot 命名 > human。
    expect(
      classifyFeedbackAuthor({
        body: 'auto note <!-- aw-self:m-123 --> end',
        authorUsername: 'anyone',
        selfMarker: 'm-123',
      }),
    ).toBe('self')
    expect(
      classifyFeedbackAuthor({ body: 'x', authorUsername: 'ci-runner[bot]', selfMarker: 'm-1' }),
    ).toBe('bot')
    expect(
      classifyFeedbackAuthor({ body: 'x', authorUsername: 'renovate-bot', selfMarker: 'm-1' }),
    ).toBe('bot')
    // 别家 marker 不互认；普通人类。
    expect(
      classifyFeedbackAuthor({
        body: '<!-- aw-self:other-mission -->',
        authorUsername: 'alice',
        selfMarker: 'm-123',
      }),
    ).toBe('human')

    // 可选集。
    const row = (over: Partial<FeedbackLedgerRow>): FeedbackLedgerRow => ({
      id: over.id ?? ulid(),
      missionId: 'm-1',
      threadRef: 't-1',
      revision: 'r-1',
      headSha: HEAD_A,
      fingerprint: 'f'.repeat(64),
      authorClass: 'human',
      state: 'observed',
      actionRunId: null,
      replyEffectId: null,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    })
    const policy = { allowedAuthorClasses: ['human'], batchLimit: 10, requireLatestRevision: true }
    // 同 thread 旧 revision observed、新 revision addressed ⇒ 全不入选
    //（latest 折叠在 state 过滤**之前**——旧修订永不入选）。
    const collapsed = selectableFeedback(
      [
        row({ id: 'a', revision: 'r-1', state: 'observed' }),
        row({ id: 'b', revision: 'r-2', state: 'addressed' }),
      ],
      policy,
    )
    expect(collapsed).toEqual([])
    // authorClass 过滤 + createdAt 升序 + batchLimit 截断。
    const picked = selectableFeedback(
      [
        row({ id: 'c', threadRef: 't-2', createdAt: 5 }),
        row({ id: 'd', threadRef: 't-3', createdAt: 3 }),
        row({ id: 'e', threadRef: 't-4', createdAt: 4, authorClass: 'bot' }),
        row({ id: 'f', threadRef: 't-5', createdAt: 9 }),
      ],
      { ...policy, batchLimit: 2 },
    )
    expect(picked.map((r) => r.id)).toEqual(['d', 'c'])
    // 闭集素材投影。
    expect(feedbackClosedRefs(picked)).toEqual([
      { threadRef: 't-3', revision: 'r-1' },
      { threadRef: 't-2', revision: 'r-1' },
    ])
  })
})

describe('rfc310 pr7 T72 — MR facts projection', () => {
  test('catalog leaves, vocabulary mapping, and honest absence for unreadable dimensions', () => {
    const full = projectMrCells(
      {
        mrRef: '7',
        headSha: HEAD_A,
        targetSha: HEAD_B,
        targetBranch: 'main',
        state: 'opened',
        draft: false,
        mergeableState: 'conflict',
        approvalHold: true,
        mergedCommitSha: null,
        mergedAt: null,
      },
      2,
      'snap-1',
      1_000,
    )
    expect(full['mr.exists']).toMatchObject({ value: true })
    expect(full['mr.draft']).toMatchObject({ value: false })
    expect(full['mr.conflict']).toMatchObject({ value: true })
    expect(full['mr.mergeable']).toMatchObject({ value: 'no' })
    expect(full['mr.approvalHold']).toMatchObject({ value: true })
    expect(full['mr.unhandledFeedbackCount']).toMatchObject({ value: 2 })
    expect(full['mr.terminalState']).toMatchObject({ value: 'active' })
    expect(full['__mr.headSha']).toMatchObject({ value: HEAD_A, sourceRevision: 'snap-1' })
    expect(full['__mr.targetSha']).toMatchObject({ value: HEAD_B })
    expect(full['__mr.factsCollectedAt']).toMatchObject({ value: '1000' })
    expect('__mr.mergedCommitSha' in full).toBe(false)

    // 读不到的维度不产 cell（规则读到 indeterminate 老实停）。
    const sparse = projectMrCells(
      {
        mrRef: '7',
        headSha: HEAD_A,
        targetSha: null,
        targetBranch: null,
        state: 'merged',
        draft: false,
        mergeableState: 'unknown',
        approvalHold: null,
        mergedCommitSha: 'cc'.repeat(20),
        mergedAt: '2026-08-18T00:00:00+00:00',
      },
      0,
      'snap-2',
      2_000,
    )
    expect('mr.approvalHold' in sparse).toBe(false)
    expect('__mr.targetSha' in sparse).toBe(false)
    expect(sparse['mr.mergeable']).toMatchObject({ value: 'unknown' })
    expect(sparse['mr.terminalState']).toMatchObject({ value: 'merged' })
    expect(sparse['__mr.mergedCommitSha']).toMatchObject({ value: 'cc'.repeat(20) })
    expect(sparse['__mr.mergedAt']).toMatchObject({ value: '2026-08-18T00:00:00+00:00' })
  })
})
