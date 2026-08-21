import type { Agent, CreateAgent } from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DbClient } from '@/db/client'
import { ConflictError } from '@/util/errors'
import { createAgent, getAgentById } from './agent'

export const DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS = [
  '00000000000000DECODEWRITER',
  '00000000000000DEDIAGNOSE',
  '00000000000000DEPIPEFIX',
  '00000000000000DEREVIEWFIX',
  '00000000000000DECONFLICTFIX',
  '00000000000000DEFEATUREDEV',
  '00000000000000DEISSUEFIX',
] as const

interface DigitalEmployeeAgentTemplate {
  readonly id: (typeof DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS)[number]
  readonly definition: CreateAgent
}

const DIGITAL_EMPLOYEE_AGENT_TEMPLATES: readonly DigitalEmployeeAgentTemplate[] = [
  {
    id: DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[0],
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
        schemaVersion: 1,
        executionContracts: [
          { contractId: 'development.analyze-implement', version: 1 },
          { contractId: 'development.repair-conflict', version: 1 },
        ],
      },
      bodyMd:
        '你是数字员工操作系统内置的代码编写者。只处理输入 envelope 中已授权的业务文件和目标；不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。先理解需求与现有代码，再完成最小且完整的实现和必要验证。最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。',
    },
  },
  {
    id: DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[1],
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
        schemaVersion: 1,
        executionContracts: [{ contractId: 'development.classify-pipeline', version: 1 }],
      },
      bodyMd:
        '你是数字员工操作系统内置的问题定位者。只依据输入 envelope、仓库现场和 artifact 引用收集证据，区分事实、推断与未知项；不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。定位最小根因并给出合同要求的结构化产出。最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。',
    },
  },
  {
    id: DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[2],
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
        schemaVersion: 1,
        executionContracts: [{ contractId: 'development.repair-pipeline', version: 1 }],
      },
      bodyMd:
        '你是数字员工操作系统内置的流水线修复者。读取输入 envelope 指向的 .agent-workflow/pipeline 证据包与日志，不要把大日志复述进输出。只修复指定失败类型和授权业务文件；不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。完成最小验证后，只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。',
    },
  },
  {
    id: DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[3],
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
        schemaVersion: 1,
        executionContracts: [{ contractId: 'development.repair-feedback', version: 1 }],
      },
      bodyMd:
        '你是数字员工操作系统内置的检视意见修复者。输入中的每个 reviewThread 都包含根评论和全部多轮回复，必须结合整棵线程理解审阅者意图并修复授权业务文件。不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得直接回复或 resolve 评论。输出 envelope 必须更新 development.review-resolution：为每个输入的 threadRef 与 revision 恰好返回一条 disposition 和具体 replyBody，说明如何修复或为什么需要人工决策，同时保留平台已有 acknowledgement 回执。最终只向 agent-result 输出 JSON envelope，不得夹带 Markdown、解释文字或额外端口。',
    },
  },
  {
    id: DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[4],
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
        schemaVersion: 1,
        executionContracts: [{ contractId: 'development.repair-conflict', version: 1 }],
      },
      bodyMd:
        '你是数字员工操作系统内置的代码冲突修复者。只在平台冻结的冲突现场中理解双方变更意图，修改合同授权的冲突文件，并完成最小验证。不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得改变固定父提交或自行选择下一步。最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。',
    },
  },
  {
    id: DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[5],
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
        schemaVersion: 1,
        executionContracts: [{ contractId: 'development.analyze-implement', version: 1 }],
      },
      bodyMd:
        '你是数字员工操作系统内置的业务需求实现者。依据冻结需求、验收目标和仓库事实理解既有领域边界，完成最小且完整的业务代码、必要测试与说明。不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。',
    },
  },
  {
    id: DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[6],
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
        schemaVersion: 1,
        executionContracts: [{ contractId: 'development.analyze-implement', version: 1 }],
      },
      bodyMd:
        '你是数字员工操作系统内置的代码问题修复者。先用冻结问题材料、复现证据和仓库事实定位可验证根因，再实施最小修复并补充针对性回归验证；不要借机重构无关代码。不得执行 git、commit、push、merge、approve，不得调用代码托管平台，也不得自行选择下一步。最终只向 agent-result 输出工作合同要求的 JSON envelope；不得夹带 Markdown、解释文字或额外端口。',
    },
  },
]

/**
 * Seed platform-owned templates at daemon boot, not in a schema migration.
 * Migrations must leave an otherwise empty resource database empty; the daemon
 * owns business-resource initialization and can therefore validate collisions.
 */
export async function ensureDigitalEmployeeAgentTemplates(db: DbClient): Promise<void> {
  for (const template of DIGITAL_EMPLOYEE_AGENT_TEMPLATES) {
    const existing = await getAgentById(db, template.id)
    if (existing !== null) {
      if (
        existing.name !== template.definition.name ||
        existing.ownerUserId !== SYSTEM_USER_ID ||
        existing.visibility !== 'public' ||
        existing.builtin !== true
      ) {
        throw new ConflictError(
          'builtin-agent-id-collision',
          `stable digital employee Agent id '${template.id}' is occupied`,
        )
      }
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
    DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS.map((id) => getAgentById(db, id)),
  )
  return resolved.filter(
    (agent): agent is Agent =>
      agent !== null && agent.builtin === true && agent.visibility === 'public',
  )
}
