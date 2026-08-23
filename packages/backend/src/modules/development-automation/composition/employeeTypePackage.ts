// RFC-310 OS revision -- the development employee is a type package, not the
// owner of the digital-employee runtime. Bootstrap registers this descriptor
// through digital-employee's public contract; the OS never imports this module.

import { z } from 'zod'

import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'

import type {
  EmployeeTypeCollaborationCodec,
  EmployeeTypePackageRegistration,
  EmployeeTypeContextCodec,
  EmployeeTypeReactionCodec,
} from '@/modules/digital-employee/public/types'
import {
  EXECUTION_CONTRACT_RESULT_PORT,
  EXECUTION_CONTRACT_SCRIPT_INPUT_ENV,
  EXECUTION_CONTRACT_SCRIPT_INPUT_FILE_ENV,
  type ExecutionContractField,
  type ExecutionContractRegistration,
} from '@/modules/execution-contract/public/types'
import { stableIdentityComponent } from '@/util/gitRef'

type EmployeeTypeRuntimeCodec = EmployeeTypeContextCodec &
  EmployeeTypeReactionCodec &
  EmployeeTypeCollaborationCodec

interface LocalizedText {
  readonly 'zh-CN': string
  readonly 'en-US': string
}

interface ExactResourceRef {
  readonly id: string
  readonly revision: number
}

interface WorkContract {
  readonly contractId: string
  readonly version: number
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
  readonly fixtureSuiteRef: ExactResourceRef
}

type ToolImplementation =
  | { readonly kind: 'agent'; readonly agentRef: ExactResourceRef }
  | { readonly kind: 'workflow'; readonly workflowRef: ExactResourceRef }
  | {
      readonly kind: 'program'
      readonly runtimeKind: 'bash' | 'node' | 'python'
      readonly executableArtifactRef: string
      readonly executableDigest: string
      readonly parameterValuesRef: string | null
      readonly runtimeProfileRef: ExactResourceRef
    }

interface ContractValidationCheck {
  readonly code: string
  readonly ok: boolean
  readonly detail: string
}

const text = (zh: string, en: string): LocalizedText => ({ 'zh-CN': zh, 'en-US': en })
const triggerContract = (
  namespace: string,
  fields: readonly (readonly [fieldId: string, zh: string, en: string])[],
) => ({
  namespace,
  fields: fields.map(([fieldId, zh, en]) => ({
    fieldId,
    displayName: text(zh, en),
    description: text(zh, en),
  })),
})
const typeRef = { typeId: 'development', revision: 6 } as const
const fixtureSuiteRef = { id: 'builtin:development-work-contract-fixtures', revision: 1 } as const

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repository'), repositoryId: z.string().min(1).max(200) }).strict(),
  z
    .object({ kind: z.literal('repository-group'), repositoryGroupId: z.string().min(1).max(200) })
    .strict(),
  z.object({ kind: z.literal('task') }).strict(),
])

// Revision 5 retired “global default” from authoring in favor of an explicit
// task-time repository choice. Runtime codecs are keyed by type id, however,
// so revision 6 must continue decoding frozen revision-3 employee scopes.
const runtimeScopeSchema = z.discriminatedUnion('kind', [
  ...scopeSchema.options,
  z.object({ kind: z.literal('global') }).strict(),
])

const contract = (
  contractId: string,
  input: string,
  output: string,
  materialZh: string,
  materialEn: string,
  completionZh: string,
  completionEn: string,
  allowedToolKinds: WorkContract['allowedToolKinds'],
  allowedEffectKinds: readonly string[],
  workspacePolicy: WorkContract['workspacePolicy'],
  requiredConnectionPurpose: string | null = null,
): WorkContract => ({
  contractId,
  version: 1,
  inputSchemaId: input,
  outputSchemaId: output,
  materialSummary: text(materialZh, materialEn),
  completionStandard: text(completionZh, completionEn),
  allowedToolKinds: [...allowedToolKinds],
  allowedEffectKinds: [...allowedEffectKinds],
  requiredConnectionPurpose,
  workspacePolicy,
  semanticValidatorId: `${contractId}.validator`,
  fixtureSuiteRef,
})

const WRITE_REQUIRED = {
  mode: 'write',
  businessChangeOnOk: 'required',
  writablePrefixes: [],
  platformWritePrefixes: [],
} as const satisfies WorkContract['workspacePolicy']
const WRITE_IMPLEMENTATION = {
  mode: 'write',
  businessChangeOnOk: 'required',
  writablePrefixes: [],
  platformWritePrefixes: ['inputs/requirements'],
} as const satisfies WorkContract['workspacePolicy']
const WRITE_MATERIALS = {
  mode: 'write',
  businessChangeOnOk: 'optional',
  writablePrefixes: [],
  platformWritePrefixes: ['inputs/requirements'],
} as const satisfies WorkContract['workspacePolicy']
const READ_ONLY = {
  mode: 'read-only',
  businessChangeOnOk: 'forbidden',
  writablePrefixes: [],
  platformWritePrefixes: [],
} as const satisfies WorkContract['workspacePolicy']
const READ_PIPELINE = {
  mode: 'read-only',
  businessChangeOnOk: 'forbidden',
  writablePrefixes: [],
  platformWritePrefixes: ['pipeline'],
} as const satisfies WorkContract['workspacePolicy']
const NO_WORKSPACE = {
  mode: 'none',
  businessChangeOnOk: 'forbidden',
  writablePrefixes: [],
  platformWritePrefixes: [],
} as const satisfies WorkContract['workspacePolicy']

const contracts: WorkContract[] = [
  contract(
    'development.prepare-materials',
    'development.work-request.v1',
    'development.requirement-context.v1',
    '需求正文、附件或外部问题单引用',
    'Requirement body, attachments, or an external work-item reference',
    '形成完整、可追溯的需求上下文和仓库文件落点',
    'A complete traceable requirement context and repository file placement plan exists',
    ['agent', 'workflow', 'program'],
    [],
    WRITE_MATERIALS,
  ),
  contract(
    'development.analyze-implement',
    'development.requirement-context.v1',
    'development.change-proposal.v1',
    '需求上下文、仓库快照和已有诊断证据',
    'Requirement context, repository snapshot, and existing diagnostics',
    '输出符合 envelope 的修改提案和验证说明，不执行 Git 或代码平台操作',
    'Produces an envelope-valid change proposal and verification notes without Git or code-host effects',
    ['agent', 'workflow'],
    [],
    WRITE_IMPLEMENTATION,
  ),
  contract(
    'development.prepare-change',
    'development.change-proposal.v1',
    'development.change-candidate.v1',
    '已验证的修改提案',
    'Validated change proposal',
    '平台形成可提交的 change candidate',
    'The platform has produced a committable change candidate',
    [],
    ['source-control.candidate'],
    NO_WORKSPACE,
  ),
  contract(
    'development.publish-mr',
    'development.change-candidate.v1',
    'development.merge-request-context.v1',
    'Change candidate 与目标分支事实',
    'Change candidate and target branch facts',
    '平台完成 commit、CAS push 并创建或更新 MR 上下文',
    'The platform commits, CAS-pushes, and creates or updates the merge-request context',
    [],
    ['source-control.commit', 'source-control.push', 'code-host.merge-request.ensure'],
    NO_WORKSPACE,
  ),
  contract(
    'development.observe-mr',
    'development.merge-request-context.v1',
    'development.merge-request-facts.v1',
    '当前 MR、review、流水线和冲突关注范围',
    'Current merge request, review, pipeline, and conflict attention',
    '刷新同一 head 的权威 MR 事实并淘汰过时事件',
    'Refreshes authoritative same-head MR facts and obsoletes stale events',
    [],
    [],
    NO_WORKSPACE,
  ),
  contract(
    'development.classify-feedback',
    'development.review-evidence.v1',
    'development.problem-set.v1',
    '当前 MR 的全部未处理、非自身检视意见',
    'Every unresolved non-self review thread on the current merge request',
    '平台逐条归一化为可追溯问题集合，不遗漏、不合并，也不选择下一动作',
    'The platform normalizes every thread into a traceable problem set without omission, merging, or action selection',
    [],
    [],
    NO_WORKSPACE,
  ),
  contract(
    'development.repair-feedback',
    'development.problem-set.v1',
    'development.change-proposal.v1',
    '类型化检视问题、对应代码和评论上下文',
    'Typed review problems with corresponding code and comment context',
    '修复所有分配问题并输出修改 envelope',
    'Repairs every assigned problem and emits a change envelope',
    ['agent', 'workflow', 'program'],
    [],
    WRITE_REQUIRED,
  ),
  contract(
    'development.collect-pipeline',
    'development.merge-request-context.v1',
    'development.pipeline-evidence.v1',
    'MR head、流水线标识和已注册系统连接',
    'MR head, pipeline identity, and registered system connection',
    '程序化取得完整门禁状态，大日志落入 pipeline evidence 目录',
    'Programmatically obtains complete gate state and stores large logs in pipeline evidence',
    ['program', 'workflow'],
    [],
    READ_PIPELINE,
  ),
  contract(
    'development.classify-pipeline',
    'development.pipeline-evidence.v1',
    'development.problem-set.v1',
    '结构化门禁结果和大日志 artifact 引用',
    'Structured gate results and large-log artifact references',
    '产出命中本工具闭集的问题记录与待处理种类；平台随后按固定优先级逐类调度，未知项进入兜底类型',
    "Produces problem records and remaining categories from this tool's closed set; the platform then dispatches each category by fixed priority with an explicit unknown fallback",
    ['agent', 'workflow', 'program'],
    [],
    READ_ONLY,
  ),
  contract(
    'development.repair-pipeline',
    'development.problem-set.v1',
    'development.change-proposal.v1',
    '平台分配的唯一问题种类、该类问题记录、流水线证据和当前代码',
    'The one assigned problem category, its problem records, pipeline evidence, and current code',
    '对应槽位工具修复该种类的全部问题并输出修改 envelope',
    'The bound slot tool repairs every problem in that category and emits a change envelope',
    ['agent', 'workflow', 'program'],
    [],
    WRITE_REQUIRED,
  ),
  contract(
    'development.repair-conflict',
    'development.conflict-context.v1',
    'development.change-proposal.v1',
    '平台准备的冲突现场、父提交和冲突文件集合',
    'Platform-prepared conflict scene, parent commits, and conflict file set',
    '只修改授权冲突文件并输出 envelope',
    'Modifies only authorized conflict files and emits an envelope',
    ['agent', 'workflow', 'program'],
    [],
    WRITE_REQUIRED,
  ),
  contract(
    'development.delegate',
    'employee.invocation-request.v1',
    'employee.invocation-result.v1',
    '目标员工、工作范围和类型化输入 envelope',
    'Target employee, work scope, and typed input envelope',
    '异步子员工返回可重验结果，父员工不持有等待进程',
    'An asynchronous child employee returns a revalidatable result without a waiting parent process',
    [],
    ['employee.invocation.create'],
    NO_WORKSPACE,
  ),
  contract(
    'development.evaluate-ready',
    'development.merge-request-facts.v1',
    'development.readiness.v1',
    '同一 head 的机器门禁、人工门禁和代码平台 mergeability',
    'Same-head machine gates, human gates, and code-host mergeability',
    '给出可解释的 ready-to-merge 判定，平台不自动合入',
    'Produces an explainable ready-to-merge result without automatic merge',
    [],
    [],
    NO_WORKSPACE,
  ),
  contract(
    'development.wait-merge',
    'development.readiness.v1',
    'development.terminal.v1',
    'ready-to-merge MR 与生命周期关注范围',
    'Ready-to-merge MR and lifecycle attention',
    '持续跟踪到外部 merged 或 closed 终态',
    'Tracks until the external merged or closed terminal state',
    [],
    [],
    NO_WORKSPACE,
  ),
  contract(
    'development.publish-conflict',
    'development.change-proposal.v1',
    'development.merge-request-context.v1',
    '已通过平台边界校验的冲突修复现场和固定父提交',
    'A boundary-validated conflict scene with pinned parent commits',
    '平台生成双父 merge commit、CAS 推送并刷新 MR head',
    'The platform creates a two-parent merge commit, CAS-pushes it, and refreshes the MR head',
    [],
    ['source-control.commit', 'source-control.push'],
    NO_WORKSPACE,
  ),
  contract(
    'development.prepare-approval',
    'development.merge-request-context.v1',
    'development.approval-draft.v1',
    '当前 MR 门禁事实、审批类型和审批系统连接',
    'Current merge-request gate facts, approval type, and approval-system connection',
    '形成绑定当前 MR head 的严格审批草稿引用；Agent 不持有凭据且不能直接提交',
    'Produces a strict approval draft bound to the current MR head without credentials or direct submission',
    ['agent', 'workflow', 'program'],
    [],
    READ_ONLY,
    'approval-gateway',
  ),
  contract(
    'development.submit-approval',
    'development.approval-draft.v1',
    'development.approval-receipt.v1',
    '已校验审批草稿和固定审批系统连接',
    'Validated approval draft and pinned approval-system connection',
    '平台按幂等键提交或认领既有审批，并保存 correlation receipt',
    'The platform submits or adopts the approval by idempotency key and stores its correlation receipt',
    [],
    ['external-approval.submit'],
    NO_WORKSPACE,
  ),
  contract(
    'development.observe-approval',
    'development.approval-receipt.v1',
    'development.approval-observation.v1',
    '审批 correlation、截止时间和最新权威 revision',
    'Approval correlation, deadline, and latest authoritative revision',
    '短调用取得 pending、approved、rejected、expired 或 unavailable 终态',
    'A short call returns pending, approved, rejected, expired, or unavailable',
    [],
    ['external-approval.observe'],
    NO_WORKSPACE,
  ),
  contract(
    'development.acknowledge-feedback',
    'development.review-resolution.v1',
    'development.review-resolution.v1',
    '待处理检视线程和当前 MR',
    'Actionable review threads and the current merge request',
    '平台已逐线程回复收到并保存幂等笔迹',
    'The platform has acknowledged every thread and recorded idempotent markers',
    [],
    ['code-host.merge-request.reply'],
    NO_WORKSPACE,
  ),
  contract(
    'development.reply-feedback',
    'development.review-resolution.v1',
    'development.review-resolution.v1',
    '已发布提交和 Agent 逐线程处理说明',
    'The published commit and the Agent treatment for every thread',
    '平台已把每条处理说明回复到原线程并保存回执',
    'The platform has replied to every original thread and recorded receipts',
    [],
    ['code-host.merge-request.reply'],
    NO_WORKSPACE,
  ),
]

const contractField = (
  path: string,
  labelZh: string,
  labelEn: string,
  descriptionZh: string,
  descriptionEn: string,
  source: ExecutionContractField['source'],
  valueType: ExecutionContractField['valueType'],
  required = true,
  example: string | null = null,
  condition: LocalizedText | null = null,
): ExecutionContractField => ({
  path,
  label: text(labelZh, labelEn),
  description: text(descriptionZh, descriptionEn),
  valueType,
  required,
  source,
  condition,
  example,
})

const commonInputFields: ExecutionContractField[] = [
  contractField(
    'schemaVersion',
    '信封版本',
    'Envelope version',
    '平台固定注入为 1',
    'Always injected as 1 by the platform',
    'platform',
    'number',
    true,
    '1',
  ),
  contractField(
    'roundRef',
    '执行轮次',
    'Execution round',
    '平台生成；输出必须原样回传',
    'Generated by the platform and copied exactly into output',
    'platform',
    'string',
    true,
    '01J...ROUND',
  ),
  contractField(
    'executionNonce',
    '执行随机数',
    'Execution nonce',
    '平台生成；防止把其他轮次的结果误收进来',
    'Generated by the platform to reject results from another run',
    'platform',
    'string',
    true,
    '64 位十六进制字符串',
  ),
  contractField(
    'workItemRef',
    '工作项',
    'Work item',
    '当前固定职责节点',
    'The current fixed responsibility node',
    'platform',
    'string',
  ),
  contractField(
    'toolSlotRef',
    '工具槽位',
    'Tool slot',
    '规则已经选择的工具槽位，执行器不得改选',
    'The rule-selected tool slot; the executor cannot choose another',
    'platform',
    'string',
  ),
  contractField(
    'connectionRef',
    '系统连接',
    'System connection',
    '平台冻结的连接版本；无连接时为 null，凭据不进入信封',
    'The exact frozen connection revision, or null; credentials never enter the envelope',
    'platform',
    'object',
    false,
  ),
  contractField(
    'inputSchemaId',
    '输入结构',
    'Input schema',
    '当前工作合同冻结的输入 schema ID',
    'The input schema ID frozen by the current work contract',
    'platform',
    'string',
  ),
  contractField(
    'outputSchemaId',
    '输出结构',
    'Output schema',
    '当前工作合同冻结的输出 schema ID',
    'The output schema ID frozen by the current work contract',
    'platform',
    'string',
  ),
  contractField(
    'contractInput',
    '业务输入',
    'Business input',
    '按当前 input schema 投影后的直接可消费对象',
    'The directly consumable object projected by the current input schema',
    'work-input',
    'object',
  ),
  contractField(
    'artifactRefs',
    '材料引用',
    'Artifact references',
    '大文件只传引用，执行器按引用读取工作目录中的材料',
    'Large files are passed by reference and read from the prepared workspace',
    'artifact',
    'array',
    false,
  ),
  contractField(
    'materialInstructions',
    '工作材料清单',
    'Work material manifest',
    '平台列出正文、外部 ID、每个上传文件的落点和材料目录；执行器必须逐项读取',
    'Lists the body, external ID, every uploaded file placement, and material directory; the executor must read every item',
    'platform',
    'object',
  ),
  contractField(
    'platformPaths',
    '平台工作目录',
    'Platform workspace paths',
    '当前 Case 的需求材料、外部下载和流水线证据精确目录；工具不得自行选择路径',
    'Exact requirement, external-download, and pipeline-evidence directories for this case; tools cannot choose paths',
    'platform',
    'object',
  ),
  contractField(
    'humanReview',
    '人工评审指令',
    'Human review directive',
    '需要先评审方案时由平台注入，否则为 null',
    'Injected when a plan must be reviewed first; otherwise null',
    'platform',
    'object',
    false,
  ),
  contractField(
    'eventJson',
    '触发事件',
    'Triggering event',
    '平台冻结的事件 JSON；执行器不得改选事件',
    'The frozen event JSON; the executor cannot select another event',
    'event',
    'string',
  ),
  contractField(
    'contextsJson',
    '上下文快照',
    'Context snapshot',
    '本轮所需 Context 的冻结 JSON；大材料仍只放引用',
    'Frozen JSON for the Contexts required by this round; large material remains referenced',
    'context',
    'string',
  ),
  contractField(
    'workInstructions',
    '工作说明',
    'Work instructions',
    '类型包生成的本轮确定性约束',
    'Deterministic constraints generated by the type package for this round',
    'platform',
    'string',
  ),
  contractField(
    'executionEnvironmentJson',
    '执行环境',
    'Execution environment',
    '平台冻结的 scratch 或仓库工作区说明 JSON',
    'Frozen JSON describing the scratch or repository workspace',
    'platform',
    'string',
  ),
]

