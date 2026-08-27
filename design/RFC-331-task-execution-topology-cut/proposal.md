# RFC-331：Task Execution 拓扑切割（W2-A 第一刀）

> 状态：Approved / Implementation Complete / Publication Pending（2026-08-27；T3～T12 本地候选已完成，待发布与 exact-SHA hosted CI 收口）
>
> 架构位置：RFC-294 N3 / W2-A topology cut；承接已完成的 RFC-328，不领取 W2-B TaskEngine、
> W2-C NodeExecutor 或 W2-D WrapperRuntime 的 credit。
>
> 已发布基线：`158b67296b05a11f22a92ab64b2045643f895f9f`（`HEAD=origin/main`）；该 SHA 的
> exact-SHA CI `33024515076` 已达到 terminal `success`。RFC-331 本地候选尚未提交/发布；按候选生产源码
> 重放的 `architecture/current-report.json` digest 为
> `sha256:e9f8a0ec9d551929295bd43b5d271237448e099c6fdb1c60d2d43aa26ebd0cac`。

## 1. 背景

RFC-328 已经把任务执行的授权事实从进程内约定升级为 durable owner / intent / effect / fence，
并落下 exact-token runtime registry、同事务 lifecycle outbox 与 `TaskExecutionContext`。它完成的是
RFC-294 P0-D：回答“哪一代 worker 可以继续写”。它刻意没有领取 W2 的目录、引擎或解环 credit。

当前下一项结构债因此非常具体：backend 仍有一个由 8 个文件组成的 task SCC family，
`scripts/depcheck.ts` 用 6 条 exact `no-circular` 账目容纳它：

1. `scheduler.ts → task.ts`；
2. `scheduler.ts → workgroup/launch.ts`；
3. `execution/executor.ts → task.ts`；
4. `execution/executor.ts → workgroup/launch.ts`；
5. `agentLaunch.ts → task.ts`；
6. `gc.ts → structuralDiff/callGraph/expandService.ts`。

前五条同源于 `task.ts` 对 `scheduler.ts` 的四个直接 `runTask(...)` kick，而 scheduler 又静态或动态
回调 `task.ts` 的状态发布、子任务 cancel/resume 和 active 查询。第六条同源于 call-graph 扩展为取得
三个 workspace 字段而导入巨型 `getTask`，再经 `task.ts → gc.ts` 闭环。

这不是“把六行账删掉”即可完成的工作。需要把调用能力改成显式、实例级端口，并让读模型按用途变窄；
否则用 global registrar、动态 import 或另一个 god singleton 也能让图表变绿，却没有形成可维护的模块边界。

## 2. 基线与实施后事实

已发布基线 `158b67296` 上，`task.ts` 直接导入 scheduler 并有四个 production kick；
`scheduler.ts` 静态/动态回调 task 的 status、cancel、resume、active；`expandService.ts` 为三个
workspace 字段导入完整 `getTask`。该基线为 repo SCC=7、backend SCC=5、
`KNOWN_VIOLATIONS=37`。

2026-08-27 本地候选已重放出以下结果：

- `task.ts` 四个 kick 全部经必填 `SchedulerDriverPort.kick`，传递同一 RFC-328 context
  instance 的窄 identity ref、原 `AbortSignal` 与完整 runtime config；`task.ts → scheduler.ts` 值级 import=0。
- `scheduler.ts` 的 child cancel/resume/is-active、status projection/publish 全经实例级 topology；
  `scheduler.ts → task.ts` 静态/动态 import=0，缺失/损坏 driver 以 `TypeError` 可见失败。
- status 与 call-graph workspace 使用两个 purpose-specific SQLite read model；`expandService.ts`
  不再依赖 `DbClient` 或 `task.ts`，单仓 fallback、多仓 longest-prefix 与错误顺序保持。
- RFC-328 的 durable ownership/context/runtime registry/lifecycle outbox 未增加平行实现；WS adapter 只发现有
  ephemeral frame 序列。
- 六条 exact depcheck debt 已删；候选报告为 repo SCC=6、backend SCC=4、
  `KNOWN_VIOLATIONS=31`，task SCC family 消失。route→DB=15、transport→DB=2、AppDeps=54、
  inbound/outbound=92/23 均不变，未把其他 wave 倒签完成。

## 3. 目标

### G1：断开 task 与 scheduler 的双向源码依赖

四个 task kick 统一依赖 application-owned `SchedulerDriverPort`，scheduler 通过注入的窄子任务控制端口
和状态发布端口完成反向调用。`task.ts` 与 `scheduler.ts` 不再互相值级 import。

