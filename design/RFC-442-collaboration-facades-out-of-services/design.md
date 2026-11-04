# RFC-442 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`C` = `S/modules/collaboration`。以 RFC-441 落地后的源码（`19ba4671b`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：collaboration 的 `domain`（`clarifyAskingNode.ts`、`taskQuestionConflicts.ts`）与 `public/queries`、`public/types`
  （精确入口）；三个路由只改 import。
- **承担的演进**：W4 B / D 第八步。
  - import `services/` 的路由 15 → 12；
  - 删掉一条把 collaboration infrastructure 转给模块外的 legacy 转出，`R1` 170 → 169；
  - collaboration 自己的 `clarify/service.ts` 与 `infrastructure/taskQuestions.ts` 不再经 legacy 绕回本模块。
- **不新增** DAG 之外的边、R1 边与 R2 边：
  - 两个 domain 文件只 import `@agent-workflow/shared`；
  - 路由只经 `public/queries`、`public/types` 取用；
  - collaboration 内部改相对路径。
- **留下的债**：collaboration infrastructure 对 `services/clarify/service`、`services/taskQuestions` 等的依赖；其余 12 个路由。
- **偏离项**：无。

## 1. 文件去向

| 原文件                                                                 | 新位置                              | 说明                                                                                                                |
| ---------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `S/services/taskFeedback.ts`                                           | 删除                                | 路由直接取 `C/public/commands`（`createTaskFeedback`）与 `C/public/queries`（另两个）                               |
| `S/services/taskClarifyDirective.ts`                                   | 删除                                | 路由改取 `C/public/queries` 的 `isAskingNodeInSnapshot`；模块内与用例直接取 `C/infrastructure/taskClarifyDirective` |
| `C/infrastructure/taskClarifyDirective.ts` 的 `isAskingNodeInSnapshot` | `C/domain/clarifyAskingNode.ts`     | 原样迁出，infrastructure 文件删去它与随之不再使用的 import                                                          |
| `S/services/taskQuestionConflicts.ts`                                  | `C/domain/taskQuestionConflicts.ts` | 原样搬迁；`C/public/types` 转出常量与类型                                                                           |

## 2. 连接

- `routes/taskFeedback.ts`：`createTaskFeedback` 取 `@/modules/collaboration/public/commands`，`canViewTaskFeedback`、`listTaskFeedback`
  取 `@/modules/collaboration/public/queries`。
- `routes/taskClarifyDirective.ts`：`isAskingNodeInSnapshot` 取 `@/modules/collaboration/public/queries`。
- `routes/taskQuestions.ts`：`TASK_QUESTION_CONFLICT` 取 `@/modules/collaboration/public/types`。
- collaboration 内部：
  - `infrastructure/clarify/seal.ts`、`clarify/service.ts` 改取 `../taskClarifyDirective`；
  - `infrastructure/taskQuestions.ts`、`taskQuestionDispatch.ts`、`clarify/autoDispatch.ts` 改取 `domain/taskQuestionConflicts`。

## 3. 守卫与用例

- **改 import 的用例**：`scheduler-clarify-dispatch`、`clarify-review-combination-scenarios`、`rfc123-clarify-directive-single-source`、
  `rfc122-clarify-directive-dispatch`、`rfc128-p5-d-autodispatch`、`rfc122-clarify-directive-route` 改取 `C/infrastructure/taskClarifyDirective`。
- **架构报告**：legacy 归属表删去三个 `services/` 文件。
- **串行化插入的源码锁**（`T/fixtures/rfc395-serialized-insert-source-locks.json`）：`clarifyAnswerWrite.ts` 的复核证明把调用方
  `clarify/seal.ts` 的内容哈希一并锁住。本 RFC 只改了 seal.ts 的一行 import（同一个 `setNodeClarifyDirectiveTx`，从被删的 legacy
  转出改为同模块文件），轮次锁、调用方事务与答案插入顺序不变；按 RFC-400 的先例复核后刷新该依赖哈希，并在 `why` 里记一句。
- **账本**：`architecture/commons-debt.json` 删去 `services/taskClarifyDirective.ts` 的一条 R1 边，`inboundEdges` 170 → 169。
- **新用例** `T/rfc442-collaboration-facades-out-of-services.test.ts`：
  - 原文件不存在，新文件就位；`isAskingNodeInSnapshot` 不再在 infrastructure 定义；
  - 源码里没有文件 import 三个旧路径（census 的 AST 提取，带负对照）；
  - 三个路由不 import `services/`，对 collaboration 只经 exact public 入口；
  - 两个 domain 文件只 import `@agent-workflow/shared`；
  - 判定：提问节点为真，非提问节点与坏 JSON 为假；冲突码的字面值逐个不变（REST 合同）。
- **行为由既有用例覆盖**：RFC-122 / RFC-123 澄清指令（路由的 404 / 422）、任务反馈、RFC-217 任务问题冲突码与改派。

## 4. 账本与计数（实测为准）

- `commons-debt.json`：如上。`guard-manifest.json`：不改登记守卫，不变。`counts.json`：只降不升，不改。
- e2e 注释：`task-feedback-distill.spec.ts` 里早已过期的 `services/taskFeedback.ts:48-72` 改指实际实现
  `modules/collaboration/application/taskFeedback.ts:39-61`；`task-question-reassign.spec.ts` 的冲突码引用改指新位置（行号不变）。

## 5. 失败模式

- **漏改引用**：tsc 与新用例的「旧路径零引用」兜底。
- **冲突码字面值漂移**：原样搬迁，新用例逐个锁字面值。

## 6. 测试策略

全部实现与用例写完后集中验证一次：静态检查；全量 SQLite；导出仓库（含 PostgreSQL 真库）跑全部架构测试与受影响用例；P0 变异 lane。
