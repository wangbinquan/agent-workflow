# RFC-026 Proposal — 反问节点支持「同 session 内反问」模式（inline session resume）

> 状态：Draft（2026-05-17）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)、上游基线 [RFC-023](../RFC-023-agent-clarify/proposal.md)

## 1. 背景

RFC-023 落地的反问澄清节点（clarify）在每一轮反问 → 用户回答 → agent 重跑这条链路上，**每次都是一个独立的 opencode 进程**：

1. 第 N 轮 agent 跑出 `<workflow-clarify>` → 进程退出。
2. 用户答完 → 平台**新起**一个 opencode 进程跑第 N+1 轮。
3. 为了让新进程"知道前几轮发生了什么"，runner 在 user prompt 里把 **过去所有轮次的 questions + answers** 用 `## Clarify Q&A` 段拼接进去（commit `b5296c0` 明确把"只保留最近一轮"改成"拼接所有历史轮次"）。

这条路径稳定可用，但代价显眼：

- **token 浪费叠加**：每多反问一轮，prompt 头部的历史拼接就增厚一段；如果 agent 反问 3 轮（每轮 5 题 × 4 options），第 4 轮的 prompt 就要带 ~3 轮 × ~1KB 的 Q&A 历史 + framework synthesis + 协议块。
- **agent 上下文断裂**：opencode session 在每轮新进程里都是全新的——agent 看不到自己上一轮在 thinking / tool calls 里推演到哪、跑过哪些 grep、读过哪些文件，只能看到"我之前问了 5 题、用户答了"这种压缩后的二手信息。复杂场景下相当于让 agent 每轮**冷启动重新建模**。
- **响应延迟**：opencode 冷启动 + 加载 agent.md + 重新 grep / index 一遍 worktree 是有固定开销的，多轮反问场景这部分时间被乘以轮次。
- **状态不一致风险**：framework `summariseClarifyAnswer` 是确定性纯函数（design.md §5），但它给出的是"短英文摘要"，与 agent 自己脑子里"我刚刚那题在权衡 A 还是 B"的语境之间存在信息丢失——agent 在第 2 轮重启后可能拍出和它第 1 轮"如果用户选 A 我就打算这么干"完全不同的方向。

而 opencode CLI **已经原生支持** session 续接：`opencode run --session <id>` / `opencode run --continue`（packages/opencode/src/cli/cmd/run.ts:149-158、784 `resume: true`），续接后 opencode 自动把上一会话的完整消息历史 + 工具调用历史 + agent 状态加载回来，新 prompt 只需是"用户对你刚问的题的回答"这一段增量。

平台的 runner 已经把 opencode session ID 从 stdout JSON events 里抓回来（`RunResult.sessionId`，runner.ts:152-153）——目前只用于 observability，不消费。

把这两块拼起来就是本 RFC：**给 clarify 节点加一个配置开关，让用户在创作工作流时选择"独立 session 反问"（当前行为，默认）或"同 session 内反问"（新增）。**

## 1.1 为什么要现在做

- 用户已经把 clarify 用在 PRD 起草 / 代码生成 / bug fix 三条线，反复反映"反问 3 轮以上时第 4 轮 agent 像换了个人"——典型 inline-session 缺位症状。
- opencode `--session` 已稳定上游（master 分支 cmd/run.ts），平台 runner 已经抓到 sessionId，落地代码量极小（估算 backend +120 行、frontend +40 行、shared +30 行）。
- RFC-023 的协议块 / DB schema / 节点拓扑都不需要动，只在 runner.ts spawn 路径 + clarify 节点 schema 上加分支，blast radius 小。

## 1.2 本 RFC 不动哪些地方