const outputFields: ExecutionContractField[] = [
  contractField(
    'schemaVersion',
    '信封版本',
    'Envelope version',
    '固定为 1',
    'Always 1',
    'platform',
    'number',
    true,
    '1',
  ),
  contractField(
    'roundRef',
    '执行轮次',
    'Execution round',
    '从输入原样回传',
    'Copied exactly from input',
    'platform',
    'string',
  ),
  contractField(
    'executionNonce',
    '执行随机数',
    'Execution nonce',
    '从输入原样回传',
    'Copied exactly from input',
    'platform',
    'string',
  ),
  contractField(
    'status',
    '执行结果',
    'Execution status',
    '只允许 ok、needs-input 或 blocked',
    'Only ok, needs-input, or blocked',
    'platform',
    'enum',
  ),
  contractField(
    'summary',
    '结果摘要',
    'Result summary',
    '必填的简短结果，不得放大日志',
    'Required concise result; large logs do not belong here',
    'work-input',
    'string',
  ),
  contractField(
    'contextPatches',
    '上下文变更',
    'Context patches',
    '符合 output schema 的类型化上下文补丁',
    'Typed context patches conforming to the output schema',
    'context',
    'array',
  ),
  contractField(
    'effectSuggestions',
    '效果建议',
    'Effect suggestions',
    '只提出合同允许的平台效果；执行器不直接执行',
    'Only suggests contract-allowed platform effects; the executor never performs them',
    'platform',
    'array',
  ),
  contractField(
    'artifactRefs',
    '产物引用',
    'Artifact references',
    '输出产生的大文件或证据引用',
    'References to large output artifacts or evidence',
    'artifact',
    'array',
  ),
]

const pipelineEvidenceExample = {
  status: 'failed',
  mergeRequestRef: 'project!123',
  headSha: '0'.repeat(40),
  evidenceArtifactRef: '.agent-workflow/pipeline/case-id/result.json',
  failureTypes: ['compile-error'],
}

const pipelineFailureTypeDefinitionsExample = [
  {
    typeId: 'compile-error',
    name: 'Compile error',
    description: 'Compilation or type checking fails',
    priority: 1,
    fallback: false,
    handlingWorkItemRef: 'repair-pipeline',
  },
  {
    typeId: 'unknown-pipeline-failure',
    name: 'Unknown pipeline failure',
    description: 'No earlier category matches',
    priority: 2,
    fallback: true,
    handlingWorkItemRef: 'repair-pipeline',
  },
]

const pipelineProblemSetExample = {
  status: 'active',
  source: 'pipeline',
  headSha: '0'.repeat(40),
  remainingTypes: ['compile-error'],
  problems: [
    {
      problemId: 'pipeline:compile-error:1',
      type: 'compile-error',
      summary: 'Type checking failed in the frontend package',
      evidenceArtifactRefs: ['.agent-workflow/pipeline/case-id/logs/typecheck.log'],
      reviewThread: null,
    },
  ],
}

const inputDetailsByContract: Record<
  string,
  {
    readonly primaryFieldPaths: readonly string[]
    readonly fields: readonly ExecutionContractField[]
    readonly contractInput: unknown
  }
> = {
  'development.prepare-materials': {
    primaryFieldPaths: [
      'contractInput.workRequest.externalId',
      'contractInput.materialTargetDirectory',
    ],
    fields: [
      contractField(
        'contractInput.workRequest.kind',
        '材料形式',
        'Material kind',
        'body、files、body-and-files 或 external-id',
        'body, files, body-and-files, or external-id',
        'work-input',
        'enum',
      ),
      contractField(
        'contractInput.workRequest.externalId',
        '需求 / 问题 ID',
        'Requirement / issue ID',
        '用户在受理页面填写的原始 ID，脚本可直接读取',
        'The original ID entered at intake and directly readable by the executor',
        'work-input',
        'string',
        false,
        'ISSUE-1234',
        text('仅 external-id 形式必填', 'Required only for external-id material'),
      ),
      contractField(
        'contractInput.workRequest.body',
        '需求正文',
        'Request body',
        '用户提交的正文',
        'The body submitted by the user',
        'work-input',
        'string',
        false,
      ),
      contractField(
        'contractInput.workRequest.uploads',
        '上传文件',
        'Uploaded files',
        '每项含平台分配的 placement、artifactRef、targetPath、originalName',
        'Each item contains platform-assigned placement, artifactRef, targetPath, and originalName',
        'artifact',
        'array',
        false,
      ),
      contractField(
        'contractInput.materialTargetDirectory',
        '外部材料目标目录',
        'External material target directory',
        '平台为当前任务分配的唯一临时目录；外部 ID 工具只能写入这里',
        'The only temporary directory allocated by the platform for this case; an external-ID tool writes only here',
        'platform',
        'string',
      ),
      contractField(
        'contractInput.repositoryRef',
        '目标仓库',
        'Target repository',
        '用户选择的目标仓库引用',
        'The target repository selected at intake',
        'context',
        'string',
      ),
    ],
    contractInput: {
      workRequest: { kind: 'external-id', externalId: 'ISSUE-1234', body: null, uploads: [] },
      repositoryRef: 'repository-id',
      materialTargetDirectory: '.agent-workflow/inputs/requirements/case-id/external',
    },
  },
  'development.analyze-implement': {
    primaryFieldPaths: [
      'contractInput.requirementContext.request',
      'platformPaths.requirementDirectory',
      'platformPaths.implementationPlanPath',
    ],
    fields: [
      contractField(
        'contractInput.requirementContext.request',
        '需求与问题材料',
        'Requirement and problem materials',
        '正文、外部 ID 以及每个上传文档的平台落点',
        'Body, external ID, and the platform placement of every uploaded document',
        'context',
        'object',
      ),
      contractField(
        'platformPaths.requirementDirectory',
        '材料读取目录',
        'Material directory',
        '必须逐项读取该 Case 目录内的平台材料',
        'Every platform material in this case directory must be read',
        'platform',
        'string',
      ),
      contractField(
        'platformPaths.implementationPlanPath',
        '方案文档路径',
        'Implementation plan path',
        '启用人工评审时，方案分析 Agent 必须在此路径写入 Markdown，并从 analysis-plan 输出同一路径',
        'When review is enabled, the planning Agent writes Markdown here and emits the same path from analysis-plan',
        'platform',
        'string',
        false,
        '.agent-workflow/inputs/requirements/case-id/review/implementation-plan.md',
        text('仅启用实现方案评审时使用', 'Used only when implementation-plan review is enabled'),
      ),
    ],
    contractInput: {
      requirementContext: {
        request: { kind: 'body', body: 'Implement the accepted requirement', uploads: [] },
      },
    },
  },
  'development.collect-pipeline': {
    primaryFieldPaths: [
      'contractInput.mergeRequest.mergeRequestRef',
      'contractInput.pipelineDirectory',
    ],
    fields: [
      contractField(
        'contractInput.mergeRequest.mergeRequestRef',
        'MR 标识',
        'Merge request reference',
        '需要查询门禁的 MR',
        'The merge request whose gates must be queried',
        'context',
        'string',
      ),
      contractField(
        'contractInput.mergeRequest.headSha',
        'MR 当前提交',
        'Merge request head',
        '结果必须属于这个提交',
        'The result must belong to this commit',
        'context',
        'string',
      ),
      contractField(
        'contractInput.connectionRef',
        '系统连接',
        'System connection',
        '平台冻结的自建系统程序引用，凭据不进入 Agent 输入',
        'Frozen system-program reference; credentials never enter Agent input',
        'platform',
        'object',
        false,
      ),
      contractField(
        'contractInput.pipelineDirectory',
        '流水线材料目录',
        'Pipeline material directory',
        '大日志必须下载到该目录并只在输出中返回引用',
        'Large logs must be downloaded here and returned only by reference',
        'platform',
        'string',
      ),
    ],
    contractInput: {
      mergeRequest: { mergeRequestRef: 'project!123', headSha: '0'.repeat(40) },
      connectionRef: { id: 'pipeline-adapter', revision: 1 },
      pipelineDirectory: '.agent-workflow/pipeline/<case-id>',
    },
  },
  'development.classify-pipeline': {
    primaryFieldPaths: ['contractInput.pipelineEvidence', 'contractInput.pipelineDirectory'],
    fields: [
      contractField(
        'contractInput.pipelineEvidence',
        '流水线失败证据',
        'Pipeline failure evidence',
        '当前 MR head 的结构化门禁状态、失败信号和证据 artifact 引用；这是问题归类的业务输入',
        'Structured gate status, failure signals, and evidence artifact references for the current MR head; this is the business input to classification',
        'context',
        'object',
      ),
      contractField(
        'contractInput.pipelineDirectory',
        '流水线材料目录',
        'Pipeline material directory',
        '只从平台分配的当前 Case 目录读取结构化门禁结果和大日志',
        'Read structured gate results and large logs only from this platform-allocated case directory',
        'platform',
        'string',
      ),
      contractField(
        'contractInput.failureTypeDefinitions',
        '失败类型定义',
        'Failure type definitions',
        '平台从本工具版本的“问题种类”配置冻结注入，只约束允许产出的种类、优先级和兜底项；它不是上游任务材料',
        "Injected from this tool revision's problem-category configuration; it constrains allowed outputs, priority, and fallback and is not upstream task material",
        'platform',
        'array',
      ),
    ],
    contractInput: {
      pipelineEvidence: pipelineEvidenceExample,
      pipelineDirectory: '.agent-workflow/pipeline/case-id',
      failureTypeDefinitions: pipelineFailureTypeDefinitionsExample,
    },
  },
  'development.repair-pipeline': {
    primaryFieldPaths: [
      'contractInput.problemSet',
      'contractInput.assignedFailureType',
      'contractInput.pipelineEvidence',
      'contractInput.pipelineDirectory',
    ],
    fields: [
      contractField(
        'contractInput.problemSet',
        '已归类的流水线问题',
        'Classified pipeline problems',
        '分类工具产出的完整问题集合；本工具只处理 problems 中 type 等于 assignedFailureType 的全部记录',
        'The complete problem set emitted by the classifier; this tool handles every problem whose type equals assignedFailureType',
        'context',
        'object',
      ),
      contractField(
        'contractInput.assignedFailureType',
        '本轮失败类型',
        'Assigned failure type',
        '平台规则已选择的唯一失败类型，工具不得改选',
        'The one failure type selected by platform rules; the tool cannot choose another',
        'platform',
        'string',
      ),
      contractField(
        'contractInput.pipelineEvidence',
        '流水线失败证据',
        'Pipeline failure evidence',
        '与问题集合绑定到同一 MR head 的结构化门禁状态和证据引用',
        'Structured gate state and evidence references bound to the same MR head as the problem set',
        'context',
        'object',
      ),
      contractField(
        'contractInput.pipelineDirectory',
        '流水线材料目录',
        'Pipeline material directory',
        '当前失败类型对应证据和大日志的精确平台目录',
        'The exact platform directory containing evidence and large logs for this failure',
        'platform',
        'string',
      ),
    ],
    contractInput: {
      problemSet: pipelineProblemSetExample,
      assignedFailureType: 'compile-error',
      pipelineEvidence: pipelineEvidenceExample,
      pipelineDirectory: '.agent-workflow/pipeline/case-id',
    },
  },
  'development.repair-feedback': {
    primaryFieldPaths: [
      'contractInput.problemSet',
      'contractInput.requirementContext',
      'platformPaths.requirementDirectory',
    ],
    fields: [
      contractField(
        'contractInput.problemSet',
        '完整检视线程树',
        'Complete review thread trees',
        '每项包含根评论、全部多轮回复、作者分类、文件路径与冻结 revision；必须整棵处理',
        'Each item contains the root comment, every reply, author class, file path, and frozen revision; the entire tree must be handled',
        'context',
        'object',
      ),
      contractField(
        'contractInput.requirementContext',
        '需求与交付 Context',
        'Requirement and delivery Context',
        '输出交付文案时必须基于并完整保留的当前需求 Context',
        'The current requirement Context that must be preserved when returning delivery content',
        'context',
        'object',
      ),
      contractField(
        'platformPaths.requirementDirectory',
        '原始工作材料目录',
        'Original work-material directory',
        '需要回看需求或上传文档时使用的精确平台路径',
        'The exact platform path used when the original request or uploads must be revisited',
        'platform',
        'string',
      ),
    ],
    contractInput: {
      problemSet: { source: 'review', problems: [{ reviewThread: { messages: [] } }] },
      mergeRequest: { mergeRequestRef: 'project!123', headSha: '0'.repeat(40) },
      reviewResolution: { status: 'acknowledged', threads: [] },
      requirementContext: {
        request: { kind: 'body', body: 'Implement the accepted requirement', uploads: [] },
      },
    },
  },
  'development.repair-conflict': {
    primaryFieldPaths: [
      'contractInput.mergeRequest',
      'contractInput.event',
      'contractInput.requirementContext',
    ],
    fields: [
      contractField(
        'contractInput.mergeRequest',
        '当前 MR 与固定 head',
        'Current merge request and pinned head',
        '平台准备冲突现场所依据的 MR 身份与提交',
        'The merge-request identity and commit used by the platform to prepare the conflict scene',
        'context',
        'object',
      ),
      contractField(
        'contractInput.event',
        '冲突现场事件',
        'Conflict-scene event',
        '包含平台已验证的冲突文件和父提交引用；工具不得改选',
        'Contains platform-validated conflict files and parent refs; the tool cannot choose another scene',
        'event',
        'object',
      ),
      contractField(
        'contractInput.requirementContext',
        '需求与交付 Context',
        'Requirement and delivery Context',
        '生成提交与 MR 文案时必须保留的当前需求 Context',
        'The current requirement Context preserved while generating commit and MR content',
        'context',
        'object',
      ),
    ],
    contractInput: {
      mergeRequest: { mergeRequestRef: 'project!123', headSha: '0'.repeat(40) },
      event: { conflictFiles: ['src/example.ts'], parentShas: ['0'.repeat(40), '1'.repeat(40)] },
      requirementContext: {
        request: { kind: 'body', body: 'Implement the accepted requirement', uploads: [] },
      },
    },
  },
  'development.prepare-approval': {
    primaryFieldPaths: ['contractInput.mergeRequest', 'contractInput.connectionRef'],
    fields: [
      contractField(
        'contractInput.mergeRequest',
        '待审批 MR',
        'Merge request requiring approval',
        '审批草稿必须绑定的当前 MR head 与门禁事实',
        'Current merge-request head and gate facts to which the approval draft must bind',
        'context',
        'object',
      ),
      contractField(
        'contractInput.connectionRef',
        '审批系统连接',
        'Approval-system connection',
        '平台冻结的适配程序版本；凭据不进入 Agent 或脚本',
        'Frozen adapter revision; credentials never enter the Agent or script',
        'platform',
        'object',
      ),
    ],
    contractInput: {
      mergeRequest: { mergeRequestRef: 'project!123', headSha: '0'.repeat(40) },
      connectionRef: { id: 'approval-adapter', revision: 1 },
    },
  },
}

const successfulDeliveryCondition = text(
  'status=ok 时必填；needs-input 或 blocked 时可以为 null',
  'Required when status=ok; may be null for needs-input or blocked',
)

const deliveryOutputFields: readonly ExecutionContractField[] = [
  contractField(
    'deliveryContent',
    '交付写回内容',
    'Delivery writeback content',
    'Agent 只产出内容；平台校验后执行提交、推送和 MR 写回',
    'The Agent only produces content; the platform validates it and performs commit, push, and merge-request writeback',
    'work-input',
    'object',
    false,
    null,
    successfulDeliveryCondition,
  ),
  contractField(
    'deliveryContent.commitMessage',
    '提交信息',
    'Commit message',
    'Agent 必须给出提交标题和可选正文；平台只追加 Case 与 Context 机器标记并执行 commit',
    'The Agent supplies the commit subject and optional body; the platform only appends Case and Context markers and performs the commit',
    'context',
    'string',
    false,
    null,
    successfulDeliveryCondition,
  ),
  contractField(
    'deliveryContent.mergeRequestTitle',
    'MR 标题',
    'Merge request title',
    'Agent 必须给出最终 MR 标题；平台校验后原样用于创建或更新 MR',
    'The Agent supplies the final merge-request title; the platform validates it and uses it to create or update the MR',
    'context',
    'string',
    false,
    null,
    successfulDeliveryCondition,
  ),
  contractField(
    'deliveryContent.mergeRequestDescription',
    'MR 正文',
    'Merge request description',
    'Agent 必须给出面向评审者的 MR 正文；平台只在末尾追加可追踪机器标记',
    'The Agent supplies the reviewer-facing description; the platform only appends traceability markers',
    'context',
    'string',
    false,
    null,
    successfulDeliveryCondition,
  ),
]

const deliveryPrimaryFieldPaths = deliveryOutputFields
  .filter((field) => field.path !== 'deliveryContent')
  .map((field) => field.path)

const deliveryContentExample = {
  commitMessage: 'implement accepted requirement\n\nAdd the requested behavior and tests.',
  mergeRequestTitle: 'Implement accepted requirement',
  mergeRequestDescription: '## What changed\n\nImplemented the requested behavior and tests.',
}

function mergeContractFields(
  common: readonly ExecutionContractField[],
  specialized: readonly ExecutionContractField[],
): ExecutionContractField[] {
  const specializedByPath = new Map(specialized.map((field) => [field.path, field]))
  const commonPaths = new Set(common.map((field) => field.path))
  return [
    ...common.map((field) => specializedByPath.get(field.path) ?? field),
    ...specialized.filter((field) => !commonPaths.has(field.path)),
  ]
}

const outputDetailsByContract: Record<
  string,
  {
    readonly primaryFieldPaths: readonly string[]
    readonly fields: readonly ExecutionContractField[]
    readonly topLevelFields?: readonly string[]
    readonly exampleFields?: Readonly<Record<string, unknown>>
  }
