# RFC-135 · 任务分解

单 PR 交付；commit 前缀 `feat(home): RFC-135 首页多运行时状态行`。

## RFC-135-T1 — shared 契约 + 后端状态端点（依赖：无）

- `packages/shared/src/schemas/runtime.ts`：新增 `RuntimeStatusEntrySchema` /
  `RuntimesStatusResponseSchema`（design §2）；删
  `RuntimeOpencodeStatusSchema` / `RuntimeClaudeStatusSchema`（与 T3 同批，先加后删亦可）。
- `packages/backend/src/routes/runtimes.ts`：新增 `GET /api/runtimes/status`
  （enabled 过滤 → 并行 probe → 契约行）；**`requirePermission('runtime:read')`**
  （gate F1，对齐 server.ts:144-145 旧探针权限面）。
- `probeOpencode` / `probeClaudeCode` 签名扩展**向后兼容可选 opts
  `{ timeoutMs?, quiet? }`**（超时 `proc.kill('SIGKILL')` 回收再按
  `version: null` 返回，SIGKILL 防 kill 后二次悬挂；quiet 抑制 per-probe
  log.warn；不传 = 现行为，daemon 启动探测零变化）——status 端点传
  5000ms（可注入）+ `quiet: true`（gate F2/F4/F6/F7）。
- binary 解析抽 `resolveRuntimeBinary` helper，`POST /:name/probe`
  （routes/runtimes.ts:172-176）改为同一 helper。
- 测试：`rfc135-runtimes-status.test.ts` 七个 case（design §7 backend 1-7，含
  收窄 PAT 403 与挂死超时回归）。

## RFC-135-T2 — 前端首页改造（依赖：T1）

- `HomepageGreeting.tsx`：查询换 `GET /api/runtimes/status`（query key
  `['runtimes','status','home']`，staleTime/refetchInterval 沿现状）；
  `describeRuntime` → `describeRuntimes`（items / aggregate / checking /
  noneEnabled 判别 union，每 item 输出 **severity**，`__test__` 导出）；
  逐 item 渲染状态点。
- i18n：zh-CN / en-US `home.runtime.*` 重构 + bundle 类型声明（design §5）。
- CSS：dot 变体**语义化改名** `--{ok|fault|soft|checking}`（gate F3，旧
  `--{ready|checking|incompatible|missing}` 同批删）+ item 间距
  （`.homepage__runtime-item`）。
- 测试：`describeRuntimes` 纯函数单测（含最坏 severity 点名，gate F5）+
  `homepage.test.tsx` / `index-page-routing.test.tsx`（gate F8）mock/断言更新
  （design §7 frontend 1-2）。

## RFC-135-T3 — 旧单运行时探针面清理（依赖：T2）

- 删 `packages/frontend/src/components/RuntimeStatusCard.tsx`（零引用死代码）。
- `packages/backend/src/routes/runtime.ts`：删 `GET /api/runtime/opencode` /
  `GET /api/runtime/claude`（models 端点保留，头注释更新）；`probeOpencode` /
  `probeClaudeCode` util 不动（daemon 启动探测在用）。
- 前端 i18n 清理：`settingsForm.runtimeStatus*` / `claudeRuntimeStatus*` 中
  仅被 RuntimeStatusCard 消费的 key 一并删（实现时以 grep 零引用为准，勿多删）。
- 测试联动：`runtime-routes.test.ts` 删两 describe；`admin-only-gate.test.ts`
  旧探针断言改指 `/api/runtimes/status`；`contracts/registry.ts` 条目替换；
  新增源码文本断言（HomepageGreeting 不含 `/api/runtime/opencode`）。

## RFC-135-T4 — 收口（依赖：T1-T3）

- `design/plan.md` RFC 索引状态 Draft → Done；`STATE.md` 进行中行转已完成条目。
- 门禁：`bun run typecheck && bun run test && bun run format:check` + 前端 vitest
  + `bun run build:binary` smoke；推送后查 GitHub Actions。
- Playwright 视觉基线：`e2e/visual-regression.spec.ts:120`（homepage/dashboard）
  截图基线随 hero 改动更新。**注意**：该 spec 在 nightly 已连续失败
  （2026-07-01/07-02，失败页面正是 homepage——本 RFC 之前的既有漂移），实现时
  先确认基线现状、区分既有漂移与本 RFC 引入的变化，勿把旧漂移一并「重拍」掩盖。
- Codex 实现 gate review + 视觉自查（首页明暗双主题截图，对照 /settings 等核心页）。

## 验收清单

- [ ] AC-1〜AC-6（proposal）逐条过。
- [ ] design §7 全部测试落地且绿。
- [ ] 零 migration / `GET /api/runtimes`、`GET /api/runtime/models` 字节不变。
