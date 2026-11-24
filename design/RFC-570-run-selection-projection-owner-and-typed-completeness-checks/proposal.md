# RFC-570 工作组运行选择投影归 task-execution，source-control 的两个完整性检查收具名类型（RFC-294 S9 第二十五步）

- **状态**：Done（2026-11-24，落地 `26c56a6ee`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan S9 范围第 2 项（“开放类型收成闭合接口”“其余 6 条逐条处理”）与
  design §3.2；消费方用自己的形状声明沿用 [RFC-563](../RFC-563-content-reference-own-shapes/proposal.md)。不改检测规则。

## 1. 背景

`PUBLIC_SURFACE_DEBT` 还有 35 条，其中三条可以不动检测规则地收掉：

| 清单条目（public 根）                             | 问题                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task-execution `WorkgroupTaskRoomHostRunSnapshot` | `selection` 的类型 `WorkgroupRunSelectionProjection` 声明在 `platform/runSelectionProjection.ts`。它是 task-execution 算出的业务投影，放在 platform 只是为了让 resource-catalog 也能取到 |
| source-control `requireIsolationWorkspaceScope`   | 入参写成 `unknown` 再断言成 `IsolationWorkspaceScope`；三个调用点传进来的值本来就是这个类型                                                                                              |
| source-control `requireWorkspaceUploadContent`    | 同上（`WorkspaceUploadContent`）；旁边两个 `…Factory` 的同类检查早就是“收具名类型、返回 void”                                                                                            |

`platform/runSelectionProjection.ts` 的读者只有 task-execution 的三个文件与 resource-catalog 的房间投影；后者只读其中两个字段（`sequence`、
`legacyGroupCurrent`）。

## 2. 目标

- **G1**：`WorkgroupRunSelectionProjection` 归 task-execution（声明在它的 domain）；resource-catalog 的房间投影用自己的窄形状声明读到的两个字段；
  `platform/runSelectionProjection.ts` 删除。
- **G2**：两个完整性检查的入参改为具名类型、返回 `void`；运行期的检查原样保留。
- **G3**：`public-surface-deviations` 35 → 32；其余计数不升；不改检测规则；行为不变。

## 3. 非目标

- `WorkgroupTaskRoomTaskParticipantInTx` 上的 `CommittedEventRef`（平台的已提交事件机制类型）：要不要让 public 合同直接用平台的机制类型，属于检测
  规则的讨论（须用户确认）。
- 隔离工作区合同里的日志器与借贷式入参、运行时探测回执的视图类型（`lastProbe`，收紧它要给存量回执加形状校验，会改变旧回执的显示，另议）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`platform/runSelectionProjection.ts` 不存在；全部源码不再取它；task-execution 的 domain 声明投影，resource-catalog 的房间投影不取
  task-execution 的类型。
- **AC-2**：两个完整性检查收具名类型；缺方法的接收者照旧被拒绝（错误类型与消息不变）。
- **AC-3**：`PUBLIC_SURFACE_DEBT` 删去 3 条，`public-surface-deviations` 35 → 32；新增 RFC-570 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
