// RFC-359 W4-D11 —— development-automation 的 Playbook saga 持久化与上传会话 store：一份实现，两个 provider 共用，
// 同一段断言在两个引擎上各跑一遍。承接原 rfc310-pr3-upload-session 锁的会话合同（①createUpload 按 (actor,
// idempotencyKey) 幂等复用；②DELETE 只对本人 pending 生效，他人 / 已 claim / 不存在同形 404；③claim 全有或全无；
// ④同 mission 重放 claim 幂等；⑤TTL 过期拒 claim、sweep 只清 pending；⑥plan + 有序 entries 落库），再把 saga
// 的认领幂等 / 状态机 CAS / mission link / approval saga / step join / digest 也钉在两个引擎上。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
} from '@/db/schema'
import type { MissionRow } from '@/modules/development-automation/application/ports/missionStore'
import { createMissionPersistence } from '@/modules/development-automation/infrastructure/missionStore'
import { createPlaybookSagaPersistence } from '@/modules/development-automation/infrastructure/playbookSagaStore'
import { insertUploadPlan } from '@/modules/development-automation/infrastructure/uploadPlanStore'
import {
  createUploadSessionPersistence,
  UPLOAD_SESSION_TTL_MS,
  type UploadSessionPersistence,
} from '@/modules/development-automation/infrastructure/uploadSessionStore'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

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
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

async function newMission(db: ProviderNeutralDatabase): Promise<string> {
  const row = missionRow()
  await createMissionPersistence(db).createMission(row)
  return row.id
}

function put(
  store: UploadSessionPersistence,
  overrides: Partial<{
    actorUserId: string | null
    originalName: string
    idempotencyKey: string | null
    now: number
    sha256: string
  }> = {},
) {
  return store.createUpload({
    actorUserId: 'actorUserId' in overrides ? overrides.actorUserId! : 'u-1',
    originalName: overrides.originalName ?? 'spec.md',
    bytes: 4,
    sha256: overrides.sha256 ?? 'a'.repeat(64),
    blobRef: overrides.sha256 ?? 'a'.repeat(64),
    idempotencyKey: overrides.idempotencyKey ?? null,
    now: overrides.now ?? T0,
  })
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? '<no-code>'
  }
}

