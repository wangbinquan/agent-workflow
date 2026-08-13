// RFC-297 T7 —— 事件管道骨架的行为锁。
//
// 这条管道取代了 runner stdout pump 里手写散开的一坨 if。它的两条语义如果被
// 后来的重构悄悄改掉，生产行为会跟着变而测试不一定红，故在此逐条钉死：
//
//  · **串行 + 顺序即数组顺序**：现状 session 认领要 await 租约 claim、落库要
//    await insert，二者顺序不可交换；并发化或乱序会让「先认领会话再写事件」
//    失效。
//  · **错误策略分流**（design §7.1）：`propagate` 让抛错沿现有路径冒泡——其中
//    session 认领在「一次 run 中途原生会话 id 变了」时刻意抛错把节点判失败
//    （RFC-027/276 会话身份契约）。若管道一律吞异常，这条只在异常运行时触发的
//    保护会静默消失且没有任何既有测试会变红。`isolate` 才是新 stage 的默认，
//    清单挂了不该弄坏一次本来成功的 run。

import { describe, expect, test } from 'bun:test'
import { createEventPipeline, type EventStage } from '@/services/execution/eventPipeline'
import type { NormalizedEvent } from '@/services/runtime/types'
import { createLogger } from '@/util/log'

const log = createLogger('rfc297-test')

const event = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  kind: 'text',
  rawLine: '{"type":"assistant"}',
  ...over,
})

/** 只认结构化行的最小解析器：以 `{` 开头即视作事件。 */
const parseEvent = (line: string): NormalizedEvent | null =>
  line.startsWith('{') ? event({ rawLine: line }) : null

describe('分发顺序', () => {
  test('stage 按数组顺序串行执行，前一个 await 完才轮到下一个', async () => {
    const order: string[] = []
    const slow: EventStage = {
      name: 'slow',
      errorPolicy: 'propagate',
      async onEvent() {
        await new Promise((r) => setTimeout(r, 10))
        order.push('slow')
      },
    }
    const fast: EventStage = {
      name: 'fast',
      errorPolicy: 'propagate',
      onEvent() {
        order.push('fast')
      },
    }
    const pipeline = createEventPipeline({ parseEvent, stages: [slow, fast], log })
    await pipeline.consumeLine('{"a":1}')
    expect(order).toEqual(['slow', 'fast'])
  })

  test('observeLine 全部先于 parseEvent 与 onEvent', async () => {
    const order: string[] = []
    const stage: EventStage = {
      name: 's',
      errorPolicy: 'propagate',
      observeLine: () => void order.push('observe'),
      onEvent: () => void order.push('event'),
    }
    const pipeline = createEventPipeline({
      parseEvent: (line) => {
        order.push('parse')
        return parseEvent(line)
      },
      stages: [stage],
      log,
    })
    await pipeline.consumeLine('{"a":1}')
    expect(order).toEqual(['observe', 'parse', 'event'])
  })

  test('一行只解析一次，结果分发给全部 stage（AC-10 的骨架侧保证）', async () => {
    let parses = 0
    const seen: NormalizedEvent[] = []
    const mk = (name: string): EventStage => ({
      name,
      errorPolicy: 'propagate',
      onEvent: (ev) => void seen.push(ev),
    })
    const pipeline = createEventPipeline({
      parseEvent: (line) => {
        parses += 1
        return parseEvent(line)
      },
      stages: [mk('a'), mk('b'), mk('c')],
      log,
    })
    await pipeline.consumeLine('{"a":1}')
    expect(parses).toBe(1)
    expect(seen).toHaveLength(3)
    // 三个 stage 拿到的是同一个对象，不是各自解析出来的副本。
    expect(seen[0]).toBe(seen[1]!)
    expect(seen[1]).toBe(seen[2]!)
  })

  test('非结构化行走 onRawLine，且不触发 onEvent', async () => {
    const hits: string[] = []
    const stage: EventStage = {
      name: 's',
      errorPolicy: 'propagate',
      onEvent: () => void hits.push('event'),
      onRawLine: (line) => void hits.push(`raw:${line}`),
    }
    const pipeline = createEventPipeline({ parseEvent, stages: [stage], log })
    await pipeline.consumeLine('plain text')
    expect(hits).toEqual(['raw:plain text'])
  })
})