> = {
  'development.prepare-materials': {
    primaryFieldPaths: ['artifactRefs', 'contextPatches'],
    fields: [],
  },
  'development.analyze-implement': {
    primaryFieldPaths: deliveryPrimaryFieldPaths,
    fields: deliveryOutputFields,
    topLevelFields: ['deliveryContent'],
    exampleFields: { deliveryContent: deliveryContentExample },
  },
  'development.repair-pipeline': {
    primaryFieldPaths: deliveryPrimaryFieldPaths,
    fields: deliveryOutputFields,
    topLevelFields: ['deliveryContent'],
    exampleFields: { deliveryContent: deliveryContentExample },
  },
  'development.repair-conflict': {
    primaryFieldPaths: deliveryPrimaryFieldPaths,
    fields: deliveryOutputFields,
    topLevelFields: ['deliveryContent'],
    exampleFields: { deliveryContent: deliveryContentExample },
  },
  'development.repair-feedback': {
    primaryFieldPaths: [...deliveryPrimaryFieldPaths, 'reviewReplies'],
    fields: [
      ...deliveryOutputFields,
      contractField(
        'reviewReplies',
        '逐条检视回复',
        'Reply for every review thread',
        '每棵输入线程必须输出一条具体处理说明；平台在提交发布后把它回复到原线程',
        'Every input thread must receive a concrete treatment message; the platform posts it to the original thread after publishing the commit',
        'context',
        'array',
        false,
        null,
        text(
          'status=ok 时必须与输入线程逐条对应；其他状态可以为空数组',
          'For status=ok, must correspond one-for-one with input threads; otherwise it may be empty',
        ),
      ),
    ],
    topLevelFields: ['deliveryContent', 'reviewReplies'],
    exampleFields: {
      deliveryContent: deliveryContentExample,
      reviewReplies: [
        {
          threadRef: 'thread-1',
          revision: 'revision-1',
          disposition: 'addressed',
          replyBody: '已按意见修正边界条件，并补充对应回归测试。',
        },
      ],
    },
  },
  'development.collect-pipeline': {
    primaryFieldPaths: ['artifactRefs', 'contextPatches'],
    fields: [],
  },
  'development.classify-pipeline': {
    primaryFieldPaths: ['contextPatches'],
    fields: [
      contractField(
        'contextPatches',
        '问题种类与问题记录',
        'Problem categories and records',
        '必须恰好写回一个 development.problem-set：problems[].type 和去重后的 remainingTypes 只能取本工具配置的问题种类，且每个待处理种类至少有一条问题记录；平台据此启动下一修复工具',
        'Must return exactly one development.problem-set: problems[].type and deduplicated remainingTypes may only use categories configured by this tool, with at least one problem record per remaining category; the platform uses it to start the next repair tool',
        'context',
        'array',
      ),
    ],
    exampleFields: {
      contextPatches: [
        {
          contextId: null,
          contextTypeId: 'development.problem-set',
          schemaVersion: 1,
          expectedRevision: null,
          lifecycleState: 'active',
          stateJson: JSON.stringify(pipelineProblemSetExample),
          artifactRefs: pipelineProblemSetExample.problems.flatMap(
            (problem) => problem.evidenceArtifactRefs,
          ),
        },
      ],
    },
  },
  'development.prepare-approval': {
    primaryFieldPaths: ['artifactRefs', 'contextPatches'],
    fields: [],
  },
}

const genericContractInput = {
  event: { eventTypeId: 'platform.event', subjectRef: 'subject' },
  contexts: [{ typeId: 'registered.context', revision: 1, state: {} }],
}

const outputTopLevelFields = [
  'schemaVersion',
  'roundRef',
  'executionNonce',
  'status',
  'summary',
  'contextPatches',
  'effectSuggestions',
  'artifactRefs',
] as const

export const developmentExecutionContractRegistrations: readonly ExecutionContractRegistration[] =
  contracts.map((workContract) => {
    const details = inputDetailsByContract[workContract.contractId]
    const outputDetails = outputDetailsByContract[workContract.contractId]
    const workItemRef = workContract.contractId.slice('development.'.length)
    const inputExample = {
      schemaVersion: 1,
      roundRef: '01JEXAMPLECONTRACTROUND',
      executionNonce: '0'.repeat(64),
      workItemRef,
      toolSlotRef: 'default',
      connectionRef: null,
      inputSchemaId: workContract.inputSchemaId,
      outputSchemaId: workContract.outputSchemaId,
      contractInput: details?.contractInput ?? genericContractInput,
      artifactRefs: [],
      materialInstructions: {
        bodyProvided: false,
        externalId: null,
        uploads: [],
        requirementDirectory: '.agent-workflow/inputs/requirements/case-id',
        externalMaterialDirectory: '.agent-workflow/inputs/requirements/case-id/external',
      },
      platformPaths: {
        requirementDirectory: '.agent-workflow/inputs/requirements/case-id',
        externalMaterialDirectory: '.agent-workflow/inputs/requirements/case-id/external',
        pipelineDirectory: '.agent-workflow/pipeline/case-id',
        implementationPlanPath:
          '.agent-workflow/inputs/requirements/case-id/review/implementation-plan.md',
      },
      humanReview: null,
      eventJson: '{}',
      contextsJson: '[]',
      workInstructions: 'Follow the frozen contract.',
      executionEnvironmentJson: JSON.stringify({ kind: 'scratch' }),
    }
    const commonTransport = {
      inputInstruction: text(
        '平台注入完整 JSON envelope；执行器不自行查询上下文来源。',
        'The platform injects the complete JSON envelope; the executor does not choose context sources.',
      ),
      outputInstruction: text(
        '只接受一个严格 JSON 对象；缺字段、多字段或 schema 不符都会拒收。',
        'Only one strict JSON object is accepted; missing, extra, or schema-mismatched fields are rejected.',
      ),
    }
    const guide = {
      schemaVersion: 1,
      contractRef: { contractId: workContract.contractId, version: workContract.version },
      displayName: workContract.materialSummary,
      description: workContract.completionStandard,
      input: {
        schemaId: workContract.inputSchemaId,
        displayName: text('确定性输入 envelope', 'Deterministic input envelope'),
        description: workContract.materialSummary,
        topLevelFields: Object.keys(inputExample),
        primaryFieldPaths: [...(details?.primaryFieldPaths ?? ['contractInput'])],
        fields: [...commonInputFields, ...(details?.fields ?? [])],
        exampleJson: JSON.stringify(inputExample, null, 2),
      },
      output: {
        schemaId: workContract.outputSchemaId,
        displayName: text('确定性输出 envelope', 'Deterministic output envelope'),
        description: workContract.completionStandard,
        topLevelFields: [...outputTopLevelFields, ...(outputDetails?.topLevelFields ?? [])],
        primaryFieldPaths: [...(outputDetails?.primaryFieldPaths ?? ['summary'])],
        fields: mergeContractFields(outputFields, outputDetails?.fields ?? []),
        exampleJson: JSON.stringify(
          {
            schemaVersion: 1,
            roundRef: '01JEXAMPLECONTRACTROUND',
            executionNonce: '0'.repeat(64),
            status: 'ok',
            summary: 'Describe the completed result.',
            contextPatches: [],
            effectSuggestions: [],
            artifactRefs: [],
            ...(outputDetails?.exampleFields ?? {}),
          },
          null,
          2,
        ),
      },
      allowedExecutorKinds: [...workContract.allowedToolKinds],
      transports: {
        agent: workContract.allowedToolKinds.includes('agent')
          ? {
              ...commonTransport,
              inputLocation: 'Agent prompt · INPUT_ENVELOPE_JSON',
              outputLocation: `Agent output port · ${EXECUTION_CONTRACT_RESULT_PORT}`,
            }
          : null,
        workflow: workContract.allowedToolKinds.includes('workflow')
          ? {
              ...commonTransport,
              inputLocation: 'Workflow text input · prompt',
              outputLocation: `Workflow output · ${EXECUTION_CONTRACT_RESULT_PORT}`,
            }
          : null,
        program: workContract.allowedToolKinds.includes('program')
          ? {
              ...commonTransport,
              inputLocation: `Environment variable · ${EXECUTION_CONTRACT_SCRIPT_INPUT_ENV} (large input: ${EXECUTION_CONTRACT_SCRIPT_INPUT_FILE_ENV})`,
              outputLocation: 'stdout · one JSON object',
            }
          : null,
      },
    }
    return {
      contractRef: guide.contractRef,
      guideJson: JSON.stringify(guide),
    }
  })

const legacyBuiltinAgentContractRefs: Readonly<
  Record<string, readonly { contractId: string; version: number }[]>
> = {
  'code-writing': [
    { contractId: 'development.analyze-implement', version: 1 },
    { contractId: 'development.repair-conflict', version: 1 },
  ],
  'problem-diagnosis': [{ contractId: 'development.classify-pipeline', version: 1 }],
  'pipeline-repair': [{ contractId: 'development.repair-pipeline', version: 1 }],
  'review-repair': [{ contractId: 'development.repair-feedback', version: 1 }],
  'conflict-repair': [{ contractId: 'development.repair-conflict', version: 1 }],
  'business-implementation': [{ contractId: 'development.analyze-implement', version: 1 }],
  'issue-repair': [{ contractId: 'development.analyze-implement', version: 1 }],
}

/**
 * Compatibility projection for built-in Agents seeded before executionContracts
 * became an explicit Agent field. The platform owns evaluation; the employee
 * type package owns this development-specific metadata interpretation.
 */
export function developmentImplicitAgentContractDeclarations(input: {
  readonly frontmatterExtra: Readonly<Record<string, unknown>>
}): readonly { readonly contractId: string; readonly version: number }[] {
  const template = input.frontmatterExtra.digitalEmployeeTemplate
  return typeof template === 'string' ? (legacyBuiltinAgentContractRefs[template] ?? []) : []
}

const primaryRole = (
  labelZh: string,
  labelEn: string,
  descriptionZh: string,
  descriptionEn: string,
) => [
  {
    roleRef: 'primary',
    label: text(labelZh, labelEn),
    description: text(descriptionZh, descriptionEn),
    order: 0,
    bindingSlots: [
      {
        slotRef: 'default',
        label: text('默认工具', 'Default tool'),
        description: text('此工作项的确定性执行工具', 'Deterministic executor for this work item'),
        required: true,
        cardinality: 'exactly-one' as const,
      },
    ],
  },
]

const optionalPrimaryRole = (
  labelZh: string,
  labelEn: string,
  descriptionZh: string,
  descriptionEn: string,
) => [
  {
    roleRef: 'primary',
    label: text(labelZh, labelEn),
    description: text(descriptionZh, descriptionEn),
    order: 0,
    bindingSlots: [
      {
        slotRef: 'default',
        label: text('外部 ID 取得工具', 'External ID acquisition tool'),
        description: text(
          '仅当任务输入外部需求或问题 ID 时使用',
          'Used only when a task starts from an external requirement or issue ID',
        ),
        required: false,
        cardinality: 'zero-or-one' as const,
      },
    ],
  },
]

const pipelineFailureTypeSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .refine((value) => value !== 'review', 'review is reserved for review feedback')

