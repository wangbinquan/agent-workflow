# RFC-045 — 人工创建 + 编辑记忆（scope / tags / title / body）

## 1. 背景

RFC-041 落地后，平台的"长期记忆"完全由 distiller agent 自动产出：

- `scope_type` / `scope_id` 由 distiller 模型自己判定（agent / workflow / repo / global 四选一 +
  对应 id），写入 `memories.scope_type/scope_id`。
- `tags` 由 distiller 从"当前 scope 已用 tag 池"里挑 / 偶尔提新 tag。
- `title` / `body_md` 由 distiller 写英语自然语言。

admin 在 `/memory` → Approval Queue 的能力今天只有 4 个：approve / approve_and_supersede /
reject / archive。其中 approve / approve_and_supersede 允许 `tagsOverride`——这是**唯一**的"人
工修改"入口，且只在 promote 那一刻生效；scope_type、scope_id、title、body_md 一律不能手改。
approved 后行被产品文 §G7 明确锁死：「approved 后正文不可改；修改 = 起一条新 row 走 supersede
链」，proposal §P143 还规划了"`body_md` 不被任何路由 PATCH"的 grep 守卫（实际未落地，本 RFC
确认其作为遗留约束被取代）。

后端**已经**有 `POST /api/memories` 路径（`createManualCandidate`）支持 admin 手工写一条
`source_kind='manual'` 的候选记忆，但**前端从未给过 UI 入口**——admin 只能 `curl` 后端，或者
等 distiller 自己产候选。这条后门除 e2e fixtures 之外几乎无人触发。

这套设计在 distiller 推断准时成立，但实际跑下来三类问题反复出现：

1. **scope 错位**：distiller 经常把一条普适规则推成"agent: senior-engineer"——admin 想把它
   提升到 global，或者反过来收窄到具体 workflow，**没有任何操作可以做到**。她唯一的选择是先
   reject 这条候选，然后手动 POST 一条 `source_kind='manual'` 的新候选（创建路径走的是
   `createManualCandidate`，但用户也得自己重写 title/body），再去 approve。链路冗长且丢失了
   原 distiller 的推理上下文。
2. **tag 拼写 / 命名漂移**：distiller 间歇会把同义 tag 写成不同 case（如 `git-workflow` vs
   `git_workflow`），或起一个 newTag 但 admin 想合并进现有池。tagsOverride 只能在 promote
   时纠一次，approved 后这条记忆的 tag 永久错位。
3. **正文措辞偏离**：distiller 偶尔把 review 决策概括得过于绝对（"never X" 而 admin 觉得应该
   是"prefer not X unless Y"）。今天 admin 要么 reject 重写 + 重新经过 distiller debounce，要
   么 approve 一条措辞不准的记忆容忍它注入到运行时 prompt。
4. **完全空白的人工补录**：admin 在和团队复盘时学到一条新经验（"PR 描述里如果带 `[infra]`
   prefix 一律加 @infra-team review"），distiller 看不到这条信息（没有任何 clarify / review /
   feedback 触发它），admin 只能干等下次某 task 偶然撞上这条规则。没有 UI 手工建立 candidate
   的入口，这条经验进不了平台记忆。

后两类（tag / 正文）尤其磨人，因为 RFC-041 §G7 的"approved immutable"约束本意是保证 supersede
链可审计——但 admin 修个错字也走 supersede 链会让链路在第一年内就膨胀到上百节。第四类（空白
补录）则是"distiller 上游再准也修不到根本没被它看到的知识"。RFC-044 在改善 distiller 上游精
度，但**仍需要一条人工补救通道**给 admin 直接写。

## 2. 目标

两条紧密相关的能力：

- (A) **人工创建 candidate 的 UI 入口**：让 admin 不必 `curl` 就能补录一条记忆。后端
  `POST /api/memories` 早已具备，本 RFC 只补前端。
- (B) **人工编辑 4 字段**（`scope_type`/`scope_id`/`tags`/`title`/`body_md`），覆盖 candidate
  与 approved + archived 三类行，**显式 supersede RFC-041 §G7 "approved 后正文不可改"** 的
  约束。

### 2.1 必须做到

#### 2.1.A 手工创建

