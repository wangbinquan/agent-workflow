# RFC-061 — node 执行模型事件溯源化（产品视角）

## 状态

**Draft** — 等用户批准 + RFC-060 完工后进入 PR-A。

## 前置条件

RFC-060 (Fanout as Wrapper) 全部 6 PR 必须先合并落 main。本 RFC 启动时假定：

- `wrapper-fanout` NodeKind 已存在
- `agent-multi` NodeKind 已删除
- 参数化 `path<T>` / `list<T>` kind / `signal` output kind 已生效
- `agent.role: 'aggregator'` frontmatter 已支持
- wrapper-git 的 `git_diff` port 已升级为 `list<path>`

RFC-061 在 RFC-060 既有 NodeKind 集合上做**执行模型重写**——不再增减 NodeKind，只改 NodeKind 是怎么被驱动的。

## 自由断代原则

系统未上生产、无历史数据负担、无字节级行为守恒义务。本 RFC 因此**不做 dual-write、不做 backward compat、不做 byte-for-byte UI 守恒**——只追求最优终态：

- 老 7 张表（`node_runs / node_run_events / node_run_outputs / clarify_sessions / clarify_rounds / cross_clarify_sessions / doc_versions`）在 PR-B 一次性 DROP
- 老 6 个 services（`scheduler.ts / clarify.ts / crossClarify.ts / clarifyRounds.ts / clarifyFallback.ts / review.ts` + `lifecycle.ts` RFC-053 P-1）在 PR-B 一次性删除
- frontend DTOs / 路由 / WS 在 PR-C 全面重写
- 历史 fixup scripts (`fixup-rfc052-*.ts / fixup-rfc056-*.ts`) 在 PR-D 完全删除（断代后结构性不再需要）
- UI 形态允许变更——事件溯源带来的天然能力（events timeline 视图）作为新功能补进 PR-C

## 背景

RFC-052（review retry cascade stuck）/ RFC-053（lifecycle hardening）/ RFC-056（cross-agent clarify 五份补丁 + 2 个 fixup 脚本）/ RFC-057（diagnose repair）累计 9 个月治了四类反复发生的 bug：**task 卡死 / 输出陈旧 / cascade 遗漏 / clarify 历史污染**。RFC-053 §背景 §1-6 已经把根因总结为 6 类结构性温床：

1. `node_runs.status` 没有状态机
2. 同一 nodeId 多行 + 各模块用不同 selector
3. 跨 kind 普适操作硬编码
4. review / clarify 双层状态（node_runs ↔ doc_versions / clarify_sessions / cross_clarify_sessions）
5. 关键路径靠 fire-and-forget
6. 缺跨模块一致性的 property-based 测试

RFC-053 已落 P-1 + P-3 + P-6 + RFC-057 共 4 层兜底，但**结构性温床 ①②③⑥ 仍裸露**——最直接证据：2026-05-22 → 05-26 RFC-056 连续 5 天 5 份补丁，加 2 个一次性 fixup 脚本。每次根因都是"某 dispatcher 短路忘了看某 counter"或"某 mint 路径漏继承某 counter"，同源 bug 反复出现。

本 RFC 把状态模型从 *mutable row + CAS + 5 类计数器手抄继承 + N 个 dispatcher 各自挑当前行* 重写为 *events 是唯一真值源 + projection 自动维护 + 单 actor per task + 双层 KindHandler 表*——一次性把 6 类温床中的 ①②③④⑥ 全部结构性消解到"代码上不可能再犯"。温床 ⑤（fire-and-forget）由单 actor + 事件队列自然消解。

## 目标

