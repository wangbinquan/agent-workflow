// RFC-208 PR-4 —— 写入结果分类必须按「幂等性」切分，而不是按 HTTP 状态。
//
// 这条测试存在的首要目的是**防止一个已经被否掉的修法被重新提出来**。
//
// 本 RFC 初稿曾主张：把整个 `status === 0`（传输失败）判为「请求未被服务端接受、
// 可安全重试」，理由是「连接失败说明请求没落地」。Codex 设计门指出这是错的：
// 超时与 abort 完全可能发生在服务端**已经收到并提交之后**（响应在回程丢失、
// 或用户在提交后取消），浏览器无法可靠区分「连接从未建立」和「已发出但响应丢失」。
// 按初稿实现会跳过对账、放掉导航令牌，可能导致重复启动任务或状态分叉。
//
// 因此正确的切法是按该调用**是否幂等**：
//   · 4xx                      → definitive（服务端明确拒绝，客户端状态可信）
//   · 传输失败 + 幂等调用      → retriable（重放无副作用）
//   · 5xx，或非幂等写遇传输失败 → unknown（服务端可能已提交）
//
// 用户报的那条「保存技能时 daemon 重启 → 永久锁死导航」不是靠把它重分类为
// 「安全」来解决的，而是靠**让 unknown 不再等于永久**（有界等待 + 逃生口 +
// 既有的「重新检查」）。这条区别是本 RFC 的核心，不能被后来的重构抹掉。

import { describe, expect, test } from 'vitest'
import { ApiError } from '../src/api/client'
import { classifyWriteOutcome } from '../src/lib/write-outcome'

const transportFailure = new ApiError(0, 'network-unreachable', 'Failed to fetch')
const timeout = new ApiError(0, 'request-timeout', 'request timed out')
const serverError = new ApiError(500, 'boom', 'internal error')
const rejected = new ApiError(422, 'skill-invalid', 'bad payload')
const conflict = new ApiError(409, 'stale', 'revision moved')

describe('RFC-208 · write outcome classification', () => {
  test('4xx is definitive regardless of idempotency', () => {
    expect(classifyWriteOutcome(rejected, { idempotent: false })).toBe('definitive')
    expect(classifyWriteOutcome(rejected, { idempotent: true })).toBe('definitive')
    expect(classifyWriteOutcome(conflict, { idempotent: false })).toBe('definitive')
  })

  // The heart of it. A non-idempotent write that failed in transport may still
  // have been applied — treating it as "never happened" is what would cause a
  // duplicate task launch.
  test('a NON-idempotent write is unknown after transport failure, timeout or abort', () => {
    expect(classifyWriteOutcome(transportFailure, { idempotent: false })).toBe('unknown')
    expect(classifyWriteOutcome(timeout, { idempotent: false })).toBe('unknown')
    const aborted = new DOMException('aborted', 'AbortError')
    expect(classifyWriteOutcome(aborted, { idempotent: false })).toBe('unknown')
  })

  test('an idempotent call is retriable after the same failures', () => {
    expect(classifyWriteOutcome(transportFailure, { idempotent: true })).toBe('retriable')
    expect(classifyWriteOutcome(timeout, { idempotent: true })).toBe('retriable')
  })

  test('5xx stays unknown even when the call is idempotent in shape', () => {
    // The server reached its handler; it may have committed before failing.
    expect(classifyWriteOutcome(serverError, { idempotent: false })).toBe('unknown')
    expect(classifyWriteOutcome(serverError, { idempotent: true })).toBe('unknown')
  })

  test('a non-ApiError throw is unknown for a non-idempotent write', () => {
    expect(classifyWriteOutcome(new Error('weird'), { idempotent: false })).toBe('unknown')
  })
})
