# RFC-042 — Envelope Follow-up Recovery（无 envelope 同 session 追问 + 默认重试 3 次）

Status: Draft
Author: WangBinquan
Created: 2026-05-19

## 背景

生产实跑里 agent 节点经常因为 opencode 子进程「跑完了 / 跑了一半 / 多轮 tool-call 后忘了协议要求」而漏掉 `<workflow-output>` envelope，runner 在 `services/runner.ts:550` / `558` 把这种 run 标 `failed` + `errorMessage = 'no <workflow-output> envelope found in stdout'`。当前 scheduler 的重试策略：

- 默认 `retries=0`（`scheduler.ts:632`），节点直接红，整条 task 失败。
- 即便用户在 Inspector 里手填 retries > 0，重试也是**全新 session**：rollback git stash → 重新 spawn opencode、重新发完整 user prompt。这意味着 agent 在第一轮里花掉的 token 全废，且如果是"模型只是漏了 envelope、内容已经在 stdout 里"，新 session 也得从头再跑一遍。

`<workflow-clarify>` 这边也是同样模式：当 reply 同时含两种 envelope 或都没含、或 clarify body 解析失败时，runner 直接给 `failed` 状态、靠 retry 重跑全新 session。

用户的需求是把这种"模型协议错误"识别成"可在同 session 内修复"的子类，把追问能力做进框架自身——**让框架自己跟模型说"你刚才没按格式输出，请补一发"**，而不是无脑炸成 failed。同时把默认重试从 0 提到 3，给系统一个起码的容错空间。

## 目标

- (G1) **同 session 追问恢复**：当 opencode 正常退出（exitCode === 0）且 stdout 里捕到 sessionID 时，若 envelope 解析失败（none / both / clarify-malformed），下一次重试**复用同一 opencode session**（`--session <id>`，复用 RFC-026 已有的能力），追加一段简短的 follow-up 提示词把模型拉回协议轨道：
  - **未挂接 clarify 节点**：追问"如果你已经完成本轮工作，请按之前指定的格式输出 `<workflow-output>` envelope；如果还没完成，请先把剩余工作做完再输出 envelope。无论哪种情况，本次回复必须以 envelope 收尾，不允许再省略"。
  - **已挂接 clarify 节点**：追问"如果本轮工作已经完成，请按 RFC-039 的强化偏向选择 `<workflow-clarify>`（默认偏向，仍有未决项就反问）或 `<workflow-output>`（输入已无歧义才允许）二选一收尾。如果还没完成，请先把剩余工作做完。无论如何，本次回复必须含且仅含其中一个 envelope"。当 clarify session 里用户上一轮按了「继续反问」（directive=continue），追问文案同步强化"用户已显式要求你再发一轮 clarify，除非每个细节都被上一轮答案彻底解决"——把 RFC-039 的偏向带进追问。
- (G2) **错误分支：同 session 追问 vs 全新 session 重试**：节点同一份 `retries` 预算被两种策略共享：
  - 走 (G1) 同 session 追问：opencode `exitCode === 0` **且** 上一次 run 已捕到 `sessionId` **且** 上一次 run 的 stdout 里有任何 agent text 行（说明模型确实跑了，只是协议没满足）**且** 失败原因属于 envelope 形态错（见 §"识别集合"）。
  - 走全新 session 重试：opencode 异常退出（exitCode !== 0，含 timeout / signal-killed / process-crash），或上一次 run 没拿到 sessionId / 没有 agent text，或失败原因属于运行时错（spawn 失败 / opencode 自身错）。
- (G3) **默认 retries 从 0 改 3**：`scheduler.ts:632` 把 `pickNumber(node, 'retries') ?? 0` 改成 `?? 3`。用户在 Inspector 上显式填 `0` 仍然 0；显式填 `5` 仍然 5；只对"作者没设" / 老工作流定义没字段这两种情况生效。
- (G4) **既有验收路径零退化**：runner 仍然在 envelope none / both / clarify-malformed 情况下返回 `status='failed'`；scheduler 仍然按 retries 计数；都耗尽后 task 仍然 `failed`。追问只占 retry 预算的一格，不无限重试。

