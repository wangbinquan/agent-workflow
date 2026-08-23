// RFC-317 T54（findings TP-04）—— 进程级 work-start 参与者不得被静默重绑。
//
// 为什么这条测试存在：`mountApiRoutes` 每进程被调用**两次**——一次给 REST app
// （`createApp`），一次给 MCP dispatcher 的私有 Hono app（`mcp/dispatch.ts`，在第一次
// MCP 请求时懒建）。它里面那句 `deps.digitalEmployeeWorkStart.bind(...)` 绑的是进程级的
// deferred participant，而 `cli/start.ts` 把这个 participant 交给了 webhook dispatcher。
//
// 改造前 `bind` 是一句裸赋值，没有 once 守卫：**一旦有人发过一次 MCP 请求**，此后所有
// webhook / 事件驱动的工作启动都改道到 MCP 那套私有 runtime 上，无日志、无报错、
// 无任何测试会红。这条测试锁住两件事：二次绑定必须炸，未绑定时调用必须炸。

import { describe, expect, test } from 'bun:test'
import { createDeferredDigitalEmployeeWorkStart } from '@/modules/integration/composition'

const participantOf = (tag: string) => ({
  launch: () => ({ caseId: `case-${tag}` }),
})

describe('RFC-317 T54 —— work-start participant 的绑定是一次性的', () => {
  test('未绑定就调用 ⇒ 抛（而不是静默返回什么都不做）', () => {
    const deferred = createDeferredDigitalEmployeeWorkStart()
    expect(() =>
      deferred.participant.launch({
        employeeId: 'e1',
        intake: {} as never,
        actorUserId: null,
        origin: 'api',
      } as never),
    ).toThrow('is not bound')
  })

  test('绑一次可用', () => {
    const deferred = createDeferredDigitalEmployeeWorkStart()
    deferred.bind(participantOf('rest') as never)
    expect(
      deferred.participant.launch({
        employeeId: 'e1',
        intake: {} as never,
        actorUserId: null,
        origin: 'api',
      } as never),
    ).toEqual({ caseId: 'case-rest' })
  })

  test('**绑第二次直接抛**——改造前它会静默覆盖，把 webhook 改道到另一套 runtime', () => {
    const deferred = createDeferredDigitalEmployeeWorkStart()
    deferred.bind(participantOf('rest') as never)
    expect(() => deferred.bind(participantOf('mcp') as never)).toThrow('already bound')
    // 且第一次那份仍然有效——抛出之后不能留下半绑定的状态。
    expect(
      deferred.participant.launch({
        employeeId: 'e1',
        intake: {} as never,
        actorUserId: null,
        origin: 'api',
      } as never),
    ).toEqual({ caseId: 'case-rest' })
  })
})

describe('RFC-317 T54 —— MCP dispatcher 不参与进程级绑定', () => {
  test('dispatch.ts 显式把 digitalEmployeeWorkStart 置空后再挂路由', async () => {
    // 源码层断言：dispatcher 是第二个路由面，不该抢进程级参与者。
    // 行为层的证据是上面那条「绑第二次直接抛」——如果 dispatcher 还在绑，
    // 任何一次建 dispatcher 的测试都会炸。
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'mcp', 'dispatch.ts'), 'utf8')
    expect(src).toContain('digitalEmployeeWorkStart: undefined')
  })
})
