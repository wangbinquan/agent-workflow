// RFC-329 —— 「每一条路由都知道自己有没有 MCP 工具」的全域守卫（proposal §2.4 / AC-11…AC-13）。
//
// 为什么是全域而不是某个域
// ------------------------
// RFC-326 建过同款守卫，但只扫 `/api/reviews*`。于是 2026-08-26 的审计一口气挖出：
// 一条**从未注册**的路由被 MCP 表当成能力宣传了不知多久（`GET /api/cached-repos/:id`，
// 恒 404，`describe_resource` 还照表说支持）；三个人工门整块没有工具；六个新产品域
// 从来没进过任何人的视野——因为它们的权限点不在 `MATRIX_RESOURCES` 里，
// `MCP_RESOURCE_KINDS` 的漂移锁（rfc247-mcp-server.test.ts）根本够不着它们。
//
// 共同的失败形态是**没有任何机器在看**。所以这条守卫的判定面是「`allRouteMeta()` 返回的
// 每一条」，没有前缀过滤，分母也不写成数字（路由一增一减就该由账本说话，不是改断言）。
//
// 四向判定
// --------
//   uncovered       路由有、工具无、账本也没记      → 补工具，或写一行有署名的理由
//   staleExemptions 账本记着、但工具已覆盖 / 路由已不在 → 清账本
//   unroutedTools   工具打向的路径不在路由表        → A1 那类死路径
//   权限不一致       工具与其目标路由要的权限对不上   → 工具在 tools/list 里出现却每次被拒
//
// 关于 fixture（设计门 P1-3）
// --------------------------
// 工具路径是**真调 handler** 推出来的，不是读源码猜的。但调用需要按工具定制响应：
// RFC-326 的 recorder 对每次 dispatch 固定返回 `{}`，于是 `list_repo_refs` 的第一跳拿到空
// items、找不到行就抛错，**第二跳永远不会发生**，守卫会把 `/api/repos/refs` 误报成 uncovered。
// `TOOL_FIXTURES` 就是为这件事存在的。

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READ_POINTS, type Permission } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { createInMemoryDb } from '@/db/client'
import { ALL_TOOLS, MCP_RESOURCE_KINDS, type McpToolContext } from '@/mcp/tools'
import { allRouteMeta } from '@/routes/registry'
import { createApp } from '@/server'
import {
  EXEMPT_REASONS,
  MCP_SURFACE_EXEMPTION_LEAVES,
  exemptionLeaves,
} from './rfc329McpSurfaceLedger'

const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')

