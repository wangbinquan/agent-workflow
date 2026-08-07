// RFC-269 — 最终 URL 的构造与**双复核**。
//
// 这是「节点只能打到管理员配置的那台主机的那个 API 根」的运行期半边（保存期
// 半边是 shared 的 `codeHostPathIssue`）。放在后端是因为它要的是 `..` 与
// percent 编码**被归一化之后**的结果，而 shared 是零环境依赖层、拿不到 `URL`。
//
// 两项复核缺一不可（2026-08-07 实证）：
//
//   base = 'https://gitlab.corp.example/api/v4'
//   + '/../../admin'  ->  https://gitlab.corp.example/admin
//
// origin 一字未变，却已经从 API 根跳到了 GitLab 的**管理界面**。只查 origin
// 的实现会放行它。

export type CodeHostUrlIssue = 'unparsable' | 'origin-escaped' | 'prefix-escaped'

export interface BuiltUrl {
  /** 归一化后的最终 URL。 */
  url: string
  /** 归一化后的 pathname，供日志/错误信息使用（不含 query，天然无凭据）。 */
  pathname: string
}

/**
 * 拼 base + path + query 并复核。
 *
 * `path` 必须已经过 shared 的保存期判据，且其中的模板变量已按 path 位置
 * percent-encode —— 这个函数是最后一道网，不是第一道。
 */
export function buildCodeHostUrl(
  base: string,
  path: string,
  query?: Readonly<Record<string, string>>,
): { ok: true; value: BuiltUrl } | { ok: false; issue: CodeHostUrlIssue } {
  let parsed: URL
  let parsedBase: URL
  try {
    parsedBase = new URL(base)
    // 字符串拼接而不是 `new URL(path, base)`：后者对以 '/' 开头的 path 会丢掉
    // base 自己的路径前缀（`new URL('/x', 'https://h/api/v4/')` → `https://h/x`），
    // 也就是把每个请求都打到 API 根之外。
    parsed = new URL(`${base.replace(/\/+$/, '')}${path}`)
  } catch {
    return { ok: false, issue: 'unparsable' }
  }
  if (parsed.origin !== parsedBase.origin) return { ok: false, issue: 'origin-escaped' }
  const basePath = parsedBase.pathname.replace(/\/+$/, '')
  if (basePath.length > 0) {
    if (parsed.pathname !== basePath && !parsed.pathname.startsWith(`${basePath}/`)) {
      return { ok: false, issue: 'prefix-escaped' }
    }
  }
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      parsed.searchParams.set(key, value)
    }
  }
  return { ok: true, value: { url: parsed.toString(), pathname: parsed.pathname } }
}

/**
 * 跟随重定向前的目标校验（仅 `followRedirectStripAuth` 那一条 binding 用）。
 *
 * 要求 https：跟随的目标是第三方签名主机，明文跳转会把签名 URL 本身暴露在
 * 链路上。凭据在调用方剥离，不在这里。
 */
export function redirectTargetIssue(location: string): 'unparsable' | 'not-https' | null {
  let parsed: URL
  try {
    parsed = new URL(location)
  } catch {
    return 'unparsable'
  }
  return parsed.protocol === 'https:' ? null : 'not-https'
}
