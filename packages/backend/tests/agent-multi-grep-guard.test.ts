// RFC-060 PR-E E.T6 — source-grep guard.
//
// Locks that the `agent-multi` NodeKind is fully removed from production
// source code:
//
//   1. NODE_KIND enum does NOT contain 'agent-multi'.
//   2. shared/sharding.ts (the RFC-055 agent-multi sharding helpers) is gone.
//   3. No production .ts / .tsx file under packages/*/src/ contains the
//      literal token `agent-multi` outside RFC-060 comments.
//
// The string `agent-multi` is still allowed in:
//   - documentation: any file under design/ + proposal/init.md footnote
//   - this guard test itself (it has to mention the token)
//   - comment lines that explicitly cite the removal (matched via
//     `RFC-060 PR-E removed agent-multi` style markers)
//   - the no-op stub for the legacy palette deserializer (rejects the
//     legacy serialized form by name)

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { NODE_KIND } from '@agent-workflow/shared'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue
    const path = join(dir, entry)
    const s = statSync(path)
    if (s.isDirectory()) {
      walk(path, out)
    } else {
      const ext = extname(path)
      if (ext === '.ts' || ext === '.tsx') out.push(path)
    }
  }
  return out
}

// RFC-060 PR-E: comments mentioning agent-multi are tolerated as historical
// context (RFC-xx prior-art references, removal notes, JSDoc lists). Only
// LIVE code paths must be free of the token; the comment-prefix check below
// covers all comment shapes (//, *, /* …).

/**
 * 这一行是不是**活代码里**的 agent-multi 残留。**纯函数**——扫描与 RFC-317 T14 的
 * 「matcher 自证」共用它。判据里三条豁免（注释 / i18n 文案 / palette 兼容 stub）各自
 * 都是一次「宽一点」的决定，而宽过头的表现就是「零违规」，与真的清干净了同形。
 */
function isAgentMultiOffender(file: string, line: string): boolean {
  if (!line.includes('agent-multi')) return false
  const trimmed = line.trimStart()
  // Comment lines are tolerated — historical context, RFC-x prior-art notes,
  // JSDoc lists, removal markers all use the token. Only live code paths must
  // be clean.
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('{/*') // JSX comment
  ) {
    return false
  }
  // i18n-string lines referencing the legacy node kind in human-readable copy
  // (e.g. `multiNotSupported:` messages) are tolerated — PR-F's i18n sweep
  // will drop them.
  if (file.endsWith('zh-CN.ts') || file.endsWith('en-US.ts')) return false
  // The palette deserializer's legacy stub returns null for the legacy
  // serialized form by name — that's the documented escape hatch.
  if (file.endsWith('nodePalette.ts') && line.includes("kind === 'agent-multi'")) return false
  return true
}

describe("RFC-060 PR-E — 'agent-multi' grep guard", () => {
  test("NODE_KIND enum does NOT contain 'agent-multi'", () => {
    expect(NODE_KIND).not.toContain('agent-multi' as never)
  })

  test('shared/sharding.ts (RFC-055 helpers) is removed', () => {
    expect(() =>
      readFileSync(resolve(REPO_ROOT, 'packages/shared/src/sharding.ts'), 'utf8'),
    ).toThrow()
  })

  test('shared/tests/sharding.test.ts is removed', () => {
    expect(() =>
      readFileSync(resolve(REPO_ROOT, 'packages/shared/tests/sharding.test.ts'), 'utf8'),
    ).toThrow()
  })

  test('frontend ShardingStrategyField is removed', () => {
    expect(() =>
      readFileSync(
        resolve(REPO_ROOT, 'packages/frontend/src/components/canvas/ShardingStrategyField.tsx'),
        'utf8',
      ),
    ).toThrow()
  })

  // RFC-254 T32: this guard READS every source file in three packages, so its
  // cost is real I/O rather than computation. Measured: 107ms for the whole
  // file on macOS, and over 5000ms for this one test on Windows — roughly a
  // 47x penalty, which is what per-file real-time scanning does to a few
  // thousand small opens. The default 5s budget therefore expires on Windows
  // while the guard is doing exactly what it is supposed to.
  //
  // The budget is deliberately generous rather than "just above what was
  // measured": a guard that flakes near its own deadline is worse than one that
  // takes a few seconds, and nothing here gets slower except by scanning more
  // files, which is the point.
  test('production src/ has no live agent-multi references (comments excluded)', () => {
    const srcDirs = [
      resolve(REPO_ROOT, 'packages/shared/src'),
      resolve(REPO_ROOT, 'packages/backend/src'),
      resolve(REPO_ROOT, 'packages/frontend/src'),
    ]
    const offenders: string[] = []
    for (const dir of srcDirs) {
      for (const file of walk(dir)) {
        const text = readFileSync(file, 'utf8')
        if (!text.includes('agent-multi')) continue
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          if (!isAgentMultiOffender(file, line)) continue
          offenders.push(`${file.replace(REPO_ROOT + '/', '')}:${i + 1}: ${line.trimStart()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  }, 60_000)
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(walk(resolve(REPO_ROOT, 'packages/backend/src')).length).toBeGreaterThanOrEqual(300)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的残留喂给**扫描用的同一份判据**。
//
// 这条守卫的三条豁免各自都是一次「宽一点」的决定，而宽过头的表现是「零违规」——
// 与真的清干净了同形。这里把每条豁免的**边界**钉住：豁免被悄悄放宽（比如从
// 「nodePalette.ts 里的 kind 比较」放宽成「nodePalette.ts 全文件」）会当场红。
describe('RFC-317 T14 —— matcher 自证：活代码里的残留必须被抓到', () => {
  const SRC = 'packages/backend/src/services/nodeExecutor.ts'

  test('活代码里的残留命中', () => {
    for (const line of [
      "      if (node.kind === 'agent-multi') return shard(node)",
      '  const KINDS = ["agent", "agent-multi"]',
    ]) {
      expect(isAgentMultiOffender(SRC, line), `没抓到：${line}`).toBe(true)
    }
  })

  test('四种注释形态都豁免（含 JSX 注释）', () => {
    for (const line of [
      "  // 历史上这里是 'agent-multi'",
      '   * agent-multi 已随 RFC-060 删除',
      '  /* agent-multi */',
      '      {/* agent-multi 的旧入口 */}',
    ]) {
      expect(isAgentMultiOffender(SRC, line), `不该报：${line}`).toBe(false)
    }
  })

  test('i18n 文案豁免只对两个语言文件生效', () => {
    const copy = "  multiNotSupported: 'agent-multi 节点已不再支持',"
    expect(isAgentMultiOffender('packages/frontend/src/i18n/zh-CN.ts', copy)).toBe(false)
    expect(isAgentMultiOffender('packages/frontend/src/i18n/en-US.ts', copy)).toBe(false)
    expect(isAgentMultiOffender('packages/frontend/src/i18n/index.ts', copy)).toBe(true)
  })

  test('palette 兼容 stub 的豁免只覆盖那一种比较写法', () => {
    const palette = 'packages/frontend/src/workflow/nodePalette.ts'
    expect(isAgentMultiOffender(palette, "  if (kind === 'agent-multi') return null")).toBe(false)
    expect(isAgentMultiOffender(palette, "  register('agent-multi', legacyStub)")).toBe(true)
  })
})