### G2：复用 RFC-328 已落权威

继续使用同一 `TaskExecutionModule`、同一 exact-token runtime registry、同一 durable ownership/fence、
同一 `TaskExecutionContext` 与同一 committed lifecycle outbox。解环不得引入第二张 lease 表、第二个
claim API、第二个 registry 或第二条 durable event 通道。

### G3：把读模型按用途变窄

- scheduler 状态投影只读取 `taskId/status/errorSummary` 和本次需要广播的 canceled node rows；
- call-graph workspace query 只返回工作区定位所需字段；
- 不把 6,000+ 行 `getTask` 整体搬进 module，也不让 call graph 获得完整 Task DTO。

### G4：保持功能逐字等价

四条 kick 的配置、等待模式、日志、错误处理、workspace profile、controller 与 finally release 保持；
child cancel/resume/is-active、daemon shutdown→interrupted、WS frame 顺序与 payload、多仓 call graph ref、
错误码/错误先后顺序保持。

### G5：让边界由机器持续保护

两笔 production cut 各自同步删除精确 depcheck 账目并补负向 fixture：未来重新增加
`task.ts → scheduler.ts`、`scheduler.ts → task.ts` 或 `expandService.ts → task.ts` 必须转红。

## 4. 非目标

- 不拆 TaskEngine / NodeExecutor / WrapperRuntime；它们分别留给 W2-B/C/D。
- 不机械拆分或搬迁 `task.ts`、`scheduler.ts`、materialization、GC 或 call-graph 主体。
- 不把 scheduler→executor 的惰性 import 改成静态 import；断 A1 后它不再构成此环，改动反而扩大初始化风险。
- 不删除 `task.ts → gc.ts`；第六条债只需让 call graph 改依赖窄读模型。
- 不改 REST、MCP、WS schema、DB schema、Task/NodeRun 状态机、错误码或任何用户能力。
- 不把 RFC-329 的 route/tool inventory 误算为 W4-A operation catalog 完成。
- 不添加任何安全策略、权限收紧、能力挡板或功能收缩；本 RFC 是纯功能保真的依赖拓扑重构。

## 5. 决策

- **D1 — 范围恰好六条边**：本 RFC 只清理 `scripts/depcheck.ts:83-131` 当前六条 task-family
  exact debt；邻接的大文件、其他 SCC、route→DB/AppDeps 债不搭车。
- **D2 — RFC-328 事实直接复用**：ownership/runtime/context/outbox 都视为已落基线；本 RFC 不建平行实现。
- **D3 — 显式实例注入**：`SchedulerDriverPort` 由 composition factory 构造并放入必填依赖；禁止
  `registerSchedulerDriver`、module-global mutable locator、production optional fallback。
- **D4 — 一个总合同、消费方取窄面**：`SchedulerDriverPort` 提供 kick/cancel-child/resume-child/is-active；
  task 只拿 kick，scheduler 只拿 child-control 子集，不产生第五个全局 god service。合同 owner 在 application，兼容期只经
  `task-execution/public/topology` 一跳导出；legacy consumer 不得 deep import module application/infrastructure。
- **D5 — 状态发布分相**：本 RFC 的 `TaskStatusPublisher` 只投影既有 ephemeral WS frames；RFC-328
  的 durable lifecycle outbox 保持唯一 committed-event 通道，不做第二次持久化。
- **D6 — 两个目的化 query**：scheduler 状态 projection 与 call-graph workspace projection 分开；
  不复用 full `Task` DTO，不让结构差异服务读取 task 内部聚合。query 合同经 public surface 暴露、SQLite 实现留 module 内，
  `getCallTargets` 接收显式绑定的 read-model instance，不反向 import implementation。
- **D7 — 两刀提交**：第一刀原子切 A1+B1～B4 并删除前五条账；第二刀切 E3 call-graph query
  并删除第六条账。任一刀不允许临时新增 `KNOWN_VIOLATIONS`。
- **D8 — 功能保真优先**：所有既有正向路径先有 golden/interaction oracle，再做接线；发现设计会改变
  正常能力时退回 RFC 重新请批，不以“架构更干净”为理由接受功能损失。

## 6. 能力影响清单

本 RFC 的目标能力影响为 **零**：

