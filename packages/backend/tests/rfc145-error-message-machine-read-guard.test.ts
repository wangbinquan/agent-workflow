// RFC-145 T5 — errorMessage 机器读禁令（源码守卫）。
//
// 为什么这条测试存在：error_message 曾寄生两个机器协议（信封失败前缀路由 /
// supersede 标记），RFC-145 把它们列化为 failure_code / superseded_by_review /
// rolled_back 后，errorMessage 回归纯人读 breadcrumb。本守卫防止未来任何生产
// 代码重新把它当机器路由键：
//   违规形态 = `errorMessage` 上的 .startsWith( / .includes( / 与字符串字面量
//   的 ===/!== 比较（backend src + frontend src 双包，剥注释后扫描）。
//   允许：null 判、空串存在性判（`!== ''`——展示层「有没有内容」检查，非协议）、
//   列对列比较（如展示层的 errorMessage !== errorSummary 去重）、赋值/透传/渲染。
// allowlist 为空——新增机器读没有豁免通道，只能走结构化列。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOTS = [
  { name: 'backend', dir: resolve(import.meta.dir, '..', 'src') },
  { name: 'frontend', dir: resolve(import.meta.dir, '..', '..', 'frontend', 'src') },
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

function stripCommentLines(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
        ? ''
        : line
    })
    .join('\n')
}

// errorMessage（含 ?. / ! 链）后接 .startsWith( / .includes(，或与**非空**字符串
// 字面量比较（空串比较是存在性检查，放行）。
const METHOD_READ = /\berrorMessage\s*[?!]*\s*\.\s*(startsWith|includes)\s*\(/
const LITERAL_COMPARE = /\berrorMessage\b[^\n=!]*[!=]==?\s*(['"`])(?!\1)/

describe('RFC-145 ratchet: errorMessage is human breadcrumbs — no machine reads in production code', () => {
  test('backend + frontend src：零违规（机器判定一律走 failure_code / superseded_by_review / rolled_back）', () => {
    const violations: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root.dir)) {
        const rel = `${root.name}/${relative(root.dir, file).split(sep).join('/')}`
        const lines = stripCommentLines(readFileSync(file, 'utf8')).split('\n')
        lines.forEach((line, i) => {
          if (METHOD_READ.test(line) || LITERAL_COMPARE.test(line)) {
            violations.push(`${rel}:${i + 1}  ${line.trim()}`)
          }
        })
      }
    }
    expect(violations).toEqual([])
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(ROOTS.flatMap((root) => walk(root.dir)).length).toBeGreaterThanOrEqual(600)
  })
})
