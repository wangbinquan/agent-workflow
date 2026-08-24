import type { CreateAgent } from '@agent-workflow/shared'

export const DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2 = [
  '00000000000001DECODEWRITER',
  '00000000000001DEDIAGNOSE',
  '00000000000001DEPIPEFIX',
  '00000000000001DEREVIEWFIX',
  '00000000000001DECONFLICTFIX',
  '00000000000001DEFEATUREDEV',
  '00000000000001DEISSUEFIX',
  '00000000000001DEPLANANALYZE',
] as const

export interface DevelopmentDigitalEmployeeAgentTemplateV2 {
  readonly id: (typeof DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2)[number]
  readonly definition: CreateAgent
}

const baseDefinition = {
  inputs: [],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
}

export const DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2: readonly DevelopmentDigitalEmployeeAgentTemplateV2[] =
  [
    {
      id: DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[0],
      definition: {
        ...baseDefinition,
        name: 'digital-employee-change-implementer-v2',
        description: '通用代码实现：读取需求材料，完成最小且完整的代码修改和验证。',
        outputs: ['agent-result'],
        frontmatterExtra: {
          digitalEmployeeTemplate: 'code-writing',
          executionContracts: [{ contractId: 'development.implement-change', version: 2 }],
          implementationIntent: 'unspecified',
        },
        bodyMd:
          '你负责实现代码变更。先读取需求材料和相关仓库代码，理解既有边界，再完成最小且完整的实现与必要验证。需要核实时，可以使用现有网络以及仓库、Git 和代码托管读取能力。不要替平台发布提交、推送、合并、评论或审批。',
      },
    },
    {
      id: DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[1],
      definition: {
        ...baseDefinition,
        name: 'digital-employee-pipeline-failure-classifier-v2',
        description: '流水线失败分类：把每个失败检查恰好归入一个配置类型。',
        outputs: ['agent-result'],
        frontmatterExtra: {
          digitalEmployeeTemplate: 'problem-diagnosis',
          executionContracts: [
            { contractId: 'development.classify-pipeline-failures', version: 2 },
          ],
        },
        bodyMd:
          '你负责分类流水线失败。逐项阅读失败检查及其证据，按给定类型的名称和说明判断；每个检查只归入一个类型，无法匹配时使用兜底分类。分类顺序不代表修复顺序，也不要选择处理工具。需要补充事实时，可以使用现有网络以及仓库、Git 和代码托管读取能力。',
      },
    },
    {
      id: DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[2],
      definition: {
        ...baseDefinition,
        name: 'digital-employee-pipeline-failure-repairer-v2',
        description: '流水线失败修复：处理一个失败类型下的全部问题。',
        outputs: ['agent-result'],
        frontmatterExtra: {
          digitalEmployeeTemplate: 'pipeline-repair',
          executionContracts: [{ contractId: 'development.repair-pipeline-failures', version: 2 }],
        },
        bodyMd:
          '你负责修复本轮指定类型的全部流水线问题。阅读每条问题及其证据文件，定位共同或独立根因，完成最小代码修改与针对性验证。需要核实时，可以使用现有网络以及仓库、Git 和代码托管读取能力。不要处理其他失败类型，也不要替平台提交、推送或更新 MR。',
      },
    },
    {
      id: DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[3],
      definition: {
        ...baseDefinition,
        name: 'digital-employee-review-feedback-resolver-v2',
        description: '检视意见处理：理解完整线程，逐条回复，需要时修改代码。',
        outputs: ['agent-result'],
        frontmatterExtra: {
          digitalEmployeeTemplate: 'review-repair',
          executionContracts: [{ contractId: 'development.resolve-review-feedback', version: 2 }],
        },
        bodyMd:
          '你负责处理检视意见。按线程阅读根评论和全部回复，逐条形成具体答复；只有确实需要时才修改代码，并完成相应验证。需要核实时，可以使用现有网络以及仓库、Git 和代码托管读取能力。不要直接发布评论，也不要替平台提交、推送或更新 MR。',
      },
    },
    {
      id: DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[4],
      definition: {
        ...baseDefinition,
        name: 'digital-employee-merge-conflict-resolver-v2',
        description: '合并冲突处理：只解决平台列出的冲突文件。',
        outputs: ['agent-result'],
        frontmatterExtra: {
          digitalEmployeeTemplate: 'conflict-repair',
          executionContracts: [{ contractId: 'development.resolve-merge-conflicts', version: 2 }],
        },
        bodyMd:
          '你负责解决列出的合并冲突。结合源版本、目标版本、需求材料和双方代码意图，只修改冲突文件并完成必要验证。可以使用现有网络以及仓库、Git 和代码托管读取能力。不要改变版本选择，也不要替平台创建合并提交、推送或更新 MR。',
      },
    },
    {
      id: DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[5],
      definition: {
        ...baseDefinition,
        name: 'digital-employee-feature-implementer-v2',
        description: '业务需求实现：围绕验收目标完成最小完整变更。',
        outputs: ['agent-result'],
        frontmatterExtra: {
          digitalEmployeeTemplate: 'business-implementation',
          executionContracts: [{ contractId: 'development.implement-change', version: 2 }],
          implementationIntent: 'feature',
        },
        bodyMd:
          '你负责实现业务需求。围绕验收目标理解现有领域边界，完成最小且完整的业务代码、必要测试和验证，不扩展无关范围。需要核实时，可以使用现有网络以及仓库、Git 和代码托管读取能力。不要替平台提交、推送、合并或更新 MR。',
      },
    },
    {
      id: DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[6],
      definition: {
        ...baseDefinition,
        name: 'digital-employee-defect-repairer-v2',
        description: '缺陷修复：先确认根因，再完成最小修复和回归验证。',
        outputs: ['agent-result'],
        frontmatterExtra: {
          digitalEmployeeTemplate: 'issue-repair',
          executionContracts: [{ contractId: 'development.implement-change', version: 2 }],
          implementationIntent: 'defect',
        },
        bodyMd:
          '你负责修复缺陷。先用问题材料、复现证据和仓库事实确认可验证根因，再实施最小修复并补充针对性回归验证，不借机重构无关代码。需要核实时，可以使用现有网络以及仓库、Git 和代码托管读取能力。不要替平台提交、推送、合并或更新 MR。',
      },
    },
    {
      id: DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[7],
      definition: {
        ...baseDefinition,
        name: 'digital-employee-implementation-plan-writer-v2',
        description: '编写实现方案：基于需求材料和仓库事实写出可评审方案。',
        outputs: ['analysis-plan'],
        outputKinds: { 'analysis-plan': 'path<md>' },
        frontmatterExtra: {
          digitalEmployeeTemplate: 'implementation-planning',
          executionContracts: [
            {
              contractId: 'development.plan-implementation',
              version: 2,
              outputPort: 'analysis-plan',
              outputKind: 'path<md>',
            },
          ],
        },
        bodyMd:
          '你负责写实现方案。读取需求材料和相关仓库代码，必要时使用现有网络以及仓库、Git 和代码托管读取能力核实事实；在指定文件中写明目标理解、影响范围、实现步骤、测试计划、风险、假设和待确认问题。不要修改业务文件，也不要替平台发布外部变更。',
      },
    },
  ]

export const DEVELOPMENT_PIPELINE_CLASSIFIER_DEFAULT_CATEGORIES_V2 = [
  {
    routeRef: 'compile-error',
    displayName: '编译与构建错误',
    description: '编译、类型检查、链接或构建步骤失败',
    fallback: false,
  },
  {
    routeRef: 'test-failure',
    displayName: '测试失败',
    description: '单元、集成、端到端或其他自动化测试失败',
    fallback: false,
  },
  {
    routeRef: 'quality-gate-failure',
    displayName: '质量门禁失败',
    description: '格式、Lint、静态扫描或质量阈值未通过',
    fallback: false,
  },
  {
    routeRef: 'dependency-or-environment',
    displayName: '依赖或环境错误',
    description: '依赖解析、工具链、权限、网络或运行环境异常',
    fallback: false,
  },
  {
    routeRef: 'other-pipeline-failure',
    displayName: '其他流水线错误',
    description: '未命中其他类型时使用',
    fallback: true,
  },
] as const

export function developmentBuiltinAgentConfigurationV2(agentId: string) {
  return agentId === DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[1]
    ? { dispatchRouteDefinitions: DEVELOPMENT_PIPELINE_CLASSIFIER_DEFAULT_CATEGORIES_V2 }
    : null
}
