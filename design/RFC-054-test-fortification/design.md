# RFC-054 — 测试防护加固（技术设计）

> 配套 [proposal.md](./proposal.md)。引用以 `main@HEAD` 为准；行号在
> 重构过程中会变，文中只引"模块名 + 函数名"作锚点。

## 全景图

```
┌─────────────────── Wave 1（~11 人日，最高 ROI）───────────────────┐
│                                                                    │
│  W1-1 真实 opencode 录制 fixture 守门 ◄── 解 B-1（协议变更暴雷）   │
│  W1-2 API 契约总册（all routes × happy/4xx/5xx × Zod） ◄── B-15    │
│  W1-3 崩溃恢复 e2e（SIGKILL → resume → 完成）       ◄── B-4 核心   │
│  W1-4 task 7 状态 e2e（pending..exhausted 每条达路径） ◄── B-4 续  │
│  W1-5 跨用户权限 e2e（A 拿不到 B）                  ◄── B-14 核心  │
│  W1-6 滚动升级测试（旧 home → 新 binary）           ◄── B-7        │
│  W1-7 dep-cruiser + 路由禁 `as T` 守门             ◄── B-15 续    │
│  W1-8 e2e shard + webkit 矩阵                       ◄── 基础设施   │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  Wave 1 全合并解锁 Wave 2
┌─────────────────── Wave 2（~6 周，可重构）────────────────────────┐
│  W2-1 真实 opencode 完整集成（matrix pin/latest）  ◄── B-1 全解    │
│  W2-2 WS broadcast 黄金 + SQLite fuzz             ◄── B-3 + B-11   │
│  W2-3 xyflow 编辑器交互 e2e                        ◄── B-2         │
│  W2-4 多用户协作 e2e                                ◄── B-3 续     │
│  W2-5 visual regression × 10 快照                  ◄── B-8         │
│  W2-6 axe-core 注入                                ◄── B-9         │
│  W2-7 import/export 真文件                         ◄── B-10 part1  │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  Wave 2 全合并解锁 Wave 3
┌─────────────────── Wave 3（~6-12 周，可扩展）─────────────────────┐
│  W3-1 混沌注入（disk-full / kill / rm-worktree）   ◄── 韧性        │
│  W3-2 perf baseline + PR diff                       ◄── B-5         │
│  W3-3 config / workflow schema 兼容矩阵            ◄── B-7 + B-12   │
│  W3-4 真实 git 协议 e2e（gitea container）         ◄── B-10 part2   │
│  W3-5 安全 fuzz                                    ◄── B-14 续     │
└────────────────────────────────────────────────────────────────────┘
```

**波间硬序**：前波全合并 + STATE.md / plan.md 标 Done 才解锁下波第一个
PR。**波内可并行**评审。

---

## 防护金字塔（每层职责）

把每类测试明确归位，避免重复造轮子。

| 层                      | 已有                                            | 新增（本 RFC）                         | 工具                          |
| ----------------------- | ----------------------------------------------- | -------------------------------------- | ----------------------------- |
| L0 静态                 | tsc / ESLint / Prettier                         | dep-cruiser、knip、`as T` grep 守门    | W1-7                          |
| L1 纯函数单测           | 强                                              | —                                      | bun:test / vitest             |
| L2 服务集成             | 强（runner / scheduler / lifecycle invariants） | runner 故障注入扩展                    | bun:test + in-memory SQLite   |
| L3 API/WS 契约          | 部分                                            | **契约总册**（W1-2）、WS 黄金（W2-2）  | bun:test                      |
| L4 Playwright e2e       | 6 spec                                          | 主线 7-12 + 矩阵 webkit + shard        | Playwright                    |
| L5 真实 opencode        | **无**                                          | **录制守门**（W1-1）+ 完整集成（W2-1） | bun:test + recording fixture  |
| L6 多用户 / 并发 / 混沌 | 部分（lifecycle-property）                      | WS 黄金、双 user e2e、混沌注入         | Playwright + fast-check       |
| L7 性能 / 容量          | `perf:sweep` 脚本                               | baseline + PR diff                     | bun:bench + JSON baseline     |
| L8 视觉回归             | **无**                                          | 关键页面 × 10 快照                     | Playwright `toHaveScreenshot` |
| L9 a11y                 | **无**                                          | axe-core 注入 + 键盘流程               | @axe-core/playwright          |
| L10 升级 / 兼容         | migration 单点                                  | 滚动升级 + config / schema 矩阵        | bun:test + 历史 fixtures      |