const orderedDispatchConfigurationRuntimeSchema = z
  .array(
    z
      .object({
        classifierWorkItemRef: z.string().min(1).max(160),
        routes: z
          .array(
            z
              .object({
                routeRef: pipelineFailureTypeSchema,
                displayName: z.string().min(1).max(200),
                description: z.string().max(2_000),
                destinationWorkItemRef: z.string().min(1).max(160),
                registrationRef: z
                  .object({ id: z.string().min(1), revision: z.number().int().positive() })
                  .strict()
                  .nullable(),
                fallback: z.boolean(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
  )
  .max(100)

const runtimePackage = {
  descriptor: {
    schemaVersion: 1,
    typeRef,
    displayName: text('开发数字员工', 'Development employee'),
    description: text(
      '负责需求开发、问题定位并提交 MR；随后持续看护检视、流水线和冲突，直到 MR 外部合入或关闭。',
      'Develops requirements, diagnoses problems, opens a merge request, and then watches reviews, pipelines, and conflicts until external merge or close.',
    ),
    workScopeContractId: 'development.repository-scope.v1',
    workScopeAuthoring: {
      schemaVersion: 1,
      label: text('负责范围', 'Responsibility scope'),
      description: text(
        '决定这名员工可以受理哪些仓库的工作。',
        'Determines which repositories this employee may accept work for.',
      ),
      variants: [
        {
          kind: 'repository',
          label: text('单个仓库', 'Repository'),
          description: text('只负责一个代码仓库', 'Owns work for one repository'),
          fields: [
            {
              fieldRef: 'repositoryId',
              label: text('仓库', 'Repository'),
              description: text('从平台已有仓库中选择', 'Choose an existing platform repository'),
              inputKind: 'repository-picker',
              required: true,
              placeholder: text('请选择仓库', 'Choose a repository'),
            },
          ],
        },
        {
          kind: 'repository-group',
          label: text('仓库组', 'Repository group'),
          description: text('负责一个仓库组中的工作', 'Owns work for a repository group'),
          fields: [
            {
              fieldRef: 'repositoryGroupId',
              label: text('仓库组', 'Repository group'),
              description: text('从平台已有仓库组中选择', 'Choose an existing repository group'),
              inputKind: 'repository-group-picker',
              required: true,
              placeholder: text('请选择仓库组', 'Choose a repository group'),
            },
          ],
        },
        {
          kind: 'task',
          label: text('任务启动时指定仓库', 'Choose repository when starting a task'),
          description: text(
            '员工不固定仓库，每次交给它工作时再选择目标仓库',
            'The employee is not bound to a repository; choose one for each new task',
          ),
          fields: [],
        },
      ],
    },
    workIntakeAuthoring: {
      schemaVersion: 1,
      label: text('交给员工一项工作', 'Give the employee work'),
      description: text(
        '可以写正文、上传并指定入库路径，或提交外部需求/问题 ID。',
        'Provide a body, upload files with repository target paths, or submit an external requirement or issue ID.',
      ),
      targetFields: [
        {
          fieldRef: 'repositoryId',
          label: text('目标仓库', 'Target repository'),
          description: text(
            '这项工作最终修改并提交到哪个仓库',
            'Repository that will receive the resulting change',
          ),
          inputKind: 'repository-picker',
          required: true,
          placeholder: text('请选择目标仓库', 'Choose the target repository'),
        },
      ],
      acceptedKinds: ['body', 'files', 'body-and-files', 'external-id'],
      kindRequirements: [
        { kind: 'external-id', workItemRef: 'prepare-materials', slotRef: 'default' },
      ],
      executionOptions: [
        {
          optionRef: 'review-implementation-plan',
          label: text('实现前评审方案', 'Review implementation plan'),
          description: text(
            '先输出实现方案，等待人工评论、驳回/迭代或批准，再开始修改代码',
            'Produce a plan and wait for human comments, iteration, or approval before changing code',
          ),
          defaultValue: false,
          requiredWorkItemRef: 'analyze-implement',
          requiredSlotRef: 'default',
          requiredExecutorKind: 'agent',
        },
      ],
      body: {
        label: text('需求或问题正文', 'Requirement or problem body'),
        description: text(
          '说明目标、现象和验收条件',
          'Describe the goal, symptoms, and acceptance criteria',
        ),
        placeholder: text('写下需要完成的工作…', 'Describe the work to be completed…'),
        maxBytes: 2 * 1024 * 1024,
      },
      files: {
        label: text('需求或问题文档', 'Requirement or problem documents'),
        description: text(
          '每个文件可选择随 MR 入库，或放入平台临时材料目录仅供分析与实现读取。',
          'Each file can be committed with the MR or placed in the platform temporary material directory for analysis and implementation only.',
        ),
        maxFiles: 200,
        maxFileBytes: 32 * 1024 * 1024,
        targetPathRequired: true,
        placementModes: ['repository', 'temporary'],
      },
      externalId: {
        label: text('外部需求或问题 ID', 'External requirement or issue ID'),
        description: text(
          '由当前工作项配置的取得工具下载对应多文件',
          'The current work item acquisition tool downloads the referenced multi-file work item',
        ),
        placeholder: text('例如 ISSUE-1234', 'For example ISSUE-1234'),
      },
    },
    workStartWorkItemRef: 'prepare-materials',
    workContracts: contracts,
    authoringManifest: {
      schemaVersion: 1,
      lifecycleRegions: [
        {
          regionId: 'delivery',
          label: text('需求开发与问题定位', 'Delivery and diagnosis'),
          description: text(
            '目标是形成一个可看护的 MR',
            'Produces a merge request that can be watched',
          ),
          order: 0,
          responsibilityLanes: [
            {
              laneId: 'delivery-main',
              label: text('交付主线', 'Delivery spine'),
              description: text('从工作材料到提交 MR', 'From work material to merge request'),
              order: 0,
              kind: 'spine',
            },
          ],
        },
        {
          regionId: 'care',
          label: text('MR 看护与修绿', 'MR care and repair'),
          description: text(
            '响应 review、流水线、冲突和生命周期事件，保持随时可合入',
            'Reacts to review, pipeline, conflict, and lifecycle events to keep the MR merge-ready',
          ),
          order: 1,
          responsibilityLanes: [
            {
              laneId: 'care-attention',
              label: text('MR 事件入口', 'MR event hub'),
              description: text(
                '订阅或扫描变化，再按事件进入对应职责',
                'Observe changes, then dispatch to the matching duty',
              ),
              order: 0,
              kind: 'spine',
            },
            {
              laneId: 'care-review',
              label: text('检视意见', 'Review feedback'),
              description: text('识别意见并完成修复', 'Classify and repair review feedback'),
              order: 10,
              kind: 'branch',
              optional: true,
            },
            {
              laneId: 'care-pipeline',
              label: text('流水线门禁', 'Pipeline gates'),
              description: text(
                '取得证据、归类失败，再按固定优先级逐类修绿',
                'Collect evidence, classify failures, then repair each type by fixed priority',
              ),
              order: 20,
              kind: 'branch',
              optional: true,
            },
            {
              laneId: 'care-conflict',
              label: text('代码冲突', 'Merge conflicts'),
              description: text(
                '修复冲突并刷新 MR head',
                'Repair conflicts and refresh the MR head',
              ),
              order: 30,
              kind: 'branch',
              optional: true,
            },
            {
              laneId: 'care-collaboration',
              label: text('员工协同', 'Employee collaboration'),
              description: text(
                '调起其他数字员工并等待其工作结果',
                'Invoke another digital employee and wait for its result',
              ),
              order: 40,
              kind: 'branch',
              optional: true,
            },
            {
              laneId: 'care-approval',
              label: text('外部审批门禁', 'External approval gate'),
              description: text(
                '独立准备、提交并等待外部系统审批',
                'Independently prepare, submit, and await external approval',
              ),
              order: 50,
              kind: 'branch',
              optional: true,
            },
            {
              laneId: 'care-readiness',
              label: text('合入判断', 'Merge readiness'),
              description: text(
                '持续判断随时可合入并等待 committer',
                'Stay merge-ready and await a committer',
              ),
              order: 60,
              kind: 'branch',
            },
          ],
        },
      ],
      workIngresses: [
        {
          ingressRef: 'ui-input',
          regionId: 'delivery',
          responsibilityLaneId: 'delivery-main',
          order: 0,
          label: text('界面输入', 'UI input'),
          valueLabel: text('任务', 'Task'),
          description: text(
            '从统一新建任务界面输入正文、文件或外部需求编号',
            'Enter a body, files, or an external requirement ID in unified task creation',
          ),
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
          label: text('ISSUE', 'ISSUE'),
          valueLabel: text('Webhook', 'Webhook'),
          description: text(
            '在 Webhook 自动化规则中把 ISSUE 事件交给这名数字员工',
            'Route ISSUE events to this employee with a Webhook automation rule',
          ),
          sourceClass: 'issue',
          eventTypeRefs: [
            { id: 'code-host.issue.labeled', revision: 1 },
            { id: 'code-host.issue.comment-received', revision: 1 },
          ],
          configurationSurface: 'event-response-rules',
          nextWorkItemRef: 'prepare-materials',
        },
      ],
      workItems: [
        {
          workItemRef: 'prepare-materials',
          regionId: 'delivery',
          responsibilityLaneId: 'delivery-main',
          order: 10,
          label: text('准备工作材料', 'Prepare work materials'),
          description: text(
            '取得正文、附件或外部问题单多文件',
            'Acquire body, attachments, or external work-item files',
          ),
          workContractRef: { contractId: 'development.prepare-materials', version: 1 },
          materialSummary: contracts[0]!.materialSummary,
          completionStandard: contracts[0]!.completionStandard,
          nodeKind: 'business-tool',
          toolRoleGroups: optionalPrimaryRole(
            '材料取得',
            'Material acquisition',
            '取得并规范化工作材料',
            'Acquire and normalize work materials',
          ),
          nextWorkItemRefs: ['analyze-implement'],
        },
        {
          workItemRef: 'analyze-implement',
          regionId: 'delivery',
          responsibilityLaneId: 'delivery-main',
          order: 20,
          label: text('分析并实现', 'Analyze and implement'),
          description: text(
            '理解需求或定位问题并形成代码修改',
            'Understand the request or diagnose the problem and produce code changes',
          ),
          workContractRef: { contractId: 'development.analyze-implement', version: 1 },
          materialSummary: contracts[1]!.materialSummary,
          completionStandard: contracts[1]!.completionStandard,
          nodeKind: 'business-tool',
          humanReview: {
            optionRef: 'review-implementation-plan',
            artifactPort: 'analysis-plan',
            label: text('人工审核修复计划', 'Human plan review'),
            description: text(
              '任务受理时可选择先评审实现方案，批准后才执行实现工具',
              'The task may require plan approval before its implementation tool runs',
            ),
            reviewedPath: {
              beforeReviewLabel: text('分析', 'Analyze'),
              afterApprovalLabel: text('实现', 'Implement'),
            },
          },
          toolRoleGroups: primaryRole(
            '实现者',
            'Implementer',
            '完成分析和代码实现',
            'Analyze and implement the change',
          ),
          nextWorkItemRefs: ['prepare-change'],
        },
        {
          workItemRef: 'prepare-change',
          regionId: 'delivery',
          responsibilityLaneId: 'delivery-main',
          order: 30,
          label: text('校验并冻结代码修改', 'Validate and freeze code changes'),
          description: text(
            '只校验 envelope 与工作区差异并冻结待提交快照，不 commit、不 push',
            'Validate the envelope and workspace delta, then freeze a pending snapshot without commit or push',
          ),
          workContractRef: { contractId: 'development.prepare-change', version: 1 },
          materialSummary: contracts[2]!.materialSummary,
          completionStandard: contracts[2]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['publish-mr'],
        },
        {
          workItemRef: 'publish-mr',
          regionId: 'delivery',
          responsibilityLaneId: 'delivery-main',
          order: 40,
          label: text('提交 MR', 'Publish merge request'),
          description: text(
            '平台负责 commit、CAS push 与 MR 创建',
            'The platform owns commit, CAS push, and MR creation',
          ),
          workContractRef: { contractId: 'development.publish-mr', version: 1 },
          materialSummary: contracts[3]!.materialSummary,
          completionStandard: contracts[3]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['observe-mr', 'reply-feedback'],
        },
        {
          workItemRef: 'observe-mr',
          regionId: 'care',
          responsibilityLaneId: 'care-attention',
          order: 50,
          label: text('关注 MR 状态', 'Observe merge request'),
          description: text(
            '自动订阅或主动扫描 review、流水线、冲突和生命周期',
            'Automatically subscribe to or scan review, pipeline, conflict, and lifecycle state',
          ),
          workContractRef: { contractId: 'development.observe-mr', version: 1 },
          materialSummary: contracts[4]!.materialSummary,
          completionStandard: contracts[4]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: [
            'classify-feedback',
            'collect-pipeline',
            'repair-conflict',
            'prepare-approval',
            'evaluate-ready',
          ],
        },
        {
          workItemRef: 'classify-feedback',
          regionId: 'care',
          responsibilityLaneId: 'care-review',
          order: 60,
          label: text('汇总待处理检视意见', 'Collect actionable review feedback'),
          description: text(
            '平台收集当前 MR 全部未处理、非自身意见并逐条形成问题集合',
            'The platform collects every unresolved non-self thread and creates one problem per thread',
          ),
          workContractRef: { contractId: 'development.classify-feedback', version: 1 },
          materialSummary: contracts[5]!.materialSummary,
          completionStandard: contracts[5]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['acknowledge-feedback'],
        },
        {
          workItemRef: 'acknowledge-feedback',
          regionId: 'care',
          responsibilityLaneId: 'care-review',
          order: 65,
          label: text('回复已收到', 'Acknowledge review feedback'),
          description: text(
            '平台逐线程回复固定收到消息，并以自身标记防止重复触发',
            'The platform acknowledges every thread and marks its own replies to prevent retriggering',
          ),
          workContractRef: { contractId: 'development.acknowledge-feedback', version: 1 },
          materialSummary: contracts[18]!.materialSummary,
          completionStandard: contracts[18]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['repair-feedback'],
        },
        {
          workItemRef: 'repair-feedback',
          regionId: 'care',
          responsibilityLaneId: 'care-review',
          order: 70,
          label: text('修复检视问题', 'Repair review feedback'),
          description: text(
            '按问题集合修改代码并重新发布',
            'Modify code for the problem set and republish',
          ),
          workContractRef: { contractId: 'development.repair-feedback', version: 1 },
          materialSummary: contracts[6]!.materialSummary,
          completionStandard: contracts[6]!.completionStandard,
          nodeKind: 'business-tool',
          inputMultiplicity: 'collection',
          toolRoleGroups: primaryRole(
            '问题修复者',
            'Problem repairer',
            '修复检视问题',
            'Repair review problems',
          ),
          nextWorkItemRefs: ['prepare-change'],
        },
        {
          workItemRef: 'reply-feedback',
          regionId: 'care',
          responsibilityLaneId: 'care-review',
          order: 75,
          label: text('回复修复结果', 'Reply with repair result'),
          description: text(
            '提交更新 MR 后，平台把 Agent 的逐线程处理说明回复到原意见',
            'After updating the MR, the platform replies to each thread with the Agent treatment',
          ),
          workContractRef: { contractId: 'development.reply-feedback', version: 1 },
          materialSummary: contracts[19]!.materialSummary,
          completionStandard: contracts[19]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['observe-mr'],
        },
        {
          workItemRef: 'collect-pipeline',
          regionId: 'care',
          responsibilityLaneId: 'care-pipeline',
          order: 80,
          label: text('取得流水线门禁', 'Collect pipeline gates'),
          description: text(
            '调用自建系统程序取得详细门禁和大日志',
            'Call system-specific programs for detailed gates and large logs',
          ),
          workContractRef: { contractId: 'development.collect-pipeline', version: 1 },
          materialSummary: contracts[7]!.materialSummary,
          completionStandard: contracts[7]!.completionStandard,
          nodeKind: 'business-tool',
          toolRoleGroups: primaryRole(
            '门禁采集器',
            'Gate collector',
            '程序化取得门禁事实',
            'Programmatically collect gate facts',
          ),
          nextWorkItemRefs: ['classify-pipeline', 'observe-mr'],
        },
        {
          workItemRef: 'classify-pipeline',
          regionId: 'care',
          responsibilityLaneId: 'care-pipeline',
          order: 90,
          label: text('归类流水线失败', 'Classify pipeline failures'),
          description: text(
            '按所选分类工具版本内的问题清单归类；清单顺序就是确定性处理优先级',
            'Classify against the selected tool revision problem list; list order is deterministic priority',
          ),
          workContractRef: { contractId: 'development.classify-pipeline', version: 1 },
          materialSummary: contracts[8]!.materialSummary,
          completionStandard: contracts[8]!.completionStandard,
          nodeKind: 'business-tool',
          orderedDispatchAuthoring: {
            label: text('流水线问题与处理方式', 'Pipeline problems and handlers'),
            description: text(
              '问题清单由分类工具定义；岗位只为派生问题选择兼容修复工具或协同员工',
              'The classifier tool defines the problem list; the job only selects a compatible repair tool or employee for each derived problem',
            ),
            destinationWorkItemRefs: ['repair-pipeline', 'delegate'],
          },
          toolRoleGroups: primaryRole(
            '问题识别者',
            'Problem recognizer',
            '识别流水线失败类型',
            'Recognize pipeline failure types',
          ),
          nextWorkItemRefs: ['repair-pipeline', 'delegate'],
        },
        {
          workItemRef: 'repair-pipeline',
          regionId: 'care',
          responsibilityLaneId: 'care-pipeline',
          order: 100,
          label: text('修复流水线问题', 'Repair pipeline failures'),
          description: text(
            '工具声明能解决的问题；岗位按分类工具清单逐类选择兼容处理者',
            'Tools declare the problems they solve; jobs select a compatible handler for each classifier-tool problem',
          ),
          workContractRef: { contractId: 'development.repair-pipeline', version: 1 },
          materialSummary: contracts[9]!.materialSummary,
          completionStandard: contracts[9]!.completionStandard,
          nodeKind: 'business-tool',
          toolRoleGroups: [
            {
              roleRef: 'repairer',
              label: text('问题修复', 'Problem repair'),
              description: text(
                '本工具显式声明可解决一个、多个或全部分类问题',
                'This tool explicitly declares that it solves one, multiple, or all classified problems',
              ),
              order: 0,
              bindingSlots: [],
            },
          ],
          nextWorkItemRefs: ['repair-pipeline', 'delegate', 'prepare-change'],
        },
        {
          workItemRef: 'repair-conflict',
          regionId: 'care',
          responsibilityLaneId: 'care-conflict',
          order: 110,
          label: text('修复代码冲突', 'Repair merge conflict'),
          description: text(
            '在平台准备的冲突现场中修复授权文件',
            'Repair authorized files in a platform-prepared conflict scene',
          ),
          workContractRef: { contractId: 'development.repair-conflict', version: 1 },
          materialSummary: contracts[10]!.materialSummary,
          completionStandard: contracts[10]!.completionStandard,
          nodeKind: 'business-tool',
          toolRoleGroups: primaryRole(
            '冲突修复者',
            'Conflict repairer',
            '修复代码冲突',
            'Repair merge conflicts',
          ),
          nextWorkItemRefs: ['publish-conflict'],
        },
        {
          workItemRef: 'publish-conflict',
          regionId: 'care',
          responsibilityLaneId: 'care-conflict',
          order: 115,
          label: text('提交冲突修复', 'Commit conflict repair'),
          description: text(
            '平台生成 merge commit、CAS 推送到远端并刷新 MR head',
            'The platform creates a merge commit, CAS-pushes it to the remote, and refreshes the MR head',
          ),
          workContractRef: { contractId: 'development.publish-conflict', version: 1 },
          materialSummary: contracts[14]!.materialSummary,
          completionStandard: contracts[14]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['observe-mr'],
        },
        {
          workItemRef: 'delegate',
          regionId: 'care',
          responsibilityLaneId: 'care-collaboration',
          order: 120,
          label: text('协同其他数字员工', 'Collaborate with another employee'),
          description: text(
            '异步调起其他员工并等待事件返回',
            'Invoke another employee asynchronously and wait for an event result',
          ),
          workContractRef: { contractId: 'development.delegate', version: 1 },
          materialSummary: contracts[11]!.materialSummary,
          completionStandard: contracts[11]!.completionStandard,
          nodeKind: 'collaboration',
          collaborationContractId: 'development.cross-repository-work',
          toolRoleGroups: [],
          nextWorkItemRefs: ['collect-pipeline'],
        },
        {
          workItemRef: 'prepare-approval',
          regionId: 'care',
          responsibilityLaneId: 'care-approval',
          order: 122,
          label: text('准备外部审批', 'Prepare external approval'),
          description: text(
            '根据当前 MR 门禁形成审批材料；执行工具不持有审批系统凭据',
            'Prepare approval material from current MR gates without approval credentials',
          ),
          workContractRef: { contractId: 'development.prepare-approval', version: 1 },
          materialSummary: contracts[15]!.materialSummary,
          completionStandard: contracts[15]!.completionStandard,
          nodeKind: 'business-tool',
          toolRoleGroups: primaryRole(
            '审批材料准备者',
            'Approval material preparer',
            '生成确定性的审批草稿 envelope',
            'Produce a deterministic approval-draft envelope',
          ),
          nextWorkItemRefs: ['submit-approval'],
        },
        {
          workItemRef: 'submit-approval',
          regionId: 'care',
          responsibilityLaneId: 'care-approval',
          order: 124,
          label: text('提交外部审批', 'Submit external approval'),
          description: text(
            '平台通过已注册审批程序按幂等键提交或认领审批',
            'Use the registered approval program to submit or adopt an approval idempotently',
          ),
          workContractRef: { contractId: 'development.submit-approval', version: 1 },
          materialSummary: contracts[16]!.materialSummary,
          completionStandard: contracts[16]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['observe-approval'],
        },
        {
          workItemRef: 'observe-approval',
          regionId: 'care',
          responsibilityLaneId: 'care-approval',
          order: 126,
          label: text('等待外部审批', 'Wait for external approval'),
          description: text(
            '事件中心按关注范围启动短轮询；无人关注时自动停止',
            'Event Center runs short observations only while the approval is subscribed',
          ),
          workContractRef: { contractId: 'development.observe-approval', version: 1 },
          materialSummary: contracts[17]!.materialSummary,
          completionStandard: contracts[17]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['observe-mr'],
        },
        {
          workItemRef: 'evaluate-ready',
          regionId: 'care',
          responsibilityLaneId: 'care-readiness',
          order: 130,
          label: text('判断是否随时可合入', 'Evaluate merge readiness'),
          description: text(
            '区分机器门禁、人工门禁和代码平台可合入状态',
            'Separate machine gates, human gates, and code-host mergeability',
          ),
          workContractRef: { contractId: 'development.evaluate-ready', version: 1 },
          materialSummary: contracts[12]!.materialSummary,
          completionStandard: contracts[12]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['wait-merge', 'observe-mr'],
        },
        {
          workItemRef: 'wait-merge',
          regionId: 'care',
          responsibilityLaneId: 'care-readiness',
          order: 140,
          label: text('等待审核合入', 'Wait for committer merge'),
          description: text(
            '平台不自动合入，只跟踪到外部 merged 或 closed',
            'The platform never auto-merges and only tracks external merge or close',
          ),
          workContractRef: { contractId: 'development.wait-merge', version: 1 },
          materialSummary: contracts[13]!.materialSummary,
          completionStandard: contracts[13]!.completionStandard,
          nodeKind: 'system',
          toolRoleGroups: [],
          nextWorkItemRefs: ['observe-mr'],
        },
      ],
    },
    contextTypes: [
      {
        typeId: 'development.issue-handling',
        schemaVersion: 1,
        displayName: text('需求或问题上下文', 'Requirement or problem context'),
        description: text(
          '保存工作材料、目标和来源追踪',
          'Stores work materials, target, and provenance',
        ),
        projectionFields: [
          { path: 'subjectRef', label: text('工作对象', 'Work item'), format: 'text' },
          { path: 'request.body', label: text('需求正文', 'Request body'), format: 'text' },
          { path: 'request.externalId', label: text('外部编号', 'External ID'), format: 'text' },
          {
            path: 'request.uploads',
            label: text('随代码提交的文件', 'Committed files'),
            format: 'count',
          },
        ],
      },
      {
        typeId: 'development.change-candidate',
        schemaVersion: 1,
        displayName: text('修改候选上下文', 'Change candidate context'),
        description: text(
          '保存平台独立计算的差异、树身份与发布状态',
          'Stores the platform-derived delta, tree identity, and publication state',
        ),
        projectionFields: [
          { path: 'changedPaths', label: text('修改文件', 'Changed files'), format: 'count' },
          { path: 'baselineSha', label: text('基线提交', 'Baseline'), format: 'short-hash' },
        ],
      },
      {
        typeId: 'development.merge-request',
        schemaVersion: 1,
        displayName: text('MR 上下文', 'Merge request context'),
        description: text(
          '保存 MR 身份、head 与关注范围',
          'Stores merge-request identity, head, and attention',
        ),
        projectionFields: [
          { path: 'mergeRequestRef', label: text('MR', 'MR'), format: 'text' },
          { path: 'headSha', label: text('当前提交', 'Current commit'), format: 'short-hash' },
          { path: 'readyToMerge', label: text('随时可合入', 'Ready to merge'), format: 'boolean' },
        ],
      },
      {
        typeId: 'development.pipeline',
        schemaVersion: 1,
        displayName: text('流水线上下文', 'Pipeline context'),
        description: text(
          '保存门禁摘要和大日志 artifact 引用',
          'Stores gate summaries and large-log artifact references',
        ),
        projectionFields: [
          { path: 'status', label: text('门禁结果', 'Gate result'), format: 'text' },
          { path: 'failureTypes', label: text('失败类型', 'Failure types'), format: 'list' },
          { path: 'headSha', label: text('对应提交', 'Commit'), format: 'short-hash' },
        ],
      },
      {
        typeId: 'development.problem-set',
        schemaVersion: 1,
        displayName: text('待处理问题集合', 'Problem set'),
        description: text(
          '保存检视或流水线问题类型、证据引用与尚未处理的工具槽位',
          'Stores review or pipeline problem types, evidence references, and remaining tool slots',
        ),
        projectionFields: [
          { path: 'problems', label: text('待处理问题', 'Open problems'), format: 'count' },
          { path: 'remainingTypes', label: text('剩余类型', 'Remaining types'), format: 'list' },
        ],
      },
      {
        typeId: 'development.delegation',
        schemaVersion: 1,
        displayName: text('协同上下文', 'Delegation context'),
        description: text(
          '保存跨员工调用与返回结果',
          'Stores cross-employee invocation and result',
        ),
        projectionFields: [
          { path: 'status', label: text('协作状态', 'Collaboration status'), format: 'text' },
          { path: 'members', label: text('协作员工', 'Collaborating employees'), format: 'count' },
        ],
      },
      {
        typeId: 'development.approval',
        schemaVersion: 1,
        displayName: text('外部审批上下文', 'External approval context'),
        description: text(
          '保存审批草稿、幂等提交回执、correlation、截止时间和最新观察状态',
          'Stores the approval draft, idempotent submission receipt, correlation, deadline, and latest observed state',
        ),
        projectionFields: [
          { path: 'status', label: text('审批状态', 'Approval status'), format: 'text' },
          { path: 'externalRequestRef', label: text('审批单', 'Approval request'), format: 'text' },
          { path: 'deadlineAt', label: text('等待截止', 'Wait deadline'), format: 'timestamp' },
        ],
      },
    ],
    eventSources: [
      {
        sourceId: 'code-host.activity',
        version: 1,
        ownerTypeId: 'integration.code-host',
        displayName: text('代码平台', 'Code platform'),
        description: text(
          '通过 Webhook 实时接收变化，并在有人关注时用短轮询补齐权威状态。',
          'Receives real-time changes through webhooks and reconciles authoritative state by short polling while subscribed.',
        ),
        observationMode: 'hybrid',
        observerProgramRef: { id: 'builtin:development-code-host-observer', revision: 1 },
        pollIntervalMs: 30_000,
        batchSize: 100,
      },
      {
        sourceId: 'employee.channel',
        version: 1,
        displayName: text('数字员工协同通道', 'Digital employee collaboration channel'),
        description: text(
          '传递子员工公开里程碑与完成结果',
          'Carries child employee milestones and completion results',
        ),
        observationMode: 'passive',
        observerProgramRef: null,
        pollIntervalMs: 60_000,
        batchSize: 100,
      },
      {
        sourceId: 'development.approval-state',
        version: 1,
        displayName: text('外部审批状态观察', 'External approval state observation'),
        description: text(
          '只在有数字员工关注审批时启动已注册程序进行短轮询',
          'Runs the registered short observer only while an employee subscribes to the approval',
        ),
        observationMode: 'hybrid',
        observerProgramRef: { id: 'builtin:development-approval-observer', revision: 1 },
        pollIntervalMs: 30_000,
        batchSize: 100,
      },
    ],
    eventTypes: [
      {
        eventTypeId: 'development.review-updated',
        version: 2,
        subjectTypeId: 'merge-request',
        payloadSchemaId: 'development.review.event.v1',
        displayName: text('MR 检视意见有更新', 'MR review feedback updated'),
        description: text(
          '出现新的或发生变化的检视意见',
          'New or changed review feedback is available',
        ),
        deliveryClass: 'review',
        sourceRef: { id: 'code-host.activity', revision: 1 },
        catalogVisibility: 'internal',
        triggerParameters: null,
      },
      {
        eventTypeId: 'development.conflict-updated',
        version: 2,
        subjectTypeId: 'merge-request',
        payloadSchemaId: 'development.conflict.event.v1',
        displayName: text('MR 冲突状态有更新', 'MR conflict state updated'),
        description: text(
          '目标分支变化导致冲突出现或消失',
          'Target branch changes introduced or cleared a conflict',
        ),
        deliveryClass: 'conflict',
        sourceRef: { id: 'code-host.activity', revision: 1 },
        catalogVisibility: 'internal',
        triggerParameters: null,
      },
      {
        eventTypeId: 'development.lifecycle-updated',
        version: 2,
        subjectTypeId: 'merge-request',
        payloadSchemaId: 'development.lifecycle.event.v1',
        displayName: text('MR 生命周期有更新', 'MR lifecycle updated'),
        description: text(
          'MR 已合入、关闭、重新打开或 head 发生变化',
          'The MR was merged, closed, reopened, or moved to another head',
        ),
        deliveryClass: 'terminal',
        sourceRef: { id: 'code-host.activity', revision: 1 },
        catalogVisibility: 'internal',
        triggerParameters: null,
      },
      {
        eventTypeId: 'development.pipeline-check-due',
        version: 1,
        subjectTypeId: 'merge-request',
        payloadSchemaId: 'development.pipeline-check-due.v1',
        displayName: text('MR 门禁复核到期', 'MR gate recheck due'),
        description: text(
          '下一次主动门禁复核时间已经到达，只用于唤醒正在关注此 MR 的数字员工',
          'The next active gate recheck is due; this only wakes employees already watching the MR',
        ),
        deliveryClass: 'pipeline',
        sourceRef: { id: 'code-host.activity', revision: 1 },
        catalogVisibility: 'internal',
        triggerParameters: null,
      },
      {
        eventTypeId: 'development.employee-result',
        version: 1,
        subjectTypeId: 'employee-invocation',
        payloadSchemaId: 'employee.invocation-result.v1',
        displayName: text('协同员工返回结果', 'Collaborating employee returned a result'),
        description: text(
          '被调起的数字员工返回了可重验的里程碑或终态结果',
          'An invoked employee returned a revalidatable milestone or terminal result',
        ),
        deliveryClass: 'collaboration',
        priority: 600,
        sourceRef: { id: 'employee.channel', revision: 1 },
        catalogVisibility: 'internal',
        triggerParameters: null,
      },
      {
        eventTypeId: 'development.approval-updated',
        version: 1,
        subjectTypeId: 'external-approval',
        payloadSchemaId: 'development.approval-observation.v1',
        displayName: text('外部审批状态有更新', 'External approval status updated'),
        description: text(
          '审批系统返回了新的权威 revision 或终态',
          'The approval system returned a new authoritative revision or terminal state',
        ),
        deliveryClass: 'approval',
        priority: 850,
        sourceRef: { id: 'development.approval-state', revision: 1 },
        catalogVisibility: 'internal',
        triggerParameters: null,
      },
      {
        eventTypeId: 'approval.status.changed',
        version: 1,
        subjectTypeId: 'external-approval',
        payloadSchemaId: 'approval.status-change.v1',
        displayName: text('外部审批状态已变化', 'External approval status changed'),
        description: text(
          '外部审批系统返回了新的权威状态或修订',
          'An external approval system returned a new authoritative status or revision',
        ),
        deliveryClass: 'approval-business-event',
        sourceRef: { id: 'development.approval-state', revision: 1 },
        triggerParameters: triggerContract('approval', [
          ['subject_ref', '审批对象', 'Approval subject'],
        ]),
      },
    ],
    attentionRules: [
      {
        ruleId: 'watch-merge-request',
        contextTypeId: 'development.merge-request',
        whenState: 'active',
        subscriptions: [
          {
            eventTypeId: 'development.review-updated',
            subjectPath: '$.mergeRequestRef',
            sourceProfileRef: null,
            deliveryClass: 'review',
          },
          {
            eventTypeId: 'development.pipeline-check-due',
            subjectPath: '$.mergeRequestRef',
            sourceProfileRef: null,
            deliveryClass: 'pipeline',
          },
          {
            eventTypeId: 'development.conflict-updated',
            subjectPath: '$.mergeRequestRef',
            sourceProfileRef: null,
            deliveryClass: 'conflict',
          },
          {
            eventTypeId: 'development.lifecycle-updated',
            subjectPath: '$.mergeRequestRef',
            sourceProfileRef: null,
            deliveryClass: 'terminal',
          },
        ],
      },
      {
        ruleId: 'watch-delegation',
        contextTypeId: 'development.delegation',
        whenState: 'active',
        subscriptions: [
          {
            eventTypeId: 'development.employee-result',
            subjectPath: '$.invocationRef',
            sourceProfileRef: null,
            deliveryClass: 'collaboration',
          },
        ],
      },
      {
        ruleId: 'watch-external-approval',
        contextTypeId: 'development.approval',
        whenState: 'active',
        subscriptions: [
          {
            eventTypeId: 'development.approval-updated',
            subjectPath: '$.subjectRef',
            sourceProfileRef: null,
            deliveryClass: 'approval',
          },
        ],
      },
    ],
    reactionRules: [
      {
        ruleId: 'handle-review',
        eventTypeId: 'development.review-updated',
        priority: 900,
        preemptsContinuation: true,
        requiredContextTypes: ['development.issue-handling', 'development.merge-request'],
        capabilityWorkItemRef: 'classify-feedback',
        workItemRef: 'observe-mr',
        slotRef: 'system',
        allowedEffectKinds: [],
      },
      {
        ruleId: 'handle-pipeline',
        eventTypeId: 'development.pipeline-check-due',
        priority: 700,
        preemptsContinuation: false,
        requiredContextTypes: ['development.issue-handling', 'development.merge-request'],
        workItemRef: 'collect-pipeline',
        slotRef: 'default',
        allowedEffectKinds: [],
      },
      {
        ruleId: 'handle-conflict',
        eventTypeId: 'development.conflict-updated',
        priority: 800,
        preemptsContinuation: true,
        requiredContextTypes: ['development.issue-handling', 'development.merge-request'],
        capabilityWorkItemRef: 'repair-conflict',
        workItemRef: 'observe-mr',
        slotRef: 'system',
        allowedEffectKinds: [],
      },
      {
        ruleId: 'handle-lifecycle',
        eventTypeId: 'development.lifecycle-updated',
        priority: 1_000,
        preemptsContinuation: true,
        requiredContextTypes: ['development.merge-request'],
        workItemRef: 'observe-mr',
        slotRef: 'system',
        allowedEffectKinds: [],
      },
      {
        ruleId: 'handle-employee-result',
        eventTypeId: 'development.employee-result',
        priority: 600,
        preemptsContinuation: false,
        requiredContextTypes: ['development.delegation'],
        workItemRef: 'delegate',
        slotRef: 'collaboration',
        allowedEffectKinds: [],
      },
      {
        ruleId: 'handle-approval-update',
        eventTypeId: 'development.approval-updated',
        priority: 850,
        preemptsContinuation: true,
        requiredContextTypes: ['development.approval'],
        workItemRef: 'observe-approval',
        slotRef: 'system',
        allowedEffectKinds: ['external-approval.observe'],
      },
    ],
    invocationContracts: [
      {
        contractId: 'development.cross-repository-work',
        inputSchemaId: 'development.delegated-work.v1',
        resultSchemaId: 'development.delegated-result.v1',
        milestoneEventTypeIds: ['development.employee-result'],
      },
    ],
  },

  parseWorkScope(input: unknown): unknown {
    return scopeSchema.parse(input)
  },

  summarizeWorkScope(scope: unknown, locale: 'zh-CN' | 'en-US'): string {
    const parsed = scopeSchema.parse(scope)
    if (parsed.kind === 'task')
      return locale === 'zh-CN' ? '任务启动时指定仓库' : 'Repository chosen at task launch'
    if (parsed.kind === 'repository') {
      return locale === 'zh-CN'
        ? `仓库：${parsed.repositoryId}`
        : `Repository: ${parsed.repositoryId}`
    }
    return locale === 'zh-CN'
      ? `仓库组：${parsed.repositoryGroupId}`
      : `Repository group: ${parsed.repositoryGroupId}`
  },

  validateContractFixture(input: {
    readonly contract: WorkContract
    readonly implementation: ToolImplementation
  }): readonly ContractValidationCheck[] {
    const checks: ContractValidationCheck[] = [
      {
        code: 'tool-kind-allowed',
        ok: input.contract.allowedToolKinds.includes(input.implementation.kind),
        detail: input.contract.allowedToolKinds.includes(input.implementation.kind)
          ? `${input.implementation.kind} is allowed`
          : `${input.implementation.kind} is not allowed by ${input.contract.contractId}`,
      },
      {
        code: 'input-schema-declared',
        ok: input.contract.inputSchemaId.length > 0,
        detail: input.contract.inputSchemaId,
      },
      {
        code: 'output-schema-declared',
        ok: input.contract.outputSchemaId.length > 0,
        detail: input.contract.outputSchemaId,
      },
      {
        code: 'semantic-validator-declared',
        ok: input.contract.semanticValidatorId.length > 0,
        detail: input.contract.semanticValidatorId,
      },
    ]
    if (input.implementation.kind === 'program') {
      checks.push({
        code: 'program-artifact-digest',
        ok: /^[a-f0-9]{64}$/.test(input.implementation.executableDigest),
        detail: input.implementation.executableArtifactRef,
      })
    }
    return checks
  },
}

export const developmentEmployeeTypePackage: EmployeeTypePackageRegistration = {
  descriptorJson: JSON.stringify(runtimePackage.descriptor),
  parseWorkScopeJson(inputJson) {
    return JSON.stringify(runtimePackage.parseWorkScope(JSON.parse(inputJson) as unknown))
  },
  summarizeWorkScopeJson(scopeJson, locale) {
    return runtimePackage.summarizeWorkScope(JSON.parse(scopeJson) as unknown, locale)
  },
  validateContractFixtureJson(requestJson) {
    const request = JSON.parse(requestJson) as {
      readonly contract: WorkContract
      readonly implementation: ToolImplementation
    }
    return JSON.stringify(runtimePackage.validateContractFixture(request))
  },
}

const uploadSeedSchema = z
  .object({
    artifactRef: z.string().min(1).max(1_000),
    placement: z.enum(['repository', 'temporary']).default('repository'),
    targetPath: z
      .string()
      .min(1)
      .max(1_000)
      .refine(
        (value) =>
          !value.startsWith('/') &&
          !/^[a-zA-Z]:[\\/]/.test(value) &&
          !value.includes('\\') &&
          value
            .split('/')
            .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
      ),
    originalName: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    const root = value.targetPath.split('/')[0]?.toLowerCase()
    if (value.placement === 'repository' && (root === '.git' || root === PLATFORM_WORKSPACE_DIR)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetPath'],
        message: 'repository upload path overlaps a platform-owned path',
      })
    }
    if (
      value.placement === 'temporary' &&
      !value.targetPath.startsWith(`${PLATFORM_WORKSPACE_DIR}/inputs/requirements/`)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetPath'],
        message: 'temporary upload path must be allocated under the platform requirement root',
      })
    }
  })

const deliveryContentSchema = z
  .object({
    commitMessage: z.string().trim().min(1).max(5_000),
    mergeRequestTitle: z.string().trim().min(1).max(240),
    mergeRequestDescription: z.string().trim().min(1).max(32_000),
  })
  .strict()

export const issueHandlingContextSchema = z
  .object({
    status: z.enum(['active', 'waiting', 'terminal']),
    subjectRef: z.string().min(1).max(1_000),
    repositoryRef: z.string().min(1).max(500),
    request: z
      .object({
        kind: z.enum(['body', 'files', 'body-and-files', 'external-id']),
        body: z
          .string()
          .min(1)
          .max(2 * 1024 * 1024)
          .nullable(),
        externalId: z.string().min(1).max(500).nullable(),
        uploads: z.array(uploadSeedSchema).max(200),
        executionOptions: z.record(z.string().min(1).max(160), z.boolean()).default({}),
      })
      .strict(),
    materialArtifactRefs: z.array(z.string().min(1).max(1_000)).max(500),
    deliveryContent: deliveryContentSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const needsBody = value.request.kind === 'body' || value.request.kind === 'body-and-files'
    const needsFiles = value.request.kind === 'files' || value.request.kind === 'body-and-files'
    if (needsBody && value.request.body === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'body is required for this intake kind',
      })
    }
    if (needsFiles && value.request.uploads.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'uploads are required for this intake kind',
      })
    }
    if (value.request.kind === 'external-id' && value.request.externalId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'externalId is required' })
    }
  })

