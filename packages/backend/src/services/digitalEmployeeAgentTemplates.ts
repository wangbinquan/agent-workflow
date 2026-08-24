import {
  canonicalJson,
  CreateAgentSchema,
  type Agent,
  type CreateAgent,
} from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DbClient } from '@/db/client'
import {
  DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2,
  DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2,
  developmentBuiltinAgentConfigurationV2,
} from '@/modules/development-automation/public/digitalEmployeeAgentTemplatesV2'
import { ConflictError } from '@/util/errors'
import { createAgent, getAgentById, renameAgent, updateAgent } from './agent'

export const LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS = [
  '00000000000000DECODEWRITER',
  '00000000000000DEDIAGNOSE',
  '00000000000000DEPIPEFIX',
  '00000000000000DEREVIEWFIX',
  '00000000000000DECONFLICTFIX',
  '00000000000000DEFEATUREDEV',
  '00000000000000DEISSUEFIX',
  '00000000000000DEPLANANALYZE',
] as const

export const DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS = [
  ...LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS,
  ...DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2,
] as const

const LEGACY_DIGITAL_EMPLOYEE_PLAN_ANALYZER_ID = LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[7]
export const DIGITAL_EMPLOYEE_PLAN_ANALYZER_ID = LEGACY_DIGITAL_EMPLOYEE_PLAN_ANALYZER_ID
export const DIGITAL_EMPLOYEE_PLAN_ANALYZER_ID_V2 =
  DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[7]

const DIGITAL_EMPLOYEE_AGENT_TOOL_PRESENTATION: Readonly<
  Record<
    string,
    { readonly zh: string; readonly en: string; readonly selection: 'selectable' | 'automatic' }
  >
> = {
  'code-writing': {
    zh: '通用代码实现',
    en: 'General code implementation',
    selection: 'selectable',
  },
  'problem-diagnosis': {
    zh: '流水线失败分类',
    en: 'Pipeline failure classification',
    selection: 'selectable',
  },
  'pipeline-repair': {
    zh: '流水线失败修复',
    en: 'Pipeline failure repair',
    selection: 'selectable',
  },
  'review-repair': {
    zh: '检视意见处理',
    en: 'Review feedback handling',
    selection: 'selectable',
  },
  'conflict-repair': {
    zh: '合并冲突处理',
    en: 'Merge conflict handling',
    selection: 'selectable',
  },
  'business-implementation': {
    zh: '业务需求实现',
    en: 'Business implementation',
    selection: 'selectable',
  },
  'issue-repair': { zh: '缺陷修复', en: 'Defect repair', selection: 'selectable' },
  'implementation-planning': {
    zh: '编写实现方案',
    en: 'Write implementation plan',
    selection: 'selectable',
  },
}

export function digitalEmployeeAgentToolPresentation(template: string) {
  return DIGITAL_EMPLOYEE_AGENT_TOOL_PRESENTATION[template] ?? null
}

interface DigitalEmployeeAgentTemplate {
  readonly id: (typeof LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS)[number]
  readonly definition: CreateAgent
}

const DELIVERY_CONTENT_INSTRUCTION =
  '只要本轮修改了代码，输出 envelope 就必须在顶层 deliveryContent 中给出完整 commitMessage、mergeRequestTitle、mergeRequestDescription。不得编辑平台 Context；平台会校验并保存业务内容，再负责 commit、push 和创建或更新 MR。不得把交付文案只写在 summary。'

