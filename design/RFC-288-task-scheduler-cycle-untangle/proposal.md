# RFC-288 — task↔scheduler 环拆解（taskDriver，WP-5）（proposal）

状态：Draft（2026-08-13 落档）
来源：`design/system-commons-unification-audit-2026-08-12.md` D3 大件二；原始工作包
=`design/task-execution-architecture-audit-2026-08-03.md` §A3（:182-188）+ WP-5
（:306-312）。⚠️ 命名注意：`design/scheduler-audit-2026-06-10.md:303` 另有一个
「WP-5」（写锁注册表，已随 RFC-098 完成）——本 RFC 指 **2026-08-03 审计的 WP-5**。
现状测绘（2026-08-13 只读子代理，Tarjan 重算 + 全边锚）收录 design.md §1。

## 1. 背景

backend services 里唯一的大值级 SCC：**8 模块环**（task.ts / scheduler.ts /
execution/{executor,outcome} / agentLaunch / workgroup/launch / gc /
callGraph/expandService），由 `scripts/depcheck.ts` KNOWN_VIOLATIONS 前 6 条
记账（removeWhen 全写 WP-5）。环的唯一「上行边」是 `task.ts:114 import
{ runTask } from './scheduler'`（kick）；scheduler 反向对 task 的回边
1 静态 + 3 动态（emitTaskStatus/getTask 静态；cancelTask/resumeTask/
isTaskActive 动态 import 民俗）；另有 workgroup 启动**绕过 executor facade**
的动态边（scheduler.ts:4102，A3 点名）。gc 旁支环（materializingSpaces 共享
Map + expandService.getTask）独立成环共用第 6 条账。

## 2. 目标

**零产品行为变更**。按原始 WP-5 的 3-4 刀拆分：

- **G1 taskDriver 叶子**：新 `services/taskDriver.ts`（真叶子——判据同
  scheduledTaskRefs.ts 先例）：独占 `activeTasks` 注册表 + `emitTaskStatus`
  - 统一 `kickScheduler` 注入面（组合根 cli/start.ts 注册驱动函数）。
    task.ts 的 kick 三点改调 driver；scheduler 的 B1-B4 回边改 import 叶子；
    A1 断 ⇒ C-1..C-6 六个极小环全塌；C1/C2 动态 import 转静态；
    `startWorkgroupTaskFromFrozen` 收进 executor facade 分支、scheduler.ts
    加入 CALL_FACES 清单。`AGENT_HOST_AGENT_NODE_ID` 常量下沉（D7 叶抽取，
    可先行独立小刀）。
- **G2 workspace/materialize 切分**：task.ts:379-1741 物化域迁
  `services/workspace/materialize.ts`（agentLaunch 的 D5 重依赖随迁）。
- **G3 taskReadModel 切分**：`getTask` 等读模型迁 `services/taskReadModel.ts`；
  expandService 的 E3 改 import 读模型（第 6 条账销）；`materializingSpaces`
  Map 下沉 `services/workspaceLeases.ts` 叶子（E1）。
- **G4 归位与锁**：scheduler.ts export 面收缩断言（只允许 runTask/
  RunTaskOptions/buildWorkgroupHooks 级）；「scheduler 禁 import task.ts」
  源锁（抄 rfc257 webhookDispatch 同型）；depcheck 六条销账 + 总数叙述注释
  更新 + gate 测试 fixture 改样例对。

## 3. 非目标

- 不动装配线内部结构（RFC-287 已收敛为骨架——本 RFC 在其后执行，只动
  import 拓扑与模块归属）。
- 不动 fanout 内链（RFC-289）。
- 不引入 TaskStatusObserver 等新抽象（WP-10 后续，依赖本 RFC）。
- 不改 depcruise 规则语义（type-only 豁免保持；no-circular 不得退化为
  pathNot 排除——gate 测试已禁止）。

## 4. 能力影响清单

零能力变化（纯模块拓扑重构；所有公共行为面 API/调度语义不动）。

## 5. 验收标准

- AC-1 值级 SCC 消失：Tarjan 复算 backend services 无 ≥2 成员值级环；
  depcheck KNOWN_VIOLATIONS 前 6 条删除且零新增 unknown。
- AC-2 中间态无双红：每刀 PR 内同步调整账本（详见 design §4 的
  「(rule,from,to) 身份漂移」策略），gate 测试（stale/why/removeWhen 格式）
  全程绿。
- AC-3 行为对拍：92/88 个 import scheduler/task 的测试文件全绿；kick 三点、
  shutdown 的 abortAllActiveTasks、orphanReconcile 的 taskHasDriver seam
  行为逐字节保持。
- AC-4 启动面锁更新：rfc243-executor-facade CALL_FACES + executor 三臂锁、
  rfc257 同型新锁（scheduler 禁 task import）、测试专用出口
  （\_\_setActiveTaskForTesting 族）迁移后全部改锚。
- AC-5 文档账本同步：depcheck 头注计数、2026-08-03 审计 ⓪ 进度回填、
  路线表状态、STATE.md（解封后）。
- AC-6 每刀 pin gate 全绿 + exact-SHA CI 绿；实现门（独立子代理）。
