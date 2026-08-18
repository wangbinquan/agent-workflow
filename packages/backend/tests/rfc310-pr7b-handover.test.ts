// RFC-310 PR-7b T80 —— handoff / attach-MR / resume 三命令。
//
// 锁：①handoff：bump epoch + fence，在途 attempt discarded、prepared effect
// invalidated；dispatched effect 不猜结果——保持 fence 交 settleFence（pending
// 语义），无悬挂时命令内直接收口 tracking-only 且 MR claim 保留；②attach：
// 平台主动 observe 校验（不信入参自述）、唯一 claim 撞后消歧异主才拒、转
// adopt 继续 tracking；所挂 MR 已 merged/closed 同一命令内 authoritative
// terminal + upload fulfillment 如实定格（unfulfilled ≠ success）；未结算
// effect 拒绑；③resume：先把 MR/pipeline facts 标记过期（下轮强制 recollect）
// 再 bump epoch 回 active；admissibility 拒非 tracking。④HTTP 面 permission
// 三新点 + typed 错误码。命令层多断言收单 test 防 --randomize。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { Hono } from 'hono'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  attachMergeRequest,
  handoffMission,
  resumeMission,
} from '../src/modules/development-automation/application/commands/missionHandover'
import type {
  MissionRow,
  MissionStore,
} from '../src/modules/development-automation/application/ports/missionStore'
import type { MrEffectsPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { canonicalDigest } from '../src/modules/development-automation/domain/canonicalJson'
import { createApp } from '../src/server'
import { createSession } from '../src/auth/sessionStore'
import { createUser } from '../src/services/users'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedMission(store: MissionStore, overrides: Partial<MissionRow> = {}): string {
  const now = Date.now()
  const missionId = overrides.id ?? ulid()
  store.createMission({
    id: missionId,
    revision: 0,
    epoch: 0,
    status: 'watching',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: 'repo-7b',
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
    launchIdempotencyKey: `idem-${missionId}`,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
  return missionId
}

function observing(state: 'opened' | 'merged' | 'closed', sourceSha: string | null): MrEffectsPort {
  return {
    async observe(_repo, mrRef) {
      return {
        ok: true,
        observation: { mrRef, state, sourceSha, targetBranch: 'main', webUrl: null },
      }
    },
    async ensure() {
      throw new Error('not used')
    },
    async reply() {
      throw new Error('not used')
    },
  }
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { code?: string },
  )
  expect(err?.code).toBe(code)
}

function handoverDeps(fx: Pr3Fixture, mrEffects?: MrEffectsPort) {
  return {
    store: fx.store,
    snapshots: fx.snapshots,
    ...(mrEffects === undefined ? {} : { ports: { mrEffects } }),
    now: () => Date.now(),
  }
}

describe('rfc310 pr7b — handoff command', () => {
  test('fences, revokes in-flight action, invalidates prepared effects; dispatched effects keep the fence pending', async () => {
    const fx = await buildPr3Fixture()
    const now = Date.now()

    // A) 干净 mission：直接收口 tracking-only（epoch+1、fence 清、claim 保留）。
    const clean = seedMission(fx.store, { mrClaimId: 'claim-keep' })
    const done = await handoffMission(handoverDeps(fx), { missionId: clean, reason: 'manual' })
    expect(done).toEqual({ automationMode: 'tracking-only', status: 'watching', pending: false })
    const cleanRow = fx.store.getMission(clean)!
    expect(cleanRow.epoch).toBe(1)
    expect(cleanRow.transitionFence).toBe('none')
    expect(cleanRow.mrClaimId).toBe('claim-keep')

    // B) 在途 action + prepared/dispatched effect 的处置矩阵。
    const busy = seedMission(fx.store, { status: 'working' })
    const runId = `run-${busy}`
    fx.store.createActionRun({
      id: runId,
      missionId: busy,
      missionRevision: 0,
      decisionId: `dec-${busy}`,
      capabilityId: 'change.implement',
      capabilityContractVersion: 1,
      templateId: null,
      templateRevision: null,
      workSetDigest: null,
      inputFactDigest: 'e'.repeat(64),
      baselineRef: 'base',
      writable: true,
      now,
    })
    fx.store.claimAttempt({
      id: `att-${busy}`,
      actionRunId: runId,
      rerunSeq: 0,
      attemptSeq: 0,
      executionRef: null,
      baselineRef: 'base',
      nonceDigest: 'n'.repeat(64),
      inputDigest: 'i'.repeat(64),
      now,
    })
    {
      const m = fx.store.getMission(busy)!
      fx.store.occUpdate(m.id, m.revision, m.epoch, { currentActionRunId: runId })
    }
    const prepared = fx.store.prepareEffect({
      id: ulid(),
      missionId: busy,
      actionRunId: null,
      effectKind: 'candidate-push',
      intentDigest: canonicalDigest({ a: 1 }),
      idempotencyKey: `p:${busy}`,
      epoch: 0,
      now,
    })
    const dispatched = fx.store.prepareEffect({
      id: ulid(),
      missionId: busy,
      actionRunId: null,
      effectKind: 'mr-ensure',
      intentDigest: canonicalDigest({ b: 2 }),
      idempotencyKey: `d:${busy}`,
      epoch: 0,
      now,
    })
    fx.store.markEffectDispatched(dispatched.effect.id, now)

    const pending = await handoffMission(handoverDeps(fx), { missionId: busy })
    expect(pending.pending).toBe(true)
    const busyRow = fx.store.getMission(busy)!
    expect(busyRow.transitionFence).toBe('handoff-pending')
    expect(busyRow.epoch).toBe(1)
    expect(busyRow.currentActionRunId).toBeNull()
    // 在途 attempt discarded、run failed。
    expect(fx.store.listAttempts(runId)[0]!.status).toBe('discarded')
    expect(fx.store.getActionRun(runId)!.status).toBe('failed')
    // prepared 作废、dispatched 保留（settleFence 按外部真相结算）。
    expect(fx.store.getEffect(prepared.effect.id)!.state).toBe('invalidated')
    expect(fx.store.getEffect(dispatched.effect.id)!.state).toBe('dispatched')

    // 二次 handoff：fence 已挂 → mission-command-transition-pending。
    await expect(handoffMission(handoverDeps(fx), { missionId: busy })).rejects.toThrow(
      'transition-pending',
    )
  })
})

describe('rfc310 pr7b — attach command', () => {
  test('binds an open MR (adopt + claim + cells); merged MR settles terminal with honest fulfillment; typed refusals', async () => {
    const fx = await buildPr3Fixture()

    // 拒：非 tracking-only。
    const active = seedMission(fx.store)
    await expect(
      attachMergeRequest(handoverDeps(fx, observing('opened', 'aa'.repeat(20))), {
        missionId: active,
        mrIid: '7',
        codeHostEndpointRef: 'gitlab',
        stableProjectRef: 'grp/repo',
      }),
    ).rejects.toThrow('attach-requires-tracking-only')

    // 拒：未结算 effect。
    const withEffect = seedMission(fx.store, { automationMode: 'tracking-only' })
    const eff = fx.store.prepareEffect({
      id: ulid(),
      missionId: withEffect,
      actionRunId: null,
      effectKind: 'mr-ensure',
      intentDigest: canonicalDigest({ x: 1 }),
      idempotencyKey: `k:${withEffect}`,
      epoch: 0,
      now: Date.now(),
    })
    fx.store.markEffectDispatched(eff.effect.id, Date.now())
    await expectCode(
      attachMergeRequest(handoverDeps(fx, observing('opened', null)), {
        missionId: withEffect,
        mrIid: '8',
        codeHostEndpointRef: 'gitlab',
        stableProjectRef: 'grp/repo',
      }),
      'mission-effects-unsettled',
    )

    // 拒：observe 端口缺 / claim 键推不出。
    const bare = seedMission(fx.store, { automationMode: 'tracking-only' })
    await expectCode(
      attachMergeRequest(handoverDeps(fx), { missionId: bare, mrIid: '9' }),
      'mr-observe-unavailable',
    )
    await expectCode(
      attachMergeRequest(handoverDeps(fx, observing('opened', null)), {
        missionId: bare,
        mrIid: '9',
      }),
      'mr-binding-unresolved',
    )

    // 拒：claim 已归他人。
    const rival = seedMission(fx.store, { automationMode: 'tracking-only' })
    const rivalOwner = seedMission(fx.store)
    fx.store.claimMr({
      id: 'claim-rival',
      codeHostEndpointRef: 'gitlab',
      stableProjectRef: 'grp/repo',
      mrIid: '10',
      missionId: rivalOwner,
      epoch: 0,
      headSha: null,
      now: Date.now(),
    })
    await expectCode(
      attachMergeRequest(handoverDeps(fx, observing('opened', null)), {
        missionId: rival,
        mrIid: '10',
        codeHostEndpointRef: 'gitlab',
        stableProjectRef: 'grp/repo',
      }),
      'mr-owned-by-another-mission',
    )

    // 成：opened → adopt 绑定 + cells + tracking 继续。
    const attach = seedMission(fx.store, { automationMode: 'tracking-only' })
    const bound = await attachMergeRequest(handoverDeps(fx, observing('opened', 'ab'.repeat(20))), {
      missionId: attach,
      mrIid: '11',
      codeHostEndpointRef: 'gitlab',
      stableProjectRef: 'grp/repo',
    })
    expect(bound.terminal).toBeNull()
    expect(bound.deliveryKind).toBe('adopt-merge-request')
    const attachRow = fx.store.getMission(attach)!
    expect(attachRow.deliveryKind).toBe('adopt-merge-request')
    expect(attachRow.adoptedMrRef).toBe('11')
    expect(attachRow.mrClaimId).toBe(bound.mrClaimId)
    const cells = fx.snapshots.getCells(attachRow.requirementBundleRef!)!
    expect(cells['__mr.ref']).toMatchObject({ value: '11' })

    // 成：merged → 同一命令内 authoritative terminal + fulfillment 如实定格。
    const mergedM = seedMission(fx.store, {
      automationMode: 'tracking-only',
      uploadPlanRef: 'plan-x',
    })
    const settled = await attachMergeRequest(
      handoverDeps(fx, observing('merged', 'cd'.repeat(20))),
      {
        missionId: mergedM,
        mrIid: '12',
        codeHostEndpointRef: 'gitlab',
        stableProjectRef: 'grp/repo',
      },
    )
    expect(settled.terminal).toBe('merged')
    const mergedRow = fx.store.getMission(mergedM)!
    expect(mergedRow.status).toBe('merged')
    expect(mergedRow.terminalKind).toBe('merged')
    // plan 在、无 publication receipt → unfulfilled（不是 success，只是被外部合入截断）。
    expect(mergedRow.terminalUploadFulfillment).toBe('unfulfilled')
  })
})

describe('rfc310 pr7b — resume command', () => {
  test('marks facts stale, bumps epoch, returns to active; refuses non-tracking missions', async () => {
    const fx = await buildPr3Fixture()
    const tracked = seedMission(fx.store, { automationMode: 'tracking-only' })
    const out = await resumeMission(handoverDeps(fx), { missionId: tracked })
    expect(out).toEqual({ automationMode: 'active', status: 'watching' })
    const row = fx.store.getMission(tracked)!
    expect(row.automationMode).toBe('active')
    expect(row.epoch).toBe(1)
    const cells = fx.snapshots.getCells(row.requirementBundleRef!)!
    expect(cells['__mr.factsCollectedAt']).toMatchObject({ value: '0' })
    expect(cells['__pipeline.collectedAt']).toMatchObject({ value: '0' })

    const active = seedMission(fx.store)
    await expect(resumeMission(handoverDeps(fx), { missionId: active })).rejects.toThrow(
      'not-tracking-only',
    )
  })
})

describe('rfc310 pr7b — HTTP face', () => {
  test('three endpoints enforce their permission points and surface typed codes', async () => {
    const db: DbClient = createInMemoryDb(MIGRATIONS)
    const fx = await buildPr3Fixture({ db })
    const app: Hono = createApp({
      token: 'a'.repeat(64),
      configPath: '/tmp/aw-pr7b-config-never-used.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const admin = await createUser(db, {
      username: 'admin-pr7b',
      displayName: 'Admin',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const token = (await createSession({ db, userId: admin.id })).token
    const post = async (path: string, body: unknown = {}): Promise<Response> =>
      app.request(path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })

    // handoff：happy path（干净 mission 直接 tracking-only）。
    const m1 = seedMission(fx.store)
    const handedOff = await post(`/api/code/missions/${m1}/handoff`, { reason: 'take over' })
    expect(handedOff.status).toBe(200)
    expect((await handedOff.json()) as object).toMatchObject({
      automationMode: 'tracking-only',
      pending: false,
    })

    // resume：happy path（刚交接的 mission 拉回 active）。
    const resumed = await post(`/api/code/missions/${m1}/resume`)
    expect(resumed.status).toBe(200)
    expect((await resumed.json()) as object).toMatchObject({ automationMode: 'active' })

    // attach：真 binder 无 code-host connection → typed 409 mr-observe-unavailable。
    const m2 = seedMission(fx.store, { automationMode: 'tracking-only' })
    const attach = await post(`/api/code/missions/${m2}/attach-mr`, { mrIid: '7' })
    expect(attach.status).toBe(409)
    expect(((await attach.json()) as { code: string }).code).toBe('mr-observe-unavailable')

    // 命令准入失败也是 typed 409（route-error-code coverage 点名）：
    // mission-command-not-tracking-only / mission-command-already-tracking-only /
    // mission-command-attach-requires-tracking-only / mission-command-mr-already-bound /
    // mission-effects-unsettled / mr-binding-unresolved / mr-owned-by-another-mission。
    const m3 = seedMission(fx.store)
    const refuse = await post(`/api/code/missions/${m3}/resume`)
    expect(refuse.status).toBe(409)
    expect(((await refuse.json()) as { code: string }).code).toBe(
      'mission-command-not-tracking-only',
    )

    // 404：不存在的 mission。
    const missing = await post(`/api/code/missions/does-not-exist/handoff`)
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { code: string }).code).toBe('mission-not-found')
  })
})
