import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createSession } from '@/auth/sessionStore'
import { createInMemoryDb } from '@/db/client'
import { employeeTypePackages } from '@/db/schema'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composeDigitalEmployee,
  readPersistedDigitalEmployeeTypePackageDescriptorJsons,
} from '@/modules/digital-employee/composition'
import { isEmployeeReactionEventEnabled } from '@/modules/digital-employee/application/runtimeService'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'
import { inspectExecutionContractWorkflowDefinition } from '@/modules/execution-contract/infrastructure/taskExecutionAdapter'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import {
  effectiveReactionPriority,
  employeeTypePackageDescriptorSchema,
  mergeExactAdapterBindings,
  reactionLaneIds,
  type LaneAdapterBinding,
  validateTypePackage,
} from '@/modules/digital-employee/domain/model'
import { employeeWorkIntakeSchema } from '@/modules/digital-employee/domain/runtimeModel'
import { buildDigitalEmployeeFixedPrompt } from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { createApp } from '@/server'
import {
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'
import { listAgents } from '@/services/agent'
import { createUser } from '@/services/users'
import {
  designEmployeeTypePackage,
  testEmployeeTypePackage,
} from './fixtures/digitalEmployeeTypePackages'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []
const developmentContractRefs = developmentExecutionContractRegistrations.map(
  (registration) => registration.contractRef,
)

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function developmentExecutionContracts(): ExecutionContractParticipant {
  return new ExecutionContractService({
    registrations: developmentExecutionContractRegistrations,
    resources: {
      async inspect({ implementation }) {
        return {
          kind: implementation.kind,
          name:
            implementation.kind === 'agent'
              ? implementation.agentRef.id
              : implementation.workflowRef.id,
          available: true,
          detail: 'test exact executor',
          declaredContractRefs: implementation.kind === 'agent' ? developmentContractRefs : null,
        }
      },
    },
    programFixtures: {
      async validate() {
        return [{ code: 'test-program-fixture', ok: true, detail: 'exact test fixture' }]
      },
    },
  })
}

const genericExecutionContracts: ExecutionContractParticipant = {
  list: () => [],
  get: () => {
    throw new Error('generic authoring test does not execute a reaction')
  },
  async validateExecutor({ contractRef }) {
    return {
      schemaVersion: 1,
      contractRef,
      status: 'valid',
      checks: [{ code: 'generic-platform-contract', ok: true, detail: 'test contract' }],
    }
  },
  async validateAgentCandidates() {
    return []
  },
  validateEnvelope() {
    throw new Error('generic authoring test does not settle a reaction')
  },
}

function fixtureModule(retryLimits?: {
  current(): { defaultNodeRetries: number; sessionRestartBudget: number }
}) {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc310-os-authoring-'))
  roots.push(appHome)
  let ordinal = 0
  return composeDigitalEmployee({
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    typePackages: [developmentEmployeeTypePackage],
    executionContracts: developmentExecutionContracts(),
    ...(retryLimits === undefined ? {} : { retryLimits }),
    id: () => `resource-${++ordinal}`,
    now: () => 1_000 + ordinal,
    connectionCatalog: {
      resolve(ref) {
        if (ref.id === 'missing-adapter') return null
        const purpose = ref.id.startsWith('pipeline-adapter') ? 'pipeline-gate' : 'approval-gateway'
        const available = ref.id !== 'pipeline-adapter-archived'
        const visible = ref.id !== 'pipeline-adapter-hidden'
        return {
          ref,
          purpose,
          available,
          visible,
          contentDigest: '0'.repeat(64),
          closureSummary: `${ref.id}; ${purpose}; ${available ? 'available' : 'archived'}; ${visible ? 'visible' : 'not visible'}`,
        }
      },
    },
  })
}

describe('RFC-310 Digital Employee OS authoring hierarchy', () => {
  test('type packages declare complete responsibility lanes for deterministic graph layout', () => {
    const descriptor = employeeTypePackageDescriptorSchema.parse(
      JSON.parse(developmentEmployeeTypePackage.descriptorJson),
    )
    const care = descriptor.authoringManifest.lifecycleRegions.find(
      (region) => region.regionId === 'care',
    )!
    const delivery = descriptor.authoringManifest.lifecycleRegions.find(
      (region) => region.regionId === 'delivery',
    )!

    expect(descriptor.typeRef).toEqual({ typeId: 'development', revision: 10 })
    expect(descriptor.authoringManifest.workItems).toHaveLength(20)
    expect(descriptor.authoringManifest.workIngresses).toEqual([
      {
        ingressRef: 'ui-input',
        regionId: 'delivery',
        responsibilityLaneId: 'delivery-main',
        order: 0,
        label: { 'zh-CN': '界面输入', 'en-US': 'UI input' },
        valueLabel: { 'zh-CN': '任务', 'en-US': 'Task' },
        description: {
          'zh-CN': '从统一新建任务界面输入正文、文件或外部需求编号',
          'en-US': 'Enter a body, files, or an external requirement ID in unified task creation',
        },
        sourceClass: 'manual',
        eventTypeRefs: [],
        configurationSurface: 'task-creation',
        nextWorkItemRef: 'prepare-materials',
      },
      {
        ingressRef: 'issue',
        regionId: 'delivery',
        responsibilityLaneId: 'delivery-main',
        order: 10,
        label: { 'zh-CN': 'ISSUE', 'en-US': 'ISSUE' },
        valueLabel: { 'zh-CN': 'Webhook', 'en-US': 'Webhook' },
        description: {
          'zh-CN': '在 Webhook 自动化规则中把 ISSUE 事件交给这名数字员工',
          'en-US': 'Route ISSUE events to this employee with a Webhook automation rule',
        },
        sourceClass: 'issue',
        eventTypeRefs: [
          { id: 'code-host.issue.labeled', revision: 1 },
          { id: 'code-host.issue.comment-received', revision: 1 },
        ],
        configurationSurface: 'event-response-rules',
        nextWorkItemRef: 'prepare-materials',
      },
    ])

    expect(care.responsibilityLanes.map((lane) => lane.laneId)).toEqual([
      'care-attention',
      'care-review',
      'care-pipeline',
      'care-conflict',
      'care-collaboration',
      'care-approval',
      'care-readiness',
    ])
    expect(
      delivery.responsibilityLanes.find((lane) => lane.laneId === 'delivery-main')?.adapterSlots,
    ).toEqual([])
    expect(
      care.responsibilityLanes.find((lane) => lane.laneId === 'care-pipeline')?.adapterSlots,
    ).toEqual([
      expect.objectContaining({
        slotRef: 'primary',
        purpose: 'pipeline-gate',
        requiredWhenLaneEnabled: true,
      }),
    ])
    expect(
      care.responsibilityLanes.find((lane) => lane.laneId === 'care-approval')?.adapterSlots,
    ).toEqual([
      expect.objectContaining({
        slotRef: 'primary',
        purpose: 'approval-gateway',
        requiredWhenLaneEnabled: true,
      }),
    ])
    const workItems = new Map(
      descriptor.authoringManifest.workItems.map((item) => [item.workItemRef, item] as const),
    )
    expect(workItems.get('analyze-implement')?.nextWorkItemRefs).toEqual(['prepare-change'])
    expect(workItems.get('analyze-implement')?.label).toEqual({
      'zh-CN': '实现变更',
      'en-US': 'Implement change',
    })
    expect(workItems.get('analyze-implement')?.humanReview).toMatchObject({
      optionRef: 'review-implementation-plan',
      artifactPort: 'analysis-plan',
      planningRoleRef: 'planning',
      planningSlotRef: 'plan',
      label: { 'zh-CN': '人工审核方案', 'en-US': 'Human plan review' },
      reviewedPath: {
        beforeReviewLabel: {
          'zh-CN': '编写实现方案',
          'en-US': 'Write implementation plan',
        },
        afterApprovalLabel: { 'zh-CN': '实现变更', 'en-US': 'Implement change' },
      },
    })
    expect(workItems.get('analyze-implement')?.toolRoleGroups).toContainEqual(
      expect.objectContaining({
        roleRef: 'planning',
        workContractRef: { contractId: 'development.plan-implementation', version: 2 },
        bindingSlots: [expect.objectContaining({ slotRef: 'plan', required: false })],
      }),
    )
    expect(workItems.get('repair-pipeline')?.nextWorkItemRefs).toEqual([
      'repair-pipeline',
      'delegate',
      'prepare-change',
    ])
    expect(workItems.get('observe-mr')?.nextWorkItemRefs).toEqual([
      'classify-feedback',
      'collect-pipeline',
      'repair-conflict',
      'prepare-approval',
      'evaluate-ready',
    ])
    expect(workItems.get('classify-feedback')).toMatchObject({
      nodeKind: 'system',
      toolRoleGroups: [],
      nextWorkItemRefs: ['acknowledge-feedback'],
    })
    expect(workItems.get('acknowledge-feedback')?.nextWorkItemRefs).toEqual([
      'repair-feedback',
      'observe-mr',
    ])
    expect(workItems.get('repair-feedback')).toMatchObject({
      nodeKind: 'business-tool',
      inputMultiplicity: 'collection',
    })
    expect(
      [...workItems.values()]
        .filter((item) => item.inputMultiplicity === 'collection')
        .map((item) => item.workItemRef),
    ).toEqual(['repair-feedback'])
    expect(workItems.get('delegate')).toMatchObject({
      responsibilityLaneId: 'care-collaboration',
      nextWorkItemRefs: ['collect-pipeline'],
    })
    expect(workItems.get('prepare-approval')?.responsibilityLaneId).toBe('care-approval')
    expect(descriptor.reactionRules.find((rule) => rule.ruleId === 'handle-review')).toMatchObject({
      requiredContextTypes: [
        'development.issue-handling',
        'development.merge-request',
        'development.pipeline',
      ],
      optionalContextTypes: ['development.problem-set', 'development.review-resolution'],
      capabilityWorkItemRef: 'classify-feedback',
      workItemRef: 'observe-mr',
      slotRef: 'system',
    })
    expect(
      descriptor.reactionRules.find((rule) => rule.ruleId === 'handle-pipeline'),
    ).toMatchObject({
      requiredContextTypes: [
        'development.issue-handling',
        'development.merge-request',
        'development.pipeline',
      ],
      workItemRef: 'collect-pipeline',
      slotRef: 'system',
    })
    expect(
      descriptor.attentionRules
        .find((rule) => rule.ruleId === 'watch-merge-request')
        ?.subscriptions.map((subscription) => subscription.eventTypeId),
    ).toEqual([
      'development.review-updated',
      'development.conflict-updated',
      'development.lifecycle-updated',
    ])
    expect(
      descriptor.attentionRules
        .find((rule) => rule.ruleId === 'watch-pipeline-gate')
        ?.subscriptions.map((subscription) => subscription.eventTypeId),
    ).toEqual(['development.pipeline-check-due'])
    expect(reactionLaneIds(descriptor)).toEqual([
      'care-review',
      'care-approval',
      'care-conflict',
      'care-pipeline',
      'care-collaboration',
    ])
    const reviewRule = descriptor.reactionRules.find((rule) => rule.ruleId === 'handle-review')!
    const pipelineRule = descriptor.reactionRules.find((rule) => rule.ruleId === 'handle-pipeline')!
    const lifecycleRule = descriptor.reactionRules.find(
      (rule) => rule.ruleId === 'handle-lifecycle',
    )!
    const pipelineFirst = [
      'care-pipeline',
      'care-review',
      'care-conflict',
      'care-collaboration',
      'care-approval',
    ]
    expect(
      effectiveReactionPriority({
        descriptor,
        reactionLaneOrder: pipelineFirst,
        rule: pipelineRule,
      }),
    ).toBeGreaterThan(
      effectiveReactionPriority({
        descriptor,
        reactionLaneOrder: pipelineFirst,
        rule: reviewRule,
      }),
    )
    expect(
      effectiveReactionPriority({
        descriptor,
        reactionLaneOrder: pipelineFirst,
        rule: lifecycleRule,
      }),
    ).toBeGreaterThan(
      effectiveReactionPriority({
        descriptor,
        reactionLaneOrder: pipelineFirst,
        rule: pipelineRule,
      }),
    )
    expect(
      descriptor.reactionRules.find((rule) => rule.ruleId === 'handle-conflict'),
    ).toMatchObject({
      requiredContextTypes: [
        'development.issue-handling',
        'development.merge-request',
        'development.pipeline',
      ],
      optionalContextTypes: ['development.problem-set', 'development.review-resolution'],
      capabilityWorkItemRef: 'repair-conflict',
      workItemRef: 'observe-mr',
      slotRef: 'system',
    })
    expect(
      descriptor.reactionRules.find((rule) => rule.ruleId === 'handle-lifecycle'),
    ).toMatchObject({
      requiredContextTypes: ['development.merge-request', 'development.pipeline'],
      optionalContextTypes: ['development.problem-set', 'development.review-resolution'],
    })
    expect(validateTypePackage(descriptor)).toEqual([])

    const invalid = structuredClone(descriptor)
    invalid.authoringManifest.workItems[0]!.responsibilityLaneId = 'missing-lane'
    expect(validateTypePackage(invalid)).toContainEqual({
      code: 'unknown-responsibility-lane',
      at: `workItems.${invalid.authoringManifest.workItems[0]!.workItemRef}.responsibilityLaneId`,
      detail: 'missing-lane',
    })
    const duplicateIngress = structuredClone(descriptor)
    duplicateIngress.authoringManifest.workIngresses.push(
      structuredClone(duplicateIngress.authoringManifest.workIngresses[1]!),
    )
    expect(validateTypePackage(duplicateIngress)).toContainEqual({
      code: 'duplicate-identity',
      at: 'authoringManifest.workIngresses',
      detail: 'issue',
    })
    const invalidIngressLane = structuredClone(descriptor)
    invalidIngressLane.authoringManifest.workIngresses[1]!.responsibilityLaneId = 'missing-lane'
    expect(validateTypePackage(invalidIngressLane)).toContainEqual({
      code: 'unknown-responsibility-lane',
      at: 'workIngresses.issue.responsibilityLaneId',
      detail: 'missing-lane',
    })
    const invalidIngressNext = structuredClone(descriptor)
    invalidIngressNext.authoringManifest.workIngresses[1]!.nextWorkItemRef = 'analyze-implement'
    expect(validateTypePackage(invalidIngressNext)).toContainEqual({
      code: 'work-ingress-next-not-work-start',
      at: 'workIngresses.issue.nextWorkItemRef',
      detail: 'analyze-implement',
    })
    const missingIngressNext = structuredClone(descriptor)
    missingIngressNext.authoringManifest.workIngresses[1]!.nextWorkItemRef = 'missing-work-item'
    expect(validateTypePackage(missingIngressNext)).toContainEqual({
      code: 'unknown-work-item',
      at: 'workIngresses.issue.nextWorkItemRef',
      detail: 'missing-work-item',
    })
    const missingEventType = structuredClone(descriptor)
    missingEventType.authoringManifest.workIngresses[1]!.eventTypeRefs = []
    expect(validateTypePackage(missingEventType)).toContainEqual({
      code: 'work-ingress-event-type-required',
      at: 'workIngresses.issue.eventTypeRefs',
      detail: 'issue',
    })
    const eventOnUiInput = structuredClone(descriptor)
    eventOnUiInput.authoringManifest.workIngresses[0]!.eventTypeRefs = [
      { id: 'code-host.issue.labeled', revision: 1 },
    ]
    expect(validateTypePackage(eventOnUiInput)).toContainEqual({
      code: 'work-ingress-event-type-not-applicable',
      at: 'workIngresses.ui-input.eventTypeRefs',
      detail: 'ui-input',
    })
    const invalidCapability = structuredClone(descriptor)
    invalidCapability.reactionRules[0]!.capabilityWorkItemRef = 'missing-capability'
    expect(validateTypePackage(invalidCapability)).toContainEqual({
      code: 'unknown-capability-work-item',
      at: `reactionRules.${invalidCapability.reactionRules[0]!.ruleId}.capabilityWorkItemRef`,
      detail: 'missing-capability',
    })
    const duplicateAdapterSlot = structuredClone(descriptor)
    const pipelineLane = duplicateAdapterSlot.authoringManifest.lifecycleRegions
      .flatMap((region) => region.responsibilityLanes)
      .find((lane) => lane.laneId === 'care-pipeline')!
    pipelineLane.adapterSlots.push(structuredClone(pipelineLane.adapterSlots[0]!))
    expect(validateTypePackage(duplicateAdapterSlot)).toContainEqual({
      code: 'duplicate-identity',
      at: 'authoringManifest.lifecycleRegions.care.responsibilityLanes.care-pipeline.adapterSlots',
      detail: 'primary',
    })
    const duplicateAdapterPurpose = structuredClone(descriptor)
    const duplicatePurposeLane = duplicateAdapterPurpose.authoringManifest.lifecycleRegions
      .flatMap((region) => region.responsibilityLanes)
      .find((lane) => lane.laneId === 'care-pipeline')!
    duplicatePurposeLane.adapterSlots.push({
      ...structuredClone(duplicatePurposeLane.adapterSlots[0]!),
      slotRef: 'secondary',
    })
    expect(validateTypePackage(duplicateAdapterPurpose)).toContainEqual({
      code: 'duplicate-identity',
      at: 'authoringManifest.lifecycleRegions.care.responsibilityLanes.care-pipeline.adapterPurposes',
      detail: 'pipeline-gate',
    })
    const stagedOptionalAdapterSlot = structuredClone(descriptor)
    const stagedOptionalLane = stagedOptionalAdapterSlot.authoringManifest.lifecycleRegions
      .flatMap((region) => region.responsibilityLanes)
      .find((lane) => lane.laneId === 'care-pipeline')!
    stagedOptionalLane.adapterSlots.push({
      ...structuredClone(stagedOptionalLane.adapterSlots[0]!),
      slotRef: 'future-classifier',
      purpose: 'pipeline-classifier',
      requiredWhenLaneEnabled: false,
    })
    expect(validateTypePackage(stagedOptionalAdapterSlot)).toEqual([])
    const invalidAdapterPurpose = structuredClone(descriptor) as unknown as {
      authoringManifest: {
        lifecycleRegions: Array<{
          responsibilityLanes: Array<{
            laneId: string
            adapterSlots: Array<{ purpose: string }>
          }>
        }>
      }
    }
    invalidAdapterPurpose.authoringManifest.lifecycleRegions
      .flatMap((region) => region.responsibilityLanes)
      .find((lane) => lane.laneId === 'care-pipeline')!.adapterSlots[0]!.purpose = 'shell'
    expect(employeeTypePackageDescriptorSchema.safeParse(invalidAdapterPurpose).success).toBe(false)
  })

  test('lane Adapter bindings merge defaults and employee overrides over the manifest closed set', () => {
    const descriptor = employeeTypePackageDescriptorSchema.parse(
      JSON.parse(developmentEmployeeTypePackage.descriptorJson),
    )
    const manifest = descriptor.authoringManifest
    const inherited: LaneAdapterBinding = {
      laneId: 'care-pipeline',
      slotRef: 'primary',
      adapterRef: { id: 'pipeline-default', revision: 3 },
    }
    const override: LaneAdapterBinding = {
      ...inherited,
      adapterRef: { id: 'pipeline-employee', revision: 7 },
    }
    expect(
      mergeExactAdapterBindings({
        manifest,
        defaults: [inherited],
        overrides: [override],
        enabledWorkItemRefs: ['classify-pipeline'],
      }),
    ).toEqual({ bindings: [override], violations: [] })
    expect(
      mergeExactAdapterBindings({
        manifest,
        defaults: [],
        overrides: [],
        enabledWorkItemRefs: ['classify-pipeline'],
      }).violations,
    ).toContainEqual({
      code: 'required-lane-adapter-binding-missing',
      at: 'responsibilityLanes.care-pipeline',
      detail: 'care-pipeline/primary',
    })
    expect(
      mergeExactAdapterBindings({
        manifest,
        defaults: [inherited, inherited],
        overrides: [],
        enabledWorkItemRefs: [],
      }).violations,
    ).toContainEqual({
      code: 'duplicate-lane-adapter-binding',
      at: 'jobTemplate.defaultAdapterBindings',
      detail: 'care-pipeline/primary',
    })
    expect(
      mergeExactAdapterBindings({
        manifest,
        defaults: [
          {
            laneId: 'care-pipeline',
            slotRef: 'missing',
            adapterRef: { id: 'pipeline-default', revision: 3 },
          },
        ],
        overrides: [],
        enabledWorkItemRefs: [],
      }).violations,
    ).toContainEqual({
      code: 'unknown-lane-adapter-slot',
      at: 'jobTemplate.defaultAdapterBindings',
      detail: 'care-pipeline/missing',
    })
  })

  test('pipeline attention is active only while the current head gate is pending', () => {
    const attentionEventIds = (contextTypeId: string, state: object) =>
      (
        JSON.parse(
          developmentEmployeeRuntimeCodec.resolveAttentionSubjectsJson(
            contextTypeId,
            JSON.stringify(state),
          ),
        ) as Array<{ eventTypeRef: { id: string } }>
      ).map((subject) => subject.eventTypeRef.id)

    const mergeRequest = {
      status: 'active',
      mergeRequestRef: 'repo!42',
      headSha: 'a'.repeat(40),
      issueHandlingContextRef: 'issue-context',
      readyToMerge: false,
    }
    expect(attentionEventIds('development.merge-request', mergeRequest)).toEqual([
      'development.review-updated',
      'development.conflict-updated',
      'development.lifecycle-updated',
    ])

    const pipeline = {
      status: 'pending',
      mergeRequestRef: 'repo!42',
      headSha: 'a'.repeat(40),
      evidenceArtifactRef: '.agent-workflow/pipeline/case-1/',
      failureTypes: [],
    }
    expect(attentionEventIds('development.pipeline', pipeline)).toEqual([
      'development.pipeline-check-due',
    ])
    expect(attentionEventIds('development.pipeline', { ...pipeline, status: 'passed' })).toEqual([])
    expect(
      attentionEventIds('development.pipeline', {
        ...pipeline,
        status: 'failed',
        failureTypes: ['test'],
      }),
    ).toEqual([])
  })

  test('HTTP names malformed type refs and empty or declared-oversized uploads', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-authoring-route-errors-'))
    roots.push(appHome)
    const app = createApp({
      token: 'a'.repeat(64),
      configPath: join(appHome, 'config.json'),
      appHome,
      opencodeVersion: null,
      dbVersion: 1,
      db,
    })
    const admin = await createUser(db, {
      username: 'authoring-route-admin',
      displayName: 'Authoring Route Admin',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const session = await createSession({ db, userId: admin.id })
    const authorization = { Authorization: `Bearer ${session.token}` }

    const malformedType = await app.request('/api/digital-employee-types/development', {
      headers: authorization,
    })
    expect(malformedType.status).toBe(422)
    expect(await malformedType.json()).toMatchObject({ code: 'employee-type-ref-invalid' })

    const malformedContract = await app.request('/api/execution-contracts/not-a-ref', {
      headers: authorization,
    })
    expect(malformedContract.status).toBe(422)
    expect(await malformedContract.json()).toMatchObject({ code: 'execution-contract-ref-invalid' })

    const emptyUpload = await app.request('/api/digital-employee-input-uploads', {
      method: 'POST',
      headers: authorization,
      body: new Uint8Array(),
    })
    expect(emptyUpload.status).toBe(422)
    expect(await emptyUpload.json()).toMatchObject({ code: 'employee-upload-empty' })

    const oversizedUpload = await app.request('/api/digital-employee-input-uploads', {
      method: 'POST',
      headers: {
        ...authorization,
        'content-length': String(32 * 1024 * 1024 + 1),
      },
      body: new Uint8Array([1]),
    })
    expect(oversizedUpload.status).toBe(422)
    expect(await oversizedUpload.json()).toMatchObject({ code: 'employee-upload-too-large' })

    const removedPublishEndpoint = await app.request(
      '/api/digital-employees/no-longer-two-phase/publish',
      { method: 'POST', headers: authorization },
    )
    expect(removedPublishEndpoint.status).toBe(404)

    const removedUpgradeCandidates = await app.request(
      '/api/digital-employee-types/development@9/upgrade-candidates',
      { headers: authorization },
    )
    expect(removedUpgradeCandidates.status).toBe(404)
    const removedEmployeeUpgrade = await app.request(
      '/api/digital-employee-types/development@9/employees/legacy/upgrade',
      { method: 'POST', headers: authorization, body: '{}' },
    )
    expect(removedEmployeeUpgrade.status).toBe(404)
  })

  test('pure migrations stay resource-empty and daemon seeding installs Agent templates once', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    expect(await listAgents(db)).toEqual([])

    await ensureDigitalEmployeeAgentTemplates(db)
    await ensureDigitalEmployeeAgentTemplates(db)

    const templates = await listDigitalEmployeeAgentTemplates(db)
    expect(templates).toHaveLength(8)
    expect(templates.map((template) => template.frontmatterExtra.digitalEmployeeTemplate)).toEqual([
      'code-writing',
      'problem-diagnosis',
      'pipeline-repair',
      'review-repair',
      'conflict-repair',
      'business-implementation',
      'issue-repair',
      'implementation-planning',
    ])
    expect(
      templates.every((template) => template.builtin && template.visibility === 'public'),
    ).toBe(true)
    expect(await listAgents(db)).toHaveLength(16)

    const historicalDescriptorJson = JSON.stringify({
      typeRef: { typeId: 'development', revision: 8 },
      workContracts: [{ contractId: 'development.repair-feedback', version: 1 }],
      authoringManifest: {
        workItems: [
          {
            workItemRef: 'repair-feedback',
            nodeKind: 'business-tool',
            workContractRef: { contractId: 'development.repair-feedback', version: 1 },
            toolRoleGroups: [{ roleRef: 'primary' }],
          },
        ],
      },
    })
    db.insert(employeeTypePackages)
      .values({
        typeId: 'development',
        revision: 8,
        descriptorJson: historicalDescriptorJson,
        descriptorDigest: 'historical-development-8',
        state: 'published',
        registeredAt: 1,
      })
      .run()

    // User regression 2026-08-22: the classifier's problem list must be part
    // of the exact tool revision, while the built-in repair Agent explicitly
    // declares that it can solve every problem emitted by that classifier.
    const catalog = composeDigitalEmployeeBuiltinToolCatalog({
      db,
      typePackageDescriptorJsons: [
        ...readPersistedDigitalEmployeeTypePackageDescriptorJsons(db),
        developmentEmployeeTypePackage.descriptorJson,
      ],
    })
    const classifierTools = JSON.parse(
      catalog.listJson(
        JSON.stringify({ typeId: 'development', revision: 10 }),
        'classify-pipeline',
      ),
    ) as Array<{
      content: {
        dispatchRouteDefinitions?: Array<{ routeRef: string; fallback: boolean }>
      }
    }>
    expect(classifierTools).toHaveLength(1)
    expect(classifierTools[0]?.content.dispatchRouteDefinitions).toEqual([
      expect.objectContaining({ routeRef: 'compile-error', fallback: false }),
      expect.objectContaining({ routeRef: 'test-failure', fallback: false }),
      expect.objectContaining({ routeRef: 'quality-gate-failure', fallback: false }),
      expect.objectContaining({ routeRef: 'dependency-or-environment', fallback: false }),
      expect.objectContaining({ routeRef: 'other-pipeline-failure', fallback: true }),
    ])
    const repairTools = JSON.parse(
      catalog.listJson(JSON.stringify({ typeId: 'development', revision: 10 }), 'repair-pipeline'),
    ) as Array<{
      content: {
        acceptedDispatchRoutes?: Array<{
          classifierWorkItemRef: string
          routeRefs: string[]
        }>
      }
    }>
    expect(repairTools).toHaveLength(1)
    expect(repairTools[0]?.content.acceptedDispatchRoutes).toEqual([
      { classifierWorkItemRef: 'classify-pipeline', routeRefs: ['*'] },
    ])
    const analyzeTools = JSON.parse(
      catalog.listJson(
        JSON.stringify({ typeId: 'development', revision: 10 }),
        'analyze-implement',
      ),
    ) as Array<{
      selection: string
      content: {
        roleRef: string
        workContractRef: { contractId: string; version: number }
        implementation: { kind: string; agentRef?: { id: string } }
      }
    }>
    expect(analyzeTools).toContainEqual(
      expect.objectContaining({
        selection: 'selectable',
        content: expect.objectContaining({
          roleRef: 'planning',
          workContractRef: { contractId: 'development.plan-implementation', version: 2 },
          implementation: expect.objectContaining({ kind: 'agent' }),
        }),
      }),
    )
    const historicalReviewTools = JSON.parse(
      catalog.listJson(JSON.stringify({ typeId: 'development', revision: 8 }), 'repair-feedback'),
    ) as Array<{ id: string; publishedRevision: number }>
    expect(historicalReviewTools).toHaveLength(1)
    expect(historicalReviewTools[0]?.id).toContain(
      'platform:employee-tool:development:8:repair-feedback:',
    )
    expect(
      catalog.getRevisionJson(
        JSON.stringify({
          id: historicalReviewTools[0]!.id,
          revision: historicalReviewTools[0]!.publishedRevision,
        }),
      ),
    ).not.toBeNull()
  })

  test('classifier tools own problem definitions and repair tools declare exact capabilities', async () => {
    const module = fixtureModule()
    const typeRef = { typeId: 'development', revision: 10 }
    const classifierBody = {
      displayName: '两类流水线问题识别工具',
      description: '工具版本拥有有序问题清单',
      roleRef: 'primary',
      implementation: {
        kind: 'agent' as const,
        agentRef: { id: 'agent-classifier', revision: 1 },
      },
      dispatchRouteDefinitions: [
        {
          routeRef: 'compile-error',
          displayName: '编译错误',
          description: '编译或类型检查失败',
          fallback: false,
        },
        {
          routeRef: 'other-pipeline-failure',
          displayName: '其他流水线错误',
          description: '没有命中前序问题时的兜底',
          fallback: true,
        },
      ],
    }

    await expect(
      module.commands.createTool({
        typeRef,
        workItemRef: 'classify-pipeline',
        actorUserId: 'author',
        body: { ...classifierBody, dispatchRouteDefinitions: undefined },
      }),
    ).rejects.toThrow('classifier tools must define their ordered dispatch routes')

    const classifier = await module.commands.createTool({
      typeRef,
      workItemRef: 'classify-pipeline',
      actorUserId: 'author',
      body: classifierBody,
    })
    const classifierRef = await module.commands.publishTool({
      typeRef,
      workItemRef: 'classify-pipeline',
      toolId: classifier.id,
      actorUserId: 'author',
    })

    const repairBody = {
      displayName: '编译与其他问题修复工具',
      description: '显式声明可解决多个问题',
      roleRef: 'repairer',
      implementation: {
        kind: 'agent' as const,
        agentRef: { id: 'agent-repair', revision: 1 },
      },
    }
    await expect(
      module.commands.createTool({
        typeRef,
        workItemRef: 'repair-pipeline',
        actorUserId: 'author',
        body: repairBody,
      }),
    ).rejects.toThrow('dispatch destination tools must declare accepted routes')
    const repair = await module.commands.createTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      actorUserId: 'author',
      body: {
        ...repairBody,
        acceptedDispatchRoutes: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routeRefs: ['compile-error', 'other-pipeline-failure'],
          },
        ],
      },
    })
    expect(repair.content.acceptedDispatchRoutes?.[0]?.routeRefs).toEqual([
      'compile-error',
      'other-pipeline-failure',
    ])
    const repairRef = await module.commands.publishTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      toolId: repair.id,
      actorUserId: 'author',
    })

    expect(() =>
      module.commands.createJobTemplate({
        typeRef,
        actorUserId: 'author',
        body: {
          name: '被篡改的问题清单',
          description: '岗位不能修改分类工具的问题名称或顺序',
          defaultToolBindings: [
            {
              workItemRef: 'classify-pipeline',
              slotRef: 'default',
              registrationRef: classifierRef,
            },
          ],
          orderedDispatchConfigurations: [
            {
              classifierWorkItemRef: 'classify-pipeline',
              routes: [
                {
                  routeRef: 'compile-error',
                  displayName: '岗位擅自改名',
                  description: '编译或类型检查失败',
                  destinationWorkItemRef: 'repair-pipeline',
                  registrationRef: repairRef,
                  fallback: false,
                },
                {
                  routeRef: 'other-pipeline-failure',
                  displayName: '其他流水线错误',
                  description: '没有命中前序问题时的兜底',
                  destinationWorkItemRef: 'repair-pipeline',
                  registrationRef: repairRef,
                  fallback: true,
                },
              ],
            },
          ],
        },
      }),
    ).toThrow('must match the classifier tool revision')
  })

  test('design and test packages use the same type -> work item -> tool -> employee core', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-generic-types-'))
    roots.push(appHome)
    let ordinal = 0
    const module = composeDigitalEmployee({
      db: createInMemoryDb(MIGRATIONS),
      appHome,
      typePackages: [designEmployeeTypePackage, testEmployeeTypePackage],
      executionContracts: genericExecutionContracts,
      id: () => `generic-${++ordinal}`,
    })

    expect(module.queries.listTypes().map((item) => item.typeRef.typeId)).toEqual([
      'design',
      'test',
    ])
    const typeRef = { typeId: 'design', revision: 1 }
    const tool = await module.commands.createTool({
      typeRef,
      workItemRef: 'design-work',
      actorUserId: 'generic-author',
      body: {
        displayName: '设计执行工具',
        description: '从已有 Agent 库选择',
        roleRef: 'primary',
        implementation: { kind: 'agent', agentRef: { id: 'design-agent', revision: 7 } },
      },
    })
    const toolRef = await module.commands.publishTool({
      typeRef,
      workItemRef: 'design-work',
      toolId: tool.id,
      actorUserId: 'generic-author',
    })
    const job = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'generic-author',
      body: {
        name: '设计岗位',
        description: '只有类型包定义的一个职责',
        defaultToolBindings: [
          { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
        ],
      },
    })
    const jobRef = module.commands.publishJobTemplate({
      id: job.id,
      actorUserId: 'generic-author',
    })
    const employee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'generic-author',
      body: {
        name: '产品设计数字员工',
        jobTemplateRef: jobRef,
        workScope: { kind: 'global' },
      },
    })
    expect({ id: employee.id, revision: employee.revision }).toEqual({
      id: employee.id,
      revision: 1,
    })

    for (const source of [
      'modules/digital-employee/application/authoringService.ts',
      'modules/digital-employee/application/runtimeService.ts',
      'modules/digital-employee/composition.ts',
    ]) {
      expect(readFileSync(resolve(import.meta.dir, '..', 'src', source))).not.toContain(
        "typeId === 'development'",
      )
    }
  })

  test('work intake rejects platform-owned and overlapping repository upload targets', () => {
    const intake = (targetPaths: readonly string[]) => ({
      kind: 'files' as const,
      target: { repositoryId: 'repo-1' },
      body: null,
      externalId: null,
      uploads: targetPaths.map((targetPath, index) => ({
        uploadRef: `upload-${index}`,
        targetPath,
      })),
      idempotencyKey: `intake:${targetPaths.join('|')}`,
    })

    expect(employeeWorkIntakeSchema.safeParse(intake(['docs/spec.md'])).success).toBe(true)
    expect(employeeWorkIntakeSchema.safeParse(intake(['.git/config'])).success).toBe(false)
    expect(
      employeeWorkIntakeSchema.safeParse(intake(['.AGENT-WORKFLOW/pipeline/fake.log'])).success,
    ).toBe(false)
    expect(
      employeeWorkIntakeSchema.safeParse(intake(['docs/spec', 'docs/spec/details.md'])).success,
    ).toBe(false)
  })

  test('repository admission is inherited from a fixed employee scope or required at task launch', () => {
    const request = (workScope: unknown, target: Record<string, string>) => ({
      schemaVersion: 1,
      caseRef: 'case-scope-admission',
      employeeRef: { id: 'employee-scope-admission', revision: 1 },
      workScopeJson: JSON.stringify(workScope),
      receivedAt: 1,
      intake: {
        kind: 'body',
        target,
        body: 'Implement the requested behavior',
        externalId: null,
        idempotencyKey: 'scope-admission',
        executionOptions: {},
        uploads: [],
      },
    })
    const repositoryRef = (payload: ReturnType<typeof request>): string => {
      const launch = JSON.parse(
        developmentEmployeeRuntimeCodec.buildInitialCaseJson(JSON.stringify(payload)),
      ) as { primaryContextJson: string }
      return (JSON.parse(launch.primaryContextJson) as { repositoryRef: string }).repositoryRef
    }

    expect(repositoryRef(request({ kind: 'repository', repositoryId: 'repo-fixed' }, {}))).toBe(
      'repo-fixed',
    )
    expect(() =>
      repositoryRef(
        request({ kind: 'repository', repositoryId: 'repo-fixed' }, { repositoryId: 'repo-other' }),
      ),
    ).toThrow('outside the employee responsibility scope')
    expect(repositoryRef(request({ kind: 'task' }, { repositoryId: 'repo-launch' }))).toBe(
      'repo-launch',
    )
    expect(() => repositoryRef(request({ kind: 'task' }, {}))).toThrow(
      'requires a target repository',
    )
    expect(
      repositoryRef(
        request(
          { kind: 'repository-group', repositoryGroupId: 'group-1' },
          { repositoryId: 'repo-from-group' },
        ),
      ),
    ).toBe('repo-from-group')
    expect(repositoryRef(request({ kind: 'global' }, { repositoryId: 'repo-legacy' }))).toBe(
      'repo-legacy',
    )
  })

  test('a job template cannot publish before every required graph node has a tool', () => {
    const module = fixtureModule()
    const draft = module.commands.createJobTemplate({
      typeRef: { typeId: 'development', revision: 10 },
      actorUserId: 'author-1',
      body: {
        name: '不完整岗位',
        description: '用于锁定节点工具发布门禁。',
        defaultToolBindings: [],
      },
    })

    expect(draft.draft.reactionLaneOrder).toEqual([
      'care-review',
      'care-approval',
      'care-conflict',
      'care-pipeline',
      'care-collaboration',
    ])

    expect(() =>
      module.commands.publishJobTemplate({ id: draft.id, actorUserId: 'author-1' }),
    ).toThrow('job template does not cover every required work-item tool slot')

    expect(() =>
      module.commands.createJobTemplate({
        typeRef: { typeId: 'development', revision: 10 },
        actorUserId: 'author-1',
        body: {
          name: '错误的泳道优先级',
          description: '缺失泳道不得静默回退。',
          defaultToolBindings: [],
          reactionLaneOrder: ['care-review'],
        },
      }),
    ).toThrow('reaction lane order must contain every event-driven business lane exactly once')
  })

  test('unconfigured optional lanes stay disabled without blocking employee save', async () => {
    const module = fixtureModule()
    const typeRef = { typeId: 'development', revision: 10 }
    const typePackage = module.queries.getType(typeRef)
    const optionalLanes = new Set(
      typePackage.authoringManifest.lifecycleRegions.flatMap((region) =>
        region.responsibilityLanes.filter((lane) => lane.optional).map((lane) => lane.laneId),
      ),
    )
    const coreItems = typePackage.authoringManifest.workItems.filter(
      (item) => item.responsibilityLaneId === null || !optionalLanes.has(item.responsibilityLaneId),
    )
    const bindings = [] as Array<{
      workItemRef: string
      slotRef: string
      registrationRef: { id: string; revision: number }
    }>
    for (const item of coreItems) {
      for (const role of item.toolRoleGroups) {
        for (const slot of role.bindingSlots.filter((candidate) => candidate.required)) {
          const tool = await module.commands.createTool({
            typeRef,
            workItemRef: item.workItemRef,
            actorUserId: 'author-optional',
            body: {
              displayName: `${item.label['zh-CN']}工具`,
              description: '仅配置交付主线',
              roleRef: role.roleRef,
              implementation: {
                kind: 'agent',
                agentRef: { id: `agent-${item.workItemRef}`, revision: 1 },
              },
            },
          })
          bindings.push({
            workItemRef: item.workItemRef,
            slotRef: slot.slotRef,
            registrationRef: await module.commands.publishTool({
              typeRef,
              workItemRef: item.workItemRef,
              toolId: tool.id,
              actorUserId: 'author-optional',
            }),
          })
        }
      }
    }
    const job = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author-optional',
      body: {
        name: '只负责交付 MR 的岗位',
        description: '不启用检视、流水线、冲突、协同或外部审批泳道',
        defaultToolBindings: bindings,
      },
    })
    const jobRef = module.commands.publishJobTemplate({
      id: job.id,
      actorUserId: 'author-optional',
    })
    const employee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author-optional',
      body: {
        name: '只交付 MR 的数字员工',
        jobTemplateRef: jobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-core-only' },
      },
    })
    const enabled = module.queries.getEmployee(employee.id).definition.enabledWorkItemRefs
    expect(enabled).toEqual(coreItems.map((item) => item.workItemRef))
    expect(enabled).not.toContain('classify-feedback')
    expect(enabled).not.toContain('collect-pipeline')
    expect(enabled).not.toContain('repair-conflict')
    expect(enabled).not.toContain('delegate')
    expect(enabled).not.toContain('prepare-approval')
    expect(
      isEmployeeReactionEventEnabled({
        descriptor: typePackage,
        enabledWorkItemRefs: enabled,
        eventTypeId: 'development.review-updated',
      }),
    ).toBe(false)
    expect(
      isEmployeeReactionEventEnabled({
        descriptor: typePackage,
        enabledWorkItemRefs: enabled,
        eventTypeId: 'development.lifecycle-updated',
      }),
    ).toBe(true)

    const classifyPipeline = typePackage.authoringManifest.workItems.find(
      (item) => item.workItemRef === 'classify-pipeline',
    )!
    const classifySlot = classifyPipeline.toolRoleGroups[0]!.bindingSlots[0]!
    const classifierTool = await module.commands.createTool({
      typeRef,
      workItemRef: classifyPipeline.workItemRef,
      actorUserId: 'author-optional',
      body: {
        displayName: '归类流水线失败',
        description: '按岗位定义的错误类型闭集进行归类',
        roleRef: classifyPipeline.toolRoleGroups[0]!.roleRef,
        implementation: {
          kind: 'agent',
          agentRef: { id: 'agent-classify-pipeline', revision: 1 },
        },
        dispatchRouteDefinitions: [
          {
            routeRef: 'other-pipeline-failure',
            displayName: '其他流水线错误',
            description: '未命中前序问题类型的兜底',
            fallback: true,
          },
        ],
      },
    })
    const partialJob = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author-optional',
      body: {
        name: '未配完的流水线岗位',
        description: '开始配置后才要求本泳道内部闭合',
        defaultToolBindings: [
          ...bindings,
          {
            workItemRef: classifyPipeline.workItemRef,
            slotRef: classifySlot.slotRef,
            registrationRef: await module.commands.publishTool({
              typeRef,
              workItemRef: classifyPipeline.workItemRef,
              toolId: classifierTool.id,
              actorUserId: 'author-optional',
            }),
          },
        ],
        defaultAdapterBindings: [
          {
            laneId: 'care-pipeline',
            slotRef: 'primary',
            adapterRef: { id: 'pipeline-adapter', revision: 1 },
          },
        ],
      },
    })
    expect(() =>
      module.commands.publishJobTemplate({
        id: partialJob.id,
        actorUserId: 'author-optional',
      }),
    ).toThrow('ordered dispatch must be configured for classify-pipeline')
  })

  test('type -> work item -> tool registration closes an exact employee definition', async () => {
    const module = fixtureModule()
    const typeRef = { typeId: 'development', revision: 10 }
    const manifest = module.queries.getAuthoringManifest(typeRef)
    const typePackage = module.queries.getType(typeRef)
    expect(manifest.lifecycleRegions.map((region) => region.regionId)).toEqual(['delivery', 'care'])
    expect(manifest.workItems).toHaveLength(20)
    expect(
      manifest.workItems.find((item) => item.workItemRef === 'repair-conflict')?.nextWorkItemRefs,
    ).toEqual(['publish-conflict'])
    expect(
      manifest.workItems.find((item) => item.workItemRef === 'publish-conflict'),
    ).toMatchObject({ nodeKind: 'system', nextWorkItemRefs: ['observe-mr'] })
    expect(
      typePackage.reactionRules
        .filter((rule) => rule.preemptsContinuation)
        .map((rule) => rule.eventTypeId),
    ).toEqual([
      'development.review-updated',
      'development.conflict-updated',
      'development.lifecycle-updated',
      'development.approval-updated',
    ])

    const bindings: Array<{
      workItemRef: string
      slotRef: string
      registrationRef: { id: string; revision: number }
    }> = []
    for (const item of manifest.workItems) {
      for (const role of item.toolRoleGroups) {
        for (const slot of role.bindingSlots) {
          if (!slot.required) continue
          const contract = typePackage.workContracts.find(
            (candidate) =>
              candidate.contractId === item.workContractRef.contractId &&
              candidate.version === item.workContractRef.version,
          )!
          const implementation = contract.allowedToolKinds.includes('agent')
            ? {
                kind: 'agent' as const,
                agentRef: {
                  id: `agent-${item.workItemRef}-${slot.slotRef}`,
                  revision: 1,
                },
              }
            : {
                kind: 'workflow' as const,
                workflowRef: {
                  id: `workflow-${item.workItemRef}-${slot.slotRef}`,
                  revision: 1,
                },
              }
          const draft = await module.commands.createTool({
            typeRef,
            workItemRef: item.workItemRef,
            actorUserId: 'author-1',
            body: {
              displayName: `${item.label['zh-CN']}工具`,
              description: slot.description['zh-CN'],
              roleRef: role.roleRef,
              implementation,
              ...(item.workItemRef === 'classify-pipeline'
                ? {
                    dispatchRouteDefinitions: [
                      {
                        routeRef: 'compile-error',
                        displayName: '编译错误',
                        description: '编译或类型检查失败',
                        fallback: false,
                      },
                      {
                        routeRef: 'test-failure',
                        displayName: '测试失败',
                        description: '自动化测试失败',
                        fallback: false,
                      },
                      {
                        routeRef: 'other-pipeline-failure',
                        displayName: '其他流水线错误',
                        description: '用户配置的兜底错误类型',
                        fallback: true,
                      },
                    ],
                  }
                : {}),
              ...(item.workItemRef === 'repair-pipeline'
                ? {
                    acceptedDispatchRoutes: [
                      { classifierWorkItemRef: 'classify-pipeline', routeRefs: ['*'] },
                    ],
                  }
                : {}),
            },
          })
          expect(
            draft.validationReceipt.status,
            JSON.stringify(draft.validationReceipt.checks),
          ).toBe('valid')
          const registrationRef = await module.commands.publishTool({
            typeRef,
            workItemRef: item.workItemRef,
            toolId: draft.id,
            actorUserId: 'author-1',
          })
          bindings.push({
            workItemRef: item.workItemRef,
            slotRef: slot.slotRef,
            registrationRef,
          })
        }
      }
    }
    const pipelineRepairTool = await module.commands.createTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      actorUserId: 'author-1',
      body: {
        displayName: '通用流水线修复工具',
        description: '岗位可把任意错误类型绑定到这个 Agent',
        roleRef: 'repairer',
        implementation: {
          kind: 'agent',
          agentRef: { id: 'agent-pipeline-generic', revision: 1 },
        },
        acceptedDispatchRoutes: [{ classifierWorkItemRef: 'classify-pipeline', routeRefs: ['*'] }],
      },
    })
    const pipelineRepairRef = await module.commands.publishTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      toolId: pipelineRepairTool.id,
      actorUserId: 'author-1',
    })
    const orderedDispatchConfigurations = [
      {
        classifierWorkItemRef: 'classify-pipeline',
        routes: [
          {
            routeRef: 'test-failure',
            displayName: '测试失败',
            description: '自动化测试失败',
            destinationWorkItemRef: 'repair-pipeline',
            registrationRef: pipelineRepairRef,
            fallback: false,
          },
          {
            routeRef: 'compile-error',
            displayName: '编译错误',
            description: '编译或类型检查失败',
            destinationWorkItemRef: 'repair-pipeline',
            registrationRef: pipelineRepairRef,
            fallback: false,
          },
          {
            routeRef: 'other-pipeline-failure',
            displayName: '其他流水线错误',
            description: '用户配置的兜底错误类型',
            destinationWorkItemRef: 'repair-pipeline',
            registrationRef: pipelineRepairRef,
            fallback: true,
          },
        ],
      },
    ]
    const defaultAdapterBindings: LaneAdapterBinding[] = [
      {
        laneId: 'care-pipeline',
        slotRef: 'primary',
        adapterRef: { id: 'pipeline-adapter', revision: 1 },
      },
      {
        laneId: 'care-approval',
        slotRef: 'primary',
        adapterRef: { id: 'approval-adapter', revision: 7 },
      },
    ]
    const exactDefaultAdapterBindings = [...defaultAdapterBindings].sort((left, right) =>
      `${left.laneId}/${left.slotRef}`.localeCompare(`${right.laneId}/${right.slotRef}`),
    )

    const invalidAdapterJob = (adapterRef: { id: string; revision: number }) =>
      module.commands.createJobTemplate({
        typeRef,
        actorUserId: 'author-1',
        body: {
          name: `非法 Adapter ${adapterRef.id}`,
          description: 'Adapter draft validation fixture',
          defaultToolBindings: [],
          defaultAdapterBindings: [{ laneId: 'care-pipeline', slotRef: 'primary', adapterRef }],
        },
      })
    expect(() => invalidAdapterJob({ id: 'wrong-purpose-adapter', revision: 1 })).toThrow(
      'requires pipeline-gate',
    )
    expect(() => invalidAdapterJob({ id: 'missing-adapter', revision: 1 })).toThrow(
      'Adapter revision is not published',
    )
    expect(() => invalidAdapterJob({ id: 'pipeline-adapter-archived', revision: 1 })).toThrow(
      'archived',
    )
    expect(() => invalidAdapterJob({ id: 'pipeline-adapter-hidden', revision: 1 })).toThrow(
      'not visible',
    )

    const compileOnlyTool = await module.commands.createTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      actorUserId: 'author-1',
      body: {
        displayName: '只修复编译错误',
        description: '只能消费 compile 类型的问题集合',
        roleRef: 'repairer',
        implementation: {
          kind: 'agent',
          agentRef: { id: 'agent-pipeline-compile', revision: 1 },
        },
        acceptedDispatchRoutes: [
          { classifierWorkItemRef: 'classify-pipeline', routeRefs: ['compile'] },
        ],
      },
    })
    const compileOnlyRef = await module.commands.publishTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      toolId: compileOnlyTool.id,
      actorUserId: 'author-1',
    })
    expect(() =>
      module.commands.createJobTemplate({
        typeRef,
        actorUserId: 'author-1',
        body: {
          name: '错误绑定示例',
          description: 'environment 类型不能选择只支持 compile 的工具。',
          defaultToolBindings: bindings,
          orderedDispatchConfigurations: [
            {
              classifierWorkItemRef: 'classify-pipeline',
              routes: [
                {
                  routeRef: 'environment',
                  displayName: '环境错误',
                  description: '用于验证后端确定性能力过滤',
                  destinationWorkItemRef: 'repair-pipeline',
                  registrationRef: compileOnlyRef,
                  fallback: true,
                },
              ],
            },
          ],
        },
      }),
    ).toThrow('does not accept classify-pipeline/environment')

    const template = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author-1',
      body: {
        name: '标准开发岗位',
        description: '节点默认工具，不包含事件、重试或执行规则。',
        defaultToolBindings: bindings,
        defaultAdapterBindings,
        orderedDispatchConfigurations,
      },
    })
    const templateRef = module.commands.publishJobTemplate({
      id: template.id,
      actorUserId: 'author-1',
    })
    expect(() =>
      module.commands.createEmployee({
        typeRef,
        actorUserId: 'author-1',
        body: {
          name: '带废弃启动开关的员工',
          jobTemplateRef: templateRef,
          enabled: true,
          workScope: { kind: 'repository', repositoryId: 'repo-1' },
        },
      }),
    ).toThrow()
    const employee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author-1',
      body: {
        name: 'Java 开发数字员工',
        jobTemplateRef: templateRef,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const employeeRef = { id: employee.id, revision: employee.revision }

    const current = module.queries.getEmployee(employee.id)
    expect(employeeRef).toEqual({ id: employee.id, revision: 1 })
    expect(current.definition.workScopeSummary).toBe('仓库：repo-1')
    expect(current.workScope).toEqual({ kind: 'repository', repositoryId: 'repo-1' })
    expect(current.definition.exactToolBindings).toEqual(
      [...bindings].sort((left, right) =>
        `${left.workItemRef}/${left.slotRef}`.localeCompare(
          `${right.workItemRef}/${right.slotRef}`,
        ),
      ),
    )
    expect(current.definition.exactOrderedDispatchConfigurations).toEqual(
      orderedDispatchConfigurations,
    )
    expect(current.definition.exactAdapterBindings).toEqual(exactDefaultAdapterBindings)
    expect(current.inheritedAdapterBindings).toEqual(defaultAdapterBindings)
    expect(current.adapterBindingSources).toEqual(
      exactDefaultAdapterBindings.map((binding) => ({ ...binding, source: 'job-default' })),
    )
    expect(current.configuration).not.toHaveProperty('enabled')
    expect(current.definition).not.toHaveProperty('enabled')
    expect(current).not.toHaveProperty('publishedRevision')
    expect(current).not.toHaveProperty('published')
    expect(JSON.stringify(current)).not.toContain('sameSceneAttempts')
    expect(JSON.stringify(current)).not.toContain('retry')

    const employeeWithPipelineOverride = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author-1',
      body: {
        name: 'GitLab CI 开发数字员工',
        jobTemplateRef: templateRef,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
        adapterOverrides: [
          {
            laneId: 'care-pipeline',
            slotRef: 'primary',
            adapterRef: { id: 'pipeline-adapter-secondary', revision: 2 },
          },
        ],
      },
    })
    const overridden = module.queries.getEmployee(employeeWithPipelineOverride.id)
    expect(overridden.definition.exactToolBindings).toEqual(current.definition.exactToolBindings)
    expect(overridden.definition.exactAdapterBindings).toEqual([
      {
        laneId: 'care-approval',
        slotRef: 'primary',
        adapterRef: { id: 'approval-adapter', revision: 7 },
      },
      {
        laneId: 'care-pipeline',
        slotRef: 'primary',
        adapterRef: { id: 'pipeline-adapter-secondary', revision: 2 },
      },
    ])
    expect(overridden.inheritedAdapterBindings).toEqual(defaultAdapterBindings)
    expect(overridden.adapterBindingSources).toEqual([
      {
        laneId: 'care-approval',
        slotRef: 'primary',
        adapterRef: { id: 'approval-adapter', revision: 7 },
        source: 'job-default',
      },
      {
        laneId: 'care-pipeline',
        slotRef: 'primary',
        adapterRef: { id: 'pipeline-adapter-secondary', revision: 2 },
        source: 'employee-override',
      },
    ])
    expect(overridden.definition.compiledClosureDigest).not.toBe(
      current.definition.compiledClosureDigest,
    )
    expect(module.queries.getEmployee(employee.id).definition.exactAdapterBindings).toEqual(
      exactDefaultAdapterBindings,
    )

    const savedAgain = module.commands.updateEmployee({
      id: employee.id,
      actorUserId: 'author-1',
      body: {
        name: 'Java 开发数字员工（更新）',
        jobTemplateRef: templateRef,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
        collaborationOverrides: [],
      },
    })
    expect(savedAgain).toMatchObject({
      id: employee.id,
      name: 'Java 开发数字员工（更新）',
      revision: 2,
    })
    expect(module.queries.getEmployee(employee.id).revision).toBe(2)

    const cppTemplate = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author-1',
      body: {
        name: 'C++ 开发岗位',
        description: '同一分类可定义另一套节点工具组合。',
        defaultToolBindings: bindings,
        defaultAdapterBindings,
        orderedDispatchConfigurations,
      },
    })
    const cppTemplateRef = module.commands.publishJobTemplate({
      id: cppTemplate.id,
      actorUserId: 'author-1',
    })
    const cppEmployee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author-1',
      body: {
        name: 'C++ 开发数字员工',
        jobTemplateRef: cppTemplateRef,
        workScope: { kind: 'repository', repositoryId: 'repo-2' },
        toolOverrides: [],
      },
    })
    expect(module.queries.listJobTemplates(typeRef).map((job) => job.name)).toEqual([
      'C++ 开发岗位',
      '标准开发岗位',
    ])
    expect(module.queries.getEmployee(cppEmployee.id).definition.jobTemplateRef).toEqual(
      cppTemplateRef,
    )
  })

  test('pipeline problem types follow the employee-configured priority and handler list', () => {
    const orderedDispatchConfigurations = [
      {
        classifierWorkItemRef: 'classify-pipeline',
        routes: [
          {
            routeRef: 'compile',
            displayName: '编译错误',
            description: '先处理编译失败',
            destinationWorkItemRef: 'repair-pipeline',
            registrationRef: { id: 'compile-agent', revision: 1 },
            fallback: false,
          },
          {
            routeRef: 'environment',
            displayName: '其他环境错误',
            description: '岗位自定义兜底类型',
            destinationWorkItemRef: 'repair-pipeline',
            registrationRef: { id: 'generic-agent', revision: 1 },
            fallback: true,
          },
        ],
      },
    ]
    const failureTypeDefinitions = orderedDispatchConfigurations[0]!.routes.map((route, index) => ({
      typeId: route.routeRef,
      priority: index + 1,
      fallback: route.fallback,
      handlingWorkItemRef: route.destinationWorkItemRef,
    }))
    const context = {
      id: 'problem-context',
      revision: 1,
      typeId: 'development.problem-set',
      stateJson: JSON.stringify({
        status: 'active',
        source: 'pipeline',
        headSha: 'a'.repeat(40),
        remainingTypes: ['environment', 'compile'],
        problems: [
          {
            problemId: 'compile-1',
            type: 'compile',
            summary: 'compile failed',
            evidenceArtifactRefs: ['.agent-workflow/pipeline/case-1/logs/compile.log'],
          },
          {
            problemId: 'environment-1',
            type: 'environment',
            summary: 'environment failed',
            evidenceArtifactRefs: [],
          },
        ],
      }),
      artifactRefs: [],
    }
    expect(
      JSON.parse(
        developmentEmployeeRuntimeCodec.selectReactionToolSlotJson(
          JSON.stringify({
            schemaVersion: 1,
            workItemRef: 'repair-pipeline',
            defaultSlotRef: 'system',
            contextsJson: JSON.stringify([context]),
            orderedDispatchConfigurationsJson: JSON.stringify(orderedDispatchConfigurations),
          }),
        ),
      ),
    ).toEqual({ slotRef: 'compile' })
    expect(
      JSON.parse(
        developmentEmployeeRuntimeCodec.selectReactionToolSlotJson(
          JSON.stringify({
            schemaVersion: 1,
            workItemRef: 'repair-pipeline',
            defaultSlotRef: 'system',
            contextsJson: '[]',
            orderedDispatchConfigurationsJson: JSON.stringify(orderedDispatchConfigurations),
          }),
        ),
      ),
    ).toEqual({ slotRef: 'system' })

    const firstRepair = JSON.parse(
      developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'repair-pipeline',
          toolSlotRef: 'compile',
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-repair-compile',
            executionNonce: 'c'.repeat(64),
            status: 'ok',
            summary: 'compile failure repaired',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          }),
          contextsJson: JSON.stringify([context]),
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([context]),
            contractInput: { failureTypeDefinitions },
          }),
          allowedNextWorkItemRefs: ['repair-pipeline', 'delegate', 'prepare-change'],
        }),
      ),
    )
    expect(firstRepair).toMatchObject({ caseState: 'active', nextWorkItemRef: 'repair-pipeline' })
    expect(
      JSON.parse(
        firstRepair.contextPatches.find(
          (patch: { contextTypeId: string }) => patch.contextTypeId === 'development.problem-set',
        ).stateJson,
      ),
    ).toMatchObject({ status: 'active', remainingTypes: ['environment'] })
  })

  test('typed pipeline dependency and review repair resolve to fixed continuations', () => {
    const pipelineProblem = {
      id: 'problem-pipeline',
      revision: 1,
      typeId: 'development.problem-set',
      stateJson: JSON.stringify({
        status: 'active',
        source: 'pipeline',
        headSha: 'a'.repeat(40),
        remainingTypes: ['external-dependency'],
        problems: [
          {
            problemId: 'approval-1',
            type: 'external-dependency',
            summary: '另一个仓库需要完成审批',
            evidenceArtifactRefs: [],
          },
        ],
      }),
      artifactRefs: [],
    }
    const classification = JSON.parse(
      developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'classify-pipeline',
          toolSlotRef: 'default',
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-classify',
            executionNonce: 'a'.repeat(64),
            status: 'ok',
            summary: '识别到外部依赖',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          }),
          contextsJson: JSON.stringify([pipelineProblem]),
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([pipelineProblem]),
            contractInput: {
              failureTypeDefinitions: [
                {
                  typeId: 'external-dependency',
                  priority: 1,
                  fallback: true,
                  handlingWorkItemRef: 'delegate',
                },
              ],
            },
          }),
          allowedNextWorkItemRefs: ['repair-pipeline', 'delegate'],
        }),
      ),
    )
    expect(classification).toMatchObject({
      caseState: 'active',
      nextWorkItemRef: 'delegate',
    })

    const failedPipeline = {
      id: 'pipeline-failed',
      revision: 2,
      typeId: 'development.pipeline',
      stateJson: JSON.stringify({
        status: 'failed',
        mergeRequestRef: 'repo!42',
        headSha: 'a'.repeat(40),
        evidenceArtifactRef: '.agent-workflow/pipeline/case-1/',
        failureTypes: ['external-dependency'],
      }),
      artifactRefs: ['.agent-workflow/pipeline/case-1/'],
    }
    const satisfiedDelegation = {
      id: 'delegation-satisfied',
      revision: 2,
      typeId: 'development.delegation',
      stateJson: JSON.stringify({
        status: 'satisfied',
        groupRef: 'group-1',
        joinMode: 'all',
        quorum: null,
        members: [
          {
            memberRef: 'dependency',
            invocationRef: 'invocation-1',
            targetEmployeeRef: 'employee-child',
            state: 'satisfied',
            resultArtifactRefs: [],
          },
        ],
        resultArtifactRefs: [],
      }),
      artifactRefs: [],
    }
    const delegationSettlement = JSON.parse(
      developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'delegate',
          toolSlotRef: 'collaboration',
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-delegate',
            executionNonce: 'd'.repeat(64),
            status: 'ok',
            summary: 'dependency employee completed',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          }),
          contextsJson: JSON.stringify([failedPipeline, pipelineProblem, satisfiedDelegation]),
          allowedNextWorkItemRefs: ['collect-pipeline'],
        }),
      ),
    )
    expect(delegationSettlement).toMatchObject({ caseState: 'waiting', nextWorkItemRef: null })
    expect(
      JSON.parse(
        delegationSettlement.contextPatches.find(
          (patch: { contextTypeId: string }) => patch.contextTypeId === 'development.pipeline',
        ).stateJson,
      ),
    ).toMatchObject({ status: 'pending', failureTypes: [] })
    expect(
      JSON.parse(
        delegationSettlement.contextPatches.find(
          (patch: { contextTypeId: string }) => patch.contextTypeId === 'development.problem-set',
        ).stateJson,
      ),
    ).toMatchObject({ status: 'resolved', remainingTypes: [] })

    const reviewProblem = {
      ...pipelineProblem,
      id: 'problem-review',
      stateJson: JSON.stringify({
        status: 'active',
        source: 'review',
        headSha: 'b'.repeat(40),
        remainingTypes: ['review'],
        problems: [
          {
            problemId: 'review-1',
            type: 'review',
            summary: 'review finding',
            evidenceArtifactRefs: [],
            reviewThread: {
              threadRef: 'review-1',
              revision: '1:1',
              authorClass: 'human',
              resolved: false,
              body: 'review finding',
              path: null,
              messages: [
                {
                  messageRef: '1',
                  parentMessageRef: null,
                  authorClass: 'human',
                  body: 'review finding',
                  path: null,
                  createdAt: null,
                },
              ],
            },
          },
        ],
      }),
    }
    const staleResolution = {
      id: 'resolution-stale-review',
      revision: 1,
      typeId: 'development.review-resolution',
      stateJson: JSON.stringify({
        status: 'collected',
        mergeRequestRef: 'repo!42',
        sourceHeadSha: 'b'.repeat(40),
        publishedHeadSha: null,
        commitSha: null,
        threads: [
          {
            threadRef: 'review-1',
            revision: '1:1',
            acknowledgement: null,
            disposition: null,
            replyBody: null,
            finalReply: null,
          },
        ],
      }),
      artifactRefs: [],
    }
    const resolvedReviewProblem = {
      ...reviewProblem,
      stateJson: JSON.stringify({
        ...JSON.parse(reviewProblem.stateJson),
        status: 'resolved',
        remainingTypes: [],
        problems: [],
      }),
    }
    const reconciledReview = JSON.parse(
      developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'acknowledge-feedback',
          toolSlotRef: 'system',
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-acknowledge-stale-review',
            executionNonce: 'f'.repeat(64),
            status: 'ok',
            summary: 'retired a review fact absent from the authoritative snapshot',
            contextPatches: [
              {
                contextId: staleResolution.id,
                contextTypeId: staleResolution.typeId,
                schemaVersion: 1,
                expectedRevision: staleResolution.revision,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  ...JSON.parse(staleResolution.stateJson),
                  threads: [],
                }),
                artifactRefs: [],
              },
              {
                contextId: reviewProblem.id,
                contextTypeId: reviewProblem.typeId,
                schemaVersion: 1,
                expectedRevision: reviewProblem.revision,
                lifecycleState: 'terminal',
                stateJson: resolvedReviewProblem.stateJson,
                artifactRefs: [],
              },
            ],
            effectSuggestions: [],
            artifactRefs: [],
          }),
          contextsJson: JSON.stringify([reviewProblem, staleResolution]),
          allowedNextWorkItemRefs: ['repair-feedback', 'observe-mr'],
        }),
      ),
    )
    expect(reconciledReview).toMatchObject({
      caseState: 'active',
      nextWorkItemRef: 'observe-mr',
    })

    const repaired = JSON.parse(
      developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'repair-feedback',
          toolSlotRef: 'default',
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-repair',
            executionNonce: 'b'.repeat(64),
            status: 'ok',
            summary: '已修复检视问题',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          }),
          contextsJson: JSON.stringify([reviewProblem]),
          allowedNextWorkItemRefs: ['prepare-change'],
        }),
      ),
    )
    expect(repaired.nextWorkItemRef).toBe('prepare-change')
    expect(
      JSON.parse(
        repaired.contextPatches.find(
          (patch: { contextTypeId: string }) => patch.contextTypeId === 'development.problem-set',
        ).stateJson,
      ),
    ).toMatchObject({ status: 'resolved', remainingTypes: [] })

    const mrContext = {
      id: 'mr-ready-check',
      revision: 1,
      typeId: 'development.merge-request',
      stateJson: JSON.stringify({
        status: 'active',
        mergeRequestRef: 'repo!42',
        headSha: 'c'.repeat(40),
        issueHandlingContextRef: 'issue-context',
        readyToMerge: false,
      }),
      artifactRefs: [],
    }
    const observed = JSON.parse(
      developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'observe-mr',
          toolSlotRef: 'system',
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-observe',
            executionNonce: 'c'.repeat(64),
            status: 'ok',
            summary: 'MR facts refreshed',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          }),
          contextsJson: JSON.stringify([mrContext]),
          allowedNextWorkItemRefs: [
            'classify-feedback',
            'collect-pipeline',
            'repair-conflict',
            'evaluate-ready',
            'wait-merge',
          ],
        }),
      ),
    )
    expect(observed).toMatchObject({ caseState: 'active', nextWorkItemRef: 'evaluate-ready' })

    const reviewMrContext = {
      ...mrContext,
      stateJson: JSON.stringify({
        ...JSON.parse(mrContext.stateJson),
        unresolvedReviewCount: 1,
        reviewThreads: [
          {
            threadRef: 'thread-review-refresh',
            revision: '2:42',
            authorClass: 'human',
            resolved: false,
            body: 'please repair the refreshed review thread',
            path: 'src/main.ts',
            messages: [
              {
                messageRef: '41',
                parentMessageRef: null,
                authorClass: 'human',
                body: 'root review comment',
                path: 'src/main.ts',
                createdAt: null,
              },
              {
                messageRef: '42',
                parentMessageRef: '41',
                authorClass: 'human',
                body: 'please repair the refreshed review thread',
                path: 'src/main.ts',
                createdAt: null,
              },
            ],
          },
        ],
      }),
    }
    expect(
      JSON.parse(
        developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
          JSON.stringify({
            schemaVersion: 1,
            workItemRef: 'observe-mr',
            toolSlotRef: 'system',
            outputJson: JSON.stringify({
              schemaVersion: 1,
              roundRef: 'round-observe-review',
              executionNonce: '1'.repeat(64),
              status: 'ok',
              summary: 'authoritative review facts refreshed',
              contextPatches: [],
              effectSuggestions: [],
              artifactRefs: [],
            }),
            contextsJson: JSON.stringify([reviewMrContext]),
            inputEnvelopeJson: JSON.stringify({
              contextsJson: JSON.stringify([reviewMrContext]),
              contractInput: {},
              eventJson: JSON.stringify({
                eventTypeRef: { id: 'development.review-updated', revision: 2 },
              }),
            }),
            enabledWorkItemRefsJson: JSON.stringify(['observe-mr', 'classify-feedback']),
            allowedNextWorkItemRefs: ['classify-feedback', 'repair-conflict', 'evaluate-ready'],
          }),
        ),
      ),
    ).toMatchObject({ caseState: 'active', nextWorkItemRef: 'classify-feedback' })

    const conflictMrContext = {
      ...mrContext,
      stateJson: JSON.stringify({
        ...JSON.parse(mrContext.stateJson),
        mergeableState: 'conflict',
        targetSha: 'e'.repeat(40),
      }),
    }
    expect(
      JSON.parse(
        developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
          JSON.stringify({
            schemaVersion: 1,
            workItemRef: 'observe-mr',
            toolSlotRef: 'system',
            outputJson: JSON.stringify({
              schemaVersion: 1,
              roundRef: 'round-observe-conflict',
              executionNonce: '2'.repeat(64),
              status: 'ok',
              summary: 'authoritative conflict facts refreshed',
              contextPatches: [],
              effectSuggestions: [],
              artifactRefs: [],
            }),
            contextsJson: JSON.stringify([conflictMrContext]),
            inputEnvelopeJson: JSON.stringify({
              contextsJson: JSON.stringify([conflictMrContext]),
              contractInput: {},
              eventJson: JSON.stringify({
                eventTypeRef: { id: 'development.conflict-updated', revision: 2 },
              }),
            }),
            enabledWorkItemRefsJson: JSON.stringify(['observe-mr', 'repair-conflict']),
            allowedNextWorkItemRefs: ['classify-feedback', 'repair-conflict', 'evaluate-ready'],
          }),
        ),
      ),
    ).toMatchObject({ caseState: 'active', nextWorkItemRef: 'repair-conflict' })

    const approvalPendingMr = {
      ...mrContext,
      stateJson: JSON.stringify({
        ...JSON.parse(mrContext.stateJson),
        approvalHold: true,
      }),
    }
    const pendingApproval = {
      id: 'approval-pending',
      revision: 1,
      typeId: 'development.approval',
      stateJson: JSON.stringify({
        status: 'pending',
        mergeRequestRef: 'repo!42',
        headSha: 'c'.repeat(40),
        approvalType: 'gate-change',
        adapterRef: { id: 'approval-adapter', revision: 1 },
        validatedDraftRef: 'draft-1',
        subjectRef: 'approval-subject',
        deadlineAt: '2026-09-01T00:00:00.000Z',
        idempotencyKey: 'd'.repeat(64),
        correlationRef: 'approval-correlation',
        externalRequestRef: 'APP-1',
        submittedRevision: 'submit-1',
        observedRevision: 'observe-1',
        evidenceRef: null,
      }),
      artifactRefs: [],
    }
    expect(
      JSON.parse(
        developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
          JSON.stringify({
            schemaVersion: 1,
            workItemRef: 'observe-mr',
            toolSlotRef: 'system',
            outputJson: JSON.stringify({
              schemaVersion: 1,
              roundRef: 'round-observe-pending-approval',
              executionNonce: 'f'.repeat(64),
              status: 'ok',
              summary: 'MR facts refreshed while approval is pending',
              contextPatches: [],
              effectSuggestions: [],
              artifactRefs: [],
            }),
            contextsJson: JSON.stringify([approvalPendingMr, pendingApproval]),
            enabledWorkItemRefsJson: JSON.stringify([
              'observe-mr',
              'prepare-approval',
              'evaluate-ready',
            ]),
            allowedNextWorkItemRefs: ['prepare-approval', 'evaluate-ready'],
          }),
        ),
      ),
    ).toMatchObject({ caseState: 'active', nextWorkItemRef: 'evaluate-ready' })

    const notReady = JSON.parse(
      developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'evaluate-ready',
          toolSlotRef: 'system',
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-evaluate',
            executionNonce: 'd'.repeat(64),
            status: 'ok',
            summary: 'not ready yet',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          }),
          contextsJson: JSON.stringify([mrContext]),
          allowedNextWorkItemRefs: ['wait-merge', 'observe-mr'],
        }),
      ),
    )
    expect(notReady).toMatchObject({ caseState: 'waiting', nextWorkItemRef: null })

    const pendingPipeline = {
      id: 'pipeline-pending',
      revision: 1,
      typeId: 'development.pipeline',
      stateJson: JSON.stringify({
        status: 'pending',
        mergeRequestRef: 'repo!42',
        headSha: 'c'.repeat(40),
        evidenceArtifactRef: '.agent-workflow/pipeline/case-1/',
        failureTypes: [],
      }),
      artifactRefs: [],
    }
    expect(
      JSON.parse(
        developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
          JSON.stringify({
            schemaVersion: 1,
            workItemRef: 'collect-pipeline',
            toolSlotRef: 'default',
            outputJson: JSON.stringify({
              schemaVersion: 1,
              roundRef: 'round-pipeline-pending',
              executionNonce: 'e'.repeat(64),
              status: 'ok',
              summary: 'pipeline is still running',
              contextPatches: [],
              effectSuggestions: [],
              artifactRefs: [],
            }),
            contextsJson: JSON.stringify([pendingPipeline]),
            allowedNextWorkItemRefs: ['classify-pipeline', 'observe-mr'],
          }),
        ),
      ),
    ).toMatchObject({ caseState: 'waiting', nextWorkItemRef: null })
  })

  test('pipeline target binding is introduced at type revision 8 without breaking pinned revision 7 Cases', () => {
    const mergeRequest = {
      id: 'mr-target-version-context',
      revision: 1,
      typeId: 'development.merge-request',
      stateJson: JSON.stringify({
        status: 'active',
        mergeRequestRef: 'repo!42',
        headSha: 'a'.repeat(40),
        factsHeadSha: 'a'.repeat(40),
        targetSha: 'b'.repeat(40),
        issueHandlingContextRef: 'issue-context',
        readyToMerge: false,
      }),
    }
    const pipeline = {
      id: 'pipeline-target-version-context',
      revision: 1,
      typeId: 'development.pipeline',
      stateJson: JSON.stringify({
        status: 'pending',
        mergeRequestRef: 'repo!42',
        headSha: 'a'.repeat(40),
        evidenceArtifactRef: '.agent-workflow/pipeline/case-versioned/',
        failureTypes: [],
      }),
    }
    const validate = (
      revision: 7 | 8,
      options: { targetSha?: string | null; status?: 'pending' | 'passed' } = {},
    ) =>
      developmentEmployeeRuntimeCodec.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          employeeTypeRef: { typeId: 'development', revision },
          workItemRef: 'collect-pipeline',
          toolSlotRef: 'default',
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([mergeRequest, pipeline]),
          }),
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: `round-pipeline-target-v${revision}`,
            executionNonce: 'f'.repeat(64),
            status: 'ok',
            summary: 'head-bound pipeline snapshot',
            contextPatches: [
              {
                contextId: pipeline.id,
                contextTypeId: pipeline.typeId,
                schemaVersion: 1,
                expectedRevision: pipeline.revision,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  ...JSON.parse(pipeline.stateJson),
                  targetSha: options.targetSha,
                  status: options.status ?? 'passed',
                }),
                artifactRefs: [],
              },
            ],
            effectSuggestions: [],
            artifactRefs: [],
          }),
        }),
      )

    expect(() => validate(7)).not.toThrow()
    const upgradedLegacyOutput = JSON.parse(validate(8)) as {
      contextPatches: Array<{ contextTypeId: string; stateJson: string }>
    }
    expect(
      JSON.parse(
        upgradedLegacyOutput.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.pipeline',
        )!.stateJson,
      ),
    ).toMatchObject({ status: 'passed', targetSha: 'b'.repeat(40) })
    expect(() => validate(8, { targetSha: 'c'.repeat(40) })).toThrow(
      'pipeline evidence does not belong to the current MR target',
    )

    const unknownTargetMergeRequest = {
      ...mergeRequest,
      stateJson: JSON.stringify({ ...JSON.parse(mergeRequest.stateJson), targetSha: null }),
    }
    const validateUnknownTarget = (status: 'pending' | 'passed') =>
      developmentEmployeeRuntimeCodec.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          employeeTypeRef: { typeId: 'development', revision: 8 },
          workItemRef: 'collect-pipeline',
          toolSlotRef: 'default',
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([unknownTargetMergeRequest, pipeline]),
          }),
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: `round-pipeline-unknown-target-${status}`,
            executionNonce: 'e'.repeat(64),
            status: 'ok',
            summary: 'target is not authoritative yet',
            contextPatches: [
              {
                contextId: pipeline.id,
                contextTypeId: pipeline.typeId,
                schemaVersion: 1,
                expectedRevision: pipeline.revision,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  ...JSON.parse(pipeline.stateJson),
                  targetSha: null,
                  status,
                }),
                artifactRefs: [],
              },
            ],
            effectSuggestions: [],
            artifactRefs: [],
          }),
        }),
      )
    expect(() => validateUnknownTarget('pending')).not.toThrow()
    expect(() => validateUnknownTarget('passed')).toThrow(
      'pipeline evidence must remain pending while the current MR target is unknown',
    )
  })

  test('semantic output boundary rejects a problem set for a stale pipeline head', () => {
    const mergeRequest = {
      id: 'mr-context',
      revision: 1,
      typeId: 'development.merge-request',
      stateJson: JSON.stringify({
        status: 'active',
        mergeRequestRef: 'repo!42',
        headSha: 'a'.repeat(40),
        issueHandlingContextRef: 'issue-context',
        readyToMerge: false,
      }),
    }
    const pipeline = {
      id: 'pipeline-context',
      revision: 1,
      typeId: 'development.pipeline',
      stateJson: JSON.stringify({
        status: 'failed',
        mergeRequestRef: 'repo!42',
        headSha: 'a'.repeat(40),
        evidenceArtifactRef: '.agent-workflow/pipeline/case-1/',
        failureTypes: ['compile'],
      }),
    }
    expect(() =>
      developmentEmployeeRuntimeCodec.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'classify-pipeline',
          toolSlotRef: 'default',
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([mergeRequest, pipeline]),
          }),
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-stale',
            executionNonce: 'c'.repeat(64),
            status: 'ok',
            summary: 'stale classification',
            contextPatches: [
              {
                contextId: null,
                contextTypeId: 'development.problem-set',
                schemaVersion: 1,
                expectedRevision: null,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  status: 'active',
                  source: 'pipeline',
                  headSha: 'b'.repeat(40),
                  remainingTypes: ['compile'],
                  problems: [
                    {
                      problemId: 'compile-1',
                      type: 'compile',
                      summary: 'compile failed',
                      evidenceArtifactRefs: [],
                    },
                  ],
                }),
                artifactRefs: [],
              },
            ],
            effectSuggestions: [],
            artifactRefs: [],
          }),
        }),
      ),
    ).toThrow('problem set is stale')
  })

  test('classifier upserts a prior terminal problem set using its frozen identity', () => {
    const headSha = 'a'.repeat(40)
    const mergeRequest = {
      id: 'mr-pipeline-reclassification',
      revision: 4,
      typeId: 'development.merge-request',
      schemaVersion: 1,
      lifecycleState: 'active',
      stateJson: JSON.stringify({
        status: 'active',
        mergeRequestRef: 'repo!42',
        headSha,
        factsHeadSha: headSha,
        targetSha: 'b'.repeat(40),
        issueHandlingContextRef: 'issue-context',
        readyToMerge: false,
      }),
      artifactRefs: [],
    }
    const pipeline = {
      id: 'pipeline-reclassification',
      revision: 3,
      typeId: 'development.pipeline',
      schemaVersion: 1,
      lifecycleState: 'active',
      stateJson: JSON.stringify({
        status: 'failed',
        mergeRequestRef: 'repo!42',
        headSha,
        targetSha: 'b'.repeat(40),
        evidenceArtifactRef: '.agent-workflow/pipeline/case-reclassification/',
        failureTypes: ['test-failure'],
      }),
      artifactRefs: ['.agent-workflow/pipeline/case-reclassification/'],
    }
    const priorProblemSet = {
      id: 'problem-set-from-prior-review',
      revision: 6,
      typeId: 'development.problem-set',
      schemaVersion: 1,
      lifecycleState: 'terminal',
      stateJson: JSON.stringify({
        status: 'resolved',
        source: 'review',
        headSha: 'c'.repeat(40),
        remainingTypes: [],
        problems: [],
      }),
      artifactRefs: [],
    }
    const validated = JSON.parse(
      developmentEmployeeRuntimeCodec.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'classify-pipeline',
          toolSlotRef: 'default',
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([mergeRequest, pipeline, priorProblemSet]),
            contractInput: {
              failureTypeDefinitions: [
                {
                  typeId: 'test-failure',
                  priority: 1,
                  fallback: false,
                  handlingWorkItemRef: 'repair-pipeline',
                },
              ],
            },
          }),
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-pipeline-reclassification',
            executionNonce: 'f'.repeat(64),
            status: 'ok',
            summary: 'classified the current pipeline failure',
            contextPatches: [
              {
                contextId: null,
                contextTypeId: 'development.problem-set',
                schemaVersion: 1,
                expectedRevision: null,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  status: 'active',
                  source: 'pipeline',
                  headSha,
                  remainingTypes: ['test-failure'],
                  problems: [
                    {
                      problemId: 'pipeline:test-failure:1',
                      type: 'test-failure',
                      summary: 'the test job failed',
                      evidenceArtifactRefs: [
                        '.agent-workflow/pipeline/case-reclassification/job.log',
                      ],
                      reviewThread: null,
                    },
                  ],
                }),
                artifactRefs: ['.agent-workflow/pipeline/case-reclassification/job.log'],
              },
            ],
            effectSuggestions: [],
            artifactRefs: [],
          }),
        }),
      ),
    ) as {
      contextPatches: Array<{
        contextId: string | null
        contextTypeId: string
        schemaVersion: number
        expectedRevision: number | null
        lifecycleState: string
      }>
    }
    expect(validated.contextPatches).toContainEqual(
      expect.objectContaining({
        contextId: priorProblemSet.id,
        contextTypeId: priorProblemSet.typeId,
        schemaVersion: priorProblemSet.schemaVersion,
        expectedRevision: priorProblemSet.revision,
        lifecycleState: 'active',
      }),
    )
  })

  test('review classification covers each actionable MR thread exactly once', () => {
    const mergeRequest = {
      id: 'mr-review-context',
      revision: 1,
      typeId: 'development.merge-request',
      stateJson: JSON.stringify({
        status: 'active',
        mergeRequestRef: 'repo!42',
        headSha: 'a'.repeat(40),
        issueHandlingContextRef: 'issue-context',
        readyToMerge: false,
        unresolvedReviewCount: 2,
        reviewThreads: [
          {
            threadRef: 'thread-human',
            revision: '1:1',
            authorClass: 'human',
            resolved: false,
            body: 'please repair the null branch',
            path: 'src/main.ts',
            messages: [
              {
                messageRef: '1',
                parentMessageRef: null,
                authorClass: 'human',
                body: 'please repair the null branch',
                path: 'src/main.ts',
                createdAt: null,
              },
            ],
          },
          {
            threadRef: 'thread-bot',
            revision: '1:2',
            authorClass: 'bot',
            resolved: false,
            body: 'lint finding',
            path: null,
          },
          {
            threadRef: 'thread-self',
            revision: '1:3',
            authorClass: 'self',
            resolved: false,
            body: 'platform reply',
            path: null,
          },
          {
            threadRef: 'thread-resolved',
            revision: '1:4',
            authorClass: 'human',
            resolved: true,
            body: 'already resolved',
            path: null,
          },
        ],
      }),
    }
    const validate = (problemIds: readonly string[]) => {
      const reviewThreads = (
        JSON.parse(mergeRequest.stateJson) as {
          reviewThreads: Array<{
            threadRef: string
            revision: string
            authorClass: 'human' | 'bot' | 'self'
            resolved: boolean
            body: string
            path: string | null
            messages?: unknown[]
          }>
        }
      ).reviewThreads
      return developmentEmployeeRuntimeCodec.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'classify-feedback',
          toolSlotRef: 'default',
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([mergeRequest]),
          }),
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-review',
            executionNonce: 'd'.repeat(64),
            status: 'ok',
            summary: 'classified review threads',
            contextPatches: [
              {
                contextId: null,
                contextTypeId: 'development.problem-set',
                schemaVersion: 1,
                expectedRevision: null,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  status: 'active',
                  source: 'review',
                  headSha: 'a'.repeat(40),
                  remainingTypes: ['review'],
                  problems: problemIds.map((problemId) => ({
                    problemId,
                    type: 'review',
                    summary: `review problem ${problemId}`,
                    evidenceArtifactRefs: [],
                    reviewThread:
                      reviewThreads.find((thread) => thread.threadRef === problemId) ??
                      reviewThreads[0],
                  })),
                }),
                artifactRefs: [],
              },
              {
                contextId: null,
                contextTypeId: 'development.review-resolution',
                schemaVersion: 1,
                expectedRevision: null,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  status: 'collected',
                  mergeRequestRef: 'repo!42',
                  sourceHeadSha: 'a'.repeat(40),
                  publishedHeadSha: null,
                  commitSha: null,
                  threads: problemIds.map((threadRef) => ({
                    threadRef,
                    revision:
                      reviewThreads.find((thread) => thread.threadRef === threadRef)?.revision ??
                      'unexpected',
                    acknowledgement: null,
                    disposition: null,
                    replyBody: null,
                    finalReply: null,
                  })),
                }),
                artifactRefs: [],
              },
            ],
            effectSuggestions: [],
            artifactRefs: [],
          }),
        }),
      )
    }

    expect(() => validate(['thread-human'])).toThrow(
      'must cover each unresolved non-self review thread exactly once',
    )
    expect(() => validate(['thread-human', 'thread-bot', 'unexpected'])).toThrow(
      'must cover each unresolved non-self review thread exactly once',
    )
    expect(() => validate(['thread-bot', 'thread-human'])).not.toThrow()
    expect(() =>
      developmentEmployeeRuntimeCodec.validateContextJson(
        'development.merge-request',
        JSON.stringify({
          ...JSON.parse(mergeRequest.stateJson),
          unresolvedReviewCount: 3,
        }),
      ),
    ).toThrow('unresolvedReviewCount does not match actionable reviewThreads')
  })

  test('a later review revision answers only its frozen problem set and preserves prior treatment', () => {
    const issue = {
      id: 'issue-review-revision',
      revision: 2,
      typeId: 'development.issue-handling',
      schemaVersion: 1,
      lifecycleState: 'active',
      stateJson: JSON.stringify({
        status: 'active',
        subjectRef: 'repo:ISSUE-8',
        repositoryRef: 'repo',
        request: {
          kind: 'external-id',
          body: null,
          externalId: 'ISSUE-8',
          uploads: [],
          executionOptions: {},
        },
        materialArtifactRefs: [],
        deliveryContent: null,
      }),
      artifactRefs: [],
    }
    const selectedRevision = {
      threadRef: 'thread-1',
      revision: '2:10',
      authorClass: 'human',
      resolved: false,
      body: 'publish the existing repair',
      path: 'test/calc.test.mjs',
      messages: [],
    }
    const problemSet = {
      id: 'problem-review-revision',
      revision: 1,
      typeId: 'development.problem-set',
      schemaVersion: 1,
      lifecycleState: 'active',
      stateJson: JSON.stringify({
        status: 'active',
        source: 'review',
        headSha: 'a'.repeat(40),
        remainingTypes: ['review'],
        problems: [
          {
            problemId: 'thread-1',
            type: 'review',
            summary: 'publish the existing repair',
            evidenceArtifactRefs: [],
            reviewThread: selectedRevision,
          },
        ],
      }),
      artifactRefs: [],
    }
    const priorThread = {
      threadRef: 'thread-1',
      revision: '1:8',
      acknowledgement: { marker: 'received-old', noteRef: '9' },
      disposition: 'addressed',
      replyBody: 'old revision was repaired',
      finalReply: { marker: 'resolved-old', noteRef: '11' },
    }
    const resolution = {
      id: 'resolution-review-revision',
      revision: 4,
      typeId: 'development.review-resolution',
      schemaVersion: 1,
      lifecycleState: 'active',
      stateJson: JSON.stringify({
        status: 'acknowledged',
        mergeRequestRef: 'repo!3',
        sourceHeadSha: 'a'.repeat(40),
        publishedHeadSha: null,
        commitSha: null,
        threads: [
          priorThread,
          {
            threadRef: selectedRevision.threadRef,
            revision: selectedRevision.revision,
            acknowledgement: { marker: 'received-new', noteRef: '12' },
            disposition: null,
            replyBody: null,
            finalReply: null,
          },
        ],
      }),
      artifactRefs: [],
    }
    const validate = (
      reviewReplies: readonly object[],
      resolutionContext: typeof resolution = resolution,
    ) =>
      developmentEmployeeRuntimeCodec.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          workItemRef: 'repair-feedback',
          toolSlotRef: 'default',
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([issue, problemSet, resolutionContext]),
          }),
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-review-revision',
            executionNonce: 'e'.repeat(64),
            status: 'ok',
            summary: 'repaired the selected review revision',
            deliveryContent: {
              commitMessage: 'test: publish decimal regression',
              mergeRequestTitle: 'Publish decimal regression',
              mergeRequestDescription: 'Publishes the reviewed decimal regression test.',
            },
            reviewReplies,
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          }),
        }),
      )
    const validated = JSON.parse(
      validate([
        {
          threadRef: selectedRevision.threadRef,
          revision: selectedRevision.revision,
          disposition: 'addressed',
          replyBody: 'published the requested decimal regression',
        },
      ]),
    ) as { contextPatches: Array<{ contextTypeId: string; stateJson: string }> }
    const patched = JSON.parse(
      validated.contextPatches.find(
        (patch) => patch.contextTypeId === 'development.review-resolution',
      )!.stateJson,
    ) as { status: string; threads: unknown[] }
    expect(patched.status).toBe('prepared')
    expect(patched.threads).toEqual([
      priorThread,
      {
        threadRef: selectedRevision.threadRef,
        revision: selectedRevision.revision,
        acknowledgement: { marker: 'received-new', noteRef: '12' },
        disposition: 'addressed',
        replyBody: 'published the requested decimal regression',
        finalReply: null,
      },
    ])
    const supersededAcknowledgement = {
      ...priorThread,
      disposition: null,
      replyBody: null,
      finalReply: null,
    }
    const healed = JSON.parse(
      validate(
        [
          {
            threadRef: supersededAcknowledgement.threadRef,
            revision: supersededAcknowledgement.revision,
            disposition: 'addressed',
            replyBody: 'duplicate reply for the superseded revision must not be published',
          },
          {
            threadRef: selectedRevision.threadRef,
            revision: selectedRevision.revision,
            disposition: 'addressed',
            replyBody: 'published the requested decimal regression',
          },
        ],
        {
          ...resolution,
          stateJson: JSON.stringify({
            ...JSON.parse(resolution.stateJson),
            threads: [supersededAcknowledgement, JSON.parse(resolution.stateJson).threads[1]],
          }),
        },
      ),
    ) as { contextPatches: Array<{ contextTypeId: string; stateJson: string }> }
    expect(
      JSON.parse(
        healed.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.review-resolution',
        )!.stateJson,
      ).threads,
    ).toEqual([
      {
        threadRef: selectedRevision.threadRef,
        revision: selectedRevision.revision,
        acknowledgement: { marker: 'received-new', noteRef: '12' },
        disposition: 'addressed',
        replyBody: 'published the requested decimal regression',
        finalReply: null,
      },
    ])
    expect(() =>
      validate([
        {
          threadRef: priorThread.threadRef,
          revision: priorThread.revision,
          disposition: 'addressed',
          replyBody: 'duplicate historical treatment',
        },
        {
          threadRef: selectedRevision.threadRef,
          revision: selectedRevision.revision,
          disposition: 'addressed',
          replyBody: 'new treatment',
        },
      ]),
    ).toThrow('one ordered review reply for every selected thread revision')
  })

  test('system nodes reject tools and employee retries are derived from global Limits', async () => {
    let limits = { defaultNodeRetries: 3, sessionRestartBudget: 1 }
    const module = fixtureModule({ current: () => limits })
    const typeRef = { typeId: 'development', revision: 10 }
    await expect(
      module.commands.createTool({
        typeRef,
        workItemRef: 'publish-mr',
        actorUserId: 'author-1',
        body: {
          displayName: '非法发布工具',
          description: '',
          roleRef: 'primary',
          implementation: { kind: 'agent', agentRef: { id: 'agent-1', revision: 1 } },
        },
      }),
    ).rejects.toMatchObject({ code: 'employee-work-item-does-not-accept-tools' })

    const initial = module.queries.getExecutionPolicy()
    expect(initial.revision).toBe(1)
    expect(initial.content.sameSceneAttempts).toBe(3)
    expect(initial.content.freshSceneAttempts).toBe(1)

    limits = { defaultNodeRetries: 5, sessionRestartBudget: 2 }
    const updated = module.queries.getExecutionPolicy()
    expect(updated.revision).toBe(2)
    expect(updated.content.sameSceneAttempts).toBe(5)
    expect(updated.content.freshSceneAttempts).toBe(2)
    expect(module.queries.getExecutionPolicy().revision).toBe(2)
  })

  test('new tools reject connectionRef because Adapter binding belongs to the lane', async () => {
    const module = fixtureModule()
    const typeRef = { typeId: 'development', revision: 10 }
    await expect(
      module.commands.createTool({
        typeRef,
        workItemRef: 'prepare-approval',
        actorUserId: 'author-1',
        body: {
          displayName: '带旧连接字段的审批材料工具',
          description: '新写路径必须拒绝旧字段。',
          roleRef: 'primary',
          implementation: {
            kind: 'agent',
            agentRef: { id: 'builtin:approval-draft-agent', revision: 1 },
          },
          connectionRef: { id: 'approval-adapter', revision: 7 },
        },
      }),
    ).rejects.toMatchObject({ code: 'tool-connection-moved-to-employee-binding' })

    const valid = await module.commands.createTool({
      typeRef,
      workItemRef: 'prepare-approval',
      actorUserId: 'author-1',
      body: {
        displayName: '审批材料工具',
        description: '连接由职责泳道配置。',
        roleRef: 'primary',
        implementation: {
          kind: 'agent',
          agentRef: { id: 'builtin:approval-draft-agent', revision: 1 },
        },
      },
    })
    expect(valid.validationReceipt.status).toBe('valid')
    expect(valid.content.connectionRef).toBeNull()
  })

  // Regression: a failed contract check used to leave one invalid registration,
  // while the correction submitted from the still-open dialog called create
  // again. The toolbox then showed two same-name rows with different IDs and
  // offered no way to repair either one. Corrections must stay on one stable
  // registration identity and successful republishes advance only its revision.
  test('tool corrections reuse one registration id and publish immutable revisions', async () => {
    const module = fixtureModule()
    const typeRef = { typeId: 'development', revision: 10 }
    const body = {
      displayName: '审批工具',
      description: '初始草稿。',
      roleRef: 'primary',
      implementation: {
        kind: 'agent' as const,
        agentRef: { id: 'builtin:approval-draft-agent', revision: 1 },
      },
    }
    const created = await module.commands.createTool({
      typeRef,
      workItemRef: 'prepare-approval',
      actorUserId: 'author-1',
      body,
    })
    expect(created.validationReceipt.status).toBe('valid')
    expect(
      await module.commands.publishTool({
        typeRef,
        workItemRef: 'prepare-approval',
        toolId: created.id,
        actorUserId: 'author-1',
      }),
    ).toEqual({ id: created.id, revision: 1 })

    const corrected = await module.commands.updateTool({
      typeRef,
      workItemRef: 'prepare-approval',
      toolId: created.id,
      body: {
        ...body,
        description: '更新说明后沿用原 registration id。',
      },
    })
    expect(corrected.id).toBe(created.id)
    expect(corrected.validationReceipt.status).toBe('valid')
    expect(module.queries.listTools(typeRef, 'prepare-approval')).toHaveLength(1)
    expect(
      await module.commands.publishTool({
        typeRef,
        workItemRef: 'prepare-approval',
        toolId: created.id,
        actorUserId: 'author-1',
      }),
    ).toEqual({ id: created.id, revision: 2 })
    expect(module.queries.listTools(typeRef, 'prepare-approval')).toMatchObject([
      { id: created.id, publishedRevision: 2 },
    ])
  })

  test('Program tool editor round-trips source and parameters from immutable artifacts', async () => {
    const module = fixtureModule()
    const typeRef = { typeId: 'development', revision: 10 }
    const created = await module.commands.createTool({
      typeRef,
      workItemRef: 'prepare-materials',
      actorUserId: 'author-1',
      body: {
        displayName: '材料脚本',
        description: '程序工具也必须能二次编辑。',
        roleRef: 'primary',
        implementation: {
          kind: 'program',
          runtimeKind: 'python',
          source: 'print("first")\n',
          parameterValues: { mode: 'strict', retries: 2, enabled: true },
          runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
        },
      },
    })

    expect(
      await module.queries.getToolAuthoring({
        typeRef,
        workItemRef: 'prepare-materials',
        toolId: created.id,
      }),
    ).toMatchObject({
      id: created.id,
      body: {
        displayName: '材料脚本',
        implementation: {
          kind: 'program',
          runtimeKind: 'python',
          source: 'print("first")\n',
          parameterValues: { mode: 'strict', retries: 2, enabled: true },
        },
      },
    })
  })

  test('Workflow and Agent execution boundaries reject hidden platform effects', () => {
    const safe = inspectExecutionContractWorkflowDefinition({
      $schema_version: 5,
      inputs: [{ kind: 'text', key: 'prompt', label: 'Prompt', required: true }],
      nodes: [
        { id: 'input', kind: 'input', inputKey: 'prompt' },
        { id: 'script', kind: 'script' },
        {
          id: 'output',
          kind: 'output',
          ports: [{ name: 'agent-result', bind: { nodeId: 'script', portName: 'stdout' } }],
        },
      ],
      edges: [],
    })
    expect(safe.ok).toBe(true)
    expect(
      inspectExecutionContractWorkflowDefinition({
        $schema_version: 5,
        inputs: [
          { kind: 'text', key: 'prompt', label: 'Prompt' },
          { kind: 'text', key: 'secret', label: 'Secret', required: true },
        ],
        nodes: [
          { id: 'git', kind: 'wrapper-git', nodeIds: [] },
          { id: 'host', kind: 'code-host-call' },
        ],
        edges: [],
      }),
    ).toEqual({
      ok: false,
      detail:
        "unsupported required inputs: secret; forbidden node kinds: code-host-call, wrapper-git; missing output 'agent-result'",
    })

    const prompt = buildDigitalEmployeeFixedPrompt(
      {
        roundRef: 'round-1',
        executionNonce: 'a'.repeat(64),
        toolSlotRef: 'compile',
        semanticValidatorId: 'development.validator',
        inputEnvelopeJson: '{"frozen":true}',
        allowedEffectKinds: [],
      },
      { previousError: 'wrong nonce' },
      developmentExecutionContracts().get({
        contractId: 'development.analyze-implement',
        version: 1,
      }),
    )
    expect(prompt).toContain('Use read-only repository and Git inspection')
    expect(prompt).toContain(
      'Do not run Git commands that mutate the worktree or metadata, including add, commit, push, merge, rebase, reset, or checkout',
    )
    expect(prompt).toContain('or choose the next action')
    expect(prompt).toContain(`executionNonce=${JSON.stringify('a'.repeat(64))}`)
    expect(prompt).toContain('tool slot "compile"')
    expect(prompt).toContain('previous output was rejected: wrong nonce')
    expect(prompt.endsWith('{"frozen":true}')).toBe(true)

    const executionSource = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'digitalEmployeeExecution.ts',
      ),
      'utf8',
    )
    expect(executionSource).toContain(
      'outcome.outputs[DIGITAL_EMPLOYEE_RESULT_PORT]?.content ?? null',
    )
    expect(executionSource).not.toContain('outcome.outputs.result')
  })
})
