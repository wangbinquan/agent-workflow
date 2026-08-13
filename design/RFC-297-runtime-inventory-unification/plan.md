# RFC-297 任务分解

配套 `proposal.md` / `design.md`。四批，依赖线性 A → B → C → D；B 与 C 内部各拆两个 PR 做风险隔离。

> 批 B 已按用户 2026-08-13 的裁决改为**统一事件流 + pipeline**（取代初稿的 per-driver collector）。

## 批 A — 统一契约（shared，零行为变更）

| # | 任务 | 落点 |
| --- | --- | --- |
| RFC-297-T1 | 新建统一类型：`InventoryFace` / `InventoryFieldsByFace` / `InventoryDeclaration` / `InventoryEntry` / `RuntimeInventoryObservation` / `RuntimeInventoryPayload` | `packages/shared/src/schemas/runtimeInventory.ts`（新）+ `shared/src/index.ts` 导出 |
| RFC-297-T2 | provenance 纯函数 + 面名映射表（`agents↔subagents`、`mcps↔mcpServers`）单点定义 | 同上 |
| RFC-297-T3 | 抽出 declared-missing 判定，使其与 `verifyStartup` 的 missing 共用同一实现 | `backend/src/services/execution/startupVerification.ts` 现有 `missing()`（`:44`）上提或共用 |
| RFC-297-T4 | 测试 T-4（三态交并差 + 与 `verifyStartup` 同源等价）、面名映射闭合断言 | `packages/shared/tests/rfc297-inventory-contract.test.ts`（新）|

依赖：无。可独立合入，不改任何运行时行为。

## 批 B — 事件流与 pipeline

### B-1（管道骨架，零行为变更）

| # | 任务 | 落点 |
| --- | --- | --- |
| RFC-297-T5 | `NormalizedEventKind` 新增 `'startup_inventory'`；`NormalizedEvent` 新增 `data?`（kind-specific 载荷，按 kind 分派 zod）与 `persist?`；新增 `drainFinalEvents?()` 钩子；`capabilities.inventory: InventoryDeclaration` | `backend/src/services/runtime/types.ts:127-161 / 629-647` |
| RFC-297-T6 | pipeline 骨架：stage 注册与**串行**分发（现状就是串行 await，顺序不可乱）、按 `errorPolicy` 分流错误（design §7.1：搬迁的既有 stage 一律 `propagate`，新增的一律 `isolate`）、`persist:false` 过滤；把今天隐式的四个消费者（session 认领 / token 统计 / 文本累积 / 落库）显式化为 stage | `services/runner.ts:1154-1260` + 新 `services/execution/eventPipeline.ts` |
| RFC-297-T7 | 测试：骨架等价性（同一批 stdout 行经新旧路径产生完全相同的 DB 行与统计）+ stage 隔离（T-8b）| `backend/tests/rfc297-event-pipeline.test.ts`（新）|

**此 PR 不改变任何可观察行为**，只把手写散开的 pump 显式化。等价性测试是它唯一的验收依据。

### B-2（观测收口）

