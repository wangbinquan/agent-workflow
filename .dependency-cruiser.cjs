// RFC-054 W1-7 — dependency-cruiser configuration.
//
// LOCKS: cross-package import direction + runtime import cycles. Any PR that
// crosses the wrong seam or closes a new require-time cycle fails
// `bun run depcheck`.
//
// Run:  bun run depcheck            (the ONLY supported entry point)
//
// ─────────────────────────────────────────────────────────────────────────
// 为什么这个文件不再自己写 `tsConfig`（2026-08-03 架构审视 A1 / WP-0）
//
// 原配置写死 `tsConfig: { fileName: 'tsconfig.base.json' }`，而 base 里
// **没有** `paths` —— `@/*` 只定义在各 package 自己的 tsconfig。于是每一条
// `@/...` 写法的 import 都 couldNotResolve 被静默丢出依赖图：实测后端
// **3365 / 5384 = 62.5%** 的依赖边门禁根本看不见，`bun run depcheck` 长期
// 报 0 违规。把 tsconfig 换对后立刻暴露 19 条真实违规（18 个 runtime 环 +
// 1 条 services→routes）。更糟的是绕环最常用的 `await import('@/…')` 恰好
// 100% 落在这个盲区里——「工具 + 约定双保险」实际退化成了纯人肉约定。
//
// 两个 package 的 `@/*` 指向不同目录（各自的 `src/`），一份 tsconfig 无法
// 同时服务两者；`options.enhancedResolveOptions.alias` 又不被 schema 接受
// （报 `must NOT have additional properties`）。所以正解是**每个 package
// 各跑一次**，由 `scripts/depcheck.ts` 生成扁平化（无 `extends`，绝对
// `baseUrl`）的 per-package tsconfig 并经 DEPCRUISE_TSCONFIG 传进来。
//
// 这里刻意 **fail-closed**：拿不到该环境变量就抛错，而不是退回「解析不了
// 就当没有这条边」的静默失明——后者正是上面那个两年没人发现的形态。
// ─────────────────────────────────────────────────────────────────────────

