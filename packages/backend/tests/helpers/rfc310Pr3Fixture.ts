// RFC-310 PR-3 —— 需求取件链路测试的共享 fixture。
//
// 在 PR-2 fixture 的骨架上加三块真实件：①可参数化的 policy actionPriority
// （默认第一谓词读 requirement.bundleComplete——这正是触发 reconciler
// requirement 重派的形状）；②真实发布的 integration adapter（executableRef
// 指向 system-mocks 的 requirement-adapter-cli，真子进程）；③真实
// EvidenceStore + requirementMaterializer + createRequirementSourceAdapter
// 全链装配。外部世界只剩 requirement mock HTTP 服务与 repository facts fake。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '../../src/db/client'
import type { DbClient } from '../../src/db/client'
import {
  createActionTemplate,
  publishActionTemplate,
} from '../../src/modules/development-automation/application/commands/actionTemplateCommands'
import { createSqliteActionTemplatePersistence } from '../../src/modules/development-automation/infrastructure/sqliteConfigResourceStore'
import {
  createAutomationPolicy,
  publishAutomationPolicy,
  createDigitalEmployee,
  publishDigitalEmployee,
  getDigitalEmployeeRevision,
  getAutomationPolicyRevision,
} from '../../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import { resolveAdmissionAssignment } from '../../src/modules/development-automation/infrastructure/sqliteAssignmentStore'
import { createEmployeePublishLookup } from '../../src/modules/development-automation/infrastructure/publishLookup'
import {
  createSqliteMissionPersistence,
  createSqliteMissionStore,
} from '../../src/modules/development-automation/infrastructure/sqliteMissionStore'
import { createSqliteFactSnapshotReader } from '../../src/modules/development-automation/infrastructure/sqliteReconcilerReaders'
import { createSqliteRequirementBundleRefPersistence } from '../../src/modules/development-automation/infrastructure/requirementBundleRefPersistence'
import { EvidenceStore } from '../../src/modules/development-automation/infrastructure/evidenceStore'
import {
  createRequirementMaterializer,
  type RequirementMaterializer,
} from '../../src/modules/development-automation/infrastructure/requirementMaterializer'
import { defaultAutomationPolicyContent } from '../../src/modules/development-automation/domain/automationPolicy'
import type { AdmissionLookup } from '../../src/modules/development-automation/application/ports/admissionLookup'
import type { MissionStore } from '../../src/modules/development-automation/application/ports/missionStore'
import type {
  FactSnapshotReader,
  ReconcilerPorts,
} from '../../src/modules/development-automation/application/ports/reconcilerPorts'
import type { ReconcileDeps } from '../../src/modules/development-automation/application/missionReconciler'
import { launchMission } from '../../src/modules/development-automation/application/commands/launchMission'
import {
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
} from '../../src/modules/integration/application/developmentAdapterCommands'
import { createSqliteDevelopmentAdapterStore } from '../../src/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'
import {
  createDbAdapterBindingResolver,
  createRequirementSourceAdapter,
} from '../../src/modules/integration/infrastructure/developmentRequirementSourceAdapter'

const MIGRATIONS = resolve(import.meta.dirname, '..', '..', 'db', 'migrations')

export const ADAPTER_CLI = Bun.resolveSync(
  '@agent-workflow/system-mocks/development/requirement-adapter-cli',
  import.meta.dir,
)

export interface Pr3PolicyRule {
  readonly ruleId: string
  readonly when: readonly unknown[]
  readonly capabilityId: 'change.implement' | 'requirement.analyze' | 'conflict.repair'
}