- **不动** `<workflow-clarify>` envelope 协议、`extractClarifyEnvelopeBody`、parse 路径——agent 输出格式两种模式完全一致。
- **不动** clarify_sessions 表 schema 主体（仅 node_runs 表加 1 列存 opencode session_id；clarify_sessions 不动）。
- **不动** clarify 节点拓扑：仍是 1 进 1 出、仍靠反向拖动建两条边、仍 awaiting_human 状态、仍 retries / retry_index / clarify_iteration 三计数器正交。
- **不动** review / iterate / sibling cascade 任何路径——本 RFC 仅作用于 **clarify 触发的 agent 重跑** 一条路径；review reject/iterate、retry on technical failure 等其他重跑触发器一律保留现在的 isolated session 行为。
- **不动** wrapper-loop 内"每次 iteration 是一个新 node_run"的语义——loop 跨 iteration 仍是独立 session（loop 的语义就是"重新开始一遍"，跨 iter 续 session 与 loop 语义冲突）。inline 模式仅在**同一 node_run 的 clarify_iteration 维度**复用 session。
- **不动** agent.md frontmatter / agent 表 CRUD——sessionMode 是 clarify 节点字段，不是 agent 字段。
- **不动** workflow schema_version：纯字段追加，v3 直接 readable，不 bump v4（用户已确认）。

## 2. 目标

### 2.1 做

1. **ClarifyNode 新字段 `sessionMode`**（可选 enum）：
   - `'isolated'`（默认，与 RFC-023 落地后行为完全一致——每轮新 opencode 进程 + 历史 Q&A 拼到 prompt）
   - `'inline'`（新增——下一轮 spawn 时带 `--session <previousSessionId>`，prompt 仅含本轮答案 + 简短协议提醒，不重复拼历史 Q&A）
   - 未提供 / 等于 `'isolated'` 时与现行落地零差异（兼容所有 v3 已存工作流）。

2. **node_runs 新增列 `opencode_session_id TEXT`**（nullable）：
   - 每个 agent node_run 完成（status='done'）时，runner 把 `RunResult.sessionId` 写入该列。
   - 已有的 sessionId 抓取逻辑（runner.ts 解析 opencode JSON events）不动；本 RFC 仅把它从内存里持久化下来。

3. **inline 模式 spawn 透传**：
   - clarify 触发 agent 重跑时（`triggerAgentRerunFromClarify`），scheduler 检查上游 clarify 节点的 `sessionMode`：
     - `isolated` → 走原路径（新 session、prompt 拼全部历史 Q&A），零行为差。
     - `inline` → 查 source agent node_run 的 `opencode_session_id`，若非空则 runner spawn 时追加 `--session <id>` 到 opencode 命令行参数；prompt 改用**精简版**，只含本轮 answers + 一行协议提醒；不注入 `{{__clarify_questions__}}` 等历史 token。
   - opencode 加载 session 后自动具备前几轮 messages / thinking / tool calls 上下文。

4. **inline 模式 prompt 精简**：
   - 不再 auto-append `## Clarify Q&A — Last-Round Questions`（opencode session 已有原 questions 在历史里）。
   - **保留** `## Clarify Q&A — User Answers`，但只含本轮（不再拼所有历史轮）+ framework synthesis 一行。
   - 末尾追加一行精简协议提醒："用户已对你的上一轮反问做出选择，本轮请直接产出 `<workflow-output>` 或继续 `<workflow-clarify>`（如仍有阻塞）；二者择一。"
   - `buildClarifyProtocolBlock()` 的完整版协议块在 inline 重跑路径**不**再追加（agent 第一轮已经看到过，session 里已经有）。

5. **inline 失败兜底**：以下任一情形发生时**自动回退到 isolated 行为**（透明回退，不让 task fail）+ node_run_events 记 warning：
   - 上游 source agent node_run 的 `opencode_session_id` 为空（首轮 agent 跑得过快没采到 sessionId / opencode 没吐 session 事件 / 抓取逻辑早期返回）。
   - opencode 进程退出且 stderr 含 `session not found` / 等价错误码（用户自己删了 ~/.local/share/opencode/db、或 opencode 数据迁移导致 session id 失效）。
   - opencode 版本不支持 `--session` 标志（daemon 启动期已用 minVersion 守护，但本路径补一次 defensive 检查）。
   - 工作流定义里 inline 模式但 source agent node_run 的 sessionId 与当前 inline 配置创建时机不一致（譬如 task 启动后用户改了节点 sessionMode → isolated → inline；以"运行时已存在的 sessionId"为准，缺则回退）。
   - 这些 warning 都不阻塞 task；用户在 task 详情节点运行 tab 上看到 `inline-clarify-fallback-to-isolated` 标记。

