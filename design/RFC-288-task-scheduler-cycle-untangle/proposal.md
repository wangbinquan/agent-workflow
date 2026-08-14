# RFC-288 — task↔scheduler 环拆解（按 RFC-294 §5.2 重写）（proposal）

状态：Draft（2026-08-13 初稿；**2026-08-14 双半场 Codex 设计门后按 RFC-294 §5.2 / §16.2 整体重写**）
来源：`design/system-commons-unification-audit-2026-08-12.md` D3 大件二；原始工作包
=`design/task-execution-architecture-audit-2026-08-03.md` §A3（:182-188）+ WP-5
（:306-312）。⚠️ 命名注意：`design/scheduler-audit-2026-06-10.md:303` 另有一个
「WP-5」（写锁注册表，已随 RFC-098 完成）——本 RFC 指 **2026-08-03 审计的 WP-5**。
**锚基线：HEAD `01d2160e`**（初稿锚 `da706b19` 已漂 160 个提交；逐条对照见
design.md §12）。

## 1. 背景

backend services 里唯一的大值级 SCC：**8 模块环**（task.ts / scheduler.ts /
execution/{executor,outcome} / agentLaunch / workgroup/launch / gc /
callGraph/expandService），由 `scripts/depcheck.ts` KNOWN_VIOLATIONS 前 6 条
记账（removeWhen 全写 WP-5）。环的唯一**闭环上行边**是 `task.ts:153 import
{ runTask } from './scheduler'`（A1）；scheduler 反向对 task 的回边 1 静态
（`:205` emitTaskStatus/getTask）+ 3 动态（`:3485/:3526/:3547`
cancelTask/resumeTask/isTaskActive）；另有 workgroup 启动**绕过 executor
facade** 的动态边（`:4181`，A3 点名）。gc 旁支环（materializingSpaces 共享
Map + expandService.getTask）独立成环共用第 6 条账。

**初稿之后运行期事实已变（设计门实测）**，这是本次重写的根因：

- **active-task 注册表早已不是一个 Map**：RFC-303 把它抽成
  `modules/task-execution/ports/taskDriverSupervisor.ts` 的 `TaskDriverSupervisor`
  合同 + `infrastructure/inMemoryTaskDriverSupervisor.ts` 适配器（generation
  ticket / 精确 owner release / unreaped receipt）；`task.ts:235` 只持实例。
  初稿里的 `activeTasks: Map<string, ActiveTaskHandle>` 与 `ActiveTaskHandle`
  在仓内**不存在**。
- **`abortAllActiveTasks` 不是无参 void**：`task.ts:330` 现为
  `(reason?: string): string[]`，`shutdown.ts:28` 传
  `DAEMON_SHUTDOWN_ABORT_REASON`——它决定终态是可恢复的 `interrupted` 而不是
  用户 `canceled`（RFC-202 语义）。
- **kick 是四点不是三点**：`task.ts:2919`（startTask/deferred continuation）、
  `:3701`（resumeTask）、`:4252`（**RFC-287 AC-11 retryRepoPreparation**）、
  `:4832`（retryNode）；计数锁已在
  `rfc103-launch-config-passthrough.test.ts:172-180`。
- **物化域已被 RFC-287 改形**：`ensureCachedRepoIdentity` / 同步
  `materializeSpace` / `runDeferredRepoPreparation` 形成了初稿行区间之外的
  第二组关键调用。

**RFC-294 已对本 RFC 作出裁决**（`design/RFC-294-.../proposal.md:242` §5.2 +
`design.md:2922` §16.2）：目标必要，但初稿的 `taskDriver` 单叶子同时装 active
registry、status publisher、kick/cancel/resume service locator，把三个不同生命
周期的能力塞进一个新的 process-global 叶子，**必须按 RFC-294 重写**；且
「P0-D 先落 canonical durable ownership/fence，RFC-288 只迁四件合同的
owner/consumer/import 拓扑并复用 P0-D authority，不新建第二套 lease/schema」是
**已固定的批准路径**，不是实施时可临场选择的分支。