---

## Wave 1 详细设计

### W1-1 真实 opencode 录制 fixture 守门

**问题**：所有现存 e2e 用 `e2e/fixtures/stub-opencode*.sh` 替身。1.14.51
PWD bug（commit `d7059d7`）是被用户报告的——CI 全绿走不到。

**方案**：录制 + 喂解析器，而不是真跑 opencode（真跑放 W2-1）。

接口契约：

```ts
// tests/fixtures/opencode-recordings/<version>.ndjson
// 每行一个 JSON 对象，格式与 opencode --format json 一致：
// { type: 'session.created', sessionId: '...' }
// { type: 'message.created', ... }
// { type: 'message.part.created', ... }
// ...
// { type: 'envelope', body: '<workflow-output>...</workflow-output>' }
// { type: 'exit', code: 0 }

// 录制头部 magic 行：
// {"__recording__":{"opencodeVersion":"1.14.51","capturedAt":"2026-05-21","agentName":"...","seed":42}}
```

新单测 `packages/backend/tests/opencode-recording-parser.test.ts`：

```ts
// 载入 recording → 喂 runner 的协议解析器 → 断言：
//   - sessionId 落到 node_run.opencodeSessionId
//   - 所有 message.part 入 node_run_events
//   - envelope 解析后 port=answer 入 node_run_outputs
//   - exit code 0 → status='done'；非 0 → 'failed'
//   - 期望产出与 recording 的 metadata 一致
```

**录制方法**：写一个 `scripts/record-opencode.ts`，跑真 opencode（用户
本地）+ tee 到 fixture 文件。该脚本不入 CI，仅维护时跑。

**漂移防护**：commit hook 拒绝 recording 文件 git diff > 0 行（除非
commit message 含 `[recording-refresh]`）。

### W1-2 API 契约总册

**问题**：路由 happy-path 单测各路由独立；**契约一致性**只有人脑维护。

**方案**：单一文件枚举全 endpoint × Zod schema，CI 强制。

```ts
// packages/backend/tests/api-contract.test.ts
const ENDPOINTS: ApiEndpointSpec[] = [
  {
    method: 'POST',
    path: '/api/tasks',
    auth: 'required',
    request: StartTaskRequestSchema,
    response: {
      201: StartTaskResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      409: ErrorResponseSchema, // RFC-053 lifecycle CAS
    },
    happyPath: () => ({ workflowId: ..., name: 'x', inputs: {}, repoPath: ..., baseBranch: 'main' }),
    invalidRequests: [
      { fixture: { /* missing name */ }, expectStatus: 400 },
      { fixture: { /* unknown workflowId */ }, expectStatus: 404 },
    ],
  },
  // ...全部 ~50 个 route
]

describe('API contract', () => {
  test.each(ENDPOINTS)('$method $path matches schema', async (ep) => {
    // happy: 发请求 → 断言 status + body 通过 response[201/200] Zod
    // each invalidRequest: 断言 status + body 通过 ErrorResponseSchema
  })
})
```

**grep 守卫**：新文件 `packages/backend/tests/api-contract-coverage.test.ts`
扫 `src/routes/*.ts` 抽取所有 `app.get/.post/...` 调用点，断言每个 path
在 `ENDPOINTS` 表里出现 ≥ 1 次。漏写 → CI 红。

