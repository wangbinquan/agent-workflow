# RFC-585 节点隔离工作区的实现一族归 source-control（RFC-294 W5 余项第一步）

- **状态**：In Progress（2026-11-25）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」，2026-11-25「继续」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；
  不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §8（source-control 拥有 repo / cache / worktree / submodule，
  `util/git` 迁为本域 infrastructure 叶子）与 plan §4.3 W5；所有权切分沿用 [RFC-370](../RFC-370-crewstation-hosted-deployment/proposal.md)
  （隔离工作区的公共合同 `IsolationWorkspaceScope` 与本机实现归 source-control，task-execution 只经合同用它）。

## 1. 背景

节点隔离工作区（每个节点一棵隔离工作树、快照、合并回写、子模块池、冲突交给合并代理）的本机实现今天停在 `platform/workspace/local/`：
`isolation.ts`（1841 行）、`isolationReferences.ts`、`submoduleParams.ts`，以及它们取的 `services/gitSubmodule.ts`（478 行）。RFC-294 design §3 规定
platform 不依赖任何模块、只放中性机制，而这一族：

- 是 source-control 的实现：生产里只有 source-control 的 `infrastructure/local/localIsolationWorkspace.ts` 与两个托管实现用它（RFC-370 的切分）；
- 反过来取 legacy 的 `services/gitSubmodule`、`services/mergeAgent` 与 `@/config`，后两者又取 source-control 的 public。

task-execution 还有两处直接取它：隔离工作区视图（`infrastructure/isolationWorkspaceView.ts`）在句柄没有 source-control 作用域时退回本机函数——生产
句柄全部经作用域创建，这条退路只有用 `createNodeIso` 直接造句柄的用例在走；执行诊断（`infrastructure/executionDiagnostics.ts`）取两个错误类。

## 2. 目标

- **G1**：四个文件原样迁入 `modules/source-control/infrastructure/local/`（`nodeIsolation.ts`、`isolationReferences.ts`、`submoduleParams.ts`、
  `gitSubmodule.ts`），旧位置不留转出。
- **G2**：task-execution 不再取这一族：视图的本机退路删去（没有作用域的句柄直接报错，与它的其他入口一致），签名改用 task-execution 自己的端口与
  source-control 的 public 作用域类型；两个错误类（`IsoWorkspaceBlockedError`、`MergeAgentChildUnreapedError`）挪到 source-control 的 domain，经
  `public/types` 交给 task-execution。
- **G3**：用 `createNodeIso` 直接造句柄的用例改经一个用例辅助拿本机清理绑定（行为与原退路相同）。
- **G4**：`legacy-horizontal-files` 64 → 63、`legacy-service-implementations` 4 → 3；其余计数不升；DAG 之外的边不增加；生产行为不变。

## 3. 非目标

- `services/mergeAgent.ts`：它同时供 source-control 的隔离实现与 task-execution 的合并代理模板用，归属另议（下一步）。
- `util/git.ts` 本身与 platform 里余下的 `runGit` 使用方（W5 后续）。
- 托管（CrewStation）形态的隔离实现：不动。

## 4. 能力影响清单

- **生产**：无。生产里的隔离句柄只由 source-control 的作用域创建，task-execution 的视图对它们的处理不变。
- **用例**：经 task-execution 内核清理“没有作用域的本机句柄”的兼容路径从生产代码移入用例辅助（`tests/helpers/nativeIsolationCleanup.ts`），用到它的
  用例改取辅助，断言不变。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：四个旧路径不存在，全部源码、用例与脚本不再取它们；四个文件只改 import 说明符（`nodeIsolation.ts` 另把两个错误类改为取 domain）。
- **AC-2**：task-execution 不取 source-control 的 infrastructure；视图没有本机退路；生产行为不变，隔离、快照、合并、冲突与清理的用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 64 → 63、`legacy-service-implementations` 上限 4 → 3；未消费 public 符号保持 0；public 类型偏差不升；DAG 之外的
  边不增加；跨 context 内部文件对不增加；新增 RFC-585 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