- **G1 events 成为唯一真值源** —— 所有状态变化是 append-only 事件；今日的 5 张可变表全部退化为 events 的 projection；可任意 replay 重建。
- **G2 计数器塌缩为 1 个 iter + 2 个 scope 轴** —— `retry_index / clarifyIteration / crossClarifyIteration / reviewIteration` 合一为单一 `iter`；`(loopIter, shardKey)` 留作结构性 scope 轴。`isFresherNodeRun` heuristic 退役；挑当前 run 改为 `WHERE scope=? ORDER BY iter DESC LIMIT 1` 单一 SQL。
- **G3 4 类外部信号统一原语** —— self-clarify / cross-clarify / review / retry 全部走 `Suspension { signalKind, payload, awaitsActor }` + `Resolution { resolutionId, payload }`；闭合 6 类 SignalKind 枚举；scheduler 不感知具体 kind，per-kind 业务由 SignalKindHandler 表注册。
- **G4 双层 KindHandler 完整版** —— RFC-053 P-2 落到实处：NodeKindHandler / SignalKindHandler 各自 TypeScript exhaustiveness-checked；新增 NodeKind / SignalKind 编译器强制实现全部接口方法。
- **G5 单 actor per task** —— 每 task 一个 async actor 顺序消费 wake 事件队列；`scheduler.ts` 3160 行单体**整体删除**；task 内零 race、零 `writeSem` / `Promise.all` 时序假设。
- **G6 lazy cascade** —— `cascadeDownstreamFromDesigner` / `applyCrossClarifyFreshnessInvariant` / `rescanScopeForNewPendingRows` 三层兜底全部下台；下游 ready check 改为 `my.iter < max(upstream.iter)` 单 SQL 谓词。
- **G7 aging 单一纯函数** —— `buildPromptFromEvents` 内 `fromIter >= max(attempt-output-captured.iter)` 谓词；今日 `computeHistoryCutoff` + 3 consumerKind 分支跨 4 文件实现塌缩为 < 30 行纯函数。
- **G8 daemon 重启零人工介入** —— in-flight attempt 自动 emit `attempt-finished-crash` + `retry-pending-auto`；用户视角 task 几秒后继续；零 fixup 脚本介入。
- **G9 frontend 解锁事件溯源原生 UX** —— events timeline 视图（`/tasks/:id/timeline` 路由）：用户首次看到 task 的完整 audit timeline，含每次 retry / clarify / cross-clarify / review 决策的精确时序。这是事件溯源架构相对今日 mutable row 的**独有优势**，PR-C 内交付。

## 非目标

- **不再增减 NodeKind** —— RFC-060 已经收口 NodeKind 集合（input / output / agent / review / clarify / clarify-cross-agent / wrapper-git / wrapper-loop / wrapper-fanout）；本 RFC 只换驱动模型，不动 NodeKind 列表。
- **不重写 frontend xyflow 画布业务路径** —— 画布拖拽 / NodeInspector / 编辑器布局不动；只在 PR-C 改 detail / inbox / diagnose 三个详情页的数据源 + 增加 events timeline 视图。
- **不引入新依赖** —— bun + sqlite + drizzle 不变；事件 fold 手写。
- **不做实时事件推送 latency 优化** —— v1 仍用 WS broadcaster 推 events 增量；event stream 直推 latency 优化是后续 RFC。
- **不做 dual-write、不保留 fallback / legacy path** —— 系统未上生产，硬切代价 = 测试代价；无产品代价。
- **不重写 opencode 子进程交互** —— `runner.ts` spawn opencode + envelope parsing + RFC-049 端口验证保留；只是其 status / counter 写入 events 而不是 node_runs。

## 用户故事

- **设计师**：点 approve / iterate / reject 立刻看到下游进度；不再有 "approve 后冒出 v(n+1)" / "cross-clarify 答了但 review 永远不重审" 这类 RFC-052/056 patch 反复治过的回弹。任务详情页新增 timeline 视图直接看到完整决策时序。
- **运维**：task 卡死时 `SELECT * FROM events WHERE task_id=? ORDER BY ts` 就是完整 timeline；不需要跨 5 张表 join 推断；fixup 脚本永远不再写。
- **未来加 SignalKind 的开发者**：改 `SignalKind` union 一行 → 编译器在 `SIGNAL_KIND_HANDLERS` 表上报缺失项 → 必须实现 6 个 method → 自动接入 aging / cascade / WS / diagnose。
- **未来加 NodeKind 的开发者**：改 `NodeKind` union → `NODE_KIND_HANDLERS` 表 + 5 method 同款编译期报缺。
- **第一次接手系统的工程师**：核心模型一张图（4 原语）+ 5 行不变量（INV-1..INV-5）+ 主循环 < 200 行 + 每 handler < 250 行；学曲线显著低于今日 `scheduler.ts` 3160 单文件 + 9 个 dispatcher 分支 + 6 层兜底机制。

## 验收标准

