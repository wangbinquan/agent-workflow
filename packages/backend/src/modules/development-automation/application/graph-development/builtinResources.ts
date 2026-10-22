import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  CreateAgentSchema,
  WorkflowDefinitionSchema,
  WORKFLOW_SCHEMA_VERSION,
  CLARIFY_SOURCE_PORT_NAME,
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  type CreateAgent,
  type CreateWorkflow,
} from '@agent-workflow/shared'
import { graphToolResultSchema } from './toolContracts'

export const GRAPH_BUILTIN_IDS = {
  designer: '00000000000000GRAPHDESIGN1',
  clarifier: '00000000000000GRAPHCLRFY1',
  reviewer: '00000000000000GRAPHREVIEW1',
  // A published v1 prompt was changed in 3a36ce4c7. Preserve either installed
  // v1 snapshot for frozen work; new requests select a distinct immutable v2.
  implementer: '00000000000000GRAPHBUILD2',
  designWorkflow: '00000000000000GRAPHWFDS1',
  reviewWorkflow: '00000000000000GRAPHWFRV1',
} as const
export function graphOutputInstructions(
  item: 'design-and-clarify' | 'implement-change' | 'review-design',
) {
  return `Business output JSON schema:\n${JSON.stringify(zodToJsonSchema(graphToolResultSchema(item), { $refStrategy: 'none' }))}`
}
const base = {
  permission: {},
  skills: [],
  dependsOn: [],
  inputs: [],
  mcp: [],
  plugins: [],
  syncOutputsOnIterate: true,
}
const behaviorInstructions = `有限状态/决策表验收可在 execution.modelCheck 指定 modelId、programRef(repo: 相对可执行文件)、inputs、depth/paths/timeoutMs。实现者须编写真实适配器调用业务代码，读取 stdin JSON：{schemaVersion:1,modelId,kind:'state'|'decision-table',input,actions:[{event,actionRef,assertionRefs}]?,assertionRefs?}。stdout 只输出 JSON {states?:[实际初始与各步状态],assertions:{断言ID:真实布尔值},outputs?:[实际决策结果]}。不得回显期望值代替真实调用。平台按冻结模型枚举有限路径和输入并比对实际输出；缺少事件/断言绑定或达到边界必须记不完整。profile 仍须执行真实单元/集成测试。`
export const GRAPH_BUILTIN_AGENTS: readonly { id: string; definition: CreateAgent }[] = [
  {
    id: GRAPH_BUILTIN_IDS.designer,
    definition: CreateAgentSchema.parse({
      ...base,
      name: 'graph-development-designer-v1',
      description: '按需求和预算提出自适应视图组合，使用原澄清宿主保留人的判断。',
      outputs: ['design-model', 'agent-result'],
      frontmatterExtra: {
        executionContracts: [{ contractId: 'graph-development.design-and-clarify', version: 1 }],
      },
      bodyMd: `读取完整需求文件、仓库和输入 materials.document。向 design-model 输出当前设计 JSON（{summary,result:{document,candidates}}），并向 agent-result 输出相同 JSON。此节点只提交设计输出，不提出 workflow-clarify；把待确认事项记录为 open 关注点和明确假设，由后续独立澄清节点询问。不要在回答尚未提交时生成任何人的选择、成熟度、负责人或承诺日期。平台将从原澄清记录导入人的来源。不得改动业务代码、Git 或平台材料。\n按当前需要推导关注点；提出多种有实质差异的候选组合，说明覆盖收益、阅读成本、替代项与缺口。不得固定输出某几类图。简单需求允许一张图；新增并发、乱序、权限或数据约束时增补合适的表达，过时/冗余表达可归档，用户固定项必须保留。仅使用输入提供的表达器版本。为所有语义对象保留稳定 ID，引用必须闭合。验收义务必须具体：引用材料中真实 profile 的 id/revision/digest 及计划测试引用，或明确写 manual/unassigned，不能编造已执行结果。不得把图结构一致视为代码正确。\n${behaviorInstructions}\n${graphOutputInstructions('design-and-clarify')}`,
    }),
  },
  {
    id: GRAPH_BUILTIN_IDS.clarifier,
    definition: CreateAgentSchema.parse({
      ...base,
      name: 'graph-development-clarifier-v1',
      description: '围绕上游已提交的图模型提出原生澄清，保留人作出的原始判断。',
      outputs: ['agent-result'],
      frontmatterExtra: {},
      bodyMd: `先读取 COMMITTED_DESIGN_JSON 中上游已提交的设计，并结合原始工作材料。需要确认时只输出平台 workflow-clarify 问题；不同时输出 workflow-output。问题附 artifactAnchor:{artifactRef:document.id,elementIds:[已存在的稳定ID],relationIds:[],viewId?}。等待人回答时，上游已提交的图仍可见。收到回答后保留原话、选项、自定义回答和成熟度，不代填未知负责人/日期。仍有关键未定项可沿原生澄清继续追问；无需更多问题后，仅向 agent-result 返回更新后的 {summary,result:{document,candidates}}。人的来源由平台从原澄清记录导入，不伪造来源。按需要调整关注点和候选图组合，保留固定视图和实际 profile 版本。不得修改任何文件。\n${behaviorInstructions}\n${graphOutputInstructions('design-and-clarify')}`,
    }),
  },
  {
    id: GRAPH_BUILTIN_IDS.reviewer,
    definition: CreateAgentSchema.parse({
      ...base,
      name: 'graph-development-review-material-v1',
      description: '将平台冻结的实现依据交给原生人工审核。',
      outputs: ['basis-document'],
      outputKinds: { 'basis-document': 'path<md>' },
      frontmatterExtra: {},
      bodyMd:
        '读取输入中的 materials.reviewDocumentPath 和 materials.basis，确认材料存在且未改变。basis-document 端口必须且只能输出 materials.reviewDocumentPath 的原始路径字符串。不得重写文件、批准、拒绝或自行生成审核决定。此后由平台的 review 节点请求人决定。',
    }),
  },
  {
    id: GRAPH_BUILTIN_IDS.implementer,
    definition: CreateAgentSchema.parse({
      ...base,
      name: 'graph-development-implementer-v2',
      description: '根据已经批准的冻结依据完成代码和测试，并提供待平台核对的追溯。',
      outputs: ['agent-result'],
      frontmatterExtra: {
        executionContracts: [{ contractId: 'graph-development.implement-change', version: 1 }],
      },
      bodyMd: `读取 materials.basis 全部材料及其原始回答、暂定判断和未定项，仅实现 includedElementIds 指定范围。完成全部代码和必要测试用例后才集中运行检查；平台随后还会独立执行已登记 profile。不得执行 Git、提交、推送、修改平台材料或自行批准。每个需求必须有准确的文件、符号和测试追溯；testRef 使用相对路径或 path#测试名，symbol 必须是文件中可定位的实际文本。无法实现的部分如实写 limitations。agent-result 只输出业务 JSON。\n${behaviorInstructions}\n${graphOutputInstructions('implement-change')}`,
    }),
  },
]
const edge = (id: string, source: string, port: string, target: string, targetPort = port) => ({
  id,
  source: { nodeId: source, portName: port },
  target: { nodeId: target, portName: targetPort },
})
const input = { kind: 'text', key: 'prompt', label: '工作材料', required: true, multiline: true }
const readPortScript = `import * as fs from 'node:fs';\nconst port = name => process.env['AW_PORT_FILE_' + name] ? fs.readFileSync(process.env['AW_PORT_FILE_' + name], 'utf8') : process.env['AW_PORT_' + name];\n`
export const GRAPH_BUILTIN_WORKFLOWS: readonly {
  id: string
  item: 'design-and-clarify' | 'review-design'
  definition: CreateWorkflow
}[] = [
  {
    id: GRAPH_BUILTIN_IDS.designWorkflow,
    item: 'design-and-clarify',
    definition: {
      name: 'graph-development-design-and-clarify-v1',
      description: '设计内容在等待人工澄清时即可读取；人的回答沿用原澄清循环。',
      definition: WorkflowDefinitionSchema.parse({
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [input],
        nodes: [
          { id: 'input', kind: 'input', inputKey: 'prompt' },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: GRAPH_BUILTIN_IDS.designer,
            agentName: 'graph-development-designer-v1',
            promptTemplate: '{{prompt}}',
          },
          {
            id: 'clarifier',
            kind: 'agent-single',
            agentId: GRAPH_BUILTIN_IDS.clarifier,
            agentName: 'graph-development-clarifier-v1',
            promptTemplate: '{{prompt}}\n\nCOMMITTED_DESIGN_JSON\n\n{{design_model}}',
          },
          {
            id: 'clarify',
            kind: 'clarify',
            interactionMode: 'mindmap',
            mindmap: { categories: ['目标与范围', '业务行为', '约束与验收'] },
            sessionMode: 'isolated',
            clarifyMode: 'optional',
          },
          {
            id: 'output',
            kind: 'output',
            ports: [
              { name: 'agent-result', bind: { nodeId: 'clarifier', portName: 'agent-result' } },
            ],
          },
        ],
        edges: [
          edge('input-designer', 'input', 'prompt', 'designer'),
          edge('input-clarifier', 'input', 'prompt', 'clarifier'),
          edge('design-clarifier', 'designer', 'design-model', 'clarifier', 'design_model'),
          edge(
            'design-questions',
            'clarifier',
            CLARIFY_SOURCE_PORT_NAME,
            'clarify',
            CLARIFY_INPUT_PORT_NAME,
          ),
          edge(
            'clarify-answers',
            'clarify',
            CLARIFY_OUTPUT_PORT_NAME,
            'clarifier',
            CLARIFY_RESPONSE_TARGET_PORT_NAME,
          ),
          edge('result', 'clarifier', 'agent-result', 'output'),
        ],
      }),
    },
  },
  {
    id: GRAPH_BUILTIN_IDS.reviewWorkflow,
    item: 'review-design',
    definition: {
      name: 'graph-development-review-design-v1',
      description: '审核冻结依据并返回实际决定；拒绝和迭代不重跑冻结材料。',
      definition: WorkflowDefinitionSchema.parse({
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [input],
        nodes: [
          { id: 'input', kind: 'input', inputKey: 'prompt' },
          {
            id: 'material',
            kind: 'agent-single',
            agentId: GRAPH_BUILTIN_IDS.reviewer,
            agentName: 'graph-development-review-material-v1',
            promptTemplate: '{{prompt}}',
          },
          {
            id: 'review',
            kind: 'review',
            decisionHandling: 'return-decision',
            rerunnableOnReject: [],
            rerunnableOnIterate: [],
            rollbackFilesOnReject: false,
            rollbackFilesOnIterate: false,
          },
          {
            id: 'receipt',
            kind: 'script',
            language: 'node',
            readonly: true,
            script:
              readPortScript +
              `const prompt = port('PROMPT'); const marker = '\\nINPUT_JSON\\n'; const start = prompt.lastIndexOf(marker); if (start < 0) throw new Error('graph-input-json-missing'); const input = JSON.parse(prompt.slice(start + marker.length)); const receipt = JSON.parse(port('DECISION_META')); console.log(JSON.stringify({summary:'审核决定：' + receipt.decision,result:{basisId:input.materials.basis.id,basisDigest:input.materials.basis.digest,receipt}}));`,
          },
          {
            id: 'output',
            kind: 'output',
            ports: [{ name: 'agent-result', bind: { nodeId: 'receipt', portName: 'stdout' } }],
          },
        ],
        edges: [
          edge('input-material', 'input', 'prompt', 'material'),
          edge('material-review', 'material', 'basis-document', 'review', '__review_input__'),
          edge('decision', 'review', 'decision_meta', 'receipt'),
          edge('input-receipt', 'input', 'prompt', 'receipt'),
          edge('receipt-result', 'receipt', 'stdout', 'output', 'agent-result'),
        ],
      }),
    },
  },
]
