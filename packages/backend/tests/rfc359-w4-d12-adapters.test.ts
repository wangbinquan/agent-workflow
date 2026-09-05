// RFC-359 W4-D12 —— development-automation 剩余的六个 provider 对合一后的双引擎锁：上传 placement 读写、publication
// receipt、requirement bundle 指针行、仓库位置读取、保留期清扫，以及三组 sqlite / postgresql 装配对的收口。
// 同一段断言在两个引擎上各跑一遍；源码锁钉住「不再有 provider 命名的孪生」。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  developmentBundleRefs,
  developmentRepositoryUploadReceipts,
} from '@/db/schema'
import type { MissionRow } from '@/modules/development-automation/application/ports/missionStore'
import type { RequirementBundleRefRecord } from '@/modules/development-automation/application/ports/requirementBundleRefStore'
import { defaultAutomationPolicyContent } from '@/modules/development-automation/domain/automationPolicy'
import { createRepositoryLocationRead } from '@/modules/development-automation/infrastructure/gitBaselineReader'
import { createMissionPersistence } from '@/modules/development-automation/infrastructure/missionStore'
import { createRequirementBundleRefPersistence } from '@/modules/development-automation/infrastructure/requirementBundleRefPersistence'
import {
  RETENTION_DAY_MS,
  sweepDevelopmentRetention,
  type RetentionPolicyReader,
} from '@/modules/development-automation/infrastructure/retentionSweeper'
import { createUploadPlacementPersistence } from '@/modules/development-automation/infrastructure/uploadPlacementPersistence'
import { insertUploadPlan } from '@/modules/development-automation/infrastructure/uploadPlanStore'
import {
  hasUploadPublicationReceipt,
  recordUploadPublicationReceipt,
} from '@/modules/development-automation/infrastructure/uploadPublicationReceipt'
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

async function plantPlan(db: ProviderNeutralDatabase, missionId: string): Promise<string> {
  const planId = `plan-${missionId}`
  await insertUploadPlan(db, {
    planId,
    missionId,
    missionRevision: 0,
    repositoryId: 'repo-1',
    baselineSnapshotRef: `git:${'f'.repeat(40)}`,
    baselineSha: 'f'.repeat(40),
    planDigest: 'd'.repeat(64),
    createdAt: T0,
    entries: [
      {
        ordinal: 1,
        fileId: 'up-2',
        uploadBlobRef: 'b'.repeat(64),
        uploadSha256: 'b'.repeat(64),
        repositoryTargetPath: 'docs/b.md',
        contentPolicy: 'agent-editable',
        targetFileMode: 'regular',
        expectedTarget: { kind: 'absent' },
      },
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
    ],
  })
  return planId
}

function bundleRef(
  missionId: string,
  overrides: Partial<RequirementBundleRefRecord> = {},
): RequirementBundleRefRecord {
  return {
    id: ulid(),
    missionId,
    purpose: 'requirement-bundle',
    evidenceRef: `evidence-${ulid()}`,
    manifestDigest: 'm'.repeat(64),
    fileCount: 2,
    totalBytes: 100,
    retentionState: 'active',
    createdAt: T0,
    ...overrides,
  }
}

describeEachProvider('RFC-359 W4-D12 —— 上传 placement / publication receipt', (harness) => {
  test('load 按 ordinal 回 entries；record 按 (plan, baseline, kind) 幂等，placement receipt 只落一行', async () => {
    const placement = createUploadPlacementPersistence(harness.db)
    const missionId = await newMission(harness.db)
    const planId = await plantPlan(harness.db, missionId)
    expect(await placement.load('missing')).toBeNull()
    const before = (await placement.load(planId))!
    expect(before.entries.map((entry) => entry.repositoryTargetPath)).toEqual([
      'docs/a.md',
      'docs/b.md',
    ])
    expect(before).toMatchObject({ planDigest: 'd'.repeat(64), placementReceipt: null })
    const receipt = {
      planId,
      baselineSnapshotRef: `git:${'f'.repeat(40)}`,
      seedChangeRef: null,
      seedTreeDigest: 't'.repeat(64),
      fulfillmentKind: null,
      commitSha: null,
      entriesJson: '[]',
      createdAt: T0,
    }
    await placement.record({ ...receipt, id: `pr-1-${missionId}` })
    await placement.record({ ...receipt, id: `pr-2-${missionId}`, seedTreeDigest: 'u'.repeat(64) })
    expect((await placement.load(planId))?.placementReceipt).toEqual({
      seedTreeDigest: 't'.repeat(64),
    })
    expect(
      await harness.db
        .select({ id: developmentRepositoryUploadReceipts.id })
        .from(developmentRepositoryUploadReceipts)
        .where(eq(developmentRepositoryUploadReceipts.planId, planId)),
    ).toEqual([{ id: `pr-1-${missionId}` }])
  })

  test('publication receipt：首次落行；同 baseline 重放幂等；新 baseline 另记一行；placement 行不算 publication', async () => {
    const missionId = await newMission(harness.db)
    const planId = await plantPlan(harness.db, missionId)
    await createUploadPlacementPersistence(harness.db).record({
      id: `pr-${missionId}`,
      planId,
      baselineSnapshotRef: `git:${'a'.repeat(40)}`,
      seedChangeRef: null,
      seedTreeDigest: 't'.repeat(64),
      fulfillmentKind: null,
      commitSha: null,
      entriesJson: '[]',
      createdAt: T0,
    })
    expect(await hasUploadPublicationReceipt(harness.db, planId)).toBe(false)
    const publish = (baseline: string, commit: string) =>
      recordUploadPublicationReceipt(harness.db, {
        planId,
        baselineSnapshotRef: `git:${baseline.repeat(40)}`,
        commitSha: commit.repeat(40),
        seedChangeRef: 'p'.repeat(64),
        seedTreeDigest: 's'.repeat(64),
        entries: [{ targetPath: 'docs/a.md', sha256: 'b'.repeat(64) }],
        now: T0,
      })
    const first = await publish('a', 'c')
    expect(first.created).toBe(true)
    expect(await hasUploadPublicationReceipt(harness.db, planId)).toBe(true)
    expect(await publish('a', 'c')).toEqual({ created: false, receiptId: first.receiptId })
    const rebased = await publish('d', 'e')
    expect(rebased.created).toBe(true)
    expect(rebased.receiptId).not.toBe(first.receiptId)
  })
})

