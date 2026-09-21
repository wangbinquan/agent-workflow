// 结构律：**投递名单**必须与**实际创建的消费者定义**逐条对上。
//
// 为什么必须有这条：提交一个 committed event 时，写进事件行的投递名单是
// `<family>DurableConsumers(eventType)`，而那份名单来自 manifest；dispatcher 只按名单
// 投递。RFC-366 给「任务执行结束」加了 `task-terminal-distill-enqueue` 消费者定义，却漏
// 了把它登记进 `TASK_LIFECYCLE_DURABLE_CONSUMER_MANIFEST` —— 事件照常提交、dispatcher
// 照常跑、任务照常 done，队列里就是什么都不多，**而且没有任何一行报错**。
// e2e `rfc366-execution-end-distill` 在 2026-09-21 的 nightly 上抓到了它（在生产里则是
// 一整类「提炼永远不发生、也没人知道」的静默失效）。
//
// 判据是 (id, eventTypes, deliveryClass) 三条：少了任何一条，事件都到不了那个消费者。
// 两侧家族都用同一个判据——「只修一侧，另一侧迟早再来」在本仓是写进复盘的一条教训。
import { describe, expect, test } from 'bun:test'

import { createTaskLifecycleDurableConsumerDefinitions } from '../src/modules/task-execution/application/taskLifecycleConsumers'
import { TASK_LIFECYCLE_DURABLE_CONSUMER_MANIFEST } from '../src/modules/task-execution/domain/taskLifecycleCommittedEvent'
import { createCollaborationDurableConsumerDefinitions } from '../src/modules/collaboration/application/collaborationCommittedEventConsumers'
import { COLLABORATION_DURABLE_CONSUMER_MANIFEST } from '../src/modules/collaboration/domain/collaborationCommittedEvent'

interface ConsumerShape {
  readonly id: string
  readonly eventTypes: readonly string[]
  readonly deliveryClass: string
}

/** 名单与定义之间的差异；空数组 = 每一条都能真的投到。 */
function deliveryParityProblems(
  manifest: readonly ConsumerShape[],
  definitions: readonly ConsumerShape[],
): string[] {
  const problems: string[] = []
  const listed = new Map(manifest.map((entry) => [entry.id, entry]))
  for (const definition of definitions) {
    const entry = listed.get(definition.id)
    if (entry === undefined) {
      problems.push(`${definition.id}: 建了消费者却没登记进投递名单 ⇒ 这个事件永远投不到它`)
      continue
    }
    if (entry.deliveryClass !== definition.deliveryClass) {
      problems.push(
        `${definition.id}: 名单记的 deliveryClass=${entry.deliveryClass}，定义是 ${definition.deliveryClass}`,
      )
    }
    for (const eventType of definition.eventTypes) {
      if (!entry.eventTypes.includes(eventType)) {
        problems.push(`${definition.id}: 名单没有为 '${eventType}' 投递它`)
      }
    }
  }
  const defined = new Set(definitions.map((definition) => definition.id))
  for (const entry of manifest) {
    if (!defined.has(entry.id)) {
      problems.push(`${entry.id}: 名单点名了一个并不存在的消费者（它永远等不到事件）`)
    }
  }
  return problems
}

describe('committed event 投递名单 ↔ 消费者定义 两向对账', () => {
  test('自证：漏登记 / 少 eventType / deliveryClass 不符 / 幽灵条目，四种都被报出来', () => {
    const manifest: ConsumerShape[] = [{ id: 'ok', eventTypes: ['e.1'], deliveryClass: 'critical' }]
    // 健康侧闭嘴。
    expect(
      deliveryParityProblems(manifest, [
        { id: 'ok', eventTypes: ['e.1'], deliveryClass: 'critical' },
      ]),
    ).toEqual([])
    // 漏登记（同一份反向名单此时也没有定义，两条一起报）。
    expect(
      deliveryParityProblems(manifest, [
        { id: 'ghost', eventTypes: ['e.1'], deliveryClass: 'rebuildable' },
      ]),
    ).toEqual([
      'ghost: 建了消费者却没登记进投递名单 ⇒ 这个事件永远投不到它',
      'ok: 名单点名了一个并不存在的消费者（它永远等不到事件）',
    ])
    // 清单里有、定义里没有。
    expect(deliveryParityProblems(manifest, [])).toEqual([
      'ok: 名单点名了一个并不存在的消费者（它永远等不到事件）',
    ])
    // eventType 少一条。
    expect(
      deliveryParityProblems(manifest, [
        { id: 'ok', eventTypes: ['e.2'], deliveryClass: 'critical' },
      ]),
    ).toEqual(["ok: 名单没有为 'e.2' 投递它"])
    // deliveryClass 不符。
    expect(
      deliveryParityProblems(manifest, [
        { id: 'ok', eventTypes: ['e.1'], deliveryClass: 'rebuildable' },
      ]),
    ).toEqual(['ok: 名单记的 deliveryClass=critical，定义是 rebuildable'])
  })

  test('task 家族：每一个建出来的消费者都在投递名单上，且三条判据逐条相等', () => {
    const definitions = createTaskLifecycleDurableConsumerDefinitions({
      events: { observe: async () => ({}) as never },
      closeTerminalGates: async () => {},
      notifyChildBudget: async () => {},
      notifyExecutionWatch: async () => {},
      nudgeWorkspacePrune: async () => {},
      enqueueTaskRunDistill: async () => {},
    })
    expect(
      deliveryParityProblems(TASK_LIFECYCLE_DURABLE_CONSUMER_MANIFEST, definitions),
      'task 家族的投递名单与消费者定义对不上 ⇒ 有事件会静默投不到',
    ).toEqual([])
    // 语料非空：工厂坏了（返回空数组）时这条判据本身也会变成恒真。
    expect(definitions.length).toBeGreaterThanOrEqual(6)
  })

  test('collaboration 家族：同一个判据也跑一遍', () => {
    const definitions = createCollaborationDurableConsumerDefinitions({
      events: { observe: () => undefined },
      nudgeContinuation: () => {},
      enqueueReviewDistill: async () => {},
    })
    expect(
      deliveryParityProblems(COLLABORATION_DURABLE_CONSUMER_MANIFEST, definitions),
      'collaboration 家族的投递名单与消费者定义对不上 ⇒ 有事件会静默投不到',
    ).toEqual([])
    expect(definitions.length).toBeGreaterThanOrEqual(2)
  })
})
