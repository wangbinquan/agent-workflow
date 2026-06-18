# RFC-100 — 任务分解

PR 拆分建议：**单 PR**（改动内聚于一条"反问注入 + 运行时拦截"链路，self/cross 共路；拆开反而割裂上下文）。
直推 `main`（见 [feedback_main_branch_only]）。

## 子任务

### RFC-100-T1 — shared 提示词层（self & cross 共用）
- `prompt.ts`：
  - 新增 `buildMandatoryClarifyPreamble()`（强制反问 + 富化指引，design §2.1b）。
  - `renderUserPrompt` 尾块选择重排（design §2.1a；`hasClarifyChannel` 前置于 `inlineMode`）。
  - `buildClarifyProtocolBlock()` 文案改"只反问"（§2.1c）。
  - `buildProtocolBlock` 删 bi-modal 分支 + 降为 2 参（§2.1d），改其调用方。
  - `buildClarifyInlineReminder()` 强化为无条件"再问一轮"（§2.1e）。
  - `renderEnvelopeFollowupPrompt` 加 `clarify-required` reason + hasClarify bullets 去逃逸（§2.1g）。
- `clarify.ts`：`renderClarifyDirectiveTrailer('continue')` 去软逃逸（§2.1f）；`'stop'` 不变。
- 依赖：无。

### RFC-100-T2 — runner 运行时拦截
- `runner.ts`：envelope 分类加 `clarifyActive` 短路，output/both/none 在反问激活期判 `clarify-required-*`（§2.2）。
- 导出 `CLARIFY_REQUIRED_PREFIX`。
- 依赖：T1（reason/文案）。

### RFC-100-T3 — scheduler followup 决策
- `scheduler.ts`：`decideEnvelopeFollowup` 加 `clarify-required` 分支 + reason 联合类型（§2.3）。
- 依赖：T2（前缀常量）。

### RFC-100-T4 — 测试（随 T1–T3 同 PR，不延后）
- 改写 byte/文本回归基线（design §5 列表，每处 test 顶注释链接 RFC-100 说明"有意收紧"）。
- 新增：强制块正向 + 无输出格式断言、stop 给输出格式、runner 拦截三态、followup 决策、源码层文本兜底。
- self 与 cross-questioner 双侧覆盖。

### RFC-100-T5 — 收尾
- 跑 `bun run typecheck && bun run test && bun run format:check` 全绿。
- 单二进制 smoke（`bun run build:binary`）以防 shared 导出改动引入模块环（见 [reference_binary_build_module_cycle]）。
- 更新 `design/plan.md` RFC 索引状态 Draft→Done、`STATE.md` 顶部进行中行 + 已完成表加一行。
- commit（前缀 `feat(clarify): RFC-100 ...`），推 `main`，按 [feedback_post_commit_ci_check] 查 CI。

## 验收清单（与 proposal §验收标准对应）
- [ ] 反问激活注入不含 `<workflow-output>` 格式；含强制块全部要点（self & cross）。
- [ ] 运行时反问激活期 output→`clarify-required` failed→followup 要求反问；重试耗尽→failed。
- [ ] stop 轮（含 inline 首次）注入输出格式，Agent 产出 output 被接受。
- [ ] `continue` trailer / inline 提醒 / followup 文案均无 output 逃逸。
- [ ] 无反问通道节点输出注入字节不变；cross designer 侧 External Feedback/update-mode 不变。
- [ ] 三门槛 + 单二进制 smoke + CI 全绿。

## 已知边界（design §4，登记不堵）
- stop 轮 Agent 违逆 emit clarify → 仍建会话（既有行为，本 RFC 不扩范围）。
- 强制至少 1 轮反问为有意产品行为（用户须在某轮点 stop 放行）。
