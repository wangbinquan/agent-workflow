// RFC-359 W4-D13 —— development-automation 最后三个 provider 对合一后的双引擎锁：数字员工平台工作项持久化
// （审批 saga / change candidate / case workspace）、交付面的仓库 / MR 事实目录、旧 Mission 排空视图。
// 同一段断言在两个引擎上各跑一遍；源码锁钉住「不再有 provider 命名的孪生」。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  employeeCases,
  employeeCaseWorkspaces,
  employeeReactionRounds,
  employeeRoundWorkspaceStates,
} from '@/db/schema'
import type { PipelineEvidenceExecution } from '@/modules/integration/infrastructure/developmentPipelineAdapter'
import type { MissionRow } from '@/modules/development-automation/application/ports/missionStore'
import { createLegacyMissionDrainPort } from '@/modules/development-automation/composition/legacyMissionDrain'
import { createDevelopmentDeliveryProvider } from '@/modules/development-automation/infrastructure/developmentDeliveryProvider'
import { createEmployeePlatformWorkItemPersistence } from '@/modules/development-automation/infrastructure/employeePlatformWorkItemPersistence'
import { createMissionPersistence } from '@/modules/development-automation/infrastructure/missionStore'
import { createPlaybookSagaPersistence } from '@/modules/development-automation/infrastructure/playbookSagaStore'
import type { CodeHostConnectionsService } from '@/services/codeHost/connections'
import { rememberVolatileRepoUrl, sealRepoUrl } from '@/services/repoCredentials'
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

async function newMission(
  db: ProviderNeutralDatabase,
  overrides: Partial<MissionRow> = {},
): Promise<string> {
  const row = missionRow(overrides)
  await createMissionPersistence(db).createMission(row)
  return row.id
}

async function seedRepo(
  db: ProviderNeutralDatabase,
  urlEnc: string | null = null,
): Promise<string> {
  const id = ulid()
  await db.insert(cachedRepos).values({
    id,
    urlHash: id.slice(-8).toLowerCase(),
    urlEnc,
    localPath: `/tmp/aw-repos/${id}`,
    defaultBranch: 'main',
    lastFetchedAt: T0,
    createdAt: T0,
  })
  return id
}

async function seedCaseAndRound(
  db: ProviderNeutralDatabase,
): Promise<{ caseId: string; roundId: string }> {
  const caseId = ulid()
  const roundId = ulid()
  await db.insert(employeeCases).values({
    id: caseId,
    employeeId: 'emp-1',
    employeeRevision: 1,
    typeId: 'type-1',
    typeRevision: 1,
    primaryContextId: `ctx-${caseId}`,
    executionPolicyRevision: 1,
    createdAt: T0,
    updatedAt: T0,
  })
  await db.insert(employeeReactionRounds).values({
    id: roundId,
    caseId,
    caseRevision: 1,
    employeeId: 'emp-1',
    employeeRevision: 1,
    ruleId: 'rule-1',
    workItemRef: 'work-1',
    workContractId: 'contract-1',
    workContractVersion: 1,
    executionPolicyRevision: 1,
    inputContextRefsJson: '[]',
    planJson: '{}',
    createdAt: T0,
    updatedAt: T0,
  })
  return { caseId, roundId }
}

