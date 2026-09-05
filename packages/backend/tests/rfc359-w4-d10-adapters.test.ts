// RFC-359 W4-D10 —— development-automation 的 Mission 持久化与读模型：一份实现，两个 provider 共用，同一段断言在
// 两个引擎上各跑一遍。承接原 rfc310-pr2-mission-store 用例锁的存储层不变量（launch idempotency、OCC / epoch、active
// MR claim 唯一、effect idempotency 与状态机、attempt ordinal 唯一、decision input 去重、deferred wake 的
// fire / early / ordinal 不清零、writable action 单活），并把 launch 事务（上传认领 + plan）、快照 + 决策原子操作与
// 读模型（分页 / facets / counts / 详情 / MR 投影 / effect 台账 / 决策 trace）也钉在两个引擎上。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { developmentRepositoryUploadPlans, missionInputUploads } from '@/db/schema'
import type {
  MissionPersistence,
  MissionRow,
} from '@/modules/development-automation/application/ports/missionStore'
import {
  evaluateWake,
  nextAttemptOrdinal,
} from '@/modules/development-automation/domain/deferredWake'
import {
  createMissionReadModelQueries,
  listMissionSummariesPage,
} from '@/modules/development-automation/infrastructure/missionReadModels'
import { createMissionPersistence } from '@/modules/development-automation/infrastructure/missionStore'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

function missionRow(overrides: Partial<MissionRow> = {}): MissionRow {
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

async function newStore(
  db: ProviderNeutralDatabase,
): Promise<{ store: MissionPersistence; missionId: string }> {
  const store = createMissionPersistence(db)
  const row = missionRow()
  await store.createMission(row)
  return { store, missionId: row.id }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? '<no-code>'
  }
}

