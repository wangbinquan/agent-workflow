# RFC-297 任务分解

配套 `proposal.md` / `design.md`。四批，依赖线性 A → B → C → D；B 与 C 内部各拆两个 PR 做风险隔离。

> 批 B 已按用户 2026-08-13 的裁决改为**统一事件流 + pipeline**（取代初稿的 per-driver collector）。

## 批 A — 统一契约（shared，零行为变更）

| #          | 任务                                                                                                                                                            | 落点                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| RFC-297-T1 | 新建统一类型：`InventoryFace` / `InventoryFieldsByFace` / `InventoryDeclaration` / `InventoryEntry` / `RuntimeInventoryObservation` / `RuntimeInventoryPayload` | `packages/shared/src/schemas/runtimeInventory.ts`（新）+ `shared/src/index.ts` 导出         |
| RFC-297-T2 | provenance 纯函数 + 面名映射表（`agents↔subagents`、`mcps↔mcpServers`）单点定义                                                                                 | 同上                                                                                        |
| RFC-297-T3 | 抽出 declared-missing 判定，使其与 `verifyStartup` 的 missing 共用同一实现                                                                                      | `backend/src/services/execution/startupVerification.ts` 现有 `missing()`（`:44`）上提或共用 |
| RFC-297-T4 | 测试 T-4（三态交并差 + 与 `verifyStartup` 同源等价）、面名映射闭合断言                                                                                          | `packages/shared/tests/rfc297-inventory-contract.test.ts`（新）                             |

依赖：无。可独立合入，不改任何运行时行为。

## 批 B — 事件流与 pipeline

### B-1（管道骨架，零行为变更）

| #          | 任务                                                                                                                                                                                                                                                                                    | 落点                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| RFC-297-T5 | `NormalizedEventKind` 新增 `'startup_inventory'`；`NormalizedEvent` 新增 `data?`（kind-specific 载荷，按 kind 分派 zod）与 `persist?`；新增 `drainFinalEvents?()` 钩子；`capabilities.inventory: InventoryDeclaration`                                                                  | `backend/src/services/runtime/types.ts:127-161 / 629-647`                 |
| RFC-297-T6 | pipeline 骨架：stage 注册与**串行**分发（现状就是串行 await，顺序不可乱）、按 `errorPolicy` 分流错误（design §7.1：搬迁的既有 stage 一律 `propagate`，新增的一律 `isolate`）、`persist:false` 过滤；把今天隐式的四个消费者（session 认领 / token 统计 / 文本累积 / 落库）显式化为 stage | `services/runner.ts:1154-1260` + 新 `services/execution/eventPipeline.ts` |
| RFC-297-T7 | 测试：骨架等价性（同一批 stdout 行经新旧路径产生完全相同的 DB 行与统计）+ stage 隔离（T-8b）                                                                                                                                                                                            | `backend/tests/rfc297-event-pipeline.test.ts`（新）                       |

**此 PR 不改变任何可观察行为**，只把手写散开的 pump 显式化。等价性测试是它唯一的验收依据。

### B-2（观测收口）

