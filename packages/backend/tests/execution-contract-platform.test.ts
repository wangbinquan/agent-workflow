import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DAEMON_RESTART_ERROR_SUMMARY,
  renderUserPrompt,
  WorkflowDefinitionSchema,
} from '@agent-workflow/shared'
import { createInMemoryDb } from '@/db/client'
import { agents as agentRows, nodeRuns, tasks, workflows } from '@/db/schema'
import {
  developmentEmployeeRuntimeCodec,
  developmentExecutionContractRegistrations,
  developmentImplicitAgentContractDeclarations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'
import {
  createExecutionContractProgramFixtureAdapter,
  createExecutionContractResourceAdapter,
} from '@/modules/execution-contract/infrastructure/taskExecutionAdapter'
import {
  executionContractGuideSchema,
  validateExactContractInput,
  validateExactContractOutput,
} from '@/modules/execution-contract/domain/model'
import { executionContractRefKey } from '@/modules/execution-contract/public/types'
import { createProgramArtifactStore } from '@/modules/digital-employee/infrastructure/programArtifactStore'
import {
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'
import {
  DIGITAL_EMPLOYEE_IMPLEMENTATION_PLAN_KEY,
  DIGITAL_EMPLOYEE_PLAN_READER_NODE_ID,
  DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID,
  DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY,
  synthesizeDigitalEmployeeScriptHostSnapshot,
  synthesizeReviewedDigitalEmployeeHostSnapshot,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import {
  buildDigitalEmployeeFixedPrompt,
  buildDigitalEmployeePlanPrompt,
  composeDigitalEmployeeExecution,
  inspectDigitalEmployeeHumanReviewState,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { createAgent, updateAgent } from '@/services/agent'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function guide(contractId: string, version?: number) {
  const registration = developmentExecutionContractRegistrations.find(
    (candidate) =>
      candidate.contractRef.contractId === contractId &&
      (version === undefined || candidate.contractRef.version === version),
  )
  if (registration === undefined) throw new Error(`missing fixture ${contractId}`)
  return executionContractGuideSchema.parse(JSON.parse(registration.guideJson) as unknown)
}

/**
 * 从工作流节点上取 `promptTemplate`。
 *
 * 这个字段**没有在 `WorkflowNodeSchema` 里声明**——它靠 `.passthrough()` 漏过去，
 * 于是每个读点拿到的都是 `unknown`。全仓有 24 个生产文件在用它，却没有任何共享读取器：
 * `scheduler.ts` 自己开了个私有的 `pickString(node, 'promptTemplate')`（:5741 / :8387），
 * 其余各处各自应付。这里不复刻那份私有实现，只做本测试需要的显式收窄，并把这个缺口
 * 记在 `docs/audit-backlog.md`——补 schema 声明会改变既有存量定义的校验行为，
 * 属独立决策，不该顺手塞进一个测试修复里。
 */
function requirePromptTemplate(node: unknown, label: string): string {
  // 参数取 unknown 而不是 `{ promptTemplate?: unknown }`：后者全是可选属性，会触发
  // TS 的弱类型检查（"has no properties in common"）——而这恰恰说明该字段**不在类型里**。
  const value =
    typeof node === 'object' && node !== null
      ? (node as { promptTemplate?: unknown }).promptTemplate
      : undefined
  if (typeof value !== 'string') {
    throw new Error(`${label} node is missing a string promptTemplate (got ${typeof value})`)
  }
  return value
}

describe('platform execution contracts', () => {
  test('the guide exposes direct external-id injection and the exact script transport', () => {
    const material = guide('development.prepare-materials')
    expect(material.input.fields.map((field) => field.path)).toContain(
      'contractInput.workRequest.externalId',
    )
    expect(material.input.primaryFieldPaths).toEqual([
      'contractInput.workRequest.externalId',
      'contractInput.materialTargetDirectory',
    ])
    expect(
      material.input.topLevelFields.every((field) =>
        material.input.fields.some((guideField) => guideField.path === field),
      ),
    ).toBe(true)
    expect(material.transports.program?.inputLocation).toContain('AW_PORT_CONTRACT_INPUT')
    expect(material.transports.program?.inputLocation).toContain('AW_PORT_FILE_CONTRACT_INPUT')
    expect(material.output.topLevelFields).toEqual([
      'schemaVersion',
      'roundRef',
      'executionNonce',
      'status',
      'summary',
      'contextPatches',
      'effectSuggestions',
      'artifactRefs',
    ])
  })

  test('the planning contract owns analysis-plan without an agent-result envelope', () => {
    const planning = guide('development.analyze-plan')
    expect(planning.allowedExecutorKinds).toEqual(['agent'])
    expect(planning.transports.agent).toMatchObject({
      outputPort: 'analysis-plan',
      outputKind: 'path<md>',
    })
    expect(planning.transports.agent?.outputInstruction['en-US']).toContain(
      'do not emit an agent-result envelope',
    )
    expect(planning.output.topLevelFields).toEqual(['artifactPath'])
    expect(
      validateExactContractOutput({
        guide: planning,
        roundRef: 'not-embedded-for-artifacts',
        executionNonce: '0'.repeat(64),
        outputJson: '.agent-workflow/inputs/requirements/case-id/review/implementation-plan.md',
      }),
    ).toBe('.agent-workflow/inputs/requirements/case-id/review/implementation-plan.md')
  })

  // Real GitLab Case regression (2026-08-23): an otherwise successful Agent
  // returned `status: "succeeded"` because the frozen prompt named the field
  // but not its closed vocabulary, so strict validation discarded the result.
  test('Agent envelope prompts name the closed status vocabulary and successful value', () => {
    const contractGuide = guide('development.analyze-implement')
    const runtimeGuide = {
      schemaVersion: contractGuide.schemaVersion,
      contractRef: contractGuide.contractRef,
      displayName: contractGuide.displayName,
      description: contractGuide.description,
      inputSchemaId: contractGuide.input.schemaId,
      outputSchemaId: contractGuide.output.schemaId,
      outputTopLevelFields: contractGuide.output.topLevelFields,
      allowedExecutorKinds: contractGuide.allowedExecutorKinds,
      agentOutputPort: contractGuide.transports.agent?.outputPort ?? null,
      agentOutputKind: contractGuide.transports.agent?.outputKind ?? null,
      guideJson: JSON.stringify(contractGuide),
    }
    const prompt = buildDigitalEmployeeFixedPrompt(
      {
        roundRef: 'round-status-vocabulary',
        executionNonce: 'a'.repeat(64),
        toolSlotRef: 'default',
        semanticValidatorId: 'development.analyze-implement.validator',
        inputEnvelopeJson: '{}',
        allowedEffectKinds: [],
      },
      { previousError: null },
      runtimeGuide,
    )

    expect(prompt).toContain(
      'Set status to exactly "ok", "needs-input", or "blocked". For successful completion use "ok", never "succeeded" or another synonym.',
    )
    expect(prompt).toContain(
      'effectSuggestions must be an array of string effect IDs; never encode an effect as an object.',
    )
    expect(prompt).toContain(
      'This frozen contract allows no effect IDs, so return effectSuggestions: [].',
    )
    expect(prompt).toContain('OUTPUT_SCHEMA_EXAMPLE_JSON')
    expect(prompt).toContain('"effectSuggestions": []')
    expect(() =>
      validateExactContractOutput({
        guide: contractGuide,
        roundRef: 'round-status-vocabulary',
        executionNonce: 'a'.repeat(64),
        outputJson: JSON.stringify({
          ...JSON.parse(contractGuide.output.exampleJson),
          roundRef: 'round-status-vocabulary',
          executionNonce: 'a'.repeat(64),
          status: 'succeeded',
        }),
      }),
    ).toThrow('output status must be ok, needs-input, or blocked')
  })

  test('direct Agent prompts contain only the action, business result, and business input', () => {
    const contractGuide = guide('development.implement-change', 2)
    const prompt = buildDigitalEmployeeFixedPrompt(
      {
        roundRef: 'round-direct-input',
        executionNonce: 'b'.repeat(64),
        toolSlotRef: 'default',
        semanticValidatorId: 'development.implement-change.v2.validator',
        inputEnvelopeJson: JSON.stringify({
          requirementsDirectory: '.agent-workflow/inputs/requirements/case',
        }),
        allowedEffectKinds: [],
      },
      { previousError: null },
      {
        schemaVersion: contractGuide.schemaVersion,
        inputMode: contractGuide.inputMode,
        contractRef: contractGuide.contractRef,
        displayName: contractGuide.displayName,
        description: contractGuide.description,
        inputSchemaId: contractGuide.input.schemaId,
        outputSchemaId: contractGuide.output.schemaId,
        outputTopLevelFields: contractGuide.output.topLevelFields,
        allowedExecutorKinds: contractGuide.allowedExecutorKinds,
        agentOutputPort: contractGuide.transports.agent?.outputPort ?? null,
        agentOutputKind: contractGuide.transports.agent?.outputKind ?? null,
        guideJson: JSON.stringify(contractGuide),
      },
    )

    expect(prompt).toContain('Action: Read the requirement materials and complete the code change')
    expect(prompt).toContain('Use the available network')
    expect(prompt).toContain('INPUT_JSON')
    expect(prompt).toContain('"requirementsDirectory"')
    expect(prompt).not.toContain('round-direct-input')
    expect(prompt).not.toContain('development.implement-change@2')
    expect(prompt).not.toContain('Input schema:')
    expect(prompt).not.toContain('tool slot')
    expect(prompt).not.toContain('Semantic validator:')
    expect(prompt).not.toContain('schemaVersion')
    expect(prompt).not.toContain('executionNonce')
    expect(prompt).not.toContain('directResult')
    expect(prompt).not.toContain('envelope')
  })

  // User regression 2026-08-23: the tool-definition guide had reversed the
  // classifier's configuration and runtime handoff, hiding the problem set.
  test('pipeline tool guides expose the classified problem-set handoff instead of treating tool configuration as task input', () => {
    const classifier = guide('development.classify-pipeline')
    expect(classifier.input.primaryFieldPaths).toEqual([
      'contractInput.pipelineEvidence',
      'contractInput.pipelineDirectory',
    ])
    expect(
      classifier.input.fields.find(
        (field) => field.path === 'contractInput.failureTypeDefinitions',
      ),
    ).toMatchObject({ source: 'platform' })
    expect(classifier.output.primaryFieldPaths).toEqual(['contextPatches'])
    expect(classifier.output.fields.find((field) => field.path === 'contextPatches')).toMatchObject(
      {
        label: {
          'zh-CN': '问题种类与问题记录',
          'en-US': 'Problem categories and records',
        },
      },
    )

    const classifierInput = JSON.parse(classifier.input.exampleJson) as {
      contractInput: Record<string, unknown>
    }
    expect(classifierInput.contractInput).toMatchObject({
      pipelineEvidence: expect.objectContaining({ status: 'failed' }),
      failureTypeDefinitions: expect.arrayContaining([
        expect.objectContaining({ typeId: 'compile-error' }),
      ]),
    })
    const classifierOutput = JSON.parse(classifier.output.exampleJson) as {
      contextPatches: Array<{ contextTypeId: string; stateJson: string }>
    }
    expect(classifierOutput.contextPatches).toHaveLength(1)
    expect(classifierOutput.contextPatches[0]?.contextTypeId).toBe('development.problem-set')
    expect(JSON.parse(classifierOutput.contextPatches[0]!.stateJson)).toMatchObject({
      source: 'pipeline',
      remainingTypes: ['compile-error'],
      problems: [expect.objectContaining({ type: 'compile-error' })],
    })

    const repair = guide('development.repair-pipeline')
    expect(repair.input.primaryFieldPaths).toEqual([
      'contractInput.problemSet',
      'contractInput.assignedFailureType',
      'contractInput.pipelineEvidence',
      'contractInput.pipelineDirectory',
    ])
    const repairInput = JSON.parse(repair.input.exampleJson) as {
      contractInput: Record<string, unknown>
    }
    expect(repairInput.contractInput).toMatchObject({
      problemSet: expect.objectContaining({ remainingTypes: ['compile-error'] }),
      assignedFailureType: 'compile-error',
      pipelineEvidence: expect.objectContaining({ status: 'failed' }),
    })
    expect(
      repair.input.fields.find((field) => field.path === 'contractInput.assignedFailureType'),
    ).toMatchObject({ source: 'platform' })
  })

  test('contract registration rejects guides whose examples or executor kinds contradict the guide', () => {
    const mismatchedExample = structuredClone(guide('development.prepare-materials'))
    mismatchedExample.input.exampleJson = JSON.stringify({ unexpected: true })
    expect(executionContractGuideSchema.safeParse(mismatchedExample).success).toBe(false)

    const duplicateExecutor = structuredClone(guide('development.prepare-materials'))
    duplicateExecutor.allowedExecutorKinds.push('agent')
    expect(executionContractGuideSchema.safeParse(duplicateExecutor).success).toBe(false)

    const unknownPrimaryField = structuredClone(guide('development.prepare-materials'))
    unknownPrimaryField.input.primaryFieldPaths = ['contractInput.unknown']
    expect(executionContractGuideSchema.safeParse(unknownPrimaryField).success).toBe(false)
  })

  test('the type package projects an intake ID into a directly consumable contractInput', () => {
    const envelope = JSON.parse(
      developmentEmployeeRuntimeCodec.assembleReactionInputJson(
        JSON.stringify({
          schemaVersion: 1,
          caseRef: 'case-1',
          roundRef: 'round-1',
          executionNonce: '1'.repeat(64),
          workItemRef: 'prepare-materials',
          toolSlotRef: 'default',
          connectionRef: null,
          inputSchemaId: 'development.work-request.v1',
          outputSchemaId: 'development.requirement-context.v1',
          eventJson: JSON.stringify({ kind: 'work-item-continuation' }),
          contextsJson: JSON.stringify([
            {
              typeId: 'development.issue-handling',
              schemaVersion: 1,
              revision: 1,
              stateJson: JSON.stringify({
                status: 'active',
                subjectRef: 'repo:ISSUE-1234',
                repositoryRef: 'repo',
                request: {
                  kind: 'external-id',
                  body: null,
                  externalId: 'ISSUE-1234',
                  uploads: [],
                  executionOptions: {},
                },
                materialArtifactRefs: [],
              }),
              artifactRefs: [],
            },
          ]),
        }),
      ),
    ) as Record<string, unknown>
    expect(envelope.contractInput).toEqual({
      workRequest: {
        kind: 'external-id',
        body: null,
        externalId: 'ISSUE-1234',
        uploads: [],
        executionOptions: {},
      },
      repositoryRef: 'repo',
      materialTargetDirectory: '.agent-workflow/inputs/requirements/case-1/external',
    })
  })

  test('plan review receives one platform path and a fixed analyze-review-implement host', () => {
    const requirementDirectory = '.agent-workflow/inputs/requirements/case-plan'
    const envelope = JSON.parse(
      developmentEmployeeRuntimeCodec.assembleReactionInputJson(
        JSON.stringify({
          schemaVersion: 1,
          caseRef: 'case-plan',
          roundRef: 'round-plan',
          executionNonce: '3'.repeat(64),
          workItemRef: 'analyze-implement',
          toolSlotRef: 'default',
          connectionRef: null,
          inputSchemaId: 'development.requirement-context.v1',
          outputSchemaId: 'development.change-proposal.v1',
          eventJson: JSON.stringify({ kind: 'work-item-continuation' }),
          contextsJson: JSON.stringify([
            {
              typeId: 'development.issue-handling',
              schemaVersion: 1,
              revision: 1,
              stateJson: JSON.stringify({
                status: 'active',
                subjectRef: 'case:case-plan',
                repositoryRef: 'repo',
                request: {
                  kind: 'body',
                  body: 'Implement the accepted plan.',
                  externalId: null,
                  executionOptions: { 'review-implementation-plan': true },
                  uploads: [
                    {
                      artifactRef: 'employee-input:blob-1',
                      placement: 'temporary',
                      targetPath: `${requirementDirectory}/uploads/001-doc`,
                      originalName: 'design.md',
                    },
                  ],
                },
                materialArtifactRefs: ['employee-input:blob-1'],
              }),
              artifactRefs: ['employee-input:blob-1'],
            },
          ]),
          toolBindingsJson: JSON.stringify([
            {
              slotRef: 'plan',
              registrationRef: { id: 'planning-tool', revision: 4 },
              workContractRef: { contractId: 'development.analyze-plan', version: 1 },
              implementation: {
                kind: 'agent',
                agentRef: { id: 'business-specific-planner', revision: 9 },
              },
            },
          ]),
        }),
      ),
    ) as {
      humanReview: {
        kind: string
        artifactPort: string
        documentPath: string
        title: string
        description: string
        planningTool: {
          slotRef: string
          registrationRef: { id: string; revision: number }
          workContractRef: { contractId: string; version: number }
          implementation: {
            kind: 'agent'
            agentRef: { id: string; revision: number }
          }
        }
      }
      platformPaths: {
        requirementDirectory: string
        implementationPlanPath: string
      }
      materialInstructions: {
        uploads: Array<{
          originalName: string
          placement: string
          workspacePath: string
          commitWithMergeRequest: boolean
          artifactRef: string
        }>
      }
    }
    const implementationPlanPath = `${requirementDirectory}/review/implementation-plan.md`
    expect(envelope.humanReview).toEqual({
      kind: 'implementation-plan',
      artifactPort: 'analysis-plan',
      documentPath: implementationPlanPath,
      title: '实现方案评审',
      description: '请评审数字员工基于冻结工作材料和仓库现场形成的实现方案。',
      planningTool: {
        slotRef: 'plan',
        registrationRef: { id: 'planning-tool', revision: 4 },
        workContractRef: { contractId: 'development.analyze-plan', version: 1 },
        implementation: {
          kind: 'agent',
          agentRef: { id: 'business-specific-planner', revision: 9 },
        },
      },
    })
    expect(envelope.platformPaths).toMatchObject({
      requirementDirectory,
      implementationPlanPath,
    })
    expect(envelope.materialInstructions.uploads).toEqual([
      {
        originalName: 'design.md',
        placement: 'temporary',
        workspacePath: `${requirementDirectory}/uploads/001-doc`,
        commitWithMergeRequest: false,
        artifactRef: 'employee-input:blob-1',
      },
    ])

    const prompt = buildDigitalEmployeePlanPrompt(
      {
        inputEnvelopeJson: JSON.stringify({
          requirementsDirectory: requirementDirectory,
          outputFile: implementationPlanPath,
        }),
      },
      { previousError: null },
      implementationPlanPath,
    )
    expect(prompt).toContain(
      `Write the complete Markdown plan only to this exact platform path: ${implementationPlanPath}`,
    )
    expect(prompt).toContain(
      'Use the available network and repository, Git, or code-host reads when they help you verify the plan.',
    )
    expect(prompt).toContain(
      'Do not publish external changes: the platform owns commit, push, merge, comment publication, and approval submission.',
    )
    expect(prompt).toContain('Do not modify business files while writing the plan.')
    expect(prompt).toContain('"requirementsDirectory"')
    expect(prompt).toContain('"outputFile"')
    expect(prompt).toContain('INPUT_JSON')
    expect(prompt).not.toContain('INPUT_ENVELOPE_JSON')
    expect(prompt).not.toContain('EXPECTED_ANALYSIS_PLAN_PATH_JSON')
    expect(prompt).not.toContain('ROUND_REF')
    expect(prompt).not.toContain('EXECUTION_NONCE')

    const legacyPrompt = buildDigitalEmployeePlanPrompt(
      { inputEnvelopeJson: JSON.stringify(envelope) },
      { previousError: null },
      implementationPlanPath,
      'host-envelope',
    )
    expect(legacyPrompt).toContain('INPUT_ENVELOPE_JSON')
    expect(legacyPrompt).toContain(
      `EXPECTED_ANALYSIS_PLAN_PATH_JSON\n${JSON.stringify(implementationPlanPath)}`,
    )

    const host = WorkflowDefinitionSchema.parse(
      synthesizeReviewedDigitalEmployeeHostSnapshot({
        planAgentId: 'builtin-plan-agent',
        planAgentName: 'Implementation planning',
        implementationAgentId: 'employee-implementation-agent',
        implementationAgentName: 'Implementation',
        artifactPort: 'analysis-plan',
        documentPath: implementationPlanPath,
        reviewTitle: '实现方案评审',
        reviewDescription: '批准后才开始修改代码。',
      }),
    )
    expect(host.nodes.map((node) => node.kind)).toEqual([
      'input',
      'input',
      'agent-single',
      'review',
      'script',
      'agent-single',
      'output',
    ])
    expect(host.edges).toContainEqual({
      id: 'e_de_approved_plan',
      source: { nodeId: DIGITAL_EMPLOYEE_PLAN_READER_NODE_ID, portName: 'stdout' },
      target: {
        nodeId: '__de_agent__',
        portName: DIGITAL_EMPLOYEE_IMPLEMENTATION_PLAN_KEY,
      },
    })
    expect(host.edges).toContainEqual({
      id: 'e_de_approved_plan_path',
      source: { nodeId: DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID, portName: 'approved_doc' },
      target: {
        nodeId: DIGITAL_EMPLOYEE_PLAN_READER_NODE_ID,
        portName: 'approved_plan_path',
      },
    })
    const planningNode = host.nodes.find((node) => node.id === '__de_plan_agent__')
    expect(planningNode?.kind).toBe('agent-single')
    if (planningNode?.kind !== 'agent-single') throw new Error('missing planning Agent node')
    const renderedPlanPrompt = renderUserPrompt({
      promptTemplate: requirePromptTemplate(planningNode, 'planning'),
      inputs: { [DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]: prompt },
      meta: {
        repoPath: '/repo',
        baseBranch: 'main',
        taskId: 'plan-task',
        nodeId: planningNode.id,
      },
      agentOutputs: ['analysis-plan'],
      agentOutputKinds: { 'analysis-plan': 'path<md>' },
    })
    expect(renderedPlanPrompt).toContain(prompt)

    const implementationNode = host.nodes.find((node) => node.id === '__de_agent__')
    expect(implementationNode?.kind).toBe('agent-single')
    if (implementationNode?.kind !== 'agent-single') {
      throw new Error('missing implementation Agent node')
    }
    const approvedPlan = '# Approved implementation plan\n\nUse the reviewed contract.'
    const renderedImplementationPrompt = renderUserPrompt({
      promptTemplate: requirePromptTemplate(implementationNode, 'implementation'),
      inputs: { prompt, [DIGITAL_EMPLOYEE_IMPLEMENTATION_PLAN_KEY]: approvedPlan },
      meta: {
        repoPath: '/repo',
        baseBranch: 'main',
        taskId: 'implementation-task',
        nodeId: implementationNode.id,
      },
      agentOutputs: ['agent-result'],
      agentOutputKinds: { 'agent-result': 'string' },
    })
    expect(renderedImplementationPrompt).toContain(approvedPlan)
  })

  test('human-review projection reads the frozen host input and durable review receipt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(workflows).values({
      id: 'review-projection-workflow',
      name: 'review projection workflow',
      description: '',
      version: 1,
      schemaVersion: 2,
      definition: JSON.stringify({ $schema_version: 2, nodes: [], edges: [], inputs: [] }),
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(tasks).values({
      id: 'review-projection-task',
      name: 'review projection task',
      workflowId: 'review-projection-workflow',
      workflowSnapshot: '{}',
      repoPath: '/tmp/review-projection',
      worktreePath: '/tmp/review-projection',
      baseBranch: 'main',
      branch: 'agent-workflow/review-projection',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
    })

    expect(inspectDigitalEmployeeHumanReviewState(db, 'review-projection-task')).toBeNull()
    db.update(tasks)
      .set({ inputs: JSON.stringify({ [DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]: 'frozen prompt' }) })
      .where(eq(tasks.id, 'review-projection-task'))
      .run()
    expect(inspectDigitalEmployeeHumanReviewState(db, 'review-projection-task')).toBe('planning')

    await db.insert(nodeRuns).values({
      id: 'review-projection-run',
      taskId: 'review-projection-task',
      nodeId: DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID,
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
    })
    expect(inspectDigitalEmployeeHumanReviewState(db, 'review-projection-task')).toBe('waiting')
    db.update(nodeRuns)
      .set({ status: 'done' })
      .where(eq(nodeRuns.id, 'review-projection-run'))
      .run()
    expect(inspectDigitalEmployeeHumanReviewState(db, 'review-projection-task')).toBe('approved')
    db.update(nodeRuns)
      .set({ status: 'failed' })
      .where(eq(nodeRuns.id, 'review-projection-run'))
      .run()
    expect(inspectDigitalEmployeeHumanReviewState(db, 'review-projection-task')).toBe('failed')
  })

  test('a failed reviewed execution reports the task failure before derived plan validation', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'reviewed-execution-failed-before-output'
    await db.insert(tasks).values({
      id: taskId,
      name: 'reviewed execution pre-spawn failure',
      workflowId: 'digital-employee-host-reviewed',
      workflowSnapshot: '{}',
      repoPath: '/tmp/reviewed-execution-failure',
      worktreePath: '/tmp/reviewed-execution-failure',
      baseBranch: 'main',
      branch: 'agent-workflow/reviewed-execution-failure',
      status: 'failed',
      inputs: JSON.stringify({
        [DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]:
          'EXPECTED_ANALYSIS_PLAN_PATH_JSON\n".agent-workflow/reviews/plan.md"',
      }),
      startedAt: 1,
      finishedAt: 2,
      errorSummary: 'implementation Agent failed before spawn',
      errorMessage: 'invalid prompt template ref: malformed-local-ref',
      failedNodeId: '__de_agent__',
    })
    const execution = composeDigitalEmployeeExecution({
      db,
      appHome: '/tmp',
      startDeps: null as never,
      executionContracts: null as never,
    })

    expect(await execution.inspect(taskId)).toEqual({
      kind: 'failed',
      executionRef: taskId,
      errorClass: 'infrastructure',
      errorCode: 'execution-failed',
      errorDetail: 'invalid prompt template ref: malformed-local-ref',
    })
  })

  // Real development Case regression (2026-08-23): Bun watch interrupted an
  // implementation task, boot auto-resume immediately reclaimed the same task,
  // but the employee adapter had already reported the transient interrupted row
  // as a permanent round failure. The Case became blocked while its Task was
  // visibly running again, and repeated reloads then burned work for no purpose.
  test('daemon-restart interruptions remain pending while automatic recovery is available', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'employee-execution-recovering-after-daemon-restart'
    await db.insert(tasks).values({
      id: taskId,
      name: 'recovering employee execution',
      workflowId: 'digital-employee-host',
      workflowSnapshot: '{}',
      repoPath: '/tmp/recovering-employee-execution',
      worktreePath: '/tmp/recovering-employee-execution',
      baseBranch: 'main',
      branch: 'agent-workflow/recovering-employee-execution',
      status: 'interrupted',
      inputs: '{}',
      startedAt: 1,
      finishedAt: 2,
      errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
      errorMessage: 'daemon restarted while this task was running; please resume',
      autoRecoverySuspended: false,
    })
    const execution = composeDigitalEmployeeExecution({
      db,
      appHome: '/tmp',
      startDeps: null as never,
      executionContracts: null as never,
    })

    expect(await execution.inspect(taskId)).toEqual({
      kind: 'pending',
      executionRef: taskId,
    })

    db.update(tasks).set({ autoRecoverySuspended: true }).where(eq(tasks.id, taskId)).run()
    expect(await execution.inspect(taskId)).toEqual({
      kind: 'failed',
      executionRef: taskId,
      errorClass: 'infrastructure',
      errorCode: 'execution-interrupted',
      errorDetail: 'daemon restarted while this task was running; please resume',
    })
  })

  test('exact envelope validation rejects malformed input and missing, extra, or cross-round output', () => {
    const contract = guide('development.analyze-implement')
    const exactInput = JSON.parse(contract.input.exampleJson) as Record<string, unknown>
    exactInput.roundRef = 'round-1'
    exactInput.executionNonce = '2'.repeat(64)
    expect(
      JSON.parse(
        validateExactContractInput({
          guide: contract,
          roundRef: 'round-1',
          executionNonce: '2'.repeat(64),
          inputJson: JSON.stringify(exactInput),
        }),
      ),
    ).toEqual(exactInput)
    expect(() =>
      validateExactContractInput({
        guide: contract,
        roundRef: 'round-1',
        executionNonce: '2'.repeat(64),
        inputJson: JSON.stringify({ ...exactInput, workItemRef: 42 }),
      }),
    ).toThrow('workItemRef must be string')

    const base = {
      schemaVersion: 1,
      roundRef: 'round-1',
      executionNonce: '2'.repeat(64),
      status: 'ok',
      summary: 'done',
      deliveryContent: {
        commitMessage: 'implement accepted requirement',
        mergeRequestTitle: 'Implement accepted requirement',
        mergeRequestDescription: 'Implemented the accepted requirement.',
      },
      contextPatches: [],
      effectSuggestions: [],
      artifactRefs: [],
    }
    expect(
      JSON.parse(
        validateExactContractOutput({
          guide: contract,
          roundRef: 'round-1',
          executionNonce: '2'.repeat(64),
          outputJson: JSON.stringify(base),
        }),
      ),
    ).toEqual(base)
    expect(() =>
      validateExactContractOutput({
        guide: contract,
        roundRef: 'round-1',
        executionNonce: '2'.repeat(64),
        outputJson: JSON.stringify({ ...base, extra: true }),
      }),
    ).toThrow('extra=[extra]')
    const missing: Partial<typeof base> = { ...base }
    delete missing.summary
    expect(() =>
      validateExactContractOutput({
        guide: contract,
        roundRef: 'round-1',
        executionNonce: '2'.repeat(64),
        outputJson: JSON.stringify(missing),
      }),
    ).toThrow('missing=[summary]')
    expect(() =>
      validateExactContractOutput({
        guide: contract,
        roundRef: 'round-1',
        executionNonce: '2'.repeat(64),
        outputJson: JSON.stringify({ ...base, contextPatches: 'not-an-array' }),
      }),
    ).toThrow('contextPatches must be array')
    expect(() =>
      validateExactContractOutput({
        guide: contract,
        roundRef: 'other-round',
        executionNonce: '2'.repeat(64),
        outputJson: JSON.stringify(base),
      }),
    ).toThrow('roundRef')
  })

  test('Agent compatibility requires both the output port and an explicit contract declaration', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await ensureDigitalEmployeeAgentTemplates(db)
    const templates = await listDigitalEmployeeAgentTemplates(db)
    const codeWriter = templates.find(
      (agent) => agent.frontmatterExtra.digitalEmployeeTemplate === 'code-writing',
    )!
    const planner = templates.find(
      (agent) => agent.frontmatterExtra.digitalEmployeeTemplate === 'implementation-planning',
    )!
    db.update(agentRows)
      .set({
        frontmatterExtra: JSON.stringify({
          digitalEmployeeTemplate: 'code-writing',
          schemaVersion: 1,
        }),
      })
      .where(eq(agentRows.id, codeWriter.id))
      .run()
    const service = new ExecutionContractService({
      registrations: developmentExecutionContractRegistrations,
      resources: createExecutionContractResourceAdapter(
        db,
        developmentImplicitAgentContractDeclarations,
      ),
      programFixtures: {
        async validate() {
          return []
        },
      },
    })
    const compatible = await service.validateExecutor({
      contractRef: { contractId: 'development.analyze-implement', version: 1 },
      implementation: {
        kind: 'agent',
        agentRef: { id: codeWriter.id, revision: codeWriter.updatedAt },
      },
    })
    expect(compatible.status).toBe('valid')
    expect(
      await service.validateAgentCandidates({
        contractRef: { contractId: 'development.analyze-implement', version: 1 },
        agentRefs: [
          { id: codeWriter.id, revision: codeWriter.updatedAt },
          { id: codeWriter.id, revision: codeWriter.updatedAt },
        ],
      }),
    ).toEqual([
      {
        agentRef: { id: codeWriter.id, revision: codeWriter.updatedAt },
        validationReceipt: compatible,
      },
    ])
    const mismatched = await service.validateExecutor({
      contractRef: { contractId: 'development.prepare-materials', version: 1 },
      implementation: {
        kind: 'agent',
        agentRef: { id: codeWriter.id, revision: codeWriter.updatedAt },
      },
    })
    expect(mismatched.status).toBe('invalid')
    expect(mismatched.checks).toContainEqual(
      expect.objectContaining({ code: 'agent-contract-declared', ok: false }),
    )
    const compatiblePlanner = await service.validateExecutor({
      contractRef: { contractId: 'development.plan-implementation', version: 2 },
      implementation: {
        kind: 'agent',
        agentRef: { id: planner.id, revision: planner.updatedAt },
      },
    })
    expect(compatiblePlanner.status).toBe('valid')
    expect(compatiblePlanner.checks).toContainEqual(
      expect.objectContaining({
        code: 'agent-exact-revision-resolves',
        ok: true,
        detail: expect.stringContaining('exact analysis-plan output port'),
      }),
    )
  })

  test('Agent saves keep the contract-owned result port atomic with declaration lifecycle', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const created = await createAgent(db, {
      name: 'contract-owned-port',
      description: '',
      outputs: [],
      outputKinds: { 'agent-result': 'markdown' },
      branchPorts: ['agent-result'],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        executionContracts: [{ contractId: 'development.analyze-implement', version: 1 }],
      },
      bodyMd: '',
    })
    expect(created.outputs).toEqual(['agent-result'])
    expect(created.outputKinds).toEqual({})
    expect(created.branchPorts).toBeUndefined()

    const protectedPort = await updateAgent(db, created.id, {
      outputs: [],
      outputKinds: { 'agent-result': 'signal' },
      branchPorts: ['agent-result'],
    })
    expect(protectedPort.outputs).toEqual(['agent-result'])
    expect(protectedPort.outputKinds).toEqual({})
    expect(protectedPort.branchPorts).toBeUndefined()

    const removed = await updateAgent(db, created.id, {
      frontmatterExtra: {},
      outputs: ['ordinary', 'agent-result'],
      outputKinds: { ordinary: 'markdown', 'agent-result': 'signal' },
      branchPorts: ['agent-result'],
    })
    expect(removed.outputs).toEqual(['ordinary'])
    expect(removed.outputKinds).toEqual({ ordinary: 'markdown' })
    expect(removed.branchPorts).toBeUndefined()

    const planner = await createAgent(db, {
      name: 'contract-owned-plan-port',
      description: '',
      outputs: [],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        executionContracts: [
          {
            contractId: 'development.analyze-plan',
            version: 1,
            outputPort: 'analysis-plan',
            outputKind: 'path<md>',
          },
        ],
      },
      bodyMd: '',
    })
    expect(planner.outputs).toEqual(['analysis-plan'])
    expect(planner.outputKinds).toEqual({ 'analysis-plan': 'path<md>' })
    const plannerProtected = await updateAgent(db, planner.id, {
      outputs: [],
      outputKinds: { 'analysis-plan': 'signal' },
    })
    expect(plannerProtected.outputs).toEqual(['analysis-plan'])
    expect(plannerProtected.outputKinds).toEqual({ 'analysis-plan': 'path<md>' })
    const plannerUnlinked = await updateAgent(db, planner.id, {
      frontmatterExtra: {},
      outputs: ['analysis-plan'],
    })
    expect(plannerUnlinked.outputs).toEqual([])
  })

  test('Program validation executes the authored script with the same env input and stdout contract', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'execution-contract-program-'))
    roots.push(appHome)
    const source = `const input = JSON.parse(process.env.AW_PORT_CONTRACT_INPUT ?? '')
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  roundRef: input.roundRef,
  executionNonce: input.executionNonce,
  status: 'blocked',
  summary: 'fixture ' + input.inputSchemaId,
  contextPatches: [],
  effectSuggestions: [],
  artifactRefs: [],
}))`
    const artifact = await createProgramArtifactStore(appHome).put({
      runtimeKind: 'node',
      source,
      parameterValues: null,
    })
    const checks = await createExecutionContractProgramFixtureAdapter({
      appHome,
      scriptInterpreterOverrides: { node: process.execPath },
    }).validate({
      guide: guide('development.prepare-materials'),
      implementation: {
        kind: 'program',
        runtimeKind: 'node',
        ...artifact,
        runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
      },
    })
    expect(checks).toEqual([
      {
        code: 'program-fixture-exact-output',
        ok: true,
        detail: 'development.work-request.v1 -> development.requirement-context.v1',
      },
    ])
    expect(executionContractRefKey(guide('development.prepare-materials').contractRef)).toBe(
      'development.prepare-materials@1',
    )

    const invalidDirectArtifact = await createProgramArtifactStore(appHome).put({
      runtimeKind: 'node',
      source: `process.stdout.write(JSON.stringify({ outcome: 'completed' }))`,
      parameterValues: null,
    })
    const directRegistration = developmentExecutionContractRegistrations.find(
      (registration) =>
        registration.contractRef.contractId === 'development.implement-change' &&
        registration.contractRef.version === 2,
    )!
    const directChecks = await createExecutionContractProgramFixtureAdapter({
      appHome,
      scriptInterpreterOverrides: { node: process.execPath },
    }).validate({
      guide: guide('development.implement-change'),
      implementation: {
        kind: 'program',
        runtimeKind: 'node',
        ...invalidDirectArtifact,
        runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
      },
      validateOutputJson: directRegistration.validateOutputJson,
    })
    expect(directChecks).toEqual([
      expect.objectContaining({ code: 'program-fixture-exact-output', ok: false }),
    ])
  })

  test('the shared Script host keeps the platform contract input port explicit', () => {
    const snapshot = synthesizeDigitalEmployeeScriptHostSnapshot({
      inputPort: 'contract-input',
      language: 'node',
      script: 'process.stdout.write("{}")',
      dependencies: [],
      env: {},
      readonly: false,
    })
    expect(snapshot.inputs).toEqual([
      expect.objectContaining({ key: 'contract-input', required: true }),
    ])
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({ kind: 'input', inputKey: 'contract-input' }),
    )
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({ portName: 'contract-input' }),
        target: expect.objectContaining({ portName: 'contract-input' }),
      }),
    )
  })
})
