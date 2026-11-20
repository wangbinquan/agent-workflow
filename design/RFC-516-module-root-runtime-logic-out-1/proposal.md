# RFC-516 模块根装配文件的运行期逻辑迁出（一）：事件中心、身份访问与源码控制（RFC-294 S10 第二十三步）

- **状态**：In Progress（2026-11-19）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推进RFC294」：本会话按
  2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。
  设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10。
- **前序**：[RFC-515](../RFC-515-composition-assembly-only-gate/proposal.md)（S10 第二十二步）：全模块门把 6 个模块根 `composition.ts` 登记为例外
  （后继：模块根收口）。本 RFC 清掉其中 3 个：event-center、identity-access 与 source-control；装配入口与导出的名字、签名不变。

## 1. 背景

三个模块根 `composition.ts` 里各有一小段运行期逻辑，是 RFC-515 门的例外：

- `event-center/composition.ts`：没交观察者程序时的缺省观察者，一调就抛 `observer program unavailable: …`（空对象）。
- `identity-access/composition.ts`：在线状态连接的登记表 `RuntimePresenceConnections`（一个类：开连接、释放、关停时逐个释放）。
- `source-control/composition.ts`：升级 / 启动时对代码托管连接投影的收敛 `reconcileRepositoryTransportConnectionProjections`（两个循环），与员工
  案例工作区的托管操作宿主不齐时抛 `employee-case-workspace-effects-incomplete` 的核对。

## 2. 目标

- **G1 归 application**（逐字不变）：缺省观察者迁入新的 `event-center/application/unavailableObserverProgram.ts`；登记表类迁入新的
  `identity-access/application/runtimePresenceConnections.ts`；收敛并入既有的 `source-control/application/repositoryTransportConnectionProjection.ts`，
  核对并入既有的 `source-control/application/employeeCaseWorkspace.ts`。
- **G2 模块根只装配**：三个模块根 `composition.ts` 改为取新位置，不再有循环、`try` 与 `throw`；收敛函数仍从 `source-control/composition.ts` 转出。
- **G3 门收紧**：RFC-515 门的例外清单删去这 3 个文件（33 → 30）；新增 RFC-516 用例。

## 3. 非目标

- 其余 3 个模块根（digital-employee、system-operations、task-execution，另立后继）；RFC-370 的例外文件；任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的位置声明；三个模块根 `composition.ts` 不再有循环、`try` 与 `throw`，RFC-515 门的例外清单删去它们后仍绿；
  装配入口与导出的名字不变。
- **AC-2**：同样输入下缺省观察者、登记表、收敛与核对的行为、错误与次序不变。
- **AC-3**：新位置只取本模块的 application、端口、public 类型与 `@agent-workflow/shared`，不用进程全局；public surface 不升；计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
