# RFC-590 任务目录路由归入 task-catalog 的 inbound，模块不再有 public 面（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第十二批）

- **状态**：Done（2026-11-25，落地 `3f07d748a`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（此前多次同样下达）：
  RFC-577 design §5 把“一个模块可不可以只有入站绑定、没有 public 合同”留给单独的 RFC，本 RFC 按 RFC-294 总纲自行裁定（见 design §0）；设计门免、不派
  Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2、§3 与 plan §4.6 W9-D；上一批见
  [RFC-589](../RFC-589-agent-workgroup-routes-split-by-owner/proposal.md)。

## 1. 背景

`routes/taskCatalog.ts`（60 行）是 task-catalog 唯一的 HTTP 绑定，也是它 public 面唯一的消费者：`TaskCatalogQueries` 与只经它可达的
`TaskCatalogViewer`、`TaskCatalogListQuery`。绑定一进模块，这三个符号就不再有别的模块消费，按“未消费 public 符号为 0”要撤回，task-catalog 于是没有
public 面。`rfc317-module-boundary` 的 R3 把“public 面为空”一律当作要入账、要清偿的债（“它对外不可用，或者消费者正在走内部路径”），RFC-577 因此把它
留了下来。

## 2. 目标

- **G1**：`routes/taskCatalog.ts` 逐字迁入 `modules/task-catalog/inbound/http/taskCatalogRoutes.ts`，挂载函数经 task-catalog 的 composition 转出，
  `server.ts` 改从那里取；挂载顺序不变。
- **G2**：撤回三个 public 符号（定义移进 `application/ports/taskCatalogQueries.ts`），删掉随之变空的 `public/queries.ts`、`public/types.ts`。
- **G3**：R3 的判据改准：public 面为空的模块，要么在债务账本里（写清理由与清偿波次），要么由装配根（`BOOTSTRAP_FILES`）经它的 composition 取用——
  后者是“只被装配、不被别的模块消费”的正当形状，不是债；别的路径仍由 R1 与跨 context 的规则拦住。
- **G4**：`legacy-horizontal-files` 56 → 55；未消费 public 符号保持 0（`unconsumed-public-symbols-task-catalog` 随 public 面一起退场）；几处“有 public
  面的 context 至少 19 个”的非空下限改为 18；其余计数不升；行为不变。

## 3. 非目标

- `routes/` 里暂缓的那一组（`registry`、`operationRoute`、identity-access 的路由、`accountRepositoryTransportCredentials`、`resourceAcl`）；W5 的
  `util/git`。

## 4. 能力影响清单

无（只改代码落位与一条结构规则的判据，不关闭、不收缩任何既有能力）。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：旧路径不存在，全部源码、用例与脚本不再取它；新绑定与原文件只差 import。
- **AC-2**：行为不变：任务目录的来源与列表路由用例通过。
- **AC-3**：task-catalog 没有 `public/`；R3 的新判据通过，且对“public 为空、装配根也不取它 composition 的模块”报红（带负对照）；`legacy-horizontal-files`
  上限 56 → 55；未消费 public 符号 0；DAG 之外的边不增加；新增 RFC-590 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
