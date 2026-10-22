import { z } from 'zod'
import type { EmployeeTypePackageRegistration } from '@/modules/digital-employee/public/types'

export const GRAPH_EMPLOYEE_TYPE = { typeId: 'graph-development', revision: 1 } as const
export const GRAPH_CONTEXT_TYPE = 'graph-development.design-context'
export const GRAPH_EVENT_SOURCE = { id: 'graph-development.requests', revision: 1 } as const
export const graphText = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })
const text = graphText

export const GraphEmployeeScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repository'), repositoryId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('task') }).strict(),
])

export const GRAPH_WORK_ITEMS = [
  {
    id: 'understand-request',
    label: text('理解工作材料', 'Understand the request'),
    description: text(
      '读取材料与准确仓库基线，建立共享设计。',
      'Read the material and exact repository baseline to establish a shared design.',
    ),
    executors: [] as ('agent' | 'workflow' | 'program')[],
    mode: 'read-only',
    next: ['design-and-clarify'],
  },
  {
    id: 'design-and-clarify',
    label: text('设计与澄清', 'Design and clarify'),
    description: text(
      '按关注点生成和调整视图组合，保留人的回答与未定事项。',
      'Adapt the view combination to the concerns while preserving human answers and unknowns.',
    ),
    executors: ['workflow'] as ('agent' | 'workflow' | 'program')[],
    mode: 'read-only',
    next: [] as string[],
  },
  {
    id: 'review-design',
    label: text('审核实现依据', 'Review the implementation basis'),
    description: text(
      '对指定版本进行独立审核，返回原决定。',
      'Review an immutable basis and return the actual decision.',
    ),
    executors: ['workflow'] as ('agent' | 'workflow' | 'program')[],
    mode: 'read-only',
    next: [] as string[],
  },
  {
    id: 'implement-change',
    label: text('生成代码与测试', 'Implement code and tests'),
    description: text(
      '消费已批准的同一基线，完成代码、用例和追溯提案。',
      'Consume the approved basis and complete code, tests and trace proposals.',
    ),
    executors: ['agent', 'workflow', 'program'] as ('agent' | 'workflow' | 'program')[],
    mode: 'write',
    next: ['verify-change'],
  },
  {
    id: 'verify-change',
    label: text('校验候选', 'Verify the candidate'),
    description: text(
      '核对实际候选与追溯，并执行已登记的校验。',
      'Check the actual candidate and traces, then run the registered verification profiles.',
    ),
    executors: [] as ('agent' | 'workflow' | 'program')[],
    mode: 'read-only',
    next: ['deliver-result'],
  },
  {
    id: 'deliver-result',
    label: text('交付结果', 'Deliver the result'),
    description: text(
      '汇总设计、代码、验证和明确配置的发布回执。',
      'Present design, code, verification and explicitly configured publication receipts.',
    ),
    executors: [] as ('agent' | 'workflow' | 'program')[],
    mode: 'read-only',
    next: [] as string[],
  },
] as const

export const GRAPH_WORK_CONTRACTS = GRAPH_WORK_ITEMS.map((item) => ({
  contractId: `graph-development.${item.id}`,
  version: 1,
  inputSchemaId: `graph-development.${item.id}.input`,
  outputSchemaId: `graph-development.${item.id}.output`,
  materialSummary: item.description,
  completionStandard: item.description,
  allowedToolKinds: item.executors,
  allowedEffectKinds: [],
  requiredConnectionPurpose: null,
  workspacePolicy: {
    mode: item.mode,
    businessChangeOnOk: item.id === 'implement-change' ? 'required' : 'forbidden',
    writablePrefixes: [],
    platformWritePrefixes: [],
  },
  semanticValidatorId: `graph-development.${item.id}.v1`,
  fixtureSuiteRef: { id: `graph-development.${item.id}.fixtures`, revision: 1 },
}))

