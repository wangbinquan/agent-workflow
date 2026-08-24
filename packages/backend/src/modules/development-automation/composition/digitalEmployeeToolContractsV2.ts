import type {
  ExecutionContractField,
  ExecutionContractRegistration,
} from '@/modules/execution-contract/public/types'
import {
  EXECUTION_CONTRACT_RESULT_PORT,
  EXECUTION_CONTRACT_SCRIPT_INPUT_ENV,
  EXECUTION_CONTRACT_SCRIPT_INPUT_FILE_ENV,
} from '@/modules/execution-contract/public/types'
import { projectDevelopmentToolInputV2 } from '../application/digitalEmployeeToolContractProjectionV2'
import {
  validateDevelopmentToolOutputV2,
  type DevelopmentToolContractIdV2,
  type DevelopmentToolJsonOutputContractIdV2,
} from '../domain/digitalEmployeeToolContractsV2'

interface LocalizedText {
  readonly 'zh-CN': string
  readonly 'en-US': string
}

interface DevelopmentWorkContractV2 {
  readonly contractId: DevelopmentToolContractIdV2
  readonly version: 2
  readonly inputSchemaId: string
  readonly outputSchemaId: string
  readonly materialSummary: LocalizedText
  readonly completionStandard: LocalizedText
  readonly allowedToolKinds: readonly ('agent' | 'workflow' | 'program')[]
  readonly allowedEffectKinds: readonly string[]
  readonly requiredConnectionPurpose: string | null
  readonly workspacePolicy: {
    readonly mode: 'write' | 'read-only' | 'none'
    readonly businessChangeOnOk: 'required' | 'forbidden' | 'optional'
    readonly writablePrefixes: readonly string[]
    readonly platformWritePrefixes: readonly ('inputs/requirements' | 'pipeline')[]
  }
  readonly semanticValidatorId: string
  readonly fixtureSuiteRef: { readonly id: string; readonly revision: number }
}

const text = (zh: string, en: string): LocalizedText => ({ 'zh-CN': zh, 'en-US': en })
const fixtureSuiteRef = { id: 'builtin:development-work-contract-fixtures', revision: 1 } as const
const WRITE_MATERIALS = {
  mode: 'write',
  businessChangeOnOk: 'optional',
  writablePrefixes: [],
  platformWritePrefixes: ['inputs/requirements'],
} as const
const WRITE_PLAN = {
  mode: 'write',
  businessChangeOnOk: 'forbidden',
  writablePrefixes: [],
  platformWritePrefixes: ['inputs/requirements'],
} as const
const WRITE_IMPLEMENTATION = {
  mode: 'write',
  businessChangeOnOk: 'required',
  writablePrefixes: [],
  platformWritePrefixes: ['inputs/requirements'],
} as const
const WRITE_REQUIRED = {
  mode: 'write',
  businessChangeOnOk: 'required',
  writablePrefixes: [],
  platformWritePrefixes: [],
} as const
const WRITE_OPTIONAL = {
  mode: 'write',
  businessChangeOnOk: 'optional',
  writablePrefixes: [],
  platformWritePrefixes: [],
} as const
const READ_PIPELINE = {
  mode: 'read-only',
  businessChangeOnOk: 'forbidden',
  writablePrefixes: [],
  platformWritePrefixes: ['pipeline'],
} as const
const READ_ONLY = {
  mode: 'read-only',
  businessChangeOnOk: 'forbidden',
  writablePrefixes: [],
  platformWritePrefixes: [],
} as const

function workContract(
  input: Omit<DevelopmentWorkContractV2, 'version' | 'semanticValidatorId' | 'fixtureSuiteRef'>,
): DevelopmentWorkContractV2 {
  return {
    ...input,
    version: 2,
    semanticValidatorId: `${input.contractId}.v2.validator`,
    fixtureSuiteRef,
  }
}

