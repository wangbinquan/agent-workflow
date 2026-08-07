// RFC-269 §8 — `code-host-calls:author` 门判定的**敏感投影**。
//
// 与 RFC-253 的脚本门同构：被门住的是"这个节点会对代码平台做什么"，不是整份
// 文档。没有该权限的作者仍然可以移动节点、改标题、编辑同一份工作流的其它部分；
// 不能改的是**平台会以管理员的 token 发出什么请求**——这包括：
//
//   · provider / action / 定型参数 / 自定义请求 / DELETE 闸 / 超时；
//   · 该节点的**入边**（决定 `{{port}}` 取到什么，也就是回帖正文是什么）；
//   · 该节点的 **wrapper 归属**（决定回几次帖 —— 挪进 50 次的循环就是 50 条
//     评论）。
//
// 后两项与脚本门逐字同理，因此复用 `workflowNodeAncestry.ts` 的共享投影。

import { canonicalJson } from '../workflow-canonical'
import { inboundEdgeSignature, wrapperAncestryOf } from '../workflowNodeAncestry'
import type { WorkflowDefinition, WorkflowNode } from '../schemas/workflow'

export const CODE_HOST_SENSITIVE_PROJECTION_DOMAIN_V1 = 'code-host-sensitive/v1\n'

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function record(node: WorkflowNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>
}

function readParams(node: WorkflowNode): Record<string, string> {
  const raw = record(node).params
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  // 规范排序：键序变化不该被当成"改了执行语义"。
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => cmp(a, b)))
}

/** True when the definition contains at least one code-host call node. */
export function definitionHasCodeHostCallNode(definition: WorkflowDefinition): boolean {
  return definition.nodes.some((node) => node.kind === 'code-host-call')
}

export function serializeCodeHostSensitiveProjectionV1(definition: WorkflowDefinition): string {
  const rows = definition.nodes
    .filter((node) => node.kind === 'code-host-call')
    .map((node) => {
      const rec = record(node)
      return {
        id: node.id,
        provider: typeof rec.provider === 'string' ? rec.provider : null,
        action: typeof rec.action === 'string' ? rec.action : null,
        params: readParams(node),
        // 自定义请求整体入投影：method / path / query / body 任一变化都是
        // "发出去的东西变了"。
        request: rec.request ?? null,
        allowDestructive: rec.allowDestructive === true,
        timeoutMs: typeof rec.timeoutMs === 'number' ? rec.timeoutMs : null,
        inbound: inboundEdgeSignature(definition, node.id),
        wrappers: wrapperAncestryOf(definition, node.id),
      }
    })
    .sort((a, b) => cmp(a.id, b.id))
  return `${CODE_HOST_SENSITIVE_PROJECTION_DOMAIN_V1}${canonicalJson(rows)}`
}