describe('错误策略', () => {
  test('propagate：抛错冒泡给调用方（session 身份错乱必须能判失败）', async () => {
    const boom: EventStage = {
      name: 'session-lease',
      errorPolicy: 'propagate',
      onEvent() {
        throw new Error('runtime changed native session id during one run')
      },
    }
    const pipeline = createEventPipeline({ parseEvent, stages: [boom], log })
    await expect(pipeline.consumeLine('{"a":1}')).rejects.toThrow(
      'runtime changed native session id',
    )
  })

  test('propagate 抛错后，后续 stage 不再执行（与今天 if 块内的顺序语义一致）', async () => {
    const after: string[] = []
    const boom: EventStage = {
      name: 'boom',
      errorPolicy: 'propagate',
      onEvent() {
        throw new Error('x')
      },
    }
    const later: EventStage = {
      name: 'later',
      errorPolicy: 'propagate',
      onEvent: () => void after.push('ran'),
    }
    const pipeline = createEventPipeline({ parseEvent, stages: [boom, later], log })
    await expect(pipeline.consumeLine('{"a":1}')).rejects.toThrow('x')
    expect(after).toEqual([])
  })

  test('isolate：抛错就地吞掉，其余 stage 与后续行照常', async () => {
    const persisted: string[] = []
    const flaky: EventStage = {
      name: 'inventory',
      errorPolicy: 'isolate',
      onEvent() {
        throw new Error('inventory assembly blew up')
      },
    }
    const persist: EventStage = {
      name: 'persist-events',
      errorPolicy: 'propagate',
      onEvent: (ev) => void persisted.push(ev.rawLine),
    }
    const pipeline = createEventPipeline({ parseEvent, stages: [flaky, persist], log })
    await pipeline.consumeLine('{"n":1}')
    await pipeline.consumeLine('{"n":2}')
    expect(persisted).toEqual(['{"n":1}', '{"n":2}'])
  })

  test('isolate 的 rejected promise 同样被吞（异步 stage 不能漏网）', async () => {
    const stage: EventStage = {
      name: 'async-isolate',
      errorPolicy: 'isolate',
      onEvent: () => Promise.reject(new Error('async boom')),
    }
    const pipeline = createEventPipeline({ parseEvent, stages: [stage], log })
    await pipeline.consumeLine('{"a":1}')
  })
})

describe('补发事件与流内事件走同一条路', () => {
  test('consumeEvent 分发给与 consumeLine 相同的 stage 链', async () => {
    const seen: string[] = []
    const stage: EventStage = {
      name: 's',
      errorPolicy: 'propagate',
      onEvent: (ev) => void seen.push(ev.kind),
    }
    const pipeline = createEventPipeline({ parseEvent, stages: [stage], log })
    await pipeline.consumeLine('{"a":1}')
    // 子进程退出后 drainFinalEvents 补发的合成事件——下游无从分辨它来自文件。
    // （PR-2 只立管道；合成事件的专属 kind 与落库过滤在 PR-3 接入 pump 时落地。）
    await pipeline.consumeEvent(event({ kind: 'step_finish', persist: false }))
    expect(seen).toEqual(['text', 'step_finish'])
  })

  test('consumeEvent 不触发 observeLine（它没有原始行）', async () => {
    const hits: string[] = []
    const stage: EventStage = {
      name: 's',
      errorPolicy: 'propagate',
      observeLine: () => void hits.push('observe'),
      onEvent: () => void hits.push('event'),
    }
    const pipeline = createEventPipeline({ parseEvent, stages: [stage], log })
    await pipeline.consumeEvent(event())
    expect(hits).toEqual(['event'])
  })
})

describe('缺省钩子', () => {
  test('未声明的钩子被跳过，不报错', async () => {
    const onlyRaw: EventStage = {
      name: 'raw-only',
      errorPolicy: 'propagate',
      onRawLine: () => {},
    }
    const pipeline = createEventPipeline({ parseEvent, stages: [onlyRaw], log })
    await pipeline.consumeLine('{"a":1}')
    await pipeline.consumeLine('plain')
  })
})
