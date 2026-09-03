// RFC-353 T4（RFC-294 W4-E3）—— 内建融合工作流的 canonical 定义（纯，零 IO）。
//
// 从 `services/fusion.ts` 逐字平移。这张图是**内建资源的事实源**：daemon 启动时按它播种 /
// 对账内建 workflow，节点 id、端口名与 clarify 回边一个都不能变——变了等于换了一个工作流，
// 存量融合任务的重放会对不上。
//
// 平移时按字节对拍过原文（`rfc353-fusion-domain-verbatim.test.ts`）。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'

import type { FusionBuiltinWorkflowSeed } from '@/modules/knowledge-evolution/public/types'
import { FUSION_WORKFLOW_DESCRIPTION, MERGER_PROMPT_TEMPLATE } from './fusionPrompt'

/**
 * 内建资源的 id / name 由调用方注入，**domain 不去 legacy 取**。
 *
 * 它们的单一事实源是 `services/systemResources`（同一份清单还喂着「内建资源不在列表里显示」
 * 的过滤器）。domain 直接 import 那里会造出一条「模块内部反向依赖 legacy」的边——
 * RFC-317 R2 明令禁止，而且按 B0 口径这类债只允许落在 application 层，不允许落在 domain。
 * 做成入参之后这一层重新变纯：给什么 id 就画什么图，测试也能随便造。
 */
export interface FusionBuiltinResourceIdentity {
  readonly workflowId: string
  readonly workflowName: string
  readonly mergerAgentId: string
  readonly mergerAgentName: string
}

export function canonicalFusionWorkflowDefinition(
  identity: FusionBuiltinResourceIdentity,
): WorkflowDefinition {
  return {
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [
      { kind: 'text', key: 'intent', label: 'Merge intent', required: false },
      { kind: 'text', key: 'memories', label: 'Memories', required: true },
    ],
    nodes: [
      { id: 'in_intent', kind: 'input', inputKey: 'intent' },
      { id: 'in_memories', kind: 'input', inputKey: 'memories' },
      {
        id: 'merger',
        kind: 'agent-single',
        agentId: identity.mergerAgentId,
        agentName: identity.mergerAgentName,
        promptTemplate: MERGER_PROMPT_TEMPLATE,
      },
      { id: 'clarify', kind: 'clarify', title: 'Confirm fusion' },
    ],
    edges: [
      {
        id: 'e_intent',
        source: { nodeId: 'in_intent', portName: 'intent' },
        target: { nodeId: 'merger', portName: 'intent' },
      },
      {
        id: 'e_memories',
        source: { nodeId: 'in_memories', portName: 'memories' },
        target: { nodeId: 'merger', portName: 'memories' },
      },
      {
        id: 'e_ask',
        source: { nodeId: 'merger', portName: '__clarify__' },
        target: { nodeId: 'clarify', portName: 'questions' },
      },
      {
        id: 'e_ans',
        source: { nodeId: 'clarify', portName: 'answers' },
        target: { nodeId: 'merger', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

export function fusionBuiltinWorkflowSeed(
  identity: FusionBuiltinResourceIdentity,
): FusionBuiltinWorkflowSeed {
  return {
    id: identity.workflowId,
    name: identity.workflowName,
    description: FUSION_WORKFLOW_DESCRIPTION,
    definition: canonicalFusionWorkflowDefinition(identity),
    mergerAgentId: identity.mergerAgentId,
  }
}
