// 路由门单一事实源 ratchet（架构审视 G0，2026-08-03）。
//
// WHY THIS TEST EXISTS
//
// RFC-247 T4 把粗粒度权限门从三处散落收敛成 `registerRoute` 声明 + 启动期双向
// 自检（routes/registry.ts），并删掉了 server.ts 里手挂的 path-prefix 中间件。
// 但它**只删了调用方**：`backend/src/auth/permissions.ts` 那 202 行实现（7 个
// 导出）原封不动留了下来，全仓零生产引用，唯一 import 是它自己的逐行测试
// `rfc247-verb-for-route.test.ts` —— 一个「只测试无人调用的函数、却看起来像
// 权限不变量锁」的测试，给这份死映射持续发绿灯。
//
// 代价不是几百行磁盘占用，是它在**教育后来人**：
//   · `permissions.ts:113-118` 断言 "the manual resourcePermissionGate('repos')
//     mount in server.ts **still runs alongside** the migrated routes"，而
//     server.ts 同时明写那些挂载 GONE；
//   · `:143-145` 的 "the route-metadata registry (T1) **will** consume the same
//     function" 从未发生；
//   · `verbForRoute` 因此成了「路由 → 权限点」的第二份、无人执行、无人比对的
//     事实源，机械重放全部 registerRoute 声明与它分歧 7 条。
//
// 整层已删。这条测试锁住两件事：
//   1. 那个文件不会回来；
//   2. 没人用旧名字重新造一套并行的权限中间件。
//
// 注释里出现这些名字是允许的（历史叙述、本文件本身），只有**可执行代码**里
// 出现才算复辟。

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const BACKEND_TESTS = resolve(import.meta.dir)
const SHARED_SRC = resolve(import.meta.dir, '..', '..', 'shared', 'src')

/** This file names every retired identifier as a string literal, so it must not scan itself. */
const SELF = resolve(import.meta.dir, 'route-gate-single-source.test.ts')

/** The 7 exports of the deleted legacy layer. */
const RETIRED_GATE_IDENTIFIERS = [
  'requirePermission',
  'requireAdmin',
  'requireResourceAdmin',
  'ensurePermission',
  'resourcePermissionGate',
  'verbForRoute',
  'GatedResource',
] as const

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) out.push(...listTsFiles(p))
    else if (s.isFile() && /\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

/** Line-level comment filter — the same shape RFC-222's G-1 guard uses. */
function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

interface Hit {
  file: string
  line: number
  text: string
}

describe('route gate — single source of truth', () => {
  test('the legacy auth/permissions.ts layer stays deleted', () => {
    const legacy = join(BACKEND_SRC, 'auth', 'permissions.ts')
    expect(existsSync(legacy)).toBe(false)
  })

  test('no executable code references a retired gate helper', () => {
    const pattern = new RegExp(`\\b(${RETIRED_GATE_IDENTIFIERS.join('|')})\\b`)
    const offenders: Hit[] = []
    for (const root of [BACKEND_SRC, BACKEND_TESTS, SHARED_SRC]) {
      for (const file of listTsFiles(root)) {
        if (file === SELF) continue
        const rel = file.replace(`${resolve(root, '..', '..')}/`, '')
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (isCommentLine(line)) return
            if (pattern.test(line)) offenders.push({ file: rel, line: i + 1, text: line.trim() })
          })
      }
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')
      throw new Error(
        `A retired route-gate helper reappeared in executable code at ${offenders.length} site(s):\n${msg}\n` +
          `Route gating goes through registerRoute's RouteMeta declaration only ` +
          `(routes/registry.ts). A second gate mechanism cannot be kept in agreement ` +
          `with the first — that is exactly what RFC-247 T4 removed.`,
      )
    }
    expect(offenders.length).toBe(0)
  })
})