## 2. 目标

**零产品行为变更**（G6 三族环外扩同样是纯 import 拓扑）。

- **G1 四件合同替代单叶子**（RFC-294 §5.2 逐字要求）：
  - `TaskRuntimeRegistry`——只拥有本进程 active handle 与 abort reason；实现
    复用现有 `TaskDriverSupervisor` 端口 + `InMemoryTaskDriverSupervisor`
    适配器，**不降级回 Map**（generation ticket / 精确 controller release /
    unreaped receipt / `abort(reason)` 全部保真）。
  - `TaskOwnershipPort`——lease/epoch/fencing。**复用 P0-D 落地的 canonical
    authority**，本 RFC 不新建第二套 lease 或 schema。
  - `TaskStatusPublisher`——只消费已提交的 domain event 再广播；`emitTaskStatus`
    （`task.ts:4875-4899`，实测只依赖两个 broadcaster + shared `Task` 类型）
    是它唯一的机械载荷。
  - `SchedulerDriverPort`——kick/cancel/resume 的窄端口，**由 application 经
    `TaskExecutionModule` 实例显式注入**；未装配时在 bootstrap **fail-fast**。
    初稿的模块级 `registerSchedulerDriver` + 全局 `driver` + 「未注册即响亮
    throw」被废弃（理由见 §4 与 design.md §3）。
  - 四件均落 `modules/task-execution/`，A1 与 B1-B4 随之断开；C1/C2 转静态。
  - `AGENT_HOST_AGENT_NODE_ID`（`agentLaunch.ts:60`，消费者
    `execution/outcome.ts:25,160`）下沉为 task-execution node/domain owned
    type，**不再落平铺 `services/`**；可先行独立小刀。
- **G2 workspace / materialization 符号级迁移**：按**符号清单**（不是行区间）
  迁出物化原语，`runDeferredRepoPreparation` 等 RFC-287 编排留在 application
  层经 source-control materialization port 调用（清单见 design.md §4）。
- **G3 task read model 分域**：窄义 `getTask`（`task.ts:4901-4941`，实测无编排/
  写路径调用）迁 application queries；archived events / stdout 的 FS 读、
  `getTaskDiff` 的 Git 调用**分别归 log/artifact query 与
  source-control/workspace-insight**，不许整族塞进一个 read model
  （清单见 design.md §5）。`expandService` 改 import 读模型（E3 断，第 6 条账销）。
- **G4 scheduler 纯符号归位刀 + export 收缩锁**：先按 export inventory 把
  `Frontier`/`deriveFrontier`/`buildContainerMap`/`isFresherNodeRun`/envelope-retry/
  prior-output/upstream-inputs/wrapper-iso/fanout-key 各归 owner 并逐符号改锚
  （**28 个测试文件 + 生产消费者 `lifecycleRepair/options-S1.ts:24`**，清单见
  design.md §6），consumer 清零后才上白名单收缩锁。
- **G5 gc 旁支**：`materializingSpaces` 与
  `finishClaimedWebhookWorkspacePrune`（同在 `task.ts:100` 一条 import 里）
  **一并迁走**，`task→gc` 值边真正消失。
- **G6 services 零值级环外扩**（用户 2026-08-14 决策）：一并拆掉另外三族值级
  SCC——`agent↔agentDeps↔agentResourceIntegrity`（3 成员）、
  `gitRepoCache↔repoGroup`、`workflow↔workflow.validator`。各自**独立成刀、
  可单独回退**，只动 import 拓扑不动 owner 归属。
- **G7 归位与锁**：「scheduler 禁 import task.ts」源锁（抄 rfc257 同型）+
  CALL_FACES 更新 + depcheck 六条销账 + 头注计数与文档账本同步。

## 3. 非目标