## 非目标

- 不引入 envelope 之外的新协议（不发明新的 envelope 类型 / 不改 `<workflow-output>` / `<workflow-clarify>` 结构）。
- 不引入"启发式抽取"——不试图从模型的非 envelope 文本里"猜" port 输出。如果模型不按格式补出 envelope，重试照样失败，框架不去硬解。
- 不修改 runner 现有的 envelope 解析三件套（`detectEnvelopeKind` / `extractLastEnvelope` / `extractClarifyEnvelopeBody`）。
- 不改 review / clarify / loop / git wrapper / fan-out 的 retry 语义本身——retry 计数语义、`retry_index` 单调递增、cascade downstream 全保留 RFC-005 / RFC-014 现状。
- 不改前端 Inspector 上的 retries `<NumberInput>` 控件（默认值依然为空 → 走后端默认；用户显式填仍尊重）。
- 不改 `node_runs` 表结构 / 不写 migration。识别"上一次 run 是否符合同 session 追问条件"完全靠**最新一行 node_run 的现有列**（status / exitCode / opencodeSessionId / errorMessage）。
- 不动 opencode 源码。

## 识别集合：什么 errorMessage 触发同 session 追问

`runner.ts` 当前在以下 4 个分支把 `status` 标 `'failed'`：

| 分支                       | errorMessage 文案                                                                       | 是否走同 session 追问 |
| -------------------------- | --------------------------------------------------------------------------------------- | --------------------- |
| envelope none              | `no <workflow-output> envelope found in stdout`                                         | ✅                    |
| envelope both              | `clarify-and-output-both-present: agent reply contained BOTH ...`                       | ✅                    |
| clarify body 解析失败      | `<errCode>: <detail>` 或 `clarify-questions-malformed: empty body`                      | ✅                    |
| 进程异常 / 超时 / 非零退出 | `opencode exited with code N` / `node-timeout: exceeded Nms` / `node <id> threw: <msg>` | ❌（走全新 session）  |

并且即便文案命中前 3 类，还要满足：

1. `exitCode === 0`（opencode 本身没崩）。
2. 上一行 `node_runs.opencodeSessionId` 非空（说明 opencode 真正 emit 了 session.created）。
3. 上一行 `node_run_events` 有至少 1 条 `kind='text'` 行（说明模型确实输出了内容、不是空回复）。

任何一条不满足 → 回退全新 session 路径。

## 用户故事

- **US1**：我（工作流作者）拿一个新模型跑工作流，agent 完成了 codegen 任务但忘了输出 envelope。当前实测：节点直接红，需要我手动重跑或在 Inspector 上调高 retries 再重跑。改完后：框架自动用同 session 追问"按格式输出 envelope"，模型补一发，节点 done，整条工作流不被一次协议失误拖死。
- **US2**：我（任务发起人）给 agent 挂了反问节点，点了「继续反问」，agent 第二轮回了一段长 reasoning 但没收 envelope。当前实测：节点红、需要重跑整轮 clarify（费 token、慢、用户体验差）。改完后：框架在同 session 追问"按 RFC-039 强偏向继续反问或 output"，模型补 `<workflow-clarify>` 拉起下一轮——用户感受不到协议失误。
- **US3**：opencode 进程因为 OOM / 超时被 SIGKILL（exitCode !== 0）。当前实测：retries 计数照样消耗、走全新 session。改完后：行为不变——崩溃类失败仍然全新 session，不被错误地塞进同 session 追问（同 session 已经死了，没法追问）。
- **US4**：我（工作流作者）没在 Inspector 上填 retries 字段。改完后：默认 3 次，第一次失败靠同 session 追问救回来的概率显著上升；如果是 3 次都救不回来（说明问题不在 envelope），节点照红——和现状一致。

## 验收标准

### A1 — 同 session 追问触发条件

scheduler 的 attempt 循环里，第 N+1 次 attempt（N ≥ 0）走"同 session 追问"分支当且仅当：