/** `GET /api/tasks/:taskId/alerts/:alertId` → `GET /api/tasks/:id/alerts/:id`. */
function canon(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':id')}`
}

/**
 * The framework's own declaration table, from a REAL app boot.
 *
 * `secretBox` is NOT optional here. Without it `mountApiRoutes` skips a whole
 * batch of conditionally-mounted routes, and the guard silently measures a
 * smaller surface than the daemon actually serves — the first version of the
 * RFC-329 audit read 440 routes instead of 470 for exactly this reason.
 */
function mountedRoutes(): Array<{ key: string; permissions: ReadonlyArray<Permission> }> {
  const home = mkdtempSync(join(tmpdir(), 'aw-rfc329-guard-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ $schema_version: 1 }), 'utf-8')
  createApp({
    token: 'rfc329-guard',
    configPath: join(home, 'config.json'),
    opencodeVersion: '1.15.5',
    dbVersion: 28,
    db: createInMemoryDb(MIGRATIONS),
    secretBox: createSecretBoxFromKey(randomBytes(32)),
  })
  return allRouteMeta().map((meta) => ({
    key: canon(meta.method, meta.path),
    permissions: meta.permissions as ReadonlyArray<Permission>,
  }))
}

/**
 * What a given tool's dispatches should answer, so its handler gets far enough
 * to make every call it would make in production. Default is `{}`.
 */
const TOOL_FIXTURES: Readonly<Record<string, (path: string) => unknown>> = {
  // Two hops: hop 1 must return a row whose id matches the argument below,
  // or the tool refuses before hop 2 (which is the correct behaviour, and also
  // what makes a fixed `{}` fixture wrong for this tool).
  list_repo_refs: (path) =>
    path === '/api/cached-repos' ? { items: [{ id: 'FIXTURE_ID', localPath: '/m/x' }] } : {},
  // Settles on the first poll instead of blocking for 240s.
  watch_task: () => ({ status: 'done' }),
}

/**
 * One placeholder for every id-shaped argument, chosen so it cannot collide with
 * a real path segment. The dispatch recorder turns it back into `:id` — without
 * that step a tool's `/api/reviews/PH/versions/PH` never matches the route
 * table's `/api/reviews/:id/versions/:id`, and the guard reports every covered
 * route as uncovered.
 */
const PH = 'RFC329PH'

const ARGS: Readonly<Record<string, unknown>> = {
  id: PH,
  nodeRunId: PH,
  docVersionId: PH,
  commentId: PH,
  taskId: PH,
  workflowId: PH,
  nodeId: PH,
  entryId: PH,
  versionId: PH,
  alertId: PH,
  assignmentId: PH,
  batchId: PH,
  rowId: PH,
  cachedRepoId: 'FIXTURE_ID',
  commentText: 'x',
  selection: 'accepted',
  decision: 'approved',
  reviewIteration: 0,
  confirm: 'x',
  optionId: 'x',
  name: 'x',
  text: 'x',
  body: {},
  answers: [],
}

/** Only the converged tools need the kind × method sweep. */
const CONVERGED = new Set(['resource_read', 'resource_write', 'describe_resource'])

async function dispatchedByTool(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const aborted = new AbortController()
  aborted.abort()
  for (const tool of ALL_TOOLS) {
    const variants: Array<Record<string, unknown>> = [{}]
    if (CONVERGED.has(tool.name)) {
      for (const kind of MCP_RESOURCE_KINDS) {
        for (const method of ['list', 'get', 'facets', 'create', 'update', 'delete']) {
          variants.push({ kind, method })
        }
      }
    }
    const respond = TOOL_FIXTURES[tool.name] ?? (() => ({}))
    const calls = new Set<string>()
    for (const variant of variants) {
      const ctx: McpToolContext = {
        actor: {
          user: { id: 'u', role: 'admin' },
          permissions: new Set<Permission>(),
        } as unknown as McpToolContext['actor'],
        dispatch: async (req) => {
          const normalised = req.path.split('FIXTURE_ID').join(':id').split(PH).join(':id')
          calls.add(canon(req.method, normalised))
          return { status: 200, body: respond(req.path) }
        },
        progress: async () => {},
        signal: aborted.signal,
      }
      try {
        await Promise.race([
          tool.handler({ ...ARGS, ...variant }, ctx),
          new Promise<void>((resolve) => setTimeout(resolve, 25)),
        ])
      } catch {
        // A tool that refuses these placeholder arguments contributes nothing.
      }
    }
    out.set(tool.name, calls)
  }
  return out
}

/** Pure comparison — shared by the guard and its negative fixtures. */
export function surfaceDrift(
  routes: ReadonlyArray<string>,
  toolPaths: ReadonlyArray<string>,
  exempt: ReadonlyArray<string>,
): { uncovered: string[]; staleExemptions: string[]; unroutedTools: string[] } {
  const routeSet = new Set(routes)
  const toolSet = new Set(toolPaths)
  const exemptSet = new Set(exempt)
  return {
    uncovered: routes.filter((r) => !toolSet.has(r) && !exemptSet.has(r)).sort(),
    staleExemptions: exempt.filter((r) => toolSet.has(r) || !routeSet.has(r)).sort(),
    unroutedTools: toolPaths.filter((p) => !routeSet.has(p)).sort(),
  }
}

/**
 * Which non-read permissions a tool must declare.
 *
 * Direction matters and the first draft of this RFC got it backwards. Tool
 * permissions decide whether the tool is LISTED (`toolsFor`); route permissions
 * decide whether the call SUCCEEDS. So "tool ⊆ route" is not safe: a tool that
 * under-declares shows up in `tools/list` for a token that will be refused on
 * every call. Equality (after removing the read points every token carries) is
 * the only judgement that keeps the two channels honest.
 */
export function permissionDrift(
  toolPermissions: ReadonlyArray<Permission>,
  routePermissions: ReadonlyArray<Permission>,
): { missing: Permission[]; extra: Permission[] } {
  const reads = new Set<Permission>(READ_POINTS)
  const tool = new Set(toolPermissions.filter((p) => !reads.has(p)))
  const route = new Set(routePermissions.filter((p) => !reads.has(p)))
  return {
    missing: [...route].filter((p) => !tool.has(p)).sort(),
    extra: [...tool].filter((p) => !route.has(p)).sort(),
  }
}

/**
 * Tools whose permission requirement depends on their ARGUMENTS, so a single
 * declared array cannot describe them. `resource_write` deliberately declares
 * none and lets the route decide per `(kind, method)` — see its comment.
 */
const PARAMETERISED_TOOLS = new Set(['resource_read', 'resource_write', 'describe_resource'])

describe('RFC-329 AC-11 — every mounted route is either covered by a tool or on the ledger', () => {
  test('corpus: both sides are non-trivial (an empty side would pass everything)', async () => {
    const routes = mountedRoutes()
    const byTool = await dispatchedByTool()
    expect(routes.length).toBeGreaterThan(400)
    expect(ALL_TOOLS.length).toBeGreaterThan(25)
    expect([...byTool.values()].flatMap((s) => [...s]).length).toBeGreaterThan(50)
  })

  test('no uncovered route, no stale exemption, no tool pointing at a missing route', async () => {
    const routes = mountedRoutes().map((r) => r.key)
    const byTool = await dispatchedByTool()
    const toolPaths = [...new Set([...byTool.values()].flatMap((s) => [...s]))]
    const drift = surfaceDrift(routes, toolPaths, exemptionLeaves())
    expect(
      drift,
      'uncovered = 一条路由既没有工具也没进账本：补工具，或去 rfc329McpSurfaceLedger.ts 写一行有署名的理由。\n' +
        'staleExemptions = 账本记的条目已经有工具了，或那条路由已经不存在：把它从账本删掉（账本只许缩）。\n' +
        'unroutedTools = 某个工具打向一条不存在的路由——这正是 RFC-329 A1 的形态，恒 404 而无人发现。',
    ).toEqual({ uncovered: [], staleExemptions: [], unroutedTools: [] })
  })

  test('a tool declares exactly the non-read permissions its target routes require', async () => {
    const routes = new Map(mountedRoutes().map((r) => [r.key, r.permissions]))
    const byTool = await dispatchedByTool()
    const offenders: string[] = []
    for (const tool of ALL_TOOLS) {
      if (PARAMETERISED_TOOLS.has(tool.name)) continue
      const paths = [...(byTool.get(tool.name) ?? [])]
      if (paths.length === 0) continue
      const required = [...new Set(paths.flatMap((p) => [...(routes.get(p) ?? [])]))]
      const { missing, extra } = permissionDrift(tool.permissions, required)
      if (missing.length > 0 || extra.length > 0) {
        offenders.push(
          `${tool.name}: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
        )
      }
    }
    expect(
      offenders.sort(),
      'missing = 工具声明得比路由少：它会出现在 tools/list 里，然后每次调用被路由拒。\n' +
        'extra = 工具声明得比路由多：明明够权限的令牌看不到这个工具。',
    ).toEqual([])
  })
})

