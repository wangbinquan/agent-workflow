# RFC-458 workflow-output 信封解析器归 shared、端口内容解析归 task-execution（RFC-294 W9-D 第五步）

- **状态**：In Progress（2026-11-06）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-457](../RFC-457-services-platform-mechanisms/proposal.md)（平台机制归 `platform`，`services/` 93 → 84）。
- **落位**：`packages/shared`（信封协议的解析半边）、task-execution 的 `application` / `composition` / `domain`。

## 1. 背景

`services/envelope.ts`（554 行）装着两件事：

- **workflow-output 信封解析器**：从 agent / 脚本的 stdout 里取最后一个（带 nonce 的）`<workflow-output>`，按声明端口拆出端口值，识别
  反问信封、坏掉的端口与分支标记。纯字符串处理，只取 shared 的 `AgentOutputKind`。使用者：task-execution 的 agent 运行与脚本节点、intent
  的 turn engine、memory 的蒸馏输出、自动 commit&push 的消息解析。
- **task-execution 的端口内容解析与校验失败的序列化**：`resolvePortContent` / `resolvePortContentDetailed` 是 task-execution
  composition 里 `resolveNativePortContentDetailed` 的薄包装，`serialize` / `parsePortValidationFailuresJson` 是 `node_runs` 一列的
  JSON 形状；另再导出 task-execution 的 `PortValidationError`、`NODE_VALIDATE_IO` 与两个类型。

信封协议的另一半——给 agent 的协议说明块（带 nonce 的开标签 `envelopeOpenTag`）、反问信封体解析（`parseClarifyEnvelopeBody`）、缺信封
分类（`classifyMissingEnvelope`）、脚本节点的信封片段——早就在 `@agent-workflow/shared`。解析器留在 `services/` 的代价：intent 与 memory
的 application 层、task-execution 的 `application/taskAgentRun.ts` 都取 `@/services/envelope`（`R2` 4 条：`taskAgentRun` 的类型与值各一条）；`envelope.ts` 自己取
task-execution 的 application / composition（`R1` 7 条）。`services/scriptPorts.ts`（脚本 stdout → 端口值，纯函数）只依赖解析器，唯一
使用者是 task-execution 的脚本节点执行。

## 2. 目标

- **G1 归位**：解析器（含私有正则助手）迁入 `packages/shared/src/workflowOutputEnvelope.ts` 并从 shared 入口导出；校验失败的序列化 /
  解析迁入 task-execution `application/portOutputValidation.ts`（与 `PortValidationFailure` 同处）；`resolvePortContent{,Detailed}` 迁入
  task-execution `composition/portOutputValidation.ts`（与 `resolveNativePortContentDetailed` 同处）；`scriptPorts` 迁入 task-execution
  `domain/scriptPorts.ts`。`services/envelope.ts`、`services/scriptPorts.ts` 删除。函数体原样。
- **G2 账本下降**：`R1` 108 → 101、`R2` 27 → 23；不新增目标 DAG 之外的边、模块 public 导出、`module-layer-violations`、跨 context 内部
  文件对与不可达生产文件。
- **G3 行为不变**：只换位置与 import；解析器与包装函数没有第二份定义。

## 3. 非目标

- `services/commitPush.ts` / `commitPushRunner.ts`：执行器取 source-control 的 composition，随 source-control 一族另立 RFC（`commitPush`
  本 RFC 后只改取 shared 的解析器）。
- `nodeRunMint`、`systemAgentRun`、运行时驱动一族等其余 `R2` 来源；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个旧文件不在，`src/`、用例与脚本零引用旧路径；解析器只在 shared 定义一份，task-execution 的包装与原生函数是同一份行为。
- **AC-2**：架构计数按实测：`services/` 84 → 82，`R1` 108 → 101，`R2` 27 → 23，账本逐条相等；越界类计数不升。
- **AC-3**：受影响用例（信封解析、反问信封、端口内容解析与 md 路径、端口校验失败、脚本端口、分支标记、commit&push 核心、蒸馏输出、
  intent turn）全部通过；新增 RFC-458 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **解析器进 shared，不进 `platform/contracts` 或 task-execution public**：协议的渲染半边（开标签、反问体解析、缺信封分类、脚本片段）
   已在 shared，解析与渲染同处；intent → task-execution 不是目标 DAG 给的边，task-execution public 服务不了 intent；shared 可被任何层
   （含 domain）取用。
2. **端口内容解析与校验失败形状留在 task-execution**：前者要按 `markdown_file` 读 worktree 里的文件（task-execution infrastructure），
   后者是 task-execution 自己 `node_runs` 列的 JSON 形状。
3. **`scriptPorts` 进 task-execution `domain`**：纯函数，唯一使用者是脚本节点执行。
4. **`commitPush` 不动**：它的执行器要先解开对 source-control composition 的依赖，二者同批走。