export const developmentWorkContractsV2: readonly DevelopmentWorkContractV2[] = [
  workContract({
    contractId: 'development.prepare-materials',
    inputSchemaId: 'development.prepare-materials.input.v2',
    outputSchemaId: 'development.prepare-materials.result.v2',
    materialSummary: text(
      '系统连接、外部事项编号、材料输出目录',
      'Connection, external item ID, and material output directory',
    ),
    completionStandard: text(
      '外部事项的材料文件已写入指定目录',
      'External item files are written to the specified directory',
    ),
    allowedToolKinds: ['agent', 'workflow', 'program'],
    allowedEffectKinds: [],
    requiredConnectionPurpose: 'requirement-source',
    workspacePolicy: WRITE_MATERIALS,
  }),
  workContract({
    contractId: 'development.plan-implementation',
    inputSchemaId: 'development.plan-implementation.input.v2',
    outputSchemaId: 'development.plan-implementation.path.v2',
    materialSummary: text(
      '需求材料目录、方案文件路径',
      'Requirements directory and plan file path',
    ),
    completionStandard: text(
      '指定 Markdown 方案已写好，并返回同一路径',
      'The designated Markdown plan is written and the same path is returned',
    ),
    allowedToolKinds: ['agent'],
    allowedEffectKinds: [],
    requiredConnectionPurpose: null,
    workspacePolicy: WRITE_PLAN,
  }),
  workContract({
    contractId: 'development.implement-change',
    inputSchemaId: 'development.implement-change.input.v2',
    outputSchemaId: 'development.implement-change.result.v2',
    materialSummary: text(
      '需求材料目录、已批准方案（如有）',
      'Requirements directory and approved plan when present',
    ),
    completionStandard: text(
      '代码修改完成，并给出提交与 MR 文案',
      'The code change is complete with commit and merge-request text',
    ),
    allowedToolKinds: ['agent', 'workflow'],
    allowedEffectKinds: [],
    requiredConnectionPurpose: null,
    workspacePolicy: WRITE_IMPLEMENTATION,
  }),
  workContract({
    contractId: 'development.resolve-review-feedback',
    inputSchemaId: 'development.resolve-review-feedback.input.v2',
    outputSchemaId: 'development.resolve-review-feedback.result.v2',
    materialSummary: text(
      '需求材料目录、完整检视线程',
      'Requirements directory and complete review threads',
    ),
    completionStandard: text(
      '每个线程都有回复；只有修改代码时才给出提交信息',
      'Every thread has a reply; a commit message is returned only when code changed',
    ),
    allowedToolKinds: ['agent', 'workflow', 'program'],
    allowedEffectKinds: [],
    requiredConnectionPurpose: null,
    workspacePolicy: WRITE_OPTIONAL,
  }),
  workContract({
    contractId: 'development.collect-pipeline-status',
    inputSchemaId: 'development.collect-pipeline-status.input.v2',
    outputSchemaId: 'development.collect-pipeline-status.result.v2',
    materialSummary: text(
      '系统连接、MR、证据目录',
      'Connection, merge request, and evidence directory',
    ),
    completionStandard: text(
      '返回所观察版本的完整流水线与检查状态',
      'Returns complete pipeline and check status for the observed version',
    ),
    allowedToolKinds: ['workflow', 'program'],
    allowedEffectKinds: [],
    requiredConnectionPurpose: 'pipeline-gate',
    workspacePolicy: READ_PIPELINE,
  }),
  workContract({
    contractId: 'development.classify-pipeline-failures',
    inputSchemaId: 'development.classify-pipeline-failures.input.v2',
    outputSchemaId: 'development.classify-pipeline-failures.result.v2',
    materialSummary: text(
      '失败检查、问题类型、兜底分类',
      'Failed checks, categories, and fallback type',
    ),
    completionStandard: text(
      '每个失败检查恰好归入一个问题类型',
      'Every failed check belongs to exactly one category',
    ),
    allowedToolKinds: ['agent', 'workflow', 'program'],
    allowedEffectKinds: [],
    requiredConnectionPurpose: null,
    workspacePolicy: READ_ONLY,
  }),
  workContract({
    contractId: 'development.repair-pipeline-failures',
    inputSchemaId: 'development.repair-pipeline-failures.input.v2',
    outputSchemaId: 'development.repair-pipeline-failures.result.v2',
    materialSummary: text('一个失败类型及其全部问题', 'One failure type and all of its problems'),
    completionStandard: text(
      '该类型问题已修复，并给出提交信息',
      'The assigned failures are repaired with a commit message',
    ),
    allowedToolKinds: ['agent', 'workflow', 'program'],
    allowedEffectKinds: [],
    requiredConnectionPurpose: null,
    workspacePolicy: WRITE_REQUIRED,
  }),
  workContract({
    contractId: 'development.resolve-merge-conflicts',
    inputSchemaId: 'development.resolve-merge-conflicts.input.v2',
    outputSchemaId: 'development.resolve-merge-conflicts.result.v2',
    materialSummary: text(
      '源版本、目标版本、冲突文件、需求目录',
      'Source version, target version, conflict files, and requirements directory',
    ),
    completionStandard: text(
      '列出的冲突已解决，并给出提交信息',
      'The listed conflicts are resolved with a commit message',
    ),
    allowedToolKinds: ['agent', 'workflow', 'program'],
    allowedEffectKinds: [],
    requiredConnectionPurpose: null,
    workspacePolicy: WRITE_REQUIRED,
  }),
  workContract({
    contractId: 'development.draft-approval',
    inputSchemaId: 'development.draft-approval.input.v2',
    outputSchemaId: 'development.draft-approval.result.v2',
    materialSummary: text(
      'MR、当前版本、审批类型、门禁结论、格式说明',
      'Merge request, current version, approval type, gate conclusions, and format guide',
    ),
    completionStandard: text('形成可提交的审批草稿', 'Produces a submission-ready approval draft'),
    allowedToolKinds: ['agent', 'workflow', 'program'],
    allowedEffectKinds: [],
    requiredConnectionPurpose: 'approval-gateway',
    workspacePolicy: READ_ONLY,
  }),
]