describeEachProvider('RFC-359 W4-D11 —— 上传会话 store', (harness) => {
  test('createUpload 按 (actor, idempotencyKey) 幂等复用；不同 actor / 无键各得新行；null actor 也能幂等', async () => {
    const store = createUploadSessionPersistence(harness.db)
    const first = await put(store, { idempotencyKey: 'retry-1' })
    const replay = await put(store, { idempotencyKey: 'retry-1' })
    expect(replay.id).toBe(first.id)
    expect((await put(store, { idempotencyKey: 'retry-1', actorUserId: 'u-2' })).id).not.toBe(
      first.id,
    )
    expect((await put(store)).id).not.toBe(first.id)
    const anonymous = await put(store, { idempotencyKey: 'anon-1', actorUserId: null })
    expect((await put(store, { idempotencyKey: 'anon-1', actorUserId: null })).id).toBe(
      anonymous.id,
    )
    expect(await store.getUpload(first.id)).toMatchObject({
      id: first.id,
      state: 'pending',
      expiresAt: T0 + UPLOAD_SESSION_TTL_MS,
      bytes: 4,
    })
  })

  test('deleteUpload：本人 pending 可删；他人 / 已 claim / 不存在同形 404 且不误删', async () => {
    const store = createUploadSessionPersistence(harness.db)
    const missionId = await newMission(harness.db)
    const mine = await put(store)
    const foreign = await put(store, { actorUserId: 'u-2' })
    const claimed = await put(store)
    await store.claimUploads({ missionId, actorUserId: 'u-1', uploadRefs: [claimed.id], now: T0 })

    await store.deleteUpload(mine.id, 'u-1')
    expect(await store.getUpload(mine.id)).toBeNull()
    for (const ref of [foreign.id, claimed.id, 'does-not-exist']) {
      expect(await codeOf(() => store.deleteUpload(ref, 'u-1'))).toBe('upload-not-found')
    }
    expect(await store.getUpload(foreign.id)).not.toBeNull()
    expect((await store.getUpload(claimed.id))?.state).toBe('claimed')
  })

  test('claim 全有或全无：一个被别的 mission 拿走的 ref 让其余 ref 零消费', async () => {
    const store = createUploadSessionPersistence(harness.db)
    const thief = await newMission(harness.db)
    const mission = await newMission(harness.db)
    const a = await put(store)
    const b = await put(store)
    const stolen = await put(store)
    await store.claimUploads({
      missionId: thief,
      actorUserId: 'u-1',
      uploadRefs: [stolen.id],
      now: T0,
    })
    expect(
      await codeOf(() =>
        store.claimUploads({
          missionId: mission,
          actorUserId: 'u-1',
          uploadRefs: [a.id, b.id, stolen.id],
          now: T0,
        }),
      ),
    ).toBe('upload-already-claimed')
    expect((await store.getUpload(a.id))?.state).toBe('pending')
    expect((await store.getUpload(b.id))?.state).toBe('pending')
    expect((await store.getUpload(stolen.id))?.claimedByMissionId).toBe(thief)
  })

  test('同 mission 重放 claim 幂等；过期拒 claim（upload-not-claimable）；他人 ref 与不存在同形', async () => {
    const store = createUploadSessionPersistence(harness.db)
    const mission = await newMission(harness.db)
    const row = await put(store)
    const first = await store.claimUploads({
      missionId: mission,
      actorUserId: 'u-1',
      uploadRefs: [row.id],
      now: T0,
    })
    expect(first).toMatchObject([{ id: row.id, state: 'claimed', claimedByMissionId: mission }])
    const replay = await store.claimUploads({
      missionId: mission,
      actorUserId: 'u-1',
      uploadRefs: [row.id],
      now: T0,
    })
    expect(replay[0]?.claimedByMissionId).toBe(mission)

    const expiring = await put(store)
    expect(
      await codeOf(() =>
        store.claimUploads({
          missionId: mission,
          actorUserId: 'u-1',
          uploadRefs: [expiring.id],
          now: T0 + UPLOAD_SESSION_TTL_MS + 1,
        }),
      ),
    ).toBe('upload-not-claimable')
    const foreign = await put(store, { actorUserId: 'u-2' })
    for (const ref of [foreign.id, 'no-such-ref']) {
      expect(
        await codeOf(() =>
          store.claimUploads({
            missionId: mission,
            actorUserId: 'u-1',
            uploadRefs: [ref],
            now: T0,
          }),
        ),
      ).toBe('upload-not-found')
    }
  })

  test('sweepExpired 只清过期的 pending 行，且受 limit 约束', async () => {
    const store = createUploadSessionPersistence(harness.db)
    const mission = await newMission(harness.db)
    const fresh = await put(store, { now: T0 + UPLOAD_SESSION_TTL_MS })
    const stale = await put(store, { now: T0 })
    const staleToo = await put(store, { now: T0 + 1 })
    const claimedStale = await put(store, { now: T0 })
    await store.claimUploads({
      missionId: mission,
      actorUserId: 'u-1',
      uploadRefs: [claimedStale.id],
      now: T0,
    })
    expect(await store.sweepExpired(T0 + UPLOAD_SESSION_TTL_MS + 2, 1)).toBe(1)
    expect(await store.sweepExpired(T0 + UPLOAD_SESSION_TTL_MS + 2)).toBe(1)
    expect(await store.sweepExpired(T0 + UPLOAD_SESSION_TTL_MS + 2)).toBe(0)
    expect(await store.getUpload(stale.id)).toBeNull()
    expect(await store.getUpload(staleToo.id)).toBeNull()
    expect(await store.getUpload(fresh.id)).not.toBeNull()
    expect((await store.getUpload(claimedStale.id))?.state).toBe('claimed')
  })

  test('insertUploadPlan 落 plan + 有序 entries，expectedTarget 投影完整', async () => {
    const mission = await newMission(harness.db)
    const planId = `plan-${mission}`
    await insertUploadPlan(harness.db, {
      planId,
      missionId: mission,
      missionRevision: 0,
      repositoryId: 'repo-1',
      baselineSnapshotRef: `git:${'f'.repeat(40)}`,
      baselineSha: 'f'.repeat(40),
      planDigest: 'd'.repeat(64),
      createdAt: T0,
      entries: [
        {
          ordinal: 0,
          fileId: 'up-1',
          uploadBlobRef: 'a'.repeat(64),
          uploadSha256: 'a'.repeat(64),
          repositoryTargetPath: 'docs/a.md',
          contentPolicy: 'preserve-upload',
          targetFileMode: 'regular',
          expectedTarget: { kind: 'absent' },
        },
        {
          ordinal: 1,
          fileId: 'up-2',
          uploadBlobRef: 'b'.repeat(64),
          uploadSha256: 'b'.repeat(64),
          repositoryTargetPath: 'docs/b.md',
          contentPolicy: 'agent-editable',
          targetFileMode: 'executable',
          expectedTarget: { kind: 'exact-file', sha256: 'c'.repeat(64), fileMode: 'regular' },
        },
      ],
    })
    const plan = (
      await harness.db
        .select()
        .from(developmentRepositoryUploadPlans)
        .where(eq(developmentRepositoryUploadPlans.id, planId))
    )[0]
    expect(plan?.planDigest).toBe('d'.repeat(64))
    const entries = (
      await harness.db
        .select()
        .from(developmentRepositoryUploadPlanEntries)
        .where(eq(developmentRepositoryUploadPlanEntries.planId, planId))
    ).sort((a, b) => a.ordinal - b.ordinal)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ expectedTargetKind: 'absent', expectedTargetSha256: null })
    expect(entries[1]).toMatchObject({
      expectedTargetKind: 'exact-file',
      expectedTargetSha256: 'c'.repeat(64),
      expectedTargetFileMode: 'regular',
    })
  })
})

