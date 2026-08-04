// 2026-08-04 沙箱审计的最后一条大项：受控业务 agent 的 shell 只有 `/usr/bin:/bin`
// （外加一份封印的 Bun），于是 `node` / `npm` / `npx` / `cargo` / `go` 与任何版本管理器的
// shim 在围栏里根本不存在——Code→Audit→Fix 的「Code」那一段大面积 `command not found`，
// 而模型只看到 exit 127，全链没有一句话说明是平台把 PATH 换掉了。
//
// 修法不是继承 daemon 的 PATH（那等于把宿主工具链整个交给模型可控进程），而是让**管理员
// 显式声明**要暴露哪些目录：默认空 = 与今天逐字一致；声明后按只读投影进子围栏并前置进 PATH。
//
// 本文件锁的是配置面的形状与默认值；投影本身由 `verifiedPlan` 的 wrapper 装配消费
// （`bindReadOnly` + PATH），在 rfc224/rfc242 的既有套件里随 toolchain 一起被断言。

import { describe, expect, test } from 'bun:test'
import { ConfigSchema, DEFAULT_CONFIG } from '@agent-workflow/shared'

describe('businessToolchainPaths — 管理员声明的工具链目录', () => {
  // 注意：`ConfigSchema` 有大量必填字段，直接 parse `{}` 会因为别的原因抛——那样写出来的
  // 「拒绝」用例是假绿（换掉本条 refinement 也照样过）。一律基于完整默认配置构造。
  const withPaths = (businessToolchainPaths: unknown): unknown => ({
    ...DEFAULT_CONFIG,
    businessToolchainPaths,
  })

  test('默认是空数组（不声明就与修复前逐字一致，绝不从 daemon PATH 推断）', () => {
    expect(DEFAULT_CONFIG.businessToolchainPaths).toEqual([])
    const { businessToolchainPaths: _drop, ...withoutKey } = DEFAULT_CONFIG
    expect(ConfigSchema.parse(withoutKey).businessToolchainPaths).toEqual([])
  })

  test('接受绝对且已规范化的目录', () => {
    const parsed = ConfigSchema.parse(withPaths(['/opt/homebrew/bin', '/usr/local/bin']))
    expect(parsed.businessToolchainPaths).toEqual(['/opt/homebrew/bin', '/usr/local/bin'])
  })

  test.each([
    ['相对路径', 'opt/bin'],
    ['文件系统根', '/'],
    ['含 ..', '/opt/../etc'],
    ['尾随斜杠（同一目录两种写法会让去重失效）', '/usr/local/bin/'],
    ['空串', ''],
  ])('拒绝%s', (_label, entry) => {
    // 先证明同一份配置在只换这一个字段时是合法的，再证明该值被拒——否则「抛了」可能
    // 只是因为别处不合法。
    expect(() => ConfigSchema.parse(withPaths([]))).not.toThrow()
    expect(() => ConfigSchema.parse(withPaths([entry]))).toThrow()
  })

  test('有条数上限（配置面不是通往整个宿主文件系统的通道）', () => {
    const many = Array.from({ length: 17 }, (_, i) => `/opt/t${i}`)
    expect(() => ConfigSchema.parse(withPaths(many))).toThrow()
  })
})
