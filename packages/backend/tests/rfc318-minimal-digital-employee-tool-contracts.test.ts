import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { agents as agentRows } from '@/db/schema'
import {
  projectDevelopmentToolInputV2,
  projectDevelopmentToolResultV2,
} from '@/modules/development-automation/application/digitalEmployeeToolContractProjectionV2'
import {
  developmentExecutionContractRegistrationsV2,
  developmentWorkContractsV2,
} from '@/modules/development-automation/composition/digitalEmployeeToolContractsV2'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  DEVELOPMENT_TOOL_CONTRACT_IDS_V2,
  developmentToolInputSchemasV2,
  validateDevelopmentToolOutputV2,
  type DevelopmentToolContractIdV2,
  type DevelopmentToolJsonOutputContractIdV2,
} from '@/modules/development-automation/domain/digitalEmployeeToolContractsV2'
import {
  DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2,
  DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2,
} from '@/modules/development-automation/public/participants'
import { employeeTypePackageDescriptorSchema } from '@/modules/digital-employee/domain/model'
import { executionContractGuideSchema } from '@/modules/execution-contract/domain/model'
import {
  digitalEmployeeAgentToolPresentation,
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NONCE = 'a'.repeat(64)

const context = (typeId: string, state: unknown, index: number) => ({
  id: `context-${index}`,
  revision: 1,
  typeId,
  schemaVersion: 1,
  lifecycleState: 'active',
  stateJson: JSON.stringify(state),
  artifactRefs: [],
})

const reviewThread = {
  threadRef: 'thread-1',
  revision: '1:2',
  authorClass: 'human',
  body: '请补充空值处理。',
  path: 'src/example.ts',
  messages: [
    { authorClass: 'human', body: '请补充空值处理。', path: 'src/example.ts' },
    { authorClass: 'self', body: '已收到。', path: 'src/example.ts' },
  ],
}

function hostEnvelope(problemSource: 'review' | 'pipeline' = 'review') {
  const issue = {
    repositoryRef: 'repository-1',
    request: { kind: 'external-id', externalId: 'ISSUE-1234', uploads: [] },
    deliveryContent: {
      commitMessage: 'initial implementation',
      mergeRequestTitle: 'Implement the request',
      mergeRequestDescription: 'Implements the accepted request.',
    },
  }
  const mergeRequest = {
    mergeRequestRef: 'project!123',
    headSha: '1'.repeat(40),
    targetSha: '2'.repeat(40),
  }
  const pipeline = {
    status: 'failed',
    mergeRequestRef: 'project!123',
    headSha: '1'.repeat(40),
    targetSha: '2'.repeat(40),
    checks: [
      {
        checkRef: 'build',
        name: 'Build',
        status: 'failed',
        summary: 'Type check failed',
        evidenceFiles: ['.agent-workflow/pipeline/case/build.log'],
      },
      { checkRef: 'lint', name: 'Lint', status: 'passed' },
    ],
  }
  const problemSet =
    problemSource === 'review'
      ? {
          status: 'active',
          source: 'review',
          headSha: '1'.repeat(40),
          remainingTypes: ['review'],
          problems: [
            {
              problemId: 'thread-1',
              type: 'review',
              summary: 'Review feedback',
              evidenceArtifactRefs: [],
              reviewThread,
            },
          ],
        }
      : {
          status: 'active',
          source: 'pipeline',
          headSha: '1'.repeat(40),
          remainingTypes: ['compile-error'],
          problems: [
            {
              problemId: 'build',
              type: 'compile-error',
              summary: 'Type check failed',
              evidenceArtifactRefs: ['.agent-workflow/pipeline/case/build.log'],
              reviewThread: null,
            },
          ],
        }
  return JSON.stringify({
    connectionRef: { id: 'connection-1', revision: 3 },
    contractInput: {
      workRequest: { externalId: 'ISSUE-1234' },
      failureTypeDefinitions: [
        {
          typeId: 'compile-error',
          name: '编译错误',
          description: '编译或类型检查失败',
          fallback: false,
          priority: 1,
          handlingWorkItemRef: 'repair-pipeline',
        },
        {
          typeId: 'other',
          name: '其他',
          description: '未命中其他类型',
          fallback: true,
          priority: 2,
          handlingWorkItemRef: 'repair-pipeline',
        },
      ],
      assignedFailureType: 'compile-error',
    },
    contextsJson: JSON.stringify([
      context('development.issue-handling', issue, 1),
      context('development.merge-request', mergeRequest, 2),
      context('development.pipeline', pipeline, 3),
      context('development.problem-set', problemSet, 4),
    ]),
    platformPaths: {
      requirementDirectory: '.agent-workflow/inputs/requirements/case',
      externalMaterialDirectory: '.agent-workflow/inputs/requirements/case/external',
      pipelineDirectory: '.agent-workflow/pipeline/case',
      implementationPlanPath:
        '.agent-workflow/inputs/requirements/case/review/implementation-plan.md',
    },
    humanReview: { status: 'approved' },
  })
}

function directResult(result: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    roundRef: 'round-1',
    executionNonce: NONCE,
    directResult: result,
  })
}

