# RFC-578 memory 与 source-control 的路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第三批）

- **状态**：Done（2026-11-25，落地 `0a5bf21f1`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2 与 plan §4.6 W9-D；前两批见
  [RFC-576](../RFC-576-system-operations-routes-into-inbound/proposal.md) 与
  [RFC-577](../RFC-577-single-route-families-into-inbound/proposal.md)，做法沿用 [RFC-439](../RFC-439-code-capability-inbound-bindings/proposal.md)。

## 1. 背景

RFC-577 之后 `routes/` 还剩 41 个文件。RFC-576 / RFC-577 的教训是：路由进了模块，只被它用的 public 符号就没有模块外的消费者了，撤回它们又会让
它们引用的符号落单。本 RFC 先按架构报告的消费者表与 public 类型引用，把每族迁进 owner 模块之后要撤回的符号算到不动点：

| 族                                       | 路由                                                                       | 要撤回的 public 符号 | 绑定的依赖都在 DAG 里                       |
| ---------------------------------------- | -------------------------------------------------------------------------- | -------------------- | ------------------------------------------- |
| memory                                   | `memories`、`memoryDistillJobs`                                            | 4（两层）            | 是                                          |
| source-control（不含账户仓库的传输凭据） | `repos`、`repoGroups`、`cached-repos`                                      | 9（两层）            | 是                                          |
| collaboration                            | `clarify`、`reviews`、`taskClarifyDirective`、`taskQuestions`              | 25（四层）           | 是                                          |
| development-automation                   | `developmentConfig`、`developmentMissions`、`missionInputUploads`          | 22（四层）           | 是                                          |
| task-execution                           | `port-artifacts`、`taskArchive`、`taskFeedback`、`tasks`、`worktree-files` | 10（三层）           | 否（到 memory、workspace-insight 的类型边） |
| resource-catalog                         | 八个                                                                       | 92（五层）           | 是                                          |

memory 与 source-control 两族最干净：撤回少，绑定对别的模块的依赖都已在 DAG 里，两个模块迁完都还有 public 面。

## 2. 目标

- **G1**：五个路由原样迁入各自模块的 `inbound/http/`（memory：`memoryRoutes.ts`、`memoryDistillJobRoutes.ts`；source-control：`repoRoutes.ts`、
  `repoGroupRoutes.ts`、`cachedRepoRoutes.ts`），挂载函数经各模块的 `composition.ts` 转出，`server.ts` 改从那里取；旧位置不留转出。
- **G2**：只被这些路由（及其连带）用的 13 个 public 转出撤回（memory 4、source-control 9），读者改取模块内部的定义。
- **G3**：`legacy-horizontal-files` 89 → 84；其余计数不升（未消费 public 符号保持 0）；行为不变。

## 3. 非目标

- §1 表里的其余各族（collaboration、development-automation、resource-catalog 撤回多，task-execution 先要处理 DAG 之外的两条类型边，各自另立）；
  `routes/accountRepositoryTransportCredentials.ts`（凭据相邻，延后）；task-catalog（RFC-577 design §5）；路由传输工具归位。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：五个旧路径不存在，全部源码、用例与脚本不再取它们；新文件与原文件只差 import 说明符。
- **AC-2**：行为不变：`server.ts` 的挂载调用与顺序不变；路由清单与既有路由用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 89 → 84；未消费 public 符号保持 0；架构报告的归属表删去五行；新增 RFC-578 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
