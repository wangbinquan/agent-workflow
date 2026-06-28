# RFC-118 任务分解

## 子任务

- **RFC-118-T1（DB）**：
  - `db/migrations/0059_rfc118_runtime_enabled.sql`：`ALTER TABLE runtimes ADD COLUMN enabled integer NOT NULL DEFAULT 1;` + `meta/_journal.json` 条目。
  - `db/schema.ts`：runtimes 加 `enabled`（boolean notNull default true）。
  - migration apply 测试（列存在 + 存量回填 1）。

- **RFC-118-T2（后端 service + 路由）**：
  - `runtimeRegistry.ts`：RuntimeRow/RuntimeView + `enabled`；`runtimeRowToView` 透出；新 `setRuntimeEnabled(db,name,enabled,defaultRuntimeName)`（404 / D3 默认保护 / update）。
  - `routes/runtimes.ts`：`POST /api/runtimes/:name/enabled`（admin），调 `setRuntimeEnabled`。
  - `GET /api/runtimes` 自动带出 `enabled`（view 已含）。

- **RFC-118-T3（后端保存兜底）**：
  - agent 保存：`agent.runtime` **新指向** disabled → 拒（保持原值放行）。
  - `config.defaultRuntime` 保存：新指向 disabled → 拒。
  - 定位保存校验入口（agent service / config 路由），仿 RFC-099「只校验新增引用」。

- **RFC-118-T4（前端）**：
  - `RuntimeList.tsx`：行内启用/禁用 `Switch`；默认行置灰 + 提示；禁用行灰显 + 「已禁用」chip；`RuntimeView.enabled`；toggle mutation 失效 `['runtimes']`。
  - `AgentForm.tsx` runtime 选择器 + settings 默认运行时下拉：过滤 `enabled`，**保留已 pin 当前值**。
  - i18n zh/en：`enable`/`disable`/`disabled`/`defaultCannotDisable`。

- **RFC-118-T5（测试）**：design §6 后端 7 + 前端 3 必写 case。

- **RFC-118-T6（登记）**：`design/plan.md` RFC 索引 + `STATE.md` 进行中→完工 Done。

## 依赖

`T1 → T2 → {T3, T4}`；`T5` 贯穿；`T6` 收尾。

## PR 拆分

**单 PR**（migration + service + 路由 + 前端 + 校验原子；分开会留「列加了但无 UI」或「UI 有 toggle 但后端不认」的中间不一致态）。commit 前缀：`feat(backend,frontend): RFC-118 运行时启用/禁用开关`。migration 单语句、纯加列，风险低，无需多 PR 强序。

## 验收清单

- [ ] migration 0059 apply + 回填 1；`bun run build:binary` smoke（migration 嵌入）。
- [ ] 后端 7 必写 case（禁用非默认/禁用默认被拒/启用/seed 保留/resolve 不变/保存校验/admin gate）。
- [ ] 前端 3 case（Switch + 默认置灰 + 禁用标记 + 选择器过滤保留已 pin）。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] Codex 设计 gate + 实现 gate findings 全 fold。
- [ ] push 后 CI（双 OS test + binary smoke + e2e）success。
- [ ] `STATE.md` / `design/plan.md` 更新。