- **新 UI 入口**：`/memory` 顶栏右侧加 `[+ New memory]` 按钮（admin only，无权限时整钮不渲染）。
  点击开 `<MemoryNewDialog>`：
  - scope 选择器：4 单选（agent / workflow / repo / global）；
  - scope_id：依据 scope_type 动态——agent → 拉 agents 下拉、workflow → 拉 workflows 下拉、
    repo → 拉 repos 下拉、global → 字段隐藏并固定 null；
  - title 文本（1-120 字符）；
  - bodyMd textarea（1-4000 字节，UTF-8 byte-count 与 schema 一致）；
  - tags：自由输入（逗号 / 回车分隔），16 条上限 + 单 tag 1-40 字符；
  - Save → 走既有 `POST /api/memories` → 后端返回 `status='candidate'` 的 Memory；
  - Save 成功后 dialog 关闭，自动切到 Approval Queue 子页签并 invalidate `['memories',
    'candidates']`；后端 publish `memory.candidate.created`（既有路径，零改动），前端 WS hook
    刷新 pending-count 徽章。
- **后端零新增路由**：沿用既有 `POST /api/memories`（perm=`memory:approve`），但
  **新增 `memory:edit` 不影响 create**——create 仍走 `memory:approve` 因为它在产品语义上是"自
  己产一条候选并默认会去 approve"，与 reject/promote 同档；解耦在 edit 路径（候选 / 已批准 / 已
  归档都可编辑，而 admin 不一定有 approve 权限——目前 admin 一身全占，未来分工时这一档别绑死）。

#### 2.1.B 人工编辑

- **可编辑字段**：`scope_type`、`scope_id`、`tags`、`title`、`body_md` 全部支持人工修改。
  - 跨 `scope_type` 编辑允许（global ↔ agent / workflow / repo 任意组合），由 admin 自己
    保证 scope_id 与 scope_type 配套。后端 schema 校验照旧（global 必 null、其余必非空）。
  - tags 不限制必须从"已用 tag 池"挑，仍受 `MemorySchema` 的 16 条上限 + 单 tag 40 字节。
- **状态覆盖**：`status ∈ {candidate, approved, archived}` 三类行都能改。`superseded` /
  `rejected` 不能改（已经是终态，改它没有任何运行时副作用，且会把 supersede 链搞乱）。
- **原地修改 + version 自增**：approved 行的编辑**不**起新 row、**不**写 supersede 链，直接
  UPDATE 同 row 并 `version += 1`。runner 的 inject 走 live read（RFC-041 PR3 已落），下一次
  `runNode` 自然读到新值。
- **审计可见**：每次编辑写一条 WS 广播 `memory.updated`，前端订阅者刷新；后端 log 一条
  `memory-edited` 含 `editedBy` / `fieldsChanged`，便于事后排查。
- **权限新增 `memory:edit`**：与 `memory:approve` 解耦。仍只发给 admin 角色（与 RFC-036
  既有 5 个 memory:* 位的发放策略一致）。
- **UI 入口**：
  - Approval Queue 卡片（candidate）增加"编辑"按钮，开 `<MemoryEditDialog>`（field-level 编辑
    → save → 卡片就地刷新）。
  - 全部 / by-scope / scope-detail 三类列表的 row 增加"编辑"按钮，仅在 status ∈
    {candidate, approved, archived} 显示，开同一编辑 dialog。
  - `<MemoryEditDialog>` 与 `<MemoryNewDialog>` 共享内部 `<MemoryFormFields>` 组件（表单字段
    一致，只是 New 全字段 fresh / Edit 带初值 + 4 字段独立 dirty 标记）。
- **immutable 守卫拆除**：RFC-041 proposal §P143 那条"`body_md` 不被任何 PATCH" 的 grep
  守卫**实际上从未落地为代码**（grep 后无任何 backend test 锁住该断言），本 RFC 显式标记其作
  为遗留计划被取代；新路径 `PATCH /api/memories/:id` 需 `memory:edit` 权限。