describeEachProvider('RFC-359 W4-D12 —— bundle 指针 / 仓库位置 / 保留期清扫', (harness) => {
  test('bundle 指针：insert / get / latest 按 (createdAt, id) 逆序 / findManifest / copyLatestRequirements 只复制有行的 purpose', async () => {
    const refs = createRequirementBundleRefPersistence(harness.db)
    const from = await newMission(harness.db)
    const to = await newMission(harness.db)
    const older = bundleRef(from, { createdAt: T0 })
    const newer = bundleRef(from, { createdAt: T0 + 1, manifestDigest: 'n'.repeat(64) })
    const manifest = bundleRef(from, {
      purpose: 'requirement-manifest',
      manifestDigest: 'x'.repeat(64),
    })
    for (const record of [older, newer, manifest]) await refs.insert(record)
    expect(await refs.get(older.id)).toEqual(older)
    expect(await refs.get('missing')).toBeNull()
    expect((await refs.latest(from, 'requirement-bundle'))?.id).toBe(newer.id)
    expect(await refs.latest(from, 'answer-set')).toBeNull()
    expect((await refs.findManifest(from, 'x'.repeat(64)))?.id).toBe(manifest.id)
    expect(await refs.findManifest(from, 'y'.repeat(64))).toBeNull()
    expect(
      await refs.copyLatestRequirements({
        fromMissionId: from,
        toMissionId: to,
        copies: [
          { id: `copy-bundle-${to}`, purpose: 'requirement-bundle' },
          { id: `copy-manifest-${to}`, purpose: 'requirement-manifest' },
          { id: `copy-direct-${to}`, purpose: 'direct-submission' },
        ],
        createdAt: T0 + 9,
      }),
    ).toBe(2)
    expect(await refs.get(`copy-bundle-${to}`)).toEqual({
      ...newer,
      id: `copy-bundle-${to}`,
      missionId: to,
      createdAt: T0 + 9,
    })
    expect(await refs.get(`copy-direct-${to}`)).toBeNull()
  })

  test('仓库位置读取：cached_repos 命中回 localPath，未缓存回 null', async () => {
    const id = ulid()
    await harness.db.insert(cachedRepos).values({
      id,
      urlHash: id.slice(0, 8).toLowerCase(),
      localPath: `/tmp/aw-repos/${id}`,
      lastFetchedAt: T0,
      createdAt: T0,
    })
    const read = createRepositoryLocationRead(harness.db)
    expect(await read.localPath(id)).toBe(`/tmp/aw-repos/${id}`)
    expect(await read.localPath('missing')).toBeNull()
  })

  test('保留期清扫：终态 Mission 超期后只删已结算 attempt、只标 active 指针；无策略 / 未终态不动；第二轮零增量', async () => {
    const store = createMissionPersistence(harness.db)
    const refs = createRequirementBundleRefPersistence(harness.db)
    const terminal = await newMission(harness.db, {
      status: 'merged',
      terminalKind: 'merged',
      terminalAt: T0,
      policyId: 'pol-1',
      policyRevision: 1,
    })
    const noPolicy = await newMission(harness.db, { status: 'merged', terminalAt: T0 })
    const live = await newMission(harness.db, { policyId: 'pol-1', policyRevision: 1 })
    for (const missionId of [terminal, noPolicy, live]) {
      await refs.insert(bundleRef(missionId))
      await store.createActionRun({
        id: `run-${missionId}`,
        missionId,
        missionRevision: 0,
        decisionId: `dec-${missionId}`,
        capabilityId: 'change.implement',
        capabilityContractVersion: 1,
        templateId: null,
        templateRevision: null,
        workSetDigest: null,
        inputFactDigest: 'e'.repeat(64),
        baselineRef: null,
        writable: false,
        now: T0,
      })
      for (const [seq, settle] of [
        [0, true],
        [1, false],
      ] as const) {
        await store.claimAttempt({
          id: `att-${seq}-${missionId}`,
          actionRunId: `run-${missionId}`,
          rerunSeq: 0,
          attemptSeq: seq,
          executionRef: `exec-${seq}-${missionId}`,
          baselineRef: 'base-1',
          nonceDigest: 'n'.repeat(64),
          inputDigest: 'g'.repeat(64),
          now: T0,
        })
        if (settle) {
          await store.settleAttempt({
            id: `att-${seq}-${missionId}`,
            status: 'rejected',
            rejectionJson: '{"code":"schema"}',
            outcomeRef: null,
            now: T0 + 1,
          })
        }
      }
    }
    await refs.insert(bundleRef(terminal, { retentionState: 'expired' }))
    const reader: RetentionPolicyReader = {
      async getPolicyRevisionContent(policyId) {
        if (policyId !== 'pol-1') return null
        const content = defaultAutomationPolicyContent()
        return {
          ...content,
          retention: {
            ...content.retention,
            requirementBundleTerminalTtlDays: 1,
            attemptLedgerTtlDays: 2,
          },
        }
      },
    }
    // 只过 bundle 的保留期（1 天 < age < 2 天）：标指针，不删 attempt。
    const firstSweep = await sweepDevelopmentRetention(
      harness.db,
      reader,
      T0 + RETENTION_DAY_MS * 1.5,
    )
    expect(firstSweep).toMatchObject({ prunedAttempts: 0, markedBundleRefs: 1 })
    expect(firstSweep.missionsScanned).toBeGreaterThanOrEqual(2)
    expect(firstSweep.expiredBundleRefsPending).toBeGreaterThanOrEqual(2)
    // 两个保留期都过：删已结算 attempt（在途的留下），指针已经标过不再重复。
    const secondSweep = await sweepDevelopmentRetention(
      harness.db,
      reader,
      T0 + RETENTION_DAY_MS * 3,
    )
    expect(secondSweep).toMatchObject({ prunedAttempts: 1, markedBundleRefs: 0 })
    expect((await store.listAttempts(`run-${terminal}`)).map((row) => row.id)).toEqual([
      `att-1-${terminal}`,
    ])
    expect(await store.listAttempts(`run-${noPolicy}`)).toHaveLength(2)
    expect(await store.listAttempts(`run-${live}`)).toHaveLength(2)
    expect(
      (
        await harness.db
          .select({ state: developmentBundleRefs.retentionState })
          .from(developmentBundleRefs)
          .where(eq(developmentBundleRefs.missionId, live))
      ).map((row) => row.state),
    ).toEqual(['active'])
    expect(
      await sweepDevelopmentRetention(harness.db, reader, T0 + RETENTION_DAY_MS * 3),
    ).toMatchObject({
      prunedAttempts: 0,
      markedBundleRefs: 0,
    })
    // limit 兜住单轮扫描规模。
    expect(
      (await sweepDevelopmentRetention(harness.db, reader, T0 + RETENTION_DAY_MS * 3, 1))
        .missionsScanned,
    ).toBe(1)
  })
})

