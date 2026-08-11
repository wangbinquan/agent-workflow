// RFC-103 T3 (调研报告 06-OCI-06) — opencode token 计量回归锁。
//
// 为什么这条测试存在：真实 opencode（1.15.5+）把 cache 计数嵌套在
// `tokens.cache = { read, write }`，而 accumulateTokens 原本只读扁平
// `cache_read / cache_creation`，导致 cache token 恒计 0（录制 fixture
// 1.15.5-with-envelope.ndjson 上 ~15× 漏计：framework total 483 vs 真实
// 7523），max_total_tokens 限额据此判断 → 形同虚设。本测试用 fixture 的真实
// token 形状作预言，并保留旧扁平/camelCase 兼容用例。链接 RFC-103 design §T3。
import { describe, expect, test } from 'bun:test'
import { accumulateTokens } from '../src/services/runtime/opencode/events'

type Acc = Parameters<typeof accumulateTokens>[1]
function freshAcc(): Acc {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }
}

describe('RFC-103 T3 accumulateTokens — 嵌套 cache 形状', () => {
  test('真实 opencode 1.15.5 嵌套 cache:{read,write} 被正确计入', () => {
    // 与 packages/backend/tests/fixtures/opencode-recordings/
    // 1.15.5-with-envelope.ndjson 的 step_finish token 形状一致。
    const acc = freshAcc()
    accumulateTokens(
      {
        tokens: {
          total: 7523,
          input: 465,
          output: 18,
          reasoning: 0,
          cache: { write: 0, read: 7040 },
        },
      },
      acc,
    )
    expect(acc.cacheRead).toBe(7040)
    expect(acc.cacheCreate).toBe(0)
    expect(acc.input).toBe(465)
    expect(acc.output).toBe(18)
    // framework 自算 total 必须等于 fixture 自报 total（修复前是 483）。
    expect(acc.total).toBe(7523)
    expect(acc.total).toBe(acc.input + acc.output + acc.cacheCreate + acc.cacheRead)
  })

  test('嵌套 cache.write 计入 cacheCreate', () => {
    const acc = freshAcc()
    accumulateTokens({ tokens: { input: 10, output: 4, cache: { write: 30, read: 6 } } }, acc)
    expect(acc.cacheCreate).toBe(30)
    expect(acc.cacheRead).toBe(6)
    expect(acc.total).toBe(50)
  })

  test('向后兼容：旧扁平 cache_read / cache_creation 仍生效', () => {
    const acc = freshAcc()
    accumulateTokens({ tokens: { input: 10, output: 5, cache_read: 100, cache_creation: 20 } }, acc)
    expect(acc.cacheRead).toBe(100)
    expect(acc.cacheCreate).toBe(20)
    expect(acc.total).toBe(135)
  })

  test('向后兼容：camelCase cacheRead / cacheCreation 仍生效', () => {
    const acc = freshAcc()
    accumulateTokens({ tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } }, acc)
    expect(acc.cacheRead).toBe(3)
    expect(acc.cacheCreate).toBe(4)
    expect(acc.total).toBe(10)
  })

  test('扁平键优先于嵌套（同时存在时不双计）', () => {
    const acc = freshAcc()
    accumulateTokens(
      { tokens: { input: 0, output: 0, cache_read: 5, cache: { read: 999, write: 0 } } },
      acc,
    )
    expect(acc.cacheRead).toBe(5)
  })
})
