# RFC-513 代码能力与资源目录组合层余下的 throw 迁出 composition（RFC-294 S10 第二十步）

- **状态**：In Progress（2026-11-19）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推进RFC294」：本会话按
  2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。
  设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）。
- **前序**：[RFC-512](../RFC-512-source-control-repository-mirror-use-cases-out-of-composition/proposal.md)（S10 第十九步）：source-control
  组合层最后一个非 RFC-370 的用例已迁出。本 RFC 处理另两个模块组合层里仅有的 `throw`：code-capability 的未绑定历史读取器（2 个）与
  resource-catalog 恢复选择的互斥核对（1 个）；装配入口的名字、入参与返回形状不变。

## 1. 背景

S10 的门要求组合层的 `try` / `throw` 只在登记清单内、例外清单最终为空。RFC-512 之后，RFC-370 之外的组合层 `throw` 还剩六处：task-execution 三
处（运行时绑定与引擎，另立后继）、code-capability 两处、resource-catalog 一处：

- `code-capability/composition/historyQueries.ts` 的装配入口 `composeCodeHistoryQueries` 给 `history` 参数的缺省值是一个内联的读取器：两个
  操作都抛 `CodeHistoryReadError('code-history-reader-unbound', 'installation binding required')`——没有绑定安装时的空读取器；
- `resource-catalog/composition/resourcePackageMaintenance.ts` 的装配入口在同时给了恢复产物端口与恢复效果工厂时抛
  `resource-package-recovery-selections-conflict`——两个互斥选择的装配期核对。

## 2. 目标

- **G1 归 application**（逐字不变）：未绑定的历史读取器迁入新的 `code-capability/application/unboundHistoryReader.ts`
  （`createUnboundCodeHistoryReader()`）；互斥核对并入既有的 `resource-catalog/application/resourcePackageMaintenance.ts`
  （`requireExclusiveRecoverySelection(input)`）。
- **G2 composition 只装配**：两个装配入口改为取新位置的读取器与核对，时机不变；code-capability 组合层的控制流 2 → 0，resource-catalog 77 → 75。
- **G3 账本与锁**：两项计数收紧到实测；钉着这两个组合文件的用例仍通过；新增 RFC-513 用例。

## 3. 非目标

- task-execution 组合层的运行时绑定与引擎（另立后继）；两个模块组合层的其余装配期选择；`crewstation*` / `taskImage*`（RFC-370 余项）。
- 改写任何判据、错误类型与错误串；任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的位置声明；两个组合文件不再有这 3 个 `throw`（code-capability 组合层没有控制流，resource-catalog 的
  `resourcePackageMaintenance.ts` 没有分支），装配入口的名字、入参与返回形状不变。
- **AC-2**：同样输入下，未绑定读取器的两个操作抛出相同的错误，互斥核对接受与拒绝相同的输入、抛出相同的错误，时机不变。
- **AC-3**：新位置的依赖面是闭集（只取本模块的 domain、端口与 application 类型），不用进程全局；public surface 不升；两项计数收紧到实测，其余计
  数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
