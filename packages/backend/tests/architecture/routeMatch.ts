// RFC-319 T21 —— 路由匹配的单一实现。
//
// 仓里有两处需要把「一个被调用的路径」对回「一条注册的路由」，方向相反：
//
//   A. `api-contract-coverage.test.ts` —— 扫 e2e 源码里 `${baseUrl}/api/...` 的调用，
//      问「这条调用今天还存在吗」。调用侧的 `${...}` 段是通配。
//   B. `rfc319-endpoint-coverage.test.ts` —— 读运行期日志里的**具体**路径，
//      问「哪些注册的端点一次都没被打到」。调用侧没有通配，注册侧的 `:param` 才是通配。
//
// 两处曾经各写一套逐段比较。共用一份的理由不是省代码，是**判据不能有两套**：
// 一旦分叉，「账本说没覆盖」和「守卫说覆盖了」可以同时为真，而没有任何东西会红。
//
// `method` 必须参与比对。RFC-310 PR-10 实测：删的是 `PUT /api/code/matrix/:repoId`
// 而同路径的 `GET` 还在，只比 path 的版本会把三条已死的 e2e 调用全部放行。

/**
 * 调用侧的通配段标记：A 方向用它顶替 e2e 源码里的模板插值段；B 方向用不到。
 *
 * 刻意用一个**不可能出现在真实路径里**的控制字符——与本模块抽取前
 * `api-contract-coverage.test.ts` 内联的哨兵值逐字相同。用空串会和
 * `'/api/x'.split('/')` 产生的前导空段撞车，于是 `/api//agents` 这种双斜杠路径
 * 会意外匹配上 `/api/:id/agents`：通配标记必须落在路径字母表之外。
 */
export const CALL_WILDCARD = '\u0001'

export interface RoutePattern {
  readonly method: string
  /** 注册形态，例如 `/api/agents/:id`。 */
  readonly path: string
}

interface CompiledPattern extends RoutePattern {
  readonly segments: readonly string[]
  /** 字面量段的个数——「最多字面量段获胜」用它排序。 */
  readonly literals: number
}

function segmentsOf(path: string): string[] {
  return path.replace(/\/+$/, '').split('/')
}

export function compilePatterns(patterns: readonly RoutePattern[]): CompiledPattern[] {
  return patterns.map((p) => {
    const segments = segmentsOf(p.path)
    return {
      ...p,
      segments,
      literals: segments.filter((s) => !s.startsWith(':')).length,
    }
  })
}

function segmentsMatch(pattern: readonly string[], called: readonly string[]): boolean {
  if (pattern.length !== called.length) return false
  return pattern.every((seg, i) => {
    const other = called[i]!
    return seg.startsWith(':') || other === CALL_WILDCARD || seg === other
  })
}

/**
 * A 方向：这条（可能带通配段的）调用命中了任何一条注册路由吗。
 *
 * 语义与 `api-contract-coverage.test.ts` 原有的内联 `known()` 逐字一致。
 */
export function callIsRegistered(
  compiled: readonly CompiledPattern[],
  method: string,
  calledSegments: readonly string[],
): boolean {
  return compiled.some((p) => p.method === method && segmentsMatch(p.segments, calledSegments))
}

/**
 * B 方向：把一条**具体**路径对回唯一一条注册路由。
 *
 * **最多字面量段获胜**——与 Hono 自身的路由优先级一致，所以 `/api/workflows/new`
 * 不会被错记成 `/api/workflows/:id` 的命中。同分时按 path 字典序取第一条，
 * 保证结果确定；同分只可能出现在两条形状完全相同的注册上，而那是重复注册，
 * 由 `api-contract-coverage.test.ts` 的 duplicate 守卫管。
 *
 * 对不上任何一条时返回 null —— 调用方要把它当作**反方向的信号**
 * （日志里出现了注册表没有的路径），而不是静默丢弃。
 */
export function resolveConcretePath(
  compiled: readonly CompiledPattern[],
  method: string,
  concretePath: string,
): RoutePattern | null {
  const called = segmentsOf(concretePath.split('?')[0]!)
  let best: CompiledPattern | null = null
  for (const p of compiled) {
    if (p.method !== method) continue
    if (!segmentsMatch(p.segments, called)) continue
    if (
      best === null ||
      p.literals > best.literals ||
      (p.literals === best.literals && p.path < best.path)
    ) {
      best = p
    }
  }
  return best === null ? null : { method: best.method, path: best.path }
}

export function routeKey(r: RoutePattern): string {
  return `${r.method} ${r.path}`
}
