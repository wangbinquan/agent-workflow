# RFC-582 task-execution 的端口产物与工作树文件路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第七批）

- **状态**：In Progress（2026-11-25）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」，2026-11-25「继续」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；
  不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2 与 plan §4.6 W9-D；上一批见
  [RFC-581](../RFC-581-resource-catalog-mcp-skill-plugin-routes-into-inbound/proposal.md)。

## 1. 背景

RFC-581 之后 `routes/` 还剩 23 个文件，task-execution 的五个里，按 RFC-578 design §3 的口径（边的角色一起核对）逐个推算：

- `port-artifacts`、`worktree-files`：撤回 0 个 public 符号；对别的模块只取 source-control 的 `public/types`（DAG 有 task-execution → source-control 的
  offered-consumption）。可以迁。
- `taskArchive`、`taskFeedback`、`tasks`：分别取 system-operations、collaboration、memory 与 workspace-insight 的 public，DAG 里这几对要么只有
  required-implementation、要么没有边，迁进模块就是 DAG 之外的边，与 resource-catalog 的 `agents` / `workgroups` 一起等用户定。

## 2. 目标

- **G1**：两个路由原样迁入 `modules/task-execution/inbound/http/`（`portArtifactRoutes.ts`、`worktreeFilesRoutes.ts`），挂载函数经 `composition.ts`
  转出，`server.ts` 改从那里取；旧位置不留转出。
- **G2**：`legacy-horizontal-files` 71 → 69；其余计数不升；DAG 之外的边不增加；行为不变。

## 3. 非目标

- task-execution 的另三个路由与 resource-catalog 的两个（等用户定）；identity-access 与凭据相邻的路由；task-catalog；路由传输工具归位。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个旧路径不存在，全部源码、用例与脚本不再取它们；新文件与原文件只差 import 说明符（这次一行都不用改）。
- **AC-2**：行为不变：`server.ts` 的挂载调用与顺序不变；路由清单与既有路由用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 71 → 69；未消费 public 符号保持 0；DAG 之外的边不增加；架构报告的归属表删去两行；新增 RFC-582 用例并登记
  guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