### W1-3 崩溃恢复 e2e

**问题**：`resume-task-idempotent.test.ts` 在 service 层，没有"真 SIGKILL
daemon child 进程 → 重启 → UI 看 interrupted → click resume"的完整链。

**方案**：复用 `e2e/harness.ts` 的 `startDaemon`，spec 内拿到 child
handle 直接 SIGKILL。

```ts
// e2e/crash-recovery.spec.ts
test('SIGKILL daemon mid-task → restart → resume → done', async ({ page }) => {
  let daemon = await startDaemon()
  // ... 启 task，等它进 running
  const taskId = await launchTask(daemon, page, ...)
  await waitForStatus(daemon, taskId, 'running', { timeout: 5000 })

  // 真 SIGKILL — 不走 graceful shutdown
  daemon.killChild('SIGKILL')
  await daemon.waitForExit()

  // 重启同 home
  daemon = await startDaemon({ home: daemon.home })
  await primeAuthLocalStorage(page, daemon)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)

  // 应自动 detect interrupted（lifecycle invariants U1 命中 + WS 推）
  await expect(page.locator('.status-chip', { hasText: /interrupted/i })).toBeVisible({ timeout: 15_000 })

  // Click resume
  await page.getByRole('button', { name: /resume/i }).click()
  // 节点回滚到 pre_snapshot（git stash apply）+ 重新 running
  await expect(page.locator('.status-chip', { hasText: /^done$/i })).toBeVisible({ timeout: 30_000 })
})
```

**harness 改动**：`startDaemon({ home? })` 加可选 home（复用同一目录）；
`killChild(sig)` 暴露 child handle。

### W1-4 task 全状态 e2e

7 个 status × 1 条路径：

| status        | 触达方式                                                           |
| ------------- | ------------------------------------------------------------------ |
| `pending`     | 启 task，配大 maxConcurrentNodes=0 让它无法 dispatch；断言 pending |
| `running`     | happy path 中已自然经过                                            |
| `done`        | happy path 终态                                                    |
| `failed`      | stub opencode 返 exit 1                                            |
| `canceled`    | 启 task 后立刻 cancel；断言 status                                 |
| `interrupted` | W1-3 复用                                                          |
| `exhausted`   | wrapper-loop max_iterations=2，循环条件永远满足                    |

每个 case 一个 `test()`，断言 status chip + WS 收到对应事件 + DB
（通过 API 拉）值一致。

### W1-5 跨用户权限 e2e

```ts
// e2e/auth-isolation.spec.ts
test('user A cannot access user B resources', async ({ browser }) => {
  const daemon = await startDaemon()
  // 通过 admin CLI 创建两个 user
  await execAdmin(daemon, 'users add alice admin')
  await execAdmin(daemon, 'users add bob developer')

  const aCtx = await browser.newContext()
  const bCtx = await browser.newContext()
  await loginAs(aCtx, daemon, 'alice', '...')
  await loginAs(bCtx, daemon, 'bob', '...')

  // Bob 启 task
  const bTask = await bCtx.evaluate(() => fetch('/api/tasks', ...))

  // Alice 用 session token 拿 task → 403
  const aResp = await aCtx.evaluate((tid) => fetch(`/api/tasks/${tid}`), bTask.id)
  expect(aResp.status).toBe(403)

  // Alice 用 session token 拿 worktree-files → 403
  // Alice 用 stale token 拿 anything → 401
})
```

### W1-6 滚动升级测试

```ts
// packages/backend/tests/upgrade-rolling.test.ts
// Fixtures 在 tests/fixtures/old-homes/{m0001,m0014,m0020}/
//   - config.json
//   - data.db（SQLite，停在该 migration 状态）
//   - agents/, skills/ 目录
//   - worktrees/（如有）

for (const tag of ['m0001', 'm0014', 'm0020']) {
  test(`rolling upgrade from ${tag} reaches m0028 and runs a task`, async () => {
    const home = await copyFixtureToTmpDir(`old-homes/${tag}`)
    const daemon = await startDaemonInProcess({ home })
    // daemon 启动时自动跑 migrations 0001 → 0028
    expect(daemon.dbVersion).toBe(28)

    // 跑一个 toy workflow（agent 用 mock-opencode）
    const taskId = await startToyTask(daemon)
    await waitForTerminal(daemon, taskId)
    expect(taskId.status).toBe('done')
  })
}
```