describe('RFC-329 AC-12 — the ledger is a ledger, not a wildcard', () => {
  test('every leaf is an exact `METHOD /path` template, never a hand-rolled prefix', () => {
    expect(exemptionLeaves().filter((leaf) => !/^[A-Z]+ \/\S*$/.test(leaf))).toEqual([])
    // Bulk syntax of my own invention (`/**`, a trailing `...`) is what this
    // guards against. Hono's own single-segment wildcard — `GET
    // /api/worktree-files/:id/*` — is the ROUTE TEMPLATE, not a prefix rule, and
    // whether it belongs on the ledger is settled by `staleExemptions`, which
    // requires every leaf to be a route that is actually mounted today.
    expect(
      exemptionLeaves().filter((leaf) => leaf.includes('**') || leaf.endsWith('...')),
    ).toEqual([])
  })

  test('no leaf appears twice', () => {
    const counts = new Map<string, number>()
    for (const entry of MCP_SURFACE_EXEMPTION_LEAVES) {
      counts.set(entry.leaf, (counts.get(entry.leaf) ?? 0) + 1)
    }
    expect([...counts].filter(([, n]) => n > 1)).toEqual([])
  })

  test('every group a leaf claims has a real reason written down', () => {
    const used = [...new Set(MCP_SURFACE_EXEMPTION_LEAVES.map((entry) => entry.group))]
    const thin = used.filter((group) => (EXEMPT_REASONS[group] ?? '').trim().length < 12)
    expect(thin, '一个没有理由的分组等于一张空白许可证').toEqual([])
  })

  test('no reason is left behind by the leaves it used to explain', () => {
    const used = new Set(MCP_SURFACE_EXEMPTION_LEAVES.map((entry) => entry.group))
    // A reason whose last leaf was removed is a stale entry: it reads like the
    // exemption is still in force when nothing is exempt under it any more.
    expect(Object.keys(EXEMPT_REASONS).filter((group) => !used.has(group)).sort()).toEqual([])
  })

  test('the count the high-water ledger pins is the LEAF count, not a group count', () => {
    // architecture/ledger-baselines.json pins MCP_SURFACE_EXEMPTION_LEAVES.
    // If this ever became a grouped structure again, adding a leaf to an
    // existing group would leave the baseline untouched — the same hole a
    // prefix ledger has (proposal D9 / 设计门 P1-4).
    expect(exemptionLeaves().length).toBe(MCP_SURFACE_EXEMPTION_LEAVES.length)
    expect(exemptionLeaves().length).toBeGreaterThan(100)
  })
})