- 不动装配线内部结构（RFC-287 已收敛为骨架）。
- 不动 fanout 内链（RFC-289，已按 RFC-294 §5.3 冻结）。
- **不新建 durable ownership / lease / schema**——那是 P0-D 的范围（RFC-294
  §16.2 明令：若要把 ownership/schema/fencing 并回本 RFC，必须先显式 Supersede
  该决策与本三件套并重新请批）。
- 不改 depcruise 规则语义（type-only 豁免保持；no-circular 不得退化为 pathNot
  排除——gate 测试已禁止）。
- 不做 RFC-294 W9 的全局 container 清仓；本 RFC 只把最小
  `TaskExecutionModule` instance 落到**当前** composition root。

## 4. 能力影响清单

**零能力变化**，但以下五项是「零」的前提，逐条为设计门 P0 的直接结论：

| 必须保真的行为 | 若按初稿实现会怎样 | 锁在哪 |
| --- | --- | --- |
| `abort(reason)` → `interrupted`（daemon shutdown）而非 `canceled` | 初稿 `abortAllActiveTasks(): void` 丢掉 reason，daemon 重启后任务不再可恢复 | `rfc202-source-locks.test.ts:16-23,35-40` |
| 精确 generation / stale controller 拒绝 | 旧 controller 可能释放新 owner 的槽位 | `rfc303-runtime-ownership.test.ts:27-71` |
| stop ticket：cancel 必须等确切 driver 停 | cancel 只改 DB，child driver 继续跑并写盘 | 同上 |
| unreaped receipt（`child-unkillable`） | 结果丢失，工作区清理与子进程判定失真 | 同上 |
| frozen workgroup 不重读 live resource | 破坏父任务冻结闭包 / 被 node-invoker guard 拒 | `rfc243-call-workgroup.test.ts:129` |

另外**两项**不是行为变更但必须登记：`SchedulerDriverPort` 改为实例注入后，
「未装配」从**运行期静默错判**变成**bootstrap 启动失败**（这是修正，不是收缩：
初稿的运行期 throw 会被 `scheduler.ts:3487` / `:3528` 的裸 `catch` 吞掉，表现为
「取消看起来成功、child 仍在跑」）；G4 收缩前必须先把 `buildContainerMap` 等
有真实消费者的符号归位，否则 typecheck 直接红。

## 5. RFC-294 对齐（强制章节）

落位表（context / 层以 RFC-294 `design.md` §2 目标物理结构与 §18 owner 表为准）：

| 本 RFC 新增/迁移 | bounded context | 层 | RFC-294 依据 |
| --- | --- | --- | --- |
| `TaskRuntimeRegistry` | task-execution | ports（合同）+ infrastructure（进程内适配器，复用 `InMemoryTaskDriverSupervisor`） | §18「`activeTasks`/`driverLease`/status claim → application/ports + infrastructure」 |
| `TaskOwnershipPort` | task-execution | application/ports（实现来自 P0-D） | §16.2 |
| `TaskStatusPublisher` | task-execution → platform/events | domain event 消费 + WS adapter | §18「lifecycle writer + hook/watch/budget/WS」 |
| `SchedulerDriverPort` | task-execution | application/ports，经 `TaskExecutionModule` 装配 | §5.2 / §16.2 |
| `TaskReadModel`（窄义 getTask 族） | task-execution | application/queries | §18「scheduler frontier/scope/drive → engine/task」邻接项 |
| archived events / stdout query | task-execution | log/artifact query（经 port 读 FS） | §18 同行 |
| `getTaskDiff` | source-control / workspace-insight | query | §18「repo/cache/submodule/worktree/git → source-control」 |
| repo/cache/worktree materialization | source-control | commands + execution workspace port | 同上 |
| multipart / pre-created prestage | task-execution | direct-launch prestage（保持现有语义） | §18「multipart pre-materialization」 |
| workspace GC lease | task-execution / source-control | owner job + participant | §18「task limits / workspace GC」 |
| `AGENT_HOST_AGENT_NODE_ID` | task-execution | node/domain owned type | §18「agent/script/call kind 分发 → engine/node」 |