| #           | 任务                                                                                                                                                                                                                                       | 落点                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| RFC-297-T8  | opencode 规范化：`drainFinalEvents` 读 `inventory.json`（沿用 `readSnapshotFromRunDir`）补发 `startup_inventory` 事件；`freshRun === false` 返回 `[]`（把 `observationSkippedByDesign` 从调用方搬进 driver）；declaration 表态             | `runtime/opencode/inventory.ts` + `driver.ts`                                                       |
| RFC-297-T9  | claude 规范化：`parseEvent` 识别 `system/init` 时在**同一次 `JSON.parse`** 内顺带填 `data` 载荷（三次解析并作一次）；**该行既有的 kind=`step_start` 与 sessionId 暴露不得改动**（design §3.2）；declaration 表态（`plugins: unsupported`） | `runtime/claudeCode/events.ts` + `driver.ts`                                                        |
| RFC-297-T10 | 清单组装 stage（运行时无关）：事件载荷 + `declared` → `RuntimeInventoryObservation`；MCP 不可用告警从同一观测计算                                                                                                                          | `services/execution/inventoryStage.ts`（新）                                                        |
| RFC-297-T11 | 删除 `readInventory?` / `parseStartupInventory?` / `parseUnusableMcpServers?` 三个可选方法（D10）                                                                                                                                          | `runtime/types.ts` + 两个 driver                                                                    |
| RFC-297-T12 | runner 收敛：删两个并行捕获变量、删 pump 内两个 if 块、删退出后的 `readInventory` 分支与 `startupObservation` switch                                                                                                                       | `services/runner.ts:1127 / 1155-1179 / 1890-1957`                                                   |
| RFC-297-T13 | `wantsInventory` 从 `AgentSpawnContext` 移除，注入决策下沉各 driver 的 `buildSpawn`                                                                                                                                                        | `runtime/types.ts:383 / 453 / 590`、`runner.ts:562`、`runtime/spawnCtx.ts:60/95`                    |
| RFC-297-T14 | 另两处观测消费点迁移                                                                                                                                                                                                                       | `services/systemAgentRun.ts:503`、`services/mcpRuntimeTest.ts:2689`                                 |
| RFC-297-T15 | 启动自检扩展（五面齐全 / supported 必须真能规范化出该面 / `none` 不得声明 supported）                                                                                                                                                      | `runtime/selfCheck.ts`                                                                              |
| RFC-297-T16 | 测试 T-1 / T-2 / T-3 / T-7 / T-8 / T-8c / T-10 / T-12                                                                                                                                                                                      | `backend/tests/rfc297-inventory-observation.test.ts`（新）+ 扩 `rfc282-a3-driver-selfcheck.test.ts` |

依赖：批 A + B-1。**此批结束时 `runtime_inventory_json` 尚未落库**，stage 产物先只喂给现有的 verification 组装（保持行为等价），便于单独验证收口正确性。

## 批 C — 落库与读端

### C-1（功能）

| #           | 任务                                                                                                                          | 落点                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| RFC-297-T17 | migration：`node_runs` 加 `runtime_inventory_json TEXT`（仅加列，无回填）                                                     | `backend/src/db/migrations/` 新一支 + `db/schema.ts`                                              |
| RFC-297-T18 | 写入：观测无条件写新列；verification 仍受 `declaredHasContent` 门控（D5）                                                     | `services/runner.ts:1944-1987`                                                                    |
| RFC-297-T19 | 读端统一：响应换成 `{observation, declaration}`；`in-flight` / `session-reused` / `runtime-has-no-inventory` 三档 reason 区分 | `runtime/opencode/inventory.ts:144` 迁出 opencode 目录改为运行时无关读端 + `routes/tasks.ts:1115` |
| RFC-297-T20 | 存量转码层（老 opencode 行 / 老 claude 行 → 统一 entry；老 opencode 行标 `provenanceUnavailable`）                            | 同上，标注过渡代码                                                                                |
| RFC-297-T21 | 测试 T-5 / T-6 / T-9 / T-11                                                                                                   | `backend/tests/rfc297-inventory-readend.test.ts`（新）                                            |

### C-2（停写旧列，单独 PR）

| #           | 任务                                    | 落点                                                                                                                                                                                                                 |
| ----------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC-297-T22 | `inventory_snapshot_json` 对新 run 停写 | `services/runner.ts:2024`                                                                                                                                                                                            |
| RFC-297-T23 | 迁移受影响的既有测试到新列语义          | `inventory-service.test.ts` / `routes-inventory.test.ts` / `runner-inventory-integration.test.ts` / `inventory-dump-twin-parity.test.ts` / `inventory-in-flight-fallback.test.ts` / `inventory-transcode.test.ts` 等 |

