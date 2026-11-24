# RFC-553 knowledge-evolution 不再取 task-execution 的内部（RFC-294 S9 第九步）

- **状态**：In Progress（2026-11-23）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9 第 5 项（认领 S5 / S6 留下的跨 context 内部文件对）
  与 design §14“跨 context 内部文件对 → 0”“模块分层违规 → 0”。

## 1. 背景

knowledge-evolution 有两处直接取 task-execution 的内部文件：融合编排从 task-execution 的 domain 取启动人类型 `DirectTaskInitiator`
（`'manual' | 'api'`），融合路由从 task-execution 的 inbound 取 `directTaskInitiatorFromActorSource`（把请求认证来源投影成启动人）。它们是
跨 context 内部文件对精确清单里的两条（17 条中的 2 条），后一条也是全仓唯一一条模块分层违规（inbound 取别的 context 的内部）。

task-execution 自己的启动路由已经用“装配期交入投影”的形状：根启动的依赖里有 `directTaskInitiator: (actor) => DirectTaskInitiator`，由它的
composition 用同一个投影函数绑定。投影函数读的是遗留 `@/auth/actor` 的 `ActorSource`，按 RFC-301 只许 inbound 适配层看见它，所以不能进 domain，
也不宜从 public 交出（public 面不取 `@/auth`）。

## 2. 目标

- **G1**：`DirectTaskInitiator` 经 task-execution 的 `public/types` 交出，融合编排改从那里取。
- **G2**：融合路由的依赖多一个 consumer 自有端口 `directTaskInitiator: (actor) => DirectTaskInitiator`（与 task-execution 根启动的同名依赖同形），
  路由改调它；bootstrap 装配融合路由时，用 task-execution composition 交出的同一个投影函数绑定。
- **G3**：跨 context 内部文件对 17 → 15、模块分层违规 1 → 0；精确清单与减速带随之降低。
- **G4 结局不变**：同一个投影函数、同样的输入，融合任务的启动人与原先相同。

## 3. 非目标

- 其余 15 个跨 context 内部文件对（各随所属的 context 对处理）；S9 的其他项。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：knowledge-evolution 不再 import task-execution 的 domain / inbound；`DirectTaskInitiator` 经 `public/types`，投影经路由依赖交入。
- **AC-2**：融合任务的启动人与原先相同（session → manual，PAT / daemon → api）。
- **AC-3**：跨 context 内部文件对 17 → 15、模块分层违规 1 → 0，精确清单与 `counts.json` 随之更新；新增 RFC-553 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
