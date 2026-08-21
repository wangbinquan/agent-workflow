import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { employeeCases } from '@/db/schema'
import { eq } from 'drizzle-orm'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
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

  test('new work is delivered through outbox/event queue and deterministically freezes one reaction round', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-case-runtime-'))
    roots.push(appHome)
    let now = 30_000
    let ordinal = 0
    let corruptOutputsRemaining = 3
    let executionOutput = {
      status: 'ok',
      summary: '工作材料已取得并规范化',
      contextPatches: [],
      effectSuggestions: [],
      artifactRefs: [],
    }
    const launchedPlans: unknown[] = []
    const launchedAttempts: Array<{ ordinal: number; mode: string }> = []
    const nextId = () => `resource-${String(++ordinal).padStart(4, '0')}`
    const eventCenter = composeEventCenter({
      db,
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
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
      now: () => now,
      id: nextId,
      connectionCatalog: {
        async resolve(ref) {
          return {
            ref,
            purpose: 'approval-gateway',
            available: true,
            closureSummary: 'exact approval-gateway fixture',
          }
        },
      },
      runtime: {
        eventCenter: eventCenter.participant,
        codecs: [developmentEmployeeRuntimeCodec],
        platformWorkItems: {
          async execute(plan) {
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
              roundRef: string
              executionNonce: string
              workItemRef: string
            }
            const outputForRound =
              plan.workItemRef === 'classify-feedback'
                ? {
                    ...executionOutput,
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
                          problems: [
                            {
                              problemId: 'review-1',
                              type: 'review',
                              summary: 'review feedback',
                              evidenceArtifactRefs: [],
                            },
                          ],
                        }),
                        artifactRefs: [],
                      },
                    ],
                  }
                : plan.workItemRef === 'collect-pipeline'
                  ? {
                      ...executionOutput,
                      contextPatches: [
                        {
                          contextId: null,
                          contextTypeId: 'development.pipeline',
                          schemaVersion: 1,
                          expectedRevision: null,
                          lifecycleState: 'active',
                          stateJson: JSON.stringify({
                            status: 'failed',
                            mergeRequestRef: 'repo-1!42',
                            headSha: 'a'.repeat(40),
                            evidenceArtifactRef: '.agent-workflow/pipeline/case-1/result.json',
                            failureTypes: ['unknown'],
                          }),
                          artifactRefs: [],
                        },
                      ],
                    }
                  : executionOutput
            return {
              kind: 'completed',
              executionRef,
              outputJson: JSON.stringify({
                schemaVersion: 1,
                roundRef: plan.roundRef,
                executionNonce:
                  corruptOutputsRemaining-- > 0 ? '0'.repeat(64) : plan.executionNonce,
                ...outputForRound,
              }),
            }
          },
          async cancel() {},
        },
      },
    })
    const runtime = module.runtime!
    const typeRef = { typeId: 'development', revision: 2 }
    const typePackage = module.queries.getType(typeRef)
    const manifest = typePackage.authoringManifest
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
                  : { id: 'approval-adapter', revision: 1 },
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
    const baseJob = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '协同目标岗位',
        description: '固定节点默认工具',
        defaultToolBindings: bindings,
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
        enabled: true,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const childEmployeeRef = module.commands.publishEmployee({
      id: childEmployee.id,
      actorUserId: 'author',
    })
    const secondChildEmployee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '协同开发员工二号',
        jobTemplateRef: baseJobRef,
        enabled: true,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const secondChildEmployeeRef = module.commands.publishEmployee({
      id: secondChildEmployee.id,
      actorUserId: 'author',
    })
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
      },
    })
    const jobRef = module.commands.publishJobTemplate({ id: job.id, actorUserId: 'author' })
    const employee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author',
      body: {
        name: '开发一号',
        jobTemplateRef: jobRef,
        enabled: true,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const employeeRef = module.commands.publishEmployee({
      id: employee.id,
      actorUserId: 'author',
    })

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
      initialEventTypeRef: { id: 'development.work-received', revision: 1 },
      initialEventSourceRef: { id: 'development.work-ingress', revision: 1 },
      initialEventDedupeKey: 'work:REQ-42:v1',
      initialEventSummary: '收到需求 REQ-42',
    })
    expect(launched.state).toBe('active')
    expect(JSON.parse(launched.projectionJson)).toMatchObject({
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
      attention: [{ state: 'desired' }],
    })

    expect(await runtime.worker.runOneOutbox()).toBe('completed')
    expect(await runtime.worker.runOneOutbox()).toBe('completed')
    expect(runtime.worker.pumpOneDelivery()).toBe(true)
    const roundId = runtime.worker.planOneReaction()
    expect(roundId).not.toBeNull()
    let projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.activeRound).toMatchObject({
      id: roundId,
      ruleId: 'start-work',
      workItemRef: 'prepare-materials',
      executionPolicyRevision: 1,
    })
    expect(projection.inbox).toMatchObject([{ state: 'claimed', roundId }])

    expect(await runtime.worker.runOneOutbox()).toBe('completed')
    expect(launchedPlans).toHaveLength(1)
    expect(launchedPlans[0]).toMatchObject({
      roundRef: roundId,
      implementationKind: 'agent',
      inputSchemaId: 'development.work-request.v1',
      outputSchemaId: 'development.requirement-context.v1',
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
      { ordinal: 3, mode: 'fresh-scene' },
    ])
    expect(await runtime.worker.inspectOneExecution()).toBe('completed')
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.activeRound).toBeUndefined()
    expect(projection.rounds[0]).toMatchObject({ state: 'completed' })
    expect(projection.inbox[0]).toMatchObject({ state: 'settled' })
    expect(projection.case).toMatchObject({
      state: 'active',
      currentWorkItemRef: 'analyze-implement',
    })
    expect(projection.attention[0]).toMatchObject({ state: 'cancel-requested' })

    const analyzeRound = runtime.worker.planOneReaction()
    expect(analyzeRound).not.toBeNull()
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Attention cleanup can precede the reaction launch outbox.
    }
    expect(await runtime.worker.inspectOneExecution()).toBe('completed')
    expect(
      JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson).case
        .currentWorkItemRef,
    ).toBe('prepare-change')

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
    expect(
      JSON.parse(runtime.queries.getCase(childCaseId).projectionJson).case.employeeRef,
    ).toEqual(childEmployeeRef)
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
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Older attention cleanup may precede the collaboration result outbox.
    }
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ childCaseId, state: 'satisfied' }),
        expect.objectContaining({ childCaseId: detachedChildCaseId, state: 'detached' }),
      ]),
    )
    expect(projection.case).toMatchObject({
      state: 'active',
      currentWorkItemRef: 'prepare-approval',
    })
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
        sourceRef: { id: 'development.code-host-state', revision: 1 },
        eventTypeRef: { id: eventTypeId, revision: 1 },
        subject: { typeId: 'merge-request', subjectRef: 'repo-1!42' },
        occurredAt: now,
        dedupeKey,
        summary: eventTypeId,
        payloadArtifactRef: null,
      })
    }
    observeMrEvent('development.pipeline-updated', 'pipeline-red:1')
    observeMrEvent('development.pipeline-updated', 'pipeline-red:2')
    observeMrEvent('development.review-updated', 'review-comment:1')
    for (let index = 0; index < 12; index += 1) runtime.worker.pumpOneDelivery()
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(
      projection.inbox
        .filter((item: { state: string }) => item.state === 'pending')
        .map((item: { eventTypeRef: { id: string } }) => item.eventTypeRef.id),
    ).toEqual(['development.review-updated', 'development.pipeline-updated'])
    expect(
      projection.inbox.filter(
        (item: { state: string; eventTypeRef: { id: string } }) =>
          item.state === 'coalesced' && item.eventTypeRef.id === 'development.pipeline-updated',
      ),
    ).toHaveLength(1)

    // The higher-priority review event preempts the deterministic pipeline recheck;
    // the lower-priority pipeline event stays queued for the next round.
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.activeRound).toMatchObject({
      workItemRef: 'classify-feedback',
      ruleId: 'handle-review',
    })
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Attention cleanup can precede the reaction launch outbox.
    }
    expect(await runtime.worker.inspectOneExecution()).toBe('completed')
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
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Drain the lifecycle preemption settlement.
    }

    const currentPolicy = module.queries.getExecutionPolicy()
    module.commands.publishExecutionPolicy({
      actorUserId: 'admin',
      body: {
        ...currentPolicy.content,
        sameSceneAttempts: 5,
        roundBudgetMs: 1_000,
        caseBudgetMs: 1_000,
      },
    })
    const preview = runtime.commands.previewPolicyUpgrade(launched.caseRef.id, 2)
    const upgraded = runtime.commands.applyPolicyUpgrade(preview)
    expect(JSON.parse(upgraded.projectionJson).case.executionPolicyRevision).toBe(2)
    expect(runtime.worker.planOneReaction()).toBeNull()
    projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson)
    expect(projection.case).toMatchObject({
      state: 'blocked',
      blockReason: 'case-budget-exhausted',
    })
    expect(
      JSON.parse(runtime.commands.resume(launched.caseRef.id).projectionJson).case,
    ).toMatchObject({
      state: 'active',
      blockReason: null,
    })

    const terminal = runtime.commands.terminate(launched.caseRef.id, 'merged')
    expect(terminal.state).toBe('terminal')
    now += 1
    expect(await runtime.worker.runOneOutbox()).toBe('completed')

    const latestPolicy = module.queries.getExecutionPolicy()
    module.commands.publishExecutionPolicy({
      actorUserId: 'admin',
      body: {
        ...latestPolicy.content,
        sameSceneAttempts: 0,
        freshSceneAttempts: 0,
        roundBudgetMs: 2 * 60 * 60 * 1_000,
        caseBudgetMs: 30 * 24 * 60 * 60 * 1_000,
        handoffOnExhausted: false,
      },
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
      initialEventTypeRef: { id: 'development.work-received', revision: 1 },
      initialEventSourceRef: { id: 'development.work-ingress', revision: 1 },
      initialEventDedupeKey: 'work:REQ-43:v1',
      initialEventSummary: '收到需求 REQ-43',
    })
    while ((await runtime.worker.runOneOutbox()) !== 'idle') {
      // Drain initial attention before executing the terminal failure fixture.
    }
    expect(runtime.worker.pumpOneDelivery()).toBe(true)
    expect(runtime.worker.planOneReaction()).not.toBeNull()
    expect(await runtime.worker.runOneOutbox()).toBe('completed')
    expect(await runtime.worker.inspectOneExecution()).toBe('failed')
    expect(
      JSON.parse(runtime.queries.getCase(terminalOnFailure.caseRef.id).projectionJson).case,
    ).toMatchObject({
      state: 'terminal',
      terminalKind: 'execution-failed',
      blockReason: null,
    })

    executionOutput = {
      status: 'blocked',
      summary: 'not used',
      contextPatches: [],
      effectSuggestions: [],
      artifactRefs: [],
    }
  })
})
