// RFC-203（Codex 实现门 P2）—— 网络错误标签接线的源级锁。为什么存在：
// 'network-unreachable' 的判定从 resolver 的 `instanceof TypeError` 猜测移到了
// fetch 边界打标（api/client.ts fetchOrNetworkError），否则任意应用层 TypeError
// 都会被伪装成「服务不可达」。三条接线都是行为级断言难稳定覆盖的巨文件/路由，
// 按仓规以源级文本断言兜底：
//   1. api/client.ts 所有请求入口必须走 fetchOrNetworkError（裸 await fetch(
//      只允许出现在该 helper 自身实现里，恰好 1 处）；
//   2. resolver 不得回潮 TypeError 猜测分支；
//   3. tasks.preview 的 port-artifact 预览 queryFn 的失败会进 ErrorBanner→
//      resolveApiError，必须用打标 fetch，否则离线显示原文 "Failed to fetch"。
// PlantUmlBlock 的 3 处裸 fetch 走私有错误路径，PR-3（T5a）迁 resolveApiError
// 时一并换成 fetchOrNetworkError——届时把它加进本锁。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function read(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8')
}

describe('RFC-203 网络打标源级锁', () => {
  test('api/client.ts：裸 await fetch( 恰好 1 处（fetchOrNetworkError 自身）', () => {
    const client = read('src/api/client.ts')
    expect(client.match(/await fetch\(/g)?.length).toBe(1)
    expect(client).toContain('export async function fetchOrNetworkError')
  })

  test('resolver 不再按 instanceof TypeError 猜网络错误', () => {
    const errors = read('src/i18n/errors.ts')
    expect(errors.includes('instanceof TypeError')).toBe(false)
  })

  test('tasks.preview 预览 queryFn 走打标 fetch', () => {
    const preview = read('src/routes/tasks.preview.tsx')
    expect(preview).toContain('fetchOrNetworkError(')
    expect(preview.match(/await fetch\(/g)).toBeNull()
  })
})
