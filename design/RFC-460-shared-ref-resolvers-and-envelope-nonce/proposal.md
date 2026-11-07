# RFC-460 调用目标选择、运行期引用解析与信封 nonce 出 `services/`（RFC-294 W9-D 第七步）

- **状态**：Done（2026-11-06，落地 `a4831eda5`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-459](../RFC-459-resource-catalog-owner-name-and-launch-reservation/proposal.md)（owner 作用域名与代理启动保留归
  resource-catalog，`services/` 82 → 79）。
- **落位**：`packages/shared/src/ref/`（调用目标选择、运行期引用解析）；`platform/contracts/envelopeNonce.ts`；intent
  `application/ports/intentSystemAgent.ts`。

## 1. 背景

intent 与 memory 的 application 层还有 11 条 `R2`（模块的 application / domain / engine / public 取 `services/` 或 `ws/`）。其中 6 条取的是
三件纯件和一个类型，都只是经 `services/` 转手：

- **调用目标选择**（`services/execution/callRefTarget.ts` 的 `pickCallTarget`）：call 选择器绑定到哪一行的唯一判据（RFC-291 面 D）。
  intent 的 dump 与 task-execution 的冻结闭包必须逐字一致；纯函数，零依赖。
- **运行期引用解析**（`services/ref/runtimeRef.ts`）：RFC-271 决策 29 的 RuntimeRef 域 resolver——节点 agent 引用的唯一读取点、
  wrapper-fanout 的去重键、技能 / MCP / 插件引用与去重键。只建在 shared 的 ref AST、codec 与调用策略（`shared/src/ref/`）之上；memory 的
  蒸馏调度、task-execution 的 composition 与 infrastructure、`services/` 的 MCP / 插件闭包都在用。
- **信封 nonce**：每次运行的 workflow-output 信封能力 nonce（`randomBytes(8)` 的 16 位 hex，RFC-200：不可预测是承重的）。实现在
  task-execution application（`generateNodeRunEnvelopeNonce`），`services/nodeRunMint.ts` 再包一层 `generateEnvelopeNonce` 给 intent
  （会话、turn engine 与 infrastructure 的持久化）与 memory（蒸馏）用；intent → task-execution 不是目标 DAG 给的边。
- **seed 文件形状**：intent 的 dump 构造器取 `services/systemAgentRun` 的 `SystemAgentSeedFile` 类型，而 intent 自己的系统代理端口
  （`application/ports/intentSystemAgent.ts`）早已按结构声明了同一形状。

## 2. 目标

- **G1 归位**：`pickCallTarget`（连同 `CallTargetRow` / `CallTargetSelector`）迁入 `packages/shared/src/ref/callTarget.ts`；
  `services/ref/runtimeRef.ts` 迁入 `packages/shared/src/ref/runtime.ts`；两者经 `ref/index.ts` 从 shared 入口导出。信封 nonce 的唯一实现
  迁入 `platform/contracts/envelopeNonce.ts`（`generateEnvelopeNonce`），task-execution 的 `generateNodeRunEnvelopeNonce` 与
  `services/nodeRunMint.ts` 的包装删除，所有调用方取它。intent 端口给 seed 文件形状命名（`IntentSystemSeedFile`），dump 构造器改用它。
  两个 `services/` 文件删除。函数体原样。
- **G2 账本下降**：`R2` 23 → 17（intent 4 条、memory 2 条）；`services/` 79 → 77；`R1` 不变；不新增目标 DAG 之外的边、跨 context 内部
  文件对、`module-layer-violations` 与不可达生产文件；public surface 不变（新导出在 shared 与 platform，不是模块 public 面）。
- **G3 行为不变**：nonce 仍是 `randomBytes(8)` 的 hex，节点运行、intent 会话与 turn、memory 蒸馏取同一个函数；调用目标选择与运行期引用
  解析逐字不变。

## 3. 非目标

- intent / memory 余下 5 条 `R2`：会话事件 sink 的类型（intent、memory 各 1，`services/sessionEventSink`，随运行时驱动一族）、memory 取
  `services/runtime/types`（1，同上）、memory 的 WS 推送（2，`ws/broadcaster`，与 task-execution `taskAgentRun` 的 WS 推送一起改经端口）。
- 运行时驱动一族（`services/runtime/**`）、`nodeRunMint` / `systemAgentRun` 的其余部分；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个旧文件不在，`src/`、用例、仓库根 `tests/` 与脚本零引用旧路径；`pickCallTarget`、7 个运行期引用导出与
  `generateEnvelopeNonce` 各只有一处定义（前两者在 shared，后者在 platform），`generateNodeRunEnvelopeNonce` 不再存在；intent dump 不再取
  `services/systemAgentRun`。
- **AC-2**：架构计数按实测：`services/` 79 → 77，`R2` 23 → 17（账本逐条相等），`R1` 不变；越界类计数不升，public surface 不变。
- **AC-3**：受影响用例（RFC-291 调用目标、RFC-271 运行期引用各组、RFC-200 nonce 源码锁、RFC-395 mint helper、intent dump / 会话 /
  turn、memory 蒸馏与调度、shared 包用例）全部通过；新增 RFC-460 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **调用目标选择与运行期引用解析进 shared 的 `ref/`，不进 resource-catalog 或 task-execution**：两者都是建在 shared ref AST / codec /
   调用策略之上的纯函数（RFC-271 把 ref 域的 AST、codec 与调用策略放进 shared，正为「同一判据只写一次」）；使用者横跨 intent、memory、
   task-execution 与 `services/`，intent → task-execution 不是目标 DAG 给的边，放进任一模块都要为别的使用者开 public 出口；放 shared 不抬
   模块 public surface。与 RFC-458（信封解析器归 shared）同式。
2. **信封 nonce 进 `platform/contracts`，不进 shared**：shared 刻意不带 `node:crypto`（`workgroup-canonical.ts`、`workflow-canonical.ts`
   的注释：哈希留给运行时相关的调用方），而 nonce 必须是 `crypto` 随机；它是 task-execution、intent、memory 共用的中性机制，与同目录的
   `Semaphore` 同类（intent application 已取 `platform/contracts/semaphore`）。名字统一为 `generateEnvelopeNonce`；task-execution 的
   `generateNodeRunEnvelopeNonce` 只是同一函数的第二个名字，删去。
3. **seed 文件形状由 intent 端口命名**：端口已按结构声明 `{ path, content }`，dump 构造器取 `services/systemAgentRun` 的同形类型只是遗留；
   命名后 dump 与端口同一类型，系统代理一族的实现照旧结构兼容。
