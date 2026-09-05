// RFC-359 W4-B5 批 c —— development-automation 三对合一（reconciler 读侧 / admission 查找 / 上传计划存储），
// 两个引擎各跑一遍：fence 与 prepared-effect 扫描、executionRef 反查、wake hint 去重、mission epoch 对拍；
// assignment 三级解析与已发布修订内容；上传计划在调用方事务里落 plan + 有序 entries、读回带 disposition 投影。

import { expect, test } from 'bun:test'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  automationPolicies,
  automationPolicyRevisions,
  developmentActionRuns,
  developmentAgentAttempts,
  developmentEffects,
  developmentFactSnapshots,
  developmentMissions,
  developmentWakeHints,
  digitalEmployeeRevisions,
  digitalEmployees,
  repositoryEmployeeAssignments,
} from '@/db/schema'
import { createAdmissionLookup } from '@/modules/development-automation/infrastructure/admissionLookup'
import {
  createFactSnapshotReader,
  listFencedMissionIds,
  listPreparedEffectRows,
  listUnconsumedWakeHintMissionIds,
  missionEpochsOf,
  missionIdOfExecutionRef,
} from '@/modules/development-automation/infrastructure/reconcilerReaders'
import {
  insertUploadPlan,
  readUploadPlan,
} from '@/modules/development-automation/infrastructure/uploadPlanStore'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