6. **clarify 节点 Inspector 加 sessionMode 选择器**：
   - segmented 控件，两个选项："独立 session（默认）" / "同 session 内反问"
   - 旁边一行小字解释：每个选项一句话——选 inline 时提示 "agent 保留前几轮上下文，省 token + 响应更快；但当前 session 一旦失效会自动回退"。
   - 编辑器保存路径走现有 workflow PUT，schema 版本 v3 不变。

7. **task 详情节点 Stats tab 显示**：
   - 节点行附加 chip："session=inline" / 默认时不显示（保留 isolated chip 空白以减视觉噪声）。
   - inline 重跑路径成功复用 session 时，节点运行 tab 的事件流加一条 info："Resumed opencode session `<id-prefix>` (clarify_iteration=N)"。
   - 兜底回退到 isolated 时事件流加 warning："inline session unavailable; falling back to isolated this round"。

8. **i18n 与错误码**：
   - 新 i18n key：`clarify.inspector.sessionMode.title` / `clarify.inspector.sessionMode.isolated` / `clarify.inspector.sessionMode.inline` / `clarify.inspector.sessionMode.hint` / `clarify.eventStream.sessionResumed` / `clarify.eventStream.fallbackToIsolated`。
   - 新 warning 码：`inline-clarify-fallback-to-isolated`（带子原因：`missing-session-id` / `session-not-found` / `unsupported-opencode-version`）。

9. **回归防护测试**：
   - 锁定"`sessionMode === 'isolated'` 走与 RFC-023 完全一致路径"——dataclass 比较新旧路径生成的 spawn 命令 + prompt 字符串 byte-for-byte 相等。
   - 锁定"`sessionMode === 'inline'` 且 sessionId 缺失 → 自动回退"。
   - 锁定"`sessionMode === 'inline'` 且 sessionId 存在 → opencode 命令行包含 `--session <id>`、prompt 不含 `## Clarify Q&A — Last-Round Questions`、prompt 含 `## Clarify Q&A — User Answers` 仅本轮"。

10. **migration**：
    - 新 migration 0008 仅加 `node_runs.opencode_session_id TEXT`（nullable，默认 NULL）；不重建表（直接 `ALTER TABLE ADD COLUMN`）。
    - 已存量行 NULL 透明；老 task 上不会触发 inline 路径（即使工作流改 inline，已跑完节点没 sessionId 也走回退）。

### 2.2 不做

- **不做** review 节点等价的 inline session 模式：review reject/iterate 重跑 agent 路径与 clarify 完全不同（review 是"人编辑文档评论 → agent 改稿"，opencode session 续接给 agent 看的"上一轮做了什么"语义和 review 的"用户对成稿提意见"语义不对齐——硬续可能让 agent 误以为自己在追问而非改稿）。如果未来要做，单独 RFC。
- **不做** wrapper-loop 跨 iteration 续 session：loop 的产品语义就是"重新开始"，跨 iter 续会让 `exit_condition` 等机制语义紊乱。loop 内的 clarify 仍可 inline——iteration 内自己续，跨 iteration 各 iteration 独立。
- **不做** opencode session 主动管理（删过期 session / 容量监控）：opencode 自己管 session 持久化（`~/.local/share/opencode/...`），本平台只消费 ID，不管理生命周期。
- **不做** 同一 agent 节点上多个 clarify 节点 / agent-multi 父级共享 session 之类的奇异拓扑——sessionId 一对一绑 agent node_run，agent-multi shard 子 node_run 各自有 session（fanout 后每个 shard 是独立 opencode 进程，本就有各自 sessionId，inline 自然按 shard 续）。
- **不做** YAML 导入导出 schema 变更：sessionMode 是可选字段，不带就 default isolated，旧 YAML 直接读。
- **不做** API 层暴露 sessionId（除 task 详情节点运行 tab 的事件流摘要）；外部 REST 不要暴露 opencode 内部 session 标识。
- **不做** 「跨 task 续 session」之类的语义跳跃——本 RFC inline 限定为同一 task 同一 agent node_run 链路上的连续 clarify 重跑。