1. **PR-A 落地：events + 5 projection 基础设施 + 测试 baseline** —— migration 0033 建 events + 5 projection 表；event-applier + projectionRebuilder 实现；property 测试 ≥ 100 case 验证 INV-1..5；e2e baseline 20 spec 锁今日所有 user-visible flow；不动 hot path。
2. **PR-B 落地：backend 硬切** —— 10 NodeKindHandler + 5 SignalKindHandler 全员上线；taskActor 接 hot path；7 张老表 DROP（migration 0034）；6 个老 services 文件**删除**；scheduler.ts 文件**删除**；backend REST 全切到 projection 读路径。
3. **PR-C 落地：frontend 硬切 + events timeline 视图** —— wire DTO 全面重写；路由 /clarify, /tasks/:id, /reviews/:id 切到 projection 读；WS broadcaster 切 events 流；新增 `/tasks/:id/timeline` 路由展示完整 events 时间线。
4. **PR-D 落地：收尾** —— 所有 grep guards 锁住（禁老表名 / 禁老 service 名 / 禁退役 helper）；scripts/fixup-* 完全删除；RFC-052/053/056 patch md 标 Superseded by RFC-061；STATE.md / 索引收尾；RFC-061 状态 Done。
5. **回归套件**：
   - 现有 backend ≥ 1900 + frontend ≥ 1900 case 全部改写后全绿；
   - RFC-005 / RFC-023 / RFC-042 / RFC-049 / RFC-052 / RFC-056 / RFC-058 / RFC-059 / RFC-060 既有功能行为全绿（schema 改名但行为等价）；
   - 新增 property-based 套件 ≥ 100 case 覆盖 5 类性质。
6. **结构性 bug 模式守门** —— 5 类老 helper 在 src/ grep 0 命中：`isFresherNodeRun` / `cascadeDownstreamFromDesigner` / `applyCrossClarifyFreshnessInvariant` / `rescanScopeForNewPendingRows` / `computeHistoryCutoff`。
7. **5 条不变量 INV-1..INV-5**（见 design.md §13）由 schema CHECK / UNIQUE / FK / event-applier 守护，property test 验证每条永真。
8. **CI 全绿** —— typecheck + lint + format + test + e2e + visual baseline + single-binary smoke 六 jobs 全绿。

## 工作量预估

- **PR-A**（基础设施 + 测试 baseline）≈ 2 周
- **PR-B**（backend 硬切：handler 全员 + 删 6 services + drop 7 表）≈ 3 周
- **PR-C**（frontend 硬切 + events timeline）≈ 1.5 周
- **PR-D**（收尾 + grep guards + STATE.md）≈ 0.5 周

**累计 ≈ 7 周**，4 PR 强序、每 PR 独立 CI 全绿。

## RFC-060 关系

RFC-060 是本 RFC 的 **prereq**——必须先完工合并。本 RFC 在 RFC-060 完成的 NodeKind 集合 + parametric kind + signal port + aggregator role 上做执行模型重写，不会回头改 RFC-060 的设计。RFC-060 PR-A 已落（commit `0b01149`），剩余 PR-B..F 继续按 RFC-060 原计划推进。

RFC-060 完成后状态切到 **Done**；本 RFC 启动后 RFC-060 的 scheduler.ts 业务代码（runFanOutNode 等）在 PR-B 随老 scheduler.ts 整体删除——但这是预期的"重写下层驱动"，不是"推翻 RFC-060 设计"。

## 与今日 RFC 的整体关系

| RFC | 命运 |
|---|---|
| RFC-005 (human review) | 业务语义保留；实现重写为 review NodeKindHandler + SignalKindHandler |
| RFC-023 (self-clarify) | 业务语义保留；实现重写为 clarify NodeKindHandler + self-clarify SignalKindHandler |
| RFC-026 (clarify inline session) | 业务语义保留；inline session 决策成为 self-clarify SignalKindHandler 内细节 |
| RFC-042 (envelope follow-up) | 业务语义保留；同 session followup 成为 retry-pending-auto SignalKindHandler.autoResolve 内逻辑 |
| RFC-049 (port content repair) | 业务语义保留；端口验证 + per-kind repair 不动；retry 走 retry-pending-auto |
| RFC-052 (review retry cascade stuck) | **结构性消除**——RFC-061 grep guard 锁 `dispatchReviewNode` `alreadyDone` 不存在 |
| RFC-053 (lifecycle hardening) | P-1 (lifecycle.ts CAS) 退役（events 是单一写者）；P-2 (KindHandler 表) 落实为 NodeKind+SignalKind 双层；P-3 (invariants) 保留为 anomaly 探测；P-6 (stuck detector) 保留 |
| RFC-056 (cross-clarify + 5 patches) | **结构性消除**——5 份补丁治的 bug 全部不能再发生 |
| RFC-057 (diagnose repair) | 保留为兜底操作面板；正常运行永不需要 |
| RFC-058 (clarify sessions unification) | clarify_rounds 表已统一；本 RFC 进一步统一到 suspensions projection；RFC-058 缺口 1/2 结构性不存在 |
| RFC-059 (per-question scope) | 业务语义保留；scope 字段成为 cross-clarify SignalKind 的 resolution payload 字段 |
| RFC-060 (fanout as wrapper) | prereq，先完工；NodeKind 集合 + parametric kind 等成果保留；执行模型重写在 RFC-061 |
