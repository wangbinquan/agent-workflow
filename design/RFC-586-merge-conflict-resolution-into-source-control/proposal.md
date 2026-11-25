# RFC-586 合并冲突解决的纯逻辑归 source-control 的 domain（RFC-294 W5 余项第二步）

- **状态**：Done（2026-11-25，落地 `035f97026`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」，2026-11-25「继续」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；
  不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §8 与 plan §4.3 W5；上一步见
  [RFC-585](../RFC-585-node-isolation-family-into-source-control/proposal.md)。

## 1. 背景

`services/mergeAgent.ts`（RFC-130 §6）是合并冲突解决的纯逻辑：不碰 DB、git 与进程。它有两组内容、两个使用方：

- **冲突解析与判定**（`classifyConflictLine`、`parseBinaryWarningPaths`、`parseConflictManifest`、`evaluateResolution`）：source-control 的本机隔离实现
  （RFC-585 迁入的 `infrastructure/local/nodeIsolation.ts`）用；
- **合并代理的模板**（代理定义 `buildMergeAgent`、它唯一的输出端口、节点号 `mergeResolveNodeId`、提示词 `buildMergeResolvePrompt`）：提示词同时被
  source-control 的隔离实现与 task-execution 的合并冲突端口用；task-execution 经自己声明的 `MergeConflictPorts['template']` 端口用这三个函数，由
  它的 composition 从 `services/mergeAgent` 取来绑定。

提示词里写着代理的输出端口名，代理定义也声明同一个端口，两者必须在一处；而 source-control 的隔离实现要用提示词、又不能依赖 task-execution。
因此整份逻辑归 source-control（冲突解决本就是它的能力），task-execution 经 DAG 上的 offered-consumption 从 source-control 的 public 取模板函数。

`evaluateResolution` 用的 `residualConflictMarkers`（一行正则）定义在 `util/git.ts`，除此之外只有一个用例在用。

## 2. 目标

- **G1**：`services/mergeAgent.ts` 原样迁入 `modules/source-control/domain/mergeConflictResolution.ts`，旧位置不留转出；`residualConflictMarkers` 随同
  从 `util/git.ts` 移进这个 domain 文件（domain 不取 git 模块）。
- **G2**：source-control 的 `public/participants` 交出 task-execution 合并冲突端口用的三个模板函数；task-execution 的 composition 改从那里取。
- **G3**：`legacy-horizontal-files` 63 → 62、`legacy-service-implementations` 3 → 2；其余计数不升；DAG 之外的边不增加；行为不变。

## 3. 非目标

- `util/git.ts` 的其余内容；`services/` 余下的 `codeRoundContract.ts`（W4-E8）与 `repoCredentials.ts`（等 RFC-546）。

## 4. 能力影响清单

无（纯逻辑换位置，调用结果逐字不变）。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：旧路径不存在，全部源码、用例与脚本不再取它；迁走的文件只改 import（另并入 `residualConflictMarkers`）；`util/git.ts` 不再有这个函数。
- **AC-2**：source-control 的隔离实现与 task-execution 的合并冲突端口拿到的是同一份函数；合并代理、冲突解析与判定的用例通过。
- **AC-3**：两个上限按实测收紧；未消费 public 符号保持 0；public 类型偏差不升；DAG 之外的边与跨 context 内部文件对不增加；新增 RFC-586 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
