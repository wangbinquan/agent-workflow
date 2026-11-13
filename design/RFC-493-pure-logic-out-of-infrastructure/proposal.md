# RFC-493 纯逻辑归位：工作流静态校验与评审的锚点、决策策略迁出 infrastructure（RFC-294 S13）

- **状态**：Done（2026-11-13，落地 `489b30bf6`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S13（纯逻辑归位）与 proposal D14（模块内分层的
  判据是“用例入口与规则判定在 application / domain、infrastructure 只实现端口”；不做 IO 的规则 / 校验 / 策略整块迁出）、review-2026-11-09
  R9 / F11。
- **前序**：无硬前置。S13 与 S9 共用 `collaboration/infrastructure/review.ts`，串行；S9 当前没有在制的步骤。

## 1. 背景

RFC-294 的 2026-11-09 审视（R9）指出：分层只规定了“禁止 import 什么”，没有规定 infrastructure 不许承载什么，旧 `services/` 文件最省事的
去处是原样搬进 infrastructure，于是规则判定大量落在这一层。D14 把存量按价值分三路归位，本 RFC 是第一路：**不做 IO 的规则 / 校验 / 策略
整块迁出**。S13 指定清单必含两处：

- resource-catalog `infrastructure/legacy/workflow.validator.ts`：3,540 行，其中只有开头约 260 行是读库组装校验上下文的异步加载器，其余约
  3,090 行（校验上下文的类型、候选覆盖层、上下文投影与哈希、`validateWorkflowDef` 本体与它的辅助函数）是同步纯函数。
- collaboration `infrastructure/review.ts`：5,218 行的评审服务里，锚点规范化（按上下文重算第几处出现、规范化、一致性断言）与评审决定的
  策略表（每种决定是否递增轮次、重跑与回滚的配置键、取代标记、级联规则）是纯规则，夹在读写库的服务代码中间。

## 2. 目标

- **G1 工作流静态校验归 resource-catalog 的 domain**：`workflow.validator.ts` 的纯函数部分原样迁入 `domain/workflowValidator.ts`；读库的
  加载器（`loadWorkflowValidationContext`、`buildWorkflowValidationContext`、`validateWorkflowById`）留在 infrastructure，改取 domain。
- **G2 评审的纯规则归 collaboration 的 domain**：锚点规范化迁入 `domain/reviewCommentAnchor.ts`，决定策略表迁入 `domain/reviewDecisionPolicy.ts`，
  轮次判定与按轮分组迁入 `domain/reviewRounds.ts`。
- **G3 原位置不留转出**：生产代码与用例改从新位置取；`review.ts` 不再转出 shared 的 `findAllOccurrences`。
- **G4 锁**：新增 RFC-493 用例，钉住清单里每一项只在新位置声明、旧位置不声明也不转出、没有文件从旧位置取。

## 3. 非目标

- 清单以外的规则归位：与 IO 交织的用例编排随 S9 与功能 RFC 归位（D14 的另两路），design §5 列出看过但不进清单的项与理由。
- 校验与评审的行为、错误码、文案；拆分 `validateWorkflowDef` 这个大函数或改写它的内部结构。
- `review.ts` 与 `workflow.validator.ts` 余下部分的重构。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的每一项只在新的 domain 文件里声明一次；`legacy/workflow.validator.ts` 只剩读库的加载器，`review.ts` 不再声明
  这些项、也不转出它们与 `findAllOccurrences`；生产代码与用例都不从旧位置取它们。
- **AC-2**：同样输入下校验结果、锚点规范化结果、决定策略与轮次分组与此前一致（迁移逐字，现有用例对拍）。
- **AC-3**：新的 domain 文件不 import 任何 infrastructure、IO 包或进程全局（RFC-294 模块分层门照常通过）；跨 context 边、public surface
  与各项计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