describeEachProvider('RFC-359 W4-D13 —— 数字员工平台工作项持久化', (harness) => {
  test('workspace：按 case 读并带仓库本地路径；仓库行缺失 / workspace 缺失都回 null；head 更新', async () => {
    const persistence = createEmployeePlatformWorkItemPersistence(harness.db)
    const { caseId } = await seedCaseAndRound(harness.db)
    const { caseId: orphan } = await seedCaseAndRound(harness.db)
    const repoId = await seedRepo(harness.db)
    for (const [id, cachedRepoId] of [
      [caseId, repoId],
      [orphan, 'repo-missing'],
    ] as const) {
      await harness.db.insert(employeeCaseWorkspaces).values({
        caseId: id,
        repositoryId: 'repo-1',
        cachedRepoId,
        baselineSha: 'a'.repeat(40),
        targetBranch: 'main',
        sourceBranch: `aw/${id}`,
        createdAt: T0,
        updatedAt: T0,
      })
    }
    expect(await persistence.currentWorkspace(caseId)).toMatchObject({
      repositoryLocalPath: `/tmp/aw-repos/${repoId}`,
      row: { caseId, state: 'active', remoteHeadSha: null },
    })
    expect(await persistence.currentWorkspace(orphan)).toBeNull()
    expect(await persistence.currentWorkspace('missing')).toBeNull()
    await persistence.updateWorkspaceHead({
      caseId,
      baselineSha: 'b'.repeat(40),
      remoteHeadSha: 'c'.repeat(40),
      updatedAt: T0 + 1,
    })
    expect((await persistence.currentWorkspace(caseId))?.row).toMatchObject({
      baselineSha: 'b'.repeat(40),
      remoteHeadSha: 'c'.repeat(40),
      state: 'published',
      updatedAt: T0 + 1,
    })
  })

  test('审批 saga：按 idempotencyKey 幂等准备（重放不覆盖）；提交 → pending；观测落状态与证据', async () => {
    const persistence = createEmployeePlatformWorkItemPersistence(harness.db)
    const { caseId, roundId } = await seedCaseAndRound(harness.db)
    const input = {
      id: `saga-${caseId}`,
      caseId,
      submitRoundId: roundId,
      adapterId: 'adapter-1',
      adapterRevision: 2,
      validatedDraftRef: 'draft-1',
      intentDigest: 'i'.repeat(64),
      deadlineAt: '2026-01-02T00:00:00.000Z',
      idempotencyKey: `key-${caseId}`,
      correlationRef: null,
      externalRequestRef: null,
      submittedRevision: null,
      submittedAt: null,
      latestStatus: 'prepared' as const,
      observedRevision: null,
      evidenceRef: null,
      observedAt: null,
      createdAt: T0,
      updatedAt: T0,
    }
    expect(await persistence.prepareApprovalSaga(input)).toMatchObject({
      caseId,
      latestStatus: 'prepared',
      adapterRevision: 2,
    })
    expect(
      await persistence.prepareApprovalSaga({
        ...input,
        id: `saga-b-${caseId}`,
        adapterRevision: 9,
      }),
    ).toMatchObject({ adapterRevision: 2 })
    await persistence.recordApprovalSubmission({
      idempotencyKey: input.idempotencyKey,
      correlationRef: 'corr-1',
      externalRequestRef: 'ext-1',
      submittedRevision: 'r1',
      submittedAt: '2026-01-01T00:00:01.000Z',
      updatedAt: T0 + 1,
    })
    expect(await persistence.approvalSaga(input.idempotencyKey)).toMatchObject({
      latestStatus: 'pending',
      correlationRef: 'corr-1',
      externalRequestRef: 'ext-1',
      submittedRevision: 'r1',
    })
    await persistence.recordApprovalObservation({
      idempotencyKey: input.idempotencyKey,
      latestStatus: 'approved',
      observedRevision: 'r2',
      evidenceRef: 'evidence-1',
      observedAt: '2026-01-01T00:00:02.000Z',
      updatedAt: T0 + 2,
    })
    expect(await persistence.approvalSaga(input.idempotencyKey)).toMatchObject({
      latestStatus: 'approved',
      observedRevision: 'r2',
      evidenceRef: 'evidence-1',
    })
    expect(await persistence.approvalSaga('missing')).toBeNull()
  })

  test('change candidate：insert 幂等；commit → committed；publish 一笔事务同时改 candidate 与 workspace；轮次校验取最高 attempt', async () => {
    const persistence = createEmployeePlatformWorkItemPersistence(harness.db)
    const { caseId, roundId } = await seedCaseAndRound(harness.db)
    const repoId = await seedRepo(harness.db)
    await harness.db.insert(employeeCaseWorkspaces).values({
      caseId,
      repositoryId: 'repo-1',
      cachedRepoId: repoId,
      baselineSha: 'a'.repeat(40),
      targetBranch: 'main',
      sourceBranch: `aw/${caseId}`,
      createdAt: T0,
      updatedAt: T0,
    })
    const candidateRef = `cand-${caseId}`
    const candidate = {
      candidateRef,
      caseId,
      roundId,
      baselineSha: 'a'.repeat(40),
      treeOid: 't'.repeat(40),
      receiptJson: '{"files":1}',
      summarySource: 'agent',
      createdAt: T0,
      updatedAt: T0,
    }
    await persistence.insertCandidate(candidate)
    await persistence.insertCandidate({ ...candidate, treeOid: 'u'.repeat(40) })
    expect(await persistence.candidate(candidateRef)).toMatchObject({
      state: 'prepared',
      treeOid: 't'.repeat(40),
      commitSha: null,
    })
    await persistence.recordCandidateCommit({
      candidateRef,
      commitSha: 'c'.repeat(40),
      updatedAt: T0 + 1,
    })
    expect(await persistence.candidate(candidateRef)).toMatchObject({
      state: 'committed',
      commitSha: 'c'.repeat(40),
    })
    await persistence.publishCandidateAndWorkspace({
      candidateRef,
      caseId,
      commitSha: 'd'.repeat(40),
      pushReceiptJson: '{"pushed":true}',
      updatedAt: T0 + 2,
    })
    expect(await persistence.candidate(candidateRef)).toMatchObject({
      state: 'published',
      commitSha: 'd'.repeat(40),
    })
    expect((await persistence.currentWorkspace(caseId))?.row).toMatchObject({
      baselineSha: 'd'.repeat(40),
      remoteHeadSha: 'd'.repeat(40),
      state: 'published',
      updatedAt: T0 + 2,
    })
    expect(await persistence.candidate('missing')).toBeNull()

    expect(await persistence.latestRoundValidation(roundId)).toBeNull()
    for (const [attemptOrdinal, validationJson] of [
      [0, '{"ok":false}'],
      [2, '{"ok":true}'],
      [1, null],
    ] as const) {
      await harness.db.insert(employeeRoundWorkspaceStates).values({
        roundId,
        attemptOrdinal,
        caseId,
        baselineSha: 'a'.repeat(40),
        preStateJson: '{}',
        checkpointDigest: 'k'.repeat(64),
        validationJson,
        createdAt: T0,
        updatedAt: T0,
      })
    }
    expect(await persistence.latestRoundValidation(roundId)).toBe('{"ok":true}')
  })
})

