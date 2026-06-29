# RFC-125 — 技术设计（v3 Pivot：默认延迟，移除 launch 开关）

> v1/v2（per-answer 混合）经 2 轮 Codex gate 共 6 findings 证实是调度器高发区大改（投递路径、逐条目 deferred 标记、级联 provenance、在飞 migration）。**用户拍板 Pivot**：放弃混合，**新任务一律延迟**，完全复用既有延迟模型。本 v3 是最终方向。

## 0. 决策

| # | 决策 |
|---|------|
| D1 | **UI launch 路由 payload 恒发 `deferredQuestionDispatch: true`**（不再由开关决定）；**创建服务默认保持 `?? false`**（实现细化，比"服务默认 true"更安全：避免把大量"程序化/测试建任务的 cross-clarify 流"从立即翻成 park）。净效果：所有经 UI 建的任务恒延迟；测试/API 仍可显式 false 复现立即路径 |
| D2 | **移除 launch「是否延迟下发」开关**（UI + payload + StartTask 用户可见入参） |
| D3 | **复用既有延迟模型，调度器/队列投递/批量下发/不变量/stuck 检测一字不改**；任一任务 flag **创建即定、终生不变**（无混合 → 无 v1/v2 的 6 findings） |
| D4 | **不翻转老任务**：已存在任务保持其 flag 既有值与行为；零 migration |
| D5 | 反问答题页**不变**（无第三按钮）；self-clarify 不变 |
| D6 | 看板 `新增问题`/`复制`/作者表单 随 `deferred` 为真**常驻可见**（既有逻辑）；`批量下发` 维持 `stagedShown>0` 门控（既有，不改）——设计者答案进看板→「加入待下发」后 `批量下发` 可达（Codex P2：批量下发不随 flag 自动显示） |

## 1. 新任务默认延迟（D1）

任务创建路径设默认。现状链路：
- `shared/schemas/task.ts:345` `StartTaskSchema.deferredQuestionDispatch: z.boolean().optional()`；`:190` `TaskSchema … .default(false)`。
- `services/task.ts` 创建任务时读 start 参数写列。
- `routes/workflows.launch.tsx:179` 仅当开关勾选才 spread `deferredQuestionDispatch: true`。

**最终实现（比"服务默认 true"更安全）**：
- **launch 路由恒发**：`routes/workflows.launch.tsx` 提交 payload **无条件**带 `deferredQuestionDispatch: true`（取代原"仅勾选才 spread"）。所有经 UI 建的任务恒延迟。
- **创建服务默认不改**：`services/task.ts:871` 保持 `input.deferredQuestionDispatch ?? false`——程序化/测试/裸 API 不给值时仍 false（**关键**：直接把服务默认翻 true 会把大量"程序化建任务跑 cross-clarify-designer 流"的测试从立即变成 park、连锁破测试；而 UI 路径已恒发 true，无需动服务默认）。
- DB 列默认（`db/schema.ts:537`）+ `StartTaskSchema`（optional）+ `TaskSchema`（default false）**全不改**。

> 净效果：经 UI launch 的新任务恒延迟；测试 / 程序化 / API 仍可显式 `false`（或默认 false）复现立即路径，保住既有 deferred-dispatch 两分支测试 + 不波及无关 cross-clarify 测试。

## 2. 移除 launch 开关（D2）

`routes/workflows.launch.tsx`：删 `deferredQuestionDispatch` **state + `<Switch>`**；payload 的条件 spread 改为**恒发 `deferredQuestionDispatch: true`**（非删除——见 §1）。`StartTaskSchema.deferredQuestionDispatch` 字段**保留为 optional**（程序化/测试仍可传）。i18n 删 `launch.deferredDispatch.label/hint`（type + zh 值 + en 值三处）。

## 3. 调度器 / 投递 / 下发 —— 零改动（D3）

`scheduler.ts`（park gate :800/:1301/:1348、投递 :2426–2460）、`crossClarify.ts`（:580 deferred 分支）、`taskQuestionDispatch.ts`、`lifecycleInvariants.ts`、`stuckTaskDetector.ts`、`taskQuestions.ts` **全部按 `deferred_question_dispatch` 既有分支运行，一字不改**。新任务走 `true` 分支（=今天延迟任务的成熟路径），老任务走其原值分支。

**为何 v1/v2 的 6 findings 在此不存在**：那些坑全部源于"**同一任务内混合**立即(graph)+延迟(queue)"或"**中途翻转 flag**"。本 Pivot 下每个任务 flag 创建即定、终生单一模式 → 无混合、无中途翻转 → 投递不串味、park gate 不误判、无 provenance/migration 需求。

## 4. 看板 / 反问页 / self-clarify —— 不变（D5/D6）

- 看板 `TaskQuestionList`：`新增问题`/`复制`/作者表单受 `deferred` prop（`tasks.detail.tsx:581` 传 `tk.deferredQuestionDispatch`）门控——新任务该值为真 → 自然常驻可见。`批量下发` bar 维持既有 `stagedShown.length>0` 门控（**不随 flag 自动显示**，Codex P2）——设计者答案进看板后「加入待下发」即现。**不改组件逻辑**。
- 反问答题页 `clarify.detail.tsx`：**不动**（无 per-answer 按钮）。设计者答案在延迟任务上本就停进看板（既有行为）。
- self-clarify：不动。

## 5. 失败模式 / 边界

| 点 | 处理 |
|----|------|
| 老 flag=false 在飞任务 | 保持立即/graph 路径（其值不变），零回归 |
| 直接 seed flag 的测试 | 不改 DB 列默认 → 裸 INSERT 行为不变；既有两分支测试继续可控 |
| 程序化/API 仍想要立即任务 | StartTask 仍可显式传 `false`（保留 optional 字段） |
| 行为变更：设计者答案不再自动重跑 | 有意；release note/STATE 标明；老任务不受影响 |

## 6. 测试策略

### 6.1 既有锁（继续绿，不改判定）
- `rfc120-deferred-dispatch.test.ts` / `rfc120-manual-questions.test.ts`：seed 显式 flag 的两分支测试**逐字不变**（模型未改）。
- `question-author-form.test.tsx`（deferred=true 看板）：不变。

### 6.2 改判定 / 新增
- `launch-deferred-dispatch.test.ts`：开关已删 → 改为断言 launch UI **无**该开关、payload 不含该字段（或移除）。
- 新增：任务创建未给 `deferredQuestionDispatch` 时**默认 true**（创建服务单测）；经 launch 创建的任务为延迟（前端 payload 不再含字段 + 后端默认 true）。
- 前端 source-lock：launch 页不再出现 `deferredDispatch` 开关（文本/role 断言）。

### 6.3 门槛
`typecheck + 前端 vitest + (cd packages/backend && bun test) + format` 全绿 → push → CI → Codex impl gate（隔离 worktree）。

## 7. Golden-lock 清单

| 锁 | 守法 |
|----|------|
| 调度器/队列投递/批量下发/不变量/stuck 全模型 | 一字不改（仅改创建默认 + 删 UI 开关） |
| 老任务（flag 既有值）行为 | 不翻转、不迁移 |
| seed 显式 flag 的既有测试 | DB 列默认不改 → 行为不变 |
| self-clarify / 反问页 | 不动 |