const tsConfigFileName = process.env.DEPCRUISE_TSCONFIG
if (!tsConfigFileName) {
  throw new Error(
    'DEPCRUISE_TSCONFIG is not set. Run `bun run depcheck` — invoking depcruise\n' +
      'directly would resolve no `@/*` alias and silently drop ~62% of the\n' +
      'dependency graph, which is exactly the failure this gate now prevents.',
  )
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-production-to-system-mocks',
      severity: 'error',
      comment:
        'The unified system mock package is test-only. Production backend, ' +
        'frontend, and shared source graphs must never import it, including ' +
        'through a relative path that bypasses the workspace package name.',
      from: { path: '^packages/(backend|frontend|shared)/src/' },
      to: { path: '^packages/system-mocks/' },
    },
    {
      name: 'no-frontend-to-backend',
      severity: 'error',
      comment:
        'Frontend code must not import from the backend package directly. ' +
        'Share types / runtime helpers via @agent-workflow/shared instead.',
      from: { path: '^packages/frontend/src/' },
      to: { path: '^packages/backend/' },
    },
    {
      // @ledger KNOWN_VIOLATIONS —— 本规则有存量债记在 scripts/depcheck.ts。
      // 这是**机器标记**，由 RFC-317 T20 双向钉死：有标记必须有条目，有条目必须有标记。
      // 不用散文判定的原因见该守卫的注释（一句「已入账」和一句「不再有条目」在正则
      // 眼里长得一模一样）。
      name: 'no-services-to-routes',
      severity: 'error',
      comment:
        'Service code is the deeper layer and must not import from routes ' +
        '(which are HTTP transport adapters). Inverting this would create ' +
        'a cycle and tightly couple business logic to Hono.',
      from: { path: '^packages/backend/src/services/' },
      to: { path: '^packages/backend/src/routes/' },
    },
    {
      name: 'no-shared-to-app',
      severity: 'error',
      comment:
        '`packages/shared` is the bottom of the dep graph. It must not ' +
        'import from `packages/backend` or `packages/frontend` (which ' +
        'depend ON it).',
      from: { path: '^packages/shared/src/' },
      to: { path: '^packages/(backend|frontend)/' },
    },
    {
      // RFC-284 T2（2026-08-12 审计 N10 / A8-1）— routes 层禁止直查 db。
      // 「业务写路径必须过 service」此前在这条缝上是纯人肉约定，webhook 域
      // 整个 CRUD 已经用脚投票漂进了路由层。存量违例逐条记在
      // scripts/depcheck.ts → KNOWN_VIOLATIONS（棘轮只减不增）；type-only
      // 边放行——类型引用在 emit 后消失，不构成绕过 service 的数据通路。
      // @ledger KNOWN_VIOLATIONS —— 本规则有存量债记在 scripts/depcheck.ts。
      // 这是**机器标记**，由 RFC-317 T20 双向钉死：有标记必须有条目，有条目必须有标记。
      // 不用散文判定的原因见该守卫的注释（一句「已入账」和一句「不再有条目」在正则
      // 眼里长得一模一样）。
      name: 'no-routes-to-db',
      severity: 'error',
      comment:
        'Routes are HTTP transport adapters; persistence goes through services. ' +
        'A route importing @/db/* directly bypasses the service layer (ACL, ' +
        'OCC, audit). Existing debt is ledgered in scripts/depcheck.ts.',
      from: { path: '^packages/backend/src/routes/' },
      to: { path: '^packages/backend/src/db/', dependencyTypesNot: ['type-only'] },
    },
    {
      // RFC-317 T41（findings TP-03）— ws/ 与 mcp/ 同样是传输层，禁止直查 db。
      //
      // 为什么补这一条：`no-routes-to-db` 的 from 只写了 `routes/`，于是 ws/ 与 mcp/
      // **不被任何规则覆盖**（.dependency-cruiser.cjs 的 forbidden 全表都不匹配它们）。
      // 实测代价：`ws/registry.ts` 直接 import 了 6 张业务表跑 Drizzle select，
      // 还手写过一条 `SELECT status, access_revision FROM users`（另一个 context 的私表）
      // ——RFC-294 的 preflight AST 扫描器看不见它，因为 ws/ 在 MODULES_ROOT 之外，
      // 而一条 SQL 字符串根本不是 import 边。裸 SQL 已在 T41 改走 identity-access 的
      // public 端口；剩下的 6 张表边逐条入账，棘轮只减不增。
      // @ledger KNOWN_VIOLATIONS —— 本规则有存量债记在 scripts/depcheck.ts。
      // 这是**机器标记**，由 RFC-317 T20 双向钉死：有标记必须有条目，有条目必须有标记。
      // 不用散文判定的原因见该守卫的注释（一句「已入账」和一句「不再有条目」在正则
      // 眼里长得一模一样）。
      name: 'no-transport-to-db',
      severity: 'error',
      comment:
        'ws/ and mcp/ are transports, exactly like routes/. Reaching into @/db/ ' +
        'from a transport bypasses the service/module layer (ACL, OCC, audit) and ' +
        'is invisible to every import-based architecture guard once it degrades ' +
        'into a raw SQL string. Existing debt is ledgered in scripts/depcheck.ts.',
      from: { path: '^packages/backend/src/(ws|mcp)/' },
      to: { path: '^packages/backend/src/db/', dependencyTypesNot: ['type-only'] },
    },
    {
      // RFC-284 T2（审计 A8-4）— util 是叶子层，不得反向依赖上层。此前唯一
      // 防线是 no-circular（只有恰好成环才被看见）；非环形态的单向 util→上层
      // 依赖会静默通过。util/git.ts 族的存量反向边（惰性 import）逐条入账。
      // @ledger KNOWN_VIOLATIONS —— 本规则有存量债记在 scripts/depcheck.ts。
      // 这是**机器标记**，由 RFC-317 T20 双向钉死：有标记必须有条目，有条目必须有标记。
      // 不用散文判定的原因见该守卫的注释（一句「已入账」和一句「不再有条目」在正则
      // 眼里长得一模一样）。
      name: 'no-util-to-upper',
      severity: 'error',
      comment:
        'util/ is the leaf layer. A util module importing services/routes/db/' +
        'ws/mcp/auth/cli inverts the layering (util/git.ts grew 9 lazy imports ' +
        'this way and started copying code to avoid more). Ledgered in ' +
        'scripts/depcheck.ts.',
      from: { path: '^packages/backend/src/util/' },
      to: {
        path: '^packages/backend/src/(services|routes|db|ws|mcp|auth|cli)/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      // RFC-284 T2（审计 A8-9 / 决策 D22）— auth 下沉为底层：不得依赖 services。
      // T24 已落地（authLoginPolicy 迁入 auth/loginPolicy.ts），auth/ 现在对
      // services/ **零值边**，KNOWN_VIOLATIONS 里也不再有本规则的条目。
      // RFC-317 T20 勘误：此处原写「现存唯一反向值边…已入账，removeWhen = T24」，
      // 那句话在 T24 落地后就过期了——账本里一条都没有，而注释仍宣称债是有人管的。
      // 这类散文与账本的背离没有任何测试看得见，故新增 T20 元断言双向钉死。
      // auth→ws 的 revalidationHook 注册边不在本规则射程（规则只封 auth→services）。
      name: 'no-auth-to-services',
      severity: 'error',
      comment:
        'auth/ sits below services (60 service files import auth/actor). ' +
        'auth importing services closes the loop one edge at a time; policy ' +
        'logic that is authentication-domain belongs IN auth/.',
      from: { path: '^packages/backend/src/auth/' },
      to: { path: '^packages/backend/src/services/', dependencyTypesNot: ['type-only'] },
    },
    {
      // RFC-217 T1 (G1) — ban RUNTIME import cycles. The workgroup constants
      // cycle (`launch → task → scheduler → runner → rounds → launch`,
      // workgroupRounds pre-move header) was cut by extracting
      // services/workgroup/constants.ts; this rule keeps every future cycle
      // out. `viaOnly.dependencyTypesNot` skips cycles that only close over
      // `import type` edges — those vanish at emit and cannot produce the
      // RFC-079 "undefined top-level const under unlucky init order" class.
      //
      // NOTE (WP-0): the pre-existing cycles used to be excused here with a
      // `from.pathNot` allowlist. That is too coarse — excluding a FILE hides
      // every future cycle through it, and `scheduler.ts` / `task.ts` are
      // exactly the files new cycles keep growing through. The known cycles
      // now live in `scripts/depcheck.ts` → KNOWN_VIOLATIONS, matched
      // EXACTLY by (rule, from, to) and each annotated with why / removeWhen.
      // A known entry that stops firing fails the gate, so the list can only
      // shrink.
      // @ledger KNOWN_VIOLATIONS —— 本规则有存量债记在 scripts/depcheck.ts。
      // 这是**机器标记**，由 RFC-317 T20 双向钉死：有标记必须有条目，有条目必须有标记。
      // 不用散文判定的原因见该守卫的注释（一句「已入账」和一句「不再有条目」在正则
      // 眼里长得一模一样）。
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
  ],
  options: {
    // Tree-shake the dep graph so we don't analyze test scaffolding or
    // node_modules.
    doNotFollow: {
      path: ['node_modules', '\\.opencode'],
    },
    exclude: {
      path: [
        'node_modules',
        'dist',
        '\\.opencode',
        'packages/.*/tests/',
        'packages/.*/dist/',
        '\\.test\\.tsx?$',
      ],
    },
    tsPreCompilationDeps: true,
    // Per-package, generated by scripts/depcheck.ts (see header). NEVER point
    // this at tsconfig.base.json — that file has no `paths`, and the gate goes
    // blind to ~62% of the graph without failing.
    tsConfig: {
      fileName: tsConfigFileName,
    },
    enhancedResolveOptions: {
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
    progress: { type: 'none' },
  },
}