export const graphEmployeeDescriptor = {
  schemaVersion: 1,
  typeRef: GRAPH_EMPLOYEE_TYPE,
  displayName: text('图驱动研发数字人', 'Graph development employee'),
  description: text(
    '按需求自适应组织业务视图，完成澄清、批准依据、代码与测试生成和实际校验。',
    'Adapt business views to each request, clarify decisions, review the implementation basis, generate code and tests, and verify actual results.',
  ),
  workScopeContractId: 'graph-development.repository-scope.v1',
  workScopeAuthoring: {
    schemaVersion: 1,
    label: text('负责范围', 'Responsibility scope'),
    description: text(
      '使用既有或已登记的空仓库。',
      'Use an existing or registered empty repository.',
    ),
    variants: [
      {
        kind: 'repository',
        label: text('单个仓库', 'Repository'),
        description: text('固定一个目标仓库', 'Use one repository'),
        fields: [
          {
            fieldRef: 'repositoryId',
            label: text('仓库', 'Repository'),
            description: text('平台已登记的仓库', 'A registered repository'),
            inputKind: 'repository-picker',
            required: true,
            placeholder: text('选择仓库', 'Choose repository'),
          },
        ],
      },
      {
        kind: 'task',
        label: text('工作启动时选择仓库', 'Choose repository for each request'),
        description: text('每次提交工作时指定目标', 'Choose the target for each work request'),
        fields: [],
      },
    ],
  },
  workIntakeAuthoring: {
    schemaVersion: 1,
    label: text('提交研发需求', 'Submit a development request'),
    description: text(
      '写下目标、已有约束和验收期望。图组合随澄清结果调整。',
      'Describe goals, known constraints and acceptance expectations. The views adapt as the design develops.',
    ),
    targetFields: [
      {
        fieldRef: 'repositoryId',
        label: text('目标仓库', 'Target repository'),
        description: text('包含已登记的空仓库', 'Registered empty repositories are supported'),
        inputKind: 'repository-picker',
        required: true,
        placeholder: text('选择仓库', 'Choose repository'),
      },
    ],
    acceptedKinds: ['body', 'files', 'body-and-files'],
    kindRequirements: [],
    executionOptions: [],
    advancedOptions: [
      {
        optionRef: 'publication-branch',
        control: 'repository-publication-branch',
        label: text('验证通过后发布到分支', 'Publish branch after verification'),
        description: text(
          '留空仅交付内部候选；可发布到基线分支或新分支，远端变化会阻止发布',
          'Leave empty for an internal candidate; publish to the baseline branch or a new branch. Remote changes block publication.',
        ),
      },
      {
        optionRef: 'working-branch',
        control: 'repository-branch',
        label: text('目标分支', 'Target branch'),
        description: text('留空时使用仓库默认分支', 'Use the repository default when empty'),
      },
    ],
    body: {
      label: text('需求正文', 'Request'),
      description: text(
        '目标、约束、未知问题和验收条件',
        'Goals, constraints, unknowns and acceptance criteria',
      ),
      placeholder: text('描述要解决的问题…', 'Describe the problem to solve…'),
      maxBytes: 2 * 1024 * 1024,
    },
    files: {
      label: text('参考材料', 'Reference material'),
      description: text('供设计与实现读取的材料', 'Material for design and implementation'),
      maxFiles: 200,
      maxFileBytes: 32 * 1024 * 1024,
      targetPathRequired: true,
      placementModes: ['temporary', 'repository'],
    },
    externalId: {
      label: text('外部标识', 'External reference'),
      description: text('请通过正文或文件提供材料', 'Provide material as text or files'),
      placeholder: text('参考标识', 'Reference'),
    },
  },
  workStartWorkItemRef: 'understand-request',
  workContracts: GRAPH_WORK_CONTRACTS,
  authoringManifest: {
    schemaVersion: 1,
    lifecycleRegions: [
      {
        regionId: 'delivery',
        label: text('设计到交付', 'Design to delivery'),
        description: text('可追溯的完整研发过程', 'A traceable development journey'),
        order: 0,
        responsibilityLanes: [
          {
            laneId: 'main',
            label: text('研发主线', 'Development'),
            description: text('澄清、实现、校验', 'Clarify, implement, verify'),
            order: 0,
            kind: 'spine',
          },
        ],
      },
    ],
    workIngresses: [],
    workItems: GRAPH_WORK_ITEMS.map((item, order) => ({
      workItemRef: item.id,
      regionId: 'delivery',
      responsibilityLaneId: 'main',
      order,
      label: item.label,
      description: item.description,
      workContractRef: { contractId: `graph-development.${item.id}`, version: 1 },
      materialSummary: item.description,
      completionStandard: item.description,
      nodeKind: item.executors.length ? 'business-tool' : 'system',
      toolRoleGroups: item.executors.length
        ? [
            {
              roleRef: 'primary',
              label: item.label,
              description: item.description,
              order: 0,
              bindingSlots: [
                {
                  slotRef: 'default',
                  label: text('执行工具', 'Execution tool'),
                  description: item.description,
                  required: true,
                  cardinality: 'exactly-one',
                },
              ],
            },
          ]
        : [],
      nextWorkItemRefs: item.next,
    })),
  },
  contextTypes: [
    {
      typeId: GRAPH_CONTEXT_TYPE,
      schemaVersion: 1,
      displayName: text('研发设计', 'Development design'),
      description: text(
        '指向唯一设计文档与已消费依据的摘要',
        'References the design document and consumed basis',
      ),
      projectionFields: [
        { path: 'designId', label: text('设计', 'Design'), format: 'text' },
        {
          path: 'consumedRevision',
          label: text('已消费版本', 'Consumed revision'),
          format: 'count',
        },
      ],
    },
  ],
  eventSources: [
    {
      sourceId: GRAPH_EVENT_SOURCE.id,
      version: 1,
      ownerTypeId: GRAPH_EMPLOYEE_TYPE.typeId,
      displayName: text('设计工作请求', 'Design work requests'),
      description: text(
        '用户明确提交的设计、审核与实现请求',
        'Explicit design, review and implementation requests',
      ),
      observationMode: 'passive',
      observerProgramRef: null,
      pollIntervalMs: 1000,
      batchSize: 100,
    },
  ],
  eventTypes: ['review', 'implementation', 'clarification', 'verification'].map((kind) => ({
    eventTypeId: `graph-development.${kind}-requested`,
    version: 1,
    subjectTypeId: 'graph-development.case',
    payloadSchemaId: `graph-development.${kind}-request.v1`,
    displayName: text(`${kind} 请求`, `${kind} request`),
    description: text('已持久化的明确工作请求', 'A persisted explicit work request'),
    deliveryClass: 'durable',
    sourceRef: GRAPH_EVENT_SOURCE,
    catalogVisibility: 'internal',
  })),
  attentionRules: [
    {
      ruleId: 'graph-development.user-requests',
      contextTypeId: GRAPH_CONTEXT_TYPE,
      whenState: 'any',
      subscriptions: ['review', 'implementation', 'clarification', 'verification'].map((kind) => ({
        eventTypeId: `graph-development.${kind}-requested`,
        subjectPath: 'caseId',
        sourceProfileRef: null,
        deliveryClass: 'durable',
      })),
    },
  ],
  reactionRules: [
    ['review', 'review-design'],
    ['implementation', 'implement-change'],
    ['clarification', 'design-and-clarify'],
    ['verification', 'verify-change'],
  ].map(([kind, workItemRef], index) => ({
    ruleId: `graph-development.${kind}`,
    eventTypeId: `graph-development.${kind}-requested`,
    priority: 100 - index,
    preemptsContinuation: true,
    resumesBlocked: true,
    requiredContextTypes: [GRAPH_CONTEXT_TYPE],
    workItemRef,
    slotRef: workItemRef === 'verify-change' ? 'system' : 'default',
    allowedEffectKinds: [],
  })),
  invocationContracts: [],
}