## 3. 用户故事

**S1（happy path：inline 模式 3 轮反问）**
工作流：`input → designer(agent-single) → clarify(sessionMode='inline') → reviewDesign(review)`。task 启动 → designer 第一轮跑（clarify_iteration=0、sessionId=`opc_xxx1`），envelope 是 `<workflow-clarify>` 3 题。clarify 节点 awaiting_human，sessionId `opc_xxx1` 已落 node_runs.opencode_session_id。

用户答完 → clarify 触发 designer 重跑：scheduler 读 designer 节点上接的 clarify 节点 sessionMode='inline'，查 source node_run.opencode_session_id=`opc_xxx1`，spawn opencode 命令行追加 `--session opc_xxx1`，user prompt 只是：

```
## Clarify Q&A — User Answers
**Q1: 目标用户是 B2B 还是 B2C？**
- Selected: 纯 B2B
- Synthesis: User chose: "纯 B2B"
**Q2: 预期同时在线用户量是多少？**
- Selected: 1000~10000
- Synthesis: User chose: "1000~10000"
**Q3: 客户端 SDK 需要支持哪些语言？**
- Selected: Python, TypeScript
- Custom: "兼容现有 Java SDK，优先级低"
- Synthesis: User selected: "Python", "TypeScript" with additional note: "..."

---
用户已对你的上一轮反问做出选择，本轮请直接产出 `<workflow-output>` 或继续 `<workflow-clarify>`（如仍有阻塞）；二者择一。
```

opencode 加载 session `opc_xxx1` → agent 看到自己之前问的 3 题 + 现在的回答，直接继续推理。这一轮 sessionId 仍是 `opc_xxx1`（同 session、追加消息）。designer 再吐 `<workflow-clarify>` 2 题 → 用户答 → designer 第 3 轮仍续接 `opc_xxx1`，最终吐 `<workflow-output>` → review → done。整个反问环只有 1 个 opencode session，token 消耗对比 isolated 减约 40-60%（具体看反问轮数 + 历史长度）。

**S2（isolated default：默认行为零差异）**
用户没改 sessionMode（默认 isolated）。两轮反问行为 byte-for-byte 与 RFC-023 落地后一致——同样的全量历史 Q&A 拼接、同样的 `buildClarifyProtocolBlock()` 完整协议块、同样的新 session ID 每轮变。回归测试断言这一路径生成的 spawn args + prompt 字符串与本 RFC PR 之前完全相同。

**S3（inline 兜底回退：sessionId 缺失）**
工作流 sessionMode='inline'，但 designer 第一轮 opencode 进程因极速异常退出（如用户中断）没吐 session JSON event，runner 没采到 sessionId。第二轮 scheduler 查 source.opencode_session_id=NULL → 自动回退到 isolated 路径（带全量 Q&A 历史 + 完整协议块、新 session）。task 详情节点运行 tab 事件流显示 warning：「inline session unavailable (missing-session-id); falling back to isolated this round」。下一轮如果新 session 成功落 sessionId，再下一轮的 inline 又能恢复。**用户的工作流不会因此 fail。**

**S4（inline + agent-multi 多 shard）**
agent-multi 分 3 shard，每个 shard 是独立 opencode 进程、独立 sessionId。其中 shard B 反问 → 用户答 → shard B 重跑时带 `--session <B 的 sessionId>` 续接（仅续这一个 shard 的 session）。shard A、C 不受影响，各自独立完成。

**S5（inline + opencode session 失效）**
inline 模式跑到第 2 轮反问时，opencode 因 schema migration 等原因报 `session not found`（stderr 检测）。runner 标该 node_run failed + warning `inline-clarify-fallback-to-isolated: session-not-found`；scheduler 触发自动 retry（retry_index+1）+ retry 走 isolated 路径（不带 `--session`），prompt 退化为带全量历史 Q&A 拼接。task 继续推进。

