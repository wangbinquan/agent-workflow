// RFC-297 T6 —— 运行时事件管道。
//
// 背景：runner 的 stdout pump 长期是一条**手写且散开**的管道——同一行先被
// `parseUnusableMcpServers` 解析一次、再被 `parseStartupInventory` 解析一次、
// 再被 `parseTerminalResultError` 看一次，最后才轮到 `parseEvent`，而
// `parseEvent` 的产物又在同一个 if 块里顺次驱动 session 认领 / token 统计 /
// 文本累积 / 事件落库 / WS 广播五件事。新增一个关注点就得再往这坨里塞一段。
//
// 本模块把它显式化：**一行只解析一次，结果分发给一组 stage**。每个 stage 只
// 声明自己关心什么，pipeline 负责顺序与错误策略。RFC-297 的清单组装（T10）
// 因此是「加一个 stage」，而不是「再往 pump 里塞一段 if」。
//
// 两条不可动摇的既有语义（改动它们等于静默改变生产行为）：
//
//  1. **串行**。stage 依次 `await`，顺序即数组顺序。现状就是串行的——session
//     认领要 await 租约 claim、落库要 await insert——并发化会让「先认领会话再
//     写事件」这个顺序失效。
//  2. **错误策略分流**（design §7.1）。搬迁过来的既有 stage 一律 `propagate`：
//     其中 session 认领在「一次 run 中途原生会话 id 变了」时**刻意抛错**把节点
//     判失败（RFC-027/276 的会话身份契约），若 pipeline 一律吞异常，这条只在
//     异常运行时触发的保护会静默消失且不会有任何测试变红。新增的 stage 一律
//     `isolate`：清单是呈现面，它挂掉不该弄坏一次本来成功的 run。
//
// pump 本身在任何情况下都不得中断——中断会让子进程卡在管道上（RFC-284 T14 的
// drain 教训）。`propagate` 指的是错误沿**现有**路径抛给 runAgentProcess 的
// 调用方，与今天逐字一致。

import type { NormalizedEvent } from '@/services/runtime/types'
import type { Logger } from '@/util/log'

export type StageErrorPolicy =
  /** 抛错沿现有路径冒泡（既有 stage 一律用它，保持字节等价）。 */
  | 'propagate'
  /** 抛错就地吞掉 + 每 stage 一次 warn，后续行与其余 stage 不受影响。 */
  | 'isolate'

export interface EventStage {
  /** 诊断用的稳定标识，同时用作「同一 stage 只 warn 一次」的去重键。 */
  readonly name: string
  readonly errorPolicy: StageErrorPolicy
  /**
   * 原始行钩子，在 `parseEvent` **之前**执行。
   *
   * 过渡期专用：留给那些今天还在自己解析原始行的既有关注点（terminal result
   * 的 `is_error` 判定）。RFC-297 的清单面在 T9 之后不再需要它——载荷由
   * `parseEvent` 一次解析出来挂在事件上。新 stage 不要用这个钩子。
   */
  observeLine?(line: string): void | Promise<void>
  /** 结构化事件（`parseEvent` 产出，或 `drainFinalEvents` 补发）。 */
  onEvent?(event: NormalizedEvent): void | Promise<void>
  /** `parseEvent` 返回 null 的非结构化行。 */
  onRawLine?(line: string): void | Promise<void>
}

export interface EventPipeline {
  /** 处理一行 stdout：解析一次，分发给所有 stage。 */
  consumeLine(line: string): Promise<void>
  /**
   * 处理一个已经规范化好的事件——供子进程退出后 `drainFinalEvents()` 补发的
   * 合成事件走**同一条**分发路径（这正是「event 来源统一」的落点：下游 stage
   * 无从分辨这个观测是来自流内一行还是退出后的一个文件）。
   */
  consumeEvent(event: NormalizedEvent): Promise<void>
}

export interface EventPipelineOptions {
  /** 冻结运行时的行解析器（`driver.parseEvent`）。 */
  parseEvent(line: string): NormalizedEvent | null
  /** 按执行顺序排列；顺序是契约的一部分，见文件头。 */
  stages: readonly EventStage[]
  log: Logger
}

export function createEventPipeline(opts: EventPipelineOptions): EventPipeline {
  const { parseEvent, stages, log } = opts
  // 每个 isolate stage 只报一次——一行坏则往往行行坏，逐行 warn 会把日志淹掉。
  const warned = new Set<string>()

  const runStage = async (
    stage: EventStage,
    hook: ((...args: never[]) => void | Promise<void>) | undefined,
    invoke: () => void | Promise<void>,
  ): Promise<void> => {
    if (hook === undefined) return
    if (stage.errorPolicy === 'propagate') {
      await invoke()
      return
    }
    try {
      await invoke()
    } catch (err) {
      if (!warned.has(stage.name)) {
        warned.add(stage.name)
        log.warn('event-stage-failed', {
          stage: stage.name,
          err: err instanceof Error ? err.message : String(err),
          detail: 'isolated stage threw; the run continues without its contribution',
        })
      }
    }
  }

  const consumeEvent = async (event: NormalizedEvent): Promise<void> => {
    for (const stage of stages) {
      await runStage(stage, stage.onEvent, () => stage.onEvent?.(event))
    }
  }

  const consumeLine = async (line: string): Promise<void> => {
    for (const stage of stages) {
      await runStage(stage, stage.observeLine, () => stage.observeLine?.(line))
    }
    const event = parseEvent(line)
    if (event === null) {
      for (const stage of stages) {
        await runStage(stage, stage.onRawLine, () => stage.onRawLine?.(line))
      }
      return
    }
    await consumeEvent(event)
  }

  return { consumeLine, consumeEvent }
}