async function seedMission(
  db: ProviderNeutralDatabase,
  id: string,
  over: Partial<typeof developmentMissions.$inferInsert> = {},
): Promise<void> {
  await db.insert(developmentMissions).values({
    id,
    status: 'working',
    repositoryId: 'repo-1',
    sourceKind: 'direct',
    deliveryKind: 'create-merge-request',
    launchIdempotencyKey: `idem-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  })
}

describeEachProvider(
  'RFC-359 W4-B5c —— development-automation reconciler 读侧 / admission 查找 / 上传计划',
  (harness) => {
    test('reconciler 读侧：fence / prepared effect / epoch / executionRef 反查 / wake hint 去重', async () => {
      const db = harness.db
      await seedMission(db, 'm-a', { epoch: 3 })
      await seedMission(db, 'm-b', { epoch: 5, transitionFence: 'freezing' })
      await seedMission(db, 'm-c')

      const snapshots = createFactSnapshotReader(db)
      expect(await snapshots.getCells('missing')).toBeNull()
      await db.insert(developmentFactSnapshots).values({
        id: 'snap-1',
        missionId: 'm-a',
        missionRevision: 0,
        capturedAt: String(NOW),
        cellsJson: JSON.stringify({
          branch: { state: 'known', value: 'main', sourceRevision: 'rev-1' },
        }),
        refsJson: '[]',
        digest: 'dg',
        createdAt: NOW,
      })
      expect(await snapshots.getCells('snap-1')).toEqual({
        branch: { state: 'known', value: 'main', sourceRevision: 'rev-1' },
      })

      expect(await listFencedMissionIds(db)).toEqual(['m-b'])

      await db.insert(developmentEffects).values([
        {
          id: 'ef-1',
          missionId: 'm-a',
          effectKind: 'publish',
          intentDigest: 'i1',
          idempotencyKey: 'k1',
          epoch: 2,
          createdAt: NOW,
        },
        {
          id: 'ef-2',
          missionId: 'm-b',
          effectKind: 'publish',
          intentDigest: 'i2',
          idempotencyKey: 'k2',
          epoch: 5,
          state: 'applied',
          createdAt: NOW,
        },
      ])
      expect(await listPreparedEffectRows(db)).toEqual([{ id: 'ef-1', missionId: 'm-a', epoch: 2 }])
      expect(await missionEpochsOf(db, [])).toEqual(new Map())
      expect(await missionEpochsOf(db, ['m-a', 'm-b', 'nope'])).toEqual(
        new Map([
          ['m-a', 3],
          ['m-b', 5],
        ]),
      )

      await db.insert(developmentActionRuns).values({
        id: 'run-1',
        missionId: 'm-a',
        missionRevision: 0,
        decisionId: 'dec',
        capabilityId: 'cap',
        capabilityContractVersion: 1,
        inputFactDigest: 'f',
        status: 'running',
        createdAt: NOW,
      })
      await db.insert(developmentAgentAttempts).values({
        id: 'att-1',
        actionRunId: 'run-1',
        rerunSeq: 0,
        attemptSeq: 0,
        executionRef: 'exec-b5c',
        baselineRef: 'base',
        nonceDigest: 'c'.repeat(64),
        inputDigest: 'd'.repeat(64),
        status: 'running',
        createdAt: NOW,
      })
      expect(await missionIdOfExecutionRef(db, 'exec-b5c')).toBe('m-a')
      expect(await missionIdOfExecutionRef(db, 'exec-none')).toBeNull()

      await db.insert(developmentWakeHints).values([
        { id: 'wh-1', missionId: 'm-a', source: 'webhook', deliveryKey: 'k1', observedAt: NOW },
        { id: 'wh-2', missionId: 'm-a', source: 'webhook', deliveryKey: 'k2', observedAt: NOW },
        {
          id: 'wh-3',
          missionId: 'm-b',
          source: 'webhook',
          deliveryKey: 'k3',
          observedAt: NOW,
          consumedAt: NOW,
        },
      ])
      expect(await listUnconsumedWakeHintMissionIds(db)).toEqual(['m-a'])
    })

    test('admission 查找：assignment 三级解析 + 已发布修订内容', async () => {
      const db = harness.db
      const lookup = createAdmissionLookup(db)
      expect(
        await lookup.resolveAssignment({ repositoryId: 'repo-x', repositoryGroupId: null }),
      ).toBeNull()

      const resource = (id: string) => ({
        id,
        name: id,
        draftJson: '{}',
        publishedRevision: 1,
        ownerUserId: null,
        visibility: 'public' as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
      await db
        .insert(digitalEmployees)
        .values([resource('emp-1'), resource('emp-2'), resource('emp-3')])
      await db.insert(automationPolicies).values(resource('pol-1'))
      await db.insert(digitalEmployeeRevisions).values({
        employeeId: 'emp-1',
        revision: 1,
        contentJson: JSON.stringify({ name: 'emp-1', revision: 1 }),
        contentDigest: 'e1',
        publishedAt: NOW,
      })
      await db.insert(automationPolicyRevisions).values({
        policyId: 'pol-1',
        revision: 1,
        contentJson: JSON.stringify({ name: 'pol-1', maxAttempts: 3 }),
        contentDigest: 'p1',
        publishedAt: NOW,
      })
      const assignment = (
        id: string,
        scopeKind: 'repository' | 'repository-group' | 'global-default',
        scopeRef: string | null,
        employeeId: string,
      ) => ({
        id,
        scopeKind,
        scopeRef,
        employeeId,
        employeeRevision: 1,
        selectionPolicyId: 'pol-1',
        selectionPolicyRevision: 1,
        executionPolicyId: 'pol-1',
        executionPolicyRevision: 1,
        defaultRequirementSourceKey: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
      await db
        .insert(repositoryEmployeeAssignments)
        .values([
          assignment('as-global', 'global-default', null, 'emp-1'),
          assignment('as-group', 'repository-group', 'grp-1', 'emp-2'),
          assignment('as-repo', 'repository', 'repo-x', 'emp-3'),
        ])
      const view = (
        employeeId: string,
        scopeKind: 'repository' | 'repository-group' | 'global-default',
      ) => ({
        scopeKind,
        employeeId,
        employeeRevision: 1,
        selectionPolicyId: 'pol-1',
        selectionPolicyRevision: 1,
        executionPolicyId: 'pol-1',
        executionPolicyRevision: 1,
        defaultRequirementSourceKey: null,
      })
      expect(
        await lookup.resolveAssignment({ repositoryId: 'repo-x', repositoryGroupId: 'grp-1' }),
      ).toEqual(view('emp-3', 'repository'))
      expect(
        await lookup.resolveAssignment({ repositoryId: 'repo-y', repositoryGroupId: 'grp-1' }),
      ).toEqual(view('emp-2', 'repository-group'))
      expect(
        await lookup.resolveAssignment({ repositoryId: 'repo-y', repositoryGroupId: 'grp-none' }),
      ).toEqual(view('emp-1', 'global-default'))
      expect(
        await lookup.resolveAssignment({ repositoryId: 'repo-y', repositoryGroupId: null }),
      ).toEqual(view('emp-1', 'global-default'))

      expect(await lookup.getEmployeeRevisionContent('emp-1', 1)).toEqual({
        name: 'emp-1',
        revision: 1,
      })
      expect(await lookup.getEmployeeRevisionContent('emp-1', 2)).toBeNull()
      expect(await lookup.getPolicyRevisionContent('pol-1', 1)).toEqual({
        name: 'pol-1',
        maxAttempts: 3,
      })
      expect(await lookup.getPolicyRevisionContent('pol-none', 1)).toBeNull()
    })

    test('上传计划：事务内落 plan + 有序 entries，读回带 disposition 投影', async () => {
      const db = harness.db
      expect(await readUploadPlan(db, 'missing')).toBeNull()
      await seedMission(db, 'm-plan')
      const plan = (planId: string) => ({
        planId,
        missionId: 'm-plan',
        missionRevision: 0,
        repositoryId: 'repo-1',
        baselineSnapshotRef: `git:${'f'.repeat(40)}`,
        baselineSha: 'f'.repeat(40),
        planDigest: `digest-${planId}`,
        createdAt: NOW,
        entries: [
          {
            ordinal: 1,
            fileId: 'up-2',
            uploadBlobRef: 'b'.repeat(64),
            uploadSha256: 'b'.repeat(64),
            repositoryTargetPath: 'scripts/verify.sh',
            contentPolicy: 'agent-editable' as const,
            targetFileMode: 'executable' as const,
            expectedTarget: {
              kind: 'exact-file' as const,
              sha256: 'e'.repeat(64),
              fileMode: 'regular' as const,
            },
          },
          {
            ordinal: 0,
            fileId: 'up-1',
            uploadBlobRef: 'a'.repeat(64),
            uploadSha256: 'a'.repeat(64),
            repositoryTargetPath: 'docs/spec.md',
            contentPolicy: 'preserve-upload' as const,
            targetFileMode: 'regular' as const,
            expectedTarget: { kind: 'absent' as const },
          },
          {
            ordinal: 2,
            fileId: 'up-3',
            uploadBlobRef: 'c'.repeat(64),
            uploadSha256: 'c'.repeat(64),
            repositoryTargetPath: 'README.md',
            contentPolicy: 'preserve-upload' as const,
            targetFileMode: 'regular' as const,
            expectedTarget: {
              kind: 'already-present' as const,
              sha256: 'c'.repeat(64),
              fileMode: 'regular' as const,
            },
          },
        ],
      })
      // 调用方事务里落库（launch 事务的形状）。
      await databaseSessionFor(db).transaction(async (tx) => {
        await insertUploadPlan(tx, plan('plan-1'))
      })
      // 直接用 db 句柄也行（测试 / 单步脚本）。
      await insertUploadPlan(db, { ...plan('plan-empty'), entries: [] })
      expect(await readUploadPlan(db, 'plan-empty')).toEqual({
        planDigest: 'digest-plan-empty',
        baselineSha: 'f'.repeat(40),
        entries: [],
      })
      const read = await readUploadPlan(db, 'plan-1')
      expect(read?.planDigest).toBe('digest-plan-1')
      expect(
        read?.entries.map((entry) => [entry.ordinal, entry.fileId, entry.disposition]),
      ).toEqual([
        [0, 'up-1', 'create'],
        [1, 'up-2', 'replace'],
        [2, 'up-3', 'already-present'],
      ])
      expect(read?.entries[1]).toEqual({
        ordinal: 1,
        fileId: 'up-2',
        targetPath: 'scripts/verify.sh',
        contentPolicy: 'agent-editable',
        fileMode: 'executable',
        disposition: 'replace',
        uploadSha256: 'b'.repeat(64),
      })
      // plan 一经写入不可修改：同 id 再落一次是主键冲突。
      await expect(insertUploadPlan(db, plan('plan-1'))).rejects.toBeDefined()
    })
  },
)