| 面                                 | 当前能力                                          | 实施后要求                                         |
| ---------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| 启动 / resume / retry / node retry | 四条 scheduler kick 均可用                        | 逐项保持，入参和等待/后台语义不变                  |
| child call                         | cancel、一次 resume、active reattach              | 逐项保持，竞态分类不变                             |
| WS                                 | list/task status、task.done、canceled node frames | 顺序与 payload golden 不变                         |
| lifecycle event                    | 同事务写 RFC-328 outbox、后台投递 Event Center    | 保持唯一 durable 通道，不重复发送                  |
| call graph                         | 单仓、多仓 ref 展开；工作区缺失 410               | 逐项保持，task-not-found 仍先于 repo/worktree 判定 |
| runtime ownership                  | durable owner + exact token + registry            | 完全复用，不改变 claim/release/takeover            |
| 对外合同                           | REST/MCP/WS/DB                                    | 零 schema、零错误码、零行为变化                    |

若实现审查发现任一行无法保持，本 RFC 的批准自动失效，先更新能力影响再请用户裁决。

## 7. 用户故事

- 作为任务使用者，我启动、恢复、重试、取消或运行 child workflow 时，不因后台重构感知任何行为变化。
- 作为调用图使用者，我在单仓和多仓任务里继续按同样的 ref 展开，缺失工作区仍得到同样错误。
- 作为维护者，我能从源码依赖与端口 owner 直接看出 task application 如何驱动 scheduler，而不是追逐动态 import/global locator。
- 作为后续 W2-B/C/D 的实现者，我可在无 task↔scheduler 环的基础上继续拆 engine，不必再次改 ownership 或事件权威。

## 8. 验收标准

- **AC-1**：四个生产 kick 全部经同一 `SchedulerDriverPort`，`task.ts` 不再值级 import `scheduler.ts`。
- **AC-2**：scheduler 不再静态/动态 import `task.ts`；child cancel/resume/is-active 经显式注入端口；legacy consumer
  对 task-execution application/infrastructure 的新增 deep import=0。
- **AC-3**：`TaskExecutionContext` 在四条 kick、scheduler execution 与 child continuation 上身份保真；无第二 context/registry。
- **AC-4**：production wiring 缺 driver/status/read-model 任一必填依赖时在装配或编译期失败；没有 silent fallback。
- **AC-5**：WS status/done/canceled-node golden 序列与 payload 逐字不变；RFC-328 lifecycle outbox发送次数不增加。
- **AC-6**：child cancel、resume、active-race 与 daemon shutdown/adoption 回归套件保持通过；不得 blanket swallow 装配错误。
- **AC-7**：四条 kick 的 config、signal、`ensureWorkspaceProfiles`、`awaitScheduler`、catch/finally release 语义逐项有断言。
- **AC-8**：call-graph query 只返回 workspace projection；单仓、多仓、unresolved repo、task missing、worktree 410 的顺序和文案保持。
- **AC-9**：第一刀后前五条 exact debt 消失且 depcheck 无新增项；第二刀后第六条消失，`KNOWN_VIOLATIONS` 37→31。
- **AC-10**：current 8-file task SCC family 消失；repo/backend 其他 SCC 不被本 RFC 误报为已完成。
- **AC-11**：负向 fixture 能分别抓回 `task→scheduler`、`scheduler→task`、`expandService→task` 三类回边。
- **AC-12**：生产代码未改 REST/MCP/WS/DB schema、权限、能力挡板或用户功能；RFC-294 的下一步推进到 W2-B，而非把 W2 整波标 Done。

## 9. 批准门

2026-08-27，用户在确认上述范围后以“开始”显式批准 D1～D8、能力影响清单与 design DEV-1 临时
compatibility 偏离，并授权进入 `plan.md` 的 T3～T12。批准不扩展到 W2-B/C/D、安全/权限或能力收缩工作。

## 10. 本地候选收口证据

2026-08-27，T3～T12 的 production/test/architecture 候选已完成，但尚未 commit/push，因此不标
Done，也不把基线 SHA 的绿灯冒充候选证据。本地已验证：

- 新 topology suite 8/8、task-execution compatibility 4/4、WS golden 5/5、call workflow 12/12；
- call-graph 单/多仓 3/3 + 6/6，RFC-103 config inheritance 21/21，RFC-287 deferred prep 58/58；
- architecture preflight/module-boundary/high-water 75/75，typecheck、lint、depcheck 通过；
- canonical payload 重生成并通过内容投影；未发布工作树的 4 条 committed-provenance 断言保持待发布
  后按真实 commit SHA repin，不写假 SHA。

待用户授权发布后，必须按候选的 exact SHA 获得 hosted CI 终态，再把 RFC-331/STATE/index
从 Publication Pending 收口为 Done，并将 RFC-294 的执行指针正式移到 W2-B。