**fixtures 来源**：从 main 历史 commit 检出对应版本的 daemon，跑一遍生成
fixture，然后 freeze 到 `tests/fixtures/old-homes/`。

### W1-7 dep-cruiser + 路由禁 `as T`

```js
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    {
      name: 'no-frontend-to-backend',
      from: { path: 'packages/frontend/' },
      to: { path: 'packages/backend/' },
    },
    {
      name: 'no-services-to-routes',
      from: { path: 'packages/backend/src/services/' },
      to: { path: 'packages/backend/src/routes/' },
    },
    {
      name: 'no-shared-to-app',
      from: { path: 'packages/shared/' },
      to: { path: 'packages/(backend|frontend)/' },
    },
  ],
}
```

路由 `as T` 守门：

```ts
// packages/backend/tests/routes-no-cast.test.ts
test('routes must validate via Zod, no `as T` shortcut', async () => {
  const files = await glob('src/routes/*.ts')
  for (const f of files) {
    const src = await readFile(f, 'utf-8')
    // 允许 `as const` / `as Hono`；禁 `as MyType` / `as RequestBody`
    const matches = src.match(/\bas\s+[A-Z][A-Za-z0-9]+(?!\s*const\b)/g) ?? []
    expect.soft(matches, `${f} 含禁用 cast: ${matches.join(', ')}`).toEqual([])
  }
})
```

### W1-8 e2e shard + webkit

```ts
// playwright.config.ts
projects: [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
],
fullyParallel: true,
workers: 4,
```

CI 改成：

```yaml
e2e:
  strategy:
    matrix:
      shard: [1/4, 2/4, 3/4, 4/4]
      project: [chromium, webkit]
  run: bun run e2e --shard=${{ matrix.shard }} --project=${{ matrix.project }}
```

---

## Wave 2 详细设计

### W2-1 真实 opencode 完整集成

新 workflow `.github/workflows/integration-opencode.yml`：

```yaml
on:
  schedule: [{ cron: '0 4 * * *' }] # 每天 04:00 UTC
  pull_request:
    paths:
      - 'packages/backend/src/services/runner.ts'
      - 'packages/backend/src/services/scheduler.ts'
      - 'packages/backend/src/services/protocol.ts'
      - 'packages/backend/src/opencode-plugin/**'

jobs:
  integration:
    strategy:
      matrix:
        opencode: ['1.14.51', 'latest'] # pin + latest
    steps:
      - uses: actions/checkout@v5
      - run: bun install -g opencode-ai@${{ matrix.opencode }}
      - run: bun test --filter '@slow @opencode'
```

≥ 5 个端到端 case：multi-process / OPENCODE_CONFIG_CONTENT 优先级 /
task 工具子代理 / readonly:true|false 写入 / errors port。

### W2-2 WS broadcast 黄金 + SQLite fuzz