**单独成 PR 的理由**：这是本 RFC 唯一一处「既有绿测试必须改」的批次，与功能解耦后出问题可单独回滚，不影响 C-1 已交付的能力。

依赖：批 B。

## 批 D — 前端

| #           | 任务                                                                                                                           | 落点                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| RFC-297-T24 | 泛型 `InventoryFaceTable`：列集由 `declaration[face].fields` 计算，`unsupported` 不出列、`unobservable` 出列渲染 `—` + tooltip | `frontend/src/components/inventory/InventoryFaceTable.tsx`（新）                                                    |
| RFC-297-T25 | 四张表退役，列定义降级为配置数据；`tools` 面复用同一原语（不新写第五张表）                                                     | 删 `AgentsTable/SkillsTable/McpsTable/PluginsTable.tsx`                                                             |
| RFC-297-T26 | `RuntimeInventorySection` 按 declaration 渲染五面 + chips 同步（不支持的面不进 chips）                                         | `RuntimeInventorySection.tsx`                                                                                       |
| RFC-297-T27 | provenance 列（复用 `<StatusChip>` 家族，`declared-missing` 用 danger）                                                        | `StatusBadge.tsx` 邻域，不新写 chip                                                                                 |
| RFC-297-T28 | i18n 新键进 `Resources` interface + `en-US` 1:1                                                                                | `i18n/zh-CN.ts` / `en-US.ts`                                                                                        |
| RFC-297-T29 | 测试 T-13 / T-14 / T-15 / T-16 / T-17                                                                                          | 扩 `session-inventory-section.test.tsx` / `i18n-inventory-rfc029.test.ts` + `rfc297-inventory-faces.test.tsx`（新） |
| RFC-297-T30 | 视觉对齐自查：与 `/agents`、`/workflows`、`/repos` side-by-side 比对按钮高度 / 圆角 / spacing / 字号                           | —                                                                                                                   |

依赖：批 C-1。

## 收尾

| #           | 任务                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| RFC-297-T31 | `docs/audit-backlog.md` 登记 D11 的后续项：`parseTerminalResultError` / `observeSystemEvent` 按同一方向收进事件流 |
| RFC-297-T32 | Codex 实现门（declare done 前），修 findings                                                                      |

## PR 拆分建议

1. **PR-1**（批 A）：shared 契约 + 纯函数 + 测试。零行为变更。
2. **PR-2**（批 B-1）：pipeline 骨架 + 等价性测试。零行为变更，但动的是最热路径——单独成 PR，等价性测试是唯一验收依据。
3. **PR-3**（批 B-2）：两个 driver 的规范化 + 清单组装 stage + 删三个旧方法 + runner 收敛。
4. **PR-4**（批 C-1）：加列 + 写入 + 统一读端 + 存量转码。**此 PR 合入后 claude 侧清单即可见**（B1 消除）。
5. **PR-5**（批 C-2）：旧列停写 + 既有测试迁移。风险隔离。
6. **PR-6**（批 D）：前端统一呈现。

每个 PR 独立跑 `bun run gate:local` 全绿再推；推完按 exact SHA 查 CI。

## 验收清单

| AC                            | 由哪些任务交付         | 验证方式                                  |
| ----------------------------- | ---------------------- | ----------------------------------------- |
| AC-1 claude 清单齐全          | T9, T10, T18, T19, T26 | 手工跑一个带技能+MCP+子代理的 claude 节点 |
| AC-2 opencode 富字段无回归    | T8, T24, T25           | T-3 逐字段断言 + T-14 前端断言集保留      |
| AC-3 不支持的面整块不渲染     | T5, T24, T26           | T-13 断言 DOM 中不存在                    |
| AC-4 missing 与 banner 同源   | T3, T10                | T-4 同源等价断言 + T-15                   |
| AC-5 零注入节点有清单且无告警 | T18                    | T-5                                       |
| AC-6 followup 文案            | T8, T19                | T-6 + T-17                                |
| AC-7 存量行可读               | T20                    | T-9                                       |
| AC-8 runner kind-blind        | T12, T13               | T-7 源码文本断言                          |
| AC-9 漏表态编译错             | T1, T5, T15            | typecheck + T-10 自检测试                 |
| AC-10 单次解析                | T6, T9                 | T-8                                       |
| AC-11 i18n 编译期完整         | T28                    | T-16                                      |

