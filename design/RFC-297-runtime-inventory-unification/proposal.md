# RFC-297 运行时清单统一：driver 侧能力收口 + 跨运行时统一呈现

状态：Draft（2026-08-13）

## 1. 背景

用户实证：**使用 Claude Code 运行时（含其自定义 fork CodeAgentCLI）执行 agent 节点时，前台「运行时清单」看不到任何注入信息**，显示成「未生成清单文件（插件可能加载失败）。」

该文案对 claude 运行时是**纯误导**——claude 从来没有那个插件。追下来是两层问题：

### 1.1 数据其实拿到了，只是没接到读端

Claude 的启动清单来自 CLI 自己的 `system/init` 事件（spawn 固定带 `--output-format stream-json --verbose`，`services/runtime/claudeCode/spawn.ts:60`），`parseStartupInventory`（`claudeCode/events.ts:142`，注释标注实测 claude 2.1.226）解析出四个面：

- `tools` —— 本轮实际加载的内建工具集（`--tools` 裁剪后的结果）
- `agents` —— 全部可寻址子代理（`--agents` 注入的 + 运行时内建）
- `skills` —— 已加载技能的**目录名**（frontmatter `name:` 只作 displayName）
- `mcp_servers` —— `{name, status}`，状态原文保留

用户已实测确认：`startup_verification_json` 里 `observation.state = 'verified'`，`agents` / `skills` / `mcp_servers` 都有值。

但这份数据**只流向了启动验证**（`node_runs.startup_verification_json`），没有流向清单读端：

| 列 | 写入来源 | claude | opencode |
| --- | --- | --- | --- |
| `node_runs.inventory_snapshot_json`（`db/schema.ts:1582`）| `driver.readInventory?.()` | **NULL**（claude driver 未实现该可选能力，`runtime/types.ts:734` 明写 "claude omits this"）| 有 |
| `node_runs.startup_verification_json`（`db/schema.ts:1600`）| `capturedStartupInventory` + `verifyStartup` | 有 | 有（但 observation 已降维，见 §1.3）|

前端 `RuntimeInventorySection.tsx` 只读前者（`routes/tasks.ts:1115` → `opencode/inventory.ts:144`），拿到 NULL 后走 `{captured:false, reason:'file-missing'}`（`inventory.ts:210`），渲染成上面那句误导文案（`i18n/zh-CN.ts:10304`）。

### 1.2 「运行时清单」这个读面从设计上就是 opencode 专属的

RFC-029 立项时只有 opencode 一个运行时，`shared/src/inventory.ts` 的形状照 opencode dump 插件的输出定死：`agents[].mode`、`skills[].source`、`mcps[].type` 都是必填非空 `z.string()`，还有一张 claude 协议上根本不存在的 `plugins` 表。RFC-111 引入第二个运行时后，读端和 UI 没有跟上。

### 1.3 抽象漏在了调用方——这是本 RFC 的真正标的

「怎么拿清单」确实已经在 driver 层，但「拿到的是什么形状」没有统一契约，归一逻辑漏在了 runner 里。三处硬证据：

1. **归一 switch 长在调用方。** `services/runner.ts:1947-1957` 按 `caps.startupObservation` 分派，把 `InventorySnapshot`（opencode 富形状）和 `StartupInventory`（claude 贫形状）各自转成 `StartupObservation`。两个 driver 各返回各的类型，统一是 runner 做的。
2. **同一个 init 事件被解析两遍。** `parseUnusableMcpServers`（`claudeCode/events.ts:104`）与 `parseStartupInventory`（`events.ts:142`）各自 `JSON.parse` 同一行、各自判 `type==='system' && subtype==='init'`、各自读 `mcp_servers`；runner 里也是两个独立 if 块（`runner.ts:1155` 与 `runner.ts:1176`）逐行各跑一遍。
3. **`wantsInventory` 布尔穿透整条 spawn 上下文**（`runtime/types.ts:383 / 453 / 590`），而 590 行注释自陈 "produce an inventory is the driver's own capability (claude ignores)"——明知只有 driver 自己知道，仍让调用方传开关。

此外 `observationFromInventory`（`execution/startupVerification.ts:106`）把 opencode 的富快照**降维成只剩 name**（丢 mode / model / path / description / source / type / hint，`plugins` 整面丢弃）。那是为「对账」设计的，不是为「展示」——所以统一读面若直接拿 observation 当唯一数据源，会让 opencode 侧丢掉今天已经在显示的字段。

## 2. 目标

1. **统一呈现**：`/agents` 节点详情的「运行时清单」对所有运行时都给出正向清单——本轮实际加载了哪些 agent / skill / MCP / tool / plugin，而不只是「出问题时才响的告警」。
2. **不丢字段**：opencode 现有的全部富字段一个不少；claude 多出 `tools` 面；差异由 driver **静态声明**驱动，不由 UI 猜。
3. **driver 侧收口**：清单获取成为 `RuntimeDriver` 上的**单一能力**，runner 完全 kind-blind。第三个运行时接入时，编译器强制它逐字段表态。
4. **消除误导**：claude 运行时不再显示「插件可能加载失败」。
5. **零 backfill**：存量行（老的 opencode 快照、老的 claude 验证记录）由读端转码直接可读，不回填、不做数据迁移（仅一支加列 migration）。