const conditionCompleted = text('outcome=completed 时必填', 'Required when outcome=completed')
const conditionBlocked = text('outcome=blocked 时必填', 'Required when outcome=blocked')
const conditionCodeChanged = text('实际修改代码时返回', 'Returned when code changed')
const conditionTargetObserved = text(
  '提供方确认目标版本时返回',
  'Returned when the provider confirms the target version',
)

function field(input: {
  readonly path: string
  readonly zh: string
  readonly en: string
  readonly descriptionZh: string
  readonly descriptionEn: string
  readonly valueType: ExecutionContractField['valueType']
  readonly required?: boolean
  readonly source?: ExecutionContractField['source']
  readonly condition?: LocalizedText | null
  readonly example?: string | null
}): ExecutionContractField {
  return {
    path: input.path,
    label: text(input.zh, input.en),
    description: text(input.descriptionZh, input.descriptionEn),
    valueType: input.valueType,
    required: input.required ?? true,
    source: input.source ?? 'work-input',
    condition: input.condition ?? null,
    example: input.example ?? null,
  }
}

interface GuideDetails {
  readonly inputFields: readonly ExecutionContractField[]
  readonly inputExample: Readonly<Record<string, unknown>>
  readonly outputFields: readonly ExecutionContractField[]
  readonly outputExample: Readonly<Record<string, unknown>>
  readonly outputMode?: 'direct-json' | 'artifact-path'
  readonly outputPort?: string
  readonly outputKind?: string
}

const presentation: Record<
  DevelopmentToolContractIdV2,
  { readonly name: LocalizedText; readonly action: LocalizedText }
> = {
  'development.prepare-materials': {
    name: text('准备外部材料', 'Prepare external materials'),
    action: text(
      '按外部事项编号把材料文件写入指定目录',
      'Write external item materials to the designated directory',
    ),
  },
  'development.plan-implementation': {
    name: text('编写实现方案', 'Write implementation plan'),
    action: text(
      '根据需求材料和仓库事实编写实现方案',
      'Write an implementation plan from requirement materials and repository facts',
    ),
  },
  'development.implement-change': {
    name: text('实现变更', 'Implement change'),
    action: text(
      '读取需求材料并完成代码修改',
      'Read the requirement materials and complete the code change',
    ),
  },
  'development.resolve-review-feedback': {
    name: text('处理检视意见', 'Resolve review feedback'),
    action: text(
      '逐线程处理意见，需要时修改代码',
      'Resolve every thread and change code when needed',
    ),
  },
  'development.collect-pipeline-status': {
    name: text('采集流水线状态', 'Collect pipeline status'),
    action: text(
      '取得完整检查状态并保存必要证据',
      'Collect complete check status and save necessary evidence',
    ),
  },
  'development.classify-pipeline-failures': {
    name: text('分类流水线失败', 'Classify pipeline failures'),
    action: text(
      '把每个失败检查归入一个已配置类型',
      'Assign every failed check to one configured category',
    ),
  },
  'development.repair-pipeline-failures': {
    name: text('修复流水线失败', 'Repair pipeline failures'),
    action: text(
      '修复一个已分配类型下的全部问题',
      'Repair every problem in one assigned failure type',
    ),
  },
  'development.resolve-merge-conflicts': {
    name: text('解决合并冲突', 'Resolve merge conflicts'),
    action: text('解决平台列出的冲突文件', 'Resolve the conflict files listed by the platform'),
  },
  'development.draft-approval': {
    name: text('编写审批草稿', 'Draft approval'),
    action: text(
      '根据当前 MR 和门禁结论形成审批草稿',
      'Draft an approval from the current merge request and gate conclusions',
    ),
  },
}

