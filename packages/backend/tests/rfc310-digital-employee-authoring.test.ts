import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import { inspectDigitalEmployeeWorkflowDefinition } from '@/modules/digital-employee/composition/defaultRequiredPorts'
import { employeeWorkIntakeSchema } from '@/modules/digital-employee/domain/runtimeModel'
import { buildDigitalEmployeeFixedPrompt } from '@/modules/task-execution/composition/digitalEmployeeExecution'
import {
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'
import { listAgents } from '@/services/agent'
import {
  designEmployeeTypePackage,
  testEmployeeTypePackage,
} from './fixtures/digitalEmployeeTypePackages'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureModule() {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc310-os-authoring-'))
  roots.push(appHome)
  let ordinal = 0
  return composeDigitalEmployee({
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    typePackages: [developmentEmployeeTypePackage],
    id: () => `resource-${++ordinal}`,
    now: () => 1_000 + ordinal,
    resourceCatalog: {
      async resolveAgent(ref) {
        return {
          kind: 'agent',
          ref,
          name: `Agent ${ref.id}`,
          available: true,
          closureSummary: 'strict digital-employee envelope',
        }
      },
      async resolveWorkflow(ref) {
        return {
          kind: 'workflow',
          ref,
          name: `Workflow ${ref.id}`,
          available: true,
          closureSummary: 'closed workflow effect graph',
        }
      },
    },
    connectionCatalog: {
      async resolve(ref) {
        if (ref.id === 'missing-adapter') return null
        const purpose = ref.id === 'wrong-purpose-adapter' ? 'pipeline-gate' : 'approval-gateway'
        const available = ref.id !== 'archived-adapter'
        return {
          ref,
          purpose,
          available,
          closureSummary: `${ref.id}; ${purpose}; ${available ? 'available' : 'archived'}`,
        }
      },
    },
    fixtureRunner: {
      async validate(request) {
        return [
          {
            code: 'fixture-envelope',
            ok: true,
            detail: `${request.inputSchemaId} -> ${request.outputSchemaId}`,
          },
        ]
      },
    },
  })
}

describe('RFC-310 Digital Employee OS authoring hierarchy', () => {
  test('pure migrations stay resource-empty and daemon seeding installs Agent templates once', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    expect(await listAgents(db)).toEqual([])

    await ensureDigitalEmployeeAgentTemplates(db)
    await ensureDigitalEmployeeAgentTemplates(db)

    const templates = await listDigitalEmployeeAgentTemplates(db)
    expect(templates).toHaveLength(3)
    expect(templates.map((template) => template.frontmatterExtra.digitalEmployeeTemplate)).toEqual([
      'code-writing',
      'problem-diagnosis',
      'pipeline-repair',
    ])
    expect(
      templates.every((template) => template.builtin && template.visibility === 'public'),
    ).toBe(true)
    expect(await listAgents(db)).toHaveLength(3)
  })

  test('design and test packages use the same type -> work item -> tool -> employee core', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-generic-types-'))
    roots.push(appHome)
    let ordinal = 0
    const module = composeDigitalEmployee({
      db: createInMemoryDb(MIGRATIONS),
      appHome,
      typePackages: [designEmployeeTypePackage, testEmployeeTypePackage],
      id: () => `generic-${++ordinal}`,
      resourceCatalog: {
        async resolveAgent(ref) {
          return {
            kind: 'agent',
            ref,
            name: ref.id,
            available: true,
            closureSummary: 'generic exact Agent',
          }
        },
        async resolveWorkflow() {
          return null
        },
      },
      fixtureRunner: {
        async validate() {
          return [{ code: 'generic-envelope', ok: true, detail: 'strict envelope' }]
        },
      },
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
        enabled: true,
        workScope: { kind: 'global' },
      },
    })
    expect(
      module.commands.publishEmployee({ id: employee.id, actorUserId: 'generic-author' }),
    ).toEqual({ id: employee.id, revision: 1 })

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

  test('a job template cannot publish before every required graph node has a tool', () => {
    const module = fixtureModule()
    const draft = module.commands.createJobTemplate({
      typeRef: { typeId: 'development', revision: 1 },
      actorUserId: 'author-1',
      body: {
        name: '不完整岗位',
        description: '用于锁定节点工具发布门禁。',
        defaultToolBindings: [],
      },
    })

    expect(() =>
      module.commands.publishJobTemplate({ id: draft.id, actorUserId: 'author-1' }),
    ).toThrow('job template does not cover every required work-item tool slot')
  })

  test('type -> work item -> tool registration closes an exact employee definition', async () => {
    const module = fixtureModule()
    const typeRef = { typeId: 'development', revision: 1 }
    const manifest = module.queries.getAuthoringManifest(typeRef)
    const typePackage = module.queries.getType(typeRef)
    expect(manifest.lifecycleRegions.map((region) => region.regionId)).toEqual(['delivery', 'care'])
    expect(manifest.workItems).toHaveLength(18)
    expect(
      manifest.workItems.find((item) => item.workItemRef === 'repair-conflict')?.nextWorkItemRefs,
    ).toEqual(['publish-conflict'])
    expect(
      manifest.workItems.find((item) => item.workItemRef === 'publish-conflict'),
    ).toMatchObject({ nodeKind: 'system', nextWorkItemRefs: ['observe-mr'] })
    expect(
      typePackage.eventTypes
        .filter((event) => event.preemptsContinuation)
        .map((event) => event.eventTypeId),
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
              connectionRef:
                contract.requiredConnectionPurpose === null
                  ? null
                  : { id: 'approval-adapter', revision: 1 },
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

    const template = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author-1',
      body: {
        name: '标准开发岗位',
        description: '节点默认工具，不包含事件、重试或执行规则。',
        defaultToolBindings: bindings,
      },
    })
    const templateRef = module.commands.publishJobTemplate({
      id: template.id,
      actorUserId: 'author-1',
    })
    const employee = module.commands.createEmployee({
      typeRef,
      actorUserId: 'author-1',
      body: {
        name: 'Java 开发数字员工',
        jobTemplateRef: templateRef,
        enabled: true,
        workScope: { kind: 'repository', repositoryId: 'repo-1' },
        toolOverrides: [],
      },
    })
    const employeeRef = module.commands.publishEmployee({
      id: employee.id,
      actorUserId: 'author-1',
    })

    const published = module.queries.getEmployee(employee.id)
    expect(employeeRef).toEqual({ id: employee.id, revision: 1 })
    expect(published.published?.workScopeSummary).toBe('仓库：repo-1')
    expect(published.published?.exactToolBindings).toEqual(
      [...bindings].sort((left, right) =>
        `${left.workItemRef}/${left.slotRef}`.localeCompare(
          `${right.workItemRef}/${right.slotRef}`,
        ),
      ),
    )
    expect(JSON.stringify(published)).not.toContain('sameSceneAttempts')
    expect(JSON.stringify(published)).not.toContain('retry')

    const cppTemplate = module.commands.createJobTemplate({
      typeRef,
      actorUserId: 'author-1',
      body: {
        name: 'C++ 开发岗位',
        description: '同一分类可定义另一套节点工具组合。',
        defaultToolBindings: bindings,
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
        enabled: true,
        workScope: { kind: 'repository', repositoryId: 'repo-2' },
        toolOverrides: [],
      },
    })
    module.commands.publishEmployee({ id: cppEmployee.id, actorUserId: 'author-1' })
    expect(module.queries.listJobTemplates(typeRef).map((job) => job.name)).toEqual([
      'C++ 开发岗位',
      '标准开发岗位',
    ])
    expect(module.queries.getEmployee(cppEmployee.id).published?.jobTemplateRef).toEqual(
      cppTemplateRef,
    )
  })

  test('pipeline problem types select specialist slots in fixed priority with unknown fallback', () => {
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
            defaultSlotRef: 'unknown',
            contextsJson: JSON.stringify([context]),
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
            defaultSlotRef: 'unknown',
            contextsJson: '[]',
          }),
        ),
      ),
    ).toEqual({ slotRef: 'unknown' })
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
          allowedNextWorkItemRefs: ['repair-pipeline', 'delegate'],
        }),
      ),
    )
    expect(classification).toMatchObject({
      caseState: 'active',
      nextWorkItemRef: 'delegate',
    })

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
          },
        ],
      }),
    }
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
    const validate = (problemIds: readonly string[]) =>
      developmentEmployeeRuntimeCodec.validateReactionOutputJson(
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

  test('system nodes reject tools and execution retry policy has one global owner', async () => {
    const module = fixtureModule()
    const typeRef = { typeId: 'development', revision: 1 }
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
    const updated = module.commands.publishExecutionPolicy({
      actorUserId: 'admin-1',
      body: {
        ...initial.content,
        sameSceneAttempts: 3,
        freshSceneAttempts: 4,
      },
    })
    expect(updated.revision).toBe(2)
    expect(updated.content.sameSceneAttempts).toBe(3)
    expect(updated.content.freshSceneAttempts).toBe(4)
    expect(() =>
      module.commands.publishExecutionPolicy({
        actorUserId: 'admin-1',
        body: { ...updated.content, initialBackoffMs: 2_000, maxBackoffMs: 1_000 },
      }),
    ).toThrow('maximum backoff must be greater than or equal to initial backoff')
    expect(() =>
      module.commands.publishExecutionPolicy({
        actorUserId: 'admin-1',
        body: { ...updated.content, roundBudgetMs: 2_000, caseBudgetMs: 1_000 },
      }),
    ).toThrow('case budget must be greater than or equal to round budget')
  })

  test('a work-item connection must resolve to the exact required provider purpose', async () => {
    const module = fixtureModule()
    const typeRef = { typeId: 'development', revision: 1 }
    const create = (connectionRef: { id: string; revision: number } | null) =>
      module.commands.createTool({
        typeRef,
        workItemRef: 'prepare-approval',
        actorUserId: 'author-1',
        body: {
          displayName: `审批材料 ${connectionRef?.id ?? 'missing'}`,
          description: '锁定连接目录的后端精确版本校验。',
          roleRef: 'primary',
          implementation: {
            kind: 'agent',
            agentRef: { id: 'builtin:approval-draft-agent', revision: 1 },
          },
          connectionRef,
        },
      })

    for (const ref of [
      null,
      { id: 'missing-adapter', revision: 1 },
      { id: 'wrong-purpose-adapter', revision: 1 },
      { id: 'archived-adapter', revision: 1 },
    ]) {
      const draft = await create(ref)
      expect(draft.validationReceipt.status).toBe('invalid')
      expect(() =>
        module.commands.publishTool({
          typeRef,
          workItemRef: 'prepare-approval',
          toolId: draft.id,
          actorUserId: 'author-1',
        }),
      ).toThrow('tool does not satisfy the work contract')
    }

    const valid = await create({ id: 'approval-adapter', revision: 7 })
    expect(valid.validationReceipt.status).toBe('valid')
    expect(valid.validationReceipt.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'required-connection-purpose-matches', ok: true }),
        expect.objectContaining({ code: 'required-connection-available', ok: true }),
      ]),
    )
  })

  test('Workflow and Agent execution boundaries reject hidden platform effects', () => {
    const safe = inspectDigitalEmployeeWorkflowDefinition({
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
      inspectDigitalEmployeeWorkflowDefinition({
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
        outputSchemaId: 'development.output.v1',
        roundRef: 'round-1',
        executionNonce: 'a'.repeat(64),
        toolSlotRef: 'compile',
        semanticValidatorId: 'development.validator',
        inputEnvelopeJson: '{"frozen":true}',
      },
      { previousError: 'wrong nonce' },
    )
    expect(prompt).toContain('Do not run git, commit, push, merge, approve')
    expect(prompt).toContain('or choose the next action')
    expect(prompt).toContain(`executionNonce=${JSON.stringify('a'.repeat(64))}`)
    expect(prompt).toContain('tool slot "compile"')
    expect(prompt).toContain('previous exact-envelope attempt was rejected: wrong nonce')
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
