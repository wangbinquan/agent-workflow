# RFC-118 技术设计：运行时启用/禁用开关

## 1. 现状

- `runtimes` 表（`schema.ts:99-126`）**无 `enabled` 列**；内置 `opencode`/`claude-code` 是 `builtin=1` 只读种子。
- `deleteRuntime`（`runtimeRegistry.ts:375`）`assertNotBuiltinRuntime` 拒删内置；`376-386` in-use 守卫（被 agent 引用 / 是 default → 先 re-point）。
- `seedBuiltinRuntimes`（`runtimeRegistry.ts:403`，`start.ts:220` 启动调用）：内置 row 缺失则 insert（NULL binary/params）；只在 protocol/builtin 漂移时 update（**保留** binary_path + profile，RFC-113 D8）。
- `resolveRuntimeByName`（`runtimeRegistry.ts:147-172`）：内置 name 无 row 也硬回退 protocol 默认；unknown name → warn + 回退 opencode（fail-safe，绝不 brick 派发）。
- 前端 `RuntimeList.tsx:201` 删除按钮 `!rt.builtin`；agent 运行时选择器（`AgentForm.tsx`）+ 默认运行时下拉（settings）读 `GET /api/runtimes`。

## 2. 决策

- **D1**：`runtimes` 加 `enabled`（`integer boolean notNull default true`），migration 0059。
- **D2**：禁用 = `enabled=false`，**保留行**。内置可禁用（**不**走 `assertNotBuiltinRuntime`）。删除路径不动——内置仍只禁不删（避免 tombstone/复活，proposal 非目标）。
- **D3**：**默认保护**——禁用 `name === (config.defaultRuntime ?? 'opencode')`（**effective** default：config 未设时 `opencode` 是事实默认，见 `runtimeRowToView:121` 与 resolve fail-safe `:171`）的运行时 → `ConflictError 'runtime-default-cannot-disable'`（先改默认）。启用无此限制。**Codex 设计 gate P2**：必须用 effective default 而非字面 `config.defaultRuntime`——否则 config 未设（null）时会放行禁用 `opencode`，而继承 agents + fail-safe 仍指向它。`opencode` 还是 `resolveRuntimeByName` 的终极兜底（`:171`）：即便 default 改指别处后被主动禁用，resolve 仍按 **D4**（不看 enabled）返回它 → **不 brick 派发**；它从选择器消失是预期。
- **D4**：`resolveRuntimeByName` / 派发链**不变**。禁用 row 仍能 resolve，存量已 pin 它的 agent 继续派发（禁用只阻**新选**，不静默改在用 agent 的运行时——proposal 非目标）。default 恒 enabled（D3 保证），故 fail-safe 回退目标始终可用。
- **D5**：`seedBuiltinRuntimes` **不改**——insert 新行时 `enabled` 取列默认 true；identity-drift update 不碰 `enabled`。禁用过的内置重启**不会**被 seed 改回启用（现有逻辑只在 row 缺失时 insert，禁用的 row 仍在 → 不 insert；drift update 只设 protocol/builtin）。✅ 天然满足「禁用持久、留列表」。
- **D6**：**选择层过滤**——
  - 前端 agent 运行时选择器 + 默认运行时下拉只列 `enabled` 运行时；但**保留 agent 已 pin 的当前值**（即便它已被禁用，不隐藏、不静默改，仿 RFC-110 旧值不泄漏）。
  - 后端兜底：保存 `agent.runtime` / `config.defaultRuntime` 时，若**新指向**一个 disabled 运行时（区别于保持原值）→ 拒（`ValidationError 'runtime-disabled'`）。保持原值放行（不阻止编辑 agent 的其他字段，仿 RFC-099「只校验新增引用」）。
- **D7**：端点 `POST /api/runtimes/:name/enabled`，body `{ enabled: boolean }`，admin-only（与其余写一致）。
- **D8**：前端 `RuntimeList` 每行加启用/禁用 `Switch`（公共组件）；**默认行** Switch `disabled` + 提示「默认运行时不可禁用，请先更改默认」；**禁用行** 整行灰显 + `<StatusChip kind="neutral">已禁用</StatusChip>`。

## 3. Migration

