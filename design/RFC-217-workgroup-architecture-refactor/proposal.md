# RFC-217 工作组架构重构（proposal）

> 状态：Draft　｜　发起：用户 2026-07-22「看下本仓库的工作组实现逻辑……准备进行一轮重构来清晰代码架构」
> 交付形态（用户拍板）：**单 RFC 内分期多 PR**（plan.md 列 PR 拆分）。

## 1. 背景

工作组（workgroup）是 17 个 RFC（164→215）在约两周内快速叠加出来的子系统：后端 ~12.6k 行（`workgroupRunner.ts` 单文件 2748 行、累计 17 个 RFC 印记 / 35 次提交）、前端 ~4.7k 行（`WorkgroupRoom.tsx` 1497 行）。功能已达产（三模式全部真机跑通、RFC-215 双轨调度落地），但架构呈「地质层堆积」形态。2026-07-22 的五路并行架构探查（运行时引擎 / clarify 子系统 / 数据模型与 API / 前端 / RFC 演进史）确认问题成体系：

1. **执行模型表达散射**：`workgroupRunner.ts` 内 15 处 `mode === '...'` 直接比较 + wake/rounds/lifecycle/routes/launch/shared 各自的派生分支；同一个 fc/lw 二分叉在 4 个模块各决策一遍；4 个 turn driver（leader 301 行 / assignment 211 / batch 269 / message 139）复制同一 mint→重试→解析→落库骨架，`clarify-forbidden` 重提示块逐字重复 3 处、协议重试块 4 处；`roundedModeOf(...) ?? 'free_collab'` 静默兜底吞掉 dynamic_workflow 误入守卫（`workgroupRunner.ts:717,787`）。
2. **隐式状态机**：`gate` / `dw` / `wgPause` 三个运行时状态槽塞在 `tasks.workgroup_config_json` 里，`gate`/`wgPause` **无任何 zod schema**，前后端手抠 `gateRaw.declaredDone === true`；同一 blob 三种写法（引擎 tx-merge `workgroupRunner.ts:657` / route 全量覆写 `routes/workgroupTasks.ts:677` / `json_set` 单键）两处入口，并发吞写风险被注释自认（`workgroupRunner.ts:394-397`）。与之对照，assignment 状态机（`workgroupLifecycle.ts:39` 转换表 + CAS）是做对了的范例。
3. **分层越界**：`routes/workgroupTasks.ts` 1432 行，9 个端点 7 个超 30 行业务逻辑，config PUT 单 handler 366 行；5 处裸 `insert(workgroupMessages)` 绕过 service（`workgroupMessages.ts:1-11` 注释自认根因未除）；scheduler.ts 内长出 ~390 行工作组特制 host-node 执行代码（718-1110）。
4. **真实模块初始化环**（`workgroupRounds.ts:12-17` 白纸黑字）：`workgroupLaunch → task → scheduler → workgroupRunner → workgroupRounds → workgroupLaunch`，`.dependency-cruiser.cjs` 无 `no-circular` 规则，只靠「`WG_*_NODE_ID` 只准函数体内引用」的口头约定压着（RFC-079 先例：仅 `build:binary` 能暴露）。
5. **kind 散射**：「这是不是工作组任务 / 哪种模式」用 6 个维度重复推导 20+ 处（`workgroupId !== null` / `launchKind==='workgroup'` / `mode===` / `resourceType='workgroup'` / dispatch 派生 / `__wg_*` 节点 id）。
6. **「round」一词三职**：预算计数器 / UI 分隔线 / 卡片锚定，非单调、fc 消息 round≡0；RFC-209 只在派生层止血、明确不改根语义。
7. **双数据源反复漂移**：assignment 行 vs node_run 行两个事实源，RFC-179→182→209→215 四轮都在修同类 drift（假 done / 漏计 / 误报 working），每轮以「单一事实源回收」收尾——底层双源才是真复杂度。
8. **clarify 三代地层双写未收口**：`clarify_sessions` + `cross_clarify_sessions` 遗留表与统一表 `clarify_rounds` 同时在役（RFC-058 承诺的 T17 从未落地，`clarify.ts:203-207`）；directive 状态散落 4 张表；self/cross 读侧 DTO + broadcast 成对复制，答题路由因无法判 kind 而两个 broadcast 盲调（`routes/clarify.ts:342-361`）；`clarifyMigration.ts` boot 垫片、`question_scopes_json` 休眠列等明确死重量。
9. **前端 god component**：`WorkgroupRoom.tsx` 8 个关注点 / 顶层 11 useState + 5 mutation，composer 6 个 state 放顶层导致每次打字全组件重渲；`workgroupRoomKey` 3 处 useQuery 声明；一批公共原语违规（`design/frontend-primitive-audit-2026-07-21.md` 已点名）。

## 2. 目标

把工作组子系统重组为**边界清晰、单一事实源、可守卫**的架构，同时按「允许语义纠偏」尺度顺手根治已知语义债。四个板块（用户全选）：

- **G1 后端本体**：单引擎 + 分层抽象（主循环 / turnExecution 公共骨架 / lw·fc 策略对象），运行时状态提升为真表 + 转换表 CAS，route 业务逻辑全部下沉 service，模块环斩断并上 CI 守卫。
- **G2 clarify 全量归一**：T17 删双遗留表、读侧全切 `clarify_rounds`、directive 收敛单表、self/cross 服务合并为 kind 泛化单模块、boot 垫片转正式 migration 后删除。
- **G3 前端拆分与原语对齐**：WorkgroupRoom 按关注点拆组件、composer 状态下放、room query 单 owner、`useOwnedEditScope` 提炼公共 hook、修复映射到既有原语的违规项。
- **G4 跨仓判别与命名收敛**：kind 判别单一 oracle + grep 锁、round 三概念显式拆分命名、workgroup/wg/room 命名正字法、死代码清扫。