const DIGITAL_EMPLOYEE_AGENT_TEMPLATES: readonly DigitalEmployeeAgentTemplate[] = [
  {
    id: LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[0],
    definition: {
      name: 'digital-employee-code-writer',
      description: '根据冻结的工作合同和上下文实现代码修改，只返回数字员工 exact envelope。',
      outputs: ['agent-result'],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        digitalEmployeeTemplate: 'code-writing',
        schemaVersion: 2,
        executionContracts: [
          { contractId: 'development.analyze-implement', version: 1 },
          { contractId: 'development.repair-conflict', version: 1 },
        ],
      },
      bodyMd: `你是数字员工操作系统内置的代码编写者。只处理输入 envelope 中已授权的业务文件和目标；不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。先理解需求与现有代码，再完成最小且完整的实现和必要验证。${DELIVERY_CONTENT_INSTRUCTION} 最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。`,
    },
  },
  {
    id: LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[1],
    definition: {
      name: 'digital-employee-problem-diagnoser',
      description: '基于冻结现场定位根因并形成可执行结论，只返回数字员工 exact envelope。',
      outputs: ['agent-result'],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        digitalEmployeeTemplate: 'problem-diagnosis',
        schemaVersion: 3,
        executionContracts: [{ contractId: 'development.classify-pipeline', version: 1 }],
        dispatchRouteDefinitions: [
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
            description: '未命中前序问题类型的确定性兜底',
            fallback: true,
          },
        ],
      },
      bodyMd:
        '你是数字员工操作系统内置的问题定位者。只依据输入 envelope、仓库现场和 artifact 引用收集证据，区分事实、推断与未知项；不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。定位最小根因并给出合同要求的结构化产出。最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。',
    },
  },
  {
    id: LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[2],
    definition: {
      name: 'digital-employee-pipeline-repairer',
      description: '读取流水线证据包和大日志引用，按闭集失败类型修复代码，只返回 exact envelope。',
      outputs: ['agent-result'],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        digitalEmployeeTemplate: 'pipeline-repair',
        schemaVersion: 2,
        executionContracts: [{ contractId: 'development.repair-pipeline', version: 1 }],
      },
      bodyMd: `你是数字员工操作系统内置的流水线修复者。读取输入 envelope 的 platformPaths.pipelineDirectory 指向的精确证据目录，不要把大日志复述进输出。只修复指定失败类型和授权业务文件；不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。完成最小验证后，${DELIVERY_CONTENT_INSTRUCTION} 最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。`,
    },
  },
  {
    id: LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[3],
    definition: {
      name: 'digital-employee-review-feedback-repairer',
      description: '读取每棵检视线程的根评论和全部多轮回复，修复代码并逐线程输出处理说明。',
      outputs: ['agent-result'],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        digitalEmployeeTemplate: 'review-repair',
        schemaVersion: 2,
        executionContracts: [{ contractId: 'development.repair-feedback', version: 1 }],
      },
      bodyMd: `你是数字员工操作系统内置的检视意见修复者。输入中的每个 reviewThread 都包含根评论和全部多轮回复，必须结合整棵线程理解审阅者意图并修复授权业务文件。不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得直接回复或 resolve 评论。输出 envelope 必须在顶层 reviewReplies 按输入顺序为每个 threadRef 与 revision 恰好返回一条 disposition 和具体 replyBody，说明如何修复或为什么需要人工决策；不得编辑平台保存的 acknowledgement 回执。平台会在发布提交后把 replyBody 写回原线程。${DELIVERY_CONTENT_INSTRUCTION} 最终只向 agent-result 输出 JSON envelope，不得夹带 Markdown、解释文字或额外端口。`,
    },
  },
  {
    id: LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[4],
    definition: {
      name: 'digital-employee-conflict-repairer',
      description: '在平台冻结的冲突现场中修复授权冲突文件，只返回 exact envelope。',
      outputs: ['agent-result'],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        digitalEmployeeTemplate: 'conflict-repair',
        schemaVersion: 2,
        executionContracts: [{ contractId: 'development.repair-conflict', version: 1 }],
      },
      bodyMd: `你是数字员工操作系统内置的代码冲突修复者。只在平台冻结的冲突现场中理解双方变更意图，修改合同授权的冲突文件，并完成最小验证。不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得改变固定父提交或自行选择下一步。${DELIVERY_CONTENT_INSTRUCTION} 最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。`,
    },
  },
  {
    id: LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[5],
    definition: {
      name: 'digital-employee-business-implementer',
      description: '面向新需求与业务逻辑实现，依据验收目标完成最小完整代码变更。',
      outputs: ['agent-result'],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        digitalEmployeeTemplate: 'business-implementation',
        schemaVersion: 2,
        executionContracts: [{ contractId: 'development.analyze-implement', version: 1 }],
      },
      bodyMd: `你是数字员工操作系统内置的业务需求实现者。依据冻结需求、验收目标和仓库事实理解既有领域边界，完成最小且完整的业务代码、必要测试与说明。不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。${DELIVERY_CONTENT_INSTRUCTION} 最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。`,
    },
  },
  {
    id: LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[6],
    definition: {
      name: 'digital-employee-issue-repairer',
      description: '面向问题单与缺陷修复，先定位可验证根因，再完成最小修复和回归验证。',
      outputs: ['agent-result'],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        digitalEmployeeTemplate: 'issue-repair',
        schemaVersion: 2,
        executionContracts: [{ contractId: 'development.analyze-implement', version: 1 }],
      },
      bodyMd: `你是数字员工操作系统内置的代码问题修复者。先用冻结问题材料、复现证据和仓库事实定位可验证根因，再实施最小修复并补充针对性回归验证；不要借机重构无关代码。不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。${DELIVERY_CONTENT_INSTRUCTION} 最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。`,
    },
  },
  {
    id: LEGACY_DIGITAL_EMPLOYEE_PLAN_ANALYZER_ID,
    definition: {
      name: 'digital-employee-implementation-planner',
      description: '只读分析需求、材料与仓库，形成供人工评审的实现方案，不修改任何文件。',
      outputs: ['analysis-plan'],
      outputKinds: { 'analysis-plan': 'path<md>' },
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        digitalEmployeeTemplate: 'implementation-planning',
        schemaVersion: 3,
        executionContracts: [
          {
            contractId: 'development.analyze-plan',
            version: 1,
            outputPort: 'analysis-plan',
            outputKind: 'path<md>',
          },
        ],
      },
      bodyMd:
        '你是数字员工操作系统内置的实现方案分析者。先逐项阅读平台列出的需求正文、上传文件、外部材料目录和仓库现状，区分确定事实、假设与待确认项。只允许在平台注入的 platformPaths.implementationPlanPath 写入包含目标理解、影响范围、实现步骤、测试计划、风险与待确认问题的 Markdown 方案，并向 analysis-plan 端口只输出该相对路径。不得修改其他文件，不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得输出 agent-result。收到评审意见后必须逐条回应并覆写同一方案文件形成完整替代方案。',
    },
  },
]

