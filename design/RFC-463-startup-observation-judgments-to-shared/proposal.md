# RFC-463 启动核验与清单观测的判定进 shared、空运行参数归 runtime-management（RFC-294 W9-D 第十步）

- **状态**：Done（2026-11-07，落地 `21968c3e3`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-462](../RFC-462-runtime-observation-vocabulary-to-runtime-management/proposal.md)（运行时观测词汇归 runtime-management，
  `R2` 11 → 7）。
- **落位**：`packages/shared/src/startupVerification.ts`、`packages/shared/src/inventoryObservation.ts`（新）；runtime-management
  `public/types.ts`、`application/ports/agentProtocol.ts`。

## 1. 背景

`R2`（模块的 application / domain / engine / public 取 `services/` 或 `ws/`）余下 7 条，其中 4 条是 task-execution
`application/taskAgentRun.ts` 为三个执行助手取 `services/execution/`：

- `startupVerification.ts`（类型与值各一条）：RFC-280 的启动核验——平台「声明注入清单」× 运行时「启动实际报告」的差集判定
  （`verifyStartup`、`declaredHasContent`）、两个观测源转成观测的构造（`observationFromInventory`、`observationFromClaudeInit`），以及
  RFC-297 T12 收口的「按驱动静态表态取观测」单点（`observationForVerification`）；
- `inventoryObservation.ts`：RFC-297 结算时的统一清单观测构造（`buildRuntimeInventoryObservation`）；
- `agentInjection.ts`：只取一个常量 `EMPTY_RUNTIME_PROFILE`（全空的运行参数）。

前两个文件是纯函数的叶子：只依赖 shared（`missingDeclared`、`assembleFace`、`declaredNamesForFace`、`inventoryFacesFromSnapshot`，以及
声明清单、启动观测、核验结果、清单观测的 zod 形状——RFC-280 / RFC-297 早已把它们放在 shared），外加驱动能力声明里的两个字段
（`startupObservation`、`observationRequiresFreshRun`）。它们的消费方横跨两个互不相取的 context：task-execution 的 agent 运行，与
resource-catalog 的 MCP 测试台（`composition/crewstationMcpDiagnostics.ts`、`infrastructure/local/mcpDiagnosticsEffects.ts`）——目标
DAG 里 resource-catalog 既不取 task-execution，也不取 runtime-management。`EMPTY_RUNTIME_PROFILE` 是 runtime-management
`public/types` 里 `RuntimeProfile` 的空值。

## 2. 目标

- **G1 判定进 shared**：两个叶子文件原样迁入 `packages/shared/src/`（与它们所依赖的 `schemas/startupVerification.ts`、
  `schemas/runtimeInventory.ts` 同包），shared 入口导出；判定读到的驱动能力只有两个字段，由 shared 命名（`StartupObservationSource`、
  `StartupObservationCapabilities`），runtime-management 的 `RuntimeDriverCapabilities.startupObservation` 改用同一个联合类型。
  `services/execution/startupVerification.ts` 与 `inventoryObservation.ts` 删除。
- **G2 空运行参数归 owner**：`EMPTY_RUNTIME_PROFILE` 迁到 runtime-management `public/types.ts`（与 `RuntimeProfile` 同处），
  `services/execution/agentInjection.ts` 改取它、不再导出。
- **G3 消费方改取**：task-execution `taskAgentRun` 与 `infrastructure/crewstation/nativeMaterial`、resource-catalog 的 MCP 测试台两处、
  用例改取 shared / runtime-management `public/types`。
- **G4 账本下降**：`R2` 7 → 3（task-execution 4 条）；`R1` 不变；`services/` 77 → 75、`legacy-service-implementations` 72 → 70；不新增
  目标 DAG 之外的边、跨 context 内部文件对、off-DAG offered 文件对与 `module-layer-violations`；public surface 偏差不升。

## 3. 非目标

- `taskAgentRun` 取 `services/runtime` 的 `NOOP_HANDLE`、runtime-management `agentMaterialEvidence` 取会话捕获 / 清扫上下文、intent
  `turnSession` 取 `services/sessionEventSink`（余下 3 条 `R2`，都在驱动接缝上，另立 RFC）。
- `agentInjection.ts` 的其余内容（注入装配，随驱动一族归 runtime-management）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个判定文件只在 shared 定义一次，`services/execution/` 下不再有它们，`src/`、用例与脚本零引用旧路径；`EMPTY_RUNTIME_PROFILE`
  只在 runtime-management `public/types` 定义；`taskAgentRun` 不再取 `services/execution/`。
- **AC-2**：架构计数按实测：`R2` 7 → 3（账本逐条相等），`R1` 不变；public surface 偏差不升；越界类计数不升。
- **AC-3**：受影响用例（启动核验、清单观测、MCP 测试台、agent 运行、注入装配）全部通过；新增 RFC-463 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **判定进 shared，而不是 task-execution 或 runtime-management**：RFC-294 的 legacy 归属表把这两个文件记在 task-execution，但
   resource-catalog 的 MCP 测试台也用同一组判定，而 resource-catalog 在目标 DAG 里既不取 task-execution 也不取 runtime-management，放进
   任一模块都要给 resource-catalog 新开 off-DAG 文件对。它们是 shared 已有形状上的纯函数，与 RFC-458（信封解析器）、RFC-460（引用
   解析）同一做法；shared 早已承载这套观测的形状与 `missingDeclared` / `assembleFace` 两个判定核心。
2. **能力只取两个字段、由 shared 命名**：shared 不能取 backend；判定只读 `startupObservation` 与 `observationRequiresFreshRun`，
   shared 给出这两个字段的结构类型，runtime-management 的能力声明以同一个联合类型声明 `startupObservation`，编译期双向锁住。
3. **`EMPTY_RUNTIME_PROFILE` 放 `public/types`**：`RuntimeProfile` 就定义在那里，该文件零 import，常量放进去不给 `agentInjection` 这个
   叶子模块引入运行时环；其余模块的 `public/types` 也带常量。