## 3. 非目标

- **不改产品功能面**：三模式、协议端口（`wg_*`）、合成节点 id（`__wg_*`）、WS 帧（`wg.*`）、API URL 均不变；行为变化仅限 §设计 D-系列逐条明示的语义纠偏。
- **不返工 RFC-215 双轨语义**：批量认领 / 双轨占用 / 预算口径维持。
- **不新建原语审计路线的新组件**（DialogActions / DescriptionList 等归 `frontend-primitive-audit` 的 5-RFC 路线）；本 RFC 只做「映射到既有原语」的违规修复与最小 prop 扩展。
- **不扩崩溃恢复矩阵**：RFC-187 T13 类未闭合窗口不在本轮修（重构中若顺手实锤，登记不折入）。
- **不动普通工作流引擎**（runScope/DAG frontier）；scheduler 只做工作组代码外迁，不改调度语义。

## 4. 用户故事

- 作为维护者，我想在一个 ≤300 行的策略文件里看懂 fc 的全部调度差异，而不是在 2748 行里追 15 个 `mode ===`。
- 作为维护者，我想给完成门（gate）加一个新状态时，改一张转换表 + 一个编解码器即可，而不是同步三种写法、两处入口和前后端各自的手抠解析。
- 作为 reviewer，我想让「route 裸写房间消息」「绕过 oracle 判 workgroup」这类回归被 CI grep 锁直接打红，而不是靠人眼。
- 作为运维者，我升级到本 RFC 之后的版本，存量工作组（含 demo 资产、interrupted 任务）经 migration 后可继续 resume / 查看历史，无数据丢失。

## 5. 验收标准（总目标，逐 PR 细化见 plan.md）

- **AC-1** `workgroupRunner.ts` 不复存在；引擎按 `services/workgroup/` 目标布局分文件，单文件 ≤800 行。
- **AC-2** 4 个 driver 的复制骨架消灭：协议重试块 / `clarify-forbidden` 重提示 / followup 分支各只有一处实现（含 `dynamicWorkflowRunner` 的第 4 份），由源码守卫锁定。
- **AC-3** gate/dw/wgPause 出 JSON 槽：`workgroup_task_state` 真表 + gate 转换表 CAS；全仓无第二处 `workgroupConfigJson` 里 gate/dw/wgPause 的读写（grep 锁）；route 层不再出现 `update(tasks).set({workgroupConfigJson...})`。
- **AC-4** `routes/workgroupTasks.ts` 每个 handler 收敛为 parse+ACL+service 调用；5 处裸 `insert(workgroupMessages)` 与裸 assignment 写消灭（表级 grep 锁）。
- **AC-5** 引擎内 `mode === '...'` 直接比较归零（策略文件内除外）；`?? 'free_collab'` 兜底删除，dynamic_workflow 误入回合引擎 fail-loud。
- **AC-6** kind 判别收敛：裸 `workgroupId !== null` 判定只允许 oracle 模块一处（grep 锁），其余 20+ 处改走 oracle。
- **AC-7** round 三概念在 API / 代码层显式分离命名（budgetUsed / displayRound / dispatchRound），预算判定行为有回归测试证明不变。
- **AC-8** `clarify_sessions` / `cross_clarify_sessions` 两表删除，读侧全走 `clarify_rounds`；directive 唯一真理源 `task_node_clarify_directives`；答题路由双盲调 broadcast 消灭；`clarifyMigration.ts` / `question_scopes_json` 清除。
- **AC-9** dependency-cruiser 增加 `no-circular` 规则且全仓绿；每个触碰模块边界的 PR 跑 `build:binary` smoke。
- **AC-10** `WorkgroupRoom.tsx` ≤400 行；composer 状态下放子组件；`workgroupRoomKey` 单一 useQuery owner；`useOwnedEditScope` 提炼为公共 hook。
- **AC-11** 全程真子进程 e2e（rfc186/187 家族）不 stub 化、持续绿；每个行为纠偏点有先红后绿的回归测试。
- **AC-12** 兼容：migration 后存量工作组资产（含 daemon DB 里的 demo 工作组）可用；migration 前处于 `interrupted` / `awaiting_*` 的工作组任务可正常 resume。

## 6. 风险与缓解（摘要，详见 design.md §失败模式）

- **锁面巨大**：clarify 相关 ~90 个测试文件、工作组家族 50+；按 PR 分期逐步重写，每期「先盘锁、再改码」（[feedback_grep_locks_before_push]）。
- **并发开发冲突**：本仓多 session 并行；每 PR 精确 pathspec 提交，重构期间 runner/scheduler 大搬家 PR 尽量单日内完成并推送。
- **模块环**：搬家顺序错误可能引爆初始化环；PR-1 先立 `no-circular` 守卫 + 常量外迁，再动其它。
- **存量数据**：migration 必须 backfill gate/dw/wgPause 与 clarify 双表数据；journal `when` 接合成轴、multi-statement 加 breakpoints（[reference_journal_when_must_be_monotonic] / [reference_migration_statement_breakpoint]）。
