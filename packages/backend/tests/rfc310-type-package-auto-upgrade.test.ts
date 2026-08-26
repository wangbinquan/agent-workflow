/**
 * RFC-310 PR-28 regression: a Type Package bump must upgrade every provably
 * compatible published employee closure without creating a user migration job.
 * The old implementation only registered the new type and left a disabled
 * "Upgrade to current version" button, so these tests intentionally start from
 * a real v1 tool -> job -> employee closure and then restart on v2.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import {
  employeeCases,
  employeeDefinitionRevisions,
  employeeDefinitions,
  employeeInvocations,
  employeeJobTemplates,
  employeeOsOutbox,
  employeeReactionRounds,
  employeeToolRegistrations,
  employeeToolRegistrationRevisions,
  resourceGrants,
  users,
} from '@/db/schema'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import type { ToolConnectionCatalogPort } from '@/modules/digital-employee/composition/required-ports'
import { contentDigest } from '@/modules/digital-employee/domain/model'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import type {
  DigitalEmployeePlatformToolCatalogParticipant,
  EmployeeTypePackageRegistration,
} from '@/modules/digital-employee/public/types'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import { composeEventCenter } from '@/modules/event-center/composition'
import { and, eq } from 'drizzle-orm'
import { designEmployeeTypePackage } from './fixtures/digitalEmployeeTypePackages'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const executionContracts: ExecutionContractParticipant = {
  list: () => [],
  get: () => {
    throw new Error('auto-upgrade fixture does not execute work')
  },
  async validateExecutor({ contractRef }) {
    return {
      schemaVersion: 1,
      contractRef,
      status: 'valid',
      checks: [{ code: 'fixture-contract', ok: true, detail: 'exact fixture contract' }],
    }
  },
  async validateAgentCandidates() {
    return []
  },
  validateEnvelope() {
    throw new Error('auto-upgrade fixture does not settle work')
  },
}

function versionedDesignPackage(
  revision: number,
  mutate?: (descriptor: Record<string, unknown>) => void,
): EmployeeTypePackageRegistration {
  const descriptor = JSON.parse(designEmployeeTypePackage.descriptorJson) as Record<string, unknown>
  descriptor.typeRef = { typeId: 'design', revision }
  mutate?.(descriptor)
  return {
    descriptorJson: JSON.stringify(descriptor),
    parseWorkScopeJson: (inputJson) => designEmployeeTypePackage.parseWorkScopeJson(inputJson),
    summarizeWorkScopeJson: (scopeJson, locale) =>
      designEmployeeTypePackage.summarizeWorkScopeJson(scopeJson, locale),
    validateContractFixtureJson: (requestJson) =>
      designEmployeeTypePackage.validateContractFixtureJson(requestJson),
  }
}

function versionedAdapterDesignPackage(input: {
  revision: number
  adapterSlot: boolean
  secondWorkItem?: boolean
}): EmployeeTypePackageRegistration {
  return versionedDesignPackage(input.revision, (descriptor) => {
    const manifest = descriptor.authoringManifest as {
      lifecycleRegions: Array<Record<string, unknown>>
      workItems: Array<Record<string, unknown>>
    }
    const lane = {
      laneId: 'design-main',
      label: { 'zh-CN': '设计执行', 'en-US': 'Design execution' },
      description: { 'zh-CN': '执行设计职责', 'en-US': 'Perform design duties' },
      order: 0,
      kind: 'spine',
      optional: false,
      adapterSlots: input.adapterSlot
        ? [
            {
              slotRef: 'primary',
              label: { 'zh-CN': '设计系统连接', 'en-US': 'Design system connection' },
              description: {
                'zh-CN': '读取设计门禁事实',
                'en-US': 'Collect design gate facts',
              },
              purpose: 'pipeline-gate',
              // The lane itself remains usable for inline work without an
              // Adapter, but the enabled WorkContract below requires this
              // purpose for external material acquisition.
              requiredWhenLaneEnabled: false,
            },
          ]
        : [],
    }
    manifest.lifecycleRegions[0]!.responsibilityLanes = [lane]
    manifest.workItems[0]!.responsibilityLaneId = 'design-main'
    if (input.secondWorkItem) {
      const second = structuredClone(manifest.workItems[0]!)
      second.workItemRef = 'design-review'
      second.order = 1
      second.label = { 'zh-CN': '复核设计', 'en-US': 'Review design' }
      second.description = { 'zh-CN': '复核设计结果', 'en-US': 'Review the design result' }
      second.nextWorkItemRefs = []
      manifest.workItems.push(second)
    }
    const contracts = descriptor.workContracts as Array<Record<string, unknown>>
    contracts[0]!.requiredConnectionPurpose = 'pipeline-gate'
  })
}

const catalogDefaultAdapterRef = { id: 'catalog-pipeline-default', revision: 4 } as const

const adapterCatalog: ToolConnectionCatalogPort = {
  resolve(ref) {
    return {
      ref,
      purpose: 'pipeline-gate',
      available: true,
      visible: true,
      contentDigest: `${ref.revision % 10}`.repeat(64),
      closureSummary: `${ref.id}@${ref.revision}; pipeline-gate; available`,
    }
  },
  selectAutomatic(input) {
    const candidates =
      input.candidates.length === 0 ? [catalogDefaultAdapterRef] : [...input.candidates]
    candidates.sort(
      (left, right) => left.id.localeCompare(right.id) || left.revision - right.revision,
    )
    const ref = candidates[0]
    return ref === undefined ? null : this.resolve(ref, input.subject)
  },
}

function writeLegacyToolConnection(
  db: ReturnType<typeof createInMemoryDb>,
  ref: { id: string; revision: number },
  connectionRef: { id: string; revision: number },
): void {
  const row = db
    .select()
    .from(employeeToolRegistrationRevisions)
    .where(
      and(
        eq(employeeToolRegistrationRevisions.toolId, ref.id),
        eq(employeeToolRegistrationRevisions.revision, ref.revision),
      ),
    )
    .get()
  if (row === undefined) throw new Error(`missing tool revision ${ref.id}@${ref.revision}`)
  const content = { ...(JSON.parse(row.contentJson) as Record<string, unknown>), connectionRef }
  db.update(employeeToolRegistrationRevisions)
    .set({ contentJson: JSON.stringify(content), contentDigest: contentDigest(content) })
    .where(
      and(
        eq(employeeToolRegistrationRevisions.toolId, ref.id),
        eq(employeeToolRegistrationRevisions.revision, ref.revision),
      ),
    )
    .run()
}

function versionedCollaboratingDesignPackage(revision: number): EmployeeTypePackageRegistration {
  return versionedDesignPackage(revision, (descriptor) => {
    const workItems = (
      descriptor.authoringManifest as { workItems: Array<Record<string, unknown>> }
    ).workItems
    workItems[0]!.nextWorkItemRefs = ['delegate']
    workItems.push({
      workItemRef: 'delegate',
      regionId: 'work',
      order: 1,
      label: { 'zh-CN': '委派设计工作', 'en-US': 'Delegate design work' },
      description: {
        'zh-CN': '调用另一个设计数字员工',
        'en-US': 'Invoke another design digital employee',
      },
      workContractRef: { contractId: 'design.perform-work', version: 1 },
      materialSummary: { 'zh-CN': '冻结委派材料', 'en-US': 'Frozen delegated material' },
      completionStandard: { 'zh-CN': '返回委派结果', 'en-US': 'Return a delegated result' },
      nodeKind: 'collaboration',
      collaborationContractId: 'design.cross-work',
      toolRoleGroups: [],
      nextWorkItemRefs: [],
    })
    descriptor.invocationContracts = [
      {
        contractId: 'design.cross-work',
        inputSchemaId: 'design.delegated-work.v1',
        resultSchemaId: 'design.delegated-result.v1',
        milestoneEventTypeIds: ['design.employee-result'],
      },
    ]
    descriptor.eventSources = [
      ...((descriptor.eventSources as Array<Record<string, unknown>> | undefined) ?? []),
      {
        sourceId: 'employee.channel',
        version: 1,
        displayName: { 'zh-CN': '数字员工协作通道', 'en-US': 'Employee channel' },
        description: {
          'zh-CN': '传递子员工的协作结果',
          'en-US': 'Carries invoked employee results',
        },
        observationMode: 'passive',
        observerProgramRef: null,
        pollIntervalMs: 60_000,
        batchSize: 100,
      },
    ]
    descriptor.eventTypes = [
      ...((descriptor.eventTypes as Array<Record<string, unknown>> | undefined) ?? []),
      {
        eventTypeId: 'design.employee-result',
        version: 1,
        subjectTypeId: 'employee-invocation',
        payloadSchemaId: 'employee.invocation-result.v1',
        displayName: { 'zh-CN': '设计协作结果', 'en-US': 'Design collaboration result' },
        description: {
          'zh-CN': '被调起的设计员工返回结果',
          'en-US': 'An invoked design employee returned a result',
        },
        deliveryClass: 'collaboration',
        priority: 600,
        sourceRef: { id: 'employee.channel', revision: 1 },
        catalogVisibility: 'internal',
        triggerParameters: null,
      },
    ]
  })
}

function versionedOrderedDispatchDesignPackage(revision: number): EmployeeTypePackageRegistration {
  return versionedDesignPackage(revision, (descriptor) => {
    const workItems = (
      descriptor.authoringManifest as { workItems: Array<Record<string, unknown>> }
    ).workItems
    const classifier = workItems[0]!
    classifier.nextWorkItemRefs = ['design-repair']
    classifier.orderedDispatchAuthoring = {
      label: { 'zh-CN': '问题分类', 'en-US': 'Problem classification' },
      description: { 'zh-CN': '按分类路由修复', 'en-US': 'Route repairs by category' },
      destinationWorkItemRefs: ['design-repair'],
      processingOrderOwner: 'job',
    }
    const repair = structuredClone(classifier)
    repair.workItemRef = 'design-repair'
    repair.order = 1
    repair.label = { 'zh-CN': '修复设计问题', 'en-US': 'Repair design problem' }
    repair.description = { 'zh-CN': '处理分类后的问题', 'en-US': 'Handle the classified problem' }
    repair.orderedDispatchAuthoring = null
    repair.nextWorkItemRefs = []
    workItems.push(repair)
  })
}

function createFixtureModule(input: {
  db: ReturnType<typeof createInMemoryDb>
  appHome: string
  typePackage: EmployeeTypePackageRegistration
  platformTools?: DigitalEmployeePlatformToolCatalogParticipant
  connectionCatalog?: ToolConnectionCatalogPort
  executionContracts?: ExecutionContractParticipant
  issues?: Array<{ reasonCode: string; resourceId: string }>
  idPrefix?: string
  id?: () => string
}) {
  let ordinal = 0
  return composeDigitalEmployee({
    db: input.db,
    appHome: input.appHome,
    typePackages: [input.typePackage],
    executionContracts: input.executionContracts ?? executionContracts,
    ...(input.platformTools === undefined ? {} : { platformTools: input.platformTools }),
    ...(input.connectionCatalog === undefined
      ? {}
      : { connectionCatalog: input.connectionCatalog }),
    id: input.id ?? (() => `${input.idPrefix ?? 'auto-upgrade-resource'}-${++ordinal}`),
    now: () => 10_000 + ordinal,
    onAutomaticUpgradeIssue: (issue) => input.issues?.push(issue),
  })
}

function platformToolCatalog(): DigitalEmployeePlatformToolCatalogParticipant {
  const record = (typeRevision: number) => {
    const content = {
      schemaVersion: 1 as const,
      typeRef: { typeId: 'design', revision: typeRevision },
      workItemRef: 'design-work',
      workContractRef: { contractId: 'design.perform-work', version: 1 },
      roleRef: 'primary',
      displayName: '平台设计 Agent',
      description: '由 provider 按稳定 Agent identity 解析 successor',
      implementation: {
        kind: 'agent' as const,
        agentRef: { id: 'platform-design-agent', revision: 99 },
      },
      connectionRef: null,
    }
    const receiptCore = {
      schemaVersion: 1 as const,
      status: 'valid' as const,
      contractRef: content.workContractRef,
      implementationDigest: contentDigest(content.implementation),
      checks: [{ code: 'platform-contract', ok: true, detail: 'provider validated successor' }],
      checkedAt: 99,
    }
    const id = `platform-fixture:design:${typeRevision}:design-work:platform-design-agent`
    const publishedRevision = 100 + typeRevision
    return {
      draft: {
        id,
        typeRef: content.typeRef,
        workItemRef: content.workItemRef,
        content,
        validationReceipt: { ...receiptCore, receiptDigest: contentDigest(receiptCore) },
        publishedRevision,
        ownerUserId: null,
        createdAt: 99,
        updatedAt: 99,
        retiredAt: null,
        origin: 'platform' as const,
        selection: 'selectable' as const,
      },
      revision: {
        ref: { id, revision: publishedRevision },
        content,
        contentDigest: contentDigest(content),
        validationReceipt: { ...receiptCore, receiptDigest: contentDigest(receiptCore) },
        state: 'published' as const,
        publishedAt: 99,
        publishedBy: null,
      },
    }
  }
  const records = [record(1), record(2), record(3)]
  return {
    listJson(typeRefJson, workItemRef) {
      const typeRef = JSON.parse(typeRefJson) as { typeId: string; revision: number }
      return JSON.stringify(
        records
          .map((candidate) => candidate.draft)
          .filter(
            (candidate) =>
              candidate.typeRef.typeId === typeRef.typeId &&
              candidate.typeRef.revision === typeRef.revision &&
              candidate.workItemRef === workItemRef,
          ),
      )
    },
    getRevisionJson(refJson) {
      const ref = JSON.parse(refJson) as { id: string; revision: number }
      const found = records.find(
        (candidate) =>
          candidate.revision.ref.id === ref.id && candidate.revision.ref.revision === ref.revision,
      )
      return found === undefined ? null : JSON.stringify(found.revision)
    },
    resolveCompatibleRevisionJson(sourceRefJson, targetTypeRefJson, workItemRef) {
      const sourceRef = JSON.parse(sourceRefJson) as { id: string; revision: number }
      const targetTypeRef = JSON.parse(targetTypeRefJson) as {
        typeId: string
        revision: number
      }
      const source = records.find(
        (candidate) =>
          candidate.revision.ref.id === sourceRef.id &&
          candidate.revision.ref.revision === sourceRef.revision,
      )
      if (
        source === undefined ||
        source.revision.content.implementation.agentRef.id !== 'platform-design-agent' ||
        targetTypeRef.typeId !== 'design' ||
        workItemRef !== 'design-work'
      ) {
        return null
      }
      const target = records.find(
        (candidate) => candidate.revision.content.typeRef.revision === targetTypeRef.revision,
      )
      return target === undefined ? null : JSON.stringify(target.revision)
    },
    isPlatformTool: (toolId) => toolId.startsWith('platform-fixture:'),
  }
}

function orderedDispatchPlatformToolCatalog(): DigitalEmployeePlatformToolCatalogParticipant {
  const record = (typeRevision: number, workItemRef: 'design-work' | 'design-repair') => {
    const classifier = workItemRef === 'design-work'
    const content = {
      schemaVersion: 1 as const,
      typeRef: { typeId: 'design', revision: typeRevision },
      workItemRef,
      workContractRef: { contractId: 'design.perform-work', version: 1 },
      roleRef: 'primary',
      displayName: classifier ? '平台问题分类器' : '平台问题修复器',
      description: classifier ? '按冻结定义分类' : '处理分类后的问题',
      implementation: {
        kind: 'agent' as const,
        agentRef: { id: classifier ? 'dispatch-classifier' : 'dispatch-repairer', revision: 1 },
      },
      connectionRef: null,
      ...(classifier
        ? {
            dispatchRouteDefinitions: [
              {
                routeRef: 'problem',
                displayName: '设计问题',
                description:
                  typeRevision === 1 ? '旧版设计问题说明' : '新版类型包拥有的设计问题说明',
                fallback: true,
              },
            ],
          }
        : { acceptedDispatchRoutes: [{ classifierWorkItemRef: 'design-work', routeRefs: ['*'] }] }),
    }
    const receiptCore = {
      schemaVersion: 1 as const,
      status: 'valid' as const,
      contractRef: content.workContractRef,
      implementationDigest: contentDigest(content.implementation),
      checks: [{ code: 'platform-contract', ok: true, detail: 'provider validated successor' }],
      checkedAt: 99,
    }
    const id = `platform-dispatch:design:${typeRevision}:${workItemRef}`
    const publishedRevision = 200 + typeRevision
    return {
      draft: {
        id,
        typeRef: content.typeRef,
        workItemRef,
        content,
        validationReceipt: { ...receiptCore, receiptDigest: contentDigest(receiptCore) },
        publishedRevision,
        ownerUserId: null,
        createdAt: 99,
        updatedAt: 99,
        retiredAt: null,
        origin: 'platform' as const,
        selection: 'selectable' as const,
      },
      revision: {
        ref: { id, revision: publishedRevision },
        content,
        contentDigest: contentDigest(content),
        validationReceipt: { ...receiptCore, receiptDigest: contentDigest(receiptCore) },
        state: 'published' as const,
        publishedAt: 99,
        publishedBy: null,
      },
    }
  }
  const records = ([1, 2] as const).flatMap((revision) => [
    record(revision, 'design-work'),
    record(revision, 'design-repair'),
  ])
  return {
    listJson(typeRefJson, workItemRef) {
      const typeRef = JSON.parse(typeRefJson) as { typeId: string; revision: number }
      return JSON.stringify(
        records
          .map((candidate) => candidate.draft)
          .filter(
            (candidate) =>
              candidate.typeRef.revision === typeRef.revision &&
              candidate.workItemRef === workItemRef,
          ),
      )
    },
    getRevisionJson(refJson) {
      const ref = JSON.parse(refJson) as { id: string; revision: number }
      const found = records.find(
        (candidate) =>
          candidate.revision.ref.id === ref.id && candidate.revision.ref.revision === ref.revision,
      )
      return found === undefined ? null : JSON.stringify(found.revision)
    },
    resolveCompatibleRevisionJson(sourceRefJson, targetTypeRefJson, workItemRef) {
      const sourceRef = JSON.parse(sourceRefJson) as { id: string; revision: number }
      const targetTypeRef = JSON.parse(targetTypeRefJson) as { revision: number }
      const source = records.find(
        (candidate) =>
          candidate.revision.ref.id === sourceRef.id &&
          candidate.revision.ref.revision === sourceRef.revision,
      )
      if (source === undefined || source.revision.content.workItemRef !== workItemRef) return null
      const target = records.find(
        (candidate) =>
          candidate.revision.content.typeRef.revision === targetTypeRef.revision &&
          candidate.revision.content.workItemRef === workItemRef,
      )
      return target === undefined ? null : JSON.stringify(target.revision)
    },
    isPlatformTool: (toolId) => toolId.startsWith('platform-dispatch:'),
  }
}

async function seedPublishedEmployee(input: {
  db: ReturnType<typeof createInMemoryDb>
  appHome: string
}) {
  const module = createFixtureModule({
    ...input,
    typePackage: versionedDesignPackage(1),
  })
  const typeRef = { typeId: 'design', revision: 1 }
  const tool = await module.commands.createTool({
    typeRef,
    workItemRef: 'design-work',
    actorUserId: 'owner-1',
    body: {
      displayName: '设计执行工具',
      description: '精确绑定设计合同',
      roleRef: 'primary',
      implementation: { kind: 'agent', agentRef: { id: 'design-agent', revision: 7 } },
    },
  })
  const toolRef = await module.commands.publishTool({
    typeRef,
    workItemRef: 'design-work',
    toolId: tool.id,
    actorUserId: 'owner-1',
  })
  const job = module.commands.createJobTemplate({
    typeRef,
    actorUserId: 'owner-1',
    body: {
      name: '产品设计岗位',
      description: '稳定的单职责岗位',
      defaultToolBindings: [
        { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
      ],
    },
  })
  const jobRef = module.commands.publishJobTemplate({ id: job.id, actorUserId: 'owner-1' })
  return module.commands.createEmployee({
    typeRef,
    actorUserId: 'owner-1',
    body: {
      name: '产品设计数字员工',
      jobTemplateRef: jobRef,
      workScope: { kind: 'global' },
    },
  })
}

describe('RFC-310 Type Package automatic compatible upgrades', () => {
  test('work-contract-required legacy lane connections auto-select a stable Adapter and keep immutable source rows', async () => {
    const runScenario = async (
      connections: readonly { id: string; revision: number }[],
      connectionCatalog: ToolConnectionCatalogPort = adapterCatalog,
    ): Promise<{
      issues: Array<{ reasonCode: string; resourceId: string }>
      employeeTypeRevision: number
      exactAdapterBindings: unknown[]
      sourceConnections: unknown[]
      targetToolConnections: unknown[]
    }> => {
      const appHome = mkdtempSync(join(tmpdir(), 'rfc323-legacy-adapter-projection-'))
      try {
        const db = createInMemoryDb(MIGRATIONS)
        const secondWorkItem = connections.length > 1
        const v1 = createFixtureModule({
          db,
          appHome,
          typePackage: versionedAdapterDesignPackage({
            revision: 1,
            adapterSlot: false,
            secondWorkItem,
          }),
          connectionCatalog,
          idPrefix: 'legacy-adapter-v1',
        })
        const typeRef = { typeId: 'design', revision: 1 }
        const workItemRefs = secondWorkItem
          ? (['design-work', 'design-review'] as const)
          : (['design-work'] as const)
        const toolRefs: Array<{ id: string; revision: number }> = []
        for (const workItemRef of workItemRefs) {
          const tool = await v1.commands.createTool({
            typeRef,
            workItemRef,
            actorUserId: 'legacy-owner',
            body: {
              displayName: `${workItemRef} legacy tool`,
              description: 'Published before lane Adapter bindings existed.',
              roleRef: 'primary',
              implementation: {
                kind: 'agent',
                agentRef: { id: `${workItemRef}-agent`, revision: 1 },
              },
            },
          })
          toolRefs.push(
            await v1.commands.publishTool({
              typeRef,
              workItemRef,
              toolId: tool.id,
              actorUserId: 'legacy-owner',
            }),
          )
        }
        const job = v1.commands.createJobTemplate({
          typeRef,
          actorUserId: 'legacy-owner',
          body: {
            name: 'Legacy Adapter role',
            description: 'Legacy exact tool connections are projected on upgrade.',
            defaultToolBindings: workItemRefs.map((workItemRef, index) => ({
              workItemRef,
              slotRef: 'primary',
              registrationRef: toolRefs[index]!,
            })),
          },
        })
        const jobRef = v1.commands.publishJobTemplate({
          id: job.id,
          actorUserId: 'legacy-owner',
        })
        const employee = v1.commands.createEmployee({
          typeRef,
          actorUserId: 'legacy-owner',
          body: {
            name: 'Legacy Adapter employee',
            jobTemplateRef: jobRef,
            workScope: { kind: 'global' },
          },
        })
        connections.forEach((connectionRef, index) =>
          writeLegacyToolConnection(db, toolRefs[index]!, connectionRef),
        )
        const sourceRows = toolRefs.map(
          (ref) =>
            db
              .select()
              .from(employeeToolRegistrationRevisions)
              .where(
                and(
                  eq(employeeToolRegistrationRevisions.toolId, ref.id),
                  eq(employeeToolRegistrationRevisions.revision, ref.revision),
                ),
              )
              .get()!,
        )

        const issues: Array<{ reasonCode: string; resourceId: string }> = []
        const v2 = createFixtureModule({
          db,
          appHome,
          typePackage: versionedAdapterDesignPackage({
            revision: 2,
            adapterSlot: true,
            secondWorkItem,
          }),
          connectionCatalog,
          issues,
          idPrefix: 'legacy-adapter-v2',
        })
        const current = v2.queries.getEmployee(employee.id)
        const sourceConnections = sourceRows.map((source) => {
          const after = db
            .select()
            .from(employeeToolRegistrationRevisions)
            .where(
              and(
                eq(employeeToolRegistrationRevisions.toolId, source.toolId),
                eq(employeeToolRegistrationRevisions.revision, source.revision),
              ),
            )
            .get()!
          expect(after.contentJson).toBe(source.contentJson)
          expect(after.contentDigest).toBe(source.contentDigest)
          return (
            (JSON.parse(after.contentJson) as { connectionRef?: unknown }).connectionRef ?? null
          )
        })
        const targetToolConnections = current.definition.exactToolBindings.map((binding) => {
          const row = db
            .select()
            .from(employeeToolRegistrationRevisions)
            .where(
              and(
                eq(employeeToolRegistrationRevisions.toolId, binding.registrationRef.id),
                eq(employeeToolRegistrationRevisions.revision, binding.registrationRef.revision),
              ),
            )
            .get()
          return row === undefined
            ? 'missing'
            : ((JSON.parse(row.contentJson) as { connectionRef?: unknown }).connectionRef ?? null)
        })
        return {
          issues,
          employeeTypeRevision: current.typeRef.revision,
          exactAdapterBindings: current.definition.exactAdapterBindings,
          sourceConnections,
          targetToolConnections,
        }
      } finally {
        rmSync(appHome, { recursive: true, force: true })
      }
    }

    const missing = await runScenario([])
    expect(missing.issues).toEqual([])
    expect(missing.employeeTypeRevision).toBe(2)
    expect(missing.exactAdapterBindings).toEqual([
      {
        laneId: 'design-main',
        slotRef: 'primary',
        adapterRef: catalogDefaultAdapterRef,
      },
    ])

    const exact = await runScenario([{ id: 'jenkins', revision: 3 }])
    expect(exact.issues).toEqual([])
    expect(exact.employeeTypeRevision).toBe(2)
    expect(exact.exactAdapterBindings).toEqual([
      {
        laneId: 'design-main',
        slotRef: 'primary',
        adapterRef: { id: 'jenkins', revision: 3 },
      },
    ])
    expect(exact.sourceConnections).toEqual([{ id: 'jenkins', revision: 3 }])
    expect(exact.targetToolConnections).toEqual([null])

    const ambiguous = await runScenario([
      { id: 'jenkins-a', revision: 1 },
      { id: 'jenkins-b', revision: 2 },
    ])
    expect(ambiguous.issues).toEqual([])
    expect(ambiguous.employeeTypeRevision).toBe(2)
    expect(ambiguous.exactAdapterBindings).toEqual([
      {
        laneId: 'design-main',
        slotRef: 'primary',
        adapterRef: { id: 'jenkins-a', revision: 1 },
      },
    ])

    const unavailable = await runScenario([], { resolve: () => null })
    expect(unavailable.employeeTypeRevision).toBe(1)
    expect(unavailable.issues).toContainEqual(
      expect.objectContaining({ reasonCode: 'adapter-binding-missing' }),
    )
  })

  test('a current employee auto-reconciles a contract-required Adapter published later', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc323-current-adapter-reconcile-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const typeRef = { typeId: 'design', revision: 2 }
      const typePackage = versionedAdapterDesignPackage({
        revision: 2,
        adapterSlot: true,
      })
      const initial = createFixtureModule({
        db,
        appHome,
        typePackage,
        connectionCatalog: { resolve: () => null },
        idPrefix: 'current-adapter-initial',
      })
      const tool = await initial.commands.createTool({
        typeRef,
        workItemRef: 'design-work',
        actorUserId: 'legacy-owner',
        body: {
          displayName: 'Late Adapter tool',
          description: 'The required Adapter is published after this employee.',
          roleRef: 'primary',
          implementation: {
            kind: 'agent',
            agentRef: { id: 'late-adapter-agent', revision: 1 },
          },
        },
      })
      const toolRef = await initial.commands.publishTool({
        typeRef,
        workItemRef: 'design-work',
        toolId: tool.id,
        actorUserId: 'legacy-owner',
      })
      const job = initial.commands.createJobTemplate({
        typeRef,
        actorUserId: 'legacy-owner',
        body: {
          name: 'Late Adapter role',
          description: 'Published before its provider Adapter exists.',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
          ],
        },
      })
      const jobRef = initial.commands.publishJobTemplate({
        id: job.id,
        actorUserId: 'legacy-owner',
      })
      const employee = initial.commands.createEmployee({
        typeRef,
        actorUserId: 'legacy-owner',
        body: {
          name: 'Late Adapter employee',
          jobTemplateRef: jobRef,
          workScope: { kind: 'global' },
        },
      })
      expect(initial.queries.getEmployee(employee.id).definition.exactAdapterBindings).toEqual([])

      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const reloaded = createFixtureModule({
        db,
        appHome,
        typePackage,
        connectionCatalog: adapterCatalog,
        issues,
        idPrefix: 'current-adapter-reloaded',
      })
      const current = reloaded.queries.getEmployee(employee.id)
      expect(issues).toEqual([])
      expect(current.revision).toBe(2)
      expect(current.definition.exactAdapterBindings).toEqual([
        {
          laneId: 'design-main',
          slotRef: 'primary',
          adapterRef: catalogDefaultAdapterRef,
        },
      ])
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('rebuilds job route metadata from the upgraded classifier revision', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-ordered-dispatch-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const platformTools = orderedDispatchPlatformToolCatalog()
      const sourceTypeRef = { typeId: 'design', revision: 1 }
      const source = createFixtureModule({
        db,
        appHome,
        typePackage: versionedOrderedDispatchDesignPackage(1),
        platformTools,
        idPrefix: 'ordered-dispatch-v1',
      })
      const classifier = source.queries.listTools(sourceTypeRef, 'design-work')[0]!
      const repair = source.queries.listTools(sourceTypeRef, 'design-repair')[0]!
      const job = source.commands.createJobTemplate({
        typeRef: sourceTypeRef,
        actorUserId: 'ordered-dispatch-owner',
        body: {
          name: 'Ordered dispatch role',
          description: 'The classifier owns route labels while the job owns handling order.',
          defaultToolBindings: [
            {
              workItemRef: 'design-work',
              slotRef: 'primary',
              registrationRef: {
                id: classifier.id,
                revision: classifier.publishedRevision!,
              },
            },
            {
              workItemRef: 'design-repair',
              slotRef: 'primary',
              registrationRef: { id: repair.id, revision: repair.publishedRevision! },
            },
          ],
          orderedDispatchConfigurations: [
            {
              classifierWorkItemRef: 'design-work',
              routes: [
                {
                  routeRef: 'problem',
                  displayName: '设计问题',
                  description: '旧版设计问题说明',
                  destinationWorkItemRef: 'design-repair',
                  registrationRef: { id: repair.id, revision: repair.publishedRevision! },
                  fallback: true,
                },
              ],
            },
          ],
        },
      })
      const jobRef = source.commands.publishJobTemplate({
        id: job.id,
        actorUserId: 'ordered-dispatch-owner',
      })
      const employee = source.commands.createEmployee({
        typeRef: sourceTypeRef,
        actorUserId: 'ordered-dispatch-owner',
        body: {
          name: 'Ordered dispatch employee',
          jobTemplateRef: jobRef,
          workScope: { kind: 'global' },
        },
      })

      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const target = createFixtureModule({
        db,
        appHome,
        typePackage: versionedOrderedDispatchDesignPackage(2),
        platformTools,
        issues,
        idPrefix: 'ordered-dispatch-v2',
      }).queries.getEmployee(employee.id)

      expect(issues).toEqual([])
      expect(target).toMatchObject({ typeRef: { typeId: 'design', revision: 2 } })
      expect(target.definition.exactOrderedDispatchConfigurations).toEqual([
        {
          classifierWorkItemRef: 'design-work',
          routes: [
            expect.objectContaining({
              routeRef: 'problem',
              description: '新版类型包拥有的设计问题说明',
              destinationWorkItemRef: 'design-repair',
              fallback: true,
            }),
          ],
        },
      ])
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('reconciles nested collaboration targets after every compatible employee upgrade', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-collaboration-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      let descendingId = 100
      const v1 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedCollaboratingDesignPackage(1),
        id: () => `collaboration-v1-${--descendingId}`,
      })
      const typeRef = { typeId: 'design', revision: 1 }
      const tool = await v1.commands.createTool({
        typeRef,
        workItemRef: 'design-work',
        actorUserId: 'collaboration-owner',
        body: {
          displayName: '设计协作工具',
          description: '完成设计员工自己的业务工作',
          roleRef: 'primary',
          implementation: { kind: 'agent', agentRef: { id: 'design-collaborator', revision: 1 } },
        },
      })
      const toolRef = await v1.commands.publishTool({
        typeRef,
        workItemRef: 'design-work',
        toolId: tool.id,
        actorUserId: 'collaboration-owner',
      })
      const targetJob = v1.commands.createJobTemplate({
        typeRef,
        actorUserId: 'collaboration-owner',
        body: {
          name: '协作目标岗位',
          description: '被父员工精确引用的目标',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
          ],
        },
      })
      const targetJobRef = v1.commands.publishJobTemplate({
        id: targetJob.id,
        actorUserId: 'collaboration-owner',
      })
      const target = v1.commands.createEmployee({
        typeRef,
        actorUserId: 'collaboration-owner',
        body: {
          name: 'Z 协作目标员工',
          jobTemplateRef: targetJobRef,
          workScope: { kind: 'global' },
        },
      })
      const targetV1Ref = { id: target.id, revision: target.revision }
      const parentJob = v1.commands.createJobTemplate({
        typeRef,
        actorUserId: 'collaboration-owner',
        body: {
          name: '协作父岗位',
          description: '包含不可变目标引用',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
          ],
          defaultCollaborationBindings: [
            {
              workItemRef: 'delegate',
              memberRef: 'primary',
              targetEmployeeRef: targetV1Ref,
              invocationContractId: 'design.cross-work',
              joinMode: 'all',
              quorum: null,
            },
          ],
        },
      })
      const parentJobRef = v1.commands.publishJobTemplate({
        id: parentJob.id,
        actorUserId: 'collaboration-owner',
      })
      const parent = v1.commands.createEmployee({
        typeRef,
        actorUserId: 'collaboration-owner',
        body: {
          name: 'A 协作父员工',
          jobTemplateRef: parentJobRef,
          workScope: { kind: 'global' },
        },
      })
      const parentV1Ref = { id: parent.id, revision: parent.revision }
      const rootJob = v1.commands.createJobTemplate({
        typeRef,
        actorUserId: 'collaboration-owner',
        body: {
          name: '协作根岗位',
          description: '经由父员工形成 A 到 B 到 C 的协作链',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
          ],
          defaultCollaborationBindings: [
            {
              workItemRef: 'delegate',
              memberRef: 'primary',
              targetEmployeeRef: parentV1Ref,
              invocationContractId: 'design.cross-work',
              joinMode: 'all',
              quorum: null,
            },
          ],
        },
      })
      const rootJobRef = v1.commands.publishJobTemplate({
        id: rootJob.id,
        actorUserId: 'collaboration-owner',
      })
      const root = v1.commands.createEmployee({
        typeRef,
        actorUserId: 'collaboration-owner',
        body: {
          name: '0 协作根员工',
          jobTemplateRef: rootJobRef,
          workScope: { kind: 'global' },
        },
      })

      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const v2 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedCollaboratingDesignPackage(2),
        issues,
        idPrefix: 'collaboration-v2',
      })
      const launchable = v2.queries.listLaunchableEmployees()
      const upgradedTarget = launchable.find((employee) => employee.id === target.id)!
      const upgradedParent = launchable.find((employee) => employee.id === parent.id)!
      const upgradedRoot = launchable.find((employee) => employee.id === root.id)!

      expect(issues).toEqual([])
      expect(upgradedTarget).toMatchObject({
        revision: 2,
        typeRef: { typeId: 'design', revision: 2 },
      })
      expect(upgradedParent).toMatchObject({
        revision: 3,
        typeRef: { typeId: 'design', revision: 2 },
        definition: {
          exactCollaborationBindings: [
            expect.objectContaining({ targetEmployeeRef: { id: target.id, revision: 2 } }),
          ],
        },
      })
      expect(upgradedRoot).toMatchObject({
        revision: 3,
        typeRef: { typeId: 'design', revision: 2 },
        definition: {
          exactCollaborationBindings: [
            expect.objectContaining({ targetEmployeeRef: { id: parent.id, revision: 3 } }),
          ],
        },
      })
      const parentRevisions = db
        .select()
        .from(employeeDefinitionRevisions)
        .all()
        .filter((revision) => revision.employeeId === parent.id)
        .map((revision) => ({
          revision: revision.revision,
          typeRevision: JSON.parse(revision.contentJson).typeRef.revision,
          targetEmployeeRef: JSON.parse(revision.contentJson).exactCollaborationBindings[0]
            .targetEmployeeRef,
        }))
      expect(parentRevisions).toEqual([
        { revision: 1, typeRevision: 1, targetEmployeeRef: targetV1Ref },
        { revision: 2, typeRevision: 2, targetEmployeeRef: targetV1Ref },
        {
          revision: 3,
          typeRevision: 2,
          targetEmployeeRef: { id: target.id, revision: 2 },
        },
      ])
      const rootRevisions = db
        .select()
        .from(employeeDefinitionRevisions)
        .all()
        .filter((revision) => revision.employeeId === root.id)
        .map((revision) => ({
          revision: revision.revision,
          typeRevision: JSON.parse(revision.contentJson).typeRef.revision,
          targetEmployeeRef: JSON.parse(revision.contentJson).exactCollaborationBindings[0]
            .targetEmployeeRef,
        }))
      expect(rootRevisions).toEqual([
        { revision: 1, typeRevision: 1, targetEmployeeRef: parentV1Ref },
        { revision: 2, typeRevision: 2, targetEmployeeRef: parentV1Ref },
        {
          revision: 3,
          typeRevision: 2,
          targetEmployeeRef: { id: parent.id, revision: 3 },
        },
      ])

      const targetV2Revision = db
        .select()
        .from(employeeDefinitionRevisions)
        .where(
          and(
            eq(employeeDefinitionRevisions.employeeId, target.id),
            eq(employeeDefinitionRevisions.revision, 2),
          ),
        )
        .get()!
      db.insert(employeeDefinitionRevisions)
        .values({
          ...targetV2Revision,
          revision: 3,
          createdAt: targetV2Revision.createdAt + 1,
          createdBy: null,
        })
        .run()
      db.update(employeeDefinitions)
        .set({ currentRevision: 3, updatedAt: targetV2Revision.createdAt + 1 })
        .where(eq(employeeDefinitions.id, target.id))
        .run()

      const sameTypeReconciled = createFixtureModule({
        db,
        appHome,
        typePackage: versionedCollaboratingDesignPackage(2),
        issues,
        idPrefix: 'collaboration-same-type',
      })
      expect(sameTypeReconciled.queries.getEmployee(parent.id)).toMatchObject({
        revision: 4,
        definition: {
          exactCollaborationBindings: [
            expect.objectContaining({ targetEmployeeRef: { id: target.id, revision: 3 } }),
          ],
        },
      })
      expect(sameTypeReconciled.queries.getEmployee(root.id)).toMatchObject({
        revision: 4,
        definition: {
          exactCollaborationBindings: [
            expect.objectContaining({ targetEmployeeRef: { id: parent.id, revision: 4 } }),
          ],
        },
      })

      const revisionCount = db.select().from(employeeDefinitionRevisions).all().length
      const replayed = createFixtureModule({
        db,
        appHome,
        typePackage: versionedCollaboratingDesignPackage(2),
        issues,
        idPrefix: 'collaboration-replay',
      })
      expect(replayed.queries.getEmployee(parent.id).revision).toBe(4)
      expect(replayed.queries.getEmployee(root.id).revision).toBe(4)
      expect(db.select().from(employeeDefinitionRevisions).all()).toHaveLength(revisionCount)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('automatically re-plans a legacy invocation when only its target can upgrade', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-invocation-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      let now = 30_000
      let ordinal = 0
      const id = () => `invocation-upgrade-${++ordinal}`
      const v1Package = versionedCollaboratingDesignPackage(1)
      const eventCenter = composeEventCenter({
        db,
        typePackageDescriptorJsons: [
          v1Package.descriptorJson,
          digitalEmployeeLifecycleEventCatalogJson,
        ],
        now: () => now,
        id,
      })
      const runtimeContracts: ExecutionContractParticipant = {
        ...executionContracts,
        validateEnvelope({ envelopeJson }) {
          return envelopeJson
        },
      }
      const runtimeCodec = {
        typeId: 'design',
        buildInitialCaseJson() {
          throw new Error('invocation upgrade fixture launches Cases through the runtime contract')
        },
        validateContextJson(contextTypeId: string, stateJson: string) {
          if (contextTypeId !== 'design.work') {
            throw new Error(`unexpected design Context: ${contextTypeId}`)
          }
          const state = JSON.parse(stateJson) as { status?: unknown; title?: unknown }
          if (typeof state.status !== 'string' || typeof state.title !== 'string') {
            throw new Error('design work Context requires status and title')
          }
          return JSON.stringify({ status: state.status, title: state.title })
        },
        resolveAttentionSubjectsJson() {
          return '[]'
        },
        selectReactionToolSlotJson(requestJson: string) {
          const request = JSON.parse(requestJson) as { defaultSlotRef: string }
          return JSON.stringify({ slotRef: request.defaultSlotRef })
        },
        assembleReactionInputJson(requestJson: string) {
          const request = JSON.parse(requestJson) as {
            caseRef: string
            roundRef: string
            executionNonce: string
            workItemRef: string
            eventJson: string
            contextsJson: string
          }
          return JSON.stringify({
            schemaVersion: 1,
            caseRef: request.caseRef,
            roundRef: request.roundRef,
            executionNonce: request.executionNonce,
            workItemRef: request.workItemRef,
            eventJson: request.eventJson,
            contextsJson: request.contextsJson,
            contractInput: {},
          })
        },
        buildInvokedCaseJson(requestJson: string) {
          const request = JSON.parse(requestJson) as {
            invocationRef: string
            targetEmployeeRef: { id: string; revision: number }
          }
          return JSON.stringify({
            employeeRef: request.targetEmployeeRef,
            primaryContextTypeId: 'design.work',
            primaryContextSchemaVersion: 1,
            primaryContextState: 'active',
            primaryContextJson: JSON.stringify({
              status: 'active',
              title: `Delegated ${request.invocationRef}`,
            }),
            artifactRefs: [],
            workSubject: {
              typeId: 'work-request',
              subjectRef: `invocation:${request.invocationRef}`,
            },
          })
        },
        buildInvocationStartedOutputJson(requestJson: string) {
          const request = JSON.parse(requestJson) as {
            roundRef: string
            executionNonce: string
          }
          return JSON.stringify({
            schemaVersion: 1,
            roundRef: request.roundRef,
            executionNonce: request.executionNonce,
            status: 'needs-input',
            summary: '等待兼容升级后的协作员工返回',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          })
        },
        validateReactionOutputJson(requestJson: string) {
          return (JSON.parse(requestJson) as { outputJson: string }).outputJson
        },
        resolveReactionSettlementJson(requestJson: string) {
          const request = JSON.parse(requestJson) as { outputJson: string }
          const output = JSON.parse(request.outputJson) as { summary: string }
          return JSON.stringify({
            schemaVersion: 1,
            caseState: 'waiting',
            terminalKind: null,
            blockReason: null,
            nextWorkItemRef: null,
            summary: output.summary,
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          })
        },
        buildInvocationResultOutputJson(requestJson: string) {
          const request = JSON.parse(requestJson) as {
            roundRef: string
            executionNonce: string
          }
          return JSON.stringify({
            schemaVersion: 1,
            roundRef: request.roundRef,
            executionNonce: request.executionNonce,
            status: 'ok',
            summary: '协作员工已返回',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          })
        },
      }
      const composeRuntime = (
        typePackage: EmployeeTypePackageRegistration,
        issues?: Array<{ reasonCode: string; resourceId: string }>,
      ) =>
        composeDigitalEmployee({
          db,
          appHome,
          typePackages: [typePackage],
          executionContracts: runtimeContracts,
          ...(issues === undefined
            ? {}
            : {
                onAutomaticUpgradeIssue: (issue) =>
                  issues.push({
                    reasonCode: issue.reasonCode,
                    resourceId: issue.resourceId,
                  }),
              }),
          now: () => now,
          id,
          runtime: {
            eventCenter: eventCenter.participant,
            codecs: [runtimeCodec],
            platformWorkItems: {
              async execute() {
                throw new Error('invocation upgrade fixture does not execute platform work')
              },
            },
            execution: {
              async launch() {
                throw new Error('invocation upgrade fixture does not launch business work')
              },
              async inspect() {
                return { kind: 'pending' as const, executionRef: 'unused' }
              },
              async cancel() {},
            },
          },
        })

      const v1 = composeRuntime(v1Package)
      const typeRef = { typeId: 'design', revision: 1 }
      const tool = await v1.commands.createTool({
        typeRef,
        workItemRef: 'design-work',
        actorUserId: 'invocation-owner',
        body: {
          displayName: '协作升级工具',
          description: '为升级恢复夹具提供完整岗位闭包',
          roleRef: 'primary',
          implementation: { kind: 'agent', agentRef: { id: 'design-agent', revision: 1 } },
        },
      })
      const toolRef = await v1.commands.publishTool({
        typeRef,
        workItemRef: 'design-work',
        toolId: tool.id,
        actorUserId: 'invocation-owner',
      })
      const targetJob = v1.commands.createJobTemplate({
        typeRef,
        actorUserId: 'invocation-owner',
        body: {
          name: '升级恢复目标岗位',
          description: '旧轮次冻结的目标员工岗位',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
          ],
        },
      })
      const targetJobRef = v1.commands.publishJobTemplate({
        id: targetJob.id,
        actorUserId: 'invocation-owner',
      })
      const target = v1.commands.createEmployee({
        typeRef,
        actorUserId: 'invocation-owner',
        body: {
          name: '升级恢复目标员工',
          jobTemplateRef: targetJobRef,
          workScope: { kind: 'global' },
        },
      })
      const targetV1Ref = { id: target.id, revision: target.revision }
      const parentJob = v1.commands.createJobTemplate({
        typeRef,
        actorUserId: 'invocation-owner',
        body: {
          name: '升级恢复父岗位',
          description: '冻结旧目标后由平台自动恢复',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
          ],
          defaultCollaborationBindings: [
            {
              workItemRef: 'delegate',
              memberRef: 'primary',
              targetEmployeeRef: targetV1Ref,
              invocationContractId: 'design.cross-work',
              joinMode: 'all',
              quorum: null,
            },
          ],
        },
      })
      const parentJobRef = v1.commands.publishJobTemplate({
        id: parentJob.id,
        actorUserId: 'invocation-owner',
      })
      const parent = v1.commands.createEmployee({
        typeRef,
        actorUserId: 'invocation-owner',
        body: {
          name: '升级恢复父员工',
          jobTemplateRef: parentJobRef,
          workScope: { kind: 'global' },
        },
      })
      const parentV1Ref = { id: parent.id, revision: parent.revision }
      const launched = v1.runtime!.commands.launch({
        employeeRef: parentV1Ref,
        primaryContextTypeId: 'design.work',
        primaryContextSchemaVersion: 1,
        primaryContextState: 'active',
        primaryContextJson: JSON.stringify({ status: 'active', title: '升级恢复委派' }),
        artifactRefs: [],
        workSubject: { typeId: 'work-request', subjectRef: 'UPGRADE-RECOVERY-1' },
      })
      const launchedRow = db
        .select()
        .from(employeeCases)
        .where(eq(employeeCases.id, launched.caseRef.id))
        .get()!
      db.update(employeeCases)
        .set({
          state: 'active',
          currentWorkItemRef: 'delegate',
          revision: launchedRow.revision + 1,
          updatedAt: ++now,
        })
        .where(eq(employeeCases.id, launched.caseRef.id))
        .run()

      const failedRoundId = v1.runtime!.worker.planOneReaction()!
      const failedRound = db
        .select()
        .from(employeeReactionRounds)
        .where(eq(employeeReactionRounds.id, failedRoundId))
        .get()!
      const failedPlan = JSON.parse(failedRound.planJson) as { implementationJson: string }
      const [frozenBinding] = JSON.parse(failedPlan.implementationJson) as Array<{
        memberRef: string
        targetEmployeeRef: { id: string; revision: number }
      }>
      const legacyInvocationId = `invocation:${failedRoundId}:${frozenBinding!.memberRef}`
      db.insert(employeeInvocations)
        .values({
          id: legacyInvocationId,
          idempotencyKey: `employee-invocation:${failedRoundId}:${frozenBinding!.memberRef}`,
          parentCaseId: launched.caseRef.id,
          parentRoundId: failedRoundId,
          targetEmployeeId: frozenBinding!.targetEmployeeRef.id,
          targetEmployeeRevision: frozenBinding!.targetEmployeeRef.revision,
          targetWorkScopeRefJson: JSON.stringify({ id: 'legacy-scope', revision: 1 }),
          inputEnvelopeRef: `reaction-round:${failedRoundId}`,
          inputDigest: '0'.repeat(64),
          completionContractRefJson: JSON.stringify({
            contractId: 'design.cross-work',
            resultSchemaId: 'design.delegated-result.v1',
            eventTypeRef: { id: 'design.employee-result', revision: 1 },
            sourceRef: { id: 'employee.channel', revision: 1 },
          }),
          deadlineAt: now + 60_000,
          childCaseId: null,
          state: 'requested',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      db.update(employeeReactionRounds)
        .set({
          state: 'failed',
          outputJson: JSON.stringify({
            kind: 'platform-dispatch-failed',
            outboxKind: 'invocation-create',
            detail: 'digital employee design@1 cannot start new work; upgrade it to design@2',
          }),
          updatedAt: ++now,
          settledAt: now,
        })
        .where(eq(employeeReactionRounds.id, failedRoundId))
        .run()
      const invocationOutbox = db
        .select()
        .from(employeeOsOutbox)
        .all()
        .find((row) => row.caseId === launched.caseRef.id && row.kind === 'invocation-create')!
      db.update(employeeOsOutbox)
        .set({ state: 'failed', attemptCount: 1, updatedAt: now })
        .where(eq(employeeOsOutbox.id, invocationOutbox.id))
        .run()
      const plannedCase = db
        .select()
        .from(employeeCases)
        .where(eq(employeeCases.id, launched.caseRef.id))
        .get()!
      db.update(employeeCases)
        .set({
          state: 'blocked',
          blockReason: 'legacy employee upgrade failure',
          activeRoundId: null,
          revision: plannedCase.revision + 1,
          updatedAt: ++now,
        })
        .where(eq(employeeCases.id, launched.caseRef.id))
        .run()

      const parentDefinition = db
        .select()
        .from(employeeDefinitions)
        .where(eq(employeeDefinitions.id, parent.id))
        .get()!
      db.update(employeeDefinitions)
        .set({
          configurationJson: JSON.stringify({
            ...JSON.parse(parentDefinition.configurationJson),
            workScope: { kind: 'global', legacyOnly: true },
          }),
          updatedAt: ++now,
        })
        .where(eq(employeeDefinitions.id, parent.id))
        .run()
      const v2Base = versionedCollaboratingDesignPackage(2)
      const v2Package: EmployeeTypePackageRegistration = {
        ...v2Base,
        parseWorkScopeJson(inputJson) {
          const scope = JSON.parse(inputJson) as { legacyOnly?: boolean }
          if (scope.legacyOnly === true) {
            throw new Error('the parent keeps an intentionally incompatible legacy scope')
          }
          return v2Base.parseWorkScopeJson(inputJson)
        },
      }
      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const v2 = composeRuntime(v2Package, issues)
      expect(v2.queries.getEmployee(target.id)).toMatchObject({ revision: 2 })
      expect(v2.queries.getEmployee(parent.id)).toMatchObject({
        revision: 1,
        typeRef: { typeId: 'design', revision: 1 },
      })
      expect(issues).toContainEqual({
        resourceId: parent.id,
        reasonCode: 'work-scope-incompatible',
      })
      const recoveredRoundId = v2.runtime!.worker.planOneReaction()!
      expect(recoveredRoundId).not.toBe(failedRoundId)

      let recoveredInvocation = db
        .select()
        .from(employeeInvocations)
        .where(eq(employeeInvocations.parentRoundId, recoveredRoundId))
        .get()
      for (let attempt = 0; attempt < 20 && recoveredInvocation === undefined; attempt += 1) {
        await v2.runtime!.worker.runOneOutbox()
        recoveredInvocation = db
          .select()
          .from(employeeInvocations)
          .where(eq(employeeInvocations.parentRoundId, recoveredRoundId))
          .get()
      }
      expect(recoveredInvocation).toMatchObject({
        targetEmployeeId: target.id,
        targetEmployeeRevision: 2,
        state: 'waiting',
        childCaseId: expect.any(String),
      })
      expect(
        db
          .select()
          .from(employeeInvocations)
          .where(eq(employeeInvocations.id, legacyInvocationId))
          .get(),
      ).toMatchObject({
        targetEmployeeId: target.id,
        targetEmployeeRevision: 1,
        state: 'requested',
        childCaseId: null,
      })
      expect(
        JSON.parse(v2.runtime!.queries.getCase(launched.caseRef.id).projectionJson).case,
      ).toMatchObject({ state: 'waiting', blockReason: null })
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('restarts upgrade custom tool -> job -> stable employee exactly once', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const original = await seedPublishedEmployee({ db, appHome })
      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const targetPackage = versionedDesignPackage(2, (descriptor) => {
        descriptor.description = {
          'zh-CN': '只增加展示说明的设计数字员工',
          'en-US': 'Design employee with a presentation-only update',
        }
      })

      const upgradedModule = createFixtureModule({
        db,
        appHome,
        typePackage: targetPackage,
        issues,
      })
      const upgraded = upgradedModule.queries.listLaunchableEmployees()

      expect(issues).toEqual([])
      expect(upgraded).toHaveLength(1)
      expect(upgraded[0]).toMatchObject({
        id: original.id,
        revision: 2,
        typeRef: { typeId: 'design', revision: 2 },
        ownerUserId: 'owner-1',
        visibility: 'private',
        workScope: { kind: 'global' },
      })
      expect(
        db
          .select()
          .from(employeeDefinitions)
          .all()
          .find((row) => row.id === original.id),
      ).toMatchObject({
        ownerUserId: 'owner-1',
        visibility: 'private',
        aclRevision: 0,
      })
      expect(
        upgradedModule.queries.listJobTemplates({ typeId: 'design', revision: 2 }),
      ).toHaveLength(1)
      expect(
        upgradedModule.queries.listTools({ typeId: 'design', revision: 2 }, 'design-work'),
      ).toHaveLength(1)

      const countsAfterUpgrade = {
        tools: db.select().from(employeeToolRegistrations).all().length,
        jobs: db.select().from(employeeJobTemplates).all().length,
        employees: db.select().from(employeeDefinitions).all().length,
        revisions: db.select().from(employeeDefinitionRevisions).all().length,
      }
      const replayedModule = createFixtureModule({
        db,
        appHome,
        typePackage: targetPackage,
        issues,
      })
      expect(replayedModule.queries.listLaunchableEmployees()[0]?.revision).toBe(2)
      expect({
        tools: db.select().from(employeeToolRegistrations).all().length,
        jobs: db.select().from(employeeJobTemplates).all().length,
        employees: db.select().from(employeeDefinitions).all().length,
        revisions: db.select().from(employeeDefinitionRevisions).all().length,
      }).toEqual(countsAfterUpgrade)

      const frozenRevisions = db
        .select()
        .from(employeeDefinitionRevisions)
        .all()
        .filter((row) => row.employeeId === original.id)
        .map((row) => ({
          revision: row.revision,
          typeRevision: JSON.parse(row.contentJson).typeRef.revision,
        }))
      expect(frozenRevisions).toEqual([
        { revision: 1, typeRevision: 1 },
        { revision: 2, typeRevision: 2 },
      ])
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  for (const source of [
    { ownerUserId: 'owner-1', visibility: 'private' as const },
    { ownerUserId: 'owner-1', visibility: 'public' as const },
    { ownerUserId: null, visibility: 'public' as const },
  ]) {
    test(`RFC-330 D18': successors inherit owner=${source.ownerUserId ?? 'null'} visibility=${source.visibility} and start with zero grants`, async () => {
      const appHome = mkdtempSync(join(tmpdir(), 'rfc330-auto-upgrade-acl-'))
      try {
        const db = createInMemoryDb(MIGRATIONS)
        await seedPublishedEmployee({ db, appHome })
        // 把 source 行（工具 + 模版 + 员工定义）改成本用例的归属 / 可见性，并各挂一条 grant——
        // successor 必须复制 owner + visibility（D18'），**不**复制 grants（用户裁定 D22）。
        const sourceTool = db.select().from(employeeToolRegistrations).all()[0]!
        const sourceJob = db.select().from(employeeJobTemplates).all()[0]!
        const sourceEmployee = db.select().from(employeeDefinitions).all()[0]!
        db.update(employeeToolRegistrations)
          .set({ ownerUserId: source.ownerUserId, visibility: source.visibility })
          .where(eq(employeeToolRegistrations.id, sourceTool.id))
          .run()
        db.update(employeeJobTemplates)
          .set({ ownerUserId: source.ownerUserId, visibility: source.visibility })
          .where(eq(employeeJobTemplates.id, sourceJob.id))
          .run()
        db.update(employeeDefinitions)
          .set({ ownerUserId: source.ownerUserId })
          .where(eq(employeeDefinitions.id, sourceEmployee.id))
          .run()
        db.insert(users)
          .values({
            id: 'grantee-1',
            username: 'grantee-1',
            displayName: 'grantee-1',
            role: 'user',
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
          })
          .run()
        db.insert(resourceGrants)
          .values([
            {
              resourceType: 'employee_tool',
              resourceId: sourceTool.id,
              userId: 'grantee-1',
              level: 'read',
              addedBy: 'seed',
              addedAt: 1,
            },
            {
              resourceType: 'employee_job_template',
              resourceId: sourceJob.id,
              userId: 'grantee-1',
              level: 'write',
              addedBy: 'seed',
              addedAt: 1,
            },
          ])
          .run()

        const issues: Array<{ reasonCode: string; resourceId: string }> = []
        createFixtureModule({ db, appHome, typePackage: versionedDesignPackage(2), issues })
        expect(issues).toEqual([])

        const successorTool = db
          .select()
          .from(employeeToolRegistrations)
          .all()
          .find((row) => row.typeRevision === 2)
        const successorJob = db
          .select()
          .from(employeeJobTemplates)
          .all()
          .find((row) => row.typeRevision === 2)
        expect(successorTool).toMatchObject({
          ownerUserId: source.ownerUserId,
          visibility: source.visibility,
          aclRevision: 0,
          name: '设计执行工具',
        })
        expect(successorJob).toMatchObject({
          ownerUserId: source.ownerUserId,
          visibility: source.visibility,
          aclRevision: 0,
          name: '产品设计岗位',
        })
        expect(
          db
            .select()
            .from(resourceGrants)
            .all()
            .filter(
              (row) => row.resourceId === successorTool!.id || row.resourceId === successorJob!.id,
            ),
        ).toEqual([])
      } finally {
        rmSync(appHome, { recursive: true, force: true })
      }
    })
  }

  test("RFC-330 D17': another owner's same-name template does not rename the successor", async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc330-auto-upgrade-other-owner-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const futureTypeRef = { typeId: 'design', revision: 2 }
      const future = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(2),
      })
      // 另一位 owner 在目标版本下已有同名模版：D17' 下它在别的 (owner) 分区，不是占位。
      const foreign = future.commands.createJobTemplate({
        typeRef: futureTypeRef,
        actorUserId: 'other-owner',
        body: {
          name: 'Standalone evolving job',
          description: 'Someone else already uses this name in the target revision.',
          defaultToolBindings: [],
        },
      })

      const v1 = createFixtureModule({ db, appHome, typePackage: versionedDesignPackage(1) })
      const typeRef = { typeId: 'design', revision: 1 }
      const tool = await v1.commands.createTool({
        typeRef,
        workItemRef: 'design-work',
        actorUserId: 'standalone-owner',
        body: {
          displayName: 'design-work tool',
          description: 'Published for a standalone job.',
          roleRef: 'primary',
          implementation: { kind: 'agent', agentRef: { id: 'design-work-agent', revision: 1 } },
        },
      })
      const toolRef = await v1.commands.publishTool({
        typeRef,
        workItemRef: 'design-work',
        toolId: tool.id,
        actorUserId: 'standalone-owner',
      })
      const published = v1.commands.createJobTemplate({
        typeRef,
        actorUserId: 'standalone-owner',
        body: {
          name: 'Standalone evolving job',
          description: 'The platform keeps one current descendant for this published job.',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
          ],
        },
      })
      v1.commands.publishJobTemplate({ id: published.id, actorUserId: 'standalone-owner' })

      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const v2 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(2),
        issues,
      })
      expect(issues).toEqual([])
      const v2Jobs = v2.queries.listJobTemplates(futureTypeRef)
      expect(v2Jobs).toHaveLength(2)
      const successor = v2Jobs.find((job) => job.publishedRevision !== null)
      expect(successor).toMatchObject({
        name: 'Standalone evolving job',
        ownerUserId: 'standalone-owner',
      })
      expect(successor?.id).not.toBe(foreign.id)
      expect(v2Jobs.find((job) => job.id === foreign.id)).toMatchObject({
        name: 'Standalone evolving job',
        ownerUserId: 'other-owner',
        publishedRevision: null,
      })
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('a target-rejected WorkContract successor stays pinned without partial writes', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-blocked-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const original = await seedPublishedEmployee({ db, appHome })
      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const incompatiblePackage = versionedDesignPackage(2, (descriptor) => {
        const contracts = descriptor.workContracts as Array<Record<string, unknown>>
        contracts[0]!.outputSchemaId = 'design.output.v2'
      })

      const module = createFixtureModule({
        db,
        appHome,
        typePackage: incompatiblePackage,
        issues,
        executionContracts: {
          ...executionContracts,
          async validateExecutor({ contractRef }) {
            return {
              schemaVersion: 1,
              contractRef,
              status: 'invalid',
              checks: [{ code: 'fixture-contract', ok: false, detail: 'target rejected' }],
            }
          },
        },
      })
      await module.maintenance.settleAutomaticUpgrades()

      expect(module.queries.listLaunchableEmployees()).toEqual([])
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reasonCode: 'work-contract-successor-invalid',
            resourceId: original.id,
          }),
        ]),
      )
      expect(db.select().from(employeeDefinitions).all()).toEqual([
        expect.objectContaining({
          id: original.id,
          typeRevision: 1,
          currentRevision: 1,
        }),
      ])
      expect(db.select().from(employeeDefinitionRevisions).all()).toHaveLength(1)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('changed WorkContract auto-upgrades after its target successor validates', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-revalidated-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const original = await seedPublishedEmployee({ db, appHome })
      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const compatiblePackage = versionedDesignPackage(2, (descriptor) => {
        const contracts = descriptor.workContracts as Array<Record<string, unknown>>
        contracts[0]!.version = 2
        contracts[0]!.outputSchemaId = 'design.output.v2'
        const workItems = (
          descriptor.authoringManifest as { workItems: Array<Record<string, unknown>> }
        ).workItems
        workItems[0]!.workContractRef = { contractId: 'design.perform-work', version: 2 }
      })

      const module = createFixtureModule({
        db,
        appHome,
        typePackage: compatiblePackage,
        issues,
      })
      issues.length = 0
      await module.maintenance.settleAutomaticUpgrades()

      expect(issues).toEqual([])
      expect(module.queries.getEmployee(original.id)).toMatchObject({
        id: original.id,
        revision: 2,
        typeRef: { typeId: 'design', revision: 2 },
        definition: {
          exactToolBindings: [
            expect.objectContaining({
              registrationRef: expect.objectContaining({ revision: 1 }),
            }),
          ],
        },
      })
      const migratedTool = db
        .select()
        .from(employeeToolRegistrations)
        .where(eq(employeeToolRegistrations.typeRevision, 2))
        .get()
      expect(migratedTool).toBeDefined()
      expect(
        (
          JSON.parse(migratedTool!.draftJson) as {
            content: { workContractRef: unknown }
          }
        ).content.workContractRef,
      ).toEqual({ contractId: 'design.perform-work', version: 2 })
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('a target scope codec rejection is diagnostic-only and never asks the user to upgrade', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-scope-blocked-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const original = await seedPublishedEmployee({ db, appHome })
      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const targetPackage = versionedDesignPackage(2)
      const incompatibleScopePackage: EmployeeTypePackageRegistration = {
        ...targetPackage,
        parseWorkScopeJson() {
          throw new Error('global scope was removed from the target codec')
        },
      }

      const module = createFixtureModule({
        db,
        appHome,
        typePackage: incompatibleScopePackage,
        issues,
      })

      expect(module.queries.listLaunchableEmployees()).toEqual([])
      expect(issues).toEqual([
        expect.objectContaining({
          reasonCode: 'work-scope-incompatible',
          resourceId: original.id,
        }),
      ])
      // The independently valid published job closure still migrates; only the
      // employee definition is pinned by its incompatible scope.
      expect(db.select().from(employeeJobTemplates).all()).toHaveLength(2)
      expect(db.select().from(employeeToolRegistrations).all()).toHaveLength(2)
      expect(db.select().from(employeeDefinitionRevisions).all()).toHaveLength(1)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('platform tools migrate only through a provider-validated target successor', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-platform-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const platformTools = platformToolCatalog()
      const v1 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(1),
        platformTools,
      })
      const sourceRef = JSON.parse(
        platformTools.getRevisionJson(
          JSON.stringify({
            id: 'platform-fixture:design:1:design-work:platform-design-agent',
            revision: 101,
          }),
        )!,
      ).ref as { id: string; revision: number }
      const job = v1.commands.createJobTemplate({
        typeRef: { typeId: 'design', revision: 1 },
        actorUserId: 'owner-platform',
        body: {
          name: '平台工具岗位',
          description: '不允许公共层解析 provider 私有 ID',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: sourceRef },
          ],
        },
      })
      const jobRef = v1.commands.publishJobTemplate({
        id: job.id,
        actorUserId: 'owner-platform',
      })
      const employee = v1.commands.createEmployee({
        typeRef: { typeId: 'design', revision: 1 },
        actorUserId: 'owner-platform',
        body: {
          name: '平台工具数字员工',
          jobTemplateRef: jobRef,
          workScope: { kind: 'global' },
        },
      })

      const v2 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(2),
        platformTools,
        idPrefix: 'platform-v2',
      })
      expect(v2.queries.listLaunchableEmployees()).toEqual([
        expect.objectContaining({
          id: employee.id,
          revision: 2,
          typeRef: { typeId: 'design', revision: 2 },
        }),
      ])
      expect(db.select().from(employeeToolRegistrations).all()).toEqual([])
      expect(
        v2.queries.listJobTemplates({ typeId: 'design', revision: 2 })[0]?.draft
          .defaultToolBindings[0]?.registrationRef,
      ).toEqual({
        id: 'platform-fixture:design:2:design-work:platform-design-agent',
        revision: 102,
      })

      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const v3 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(3, (descriptor) => {
          const contracts = descriptor.workContracts as Array<Record<string, unknown>>
          contracts[0]!.outputSchemaId = 'design.output.v3'
        }),
        platformTools,
        issues,
        idPrefix: 'platform-v3',
      })
      expect(issues).toEqual([])
      expect(v3.queries.listLaunchableEmployees()).toEqual([
        expect.objectContaining({
          id: employee.id,
          revision: 3,
          typeRef: { typeId: 'design', revision: 3 },
        }),
      ])
      expect(v3.queries.getEmployee(employee.id)).toMatchObject({
        id: employee.id,
        revision: 3,
        typeRef: { typeId: 'design', revision: 3 },
      })
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})