const expectedInputFields: Record<DevelopmentToolContractIdV2, readonly string[]> = {
  'development.prepare-materials': ['connection', 'externalItemId', 'outputDirectory'],
  'development.plan-implementation': ['outputFile', 'requirementsDirectory'],
  'development.implement-change': ['approvedPlanFile', 'requirementsDirectory'],
  'development.resolve-review-feedback': ['requirementsDirectory', 'threads'],
  'development.collect-pipeline-status': ['connection', 'evidenceDirectory', 'mergeRequest'],
  'development.classify-pipeline-failures': ['categories', 'failedChecks', 'fallbackType'],
  'development.repair-pipeline-failures': ['failureType', 'problems'],
  'development.resolve-merge-conflicts': [
    'conflictFiles',
    'requirementsDirectory',
    'sourceVersion',
    'targetVersion',
  ],
  'development.draft-approval': [
    'approvalType',
    'currentVersion',
    'formatGuide',
    'gateConclusions',
    'mergeRequest',
  ],
}

const validOutputs: Record<DevelopmentToolJsonOutputContractIdV2, Record<string, unknown>> = {
  'development.prepare-materials': { outcome: 'completed' },
  'development.implement-change': {
    outcome: 'completed',
    commitMessage: 'implement accepted change',
    mergeRequestTitle: 'Implement accepted change',
    mergeRequestDescription: 'Implements the accepted behavior and tests.',
  },
  'development.resolve-review-feedback': {
    outcome: 'completed',
    replies: [{ threadRef: 'thread-1', reply: '已补充空值处理和回归测试。' }],
    commitMessage: 'address review feedback',
  },
  'development.collect-pipeline-status': {
    outcome: 'completed',
    observedSourceVersion: '1'.repeat(40),
    observedTargetVersion: '2'.repeat(40),
    status: 'failed',
    checks: [{ checkRef: 'build', name: 'Build', status: 'failed' }],
  },
  'development.classify-pipeline-failures': {
    outcome: 'completed',
    groups: [{ type: 'compile-error', checkRefs: ['build'] }],
  },
  'development.repair-pipeline-failures': {
    outcome: 'completed',
    commitMessage: 'fix compile errors',
  },
  'development.resolve-merge-conflicts': {
    outcome: 'completed',
    commitMessage: 'resolve merge conflicts',
  },
  'development.draft-approval': {
    outcome: 'completed',
    draft: '## 变更审批\n\n门禁已通过，请审批。',
  },
}

