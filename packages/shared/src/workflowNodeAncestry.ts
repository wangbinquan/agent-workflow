// RFC-269 — 「一个节点的执行语义由什么决定」的两个纯投影，供**所有**授权门共用。
//
// 出处是 RFC-253 的 `scripts:author` 门：它发现只看节点自身字段是不够的 ——
//
//   · **入边**决定了模板变量的名字与取值。重新接线就等于改变了那个节点实际
//     执行/发送的内容，哪怕它自己一个字符都没动。
//   · **wrapper 归属**决定了它跑不跑、跑几次。把一个节点挪进 50 次迭代的循环
//     是执行语义变更；而且归属是**传递**的（RFC-253 impl-gate 1.2：把节点原本
//     那个 1 次的循环整个塞进一个 50 次的循环，节点的直接容器没变、运行次数
//     却涨了 50 倍），所以必须走完整祖先链，并把循环的退出条款一并计入
//     （把 `exitCondition` 改成永不成立，同样能把 1 次变成 maxIterations 次）。
//
// RFC-269 的 `code-host-calls:author` 需要逐字一样的推理（入边决定回帖正文，
// wrapper 归属决定回几次帖），所以这两段从 `scriptNode.ts` 抽到这里由两个门
// 共用，而不是复制一份——复制出来的第二份迟早会漏掉下一个 impl-gate 修正。

import { isWrapperKind, type WorkflowDefinition } from './schemas/workflow'

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export interface InboundEdgeSignature {
  from: string
  to: string
}

/** 指向该节点的入边，规范排序后的稳定签名。 */
export function inboundEdgeSignature(
  definition: WorkflowDefinition,
  nodeId: string,
): InboundEdgeSignature[] {
  return definition.edges
    .filter((edge) => edge.target.nodeId === nodeId)
    .map((edge) => ({
      from: `${edge.source.nodeId}.${edge.source.portName}`,
      to: edge.target.portName,
    }))
    .sort((a, b) => cmp(a.to + a.from, b.to + b.from))
}

export interface WrapperAncestryEntry {
  id: string
  kind: string
  maxIterations: number | null
  exitCondition: unknown
  continueOnMaxIterations: unknown
}

/**
 * 该节点的**完整** wrapper 祖先链（传递闭包），带上决定运行次数的那几个字段。
 *
 * 取不动点而不是走一层：容器关系是传递的，且这个写法在畸形的环状归属图上
 * 同样会终止。
 */
export function wrapperAncestryOf(
  definition: WorkflowDefinition,
  nodeId: string,
): WrapperAncestryEntry[] {
  const ancestry = new Set<string>()
  for (;;) {
    const before = ancestry.size
    for (const candidate of definition.nodes) {
      if (!isWrapperKind(candidate.kind) || ancestry.has(candidate.id)) continue
      const ids = (candidate as unknown as Record<string, unknown>).nodeIds
      if (!Array.isArray(ids)) continue
      if (ids.includes(nodeId) || ids.some((id) => typeof id === 'string' && ancestry.has(id))) {
        ancestry.add(candidate.id)
      }
    }
    if (ancestry.size === before) break
  }
  return definition.nodes
    .filter((candidate) => ancestry.has(candidate.id))
    .map((wrapper) => {
      const rec = wrapper as unknown as Record<string, unknown>
      const raw = rec.maxIterations
      return {
        id: wrapper.id,
        kind: wrapper.kind,
        maxIterations: typeof raw === 'number' ? raw : null,
        exitCondition: rec.exitCondition ?? null,
        continueOnMaxIterations: rec.continueOnMaxIterations ?? null,
      }
    })
    .sort((a, b) => cmp(a.id, b.id))
}
