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
