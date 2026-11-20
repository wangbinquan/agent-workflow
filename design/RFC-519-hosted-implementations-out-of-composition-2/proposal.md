# RFC-519 托管实现迁出组合层（二）：拆开余下 4 个文件的装配与实现（RFC-294 S10 第二十六步）

- **状态**：Done（2026-11-19，落地 `8d6797ece`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10。
- **前序**：[RFC-518](../RFC-518-hosted-implementations-out-of-composition-1/proposal.md)（S10 第二十五步）把 23 个自足的 RFC-370 托管实现整
  个迁入 `infrastructure/crewstation/`，RFC-515 门的例外清单只剩 4 个：它们在实现之外还调用本模块的组合助手，不能整个搬。本 RFC 把这 4 个文
  件里的托管实现迁出、装配留下，例外清单清零，S10 的组合层收口完成。

## 1. 背景

余下 4 个文件各有一段装配（调用本模块组合层的工厂）和一段托管实现（含循环、`try` / `throw`）：

- intent `composition/crewstationArtifacts.ts`：托管的技能工件读写（校验暂存引用、旧工件需迁移时抛错）。
- resource-catalog `composition/crewstationMcpDiagnostics.ts`：托管 MCP 诊断的 effect 工厂（约 290 行）与“备用实例不做持久意图收敛”的判断。
- runtime-management `composition/crewstationRuntimeManagement.ts`：托管运行时管理的 effect 工厂、能力 schema 与 profile 映射。
- system-operations `composition/crewstationDeployment.ts`：部署环境的读取与校验、托管数据库的配置与准备、迁移安装的种子与失败关闭、执行权失
  效时的写入围栏。

## 2. 目标

- **G1 托管实现归 infrastructure**：上述实现原样迁入各模块的 `infrastructure/crewstation/`，判据、错误类型、错误串与次序不变；它们需要的类型
  改从 application、端口或本模块 infrastructure 取，不取组合层。
- **G2 组合层只装配**：4 个文件只留装配函数（调用组合助手与新位置的工厂），照旧导出它们今天导出的全部名字（迁走的名字从新位置转
  出），bootstrap 与用例的 import 不改。
- **G3 门清零**：RFC-515 门的例外清单 4 → 0（门的负对照改用伪造的例外清单）；四个模块的 `composition-control-flow-*` 上限收紧到实测；钉着迁
  走原文的锁改指新位置；新增 RFC-519 用例。

## 3. 非目标

- 组合层里装配期的选择分支（`if`，按 S10 的分支上限处理）；把这 4 个组合文件并入模块根或改名；托管实现内部的进一步分层；任何行为变化、接口与
  界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的新位置声明；4 个组合文件没有循环、switch、`try`、`throw`，不构造错误；RFC-515 门的例外清单为空且
  门仍绿。
- **AC-2**：迁移的代码逐字不变（只改 import 与把闭包变量换成参数），4 个组合文件导出的名字与 HEAD 相同，转出的就是新位置的同一对象。
- **AC-3**：新位置不取组合层；跨 context 文件对账本只随路径改名、不增；public surface 不升；计数不升，触及的上限收紧到实测。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
