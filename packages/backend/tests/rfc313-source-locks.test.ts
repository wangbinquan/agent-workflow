// RFC-313 T10 — 源码层兜底锁。
//
// 为什么这条测试存在：本 RFC 引入的是**预算**类逻辑，而预算最容易在后续 RFC 里被
// 「顺手多给一次」——改动看起来无害、跑起来也全绿（多试一次通常只是更慢），但它悄悄
// 抬高了每个节点的最坏成本上限，而那正是用户逐项确认过的东西（最坏 attempt 4→8）。
// 单测覆盖不到「有人在别处又加了一次预算」，只有源码层断言能拦住。
//
// 锁三件事：
//   ① 形状判定只有一个定义点（decideRetryShape 在 shared，backend 只调用不重实现）；
//   ② scheduler.ts 里 restartsUsed 只被纯函数的返回值推进，没有第二处自增；
//   ③ 告知段只有 renderSessionRestartNotice 一个出口（不许有人再拼一份文案）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_SRC = resolve(import.meta.dir, '..', '..', 'shared', 'src')
const read = (...seg: string[]): string => readFileSync(resolve(...seg), 'utf8')
const occurrences = (src: string, needle: string): number => src.split(needle).length - 1

describe('RFC-313 源码层锁', () => {
  test('decideRetryShape 只在 shared 定义一次，backend 只调用', () => {
    const shared = read(SHARED_SRC, 'prompt.ts')
    expect(occurrences(shared, 'export function decideRetryShape')).toBe(1)

    const scheduler = read(BACKEND_SRC, 'services', 'scheduler.ts')
    expect(scheduler).not.toContain('function decideRetryShape')
    expect(occurrences(scheduler, 'decideRetryShape({')).toBe(1)
  })

  test('scheduler.ts 里没有第二处推进升级预算的地方', () => {
    const scheduler = read(BACKEND_SRC, 'services', 'scheduler.ts')
    // 唯一的推进方式是把纯函数返回的 next 整体赋回去。任何 `restartsUsed +=` /
    // `restartsUsed++` 都意味着有人绕过了判定单源。
    expect(scheduler).not.toContain('restartsUsed +=')
    expect(scheduler).not.toContain('restartsUsed++')
    expect(occurrences(scheduler, 'retryShapeState = next')).toBe(1)
  })

  test('attempt 上限只由 retryAttemptCap 导出，agent 线不再自己拼预算', () => {
    const scheduler = read(BACKEND_SRC, 'services', 'scheduler.ts')
    expect(occurrences(scheduler, 'retryAttemptCap(followupBudget, restartBudget)')).toBe(1)
    // 公式必须留在 shared —— backend 里再出现一次乘法就是复制了单源。
    expect(scheduler).not.toContain('(1 + followupBudget) * (1 + restartBudget)')
  })

  test('会话升级告知只有一个渲染出口', () => {
    const shared = read(SHARED_SRC, 'prompt.ts')
    expect(occurrences(shared, 'export function renderSessionRestartNotice')).toBe(1)
    const runner = read(BACKEND_SRC, 'services', 'runner.ts')
    // runner 只透传结构化的 reason，不许自己拼文案。
    expect(runner).not.toContain('Note on an earlier attempt')
    expect(occurrences(runner, 'priorSessionAbandoned:')).toBe(1)
  })

  test('升级审计事件的 tag 唯一', () => {
    const scheduler = read(BACKEND_SRC, 'services', 'scheduler.ts')
    expect(occurrences(scheduler, '[rfc313/session-restart]')).toBe(1)
  })
})