**偏离项（逐条呈用户并已于 2026-08-14 确认）**：

1. **不留 facade、一刀清干净**（用户决策）。与 `CLAUDE.md` §services 目录组织
   轻规则 D18「迁移时留同名 facade 保 import 路径稳定」及 RFC-294 §16.2
   「按 export inventory 迁移」的渐迁预期相反。理由是避免长期过渡态；缓解措施
   写死在 plan.md：每刀前 `git pull --rebase`、**改锚提交与源码提交分离**、
   每刀 pin worktree 全量 `gate:local` + exact-SHA CI、与 RFC-289 及任何在改
   `task.ts`/`scheduler.ts` 的工作建立同一排它文件窗口。
2. **G6 三族环外扩早于 W4/W5**（用户决策）。`agent*` 属 resource-catalog、
   `gitRepoCache/repoGroup` 属 source-control，按 §18 本应在 W4/W5 迁位；本 RFC
   只动这三族的 import 拓扑、不动 owner 归属，各自独立成刀可单独回退。
3. **`ports/` 落位与 §2 的 `application/ports/` 命名不一致**：HEAD 既有
   `modules/task-execution/ports/taskDriverSupervisor.ts` 就在模块根 `ports/`。
   本 RFC 与既有先例保持一致（新端口放同目录），命名归一留给 W0-R canonical
   manifest，不在本 RFC 内二次搬迁。

## 6. 验收标准

- **AC-1 零值级 SCC（用户决策扩范围）**：`packages/backend/src` 下**不存在任何
  ≥2 成员的值级 SCC**——目标 8 成员各自成 singleton，且 G6 三族环一并消失；
  depcheck KNOWN_VIOLATIONS 中 6 条 WP-5 账 + 三族环对应账全部删除，零新增
  unknown、零 stale。判据脚本**复用 dependency-cruiser 的原始 `modules` 图源**
  做 Tarjan 投影（`scripts/depcheck.ts:488` 取图处），**不另写第二套 import
  parser**，避免两套判据打架。
- **AC-2 中间态无双红**：每刀提交快照内 depcheck 的 unknown 与 stale 同时为
  零（两者都是硬失败：`depcheck.ts:398/402`）。**禁止预测性预登记**——临时条目
  只允许按当刀实跑 depcruise 报告里的 exact `(rule,from,to)` 追加。
- **AC-3 行为对拍**：94 个 import scheduler / 93 个 import task 的测试文件全绿；
  **四个** kick 点、shutdown 的 `abortAllActiveTasks(reason)`、orphanReconcile
  的 driver seam 行为逐项保持（§4 表 + design.md §10 的行为锁清单）。
- **AC-4 启动面锁更新**：rfc243 CALL_FACES（`:45-53`）+ executor 三臂锁、
  rfc257 同型新锁（scheduler 禁 import task）、`__setActiveTaskForTesting` 族
  （**实际只有 3 个测试文件 11 处引用**：rfc222-task-delete /
  review-cancel-concurrency / rfc230-run-liveness）迁移后全部改锚。
- **AC-5 装配面可验收**：未装配 `SchedulerDriverPort` 时 daemon 在
  `Bun.serve` / schedule ticker / auto-resume **之前**失败；不存在跨测试文件
  借用驱动的可能（`--isolate` 与手敲共享进程两种模型都锁）。
- **AC-6 C1/C2 初始化安全**：转静态的每一刀带 import-order smoke +
  `bun run build:binary` + 单二进制最小启动 smoke（`rfc217-architecture-locks.test.ts:3-10`
  记录过「只有单二进制才抓到」的同类事故）。
- **AC-7 frozen 面语义**：C2 收编为**内部 participant**（不可由 HTTP 公开面
  构造），frozen group payload / parent linkage 与 depth / 继承的 materialized
  space / owner-active preflight / collaborator 并集 / gates ④-⑦ 及原错误码顺序
  逐项对拍。