describeEachProvider('RFC-359 W4-D10 —— Mission 持久化', (harness) => {
  test('launch idempotency：同键第二次返回既有行；commitMissionLaunch 一笔落 mission / source / 上传认领 / plan', async () => {
    const store = createMissionPersistence(harness.db)
    const row = missionRow({ launchIdempotencyKey: `idem-fixed-${ulid()}` })
    const first = await store.createMission(row)
    expect(first.created).toBe(true)
    const second = await store.createMission(
      missionRow({ launchIdempotencyKey: row.launchIdempotencyKey }),
    )
    expect(second.created).toBe(false)
    expect(second.mission.id).toBe(row.id)

    const uploadRef = ulid()
    await harness.db.insert(missionInputUploads).values({
      id: uploadRef,
      actorUserId: 'actor-1',
      originalName: 'spec.md',
      bytes: 3,
      sha256: 'b'.repeat(64),
      blobRef: 'blob-1',
      state: 'pending',
      expiresAt: NOW + 60_000,
      createdAt: NOW,
    })
    const launched = missionRow()
    const committed = await store.commitMissionLaunch({
      mission: launched,
      source: {
        id: ulid(),
        missionId: launched.id,
        generation: 1,
        sourceKind: 'direct',
        externalId: null,
        adapterId: null,
        adapterRevision: null,
        sourceRevision: null,
        bundleRef: null,
        manifestDigest: null,
        fileCount: null,
        totalBytes: null,
        state: 'active',
        createdAt: NOW,
      },
      upload: {
        actorUserId: 'actor-1',
        uploadRefs: [uploadRef],
        plan: {
          planId: `plan-${launched.id}`,
          missionId: launched.id,
          missionRevision: 0,
          repositoryId: 'repo-1',
          baselineSnapshotRef: 'snap-1',
          baselineSha: 'c'.repeat(40),
          planDigest: 'd'.repeat(64),
          entries: [],
          createdAt: NOW,
        },
        now: NOW + 1,
      },
    })
    expect(committed.created).toBe(true)
    expect((await store.listMissionSources(launched.id)).map((s) => s.generation)).toEqual([1])
    expect(
      (
        await harness.db
          .select({
            state: missionInputUploads.state,
            claimedBy: missionInputUploads.claimedByMissionId,
          })
          .from(missionInputUploads)
          .where(eq(missionInputUploads.id, uploadRef))
      )[0],
    ).toEqual({ state: 'claimed', claimedBy: launched.id })
    expect(
      await harness.db
        .select({ id: developmentRepositoryUploadPlans.id })
        .from(developmentRepositoryUploadPlans)
        .where(eq(developmentRepositoryUploadPlans.missionId, launched.id)),
    ).toEqual([{ id: `plan-${launched.id}` }])

    // 已认领的上传不能再被另一个 launch 认领——整笔回滚，第二个 mission 不落库。
    const rival = missionRow()
    expect(
      await codeOf(() =>
        store.commitMissionLaunch({
          mission: rival,
          source: {
            id: ulid(),
            missionId: rival.id,
            generation: 1,
            sourceKind: 'direct',
            externalId: null,
            adapterId: null,
            adapterRevision: null,
            sourceRevision: null,
            bundleRef: null,
            manifestDigest: null,
            fileCount: null,
            totalBytes: null,
            state: 'active',
            createdAt: NOW,
          },
          upload: {
            actorUserId: 'actor-1',
            uploadRefs: [uploadRef],
            plan: {
              planId: `plan-${rival.id}`,
              missionId: rival.id,
              missionRevision: 0,
              repositoryId: 'repo-1',
              baselineSnapshotRef: 'snap-1',
              baselineSha: 'c'.repeat(40),
              planDigest: 'd'.repeat(64),
              entries: [],
              createdAt: NOW,
            },
            now: NOW + 2,
          },
        }),
      ),
    ).toBe('upload-already-claimed')
    expect(await store.getMission(rival.id)).toBeNull()
  })

  test('OCC：同 revision 并发写恰一成功；epoch 冲突单独报告；bumpEpoch 让在途 continuation 过期', async () => {
    const { store, missionId } = await newStore(harness.db)
    const results = await Promise.all([
      store.occUpdate(missionId, 0, 0, { status: 'publishing' }),
      store.occUpdate(missionId, 0, 0, { status: 'blocked' }),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const losses = results.filter((r) => !r.ok)
    expect(losses).toHaveLength(1)
    if (!losses[0]!.ok) expect(losses[0]!.code).toBe('revision-conflict')

    const bumped = await store.bumpEpoch(missionId, 1, { transitionFence: 'cancel-pending' })
    expect(bumped).toEqual({ ok: true, revision: 2 })
    expect(await store.occUpdate(missionId, 2, 0, { status: 'publishing' })).toEqual({
      ok: false,
      code: 'epoch-conflict',
    })
    expect(await store.occUpdate('missing', 0, 0, { status: 'publishing' })).toEqual({
      ok: false,
      code: 'not-found',
    })
    expect((await store.getMission(missionId))?.transitionFence).toBe('cancel-pending')
  })

  test('MR claim：active 唯一，released 释放槽位；findMrClaim 在历史堆积时优先 active、其次最新', async () => {
    const { store, missionId } = await newStore(harness.db)
    const other = missionRow()
    await store.createMission(other)
    const claim = {
      codeHostEndpointRef: `ep-${missionId}`,
      stableProjectRef: 'proj-1',
      mrIid: '42',
      headSha: null,
      now: 1_000,
    }
    expect(await store.claimMr({ ...claim, id: `c1-${missionId}`, missionId, epoch: 0 })).toEqual({
      ok: true,
    })
    expect(
      await store.claimMr({ ...claim, id: `c2-${missionId}`, missionId: other.id, epoch: 0 }),
    ).toEqual({ ok: false, code: 'mr-owned-by-another-mission' })
    await store.releaseMr(`c1-${missionId}`, 1_100)
    expect(
      await store.claimMr({
        ...claim,
        id: `c3-${missionId}`,
        missionId: other.id,
        epoch: 0,
        now: 1_200,
      }),
    ).toEqual({ ok: true })
    expect(
      await store.findMrClaim({
        codeHostEndpointRef: claim.codeHostEndpointRef,
        stableProjectRef: 'proj-1',
        mrIid: '42',
      }),
    ).toEqual({ id: `c3-${missionId}`, missionId: other.id, state: 'active' })
    expect(await store.getMrClaim(`c1-${missionId}`)).toMatchObject({
      missionId,
      mrIid: '42',
      state: 'released',
    })
    await store.releaseMr(`c3-${missionId}`, 1_300)
    expect(
      await store.findMrClaim({
        codeHostEndpointRef: claim.codeHostEndpointRef,
        stableProjectRef: 'proj-1',
        mrIid: '42',
      }),
    ).toEqual({ id: `c3-${missionId}`, missionId: other.id, state: 'released' })
  })

  test('wake hint 按 delivery key 去重并可消费；deferred wake 的 fire / early / ordinal 语义', async () => {
    const { store, missionId } = await newStore(harness.db)
    const hint = {
      id: ulid(),
      missionId,
      source: 'code-host',
      deliveryKey: `d-${missionId}`,
      now: NOW,
    }
    expect(await store.recordWakeHint(hint)).toEqual({ accepted: true })
    expect(await store.recordWakeHint({ ...hint, id: ulid() })).toEqual({ accepted: false })
    expect(await store.consumeWakeHints(missionId, NOW)).toBe(1)
    expect(await store.consumeWakeHints(missionId, NOW)).toBe(0)

    const decisionId = ulid()
    const wakeId = `w-${missionId}`
    await store.armWake({
      id: wakeId,
      missionId,
      decisionId,
      reason: 'pipeline-running',
      resumeAt: 1_000,
      wakeSources: ['pipeline'],
      attemptOrdinal: 3,
      now: 0,
    })
    const row = (await store.getWake(missionId, decisionId))!
    expect(evaluateWake(row, { kind: 'timer', now: 500 })).toEqual({ fire: false, code: 'not-due' })
    expect(evaluateWake(row, { kind: 'external', source: 'pipeline' })).toEqual({
      fire: true,
      early: true,
    })
    expect(nextAttemptOrdinal(row)).toBe(4)
    expect((await store.listDueWakes(2_000)).map((w) => w.id)).toContain(wakeId)
    expect(await store.fireWake(wakeId, 600)).toBe(true)
    expect(await store.fireWake(wakeId, 601)).toBe(false)
    expect((await store.listDueWakes(2_000)).map((w) => w.id)).not.toContain(wakeId)
    await store.settleWake(wakeId, 700)
    expect((await store.getWake(missionId, decisionId))?.state).toBe('settled')
  })

  test('decision input digest 去重（含快照 + 决策的原子操作）；writable action 单活；attempt ordinal 唯一且按序回读', async () => {
    const { store, missionId } = await newStore(harness.db)
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
      decisionInputDigest: `d-${missionId}`,
      now: NOW,
    }
    expect(await store.insertDecision({ ...base, id: `dec-1-${missionId}` })).toEqual({
      created: true,
      decisionId: `dec-1-${missionId}`,
    })
    expect(
      await store.commitFactSnapshotAndDecision({
        snapshot: {
          id: `snap-${missionId}`,
          missionId,
          missionRevision: 0,
          capturedAt: '2026-01-01T00:00:00+00:00',
          cellsJson: '{}',
          refsJson: '{}',
          digest: 'e'.repeat(64),
          now: NOW,
        },
        decision: { ...base, id: `dec-2-${missionId}`, factSnapshotId: `snap-${missionId}` },
      }),
    ).toEqual({ created: false, decisionId: `dec-1-${missionId}` })

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
        now: NOW,
      })
    expect(await mk(`run-1-${missionId}`, 'dec-a', true)).toEqual({ ok: true })
    expect(await mk(`run-2-${missionId}`, 'dec-b', true)).toEqual({
      ok: false,
      code: 'writable-action-already-active',
    })
    expect(await mk(`run-3-${missionId}`, 'dec-c', false)).toEqual({ ok: true })
    expect(await store.countActionRuns(missionId, 'change.implement')).toBe(2)
    await store.settleActionRun({
      id: `run-1-${missionId}`,
      status: 'settled',
      resultRef: null,
      failureJson: null,
      now: NOW,
    })
    expect(await mk(`run-4-${missionId}`, 'dec-d', true)).toEqual({ ok: true })
    expect(await store.getActionRun(`run-1-${missionId}`)).toMatchObject({
      status: 'settled',
      writable: true,
    })

    const claim = (id: string, rerunSeq: number, attemptSeq: number) =>
      store.claimAttempt({
        id,
        actionRunId: `run-3-${missionId}`,
        rerunSeq,
        attemptSeq,
        executionRef: `exec-${id}`,
        baselineRef: 'base-1',
        nonceDigest: 'n'.repeat(64),
        inputDigest: 'g'.repeat(64),
        now: NOW,
      })
    expect(await claim(`att-b-${missionId}`, 1, 0)).toEqual({ ok: true })
    expect(await claim(`att-a-${missionId}`, 0, 1)).toEqual({ ok: true })
    expect(await claim(`att-0-${missionId}`, 0, 0)).toEqual({ ok: true })
    expect(await claim(`att-dup-${missionId}`, 0, 0)).toEqual({
      ok: false,
      code: 'attempt-ordinal-taken',
    })
    await store.settleAttempt({
      id: `att-a-${missionId}`,
      status: 'rejected',
      rejectionJson: '{"code":"schema"}',
      outcomeRef: null,
      now: NOW,
    })
    const rows = await store.listAttempts(`run-3-${missionId}`)
    expect(rows.map((r) => r.id)).toEqual([
      `att-0-${missionId}`,
      `att-a-${missionId}`,
      `att-b-${missionId}`,
    ])
    expect(rows[1]).toMatchObject({ status: 'rejected', rejectionJson: '{"code":"schema"}' })
  })

  test('effect idempotency + 闭合状态机（迁移读—判—写在事务里）；feedback 台账幂等与旧 head 作废', async () => {
    const { store, missionId } = await newStore(harness.db)
    const prepare = (id: string) =>
      store.prepareEffect({
        id,
        missionId,
        actionRunId: null,
        effectKind: 'mr.ensure',
        intentDigest: 'h'.repeat(64),
        idempotencyKey: `effect-key-${missionId}`,
        epoch: 0,
        now: NOW,
      })
    const first = await prepare(`ef-1-${missionId}`)
    expect(first.created).toBe(true)
    expect(await prepare(`ef-2-${missionId}`)).toEqual({ created: false, effect: first.effect })
    expect(await codeOf(() => store.confirmEffect(`ef-1-${missionId}`, 'receipt-1', NOW))).toBe(
      'development-effect-illegal-transition',
    )
    expect(await codeOf(() => store.markEffectDispatched('ef-missing', NOW))).toBe(
      'development-effect-not-found',
    )
    await store.markEffectDispatched(`ef-1-${missionId}`, NOW)
    expect((await store.listPreparedEffects()).map((e) => e.id)).not.toContain(`ef-1-${missionId}`)
    await store.confirmEffect(`ef-1-${missionId}`, 'receipt-1', NOW)
    expect((await store.getEffect(`ef-1-${missionId}`))?.state).toBe('confirmed')
    expect(await codeOf(() => store.invalidateEffect(`ef-1-${missionId}`, NOW))).toBe(
      'development-effect-illegal-transition',
    )
    expect(await store.listUnsettledEffects(missionId)).toHaveLength(0)

    const observation = (
      overrides: Partial<{ threadRef: string; revision: string; headSha: string }>,
    ) => ({
      id: ulid(),
      missionId,
      threadRef: 'thread-1',
      revision: 'rev-1',
      headSha: 'aa'.repeat(20),
      fingerprint: 'fp',
      authorClass: 'human' as const,
      now: NOW,
      ...overrides,
    })
    expect(await store.upsertFeedbackObservation(observation({}))).toEqual({ created: true })
    expect(await store.upsertFeedbackObservation(observation({}))).toEqual({ created: false })
    expect(await store.upsertFeedbackObservation(observation({ revision: 'rev-2' }))).toEqual({
      created: true,
    })
    expect(
      await store.upsertFeedbackObservation(
        observation({ threadRef: 'thread-2', revision: 'rev-9', headSha: 'bb'.repeat(20) }),
      ),
    ).toEqual({ created: true })
    const ledger = await store.listFeedback(missionId)
    expect(ledger).toHaveLength(3)
    // 同一毫秒内的 ULID 不保证单调，台账顺序在两个引擎上都可能不同——按线程挑行，不靠 ledger[0]。
    const current = ledger.find((row) => row.threadRef === 'thread-2')!
    await store.setFeedbackState({ id: current.id, state: 'selected', now: NOW + 1 })
    expect(await store.obsoleteFeedbackForOtherHeads(missionId, 'bb'.repeat(20), NOW + 2)).toBe(2)
    expect((await store.listFeedback(missionId)).map((row) => row.state).sort()).toEqual([
      'obsolete',
      'obsolete',
      'selected',
    ])
  })

  test('读模型：分页按 (createdAt, id) 逆序 keyset、facets 算全集、counts 算过滤集；详情 / MR 投影 / effect 台账 / 决策 trace', async () => {
    const store = createMissionPersistence(harness.db)
    const queries = createMissionReadModelQueries(harness.db)
    const employeeId = `emp-${ulid()}`
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const row = missionRow({
        createdAt: NOW + index,
        updatedAt: NOW + index,
        employeeId,
        status: index === 4 ? 'merged' : 'working',
        externalId: index === 0 ? `EXT-${employeeId}` : null,
      })
      await store.createMission(row)
      ids.push(row.id)
    }
    const page1 = await listMissionSummariesPage(harness.db, { limit: 2, employeeId })
    expect(page1.items.map((m) => m.id)).toEqual([ids[4]!, ids[3]!])
    expect(page1.nextCursor).toEqual({ createdAt: NOW + 3, id: ids[3]! })
    const page2 = await queries.listPage({ limit: 2, cursor: page1.nextCursor!, employeeId })
    expect(page2.items.map((m) => m.id)).toEqual([ids[2]!, ids[1]!])
    const page3 = await queries.listPage({ limit: 2, cursor: page2.nextCursor!, employeeId })
    expect(page3.items.map((m) => m.id)).toEqual([ids[0]!])
    expect(page3.nextCursor).toBeNull()
    expect(page1.counts).toEqual({ working: 4, merged: 1 })
    expect(page1.facets.all).toBeGreaterThanOrEqual(5)
    expect(
      (
        await queries.listPage({ limit: 10, employeeId, q: `ext-${employeeId}`.toUpperCase() })
      ).items.map((m) => m.id),
    ).toEqual([ids[0]!])
    expect(
      (await queries.listPage({ limit: 10, employeeId, missionStatuses: ['merged'] })).items.map(
        (m) => m.id,
      ),
    ).toEqual([ids[4]!])
    expect(await queries.terminalOutcomeGroups()).toEqual(
      expect.arrayContaining([{ employeeId, terminalKind: 'merged', count: 1 }]),
    )
    expect((await queries.list()).map((m) => m.id)).toEqual(expect.arrayContaining(ids))

    const detail = await queries.detail(ids[0]!)
    expect(detail).toMatchObject({ id: ids[0]!, employeeId, sources: [], readiness: null })
    expect(await queries.detail('missing')).toBeNull()
    await store.claimMr({
      id: `claim-${ids[0]!}`,
      codeHostEndpointRef: 'github.example',
      stableProjectRef: 'acme/app',
      mrIid: '7',
      missionId: ids[0]!,
      epoch: 0,
      headSha: null,
      now: NOW,
    })
    expect(await queries.mergeRequest(ids[0]!, 'repo-missing')).toEqual({
      iid: '7',
      state: 'active',
      href: null,
    })
    await store.prepareEffect({
      id: `ef-${ids[0]!}`,
      missionId: ids[0]!,
      actionRunId: null,
      effectKind: 'mr.ensure',
      intentDigest: 'h'.repeat(64),
      idempotencyKey: `key-${ids[0]!}`,
      epoch: 0,
      now: NOW,
    })
    expect(await queries.effects(ids[0]!)).toEqual([
      expect.objectContaining({ id: `ef-${ids[0]!}`, state: 'prepared', epoch: 0 }),
    ])
    await store.insertDecision({
      id: `dec-${ids[0]!}`,
      missionId: ids[0]!,
      missionRevision: 0,
      policyId: null,
      policyRevision: null,
      employeeId: null,
      employeeRevision: null,
      factSnapshotId: null,
      factDigest: 'b'.repeat(64),
      workSetJson: null,
      guardTraceJson: '[{"g":1}]',
      ruleTraceJson: '[]',
      selectedJson: '{"kind":"collect-mr-facts"}',
      canonicalDigest: 'c'.repeat(64),
      decisionInputDigest: `digest-${ids[0]!}`,
      now: NOW,
    })
    expect(await queries.decisionTrace(ids[0]!)).toEqual([
      expect.objectContaining({
        id: `dec-${ids[0]!}`,
        guardTrace: [{ g: 1 }],
        selected: { kind: 'collect-mr-facts' },
      }),
    ])
  })
})

test('源码锁：Mission 持久化与读模型不再有 provider 专属文件', () => {
  const infra = join(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'development-automation',
    'infrastructure',
  )
  for (const retired of [
    'sqliteMissionStore.ts',
    'postgresqlMissionStore.ts',
    'postgresqlMissionReadModels.ts',
  ]) {
    expect(existsSync(join(infra, retired))).toBe(false)
  }
  for (const neutral of ['missionStore.ts', 'missionReadModels.ts']) {
    const source = readFileSync(join(infra, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|for update/i)
    expect(source).toContain('ProviderNeutralDatabase')
  }
})