export const graphEmployeeTypePackage: EmployeeTypePackageRegistration = {
  descriptorJson: JSON.stringify(graphEmployeeDescriptor),
  parseWorkScopeJson: (json) => JSON.stringify(GraphEmployeeScopeSchema.parse(JSON.parse(json))),
  summarizeWorkScopeJson(json, locale) {
    const scope = GraphEmployeeScopeSchema.parse(JSON.parse(json))
    return scope.kind === 'repository'
      ? `${locale === 'zh-CN' ? '仓库' : 'Repository'}: ${scope.repositoryId}`
      : locale === 'zh-CN'
        ? '按工作指定目标仓库'
        : 'Repository selected per request'
  },
  validateContractFixtureJson(json) {
    const request = z
      .object({
        contract: z.object({ contractId: z.string(), version: z.number() }).passthrough(),
        implementation: z.object({ kind: z.enum(['agent', 'workflow', 'program']) }).passthrough(),
      })
      .parse(JSON.parse(json))
    const contract = GRAPH_WORK_CONTRACTS.find(
      (value) =>
        value.contractId === request.contract.contractId &&
        value.version === request.contract.version,
    )
    return JSON.stringify([
      {
        code: 'graph-contract-kind',
        ok: contract?.allowedToolKinds.includes(request.implementation.kind) ?? false,
        detail: `${request.contract.contractId}@${request.contract.version}/${request.implementation.kind}`,
      },
    ])
  },
}
