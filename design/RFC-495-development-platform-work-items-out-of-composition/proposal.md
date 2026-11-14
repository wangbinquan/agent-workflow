# RFC-495 开发自动化的平台工作项用例迁出 composition（RFC-294 S10 第二步）

- **状态**：Done（2026-11-14，落地 `c08c4db2e`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围点名“`digitalEmployeePlatformWorkItems.ts` 的工作项用例归 application”；proposal D16、review-2026-11-09 R11 / F13。
- **前序**：[RFC-494](../RFC-494-development-employee-type-package-out-of-composition/proposal.md)（S10 第一步，Done，`e11313b6b`）。S10 与
  S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只动 development-automation 的 `composition/digitalEmployeePlatformWorkItems.ts`，
  不碰 `taskImage*` / `crewstation*`。

## 1. 背景

RFC-494 之后，development-automation 的组合层控制流实测 491 行，最多的一个文件是 `composition/digitalEmployeePlatformWorkItems.ts`
（2,324 行，占 120 行）。它的主体是数字员工的平台工作项用例：`execute(plan)` 按工作项分派——准备修改候选、发布 MR、处理冲突、收集
流水线证据、回复评审、判断能否合入等——外加这些用例用到的计划、上下文与上传的 schema 和纯辅助函数。用例只经端口做事，碰到
infrastructure 的只有四处装配：选定工作区效果的实现、未注入时懒建证据存储、冲突复验时读业务树快照求摘要、上传计划里读基线文件。

## 2. 目标

- **G1 用例归 development-automation 的 application**：工作项用例、它的 schema 与辅助函数、用例的输入接口原样迁入
  `application/employeePlatformWorkItems.ts`；四处 infrastructure 改由输入注入（用例只见端口与函数）。
- **G2 composition 只留装配**：`composition/digitalEmployeePlatformWorkItems.ts` 只留两个装配函数与组合输入类型，在这里选定工作区效果、
  懒建证据存储、绑定业务树摘要与基线文件读取、给出默认时钟；不含任何控制流语句。
- **G3 使用方不动**：bootstrap 与用例照旧从 composition 取两个装配函数与组合输入类型（类型的字段与可选性不变）；原位置不留其他转出。
- **G4 账本与锁**：读这个文件源码的锁与登记改指用例所在的新文件；`composition-control-flow-development-automation` 按实测收紧；新增
  RFC-495 用例。

## 3. 非目标

- development-automation `composition/` 的其余文件（工作区策略、mission / config 操作、交付桥等，S10 后继步骤）；其他模块的 composition；
  S10 的全模块门。
- 拆分或改写工作项用例（约 1,550 行的分派以后可按工作项拆开，见 design §8）；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在 `application/employeePlatformWorkItems.ts` 声明；`composition/digitalEmployeePlatformWorkItems.ts` 只声明、
  只交出组合输入类型与两个装配函数，没有控制流语句；没有文件从 composition 取迁出的名字。
- **AC-2**：同样输入下各工作项的输出、上下文补丁、外部调用的次序与参数和此前一致（迁移逐字，现有用例对拍）；工作区效果的选定、证据
  存储的懒建、基线读取与业务树摘要的时机不变。
- **AC-3**：新文件只取 zod、shared、`@/util/hash`、`@/util/gitRef`、digital-employee 的 `public/types` 与本模块的 domain / application，不取
  infrastructure、composition、IO 包与进程全局；跨 context 边、public surface 不升；`composition-control-flow-development-automation` 收紧到
  实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
