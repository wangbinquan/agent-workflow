// RFC-310 PR-4 T41 —— digital-employee host 的合同叶（镜像 codeRoundContract）。
//
// 一次 AgentAttempt = 一个 digital-employee host task：builtin FK anchor +
// 单 agent 节点的 synthesized snapshot，任务本身对下游（cancel/interrupted
// 修复/资源限额/详情页）完全普通——这正是把 attempt 放上 task engine 而不是
// 直接 runSystemAgent 的全部理由（RFC-304 D5 的同款判断）。
//
// 本文件保持叶子：常量 + 纯 snapshot 合成，零 service import——outcome 投影
// （execution/outcome.ts）与装配（composition/agentActionExecution.ts）都要
// 引用这里的 id，把它们放进会 import task.ts 的文件就闭环了（codeRoundContract
// 顶注记录过同一形状的教训）。

import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'

export const DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID = '00000000000000DIGEMPHOST0'
export const DIGITAL_EMPLOYEE_HOST_WORKFLOW_NAME = '__digital_employee_host__'

/** 与 agent host `__agent_main__` 同族的命名，node_runs dump 里一眼可辨。 */
export const DIGITAL_EMPLOYEE_INPUT_NODE_ID = '__de_input__'
export const DIGITAL_EMPLOYEE_AGENT_NODE_ID = '__de_agent__'
export const DIGITAL_EMPLOYEE_SCRIPT_NODE_ID = '__de_script__'
export const DIGITAL_EMPLOYEE_OUTPUT_NODE_ID = '__de_output__'
export const DIGITAL_EMPLOYEE_PROMPT_KEY = 'prompt'

/**
 * Agent 唯一结果端口。与 development-automation/domain/agentEnvelope 的
 * AGENT_RESULT_PORT **结构配对**（两模块互不 import 内部；字面一致由
 * rfc310-pr4 测试锁定）。执行侧只搬运该端口的原始文本，envelope 的
 * nonce/schema/语义校验全部归 development-automation 的 parser。
 */
export const DIGITAL_EMPLOYEE_RESULT_PORT = 'agent-result'

export interface DigitalEmployeeHostSnapshotInput {
  /** 模板 executor 解析出的 agent 资源（canonical id + 当前名字）。 */
  readonly agentId: string
  readonly agentName: string
}

/**
 * 合成 host snapshot：input(prompt) → agent-single → output(agent-result)。
 * prompt 经输入端口注入（值不再被模板引擎二次展开——不可信需求文本里出现
 * `{{...}}` 只是材料，agent host 同款防线）；输出节点让 RFC-243 统一 outcome
 * 投影（workflow kind 走 output-node ports）原样适用，零新增投影分支。
 * 无 clarify 节点：数字员工的问答走 Mission 的 closed question-set 闭环
 * （RFC-310 §7.4 needs-information outcome），不开交互 clarify 通道。
 */
