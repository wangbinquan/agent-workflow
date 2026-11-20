# RFC-518 托管实现迁出组合层（一）：RFC-370 余项里 23 个自足的文件（RFC-294 S10 第二十五步）

- **状态**：Done（2026-11-19，落地 `623baace0`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10。
- **前序**：[RFC-517](../RFC-517-module-root-runtime-logic-out-2/proposal.md)（S10 第二十四步）清完了模块根，RFC-515 门的例外清单只剩
  RFC-370 的 27 个 `crewstation*` / `taskImage*` 文件（例外理由“托管实现归
  infrastructure”）。[RFC-370](../RFC-370-crewstation-hosted-deployment/proposal.md) 已于 2026-10-19 Done，这些是它留在组合层的托管实现。本
  RFC 迁走其中 23 个不依赖别的组合文件的；其余 4 个调用了本模块的组合助手，要拆开装配与实现，另立后继。

## 1. 背景

27 个文件分属 9 个模块，合计约 4,700 行，是 CrewStation 托管部署的适配器实现（任务镜像里的工作区 / 证据 / 校验 / 观察者操作、托管内容与工
件、托管系统智能体材料、托管数据库恢复等），却放在只该装配的 `composition/` 目录里：

- 它们是 RFC-515 门全部剩下的例外（循环、`try` / `throw`）；
- `composition-forbidden-import-files` 计数的 12 个文件（`node:fs`、`@/util/git`、`drizzle-orm` 与 `sessionTables`）全在其中，且都在可直接迁
  走的 23 个里；
- 各模块 `infrastructure/crewstation/` 已有 103 个托管适配器（包括任务镜像的实现），这 23 个文件与它们同类。

## 2. 目标

- **G1 原样归 infrastructure**：23 个文件从各模块的 `composition/` 迁入同模块的 `infrastructure/crewstation/`，文件名不变，内容逐字不变，只
  按新位置重算相对 import；其中两个取本模块 `composition/required-ports` 的类型，按 collaboration 的 infrastructure 已有取法保留。
- **G2 消费方随改，入口不变**：bootstrap 改从模块根 `composition.ts` 取这些工厂（模块根照旧名转出，bootstrap 仍然不深引用模块
  infrastructure）；模块内的 import 改指新位置；留在组合层的 `system-operations/composition/crewstationDeployment.ts` 改从 infrastructure 取
  恢复函数。
- **G3 门与计数收紧**：RFC-515 门的例外清单 27 → 4；`composition-forbidden-import-files` 12 → 0；各模块的 `composition-control-flow-*` 上限
  收紧到实测；钉着旧路径的锁改指新位置；新增 RFC-518 用例。

## 3. 非目标

- 余下 4 个文件（intent 的 `crewstationArtifacts`、resource-catalog 的 `crewstationMcpDiagnostics`、runtime-management 的
  `crewstationRuntimeManagement`、system-operations 的 `crewstationDeployment`）：它们调用本模块的组合助手，要拆开装配与实现，另立后继。
- 改名、拆分、合并任何文件或函数；任何行为变化、接口与界面；托管实现内部的进一步分层。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：23 个文件只在新位置、旧路径不存在；RFC-515 门的例外清单只剩上述 4 个且仍绿；`composition-forbidden-import-files` 实测 0。
- **AC-2**：迁移的代码逐字不变，导出的名字与签名不变，bootstrap 与各消费方拿到的是同一批函数与常量。
- **AC-3**：新位置的 infrastructure 文件不取组合层（本模块 `required-ports` 的类型除外）；bootstrap 不深引用模块 infrastructure；跨 context
  的文件对账本只随路径改名、不增；public surface 不升；计数不升，触及的上限收紧到实测。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
