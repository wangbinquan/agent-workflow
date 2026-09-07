// RFC-359 W11 —— 组合根不再交出「可能没装配」的槽：行为判据。
//
// 为什么这条测试存在
// ------------------
// 两个 daemon 的组合根里曾经有一批同形的占位：一个 `let x: T | null = null`（或
// `{ current: T | null }` 的盒子）先被交给下游，下游照常持有它，装配走完再回填；持有者
// 进门先来一句 `if (x === null) throw new Error('…-not-bound')`。这形状的代价不是难看，
// 而是**「装配漏了一步」编译期完全合法**——回填那一行删掉，tsc 一声不吭，缺陷只在运行期、
// 只在某一条 tick 路径上、而且往往只在一个引擎上暴露（RFC-359 W1-T1 修掉的那批就是：PG
// daemon 每 tick 抛 `*-not-bound`，同一段业务在另一个引擎上一直正常）。
//
// W11 把这批槽换成两种**能在类型层证伪**的形状：
//   1. 环的两端同处一个函数作用域时，把环打在**词法作用域**上——闭包直接引用同作用域后面
//      那个 `const`，只在运行期取值。回填这一步随之消失，"忘了装配" 变成
//      `TS2304 Cannot find name '…'`。
//   2. 依赖本来就是现成的时，把它变成**必填构造参数**。忘了交变成
//      `TS2554 Expected 1 arguments, but got 0`。
//
// 类型层的证据在账本 `tests/architecture/rfc359-w5-t19b-composition-root-complete.test.ts`
// 的销账注释里逐条记着。本文件锁的是账本看不见的那一半——**改完之后行为没变**：活动
// operations 就落在交进来的那台 worker 上，两次装配互不串台，且这个模块不再导出任何
// 「先造空槽、以后再 bind」的仪式。
//
// **组合根整体的求值顺序**（词法环里任何一环排错就是一次 TDZ 命中，整个 app 在装配那一刻
// 就炸）不在本文件里重测：既有的 `tests/rfc349-digital-employee-platform-tools-wiring.test.ts`
// 已经把 HTTP 侧组合根整条装配起来跑，实测能抓到——把代理目录那一环改成装配期就取值，
// 它当场红在 `Cannot access 'agentCatalog' before initialization`。再写一份同形的只会给
// 「测试不得写死引擎」的账本添一笔新债（那条判据没法双引擎跑：另一个引擎的 HTTP 根是
// 另一个装配入口，要一台真库）。
//
// 注：这里刻意不写任何 `sqliteX` / `postgresqlX` 形式的模块名或导出符号；成对适配器的
// 覆盖对等账本按标识符边界数「测试文件提到了谁」，在散文里提一句就会把那份账本顶红。

import { describe, expect, test } from 'bun:test'
import * as activityComposition from '../src/modules/development-automation/composition/activityOperations'
import type { DevelopmentActivityWorker } from '../src/modules/development-automation/composition/activityOperations'

/** 记录调用顺序的假 worker；每个动作都可以被单独调成「有活儿」。 */
function recordingWorker(
  calls: string[],
  overrides: Partial<DevelopmentActivityWorker> = {},
): DevelopmentActivityWorker {
  return {
    publishOneChannelResult: async () => {
      calls.push('channel')
      return 'idle'
    },
    runOneOutbox: async () => {
      calls.push('outbox')
      return 'idle'
    },
    pumpOneDelivery: async () => {
      calls.push('delivery')
      return false
    },
    planOneReaction: async () => {
      calls.push('reaction')
      return null
    },
    inspectOneExecution: async () => {
      calls.push('execution')
      return 'idle'
    },
    ...overrides,
  }
}

describe('RFC-359 W11 —— 活动 operations 的 worker 是构造参数，不是事后回填的槽', () => {
  test('operations 落在交进来的那台 worker 上，并按固定优先级逐个问过去', async () => {
    const calls: string[] = []
    const operations = activityComposition.composeDevelopmentActivityOperations(
      recordingWorker(calls),
    )

    await expect(operations.runOneWorkerCycle()).resolves.toEqual({
      activity: 'execution',
      state: 'idle',
    })
    // 顺序本身是契约：先发布渠道结果，再收发件箱，再泵投递，再规划反应，最后才查执行。
    expect(calls).toEqual(['channel', 'outbox', 'delivery', 'reaction', 'execution'])
  })

  test('前一档有活儿就当场收工，后面的档位一个都不问', async () => {
    const calls: string[] = []
    const operations = activityComposition.composeDevelopmentActivityOperations(
      recordingWorker(calls, {
        runOneOutbox: async () => {
          calls.push('outbox')
          return 'retried'
        },
      }),
    )

    await expect(operations.runOneWorkerCycle()).resolves.toEqual({
      activity: 'outbox',
      state: 'retried',
    })
    expect(calls).toEqual(['channel', 'outbox'])
  })

  test('两次装配互不串台——没有共享的可变槽能把两台 worker 串在一起', async () => {
    const firstCalls: string[] = []
    const secondCalls: string[] = []
    const first = activityComposition.composeDevelopmentActivityOperations(
      recordingWorker(firstCalls),
    )
    const second = activityComposition.composeDevelopmentActivityOperations(
      recordingWorker(secondCalls, {
        publishOneChannelResult: async () => {
          secondCalls.push('channel')
          return 'completed'
        },
      }),
    )

    await expect(second.runOneWorkerCycle()).resolves.toEqual({
      activity: 'channel',
      state: 'completed',
    })
    // 第二次装配没有覆盖第一次：第一台 worker 的行为原样保留。
    await expect(first.runOneWorkerCycle()).resolves.toEqual({
      activity: 'execution',
      state: 'idle',
    })
    expect(firstCalls).toEqual(['channel', 'outbox', 'delivery', 'reaction', 'execution'])
    expect(secondCalls).toEqual(['channel'])
  })

  test('这个模块只导出「一次交齐」的装配函数——延迟绑定的仪式不得回归', () => {
    // 只要有人再造一个 `create…Binding()` / `bind()` 出来，这条就红。
    // 账本按错误码文本数占位，改个错误码就能绕过；导出面数不出花样。
    expect(Object.keys(activityComposition).sort()).toEqual([
      'composeDevelopmentActivityOperations',
    ])
  })
})