**S6（编辑器 UI：切换 sessionMode）**
用户在编辑器选中 clarify 节点 → Inspector 右栏看到 sessionMode 段：「独立 session（默认）」/「同 session 内反问」segmented，默认选前者。切到后者后保存（workflow PUT），$schema_version 仍 3。重启 task 后下次反问走 inline 路径。

**S7（task 详情查 session 复用）**
task 详情节点运行 tab 显示某 agent node_run 的事件流。inline 模式下事件流出现 info 行「Resumed opencode session `opc_xx…` (clarify_iteration=2)」，提示用户"这一轮是续接的"。复制 sessionId 前 8 位用于本地 `opencode --session <id>` 调试。

## 4. 验收标准

### 功能

- **A1（S2 isolated 零差异）**：工作流不带 sessionMode 字段或显式 `'isolated'` → 与 RFC-023 落地后行为 byte-for-byte 一致（spawn 命令行 + user prompt 字符串）。
- **A2（S1 inline happy path）**：sessionMode='inline' 且 source.opencode_session_id 非空 → spawn 命令行含 `--session <id>` + user prompt 不含 `## Clarify Q&A — Last-Round Questions` + user prompt 含 `## Clarify Q&A — User Answers` 仅本轮 + 末尾精简协议提醒。
- **A3（sessionId 持久化）**：agent node_run 完成时 sessionId 写入 node_runs.opencode_session_id；首次 NULL 后续轮按需更新。
- **A4（inline 回退：sessionId 缺失）**：source.opencode_session_id=NULL → 自动走 isolated 路径 + node_run_events 加 warning `inline-clarify-fallback-to-isolated: missing-session-id`，task 继续。
- **A5（inline 回退：session-not-found）**：mock opencode 报 stderr 含 "session not found" → 本轮 node_run failed + 触发 retry（retry_index+1，走 isolated）；warning code `session-not-found`。
- **A6（inline + agent-multi）**：3 shard 各自独立 sessionId；shard B 反问 + inline 模式下重跑只续 shard B 的 session，A/C 不受影响。
- **A7（loop 跨 iter 不续）**：wrapper-loop 内 designer→clarify 跑多轮 iteration；同一 iteration 内反问续 session，跨 iteration 独立 session（loop iteration 边界处 sessionId 重置）。
- **A8（Inspector UI 切换）**：编辑器 clarify 节点 Inspector 切换 sessionMode → workflow PUT 落盘 → 重新 launch task 后 inline 行为生效。
- **A9（事件流）**：inline 成功复用 → 节点运行 tab 出现 "Resumed opencode session" info；回退 → 出现 fallback warning。
- **A10（i18n 完整）**：zh-CN + en-US 文案覆盖所有新 key。
- **A11（migration 透明）**：现有 v3 workflow（含 RFC-023 clarify 节点但不带 sessionMode 字段）经 0008 migration 后 GET 返回不带 sessionMode 字段、行为不变。
- **A12（review reject/iterate 路径不变）**：review reject 触发 agent 重跑时**不**带 `--session`（review 路径未启用 inline）；强制断言 review 路径生成的 spawn 命令行不含 `--session`。
- **A13（手动 retry 不带 session）**：技术失败 retry（retry_index+1）一律 isolated；不带 `--session`。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** RFC-023 / RFC-014 / RFC-005 既有测试零退化——本 RFC 仅追加分支、不改既有路径；strict diff guard：`services/review.ts`、既有 isolated clarify 重跑路径 diff = 0。
- **B3** backend tests **≥ +14**：
  - sessionId 持久化 1
  - inline spawn 路径 3（happy + 缺 sessionId 回退 + session-not-found）
  - prompt 精简 3（不含 Last-Round Questions + 含 User Answers 仅本轮 + 末尾精简提醒）
  - scheduler 分支 2（isolated 默认路径不动 + inline 分支调用 runner 带 `--session`）
  - migration 0008 1（ALTER TABLE 加列 + 已有行 NULL + 回滚 OK）
  - agent-multi shard 续 session 2
  - review reject 不污染 inline 守卫 1
  - loop 跨 iter session 重置 1
