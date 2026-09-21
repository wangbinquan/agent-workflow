// RFC-366 —— agent 运行结束这条通知的接线。
//
// 引擎侧的挂点（`nodeMechanics.ts` 的每次 attempt 结算）在单测里没法整段跑起来，
// 所以这里按 CLAUDE.md §Test-with-every-change「运行时巨型组件难直接覆盖时，
// 最低限度保留一条源代码层文本断言」的口径分两层锁：
//
//   ① 适配器（composeAgentRunDistillObserver）与选项漏斗（runtimeConfigOpts）
//      的行为断言——这两处才是「通知有没有变成入队」的实际逻辑；
//   ② 挂点本身的源码文本断言——终态过滤必须留在引擎侧、异常必须被 swallow。
//      这两条一旦被后来的重构挪走或改写，功能面不会红（通知只是少发/多发），
//      但产品行为会悄悄变：多发 = canceled 的运行也烧蒸馏，不 swallow = 一次
//      入队失败把已经成功的 agent 运行改判成失败。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { EnqueueMemoryDistillJobInput } from '../src/modules/memory/public/commands'
import type { MemoryDistillEnqueuer } from '../src/modules/memory/public/participants'
import { composeAgentRunDistillObserver } from '../src/modules/task-execution/composition/agentRunDistillObserver'
import { NOOP_AGENT_RUN_SETTLED_OBSERVER } from '../src/modules/task-execution/application/ports/agentRunSettledObserver'
import { runtimeConfigOpts } from '../src/services/task'

const NODE_MECHANICS = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'task-execution',
  'composition',
  'nodeMechanics.ts',
)

function recordingEnqueuer(): {
  calls: EnqueueMemoryDistillJobInput[]
  enqueuer: MemoryDistillEnqueuer
} {
  const calls: EnqueueMemoryDistillJobInput[] = []
  return {
    calls,
    enqueuer: Object.freeze({
      async enqueue(input) {
        calls.push(input)
        return { jobId: 'job-1', debounceKey: 'k', nextRunAt: 0 }
      },
    }),
  }
}

describe('RFC-366 agent-run observer — 适配器', () => {
  test('把结算事实原样转成一次 agent-run 入队（nodeId 一并带上）', async () => {
    const { calls, enqueuer } = recordingEnqueuer()
    await composeAgentRunDistillObserver(enqueuer).onAgentRunSettled({
      taskId: 't-1',
      nodeRunId: 'nr-1',
      nodeId: 'agent-a',
      status: 'done',
    })
    expect(calls).toEqual([
      { sourceKind: 'agent-run', sourceEventId: 'nr-1', taskId: 't-1', nodeId: 'agent-a' },
    ])
  })

  test('入队被准入门拒绝（返回 null）不抛——「没产生 job」是正常结局', async () => {
    const observer = composeAgentRunDistillObserver(
      Object.freeze({
        async enqueue() {
          return null
        },
      }),
    )
    await expect(
      observer.onAgentRunSettled({
        taskId: 't-1',
        nodeRunId: 'nr-1',
        nodeId: 'agent-a',
        status: 'failed',
      }),
    ).resolves.toBeUndefined()
  })

  test('未装配时的 no-op 不抛（旧装配路径与测试夹具零改动）', async () => {
    await expect(
      NOOP_AGENT_RUN_SETTLED_OBSERVER.onAgentRunSettled({
        taskId: 't',
        nodeRunId: 'nr',
        nodeId: 'n',
        status: 'done',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('RFC-366 agent-run observer — 选项漏斗', () => {
  test('deps 带 enqueuer 时组出观察者（start / resume / retry 共用这一个漏斗）', () => {
    const { enqueuer } = recordingEnqueuer()
    const opts = runtimeConfigOpts({ memoryDistillEnqueuer: enqueuer })
    expect(opts.agentRunSettled).toBeDefined()
  })

  test('deps 不带 enqueuer 时不放这一项（由引擎回落 no-op）', () => {
    expect(runtimeConfigOpts({}).agentRunSettled).toBeUndefined()
  })
})

describe('RFC-366 agent-run 挂点 — 源码层守卫', () => {
  test('终态过滤留在引擎侧：只有 done / failed 通知下游', async () => {
    const src = await Bun.file(NODE_MECHANICS).text()
    expect(src).toContain("if (lastResult.status === 'done' || lastResult.status === 'failed') {")
    expect(src).toContain('.onAgentRunSettled({')
  })

  test('best-effort：通知挂了不能改变节点结算结果', async () => {
    const src = await Bun.file(NODE_MECHANICS).text()
    const at = src.indexOf('.onAgentRunSettled({')
    expect(at).toBeGreaterThan(0)
    // 调用之后必须紧跟 .catch —— 没有它，一次蒸馏入队错误就会把一次成功的 agent
    // 运行变成 throw，被上层当成节点失败。
    expect(src.slice(at, at + 600)).toContain('.catch(')
  })

  test('挂点在重试循环体内：每次 attempt 各通知一次（D1）', async () => {
    const src = await Bun.file(NODE_MECHANICS).text()
    const broadcastAt = src.indexOf(
      'broadcastNodeStatus(taskId, nodeRunId, node.id, lastResult.status)',
    )
    const notifyAt = src.indexOf('.onAgentRunSettled({')
    expect(broadcastAt).toBeGreaterThan(0)
    expect(notifyAt).toBeGreaterThan(broadcastAt)
    // 两者之间不得插入 `return`：那会让失败路径直接退出、永远不通知。
    expect(src.slice(broadcastAt, notifyAt)).not.toContain('return ')
  })
})
