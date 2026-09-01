// RFC-310 PR-2 —— reconciler/recovery 测试的共享 fixture。
//
// 真实链路：in-memory SQLite 全量迁移 + PR-1B 真配置 store（模板/policy/员工
// publish 走真实闭包检查）+ 真实 mission store；只有外部世界（collector/
// launcher/executor）是 typed fake。policy 的 actionPriority 用
// repository.languages 谓词——admission 的占位 facts 是 unknown，因此第一轮
// 老实地 collect-repository-facts，第二轮才命中 change.implement（这正是
// indeterminate-stop 语义的端到端形状）。

import { resolve } from 'node:path'

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
import { defaultAutomationPolicyContent } from '../../src/modules/development-automation/domain/automationPolicy'
import type { AdmissionLookup } from '../../src/modules/development-automation/application/ports/admissionLookup'
import type { MissionStore } from '../../src/modules/development-automation/application/ports/missionStore'
import type {
  FactSnapshotReader,
  ReconcilerPorts,
} from '../../src/modules/development-automation/application/ports/reconcilerPorts'
import type { ReconcileDeps } from '../../src/modules/development-automation/application/missionReconciler'
import { launchMission } from '../../src/modules/development-automation/application/commands/launchMission'

const MIGRATIONS = resolve(import.meta.dirname, '..', '..', 'db', 'migrations')

export interface Pr2Fixture {
  readonly db: DbClient
  readonly store: MissionStore
  readonly snapshots: FactSnapshotReader
  readonly lookup: AdmissionLookup
  readonly employeeId: string
  readonly templateId: string
  readonly policyId: string
  deps(ports: ReconcilerPorts): ReconcileDeps
  launch(idempotencyKey: string): Promise<string>
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

export async function buildPr2Fixture(): Promise<Pr2Fixture> {
  const db = createInMemoryDb(MIGRATIONS)
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

  // actionPriority 换成 repository.languages 谓词（见文件头注释）。
  const policyContent = defaultAutomationPolicyContent()
  const customPolicy = {
    ...policyContent,
    actionPriority: {
      rules: [
        {
          ruleId: 'impl-on-java',
          when: [
            { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] } as const,
          ],
          capabilityId: 'change.implement' as const,
        },
      ],
    },
  }
  const policy = await createAutomationPolicy(db, {
    name: 'pol-java',
    ownerUserId: 'admin',
    draft: customPolicy,
  })
  await publishAutomationPolicy(db, { id: policy.id, publishedBy: 'admin' })

  const lookup = createEmployeePublishLookup(db)
  const employee = await createDigitalEmployee(db, {
    name: 'emp-java',
    ownerUserId: 'admin',
    draft: {
      schemaVersion: 1,
      description: 'java employee',
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
      ],
      requirementSources: [],
      pipelineProviders: [],
      defaultPolicyRef: { id: policy.id, revision: 1 },
    },
  })
  await publishDigitalEmployee(db, { id: employee.id, publishedBy: 'admin', lookup })

  const store = createSqliteMissionStore(db)
  const persistence = createSqliteMissionPersistence(db)
  const snapshots = createSqliteFactSnapshotReader(db)
  const admissionLookup = lookupOf(db)

  return {
    db,
    store,
    snapshots,
    lookup: admissionLookup,
    employeeId: employee.id,
    templateId: template.id,
    policyId: policy.id,
    deps(ports: ReconcilerPorts): ReconcileDeps {
      return { store: persistence, lookup: admissionLookup, snapshots, ports, now }
    },
    async launch(idempotencyKey: string): Promise<string> {
      const result = await launchMission(
        { store: persistence, lookup: admissionLookup, now },
        {
          idempotencyKey,
          repositoryId: 'repo-1',
          repositoryGroupId: null,
          submission: { kind: 'direct', title: 'Add feature', body: 'do it', uploads: [] },
          delivery: { kind: 'create-merge-request' },
          requestedEmployee: { id: employee.id, revision: 1 },
          requestedPolicy: null,
          actorUserId: 'u-1',
        },
      )
      return result.missionId
    },
  }
}

export const JAVA_CELLS = {
  'repository.languages': { state: 'known', value: ['java'], sourceRevision: 'probe-1' },
  'repository.buildSystems': { state: 'known', value: ['maven'], sourceRevision: 'probe-1' },
  'repository.moduleIds': { state: 'known', value: ['app'], sourceRevision: 'probe-1' },
} as const
