// RFC-310 PR-1B 验收旅程（T13–T18 合龙）——「用户定义多套数字员工，并在
// repository facts 上得到唯一、可解释、可重放的结果」。
//
// 全程走真实 store（in-memory SQLite + 全量迁移链）：
//   模板（java/cpp/polyglot）publish → policy publish → adapter publish →
//   Java/polyglot 员工 publish（真实闭包检查，经 publishLookup 同步绑定）→
//   assignment（repo-group 规则选择）→ resolveEmployeeSelection +
//   selectActionTemplate 端到端 → 同 facts 重放 100 次结果逐字节一致。
// 反向：闭包缺模板的员工 publish 被拒（不产生 revision 行）。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
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
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import {
  resolveAdmissionAssignment,
  upsertAssignment,
} from '../src/modules/development-automation/infrastructure/sqliteAssignmentStore'
import { createEmployeePublishLookup } from '../src/modules/development-automation/infrastructure/publishLookup'
import {
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
} from '../src/modules/integration/application/developmentAdapterCommands'
import { createSqliteDevelopmentAdapterStore } from '../src/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import { canonicalStringify } from '../src/modules/development-automation/domain/canonicalJson'
import {
  buildFactSnapshot,
  type FactCellValue,
} from '../src/modules/development-automation/domain/facts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import {
  resolveEmployeeSelection,
  selectActionTemplate,
  type CapabilityRouteRule,
  type EmployeeSelectionRule,
} from '../src/modules/development-automation/engine/policy/workSelection'

const MIGRATIONS = resolve(import.meta.dirname, '..', 'db', 'migrations')

function known(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'r1' }
}

function agentTemplateDraft(capabilityId: string) {
  return {
    schemaVersion: 1,
    capabilityId,
    capabilityContractVersion: 1,
    labels: [],
    compatibility: [],
    executor: { kind: 'agent', agentRef: 'agent-java@1' },
    runtimeProfileRef: 'runtime-default',
    promptSupplement: 'domain knowledge only',
    skillRefs: [],
    mcpRefs: [],
    readOnlyResourceRefs: [],
    contextProfileRef: null,
    writablePathPolicyRef: null,
    additionalProtectedPathClasses: [],
    verificationProfileRef: 'vp-default',
    retryDefaults: { sameSession: 2, freshSession: 1 },
  }
}