## 尚未决的前置

D1-D11 已全部拍板（D4/D5/D10 由用户 2026-08-13 明确表态，D3 由用户改判为事件流方案），可直接进入批 A。实现前请按 `design.md §1` 逐条复核现状锚点——尤其 `runner.ts` 的行号在并发树上易漂移。

---

## 实施记录（2026-08-13）

实际落地顺序与计划有两处偏离，均因**并发协作面**，逐条记明以便接手。

### 已落 main

| PR                        | commit     | 内容                                                                                                             | 门禁                                          |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 三件套                    | `ebb7fc74` | proposal / design / plan 落档                                                                                    | —                                             |
| PR-1（批 A）              | `c8db6634` | T1-T4 shared 统一契约 + provenance 纯函数 + missing 判定单点化 + 21 例                                           | 主树 gate 全绿；CI + integration 双绿         |
| PR-2（批 B-1）            | `37badce5` | T5-T7 事件契约（data/persist/drainFinalEvents/capabilities.inventory）+ `eventPipeline` + 两 driver 表态 + 49 例 | pin worktree gate 全绿；CI + integration 双绿 |
| PR-3（提前的读端 + 前端） | `95a46aa1` | T19/T20/T24-T28 统一读端 + 前台按表态呈现 + 既有 13 例迁移                                                       | pin worktree gate                             |

### 偏离一：读端与前端提前到 PR-3，driver 规范化与 runner 接入押后

计划里 driver 规范化（批 B-2）在读端之前。实际发现 `runner.ts` 与
`claudeCode/events.ts` 是另一位协作者的**活跃战场**：工作树里有其 conversation-reset /
会话身份收窄（`parseEvent` 只暴露 root `system/init` 的 session_id）/ 租约轮换一组
未提交改动，且在本 RFC 的门禁运行期间仍在实时编辑（一次门禁跑到一半时
`discardRuntimeSessionLease` 才刚被写出来）。

关键判断：**其 runner 侧新逻辑依赖尚未提交的 events.ts 改动**——单独提交 runner 那一半，
claude 的非 init 帧携带不同 `session_id` 时会直接抛错判节点失败。按 CLAUDE.md
「冲突优先调和」，本 RFC 完全不碰这两个文件。

于是改走「读端先行」：claude 的清单经**启动验证记录里的 observation** 取得（那正是
`system/init` 报告的四个面），数据完整度与最终形态一致（claude 本就只按名字报告），
用户可见问题因此提前修复，不必等 driver 侧收口。

### 偏离二：`startup_inventory` kind 推迟

PR-2 原计划引入该 kind，实测它会牵动 `node_run_events.kind` 的落库类型（该列 enum
里没有它），必须与 pump 改造同批——而 pump 正是并发热点。故 PR-2 只留 `data` /
`persist` 契约，kind 与落库过滤留到接入批。

### 待接入批（阻塞中）

| #           | 内容                                                               | 解锁条件                                                     |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| T8          | opencode `drainFinalEvents` 读 dump 文件补发合成事件               | 需与 kind + 落库过滤同批                                     |
| T9          | claude 在 init 事件上附加清单载荷（三次解析并作一次）              | `events.ts` 并发改动落停                                     |
| T11-T13     | 删三个 driver 可选方法 / runner kind-blind / `wantsInventory` 下沉 | `runner.ts` 并发改动落停                                     |
| T14-T15     | systemAgentRun + mcpRuntimeTest 迁移、启动自检扩展                 | 同上                                                         |
| T17/T18/T22 | 新列 + 写入 + 旧列停写                                             | 同上（且 `db/schema.ts` 与 migrations journal 亦有并发改动） |