const reviewThreadContextSchema = z
  .object({
    threadRef: z.string().min(1).max(500),
    revision: z.string().min(1).max(500),
    authorClass: z.enum(['human', 'bot', 'self']),
    resolved: z.boolean(),
    body: z.string().max(32_000),
    path: z.string().min(1).max(1_000).nullable(),
    messages: z
      .array(
        z
          .object({
            messageRef: z.string().min(1).max(500),
            parentMessageRef: z.string().min(1).max(500).nullable(),
            authorClass: z.enum(['human', 'bot', 'self']),
            body: z.string().max(32_000),
            path: z.string().min(1).max(1_000).nullable(),
            createdAt: z.string().nullable(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict()

export const mergeRequestContextSchema = z
  .object({
    status: z.enum(['active', 'merged', 'closed']),
    mergeRequestRef: z.string().min(1).max(1_000),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    issueHandlingContextRef: z.string().min(1).max(500),
    readyToMerge: z.boolean(),
    factsHeadSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable()
      .default(null),
    targetSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable()
      .default(null),
    draft: z.boolean().default(false),
    mergeableState: z.enum(['mergeable', 'conflict', 'unknown']).default('unknown'),
    approvalHold: z.boolean().nullable().default(null),
    unresolvedReviewCount: z.number().int().nonnegative().default(0),
    reviewThreads: z.array(reviewThreadContextSchema).max(100).default([]),
    repositoryRef: z.string().min(1).max(500).nullable().default(null),
    providerMrRef: z.string().min(1).max(500).nullable().default(null),
    sourceBranch: z.string().min(1).max(500).nullable().default(null),
    targetBranch: z.string().min(1).max(500).nullable().default(null),
    webUrl: z.string().url().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const actionableReviews = (value.reviewThreads ?? []).filter(
      (thread) => !thread.resolved && thread.authorClass !== 'self',
    ).length
    if (value.unresolvedReviewCount !== actionableReviews) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unresolvedReviewCount does not match actionable reviewThreads',
      })
    }
  })

const changeCandidateContextSchema = z
  .object({
    status: z.enum(['prepared', 'committed', 'published', 'obsolete']),
    candidateRef: z.string().regex(/^[a-f0-9]{64}$/),
    baselineSha: z.string().regex(/^[a-f0-9]{40}$/),
    treeOid: z.string().regex(/^[a-f0-9]{40,64}$/),
    summarySource: z.string().min(1).max(5_000),
    changedPaths: z.array(z.string().min(1).max(1_000)).max(5_000),
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
  })
  .strict()

const pipelineContextSchema = z
  .object({
    status: z.enum(['pending', 'passed', 'failed']),
    mergeRequestRef: z.string().min(1).max(1_000),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    evidenceArtifactRef: z.string().regex(/^\.agent-workflow\/pipeline\/[a-zA-Z0-9._-]+\//),
    failureTypes: z.array(pipelineFailureTypeSchema),
  })
  .strict()

const problemTypeSchema = z.union([z.literal('review'), pipelineFailureTypeSchema])

export const problemSetContextSchema = z
  .object({
    status: z.enum(['active', 'resolved']),
    source: z.enum(['review', 'pipeline']),
    headSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    remainingTypes: z.array(problemTypeSchema).max(20),
    problems: z
      .array(
        z
          .object({
            problemId: z.string().min(1).max(500),
            type: problemTypeSchema,
            summary: z.string().min(1).max(2_000),
            evidenceArtifactRefs: z.array(z.string().min(1).max(1_000)).max(100),
            reviewThread: reviewThreadContextSchema.nullable().default(null),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const type of value.remainingTypes) {
      if (
        (value.source === 'review' && type !== 'review') ||
        (value.source === 'pipeline' && type === 'review')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${type} is invalid for ${value.source}`,
        })
      }
      if (seen.has(type)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate remaining type: ${type}` })
      }
      seen.add(type)
    }
    if (value.status === 'resolved' && value.remainingTypes.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'resolved problem set still has remaining types',
      })
    }
    if (value.status === 'active' && value.remainingTypes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'active problem set has no remaining type',
      })
    }
    for (const problem of value.problems) {
      if (value.source === 'review' && problem.reviewThread === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `review problem ${problem.problemId} has no complete thread snapshot`,
        })
      }
      if (value.source === 'pipeline' && problem.reviewThread !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pipeline problem ${problem.problemId} cannot carry a review thread`,
        })
      }
    }
  })

const reviewReplyReceiptSchema = z
  .object({
    marker: z.string().min(1).max(1_000),
    noteRef: z.string().min(1).max(500),
  })
  .strict()

export const reviewResolutionContextSchema = z
  .object({
    status: z.enum(['collected', 'acknowledged', 'prepared', 'replied']),
    mergeRequestRef: z.string().min(1).max(1_000),
    sourceHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
    publishedHeadSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    threads: z
      .array(
        z
          .object({
            threadRef: z.string().min(1).max(500),
            revision: z.string().min(1).max(500),
            acknowledgement: reviewReplyReceiptSchema.nullable(),
            disposition: z.enum(['addressed', 'needs-human']).nullable(),
            replyBody: z.string().min(1).max(8_000).nullable(),
            finalReply: reviewReplyReceiptSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const refs = new Set<string>()
    for (const [index, thread] of value.threads.entries()) {
      const key = `${thread.threadRef}\u0000${thread.revision}`
      if (refs.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['threads', index],
          message: 'duplicate review thread revision',
        })
      }
      refs.add(key)
      if (value.status !== 'collected' && thread.acknowledgement === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['threads', index, 'acknowledgement'],
          message: 'acknowledgement is required after collection',
        })
      }
      if (
        (value.status === 'prepared' || value.status === 'replied') &&
        (thread.disposition === null || thread.replyBody === null)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['threads', index],
          message: 'prepared review repair requires a disposition and reply body',
        })
      }
      if (value.status === 'replied' && thread.finalReply === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['threads', index, 'finalReply'],
          message: 'final reply receipt is required after publishing',
        })
      }
    }
    if (
      value.status === 'replied' &&
      (value.publishedHeadSha === null || value.commitSha === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'replied review resolution must identify the published commit',
      })
    }
  })

const delegationContextSchema = z
  .object({
    status: z.enum(['requested', 'waiting', 'satisfied', 'failed']),
    groupRef: z.string().min(1).max(500),
    joinMode: z.enum(['all', 'any', 'quorum']),
    quorum: z.number().int().positive().nullable(),
    members: z
      .array(
        z
          .object({
            memberRef: z.string().min(1).max(160),
            invocationRef: z.string().min(1).max(500),
            targetEmployeeRef: z.string().min(1).max(500),
            state: z.enum(['waiting', 'satisfied', 'failed', 'detached']),
            resultArtifactRefs: z.array(z.string().min(1).max(1_000)).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    resultArtifactRefs: z.array(z.string().min(1).max(1_000)).max(200),
  })
  .strict()

export const approvalContextSchema = z
  .object({
    status: z.enum(['draft', 'pending', 'approved', 'rejected', 'expired', 'unavailable']),
    mergeRequestRef: z.string().min(1).max(1_000).nullable().default(null),
    headSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable()
      .default(null),
    approvalType: z.string().min(1).max(120),
    adapterRef: z
      .object({ id: z.string().min(1).max(500), revision: z.number().int().positive() })
      .strict(),
    validatedDraftRef: z.string().min(1).max(500),
    subjectRef: z.string().min(1).max(1_000).nullable(),
    deadlineAt: z.string().datetime({ offset: true }).nullable(),
    idempotencyKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    correlationRef: z.string().min(1).max(500).nullable(),
    externalRequestRef: z.string().min(1).max(500).nullable(),
    submittedRevision: z.string().min(1).max(500).nullable(),
    observedRevision: z.string().min(1).max(500).nullable(),
    evidenceRef: z.string().min(1).max(1_000).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status !== 'draft') {
      for (const [key, field] of [
        ['subjectRef', value.subjectRef],
        ['deadlineAt', value.deadlineAt],
        ['idempotencyKey', value.idempotencyKey],
        ['correlationRef', value.correlationRef],
        ['externalRequestRef', value.externalRequestRef],
        ['submittedRevision', value.submittedRevision],
      ] as const) {
        if (field === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required` })
        }
      }
    }
  })