- **B4** frontend tests **≥ +6**：
  - Inspector segmented 切换 2
  - 节点 Stats tab chip 1
  - 事件流 info/warning 渲染 1
  - i18n 完整性 1
  - 默认值兜底（旧节点无 sessionMode）1
- **B5** e2e 加 1 子 case：`e2e/clarify.spec.ts` 扩展 inline 模式 happy path（fixture stub-opencode 第一轮吐 sessionId + clarify、第二轮根据 `--session` 检测决定输出格式），断言 spawn 命令行中含 `--session`。
- **B6** 单二进制构建包体积 / 启动时间不退化（估算 < 5KB 增量）。

### 回归防护

- **C1** `tests/clarify-inline-isolated-parity.test.ts` 顶部注释：锁定"sessionMode='isolated' 路径生成的 spawn args + prompt 与 RFC-023 落地版本 byte-for-byte 相等"——任何后续 refactor 让这条 diff ≠ 0 必须主动改这条测试，迫使讨论。
- **C2** `tests/clarify-inline-spawn-args.test.ts`：源代码层 grep `--session` 出现位置在 runner.ts 内、且仅出现在 inline 分支；防 isolated 路径误带。
- **C3** `tests/clarify-inline-fallback.test.ts`：枚举所有兜底回退 reason（missing-session-id / session-not-found / unsupported-opencode-version），每条都覆盖。
- **C4** `tests/review-reject-not-inline.test.ts`：构造 review reject 路径，断言生成 spawn 命令行**不**含 `--session`、prompt 不走 inline 精简路径。
- **C5** `tests/clarify-inline-loop-isolation.test.ts`：wrapper-loop 内同 agent 跑两个 iteration，断言两个 iteration 的 spawn 命令行**不**互续 session（跨 iter 边界 sessionId 隔离）。

## 5. 关键技术选型理由

1. **opencode `--session` vs 长驻进程 + stdin 喂答案**
   - `--session` 是 opencode 已原生支持的 idempotent CLI 模式，runner 改动量极小（仅追加一个 flag）；进程生命周期与 isolated 模式一致——spawn / wait exit / 拿结果。
   - 长驻进程方案需要 daemon 维护进程池、worktree 锁要扩展支持"agent 进程挂起期 worktree 仍占用但 idle"、daemon 重启 / 30s 优雅关闭都难处理；本就有 single-process / DB 串行写约束，长驻进程方案与之冲突明显。
   - **选 `--session`**。

2. **新字段放 clarify 节点 vs 放 agent 节点 vs workflow 全局**
   - clarify 节点：粒度最细，同一 workflow 里多个 clarify 节点可不同策略；语义上"决定怎么续"是 clarify 行为的一部分而非 agent 内禀属性（同一 agent 在 A 节点的 clarify 走 inline、在 B 节点走 isolated 完全合理）。
   - agent 节点 / agent frontmatter：agent 是被复用资源，影响所有引用它的节点，粒度过粗。
   - workflow 全局：一刀切，与"clarify 节点本就是不同位置不同行为"的产品直觉相悖。
   - **选 clarify 节点字段**（用户已确认）。

3. **sessionId 存哪：node_runs 列 vs clarify_sessions 列**
   - node_runs.opencode_session_id：sessionId 是 agent node_run 维度产物（每个 agent run 一个 session）；clarify_sessions 是反问事件维度（一个 agent run 出 1 个 clarify_session）。把 sessionId 放在 agent node_run 上语义最干净；clarify_sessions 表的字段保持 RFC-023 设计不变。
   - clarify_sessions.opencode_session_id：会迫使所有 lookup 都走 clarify_sessions（包括非 clarify 路径的 sessionId 用途，比如未来 task 详情 debug "agent X 这一轮 session 是啥"也得查 clarify_sessions）——耦合反向。
   - **选 node_runs 列**。