describeEachProvider('RFC-359 W4-D11 —— Playbook saga 持久化', (harness) => {
  test('step run：按 (mission, employee, revision, step, attempt, digest) 幂等认领；状态机 CAS；按 action 回查', async () => {
    const saga = createPlaybookSagaPersistence(harness.db)
    const missionId = await newMission(harness.db)
    const key = {
      missionId,
      employeeId: 'emp-1',
      employeeRevision: 1,
      stepId: 'implement',
      attempt: 0,
      inputDigest: 'i'.repeat(64),
      producerKind: 'agent',
      deadlineAt: null,
      now: T0,
    }
    const first = await saga.claimStepRun({ ...key, id: `run-a-${missionId}` })
    expect(first).toMatchObject({
      created: true,
      row: { id: `run-a-${missionId}`, state: 'claimed' },
    })
    const replay = await saga.claimStepRun({ ...key, id: `run-b-${missionId}`, now: T0 + 5 })
    expect(replay).toMatchObject({ created: false, row: { id: `run-a-${missionId}` } })
    const second = await saga.claimStepRun({
      ...key,
      id: `run-c-${missionId}`,
      attempt: 1,
      now: T0 + 1,
    })
    expect(second.created).toBe(true)
    expect((await saga.listStepRuns(missionId)).map((run) => run.id)).toEqual([
      `run-a-${missionId}`,
      `run-c-${missionId}`,
    ])

    expect(
      await saga.updateStepRun({
        id: `run-a-${missionId}`,
        from: ['claimed'],
        state: 'running',
        actionRunId: `action-${missionId}`,
        decisionId: 'dec-1',
        now: T0 + 2,
      }),
    ).toBe(true)
    expect((await saga.findStepRunByAction(`action-${missionId}`))?.id).toBe(`run-a-${missionId}`)
    // 当前态不在 from 里 → 拒绝；终态不可回退 → 拒绝；不存在 → 拒绝。
    expect(
      await saga.updateStepRun({
        id: `run-a-${missionId}`,
        from: ['claimed'],
        state: 'waiting',
        now: T0 + 3,
      }),
    ).toBe(false)
    expect(
      await saga.updateStepRun({
        id: `run-a-${missionId}`,
        from: ['running'],
        state: 'succeeded',
        outputRef: 'out-1',
        outputRevision: '1',
        now: T0 + 4,
      }),
    ).toBe(true)
    expect(
      await saga.updateStepRun({
        id: `run-a-${missionId}`,
        from: ['succeeded'],
        state: 'running',
        now: T0 + 5,
      }),
    ).toBe(false)
    expect(
      await saga.updateStepRun({ id: 'missing', from: ['claimed'], state: 'running', now: T0 }),
    ).toBe(false)
    expect(await saga.getStepRun(`run-a-${missionId}`)).toMatchObject({
      state: 'succeeded',
      outputRef: 'out-1',
      outputRevision: '1',
      decisionId: 'dec-1',
      updatedAt: T0 + 4,
    })
  })

  test('mission link：按 idempotencyKey 幂等；observe 回填子 mission / 满足态；按子 mission 反查', async () => {
    const saga = createPlaybookSagaPersistence(harness.db)
    const parent = await newMission(harness.db)
    const child = await newMission(harness.db)
    const step = await saga.claimStepRun({
      id: `step-${parent}`,
      missionId: parent,
      employeeId: 'emp-1',
      employeeRevision: 1,
      stepId: 'delegate',
      attempt: 0,
      inputDigest: 'i'.repeat(64),
      producerKind: 'child-mission',
      deadlineAt: null,
      now: T0,
    })
    const input = {
      parentMissionId: parent,
      parentStepRunId: step.row.id,
      targetRepositoryId: 'repo-2',
      targetEmployeeId: 'emp-2',
      targetEmployeeRevision: 3,
      inputDigest: 'j'.repeat(64),
      idempotencyKey: `link-${parent}`,
      completion: 'merged' as const,
      now: T0,
    }
    const link = await saga.claimMissionLink({ ...input, id: `link-a-${parent}` })
    expect(link).toMatchObject({
      created: true,
      row: {
        state: 'creating',
        completion: 'merged',
        completionSatisfied: false,
        childMissionId: null,
      },
    })
    expect(await saga.claimMissionLink({ ...input, id: `link-b-${parent}` })).toMatchObject({
      created: false,
      row: { id: `link-a-${parent}` },
    })
    await saga.observeMissionLink({
      id: `link-a-${parent}`,
      childMissionId: child,
      childRevision: 2,
      status: 'working',
      completionSatisfied: false,
      outputRef: null,
      observedAt: T0 + 1,
    })
    expect(await saga.findParentMissionLink(child)).toMatchObject({
      id: `link-a-${parent}`,
      state: 'observing',
      latestChildRevision: 2,
      latestStatus: 'working',
      completionSatisfied: false,
    })
    await saga.observeMissionLink({
      id: `link-a-${parent}`,
      childMissionId: child,
      childRevision: 5,
      status: 'merged',
      completionSatisfied: true,
      outputRef: 'out-child',
      observedAt: T0 + 2,
    })
    expect(await saga.getMissionLinkByStepRun(step.row.id)).toMatchObject({
      state: 'satisfied',
      completionSatisfied: true,
      outputRef: 'out-child',
      observedAt: T0 + 2,
    })
    expect((await saga.listMissionLinks(parent)).map((row) => row.id)).toEqual([`link-a-${parent}`])
  })

  test('approval saga：按 idempotencyKey 幂等；submitted → pending；每次观测 attemptOrdinal +1，终态落 settled', async () => {
    const saga = createPlaybookSagaPersistence(harness.db)
    const missionId = await newMission(harness.db)
    const step = await saga.claimStepRun({
      id: `step-${missionId}`,
      missionId,
      employeeId: 'emp-1',
      employeeRevision: 1,
      stepId: 'approve',
      attempt: 0,
      inputDigest: 'i'.repeat(64),
      producerKind: 'approval',
      deadlineAt: null,
      now: T0,
    })
    const input = {
      missionId,
      stepRunId: step.row.id,
      adapterId: 'adapter-1',
      adapterRevision: 2,
      draftRef: 'draft-1',
      submitIntentDigest: 's'.repeat(64),
      idempotencyKey: `approval-${missionId}`,
      deadlineAt: T0 + 60_000,
      now: T0,
    }
    const approval = await saga.claimApprovalSaga({ ...input, id: `ap-a-${missionId}` })
    expect(approval).toMatchObject({
      created: true,
      row: { latestStatus: 'submitting', attemptOrdinal: 0, correlationRef: null },
    })
    expect(await saga.claimApprovalSaga({ ...input, id: `ap-b-${missionId}` })).toMatchObject({
      created: false,
      row: { id: `ap-a-${missionId}` },
    })
    await saga.recordApprovalSubmitted({
      id: `ap-a-${missionId}`,
      correlationRef: 'corr-1',
      externalRequestRef: 'ext-1',
      submittedRevision: 'r1',
      now: T0 + 1,
    })
    expect(await saga.getApprovalSagaByStepRun(step.row.id)).toMatchObject({
      latestStatus: 'pending',
      correlationRef: 'corr-1',
      externalRequestRef: 'ext-1',
      submittedRevision: 'r1',
    })
    await saga.recordApprovalObservation({
      id: `ap-a-${missionId}`,
      status: 'pending',
      observedRevision: 'r1',
      evidenceRef: null,
      nextObserveAt: T0 + 10,
      now: T0 + 2,
    })
    await saga.recordApprovalObservation({
      id: `ap-a-${missionId}`,
      status: 'approved',
      observedRevision: 'r2',
      evidenceRef: 'evidence-1',
      nextObserveAt: null,
      now: T0 + 3,
    })
    expect(await saga.getApprovalSaga(`ap-a-${missionId}`)).toMatchObject({
      latestStatus: 'approved',
      attemptOrdinal: 2,
      observedRevision: 'r2',
      evidenceRef: 'evidence-1',
      nextObserveAt: null,
      updatedAt: T0 + 3,
    })
    expect((await saga.listApprovalSagas(missionId)).map((row) => row.id)).toEqual([
      `ap-a-${missionId}`,
    ])
  })

  test('step join：同 (mission, group, member) 覆盖更新；成员按 stepId 排序；settleJoin 写全组；digest 随 saga 变化', async () => {
    const saga = createPlaybookSagaPersistence(harness.db)
    const missionId = await newMission(harness.db)
    const member = (memberStepId: string, memberState: 'pending' | 'succeeded' | 'failed') => ({
      missionId,
      groupId: 'checks',
      memberStepId,
      mode: 'all' as const,
      quorum: null,
      deadlineAt: T0 + 60_000,
      memberState,
      receiptRevision: memberState === 'pending' ? null : `rev-${memberStepId}`,
      settledResult: null,
      now: T0,
    })
    const before = await saga.sagaDigest(missionId)
    expect(before).toMatch(/^[0-9a-f]{64}$/)
    expect(await saga.sagaDigest(missionId)).toBe(before)
    await saga.upsertJoinMember(member('lint', 'pending'))
    await saga.upsertJoinMember(member('build', 'pending'))
    await saga.upsertJoinMember({ ...member('lint', 'succeeded'), now: T0 + 1 })
    expect(await saga.listJoinMembers(missionId, 'checks')).toMatchObject([
      { memberStepId: 'build', memberState: 'pending', receiptRevision: null },
      { memberStepId: 'lint', memberState: 'succeeded', receiptRevision: 'rev-lint' },
    ])
    await saga.settleJoin(missionId, 'checks', 'satisfied', T0 + 2)
    expect(
      (await saga.listJoinMembers(missionId, 'checks')).map((row) => row.settledResult),
    ).toEqual(['satisfied', 'satisfied'])
    expect(await saga.listJoinMembers(missionId, 'other')).toEqual([])
    // digest 只看 step run / link / approval：join 不影响，认领一个 step run 才变。
    expect(await saga.sagaDigest(missionId)).toBe(before)
    await saga.claimStepRun({
      id: `run-${missionId}`,
      missionId,
      employeeId: 'emp-1',
      employeeRevision: 1,
      stepId: 'implement',
      attempt: 0,
      inputDigest: 'i'.repeat(64),
      producerKind: 'agent',
      deadlineAt: null,
      now: T0,
    })
    expect(await saga.sagaDigest(missionId)).not.toBe(before)
  })
})

test('源码锁：saga / 上传会话持久化不再有 provider 专属文件；launch 事务复用唯一的认领原语', () => {
  const infra = join(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'development-automation',
    'infrastructure',
  )
  for (const retired of [
    'sqlitePlaybookSagaStore.ts',
    'postgresqlPlaybookSagaStore.ts',
    'sqliteUploadSessionStore.ts',
  ]) {
    expect(existsSync(join(infra, retired))).toBe(false)
  }
  for (const neutral of [
    'playbookSagaStore.ts',
    'uploadSessionStore.ts',
    'missionInputUploadPersistence.ts',
  ]) {
    const source = readFileSync(join(infra, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|for update/i)
    expect(source).toContain('ProviderNeutralDatabase')
  }
  const missionStore = readFileSync(join(infra, 'missionStore.ts'), 'utf8')
  expect(missionStore).toContain('claimUploadSessions(tx, {')
  expect(missionStore).not.toContain("'upload-already-claimed'")
})
