import type { DevelopmentActivityOperations, DevelopmentActivityResult } from '../public/operations'

export interface DevelopmentActivityWorker {
  runOneOutbox(): Promise<'completed' | 'retried' | 'idle'>
  pumpOneDelivery(): Promise<boolean>
  planOneReaction(): Promise<string | null>
  inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'>
  publishOneChannelResult(): Promise<'completed' | 'idle'>
}

/**
 * 装配就是**把 worker 交进来**这一件事——一个必填的构造参数，没有第二步。
 *
 * RFC-359 W11：此前这里是 `createDevelopmentActivityWorkerBinding()`——先造出一个
 * `operations`、把它交给下游，再由某处补一句 `.bind(worker)`；`operations` 进门先
 * `if (worker === null) throw new Error('development-activity-worker-not-bound')`。
 * 那个「先留空、以后再补」的窗口在两个组合根上都是**多余的**：PG 根紧接着下一行就 bind，
 * SQLite 根在同一个函数里 bind 完立刻取 `operations` 用。两处都不存在「运行时才知道 worker
 * 是谁」这回事，可空槽兜的是一个不可能发生的状态，代价却是「哪天真忘了 bind」照样编译通过
 * ——正是 RFC-359 W1-T1 修掉的那类缺陷（PG daemon 每 tick 抛 `*-not-bound`，SQLite 一切正常）。
 *
 * 现在 worker 是必填实参：忘了交在类型层不可表达（实测：删掉调用点那个实参 ⇒ TS2554
 * 「Expected 1 arguments, but got 0」），也没有第二次 bind 可以静默覆盖第一次
 * （RFC-317 T54 的 once 守卫防的那个事故，在没有 bind 的形状里根本无从发生）。
 */
export function composeDevelopmentActivityOperations(
  worker: DevelopmentActivityWorker,
): DevelopmentActivityOperations {
  return Object.freeze({
    async runOneWorkerCycle(): Promise<DevelopmentActivityResult> {
      const channel = await worker.publishOneChannelResult()
      if (channel !== 'idle') return { activity: 'channel', state: channel }
      const outbox = await worker.runOneOutbox()
      if (outbox !== 'idle') return { activity: 'outbox', state: outbox }
      if (await worker.pumpOneDelivery()) return { activity: 'delivery', state: 'completed' }
      const roundId = await worker.planOneReaction()
      if (roundId !== null) return { activity: 'reaction', state: roundId }
      return { activity: 'execution', state: await worker.inspectOneExecution() }
    },
  })
}
