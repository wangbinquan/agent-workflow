// RFC-319 R2 —— 前端路由 × e2e 覆盖。
//
// 分母派生自**活的源码**：`packages/frontend/src/routes/*.tsx` 里的
// `createRoute({ path })` 与 `router.tsx` 的路由树。手写清单会漂移，派生不会。
//
// 分子是**运行期实测**：该路由被作为文档请求过（daemon 请求日志里的非 `/api` GET，
// 与 RFC-319 R1 共用同一份 journal）。判据一句话：
//
//   > 默认的 `bun run e2e` 全量跑里，这条路由被真实加载过吗？
//
// 为什么是「加载过」而不是「源码里提过」：`/code/*` 整个面在 e2e 源码里到处都是，
// 但那些出现**全部**落在视觉回归套件里，而它要 `RUN_VISUAL_REGRESSION=1` 才跑，
// PR 腿一次都不会执行。「提过」这个信号会把这一整族漂绿——恰恰是本 RFC 审计
// 抓到的假覆盖形态（`e2e/rfc250-visual-states.spec.ts:530` 的 skip 是同一件事）。
//
// **已知的保守方向**：SPA 的客户端导航（点链接从 /skills 进 /skills/$id）不产生
// 服务端请求，所以只靠文档加载会把「只被点进去过」的路由报成缺口。这个方向是
// 安全的（多报缺口不会漏掉回归），而且修法本身有价值——补一次 `goto` 直达断言
// 等于顺带锁住深链接，那本来就是真实用户场景。
// 精确化留给 T25：让所有 spec 从共享入口拿 `test`，用 fixture 监听 `framenavigated`
// 把客户端导航也记进 journal。那一步要改 62 个 spec 的 import，单独一批做。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface FrontendRoute {
  /** 归一后的路由模式，例如 `/agents/$id`。 */
  readonly path: string
  /** 声明它的源文件，失败信息里要指得出去。 */
  readonly source: string
}

/** `agents.detail.tsx` 这类子路由挂在哪个布局路由下。 */
const LAYOUT_PARENTS: ReadonlyArray<readonly [string, string]> = [
  ['agents.', '/agents'],
  ['skills.', '/skills'],
  ['mcps.', '/mcps'],
  ['plugins.', '/plugins'],
]

export function deriveFrontendRoutes(
  frontendRoutesDir: string,
  routerFile: string,
): FrontendRoute[] {
  const out: FrontendRoute[] = []
  const push = (path: string, source: string): void => {
    if (!out.some((r) => r.path === path)) out.push({ path, source })
  }

  for (const name of readdirSync(frontendRoutesDir).filter((n) => n.endsWith('.tsx'))) {
    const src = readFileSync(join(frontendRoutesDir, name), 'utf-8')
    for (const m of src.matchAll(/path:\s*'([^']+)'/g)) {
      const p = m[1]!
      if (p.startsWith('/') && p !== '/' && !p.startsWith('/$') && p !== '/new') {
        push(p, `packages/frontend/src/routes/${name}`)
        continue
      }
      const parent = LAYOUT_PARENTS.find(([prefix]) => name.startsWith(prefix))
      if (parent === undefined) continue
      push(p === '/' ? parent[1] : `${parent[1]}${p}`, `packages/frontend/src/routes/${name}`)
    }
  }

  const routerSrc = readFileSync(routerFile, 'utf-8')
  for (const m of routerSrc.matchAll(/path:\s*'([^']+)'/g)) {
    const p = m[1]!
    if (p.startsWith('/') && p !== '/') push(p, 'packages/frontend/src/router.tsx')
  }
  push('/', 'packages/frontend/src/routes/index.tsx')

  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** 路由模式匹配一条具体 URL 路径；`$param` 段通配。 */
export function routeMatchesPath(routePath: string, concrete: string): boolean {
  const a = routePath.split('/').filter(Boolean)
  const b = concrete.split('/').filter(Boolean)
  if (a.length !== b.length) return false
  return a.every((seg, i) => {
    if (seg.startsWith('$')) return true
    const other = b[i]!
    try {
      return decodeURIComponent(other) === seg
    } catch {
      return other === seg
    }
  })
}

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFiles(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * 纯诊断信号：这条路由的字面量段在 `e2e/**` 源码里出现过吗。
 *
 * **不参与通过判定**，只用来把账本条目分成两类，让接手的人知道该做什么：
 *   - 提都没提过 ⇒ 这个页面从未进过任何人的视野，要从零写一条 spec。
 *   - 提过却从未加载 ⇒ 多半只出现在默认不跑的套件里，或只被当字符串断言了一下。
 *     **这类更危险**：看起来有覆盖，PR 腿却一次都不执行它。
 *
 * 判据刻意粗：逐个字面量段查 `/seg` 是否出现（`$param` 段跳过），因为 spec 里
 * 写的是模板插值 `/tasks/${id}/preview`，按整串比对必然漏判。诊断宁可宽松。
 */
export function staticallyMentioned(e2eDir: string, routePath: string): boolean {
  const literals = routePath
    .split('/')
    .filter(Boolean)
    .filter((seg) => !seg.startsWith('$'))
    .map((seg) => `/${seg}`)
  if (literals.length === 0) return false
  for (const file of listTsFiles(e2eDir)) {
    const src = readFileSync(file, 'utf-8')
    if (literals.every((needle) => src.includes(needle))) return true
  }
  return false
}

export interface RouteCoverageInput {
  readonly routes: readonly FrontendRoute[]
  readonly e2eDir: string
  /** 运行期文档请求的路径（已去掉 query），来自 route journal 的非 `/api` GET。 */
  readonly documentLoads: readonly string[]
}

export interface RouteCoverageReport {
  readonly total: number
  /** 默认全量跑中被真实加载过的路由。 */
  readonly documentLoaded: readonly string[]
  /** 从未被加载过——账本内容。 */
  readonly uncovered: readonly string[]
  /** `uncovered` 里「源码提过但从未加载」的子集，纯诊断。 */
  readonly mentionedButNeverLoaded: readonly string[]
}

export function buildRouteCoverage(input: RouteCoverageInput): RouteCoverageReport {
  const documentLoaded: string[] = []
  const uncovered: string[] = []
  for (const r of input.routes) {
    if (input.documentLoads.some((p) => routeMatchesPath(r.path, p))) documentLoaded.push(r.path)
    else uncovered.push(r.path)
  }
  return {
    total: input.routes.length,
    documentLoaded: documentLoaded.sort(),
    uncovered: uncovered.sort(),
    mentionedButNeverLoaded: uncovered
      .filter((p) => staticallyMentioned(input.e2eDir, p))
      .sort(),
  }
}