/**
 * The stored form of one builtin row, re-expressed in the exact shape a
 * template declares it. Comparing two parsed `CreateAgent` values as one
 * canonical string beats a field-by-field checklist, which silently stops
 * covering whatever field `CreateAgent` grows next.
 */
function storedBuiltinAgentDefinition(existing: Agent): CreateAgent {
  return CreateAgentSchema.parse({
    name: existing.name,
    description: existing.description,
    outputs: existing.outputs,
    ...(existing.outputKinds === undefined ? {} : { outputKinds: existing.outputKinds }),
    ...(existing.branchPorts === undefined ? {} : { branchPorts: existing.branchPorts }),
    inputs: existing.inputs,
    ...(existing.outputWrapperPortNames === undefined
      ? {}
      : { outputWrapperPortNames: existing.outputWrapperPortNames }),
    ...(existing.role === undefined ? {} : { role: existing.role }),
    syncOutputsOnIterate: existing.syncOutputsOnIterate,
    ...(existing.runtime === undefined ? {} : { runtime: existing.runtime }),
    permission: existing.permission,
    skills: existing.skills,
    dependsOn: existing.dependsOn,
    mcp: existing.mcp,
    plugins: existing.plugins,
    frontmatterExtra: existing.frontmatterExtra,
    bodyMd: existing.bodyMd,
  })
}

