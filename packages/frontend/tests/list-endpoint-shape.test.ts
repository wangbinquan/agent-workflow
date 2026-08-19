// RFC-310 —— 「列表端点回 `{ items: [...] }`，前端别当裸数组用」的形状对账。
//
// 事故（2026-08-19 实走 UI 时撞到）：`/code/assignments` 点「新建指派」整页
// error boundary，`props.repos.map is not a function`。根因是该页四条 useQuery
// 全把 `{ items: [...] }` 声明成裸数组：
//
//   · TypeScript 拦不住——`api.get` 回 `unknown`，泛型是**作者自己填的断言**，
//     填错了编译器无从校验；
//   · 页面测试拦不住——它 mock 掉 fetch 并且**照着错误的形状**造数据，两边
//     一起错，于是全绿。
//
// 与前两个 adapter bug（端点前缀、创建载荷）同族：前端对后端形状的假设没有
// 任何机械对账。这条测试补上那根线。
//
// **判据来源**：下面这张表不是从后端源码启发式推的（试过，会把 `/api/agents`
// 这类真·裸数组误判成 items 形状，进而要求正确的代码去改错），而是
// 2026-08-19 逐条 curl 真实 daemon 得到的实测形状。新增列表端点时按同样方式
// 核一次再登记——判据必须是可复跑的观测，不是猜测。

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const FRONTEND_SRC = resolve(import.meta.dirname, '..', 'src')

/**
 * 实测回 `{ items: [...] }` 的 GET 端点（2026-08-19 对运行中的 daemon 逐条
 * curl）。对照组（同日实测**裸数组**，登记在此以免下一个人反向改错）：
 * `/api/agents`、`/api/mcps`、`/api/skills`、`/api/plugins`、`/api/workflows`、
 * `/api/workgroups`。
 */
const ITEMS_SHAPED_ENDPOINTS: readonly string[] = [
  '/api/cached-repos',
  '/api/repo-groups',
  '/api/memories',
  '/api/code/digital-employees',
  '/api/code/automation-policies',
  '/api/code/action-templates',
  '/api/code/verification-profiles',
  '/api/integrations/development-adapters',
  '/api/code/repository-assignments',
]

function listFilesRecursive(dir: string, ext: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(p, ext))
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(p)
  }
  return out
}

/** 前端 `useQuery<T>({ … queryFn: … api.get('<literal>') … })` 的 (T, path) 对。 */
export function declaredQueryShapes(
  src: string,
): { typeArg: string; path: string; line: number }[] {
  const out: { typeArg: string; path: string; line: number }[] = []
  for (const m of src.matchAll(/useQuery<([\s\S]*?)>\(\{([\s\S]*?)\n\s*\}\)/g)) {
    const get = /api\.get(?:<[^>]*>)?\(\s*'(\/api\/[^']+)'/.exec(m[2]!)
    if (get === null) continue
    out.push({
      typeArg: m[1]!,
      path: get[1]!,
      line: src.slice(0, m.index!).split('\n').length,
    })
  }
  return out
}

/**
 * 类型实参是否"带 items"。行内字面量（`{ items: X[] }`）直接看；具名类型
 * （`ListResponse`）解析一跳——在同一文件里找它的 interface/type 声明。
 * 解析不到就按**不通过**处理：宁可逼作者写清楚，也不放过一个真错。
 */
export function declaresItems(typeArg: string, src: string): boolean {
  const t = typeArg.trim()
  if (/\bitems\b/.test(t)) return true
  if (!/^[A-Za-z_$][\w$]*$/.test(t)) return false
  const start = new RegExp(
    `(?:interface\\s+${t}\\s*(?:extends[^{]*)?|type\\s+${t}\\s*=\\s*)\\{`,
  ).exec(src)
  if (start === null) return false
  // 花括号配平取整个声明体：单行 `interface X { items: Y[] }` 与多行同样成立
  // （只按 `\n}` 收尾的版本会漏掉单行写法——本文件的自检当场照出过这个洞）。
  let depth = 1
  const from = start.index + start[0].length
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return /\bitems\b/.test(src.slice(from, i))
    }
  }
  return false
}

describe('list endpoints answer { items: [...] } — the frontend must declare that shape', () => {
  test('no frontend useQuery declares a bare array for an { items } endpoint', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const file of listFilesRecursive(FRONTEND_SRC, ['.ts', '.tsx'])) {
      const src = readFileSync(file, 'utf8')
      for (const q of declaredQueryShapes(src)) {
        if (!ITEMS_SHAPED_ENDPOINTS.includes(q.path)) continue
        scanned += 1
        if (!declaresItems(q.typeArg, src)) {
          offenders.push(
            `${relative(FRONTEND_SRC, file)}:${q.line} — useQuery<${q.typeArg.trim()}> on ${q.path}` +
              ' returns { items: [...] }; a bare array crashes at .map/.find',
          )
        }
      }
    }
    // 失败关闭：扫描器一旦失效（写法变了、目录挪了），offenders 恒为空而测试
    // 恒绿——先证明它真的扫到了这些端点的调用点。
    expect(scanned).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })

  test('the shape checker itself: inline, named-with-items, and bare-array all judged right', () => {
    // 这条是守卫的自检（变异检验的常驻版）：判据函数错了，上面那条会静默放行。
    const src = `interface ListResponse { items: Row[] }\ninterface Bare { id: string }\n`
    expect(declaresItems('{ items: Row[] }', src)).toBe(true)
    expect(declaresItems('ListResponse', src)).toBe(true)
    expect(declaresItems('Row[]', src)).toBe(false)
    expect(declaresItems('Bare', src)).toBe(false)
    // 事故当时的原文：四条里的两条长这样。
    expect(declaresItems('{ id: string; urlRedacted: string | null }[]', src)).toBe(false)
    expect(declaresItems('IdentityRow[]', src)).toBe(false)
  })

  test('the extractor finds the assignments page queries (the file the incident came from)', () => {
    const src = readFileSync(join(FRONTEND_SRC, 'routes', 'code.assignments.tsx'), 'utf8')
    const paths = declaredQueryShapes(src).map((q) => q.path)
    for (const p of [
      '/api/code/repository-assignments',
      '/api/code/digital-employees',
      '/api/code/automation-policies',
      '/api/cached-repos',
      '/api/repo-groups',
    ]) {
      expect(paths).toContain(p)
    }
  })
})
