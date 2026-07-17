// RFC-203 PR-3（T5b/T5c）—— 分叉清零源级锁 + ErrorBanner testid 契约。
//
// 为什么存在：错误呈现层的价值在「唯一路径」——一旦有人图快再写一个私有
// describeError 或裸 <div className="error-box">，本地化/details 渲染/ACL
// 计数规则就会在那个面上静默失效。行为级无法断言「不存在别的路径」，按仓规
// 以全源扫描兜底：
//   1. 私有 describeError 分叉零命中（T5a 清零，共曾有 6 处字节级相同副本）；
//   2. 裸 error-box 白名单 = 仅 ErrorBanner.tsx 自身（T5b 迁完 22 处）；
//   3. NoticeBanner/ErrorBanner 的 testid prop 是迁移站点保留测试锚点的
//      公共通道（挂在 banner 根上，不是 wrapper div）。
import { describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ErrorBanner } from '../src/components/ErrorBanner'
import '../src/i18n'

afterEach(cleanup)

const SRC = resolve(__dirname, '../src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('RFC-203 分叉清零源级锁', () => {
  const files = walk(SRC)

  test('私有 describeError 零命中（唯一路径 = i18n describeApiError/resolveApiError）', () => {
    const offenders = files.filter((f) =>
      readFileSync(f, 'utf8').includes('function describeError('),
    )
    expect(offenders).toEqual([])
  })

  test('裸 className="error-box" 白名单 = ErrorBanner.tsx 自身', () => {
    const offenders = files
      .filter((f) => readFileSync(f, 'utf8').includes('className="error-box"'))
      .filter((f) => !f.endsWith('components/ErrorBanner.tsx'))
    expect(offenders).toEqual([])
  })
})

describe('ErrorBanner testid 契约（T5b 迁移锚点通道）', () => {
  test('testid 落在 banner 根（role=alert 元素），不是 wrapper', () => {
    const { container } = render(<ErrorBanner error={new Error('x')} testid="my-anchor" />)
    const root = container.querySelector('[data-testid="my-anchor"]')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('role')).toBe('alert')
    expect(root?.className).toContain('error-box')
  })
})
