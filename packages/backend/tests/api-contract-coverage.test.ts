// RFC-054 W1-2 — coverage guard for the API contract registry.
//
// ⚠️ RFC-317 T52（findings TP-01）—— 这里原本写着「LOCKS: every HTTP endpoint …」。
// **它做不到**：下面两条扫描正则都要求 `path: '<字面量>'`，而 `developmentConfig.ts`
// 用 `path: cfg.base` 注册一个六路由家族并挂了 5 次，外加计算路径的 `mountAclEndpoints`
// ——四十来个端点从未进入视野。更糟的是本文件的**盲点元守卫也看不见它们**
// （检测器的 `[^}]*?` 跨不过 `${cfg.base}` 里的 `}`），于是「所有盲点都已登记」照绿。
// 这正是本文件头注释自己命名过的失败模式：silent completeness。
//
// 权威的完备性判据现在是 `tests/architecture/rfc317-route-contract-oracle.test.ts`
// ——它在 `createApp` 之后问框架的 `allRouteMeta()`，计算路径逃不掉。
//
// 本文件保留为**源码侧的快速检查**（不需要建 app，跑得快，且「zombie 注册」与
// e2e 交叉核对这两条是它独有的）。它的覆盖面**不完整**，别再据此认为「全都注册了」。

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { ENDPOINTS, type HttpMethod } from './contracts/registry'
import { CALL_WILDCARD, callIsRegistered, compilePatterns } from './architecture/routeMatch'
import { EXEMPT_MOUNTS } from '../src/routes/registry'

const ROUTES_DIR = resolve(import.meta.dir, '..', 'src', 'routes')

// Match `app.get('/path', ...)`, `app.post('/path', ...)`, etc. We strip
// comment lines first so commented-out routes don't get picked up. Tolerant
// of leading whitespace and additional middleware args.
const ROUTE_RE = /\bapp\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g

/**
 * RFC-247 T3 — the second registration form. Migrated routes declare themselves
 * as `registerRoute(app, { method: 'GET', path: '/api/x', … }, handler)` so the
 * framework can derive their permission gate from the same declaration the API
 * documentation is generated from.
 *
 * Both forms must be discoverable while the migration is in flight. A scanner
 * that only knew `app.<verb>('…')` would report every migrated route as a
 * "zombie registration" in ENDPOINTS — i.e. it would fail loudly for the right
 * reason but the wrong cause, and the obvious way to silence it (deleting the
 * ENDPOINTS entry) would delete real contract coverage.
 */