export function synthesizeDigitalEmployeeHostSnapshot(input: DigitalEmployeeHostSnapshotInput): {
  $schema_version: number
  inputs: unknown[]
  nodes: unknown[]
  edges: unknown[]
} {
  return {
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [
      {
        kind: 'text',
        key: DIGITAL_EMPLOYEE_PROMPT_KEY,
        label: 'Digital employee prompt',
        required: true,
        multiline: true,
      },
    ],
    nodes: [
      {
        id: DIGITAL_EMPLOYEE_INPUT_NODE_ID,
        kind: 'input',
        inputKey: DIGITAL_EMPLOYEE_PROMPT_KEY,
      },
      {
        id: DIGITAL_EMPLOYEE_AGENT_NODE_ID,
        kind: 'agent-single',
        agentId: input.agentId,
        agentName: input.agentName,
        promptTemplate: `{{${DIGITAL_EMPLOYEE_PROMPT_KEY}}}`,
      },
      {
        id: DIGITAL_EMPLOYEE_OUTPUT_NODE_ID,
        kind: 'output',
        ports: [
          {
            name: DIGITAL_EMPLOYEE_RESULT_PORT,
            bind: {
              nodeId: DIGITAL_EMPLOYEE_AGENT_NODE_ID,
              portName: DIGITAL_EMPLOYEE_RESULT_PORT,
            },
          },
        ],
      },
    ],
    edges: [
      {
        id: 'e_de_prompt',
        source: {
          nodeId: DIGITAL_EMPLOYEE_INPUT_NODE_ID,
          portName: DIGITAL_EMPLOYEE_PROMPT_KEY,
        },
        target: {
          nodeId: DIGITAL_EMPLOYEE_AGENT_NODE_ID,
          portName: DIGITAL_EMPLOYEE_PROMPT_KEY,
        },
      },
      {
        id: 'e_de_result',
        source: {
          nodeId: DIGITAL_EMPLOYEE_AGENT_NODE_ID,
          portName: DIGITAL_EMPLOYEE_RESULT_PORT,
        },
        target: {
          nodeId: DIGITAL_EMPLOYEE_OUTPUT_NODE_ID,
          portName: DIGITAL_EMPLOYEE_RESULT_PORT,
        },
      },
    ],
  }
}

export interface DigitalEmployeeScriptHostSnapshotInput {
  readonly language: 'python' | 'bash' | 'node'
  readonly script: string
  readonly dependencies: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly readonly: boolean
}

/**
 * Script implementations travel through the same TaskEngine host as Agent
 * implementations. The authored program is frozen into the task snapshot,
 * receives the platform prompt through AW_PORT_PROMPT, and must emit the exact
 * `agent-result` output envelope. No direct Bun.spawn shortcut exists here.
 */
export function synthesizeDigitalEmployeeScriptHostSnapshot(
  input: DigitalEmployeeScriptHostSnapshotInput,
): { $schema_version: number; inputs: unknown[]; nodes: unknown[]; edges: unknown[] } {
  return {
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [
      {
        kind: 'text',
        key: DIGITAL_EMPLOYEE_PROMPT_KEY,
        label: 'Digital employee prompt',
        required: true,
        multiline: true,
      },
    ],
    nodes: [
      { id: DIGITAL_EMPLOYEE_INPUT_NODE_ID, kind: 'input', inputKey: DIGITAL_EMPLOYEE_PROMPT_KEY },
      {
        id: DIGITAL_EMPLOYEE_SCRIPT_NODE_ID,
        kind: 'script',
        language: input.language,
        script: input.script,
        dependencies: [...input.dependencies],
        env: { ...input.env },
        readonly: input.readonly,
      },
      {
        id: DIGITAL_EMPLOYEE_OUTPUT_NODE_ID,
        kind: 'output',
        ports: [
          {
            name: DIGITAL_EMPLOYEE_RESULT_PORT,
            bind: {
              nodeId: DIGITAL_EMPLOYEE_SCRIPT_NODE_ID,
              portName: 'stdout',
            },
          },
        ],
      },
    ],
    edges: [
      {
        id: 'e_de_script_prompt',
        source: { nodeId: DIGITAL_EMPLOYEE_INPUT_NODE_ID, portName: DIGITAL_EMPLOYEE_PROMPT_KEY },
        target: { nodeId: DIGITAL_EMPLOYEE_SCRIPT_NODE_ID, portName: DIGITAL_EMPLOYEE_PROMPT_KEY },
      },
      {
        id: 'e_de_script_result',
        source: {
          nodeId: DIGITAL_EMPLOYEE_SCRIPT_NODE_ID,
          portName: 'stdout',
        },
        target: {
          nodeId: DIGITAL_EMPLOYEE_OUTPUT_NODE_ID,
          portName: DIGITAL_EMPLOYEE_RESULT_PORT,
        },
      },
    ],
  }
}