- **AC-8 文档账本同步**：depcheck 头注计数、2026-08-03 审计 ⓪ 进度回填、
  RFC-294 §5.2/§16.2 的重写状态、路线表、STATE.md。
- **AC-9 每刀门禁**：每刀 pin worktree `bun run gate:local` 全绿 + exact-SHA CI
  绿；定向家族只作快速反馈，不得替代完整门禁。
- **AC-10 实现门**：双路独立子代理（设计门已跑，见 §7）。

## 7. 设计门记录（2026-08-14，双半场 Codex，pin `01d2160e`）

两半场独立跑（A：环地图/边全集/账本；B：合同/切分/测试策略/仓规），各自实跑
`depcheck`（1467 模块 / 36-36 / 0 unknown / 0 stale）与行为锁（31 pass / 47
pass），只读、工作树干净。合计报 **P0×8 / P1×5 / P2×1**，去重后处置如下：

| # | finding | 处置 |
| --- | --- | --- |
| P0 | 缺失强制的 RFC-294 对齐；拟建五个平铺 `services/*` 与总纲相左，且 §5.2 已裁决必须重写 | **整体重写**（本稿）；新增 §5 落位表 + 三条偏离项 |
| P0 | `taskDriver` 契约过期（Map/`ActiveTaskHandle` 不存在；丢 generation/stop ticket/unreaped/reason） | G1 改挂现有 `TaskDriverSupervisor`，§4 五项保真表 + 行为锁 |
| P0 | kick 四点被写成三点，漏 `retryRepoPreparation` ⇒ A1 删不掉或直接编译红 | AC-3 改四点；design.md §3 逐点迁移表 |
| P0 | 全局 `registerSchedulerDriver` 与 orphan seam 不同型；「响亮 throw」被裸 catch 吞掉；17/19 个直调 `startTask` 的测试不走 `createApp` | 废弃全局 seam，改实例注入 + bootstrap fail-fast（AC-5） |
| P0 | AC-1 字面不可验收（另有三族值级 SCC）；仓内无现成 Tarjan | 用户决策**扩范围**为零值级环（G6）；判据复用 depcruise 图源 |
| P0 | 物化域 `379-1741` 是两个语法结构的中间切片，且漏 RFC-287 deferred prep | G2 改符号清单（design.md §4） |
| P0 | 「不留 facade + 88 测试改锚」违反 D18 | 用户决定维持，登记为**偏离项 1** + 缓解措施 |
| P0 | G4 收缩不可落地（`options-S1.ts` 用 `buildContainerMap`，28 个测试文件消费待切符号） | 新增**纯符号归位刀**（G4，design.md §6 inventory） |
| P1 | C1/C2 转静态无 ESM 初始化验证 | AC-6：import-order + binary smoke |
| P1 | C2 无可表达 frozen closure 的 request variant | AC-7：新增内部 participant |
| P1 | E1 只搬 Map 断不了 `task→gc` | G5：两个符号一并迁走 |
| P1 | C-6「身份漂移双红」推理不成立；引用的「测绘 §2.3」不存在 | AC-2 改写为禁预测性预登记；映射表直接写进 design.md §1 |
| P1 | `getTask`「族」无边界（会把 FS/Git 拖进 read model） | G3 三分清单（design.md §5） |
| P1 | 测试策略把拓扑 oracle 当行为 oracle；T1 夹具无文件/断言；每刀未写 gate:local | design.md §10 十组行为锁 + AC-9 |
| P1 | T2 体量过大；串行约定只覆盖 scheduler 未覆盖 task | plan.md 细化为 T2a-T2i + 排它文件窗口（偏离项 1 缓解措施） |
| P2 | fixture 换「真实违规对」锁不住持续真实；scheduler↔task 硬编码不止 `:63-64` | 改名 `SYNTHETIC_CYCLE` 并补 `:78/:85/:143-152/:301` |
