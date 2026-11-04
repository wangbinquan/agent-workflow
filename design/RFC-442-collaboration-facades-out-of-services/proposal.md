# RFC-442 协作的三个 services/ 兼容层收口（RFC-294 W4 B / D 第八步）

- **状态**：In Progress（2026-11-04）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-441](../RFC-441-platform-helpers-out-of-services/proposal.md)（API 文档、PlantUML 渲染与外部入口开关归 platform）
- **落位**：collaboration：`domain`（澄清提问节点判定、任务问题冲突码）与 `public/queries`、`public/types`（给路由的精确入口）。

## 1. 背景

RFC-441 之后还有 15 个路由 import `services/`。其中三个只依赖 collaboration 的三个 `services/` 兼容层：

- `services/taskFeedback.ts`：RFC-349 留下的转出，只把 collaboration `public/commands` 与 `public/queries` 的三个函数再导出一次。
  唯一引用方是 `routes/taskFeedback.ts`。
- `services/taskClarifyDirective.ts`：把 collaboration **infrastructure** 的六个函数再导出，是一条 `R1-inbound-module-internals` 账本边。
  - 路由 `routes/taskClarifyDirective.ts` 只用其中的纯判定 `isAskingNodeInSnapshot`；
  - collaboration 自己的 `infrastructure/clarify/seal.ts`、`clarify/service.ts` 反过来经这层 legacy 转出取自家的 infrastructure；
  - 另有 6 个用例经它取函数。
- `services/taskQuestionConflicts.ts`：任务问题冲突码（RFC-217 T9 收成的常量对象），归属表登记为 collaboration。
  引用方是 collaboration 的三个 infrastructure 文件与 `routes/taskQuestions.ts`。

## 2. 目标

- **G1 删除 `taskFeedback` 转出**：路由直接取 collaboration `public/commands`、`public/queries`。
- **G2 删除 `taskClarifyDirective` 转出**：
  - `isAskingNodeInSnapshot` 是纯函数（解析快照 JSON 后判断节点是不是澄清提问节点），迁入 collaboration `domain/clarifyAskingNode.ts`，
    经 `public/queries` 给路由；
  - collaboration 自己的两个文件直接取同模块的 infrastructure；用例直接取模块文件。
- **G3 冲突码归 collaboration domain**：`services/taskQuestionConflicts.ts` 原样迁为 `domain/taskQuestionConflicts.ts`，经 `public/types`
  给路由；collaboration 内部改相对路径。
- **G4 行为不变**：反馈的创建与可见性、澄清指令路由的 404 / 422 判定、冲突码字面值（REST 合同）全部不变。
- **G5 不留 facade**：原 3 个文件删除。

## 3. 非目标

- collaboration infrastructure 对其他 legacy `services/` 的依赖（`clarify/service`、`taskQuestions`、`clarifyRerunLedger` 等，随协作子波处理）。
- 其余 12 个路由的 `services/` 依赖。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个 `services/` 文件不再存在，源码里没有对它们的 import；`isAskingNodeInSnapshot` 与冲突码在 collaboration domain，
  路由经 exact public 入口取用。
- **AC-2**：计数按实测更新，其余结构门不回退：
  - import `services/` 的路由 15 → 12（`taskFeedback`、`taskClarifyDirective`、`taskQuestions`）；
  - `R1-inbound-module-internals` 170 → 169；
  - 模块里 import `services/` 的文件 151 → 149；`services/` 文件 226 → 223。
- **AC-3**：任务反馈、澄清指令、任务问题（含冲突码）相关用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **判定函数进 domain，经 `public/queries` 暴露**：它只依赖共享合同里的 `isClarifyAskingNode`，没有存储与副作用，本不该在 infrastructure；
   签名只有 `string` 与 `boolean`，满足 public 面的类型规则。collaboration 的 `public/queries` 已有同类的纯函数入口。
2. **冲突码经 `public/types` 暴露**：它是 REST 合同的一部分（客户端按字面值匹配），属于类型面；与 digital-employee 在 `public/types`
   导出常量的做法一致。
3. **用例直接取模块文件**：用例不在 R1 账本的范围内，现有用例已普遍这样取；为用例保留 legacy 转出没有意义。