接手时先 `git status` 确认上述文件已落停，再按 design §3 实施。

> **更新（收尾）**：上述阻塞已解除并全部完成，见文末「接入批实况」。

### 期间修正的三处设计/实现问题

1. **stage 错误策略不能一刀切隔离**（design §7.1 新增）：runner 现状里「一次 run 中途
   原生会话 id 变了」是**刻意抛错**把节点判失败的（RFC-027/276 会话身份契约）。若管道
   一律吞异常，这条只在异常运行时触发的保护会静默消失且无测试会红。
2. **claude 的 init 行是「附加载荷」而非「产出新事件」**（design §3.2 修订）：那一行今天
   已是结构化事件（kind `step_start`）且是 session 认领入口，改判 kind 会同时动两处高价值
   既有行为。
3. **读端不得重写 opencode 取数**：第一版重写后当场丢掉 RFC-062 的「运行中从 runRoot
   实时读」，被既有测试抓出，改为在既有读端之上做形状转换。

---

## 接入批实况与一处自我纠正（2026-08-13 收尾）

阻塞解除后三批落地：driver 侧规范化（`b014ee93`）、消费收敛到事件载荷
（`cacbcb03`，AC-10）、新列 + 观测无条件落库（`6eb23327`，AC-5）；随后 T12/T13
（`1e293b7d`，AC-8）与 T22 旧列停写（`2cf2d397`）。**11 条验收标准全部达成。**

### AC-8 的实质不是 pump 重构

原计划把 pump 整体 pipeline 化才算达成，深挖后发现标的其实是**两处重复判据**：
`switch (caps.startupObservation)` 在 runner 与 MCP 测试台各写一遍；`wantsInventory`
的字段名又把「opencode 要物化 dump 插件」这条运行时知识写进了调用方，于是测试台
里长出了 `startupObservation === 'inventory-file'` 的三元判断。前者收进
`observationForVerification` 单点（取快照改惰性入参），后者改名 `freshAgentRun`
只陈述业务事实。两个消费方对 `startupObservation` 的引用归零，AC-8 达成——**pump
是否 pipeline 化与此无关**。

### pipeline 骨架已删除（用户裁决）

T6 的 `services/execution/eventPipeline.ts` 与 T10 的 `createInventoryStage` 曾经
落库，但 pump 始终没有 pipeline 化，二者**零生产调用方**——22 例测试锁的是死代码，
而 `createInventoryStage` 与在用的 `buildRuntimeInventoryObservation` 更是同一语义
的两份实现。按仓规「删除优于 deprecate、别为快一点留过渡态」，用户裁决删除：

- 删 `eventPipeline.ts` + `rfc297-event-pipeline.test.ts`（11 例）
- 删 `createInventoryStage` + `rfc297-inventory-stage.test.ts`（11 例）
- `inventoryStage.ts` 只剩结算形态，随之更名 `inventoryObservation.ts`
- 顺带把两处重复的 `declaredNamesFor` 收进 shared 的 `declaredNamesForFace`

**真做 pipeline 化时按当时的 pump 形态重写**——它已叠了协作者落地的
conversation-reset 状态机与租约轮换，与本 RFC 当初的设计未必吻合。design §3.4 的
管道设计因此是**纸面设计**，不是已落库的实现，接手前请以本节为准。

### 自查补的三处防护缺口（`6ee8d9c2`）

用户追问「用例防护充足吗」时自查发现，均已补：AC-10 单次解析**竟然没有锁**（补
JSON.parse 计数 + 方法缺席 + 源码调用形式三条）；AC-5 零注入节点只有纯函数覆盖
（补真跑 runner 的端到端，断言两列分工同时成立）；i18n 新键未进完整性锁（补双语
齐全 + 一条「新归因文案不得再提插件」的产品意图锁）。