- 第 N 次 attempt 的 `lastResult.status === 'failed'`，且
- `lastResult.exitCode === 0`，且
- 最新 `node_runs.opencodeSessionId` 非空，且
- `lastResult.errorMessage` 以下面任一前缀开头：
  - `no <workflow-output> envelope found in stdout`
  - `clarify-and-output-both-present`
  - `clarify-questions-malformed`
  - `clarify-questions-`（其它 clarify 解析 errCode）

否则走原全新 session 路径（rollback snapshot + 新 spawn）。

### A2 — 同 session 追问 prompt 文案

`renderUserPrompt` 不变；新增 `renderEnvelopeFollowupPrompt(input)` 渲染一段短文案（不重发完整 prompt / 不重发 inputs / 不重新跑模板代入），由 runner 在 `resumeSessionId !== undefined && envelopeFollowup === true` 时使用：

- **无 clarify channel**：

  ```
  ---
  **Envelope missing — follow-up.** Your previous reply in this session did not contain a `<workflow-output>` envelope. The framework cannot parse your result without it.

  - If you have finished the requested work, end your NEXT reply with a `<workflow-output>` block using the EXACT format previously specified in this session (the same port list, the same `<port name="...">...</port>` shape). Do not summarize, do not omit the block.
  - If you were not finished, complete the remaining work first, THEN emit the `<workflow-output>` block. The envelope is mandatory either way.
  - Do not emit anything after the closing `</workflow-output>` tag.
  ```

- **有 clarify channel**：

  ```
  ---
  **Envelope missing — follow-up.** Your previous reply in this session did not contain a valid `<workflow-output>` or `<workflow-clarify>` envelope. The framework cannot parse your result without exactly one of them.

  - By default, per the clarify protocol previously stated in this session, your next reply should be (B) `<workflow-clarify>` — ask back to disambiguate. Emit (A) `<workflow-output>` directly ONLY when every decision is already pinned down. (RFC-039 bias still applies.)
  - If the previous reply was an in-progress draft, finish the work first, then commit to EXACTLY ONE envelope.
  - A reply must contain EITHER one `<workflow-output>` block OR one `<workflow-clarify>` block — NEVER both, NEVER neither.
  - Do not emit anything after the closing envelope tag.
  ```

- **有 clarify channel + directive=continue**（用户点了「继续反问」）：在上述 clarify channel 文案末尾再追加一段 RFC-039 强偏向短句：
  ```
  The user has explicitly clicked "Keep clarifying" — unless every still-unresolved detail has been pinned down by the answers earlier in this session, your reply is REQUIRED to be another `<workflow-clarify>` envelope. Skipping to `<workflow-output>` for the sake of brevity is not allowed.
  ```

### A3 — 重试计数语义

- 同 session 追问消耗一格 retry 预算（`retry_index` 单调 +1），和现有重试完全等价。
- 同 session 追问失败之后，scheduler 仍然按 retry 剩余预算决定下一轮：剩余预算 > 0 且**当次失败仍属识别集合 ∧ 仍有 sessionId** 时继续同 session 追问；否则降级为全新 session 重试（rollback snapshot + 新 spawn）。
- retries 全部耗尽后，节点 `status='failed'`，task 按 RFC-005 / 现状走 cascade。

### A4 — 默认 retries 改 3

- `scheduler.ts:632` 由 `pickNumber(node, 'retries') ?? 0` 改成 `?? 3`。
- Inspector 上未填 retries 的老工作流定义、新建工作流定义、YAML 导入路径都按 3 处理。
- 用户显式填 0 / 1 / 5 仍然 100% 尊重——只动 `?? 0` fallback 的右值。

### A5 — 全新 session 重试路径回归（崩溃 / 超时）

- `exitCode !== 0`：仍然 rollback snapshot + 新 spawn（行为 100% 不变）。
- `lastResult.opencodeSessionId === undefined`（进程崩在 emit `session.created` 之前）：即便 errorMessage 文案命中识别集合，也强制走全新 session（同 session 已经死了）。
- `agentText` 完全空（exitCode=0 但模型一字未出）：强制走全新 session（追问没有 session 上下文意义）。