describe('RFC-318 minimal digital employee tool contracts', () => {
  test('development@9 exposes exactly nine intuitive v2 actions', () => {
    const descriptor = employeeTypePackageDescriptorSchema.parse(
      JSON.parse(developmentEmployeeTypePackage.descriptorJson) as unknown,
    )
    expect(descriptor.typeRef).toEqual({ typeId: 'development', revision: 9 })
    expect(developmentWorkContractsV2.map((contract) => contract.contractId)).toEqual([
      ...DEVELOPMENT_TOOL_CONTRACT_IDS_V2,
    ])

    const expected = {
      'prepare-materials': ['准备外部材料', 'development.prepare-materials'],
      'analyze-implement': ['实现变更', 'development.implement-change'],
      'repair-feedback': ['处理检视意见', 'development.resolve-review-feedback'],
      'collect-pipeline': ['采集流水线状态', 'development.collect-pipeline-status'],
      'classify-pipeline': ['分类流水线失败', 'development.classify-pipeline-failures'],
      'repair-pipeline': ['修复流水线失败', 'development.repair-pipeline-failures'],
      'repair-conflict': ['解决合并冲突', 'development.resolve-merge-conflicts'],
      'prepare-approval': ['编写审批草稿', 'development.draft-approval'],
    } as const
    for (const [workItemRef, [label, contractId]] of Object.entries(expected)) {
      const item = descriptor.authoringManifest.workItems.find(
        (candidate) => candidate.workItemRef === workItemRef,
      )
      expect(item?.label['zh-CN']).toBe(label)
      expect(item?.workContractRef).toEqual({ contractId, version: 2 })
    }
    const implementation = descriptor.authoringManifest.workItems.find(
      (item) => item.workItemRef === 'analyze-implement',
    )!
    expect(implementation.toolRoleGroups).toContainEqual(
      expect.objectContaining({
        roleRef: 'planning',
        label: { 'zh-CN': '编写实现方案', 'en-US': 'Write implementation plan' },
        workContractRef: { contractId: 'development.plan-implementation', version: 2 },
      }),
    )
    expect(implementation.humanReview?.reviewedPath?.beforeReviewLabel).toEqual({
      'zh-CN': '编写实现方案',
      'en-US': 'Write implementation plan',
    })
  })

  test('platform-owned nodes expose their own input and output instead of a shared tool template', () => {
    const descriptor = employeeTypePackageDescriptorSchema.parse(
      JSON.parse(developmentEmployeeTypePackage.descriptorJson) as unknown,
    )
    const platformNodes = descriptor.authoringManifest.workItems.filter(
      (item) => item.nodeKind !== 'business-tool',
    )

    expect(platformNodes).toHaveLength(12)
    expect(new Set(platformNodes.map((item) => JSON.stringify(item.materialSummary))).size).toBe(
      platformNodes.length,
    )
    expect(new Set(platformNodes.map((item) => JSON.stringify(item.completionStandard))).size).toBe(
      platformNodes.length,
    )

    for (const item of platformNodes) {
      const contract = descriptor.workContracts.find(
        (candidate) =>
          candidate.contractId === item.workContractRef.contractId &&
          candidate.version === item.workContractRef.version,
      )
      expect(contract).toBeDefined()
      expect(item.materialSummary).toEqual(contract?.materialSummary)
      expect(item.completionStandard).toEqual(contract?.completionStandard)
      expect(contract?.allowedToolKinds).toEqual([])
      expect(item.toolRoleGroups).toEqual([])
    }
  })

  test('guides expose direct business fields without the host envelope', () => {
    expect(developmentExecutionContractRegistrationsV2).toHaveLength(9)
    for (const registration of developmentExecutionContractRegistrationsV2) {
      const guide = executionContractGuideSchema.parse(
        JSON.parse(registration.guideJson) as unknown,
      )
      const contractId = registration.contractRef.contractId as DevelopmentToolContractIdV2
      expect(guide.inputMode).toBe('direct-json')
      expect([...guide.input.topLevelFields].sort()).toEqual([...expectedInputFields[contractId]])
      expect(guide.outputMode).toBe(
        contractId === 'development.plan-implementation' ? 'artifact-path' : 'direct-json',
      )
      for (const platformField of [
        'schemaVersion',
        'roundRef',
        'executionNonce',
        'contextsJson',
        'contextPatches',
        'effectSuggestions',
        'artifactRefs',
        'nextWorkItemRef',
      ]) {
        expect(guide.input.topLevelFields).not.toContain(platformField)
        expect(guide.output.topLevelFields).not.toContain(platformField)
      }
      expect(registration.guideJson).not.toMatch(
        /zero[- ]network|no network|不得访问网络|sandbox|沙箱/i,
      )
    }
    const guide = (contractId: string) =>
      executionContractGuideSchema.parse(
        JSON.parse(
          developmentExecutionContractRegistrationsV2.find(
            (registration) => registration.contractRef.contractId === contractId,
          )!.guideJson,
        ) as unknown,
      )
    const reviewCommit = guide('development.resolve-review-feedback').output.fields.find(
      (field) => field.path === 'commitMessage',
    )!
    expect(reviewCommit.description['zh-CN']).toBe('代码修改对应的提交信息')
    expect(reviewCommit.condition?.['zh-CN']).toBe('实际修改代码时返回')
    const observedTarget = guide('development.collect-pipeline-status').output.fields.find(
      (field) => field.path === 'observedTargetVersion',
    )!
    expect(observedTarget.description['zh-CN']).toBe('这份流水线状态所属的目标版本')
    expect(observedTarget.condition?.['zh-CN']).toBe('提供方确认目标版本时返回')
  })

  test('input projectors send only the fields consumed by each action', () => {
    const projected = (contractId: DevelopmentToolContractIdV2, source = hostEnvelope()) =>
      JSON.parse(
        projectDevelopmentToolInputV2({
          contractId,
          inputEnvelopeJson: source,
          ...(contractId === 'development.resolve-merge-conflicts'
            ? { projectionJson: JSON.stringify({ conflictFiles: ['src/example.ts'] }) }
            : {}),
        }),
      ) as Record<string, unknown>

    for (const contractId of DEVELOPMENT_TOOL_CONTRACT_IDS_V2) {
      const source =
        contractId === 'development.repair-pipeline-failures'
          ? hostEnvelope('pipeline')
          : hostEnvelope()
      expect(Object.keys(projected(contractId, source)).sort()).toEqual([
        ...expectedInputFields[contractId],
      ])
    }
    expect(projected('development.resolve-review-feedback')).toMatchObject({
      threads: [
        {
          threadRef: 'thread-1',
          file: 'src/example.ts',
          messages: [
            { author: 'human', body: '请补充空值处理。' },
            { author: 'self', body: '已收到。' },
          ],
        },
      ],
    })
    expect(projected('development.classify-pipeline-failures')).toEqual({
      failedChecks: [
        {
          checkRef: 'build',
          name: 'Build',
          summary: 'Type check failed',
          evidenceFiles: ['.agent-workflow/pipeline/case/build.log'],
        },
      ],
      categories: [
        { type: 'compile-error', name: '编译错误', description: '编译或类型检查失败' },
        { type: 'other', name: '其他', description: '未命中其他类型' },
      ],
      fallbackType: 'other',
    })
    expect(projected('development.draft-approval')).toMatchObject({
      gateConclusions: [{ name: 'pipeline', conclusion: 'failed' }],
    })
  })

  test('business limits reject ambiguous material IDs and fact-free approval drafts', () => {
    expect(() =>
      developmentToolInputSchemasV2['development.prepare-materials'].parse({
        connection: { id: 'connection-1', revision: 1 },
        externalItemId: 'x'.repeat(501),
        outputDirectory: '.agent-workflow/inputs/requirements/case/external',
      }),
    ).toThrow()
    expect(() =>
      developmentToolInputSchemasV2['development.draft-approval'].parse({
        mergeRequest: 'project!123',
        currentVersion: '1'.repeat(40),
        approvalType: 'gate-change',
        gateConclusions: [],
        formatGuide: '使用 Markdown 简洁说明变更、门禁和风险。',
      }),
    ).toThrow()
  })

  test('each JSON action accepts only its own completed or blocked result', () => {
    for (const [contractId, output] of Object.entries(validOutputs) as Array<
      [DevelopmentToolJsonOutputContractIdV2, Record<string, unknown>]
    >) {
      expect(
        JSON.parse(validateDevelopmentToolOutputV2(contractId, JSON.stringify(output))),
      ).toEqual(output)
      expect(
        JSON.parse(
          validateDevelopmentToolOutputV2(
            contractId,
            JSON.stringify({ outcome: 'blocked', explanation: '缺少必要的提供方事实。' }),
          ),
        ),
      ).toEqual({ outcome: 'blocked', explanation: '缺少必要的提供方事实。' })
      expect(() =>
        validateDevelopmentToolOutputV2(
          contractId,
          JSON.stringify({ ...output, schemaVersion: 2 }),
        ),
      ).toThrow()
      expect(() =>
        validateDevelopmentToolOutputV2(
          contractId,
          JSON.stringify({ outcome: 'blocked', explanation: 'blocked', summary: 'extra' }),
        ),
      ).toThrow()
    }
  })

  test('result projection derives internal state without accepting tool-owned routing metadata', () => {
    const implementation = JSON.parse(
      projectDevelopmentToolResultV2({
        workItemRef: 'analyze-implement',
        inputEnvelopeJson: hostEnvelope(),
        connectionRef: null,
        outputEnvelopeJson: directResult(validOutputs['development.implement-change']),
      }),
    ) as Record<string, unknown>
    expect(implementation).toMatchObject({
      status: 'ok',
      deliveryContent: {
        commitMessage: 'implement accepted change',
        mergeRequestTitle: 'Implement accepted change',
      },
    })

    const replyOnly = JSON.parse(
      projectDevelopmentToolResultV2({
        workItemRef: 'repair-feedback',
        inputEnvelopeJson: hostEnvelope(),
        connectionRef: null,
        outputEnvelopeJson: directResult({
          outcome: 'completed',
          replies: [{ threadRef: 'thread-1', reply: '当前实现已覆盖该情况，无需改代码。' }],
        }),
      }),
    ) as Record<string, unknown>
    expect(replyOnly).toMatchObject({
      status: 'ok',
      reviewReplies: [
        expect.objectContaining({
          threadRef: 'thread-1',
          replyBody: '当前实现已覆盖该情况，无需改代码。',
        }),
      ],
    })
    expect(replyOnly).not.toHaveProperty('deliveryContent')

    expect(() =>
      projectDevelopmentToolResultV2({
        workItemRef: 'classify-pipeline',
        inputEnvelopeJson: hostEnvelope('pipeline'),
        connectionRef: null,
        outputEnvelopeJson: directResult({
          outcome: 'completed',
          groups: [{ type: 'other', checkRefs: ['unknown-check'] }],
        }),
      }),
    ).toThrow('unknown or duplicate failed check')
    expect(() =>
      projectDevelopmentToolResultV2({
        workItemRef: 'collect-pipeline',
        inputEnvelopeJson: hostEnvelope(),
        connectionRef: { id: 'connection-1', revision: 3 },
        outputEnvelopeJson: directResult({
          outcome: 'completed',
          observedSourceVersion: '9'.repeat(40),
          observedTargetVersion: '2'.repeat(40),
          status: 'failed',
          checks: [{ checkRef: 'build', name: 'Build', status: 'failed' }],
        }),
      }),
    ).toThrow('current source version')
  })

  test('development@9 rejects the legacy agent-result envelope for v2 business tools', () => {
    expect(() =>
      developmentEmployeeRuntimeCodec.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          employeeTypeRef: { typeId: 'development', revision: 9 },
          workItemRef: 'analyze-implement',
          toolSlotRef: 'default',
          connectionRef: null,
          inputEnvelopeJson: JSON.stringify({ contextsJson: '[]' }),
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-1',
            executionNonce: NONCE,
            status: 'ok',
            summary: 'legacy envelope',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
          }),
        }),
      ),
    ).toThrow('analyze-implement must return its direct business result')
  })

  test('the eight v2 built-ins each declare one action and keep existing network access', () => {
    expect(DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2).toHaveLength(8)
    expect(DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2).toHaveLength(8)
    expect(new Set(DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2).size).toBe(8)

    const intents: string[] = []
    const expectedPresentations = {
      'code-writing': '通用代码实现',
      'problem-diagnosis': '流水线失败分类',
      'pipeline-repair': '流水线失败修复',
      'review-repair': '检视意见处理',
      'conflict-repair': '合并冲突处理',
      'business-implementation': '业务需求实现',
      'issue-repair': '缺陷修复',
      'implementation-planning': '编写实现方案',
    } as const
    for (const template of DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2) {
      const contracts = template.definition.frontmatterExtra.executionContracts as Array<{
        contractId: string
        version: number
      }>
      expect(contracts).toHaveLength(1)
      expect(contracts[0]?.version).toBe(2)
      expect(template.definition.permission).toEqual({})
      expect(template.definition.skills).toEqual([])
      expect(template.definition.mcp).toEqual([])
      expect(template.definition.plugins).toEqual([])
      expect(template.definition.bodyMd).toContain('网络')
      expect(template.definition.bodyMd).not.toMatch(
        /schemaVersion|roundRef|executionNonce|contextPatches|effectSuggestions|artifactRefs|envelope|零网络|沙箱/i,
      )
      const templateKind = template.definition.frontmatterExtra
        .digitalEmployeeTemplate as keyof typeof expectedPresentations
      expect(digitalEmployeeAgentToolPresentation(templateKind)?.zh).toBe(
        expectedPresentations[templateKind],
      )
      const intent = template.definition.frontmatterExtra.implementationIntent
      if (typeof intent === 'string') intents.push(intent)
    }
    expect(intents.sort()).toEqual(['defect', 'feature', 'unspecified'])
    expect(
      DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2[0]?.definition.frontmatterExtra
        .executionContracts,
    ).toEqual([{ contractId: 'development.implement-change', version: 2 }])
  })

  // Create-or-CONVERGE, not create-or-equal: refusing a drifted row meant one
  // reworded template stopped the daemon on every already-seeded database. The
  // retained collision refusal is covered in
  // tests/digital-employee-agent-template-reconcile.test.ts.
  test('v2 built-in IDs are create-or-converge and repair a drifted definition', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await ensureDigitalEmployeeAgentTemplates(db)
    await ensureDigitalEmployeeAgentTemplates(db)
    expect(await listDigitalEmployeeAgentTemplates(db)).toHaveLength(8)

    db.update(agentRows)
      .set({ description: 'changed occupied definition' })
      .where(eq(agentRows.id, DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[0]))
      .run()
    await ensureDigitalEmployeeAgentTemplates(db)
    expect((await listDigitalEmployeeAgentTemplates(db))[0]?.description).toBe(
      DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2[0]?.definition.description,
    )
  })
})