/** Everything except the name, which is repaired through `renameAgent`. */
function builtinAgentContentSignature(definition: CreateAgent): string {
  const { name: _name, ...content } = CreateAgentSchema.parse(definition)
  return canonicalJson(content)
}

/**
 * Bring one platform-owned row back onto its template.
 *
 * The code is the source of truth for builtin definitions, so drift is
 * REPAIRED at boot, never refused. The earlier create-or-equal rule threw on
 * any difference, which meant one reworded `description` in this repository
 * stopped the daemon dead on every machine that had already seeded the old
 * text — dev boxes and upgraded installs alike — for an edit that cannot break
 * anything. Convergence is also what keeps the two sync paths honest: the
 * legacy loop used to re-sync only when `frontmatterExtra.schemaVersion`
 * moved, so a body edit without a version bump stayed stale forever.
 */
async function reconcileBuiltinAgentTemplate(
  db: DbClient,
  existing: Agent,
  definition: CreateAgent,
): Promise<void> {
  if (existing.name !== definition.name) {
    await renameAgent(db, existing.id, { newName: definition.name })
  }
  if (
    builtinAgentContentSignature(storedBuiltinAgentDefinition(existing)) !==
    builtinAgentContentSignature(definition)
  ) {
    const { name: _stableName, ...contentPatch } = definition
    await updateAgent(db, existing.id, contentPatch, null)
  }
}

/**
 * Seed platform-owned templates at daemon boot, not in a schema migration.
 * Migrations must leave an otherwise empty resource database empty; the daemon
 * owns business-resource initialization and can therefore validate collisions.
 */
export async function ensureDigitalEmployeeAgentTemplates(db: DbClient): Promise<void> {
  const templates: readonly { readonly id: string; readonly definition: CreateAgent }[] = [
    ...DIGITAL_EMPLOYEE_AGENT_TEMPLATES,
    ...DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2,
  ]
  for (const template of templates) {
    const existing = await getAgentById(db, template.id)
    if (existing !== null) {
      // The one unrecoverable case: a row that is not ours squats the stable
      // id. Converging that would overwrite somebody's own Agent, so the
      // daemon refuses instead of repairing.
      //
      // `visibility` is deliberately NOT part of this check. It is an ACL
      // decision with its own endpoint and audit trail, so a builtin that an
      // administrator made private drops out of
      // `listDigitalEmployeeAgentTemplates` (which filters on public) without
      // costing anyone their daemon.
      if (existing.ownerUserId !== SYSTEM_USER_ID || existing.builtin !== true) {
        throw new ConflictError(
          'builtin-agent-id-collision',
          `stable digital employee Agent id '${template.id}' is occupied`,
        )
      }
      await reconcileBuiltinAgentTemplate(db, existing, template.definition)
      continue
    }
    await createAgent(db, template.definition, {
      id: template.id,
      ownerUserId: SYSTEM_USER_ID,
      builtin: true,
    })
  }
}

export async function listDigitalEmployeeAgentTemplates(db: DbClient): Promise<Agent[]> {
  const resolved = await Promise.all(
    DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2.map((id) => getAgentById(db, id)),
  )
  return resolved.filter(
    (agent): agent is Agent =>
      agent !== null && agent.builtin === true && agent.visibility === 'public',
  )
}

export function digitalEmployeeBuiltinToolConfiguration(agentId: string) {
  return developmentBuiltinAgentConfigurationV2(agentId)
}

export function digitalEmployeeBuiltinAgentSuccessorId(agentId: string): string | null {
  const index = LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS.indexOf(
    agentId as (typeof LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS)[number],
  )
  return index < 0 ? null : DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[index]!
}