- **测试覆盖**：schema 单元（5 字段独立 PATCH / 跨 scope_type 边界 / tag 上限）+ service 单元
  （version bump / WS 广播 / 状态终态拒绝）+ route 单元（permission / 404 / 422 / 409）+
  frontend `MemoryEditDialog` / `MemoryNewDialog` 测试（form 校验 / save 后刷新）+ e2e 1 spec
  （admin 顶栏点 New → 填表 → Save → Approval Queue 看到候选 → 点编辑改 scope+tag → Approve →
  verify approved row 用新 scope/tag）。

### 2.2 非目标（v1 不做）

- 不引入历史编辑表 / changelog。version 字段只是"行级心跳"，不维护每次改动的 before/after
  快照。如未来要做审计回放，单独走 RFC。
- 不改 supersede 链的语义。supersede 仍只在 `approve_and_supersede` 的 promote 路径产生；
  PATCH 不写 supersede。
- 不改 `source_kind` / `source_event_id` / `source_task_id` / `distill_job_id` /
  `distill_action` / `approved_by_user_id` / `approved_at` 这些来源字段——它们是"这条记忆怎么
  来的"的不可变记账，admin 编辑不应抹掉。手工创建的行 `source_kind='manual'` 永远不变。
- 不放开 `superseded` / `rejected` 行的编辑。这两类是终态。
- 不批量编辑——v1 只支持单条编辑 / 单条创建。
- 不在编辑 dialog 内做"另存为副本"或"创建副本"按钮——本 RFC 范围内 create 与 edit 入口完全
  独立，避免一个 dialog 服两个语义。
- 不通过本 RFC 解决 distiller 推 scope 不准的根因（distiller prompt 优化是 RFC-044 工作）。

## 3. 用户故事

### S0：admin 手工补录一条平台未捕获的规则
团队复盘后 admin 想录入"PR 描述里如果带 `[infra]` prefix 一律加 @infra-team review"。她进
`/memory`，点顶栏 `[+ New memory]`，选 scope=`global`、title="add infra team review for [infra]
PRs"、bodyMd 写规则正文、tags 输入 `pr-review,infra,review-policy`，点 Save。Dialog 关闭、
页面切到 Approval Queue 子页签，新候选卡片在最上方，她直接点 Approve（也可以再点编辑微调）。

### S1：admin 把过窄 scope 调成 global
distiller 产了一条 candidate：scope=agent/senior-engineer，title="prefer trailing-comma JSON
configs"。admin 觉得这条对所有 agent 都成立，她在 Approval Queue 候选卡片点"编辑"，下拉切到
`global`，scope_id 自动置 null，点 Save。卡片刷新成"global / [no tags]"，她按 Approve。
之后任何 agent 跑 runNode 都会注入这条。

### S2：admin 修 tag 拼写
distiller 给一条 approved memory 打了 `git_workflow`，admin 想统一成 `git-workflow`（与其他
12 条记忆对齐）。她进 `/memory` → All → 该 row 点"编辑"，tags 输入框删旧加新，Save。
WS 广播 `memory.updated`，列表当场更新；下一次 runNode 注入的 tag 已经是新值。

### S3：admin 修正过度绝对的措辞
review 决策被 distiller 概括成"never auto-merge after CI green"，admin 想改成"prefer manual
merge after CI green unless the PR is a chore/docs change"。她进编辑面板改 body_md，Save。
版本号从 v1 → v2，approved_by_user_id / approved_at 不变（不是新 approval，是 metadata 编辑），
WS 触发订阅者刷新。

### S4：超出范围的尝试都被拒绝
- admin 试图把一条 `superseded` 的旧记忆改回 active，PATCH 返 409 `memory-terminal-status`。
- admin 试图把 scope_type 改成 'global' 但忘了清空 scope_id（前端 bug），后端 422 schema 拒绝。
- 非 admin（无 `memory:edit`）试图调 PATCH，403 `permission-denied`。

## 4. 验收标准

### 4.A Create（人工创建）

- 既有 `POST /api/memories`（perm=`memory:approve`）行为不变，本 RFC 不改后端。
- 新组件 `MemoryNewDialog`：
  - 复用内部 `MemoryFormFields`（4 scope 单选 + 动态 scope_id + title + bodyMd + tags）。
  - Save 走既有 POST 路径，成功后 dialog close + 切换到 Approval Queue tab + invalidate
    `['memories', 'candidates']` / `['memories', 'pending-count']`。
  - 422 / 5xx 在 dialog 顶部 `<ErrorBanner>` 渲染，不关 dialog（admin 可纠正后重试）。