4. **inline 模式 prompt 是否要再注 `<workflow-output>` 协议块**
   - 完整版协议块 agent 第一轮已经看到（在 user prompt 末尾），session 历史里有；inline 重跑时再注一次是冗余 + 浪费 token。
   - 但完全不注又怕 agent "忘了规则"——折中：注一行精简协议提醒（"二选一，要么 output 要么 clarify"），不重复完整 JSON schema。
   - **选精简提醒**。

5. **失败回退 vs 失败 fail task**
   - inline 是优化路径，失败回退到 isolated 是天然兜底；session 失效并不意味着 task 必须失败——同样的回答配 isolated 重跑能完成任务。
   - 如果硬失败，用户体验断崖（"我都答完题了你说 session 找不到？"）；自动回退 + warning 显示 + 重启 task 时新 session 又能正常 inline，路径自愈。
   - **选自动回退**。

6. **wrapper-loop 跨 iter 是否续 session**
   - loop 的 `exit_condition` / `max_iterations` 等机制依赖"每次 iter 是独立次跑"的语义；跨 iter 续 session 会让 agent 误以为"我们在同一个会话连续讨论"，与 loop "重新开始一次"的语义直接冲突。
   - clarify_iteration 在同一 node_run 内递增（同一 iter 内反问），loop iteration 在不同 node_run 间递增；天然分层。
   - **选 loop 跨 iter 不续 session**。

## 6. 与其它 in-flight / 已落地 RFC 的关系

- **RFC-023 clarify**：本 RFC 的直接基础。所有 RFC-023 路径在 sessionMode='isolated' 时**完全保留**；inline 模式是新增并列分支。
- **RFC-022 agent dependsOn**：dependents 通过 `OPENCODE_CONFIG_CONTENT` 一次性注入，与 session 续接正交——opencode `--session` 加载的是会话历史，agent 定义仍每次按 inline JSON 读；本 RFC 不影响 RFC-022。
- **RFC-014 sibling cascade**：review reject 走 sibling 同步重生 → 不走本 RFC inline 路径（A12 防护）。
- **RFC-021 task-detail-tabs**：节点运行 tab 的事件流渲染本 RFC 的 info / warning 行——本 RFC 不抢 RFC-021 范围，仅复用既有事件流组件。

## 7. 风险

| 风险 | 评估 | 缓解 |
| --- | --- | --- |
| opencode `--session` 在某 minor 版本回归 / 改语义 | 中 | daemon 启动版本守护 + defensive 检测 + 自动回退到 isolated |
| inline 模式 agent session 越来越长（多轮反问 + 上轮 thinking / tool calls 累积） | 低 | opencode 自己有上下文管理 / 压缩；多到溢出时 opencode 报错 → 本 RFC 兜底回退 |
| 用户切到 inline 后 sessionId 没采到造成永久回退 | 低 | sessionId 抓取已稳定（RunResult.sessionId）；事件流明示原因 + 用户改回 isolated 一行操作 |
| inline 模式下 framework synthesis 与 agent 自己脑子里的"刚刚我问的题"细节不一致 | 极低 | inline 模式下 agent 已通过 session 看到原 questions，synthesis 仅作为"用户明确表达"的二次锚定；冗余信息不冲突 |
| review reject 路径误用 inline 字段 | 低 | C4 测试强制守卫 + 代码层 if 分支严格只在 clarify 触发路径检查 sessionMode |
| 跨 task 误续 session | 极低 | sessionId 绑 node_run、node_run 绑 task；查询路径天然限定 taskId |

## 8. 后续可能的延展（v1 不做）

- review 节点 inline 模式（review reject/iterate 也复用上一轮 session）。
- wrapper-loop 内可选"跨 iter 续 session"开关（产品语义需要先讨论清楚）。
- 跨 task 续 session（譬如 task 失败后用户再启动一个新 task 续上次的会话）。
- inline 模式下显式让 agent 看到"框架已经替你压缩过 N 轮历史"的元信息。
- opencode session 主动 GC（多轮反问后过期 session 清理）。
