// ALLOWLIST RATCHET — RFC-144: node_runs.merge_state 直写禁令。
//
// flag-audit §4.4（RFC-G2）：merge_state 此前 19 处 `db.update(nodeRuns)
// .set({ mergeState })` 裸直写、零 CAS 零转移守卫（对比 status 列的四层防护）。
// RFC-144 把全部写点收进 services/lifecycle.ts 的 transitionMergeState（事件
// CAS）与 abandonSupersededMergeStates（集合式守卫写，WHERE 即转移守卫）。
// 本文件是第 4 层防护——s14 同款源码扫描棘轮：
//
//   1. 「`.update(nodeRuns)` 且 `.set({...})` 含 `mergeState:`」的直写，唯一的
//      永久 allowlist 是 services/lifecycle.ts（恰 2 处，各带
//      `rfc144-allow-direct-merge-state-write` 标记）。其余任何 src 文件出现
//      merge_state 直写 → 本测试红，作者必须改走 transitionMergeState。
//   2. 「`.insert(nodeRuns)` 且 `.values({...})` 含 `mergeState:`」在生产代码
//      全域为零——mint 恒生 merge_state=NULL 是状态机的入口不变量
//      （begin-isolation 的合法 from 只有 NULL）。
//   3. `buildMintNodeRunValues`（nodeRunMint.ts）不得出现 mergeState 字段
//      ——同一不变量的工厂侧源码锁。
//
// 射程 packages/backend/src/**（生产代码）；测试 seeding 直写在射程外。
// 扫描器与 s14 一致：剔注释行 → 匹配点向后括号配平截实参 → 判字段名。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

/** 永久 allowlist：唯一合法的 merge_state 直写者（lifecycle.ts 的两个 helper）。 */
const MERGE_STATE_WRITE_ALLOWLIST: Record<string, number> = {
  'services/lifecycle.ts': 2,
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function stripCommentLines(content: string): string {
  return content
    .split('\n')
    .map((line) => (isCommentLine(line) ? '' : line))
    .join('\n')
}

/** 从 `from` 起找到下一个 `.<method>(`，括号配平截取其完整实参文本。 */
function extractCallArg(content: string, from: number, method: string): string | null {
  const re = new RegExp(`\\.${method}\\s*\\(`, 'g')
  re.lastIndex = from
  const m = re.exec(content)
  if (!m) return null
  let depth = 1
  const start = re.lastIndex
  for (let i = start; i < content.length; i++) {
    const ch = content[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return content.slice(start, i)
    }
  }
  return null
}

interface Counts {
  updateWrites: Record<string, number>
  insertWrites: Record<string, number>
}

function countMergeStateSites(): Counts {
  const updateWrites: Record<string, number> = {}
  const insertWrites: Record<string, number> = {}
  for (const file of walkTsFiles(BACKEND_SRC)) {
    const rel = relative(BACKEND_SRC, file).split(sep).join('/')
    const content = stripCommentLines(readFileSync(file, 'utf8'))
    const updateRe = /\.update\s*\(\s*nodeRuns\s*\)/g
    for (;;) {
      if (updateRe.exec(content) === null) break
      const setArg = extractCallArg(content, updateRe.lastIndex, 'set')
      if (setArg !== null && /\bmergeState\s*:/.test(setArg)) {
        updateWrites[rel] = (updateWrites[rel] ?? 0) + 1
      }
    }
    const insertRe = /\.insert\s*\(\s*nodeRuns\s*\)/g
    for (;;) {
      if (insertRe.exec(content) === null) break
      const valuesArg = extractCallArg(content, insertRe.lastIndex, 'values')
      if (valuesArg !== null && /\bmergeState\s*:/.test(valuesArg)) {
        insertWrites[rel] = (insertWrites[rel] ?? 0) + 1
      }
    }
  }
  return { updateWrites, insertWrites }
}

describe('RFC-144 ratchet: direct node_runs.merge_state writes confined to services/lifecycle.ts', () => {
  const counts = countMergeStateSites()

  test('update writes: exactly the allowlist — everything else routes through transitionMergeState', () => {
    const violations: string[] = []
    for (const [file, n] of Object.entries(counts.updateWrites)) {
      const allowed = MERGE_STATE_WRITE_ALLOWLIST[file]
      if (allowed !== undefined) {
        if (n !== allowed) {
          violations.push(
            `${file}: ${n} merge_state write(s), allowlist pins exactly ${allowed} — route new writes through transitionMergeState / abandonSupersededMergeStates`,
          )
        }
        continue
      }
      violations.push(
        `${file}: ${n} direct node_runs.merge_state write(s) outside the allowlist — use transitionMergeState (services/lifecycle.ts)`,
      )
    }
    expect(violations).toEqual([])
    // allowlist 本身必须被占用（防扫描器失效的空洞绿）：
    // transitionMergeState 的 CAS 写 + abandonSupersededMergeStates 的集合写。
    expect(counts.updateWrites['services/lifecycle.ts']).toBe(2)
  })

  test('both allowlisted writes carry the rfc144 marker comment', () => {
    const helper = readFileSync(join(BACKEND_SRC, 'services', 'lifecycle.ts'), 'utf8')
    const markers = helper.match(/rfc144-allow-direct-merge-state-write/g) ?? []
    expect(markers.length).toBe(2)
  })

  test('insert writes: zero in production — every mint is born merge_state=NULL', () => {
    expect(counts.insertWrites).toEqual({})
  })

  test('buildMintNodeRunValues carries no mergeState field (mint-NULL 入口不变量的工厂侧锁)', () => {
    const mint = stripCommentLines(
      readFileSync(join(BACKEND_SRC, 'services', 'nodeRunMint.ts'), 'utf8'),
    )
    expect(/\bmergeState\s*:/.test(mint)).toBe(false)
  })
})