| # | 任务 | 落点 |
| --- | --- | --- |
| RFC-297-T8 | opencode 规范化：`drainFinalEvents` 读 `inventory.json`（沿用 `readSnapshotFromRunDir`）补发 `startup_inventory` 事件；`freshRun === false` 返回 `[]`（把 `observationSkippedByDesign` 从调用方搬进 driver）；declaration 表态 | `runtime/opencode/inventory.ts` + `driver.ts` |
| RFC-297-T9 | claude 规范化：`parseEvent` 识别 `system/init` 时在**同一次 `JSON.parse`** 内顺带填 `data` 载荷（三次解析并作一次）；**该行既有的 kind=`step_start` 与 sessionId 暴露不得改动**（design §3.2）；declaration 表态（`plugins: unsupported`）| `runtime/claudeCode/events.ts` + `driver.ts` |
| RFC-297-T10 | 清单组装 stage（运行时无关）：事件载荷 + `declared` → `RuntimeInventoryObservation`；MCP 不可用告警从同一观测计算 | `services/execution/inventoryStage.ts`（新）|
| RFC-297-T11 | 删除 `readInventory?` / `parseStartupInventory?` / `parseUnusableMcpServers?` 三个可选方法（D10）| `runtime/types.ts` + 两个 driver |
| RFC-297-T12 | runner 收敛：删两个并行捕获变量、删 pump 内两个 if 块、删退出后的 `readInventory` 分支与 `startupObservation` switch | `services/runner.ts:1127 / 1155-1179 / 1890-1957` |
| RFC-297-T13 | `wantsInventory` 从 `AgentSpawnContext` 移除，注入决策下沉各 driver 的 `buildSpawn` | `runtime/types.ts:383 / 453 / 590`、`runner.ts:562`、`runtime/spawnCtx.ts:60/95` |
| RFC-297-T14 | 另两处观测消费点迁移 | `services/systemAgentRun.ts:503`、`services/mcpRuntimeTest.ts:2689` |
| RFC-297-T15 | 启动自检扩展（五面齐全 / supported 必须真能规范化出该面 / `none` 不得声明 supported）| `runtime/selfCheck.ts` |
| RFC-297-T16 | 测试 T-1 / T-2 / T-3 / T-7 / T-8 / T-8c / T-10 / T-12 | `backend/tests/rfc297-inventory-observation.test.ts`（新）+ 扩 `rfc282-a3-driver-selfcheck.test.ts` |

依赖：批 A + B-1。**此批结束时 `runtime_inventory_json` 尚未落库**，stage 产物先只喂给现有的 verification 组装（保持行为等价），便于单独验证收口正确性。

## 批 C — 落库与读端

### C-1（功能）

| # | 任务 | 落点 |
| --- | --- | --- |
| RFC-297-T17 | migration：`node_runs` 加 `runtime_inventory_json TEXT`（仅加列，无回填）| `backend/src/db/migrations/` 新一支 + `db/schema.ts` |
| RFC-297-T18 | 写入：观测无条件写新列；verification 仍受 `declaredHasContent` 门控（D5）| `services/runner.ts:1944-1987` |
| RFC-297-T19 | 读端统一：响应换成 `{observation, declaration}`；`in-flight` / `session-reused` / `runtime-has-no-inventory` 三档 reason 区分 | `runtime/opencode/inventory.ts:144` 迁出 opencode 目录改为运行时无关读端 + `routes/tasks.ts:1115` |
| RFC-297-T20 | 存量转码层（老 opencode 行 / 老 claude 行 → 统一 entry；老 opencode 行标 `provenanceUnavailable`）| 同上，标注过渡代码 |
| RFC-297-T21 | 测试 T-5 / T-6 / T-9 / T-11 | `backend/tests/rfc297-inventory-readend.test.ts`（新）|

### C-2（停写旧列，单独 PR）

| # | 任务 | 落点 |
| --- | --- | --- |
| RFC-297-T22 | `inventory_snapshot_json` 对新 run 停写 | `services/runner.ts:2024` |
| RFC-297-T23 | 迁移受影响的既有测试到新列语义 | `inventory-service.test.ts` / `routes-inventory.test.ts` / `runner-inventory-integration.test.ts` / `inventory-dump-twin-parity.test.ts` / `inventory-in-flight-fallback.test.ts` / `inventory-transcode.test.ts` 等 |

**单独成 PR 的理由**：这是本 RFC 唯一一处「既有绿测试必须改」的批次，与功能解耦后出问题可单独回滚，不影响 C-1 已交付的能力。

依赖：批 B。

## 批 D — 前端