### A6 — review-iterate / clarify-rerun 路径正交

- RFC-005 review reject/iterate 重跑、RFC-023 clarify-driven rerun、RFC-014 sibling-iterate：这些**不是** retry，scheduler 走的是不同 mint 路径（新 `clarifyIteration` / 新 `reviewIteration`）。同 session 追问只在**process-retry 内层 attempt 循环**生效，不污染上述路径。
- RFC-026 inline-mode clarify 已经使用 `resumeSessionId` 续 session——同 session 追问也走 `--session`，但二者不冲突：clarify rerun 是新一行 node_run（`retryIndex === 0`，inherit prior sessionId）；envelope 追问是同一行 node_run 的下一格 retry attempt（`retryIndex += 1`，复用本行第一次 attempt 的 sessionId）。

### A7 — 持久化追问事件

每次 scheduler 决定走"同 session 追问"分支时，在 `node_run_events` 新增一条 `kind='text'` 行，payload 形如 `[rfc042/envelope-followup] {"reason":"envelope-missing"|"both-present"|"clarify-malformed","retryAttempt":N}`（参照 RFC-026 `[rfc026/inline-session-resumed]` 事件 tag 风格）。前端不消费——只作运行时审计 / 日志可追溯，方便回放调查。

### A8 — 测试矩阵

按 CLAUDE.md "Test-with-every-change" 落地：

1. **shared prompt 渲染**：新增 `renderEnvelopeFollowupPrompt` 单测 6 case（无 clarify channel / 有 clarify channel / clarify channel + directive=continue 三种文案锚点 + 各自的 envelope 接尾守卫 + RFC-039 短语在 continue 分支 + 不含老的 RFC-039 stop trailer）。
2. **runner 同 session 追问执行**：mock-opencode 加 `MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV` 钩子，新增 `runner-envelope-followup.test.ts` 4 case（resumeSessionId 在 argv / followup prompt 不含 inputs 内容 / followup prompt 命中关键锚点 / opencode 没 emit session 时 runner 拒绝 resumeSessionId）。
3. **scheduler 分支判定**：新增 `scheduler-envelope-followup-branch.test.ts` 8 case：
   - 第一次 envelope=none + exitCode=0 + 有 sessionId → 第二次 attempt 走 followup（argv 含 `--session`）。
   - 第一次 envelope=none + exitCode=137 → 第二次走全新 session（argv 不含 `--session`）。
   - 第一次 envelope=none + exitCode=0 + 无 sessionId → 全新 session。
   - 第一次 both-present → followup。
   - 第一次 clarify-malformed → followup。
   - followup 失败两次 + retries=3 → 第三次仍 followup（如果再次满足识别集合）；如不满足则降级。
   - 第一次 exitCode=0 + agentText 全空 → 全新 session。
   - 第一次 spawn 失败（throw）→ 全新 session。
4. **默认 retries=3**：新增 `scheduler-default-retries.test.ts` 4 case（未填 retries → 走 3 / 显式填 0 → 走 0 / 显式填 5 → 走 5 / YAML 导入未含字段 → 走 3）。
5. **RFC-039 续穿透 followup**：新增 `scheduler-envelope-followup-rfc039.test.ts` 2 case（hasClarifyChannel=true 且 directive=continue → followup prompt 含 RFC-039 强语短句；directive=stop 时 followup 文案不含 RFC-039 短句）。
6. **正交回归**：跑通既有 `scheduler-clarify-inline.test.ts` / `scheduler-rfc040-wrapper-await.test.ts` / `scheduler-clarify*` / `runner-resume-session-flag.test.ts` 全套零退化。
7. **`node_run_events` 审计行**：新增 `node-run-events-followup.test.ts` 1 case（成功走一次 followup 后查 events 表，存在 `[rfc042/envelope-followup]` 行）。
8. **源码层 grep 守卫**：scheduler.ts 不得退回 `?? 0` 的 retries 默认（防 refactor 误改回去）；prompt.ts 必须导出 `renderEnvelopeFollowupPrompt`。