`db/migrations/0059_rfc118_runtime_enabled.sql`（单语句，SQLite `ADD COLUMN` 安全）：

```sql
ALTER TABLE runtimes ADD COLUMN enabled integer NOT NULL DEFAULT 1;
```

+ `meta/_journal.json` 追加条目。存量行（含内置）回填 `enabled=1`（启用）——零行为变更。

## 4. 接口契约变更

- `RuntimeRow` / `RuntimeView`（`runtimeRegistry.ts`）+ 前端 `RuntimeView`（`RuntimeList.tsx`）加 `enabled: boolean`。
- `runtimeRowToView` 透出 `enabled`。
- 新 `setRuntimeEnabled(db, name, enabled, defaultRuntimeName)`：404 / D3 默认保护 / update。
- 新 `POST /api/runtimes/:name/enabled`。
- `GET /api/runtimes` 返回值加 `enabled`（前端过滤用）。

## 5. 消费点清单（全量）

| 层 | 文件 | 改动 |
|---|---|---|
| DB | `db/migrations/0059_rfc118_runtime_enabled.sql` + `meta/_journal.json` | 加 `enabled` 列 |
| DB | `db/schema.ts` | runtimes 加 `enabled` |
| 后端 | `services/runtimeRegistry.ts` | RuntimeRow/View + `enabled`；`setRuntimeEnabled` + D3 守卫；`runtimeRowToView` |
| 后端 | `routes/runtimes.ts` | `POST /:name/enabled`（admin） |
| 后端 | agent 保存校验（`services/agent.ts` 或保存入口）+ `config.defaultRuntime` 保存校验 | 新指向 disabled → 拒（D6 兜底） |
| 前端 | `components/RuntimeList.tsx` | 行内 Switch + 默认置灰 + 禁用灰显/chip；`RuntimeView.enabled` |
| 前端 | `components/AgentForm.tsx` runtime 选择器 + settings 默认运行时下拉 | 过滤 `enabled`，保留已 pin 当前值 |
| i18n | `en-US.ts` / `zh-CN.ts` | `runtimes.disabled`/`enable`/`disable`/`defaultCannotDisable` 等键 |
| 测试 | backend `runtime-registry` / `runtime-routes-registry` + 前端 `runtime-list` | 见 §6 |

## 6. 测试策略（必写 case）

**后端**：
1. `setRuntimeEnabled('claude-code', false)`（非默认内置）→ ok，row `enabled=false`。
2. 禁用 `opencode`（= config.defaultRuntime）→ `ConflictError 'runtime-default-cannot-disable'`。**+ config.defaultRuntime 未设（null）时禁用 `opencode`（effective default）同样被拒**（Codex P2）。
3. 启用回来 → `enabled=true`。
4. **seed 保留**：禁用 claude-code 后再跑 `seedBuiltinRuntimes` → 仍 `enabled=false`（不复活启用）。
5. `resolveRuntimeByName('claude-code')` 在其 disabled 时**仍 resolve**（派发不变性）。
6. 保存 agent.runtime **新指向** disabled 运行时 → 拒；保持原值（已 pin 的 disabled）→ 放行。
7. `POST /api/runtimes/:name/enabled` 非 admin → 403。

**前端**：
8. `RuntimeList` 渲染行内 Switch；默认行 Switch `disabled`（+ 提示）。
9. 禁用行灰显 + 「已禁用」标记。
10. agent/默认选择器过滤掉 disabled，但 agent 已 pin 的 disabled 值仍可见（不静默丢）。

## 7. 失败模式与兼容

- migration 回填 `enabled=1` → 存量零行为变更；无 down 需求（加列）。
- 禁用 default 被 D3 拦 → default 恒 enabled → resolve fail-safe 目标恒可用。
- 禁用被 agent 引用的运行时：存量派发不变（D4），前端禁用时可提示「N agents 引用」（可选增强）。
- 单二进制 build：仅加列 + 纯函数，无新跨模块导出环（避开 binary-build cycle 风险）。

## 8. 与既有的关系

- 接 RFC-112/113 注册表；RFC-116（network-blocked）正交。
- 删除路径（`deleteRuntime`）保持不变——自定义可删、内置仍只禁不删（本 RFC 的可逆「禁用」覆盖了用户对内置的清理诉求）。
