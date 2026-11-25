# RFC-581 resource-catalog 的 MCP、技能与插件路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第六批）

- **状态**：In Progress（2026-11-25）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」，2026-11-25「继续」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；
  不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2 与 plan §4.6 W9-D；上一批见
  [RFC-580](../RFC-580-resource-catalog-workflow-workgroup-routes-into-inbound/proposal.md)。

## 1. 背景

RFC-580 之后 resource-catalog 在 `routes/` 里还剩五个路由：`agents` 与 `workgroups` 取 task-execution 的启动合同，迁进模块就是 DAG 之外的 offered 边，
等用户定（RFC-580 proposal §1）；`mcps`、`skills`、`plugins` 三个只取本模块与 identity-access 的授权类型，可以迁。按 RFC-578 design §3 的口径（边的
角色按 RFC-580 的教训一起核对）推算，三个一起迁要撤回 42 个 public 符号：

- 36 个是 public 文件里的**声明**：技能的操作描述合同、文件 / 版本命令端口、zip 导入参与者与它们的输入 / 回执（19 个），插件的操作描述合同与
  输入 / 回执（10 个），MCP 诊断的命令 / 查询端口与它们的输入和两个引用类型（7 个）。
- 6 个是**转出行**：MCP 探测用例端口与回执（转自 `application/mcps/ports`），MCP 运行时诊断的四个回执 / 会话 DTO（转自共享合同）。

## 2. 目标

- **G1**：三个路由原样迁入 `modules/resource-catalog/inbound/http/`（`mcpRoutes.ts`、`skillRoutes.ts`、`pluginRoutes.ts`），挂载函数经 `composition.ts`
  转出，`server.ts` 改从那里取；旧位置不留转出。
- **G2**：36 个声明逐字移进模块内部（design §1 的三个落位），6 个转出删去；读者改取声明处。
- **G3**：`legacy-horizontal-files` 74 → 71；其余计数不升（未消费 public 符号保持 0）；DAG 之外的边不增加；行为不变。

## 3. 非目标

- `agents` 与 `workgroups`（等用户定）；task-execution 的路由；identity-access 与凭据相邻的路由；task-catalog；路由传输工具归位；改动被移动的声明
  的形状。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个旧路径不存在，全部源码、用例与脚本不再取它们；新文件与原文件只差 import 说明符。
- **AC-2**：行为不变：`server.ts` 的挂载调用与顺序不变；路由清单与既有路由用例通过；36 个声明逐字移动，形状不变。
- **AC-3**：`legacy-horizontal-files` 上限 74 → 71；未消费 public 符号保持 0；public 类型偏差不变；DAG 之外的边不增加；架构报告的归属表删去三行；
  新增 RFC-581 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