### A9 — 三件套与 CI

- 本地 `bun run typecheck && bun run test && bun run format:check` 全绿。
- GitHub Actions 六 jobs 全绿（无新增 jobs）。
- 不新增 Playwright e2e——本 RFC 是后端 / shared 改动，前端零变化，e2e 路径不覆盖。

## 风险与权衡

- **R1（同 session 追问污染上下文）**：模型在 followup 那一轮看到一个新的「Envelope missing — follow-up」短消息，会不会被它带偏？文案设计偏短 + 复用既有 envelope 描述词（`<workflow-output>` / `<workflow-clarify>`），不引入新协议字段；模型大概率把它解读为"补一发"指令。仍有概率被它带歪——但反正不带也会重跑全新 session，followup 救一次成功率高于 0 已是净正收益。
- **R2（默认 retries=3 加重 token 消耗）**：3 次 vs 1 次确实多消耗。但目标是把"协议失误"这种廉价错误恢复掉，3 次的上限对正常工作流不会触发（成功就早退出）；对真坏的 agent 节点，3 次失败再红和 1 次失败再红的下游影响是一样的（task 都失败）。可接受。
- **R3（同 session 追问 + RFC-040 wrapper resume 互相干扰）**：RFC-040 处理的是 `awaiting_human / awaiting_review` 上抛续跑；本 RFC 处理的是 `failed` 的 retry 内层循环——二者作用面正交（retry 不上抛 awaiting，followup 只在内层 attempt 循环里跑完一格）。已在 A6 列明，测试矩阵专门跑过相关 wrapper 测试零退化。
- **R4（resumeSessionId 已被 RFC-026 用于 inline-mode clarify）**：新分支会不会和 RFC-026 抢位？不会——inline-mode 走的是 `clarifyIteration > 0 && retryIndex === 0` 的 fresh clarify rerun，新行 node_run 上的第一次 attempt；envelope followup 走的是同一行 node_run 的下一次 retry attempt（`retryIndex > 0`）。scheduler 优先级：先 RFC-026 决定要不要 inline rerun（外层 attempt 0），再决定要不要进 followup 分支（内层 attempt 1..N）。两路 resumeSessionId 来源不同：RFC-026 取上一轮 clarify rerun 的 sessionId（`readPriorAgentSessionId`），本 RFC 取本行 node_run 的第一次 attempt 自己的 sessionId（`lastResult.sessionId`）。
- **R5（模型在 followup 里又一次漏 envelope）**：算一次正常 retry 失败。若 retries 预算还剩、识别集合仍命中、sessionId 仍在 → 继续 followup（最坏 3 次都漏）；若任一条件失败 → 降级全新 session。无死循环风险。
- **R6（已有 task 跨升级行为）**：升级时点之前已生成的 node_runs 不重跑；新 task / 新 attempt 享受新行为。零 migration。

## 与已落地 RFC 的关系

- **RFC-005 / RFC-014 retry semantics**：本 RFC 在 process-retry 内层 attempt loop 上加分支，retry_index 单调递增、cascade downstream 全保留。
- **RFC-023 clarify channel + bi-modal preamble** + **RFC-039 clarify ask bias**：本 RFC 在 followup 文案里复用 RFC-039 的"默认偏向 clarify"短句；不动 RFC-023 envelope 协议。
- **RFC-026 inline clarify session resume**：本 RFC 复用 RFC-026 的 `--session <id>` 透传机制（`runner.ts:871-872`）和 `node_runs.opencodeSessionId` 持久化（`scheduler.ts:859-863`），但走的是不同 attempt 维度（见 R4）。
- **RFC-040 wrapper awaiting-bubble**：完全正交，作用面互不重叠（见 R3）。
- **RFC-041 platform memory**：完全正交。

## Follow-up（已超被 RFC-049 取代） — markdown_file 路径协议在 envelope followup 中同步提示