```ts
// packages/backend/tests/ws-broadcast-golden.test.ts
test('two WS clients converge to identical state after random ops', async () => {
  const { daemon, app } = await buildHarness()
  const ws1 = new WebSocket(`${daemon.baseUrl}/ws/tasks`)
  const ws2 = new WebSocket(`${daemon.baseUrl}/ws/tasks`)
  const state1 = collectInto({ tasks: new Map() })
  const state2 = collectInto({ tasks: new Map() })
  ws1.on('message', applyTo(state1))
  ws2.on('message', applyTo(state2))

  // Drive 100 random ops via REST
  for (let i = 0; i < 100; i++) {
    await randomOp(daemon /* startTask | approve | iterate | cancel | retry */)
  }

  // Drain WS
  await waitForQuiescence([ws1, ws2], 500)
  expect(state1).toEqual(state2)
})

// packages/backend/tests/sqlite-concurrency-fuzz.test.ts (fast-check)
test.prop([fc.array(opArbitrary, { minLength: 50, maxLength: 200 })])(
  'any random op sequence preserves lifecycle invariants',
  async (ops) => {
    const { db } = buildHarness()
    for (const op of ops) await applyOp(db, op)
    const invariants = await runLifecycleInvariants({ scope: { all: true } }, db)
    expect(invariants.filter((i) => i.severity === 'error')).toEqual([])
  },
)
```

### W2-3 xyflow 编辑器交互 e2e

Playwright 真实拖拽：

```ts
// e2e/workflow-editor.spec.ts
test('drag agent from sidebar onto canvas creates node + edge wiring', async ({ page }) => {
  // ...
  const agentChip = page.locator('[data-testid="sidebar-agent-chip"][data-agent="my-agent"]')
  const canvas = page.locator('.react-flow__pane')
  await agentChip.dragTo(canvas, { targetPosition: { x: 400, y: 200 } })

  // 断言 xyflow state + workflow definition
  await expect(page.locator('.canvas-node--agent[data-name="my-agent"]')).toBeVisible()
  const def = await page.evaluate(() => /* 从 store 拉 */)
  expect(def.nodes).toContainEqual(expect.objectContaining({ agentName: 'my-agent' }))
})
```

涵盖：拖创建 / 连边 / 删除 / Ctrl+C/V / Shift 多选 / 拖进 wrapper / 拖
出 wrapper / Ctrl+Z undo。

### W2-4 多用户协作 e2e

```ts
// e2e/collab-multi-user.spec.ts
test('two users editing same workflow see each other live', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()

  await loginAs(pageA, 'alice'); await pageA.goto(workflowUrl)
  await loginAs(pageB, 'bob');   await pageB.goto(workflowUrl)

  // A 加节点 → B 必须在 < 2s 看到
  await pageA.dragTo(...)
  await expect(pageB.locator('.canvas-node--agent[data-name=newone]')).toBeVisible({ timeout: 2000 })

  // 同时编辑同节点 prompt → 出冲突 dialog
  // ...
})
```

### W2-5 visual regression

```ts
// e2e/visual-regression.spec.ts
const PAGES = [
  '/agents', '/workflows/<id>', '/tasks/<id>',
  '/clarify/<id>', '/reviews/<id>',
  /* ... 10 个 */
]
for (const path of PAGES) {
  test(`visual: ${path}`, async ({ page }) => {
    await page.goto(daemon.baseUrl + path.replace('<id>', fixtures[...]))
    // 等所有 lazy 资源
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.002 })
  })
}
```

只在 ubuntu 跑 baseline；macOS 字体差异会噪声。

### W2-6 axe-core 注入

主线 spec 末尾：

```ts
import AxeBuilder from '@axe-core/playwright'

test.afterEach(async ({ page }) => {
  const results = await new AxeBuilder({ page }).analyze()
  const critical = results.violations.filter((v) => ['critical', 'serious'].includes(v.impact!))
  expect(critical).toEqual([])
})
```

独立键盘流程 spec：`e2e/keyboard-flows.spec.ts` 锁 Dialog focus trap、
Select 键盘可达、Tab 顺序合理。

### W2-7 import/export 真文件

`e2e/import-export.spec.ts` 跑：YAML round-trip / agent.md 导入 +
冲突 dialog / skill.zip 导入 + 写到 `~/.agent-workflow/skills/`。

---

## Wave 3 详细设计

### W3-1 混沌注入