const REGISTER_ROUTE_RE =
  /\bregisterRoute\s*\(\s*app\s*,\s*\{[^}]*?method:\s*['"](GET|POST|PUT|DELETE|PATCH)['"][^}]*?path:\s*['"]([^'"]+)['"]/gs

interface DiscoveredRoute {
  method: HttpMethod
  path: string
  /** File the route was discovered in (helpful in failure messages). */
  source: string
}

/**
 * 递归列出 `.ts`。**必须递归**：平铺 `readdirSync` 遇到子目录只会静默跳过，
 * 而扫描器扫不到的文件就是"守卫恒绿"——这类空洞绿比没有守卫更坏，因为它
 * 让人以为覆盖住了。射程内今天恰好没有子目录，正因如此更要现在就递归：
 * 等有人第一次建子目录时，没有任何信号会提醒他守卫已经瞎了。
 */
function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFilesRecursive(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

function listRouteFiles(): string[] {
  return listTsFilesRecursive(ROUTES_DIR)
}

function stripLineComments(src: string): string {
  // Drop everything from `//` to end-of-line. Block comments stay because
  // the route literal doesn't contain `*/`.
  return src
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

// RFC-099 mounts GET/PUT `${base}/:${param}/acl` through a helper, using a
// COMPUTED path (`const path = \`${cfg.base}/:${cfg.param}/acl\``). ROUTE_RE
// requires a string literal, so all ten of those endpoints — the write entry
// point for owner transfer and grants — were invisible to this guard and had no
// registry entry, hence no 401 gate and no contract test of any kind.
// Reconstruct them from the call sites.
// See design/test-guard-audit-2026-07-21 gap B1-routes-3.
const ACL_MOUNT_RE =
  /mountAclEndpoints\s*\(\s*app\s*,\s*deps\s*,\s*\{[\s\S]{0,400}?base:\s*['"]([^'"]+)['"][\s\S]{0,400}?param:\s*['"]([^'"]+)['"]/g

function discoverAclRoutes(src: string, source: string): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = []
  let m: RegExpExecArray | null
  ACL_MOUNT_RE.lastIndex = 0
  while ((m = ACL_MOUNT_RE.exec(src)) !== null) {
    const path = `${m[1]!}/:${m[2]!}/acl`
    out.push({ method: 'GET', path, source })
    out.push({ method: 'PUT', path, source })
  }
  return out
}

function discoverRoutes(): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = []
  for (const f of listRouteFiles()) {
    const src = stripLineComments(readFileSync(f, 'utf-8'))
    let m: RegExpExecArray | null
    ROUTE_RE.lastIndex = 0
    while ((m = ROUTE_RE.exec(src)) !== null) {
      out.push({
        method: m[1]!.toUpperCase() as HttpMethod,
        path: m[2]!,
        source: f,
      })
    }
    REGISTER_ROUTE_RE.lastIndex = 0
    while ((m = REGISTER_ROUTE_RE.exec(src)) !== null) {
      out.push({
        method: m[1]!.toUpperCase() as HttpMethod,
        path: m[2]!,
        source: f,
      })
    }
    out.push(...discoverAclRoutes(src, f))
  }
  return out
}

/**
 * Route registrations whose path is not a string literal, i.e. the ones
 * `ROUTE_RE` structurally cannot see. Every such call site needs a bespoke
 * reconstruction above; the meta-test below fails when a new one appears so the
 * blind spot cannot grow silently a second time.
 */
function discoverNonLiteralMounts(): string[] {
  const out: string[] = []
  for (const f of listRouteFiles()) {
    const src = stripLineComments(readFileSync(f, 'utf-8'))
    const re = /\bapp\.(get|post|put|delete|patch)\s*\(\s*([^'"\s)])/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length
      // RFC-254 T32: `basename`, not `split('/')`. The hand-rolled version
      // returns the WHOLE path on Windows, where the separator is `\`, so every
      // entry here was spelled `C:\...\resourceAcl.ts:NN` and the
      // `startsWith('resourceAcl.ts:')` check below matched nothing — the guard
      // reported zero known blind spots and read like the ACL mounts had
      // vanished.
      out.push(`${basename(f)}:${line} app.${m[1]}(${m[2]}…)`)
    }
    // RFC-247 T3: the same blind spot in the registerRoute form. A declaration
    // whose `path` is a variable (the templated ACL mounts) is invisible to
    // REGISTER_ROUTE_RE exactly as `app.get(path, …)` was invisible to
    // ROUTE_RE, so it must stay listed here rather than silently disappearing
    // from the guard when the mount is modernised.
    // Two shapes count as non-literal: `path: someVar` and the ES shorthand
    // `path,` — the ACL mount uses the latter, which an earlier version of this
    // guard missed entirely.
    const reReg = /\bregisterRoute\s*\(\s*app\s*,\s*\{[^}]*?path(?::\s*([^'"\s,]))?\s*,/gs
    while ((m = reReg.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length
      out.push(`${basename(f)}:${line} registerRoute(path: ${m[1] ?? '<shorthand>'}…)`)
    }
  }
  return out
}

// `/api/whoami` is registered directly in server.ts (not under routes/) but
// is owned by the auth layer; we deliberately skip it in this guard. Other
// non-route registrations (SPA fallback `*`, ws upgrade in server.ts) live
// outside routes/ too and similarly are not in scope.
const NON_ROUTES_EXCEPTIONS = new Set<string>()

describe('API contract registry coverage', () => {
  const discovered = discoverRoutes()
  const registered = new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`))

  test('discovers at least 100 endpoints across routes/*.ts', () => {
    // Sanity: project currently has ~138; if this drops below 100 the route
    // scan is broken (likely RegExp change), not the routes themselves.
    expect(discovered.length).toBeGreaterThan(100)
  })

  test('every src/routes/*.ts endpoint is registered in ENDPOINTS', () => {
    const missing = discovered
      .filter((d) => !NON_ROUTES_EXCEPTIONS.has(`${d.method} ${d.path}`))
      .filter((d) => !registered.has(`${d.method} ${d.path}`))
      .map((d) => `  ${d.method.padEnd(7)} ${d.path}\n    (defined in ${d.source})`)
    if (missing.length > 0) {
      throw new Error(
        `RFC-054 contract registry is missing ${missing.length} endpoint(s):\n` +
          missing.join('\n') +
          '\n\nAdd the entry to packages/backend/tests/contracts/registry.ts ENDPOINTS.',
      )
    }
  })

  test('every ENDPOINTS entry maps to a real source route (no zombie registrations)', () => {
    const discoveredKeys = new Set(discovered.map((d) => `${d.method} ${d.path}`))
    const zombies = ENDPOINTS.filter((e) => !discoveredKeys.has(`${e.method} ${e.path}`)).map(
      (e) => `${e.method} ${e.path}`,
    )
    if (zombies.length > 0) {
      throw new Error(
        `RFC-054 contract registry has ${zombies.length} entries with no source route:\n` +
          zombies.map((z) => `  ${z}`).join('\n') +
          '\n\nEither restore the route or drop the entry.',
      )
    }
  })

  test('every RFC-099 ACL endpoint is discovered and registered', () => {
    // Explicit, not just implied by the generic test above: these are the
    // owner-transfer / grant-editing endpoints for every ACL'd resource type,
    // and they spent their whole life outside the contract suite. Asserting the
    // exact set (rather than a count) means a SIXTH resource type gaining ACL
    // endpoints — as workgroups did — cannot slip in unregistered.
    const acl = discovered
      .filter((d) => d.path.endsWith('/acl'))
      .map((d) => `${d.method} ${d.path}`)
      .sort()
    expect(acl).toEqual(
      [
        '/api/agents/:id',
        '/api/skills/:id',
        '/api/mcps/:id',
        '/api/workgroups/:id',
        '/api/plugins/:id',
        '/api/workflows/:id',
        // RFC-304 → RFC-309 — the seventh ACL resource type. It was two until
        // the merge: the department layer carried scripts that run as the
        // daemon and the group layer carried none, so granting one had to not
        // grant the other. That is a field-level check inside one row now.
        '/api/capability-templates/:id',
        // RFC-317 T8 —— 员工定义（第 13 类）。
        //
        // 注意这里**只有 8 个 base**，而 ACL 资源今天有 13 类：RFC-310 的五类配置
        // 资源经 routes/developmentConfig.ts 的工厂挂载（`type: cfg.aclType`，一个
        // 变量），`discoverRoutes()` 的字面量重建规则看不见它们——与 findings.md
        // ACL-03 是同一处结构性盲区。本条清单因此**不是**「全部 ACL 端点」的分母；
        // 真正的入网判据已由 RFC-317 T9b 换成运行时预言
        // （rfc099-acl-endpoints-matrix.test.ts 起真 app 读 allRouteMeta()）。
        // 补齐这里属 TP-01 的契约覆盖扫描器改造，另批处理。
        '/api/digital-employees/:id',
        // RFC-324 §7 —— 定时任务的一对 `/acl` 端点。它**不是** ACL 资源类型
        // （没有 visibility / builtin / owner×name 唯一域，不进配置包也不由 Intent
        // 创建），所以由 routes/scheduledTasks.ts 自己挂载、而不是走
        // mountAclEndpoints——正因为是字面量路径，`discoverRoutes()` 反而看得见它，
        // 于是它出现在这份「被发现的 /acl 端点」清单里。
        '/api/scheduled-tasks/:id',
      ]
        .flatMap((base) => [`GET ${base}/acl`, `PUT ${base}/acl`])
        .sort(),
    )
  })

  test('every non-literal route mount has a bespoke discovery rule', () => {
    // A guard that cannot see a route reports "all registered" — the failure
    // mode is silent completeness. Keep the set of blind spots explicit and
    // frozen; a new computed-path mount must either use a literal or teach
    // discoverRoutes() how to reconstruct it.
    // The two templated ACL mounts, now in registerRoute form. They stay blind
    // spots for the SCANNER (their path is computed), but they are no longer
    // blind spots for AUTHORIZATION: mountAclEndpoints registers their metadata
    // itself, so the startup coverage check sees them.
    const known = discoverNonLiteralMounts().filter((x) => x.startsWith('resourceAcl.ts:'))
    expect(known.length).toBe(2)
    expect(discoverNonLiteralMounts().sort()).toEqual(known.sort())
  })

  // RFC-310 PR-10 实测：删掉三条 `/api/code` 写路由后本地门禁全绿，CI 的
  // Playwright 腿红了三条——`e2e/` 既不在任何 package 的 tsconfig include 里，
  // `gate:local` 也不跑 Playwright，所以 e2e 打一条已删端点在本地是**不可见**的
  // （docs/dev-gotchas.md 早有此条，本轮仍复发一次）。这条守卫把它拉进本地门禁。
  //
  // 只认**明确打 daemon** 的调用（`${daemon.baseUrl}/api/...` / `${baseUrl}/api/...`）：
  // e2e 里还有打 system-mocks、Gitea、浏览器内相对路径的 fetch，它们与本平台的
  // 路由注册表无关，扫进来只会逼人往守卫里加豁免。路径中的 `${...}` 段按「任意
  // 单段」处理（ACL 端点是 `/api/${resource}/${id}/acl` 这种计算形态）。
  test('every daemon /api call an e2e spec makes still exists in the registry', () => {
    const e2eDir = resolve(import.meta.dir, '..', '..', '..', 'e2e')
    const specs = listTsFilesRecursive(e2eDir)
    // RFC-319 T21 —— 逐段比较 + method 的实现已抽到 `architecture/routeMatch.ts`。
    // 抽取的理由不是省代码：RFC-319 的运行期端点命中账本问的是**反方向**的问题
    //（哪些注册端点一次都没被打到）。两处判据一旦分叉，「账本说没覆盖」与
    //「守卫说覆盖了」可以同时为真，而没有任何东西会红。
    //
    // method 必须一并核对——RFC-310 PR-10 删的是 `PUT /api/code/matrix/:repoId`
    // 而 `GET` 同路径仍在，只比 path 的守卫会放行那三条 e2e（当时 CI 上红的形态）。
    const WILDCARD = CALL_WILDCARD
    const compiled = compilePatterns(ENDPOINTS.map((e) => ({ method: e.method, path: e.path })))
    const known = (method: string, called: readonly string[]): boolean =>
      callIsRegistered(compiled, method, called)

    /**
     * 调用动词：`page.request.put(` / `api.delete(` 之类在 URL 之前，或
     * `{ method: 'PUT' }` 在其后的 init 对象里。都找不到 ⇒ GET（fetch 缺省）。
     */
    const methodOf = (src: string, urlStart: number, urlEnd: number): string => {
      const before = src.slice(Math.max(0, urlStart - 60), urlStart)
      const verbCall =
        /\.(get|post|put|delete|patch)\s*\(\s*$|\.(get|post|put|delete|patch)\s*\(\s*`?$/i.exec(
          before,
        )
      if (verbCall) return (verbCall[1] ?? verbCall[2] ?? 'GET').toUpperCase()
      const after = src.slice(urlEnd, urlEnd + 160)
      const inInit = /\bmethod\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]/i.exec(after)
      if (inInit) return inInit[1]!.toUpperCase()
      return 'GET'
    }
    // RFC-319 B74 —— `EXEMPT_MOUNTS` 里的路径**按构造**进不了这份注册表：它们是
    // 「有意不作为 API 端点」的挂载（`src/routes/registry.ts` 的名单），没有声明、
    // 也就没有合同条目。于是 e2e 里一旦出现它们的 URL，这条守卫必然误报——而误报的
    // 修法只有两种：往注册表里塞一条与那份名单直接矛盾的假条目，或者把 spec 里的
    // 字面量拆开躲过正则。两种都是拿判据换绿。
    //
    // 实撞（2026-08-25）：RFC-319 的 CFG-40 用例断言 `/.well-known/mcp` 广告出来的
    // endpoint 等于 `${daemon.baseUrl}/api/mcp`——它**根本没有发起这个调用**，只是在
    // 核对广告值。而 `/api/mcp` 是 EXEMPT_MOUNTS 的一员（RFC-247 §4.1：它是管道，
    // 授权按 TOOL 逐个发生，不是带能力的端点）。守卫报了三条不存在的「打了已删端点」。
    //
    // 判据因此从名单本身取豁免，而不是再写一张手抄清单——那张清单会和名单分叉。
    const offenders: string[] = []
    let scannedCalls = 0
    for (const spec of specs) {
      const src = stripLineComments(readFileSync(spec, 'utf8'))
      for (const m of src.matchAll(/\$\{(?:daemon\.)?baseUrl\}(\/api\/[^'"`\s?]+)/g)) {
        scannedCalls += 1
        const raw = m[1]!
        const called = raw
          .replace(/\/+$/, '')
          .split('/')
          .map((seg) => (seg.includes('${') ? WILDCARD : seg))
        const method = methodOf(src, m.index!, m.index! + m[0].length)
        if (EXEMPT_MOUNTS.has(raw.replace(/\/+$/, ''))) continue
        if (!known(method, called)) offenders.push(`${basename(spec)}: ${method} ${raw}`)
      }
    }
    // 失败关闭：spec 目录挪走、后缀改名、`${baseUrl}` 换写法……任一发生都会让
    // 上面的循环空转，而空转的守卫是绿的。这两条下界把"扫了个寂寞"变成红。
    expect(specs.length).toBeGreaterThan(0)
    expect(scannedCalls).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })

  test('no duplicate registry entries (same method+path twice)', () => {
    const seen = new Map<string, number>()
    for (const e of ENDPOINTS) {
      const key = `${e.method} ${e.path}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `  ${k} (x${n})`)
    if (dups.length > 0) {
      throw new Error(`duplicate entries:\n${dups.join('\n')}`)
    }
  })
})