## 3. 非目标

- 不改变节点成败判定。清单与启动验证都只呈现，不改写进程结果（沿用 RFC-280 用户裁决：业务节点 warn-not-fail）。
- 不新增运行时、不改 spawn 的注入内容、不动 `DeclaredManifestV1` 的语义。
- 不做清单的历史趋势 / 跨 run 对比 / 导出。
- 不接管后端分层归属——见 §7 与 RFC-294 的边界。
- 不改 MCP 测试台（RFC-238 playground）的产品行为，仅随 driver 接口变更同步其调用点。

## 4. 用户故事

- **US-1**：我用 Claude Code 运行时跑了一个挂了 3 个技能、2 个 MCP 的节点。展开「运行时清单」，我能看到这 5 项都在、状态正常，另外还能看到运行时自带的内建 agent 和本轮实际可用的工具集。
- **US-2**：我注入的某个技能没被加载。清单里那一行显示为「已声明未加载」，同时告警 banner 也点名它。我不需要在两个地方猜同一件事。
- **US-3**：我看到清单里有几个我没配过的 MCP。它们标为「运行时自带 / 继承自机器或项目配置」，我立刻知道这不是平台注入的。
- **US-4**：我用 opencode 跑节点，清单和今天完全一样——agent 的 mode/model、skill 的 path、MCP 的 type/hint、plugin 列表一个不少，另外多了一列来源对账。
- **US-5**：我给平台接了第三个运行时。我只需回答一个问题——「你的观测怎么变成事件」；如果漏了一个字段没表态，`bun run typecheck` 直接报错，而不是等到线上界面空一块。

## 5. 用户可见的行为变更清单

本 RFC **不关闭任何既有能力**（CLAUDE.md §能力收缩型 RFC 的附加门槛不适用），但以下用户可见行为会变，逐项列出供确认：

| # | 变更 | 影响面 |
| --- | --- | --- |
| B1 | claude 运行时的节点不再显示「未生成清单文件（插件可能加载失败）」，改为展示真实清单 | 修复误导，纯收益 |
| B2 | 清单表新增「来源」对账列（平台注入 / 运行时自带 / 已声明未加载），**两个运行时都加** | opencode 侧现有 `source` 字面量列保留不变，对账是新增的一列 |
| B3 | claude 运行时新增 `tools` 面（第五块表）；opencode 侧该块**整块不渲染**（协议无此观测） | 不是显示 0，是不渲染 |
| B4 | claude 运行时的 `plugins` 块**整块不渲染**（协议上无插件概念）；opencode 保持原样 | 「不支持」与「0 个」在界面上从此可区分 |
| B5 | 零注入节点（没挂任何技能 / MCP / 子代理）现在也会记录并展示运行时清单 | 今天 claude 侧这类节点数据被直接丢弃 |
| B6 | opencode followup（复用会话、dump 插件未重跑）显示「本轮复用会话，未产生新清单」，而非空表 | 消歧义 |

## 6. 验收标准

- **AC-1**：claude 运行时跑一个带技能 + MCP + 子代理的节点，「运行时清单」展开后四类资源齐全，且每行带来源对账。
- **AC-2**：同一节点改用 opencode 运行时，现有全部字段（mode / model / path / description / type / hint / specifier / source）逐一仍在，无一列丢失或变空。
- **AC-3**：claude 节点的清单面板不出现 `plugins` 块；opencode 节点不出现 `tools` 块。二者都不是「显示 0 条」。
- **AC-4**：平台注入但运行时未报告的资源，在清单里标为「已声明未加载」，且与 `StartupVerificationBanner` 的 missing 行指向同一批名字（同一份判定，不做第二套）。
- **AC-5**：零注入节点在两个运行时下都能看到运行时自带的清单；且**不产生任何告警 banner**（没注入就无所谓「注入未生效」）。
- **AC-6**：opencode followup run 显示明确的「复用会话」文案，不显示空表，不产生「无法验证」告警。
- **AC-7**：存量 run（本 RFC 上线前产生的行）打开清单能正常显示，无需任何数据迁移。
- **AC-8**：`runner.ts` 内不再出现任何按运行时 kind / `startupObservation` 分派清单来源的分支。
- **AC-9**：给 `RuntimeDriver` 的字段表态矩阵新增一个字段而不更新某个 driver 时，`bun run typecheck` 失败（棘轮生效）。
- **AC-10**：同一行 stdout 不再被解析两遍以提取同一份 init 数据。
- **AC-11**：i18n 键树保持编译期完整——`Resources` interface 覆盖全部新增键，`en-US` / `zh-CN` 1:1，界面无英文原始键泄漏。

