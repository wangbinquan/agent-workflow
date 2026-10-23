/** RFC-395 II-a A3 / G8：保留各分配规则的数值，不把 attempt 当成时间顺序。 */
export interface NodeRunAttemptFact {
  readonly retryIndex: number
  readonly parentNodeRunId?: string | null
  readonly iteration?: number
}

export type NodeRunAttemptRule =
  | {
      readonly kind: 'max-plus-one'
      /** 调用方保持旧查询范围（可以跨帧、跨 parent）。 */
      readonly rows: readonly NodeRunAttemptFact[]
      readonly topLevelOnly?: boolean
      readonly iteration?: number
    }
  | { readonly kind: 'workgroup-revival'; readonly rows: readonly NodeRunAttemptFact[] }
  | { readonly kind: 'offset'; readonly base: number; readonly offset: number }
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'explicit'; readonly attempt?: number }

export function nodeRunAttemptIndex(rule: NodeRunAttemptRule): number {
  switch (rule.kind) {
    case 'max-plus-one': {
      let max = -1
      for (const row of rule.rows) {
        if (rule.topLevelOnly === true && (row.parentNodeRunId ?? null) !== null) continue
        if (rule.iteration !== undefined && row.iteration !== rule.iteration) continue
        if (row.retryIndex > max) max = row.retryIndex
      }
      return max + 1
    }
    // 原工作组只对非空 group 调用 Math.max，没有 -1 下限。
    case 'workgroup-revival':
      return Math.max(...rule.rows.map((row) => row.retryIndex)) + 1
    case 'offset':
      return rule.base + rule.offset
    case 'count':
      return rule.count
    case 'explicit':
      return rule.attempt ?? 0
  }
}
