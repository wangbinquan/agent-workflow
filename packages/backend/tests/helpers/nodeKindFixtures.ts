// RFC-359 AC-1（第 9 刀第 1 步）—— **每种 NodeKind 的最小可用节点形状，单一事实源**。
//
// 这份 switch 原来长在 `retry-cascade-kind-matrix.test.ts` 里（只跑 SQLite）。
// 第 9 刀要在**两个引擎**上比同一张级联矩阵，两处各抄一份 switch 迟早漂
// ——而「两份拷贝各自都绿、却测的不是同一件事」正是本 RFC 反复清理的形态。
// 抽到这里之后两边共用，`satisfies` 的穷尽性也只需维护一次。
import type { NodeKind } from '@agent-workflow/shared'

/**
 * 给定 kind 造一个**最小可用**的节点定义。`upstreamNodeId` 只被那些需要指向上游的
 * kind 用到（`review` 的 `inputSource`）。
 *
 * `code-round` 故意抛错：它由 `startCodeRoundTask` 合成，校验器拒绝用户定义里出现它，
 * 所以它**不可能**是某个下游节点。抛错让 switch 保持穷尽，而不是假装这种图形状造得出来。
 */
export function minimalNodeOfKind(
  nodeId: string,
  kind: NodeKind,
  upstreamNodeId: string,
): Record<string, unknown> {
  switch (kind) {
    case 'agent-single':
      return { id: nodeId, kind: 'agent-single', agentName: 'x', promptTemplate: '' }
    // RFC-060 PR-E: 'agent-multi' was removed; fan-out is wrapper-fanout now.
    case 'wrapper-git':
      return { id: nodeId, kind: 'wrapper-git', nodeIds: [] }
    case 'wrapper-loop':
      return {
        id: nodeId,
        kind: 'wrapper-loop',
        nodeIds: [],
        maxIterations: 3,
        exitCondition: { kind: 'port-empty', portRef: { nodeId: 'x', portName: 'y' } },
      }
    case 'review':
      return {
        id: nodeId,
        kind: 'review',
        inputSource: { nodeId: upstreamNodeId, portName: 'out' },
      }
    case 'clarify':
      return { id: nodeId, kind: 'clarify' }
    case 'clarify-cross-agent':
      // RFC-056 — cross-clarify shares the non-process retry-cascade
      // behaviour with RFC-023 clarify (skip placeholder mint). Wiring the
      // 1-in / 2-out node here just exercises the dispatch path; the
      // upstream agent's retry never spawns a placeholder on it.
      return { id: nodeId, kind: 'clarify-cross-agent' }
    case 'wrapper-fanout':
      // RFC-060 — fanout wrapper shares the wrapper-* retry-cascade row
      // (mint placeholder on upstream retry). The minimal viable shape
      // here is enough to drive the matrix; PR-D's scheduler tests cover
      // the actual fan-out dispatch.
      return {
        id: nodeId,
        kind: 'wrapper-fanout',
        nodeIds: [],
        inputs: [{ name: 'docs', kind: 'list<string>', isShardSource: true }],
      }
    case 'output':
      return { id: nodeId, kind: 'output' }
    case 'input':
      return { id: nodeId, kind: 'input', inputKey: 'topic' }
    case 'call-workflow':
      // RFC-243 — a call node is process-bearing (an independent child
      // task); upstream retries mint it a placeholder like any wrapper.
      return { id: nodeId, kind: 'call-workflow', workflowName: 'child-wf' }
    case 'call-workgroup':
      return {
        id: nodeId,
        kind: 'call-workgroup',
        workgroupName: 'child-wg',
        goalTemplate: 'do {{out}}',
      }
    case 'script':
      // RFC-253 — a script node runs a real subprocess, so it shares the
      // process-bearing retry-cascade row: an upstream retry mints it a
      // placeholder exactly like an agent or a wrapper.
      return { id: nodeId, kind: 'script', language: 'bash', script: 'echo hi' }
    case 'code-host-call':
      // RFC-269 — a code-host call has REAL external side effects (a comment
      // gets posted), so it is process-bearing and cascades like the rest:
      // an upstream retry must mint it a placeholder, otherwise the retried
      // chain would silently skip the step that reports its result.
      return {
        id: nodeId,
        kind: 'code-host-call',
        provider: 'gitlab',
        action: 'comment.create',
        params: { mr: '1', body: '{{out}}' },
      }
    case 'code-round':
      // RFC-304 — `code-round` is synthesized by startCodeRoundTask, never
      // authored into a user definition (the validator rejects it), so it can
      // never BE a downstream node in this matrix. It still shares the
      // process-kind retry-cascade row ('mint-placeholder'), which is asserted
      // directly against NODE_KIND_BEHAVIORS in node-kind-behavior-table.test.
      // Throwing here keeps the switch exhaustive without pretending this
      // graph shape is constructible.
      throw new Error('code-round is synthesized-only and cannot be a downstream node')
    default: {
      const _exhaustive: never = kind
      throw new Error(`unexpected kind ${_exhaustive as string}`)
    }
  }
}
