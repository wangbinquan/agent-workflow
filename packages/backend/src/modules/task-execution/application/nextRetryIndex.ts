/**
 * Provider-neutral retry-index allocator over an already-frozen row set.
 * Callers retain ownership of their provider transaction and query scope.
 */

import { nodeRunAttemptIndex } from '../domain/nodeRunAttempt'
/**
 * RFC-284 T21（§4）——「下一个 retry_index」五处手写口径的唯一实现。
 *
 * 纯函数吃调用方已读的行集（**不自带查询**——五个调用点各有自己的行集读法与
 * 事务性，收编读法会改热路径的读行为；实施偏差已记 plan.md §实施记录）。
 * 口径差异参数化：
 *   - topLevelOnly：只数 parentNodeRunId === null 的行（taskQuestionDispatch 口径；
 *     task.ts 的 retry-cascade 刻意含 child rows，不传）
 *   - iteration：只数该迭代的行（taskQuestionDispatch 口径；scheduler 的
 *     sameNodeIterRuns 已在查询里限定迭代，不传）
 * 空集 → 0（与历史两种写法 reduce(…,-1)+1 / length===0?0:max()+1 同值）。
 * review.ts 的「latest 单行 +1」= 单元素集特例，经此函数语义不变。
 *
 * （RFC-468：本段注释随 `services/nodeRunMint.ts` 的转出删除迁来。）
 */
export function nextRetryIndex(
  rows: ReadonlyArray<{
    readonly retryIndex: number
    readonly parentNodeRunId?: string | null
    readonly iteration?: number
  }>,
  opts: { readonly topLevelOnly?: boolean; readonly iteration?: number } = {},
): number {
  return nodeRunAttemptIndex({ kind: 'max-plus-one', rows, ...opts })
}