describeEachProvider('RFC-359 W4-D13 —— 交付目录 / 旧 Mission 排空视图', (harness) => {
  test('仓库解析：未缓存 → null；无密文靠本进程 volatile URL；密文由 SecretBox 解封并带默认分支；MR 事实目标经 claim 连接', async () => {
    const box = createSecretBoxFromKey(Buffer.alloc(32, 7))
    const provider = createDevelopmentDeliveryProvider({
      db: harness.db,
      secretBox: box,
      connections: { resolve: async () => null } as unknown as CodeHostConnectionsService,
      pipeline: {} as PipelineEvidenceExecution,
    })
    expect(await provider.resolveRepository('missing')).toBeNull()
    const bare = await seedRepo(harness.db)
    expect(await provider.resolveRepository(bare)).toBeNull()
    rememberVolatileRepoUrl(harness.db, bare, 'https://volatile.example/repo.git')
    expect(await provider.resolveRepository(bare)).toEqual({
      remoteUrl: 'https://volatile.example/repo.git',
      defaultBranch: 'main',
    })
    const sealed = await seedRepo(
      harness.db,
      sealRepoUrl(box, 'https://token@sealed.example/repo.git'),
    )
    expect(await provider.resolveRepository(sealed)).toEqual({
      remoteUrl: 'https://token@sealed.example/repo.git',
      defaultBranch: 'main',
    })
    // 没有匹配的代码托管连接 → 绑定为 null（目录能解析 URL 不等于能交付）。
    expect(await provider.resolveBinding(sealed)).toBeNull()

    const missionId = await newMission(harness.db, { repositoryId: sealed })
    await createMissionPersistence(harness.db).claimMr({
      id: `claim-${missionId}`,
      codeHostEndpointRef: 'gitlab.example',
      stableProjectRef: 'group/app',
      mrIid: '17',
      missionId,
      epoch: 0,
      headSha: null,
      now: T0,
    })
    expect(await provider.readMrFactTarget({ missionId, mrClaimId: `claim-${missionId}` })).toEqual(
      {
        repositoryId: sealed,
        mrIid: '17',
      },
    )
    expect(await provider.readMrFactTarget({ missionId, mrClaimId: 'claim-other' })).toBeNull()
    expect(
      await provider.readMrFactTarget({ missionId: 'missing', mrClaimId: `claim-${missionId}` }),
    ).toBeNull()
  })

  test('旧 Mission 排空：只数未终态；报告按 (createdAt, id) 采样、如实标 truncated，计数只算 active claim / 未了结审批', async () => {
    const drain = createLegacyMissionDrainPort(harness.db)
    const store = createMissionPersistence(harness.db)
    const saga = createPlaybookSagaPersistence(harness.db)
    const before = await drain.openMissionCount()
    const first = await newMission(harness.db, { createdAt: T0 })
    const second = await newMission(harness.db, { createdAt: T0 + 1 })
    await newMission(harness.db, { createdAt: T0 + 2, status: 'merged', terminalAt: T0 + 3 })
    expect(await drain.openMissionCount()).toBe(before + 2)

    await store.claimMr({
      id: `claim-a-${first}`,
      codeHostEndpointRef: 'gitlab.example',
      stableProjectRef: 'group/app',
      mrIid: '1',
      missionId: first,
      epoch: 0,
      headSha: null,
      now: T0,
    })
    await store.claimMr({
      id: `claim-b-${first}`,
      codeHostEndpointRef: 'gitlab.example',
      stableProjectRef: 'group/app',
      mrIid: '2',
      missionId: first,
      epoch: 0,
      headSha: null,
      now: T0,
    })
    await store.releaseMr(`claim-b-${first}`, T0 + 1)
    const step = await saga.claimStepRun({
      id: `step-${first}`,
      missionId: first,
      employeeId: 'emp-1',
      employeeRevision: 1,
      stepId: 'approve',
      attempt: 0,
      inputDigest: 'i'.repeat(64),
      producerKind: 'approval',
      deadlineAt: null,
      now: T0,
    })
    await saga.claimMissionLink({
      id: `link-${first}`,
      parentMissionId: first,
      parentStepRunId: step.row.id,
      targetRepositoryId: 'repo-2',
      targetEmployeeId: 'emp-2',
      targetEmployeeRevision: 1,
      inputDigest: 'j'.repeat(64),
      idempotencyKey: `link-${first}`,
      completion: 'merged',
      now: T0,
    })
    const approval = {
      missionId: first,
      stepRunId: step.row.id,
      adapterId: 'adapter-1',
      adapterRevision: 1,
      draftRef: 'draft-1',
      submitIntentDigest: 's'.repeat(64),
      deadlineAt: T0 + 60_000,
      now: T0,
    }
    await saga.claimApprovalSaga({
      ...approval,
      id: `ap-pending-${first}`,
      idempotencyKey: `ap-1-${first}`,
    })
    await saga.claimApprovalSaga({
      ...approval,
      id: `ap-settled-${first}`,
      idempotencyKey: `ap-2-${first}`,
    })
    await saga.recordApprovalObservation({
      id: `ap-settled-${first}`,
      status: 'approved',
      observedRevision: 'r1',
      evidenceRef: null,
      nextObserveAt: null,
      now: T0 + 1,
    })

    const full = await drain.drainReport(100)
    expect(full.truncated).toBe(false)
    const entry = full.entries.find((row) => row.missionId === first)
    expect(entry).toEqual({
      missionId: first,
      status: 'working',
      activeMrClaimCount: 1,
      childLinkCount: 1,
      pendingApprovalCount: 1,
    })
    expect(full.entries.find((row) => row.missionId === second)).toMatchObject({
      activeMrClaimCount: 0,
      childLinkCount: 0,
      pendingApprovalCount: 0,
    })
    const ids = full.entries.map((row) => row.missionId)
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second))
    const truncated = await drain.drainReport(1)
    expect(truncated.truncated).toBe(true)
    expect(truncated.entries).toHaveLength(1)
  })
})

test('源码锁：development-automation 的持久化与装配不再有 provider 命名的孪生', () => {
  const root = join(import.meta.dir, '..', 'src', 'modules', 'development-automation')
  for (const file of [
    'infrastructure/employeePlatformWorkItemPersistence.ts',
    'infrastructure/developmentDeliveryProvider.ts',
    'composition/legacyMissionDrain.ts',
    'composition/digitalEmployeeWorkspace.ts',
    'composition/digitalEmployeePlatformWorkItems.ts',
  ]) {
    const source = readFileSync(join(root, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source, file).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|dbTxSync/)
    expect(source, file).toContain('ProviderNeutralDatabase')
    expect(source, file).not.toMatch(/\b(?:create|compose)(?:Sqlite|Postgresql)[A-Za-z]+\(/)
  }
})