## 7. 与 RFC-294 的边界

RFC-294（后台最终层次架构总纲，Draft，2026-08-13）要定 `domain/application/engine/ports/infrastructure` 分层与跨模块 port 开放规则，执行域固定为 TaskEngine→WrapperRuntime→NodeExecutor→ExecutionKernel。本 RFC 交付的事件流契约与 pipeline stage 属于 **runtime 模块向执行域暴露的一个 port**。

约定：本 RFC 负责**契约的形状与语义**（事件 kind 与载荷、`drainFinalEvents` 钩子、统一清单类型、字段表态矩阵、stage 划分）；RFC-294 后续接管其**分层归属与文件位置**，且不得在迁移中改变该契约。本 RFC 落地时不新建目录层级，stage 就近落在 `services/runtime/` 与 `services/execution/` 下，等 294 的波次来搬。

选择「RFC-297 一次做完整收口」而非「只做读端、driver 侧留给 294」是用户拍板（2026-08-13）：UI 统一本来就要动 driver 的字段声明，两次动同一个接口不如一次做完；且 294 当前仍是零生产改动的 Draft，此刻对齐成本最低。

## 8. 待用户批准的决策项

以下 D 项已给出推荐方案与理由，请逐项确认或改判。详细技术展开见 `design.md`。

- **D1 统一形状**：核心字段（name + 状态）固定，富字段可选，来源对账三态。推荐照此。
- **D2 字段表态矩阵**：二维 `InventoryDeclaration`（面级 `support` + 面下每个富字段的 `support`）挂在 `driver.capabilities` 上，用映射类型派生，使「新增面」或「新增字段」在任何未表态的 driver 上成为编译错误——与 RFC-282 的 `declarationFaces`（`runtime/types.ts:602-607`）同构。推荐照此。
- **D3 统一事件流 + pipeline**（用户 2026-08-13 裁决，取代初稿的 collector 方案）：driver 只负责把自己的原始形态规范化成 `NormalizedEvent`（claude 的 `system/init` 行走既有 `parseEvent`；opencode 的 `inventory.json` 由新增的 `drainFinalEvents()` 在进程退出后补发成合成事件），消费端是一组**运行时无关**的 pipeline stage。收益：清单组装逻辑从「每个 driver 各写一份」坍缩成一份，每行只解析一次，新增关注点只加 stage。**已采纳**。
- **D4 落库**：新增单列 `node_runs.runtime_inventory_json` 作为**唯一**观测落库目标，`inventory_snapshot_json` 对新 run **停写**（不留第三份冗余），存量行走读端转码。推荐照此，但这是本 RFC 改动面最大的一处——它会波及一批既有 inventory 测试，**需要用户确认**（备选：不新增列、读端从旧两列实时派生，改动小但每次读都要转码，且 claude 的 `tools` 面无处落库）。
- **D5 零注入节点**：放宽 observation 的写入门槛，使其不再受 `declaredHasContent` 门控；verification 判定仍受门控，空 declared 记为「不适用」而非「无法验证」（否则会复活 RFC-280 P2-E 治过的告警噪音）。**需要用户确认**。
- **D6 followup 档位**：`observationRequiresFreshRun` 为真且非 fresh run 时，读端返回明确的「复用会话，无新清单」态。推荐照此。
- **D7 存量数据**：零 backfill——加列 migration 不回填任何存量行，老的 opencode 快照与老的 claude 验证记录由读端一次性转码呈现（老 opencode 行无 declared，来源对账列隐藏而非显示错值）。转码层标注过渡代码，随存量 run 归档 / GC 自然消亡。推荐照此。
- **D8 banner 与面板并存**：职责不同——banner 是「有问题才响」的告警，面板是「随时可查」的清单；两者共用同一份判定，不做第二套差集逻辑。推荐并存。
- **D9 `tools` 面归属**：作为与 agents/skills/mcps/plugins 平级的第五个面，由字段表态决定是否渲染。推荐照此。
- **D10 删除三个 driver 可选方法**（`readInventory` / `parseStartupInventory` / `parseUnusableMcpServers`）：其能力分别并入 `drainFinalEvents()`（读文件补发事件）、`parseEvent()`（init 行一次解析出全部面）与清单组装 stage（MCP 可用性从统一观测算）。属内部重构，无产品能力收缩，但会动到既有测试锁（迁移断言而非删除）。**已随 D3 采纳**。
- **D11 收口边界**：runner pump 里另两处同类二次解析（`parseTerminalResultError` / `observeSystemEvent`）**本 RFC 不动**——它们牵动节点成败判定与 RFC-237 取证契约，混进来会让「清单看不见」的修复被无关风险拖住。按同一方向收进事件流是自然的下一步，在 `docs/audit-backlog.md` 登记一条。推荐照此。