/** 默认规则：requirement.bundleComplete → 才轮到 repository.languages → 动作。 */
export const DEFAULT_PR3_RULES: readonly Pr3PolicyRule[] = [
  {
    ruleId: 'impl-when-requirement-ready',
    when: [
      { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
      { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
    ],
    capabilityId: 'change.implement',
  },
]

export interface Pr3FixtureOptions {
  readonly rules?: readonly Pr3PolicyRule[]
  /** journey/HTTP 测试：在已有 db（createApp harness 同一实例）上铺配置。 */
  readonly db?: DbClient
  /** PR-5 T54：员工加 requirement.analyze 只读路由（含专用模板）。 */
  readonly analyzeRoute?: boolean
  /** PR-10 T109：员工加 mr.feedback.apply 路由（含专用模板）——全旅程 E2E 用。 */
  readonly feedbackRoute?: boolean
  /** PR-7b T78：员工加 conflict.repair 路由（含专用模板）——冲突收敛旅程用。 */
  readonly conflictRoute?: boolean
  /** PR-7b T78：conflict policy（缺省沿用 default 的 report-only）。 */
  readonly conflictPolicy?: {
    readonly mode: 'report-only' | 'repair'
    readonly maxRepairAttempts?: number
  }
  /** PR-5 T55a：policy 的 no-change 收束模式（默认 program-proof）。 */
  readonly noChangeConfirmation?: 'program-proof' | 'human-confirmation'
  /** 外部源：发布真实 adapter（CLI 子进程）并挂到员工 requirementSources。 */
  readonly external?: {
    readonly mockUrl: string
    readonly operations?: readonly ('acquire' | 'questions.writeback' | 'answers.collect')[]
    readonly timeoutMs?: number
    readonly extraEnv?: Record<string, string>
  }
}

export interface Pr3Fixture {
  readonly db: DbClient
  readonly store: MissionStore
  readonly snapshots: FactSnapshotReader
  readonly lookup: AdmissionLookup
  readonly evidence: EvidenceStore
  readonly materializer: RequirementMaterializer
  readonly employeeId: string
  readonly policyId: string
  readonly adapterId: string | null
  readonly adapterRevision: number | null
  readonly stagingRoot: string
  deps(extraPorts?: Omit<ReconcilerPorts, 'requirementMaterialize'>): ReconcileDeps
  launchDirect(idempotencyKey: string, body?: string): Promise<string>
  launchExternal(idempotencyKey: string, externalId: string): Promise<string>
}

function lookupOf(db: DbClient): AdmissionLookup {
  return {
    async resolveAssignment(scope) {
      const row = await resolveAdmissionAssignment(db, scope)
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

export async function buildPr3Fixture(options: Pr3FixtureOptions = {}): Promise<Pr3Fixture> {
  const db = options.db ?? createInMemoryDb(MIGRATIONS)
  const now = () => Date.now()
  const templates = createSqliteActionTemplatePersistence(db)

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

  let analyzeTemplateId: string | null = null
  if (options.analyzeRoute === true) {
    const analyzeTemplate = await createActionTemplate(
      { store: templates, now },
      {
        actorUserId: 'admin',
        name: 'analyze-generic',
        capabilityId: 'requirement.analyze',
        draft: {
          schemaVersion: 1,
          capabilityId: 'requirement.analyze',
          capabilityContractVersion: 1,
          labels: [],
          compatibility: [],
          executor: { kind: 'agent', agentRef: 'agent-1@1' },
          runtimeProfileRef: 'rt',
          promptSupplement: 'analyze only',
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
    await publishActionTemplate(
      { store: templates, now },
      { id: analyzeTemplate.id, actorUserId: 'admin' },
    )
    analyzeTemplateId = analyzeTemplate.id
  }

  let feedbackTemplateId: string | null = null
  if (options.feedbackRoute === true) {
    const feedbackTemplate = await createActionTemplate(
      { store: templates, now },
      {
        actorUserId: 'admin',
        name: 'feedback-generic',
        capabilityId: 'mr.feedback.apply',
        draft: {
          schemaVersion: 1,
          capabilityId: 'mr.feedback.apply',
          capabilityContractVersion: 1,
          labels: [],
          compatibility: [],
          executor: { kind: 'agent', agentRef: 'agent-1@1' },
          runtimeProfileRef: 'rt',
          promptSupplement: 'apply the review feedback',
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
    await publishActionTemplate(
      { store: templates, now },
      { id: feedbackTemplate.id, actorUserId: 'admin' },
    )
    feedbackTemplateId = feedbackTemplate.id
  }

  let conflictTemplateId: string | null = null
  if (options.conflictRoute === true) {
    const conflictTemplate = await createActionTemplate(
      { store: templates, now },
      {
        actorUserId: 'admin',
        name: 'conflict-generic',
        capabilityId: 'conflict.repair',
        draft: {
          schemaVersion: 1,
          capabilityId: 'conflict.repair',
          capabilityContractVersion: 1,
          labels: [],
          compatibility: [],
          executor: { kind: 'agent', agentRef: 'agent-1@1' },
          runtimeProfileRef: 'rt',
          promptSupplement: 'resolve the marked conflicts only',
          skillRefs: [],
          mcpRefs: [],
          readOnlyResourceRefs: [],
          contextProfileRef: null,
          writablePathPolicyRef: null,
          additionalProtectedPathClasses: [],
          verificationProfileRef: 'vp',
          retryDefaults: { sameSession: 0, freshSession: 0 },
        },
      },
    )
    await publishActionTemplate(
      { store: templates, now },
      { id: conflictTemplate.id, actorUserId: 'admin' },
    )
    conflictTemplateId = conflictTemplate.id
  }

  const policyContent = defaultAutomationPolicyContent()
  const customPolicy = {
    ...policyContent,
    requirement: {
      ...policyContent.requirement,
      noChangeConfirmation: options.noChangeConfirmation ?? 'program-proof',
    },
    actionPriority: { rules: [...(options.rules ?? DEFAULT_PR3_RULES)] },
    conflict:
      options.conflictPolicy === undefined
        ? policyContent.conflict
        : {
            mode: options.conflictPolicy.mode,
            maxRepairAttempts:
              options.conflictPolicy.maxRepairAttempts ?? policyContent.conflict.maxRepairAttempts,
          },
  }
  const policy = await createAutomationPolicy(db, {
    name: 'pol-pr3',
    ownerUserId: 'admin',
    draft: customPolicy,
  })
  await publishAutomationPolicy(db, { id: policy.id, publishedBy: 'admin' })

  // 外部源：真实发布一个 requirement-source adapter（executableRef = mock CLI）。
  let adapterId: string | null = null
  let adapterRevision: number | null = null
  const adapterStore = createSqliteDevelopmentAdapterStore(db)
  if (options.external !== undefined) {
    const created = createDevelopmentAdapter(
      adapterStore,
      { userId: 'admin', actorHasScriptsAuthor: true },
      {
        name: 'req-sys-a',
        now: now(),
        content: {
          schemaVersion: 1,
          purpose: 'requirement-source',
          operations: [
            ...(options.external.operations ?? [
              'acquire',
              'questions.writeback',
              'answers.collect',
            ]),
          ],
          contractVersion: 1,
          executableRef: ADAPTER_CLI,
          parameterSchemaRef: null,
          connectionRef: null,
          secretProjection: [],
          outputBudget: {
            maxFiles: 64,
            maxFileBytes: 8 * 1024 * 1024,
            maxTotalBytes: 32 * 1024 * 1024,
          },
          timeoutMs: options.external.timeoutMs ?? 20_000,
        },
      },
    )
    const published = publishDevelopmentAdapter(
      adapterStore,
      { userId: 'admin', actorHasScriptsAuthor: true },
      { id: created.id, now: now() },
    )
    adapterId = created.id
    adapterRevision = published.revision
  }

  const lookup = createEmployeePublishLookup(db)
  const employee = await createDigitalEmployee(db, {
    name: 'emp-pr3',
    ownerUserId: 'admin',
    draft: {
      schemaVersion: 1,
      description: 'pr3 employee',
      supportedRepositoryFacts: [],
      capabilityRoutes: [
        {
          capabilityId: 'change.implement',
          rules: [
            {
              ruleId: 'java-route',
              when: [{ kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] }],
              templateRef: { id: template.id, revision: 1 },
            },
          ],
          fallbackTemplateRef: null,
        },
        ...(analyzeTemplateId === null
          ? []
          : [
              {
                capabilityId: 'requirement.analyze',
                rules: [],
                fallbackTemplateRef: { id: analyzeTemplateId, revision: 1 },
              },
            ]),
        ...(feedbackTemplateId === null
          ? []
          : [
              {
                capabilityId: 'mr.feedback.apply',
                rules: [],
                fallbackTemplateRef: { id: feedbackTemplateId, revision: 1 },
              },
            ]),
        ...(conflictTemplateId === null
          ? []
          : [
              {
                capabilityId: 'conflict.repair',
                rules: [],
                fallbackTemplateRef: { id: conflictTemplateId, revision: 1 },
              },
            ]),
      ],
      requirementSources:
        adapterId === null
          ? []
          : [
              {
                sourceKey: 'sys-a',
                adapterRef: { id: adapterId, revision: adapterRevision! },
                isDefault: true,
              },
            ],
      pipelineProviders: [],
      defaultPolicyRef: { id: policy.id, revision: 1 },
    },
  })
  await publishDigitalEmployee(db, { id: employee.id, publishedBy: 'admin', lookup })

  const store = createSqliteMissionStore(db)
  const persistence = createSqliteMissionPersistence(db)
  const snapshots = createSqliteFactSnapshotReader(db)
  const admissionLookup = lookupOf(db)

  const evidenceRoot = mkdtempSync(join(tmpdir(), 'rfc310-pr3-evidence-'))
  const stagingRoot = mkdtempSync(join(tmpdir(), 'rfc310-pr3-staging-'))
  const evidence = new EvidenceStore(evidenceRoot)
  const source =
    options.external === undefined
      ? undefined
      : createRequirementSourceAdapter({
          resolveBinding: createDbAdapterBindingResolver((id, revision) =>
            adapterStore.getRevision(id, revision),
          ),
          extraEnv: {
            AW_REQUIREMENT_MOCK_URL: options.external.mockUrl,
            ...(options.external.extraEnv ?? {}),
          },
        })
  const materializer = createRequirementMaterializer({
    bundleRefs: createSqliteRequirementBundleRefPersistence(db),
    store: persistence,
    snapshots,
    evidence,
    stagingRoot,
    source,
    now,
  })

  const launch = async (input: {
    idempotencyKey: string
    submission:
      | { kind: 'direct'; title: string; body: string | null; uploads: [] }
      | { kind: 'external-reference'; externalId: string }
  }): Promise<string> => {
    const result = await launchMission(
      { store: persistence, lookup: admissionLookup, now },
      {
        idempotencyKey: input.idempotencyKey,
        repositoryId: 'repo-1',
        repositoryGroupId: null,
        submission: input.submission,
        delivery: { kind: 'create-merge-request' },
        requestedEmployee: { id: employee.id, revision: 1 },
        requestedPolicy: null,
        actorUserId: 'u-1',
      },
    )
    return result.missionId
  }

  return {
    db,
    store,
    snapshots,
    lookup: admissionLookup,
    evidence,
    materializer,
    employeeId: employee.id,
    policyId: policy.id,
    adapterId,
    adapterRevision,
    stagingRoot,
    deps(extraPorts = {}) {
      return {
        store: persistence,
        lookup: admissionLookup,
        snapshots,
        ports: { ...extraPorts, requirementMaterialize: materializer },
        now,
      }
    },
    async launchDirect(idempotencyKey, body = 'do the thing') {
      return await launch({
        idempotencyKey,
        submission: { kind: 'direct', title: 'Add feature', body, uploads: [] },
      })
    },
    async launchExternal(idempotencyKey, externalId) {
      return await launch({
        idempotencyKey,
        submission: { kind: 'external-reference', externalId },
      })
    },
  }
}

export const PR3_JAVA_CELLS = {
  'repository.languages': { state: 'known', value: ['java'], sourceRevision: 'probe-1' },
  'repository.buildSystems': { state: 'known', value: ['maven'], sourceRevision: 'probe-1' },
  'repository.moduleIds': { state: 'known', value: ['app'], sourceRevision: 'probe-1' },
  // PR-5 T54：默认 analyze 规则读它（真 collector 恒产出该 leaf）。
  'repository.defaultBranchKnown': { state: 'known', value: true, sourceRevision: 'probe-1' },
} as const