```ts
// packages/backend/tests/chaos-disk-full.test.ts
test('disk fills during envelope write → task fails cleanly', async () => {
  const home = await mkdtempInLowQuotaFs(1024 * 1024) // 1MB quota
  // ... 启 daemon，跑产 envelope > 1MB 的 task
  // 断言：DB 不破、task 落 failed、有清晰 error log
})

// packages/backend/tests/chaos-external-rm-worktree.test.ts
// 启 task → 进 running → rm -rf worktree → 断言 task 落 failed + log

// packages/backend/tests/chaos-sqlite-wal-truncate.test.ts
// 启 daemon → 跑一会 → 暴力 truncate WAL → 断言 daemon 自愈或落 fatal
```

### W3-2 perf baseline + PR diff

```ts
// tests/perf/baseline.json
{
  "version": "<commit-sha>",
  "workloads": {
    "500-node-dag-validation": { "p50": 45, "p95": 80, "p99": 120 },
    "10mb-envelope-parse":     { "p50": 12, "p95": 25, "p99": 40 },
    "100-concurrent-tasks":    { "p50": 850, "p95": 2100, "p99": 4500 },
    "10k-events-archive":      { "p50": 230, "p95": 380, "p99": 560 }
  }
}
```

CI workflow：

```yaml
perf:
  steps:
    - run: bun run tests/perf/run.ts > current.json
    - run: bun run tests/perf/diff.ts baseline.json current.json
      # 输出 markdown table 到 PR comment；> 20% 退化标 warning，
      # > 50% 退化标 error（但不 fail）
```

### W3-3 兼容矩阵

```ts
// packages/backend/tests/compat-config-versions.test.ts
for (const ver of ['1.0', '1.1', '1.2']) {
  test(`config.json ${ver} parses and daemon starts`, async () => {
    const cfg = await loadFixture(`config-${ver}.json`)
    const parsed = ConfigSchema.parse(cfg)
    const daemon = await startDaemonInProcess({ config: parsed })
    expect(daemon.healthy).toBe(true)
  })
}

// packages/shared/tests/compat-workflow-schema.test.ts
for (const sv of [1, 2, 3]) {
  test(`workflow $schema_version=${sv} reads and writes`, async () => {
    /* ... */
  })
}
```

### W3-4 gitea container e2e

```yaml
# docker-compose.test.yml
services:
  gitea:
    image: gitea/gitea:1.21
    ports: ['3000:3000', '2222:22']
    volumes: ['./tests/fixtures/gitea-data:/data']
```

e2e 启 compose → 拉公开 + 私钥仓 → 真 task 跑通。Independent job，不阻塞
主 PR。

### W3-5 安全 fuzz

```ts
import fc from 'fast-check'

test.prop([fc.string()])('URL redact never leaks creds', (input) => {
  const r = redactGitUrl(input)
  expect(r).not.toMatch(/[:@]/i) // 暴力但有效
  // ... 更精细的反向断言
})

test.prop([fc.array(fc.constantFrom('..', '.', 'foo', 'bar', '/'), { maxLength: 8 })])(
  'path normalize never escapes worktree',
  (parts) => {
    /* ... */
  },
)
```

---

## 失败模式 + 兜底

