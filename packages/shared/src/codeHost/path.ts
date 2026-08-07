// RFC-269 — 自定义请求 path 的安全判据。纯函数、无 IO，校验器 / Inspector /
// 执行器共用（三处判据一旦分叉，保存期放行的东西运行期就能打到别处）。
//
// 这条判定链是「节点只能打到管理员配置的那台主机的那个 API 根」这一产品承诺的
// **保存期**半边。运行期半边在后端执行器（`services/codeHost/url.ts`）：最终
// URL 的 origin 与 base pathname 前缀**双复核**——那一半必须用真 URL 实现，
// 因为它要的是 `..` 与 percent 编码被**归一化之后**的结果，而 shared 拿不到
// `URL`（零环境依赖层，见文件底部说明）。两边都在，是因为它们拦的不是同一类
// 东西：保存期拦作者写错/写坏，运行期拦模板变量渲染后才成形的路径。
//
// 判据集是**实证**出来的（2026-08-07，Bun 的 WHATWG URL 实现），不是照抄直觉：
//
//   base = 'https://gitlab.corp.example/api/v4'（含路径前缀，自建实例的常态）
//   base + '/../../admin'  -> https://gitlab.corp.example/admin      ← origin 没变，
//                             但逃出了 API 根，打到了 GitLab **管理界面**
//   base + '/a/%2e%2e/b'   -> https://gitlab.corp.example/api/v4/b   ← URL 类会解码
//                             %2e 再归一化，所以只查字面 '..' 是漏的
//   base + '/x@evil.example/y' -> origin 不变（'@' 在 path 段里无害）
//   base + '/\\\\evil.example/x' -> origin 不变（反斜杠同理）
//
// 结论有两条与初稿设计不同，已折回 design §5.3：**'@' 不再判负**（它在 path
// 中段合法，GitLab 的 `@scope` 包端点就要用它，判负是误伤），而**真正的兜底
// 不是"origin 逐字节复核"而是 origin + pathname 前缀双复核**——只看 origin
// 拦不住上面第一条。

/** 保存期判据。null = 通过。 */
export type CodeHostPathIssue =
  | 'empty'
  | 'control-char'
  | 'whitespace'
  | 'has-scheme'
  | 'not-relative'
  | 'protocol-relative'
  | 'has-query'
  | 'dot-dot'

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
// C0 控制符与 DEL（\t \n \r 由 whitespace 判据先命中，报错更贴切）。
// eslint-disable-next-line no-control-regex -- 判定控制符本身就是这条规则的目的
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const WHITESPACE_RE = /\s/

/**
 * 把 percent-encoded 的点还原成字面点，**只还原点**。
 *
 * 不用 `decodeURIComponent`：它会连带解码 `%2F`（GitLab 的文件路径端点靠
 * `a%2Fb.txt` 表达"这一整串是一个段"，解开就把一个段拆成两个），而且遇到
 * 半截的 `%` 会抛异常，把一个可判定的校验变成崩溃。
 */
function normalizeEncodedDots(path: string): string {
  return path.replace(/%2e/gi, '.')
}

/** 保存期：判定一个（可能含 `{{var}}` 的）path 模板是否可接受。 */
export function codeHostPathIssue(path: string): CodeHostPathIssue | null {
  if (path.length === 0) return 'empty'
  if (CONTROL_RE.test(path)) return 'control-char'
  if (WHITESPACE_RE.test(path)) return 'whitespace'
  // scheme 判定必须在 not-relative 之前：'https://…' 两条都命中，报 scheme
  // 才说得清问题（作者想填绝对 URL），报"不是相对路径"会让人以为少个斜杠。
  if (SCHEME_RE.test(path)) return 'has-scheme'
  if (!path.startsWith('/')) return 'not-relative'
  if (path.startsWith('//')) return 'protocol-relative'
  if (path.includes('?') || path.includes('#')) return 'has-query'
  // 段级精确比较：`..` 是段才算逃逸；`..%2fadmin`（实证：URL 类原样保留）与
  // `..foo` 都是普通段名，不判负。
  const segments = normalizeEncodedDots(path).split('/')
  if (segments.includes('..')) return 'dot-dot'
  return null
}

/**
 * base URL 归一化 + 形态校验。管理员手填，写错就在这里拦下并说清期望形态——
 * 不像 RFC-263 的 `api_base_url` 那样"推不出就渲染空串"，那里是从 payload
 * 推导、没人可问；这里有人在表单前面，说清楚比猜有用。
 *
 * **手写解析而不是 `new URL`**：shared 是零环境依赖的纯逻辑层
 * （`tsconfig.base.json` 的 `lib: ["ES2022"]` + `types: []`，`URL` 根本不在
 * 作用域里），`git-url.ts` 同样是自己解析。这是有意的约束——同一份判定要能在
 * 后端、前端表单与测试里逐字节一致地跑。
 *
 * 真正需要 URL 归一化语义的那一半（最终 URL 的 origin / 路径前缀复核，`..` 的
 * 消解要由真 URL 实现来做）留在后端执行器里，见 design §5.3。
 */
export type CodeHostBaseUrlIssue =
  | 'empty'
  | 'not-http'
  | 'unparsable'
  | 'has-credentials'
  | 'has-query'
  | 'wrong-suffix'

// scheme://authority[/path]，不接受 query / fragment / 空白。
const BASE_URL_RE = /^(https?):\/\/([^/?#\s]+)(\/[^?#\s]*)?$/i

export function normalizeCodeHostBaseUrl(
  raw: string,
  provider: 'gitlab' | 'github',
): { ok: true; value: string } | { ok: false; issue: CodeHostBaseUrlIssue } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, issue: 'empty' }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^https?:/i.test(trimmed)) {
    return { ok: false, issue: 'not-http' }
  }
  if (trimmed.includes('?') || trimmed.includes('#')) return { ok: false, issue: 'has-query' }
  const m = BASE_URL_RE.exec(trimmed)
  if (m === null) return { ok: false, issue: 'unparsable' }
  const scheme = m[1]!.toLowerCase()
  const authority = m[2]!
  // base URL 里嵌用户名密码：凭据有专门的 token 字段，混在这里既会进日志也会
  // 绕开密封存储。
  if (authority.includes('@')) return { ok: false, issue: 'has-credentials' }
  const path = (m[3] ?? '').replace(/\/+$/, '')
  const value = `${scheme}://${authority.toLowerCase()}${path}`
  if (provider === 'gitlab') {
    // 自建实例常见两种形态：https://host/api/v4 与子路径部署
    // https://host/gitlab/api/v4。两者都以 /api/v4 结尾。
    if (!path.endsWith('/api/v4')) return { ok: false, issue: 'wrong-suffix' }
    return { ok: true, value }
  }
  // github.com 的 API 在独立主机上（无路径），GHES 在 /api/v3。
  if (path.length === 0 || path.endsWith('/api/v3')) return { ok: true, value }
  return { ok: false, issue: 'wrong-suffix' }
}