describe('RFC-329 AC-13 — the comparison itself is proven to fail', () => {
  test('negative fixture: an uncovered route, a stale exemption and an unrouted tool', () => {
    const drift = surfaceDrift(
      ['GET /api/a', 'GET /api/b', 'GET /api/c'],
      ['GET /api/a', 'POST /api/ghost'],
      ['GET /api/c', 'GET /api/gone'],
    )
    expect(drift.uncovered).toEqual(['GET /api/b'])
    expect(drift.staleExemptions).toEqual(['GET /api/gone'])
    expect(drift.unroutedTools).toEqual(['POST /api/ghost'])
  })

  test('negative fixture: a leaf that is also covered by a tool is a stale exemption', () => {
    // This is the mutation "give an exempt route a tool but forget the ledger".
    const drift = surfaceDrift(['GET /api/a'], ['GET /api/a'], ['GET /api/a'])
    expect(drift.staleExemptions).toEqual(['GET /api/a'])
  })

  test('negative fixture: permission drift is caught in BOTH directions', () => {
    expect(permissionDrift([], ['tasks:execute'])).toEqual({
      missing: ['tasks:execute'],
      extra: [],
    })
    expect(permissionDrift(['tasks:execute'], [])).toEqual({
      missing: [],
      extra: ['tasks:execute'],
    })
    // Read points are carried by every token, so they are not drift.
    expect(permissionDrift([], ['tasks:read'])).toEqual({ missing: [], extra: [] })
  })
})