- `/memory` 顶栏右侧按钮 `[+ New memory]`：仅当 `usePermission('memory:approve')` 为真时渲染。

### 4.B Edit（人工编辑）

- 新接口 `PATCH /api/memories/:id`：
  - 接受部分 update（任一字段可选，至少一个非空）。
  - 接受 `{scopeType, scopeId, title, bodyMd, tags}` 的子集，**显式忽略**其他字段（不会因为
    body 带 `version: 99` 就 bump 到 99）。
  - 校验 schema（global vs scope_id 互斥 / tags 16 条 / title 1-120 / body 1-4000 字节）。
  - 校验 status：terminal 状态（superseded / rejected）→ 409 `memory-terminal-status`。
  - 不变更：`source_*`、`distill_*`、`approved_*`、`supersedes_id` / `superseded_by_id` 字段。
  - 成功：`version += 1`，WS 广播 `memory.updated`，返回 `{ memory: Memory }`。
- 新权限位 `memory:edit` 加入 PERMISSIONS 常量；admin 角色默认拥有；user 角色无。
- WS 协议增加 `memory.updated` 离散类型；前端 `useMemoryWs` 已用 `msg.type.startsWith
  ('memory.')` 全量 invalidate，新事件零 hook 改动即生效（但要在 WS schema 显式列出新 case
  以让 schema test 锁住）。
- 前端：
  - 新组件 `MemoryEditDialog`（受控 form + zod 校验，与 `MemoryNewDialog` 共享
    `MemoryFormFields`）。
  - Approval Queue 候选卡片新增 row-level "编辑"按钮，仅 candidate 显示。
  - All / by-scope / scope-detail 三处 `MemoryRow` 新增"编辑"按钮，仅 `{candidate, approved,
    archived}` 显示。
  - 编辑 dialog Save 后通过 invalidateQueries 刷新列表；订阅 WS 的列表会因 `memory.updated`
    自动 refetch。
- 不退化：现有 RFC-041 4 个 promote action / archive / unarchive / delete 路径全部不变；
  inject 的 live read 在编辑后下一次 runNode 立刻生效（RFC-041 PR3 §6 已保证，无需新代码）。
- RFC-041 proposal §G7 显式更新一行：「approved 后**body_md / title / scope / tags 由
  RFC-045 放开人工编辑**；supersede 链仍保留用于"语义性替换"，不为"修正错字"承担职责」。

## 5. 与既有 RFC 关系

- **RFC-041**：本 RFC 显式 supersede §G7 一句话约束，并标记 §P143 "`body_md` 不被任何 PATCH"
  的 grep 守卫"未落地、被本 RFC 取代"。其余（distiller / dedup / inject / WS / 权限分发）全部
  沿用。本 RFC 新加 `memory:edit` 权限位、`memory.updated` WS 事件、`PATCH /api/memories/:id`
  路由；前端补 `POST /api/memories` 的 UI 入口（后端零改）。
- **RFC-043**：详情页里若展示一条本次 distill 产出的 candidate，admin 在详情页"候选区"也可
  点击跳 Approval Queue 编辑——本 RFC 不在详情页内嵌编辑入口（避免一个 dialog 在两个路由各开
  一份）。
- **RFC-044**：上游修复 distiller 输入精度，本 RFC 是下游人工补救通道；二者完全正交（RFC-044
  不改 `memories` 行为，本 RFC 不改 distiller 输入构造）。
- **RFC-046**：`node_runs.injected_memories_json` 是 inject 那一刻的**历史快照**（按 RFC-046
  §设计原意"snapshot 不被后续编辑追改"）；本 RFC 的 PATCH 写当前 memories 行，**不**回填任何
  历史 `injected_memories_json`——这一性质本身就是 RFC-046 的卖点（"能看出本 session 用的是哪
  个版本"）。design.md §5.4 会显式锁住这条不变量。
- **RFC-036**：新权限位 `memory:edit` 走 RFC-036 的 permissions 中间件 + admin 默认发放；
  非 admin 命中 403。
- **RFC-039 / RFC-040 / RFC-042**：完全正交，不触碰 runner / scheduler / wrapper / clarify。
