import type { Agent, CreateAgent } from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DbClient } from '@/db/client'
import { ConflictError } from '@/util/errors'
import { createAgent, getAgentById } from './agent'

export const DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS = [
  '00000000000000DECODEWRITER',
  '00000000000000DEDIAGNOSE',
  '00000000000000DEPIPEFIX',
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
          { contractId: 'development.repair-feedback', version: 1 },
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
        executionContracts: [
          { contractId: 'development.classify-feedback', version: 1 },
          { contractId: 'development.classify-pipeline', version: 1 },
        ],
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
