// RFC-310 T25 —— durable wait/wake 语义（design.md §4.8）。
//
// wait decision 持久化为 deferred wake 行（resumeAt + wake sources + attempt
// ordinal），daemon 重启不重置 backoff；外部 wake 可以提前唤醒但**不清零**
// ordinal（清零等于把「第 5 次重试」洗成「第 1 次」，预算就名存实亡）。
// settle 后行关闭；同一 decision 只有一行（唯一索引）。

export interface DeferredWakeRow {
  readonly missionId: string
  readonly decisionId: string
  readonly reason: string
  readonly resumeAt: number | null
  readonly wakeSources: readonly ('webhook' | 'pipeline' | 'requirement' | 'timer' | 'manual')[]
  readonly attemptOrdinal: number
  readonly state: 'armed' | 'fired' | 'settled'
}

export type WakeTrigger =
  | { readonly kind: 'timer'; readonly now: number }
  | {
      readonly kind: 'external'
      readonly source: 'webhook' | 'pipeline' | 'requirement' | 'manual'
    }

export type WakeVerdict =
  | { readonly fire: true; readonly early: boolean }
  | { readonly fire: false; readonly code: 'not-armed' | 'source-not-subscribed' | 'not-due' }

/** 判定一个触发是否唤醒该行；early=true 表示外部源先于 resumeAt 到达。 */
export function evaluateWake(row: DeferredWakeRow, trigger: WakeTrigger): WakeVerdict {
  if (row.state !== 'armed') return { fire: false, code: 'not-armed' }
  if (trigger.kind === 'timer') {
    if (row.resumeAt === null) return { fire: false, code: 'not-due' }
    if (trigger.now < row.resumeAt) return { fire: false, code: 'not-due' }
    return { fire: true, early: false }
  }
  if (!row.wakeSources.includes(trigger.source)) {
    return { fire: false, code: 'source-not-subscribed' }
  }
  const early = row.resumeAt !== null
  return { fire: true, early }
}

/**
 * fire 之后重新 arm 的 ordinal：永远 +1——无论是否 early。重启恢复用同一
 * 函数从持久化行重放，因此内存里没有任何定时器状态可丢。
 */
export function nextAttemptOrdinal(row: DeferredWakeRow): number {
  return row.attemptOrdinal + 1
}
