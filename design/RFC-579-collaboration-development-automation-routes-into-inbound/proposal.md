# RFC-579 collaboration 与 development-automation 的路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第四批）

- **状态**：Done（2026-11-25，落地 `58ab43d1f`，补正 `ad64ba6e5`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」，2026-11-25「继续」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；
  不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2 与 plan §4.6 W9-D；前三批见
  [RFC-576](../RFC-576-system-operations-routes-into-inbound/proposal.md)、[RFC-577](../RFC-577-single-route-families-into-inbound/proposal.md) 与
  [RFC-578](../RFC-578-memory-source-control-routes-into-inbound/proposal.md)。

## 1. 背景

RFC-578 之后 `routes/` 还剩 36 个文件。按 RFC-578 design §3 的推算，collaboration（`clarify`、`reviews`、`taskClarifyDirective`、`taskQuestions`）与
development-automation（`developmentConfig`、`developmentMissions`、`missionInputUploads`）两族迁进 owner 模块之后要撤回 47 个 public 符号（四层），
多，但几乎全是转出行：

- collaboration 25 个：`public/participants` 整组转出的路由操作端口与它的 11 个参数 / 结果类型，`public/types` 的审查 / 澄清 / 下发三组命令合同、
  审查访问判定、冲突码与它们引用的四个 domain 类型，`public/queries` 的提问节点判定。模块仍有 15 个 public 符号。
- development-automation 22 个：`public/operations` 的全部导出（三个操作描述工厂、两个输入 schema 与 16 个句柄合同）与 `public/commands` 的上传
  用例端口。`public/operations.ts` 随之整个删除；模块仍有 17 个 public 符号。

两族绑定对别的模块的依赖都已在 DAG 里（collaboration → task-execution 的类型边、development-automation → identity-access 的 authority-type-only）。
public 类型偏差里有三条正是这些句柄合同的开放类型（RFC-552 记的后继是“在路由的 zod schema 上收口”）——它们不再是 public 合同，偏差随之销账。

## 2. 目标

- **G1**：七个路由原样迁入各自模块的 `inbound/http/`（collaboration：`clarifyRoutes.ts`、`reviewRoutes.ts`、`taskClarifyDirectiveRoutes.ts`、
  `taskQuestionRoutes.ts`；development-automation：`developmentConfigRoutes.ts`、`developmentMissionRoutes.ts`、`missionInputUploadRoutes.ts`），挂载
  函数经各模块的 `composition.ts` 转出，`server.ts` 改从那里取；旧位置不留转出。
- **G2**：47 个只被这些路由（及其连带）用的 public 转出撤回，读者改取声明处；development-automation 的 `public/operations.ts` 删除。
- **G3**：`legacy-horizontal-files` 84 → 77，`public-surface-deviations` 32 → 29；其余计数不升（未消费 public 符号保持 0）；行为不变。

## 3. 非目标

- resource-catalog（撤回 92 个，另立）、task-execution（两条不在 DAG 里的类型边，先要定）、identity-access 与凭据相邻的路由、task-catalog
  （RFC-577 design §5）；路由传输工具归位；在 zod schema 上收口开放类型（偏差随撤回销账，句柄合同本身不改）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：七个旧路径不存在，全部源码、用例与脚本不再取它们；新文件与原文件只差 import 说明符。
- **AC-2**：行为不变：`server.ts` 的挂载调用与顺序不变；路由清单与既有路由用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 84 → 77、`public-surface-deviations` 上限 32 → 29；未消费 public 符号保持 0；架构报告的归属表删去
  七行；新增 RFC-579 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