test('源码锁：development-automation 不再有 provider 命名的持久化 / 装配孪生', () => {
  const root = join(import.meta.dir, '..', 'src', 'modules', 'development-automation')
  const neutral = [
    'infrastructure/uploadPlacementPersistence.ts',
    'infrastructure/uploadPublicationReceipt.ts',
    'infrastructure/requirementBundleRefPersistence.ts',
    'infrastructure/gitBaselineReader.ts',
    'infrastructure/repositoryFactsCollector.ts',
    'infrastructure/retentionSweeper.ts',
    'composition.ts',
    'composition/missionOperations.ts',
  ]
  for (const file of neutral) {
    const source = readFileSync(join(root, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source, file).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|dbTxSync/)
    expect(source, file).toContain('ProviderNeutralDatabase')
  }
  const composition = readFileSync(join(root, 'composition.ts'), 'utf8')
  for (const retired of [
    'composePostgresqlDevelopmentAutomation(',
    'composeSqliteDevelopmentAdmissionLookup',
    'composePostgresqlDevelopmentAdmissionLookup',
    'composePostgresqlDevelopmentAutomationMaintenanceCommands',
    'sweepPostgresqlDevelopmentRetention',
    'createPostgresqlRepositoryFactsCollector',
    'recordPostgresqlUploadPublicationReceipt',
  ]) {
    expect(composition, retired).not.toContain(retired)
  }
  expect(readFileSync(join(root, 'composition/missionOperations.ts'), 'utf8')).not.toContain(
    'composePostgresqlDevelopmentMissionOperations',
  )
})