describe('rfc310 pr1b employee journey', () => {
  test('define templates/policy/adapter/employees, then deterministic selection end-to-end', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now = () => Date.now()
    const templates = createSqliteActionTemplatePersistence(db)
    const adapters = createSqliteDevelopmentAdapterStore(db)

    // 1) 三份 change.implement 模板（java/cpp/polyglot）各 publish 一版。
    const templateIds: Record<string, string> = {}
    for (const flavor of ['java', 'cpp', 'polyglot']) {
      const created = await createActionTemplate(
        { store: templates, now },
        {
          actorUserId: 'u-admin',
          name: `change.implement/${flavor}`,
          capabilityId: 'change.implement',
          draft: agentTemplateDraft('change.implement'),
        },
      )
      templateIds[flavor] = created.id
      const receipt = await publishActionTemplate(
        { store: templates, now },
        { id: created.id, actorUserId: 'u-admin' },
      )
      expect(receipt.revision).toBe(1)
    }

    // 2) 默认 policy publish。
    const policy = await createAutomationPolicy(db, {
      name: 'default-policy',
      ownerUserId: 'u-admin',
      draft: defaultAutomationPolicyContent(),
    })
    const policyReceipt = await publishAutomationPolicy(db, {
      id: policy.id,
      publishedBy: 'u-admin',
    })
    expect(policyReceipt.revision).toBe(1)

    // 3) requirement-source adapter publish（acquire + 问答成对）。
    const adapter = createDevelopmentAdapter(
      adapters,
      { userId: 'u-admin', actorHasScriptsAuthor: true },
      {
        name: 'inhouse-req',
        content: {
          schemaVersion: 1,
          purpose: 'requirement-source',
          operations: ['acquire', 'questions.writeback', 'answers.collect'],
          contractVersion: 1,
          executableRef: 'adapters/inhouse-req.ts',
          parameterSchemaRef: null,
          connectionRef: null,
          secretProjection: [],
          outputBudget: { maxFiles: 64, maxFileBytes: 8_000_000, maxTotalBytes: 64_000_000 },
          timeoutMs: 60_000,
        },
        now: now(),
      },
    )
    const adapterReceipt = publishDevelopmentAdapter(
      adapters,
      { userId: 'u-admin', actorHasScriptsAuthor: true },
      { id: adapter.id, now: now() },
    )
    expect(adapterReceipt.revision).toBe(1)

    // 4) Java 员工（route → java 模板）与 polyglot 员工（route → 三分支）。
    const employeeDraft = (routes: { ruleId: string; classes: string[]; template: string }[]) => ({
      schemaVersion: 1,
      description: 'employee',
      supportedRepositoryFacts: [],
      capabilityRoutes: [
        {
          capabilityId: 'change.implement',
          rules: routes.map((r) => ({
            ruleId: r.ruleId,
            when: [
              {
                kind: 'set-contains-all',
                fact: 'repository.changedPathClasses',
                values: r.classes,
              },
            ],
            templateRef: { id: r.template, revision: 1 },
          })),
          fallbackTemplateRef: null,
        },
      ],
      requirementSources: [
        { sourceKey: 'inhouse', adapterRef: { id: adapter.id, revision: 1 }, isDefault: true },
      ],
      pipelineProviders: [],
      defaultPolicyRef: { id: policy.id, revision: 1 },
    })

    const lookup = createEmployeePublishLookup(db)
    const javaEmployee = await createDigitalEmployee(db, {
      name: 'java-employee',
      ownerUserId: 'u-admin',
      draft: employeeDraft([
        { ruleId: 'java-only', classes: ['java-module'], template: templateIds.java! },
      ]),
    })
    const javaReceipt = await publishDigitalEmployee(db, {
      id: javaEmployee.id,
      publishedBy: 'u-admin',
      lookup,
    })
    expect(javaReceipt.revision).toBe(1)

    const polyglotEmployee = await createDigitalEmployee(db, {
      name: 'polyglot-employee',
      ownerUserId: 'u-admin',
      // first-match：最具体的规则必须在前——'java-only' 若排在首位会把
      // 混合改动也吞掉（它只要求 contains java-module）。这正是 policy
      // simulate/shadow 诊断（T87）要替用户照出的经典配置错。
      draft: employeeDraft([
        {
          ruleId: 'cross-module',
          classes: ['java-module', 'cpp-module'],
          template: templateIds.polyglot!,
        },
        { ruleId: 'java-only', classes: ['java-module'], template: templateIds.java! },
        { ruleId: 'cpp-only', classes: ['cpp-module'], template: templateIds.cpp! },
      ]),
    })
    const polyglotReceipt = await publishDigitalEmployee(db, {
      id: polyglotEmployee.id,
      publishedBy: 'u-admin',
      lookup,
    })
    expect(polyglotReceipt.revision).toBe(1)

    // 5) 闭包反例：引用不存在模板 revision 的员工 publish 被拒，零 revision 行。
    const broken = await createDigitalEmployee(db, {
      name: 'broken-employee',
      ownerUserId: 'u-admin',
      draft: employeeDraft([
        { ruleId: 'r', classes: ['java-module'], template: '01BROKENTEMPLATEIDXXXXXXX0' },
      ]),
    })
    await expect(
      publishDigitalEmployee(db, { id: broken.id, publishedBy: 'u-admin', lookup }),
    ).rejects.toThrow()

    // 6) assignment：repo 精确 → java；group 规则 → 按语言 facts 选 polyglot。
    await upsertAssignment(db, {
      scopeKind: 'repository',
      scopeRef: 'repo-1',
      employee: { id: javaEmployee.id, revision: 1 },
      selectionPolicy: null,
      executionPolicy: { id: policy.id, revision: 1 },
      defaultRequirementSourceKey: 'inhouse',
      updatedBy: 'u-admin',
    })
    await upsertAssignment(db, {
      scopeKind: 'repository-group',
      scopeRef: 'group-1',
      employee: { id: polyglotEmployee.id, revision: 1 },
      selectionPolicy: null,
      executionPolicy: null,
      defaultRequirementSourceKey: null,
      updatedBy: 'u-admin',
    })

    const exact = await resolveAdmissionAssignment(db, {
      repositoryId: 'repo-1',
      repositoryGroupId: 'group-1',
    })
    expect(exact?.scopeKind).toBe('repository')
    expect(exact?.employeeId).toBe(javaEmployee.id)
    const groupOnly = await resolveAdmissionAssignment(db, {
      repositoryId: 'repo-other',
      repositoryGroupId: 'group-1',
    })
    expect(groupOnly?.scopeKind).toBe('repository-group')

    // 7) published route 内容驱动模板选择：混合改动命中 polyglot 模板。
    const publishedPolyglot = await getDigitalEmployeeRevision(db, polyglotEmployee.id, 1)
    expect(publishedPolyglot).not.toBeNull()
    const content = JSON.parse(publishedPolyglot!.contentJson) as {
      capabilityRoutes: {
        capabilityId: string
        rules: { ruleId: string; when: unknown[]; templateRef: { id: string; revision: number } }[]
        fallbackTemplateRef: null
      }[]
    }
    const route = content.capabilityRoutes[0]!
    const routeRules: CapabilityRouteRule[] = route.rules.map((r) => ({
      ruleId: r.ruleId,
      when: r.when as CapabilityRouteRule['when'],
      templateRef: `${r.templateRef.id}@${r.templateRef.revision}`,
    }))
    const snapshot = buildFactSnapshot({
      missionRevision: 1,
      capturedAt: '2026-08-18T12:00:00+00:00',
      cells: { 'repository.changedPathClasses': known(['java-module', 'cpp-module']) },
    })
    const selected = selectActionTemplate({
      rules: routeRules,
      fallbackTemplateRef: null,
      snapshot,
    })
    expect(selected).toMatchObject({
      outcome: 'selected',
      templateRef: `${templateIds.polyglot}@1`,
      matchedRuleId: 'cross-module',
    })

    // 8) employee selection 经 assignment 规则 fixture + 100 次重放逐字节一致。
    const selectionRules: EmployeeSelectionRule[] = [
      {
        ruleId: 'mixed',
        when: [
          {
            kind: 'set-contains-all',
            fact: 'repository.languages',
            values: ['java', 'cpp'],
          },
        ],
        employeeRef: `${polyglotEmployee.id}@1`,
      },
    ]
    const mixedSnap = buildFactSnapshot({
      missionRevision: 1,
      capturedAt: '2026-08-18T12:00:00+00:00',
      cells: { 'repository.languages': known(['java', 'cpp']) },
    })
    const evaluateOnce = () =>
      resolveEmployeeSelection({
        explicitEmployeeRef: null,
        assignment: {
          scope: 'repository-group',
          employeeRef: null,
          selectionRules,
          executionPolicyRef: null,
          defaultRequirementSourceKey: null,
        },
        explicitFallbackRef: null,
        snapshot: mixedSnap,
      })
    const first = canonicalStringify(evaluateOnce())
    for (let i = 0; i < 100; i += 1) {
      expect(canonicalStringify(evaluateOnce())).toBe(first)
    }
    expect(evaluateOnce()).toMatchObject({
      outcome: 'selected',
      employeeRef: `${polyglotEmployee.id}@1`,
      matchedRuleId: 'mixed',
    })
  }, 30_000)
})