| 风险                                                       | 兜底                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| W1-1 录制 fixture 与真 opencode 行为漂移                   | W2-1 真集成补；recording-refresh commit 必须附 opencode 版本说明            |
| W1-2 契约总册写起来重复                                    | 抽 `defineEndpoint(...)` helper；shared schema 复用                         |
| W1-3 SIGKILL 在 macOS / ubuntu CI 行为差                   | 双 OS 矩阵跑；spec 内显式等 daemon `exitCode`                               |
| W1-4 exhausted 触发需要 loop max_iterations 配合           | 构造一个专用 toy workflow fixture                                           |
| W1-5 跨 user 测试需要 admin CLI；CLI 不稳                  | 直接 SQL insert users（绕过 CLI），加一行注释说明                           |
| W1-6 旧 home fixture 太大                                  | 用 `bun gzip` 压缩 + git LFS 慎用（避免 LFS 复杂度）；首批仅 3 个           |
| W1-7 dep-cruiser 加上后历史违规多                          | 加 `--no-progress --output-type err`，违规先标 warning，main 上推进到 error |
| W1-8 webkit 在 Linux CI 慢                                 | 仅 main 上跑全矩阵，PR 仅 chromium + nightly webkit                         |
| W2-1 真 opencode CI 抖动                                   | 标 `@flaky-allowed`，独立 workflow 不阻塞主 PR；连续 7 天失败发 issue       |
| W2-2 fast-check 找到的反例难调                             | 用 fast-check shrink；反例 freeze 进 regression test                        |
| W2-3 Playwright drag-and-drop 在 happy-dom / xyflow 上漂移 | 多次 retry + 用 `page.mouse.down()/move()/up()` 而非 `dragTo`               |
| W2-5 字体差异噪声                                          | ubuntu-only；CI 加 `--update-snapshots` 不在 PR 自动用                      |
| W2-6 axe 在 mermaid / katex 渲染有误判                     | 加 `disableRules: ['color-contrast']` 在富文本块；其余强制                  |
| W3-1 混沌注入需要 root / cgroup                            | 提前要求 CI runner 支持 user namespace；本地 macOS 跳过                     |
| W3-2 perf baseline 在 CI runner 间差                       | 用 ratio 而非绝对值；main 跑 5 次取 median                                  |
| W3-4 gitea container 启动慢                                | nightly job，缓存 image；不阻塞主 PR                                        |

---

## 测试策略

本 RFC **本身**是测试基础设施 — 元层面"测试如何测试自己"：

1. **每个新 spec / 新 contract case 都带 `// LOCKS: <PR-#> / <RFC-#> /
<一句话回归意图>` 注释**。CLAUDE.md §Test-with-every-change 的延伸。
2. **新加的 helper（harness / fixture / parser）必须自己也带测试**。
   例如 `opencode-recording-parser.ts` 必须有 `opencode-recording-
parser-self.test.ts` 锁 helper 行为。
3. **flaky 雷达**：CI 失败 retry=1，重跑才过的 spec 名 push 到 GitHub
   issue tracker（labels: `test-flake`）；每周值班 review；零容忍"重跑
   就过"作为通过依据（CLAUDE.md 已要求）。
4. **回归追溯钩子**：每个修 bug 的 commit message 必须有 `LOCKS-IN:
tests/<file>` 字段。weekly rg 巡检 main 上是否所有 `fix(...)` 都
   伴随测试。
5. **覆盖率仪表盘**：`bun test --coverage` 上传 codecov；不做硬门
   阈值，仅趋势图。

---

## 非破坏性保证

| 现有产物                         | 本 RFC 是否动                                                                      | 备注                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 现存 593 单测                    | 不动                                                                               | 仅新增；若发现重复或错的，单独 PR + 解释                            |
| 现存 6 e2e spec                  | 不动                                                                               | 仅新增；W1-8 加 webkit 时可能要调 spec selector，加一行 webkit 注释 |
| `.github/workflows/ci.yml`       | 改 e2e 一节加 shard + webkit；不动 check / build-binary                            | W1-8                                                                |
| `playwright.config.ts`           | 加 webkit project + fullyParallel                                                  | W1-8                                                                |
| `package.json` 根 + 各 workspace | 加 devDependencies: dependency-cruiser / @axe-core/playwright / knip；不动产品依赖 | W1-7 / W2-6                                                         |
| `STATE.md`                       | 每 PR 合并后追加；不删历史                                                         | 横切验收                                                            |
| `design/plan.md`                 | RFC 索引追加 RFC-054 行 + 状态推进                                                 | 横切验收                                                            |
| `CLAUDE.md`                      | 不改本 RFC 内不动；后续若有"测试加固"成为持续原则可单独 PR 补                      | —                                                                   |
