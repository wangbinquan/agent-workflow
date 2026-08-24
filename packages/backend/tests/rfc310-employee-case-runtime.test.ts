import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import {
  employeeAttentionBindings,
  employeeCases,
  employeeOsOutbox,
  employeeReactionRounds,
  employeeToolRegistrationRevisions,
  eventSubscriptions,
} from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import { projectFrozenExecutionOptions } from '@/modules/digital-employee/application/runtimeService'
import {
  digitalEmployeeLifecycleEventCatalogJson,
  EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF,
  EMPLOYEE_LIFECYCLE_SOURCE_REF,
} from '@/modules/digital-employee/public/events'
import {
  evaluateEmployeeInvocationGuard,
  evaluateEmployeeInvocationJoin,
  MAX_CHILD_INVOCATIONS_PER_CASE,
  MAX_EMPLOYEE_INVOCATION_DEPTH,
} from '@/modules/digital-employee/domain/runtimeModel'
import { composeEventCenter } from '@/modules/event-center/composition'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-310 stateful employee Case runtime', () => {
  // User regression 2026-08-23: task details must project the Case-pinned
  // active capability set instead of rendering every authoring option.
  test('projects frozen generic execution options without employee-type special cases', () => {
    const definitions = [
      { optionRef: 'review-plan', defaultValue: false },
      { optionRef: 'collect-evidence', defaultValue: true },
    ]

    expect(
      projectFrozenExecutionOptions({
        definitions,
        primaryContextState: {
          request: { executionOptions: { 'review-plan': true, unknown: true } },
        },
      }),
    ).toEqual({ 'review-plan': true, 'collect-evidence': true })
    expect(
      projectFrozenExecutionOptions({
        definitions,
        primaryContextState: { request: {} },
      }),
    ).toEqual({ 'review-plan': false, 'collect-evidence': true })
  })

  test('cross-employee guard treats revisions as one identity and closes depth and child budgets', () => {
    expect(
      evaluateEmployeeInvocationGuard({
        ancestry: [
          { caseId: 'case-a', employeeId: 'employee-a' },
          { caseId: 'case-b', employeeId: 'employee-b' },
        ],
        targetEmployeeId: 'employee-a',
        outboundInvocationCount: 0,
      }),
    ).toMatchObject({ ok: false, code: 'employee-collaboration-cycle' })
    expect(
      evaluateEmployeeInvocationGuard({
        ancestry: Array.from({ length: MAX_EMPLOYEE_INVOCATION_DEPTH }, (_, index) => ({
          caseId: `case-${index}`,
          employeeId: `employee-${index}`,
        })),
        targetEmployeeId: 'new-employee',
        outboundInvocationCount: 0,
      }),
    ).toMatchObject({ ok: false, code: 'employee-collaboration-depth-exhausted' })
    expect(
      evaluateEmployeeInvocationGuard({
        ancestry: [{ caseId: 'case-a', employeeId: 'employee-a' }],
        targetEmployeeId: 'employee-b',
        outboundInvocationCount: MAX_CHILD_INVOCATIONS_PER_CASE,
      }),
    ).toMatchObject({ ok: false, code: 'employee-collaboration-child-budget-exhausted' })
    expect(
      evaluateEmployeeInvocationGuard({
        ancestry: [
          { caseId: 'case-a', employeeId: 'employee-a' },
          { caseId: 'case-a', employeeId: 'employee-b' },
        ],
        targetEmployeeId: 'employee-c',
        outboundInvocationCount: 0,
      }),
    ).toMatchObject({ ok: false, code: 'employee-collaboration-ancestry-invalid' })
  })

  test('employee collaboration joins are total for all, any and quorum outcomes', () => {
    expect(
      evaluateEmployeeInvocationJoin({
        mode: 'all',
        quorum: null,
        memberStates: ['satisfied', 'waiting'],
      }),
    ).toBe('waiting')
    expect(
      evaluateEmployeeInvocationJoin({
        mode: 'all',
        quorum: null,
        memberStates: ['satisfied', 'failed'],
      }),
    ).toBe('failed')
    expect(
      evaluateEmployeeInvocationJoin({
        mode: 'any',
        quorum: null,
        memberStates: ['satisfied', 'waiting'],
      }),
    ).toBe('satisfied')
    expect(
      evaluateEmployeeInvocationJoin({
        mode: 'any',
        quorum: null,
        memberStates: ['failed', 'detached'],
      }),
    ).toBe('failed')
    expect(
      evaluateEmployeeInvocationJoin({
        mode: 'quorum',
        quorum: 2,
        memberStates: ['satisfied', 'satisfied', 'waiting'],
      }),
    ).toBe('satisfied')
    expect(
      evaluateEmployeeInvocationJoin({
        mode: 'quorum',
        quorum: 2,
        memberStates: ['satisfied', 'failed', 'detached'],
      }),
    ).toBe('failed')
    expect(() =>
      evaluateEmployeeInvocationJoin({
        mode: 'quorum',
        quorum: 4,
        memberStates: ['waiting', 'waiting', 'waiting'],
      }),
    ).toThrow('outside member cardinality')
  })

  test('one invalid Case is blocked without starving another plannable Case', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-case-planning-isolation-'))
    roots.push(appHome)
    let now = 20_000
    let ordinal = 0
    const id = () => `planning-isolation-${++ordinal}`
    const eventCenter = composeEventCenter({
      db,
      typePackageDescriptorJsons: [
        developmentEmployeeTypePackage.descriptorJson,
        digitalEmployeeLifecycleEventCatalogJson,
      ],
      now: () => now,
      id,
    })
    const executionContracts = new ExecutionContractService({
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
            detail: 'planning isolation fixture',
            declaredContractRefs:
              implementation.kind === 'agent'
                ? developmentExecutionContractRegistrations.map(
                    (registration) => registration.contractRef,
                  )
                : null,
          }
        },
      },
      programFixtures: {
        async validate() {
          return [{ code: 'planning-isolation', ok: true, detail: 'fixture validated' }]
        },
      },
    })
    const module = composeDigitalEmployee({
      db,
      appHome,
      typePackages: [developmentEmployeeTypePackage],
      executionContracts,
      now: () => now,
      id,
      runtime: {
        eventCenter: eventCenter.participant,
        codecs: [developmentEmployeeRuntimeCodec],
        platformWorkItems: {
          async execute() {
            throw new Error('planning isolation does not execute platform work')
          },
        },
        execution: {
          async launch() {
            throw new Error('planning isolation does not launch business work')
          },
          async inspect() {
            return { kind: 'pending' as const, executionRef: 'unused' }
          },
          async cancel() {},
        },
      },
    })
    const typeRef = { typeId: 'development', revision: 9 }
    const analyzeTool = await module.commands.createTool({
      typeRef,
      workItemRef: 'analyze-implement',
      actorUserId: 'planning-author',
      body: {
        displayName: '仅实现工具',
        description: '故意不提供外部材料获取工具',
        roleRef: 'primary',
        implementation: { kind: 'agent', agentRef: { id: 'planning-agent', revision: 1 } },
      },
    })
    const analyzeToolRef = await module.commands.publishTool({
      typeRef,
      workItemRef: 'analyze-implement',
      toolId: analyzeTool.id,
      actorUserId: 'planning-author',
    })
    const job = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'planning-author',
      body: {
        name: '仅正文输入岗位',
        description: '正文可走平台材料节点，外部编号缺少所需工具',
        defaultToolBindings: [
          {
            workItemRef: 'analyze-implement',
            slotRef: 'default',
            registrationRef: analyzeToolRef,
          },
        ],
      },
    })
    const jobRef = module.commands.publishJobTemplate({
      id: job.id,
      actorUserId: 'planning-author',
    })
    const employee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'planning-author',
      body: {
        name: '规划隔离员工',
        jobTemplateRef: jobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-planning' },
      },
    })
    const employeeRef = { id: employee.id, revision: employee.revision }
    const launch = (subjectRef: string, request: Record<string, unknown>) =>
      module.runtime!.commands.launch({
        employeeRef,
        primaryContextTypeId: 'development.issue-handling',
        primaryContextSchemaVersion: 1,
        primaryContextState: 'active',
        primaryContextJson: JSON.stringify({
          status: 'active',
          subjectRef,
          repositoryRef: 'repo-planning',
          request,
          materialArtifactRefs: [],
        }),
        artifactRefs: [],
        workSubject: { typeId: 'work-request', subjectRef },
      })
    const healthy = launch('BODY-1', {
      kind: 'body',
      body: '正文输入应由平台材料节点处理',
      externalId: null,
      uploads: [],
      executionOptions: {},
    })
    now += 1
    const invalid = launch('EXTERNAL-1', {
      kind: 'external-id',
      body: null,
      externalId: 'EXTERNAL-1',
      uploads: [],
      executionOptions: {},
    })

    const planned = module.runtime!.worker.planOneReaction()
    const plannedRound = db
      .select()
      .from(employeeReactionRounds)
      .where(eq(employeeReactionRounds.id, planned!))
      .get()
    expect(plannedRound?.caseId).toBe(healthy.caseRef.id)
    expect(
      JSON.parse(module.runtime!.queries.getCase(invalid.caseRef.id).projectionJson).case,
    ).toMatchObject({
      state: 'blocked',
      blockReason: expect.stringContaining('employee-tool-binding-unavailable'),
    })
    expect(
      JSON.parse(module.runtime!.queries.getCase(healthy.caseRef.id).projectionJson).case,
    ).toMatchObject({
      state: 'active',
      activeRoundId: planned,
    })

    // Real-environment regression 2026-08-24: a collaboration child Case was
    // frozen as missing prepare-materials/default by an older process even
    // though the current type codec now routes its body intake to the platform
    // slot. Recovery must re-evaluate the current deterministic selection.
    now += 1
    const legacyPlatformRecovery = launch('BODY-LEGACY-PLATFORM', {
      kind: 'body',
      body: '旧进程误选 default 后，当前平台槽位必须自动恢复',
      externalId: null,
      uploads: [],
      executionOptions: {},
    })
    const legacyPlatformRecoveryRow = db
      .select()
      .from(employeeCases)
      .where(eq(employeeCases.id, legacyPlatformRecovery.caseRef.id))
      .get()!
    db.update(employeeCases)
      .set({
        state: 'blocked',
        blockReason:
          'reaction-planning-failed: employee-tool-binding-unavailable: no exact published tool for prepare-materials/default',
        currentWorkItemRef: 'prepare-materials',
        activeRoundId: null,
        revision: legacyPlatformRecoveryRow.revision + 1,
        updatedAt: now,
      })
      .where(eq(employeeCases.id, legacyPlatformRecovery.caseRef.id))
      .run()
    const legacyRecoveredRound = module.runtime!.worker.planOneReaction()
    expect(legacyRecoveredRound).not.toBeNull()
    expect(
      JSON.parse(module.runtime!.queries.getCase(legacyPlatformRecovery.caseRef.id).projectionJson)
        .case,
    ).toMatchObject({
      state: 'active',
      blockReason: null,
      currentWorkItemRef: 'prepare-materials',
      activeRoundId: legacyRecoveredRound,
    })

    const recoverable = launch('BODY-RECOVERABLE', {
      kind: 'body',
      body: '精确工具暂时不可用后应自动恢复规划',
      externalId: null,
      uploads: [],
      executionOptions: {},
    })
    now += 1
    const recoverableRow = db
      .select()
      .from(employeeCases)
      .where(eq(employeeCases.id, recoverable.caseRef.id))
      .get()!
    db.update(employeeCases)
      .set({
        currentWorkItemRef: 'analyze-implement',
        revision: recoverableRow.revision + 1,
        updatedAt: now,
      })
      .where(eq(employeeCases.id, recoverable.caseRef.id))
      .run()
    const frozenToolRevision = db
      .select()
      .from(employeeToolRegistrationRevisions)
      .where(
        and(
          eq(employeeToolRegistrationRevisions.toolId, analyzeToolRef.id),
          eq(employeeToolRegistrationRevisions.revision, analyzeToolRef.revision),
        ),
      )
      .get()!
    db.delete(employeeToolRegistrationRevisions)
      .where(
        and(
          eq(employeeToolRegistrationRevisions.toolId, analyzeToolRef.id),
          eq(employeeToolRegistrationRevisions.revision, analyzeToolRef.revision),
        ),
      )
      .run()
    expect(module.runtime!.worker.planOneReaction()).toBeNull()
    expect(
      JSON.parse(module.runtime!.queries.getCase(recoverable.caseRef.id).projectionJson).case,
    ).toMatchObject({
      state: 'blocked',
      currentWorkItemRef: 'analyze-implement',
      blockReason: expect.stringContaining('employee-tool-binding-unavailable'),
    })

    db.insert(employeeToolRegistrationRevisions).values(frozenToolRevision).run()
    now += 1
    const recoveredRound = module.runtime!.worker.planOneReaction()
    expect(recoveredRound).not.toBeNull()
    expect(
      JSON.parse(module.runtime!.queries.getCase(recoverable.caseRef.id).projectionJson).case,
    ).toMatchObject({
      state: 'active',
      blockReason: null,
      currentWorkItemRef: 'analyze-implement',
      activeRoundId: recoveredRound,
    })
  })

  test('WorkStart directly fixes the first work item while lifecycle facts remain durable and multicast', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-case-runtime-'))
    roots.push(appHome)
    let now = 30_000
    let ordinal = 0
    let retryLimits = { defaultNodeRetries: 3, sessionRestartBudget: 1 }
    let corruptOutputsRemaining = 3
    let executionOutput: Record<string, unknown> = {
      outcome: 'completed',
      commitMessage: 'implement deterministic employee runtime',
      mergeRequestTitle: 'Implement deterministic employee runtime',
      mergeRequestDescription: 'Implements the requested deterministic employee runtime.',
    }
    let observedMergeRequestStatus: 'active' | 'merged' = 'active'
    const launchedPlans: unknown[] = []
    const launchedAttempts: Array<{ ordinal: number; mode: string }> = []
    const nextId = () => `resource-${String(++ordinal).padStart(4, '0')}`
    const eventCenter = composeEventCenter({
      db,
      typePackageDescriptorJsons: [
        developmentEmployeeTypePackage.descriptorJson,
        digitalEmployeeLifecycleEventCatalogJson,
      ],
      now: () => now,
      id: nextId,
    })
    const executionContracts = new ExecutionContractService({
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
            detail: 'runtime test exact executor',
            declaredContractRefs:
              implementation.kind === 'agent'
                ? developmentExecutionContractRegistrations.map(
                    (registration) => registration.contractRef,
                  )
                : null,
          }
        },
      },
      programFixtures: {
        async validate() {
          return [{ code: 'runtime-test-fixture', ok: true, detail: 'exact test fixture' }]
        },
      },
    })
    const module = composeDigitalEmployee({
      db,
      appHome,
      typePackages: [developmentEmployeeTypePackage],
      executionContracts,
      retryLimits: { current: () => retryLimits },
      now: () => now,
      id: nextId,
      connectionCatalog: {
        async resolve(ref) {
          const purpose =
            ref.id === 'pipeline-adapter'
              ? 'pipeline-gate'
              : ref.id === 'requirement-adapter'
                ? 'requirement-source'
                : 'approval-gateway'
          return {
            ref,
            purpose,
            available: true,
            closureSummary: `exact ${purpose} fixture`,
          }
        },
      },
      runtime: {
        eventCenter: eventCenter.participant,
        codecs: [developmentEmployeeRuntimeCodec],
        platformWorkItems: {
          async execute(plan) {
            const inputEnvelope = JSON.parse(plan.inputEnvelopeJson) as { contextsJson: string }
            const contexts = JSON.parse(inputEnvelope.contextsJson) as Array<{
              id: string
              revision: number
              typeId: string
              stateJson: string
              artifactRefs: string[]
            }>
            if (
              plan.workItemRef === 'prepare-materials' &&
              plan.employeeTypeRef?.typeId === 'development' &&
              plan.employeeTypeRef.revision >= 9
            ) {
              return JSON.stringify({ outcome: 'completed' })
            }
            if (plan.workItemRef === 'observe-mr' && observedMergeRequestStatus === 'merged') {
              const mergeRequestContext = contexts.find(
                (context) => context.typeId === 'development.merge-request',
              )!
              return JSON.stringify({
                schemaVersion: 1,
                roundRef: plan.roundRef,
                executionNonce: plan.executionNonce,
                status: 'ok',
                summary: '平台已确认 MR merged 终态',
                contextPatches: [
                  {
                    contextId: mergeRequestContext.id,
                    contextTypeId: mergeRequestContext.typeId,
                    schemaVersion: 1,
                    expectedRevision: mergeRequestContext.revision,
                    lifecycleState: 'terminal',
                    stateJson: JSON.stringify({
                      ...JSON.parse(mergeRequestContext.stateJson),
                      status: 'merged',
                      readyToMerge: false,
                    }),
                    artifactRefs: mergeRequestContext.artifactRefs,
                  },
                ],
                effectSuggestions: [],
                artifactRefs: [],
              })
            }
            if (plan.workItemRef === 'classify-feedback') {
              const mergeRequestContext = contexts.find(
                (context) => context.typeId === 'development.merge-request',
              )!
              const mergeRequest = JSON.parse(mergeRequestContext.stateJson) as {
                mergeRequestRef: string
                headSha: string
                reviewThreads: Array<{
                  threadRef: string
                  revision: string
                  authorClass: 'human' | 'bot' | 'self'
                  resolved: boolean
                  body: string
                  path: string | null
                  messages?: Array<{
                    messageRef: string
                    parentMessageRef: string | null
                    authorClass: 'human' | 'bot' | 'self'
                    body: string
                    path: string | null
                    createdAt: string | null
                  }>
                }>
              }
              const thread = mergeRequest.reviewThreads[0]!
              return JSON.stringify({
                schemaVersion: 1,
                roundRef: plan.roundRef,
                executionNonce: plan.executionNonce,
                status: 'ok',
                summary: '平台已汇总完整检视意见树',
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
                      headSha: mergeRequest.headSha,
                      remainingTypes: ['review'],
                      problems: [
                        {
                          problemId: thread.threadRef,
                          type: 'review',
                          summary: thread.body,
                          evidenceArtifactRefs: [],
                          reviewThread: { ...thread, messages: thread.messages ?? [] },
                        },
                      ],
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
                      mergeRequestRef: mergeRequest.mergeRequestRef,
                      sourceHeadSha: mergeRequest.headSha,
                      publishedHeadSha: null,
                      commitSha: null,
                      threads: [
                        {
                          threadRef: thread.threadRef,
                          revision: thread.revision,
                          acknowledgement: null,
                          disposition: null,
                          replyBody: null,
                          finalReply: null,
                        },
                      ],
                    }),
                    artifactRefs: [],
                  },
                ],
                effectSuggestions: [],
                artifactRefs: [],
              })
            }
            if (plan.workItemRef === 'acknowledge-feedback') {
              const resolutionContext = contexts.find(
                (context) => context.typeId === 'development.review-resolution',
              )!
              const resolution = JSON.parse(resolutionContext.stateJson) as {
                threads: Array<{ threadRef: string; revision: string }>
              }
              return JSON.stringify({
                schemaVersion: 1,
                roundRef: plan.roundRef,
                executionNonce: plan.executionNonce,
                status: 'ok',
                summary: '平台已逐线程回复收到',
                contextPatches: [
                  {
                    contextId: resolutionContext.id,
                    contextTypeId: 'development.review-resolution',
                    schemaVersion: 1,
                    expectedRevision: resolutionContext.revision,
                    lifecycleState: 'active',
                    stateJson: JSON.stringify({
                      ...JSON.parse(resolutionContext.stateJson),
                      status: 'acknowledged',
                      threads: resolution.threads.map((thread) => ({
                        ...thread,
                        acknowledgement: {
                          marker: `agent-workflow:review:${thread.threadRef}:ack`,
                          noteRef: `note:${thread.threadRef}:ack`,
                        },
                      })),
                    }),
                    artifactRefs: resolutionContext.artifactRefs,
                  },
                ],
                effectSuggestions: [],
                artifactRefs: [],
              })
            }
            if (plan.workItemRef !== 'publish-mr') {
              return JSON.stringify({
                schemaVersion: 1,
                roundRef: plan.roundRef,
                executionNonce: plan.executionNonce,
                status: 'ok',
                summary: `${plan.workItemRef} completed`,
                contextPatches: [],
                effectSuggestions: [],
                artifactRefs: [],
              })
            }
            return JSON.stringify({
              schemaVersion: 1,
              roundRef: plan.roundRef,
              executionNonce: plan.executionNonce,
              status: 'ok',
              summary: '平台已提交并创建 MR',
              contextPatches: [
                {
                  contextId: null,
                  contextTypeId: 'development.merge-request',
                  schemaVersion: 1,
                  expectedRevision: null,
                  lifecycleState: 'active',
                  stateJson: JSON.stringify({
                    status: 'active',
                    mergeRequestRef: 'repo-1!42',
                    headSha: 'a'.repeat(40),
                    issueHandlingContextRef: plan.inputContextRefs[0]!.id,
                    readyToMerge: false,
                    unresolvedReviewCount: 1,
                    reviewThreads: [
                      {
                        threadRef: 'review-1',
                        revision: '1:1',
                        authorClass: 'human',
                        resolved: false,
                        body: 'review feedback',
                        path: 'src/main.ts',
                      },
                    ],
                  }),
                  artifactRefs: [],
                },
                {
                  contextId: null,
                  contextTypeId: 'development.pipeline',
                  schemaVersion: 1,
                  expectedRevision: null,
                  lifecycleState: 'active',
                  stateJson: JSON.stringify({
                    status: 'pending',
                    mergeRequestRef: 'repo-1!42',
                    headSha: 'a'.repeat(40),
                    evidenceArtifactRef: '.agent-workflow/pipeline/case-1/',
                    failureTypes: [],
                  }),
                  artifactRefs: [],
                },
              ],
              effectSuggestions: [],
              artifactRefs: [],
            })
          },
        },
        execution: {
          async launch(plan, attempt) {
            launchedPlans.push(plan)
            launchedAttempts.push({ ordinal: attempt.ordinal, mode: attempt.mode })
            return { executionRef: `execution-${launchedPlans.length}` }
          },
          async inspect(executionRef) {
            const plan = launchedPlans[Number(executionRef.split('-').at(-1)) - 1] as {
              workItemRef: string
            }
            const outputForRound =
              plan.workItemRef === 'collect-pipeline'
                ? {
                    outcome: 'completed',
                    observedSourceVersion: 'a'.repeat(40),
                    status: 'failed',
                    checks: [
                      {
                        checkRef: 'unknown',
                        name: 'unknown',
                        status: 'failed',
                        evidenceFiles: ['.agent-workflow/pipeline/case-1/result.json'],
                      },
                    ],
                  }
                : executionOutput
            return {
              kind: 'completed',
              executionRef,
              outputJson: JSON.stringify(
                corruptOutputsRemaining-- > 0
                  ? { ...outputForRound, unexpectedEnvelopeField: true }
                  : outputForRound,
              ),
            }
          },
          async cancel() {},
        },
      },
    })
    const runtime = module.runtime!
    const typeRef = { typeId: 'development', revision: 9 }
    const typePackage = module.queries.getType(typeRef)
    const manifest = typePackage.authoringManifest
    const pipelineProblemDefinitions = [
      {
        routeRef: 'external-dependency',
        displayName: '跨仓依赖',
        description: '需要另一个数字员工先完成工作',
        fallback: false,
      },
      {
        routeRef: 'unknown',
        displayName: '未分类流水线错误',
        description: '没有命中更高优先级类型时使用通用修复 Agent',
        fallback: true,
      },
    ]
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
                agentRef: { id: `agent-${item.workItemRef}`, revision: 1 },
              }
            : {
                kind: 'workflow' as const,
                workflowRef: { id: `workflow-${item.workItemRef}`, revision: 1 },
              }
          const tool = await module.commands.createTool({
            typeRef,
            workItemRef: item.workItemRef,
            actorUserId: 'author',
            body: {
              displayName: `${item.workItemRef} tool`,
              description: slot.description['en-US'],
              roleRef: role.roleRef,
              implementation,
              connectionRef:
                contract.requiredConnectionPurpose === null
                  ? null
                  : {
                      id:
                        contract.requiredConnectionPurpose === 'pipeline-gate'
                          ? 'pipeline-adapter'
                          : contract.requiredConnectionPurpose === 'requirement-source'
                            ? 'requirement-adapter'
                            : 'approval-adapter',
                      revision: 1,
                    },
              ...(item.workItemRef === 'classify-pipeline'
                ? { dispatchRouteDefinitions: pipelineProblemDefinitions }
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
          bindings.push({
            workItemRef: item.workItemRef,
            slotRef: slot.slotRef,
            registrationRef: await module.commands.publishTool({
              typeRef,
              workItemRef: item.workItemRef,
              toolId: tool.id,
              actorUserId: 'author',
            }),
          })
        }
      }
    }
    const pipelineRepairTool = await module.commands.createTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      actorUserId: 'author',
      body: {
        displayName: '通用流水线修复工具',
        description: '处理岗位中配置的流水线错误类型',
        roleRef: 'repairer',
        implementation: {
          kind: 'agent',
          agentRef: { id: 'agent-repair-pipeline', revision: 1 },
        },
        connectionRef: null,
        acceptedDispatchRoutes: [{ classifierWorkItemRef: 'classify-pipeline', routeRefs: ['*'] }],
      },
    })
    const pipelineRepairRef = await module.commands.publishTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      toolId: pipelineRepairTool.id,
      actorUserId: 'author',
    })
    const repairFallbackRoute = {
      routeRef: 'unknown',
      displayName: '未分类流水线错误',
      description: '没有命中更高优先级类型时使用通用修复 Agent',
      destinationWorkItemRef: 'repair-pipeline',
      registrationRef: pipelineRepairRef,
      fallback: true,
    }
    const baseJob = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '协同目标岗位',
        description: '固定节点默认工具',
        defaultToolBindings: bindings,
        orderedDispatchConfigurations: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routes: [
              {
                routeRef: 'external-dependency',
                displayName: '跨仓依赖',
                description: '需要另一个数字员工先完成工作',
                destinationWorkItemRef: 'repair-pipeline',
                registrationRef: pipelineRepairRef,
                fallback: false,
              },
              repairFallbackRoute,
            ],
          },
        ],
      },
    })
    const baseJobRef = module.commands.publishJobTemplate({
      id: baseJob.id,
      actorUserId: 'author',
    })
    const childEmployee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '协同开发员工',
        jobTemplateRef: baseJobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const childEmployeeRef = { id: childEmployee.id, revision: childEmployee.revision }
    const secondChildEmployee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '协同开发员工二号',
        jobTemplateRef: baseJobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const secondChildEmployeeRef = {
      id: secondChildEmployee.id,
      revision: secondChildEmployee.revision,
    }
    const thirdChildEmployee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '协同开发员工三号',
        jobTemplateRef: baseJobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const thirdChildEmployeeRef = {
      id: thirdChildEmployee.id,
      revision: thirdChildEmployee.revision,
    }
    const job = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '开发岗位',
        description: '固定节点默认工具与协同员工',
        defaultToolBindings: bindings,
        defaultCollaborationBindings: [
          {
            workItemRef: 'delegate',
            memberRef: 'primary',
            targetEmployeeRef: childEmployeeRef,
            invocationContractId: 'development.cross-repository-work',
            joinMode: 'any',
            quorum: null,
          },
          {
            workItemRef: 'delegate',
            memberRef: 'secondary',
            targetEmployeeRef: secondChildEmployeeRef,
            invocationContractId: 'development.cross-repository-work',
            joinMode: 'any',
            quorum: null,
          },
        ],
        orderedDispatchConfigurations: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routes: [
              {
                routeRef: 'external-dependency',
                displayName: '跨仓依赖',
                description: '需要另一个数字员工先完成工作',
                destinationWorkItemRef: 'delegate',
                registrationRef: null,
                fallback: false,
              },
              repairFallbackRoute,
            ],
          },
        ],
      },
    })
    const jobRef = module.commands.publishJobTemplate({ id: job.id, actorUserId: 'author' })
    const employee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '开发一号',
        jobTemplateRef: jobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const employeeRef = { id: employee.id, revision: employee.revision }
    const quorumJob = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '三方协同开发岗位',
        description: '三个独立子员工中任意两个完成后继续',
        defaultToolBindings: bindings,
        defaultCollaborationBindings: [
          {
            workItemRef: 'delegate',
            memberRef: 'quorum-primary',
            targetEmployeeRef: childEmployeeRef,
            invocationContractId: 'development.cross-repository-work',
            joinMode: 'quorum',
            quorum: 2,
          },
          {
            workItemRef: 'delegate',
            memberRef: 'quorum-secondary',
            targetEmployeeRef: secondChildEmployeeRef,
            invocationContractId: 'development.cross-repository-work',
            joinMode: 'quorum',
            quorum: 2,
          },
          {
            workItemRef: 'delegate',
            memberRef: 'quorum-tertiary',
            targetEmployeeRef: thirdChildEmployeeRef,
            invocationContractId: 'development.cross-repository-work',
            joinMode: 'quorum',
            quorum: 2,
          },
        ],
        orderedDispatchConfigurations: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routes: [
              {
                routeRef: 'external-dependency',
                displayName: '跨仓依赖',
                description: '需要另一个数字员工先完成工作',
                destinationWorkItemRef: 'delegate',
                registrationRef: null,
                fallback: false,
              },
              repairFallbackRoute,
            ],
          },
        ],
      },
    })
    const quorumJobRef = module.commands.publishJobTemplate({
      id: quorumJob.id,
      actorUserId: 'author',
    })
    const quorumEmployee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '三方协同员工',
        jobTemplateRef: quorumJobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const quorumEmployeeRef = {
      id: quorumEmployee.id,
      revision: quorumEmployee.revision,
    }
    const allJob = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '全员协同开发岗位',
        description: '两个独立子员工必须全部完成后继续',
        defaultToolBindings: bindings,
        defaultCollaborationBindings: [
          {
            workItemRef: 'delegate',
            memberRef: 'all-primary',
            targetEmployeeRef: childEmployeeRef,
            invocationContractId: 'development.cross-repository-work',
            joinMode: 'all',
            quorum: null,
          },
          {
            workItemRef: 'delegate',
            memberRef: 'all-secondary',
            targetEmployeeRef: secondChildEmployeeRef,
            invocationContractId: 'development.cross-repository-work',
            joinMode: 'all',
            quorum: null,
          },
        ],
        orderedDispatchConfigurations: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routes: [
              {
                routeRef: 'external-dependency',
                displayName: '跨仓依赖',
                description: '需要另一个数字员工先完成工作',
                destinationWorkItemRef: 'delegate',
                registrationRef: null,
                fallback: false,
              },
              repairFallbackRoute,
            ],
          },
        ],
      },
    })
    const allJobRef = module.commands.publishJobTemplate({
      id: allJob.id,
      actorUserId: 'author',
    })
    const allEmployee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '全员协同员工',
        jobTemplateRef: allJobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const allEmployeeRef = { id: allEmployee.id, revision: allEmployee.revision }

    const launched = runtime.commands.launch({
      employeeRef,
      primaryContextTypeId: 'development.issue-handling',
      primaryContextSchemaVersion: 1,
      primaryContextState: 'active',
      primaryContextJson: JSON.stringify({
        status: 'active',
        subjectRef: 'REQ-42',
        repositoryRef: 'repo-1',
        request: {
          kind: 'body-and-files',
          body: '实现一个确定性的数字员工运行链',
          externalId: null,
          uploads: [
            {
              artifactRef: 'input-artifact-1',
              targetPath: 'docs/requirements/REQ-42.md',
              originalName: 'REQ-42.md',
            },
          ],
        },
        materialArtifactRefs: [],
      }),
      artifactRefs: ['input-artifact-1'],
      workSubject: { typeId: 'work-request', subjectRef: 'REQ-42' },
    })
    expect(launched.state).toBe('active')
    expect(JSON.parse(launched.projectionJson)).toMatchObject({
      capabilityActivation: {
        displayName: '开发一号',
        jobTemplateRef: jobRef,
        activeWorkItemRefs: expect.arrayContaining(['prepare-materials', 'analyze-implement']),
        executionOptions: { 'review-implementation-plan': false },
        exactOrderedDispatchConfigurations: [
          expect.objectContaining({ classifierWorkItemRef: 'classify-pipeline' }),
        ],
      },
      contexts: [
        {
          state: {
            request: {
              kind: 'body-and-files',
              uploads: [{ targetPath: 'docs/requirements/REQ-42.md' }],
            },
          },
        },
      ],
      attention: [],
    })

    expect(await runtime.worker.runOneOutbox()).toBe('completed')
    const lifecycleSubscribers = ['case-auditor', 'case-parent'].map((subscriberRef) => ({
      kind: 'system' as const,
      subscriberRef,
    }))
    for (const subscriber of lifecycleSubscribers) {
      eventCenter.participant.subscribe({
        eventTypeRef: EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF,
        subject: { typeId: 'digital-employee.case', subjectRef: launched.caseRef.id },
        subscriber,
      })
    }
    const auditorLifecycle = eventCenter.participant.pendingDeliveries(lifecycleSubscribers[0]!, 10)
    const parentLifecycle = eventCenter.participant.pendingDeliveries(lifecycleSubscribers[1]!, 10)
    expect(auditorLifecycle).toHaveLength(1)
    expect(parentLifecycle).toHaveLength(1)
    expect(auditorLifecycle[0]).toMatchObject({
      eventTypeRef: EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF,
      sourceRef: EMPLOYEE_LIFECYCLE_SOURCE_REF,
      subject: { typeId: 'digital-employee.case', subjectRef: launched.caseRef.id },
    })
    expect(auditorLifecycle[0]!.eventId).toBe(parentLifecycle[0]!.eventId)
    expect(auditorLifecycle[0]!.deliveryId).not.toBe(parentLifecycle[0]!.deliveryId)
    eventCenter.participant.acceptDelivery(auditorLifecycle[0]!.deliveryId)
    expect(eventCenter.participant.pendingDeliveries(lifecycleSubscribers[0]!, 10)).toEqual([])
    expect(eventCenter.participant.pendingDeliveries(lifecycleSubscribers[1]!, 10)).toHaveLength(1)
    expect(await runtime.worker.runOneOutbox()).toBe('idle')
    expect(runtime.worker.pumpOneDelivery()).toBe(false)
    const roundId = runtime.worker.planOneReaction()
    expect(roundId).not.toBeNull()
    let projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.activeRound).toMatchObject({
      id: roundId,
      ruleId: 'continue-prepare-materials',
      workItemRef: 'prepare-materials',
      executionPolicyRevision: 1,
    })
    expect(projection.inbox).toEqual([])

    expect(await runtime.worker.runOneOutbox()).toBe('completed')
    expect(launchedPlans).toHaveLength(0)
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.rounds[0]).toMatchObject({ state: 'completed' })
    expect(projection.case).toMatchObject({
      state: 'active',
      currentWorkItemRef: 'analyze-implement',
    })

    const analyzeRound = runtime.worker.planOneReaction()
    expect(analyzeRound).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Lifecycle publication can precede the Agent launch outbox.
    }
    expect(launchedPlans).toHaveLength(1)
    expect(launchedPlans[0]).toMatchObject({
      roundRef: analyzeRound,
      employeeTypeRef: typeRef,
      implementationKind: 'agent',
      inputSchemaId: 'development.implement-change.input.v2',
      outputSchemaId: 'development.implement-change.result.v2',
      allowedEffectKinds: [],
    })
    const retryDelays = [2_000, 4_000, 8_000]
    for (const retryDelay of retryDelays) {
      expect(await runtime.worker.inspectOneExecution()).toBe('retried')
      expect(await runtime.worker.runOneOutbox()).toBe('idle')
      now += retryDelay
      expect(await runtime.worker.runOneOutbox()).toBe('completed')
    }
    expect(launchedAttempts.slice(0, 4)).toEqual([
      { ordinal: 0, mode: 'initial' },
      { ordinal: 1, mode: 'same-scene' },
      { ordinal: 2, mode: 'same-scene' },
      { ordinal: 3, mode: 'same-scene' },
    ])
    expect(await runtime.worker.inspectOneExecution()).toBe('completed')
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.activeRound).toBeUndefined()
    expect(projection.inbox).toEqual([])
    expect(projection.case).toMatchObject({
      state: 'active',
      currentWorkItemRef: 'prepare-change',
    })
    expect(projection.attention).toEqual([])

    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Attention cleanup may precede the deterministic platform work item.
    }
    expect(
      JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson).case
        .currentWorkItemRef,
    ).toBe('publish-mr')

    expect(runtime.worker.planOneReaction()).not.toBeNull()
    expect(await runtime.worker.runOneOutbox()).toBe('completed')
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.case.currentWorkItemRef).toBe('observe-mr')
    expect(projection.contexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          typeId: 'development.merge-request',
          state: expect.objectContaining({ mergeRequestRef: 'repo-1!42' }),
        }),
      ]),
    )
    expect(
      projection.attention.filter(
        (binding: { state: string; subject: { subjectRef: string } }) =>
          binding.state === 'desired' && binding.subject.subjectRef === 'repo-1!42',
      ),
    ).toHaveLength(4)

    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Activate every MR attention binding before exercising collaboration.
    }
    const parentRow = db
      .select()
      .from(employeeCases)
      .where(eq(employeeCases.id, launched.caseRef.id))
      .get()!
    db.update(employeeCases)
      .set({
        state: 'active',
        currentWorkItemRef: 'delegate',
        revision: parentRow.revision + 1,
        updatedAt: now + 1,
      })
      .where(eq(employeeCases.id, launched.caseRef.id))
      .run()
    const delegationRound = runtime.worker.planOneReaction()
    expect(delegationRound).not.toBeNull()
    expect(await runtime.worker.runOneOutbox()).toBe('completed')
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.case.state).toBe('waiting')
    expect(projection.channels).toHaveLength(2)
    expect(projection.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'open', targetEmployeeRef: childEmployeeRef }),
        expect.objectContaining({ state: 'open', targetEmployeeRef: secondChildEmployeeRef }),
      ]),
    )
    const primaryChannel = projection.channels.find(
      (channel: { targetEmployeeRef: { id: string } }) =>
        channel.targetEmployeeRef.id === childEmployeeRef.id,
    )!
    const secondaryChannel = projection.channels.find(
      (channel: { targetEmployeeRef: { id: string } }) =>
        channel.targetEmployeeRef.id === secondChildEmployeeRef.id,
    )!
    const childCaseId = primaryChannel.childCaseId as string
    const detachedChildCaseId = secondaryChannel.childCaseId as string
    const childProjection = JSON.parse(runtime.queries.getCase(childCaseId).projectionJson)
    expect(childProjection.case.employeeRef).toEqual(childEmployeeRef)
    expect(childProjection.channels).toEqual([])
    const collaborationCases = JSON.parse(runtime.queries.listCasePage({ limit: 100 })) as {
      items: Array<{ id: string; openChannelCount: number }>
    }
    expect(
      collaborationCases.items.find((candidate) => candidate.id === launched.caseRef.id),
    ).toMatchObject({ openChannelCount: 2 })
    expect(
      collaborationCases.items.find((candidate) => candidate.id === childCaseId),
    ).toMatchObject({ openChannelCount: 0 })
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Activate the collaboration result subscription and settle child ingress outbox.
    }
    runtime.commands.terminate(childCaseId, 'completed')
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    for (let index = 0; index < 8; index += 1) {
      runtime.worker.pumpOneDelivery()
    }
    const resultRound = runtime.worker.planOneReaction()
    expect(resultRound).not.toBeNull()

    // Regression: an Attention can become desired again before its older
    // unsubscribe effect runs. The reactivation must retain ownership of the
    // live subscription, and the stale effect must not cancel it afterwards.
    const pipelineAttentionBeforeReactivation = db
      .select()
      .from(employeeAttentionBindings)
      .where(
        and(
          eq(employeeAttentionBindings.caseId, launched.caseRef.id),
          eq(employeeAttentionBindings.eventTypeId, 'development.pipeline-check-due'),
        ),
      )
      .get()!
    expect(pipelineAttentionBeforeReactivation.state).toBe('active')
    expect(pipelineAttentionBeforeReactivation.eventSubscriptionId).not.toBeNull()
    const pipelineSubscriptionId = pipelineAttentionBeforeReactivation.eventSubscriptionId!
    const delayedUnsubscribeAt = now + 10_000
    db.update(employeeAttentionBindings)
      .set({ state: 'cancel-requested', updatedAt: now })
      .where(eq(employeeAttentionBindings.id, pipelineAttentionBeforeReactivation.id))
      .run()
    db.insert(employeeOsOutbox)
      .values({
        id: `attention-race-unsubscribe:${launched.caseRef.id}`,
        caseId: launched.caseRef.id,
        kind: 'event-unsubscribe',
        payloadJson: JSON.stringify({
          bindingId: pipelineAttentionBeforeReactivation.id,
          subscriptionId: pipelineSubscriptionId,
        }),
        dedupeKey: `attention-race-unsubscribe:${launched.caseRef.id}`,
        state: 'pending',
        attemptCount: 0,
        nextAttemptAt: delayedUnsubscribeAt,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    let reactivatedPipelineAttention: typeof pipelineAttentionBeforeReactivation = {
      ...pipelineAttentionBeforeReactivation,
      state: 'cancel-requested' as const,
    }
    for (let step = 0; step < 12 && reactivatedPipelineAttention.state !== 'desired'; step += 1) {
      expect(await runtime.worker.runOneOutbox()).toBe('completed')
      reactivatedPipelineAttention = db
        .select()
        .from(employeeAttentionBindings)
        .where(eq(employeeAttentionBindings.id, pipelineAttentionBeforeReactivation.id))
        .get()!
    }
    expect(reactivatedPipelineAttention).toMatchObject({
      state: 'desired',
      eventSubscriptionId: pipelineSubscriptionId,
    })
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Activate the replacement Attention while its superseded cleanup stays delayed.
    }
    const activePipelineAttention = db
      .select()
      .from(employeeAttentionBindings)
      .where(eq(employeeAttentionBindings.id, pipelineAttentionBeforeReactivation.id))
      .get()!
    expect(activePipelineAttention).toMatchObject({
      state: 'active',
      eventSubscriptionId: pipelineSubscriptionId,
    })
    now = delayedUnsubscribeAt
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // A superseded unsubscribe is completed as a guarded no-op.
    }
    expect(
      db
        .select({ state: eventSubscriptions.state })
        .from(eventSubscriptions)
        .where(eq(eventSubscriptions.id, pipelineSubscriptionId))
        .get(),
    ).toEqual({ state: 'active' })
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ childCaseId, state: 'satisfied' }),
        expect.objectContaining({ childCaseId: detachedChildCaseId, state: 'detached' }),
      ]),
    )
    expect(projection.case).toMatchObject({
      state: 'waiting',
      currentWorkItemRef: null,
      blockReason: null,
    })
    expect(
      projection.contexts.find(
        (context: { typeId: string }) => context.typeId === 'development.pipeline',
      ),
    ).toMatchObject({
      lifecycleState: 'active',
      state: { status: 'pending', failureTypes: [] },
    })
    expect(
      projection.contexts.find(
        (context: { typeId: string }) => context.typeId === 'development.problem-set',
      ),
    ).toBeUndefined()
    expect(projection.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
          state: 'active',
        }),
      ]),
    )
    const parentInboxCountAfterAnyJoin = projection.inbox.length
    runtime.commands.terminate(detachedChildCaseId, 'completed-late')
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(
      projection.channels.find(
        (channel: { childCaseId: string }) => channel.childCaseId === detachedChildCaseId,
      ).results,
    ).toEqual([expect.objectContaining({ milestoneType: 'observed-late' })])
    expect(projection.inbox).toHaveLength(parentInboxCountAfterAnyJoin)

    // Persist the quorum path as a second real parent Case. Two of three child
    // completions satisfy the join; the remaining channel is detached and a
    // late result is retained as observation-only evidence.
    const quorumLaunched = runtime.commands.launch({
      employeeRef: quorumEmployeeRef,
      primaryContextTypeId: 'development.issue-handling',
      primaryContextSchemaVersion: 1,
      primaryContextState: 'active',
      primaryContextJson: JSON.stringify({
        status: 'active',
        subjectRef: 'REQ-QUORUM',
        repositoryRef: 'repo-1',
        request: {
          kind: 'body',
          body: '由三个独立数字员工中的任意两个完成协同修复',
          externalId: null,
          uploads: [],
        },
        materialArtifactRefs: [],
      }),
      artifactRefs: [],
      workSubject: { typeId: 'work-request', subjectRef: 'REQ-QUORUM' },
    })
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Publish the quorum parent launch before forcing its collaboration node.
    }
    const quorumParentRow = db
      .select()
      .from(employeeCases)
      .where(eq(employeeCases.id, quorumLaunched.caseRef.id))
      .get()!
    db.update(employeeCases)
      .set({
        state: 'active',
        currentWorkItemRef: 'delegate',
        revision: quorumParentRow.revision + 1,
        updatedAt: now + 1,
      })
      .where(eq(employeeCases.id, quorumLaunched.caseRef.id))
      .run()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Create all three durable invocation channels and child Cases.
    }
    let quorumProjection = JSON.parse(
      runtime.queries.getCase(quorumLaunched.caseRef.id).projectionJson,
    )
    expect(quorumProjection.channels).toHaveLength(3)
    expect(quorumProjection.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'open', targetEmployeeRef: childEmployeeRef }),
        expect.objectContaining({ state: 'open', targetEmployeeRef: secondChildEmployeeRef }),
        expect.objectContaining({ state: 'open', targetEmployeeRef: thirdChildEmployeeRef }),
      ]),
    )
    const quorumChannels = quorumProjection.channels as Array<{
      childCaseId: string
      targetEmployeeRef: { id: string }
    }>
    const quorumChildCaseId = (employeeId: string) =>
      quorumChannels.find((channel) => channel.targetEmployeeRef.id === employeeId)!.childCaseId
    const quorumPrimaryCaseId = quorumChildCaseId(childEmployeeRef.id)
    const quorumSecondaryCaseId = quorumChildCaseId(secondChildEmployeeRef.id)
    const quorumLateCaseId = quorumChildCaseId(thirdChildEmployeeRef.id)
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Activate all three exact invocation-result subscriptions.
    }

    runtime.commands.terminate(quorumPrimaryCaseId, 'quorum-primary-completed')
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    for (let index = 0; index < 8; index += 1) runtime.worker.pumpOneDelivery()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Settle the first result; quorum must still be waiting.
    }
    quorumProjection = JSON.parse(runtime.queries.getCase(quorumLaunched.caseRef.id).projectionJson)
    expect(
      quorumProjection.channels.find(
        (channel: { childCaseId: string }) => channel.childCaseId === quorumPrimaryCaseId,
      ),
    ).toMatchObject({ state: 'satisfied' })
    expect(
      quorumProjection.channels.filter((channel: { state: string }) => channel.state === 'open'),
    ).toHaveLength(2)
    expect(quorumProjection.case.state).toBe('waiting')

    runtime.commands.terminate(quorumSecondaryCaseId, 'quorum-secondary-completed')
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    for (let index = 0; index < 8; index += 1) runtime.worker.pumpOneDelivery()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // The second result satisfies 2/3 and durably detaches the final channel.
    }
    quorumProjection = JSON.parse(runtime.queries.getCase(quorumLaunched.caseRef.id).projectionJson)
    expect(
      quorumProjection.channels.filter(
        (channel: { state: string }) => channel.state === 'satisfied',
      ),
    ).toHaveLength(2)
    expect(
      quorumProjection.channels.find(
        (channel: { childCaseId: string }) => channel.childCaseId === quorumLateCaseId,
      ),
    ).toMatchObject({ state: 'detached' })
    expect(quorumProjection.case).toMatchObject({
      state: 'waiting',
      currentWorkItemRef: null,
      blockReason: null,
    })
    const quorumInboxCountAfterJoin = quorumProjection.inbox.length
    runtime.commands.terminate(quorumLateCaseId, 'quorum-tertiary-completed-late')
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    quorumProjection = JSON.parse(runtime.queries.getCase(quorumLaunched.caseRef.id).projectionJson)
    expect(
      quorumProjection.channels.find(
        (channel: { childCaseId: string }) => channel.childCaseId === quorumLateCaseId,
      ).results,
    ).toEqual([expect.objectContaining({ milestoneType: 'observed-late' })])
    expect(quorumProjection.inbox).toHaveLength(quorumInboxCountAfterJoin)

    const allLaunched = runtime.commands.launch({
      employeeRef: allEmployeeRef,
      primaryContextTypeId: 'development.issue-handling',
      primaryContextSchemaVersion: 1,
      primaryContextState: 'active',
      primaryContextJson: JSON.stringify({
        status: 'active',
        subjectRef: 'REQ-ALL',
        repositoryRef: 'repo-1',
        request: {
          kind: 'body',
          body: '等待两个数字员工全部完成协同修复',
          externalId: null,
          uploads: [],
        },
        materialArtifactRefs: [],
      }),
      artifactRefs: [],
      workSubject: { typeId: 'work-request', subjectRef: 'REQ-ALL' },
    })
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Publish the all-join parent launch.
    }
    const allParentRow = db
      .select()
      .from(employeeCases)
      .where(eq(employeeCases.id, allLaunched.caseRef.id))
      .get()!
    db.update(employeeCases)
      .set({
        state: 'active',
        currentWorkItemRef: 'delegate',
        revision: allParentRow.revision + 1,
        updatedAt: now + 1,
      })
      .where(eq(employeeCases.id, allLaunched.caseRef.id))
      .run()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Create both durable all-join child Cases and subscriptions.
    }
    let allProjection = JSON.parse(runtime.queries.getCase(allLaunched.caseRef.id).projectionJson)
    expect(allProjection.channels).toHaveLength(2)
    const allChildCaseIds = (allProjection.channels as Array<{ childCaseId: string }>).map(
      (channel) => channel.childCaseId,
    )
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Activate both exact invocation-result subscriptions.
    }

    runtime.commands.terminate(allChildCaseIds[0]!, 'all-primary-completed')
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    for (let index = 0; index < 8; index += 1) runtime.worker.pumpOneDelivery()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // One satisfied member cannot complete an all join.
    }
    allProjection = JSON.parse(runtime.queries.getCase(allLaunched.caseRef.id).projectionJson)
    expect(
      allProjection.channels.filter((channel: { state: string }) => channel.state === 'satisfied'),
    ).toHaveLength(1)
    expect(
      allProjection.channels.filter((channel: { state: string }) => channel.state === 'open'),
    ).toHaveLength(1)
    expect(allProjection.case.state).toBe('waiting')

    runtime.commands.terminate(allChildCaseIds[1]!, 'all-secondary-completed')
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    for (let index = 0; index < 8; index += 1) runtime.worker.pumpOneDelivery()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // The second member satisfies the exact all join.
    }
    allProjection = JSON.parse(runtime.queries.getCase(allLaunched.caseRef.id).projectionJson)
    expect(
      allProjection.channels.filter((channel: { state: string }) => channel.state === 'satisfied'),
    ).toHaveLength(2)
    expect(allProjection.case).toMatchObject({
      state: 'waiting',
      currentWorkItemRef: null,
      blockReason: null,
    })

    const partialLaunched = runtime.commands.launch({
      employeeRef: quorumEmployeeRef,
      primaryContextTypeId: 'development.issue-handling',
      primaryContextSchemaVersion: 1,
      primaryContextState: 'active',
      primaryContextJson: JSON.stringify({
        status: 'active',
        subjectRef: 'REQ-PARTIAL',
        repositoryRef: 'repo-1',
        request: {
          kind: 'body',
          body: '验证法定人数在部分成功后变得不可满足',
          externalId: null,
          uploads: [],
        },
        materialArtifactRefs: [],
      }),
      artifactRefs: [],
      workSubject: { typeId: 'work-request', subjectRef: 'REQ-PARTIAL' },
    })
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Publish the partial-result parent launch.
    }
    const partialParentRow = db
      .select()
      .from(employeeCases)
      .where(eq(employeeCases.id, partialLaunched.caseRef.id))
      .get()!
    db.update(employeeCases)
      .set({
        state: 'active',
        currentWorkItemRef: 'delegate',
        revision: partialParentRow.revision + 1,
        updatedAt: now + 1,
      })
      .where(eq(employeeCases.id, partialLaunched.caseRef.id))
      .run()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Create the three quorum channels used by the partial-result branch.
    }
    let partialProjection = JSON.parse(
      runtime.queries.getCase(partialLaunched.caseRef.id).projectionJson,
    )
    const partialChildCaseIds = (partialProjection.channels as Array<{ childCaseId: string }>).map(
      (channel) => channel.childCaseId,
    )
    expect(partialChildCaseIds).toHaveLength(3)
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Activate every invocation-result subscription.
    }

    for (const [index, terminalKind] of (['completed', 'execution-failed'] as const).entries()) {
      runtime.commands.terminate(partialChildCaseIds[index]!, terminalKind)
      expect(runtime.worker.publishOneChannelResult()).toBe('completed')
      for (let pump = 0; pump < 8; pump += 1) runtime.worker.pumpOneDelivery()
      expect(runtime.worker.planOneReaction()).not.toBeNull()
      while ((await runtime.worker.runOneOutbox()) !== 'idle') {
        // One success plus one failure still leaves quorum(2/3) reachable.
      }
    }
    partialProjection = JSON.parse(
      runtime.queries.getCase(partialLaunched.caseRef.id).projectionJson,
    )
    expect(partialProjection.case.state).toBe('waiting')
    expect(
      partialProjection.channels.filter(
        (channel: { state: string }) => channel.state === 'satisfied',
      ),
    ).toHaveLength(1)
    expect(
      partialProjection.channels.filter((channel: { state: string }) => channel.state === 'failed'),
    ).toHaveLength(1)
    expect(
      partialProjection.channels.filter((channel: { state: string }) => channel.state === 'open'),
    ).toHaveLength(1)

    runtime.commands.terminate(partialChildCaseIds[2]!, 'execution-failed')
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    for (let index = 0; index < 8; index += 1) runtime.worker.pumpOneDelivery()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // A second failed member makes quorum impossible and blocks exactly once.
    }
    partialProjection = JSON.parse(
      runtime.queries.getCase(partialLaunched.caseRef.id).projectionJson,
    )
    expect(
      partialProjection.channels.map((channel: { state: string }) => channel.state).sort(),
    ).toEqual(['failed', 'failed', 'satisfied'])
    expect(partialProjection.case).toMatchObject({
      state: 'blocked',
      currentWorkItemRef: 'delegate',
      blockReason: '协同汇合无法满足（1 成功，2 失败）',
    })

    // A second delegated Case remains independent when the parent's globally
    // pinned wait deadline expires. The channel fails and wakes the parent,
    // while the child is detached rather than silently cancelled.
    const parentBeforeTimeout = db
      .select()
      .from(employeeCases)
      .where(eq(employeeCases.id, launched.caseRef.id))
      .get()!
    db.update(employeeCases)
      .set({
        state: 'active',
        currentWorkItemRef: 'delegate',
        revision: parentBeforeTimeout.revision + 1,
        updatedAt: now + 1,
      })
      .where(eq(employeeCases.id, launched.caseRef.id))
      .run()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Prior attention cleanup may precede the new multi-member invocation outbox.
    }
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    const timedOutChannels = projection.channels.filter(
      (channel: { state: string }) => channel.state === 'open',
    )
    expect(timedOutChannels).toHaveLength(2)
    const timedOutChildCaseIds = timedOutChannels.map(
      (channel: { childCaseId: string }) => channel.childCaseId,
    )
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Activate the exact invocation-result attention before its deadline fires.
    }
    now += module.queries.getExecutionPolicy().content.externalWaitDeadlineMs + 1
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    expect(runtime.worker.publishOneChannelResult()).toBe('completed')
    for (let index = 0; index < 8; index += 1) runtime.worker.pumpOneDelivery()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Drain every durable timeout settlement before reading the projection.
    }
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    for (const timedOutChildCaseId of timedOutChildCaseIds) {
      expect(
        projection.channels.find(
          (channel: { childCaseId: string }) => channel.childCaseId === timedOutChildCaseId,
        ),
      ).toMatchObject({
        state: 'failed',
        results: [expect.objectContaining({ milestoneType: 'expired' })],
      })
    }
    expect(projection.case).toMatchObject({
      state: 'blocked',
      currentWorkItemRef: 'delegate',
      blockReason: '协同汇合无法满足（0 成功，2 失败）',
    })
    for (const timedOutChildCaseId of timedOutChildCaseIds) {
      expect(
        JSON.parse(runtime.queries.getCase(timedOutChildCaseId).projectionJson).case.state,
      ).not.toBe('terminal')
      runtime.commands.terminate(timedOutChildCaseId, 'cancelled')
    }
    const resumedAfterTimeout = JSON.parse(
      runtime.commands.resume(launched.caseRef.id).projectionJson,
    )
    expect(resumedAfterTimeout.case).toMatchObject({
      state: 'active',
      currentWorkItemRef: 'delegate',
      blockReason: null,
    })
    const resumedParent = db
      .select()
      .from(employeeCases)
      .where(eq(employeeCases.id, launched.caseRef.id))
      .get()!
    db.update(employeeCases)
      .set({
        currentWorkItemRef: 'collect-pipeline',
        revision: resumedParent.revision + 1,
        updatedAt: now + 1,
      })
      .where(eq(employeeCases.id, launched.caseRef.id))
      .run()

    const observeMrEvent = (eventTypeId: string, dedupeKey: string) => {
      now += 1
      eventCenter.commands.observe({
        sourceRef: { id: 'code-host.activity', revision: 1 },
        eventTypeRef: {
          id: eventTypeId,
          revision: eventTypeId === 'development.pipeline-check-due' ? 1 : 2,
        },
        subject: { typeId: 'merge-request', subjectRef: 'repo-1!42' },
        occurredAt: now,
        dedupeKey,
        summary: eventTypeId,
        payloadArtifactRef: null,
      })
    }
    observeMrEvent('development.pipeline-check-due', 'pipeline-red:1')
    observeMrEvent('development.pipeline-check-due', 'pipeline-red:2')
    observeMrEvent('development.review-updated', 'review-comment:1')
    for (let index = 0; index < 12; index += 1) runtime.worker.pumpOneDelivery()
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(
      projection.inbox
        .filter((item: { state: string }) => item.state === 'pending')
        .map((item: { eventTypeRef: { id: string } }) => item.eventTypeRef.id),
    ).toEqual(['development.review-updated', 'development.pipeline-check-due'])
    expect(
      projection.inbox.filter(
        (item: { state: string; eventTypeRef: { id: string } }) =>
          item.state === 'coalesced' && item.eventTypeRef.id === 'development.pipeline-check-due',
      ),
    ).toHaveLength(1)

    // The higher-priority review event preempts the deterministic pipeline recheck.
    // A provider event is only a hint, so the platform refreshes authoritative
    // MR facts before entering the optional review lane. The lower-priority
    // pipeline event stays queued for the next round.
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.activeRound).toMatchObject({
      workItemRef: 'observe-mr',
      ruleId: 'handle-review',
    })
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Attention cleanup can precede the authoritative MR refresh.
    }
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.case.currentWorkItemRef).toBe('classify-feedback')
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // The platform classifier freezes the complete review thread tree.
    }
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.case.currentWorkItemRef).toBe('acknowledge-feedback')
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Platform acknowledgement settles without launching an Agent execution.
    }
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.case.currentWorkItemRef).toBe('repair-feedback')

    // Lifecycle is the only declared preemptor: it invalidates stale repair continuation.
    observeMrEvent('development.lifecycle-updated', 'lifecycle-head-changed:1')
    for (let index = 0; index < 8; index += 1) runtime.worker.pumpOneDelivery()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.activeRound).toMatchObject({
      workItemRef: 'observe-mr',
      ruleId: 'handle-lifecycle',
    })
    const lifecycleCase = db
      .select({ activeRoundId: employeeCases.activeRoundId })
      .from(employeeCases)
      .where(eq(employeeCases.id, launched.caseRef.id))
      .get()!
    const lifecycleRound = db
      .select({ planJson: employeeReactionRounds.planJson })
      .from(employeeReactionRounds)
      .where(eq(employeeReactionRounds.id, lifecycleCase.activeRoundId!))
      .get()!
    const lifecyclePlan = JSON.parse(lifecycleRound.planJson) as { inputEnvelopeJson: string }
    const lifecycleEnvelope = JSON.parse(lifecyclePlan.inputEnvelopeJson) as {
      contextsJson: string
    }
    expect(
      (JSON.parse(lifecycleEnvelope.contextsJson) as Array<{ typeId: string }>).map(
        (context) => context.typeId,
      ),
    ).toEqual(
      expect.arrayContaining([
        'development.merge-request',
        'development.pipeline',
        'development.problem-set',
        'development.review-resolution',
      ]),
    )
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Drain the lifecycle preemption settlement.
    }

    retryLimits = { defaultNodeRetries: 5, sessionRestartBudget: 2 }
    const updatedPolicy = module.queries.getExecutionPolicy()
    expect(updatedPolicy).toMatchObject({
      revision: 2,
      content: { sameSceneAttempts: 5, freshSceneAttempts: 2 },
    })
    const preview = runtime.commands.previewPolicyUpgrade(
      launched.caseRef.id,
      updatedPolicy.revision,
    )
    const upgraded = runtime.commands.applyPolicyUpgrade(preview)
    expect(JSON.parse(upgraded.projectionJson).case.executionPolicyRevision).toBe(2)

    // A business-terminal settlement must never resurrect an Attention whose
    // older unsubscribe is still pending. This is a real lifecycle reaction,
    // not the administrative terminate command.
    const pipelineAttentionBeforeTerminal = db
      .select()
      .from(employeeAttentionBindings)
      .where(eq(employeeAttentionBindings.id, pipelineAttentionBeforeReactivation.id))
      .get()!
    expect(pipelineAttentionBeforeTerminal).toMatchObject({ state: 'active' })
    expect(pipelineAttentionBeforeTerminal.eventSubscriptionId).not.toBeNull()
    const terminalPipelineSubscriptionId = pipelineAttentionBeforeTerminal.eventSubscriptionId!
    const terminalUnsubscribeAt = now + 10_000
    db.update(employeeAttentionBindings)
      .set({ state: 'cancel-requested', updatedAt: now })
      .where(eq(employeeAttentionBindings.id, pipelineAttentionBeforeTerminal.id))
      .run()
    db.insert(employeeOsOutbox)
      .values({
        id: `attention-terminal-race-unsubscribe:${launched.caseRef.id}`,
        caseId: launched.caseRef.id,
        kind: 'event-unsubscribe',
        payloadJson: JSON.stringify({
          bindingId: pipelineAttentionBeforeTerminal.id,
          subscriptionId: terminalPipelineSubscriptionId,
        }),
        dedupeKey: `attention-terminal-race-unsubscribe:${launched.caseRef.id}`,
        state: 'pending',
        attemptCount: 0,
        nextAttemptAt: terminalUnsubscribeAt,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    observedMergeRequestStatus = 'merged'
    observeMrEvent('development.lifecycle-updated', 'lifecycle-merged-terminal-race')
    for (let index = 0; index < 8; index += 1) runtime.worker.pumpOneDelivery()
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // The authoritative MR refresh settles the Case as terminal.
    }
    expect(runtime.queries.getCase(launched.caseRef.id)).toMatchObject({ state: 'terminal' })
    expect(
      db
        .select()
        .from(employeeAttentionBindings)
        .where(eq(employeeAttentionBindings.id, pipelineAttentionBeforeTerminal.id))
        .get(),
    ).toMatchObject({
      state: 'cancel-requested',
      eventSubscriptionId: terminalPipelineSubscriptionId,
    })
    now = terminalUnsubscribeAt
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Finish the cancellation that was already authoritative at terminal settlement.
    }
    expect(
      db
        .select({ state: eventSubscriptions.state })
        .from(eventSubscriptions)
        .where(eq(eventSubscriptions.id, terminalPipelineSubscriptionId))
        .get(),
    ).toEqual({ state: 'cancelled' })

    retryLimits = { defaultNodeRetries: 0, sessionRestartBudget: 0 }
    const latestPolicy = module.queries.getExecutionPolicy()
    expect(latestPolicy).toMatchObject({
      revision: 3,
      content: { sameSceneAttempts: 0, freshSceneAttempts: 0 },
    })
    corruptOutputsRemaining = 1
    const terminalOnFailure = runtime.commands.launch({
      employeeRef,
      primaryContextTypeId: 'development.issue-handling',
      primaryContextSchemaVersion: 1,
      primaryContextState: 'active',
      primaryContextJson: JSON.stringify({
        status: 'active',
        subjectRef: 'REQ-43',
        repositoryRef: 'repo-1',
        request: {
          kind: 'body',
          body: '验证失败耗尽后按全局策略直接结束',
          externalId: null,
          uploads: [],
        },
        materialArtifactRefs: [],
      }),
      artifactRefs: [],
      workSubject: { typeId: 'work-request', subjectRef: 'REQ-43' },
    })
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Drain initial attention before executing the terminal failure fixture.
    }
    expect(runtime.worker.pumpOneDelivery()).toBe(false)
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Body input bypasses external-material acquisition and advances to implementation.
    }
    expect(
      JSON.parse(runtime.queries.getCase(terminalOnFailure.caseRef.id).projectionJson).case
        .currentWorkItemRef,
    ).toBe('analyze-implement')
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Launch the implementation Agent after the platform-only intake step.
    }
    expect(await runtime.worker.inspectOneExecution()).toBe('failed')
    expect(
      JSON.parse(runtime.queries.getCase(terminalOnFailure.caseRef.id).projectionJson).case,
    ).toMatchObject({
      state: 'blocked',
      terminalKind: null,
      blockReason: expect.stringContaining('execution-envelope-invalid'),
    })

    executionOutput = {
      outcome: 'blocked',
      explanation: 'not used',
    }

    const eventOrigin = {
      eventSubscriptionId: 'automation-subscription-1',
      eventDeliveryId: 'automation-delivery-1',
    }
    const eventWork = {
      employeeId: employee.id,
      intake: {
        kind: 'body' as const,
        target: { repositoryId: 'repo-1' },
        body: '由统一事件投递启动数字员工',
        externalId: null,
        uploads: [],
        idempotencyKey: 'event-delivery:automation-delivery-1',
      },
      actorUserId: null,
      eventOrigin,
    }
    const firstEventLaunch = runtime.commands.launchWork(eventWork)
    const repeatedEventLaunch = runtime.commands.launchWork(eventWork)
    expect(repeatedEventLaunch.caseRef.id).toBe(firstEventLaunch.caseRef.id)
    expect(JSON.parse(firstEventLaunch.projectionJson).case).toMatchObject({
      name: '由统一事件投递启动数字员工',
      ownerUserId: null,
      launchOrigin: 'event',
    })

    expect(() =>
      runtime.commands.launchWork({
        employeeId: employee.id,
        intake: {
          kind: 'body',
          target: { repositoryId: 'repo-1' },
          body: '缺少任务名的手工请求',
          externalId: null,
          uploads: [],
          idempotencyKey: 'manual-work:missing-name',
        },
        actorUserId: 'catalog-user',
      }),
    ).toThrow('manual digital employee work requires a task name')

    const manualLaunch = runtime.commands.launchWork({
      employeeId: employee.id,
      intake: {
        name: '修复目录任务命名链',
        kind: 'body',
        target: { repositoryId: 'repo-1' },
        body: '由当前用户手工启动数字员工任务',
        externalId: null,
        uploads: [],
        idempotencyKey: 'manual-work:catalog-user',
      },
      actorUserId: 'catalog-user',
    })
    expect(JSON.parse(manualLaunch.projectionJson).case).toMatchObject({
      name: '修复目录任务命名链',
      ownerUserId: 'catalog-user',
      launchOrigin: 'manual',
    })
    const mine = JSON.parse(
      runtime.queries.listCasePage({ ownerUserId: 'catalog-user', launchOrigin: 'manual' }),
    ) as { items: Array<{ id: string; taskName: string }> }
    expect(mine.items.map((item) => item.id)).toEqual([manualLaunch.caseRef.id])
    expect(mine.items[0]?.taskName).toBe('修复目录任务命名链')
    const events = JSON.parse(runtime.queries.listCasePage({ launchOrigin: 'event' })) as {
      items: Array<{ id: string }>
    }
    expect(events.items.map((item) => item.id)).toContain(firstEventLaunch.caseRef.id)
  })
})
