# RFC-280 · 统一 agent 进程执行与资源注入收拢

- 状态：In Progress（2026-08-11 用户批准）
- 日期：2026-08-11
- 发起：用户指令「统一整个平台的所有 agent 执行链路，收归统一，所有资源注入能力全部收拢」。
  起因是两起同症状、不同根因的「agent 找不到 MCP」故障排查（本机 MCP 测试台 × 旧
  launcher 身份门残留；另一环境业务链路 × agent 未引用 MCP），排查揭示 spawn 层存在
  5 条平行链路、3 套执行器骨架、4~6 套资源注入转换实现，且「声明注入 ≠ 实际加载」
  在多数链路上完全无验证。
- 决策记录（用户已拍板，2026-08-11）：
  1. 统一档位 = **最大档**：连 runner 也并，执行器骨架收敛为 1；
  2. 业务节点上注入的 MCP 未连接成功 = **不 fail，节点级持久告警**（UI 可见）；
  3. MCP 测试台上被测 MCP 未连接成功 = **显式 fail**（测试台的唯一目的就是验证 MCP）；
  4. 盘点揪出的 6 项相邻落差 **全部纳入**（见 §4）；
  5. remote MCP URL 内嵌凭据（`https://user:pass@host`）**全部放行**——「配凭据是
     个人选择」；测试台现有的 userinfo 拒绝分支随收编删除（设计门 P1-6 的裁决）。
- 设计门：2026-08-11 Codex 对抗评审 7×P1 + 2×P2，已全部修订进 v2 三件套
  （落点索引见 design.md §9）。
- 相关设计：RFC-243（统一执行器——**任务调用层**，与本 RFC 正交，见 §6 边界）、
  RFC-238（MCP 运行时测试台）、RFC-029（opencode inventory 插件）、RFC-242（claude
  权限映射与 init 事件）、RFC-117/237（systemAgentRun）、RFC-276（runtime 硬化退役，
  本 RFC 不回退其立场）、RFC-228（MCP exact-set 围栏）。

## 1. 背景

平台今天有 5 条会 spawn runtime 子进程（opencode / claude CLI）跑 agent 的链路：

| # | 链路 | 执行器骨架 | 注入面 | 启动后校验 |
|---|------|-----------|--------|-----------|
| 1 | 业务节点（scheduler 6 个入口：DAG 主线 / fan-out shard / aggregator / commit-push / merge / workgroup host） | `runner.ts` | 全量 | claude MCP 仅 daemon 日志 warn；opencode 无 |
| 2 | 系统 agent（intent 回合引擎 / change-narrative） | `systemAgentRun.ts` | 仅 persona+model | 仅 terminal-error |
| 3 | MCP 运行时测试台 | systemAgentRun + 独立 `mcpTest` capability | 恰好 1 个 MCP | 零 |
| 4 | runtime 冒烟探针 | 自建骨架（手抄 timeout/kill 链） | 仅 persona | 零 |
| 5 | 记忆蒸馏器 | 自建骨架 | 仅 persona | 零 |

资源注入转换是平行实现：**MCP 行 → wire 形状 4 套、agent 定义 → runtime 配置 6 套、
skill 注入 3 套**。校验面更弱：`parseStartupInventory` 是死代码（claude driver 注释声称
runner 会用启动清单证明注入生效，实际无消费方）；opencode 业务链路连
`declaredMcpServers` 都不产出；MCP 测试台注入了 MCP 却零验证。

**用户可感知的病灶**：任何一层出问题（MCP 进程起不来 / 被 disabled 静默跳过 / agent
没引用），最终呈现全部是「agent 口头说找不到工具」，节点/测试 turn 照常“成功”。
`docs/dev-gotchas.md` 早已沉淀教训：「能力丢失必须做成节点级显式失败，否则没人会发现」。

## 2. 目标

1. **执行器骨架收敛为 1**：新的统一 agent 进程执行器承担 spawn / stdout·stderr pump /
   timeout→TERM→KILL / 事件解析分发 / PID 记账 / reap / 清理；runner、systemAgentRun、
   smoke、distiller、MCP 测试台全部改为其消费方，删除各自手抄的进程管理代码。
2. **资源注入收拢为单层**：agent 定义、MCP、skill、plugin、dependsOn 闭包、permission、
   runtime 参数、memory 块 → 每类资源**一个**转换实现，per-runtime 渲染；产出
   **声明注入清单**（declared manifest）作为验证依据。
3. **启动验证成为一等公民**：声明清单 × runtime 启动清单（claude init 事件 / opencode
   inventory）→ 结构化验证结果；各消费方按既定语义处理：
   - 业务节点：**持久化节点级告警**（`node_runs` 新列 + 节点详情 UI banner），不 fail；
   - MCP 测试台：被测 MCP 未连接 → turn **显式 fail**（独立 failureCode）；
   - 其余链路（无注入声明）自然为空。
4. 6 项落差随统一层一并收口（§4）。

## 3. 非目标

- 不动 RFC-243 的任务调用层（发起 / 结果投影 / 等待终态 / 取消、call-workflow /
  call-workgroup）。本 RFC 只管「一次 agent 子进程 spawn 的资源注入与启动验证」。
