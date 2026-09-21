// RFC-366 —— 「一次 agent 运行结束了」的对外通知口。
//
// task-execution 自己拥有这个端口，只发出一个**中性事实**；谁关心、拿它做什么，
// 由 bootstrap 装配决定（今天唯一的消费者是 memory 的蒸馏入队）。这样执行引擎不
// 需要知道 memory 模块存在，也不必 import 它的任何东西——跨 context 只交换
// provider 中性的端口，是 RFC-294 对这类耦合的要求。
//
// **终态过滤在调用方（引擎）做，不在这里**：哪些 node_run 状态算「一次跑完的
// 执行」是执行语义，属于 task-execution；把它漏给下游意味着每个消费者都要重新
// 判一遍，而它们判错了也不会红。

import type { NodeRunStatus } from '@agent-workflow/shared'

export interface AgentRunSettledEvent {
  readonly taskId: string
  /** 结算的那一行 node_run（重试 / loop 每轮 / fanout 每分片各是一行）。 */
  readonly nodeRunId: string
  /** 工作流定义里的节点 id——下游据此解析该节点冻结的 agent id。 */
  readonly nodeId: string
  /** 已过滤过的终态：目前只会是 'done' | 'failed'。 */
  readonly status: NodeRunStatus
}

export interface AgentRunSettledObserver {
  onAgentRunSettled(event: AgentRunSettledEvent): Promise<void>
}

/**
 * RFC-366：未装配时的 no-op。引擎侧是 best-effort 通知（D13），缺了观察者既不该
 * 报错也不该改变执行路径——测试与旧装配路径因此零改动。
 */
export const NOOP_AGENT_RUN_SETTLED_OBSERVER: AgentRunSettledObserver = Object.freeze({
  async onAgentRunSettled() {
    /* no observer composed */
  },
})
