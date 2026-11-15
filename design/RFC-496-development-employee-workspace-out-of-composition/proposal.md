# RFC-496 开发自动化的员工工作区用例迁出 composition（RFC-294 S10 第三步）

- **状态**：In Progress（2026-11-14）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围点名“`digitalEmployeeWorkspace.ts` 的工作区策略……按层归位”；proposal D16、review-2026-11-09 R11 / F13。
- **前序**：[RFC-495](../RFC-495-development-platform-work-items-out-of-composition/proposal.md)（S10 第二步，Done，`c08c4db2e`）。S10 与
  S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只动 development-automation 的 `composition/digitalEmployeeWorkspace.ts`
  与它依赖的两个快照 / 校验文件、一组常量，不碰 `taskImage*` / `crewstation*`。

## 1. 背景

RFC-495 之后，development-automation 的组合层控制流实测 371 行，最多的一个文件是 `composition/digitalEmployeeWorkspace.ts`（1,418 行，
占 97 行）。它的主体是数字员工的工作区用例：为 Case 准备与冻结工作区、按工作项建场景与检查点、快照受保护目录与业务树、校验 Agent 的
改动并在越界时回退，外加用到的计划、上下文与工作区策略的 schema、纯辅助函数，以及 Case 详情页读工作区一行的读侧。

用例要留在 composition 之外，还差三样东西不在 application：受保护目录快照与工作区校验（`infrastructure/protectedSnapshot.ts`、
`infrastructure/workspaceValidator.ts`）——这两个文件只经工作区效果端口读文件、不做直接 IO，按 RFC-294 design §2 属于 application，
只是缺省时选本机实现这一步属于 infrastructure；以及 `infrastructure/attemptSupport.ts` 里三组 git 元数据前缀常量（平台与运行时各自
拥有、受保护目录对拍时跳过的路径），是不依赖任何东西的规则。

## 2. 目标

- **G1 用例归 application**：工作区用例、它的 schema 与辅助函数、用例的输入接口与 Case 工作区读侧原样迁入
  `application/employeeWorkspace.ts`；工作区效果的选定与默认时钟改由 composition 给。
- **G2 快照与校验归 application**：两个文件的内容原样迁入 `application/protectedSnapshot.ts`、`application/workspaceValidator.ts`，
  三个开作用域的函数改取已选定的实现；infrastructure 的同名文件只留“未给实现时选本机实现”的三个包装与在制文件要用的三个转出。
- **G3 常量归 domain**：三组 git 元数据前缀迁入 `domain/gitMetadataOwnership.ts`，使用方改取 domain。
- **G4 composition 只留装配**：`composition/digitalEmployeeWorkspace.ts` 只留组合输入类型与装配函数（含 Case 工作区读侧绑定数据库的一个），
  不含任何控制流语句；bootstrap 与用例照旧从这里取装配函数。
- **G5 账本与锁**：读这些文件源码的锁与登记改指新文件；`composition-control-flow-development-automation` 按实测收紧；新增 RFC-496 用例。

## 3. 非目标

- development-automation `composition/` 的其余文件（mission / config 操作、交付桥等，S10 后继步骤）；其他模块的 composition；S10 的
  全模块门。
- `infrastructure/attemptSupport.ts`、`infrastructure/graph-development/employeeWorkspace.ts` 本身的归位；`taskImage*` 一族（RFC-370 余项，
  逐个避让）。
- 拆分或改写工作区用例；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在新的 application / domain 文件声明（infrastructure 的三个包装除外，逐个钉住）；
  `composition/digitalEmployeeWorkspace.ts` 只声明、只交出组合输入类型与装配函数，没有控制流语句；没有文件从旧位置取迁出的名字（
  infrastructure 留下的三个包装与三个转出除外）。
- **AC-2**：同样输入下工作区的准备、快照、校验与回退的结果、外部调用的次序与参数和此前一致（迁移逐字，现有用例对拍）；工作区效果的
  选定时机不变，未给实现的调用方仍选本机实现，远端树操作照旧优先。
- **AC-3**：新的 application 文件只取 zod、shared、`@/util/hash`、`@/util/gitRef`、digital-employee 的 `public/types` 与本模块的 domain /
  application，不取 infrastructure、composition、IO 包与进程全局；domain 文件不取任何模块；跨 context 边、public surface 不升；
  `composition-control-flow-development-automation` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