- 不合并 scheduler 的两种推进引擎（runScope / runWorkgroupEngine）。
- 不回退 RFC-276 立场：不新增二进制身份门 / 私有 HOME / 网络围栏 / OS sandbox。
- 不改变 runtime 自身的 config 合并语义（machine/project 配置继承照旧）。
- 不新增跨 runtime 的能力（如给 claude 造 plugin 面）；能力缺口只做**显式化**（告警），
  不做填补。

## 4. 随附收口的 6 项落差（用户已确认全部纳入）

1. `parseStartupInventory` 死代码接上：skill / subagent / tool 注入面获得启动后验证。
2. opencode 补齐 MCP 可用性观测（由统一声明清单 + RFC-029 inventory 的 `mcp.status()`
   产物驱动，替代仅 claude 产出的 `declaredMcpServers` 字段）。
3. disabled-MCP 引用不再静默跳过：进入声明清单的 `skippedDisabled`，业务节点级告警可见。
   （注意：闭包内**不同 id 同 enabled name** 的既有 spawn 前 fail-fast——
   `scheduler.ts:9216` exact-identity 围栏——**原样保留**，不降级为告警；
   设计门 P1-1 裁定该场景是身份冲突，必须阻断。）
4. claude 侧静默丢弃 `variant/temperature/steps/maxSteps` → 显式告警（对齐 plugin 的
   `claude-plugins-unsupported` 处理方式）。
5. smoke / distiller 的 OS tmpdir 运行目录迁到 appHome scratch，GC 归属统一。
6. `mcpTest` 平行 spawn 契约（`RuntimeMcpTestCapabilityV1`）并回 `RuntimeDriver`，
   第三个 runtime 只需实现一套接口。

## 5. 用户故事

1. **MCP 作者**在测试台跑一轮：MCP 起不来时，turn 直接 fail 并给出
   `mcp-test-mcp-unusable` + runtime 报告的原因，而不是 agent 礼貌地说「我没有这个工具」。
2. **工作流作者**的节点引用了 3 个 MCP，其中 1 个在运行时没起来：节点照常执行，
   但节点详情出现持久告警「rag-search 未连接，本次运行缺少其工具」，任务列表可见标记。
3. **平台开发者**新增一类资源注入（或第三个 runtime）：只改统一注入层的一个实现 +
   driver 的渲染钩子，5 条链路同时生效，且启动验证自动覆盖。
4. **运维者**排查「agent 说找不到 X」：节点详情的声明清单 vs 实际加载对照表直接给出
   是「没声明」「声明了但 disabled」还是「注入了但没起来」。

## 6. 与 RFC-243 的边界

RFC-243 统一的是「**发起一次任务执行**」（ExecutionRef → taskId → 结果投影/取消），
本 RFC 统一的是任务内部「**发起一次 agent 子进程**」（资源注入 → spawn → 启动验证 →
事件流）。两者在 `services/execution/` 命名空间内分层共存：RFC-243 的产物是任务层
原语，本 RFC 的产物是进程层原语；scheduler 经 RFC-243 选定要跑什么之后，经本 RFC
把 agent 进程跑起来。互不阻塞，可独立推进。

## 7. 行为变更声明（呈用户确认）

本 RFC 无能力收缩（不关闭任何既有能力），有 4 处可观察行为变更：

1. MCP 测试台：被测 MCP 未连接从「turn 成功 + agent 口头说找不到」变为「turn fail +
   显式 failureCode」；观测源缺失/损坏同样 fail（`mcp-test-verification-unavailable`，
   不 fail-open）；timeout/取消等 durable 失败码优先不被覆盖。（用户已确认）
2. 业务节点：新增持久告警面（纯增量，不改变节点成败判定；验证器不改写进程结果）。
   （用户已确认）
3. smoke / distiller 运行目录从 OS tmpdir 迁到 appHome scratch（对外不可见，
   影响本机磁盘位置与 GC）。（用户已确认）
4. MCP 测试台不再拒绝 remote URL 内嵌凭据（userinfo）——与业务链路对齐全部放行，
   属**能力扩张**。（用户已拍板：「配凭据是个人选择」）

## 8. 验收标准

1. 全仓只剩 **1 个** spawn agent 子进程的执行器实现；`runtimeSmoke.ts` /
   `memoryDistiller.ts` / `runner.ts` / `systemAgentRun.ts` 中手抄的
   spawn/pump/timeout/kill/reap 代码删除。
2. 每类资源（agent 定义 / MCP / skill / plugin / subagent / permission / 参数 /
   memory）在仓内**恰好一个**「DB 形状 → 注入意图」实现；per-runtime 差异只存在于
   driver 的渲染钩子。
3. 所有注入 MCP 的链路都产出声明清单并做启动验证；业务节点告警落库可查、UI 可见；
   测试台 fail 语义生效。
4. `parseStartupInventory` 有生产消费方；`grep -rn 'parseStartupInventory' src | grep -v 定义文件`
   非空。
5. 既有行为锁测试（runner-* 系列 / golden spawn / mcp-end-to-end / rfc238 测试台系列 /
   smoke / distiller）全绿；argv/env 的字节级变化仅限 design.md §7 列出的有意变更。
6. `bun run gate:local` 全绿；新增测试覆盖 §7 全部行为变更与 §4 全部落差项。
