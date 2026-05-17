# RFC-027 — Node Session View（节点 Session 视图 + subagent 多层嵌套）

> 状态：Draft
>
> 编号：RFC-027
>
> 依赖：RFC-011（Prompt 历史 attempts 切换器）、RFC-022（dependsOn 多 agent 注入，使得 subagent 真实出现在线上）
>
> 不依赖也不冲突：RFC-021（任务详情页 tab 化）、RFC-023 / 026（clarify 相关 session 事件）

## 1. 背景

任务详情 → 选中一个 agent 节点 → 右侧 NodeDetailDrawer 当前 4 个页签 `Prompt / Events / Output / Stats`：

- **Prompt** 只展示发给 opencode 的最终 user prompt 文本，零交互。
- **Events** 把 `node_run_events` 表里 opencode `--format json` 的逐条 JSON 事件原样列出来，每条 `<pre>` 渲染 payload，按 kind 过滤；面对真实 agent 跑完一两百条事件时几乎不可读，且 tool call / tool result / assistant text 没有结构关联。
- 当 agent 通过 `task` 工具触发了 subagent（RFC-022 起的常见用法）后，**界面上完全看不到子 session 内部发生了什么** —— stdout 只把 task tool 当成一个 part 吐出来。

这与本框架的产品定位（"驱动多个 opencode 进程作为协作 agent"）严重错位：用户既无法快速 review 单个 session 的对话脉络，也无法 review subagent 是否按预期工作，更不要说"多层嵌套 subagent"调用。

## 2. 目标

把 **Prompt 页签升级为 Session 页签**，把"这个 node_run 对应的整段 opencode session"以**对话流**形式渲染出来，并**支持 subagent 多层嵌套展示**。

### 2.1 必须达到

1. **页签名重命名**：`Prompt` → `Session`。原 Prompt 页签的 attempts 切换器（RFC-011）保留在新 Session 页签顶部。
2. **对话流渲染**：把 opencode 事件按时间顺序还原成 `user → assistant text → tool_use → tool_result → assistant text → …` 的对话流。
3. **subagent 嵌套**：当 assistant 调用 `task` 工具创建 subagent 时，渲染为一个**可折叠的会话块**，块内是子 session 的完整对话流（同样支持 user/assistant/tool_use/tool_result/嵌套 task）。嵌套深度**不设上限**，第 N 层 task 用统一的视觉缩进 + 折叠控件呈现。
4. **prompt 并入顶部**：原 Prompt 页签的 user prompt 文本作为 Session 视图的第一条"user"消息显示，零信息丢失。
5. **subagent 数据完整性**：v1 必须**在 agent 运行时主动捕获子 session 的事件流**（不只是父 stdout 中 task tool 的最终输出），并落到本地 DB；下次刷新页面依然完整可见，不依赖 opencode 进程是否还在。
6. **不破坏既有页签**：Events / Output / Stats 三个页签维持现状（Events 页签依然是原始 raw events 视图，作为 power-user 的兜底）。
7. **不破坏既有 attempts 历史**：RFC-011 的 prompt history attempts 切换器在 Session 页签顶部继续工作，切换 attempt 时整段 Session 视图（含嵌套）按所选 attempt 重算。

### 2.2 非目标

- 不做 session 内消息的搜索 / 高亮 / 跳转。
- 不做 session 内 token 用量分布图（Stats 页签已有总数）。
- 不做对 session 内容的二次编辑、复制为 prompt、re-run from message 等高阶能力。
- 不替代 Events 页签 —— Events 仍是 raw debug 视图，本 RFC 是 reader-friendly 视图，两者长期并存。
- 不在 v1 渲染 markdown / 代码块语法高亮。assistant text 用纯文本 `<pre>` 展示；如有 markdown 需求另立 RFC。
- 不支持流式渲染（M2 行为）。v1 仅展示已落库事件；刷新时按当前 DB 状态重算（实时性由 WS invalidation 触发，与 Events 页签一致）。

## 3. 用户故事

- **作为框架使用者**，我打开一个失败的 agent 节点，希望像翻 ChatGPT 历史那样按消息顺序看：模型先理解了什么 → 调了哪些工具 → 工具返回了什么 → 又输出了什么；而不是一团原始 JSON。
- **作为审阅者**，我想知道父 agent 在第 3 步调起 subagent 后，子 agent 实际跑了几轮、最后说了什么；如果子 agent 内部又调了一个孙 agent，我也要能展开看到孙 agent 的完整对话。
- **作为 agent 作者**，我刚改了 dependsOn 链，想验证父 agent 是不是把任务正确委派给了子 agent；过去要拼接 raw events 才能拼出来，现在希望一眼看完。
- **作为多 agent workflow 调试者**，碰到 subagent 给了奇怪结果，我希望能直接展开 subagent 看到它收到的 prompt 与逐步输出，而不需要去 opencode SQLite 里翻。

## 4. 验收标准

### 4.1 UI 行为