const outcomeField = field({
  path: 'outcome',
  zh: '结果',
  en: 'Outcome',
  descriptionZh: '完成时为 completed；无法完成时为 blocked',
  descriptionEn: 'completed when done; blocked when the action cannot be completed',
  valueType: 'enum',
})
const explanationField = field({
  path: 'explanation',
  zh: '阻塞原因',
  en: 'Blocking explanation',
  descriptionZh: '具体说明为什么不能完成',
  descriptionEn: 'Concrete reason the action cannot be completed',
  valueType: 'string',
  required: false,
  condition: conditionBlocked,
})

const details: Record<DevelopmentToolContractIdV2, GuideDetails> = {
  'development.prepare-materials': {
    inputFields: [
      field({
        path: 'connection',
        zh: '连接',
        en: 'Connection',
        descriptionZh: '用于读取外部事项的已发布连接版本',
        descriptionEn: 'Published connection revision used to read the external item',
        valueType: 'object',
        source: 'platform',
      }),
      field({
        path: 'externalItemId',
        zh: '外部事项编号',
        en: 'External item ID',
        descriptionZh: '要取得材料的需求或问题编号',
        descriptionEn: 'Requirement or issue ID whose materials must be acquired',
        valueType: 'string',
      }),
      field({
        path: 'outputDirectory',
        zh: '输出目录',
        en: 'Output directory',
        descriptionZh: '所有材料文件写入这个目录',
        descriptionEn: 'Directory where every material file is written',
        valueType: 'string',
        source: 'platform',
      }),
    ],
    inputExample: {
      connection: { id: 'requirement-source', revision: 1 },
      externalItemId: 'ISSUE-1234',
      outputDirectory: '.agent-workflow/inputs/requirements/case/external',
    },
    outputFields: [outcomeField, explanationField],
    outputExample: { outcome: 'completed' },
  },
  'development.plan-implementation': {
    inputFields: [
      field({
        path: 'requirementsDirectory',
        zh: '需求材料目录',
        en: 'Requirements directory',
        descriptionZh: '读取需求正文、附件和外部材料',
        descriptionEn: 'Read the request body, attachments, and external materials here',
        valueType: 'string',
        source: 'platform',
      }),
      field({
        path: 'outputFile',
        zh: '方案文件',
        en: 'Plan file',
        descriptionZh: '方案必须写入的 Markdown 文件',
        descriptionEn: 'Markdown file where the plan must be written',
        valueType: 'string',
        source: 'platform',
      }),
    ],
    inputExample: {
      requirementsDirectory: '.agent-workflow/inputs/requirements/case',
      outputFile: '.agent-workflow/inputs/requirements/case/review/implementation-plan.md',
    },
    outputFields: [
      field({
        path: 'artifactPath',
        zh: '方案文件路径',
        en: 'Plan file path',
        descriptionZh: '与输入 outputFile 完全相同',
        descriptionEn: 'Exactly the same value as input outputFile',
        valueType: 'string',
        source: 'artifact',
      }),
    ],
    outputExample: {
      artifactPath: '.agent-workflow/inputs/requirements/case/review/implementation-plan.md',
    },
    outputMode: 'artifact-path',
    outputPort: 'analysis-plan',
    outputKind: 'path<md>',
  },
  'development.implement-change': {
    inputFields: [
      field({
        path: 'requirementsDirectory',
        zh: '需求材料目录',
        en: 'Requirements directory',
        descriptionZh: '本次实现的完整需求材料',
        descriptionEn: 'Complete requirement materials for this implementation',
        valueType: 'string',
        source: 'platform',
      }),
      field({
        path: 'approvedPlanFile',
        zh: '已批准方案',
        en: 'Approved plan',
        descriptionZh: '启用方案评审时必须遵循的方案文件',
        descriptionEn: 'Plan file to follow when plan review was enabled',
        valueType: 'string',
        source: 'platform',
        required: false,
      }),
    ],
    inputExample: { requirementsDirectory: '.agent-workflow/inputs/requirements/case' },
    outputFields: [
      outcomeField,
      field({
        path: 'commitMessage',
        zh: '提交信息',
        en: 'Commit message',
        descriptionZh: '代码修改对应的提交信息',
        descriptionEn: 'Commit message for the code change',
        valueType: 'string',
        required: false,
        condition: conditionCompleted,
      }),
      field({
        path: 'mergeRequestTitle',
        zh: 'MR 标题',
        en: 'Merge request title',
        descriptionZh: '面向评审者的 MR 标题',
        descriptionEn: 'Reviewer-facing merge request title',
        valueType: 'string',
        required: false,
        condition: conditionCompleted,
      }),
      field({
        path: 'mergeRequestDescription',
        zh: 'MR 说明',
        en: 'Merge request description',
        descriptionZh: '面向评审者的 MR 说明',
        descriptionEn: 'Reviewer-facing merge request description',
        valueType: 'string',
        required: false,
        condition: conditionCompleted,
      }),
      explanationField,
    ],
    outputExample: {
      outcome: 'completed',
      commitMessage: 'implement accepted change',
      mergeRequestTitle: 'Implement accepted change',
      mergeRequestDescription: 'Implemented the requested behavior and tests.',
    },
  },
  'development.resolve-review-feedback': {
    inputFields: [
      field({
        path: 'requirementsDirectory',
        zh: '需求材料目录',
        en: 'Requirements directory',
        descriptionZh: '回看原始需求时使用',
        descriptionEn: 'Used when the original requirements must be revisited',
        valueType: 'string',
        source: 'platform',
      }),
      field({
        path: 'threads',
        zh: '检视线程',
        en: 'Review threads',
        descriptionZh: '每项含根评论和按时间排列的全部回复',
        descriptionEn: 'Each item contains the root comment and every chronological reply',
        valueType: 'array',
        source: 'context',
      }),
    ],
    inputExample: {
      requirementsDirectory: '.agent-workflow/inputs/requirements/case',
      threads: [
        {
          threadRef: 'thread-1',
          file: 'src/example.ts',
          messages: [{ author: 'human', body: '请补充空值处理。' }],
        },
      ],
    },
    outputFields: [
      outcomeField,
      field({
        path: 'replies',
        zh: '逐线程回复',
        en: 'Thread replies',
        descriptionZh: '每个输入线程恰好一条回复',
        descriptionEn: 'Exactly one reply for every input thread',
        valueType: 'array',
        required: false,
        condition: conditionCompleted,
      }),
      field({
        path: 'commitMessage',
        zh: '提交信息',
        en: 'Commit message',
        descriptionZh: '代码修改对应的提交信息',
        descriptionEn: 'Commit message for the code change',
        valueType: 'string',
        required: false,
        condition: conditionCodeChanged,
      }),
      explanationField,
    ],
    outputExample: {
      outcome: 'completed',
      replies: [{ threadRef: 'thread-1', reply: '已补充空值处理和回归测试。' }],
      commitMessage: 'address review feedback',
    },
  },
  'development.collect-pipeline-status': {
    inputFields: [
      field({
        path: 'connection',
        zh: '连接',
        en: 'Connection',
        descriptionZh: '用于读取流水线的已发布连接版本',
        descriptionEn: 'Published connection revision used to read the pipeline',
        valueType: 'object',
        source: 'platform',
      }),
      field({
        path: 'mergeRequest',
        zh: 'MR',
        en: 'Merge request',
        descriptionZh: '要采集流水线的 MR 标识',
        descriptionEn: 'Merge request whose pipeline is collected',
        valueType: 'string',
        source: 'context',
      }),
      field({
        path: 'evidenceDirectory',
        zh: '证据目录',
        en: 'Evidence directory',
        descriptionZh: '大日志和证据文件写入这里',
        descriptionEn: 'Directory for large logs and evidence files',
        valueType: 'string',
        source: 'platform',
      }),
    ],
    inputExample: {
      connection: { id: 'pipeline-gate', revision: 1 },
      mergeRequest: 'project!123',
      evidenceDirectory: '.agent-workflow/pipeline/case',
    },
    outputFields: [
      outcomeField,
      field({
        path: 'observedSourceVersion',
        zh: '已观察源版本',
        en: 'Observed source version',
        descriptionZh: '这份流水线状态所属的源版本',
        descriptionEn: 'Source version to which the pipeline result belongs',
        valueType: 'string',
        required: false,
        condition: conditionCompleted,
      }),
      field({
        path: 'observedTargetVersion',
        zh: '已观察目标版本',
        en: 'Observed target version',
        descriptionZh: '这份流水线状态所属的目标版本',
        descriptionEn: 'Target version for the observed pipeline status',
        valueType: 'string',
        required: false,
        condition: conditionTargetObserved,
      }),
      field({
        path: 'status',
        zh: '流水线状态',
        en: 'Pipeline status',
        descriptionZh: 'pending、passed 或 failed',
        descriptionEn: 'pending, passed, or failed',
        valueType: 'enum',
        required: false,
        condition: conditionCompleted,
      }),
      field({
        path: 'checks',
        zh: '检查项',
        en: 'Checks',
        descriptionZh: '完整检查列表及其证据文件',
        descriptionEn: 'Complete check list and evidence files',
        valueType: 'array',
        required: false,
        condition: conditionCompleted,
      }),
      explanationField,
    ],
    outputExample: {
      outcome: 'completed',
      observedSourceVersion: '0'.repeat(40),
      observedTargetVersion: '1'.repeat(40),
      status: 'failed',
      checks: [
        {
          checkRef: 'build',
          name: 'Build',
          status: 'failed',
          summary: 'Type check failed',
          evidenceFiles: ['.agent-workflow/pipeline/case/build.log'],
        },
      ],
    },
  },
  'development.classify-pipeline-failures': {
    inputFields: [
      field({
        path: 'failedChecks',
        zh: '失败检查',
        en: 'Failed checks',
        descriptionZh: '需要归类的全部失败检查',
        descriptionEn: 'Every failed check that must be classified',
        valueType: 'array',
        source: 'context',
      }),
      field({
        path: 'categories',
        zh: '问题类型',
        en: 'Categories',
        descriptionZh: '本工具可输出的类型标识、名称和说明',
        descriptionEn: 'Type keys, names, and descriptions this tool may emit',
        valueType: 'array',
        source: 'platform',
      }),
      field({
        path: 'fallbackType',
        zh: '兜底分类',
        en: 'Fallback type',
        descriptionZh: '无法匹配其他类型时使用',
        descriptionEn: 'Used when no other category matches',
        valueType: 'string',
        source: 'platform',
      }),
    ],
    inputExample: {
      failedChecks: [{ checkRef: 'build', name: 'Build', summary: 'Type check failed' }],
      categories: [
        { type: 'compile-error', name: '编译错误', description: '编译或类型检查失败' },
        { type: 'other', name: '其他', description: '未命中其他类型' },
      ],
      fallbackType: 'other',
    },
    outputFields: [
      outcomeField,
      field({
        path: 'groups',
        zh: '分类结果',
        en: 'Groups',
        descriptionZh: '每组只有类型和对应检查标识',
        descriptionEn: 'Each group contains only its type and check references',
        valueType: 'array',
        required: false,
        condition: conditionCompleted,
      }),
      explanationField,
    ],
    outputExample: {
      outcome: 'completed',
      groups: [{ type: 'compile-error', checkRefs: ['build'] }],
    },
  },
  'development.repair-pipeline-failures': {
    inputFields: [
      field({
        path: 'failureType',
        zh: '失败类型',
        en: 'Failure type',
        descriptionZh: '本轮唯一要处理的类型',
        descriptionEn: 'The one failure type assigned to this run',
        valueType: 'string',
        source: 'platform',
      }),
      field({
        path: 'problems',
        zh: '问题',
        en: 'Problems',
        descriptionZh: '该类型的全部问题和证据文件',
        descriptionEn: 'Every problem and evidence file for that type',
        valueType: 'array',
        source: 'context',
      }),
    ],
    inputExample: {
      failureType: 'compile-error',
      problems: [
        {
          summary: 'Type check failed',
          evidenceFiles: ['.agent-workflow/pipeline/case/build.log'],
        },
      ],
    },
    outputFields: [
      outcomeField,
      field({
        path: 'commitMessage',
        zh: '提交信息',
        en: 'Commit message',
        descriptionZh: '修复对应的提交信息',
        descriptionEn: 'Commit message for the repair',
        valueType: 'string',
        required: false,
        condition: conditionCompleted,
      }),
      explanationField,
    ],
    outputExample: { outcome: 'completed', commitMessage: 'fix compile errors' },
  },
  'development.resolve-merge-conflicts': {
    inputFields: [
      field({
        path: 'sourceVersion',
        zh: '源版本',
        en: 'Source version',
        descriptionZh: 'MR 当前源版本',
        descriptionEn: 'Current merge request source version',
        valueType: 'string',
        source: 'context',
      }),
      field({
        path: 'targetVersion',
        zh: '目标版本',
        en: 'Target version',
        descriptionZh: '要合入的目标版本',
        descriptionEn: 'Target version to merge',
        valueType: 'string',
        source: 'context',
      }),
      field({
        path: 'conflictFiles',
        zh: '冲突文件',
        en: 'Conflict files',
        descriptionZh: '平台已经确认的冲突文件列表',
        descriptionEn: 'Conflict files confirmed by the platform',
        valueType: 'array',
        source: 'platform',
      }),
      field({
        path: 'requirementsDirectory',
        zh: '需求材料目录',
        en: 'Requirements directory',
        descriptionZh: '用于理解原始变更意图',
        descriptionEn: 'Used to understand the original change intent',
        valueType: 'string',
        source: 'platform',
      }),
    ],
    inputExample: {
      sourceVersion: '0'.repeat(40),
      targetVersion: '1'.repeat(40),
      conflictFiles: ['src/example.ts'],
      requirementsDirectory: '.agent-workflow/inputs/requirements/case',
    },
    outputFields: [
      outcomeField,
      field({
        path: 'commitMessage',
        zh: '提交信息',
        en: 'Commit message',
        descriptionZh: '冲突修复对应的提交信息',
        descriptionEn: 'Commit message for the conflict resolution',
        valueType: 'string',
        required: false,
        condition: conditionCompleted,
      }),
      explanationField,
    ],
    outputExample: { outcome: 'completed', commitMessage: 'resolve merge conflicts' },
  },
  'development.draft-approval': {
    inputFields: [
      field({
        path: 'mergeRequest',
        zh: 'MR',
        en: 'Merge request',
        descriptionZh: '待审批的 MR 标识',
        descriptionEn: 'Merge request requiring approval',
        valueType: 'string',
        source: 'context',
      }),
      field({
        path: 'currentVersion',
        zh: '当前版本',
        en: 'Current version',
        descriptionZh: '草稿必须绑定的当前版本',
        descriptionEn: 'Current version to which the draft is bound',
        valueType: 'string',
        source: 'context',
      }),
      field({
        path: 'approvalType',
        zh: '审批类型',
        en: 'Approval type',
        descriptionZh: '本次审批的业务类型',
        descriptionEn: 'Business type of this approval',
        valueType: 'string',
        source: 'platform',
      }),
      field({
        path: 'gateConclusions',
        zh: '门禁结论',
        en: 'Gate conclusions',
        descriptionZh: '需要写入草稿的门禁结论',
        descriptionEn: 'Gate conclusions to include in the draft',
        valueType: 'array',
        source: 'context',
      }),
      field({
        path: 'formatGuide',
        zh: '格式说明',
        en: 'Format guide',
        descriptionZh: '直接说明草稿应如何组织',
        descriptionEn: 'Direct instructions for organizing the draft',
        valueType: 'string',
        source: 'platform',
      }),
    ],
    inputExample: {
      mergeRequest: 'project!123',
      currentVersion: '0'.repeat(40),
      approvalType: 'gate-change',
      gateConclusions: [{ name: 'pipeline', conclusion: 'passed' }],
      formatGuide: '使用 Markdown 简洁说明变更、门禁和风险。',
    },
    outputFields: [
      outcomeField,
      field({
        path: 'draft',
        zh: '审批草稿',
        en: 'Approval draft',
        descriptionZh: '可由平台提交的完整草稿正文',
        descriptionEn: 'Complete draft body ready for platform submission',
        valueType: 'string',
        required: false,
        condition: conditionCompleted,
      }),
      explanationField,
    ],
    outputExample: { outcome: 'completed', draft: '## 变更审批\n\n门禁已通过，请审批。' },
  },
}

