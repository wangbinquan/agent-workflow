import type { EmployeeTypePackageRegistration } from '@/modules/digital-employee/public/types'

const text = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })

/**
 * Two deliberately non-development packages use the same OS authoring contract.
 * They are fixtures, not hidden product types: their job is to make a future
 * type-specific branch in the common runtime/UI fail a test immediately.
 */
export function minimalEmployeeTypePackage(input: {
  readonly typeId: 'design' | 'test'
  readonly zhName: string
  readonly enName: string
}): EmployeeTypePackageRegistration {
  const workItemRef = `${input.typeId}-work`
  const contextTypeId = `${input.typeId}.work`
  const sourceId = `${input.typeId}.work-ingress`
  const eventTypeId = `${input.typeId}.work-received`
  const contractId = `${input.typeId}.perform-work`
  const descriptor = {
    schemaVersion: 1,
    typeRef: { typeId: input.typeId, revision: 1 },
    displayName: text(input.zhName, input.enName),
    description: text(`可编程的${input.zhName}`, `Programmable ${input.enName}`),
    workScopeContractId: `${input.typeId}.scope.v1`,
    workScopeAuthoring: {
      schemaVersion: 1,
      label: text('适用范围', 'Work scope'),
      description: text('固定为全局夹具范围', 'Fixed global fixture scope'),
      variants: [
        {
          kind: 'global',
          label: text('全局', 'Global'),
          description: text('所有工作', 'All work'),
          fields: [],
        },
      ],
    },
    workIntakeAuthoring: {
      schemaVersion: 1,
      label: text('交给员工', 'Give work'),
      description: text('提交一段正文', 'Submit a body'),
      targetFields: [],
      acceptedKinds: ['body'],
      body: {
        label: text('工作内容', 'Work body'),
        description: text('需要完成的工作', 'Work to complete'),
        placeholder: text('描述工作', 'Describe the work'),
        maxBytes: 1_048_576,
      },
      files: {
        label: text('文件', 'Files'),
        description: text('此夹具不接收文件', 'Files are not accepted by this fixture'),
        maxFiles: 1,
        maxFileBytes: 1_048_576,
        targetPathRequired: true,
      },
      externalId: {
        label: text('外部编号', 'External ID'),
        description: text('此夹具不接收外部编号', 'External IDs are not accepted'),
        placeholder: text('不可用', 'Unavailable'),
      },
    },
    authoringManifest: {
      schemaVersion: 1,
      lifecycleRegions: [
        {
          regionId: 'work',
          label: text('履行职责', 'Perform duty'),
          description: text('固定生命周期背景', 'Fixed lifecycle background'),
          order: 0,
        },
      ],
      workItems: [
        {
          workItemRef,
          regionId: 'work',
          order: 0,
          label: text('完成工作', 'Complete work'),
          description: text('使用已注册工具完成职责', 'Use a registered tool to perform the duty'),
          workContractRef: { contractId, version: 1 },
          materialSummary: text('正文和当前上下文', 'Body and current context'),
          completionStandard: text('返回严格结果 envelope', 'Return a strict result envelope'),
          nodeKind: 'business-tool',
          collaborationContractId: null,
          toolRoleGroups: [
            {
              roleRef: 'primary',
              label: text('主要执行者', 'Primary executor'),
              description: text('每次只选择一个工具', 'Exactly one tool is selected'),
              order: 0,
              bindingSlots: [
                {
                  slotRef: 'primary',
                  label: text('执行工具', 'Execution tool'),
                  description: text('选择已有 Agent', 'Select an existing Agent'),
                  required: true,
                  cardinality: 'exactly-one',
                },
              ],
            },
          ],
          nextWorkItemRefs: [],
        },
      ],
    },
    workContracts: [
      {
        contractId,
        version: 1,
        inputSchemaId: `${input.typeId}.input.v1`,
        outputSchemaId: `${input.typeId}.output.v1`,
        materialSummary: text('正文和当前上下文', 'Body and current context'),
        completionStandard: text('严格结果 envelope', 'Strict result envelope'),
        allowedToolKinds: ['agent'],
        allowedEffectKinds: [],
        requiredConnectionPurpose: null,
        workspacePolicy: {
          mode: 'none',
          businessChangeOnOk: 'forbidden',
          writablePrefixes: [],
          platformWritePrefixes: [],
        },
        semanticValidatorId: `${input.typeId}.validator.v1`,
        fixtureSuiteRef: { id: `${input.typeId}.fixtures`, revision: 1 },
      },
    ],
    contextTypes: [
      {
        typeId: contextTypeId,
        schemaVersion: 1,
        displayName: text('工作上下文', 'Work context'),
        description: text('类型包拥有的上下文', 'Context owned by this package'),
        projectionFields: [
          { path: 'status', label: text('状态', 'Status'), format: 'text' },
          { path: 'title', label: text('标题', 'Title'), format: 'text' },
        ],
      },
    ],
    eventSources: [
      {
        sourceId,
        version: 1,
        displayName: text('工作入口', 'Work ingress'),
        description: text('接收新工作', 'Receives new work'),
        observationMode: 'passive',
        observerProgramRef: null,
        pollIntervalMs: 60_000,
        batchSize: 100,
      },
    ],
    eventTypes: [
      {
        eventTypeId,
        version: 1,
        subjectTypeId: `${input.typeId}-request`,
        payloadSchemaId: `${input.typeId}.event.v1`,
        displayName: text('收到工作', 'Work received'),
        description: text('开始履行职责', 'Starts the duty'),
        deliveryClass: 'work',
        priority: 100,
        preemptsContinuation: false,
        sourceRef: { id: sourceId, revision: 1 },
      },
    ],
    attentionRules: [],
    reactionRules: [
      {
        ruleId: `${input.typeId}-perform-work`,
        eventTypeId,
        requiredContextTypes: [contextTypeId],
        workItemRef,
        slotRef: 'primary',
        allowedEffectKinds: [],
      },
    ],
    invocationContracts: [],
  }

  return {
    descriptorJson: JSON.stringify(descriptor),
    parseWorkScopeJson(inputJson) {
      const scope = JSON.parse(inputJson) as { kind?: unknown }
      if (scope.kind !== 'global') throw new Error(`${input.typeId} fixture scope must be global`)
      return JSON.stringify({ kind: 'global' })
    },
    summarizeWorkScopeJson(_scopeJson, locale) {
      return locale === 'zh-CN' ? '全部工作' : 'All work'
    },
    validateContractFixtureJson() {
      return JSON.stringify([
        { code: `${input.typeId}-fixture`, ok: true, detail: 'strict envelope fixture' },
      ])
    },
  }
}

export const designEmployeeTypePackage = minimalEmployeeTypePackage({
  typeId: 'design',
  zhName: '设计数字员工',
  enName: 'Design Digital Employee',
})

export const testEmployeeTypePackage = minimalEmployeeTypePackage({
  typeId: 'test',
  zhName: '测试数字员工',
  enName: 'Test Digital Employee',
})
