// 依赖漏洞门禁（scripts/audit-gate.ts）。
//
// 为什么这条测试存在：原门禁是 `bun audit --audit-level=high --ignore <GHSA>`，
// 而这两个 flag 在 bun 1.3.13 里是**显示层过滤器**——退出码只反映「有没有公告」，
// 与严重度和忽略列表无关。于是它只有两种结局：registry 返回数据就恒红（加多少
// --ignore 都修不好），返回空就恒绿。2026-07-26 之前 CI 一直绿，全是后者：三次
// 成功 run 的该步骤日志里连一条公告都没有、0.12s 退出；当天返回真实数据后立刻
// 变红，且策略里写的「逐条 scoped ignore」完全失效。
//
// 下面锁住三件事：① 报告解码（bun 把 JSON gzip 压缩后写 stdout，还可能带 ANSI
// banner）；② 判定逻辑（只 high/critical 入闸、忽略列表生效、stale 忽略可见）；
// ③ CI 接线（必须调新门禁，且不得退回那条失效命令）。任何一条变红，都意味着
// 门禁又回到了「看起来在把关、实际不把关」的状态。

import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  BLOCKING_SEVERITIES,
  decodeAuditReport,
  evaluateAudit,
  formatVerdict,
  ghsaOf,
  IGNORED_ADVISORIES,
  type AuditReport,
  type IgnoreEntry,
} from '../../../scripts/audit-gate'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8')

function advisory(over: Partial<{ ghsa: string; severity: string; title: string }> = {}) {
  const ghsa = over.ghsa ?? 'GHSA-aaaa-bbbb-cccc'
  return {
    url: `https://github.com/advisories/${ghsa}`,
    title: over.title ?? 'test advisory',
    severity: over.severity ?? 'high',
    vulnerable_versions: '<1.0.0',
  }
}

describe('audit-gate — 报告解码', () => {
  const report: AuditReport = { lodash: [advisory({ ghsa: 'GHSA-1111-1111-1111' })] }

  test('明文 JSON', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(report))
    expect(decodeAuditReport(bytes)).toEqual(report)
  })

  test('gzip 载荷（bun 进管道时的真实形状）', () => {
    const bytes = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(report))))
    expect(decodeAuditReport(bytes)).toEqual(report)
  })

  test('ANSI banner + gzip 载荷（bun 重定向到文件时的真实形状）', () => {
    const banner = new TextEncoder().encode('[0m[1mbun audit [0mv1.3.13\n')
    const gz = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(report))))
    const bytes = new Uint8Array(banner.length + gz.length)
    bytes.set(banner, 0)
    bytes.set(gz, banner.length)
    expect(decodeAuditReport(bytes)).toEqual(report)
  })

  test('截断的 gzip（bun 1.3.13 的真实形状）仍能解出报告', () => {
    // bun 自己解不开 registry 的 gzip 响应时，会把压缩体原样倒进 stdout，而且
    // 尾部 CRC/ISIZE 是缺的——严格 gunzip 报 `unexpected end of file`。数据主体
    // 完整，必须能救回来，否则门禁在最常见的真实情形下退化成「无数据放行」。
    const full = gzipSync(Buffer.from(JSON.stringify(report)))
    const truncated = new Uint8Array(full.subarray(0, full.length - 8))
    expect(decodeAuditReport(truncated)).toEqual(report)
  })

  test('空输出 / 垃圾字节 ⇒ null（当作「无数据」，绝不当作「没有漏洞」）', () => {
    expect(decodeAuditReport(new Uint8Array(0))).toBeNull()
    expect(decodeAuditReport(new TextEncoder().encode('not json at all'))).toBeNull()
  })

  test('空报告 {} 是有效数据，不等于无数据', () => {
    expect(decodeAuditReport(new TextEncoder().encode('{}'))).toEqual({})
  })

  test('数组 / 非对象顶层 ⇒ null', () => {
    expect(decodeAuditReport(new TextEncoder().encode('[]'))).toBeNull()
  })
})