> **Superseded by [RFC-049](../RFC-049-port-content-repair-followup/proposal.md)**（2026-05-20）：RFC-049 把"端口内容校验失败 → 同 session 追问"做成了一个统一框架，markdown_file 的两步协议提示由 `markdownFile` 这个 `OutputKindHandler` 的 `buildPromptGuidance`（首轮）+ `buildRepairBlock`（followup）共同负责。`renderEnvelopeFollowupPrompt` 不再硬编码 markdown_file 字眼——shared 端只拼接 backend `composePerKindRepairBlocks` 预渲染出的 `perKindRepairBlocks` 字符串数组。本节保留作历史记录；RFC-042 已实现的"envelope 形态错 → 同 session 追问"机制零退化。
>
> 状态：Planned（RFC-042 主体已 Done + merged，本节是后续增量）。
> 触发：实际运行中观察到 followup 这一轮，模型仍然只给 `<port>` 内塞了一段路径但**没有落盘**真实文件（envelope 形态合法，但下游 `resolvePortContent` / `markdown-file-read-failed` 失败），或者 followup 这一轮再次漏 envelope、且补的 envelope 里 markdown_file port 又是空路径 / placeholder。
> 关系：与本 RFC 已落地的 G1/G2/G3/G4 正交补强；不改 followup 触发条件、不改默认 retries=3、不改全新 session 路径。只在 followup prompt 文案里加一段 markdown_file 提醒。

### F1（背景）

`buildProtocolBlock`（`packages/shared/src/prompt.ts:383`）首轮已经针对 markdown_file 端口渲染两步协议（先落盘、再只给 worktree-relative 路径），并通过 `buildMarkdownFilePortGuidance`（`prompt.ts:460`）把"emit only a path without the file behind it will fail the run"写得很重。**但 `renderEnvelopeFollowupPrompt`（`prompt.ts:589`）不感知 outputKinds，followup 短指令完全没提 markdown_file 的两步协议**。后果：

- followup 这一轮 agent 在同 session 续跑时，session 上下文里第一轮的 protocol block 还在，按理论模型应该记得；但实测里 envelope 漏发本身就是"模型把协议忘了一半"的信号——followup 提醒得越具体、补救成功率越高。
- 如果 agent 的 followup 回复里 markdown_file port 写的是路径但路径不存在（因为它根本没调 Write/Edit 工具），envelope 解析会通过 ⇒ runner 走 `resolvePortContent` ⇒ 命中 `markdown-file-read-failed` ⇒ 节点仍 failed；但 errorMessage 不在 RFC-042 识别集合里（不是 `no <workflow-output>` / `both-present` / `clarify-questions-*`），下一次 attempt 就降级走全新 session、白烧 token。

### F2（目标 / 非目标）

- (G-F1) 当本节点的 `agentOutputKinds` 里**任一** port 声明为 `markdown_file` 时，`renderEnvelopeFollowupPrompt` 在主 bullets 之后追加一条**专门的 markdown_file 两步协议提醒**——内容与首轮 `buildMarkdownFilePortGuidance` 等价（让模型"先落盘、再只发 worktree-relative 路径"），但**短一档**，因为 followup 是补丁不是教学。
- (G-F2) 当本节点的 `agentOutputKinds` 里**没有任一**端口是 markdown_file 时，followup prompt 文案完全不变（零行噪声）。
- 非目标：
  - 不把 `markdown-file-read-failed` 加入 RFC-042 识别集合（那是 envelope-解析后才发生的下游错误，需要的不是同 session 追问而是 RFC-005 全新 session 重试 + 主 prompt 已有的 `buildMarkdownFilePortGuidance`；不在本 follow-up 范围）。
  - 不改 `buildProtocolBlock` / `buildMarkdownFilePortGuidance`（首轮已经写得够重；本 follow-up 只补 followup 这一面）。
  - 不改 outputKinds schema / 不改 envelope 解析。

### F3（验收）