function topLevelFields(fields: readonly ExecutionContractField[]): string[] {
  return [...new Set(fields.map((item) => item.path.split('.')[0]!))]
}

export const developmentExecutionContractRegistrationsV2: readonly ExecutionContractRegistration[] =
  developmentWorkContractsV2.map((contract) => {
    const contractDetails = details[contract.contractId]
    const outputMode = contractDetails.outputMode ?? 'direct-json'
    const transport = {
      inputInstruction: text(
        '平台只注入本动作需要的业务 JSON。',
        'The platform injects only the business JSON needed by this action.',
      ),
      outputInstruction: text(
        outputMode === 'artifact-path'
          ? '只返回指定 Markdown 文件的路径。'
          : '只返回本动作的直接 JSON 结果；可选字段不用时省略。',
        outputMode === 'artifact-path'
          ? 'Return only the designated Markdown file path.'
          : "Return only this action's direct JSON result; omit unused optional fields.",
      ),
    }
    const guide = {
      schemaVersion: 1 as const,
      inputMode: 'direct-json' as const,
      outputMode,
      contractRef: { contractId: contract.contractId, version: 2 },
      displayName: presentation[contract.contractId].name,
      description: presentation[contract.contractId].action,
      input: {
        schemaId: contract.inputSchemaId,
        displayName: text('输入', 'Input'),
        description: contract.materialSummary,
        topLevelFields: topLevelFields(contractDetails.inputFields),
        primaryFieldPaths: contractDetails.inputFields.map((item) => item.path),
        fields: [...contractDetails.inputFields],
        exampleJson: JSON.stringify(contractDetails.inputExample, null, 2),
      },
      output: {
        schemaId: contract.outputSchemaId,
        displayName: text('输出', 'Output'),
        description: contract.completionStandard,
        topLevelFields: topLevelFields(contractDetails.outputFields),
        primaryFieldPaths: contractDetails.outputFields
          .filter((item) => item.path !== 'explanation')
          .map((item) => item.path),
        fields: [...contractDetails.outputFields],
        exampleJson: JSON.stringify(contractDetails.outputExample, null, 2),
      },
      allowedExecutorKinds: [...contract.allowedToolKinds],
      transports: {
        agent: contract.allowedToolKinds.includes('agent')
          ? {
              ...transport,
              inputLocation: 'Agent prompt · INPUT_JSON',
              outputLocation: `Agent output port · ${contractDetails.outputPort ?? EXECUTION_CONTRACT_RESULT_PORT}`,
              outputPort: contractDetails.outputPort ?? EXECUTION_CONTRACT_RESULT_PORT,
              ...(contractDetails.outputKind === undefined
                ? {}
                : { outputKind: contractDetails.outputKind }),
            }
          : null,
        workflow: contract.allowedToolKinds.includes('workflow')
          ? {
              ...transport,
              inputLocation: 'Workflow text input · prompt',
              outputLocation: `Workflow output · ${EXECUTION_CONTRACT_RESULT_PORT}`,
            }
          : null,
        program: contract.allowedToolKinds.includes('program')
          ? {
              ...transport,
              inputLocation: `Environment variable · ${EXECUTION_CONTRACT_SCRIPT_INPUT_ENV} (large input: ${EXECUTION_CONTRACT_SCRIPT_INPUT_FILE_ENV})`,
              outputLocation: 'stdout · one JSON object',
            }
          : null,
      },
    }
    return {
      contractRef: guide.contractRef,
      guideJson: JSON.stringify(guide),
      projectInputJson: ({ inputEnvelopeJson, projectionJson }) =>
        projectDevelopmentToolInputV2({
          contractId: contract.contractId,
          inputEnvelopeJson,
          projectionJson,
        }),
      ...(outputMode === 'direct-json'
        ? {
            validateOutputJson: (outputJson: string) =>
              validateDevelopmentToolOutputV2(
                contract.contractId as DevelopmentToolJsonOutputContractIdV2,
                outputJson,
              ),
          }
        : {}),
    }
  })
