# RFC-577 execution-contract 与 integration 的路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第二批）

- **状态**：In Progress（2026-11-25）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2 与 plan §4.6 W9-D；第一批见
  [RFC-576](../RFC-576-system-operations-routes-into-inbound/proposal.md)，做法沿用 [RFC-439](../RFC-439-code-capability-inbound-bindings/proposal.md)。

## 1. 背景

`routes/` 还剩 43 个文件。按 owner 分族，只有一个路由的有三族：execution-contract（`routes/executionContracts.ts`）、integration
（`routes/codeHosts.ts`）与 task-catalog（`routes/taskCatalog.ts`）。三个路由都只取本模块的 public、HTTP 传输工具、`platform` 的 HTTP / 错误原语、
shared 与 `@/auth/actor`。RFC-576 的教训是：路由进了模块，只被它用的 public 符号就没有模块外的消费者了（`unconsumed-public-symbols-*` 的上限是 0）。

- execution-contract：只被路由用的是 `parseExecutionContractRef`（定义在 domain，经 `public/types` 转出）。
- integration：只被路由用的是 `CodeHostConnectionAdministration`；撤回它之后，它引用的 `CodeHostConnectionMutationConfirmation`、
  `CodeHostConnectionTestDraft`、`CodeHostConnectionUpsertInput` 也落单（都只是端口类型的转出）。
- task-catalog：只被路由用的是 `TaskCatalogQueries`，撤回它之后 `TaskCatalogViewer`、`TaskCatalogListQuery` 也落单——task-catalog 就**整个没有 public
  面**了。`rfc317-module-boundary` 的 R3 把“没有 public 合同的模块”当成要逐个入账、写明理由与清偿波次的形态，这是一个结构上的决定，不在本 RFC 里做。

## 2. 目标

- **G1**：execution-contract 与 integration 的两个路由原样迁入各自模块的 `inbound/http/`（`executionContractRoutes.ts`、`codeHostRoutes.ts`），挂载
  函数经各模块的 `composition.ts` 转出，`server.ts` 改从那里取；旧位置不留转出。
- **G2**：只被这两个路由（及其连带）用的 public 转出撤回：execution-contract 一个、integration 四个；路由改取模块内部的定义。
- **G3**：`legacy-horizontal-files` 91 → 89；其余计数不升（未消费 public 符号保持 0）；行为不变。

## 3. 非目标

- task-catalog 的路由（见 §1；要先决定“没有 public 面的模块”在 R3 里怎么记）；其他模块的路由；路由传输工具归位。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个旧路径不存在，全部源码、用例与脚本不再取它们；新文件与原文件只差 import 说明符。
- **AC-2**：行为不变：`server.ts` 的挂载调用与顺序不变；路由清单与既有路由用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 91 → 89；未消费 public 符号保持 0；架构报告的归属表删去两行；新增 RFC-577 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