- **F-A1**：`renderEnvelopeFollowupPrompt` 入参追加 `agentOutputKinds?: AgentOutputKindsMap`（可选，向后兼容）+ `agentOutputs?: readonly string[]`（用来列出哪些 port 名是 markdown_file）。两个字段都缺省时 followup 文案与目前完全一致——已落地的 6 个 shared 单测全 0 退化。
- **F-A2**：当 `agentOutputs` 与 `agentOutputKinds` 都提供、且 `agentOutputs.filter(p => agentOutputKinds[p] === 'markdown_file')` 非空时，followup 文案在主 bullets 之后插入一段固定模板，包含三个锚点（测试用）：
  - 列出命中的 port 名（反引号包裹、逗号分隔），方便模型定位；
  - 短语 `markdown_file ports require a two-step protocol`；
  - 短语 `write the file to disk first, then place ONLY its worktree-relative path inside the <port> tag` —— 与首轮 `buildMarkdownFilePortGuidance` 同向但更短。
- **F-A3**：调用方（runner）在 `envelopeFollowup === true` 分支里把 `agent.outputs.map(o => o.name)` 与 `agent.outputs` 转出的 outputKinds 字典传给 `renderEnvelopeFollowupPrompt`，不新增 DB 字段、不新增 RFC-042 决策状态。
- **F-A4**：新增 shared 单测 3 case（按 §F5 落地）；既有 6 个 followup 单测全过；新增 backend runner 集成 1 case（agent 声明 markdown_file 输出 + envelopeFollowup=true → promptText 含三个锚点）。
- **F-A5**：clarify channel 路径（has=true）与 markdown_file 路径正交叠加——两者都命中时，followup 文案先 has=true 的双 envelope bullets，再追加 markdown_file 段，最后才追加 directive=continue 的 RFC-039 短句（顺序固定，避免 RFC-039 短句被夹在 markdown_file 段中间）。

### F4（不变契约）

- 默认 retries=3 不变；
- followup 触发条件 / 识别集合不变；
- runner 是否走 followup 的决策仍由 scheduler `decideEnvelopeFollowup` 决定，本 follow-up 只在"已经决定要 followup"之后影响 prompt 文案；
- `[rfc042/envelope-followup]` 审计行不变（payload 只多一个 `hasMarkdownFilePorts: boolean` 也可以，但非必须，PR 时再决定）。

### F5（测试增量草案）

- shared 新增 `envelope-followup-prompt.test.ts` 3 case：
  1. agentOutputs=['summary'] + agentOutputKinds={summary:'markdown'} → followup 文案**不**含 `markdown_file ports require` 短语（kind 非 markdown_file）。
  2. agentOutputs=['report','log'] + agentOutputKinds={report:'markdown_file', log:'string'} → followup 文案含 `report` + `markdown_file ports require a two-step protocol` + `worktree-relative path inside the <port> tag`，**不**含 `log`（log 不是 markdown_file）。
  3. hasClarifyChannel=true + clarifyDirective=continue + agentOutputKinds 含 markdown_file → 顺序断言：先 `(B) <workflow-clarify>` bullets、再 `markdown_file ports require` 段、再 `Keep clarifying` RFC-039 短句（验顺序，防 refactor 把 RFC-039 句挤错位置）。
- backend 新增 1 case 跑通"agent 声明 markdown_file + 第一次 reply 无 envelope + followup 这一轮 promptText 含三个锚点"。
- 既有 6 个 shared followup 测试 + 8 case `decideEnvelopeFollowup` 单测 + 4 case runner-envelope-followup + 4 case default-retries + 2 case rfc039-bias + 1 case events 审计 + 2 case grep 守卫 → 全部零退化。

### F6（实施前置 / 不在本节做）

- 本节仅落入 RFC-042 三件套作为 Planned 增量；代码 + 测试落地时再开单 PR，commit message `feat(prompt): RFC-042 follow-up — markdown_file 提示同步进 envelope followup`。
- 落地时校验 `agentOutputKinds` 类型与 `AGENT_OUTPUT_KIND`（`packages/shared/src/schemas/review.ts:27`）保持一致，不引入新枚举值。
