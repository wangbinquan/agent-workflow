// RFC-317 T54（findings TP-04）—— 进程级 work-start 参与者不得被静默重绑。
//
// 为什么这条测试存在：RFC-344 前 `mountApiRoutes` 每进程被调用两次，第二套 MCP Hono
// 会重绑进程级 participant。RFC-344 已删除那套 route root；once guard 仍保留，防止未来
// 任何新入口重复绑定 `cli/start.ts` 交给 webhook dispatcher 的 participant。
//
// 改造前 `bind` 是一句裸赋值，没有 once 守卫：**一旦有人发过一次 MCP 请求**，此后所有
// webhook / 事件驱动的工作启动都改道到 MCP 那套私有 runtime 上，无日志、无报错、
// 无任何测试会红。这条测试锁住两件事：二次绑定必须炸，未绑定时调用必须炸。

import { describe, expect, test } from 'bun:test'
import { createDeferredDigitalEmployeeWorkStart } from '@/modules/integration/composition'

const participantOf = (tag: string) => ({
  launch: async () => ({ caseId: `case-${tag}` }),
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

  test('绑一次可用', async () => {
    const deferred = createDeferredDigitalEmployeeWorkStart()
    deferred.bind(participantOf('rest') as never)
    await expect(
      deferred.participant.launch({
        employeeId: 'e1',
        intake: {} as never,
        actorUserId: null,
        origin: 'api',
      } as never),
    ).resolves.toEqual({ caseId: 'case-rest' })
  })

  test('**绑第二次直接抛**——改造前它会静默覆盖，把 webhook 改道到另一套 runtime', async () => {
    const deferred = createDeferredDigitalEmployeeWorkStart()
    deferred.bind(participantOf('rest') as never)
    expect(() => deferred.bind(participantOf('mcp') as never)).toThrow('already bound')
    // 且第一次那份仍然有效——抛出之后不能留下半绑定的状态。
    await expect(
      deferred.participant.launch({
        employeeId: 'e1',
        intake: {} as never,
        actorUserId: null,
        origin: 'api',
      } as never),
    ).resolves.toEqual({ caseId: 'case-rest' })
  })
})

describe('RFC-344 —— MCP 不再拥有第二个进程级绑定入口', () => {
  test('旧 dispatch root 消失，server 只创建 direct bound operation invoker', async () => {
    const { existsSync, readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    expect(existsSync(resolve(import.meta.dir, '..', 'src', 'mcp', 'dispatch.ts'))).toBe(false)
    const server = readFileSync(resolve(import.meta.dir, '..', 'src', 'server.ts'), 'utf8')
    expect(server).toContain('directMcpOperationAuthority(identityAccess.directAuthority, actor)')
    expect(server).not.toContain('app.request(')
  })
})
