# RFC-552 public/operations 的类型检查豁免收窄到操作描述工厂（RFC-294 S9 第八步）

- **状态**：In Progress（2026-11-23）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9（public 合同收敛）第 1 项“`public/operations`
  收口”与退出门“检测器不再整体豁免 `public/operations`，且该入口在全部模块只含操作描述及其句柄合同”；design §3.2 的定义。

## 1. 背景

public 类型污染检测（`rfc294Gates.ts` 的 `publicSurfaceViolations`）整个跳过 `public/operations`：RFC-344 的理由是操作描述工厂的
`invoke` 本来就是可执行函数，按开放类型去查会从构造上否掉操作模型。RFC-294 design §3.2（2026-11-09）把这个豁免限定为“只为操作描述
工厂而设”，并写明仓储实现、生命周期函数、写原子与策略注册不得借这个入口导出。

候选导出上实测：去掉豁免后偏差多出 32 条。21 条是操作描述的合同类型（`@/platform/operations/contracts` 的 Query / Command /
IdempotentCommand descriptor 与 `OperationAlias`），正是这个入口该有的；4 条来自 development-automation 的三个描述工厂的函数体（`invoke`
等可执行成员），正是 RFC-344 要豁免的；其余是借这个入口导出的非描述构件：knowledge-evolution 的五个运维函数（消费方只有 bootstrap）、
identity-access 的 OIDC provider 仓储与它的实现类（消费方是遗留的 `auth/oidc/providers.ts`）、source-control 的仓储存储与记录类型（消费方
是遗留的 `services/repoCredentials.ts`）。另有 identity-access 的 `OwnerIdentityQueries` 是查询端口、不是操作描述。

## 2. 目标

- **G1 判据收窄**：检测器不再整体跳过 `public/operations`。该入口里，操作合同类型（`@/platform/operations/contracts`）的 import 是合同本身、
  不计偏差；用 `define*Operation` 构造描述的工厂按 RFC-344 跳过；其余导出照常检查。
- **G2 收口**：knowledge-evolution 的五个运维函数改由它的 composition 交给 bootstrap（不再从 public 导出）；`OwnerIdentityQueries` 移到
  identity-access 的 `public/queries`。
- **G3 显形的旧债入账**：OIDC provider 仓储与 source-control 仓储存储两组，消费方是 `auth/` 与 `services/` 下的遗留实现；收窄后它们的偏差
  可见，逐条登记进 `PUBLIC_SURFACE_DEBT` 并写明后继（遗留实现迁入各自的模块），减速带随之写明来由。
- **G4 入口清单**：`public/operations` 的全部导出逐条入账（操作描述 / 描述工厂 / 句柄合同 / 带后继的旧债），新导出不在清单即红。
- **G5 结局不变**：只改判据、导出位置与 import，不改行为。

## 3. 非目标

- 把 `auth/oidc/providers.ts`、`services/repoCredentials.ts` 迁入模块（各自是 W9-D / W5 的一步，另立）。
- S9 的其他项：类型污染清单其余条目、跨 context 内部文件对。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：检测器不再整体豁免 `public/operations`；该入口的合同类型 import 与描述工厂按 design §1 处理，其余导出照常检查。
- **AC-2**：knowledge-evolution 的五个运维函数不再从 public 导出、bootstrap 改取 composition；`OwnerIdentityQueries` 在 `public/queries`。
- **AC-3**：收窄后显形的偏差逐条入账并写明后继；`public/operations` 的导出逐条入账；新增 RFC-552 用例并登记 guard-manifest。
- **AC-4**：行为不变；受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
