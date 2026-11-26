# RFC-609 能力模板的 PostgreSQL 归属方经指定 adapter 取资源目录的端口合同（RFC-294 S9 余项：跨 context 内部文件对 4 → 2）

- **状态**：In Progress（2026-11-26）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  落位由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S9（跨 context 内部 import 为 0，design §14），沿用
  RFC-555～557 的“指定 adapter 只取 required-ports 类型”做法。

## 1. 背景

全仓的跨 context 内部文件对余 4 条（`counts.json` 的 `cross-context-internal-file-pairs`）：

- **Integration 用 Task Execution 的来源终止能力（2 条）**：能力合同一族，延后。
- **能力模板的 PostgreSQL 归属方（2 条，本 RFC）**：
  - 资源包的 PostgreSQL 事务里，能力模板那一支由 code-capability 的 `postgresqlCapabilityTemplatePackageMutationOwner.ts` 实现（owner-native）。
  - 它直接 import resource-catalog infrastructure 的两个文件：合同接口在资源包参与方文件里，事务类型在 `repositorySupport.ts` 里。
  - 后者只是平台 `PersistenceTx` 的别名。

合同是资源目录要别人实现的端口，按 RFC-294 的目标形状应当由资源目录在 `composition/required-ports` 交出，实现方经自己的指定 adapter 只取类型。

## 2. 目标

- **G1**：合同迁入 resource-catalog 的 application 端口（`application/ports/capabilityTemplatePackageOwner.ts`），形状不变，名字去掉引擎前缀
  （`PostgresqlCapabilityTemplatePackageMutationOwner` → `CapabilityTemplatePackageMutationOwner`，它收的是中立的 `PersistenceTx`）。资源目录内部的
  参与方文件与装配改从端口取；`composition/required-ports` 交出它。
- **G2**：code-capability 新增指定 adapter `application/adapters/resource-catalog-adapter.ts`，只以 `import type` 取 required-ports 并转出类型。
  归属方改从它取合同，事务类型直接用平台的 `PersistenceTx`。
- **G3**：跨 context 内部文件对 4 → 2；`counts.json`、RFC-376 的基线与 preflight 的债务清单同步。

## 3. 非目标

- Integration 与 Task Execution 之间的 2 条（能力合同一族，延后）。
- code-capability 兼容岛的物理并入（W4-E8）：见 design §5，受持久化 owner 身份约束，另立。
- 资源包参与方文件直接读能力模板表那条表归属债（RFC-395 T11），不动。

## 4. 能力影响清单

无。只改类型声明的位置与 import 路径。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：合同在 resource-catalog 的 application 端口，经 required-ports 交出；参与方文件不再声明它。
- **AC-2**：归属方只经指定 adapter 取合同，事务类型取自平台；adapter 只以 `import type` 取 required-ports。
- **AC-3**：跨 context 内部文件对为 2，三处清单同步；新增 RFC-609 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