| 编号 | 验收项 |
|------|--------|
| AC-1 | 节点详情 drawer 第一个 tab label 从 `Prompt` 改为 `Session`（中英 i18n 双语 key）。Events / Output / Stats 顺序与文案不变。 |
| AC-2 | Session 视图顶部仍有 RFC-011 的 attempts 切换器；切换 attempt 时整个 Session 内容（含嵌套子 session）按所选 attempt 重渲染。 |
| AC-3 | Session 视图按时间顺序展示消息块；每个块有明确的角色标签（`User` / `Assistant` / `Tool call: <name>` / `Tool result: <name>` / `Subagent: <agent name>`）与时间戳。 |
| AC-4 | 第一条消息是 user prompt（与原 Prompt 页签的 promptText 文本完全一致）。 |
| AC-5 | `task` 工具调用渲染为可折叠的 `Subagent` 卡片，标题含子 agent 名 + 子 session 的最终状态（done / failed / canceled）；折叠时只看一行标题，展开后是子 session 的完整 Session 视图（递归）。 |
| AC-6 | 嵌套 ≥ 3 层 subagent 时，每层缩进与折叠控件正常工作，无溢出 / 错位。 |
| AC-7 | 当 attempt 处于 `pending` / `running` 且尚未有事件时，Session 视图显示与现状一致的"等待中"占位（沿用 `nodeDrawer.promptPending` 文案）。 |
| AC-8 | 当 attempt 属于"无 prompt 能力"的节点 kind（input / output / wrapper / review）时，沿用 `nodeDrawer.promptNotApplicable` 占位。 |
| AC-9 | fan-out 父节点 attempt 沿用 `nodeDrawer.promptFanoutParent` 占位（与现状一致），不渲染 Session。 |
| AC-10 | 子 session 若运行时事件捕获失败（详见 design.md §3.2），子 session 卡片标题显示 `Subagent: <name>（事件未捕获）`，展开后给出"事件未捕获"提示 + opencode 返回的 task tool 最终输出文本作为兜底；**不抛错不空白**。 |

### 4.2 数据 / 后端

| 编号 | 验收项 |
|------|--------|
| AC-D1 | `node_run_events` 表新增 `session_id TEXT` 与 `parent_session_id TEXT` 两列（nullable，老行兼容 NULL）。 |
| AC-D2 | runner 把父 session 与每一层子 session 的 message/tool 事件都落到 `node_run_events` 的同一 `node_run_id` 下，按 `session_id` 区分；`parent_session_id` 指向上一层 session。父 session 自身的 `parent_session_id` = NULL。 |
| AC-D3 | 新增 REST 端点 `GET /api/tasks/:taskId/node-runs/:nodeRunId/session`，返回结构化的会话树（见 design.md §5）。前端 Session 页签消费此端点。 |
| AC-D4 | WS 推送：现有 `/ws/tasks/:taskId` 的 `node.event` invalidation 同时让 session 端点缓存失效。 |
| AC-D5 | runner 子 session 事件捕获不阻塞主流程：即便 opencode HTTP 端口探测失败 / SSE 断开，主任务仍按现有 stdout 路径正常完成；失败仅记一条 warn 日志 + 在受影响 node_run 上落 `node_run_events.kind='subagent-capture-failed'` 标记一行。 |

### 4.3 测试覆盖

`design.md §6` 给出完整 case list；最小集合：

- 纯函数 `parseSessionTree(events)` 把扁平 events 数组重组成会话树的所有分支（user-only / 多 tool 调用 / 一层 task / 三层嵌套 task / 子 session 事件缺失）。
- 前端组件渲染快照：折叠 / 展开 / 缩进 / 三层嵌套 / 兜底文案。
- backend 端点：四态返回（pending / done / 子 session 失败兜底 / 非 agent kind 直接 410 或 200 + 空树）。
- migration：列新增、老行 NULL 兼容、回滚（drop column 不留脏 index）。
- 源代码层 grep 锁（与本仓约定一致）：
  - `tab === 'session'` 的 `<SessionTab />` 分支不可被 refactor 拿掉。
  - runner 中 SSE 订阅入口函数不可静默删除。

### 4.4 不应出现的回归

- Events 页签的 raw 输出不变（同样的事件依然出现在 raw events 列表里，只是 Session 页签额外重组了一份对话视图）。
- Stats 页签依赖的 token / 耗时 / dependsOn 树不变。
- Output 页签端口卡不变。
- attempts 切换器（RFC-011）的 fan-out parent 文案 / pending 文案 / not-applicable 文案不变。
- NodeDetailDrawer 的 retry 按钮、cascade checkbox、shard list 不受影响。

## 5. 与 Events 页签的边界

| 维度 | Session（新）| Events（保留） |
|------|-------------|----------------|
| 受众 | 人类阅读 / Review | 调试 / 排障 / 看 raw payload |
| 渲染 | 对话块 + 嵌套折叠 + 角色标签 | 一条一行 raw JSON / kind chip |
| 数据 | 父 + 子 session 全部事件按 sessionID 分桶 | 扁平 events 全集（与现状一致） |
| 是否过滤 | 自动只保留对话相关 part（message / text / tool / step-finish），其余事件按种类聚合 | 用户自行按 kind chips 过滤 |
| 错误兜底 | 缺数据时显示提示 + 父 session 的 task tool 最终输出 | 始终原样展示 |

两者并存且互不替代。

## 6. 风险与回退

- **opencode 内部事件协议变动**：opencode 仍在迭代，message.part.updated 的字段如 `part.metadata.sessionID` 可能更名。design.md §3 用一层 normalizer 函数把 opencode 事件映射到本框架的 normalized message 结构，便于将来追适配；测试 case 锁住 normalizer 的输入输出。
- **HTTP 端口冲突 / 拿不到子 session**：AC-D5 + AC-10 的双重兜底保证主任务不被拖垮；UI 能显示父 session 全部信息 + task tool 的最终回复文本，"零信息丢失"。
- **完全回退**：把 NodeDetailDrawer.tsx 中 `tab === 'session'` 分支改回 `tab === 'prompt'` + 用回 `<PromptTab />`，runner 中 SSE 订阅入口移除即可全部回滚；DB 列保持 nullable 不需要 drop 也不会影响其他模块。