describe('audit-gate — 判定', () => {
  const IGN: IgnoreEntry[] = [
    { id: 'GHSA-known-0000-0000', package: 'p', why: 'w', removeWhen: 'r' },
  ]

  test('未被接受的 high / critical ⇒ 入闸', () => {
    const v = evaluateAudit(
      {
        a: [advisory({ ghsa: 'GHSA-new1-0000-0000', severity: 'high' })],
        b: [advisory({ ghsa: 'GHSA-new2-0000-0000', severity: 'critical' })],
      },
      IGN,
    )
    expect(v.blocking.map((f) => f.ghsa).sort()).toEqual([
      'GHSA-new1-0000-0000',
      'GHSA-new2-0000-0000',
    ])
  })

  test('忽略列表里的 high 不入闸，但仍如实计入 accepted', () => {
    const v = evaluateAudit({ p: [advisory({ ghsa: 'GHSA-known-0000-0000' })] }, IGN)
    expect(v.blocking).toHaveLength(0)
    expect(v.accepted.map((f) => f.ghsa)).toEqual(['GHSA-known-0000-0000'])
  })

  test('moderate / low 永不入闸', () => {
    const v = evaluateAudit(
      {
        a: [advisory({ ghsa: 'GHSA-mod0-0000-0000', severity: 'moderate' })],
        b: [advisory({ ghsa: 'GHSA-low0-0000-0000', severity: 'low' })],
      },
      IGN,
    )
    expect(v.blocking).toHaveLength(0)
    expect(v.belowThreshold).toBe(2)
  })

  test('忽略条目匹配不到任何公告 ⇒ 标记为 stale（上游已修，该删）', () => {
    const v = evaluateAudit({}, IGN)
    expect(v.staleIgnores).toEqual(['GHSA-known-0000-0000'])
  })

  test('空报告 ⇒ 不入闸', () => {
    expect(evaluateAudit({}, IGN).blocking).toHaveLength(0)
  })

  test('ghsaOf 从公告 URL 取末段', () => {
    expect(ghsaOf(advisory({ ghsa: 'GHSA-zzzz-yyyy-xxxx' }))).toBe('GHSA-zzzz-yyyy-xxxx')
  })

  test('入闸严重度恰为 high + critical', () => {
    expect([...BLOCKING_SEVERITIES].sort()).toEqual(['critical', 'high'])
  })

  test('有未接受项时输出里带出处置指引，没有时明确说通过', () => {
    const bad = formatVerdict(
      evaluateAudit({ a: [advisory({ ghsa: 'GHSA-new1-0000-0000' })] }, IGN),
    )
    expect(bad.join('\n')).toContain('IGNORED_ADVISORIES')
    expect(formatVerdict(evaluateAudit({}, IGN)).join('\n')).toContain('没有未被接受')
  })
})

describe('audit-gate — 忽略列表的书面理由（策略强制）', () => {
  test('每条都有合法 GHSA、包名、why、removeWhen', () => {
    expect(IGNORED_ADVISORIES.length).toBeGreaterThan(0)
    for (const e of IGNORED_ADVISORIES) {
      expect(e.id).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/)
      expect(e.package.length).toBeGreaterThan(0)
      // 理由必须是具体交代，不是一句「dev only」了事。
      expect(e.why.length).toBeGreaterThan(30)
      expect(e.removeWhen.length).toBeGreaterThan(10)
    }
  })

  test('没有重复条目', () => {
    const ids = IGNORED_ADVISORIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('audit-gate — CI 接线', () => {
  const ci = read('.github/workflows/ci.yml')
  // 只看**可执行面**：注释里引用那条失效命令是有意为之（解释为什么不能用它），
  // 不能因此触发回归锁。
  const ciExecutable = ci
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')

  test('CI 调用新门禁', () => {
    expect(ciExecutable).toContain('bun run audit:gate')
  })

  test('CI 不得退回那条失效命令（--audit-level / --ignore 只是显示层过滤器）', () => {
    expect(ciExecutable).not.toMatch(/bun audit\s+--audit-level/)
    expect(ciExecutable).not.toMatch(/--ignore GHSA-/)
  })

  test('根 package.json 注册了 audit:gate', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['audit:gate']).toBe('bun run scripts/audit-gate.ts')
  })

  test('门禁没有被整体降级（策略禁止 continue-on-error）', () => {
    const step = ci.slice(ci.indexOf('dependency audit gate'), ci.indexOf('actionlint'))
    expect(step).not.toContain('continue-on-error')
  })
})
