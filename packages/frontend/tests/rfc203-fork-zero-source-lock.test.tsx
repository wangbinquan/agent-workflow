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

describe('L3 fallback 不拼原文（T5c 第三锁）', () => {
  test('未知码的 fallback 标题恒为纯词条，原文只进 raw', async () => {
    const { default: i18n } = await import('i18next')
    const { setLanguage } = await import('../src/i18n')
    const { resolveApiError } = await import('../src/i18n/errors')
    const { ApiError } = await import('../src/api/client')
    await new Promise<void>((resolvePromise) => {
      if (i18n.isInitialized) resolvePromise()
      else i18n.on('initialized', () => resolvePromise())
    })
    setLanguage('zh-CN')
    const r = resolveApiError(new ApiError(500, 'zz-no-family-no-entry', 'raw diagnostic text'))
    expect(r.title).toBe('请求失败')
    expect(r.title.includes('raw diagnostic text')).toBe(false)
    expect(r.raw).toBe('raw diagnostic text')
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

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(walk(SRC).length).toBeGreaterThanOrEqual(250)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的复活写法喂给**扫描用的同一份 needle**。
//
// 上面两条都是「零命中」型断言：私有 `describeError` 不得复活、裸 `error-box`
// className 只许出现在 ErrorBanner 自身。needle 一旦写歪（少个空格、改成正则却写错），
// 复活的分叉不会被抓到，而断言仍报零——与「真的清零了」同形。
describe('RFC-317 T14 —— matcher 自证：分叉复活写法必须被抓到', () => {
  const contains = (text: string, needle: string): boolean => text.includes(needle)

  test('私有 describeError 的声明形态命中', () => {
    const fabricated = 'function describeError(err: unknown): string {\n  return String(err)\n}\n'
    expect(contains(fabricated, 'function describeError(')).toBe(true)
  })

  test('调用而非声明不算（needle 刻意锁在声明上）', () => {
    const fabricated = 'const msg = describeError(err)\n'
    expect(contains(fabricated, 'function describeError(')).toBe(false)
  })

  test('裸 error-box className 命中；走 ErrorBanner 的写法不命中', () => {
    expect(contains('<div className="error-box">{msg}</div>', 'className="error-box"')).toBe(true)
    expect(contains('<ErrorBanner error={err} />', 'className="error-box"')).toBe(false)
  })
})
