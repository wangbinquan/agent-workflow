// RFC-310 PR-2 T24/T24a —— admission 链（真实配置 store fixture）。
//
// 锁：①四入口（direct 正文-only/文件-only/正文+文件、external）+ HTTP 幂等
// 重放同 mission；②显式员工无 assignment 可过、无员工 blocked、占位 facts
// （unknown）下规则选择老实 blocked(selection-indeterminate)；③external 的
// source 解析：requested key > assignment default > 员工唯一 default；无候选
// blocked、多候选 awaiting-information → SelectMissionRequirementSource 收敛
// →重复选幂等、越候选集拒绝；④cancel 无外部 effect 直达 canceled + epoch
// bump；retry blocked→working；⑤direct 上传目标路径重复/越界在 schema 层拒。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
import type { DbClient } from '../src/db/client'
import {
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
} from '../src/db/schema'
import {
  createActionTemplate,
  publishActionTemplate,
} from '../src/modules/development-automation/application/commands/actionTemplateCommands'
import { createSqliteActionTemplatePersistence } from '../src/modules/development-automation/infrastructure/sqliteConfigResourceStore'
import {
  createAutomationPolicy,
  publishAutomationPolicy,
  createDigitalEmployee,
  publishDigitalEmployee,
  getDigitalEmployeeRevision,
  getAutomationPolicyRevision,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import {
  resolveAdmissionAssignment,
  upsertAssignment,
} from '../src/modules/development-automation/infrastructure/sqliteAssignmentStore'
import { createEmployeePublishLookup } from '../src/modules/development-automation/infrastructure/publishLookup'
import { createSqliteMissionPersistence } from '../src/modules/development-automation/infrastructure/sqliteMissionStore'
import { createSqliteMissionInputUploadPersistence } from '../src/modules/development-automation/infrastructure/missionInputUploadPersistence'
import { createSqliteUploadSessionStore } from '../src/modules/development-automation/infrastructure/sqliteUploadSessionStore'
import type { UploadSessionStore } from '../src/modules/development-automation/application/ports/uploadSessionStore'
import {
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
} from '../src/modules/integration/application/developmentAdapterCommands'
import { createSqliteDevelopmentAdapterStore } from '../src/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import type { AdmissionLookup } from '../src/modules/development-automation/application/ports/admissionLookup'
import {
  cancelMission,
  launchMission,
  previewMissionAdmission,
  retryBlockedMission,
  selectMissionRequirementSource,
  type LaunchDeps,
} from '../src/modules/development-automation/application/commands/launchMission'

const MIGRATIONS = resolve(import.meta.dirname, '..', 'db', 'migrations')

interface Fixture {
  db: DbClient
  deps: LaunchDeps
  employees: { single: string; multi: string; none: string }
  policyId: string
  uploads: UploadSessionStore
}

function lookupOf(db: DbClient): AdmissionLookup {
  return {
    async resolveAssignment(scope) {
      const row = await resolveAdmissionAssignment(db, {
        repositoryId: scope.repositoryId,
        repositoryGroupId: scope.repositoryGroupId,
      })
      if (row === null) return null
      return {
        scopeKind: row.scopeKind,
        employeeId: row.employeeId,
        employeeRevision: row.employeeRevision,
        selectionPolicyId: row.selectionPolicyId,
        selectionPolicyRevision: row.selectionPolicyRevision,
        executionPolicyId: row.executionPolicyId,
        executionPolicyRevision: row.executionPolicyRevision,
        defaultRequirementSourceKey: row.defaultRequirementSourceKey,
      }
    },
    async getEmployeeRevisionContent(id, revision) {
      const row = await getDigitalEmployeeRevision(db, id, revision)
      return row === null ? null : JSON.parse(row.contentJson)
    },
    async getPolicyRevisionContent(id, revision) {
      const row = await getAutomationPolicyRevision(db, id, revision)
      return row === null ? null : JSON.parse(row.contentJson)
    },
  }
}

async function buildFixture(): Promise<Fixture> {
  const db = createInMemoryDb(MIGRATIONS)
  const now = () => Date.now()
  const templates = createSqliteActionTemplatePersistence(db)
  const adapters = createSqliteDevelopmentAdapterStore(db)

  const template = await createActionTemplate(
    { store: templates, now },
    {
      actorUserId: 'admin',
      name: 'impl-java',
      capabilityId: 'change.implement',
      draft: {
        schemaVersion: 1,
        capabilityId: 'change.implement',
        capabilityContractVersion: 1,
        labels: [],
        compatibility: [],
        executor: { kind: 'agent', agentRef: 'agent-1@1' },
        runtimeProfileRef: 'rt',
        promptSupplement: 'x',
        skillRefs: [],
        mcpRefs: [],
        readOnlyResourceRefs: [],
        contextProfileRef: null,
        writablePathPolicyRef: null,
        additionalProtectedPathClasses: [],
        verificationProfileRef: 'vp',
        retryDefaults: { sameSession: 2, freshSession: 1 },
      },
    },
  )
  await publishActionTemplate({ store: templates, now }, { id: template.id, actorUserId: 'admin' })

  const policy = await createAutomationPolicy(db, {
    name: 'pol',
    ownerUserId: 'admin',
    draft: defaultAutomationPolicyContent(),
  })
  await publishAutomationPolicy(db, { id: policy.id, publishedBy: 'admin' })

  const adapterActor = { userId: 'admin', actorHasScriptsAuthor: true }
  const mkAdapter = (name: string) => {
    const a = createDevelopmentAdapter(adapters, adapterActor, {
      name,
      content: {
        schemaVersion: 1,
        purpose: 'requirement-source',
        operations: ['acquire'],
        contractVersion: 1,
        executableRef: `adapters/${name}.ts`,
        parameterSchemaRef: null,
        connectionRef: null,
        secretProjection: [],
        outputBudget: { maxFiles: 8, maxFileBytes: 1_000_000, maxTotalBytes: 4_000_000 },
        timeoutMs: 30_000,
      },
      now: now(),
    })
    publishDevelopmentAdapter(adapters, adapterActor, { id: a.id, now: now() })
    return a.id
  }
  const adapterA = mkAdapter('sys-a')
  const adapterB = mkAdapter('sys-b')

  const lookup = createEmployeePublishLookup(db)
  const mkEmployee = async (
    name: string,
    sources: { sourceKey: string; adapterId: string; isDefault: boolean }[],
  ) => {
    const employee = await createDigitalEmployee(db, {
      name,
      ownerUserId: 'admin',
      draft: {
        schemaVersion: 1,
        description: name,
        supportedRepositoryFacts: [],
        capabilityRoutes: [
          {
            capabilityId: 'change.implement',
            rules: [
              {
                ruleId: 'any-java',
                when: [
                  { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
                ],
                templateRef: { id: template.id, revision: 1 },
              },
            ],
            fallbackTemplateRef: { id: template.id, revision: 1 },
          },
        ],
        requirementSources: sources.map((s) => ({
          sourceKey: s.sourceKey,
          adapterRef: { id: s.adapterId, revision: 1 },
          isDefault: s.isDefault,
        })),
        pipelineProviders: [],
        defaultPolicyRef: { id: policy.id, revision: 1 },
      },
    })
    await publishDigitalEmployee(db, { id: employee.id, publishedBy: 'admin', lookup })
    return employee.id
  }

  const single = await mkEmployee('emp-single', [
    { sourceKey: 'inhouse', adapterId: adapterA, isDefault: true },
  ])
  const multi = await mkEmployee('emp-multi', [
    { sourceKey: 'sys-a', adapterId: adapterA, isDefault: false },
    { sourceKey: 'sys-b', adapterId: adapterB, isDefault: false },
  ])
  const none = await mkEmployee('emp-none', [])

  const store = createSqliteMissionPersistence(db)
  const uploads = createSqliteUploadSessionStore(db)
  return {
    db,
    deps: {
      store,
      lookup: lookupOf(db),
      now,
      uploadAdmission: {
        uploads: createSqliteMissionInputUploadPersistence(db),
        // PR-2 admission 测试只关心 admission 链；baseline 一律「文件缺席」。
        resolveBaseline: async () => ({
          repositoryRef: 'repo-1',
          baselineSnapshotRef: `git:${'f'.repeat(40)}`,
          baselineSha: 'f'.repeat(40),
          reader: { stat: async () => 'missing' as const },
        }),
      },
    },
    employees: { single, multi, none },
    policyId: policy.id,
    uploads,
  }
}

function mkUpload(store: UploadSessionStore, name: string): string {
  return store.createUpload({
    actorUserId: 'u-1',
    originalName: name,
    bytes: 4,
    sha256: 'a'.repeat(64),
    blobRef: 'a'.repeat(64),
    idempotencyKey: null,
    now: Date.now(),
  }).id
}

function directInput(
  idempotencyKey: string,
  employeeId: string,
  body: string | null,
  uploads: unknown[] = [],
) {
  return {
    idempotencyKey,
    repositoryId: 'repo-1',
    repositoryGroupId: null,
    submission: { kind: 'direct', title: 'Add feature', body, uploads },
    delivery: { kind: 'create-merge-request' },
    requestedEmployee: { id: employeeId, revision: 1 },
    requestedPolicy: null,
    actorUserId: 'u-1',
  }
}

describe('rfc310 pr2 admission', () => {
  test('direct body-only / files-only / body+files all admit to working; idempotent replay', async () => {
    const f = await buildFixture()
    const bodyOnly = await launchMission(
      f.deps,
      directInput('idem-body-only-1', f.employees.single, 'do it'),
    )
    expect(bodyOnly).toMatchObject({ status: 'working', created: true, blockCode: null })
    const filesOnly = await launchMission(
      f.deps,
      directInput('idem-files-only-1', f.employees.single, null, [
        { uploadRef: mkUpload(f.uploads, 'spec.md'), repositoryTargetPath: 'docs/spec.md' },
      ]),
    )
    expect(filesOnly).toMatchObject({ status: 'working', created: true })
    const both = await launchMission(
      f.deps,
      directInput('idem-both-1', f.employees.single, 'and this', [
        { uploadRef: mkUpload(f.uploads, 'spec2.md'), repositoryTargetPath: 'docs/spec.md' },
      ]),
    )
    expect(both).toMatchObject({ status: 'working', created: true })

    const replay = await launchMission(
      f.deps,
      directInput('idem-body-only-1', f.employees.single, 'do it'),
    )
    expect(replay).toMatchObject({ missionId: bodyOnly.missionId, created: false })

    const mission = (await f.deps.store.getMission(bodyOnly.missionId))!
    expect(mission.employeeId).toBe(f.employees.single)
    expect(mission.policyId).toBe(f.policyId)
    expect(mission.sourceContentDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('working launch with uploads claims rows, persists the plan, and backfills uploadPlanRef', async () => {
    const f = await buildFixture()
    const ref = mkUpload(f.uploads, 'spec.md')
    const result = await launchMission(
      f.deps,
      directInput('idem-plan-persist-1', f.employees.single, null, [
        { uploadRef: ref, repositoryTargetPath: 'docs/spec.md' },
      ]),
    )
    expect(result.status).toBe('working')
    const claimed = f.uploads.getUpload(ref)!
    expect(claimed.state).toBe('claimed')
    expect(claimed.claimedByMissionId).toBe(result.missionId)
    const mission = (await f.deps.store.getMission(result.missionId))!
    expect(mission.uploadPlanRef).not.toBeNull()
    const plan = f.db
      .select()
      .from(developmentRepositoryUploadPlans)
      .where(eq(developmentRepositoryUploadPlans.id, mission.uploadPlanRef!))
      .get()!
    expect(plan.missionId).toBe(result.missionId)
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/)
    const entries = f.db
      .select()
      .from(developmentRepositoryUploadPlanEntries)
      .where(eq(developmentRepositoryUploadPlanEntries.planId, plan.id))
      .all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.fileId).toBe(ref)
    expect(entries[0]!.expectedTargetKind).toBe('absent')
  })

  test('launch transaction is atomic: in-transaction claim failure rolls back the mission row', async () => {
    const f = await buildFixture()
    const ok = mkUpload(f.uploads, 'a.md')
    const stolen = mkUpload(f.uploads, 'b.md')
    f.uploads.claimUploads({
      missionId: 'm-thief',
      actorUserId: 'u-1',
      uploadRefs: [stolen],
      now: Date.now(),
    })
    // TOCTOU 注入：预读谎报 stolen 仍 pending，让失败落在事务内的真实 claim 上。
    const lyingSessions = {
      ...f.uploads,
      getUpload: (id: string) => {
        const row = f.uploads.getUpload(id)
        return row !== null && row.id === stolen
          ? { ...row, state: 'pending', claimedByMissionId: null }
          : row
      },
    }
    const deps = {
      ...f.deps,
      uploadAdmission: { ...f.deps.uploadAdmission!, sessions: lyingSessions },
    }
    try {
      await launchMission(
        deps,
        directInput('idem-atomic-1', f.employees.single, null, [
          { uploadRef: ok, repositoryTargetPath: 'docs/a.md' },
          { uploadRef: stolen, repositoryTargetPath: 'docs/b.md' },
        ]),
      )
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('upload-already-claimed')
    }
    // 整体回滚：零 mission、零 plan、ok 行零消费、stolen 归属不变。
    expect(await f.deps.store.findByIdempotencyKey('idem-atomic-1')).toBeNull()
    expect(f.db.select().from(developmentRepositoryUploadPlans).all()).toHaveLength(0)
    expect(f.uploads.getUpload(ok)!.state).toBe('pending')
    expect(f.uploads.getUpload(stolen)!.claimedByMissionId).toBe('m-thief')
  })

  test('upload admission not wired blocks honestly instead of pretending', async () => {
    const f = await buildFixture()
    const bare = { store: f.deps.store, lookup: f.deps.lookup, now: f.deps.now }
    const result = await launchMission(
      bare,
      directInput('idem-not-wired-1', f.employees.single, null, [
        { uploadRef: 'whatever', repositoryTargetPath: 'docs/x.md' },
      ]),
    )
    expect(result).toMatchObject({ status: 'blocked', blockCode: 'upload-admission-not-wired' })
    const mission = (await f.deps.store.getMission(result.missionId))!
    expect(mission.sourceContentDigest).toBeNull()
  })

  test('direct with empty body and no uploads is rejected at the schema layer', async () => {
    const f = await buildFixture()
    await expect(
      launchMission(f.deps, directInput('idem-empty-1', f.employees.single, '   ')),
    ).rejects.toThrow()
    const dup = directInput('idem-dup-path-1', f.employees.single, null, [
      { uploadRef: 'ref-a', repositoryTargetPath: 'docs/a.md' },
      { uploadRef: 'ref-b', repositoryTargetPath: 'docs/a.md' },
    ])
    await expect(launchMission(f.deps, dup)).rejects.toThrow()
    const traversal = directInput('idem-trav-1', f.employees.single, null, [
      { uploadRef: 'ref-c', repositoryTargetPath: '../escape.md' },
    ])
    await expect(launchMission(f.deps, traversal)).rejects.toThrow()
  })

  test('no employee anywhere blocks; explicit employee needs no assignment', async () => {
    const f = await buildFixture()
    const noEmployee = await launchMission(f.deps, {
      ...directInput('idem-no-emp-1', f.employees.single, 'x'),
      requestedEmployee: null,
    })
    expect(noEmployee).toMatchObject({ status: 'blocked', blockCode: 'no-employee-match' })

    const retried = await retryBlockedMission(f.deps, { missionId: noEmployee.missionId })
    expect(retried.status).toBe('working')
  })

  test('assignment employee admits without explicit selection', async () => {
    const f = await buildFixture()
    await upsertAssignment(f.db, {
      scopeKind: 'repository',
      scopeRef: 'repo-1',
      employee: { id: f.employees.single, revision: 1 },
      selectionPolicy: null,
      executionPolicy: null,
      defaultRequirementSourceKey: null,
      updatedBy: 'admin',
    })
    const result = await launchMission(f.deps, {
      ...directInput('idem-assign-1', f.employees.single, 'x'),
      requestedEmployee: null,
    })
    expect(result.status).toBe('working')
    const mission = (await f.deps.store.getMission(result.missionId))!
    expect(mission.employeeId).toBe(f.employees.single)
  })

  test('external: unique default auto-pins; zero sources blocks; multiple candidates await selection', async () => {
    const f = await buildFixture()
    const externalInput = (key: string, employeeId: string, sourceKey?: string) => ({
      idempotencyKey: key,
      repositoryId: 'repo-1',
      repositoryGroupId: null,
      submission: {
        kind: 'external-reference',
        externalId: 'REQ-1042',
        ...(sourceKey ? { sourceKey } : {}),
      },
      delivery: { kind: 'create-merge-request' },
      requestedEmployee: { id: employeeId, revision: 1 },
      requestedPolicy: null,
      actorUserId: 'u-1',
    })

    const auto = await launchMission(f.deps, externalInput('idem-ext-auto-1', f.employees.single))
    expect(auto.status).toBe('working')
    expect((await f.deps.store.getMission(auto.missionId))!.resolvedSourceKey).toBe('inhouse')

    const zero = await launchMission(f.deps, externalInput('idem-ext-zero-1', f.employees.none))
    expect(zero).toMatchObject({ status: 'blocked', blockCode: 'requirement-source-unresolved' })

    const multi = await launchMission(f.deps, externalInput('idem-ext-multi-1', f.employees.multi))
    expect(multi.status).toBe('awaiting-information')

    // 越候选集拒绝；合法选择收敛到 working；重复选择幂等。
    await expect(
      selectMissionRequirementSource(f.deps, { missionId: multi.missionId, sourceKey: 'nope' }),
    ).rejects.toThrow()
    const selected = await selectMissionRequirementSource(f.deps, {
      missionId: multi.missionId,
      sourceKey: 'sys-b',
    })
    expect(selected.status).toBe('working')
    const again = await selectMissionRequirementSource(f.deps, {
      missionId: multi.missionId,
      sourceKey: 'sys-b',
    })
    expect(again.status).toBe('working')

    const requested = await launchMission(
      f.deps,
      externalInput('idem-ext-req-1', f.employees.multi, 'sys-a'),
    )
    expect(requested.status).toBe('working')
    expect((await f.deps.store.getMission(requested.missionId))!.resolvedAdapterId).not.toBeNull()

    const badKey = await launchMission(
      f.deps,
      externalInput('idem-ext-bad-1', f.employees.multi, 'not-offered'),
    )
    expect(badKey).toMatchObject({ status: 'blocked', blockCode: 'requirement-source-unresolved' })
  })

  test('side-effect-free preview uses the exact launch employee/policy/source chain', async () => {
    const f = await buildFixture()
    const common = {
      repositoryId: 'repo-1',
      repositoryGroupId: null,
      requestedPolicy: null,
      actorUserId: 'u-1',
    }
    const direct = await previewMissionAdmission(f.deps, {
      ...common,
      submission: { kind: 'direct' },
      requestedEmployee: { id: f.employees.single, revision: 1 },
    })
    expect(direct).toMatchObject({
      outcome: 'ready',
      employee: { id: f.employees.single, revision: 1 },
      policy: { id: f.policyId, revision: 1 },
      requirementSource: null,
      block: null,
    })

    const ambiguous = await previewMissionAdmission(f.deps, {
      ...common,
      submission: { kind: 'external-reference' },
      requestedEmployee: { id: f.employees.multi, revision: 1 },
    })
    expect(ambiguous).toMatchObject({
      outcome: 'needs-source-selection',
      sourceOptions: ['sys-a', 'sys-b'],
      block: null,
    })

    const selected = await previewMissionAdmission(f.deps, {
      ...common,
      submission: { kind: 'external-reference', sourceKey: 'sys-b' },
      requestedEmployee: { id: f.employees.multi, revision: 1 },
    })
    expect(selected).toMatchObject({
      outcome: 'ready',
      requirementSource: {
        sourceKey: 'sys-b',
        adapter: { revision: 1 },
      },
    })

    const blocked = await previewMissionAdmission(f.deps, {
      ...common,
      submission: { kind: 'direct' },
      requestedEmployee: null,
    })
    expect(blocked).toMatchObject({
      outcome: 'blocked',
      employee: null,
      policy: null,
      block: { code: 'no-employee-match' },
    })
  })

  test('adopt delivery records the MR ref at admission', async () => {
    const f = await buildFixture()
    const result = await launchMission(f.deps, {
      ...directInput('idem-adopt-1', f.employees.single, 'x'),
      delivery: { kind: 'adopt-merge-request', mergeRequestRef: 'ep-1/proj-1!42' },
    })
    expect(result.status).toBe('working')
    expect((await f.deps.store.getMission(result.missionId))!.adoptedMrRef).toBe('ep-1/proj-1!42')
  })

  test('cancel with no external effects lands terminal canceled and bumps epoch', async () => {
    const f = await buildFixture()
    const launched = await launchMission(
      f.deps,
      directInput('idem-cancel-1', f.employees.single, 'x'),
    )
    const before = (await f.deps.store.getMission(launched.missionId))!
    const result = await cancelMission(f.deps, { missionId: launched.missionId })
    expect(result).toEqual({ status: 'canceled', pending: false })
    const after = (await f.deps.store.getMission(launched.missionId))!
    expect(after.status).toBe('canceled')
    expect(after.epoch).toBe(before.epoch + 1)
    expect(after.transitionFence).toBe('none')
    expect(after.terminalKind).toBe('canceled')
    // 终态 absorbing：再 cancel 拒绝。
    await expect(cancelMission(f.deps, { missionId: launched.missionId })).rejects.toThrow()
  })

  test('cancel with a dispatched effect stays pending for the reconciler', async () => {
    const f = await buildFixture()
    const launched = await launchMission(
      f.deps,
      directInput('idem-cancel-2', f.employees.single, 'x'),
    )
    const prepared = await f.deps.store.prepareEffect({
      id: 'ef-d1',
      missionId: launched.missionId,
      actionRunId: null,
      effectKind: 'mr.ensure',
      intentDigest: 'i'.repeat(64),
      idempotencyKey: 'k-cancel-2',
      epoch: 0,
      now: Date.now(),
    })
    await f.deps.store.markEffectDispatched(prepared.effect.id, Date.now())
    const result = await cancelMission(f.deps, { missionId: launched.missionId })
    expect(result.pending).toBe(true)
    const after = (await f.deps.store.getMission(launched.missionId))!
    expect(after.transitionFence).toBe('cancel-pending')
    expect(after.status).not.toBe('canceled')
  })
})