const contextSchemas: Record<string, z.ZodTypeAny> = {
  'development.issue-handling': issueHandlingContextSchema,
  'development.change-candidate': changeCandidateContextSchema,
  'development.merge-request': mergeRequestContextSchema,
  'development.pipeline': pipelineContextSchema,
  'development.problem-set': problemSetContextSchema,
  'development.review-resolution': reviewResolutionContextSchema,
  'development.delegation': delegationContextSchema,
  'development.approval': approvalContextSchema,
}

const reactionOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    roundRef: z.string().min(1),
    executionNonce: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['ok', 'needs-input', 'blocked']),
    summary: z.string().min(1).max(5_000),
    deliveryContent: deliveryContentSchema.nullable().optional(),
    reviewReplies: z
      .array(
        z
          .object({
            threadRef: z.string().min(1).max(500),
            revision: z.string().min(1).max(500),
            disposition: z.enum(['addressed', 'needs-human']),
            replyBody: z.string().trim().min(1).max(8_000),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    contextPatches: z
      .array(
        z
          .object({
            contextId: z.string().min(1).max(200).nullable(),
            contextTypeId: z.string().min(1).max(200),
            schemaVersion: z.number().int().positive(),
            expectedRevision: z.number().int().positive().nullable(),
            lifecycleState: z.enum(['active', 'waiting', 'terminal']),
            stateJson: z
              .string()
              .min(2)
              .max(2 * 1024 * 1024),
            artifactRefs: z.array(z.string().min(1).max(1_000)).max(500),
          })
          .strict(),
      )
      .max(50),
    effectSuggestions: z.array(z.string().min(1).max(200)).max(50),
    artifactRefs: z.array(z.string().min(1).max(1_000)).max(500),
  })
  .strict()

const reactionInputEnvelopeSchema = z
  .object({
    contextsJson: z.string().min(2),
    contractInput: z.unknown().default({}),
  })
  .passthrough()

const reactionContextRecordSchema = z
  .object({ typeId: z.string().min(1), stateJson: z.string().min(2) })
  .passthrough()

const initialCaseRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseRef: z.string().min(1).max(200),
    employeeRef: z
      .object({ id: z.string().min(1).max(200), revision: z.number().int().positive() })
      .strict(),
    workScopeJson: z.string().min(2),
    receivedAt: z.number().int().nonnegative(),
    intake: z
      .object({
        kind: z.enum(['body', 'files', 'body-and-files', 'external-id']),
        target: z.record(z.string(), z.string()),
        body: z.string().min(1).nullable(),
        externalId: z.string().min(1).nullable(),
        idempotencyKey: z.string().min(1).max(500),
        executionOptions: z.record(z.string().min(1).max(160), z.boolean()).default({}),
        uploads: z.array(
          z
            .object({
              uploadRef: z.string().min(1),
              blobRef: z.string().min(1),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              bytes: z.number().int().positive(),
              originalName: z.string().min(1),
              placement: z.enum(['repository', 'temporary']).default('repository'),
              targetPath: z.string().min(1),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict()

const invokedCaseRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    invocationRef: z.string().min(1),
    parentCaseRef: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
    targetEmployeeRef: z
      .object({ id: z.string().min(1), revision: z.number().int().positive() })
      .strict(),
    targetWorkScopeJson: z.string().min(2),
    inputEnvelopeJson: z.string().min(2),
    receivedAt: z.number().int().nonnegative(),
  })
  .strict()

const invocationOutputRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    roundRef: z.string().min(1),
    executionNonce: z.string().regex(/^[a-f0-9]{64}$/),
    invocationRef: z.string().min(1),
    targetEmployeeRef: z
      .object({ id: z.string().min(1), revision: z.number().int().positive() })
      .strict(),
    invocations: z
      .array(
        z
          .object({
            memberRef: z.string().min(1),
            invocationRef: z.string().min(1),
            targetEmployeeRef: z
              .object({ id: z.string().min(1), revision: z.number().int().positive() })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(16)
      .optional(),
    joinMode: z.enum(['all', 'any', 'quorum']).optional(),
    quorum: z.number().int().positive().nullable().optional(),
    contextsJson: z.string().min(2),
    resultEnvelopeJson: z.string().min(2).optional(),
    joinResultEnvelopeJson: z.string().min(2).optional(),
  })
  .strict()

const employeeChannelResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    invocationRef: z.string().min(1),
    channelRef: z.string().min(1),
    childCaseRef: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
    state: z.enum(['satisfied', 'failed']),
    terminalKind: z.string().min(1),
    summary: z.string().min(1),
    contextRefs: z.array(
      z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict(),
    ),
    artifactRefs: z.array(z.string().min(1)),
  })
  .strict()

const employeeInvocationJoinResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    groupRef: z.string().min(1),
    joinMode: z.enum(['all', 'any', 'quorum']),
    quorum: z.number().int().positive().nullable(),
    state: z.enum(['waiting', 'satisfied', 'failed']),
    summary: z.string().min(1),
    members: z
      .array(
        z
          .object({
            memberRef: z.string().min(1),
            invocationRef: z.string().min(1),
            targetEmployeeRef: z
              .object({ id: z.string().min(1), revision: z.number().int().positive() })
              .strict(),
            state: z.enum(['waiting', 'satisfied', 'failed', 'detached']),
            resultEnvelopeJson: z.string().min(2).nullable(),
          })
          .strict(),
      )
      .min(1),
    artifactRefs: z.array(z.string().min(1)),
  })
  .strict()

export const developmentEmployeeRuntimeCodec: EmployeeTypeRuntimeCodec = {
  typeId: 'development',
  buildInitialCaseJson(requestJson) {
    const request = initialCaseRequestSchema.parse(JSON.parse(requestJson) as unknown)
    const scope = runtimeScopeSchema.parse(JSON.parse(request.workScopeJson) as unknown)
    const requestedRepositoryRef = request.intake.target.repositoryId
    const repositoryRef = scope.kind === 'repository' ? scope.repositoryId : requestedRepositoryRef
    if (repositoryRef === undefined || repositoryRef.length === 0) {
      throw new Error('development work intake requires a target repository')
    }
    if (
      scope.kind === 'repository' &&
      requestedRepositoryRef !== undefined &&
      requestedRepositoryRef !== '' &&
      requestedRepositoryRef !== scope.repositoryId
    ) {
      throw new Error('target repository is outside the employee responsibility scope')
    }
    const artifactRefs = request.intake.uploads.map((upload) => `employee-input:${upload.blobRef}`)
    const subjectRef =
      request.intake.kind === 'external-id'
        ? `${repositoryRef}:${request.intake.externalId!}`
        : `case:${request.caseRef}`
    const primaryContext = issueHandlingContextSchema.parse({
      status: 'active',
      subjectRef,
      repositoryRef,
      request: {
        kind: request.intake.kind,
        body: request.intake.body,
        externalId: request.intake.externalId,
        executionOptions: request.intake.executionOptions,
        uploads: request.intake.uploads.map((upload) => ({
          artifactRef: `employee-input:${upload.blobRef}`,
          placement: upload.placement,
          targetPath: upload.targetPath,
          originalName: upload.originalName,
        })),
      },
      materialArtifactRefs: artifactRefs,
    })
    return JSON.stringify({
      employeeRef: request.employeeRef,
      primaryContextTypeId: 'development.issue-handling',
      primaryContextSchemaVersion: 1,
      primaryContextState: 'active',
      primaryContextJson: JSON.stringify(primaryContext),
      artifactRefs,
      workSubject: { typeId: 'work-request', subjectRef },
    })
  },
  buildInvokedCaseJson(requestJson) {
    const request = invokedCaseRequestSchema.parse(JSON.parse(requestJson) as unknown)
    const scope = runtimeScopeSchema.parse(JSON.parse(request.targetWorkScopeJson) as unknown)
    const parentEnvelope = z
      .object({ contextsJson: z.string().min(2) })
      .passthrough()
      .parse(JSON.parse(request.inputEnvelopeJson) as unknown)
    const parentContexts = z
      .array(z.object({ typeId: z.string(), stateJson: z.string() }).passthrough())
      .parse(JSON.parse(parentEnvelope.contextsJson) as unknown)
    const parentIssueContext = parentContexts.find(
      (context) => context.typeId === 'development.issue-handling',
    )
    if (parentIssueContext === undefined) {
      throw new Error('delegated development work requires an issue-handling context')
    }
    const parentIssue = issueHandlingContextSchema.parse(
      JSON.parse(parentIssueContext.stateJson) as unknown,
    )
    const repositoryRef =
      scope.kind === 'repository' ? scope.repositoryId : parentIssue.repositoryRef
    const primaryContext = issueHandlingContextSchema.parse({
      ...parentIssue,
      status: 'active',
      subjectRef: `invocation:${request.invocationRef}`,
      repositoryRef,
    })
    return JSON.stringify({
      employeeRef: request.targetEmployeeRef,
      primaryContextTypeId: 'development.issue-handling',
      primaryContextSchemaVersion: 1,
      primaryContextState: 'active',
      primaryContextJson: JSON.stringify(primaryContext),
      artifactRefs: parentIssue.materialArtifactRefs,
      workSubject: {
        typeId: 'work-request',
        subjectRef: `invocation:${request.invocationRef}`,
      },
    })
  },
  buildInvocationStartedOutputJson(requestJson) {
    const request = invocationOutputRequestSchema.parse(JSON.parse(requestJson) as unknown)
    const invocations = request.invocations ?? [
      {
        memberRef: 'primary',
        invocationRef: request.invocationRef,
        targetEmployeeRef: request.targetEmployeeRef,
      },
    ]
    const contexts = z
      .array(
        z
          .object({
            id: z.string().min(1),
            revision: z.number().int().positive(),
            typeId: z.string().min(1),
          })
          .passthrough(),
      )
      .parse(JSON.parse(request.contextsJson) as unknown)
    const current = contexts.find((context) => context.typeId === 'development.delegation')
    return JSON.stringify({
      schemaVersion: 1,
      roundRef: request.roundRef,
      executionNonce: request.executionNonce,
      status: 'needs-input',
      summary: `已调起 ${invocations.length} 名协同员工，等待结果`,
      contextPatches: [
        {
          contextId: current?.id ?? null,
          contextTypeId: 'development.delegation',
          schemaVersion: 1,
          expectedRevision: current?.revision ?? null,
          lifecycleState: 'waiting',
          stateJson: JSON.stringify({
            status: 'waiting',
            groupRef: request.roundRef,
            joinMode: request.joinMode ?? 'all',
            quorum: request.quorum ?? null,
            members: invocations.map((invocation) => ({
              memberRef: invocation.memberRef,
              invocationRef: invocation.invocationRef,
              targetEmployeeRef: `${invocation.targetEmployeeRef.id}@${invocation.targetEmployeeRef.revision}`,
              state: 'waiting',
              resultArtifactRefs: [],
            })),
            resultArtifactRefs: [],
          }),
          artifactRefs: [],
        },
      ],
      effectSuggestions: ['employee.invocation.create'],
      artifactRefs: [],
    })
  },
  buildInvocationResultOutputJson(requestJson) {
    const request = invocationOutputRequestSchema.parse(JSON.parse(requestJson) as unknown)
    if (request.joinResultEnvelopeJson === undefined) {
      throw new Error('employee invocation join result envelope is missing')
    }
    if (request.resultEnvelopeJson !== undefined) {
      employeeChannelResultSchema.parse(JSON.parse(request.resultEnvelopeJson) as unknown)
    }
    const result = employeeInvocationJoinResultSchema.parse(
      JSON.parse(request.joinResultEnvelopeJson) as unknown,
    )
    const contexts = z
      .array(
        z
          .object({
            id: z.string().min(1),
            revision: z.number().int().positive(),
            typeId: z.string().min(1),
          })
          .passthrough(),
      )
      .parse(JSON.parse(request.contextsJson) as unknown)
    const delegation = contexts.find((context) => context.typeId === 'development.delegation')
    if (delegation === undefined) throw new Error('delegation context is missing')
    return JSON.stringify({
      schemaVersion: 1,
      roundRef: request.roundRef,
      executionNonce: request.executionNonce,
      status:
        result.state === 'satisfied'
          ? 'ok'
          : result.state === 'waiting'
            ? 'needs-input'
            : 'blocked',
      summary: result.summary,
      contextPatches: [
        {
          contextId: delegation.id,
          contextTypeId: 'development.delegation',
          schemaVersion: 1,
          expectedRevision: delegation.revision,
          lifecycleState: result.state === 'waiting' ? 'waiting' : 'terminal',
          stateJson: JSON.stringify({
            status: result.state,
            groupRef: result.groupRef,
            joinMode: result.joinMode,
            quorum: result.quorum,
            members: result.members.map((member) => {
              const envelope =
                member.resultEnvelopeJson === null
                  ? null
                  : employeeChannelResultSchema.parse(
                      JSON.parse(member.resultEnvelopeJson) as unknown,
                    )
              return {
                memberRef: member.memberRef,
                invocationRef: member.invocationRef,
                targetEmployeeRef: `${member.targetEmployeeRef.id}@${member.targetEmployeeRef.revision}`,
                state: member.state,
                resultArtifactRefs: envelope?.artifactRefs ?? [],
              }
            }),
            resultArtifactRefs: result.artifactRefs,
          }),
          artifactRefs: result.artifactRefs,
        },
      ],
      effectSuggestions: [],
      artifactRefs: result.artifactRefs,
    })
  },
  validateContextJson(contextTypeId, stateJson) {
    const schema = contextSchemas[contextTypeId]
    if (schema === undefined) throw new Error(`unsupported development context: ${contextTypeId}`)
    return JSON.stringify(schema.parse(JSON.parse(stateJson) as unknown))
  },
  resolveAttentionSubjectsJson(contextTypeId, stateJson) {
    if (contextTypeId === 'development.merge-request') {
      const state = mergeRequestContextSchema.parse(JSON.parse(stateJson) as unknown)
      if (state.status !== 'active') return '[]'
      return JSON.stringify(
        [
          { id: 'development.review-updated', revision: 2 },
          { id: 'development.pipeline-check-due', revision: 1 },
          { id: 'development.conflict-updated', revision: 2 },
          { id: 'development.lifecycle-updated', revision: 2 },
        ].map((eventTypeRef) => ({
          eventTypeRef,
          subject: { typeId: 'merge-request', subjectRef: state.mergeRequestRef },
        })),
      )
    }
    if (contextTypeId === 'development.delegation') {
      const state = delegationContextSchema.parse(JSON.parse(stateJson) as unknown)
      if (state.status === 'satisfied' || state.status === 'failed') return '[]'
      return JSON.stringify(
        state.members
          .filter((member) => member.state === 'waiting')
          .map((member) => ({
            eventTypeRef: { id: 'development.employee-result', revision: 1 },
            subject: { typeId: 'employee-invocation', subjectRef: member.invocationRef },
          })),
      )
    }
    if (contextTypeId === 'development.approval') {
      const state = approvalContextSchema.parse(JSON.parse(stateJson) as unknown)
      if (state.status !== 'pending' || state.subjectRef === null) return '[]'
      return JSON.stringify([
        {
          eventTypeRef: { id: 'development.approval-updated', revision: 1 },
          subject: { typeId: 'external-approval', subjectRef: state.subjectRef },
        },
      ])
    }
    return '[]'
  },
  selectReactionToolSlotJson(requestJson) {
    const request = z
      .object({
        schemaVersion: z.literal(1),
        workItemRef: z.string().min(1),
        defaultSlotRef: z.string().min(1),
        contextsJson: z.string().min(2),
        orderedDispatchConfigurationsJson: z.string().min(2).default('[]'),
      })
      .strict()
      .parse(JSON.parse(requestJson) as unknown)
    if (request.workItemRef === 'prepare-materials') {
      const contexts = z
        .array(z.object({ typeId: z.string(), stateJson: z.string() }).passthrough())
        .parse(JSON.parse(request.contextsJson) as unknown)
      const issue = contexts.find((context) => context.typeId === 'development.issue-handling')
      const kind =
        issue === undefined
          ? null
          : issueHandlingContextSchema.parse(JSON.parse(issue.stateJson) as unknown).request.kind
      return JSON.stringify({
        slotRef: kind === 'external-id' ? request.defaultSlotRef : 'platform',
      })
    }
    if (request.workItemRef !== 'repair-pipeline') {
      return JSON.stringify({ slotRef: request.defaultSlotRef })
    }
    const contexts = z
      .array(z.object({ typeId: z.string(), stateJson: z.string() }).passthrough())
      .parse(JSON.parse(request.contextsJson) as unknown)
    const problemContext = [...contexts]
      .reverse()
      .find((context) => context.typeId === 'development.problem-set')
    if (problemContext === undefined) {
      return JSON.stringify({ slotRef: request.defaultSlotRef })
    }
    const problemSet = problemSetContextSchema.parse(
      JSON.parse(problemContext.stateJson) as unknown,
    )
    const configurations = orderedDispatchConfigurationRuntimeSchema.parse(
      JSON.parse(request.orderedDispatchConfigurationsJson) as unknown,
    )
    const configuredRoutes = configurations
      .find((configuration) => configuration.classifierWorkItemRef === 'classify-pipeline')
      ?.routes.filter((route) => route.destinationWorkItemRef === request.workItemRef)
    const selected = configuredRoutes?.find((route) =>
      problemSet.remainingTypes.includes(route.routeRef),
    )?.routeRef
    return JSON.stringify({ slotRef: selected ?? request.defaultSlotRef })
  },
  assembleReactionInputJson(requestJson) {
    const request = z
      .object({
        schemaVersion: z.literal(1),
        caseRef: z.string().min(1),
        roundRef: z.string().min(1),
        executionNonce: z.string().regex(/^[a-f0-9]{64}$/),
        workItemRef: z.string().min(1),
        toolSlotRef: z.string().min(1),
        connectionRef: z
          .object({ id: z.string().min(1), revision: z.number().int().positive() })
          .strict()
          .nullable()
          .default(null),
        inputSchemaId: z.string().min(1),
        outputSchemaId: z.string().min(1),
        eventJson: z.string().min(2),
        contextsJson: z.string().min(2),
        orderedDispatchConfigurationsJson: z.string().min(2).default('[]'),
      })
      .strict()
      .parse(JSON.parse(requestJson) as unknown)
    const contexts = z
      .array(z.object({ typeId: z.string(), stateJson: z.string() }).passthrough())
      .parse(JSON.parse(request.contextsJson) as unknown)
    const issue = contexts.find((context) => context.typeId === 'development.issue-handling')
    const mergeRequest = contexts.find((context) => context.typeId === 'development.merge-request')
    const pipeline = contexts.find((context) => context.typeId === 'development.pipeline')
    const problemSet = contexts.find((context) => context.typeId === 'development.problem-set')
    const reviewResolution = contexts.find(
      (context) => context.typeId === 'development.review-resolution',
    )
    const stateOf = (context: (typeof contexts)[number] | undefined): unknown =>
      context === undefined ? null : (JSON.parse(context.stateJson) as unknown)
    const issueState =
      issue === undefined
        ? null
        : issueHandlingContextSchema.parse(JSON.parse(issue.stateJson) as unknown)
    const genericContexts = contexts.map((context) => ({
      typeId: context.typeId,
      schemaVersion:
        typeof context.schemaVersion === 'number' && Number.isInteger(context.schemaVersion)
          ? context.schemaVersion
          : 1,
      revision:
        typeof context.revision === 'number' && Number.isInteger(context.revision)
          ? context.revision
          : 1,
      state: stateOf(context),
      artifactRefs: Array.isArray(context.artifactRefs) ? context.artifactRefs : [],
    }))
    const event = JSON.parse(request.eventJson) as unknown
    const orderedDispatchConfigurations = orderedDispatchConfigurationRuntimeSchema.parse(
      JSON.parse(request.orderedDispatchConfigurationsJson) as unknown,
    )
    const pipelineDispatch = orderedDispatchConfigurations.find(
      (configuration) => configuration.classifierWorkItemRef === 'classify-pipeline',
    )
    const failureTypeDefinitions =
      pipelineDispatch?.routes.map((route, index) => ({
        typeId: route.routeRef,
        name: route.displayName,
        description: route.description,
        priority: index + 1,
        fallback: route.fallback,
        handlingWorkItemRef: route.destinationWorkItemRef,
      })) ?? []
    const platformCaseKey = stableIdentityComponent(request.caseRef)
    const requirementDirectory = `${PLATFORM_WORKSPACE_DIR}/inputs/requirements/${platformCaseKey}`
    const materialTargetDirectory = `${requirementDirectory}/external`
    const pipelineDirectory = `${PLATFORM_WORKSPACE_DIR}/pipeline/${platformCaseKey}`
    const implementationPlanPath = `${requirementDirectory}/review/implementation-plan.md`
    const projectedContractInput =
      request.workItemRef === 'prepare-materials'
        ? {
            workRequest: issueState?.request ?? null,
            repositoryRef: issueState?.repositoryRef ?? null,
            materialTargetDirectory,
          }
        : request.workItemRef === 'analyze-implement'
          ? { requirementContext: issueState }
          : request.workItemRef === 'classify-feedback'
            ? { reviewEvidence: stateOf(mergeRequest) }
            : request.workItemRef === 'repair-feedback'
              ? {
                  problemSet: stateOf(problemSet),
                  mergeRequest: stateOf(mergeRequest),
                  reviewResolution: stateOf(reviewResolution),
                  requirementContext: issueState,
                }
              : request.workItemRef === 'collect-pipeline'
                ? {
                    mergeRequest: stateOf(mergeRequest),
                    connectionRef: request.connectionRef,
                    pipelineDirectory,
                  }
                : request.workItemRef === 'classify-pipeline'
                  ? {
                      pipelineEvidence: stateOf(pipeline),
                      failureTypeDefinitions,
                      pipelineDirectory,
                    }
                  : request.workItemRef === 'repair-pipeline'
                    ? {
                        problemSet: stateOf(problemSet),
                        pipelineEvidence: stateOf(pipeline),
                        assignedFailureType: request.toolSlotRef,
                        pipelineDirectory,
                      }
                    : request.workItemRef === 'repair-conflict'
                      ? {
                          mergeRequest: stateOf(mergeRequest),
                          event,
                          requirementContext: issueState,
                        }
                      : request.workItemRef === 'prepare-approval'
                        ? {
                            mergeRequest: stateOf(mergeRequest),
                            connectionRef: request.connectionRef,
                          }
                        : { event, contexts: genericContexts }
    const executionEnvironment =
      issue === undefined
        ? { kind: 'scratch' as const }
        : {
            kind: 'cached-repository' as const,
            cachedRepoId: issueHandlingContextSchema.parse(JSON.parse(issue.stateJson) as unknown)
              .repositoryRef,
          }
    const materialInstructions = {
      bodyProvided: issueState?.request.body !== null && issueState?.request.body !== undefined,
      externalId: issueState?.request.externalId ?? null,
      uploads:
        issueState?.request.uploads.map((upload) => ({
          originalName: upload.originalName,
          placement: upload.placement,
          workspacePath: upload.targetPath,
          commitWithMergeRequest: upload.placement === 'repository',
          artifactRef: upload.artifactRef,
        })) ?? [],
      requirementDirectory,
      externalMaterialDirectory: materialTargetDirectory,
    }
    const humanReview =
      request.workItemRef === 'analyze-implement' &&
      issueState?.request.executionOptions['review-implementation-plan'] === true
        ? {
            kind: 'implementation-plan',
            artifactPort: 'analysis-plan',
            documentPath: implementationPlanPath,
            title: '实现方案评审',
            description: '请评审数字员工基于冻结工作材料和仓库现场形成的实现方案。',
          }
        : null
    return JSON.stringify({
      schemaVersion: request.schemaVersion,
      roundRef: request.roundRef,
      executionNonce: request.executionNonce,
      workItemRef: request.workItemRef,
      toolSlotRef: request.toolSlotRef,
      connectionRef: request.connectionRef,
      inputSchemaId: request.inputSchemaId,
      outputSchemaId: request.outputSchemaId,
      eventJson: request.eventJson,
      contextsJson: request.contextsJson,
      contractInput: projectedContractInput,
      artifactRefs: [
        ...new Set(
          contexts.flatMap((context) =>
            Array.isArray(context.artifactRefs)
              ? context.artifactRefs.filter((ref): ref is string => typeof ref === 'string')
              : [],
          ),
        ),
      ],
      materialInstructions,
      humanReview,
      platformPaths: {
        requirementDirectory,
        externalMaterialDirectory: materialTargetDirectory,
        pipelineDirectory,
        implementationPlanPath,
      },
      workInstructions:
        request.workItemRef === 'prepare-approval'
          ? 'Produce one development.approval context patch with status=draft. mergeRequestRef and headSha must exactly equal the frozen current MR, adapterRef must exactly equal connectionRef, approvalType must be gate-change, validatedDraftRef must identify the strict approval draft envelope, and all submission/observation fields must be null. Do not submit the approval and do not access credentials.'
          : request.workItemRef === 'collect-pipeline'
            ? 'Write complete gate evidence and large logs only under platformPaths.pipelineDirectory, then upsert development.pipeline with the exact MR head, pending/passed/failed status, evidence path, and closed failureTypes. Pending and passed must have no failureTypes. Do not choose another download path.'
            : request.workItemRef === 'classify-pipeline'
              ? `Read pipeline evidence only from platformPaths.pipelineDirectory and classify it using only contractInput.failureTypeDefinitions. Upsert development.problem-set with source=pipeline, the current MR head, typed problems, and unique remainingTypes. Use the one fallback type only when no earlier classifier-tool type matches. The list order is platform-frozen priority; do not invent a type or choose a handler.`
              : request.workItemRef === 'repair-pipeline'
                ? `Read the exact evidence and large logs from platformPaths.pipelineDirectory. Repair every problem assigned to deterministic slot ${request.toolSlotRef}; do not choose another tool, slot, or evidence path. Return top-level deliveryContent with the commit message, MR title, and MR description; do not edit the issue Context. The platform will mark that slot complete after an ok result.`
                : request.workItemRef === 'classify-feedback'
                  ? 'Read development.merge-request.reviewThreads. Upsert development.problem-set with source=review, remainingTypes=["review"], and exactly one typed problem for every unresolved non-self review thread. Each problemId must equal that review threadRef; do not add, omit, or merge threads.'
                  : request.workItemRef === 'repair-feedback'
                    ? 'Read the complete root comment and all replies from every problem.reviewThread. Repair every assigned thread. Return top-level reviewReplies in the exact input order, with one (threadRef, revision, disposition, replyBody) for every thread, plus top-level deliveryContent. Do not edit platform Contexts or receipts, and do not post comments, commit, push, or resolve threads; the platform performs those actions after validation.'
                    : request.workItemRef === 'analyze-implement'
                      ? 'Before analysis or implementation, read every body, external ID, uploaded workspacePath, and requirementDirectory entry in materialInstructions. Respect commitWithMergeRequest: temporary documents are read-only materials and must never be copied into a commit. When humanReview is present, implementation starts only after the platform review has approved the generated plan; consume that approved plan together with this frozen envelope. Do not omit an uploaded document. Return top-level deliveryContent with the commit message, MR title, and MR description; do not edit the issue Context or perform Git/MR operations.'
                      : request.workItemRef === 'repair-conflict'
                        ? 'Repair only the platform-frozen conflict scene and authorized files. Return top-level deliveryContent with the commit message, MR title, and MR description; do not edit platform Contexts and do not perform commit, push, merge, or MR updates.'
                        : request.workItemRef === 'prepare-materials'
                          ? 'For an external ID, download every source file only into contractInput.materialTargetDirectory, which the platform has already allocated and created. Do not choose another path, do not write Git metadata, and do not copy these temporary materials into business paths.'
                          : 'Follow the frozen work contract and return only its deterministic result.',
      executionEnvironmentJson: JSON.stringify(executionEnvironment),
    })
  },
  validateReactionOutputJson(requestJson) {
    const request = z
      .object({
        schemaVersion: z.literal(1),
        workItemRef: z.string().min(1),
        toolSlotRef: z.string().min(1),
        connectionRef: z
          .object({ id: z.string().min(1), revision: z.number().int().positive() })
          .strict()
          .nullable()
          .default(null),
        inputEnvelopeJson: z.string().min(2),
        outputJson: z.string().min(2),
      })
      .strict()
      .parse(JSON.parse(requestJson) as unknown)
    const parsedOutput = reactionOutputSchema.parse(JSON.parse(request.outputJson) as unknown)
    const output = {
      ...parsedOutput,
      contextPatches: [...parsedOutput.contextPatches],
    }
    const inputEnvelope = reactionInputEnvelopeSchema.parse(
      JSON.parse(request.inputEnvelopeJson) as unknown,
    )
    const inputContexts = z
      .array(reactionContextRecordSchema)
      .parse(JSON.parse(inputEnvelope.contextsJson) as unknown)
    const inputState = <T>(typeId: string, schema: z.ZodType<T>): T | null => {
      const context = inputContexts.find((candidate) => candidate.typeId === typeId)
      return context === undefined ? null : schema.parse(JSON.parse(context.stateJson) as unknown)
    }
    const platformContext = (typeId: string) => {
      const context = inputContexts.find((candidate) => candidate.typeId === typeId)
      if (context === undefined) return null
      const record = z
        .object({
          id: z.string().min(1),
          typeId: z.literal(typeId),
          schemaVersion: z.number().int().positive(),
          revision: z.number().int().positive(),
          lifecycleState: z.enum(['active', 'waiting', 'terminal']),
          artifactRefs: z.array(z.string().min(1).max(1_000)).max(500),
        })
        .passthrough()
        .safeParse(context)
      if (!record.success) {
        throw new Error(`${typeId} is missing platform context identity metadata`)
      }
      return record.data
    }
    const appendPlatformContextPatch = (
      context: NonNullable<ReturnType<typeof platformContext>>,
      state: unknown,
    ): void => {
      output.contextPatches.push({
        contextId: context.id,
        contextTypeId: context.typeId,
        schemaVersion: context.schemaVersion,
        expectedRevision: context.revision,
        lifecycleState: context.lifecycleState,
        stateJson: JSON.stringify(state),
        artifactRefs: context.artifactRefs,
      })
    }
    const patchState = <T>(typeId: string, schema: z.ZodType<T>): T | null => {
      const patch = output.contextPatches.find((candidate) => candidate.contextTypeId === typeId)
      return patch === undefined ? null : schema.parse(JSON.parse(patch.stateJson) as unknown)
    }
    if (output.status === 'ok') {
      const deliveryWorkItems = new Set([
        'analyze-implement',
        'repair-feedback',
        'repair-pipeline',
        'repair-conflict',
      ])
      if (deliveryWorkItems.has(request.workItemRef)) {
        if (
          parsedOutput.contextPatches.some(
            (patch) => patch.contextTypeId === 'development.issue-handling',
          )
        ) {
          throw new Error(
            `${request.workItemRef} must return top-level deliveryContent and cannot edit the platform-owned issue Context`,
          )
        }
        if (output.deliveryContent === undefined || output.deliveryContent === null) {
          throw new Error(
            `${request.workItemRef} must output commitMessage, mergeRequestTitle, and mergeRequestDescription`,
          )
        }
        const issueContext = platformContext('development.issue-handling')
        const issue = inputState('development.issue-handling', issueHandlingContextSchema)
        if (issueContext === null || issue === null) {
          throw new Error(`${request.workItemRef} requires the platform-owned issue Context`)
        }
        appendPlatformContextPatch(
          issueContext,
          issueHandlingContextSchema.parse({ ...issue, deliveryContent: output.deliveryContent }),
        )
      }
      if (request.workItemRef === 'repair-feedback') {
        if (
          parsedOutput.contextPatches.some(
            (patch) => patch.contextTypeId === 'development.review-resolution',
          )
        ) {
          throw new Error(
            'repair-feedback must return top-level reviewReplies and cannot edit platform review receipts',
          )
        }
        const resolutionContext = platformContext('development.review-resolution')
        const current = inputState('development.review-resolution', reviewResolutionContextSchema)
        const replies = output.reviewReplies
        if (
          resolutionContext === null ||
          current === null ||
          current.status !== 'acknowledged' ||
          replies === undefined ||
          replies.length !== current.threads.length ||
          current.threads.some(
            (thread, index) =>
              replies[index]?.threadRef !== thread.threadRef ||
              replies[index]?.revision !== thread.revision,
          )
        ) {
          throw new Error(
            'repair-feedback must return one ordered review reply for every acknowledged thread revision',
          )
        }
        appendPlatformContextPatch(
          resolutionContext,
          reviewResolutionContextSchema.parse({
            ...current,
            status: 'prepared',
            publishedHeadSha: null,
            commitSha: null,
            threads: current.threads.map((thread, index) => ({
              ...thread,
              disposition: replies[index]!.disposition,
              replyBody: replies[index]!.replyBody,
              finalReply: null,
            })),
          }),
        )
      }
      const requiredContextType =
        request.workItemRef === 'prepare-approval'
          ? 'development.approval'
          : request.workItemRef === 'repair-feedback'
            ? 'development.review-resolution'
            : request.workItemRef === 'collect-pipeline'
              ? 'development.pipeline'
              : request.workItemRef === 'classify-pipeline' ||
                  request.workItemRef === 'classify-feedback'
                ? 'development.problem-set'
                : null
      if (
        requiredContextType !== null &&
        !output.contextPatches.some((patch) => patch.contextTypeId === requiredContextType)
      ) {
        throw new Error(
          `${request.workItemRef} must produce a ${requiredContextType} context patch`,
        )
      }
      if (request.workItemRef === 'prepare-materials') {
        const issue = inputState('development.issue-handling', issueHandlingContextSchema)
        const patchedIssue = patchState('development.issue-handling', issueHandlingContextSchema)
        if (issue?.request.kind === 'external-id' && patchedIssue === null) {
          throw new Error(
            'prepare-materials must update the issue context for an external work item',
          )
        }
        if (
          issue?.request.kind === 'external-id' &&
          patchedIssue !== null &&
          (patchedIssue.repositoryRef !== issue.repositoryRef ||
            patchedIssue.request.kind !== issue.request.kind ||
            patchedIssue.request.externalId !== issue.request.externalId ||
            JSON.stringify(patchedIssue.request.uploads) !== JSON.stringify(issue.request.uploads))
        ) {
          throw new Error('prepare-materials cannot change platform-owned intake paths or identity')
        }
      }
      if (request.workItemRef === 'prepare-approval') {
        const approval = patchState('development.approval', approvalContextSchema)
        const mergeRequest = inputState('development.merge-request', mergeRequestContextSchema)
        if (
          approval === null ||
          mergeRequest === null ||
          approval.status !== 'draft' ||
          approval.mergeRequestRef !== mergeRequest.mergeRequestRef ||
          approval.headSha !== mergeRequest.headSha ||
          request.connectionRef === null ||
          approval.adapterRef.id !== request.connectionRef.id ||
          approval.adapterRef.revision !== request.connectionRef.revision
        ) {
          throw new Error(
            'prepare-approval must produce a draft bound to the frozen MR head and approval connection',
          )
        }
      }
      if (request.workItemRef === 'collect-pipeline') {
        const mergeRequest = inputState('development.merge-request', mergeRequestContextSchema)
        const pipeline = patchState('development.pipeline', pipelineContextSchema)
        if (mergeRequest === null || pipeline === null) {
          throw new Error('collect-pipeline requires the current MR and a pipeline patch')
        }
        if (
          pipeline.mergeRequestRef !== mergeRequest.mergeRequestRef ||
          pipeline.headSha !== mergeRequest.headSha
        ) {
          throw new Error('pipeline evidence does not belong to the current MR head')
        }
        if (
          (pipeline.status === 'passed' && pipeline.failureTypes.length > 0) ||
          (pipeline.status === 'pending' && pipeline.failureTypes.length > 0) ||
          (pipeline.status === 'failed' && pipeline.failureTypes.length === 0)
        ) {
          throw new Error('pipeline status and failureTypes disagree')
        }
      }
      if (request.workItemRef === 'repair-feedback') {
        const problemSet = inputState('development.problem-set', problemSetContextSchema)
        const current = inputState('development.review-resolution', reviewResolutionContextSchema)
        const proposed = patchState('development.review-resolution', reviewResolutionContextSchema)
        if (
          problemSet === null ||
          problemSet.source !== 'review' ||
          current === null ||
          current.status !== 'acknowledged' ||
          proposed === null ||
          proposed.status !== 'prepared'
        ) {
          throw new Error(
            'repair-feedback requires an acknowledged review set and a prepared resolution',
          )
        }
        const expected = current.threads.map(
          (thread) => `${thread.threadRef}\u0000${thread.revision}`,
        )
        const actual = proposed.threads.map(
          (thread) => `${thread.threadRef}\u0000${thread.revision}`,
        )
        if (
          expected.length !== actual.length ||
          expected.some((key, index) => actual[index] !== key) ||
          proposed.mergeRequestRef !== current.mergeRequestRef ||
          proposed.sourceHeadSha !== current.sourceHeadSha ||
          proposed.publishedHeadSha !== null ||
          proposed.commitSha !== null ||
          proposed.threads.some(
            (thread, index) =>
              JSON.stringify(thread.acknowledgement) !==
                JSON.stringify(current.threads[index]!.acknowledgement) ||
              thread.finalReply !== null,
          )
        ) {
          throw new Error(
            'repair-feedback must answer every acknowledged thread exactly once without changing platform receipts',
          )
        }
      }
      if (
        request.workItemRef === 'classify-pipeline' ||
        request.workItemRef === 'classify-feedback'
      ) {
        const problemSet = patchState('development.problem-set', problemSetContextSchema)
        if (problemSet === null || problemSet.status !== 'active') {
          throw new Error(`${request.workItemRef} must produce an active problem set`)
        }
        const expectedSource = request.workItemRef === 'classify-pipeline' ? 'pipeline' : 'review'
        if (problemSet.source !== expectedSource) {
          throw new Error(`${request.workItemRef} produced the wrong problem source`)
        }
        const mergeRequest = inputState('development.merge-request', mergeRequestContextSchema)
        const pipeline = inputState('development.pipeline', pipelineContextSchema)
        const expectedHead =
          expectedSource === 'pipeline' ? pipeline?.headSha : mergeRequest?.headSha
        if (expectedHead === undefined || problemSet.headSha !== expectedHead) {
          throw new Error(`${request.workItemRef} problem set is stale for the current head`)
        }
        if (request.workItemRef === 'classify-pipeline') {
          const configured = z
            .object({
              failureTypeDefinitions: z
                .array(
                  z
                    .object({
                      typeId: pipelineFailureTypeSchema,
                      priority: z.number().int().positive(),
                      fallback: z.boolean(),
                      handlingWorkItemRef: z.string().min(1),
                    })
                    .passthrough(),
                )
                .min(1),
            })
            .passthrough()
            .parse(inputEnvelope.contractInput).failureTypeDefinitions
          const allowedTypes = new Set(configured.map((definition) => definition.typeId))
          if (
            problemSet.remainingTypes.some((type) => !allowedTypes.has(type)) ||
            problemSet.problems.some((problem) => !allowedTypes.has(problem.type))
          ) {
            throw new Error(
              'classify-pipeline may only emit failure types configured in this employee job',
            )
          }
        }
        const remaining = new Set(problemSet.remainingTypes)
        if (
          problemSet.problems.length === 0 ||
          problemSet.problems.some((problem) => !remaining.has(problem.type)) ||
          problemSet.remainingTypes.some(
            (type) => !problemSet.problems.some((problem) => problem.type === type),
          )
        ) {
          throw new Error('problem set types and problem records do not form a closed set')
        }
        if (request.workItemRef === 'classify-feedback') {
          const resolution = patchState(
            'development.review-resolution',
            reviewResolutionContextSchema,
          )
          if (mergeRequest === null) {
            throw new Error('classify-feedback requires the current MR context')
          }
          if (
            resolution === null ||
            resolution.status !== 'collected' ||
            resolution.mergeRequestRef !== mergeRequest.mergeRequestRef ||
            resolution.sourceHeadSha !== mergeRequest.headSha
          ) {
            throw new Error('classify-feedback must create the matching review-resolution context')
          }
          const priorResolution = inputState(
            'development.review-resolution',
            reviewResolutionContextSchema,
          )
          const knownThreadRevisions = new Set(
            priorResolution?.threads.map(
              (thread) => `${thread.threadRef}\u0000${thread.revision}`,
            ) ?? [],
          )
          const expectedThreadRefs = (mergeRequest.reviewThreads ?? [])
            .filter(
              (thread) =>
                !thread.resolved &&
                thread.authorClass !== 'self' &&
                !knownThreadRevisions.has(`${thread.threadRef}\u0000${thread.revision}`),
            )
            .map((thread) => thread.threadRef)
            .sort()
          const producedThreadRefs = problemSet.problems.map((problem) => problem.problemId).sort()
          if (
            expectedThreadRefs.length !== producedThreadRefs.length ||
            expectedThreadRefs.some((threadRef, index) => producedThreadRefs[index] !== threadRef)
          ) {
            throw new Error(
              'classify-feedback must cover each unresolved non-self review thread exactly once',
            )
          }
        }
      }
    }
    if (output.contextPatches.length > 50) {
      throw new Error('platform context synthesis exceeds the reaction patch limit')
    }
    return JSON.stringify(reactionOutputSchema.parse(output))
  },
  resolveReactionSettlementJson(requestJson) {
    const request = z
      .object({
        schemaVersion: z.literal(1),
        workItemRef: z.string().min(1),
        toolSlotRef: z.string().min(1),
        outputJson: z.string().min(2),
        contextsJson: z.string().min(2),
        inputEnvelopeJson: z.string().min(2).optional(),
        enabledWorkItemRefsJson: z.string().min(2).default('[]'),
        allowedNextWorkItemRefs: z.array(z.string().min(1)).max(20),
      })
      .strict()
      .parse(JSON.parse(requestJson) as unknown)
    const output = reactionOutputSchema.parse(JSON.parse(request.outputJson) as unknown)
    const contexts = z
      .array(
        z
          .object({
            id: z.string().min(1),
            revision: z.number().int().positive(),
            typeId: z.string().min(1),
            stateJson: z.string().min(2),
            artifactRefs: z.array(z.string()).default([]),
          })
          .passthrough(),
      )
      .parse(JSON.parse(request.contextsJson) as unknown)
    const inputEnvelope = reactionInputEnvelopeSchema.parse(
      request.inputEnvelopeJson === undefined
        ? { contextsJson: request.contextsJson, contractInput: {} }
        : (JSON.parse(request.inputEnvelopeJson) as unknown),
    )
    const serializedEvent = (inputEnvelope as { readonly eventJson?: unknown }).eventJson
    const triggeringEventTypeId = z
      .object({
        eventTypeRef: z.object({ id: z.string().min(1) }).passthrough(),
      })
      .passthrough()
      .safeParse(typeof serializedEvent === 'string' ? JSON.parse(serializedEvent) : null).data
      ?.eventTypeRef.id
    const executionConfiguration = z
      .object({
        failureTypeDefinitions: z
          .array(
            z
              .object({
                typeId: pipelineFailureTypeSchema,
                priority: z.number().int().positive(),
                handlingWorkItemRef: z.string().min(1),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .parse(inputEnvelope.contractInput)
    const failureTypeDefinitions = executionConfiguration.failureTypeDefinitions
    const enabledWorkItemRefs = new Set(
      z
        .array(z.string().min(1).max(160))
        .parse(JSON.parse(request.enabledWorkItemRefsJson) as unknown),
    )
    const capabilityEnabled = (workItemRef: string): boolean =>
      enabledWorkItemRefs.size === 0 || enabledWorkItemRefs.has(workItemRef)
    const nextConfiguredPipelineWorkItem = (remainingTypes: readonly string[]): string => {
      const selected = failureTypeDefinitions.find((definition) =>
        remainingTypes.includes(definition.typeId),
      )
      if (selected === undefined) {
        throw new Error('pipeline problem set has no configured deterministic destination')
      }
      return selected.handlingWorkItemRef
    }
    const settlementPatches = [...output.contextPatches]
    const proposedState = (typeId: string): unknown => {
      const patch = [...output.contextPatches]
        .reverse()
        .find((candidate) => candidate.contextTypeId === typeId)
      if (patch !== undefined) return JSON.parse(patch.stateJson) as unknown
      const current = contexts.find((candidate) => candidate.typeId === typeId)
      return current === undefined ? null : (JSON.parse(current.stateJson) as unknown)
    }

    let nextWorkItemRef: string | null =
      request.allowedNextWorkItemRefs.length === 1 ? request.allowedNextWorkItemRefs[0]! : null
    const deterministicDefault: Readonly<Record<string, string>> = {
      'analyze-implement': 'prepare-change',
    }
    if (nextWorkItemRef === null) {
      nextWorkItemRef = deterministicDefault[request.workItemRef] ?? null
    }
    let caseState: 'active' | 'waiting' | 'blocked' | 'terminal' = 'active'
    let terminalKind: string | null = null
    if (output.status === 'blocked') {
      caseState = 'blocked'
      nextWorkItemRef = null
    } else if (output.status === 'needs-input') {
      caseState = 'waiting'
      nextWorkItemRef = null
    } else if (request.workItemRef === 'collect-pipeline') {
      const pipeline = pipelineContextSchema.nullable().parse(proposedState('development.pipeline'))
      if (pipeline?.status === 'pending') {
        caseState = 'waiting'
        nextWorkItemRef = null
      } else {
        nextWorkItemRef = pipeline?.status === 'passed' ? 'observe-mr' : 'classify-pipeline'
      }
    } else if (request.workItemRef === 'classify-pipeline') {
      const problemSet = problemSetContextSchema.parse(proposedState('development.problem-set'))
      if (problemSet.status !== 'active') {
        throw new Error('failed pipeline classification must produce an active problem set')
      }
      nextWorkItemRef = nextConfiguredPipelineWorkItem(problemSet.remainingTypes)
    } else if (request.workItemRef === 'repair-feedback') {
      const current = contexts.find((context) => context.typeId === 'development.problem-set')
      if (current === undefined) throw new Error('review repair has no problem-set context')
      const problemSet = problemSetContextSchema.parse(proposedState('development.problem-set'))
      if (problemSet.source !== 'review') {
        throw new Error('repair-feedback received a non-review problem set')
      }
      const resolved = problemSetContextSchema.parse({
        ...problemSet,
        status: 'resolved',
        remainingTypes: [],
      })
      const replacement = {
        contextId: current.id,
        contextTypeId: 'development.problem-set',
        schemaVersion: 1,
        expectedRevision: current.revision,
        lifecycleState: 'terminal' as const,
        stateJson: JSON.stringify(resolved),
        artifactRefs: current.artifactRefs,
      }
      const existingPatch = settlementPatches.findIndex(
        (patch) => patch.contextTypeId === 'development.problem-set',
      )
      if (existingPatch === -1) settlementPatches.push(replacement)
      else settlementPatches[existingPatch] = replacement
      nextWorkItemRef = 'prepare-change'
    } else if (request.workItemRef === 'publish-mr') {
      const reviewResolution = reviewResolutionContextSchema
        .nullable()
        .parse(proposedState('development.review-resolution'))
      nextWorkItemRef = reviewResolution?.status === 'prepared' ? 'reply-feedback' : 'observe-mr'
    } else if (request.workItemRef === 'repair-pipeline') {
      const current = contexts.find((context) => context.typeId === 'development.problem-set')
      if (current === undefined) throw new Error('pipeline repair has no problem-set context')
      const problemSet = problemSetContextSchema.parse(proposedState('development.problem-set'))
      const remainingTypes = problemSet.remainingTypes.filter(
        (type) => type !== request.toolSlotRef,
      )
      const normalized = problemSetContextSchema.parse({
        ...problemSet,
        status: remainingTypes.length === 0 ? 'resolved' : 'active',
        remainingTypes,
      })
      const replacement = {
        contextId: current.id,
        contextTypeId: 'development.problem-set',
        schemaVersion: 1,
        expectedRevision: current.revision,
        lifecycleState: remainingTypes.length === 0 ? ('terminal' as const) : ('active' as const),
        stateJson: JSON.stringify(normalized),
        artifactRefs: current.artifactRefs,
      }
      const existingPatch = settlementPatches.findIndex(
        (patch) => patch.contextTypeId === 'development.problem-set',
      )
      if (existingPatch === -1) settlementPatches.push(replacement)
      else settlementPatches[existingPatch] = replacement
      nextWorkItemRef =
        remainingTypes.length === 0
          ? 'prepare-change'
          : nextConfiguredPipelineWorkItem(remainingTypes)
    } else if (request.workItemRef === 'evaluate-ready') {
      const mergeRequest = mergeRequestContextSchema
        .nullable()
        .parse(proposedState('development.merge-request'))
      if (mergeRequest?.readyToMerge === true) {
        nextWorkItemRef = 'wait-merge'
      } else {
        caseState = 'waiting'
        nextWorkItemRef = null
      }
    } else if (request.workItemRef === 'delegate') {
      const delegation = delegationContextSchema
        .nullable()
        .parse(proposedState('development.delegation'))
      if (delegation?.status === 'satisfied') {
        nextWorkItemRef = 'collect-pipeline'
      } else if (delegation?.status === 'failed') {
        caseState = 'blocked'
        nextWorkItemRef = null
      } else {
        caseState = 'waiting'
        nextWorkItemRef = null
      }
    } else if (request.workItemRef === 'observe-mr' || request.workItemRef === 'wait-merge') {
      const mergeRequest = mergeRequestContextSchema
        .nullable()
        .parse(proposedState('development.merge-request'))
      if (mergeRequest?.status === 'merged' || mergeRequest?.status === 'closed') {
        caseState = 'terminal'
        terminalKind = mergeRequest.status
        nextWorkItemRef = null
      } else if (request.workItemRef === 'observe-mr') {
        if (mergeRequest === null) {
          caseState = 'blocked'
          nextWorkItemRef = null
        } else {
          caseState = 'active'
          const priorReviewResolution = reviewResolutionContextSchema
            .nullable()
            .parse(proposedState('development.review-resolution'))
          const knownReviewThreadRevisions = new Set(
            priorReviewResolution?.threads.map(
              (thread) => `${thread.threadRef}\u0000${thread.revision}`,
            ) ?? [],
          )
          const hasNewReviewFeedback = mergeRequest.reviewThreads.some(
            (thread) =>
              !thread.resolved &&
              thread.authorClass !== 'self' &&
              !knownReviewThreadRevisions.has(`${thread.threadRef}\u0000${thread.revision}`),
          )
          const approval = approvalContextSchema
            .nullable()
            .parse(proposedState('development.approval'))
          const approvalRequired = mergeRequest.approvalHold === true
          const currentHeadApproval =
            approval?.mergeRequestRef === mergeRequest.mergeRequestRef &&
            approval.headSha === mergeRequest.headSha
          const currentHeadApproved = currentHeadApproval && approval.status === 'approved'
          if (
            triggeringEventTypeId === 'development.review-updated' &&
            capabilityEnabled('classify-feedback') &&
            hasNewReviewFeedback
          ) {
            nextWorkItemRef = 'classify-feedback'
          } else if (
            triggeringEventTypeId === 'development.conflict-updated' &&
            capabilityEnabled('repair-conflict') &&
            mergeRequest.mergeableState === 'conflict'
          ) {
            nextWorkItemRef = 'repair-conflict'
          } else {
            nextWorkItemRef =
              approvalRequired &&
              !currentHeadApproved &&
              !currentHeadApproval &&
              capabilityEnabled('prepare-approval')
                ? 'prepare-approval'
                : 'evaluate-ready'
          }
        }
      } else {
        caseState = 'waiting'
        nextWorkItemRef = null
      }
    } else if (request.allowedNextWorkItemRefs.length === 0) {
      caseState = 'waiting'
      nextWorkItemRef = null
    } else if (nextWorkItemRef === null) {
      throw new Error(
        `development work item ${request.workItemRef} requires a deterministic continuation rule`,
      )
    }
    if (nextWorkItemRef !== null && !request.allowedNextWorkItemRefs.includes(nextWorkItemRef)) {
      throw new Error(
        `development continuation escaped manifest: ${request.workItemRef} -> ${nextWorkItemRef}`,
      )
    }
    return JSON.stringify({
      schemaVersion: 1,
      caseState,
      terminalKind,
      blockReason: caseState === 'blocked' ? output.summary : null,
      nextWorkItemRef,
      summary: output.summary,
      contextPatches: settlementPatches,
      effectSuggestions: output.effectSuggestions,
      artifactRefs: output.artifactRefs,
    })
  },
}