| # | 任务 | 落点 |
| --- | --- | --- |
| RFC-297-T24 | 泛型 `InventoryFaceTable`：列集由 `declaration[face].fields` 计算，`unsupported` 不出列、`unobservable` 出列渲染 `—` + tooltip | `frontend/src/components/inventory/InventoryFaceTable.tsx`（新）|
| RFC-297-T25 | 四张表退役，列定义降级为配置数据；`tools` 面复用同一原语（不新写第五张表）| 删 `AgentsTable/SkillsTable/McpsTable/PluginsTable.tsx` |
| RFC-297-T26 | `RuntimeInventorySection` 按 declaration 渲染五面 + chips 同步（不支持的面不进 chips）| `RuntimeInventorySection.tsx` |
| RFC-297-T27 | provenance 列（复用 `<StatusChip>` 家族，`declared-missing` 用 danger）| `StatusBadge.tsx` 邻域，不新写 chip |
| RFC-297-T28 | i18n 新键进 `Resources` interface + `en-US` 1:1 | `i18n/zh-CN.ts` / `en-US.ts` |
| RFC-297-T29 | 测试 T-13 / T-14 / T-15 / T-16 / T-17 | 扩 `session-inventory-section.test.tsx` / `i18n-inventory-rfc029.test.ts` + `rfc297-inventory-faces.test.tsx`（新）|
| RFC-297-T30 | 视觉对齐自查：与 `/agents`、`/workflows`、`/repos` side-by-side 比对按钮高度 / 圆角 / spacing / 字号 | — |

依赖：批 C-1。

## 收尾

| # | 任务 |
| --- | --- |
| RFC-297-T31 | `docs/audit-backlog.md` 登记 D11 的后续项：`parseTerminalResultError` / `observeSystemEvent` 按同一方向收进事件流 |
| RFC-297-T32 | Codex 实现门（declare done 前），修 findings |

## PR 拆分建议

1. **PR-1**（批 A）：shared 契约 + 纯函数 + 测试。零行为变更。
2. **PR-2**（批 B-1）：pipeline 骨架 + 等价性测试。零行为变更，但动的是最热路径——单独成 PR，等价性测试是唯一验收依据。
3. **PR-3**（批 B-2）：两个 driver 的规范化 + 清单组装 stage + 删三个旧方法 + runner 收敛。
4. **PR-4**（批 C-1）：加列 + 写入 + 统一读端 + 存量转码。**此 PR 合入后 claude 侧清单即可见**（B1 消除）。
5. **PR-5**（批 C-2）：旧列停写 + 既有测试迁移。风险隔离。
6. **PR-6**（批 D）：前端统一呈现。

每个 PR 独立跑 `bun run gate:local` 全绿再推；推完按 exact SHA 查 CI。

## 验收清单

| AC | 由哪些任务交付 | 验证方式 |
| --- | --- | --- |
| AC-1 claude 清单齐全 | T9, T10, T18, T19, T26 | 手工跑一个带技能+MCP+子代理的 claude 节点 |
| AC-2 opencode 富字段无回归 | T8, T24, T25 | T-3 逐字段断言 + T-14 前端断言集保留 |
| AC-3 不支持的面整块不渲染 | T5, T24, T26 | T-13 断言 DOM 中不存在 |
| AC-4 missing 与 banner 同源 | T3, T10 | T-4 同源等价断言 + T-15 |
| AC-5 零注入节点有清单且无告警 | T18 | T-5 |
| AC-6 followup 文案 | T8, T19 | T-6 + T-17 |
| AC-7 存量行可读 | T20 | T-9 |
| AC-8 runner kind-blind | T12, T13 | T-7 源码文本断言 |
| AC-9 漏表态编译错 | T1, T5, T15 | typecheck + T-10 自检测试 |
| AC-10 单次解析 | T6, T9 | T-8 |
| AC-11 i18n 编译期完整 | T28 | T-16 |

## 尚未决的前置

D1-D11 已全部拍板（D4/D5/D10 由用户 2026-08-13 明确表态，D3 由用户改判为事件流方案），可直接进入批 A。实现前请按 `design.md §1` 逐条复核现状锚点——尤其 `runner.ts` 的行号在并发树上易漂移。
