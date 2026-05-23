# RFC-059 Proposal — 跨节点反问问题作用域（Cross-Clarify Per-Question Scope）

> 状态：**Draft（Blocked-by-RFC-058，2026-05-23）**
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 基线 RFC：[RFC-023 agent-clarify](../RFC-023-agent-clarify/proposal.md)、[RFC-026 clarify-inline-session](../RFC-026-clarify-inline-session/proposal.md)、[RFC-039 clarify-ask-bias](../RFC-039-clarify-ask-bias/proposal.md)、[RFC-056 clarify-cross-agent](../RFC-056-clarify-cross-agent/proposal.md)、[RFC-058 clarify-sessions-unification](../RFC-058-clarify-sessions-unification/proposal.md)

> **重要前置条件**：本 RFC 建立在 [RFC-058](../RFC-058-clarify-sessions-unification/proposal.md) 合并后的 `clarify_rounds` 单表 + 单 service 基础上。RFC-058 落地前**本 RFC 不进入实现**。RFC-058 落地后，进入 RFC-059 实施前需要把本文里出现的 `cross_clarify_sessions` / `crossClarifySessions` / `CrossClarifySession` / `buildQuestionerCrossClarifyContext` / `triggerQuestionerStopRerun` / `triggerQuestionerContinueRerun` / `extractDesignerScopedSubset` 等引用按 RFC-058 final shape 刷过一遍（典型：rename 为 `clarify_rounds` / `clarifyRounds` / `ClarifyRound` / 合并后的 `buildPromptContext` + `kind` 分支 / `submitClarifyAnswers` 统一入口等）。产品语义、scope 单向 destination flag 定义、UI Segmented 控件、三态 footer hint、8 个 i18n key 列表、5 条 C 守门测试目标保持不变。
>
> 关于 RFC-058 落地后**反问者侧老化漏写**问题（`packages/backend/src/services/scheduler.ts` 第 1426-1435 行，cross-clarify questioner 分支没传 `historyCutoffClarifyIteration`）已在 RFC-058 PR-B 内统一修复，本 RFC 直接享受单一 `computeHistoryCutoff` + `applyAgingCutoff` helper 的成果，不再单独描述 aging 补齐。

## 1. 背景

RFC-056 把"跨 agent 反问"跑通：下游 questioner agent 反问 → 用户答 → submit 反馈给上游 designer（designer 带 `## External Feedback` 重跑、级联 reset questioner）/ reject 让 questioner 闭嘴（持久 STOP CLARIFYING）。这一套**默认把所有问题都送到 designer**——隐含前提是"questioner 是审计性 agent、它提的问题都是关于 designer 的产出的"。

实战发现这个前提不总成立：

- 用户工作流 `requirement → designer(spec author) → reviewer(questioner) → reviewDesign(review)`。reviewer 读完 designer 的设计文档，提出一批问题：
  - 有些问题确实是关于 designer 的产出（"为什么选 Redis 而不是 Memcached？"）→ 答案应该送给 designer 让它把答案织进文档。
  - **但**另一些问题其实是反问者自己拿不准的判断标准（"我（reviewer）现在评估缓存策略时，是按 P50 还是 P99 来衡量？""我应该如何理解'轻量缓存'这个表述——是 100MB 还是 1GB？"）。这类问题答完后用户希望让**反问者**带着答案重跑、自己拿出审计结论，**不需要触动 designer**。
- 当下用户被迫两种次优应付方式：
  1. **全部按 designer 处理**：但 reviewer 自身的问题被塞进 designer 的 External Feedback → designer 一头雾水（这些问题它没法答 / 它答了也不该回写到设计文档）。
  2. **整批 reject**：但 reject 的语义是"让反问者闭嘴"——一旦持久化 stop，反问者后续轮也不再问；用户其实并不想让 reviewer 永久禁言，只是想"这一批问题给反问者自己消化"。

这两条都不对路。本 RFC 解决方案：**让用户在 /clarify 详情页**对每道题**单独**指定作用域——designer 或 questioner，默认 designer。**scope 是单向"是否同时送达设计者"的标记，不是二分路由**——反问者永远收到全部 Q&A（它是提问的那一方、本该看完整答覆），scope 只决定 designer 这一侧是否参与：

- 至少 1 题 scope=designer → 走 RFC-056 当前 submit 流程，**designer 只收到 designer-scoped 子集**；级联到 questioner 后 **questioner 重跑收到全部 Q&A**（不过滤）。
- 全部 scope=questioner → **跳过 designer 重跑**，直接 cascade reset questioner（结构对齐 RFC-023 self-clarify 重跑）。questioner 收到全部 Q&A（与 RFC-056 现行 cascade rerun Q&A 注入字节级一致）。

## 1.1 为什么要现在做

- RFC-056 落地已 1 个 sprint，目前 4 条 patch（2026-05-22..25）都在补 designer cascade / questioner cascade 状态机的细节，**协议形态稳定**。这是新增 scope 字段的良好窗口——再晚一步用户已经在 prod 工作流里把"全部送 designer"当默认了，回退习惯成本高。
- 真实工作流编排里"问 designer"和"问反问者自己"是**两种正交意图**，二者并存能让一条工作流自然处理"产出维度的不确定"+ "审视维度的不确定"。
- 实现成本极低：复用 RFC-056 已铺好的 cross_clarify_sessions / commitAnswers / triggerDesignerRerun / triggerQuestionerStopRerun / buildExternalFeedbackBlock / questioner cascade rerun Q&A 注入路径——本 RFC 只在**问题列表渲染** + **service submit 分支** + **prompt 构造时过滤**三处加 scope 维度，不引入新 envelope / 新 NodeKind / 新表。
- 不做这一步的代价：用户被迫在工作流编辑器里把 reviewer 拆成两个 agent（"questioner-for-designer" / "questioner-for-self"）+ 两组 cross-clarify 节点，增量复杂度大且非自然。

## 1.2 本 RFC 不动哪些地方

- **不动** RFC-023 self-clarify 节点（envelope schema / clarify_sessions 表 / ClarifyForm / awaiting_human / clarify_iteration）。self-clarify 的提问者就是答题者本身，没有 scope 拆分语义。
- **不动** RFC-026 inline session（sessionMode / sessionModeForDesigner / sessionModeForQuestioner / inline fallback warning code）。scope 不影响 session 续接策略。
- **不动** RFC-039 STOP CLARIFYING anchor / ask-bias preamble。reject 路径忽略 scope，行为与 RFC-056 一致。
- **不动** RFC-056 envelope schema（`<workflow-clarify>` JSON、问题数 1+ 上限、选项数 2-4 上限、互斥 envelope 错误码）。scope 是**人在 UI 上加的标记**，不进 agent 输出协议。
- **不动** RFC-056 cross_clarify_sessions 既有列（questionsJson / answersJson / directive / status / iteration / loopIter / targetDesignerNodeId 等）。本 RFC 仅 **追加 1 列** `question_scopes_json TEXT NULLABLE`。
- **不动** RFC-056 多源等待（evaluateDesignerRerunReadiness）的判定条件：所有 peer cross-clarify 节点都要 resolved 才计算 designer 触发；本 RFC 仅在"决定是否真的触发"那一步增加"aggregated designer-scoped 是否非空"的二级判断。
- **不动** workflow `$schema_version`：scope 是 runtime 概念、不进 workflow definition。不 bump v4→v5。
- **不动** RFC-053 lifecycle 转移函数 / invariant 框架（含 RFC-056 加的 CR-1 abandoned 升级）。scope 不改变 cross_clarify_sessions 状态机。

## 2. 目标

### 2.1 做

1. **新枚举 `ClarifyQuestionScope = 'designer' | 'questioner'`**：默认 `'designer'`（向后兼容 RFC-056 行为）。语义是**单向 destination flag**——'designer' 表示"答案同时送达设计者与反问者"（设计者拿来更新文档、反问者拿来推进自己的下一轮），'questioner' 表示"答案只发给反问者、设计者不被通知"。反问者**永远**收到全部 Q&A，无论 scope 取值。lives in `packages/shared/src/schemas/clarify.ts`。

2. **新请求字段 `SubmitClarifyAnswers.questionScopes?: Record<questionId, ClarifyQuestionScope>`**：可选；缺省时整批默认 designer（旧客户端零退化）。仅 cross-clarify 节点的 POST 路径解析此字段；self-clarify 路径忽略（与 RFC-023 schema 行为不变）。

3. **新列 `cross_clarify_sessions.question_scopes_json TEXT NULLABLE`**（migration 0031）：提交时把 scope 映射序列化为 JSON 存盘。NULL = 旧行 / 未指定 → 渲染时全部按 designer 处理（lossless replay）。

4. **/clarify 详情页 per-question scope 控件**：每道题标题右侧加 `<Segmented>`，2 选项 [设计者 | 反问者]，默认设计者。控件**仅在 cross-clarify 节点的 awaiting_human 状态**可点击；self-clarify 节点 / sealed (`answered` / `abandoned`) 状态下隐藏控件，sealed 状态下只读渲染当时选过的 scope chip。

5. **submit hint 文案（动态）**：footer submit 按钮上方根据 scope 分布显示一行 hint：
   - 全 designer（默认）：`提交后将触发设计者重跑（设计者收到全部 {n} 题），反问者随后用全部 Q&A 重跑`
   - 全 questioner：`提交后只重跑反问者（含全部 {n} 题与答案），设计者不参与`
   - 混合：`提交后先触发设计者重跑（设计者仅收 {d} 题），反问者随后用全部 {total} 题与答案重跑`

6. **service 层 submit 分支扩展**：`crossClarifyService.submitCrossClarifyAnswers` 内部 directive='continue' 路径：
   - 解析 `questionScopes` → 计算 `designerCount`（scope='designer' 的题数）。
   - `designerCount > 0` → 走 RFC-056 现有 designer rerun 路径（multi-source readiness 等待 → 触发 designer rerun → cascade questioner）。**designer rerun prompt 的 External Feedback 段按 scope='designer' 过滤**；**questioner cascade rerun prompt 的 Q&A 段不过滤，注入全量**（与 RFC-056 行为一致——反问者本就应该看完整 Q&A）。
   - `designerCount === 0` → **跳过** evaluateDesignerRerunReadiness 与 triggerDesignerRerun；**直接** 调 `triggerQuestionerContinueRerun`（本 RFC 新增 helper，与 `triggerQuestionerStopRerun` 并列；不注入 STOP CLARIFYING、注入全部 Q&A）。outcome = `{ kind: 'questioner-continue-triggered', questionerNodeRunId }`。

7. **prompt 注入过滤（仅设计者侧）**：`buildExternalFeedbackBlock` 接收 `CrossClarifySourceContext[]`；每个 source 的 questions / answers 已经在 service 层按 scope='designer' 过滤过。该函数本身不需要新参数；service 层在构造 source 时做过滤。**反问者侧不过滤**——RFC-056 既有 `buildQuestionerCrossClarifyContext` / questioner cascade rerun 的 `__clarify_questions__` / `__clarify_answers__` 注入路径**字节级零改动**，仍注入该 cross-clarify session 的全量 Q&A。

8. **多源 readiness 微调**：`evaluateDesignerRerunReadiness` 多返回 1 个字段 `aggregatedDesignerScopedQuestionCount: number`（=所有 resolved + directive='continue' source 的 designer-scoped Q&A 题数之和）。submit 主路径在 readiness.ready=true 时增加二级判断：
   - `aggregatedDesignerScopedQuestionCount > 0` → 触发 designer rerun（与 RFC-056 行为一致）。
   - `aggregatedDesignerScopedQuestionCount === 0` → **跳过 designer rerun**；外部输出 outcome = `{ kind: 'designer-skipped-all-questioner-scope' }`；不再触发额外的 cascade（每个 source 自己的 questioner 已经在各自 submit 那一刻独立触发了 `triggerQuestionerContinueRerun`）。

9. **WS 事件扩展**：复用 RFC-056 的 4 个 `cross-clarify.*` event。新增不必要——`cross-clarify.designer-rerun-batched` 在 designerCount=0 时不广播；新增 outcome 'questioner-continue-triggered' 在前端通过 `cross-clarify.answered` event + outcome payload 区分；不引入新 WS variant 减少前端 hook 复杂度。

10. **错误码扩展（仅新增 1 条）**：`cross-clarify-question-scopes-malformed`（fail，HTTP 400）—— submit body 的 questionScopes 字段不是合法 Record 形态 / scope 值不在 enum 内 / 引用了不存在的 questionId。

11. **i18n（中英对称）**：
    - `crossClarify.questionScope.label` — "作用域" / "Scope"
    - `crossClarify.questionScope.designer` — "设计者" / "Designer"
    - `crossClarify.questionScope.questioner` — "反问者" / "Asker"
    - `crossClarify.questionScope.designerTooltip` — "答案同时送达设计者与反问者（设计者用来更新文档）" / "Answer is sent to both the designer (to update the doc) and the questioner."
    - `crossClarify.questionScope.questionerTooltip` — "答案只发给反问者；设计者不被通知、不重跑" / "Answer is sent only to the questioner; the designer is not notified or rerun."
    - `crossClarify.submitHint.allDesigner` — "提交后将触发设计者重跑（设计者收到全部 {{n}} 题），反问者随后用全部 Q&A 重跑" / "Submit will rerun the designer (with all {{n}} questions); the questioner reruns with full Q&A."
    - `crossClarify.submitHint.allQuestioner` — "提交后只重跑反问者（含全部 {{n}} 题与答案），设计者不参与" / "Submit will rerun only the questioner (with all {{n}} Q&A); the designer is not involved."
    - `crossClarify.submitHint.mixed` — "提交后先触发设计者重跑（设计者仅收 {{d}} 题），反问者随后用全部 {{total}} 题与答案重跑" / "Submit reruns the designer first (with {{d}} questions only); the questioner then reruns with full {{total}} Q&A."

### 2.2 不做

- **不做** envelope 协议扩展。questioner agent 不感知 scope；scope 完全是 UI 提交时的人工标记。这避免新 envelope 字段带来的 agent 训练 / 协议块文案 / 旧 fixture 全套更新成本。
- **不做** scope 默认值随 agent 变化。所有题目 default 'designer'，与 RFC-056 行为完全一致——这样旧客户端 / 不修改 questionScopes 的客户端零差异。
- **不做** scope 自动推断（譬如根据题目文本里出现"你（反问者）"切到 questioner）：用户决策、不要黑魔法。
- **不做** scope='both'。要么这题给 designer、要么给 questioner、不允许双发——双发增量复杂度（譬如 designer 收到一份、questioner 收到副本，两边 Q&A 一致性维护）远不抵收益；用户真要双发可以拆成两个 cross-clarify 节点。
- **不做** scope 撤销 / 调整在 sealed 状态：一旦 submit / reject，scope 与 answers 一起冻结。改主意需要重启 task。
- **不做** scope 改变 multi-source readiness 判定规则（哪些 peer 需要 resolved）：所有 peer 仍然要 resolved；scope 仅决定"resolved 之后是否真的触发 designer"。这避免 readiness 算法多一个变量、与 RFC-056 patch-2026-05-22..25 的 cci/cascade 算法继承关系撞车。
- **不做** reject 路径按 scope 拆分。reject 是"让反问者闭嘴"——与"这道题给谁"无关；reject 时 questionScopes 字段被持久但不影响 STOP CLARIFYING 注入（注入全量 Q&A，与 RFC-056 一致）。
- **不做** Inspector 上 cross-clarify 节点新增"默认 scope"配置：所有题首次渲染都默认 designer；让节点 inspector 改默认会引入"agent 写的题怎么影响人选 scope"的二阶语义，本 RFC 拒绝复杂化。
- **不做** YAML 导入/导出携带 scope（scope 与 task runtime 数据绑、不是 workflow definition）。
- **不做** designer rerun 时把"用户选过哪些题给设计者 / 哪些给反问者"全量写进 External Feedback（让 designer 知道反问者还问了 ta 自己几道）：那是反问者的事，designer 不需要见此元信息。仅 designer-scoped Q&A 进 External Feedback、其它不可见。

## 3. 用户故事

**S1（happy path：默认全 designer，与 RFC-056 完全一致）**

工作流 `input → designer → reviewer(questioner) → reviewDesign`。reviewer 第一轮跑出 3 题 `<workflow-clarify>` envelope → cross-clarify 节点 awaiting_human → 用户进 /clarify 详情页。

用户**不动 scope 控件**（默认全 designer）→ 答完 3 题 → 点 Submit。

- footer hint 显示 "提交后将触发设计者重跑（3 题）"。
- submit 后 outcome='designer-rerun-triggered'。
- designer 收到 External Feedback 含全部 3 题（与 RFC-056 同），重跑写文档 v2。
- 级联 reset reviewer → reviewer 第二轮跑（注入 `__clarify_answers__` 含全部 3 题与答案，与 RFC-056 同）→ 跑出 `<workflow-output>` → reviewDesign approve → task done。

行为字节级等价于 RFC-056 happy path（无任何 scope 字段持久或读取差异）。

**S2（全 questioner-scope）**

同 S1，但用户答题时**把 3 题全部切到反问者**。

- footer hint 切为 "提交后只重跑反问者（含全部 3 题与答案），设计者不参与"。
- submit 后 outcome='questioner-continue-triggered'。
- **designer 不重跑**（cross_clarify_iteration 不递增）。
- reviewer cascade rerun（不走 STOP CLARIFYING、不带 ask-bias 改动；与 RFC-056 submit-then-cascade 同 prompt 注入路径），`__clarify_answers__` 注入这 3 题答案 → reviewer 第二轮直接跑出 `<workflow-output>`（反问者自己消化掉这批问题）→ reviewDesign approve → task done。

**S3（混合 scope）**

同 S1，3 题分别切为 designer / questioner / designer。

- footer hint 切为 "提交后先触发设计者重跑（设计者仅收 2 题），反问者随后用全部 3 题与答案重跑"。
- submit 后 outcome='designer-rerun-triggered'，designer External Feedback 仅含第 1 + 第 3 题（按 scope='designer' 过滤）。
- designer 重跑文档 v2。
- 级联 reset reviewer → reviewer 第二轮跑，`__clarify_answers__` 注入**全部 3 题与答案**（反问者侧不过滤；scope 只决定是否同时送 designer、不决定反问者自己能看哪些）→ reviewer 第二轮跑出 output（基于完整 Q&A 上下文做最终判断）→ workflow 继续。

**S4（多源 + 混合 scope）**

工作流：`input → designer → securityQ → securityCross(cross-clarify) → ...` 与 `... → uxQ → uxCross(cross-clarify) → ...`，两个 cross-clarify 节点的 to_designer 都指向同一 designer。

- securityCross 4 题、ux 3 题。用户先答 securityCross：2 题切 questioner、2 题保留 designer → submit → outcome='designer-waiting'（因为 ux 还在 awaiting；securityCross 不能独立触发 questioner-only 路径，因为 designer-scoped > 0）。banner 显示 "等待另 1 个新节点（uxCross）处理完 designer 才会重跑"。
- 用户答 uxCross：全部 3 题切 questioner → 这是 uxCross 这个 session 的 submit、scope 全 questioner。但 multi-source readiness 是按 peer-session 维度看，uxCross resolve 后所有 peer 都 resolved → readiness.ready=true。
- 二级判断：aggregatedDesignerScopedQuestionCount = securityCross 2 题 + uxCross 0 题 = 2 → 触发 designer rerun。两 questioner cascade rerun 各自收到**自身 session 的全部 Q&A**（不过滤）。
- 实际触发顺序：uxCross 的 submit 路径在 readiness=true 后**先**触发 `triggerDesignerRerun`（按 aggregate）；designer 重跑 done → RFC-014 cascade reset 触达 securityQ + uxQ + 两个 cross-clarify 节点。两 questioner cascade rerun 注入各自 session 的全部 Q&A（securityQ 收自身 4 题、uxQ 收自身 3 题）。
- 与 RFC-056 多源行为对比：唯一差异是 designer External Feedback 只含 2 题（securityCross 的 designer-scoped 子集）；两 questioner 的 Q&A 注入与 RFC-056 字节级一致。

**S5（多源 + 全 questioner）**

同 S4，但用户**两个 cross-clarify 都全部切 questioner**。

- securityCross submit 时 designerCount=0，但 peer ux 还在 awaiting → **single-source 路径 vs multi-source 路径需要决策**：本 RFC 选**single-source 优先**——当某个 session 自身 designerCount=0，**该 session 走 single-source 简化路径**（不等 peer），立刻 `triggerQuestionerContinueRerun`，注入自身全部 4 题与答案。outcome='questioner-continue-triggered'。
- uxCross submit 时类似，注入自身全部 3 题与答案，outcome='questioner-continue-triggered'。
- designer **从未重跑**（aggregatedDesignerScopedQuestionCount=0 自始至终）。两 questioner 各自独立 rerun 消化自己 session 的全量 Q&A。

**S6（reject 路径，scope 忽略）**

同 S1，用户在 UI 上把 2 题切到 questioner、1 题保留 designer → 点 Reject → 二次确认 → 确认。

- questionScopes 仍随 reject 一起持久（用于 audit / 重放）。但 reject 路径完全走 RFC-056 行为：directive='stop'、questioner cascade rerun 注入**全量** Q&A + STOP CLARIFYING anchor、不触发 designer rerun。scope 在 reject 流程中**没有任何运行时分支**。
- 与 RFC-056 reject 行为完全一致；唯一差异是 question_scopes_json 列被填写（之前 NULL）。注意 RFC-058 的 submit 路径下反问者**本就**收到全量（与 reject 路径同），所以 reject vs submit 在反问者侧的 Q&A 注入只差一个 STOP CLARIFYING anchor。

**S7（旧客户端 / 不发 questionScopes）**

旧版前端（或第三方脚本）调 POST `/api/clarify/{nodeRunId}/answers` 不带 `questionScopes` 字段 → 后端默认填全 designer → 行为与 RFC-056 完全一致。

`question_scopes_json` 列在该 session 上仍为 NULL（不强写默认值；NULL 在 prompt 渲染时透明地视为"全 designer"）。

**S8（已 answered 的 session 回看）**

用户进 /clarify/{nodeRunId} 查看历史记录、status='answered'。

- 表单 readonly。
- 每题旁的 Segmented 控件变成纯 chip 展示（"设计者" / "反问者"），不可点击。
- 若 question_scopes_json=NULL（RFC-058 上线前答的旧行）→ chip 渲染为"设计者"，与当时实际跑的行为一致。

**S9（旧 cross_clarify_sessions 行的 designer rerun 重放）**

RFC-058 之前已经 answered 但 designer 还没消化的 session（RFC-056 abandoned 升级前）→ designer rerun 时 question_scopes_json=NULL → buildExternalFeedbackBlock 渲染全部题为 designer-scoped（与 RFC-056 行为一致）。反问者 cascade rerun 路径本就注入全量，scope=NULL 与 RFC-058 任意 scope 配置下注入字节级一致。

## 4. 验收标准

### 功能

- **A1（默认全 designer，零差异）**：questionScopes 字段缺省 / 全 'designer' → 行为字节级等价于 RFC-056（External Feedback / questioner Q&A 注入文本一致）。
- **A2（全 questioner 路径）**：questionScopes 全 'questioner' → designer 不重跑、outcome='questioner-continue-triggered'；questioner cascade rerun prompt 含**全部** Q&A、不含 STOP CLARIFYING。
- **A3（混合路径）**：questionScopes 混合 → designer rerun External Feedback **仅含** designer-scoped 子集；questioner cascade rerun prompt 含**全部** Q&A（不过滤——反问者本就该看全量答覆）。
- **A3b（反问者侧不过滤守门）**：任何 directive='continue' submit 触发的 questioner cascade rerun，`__clarify_answers__` 注入文本与"忽略 scope、注入该 session 全部 Q&A"路径产生的字符串字节级一致（与 RFC-056 既有 buildQuestionerCrossClarifyContext 输出一致）。
- **A4（multi-source 单 session 全 questioner 快路径）**：某 session designerCount=0 时立刻触发 questioner rerun（不等 peer）；其它 peer 继续按 readiness 等。
- **A5（multi-source 聚合 designerCount=0 不触发 designer）**：所有 peer resolved 后聚合 designer-scoped Q&A 为 0 → designer 不重跑、outcome 在主驱动 session 上记为 'designer-skipped-all-questioner-scope'。
- **A6（reject 忽略 scope）**：directive='stop' 提交，无论 scope 分布 → 行为字节级等价于 RFC-056 reject（持久 STOP、questioner rerun 注入全量 Q&A 含 reject 当次答案）。
- **A7（旧客户端兼容）**：submit body 不含 questionScopes → 后端按默认 'designer' 处理 + question_scopes_json 写 NULL；行为与 RFC-056 同。
- **A8（旧已存 session 回看）**：question_scopes_json=NULL 行渲染 chip 为"设计者"；External Feedback 重放（譬如 RFC-056 abandoned 升级修复路径）含全部题。
- **A9（schema 校验 fail）**：questionScopes 引用未知 questionId / scope 值非 enum → HTTP 400 + 错误码 `cross-clarify-question-scopes-malformed`。
- **A10（self-clarify 路径不受影响）**：RFC-023 self-clarify 节点的 POST answers 路径忽略 questionScopes 字段（不校验、不持久、不影响）；ClarifySession 测试套件零退化。
- **A11（migration 0031 上行可跑）**：drizzle migration test 通过 + 已有 cross_clarify_sessions 行新列默认 NULL。
- **A12（UI Segmented 公共组件）**：scope 控件复用 `<Segmented>` 公共组件（与 RFC-035 / RFC-056 sessionMode 控件同视觉风格），不自写 chrome。
- **A13（footer hint 三种文案）**：hint 文本根据 scope 分布精确切换；i18n cn/en 双语对称（grep 守门覆盖关键字符串）。
- **A14（sealed 状态控件只读）**：status='answered' / 'abandoned' 时 Segmented 渲染为只读 chip；点击不触发回调。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** RFC-056 / RFC-023 / RFC-026 / RFC-039 既有套件零退化。关键 strict diff guard：
  - `packages/shared/src/clarify-cross.ts` 的 `buildExternalFeedbackBlock` 函数签名向后兼容（不修参数列表、仅 service 层传入已过滤的 sources）。
  - `packages/backend/src/services/crossClarify.ts` 的 `triggerDesignerRerun` / `triggerQuestionerStopRerun` / `buildQuestionerCrossClarifyContext` 函数签名 + 主体字节级不变；新增 `triggerQuestionerContinueRerun` helper 与 stop 版并列。
  - `packages/frontend/src/routes/clarify.detail.tsx` 既有 self-clarify 渲染分支零改动。
- **B3** backend tests **≥ +12**：
  - shared schemas 2（ClarifyQuestionScope enum + SubmitClarifyAnswers.questionScopes 校验）
  - clarify-cross 纯函数 2（extractDesignerScopedSubset happy / 多 session 聚合）
  - migration 0031 2（上行可跑 + 已有行 NULL 默认）
  - service submit 4（全 designer 默认 / 全 questioner 快路径 / 混合 / 旧客户端无 questionScopes）
  - service multi-source 2（聚合 designerCount=0 跳过 designer / aggregated > 0 仍触发）
  - REST 1（malformed questionScopes 400）
- **B4** frontend tests **≥ +6**：
  - Segmented per-question 渲染 1
  - hint 文案三种切换 1
  - submit body 携带 questionScopes 1
  - sealed 状态只读 chip 1
  - 旧 NULL session 渲染为"设计者" 1
  - i18n cn/en 双语对称 1
- **B5** Playwright e2e：**不新增** spec 文件（A1/A2/A3 在 backend service + frontend vitest 已覆盖；e2e fixture 复杂度 / 维护成本不抵收益）。RFC-058 完工记录里显式声明 e2e 不增量。
- **B6** 单二进制构建包体积 / 启动时间不退化（估算 < 5KB 体积增量、+1 migration 启动时 < 10ms）。

### 回归防护

- **C1（RFC-056 happy path 字节级）**：`packages/backend/tests/cross-clarify-rfc058-compat.test.ts`——构造 RFC-056 happy path fixture（不传 questionScopes），断言 designer prompt 文本、questioner cascade rerun prompt 文本与 RFC-058 上线前完全一致（字符串严格 equal）。
- **C2（设计者 External Feedback 过滤）**：`packages/shared/tests/cross-clarify-scope-filter.test.ts`——单测 extractDesignerScopedSubset / countDesignerScopedAcrossSources 纯函数。覆盖单 source / 多 source / 全 designer / 全 questioner / 混合 / 引用未知 questionId 容错。
- **C3（反问者侧不过滤守门）**：`packages/backend/tests/cross-clarify-questioner-full-injection.test.ts`——构造 questionScopes 混合 / 全 questioner / NULL 三种 case，断言 questioner cascade rerun prompt（continue 路径 + reject 路径）注入的 Q&A 题数 / 题文 / 答案均为该 session 的**全集**；与 RFC-056 buildQuestionerCrossClarifyContext 输出字节级一致。
- **C4（multi-source 快路径不污染 peer）**：`packages/backend/tests/cross-clarify-fast-path-isolation.test.ts`——A session designerCount=0 触发快路径后，B session 仍 awaiting 时 readiness 状态正确；B submit 后 designer 是否触发由 aggregated designer-scoped 决定，不被 A 的状态污染。
- **C5（i18n cn/en 对齐）**：`packages/frontend/tests/cross-clarify-scope-i18n.test.ts`——grep 守门 zh-CN.ts / en-US.ts 各含 8 个新 i18n key + 字符串非空 + 占位符同名（`{{n}}` / `{{d}}` / `{{total}}`）。

## 5. 关键技术选型理由

按 RFC 规范交代几个我做的判断与理由：

0. **scope 是单向"是否同时送达设计者"标记 / 反问者永远收全量**：选**单向标记**。理由：反问者是提问的那一方，它要做出"下一轮该继续问还是 output"的判断，必须看到完整的人答覆全貌；如果按 scope 把反问者侧也过滤，反问者会看不到那些"用户决定不送 designer 的题"的答案，导致它做判断时缺上下文（譬如用户答完 reviewer 的某个澄清题、明确说"这题不必告诉 designer"——但 reviewer 自己要消化这个答案才能决定后续 review 怎么做）。replaced approach（二分路由）会让 reviewer 错过这种关键信息。**单向标记**也让反问者侧的注入路径与 RFC-056 字节级一致（零退化、零回归担忧）。
1. **scope 不嵌 ClarifyQuestion 而是单独 questionScopes 字段**：选**单独字段**。Question schema 是 agent 的契约（envelope JSON）；scope 是 human 的契约（submit body）。混在一起会让 agent 误以为可以输出 scope（实际上不允许）；分开两个契约边界清晰、向后兼容简单（旧 questionsJson 不动）。
2. **scope 存 `question_scopes_json TEXT` vs 独立 cross_clarify_question_scopes 表**：选**JSON 列**。一行 cross_clarify_session 对应 1 个 scope 映射、永远整体读写、不需要单题 join 查询；JSON 列方案省 1 表 1 FK；查询代码 1 行 JSON.parse 完成。
3. **scope 默认 'designer' vs 强制用户每题显式选**：选**默认 designer**。旧客户端 / 不修改 questionScopes 的用例不退化；用户对"反问者真正应该看的问题"是少数情况，"反问者问 designer"是多数；多数走默认、少数显式切，UX 直观。
4. **新增 outcome 'questioner-continue-triggered' vs 复用 'designer-rerun-triggered' 加 flag**：选**新增枚举值**。前端按 outcome.kind 走不同 toast / navigate 路径，分支语义化、可读性高；复用 + flag 是反模式。
5. **单 session designerCount=0 走快路径（不等 peer）vs 等 peer 再决策**：选**快路径**。理由：S2 单源全 questioner 的语义就是"立刻让反问者消化、不动 designer"；多源场景里某 session 全 questioner 时该 session 的 questioner 没有任何理由等 peer——peer 后续是否触发 designer 与本 session 无关（cascade reset 来到时再多跑一轮就是了）。等 peer 会让用户看到"我答完了反问者还没动"的违反直觉。代价：极少数情况 cascade 会让该 questioner 多跑一次，但实际上多源 + 全 questioner 是边角组合，可接受。
6. **multi-source 聚合 designerCount=0 跳过 designer**：选**跳过**。让 designer 重跑 + 空 External Feedback 是无意义的——designer 看到 0 个反馈题、要么重写原文档（浪费）、要么生成"无变化"（污染 audit）。跳过更干净；user 通过 outcome 'designer-skipped-all-questioner-scope' 明确知道发生了什么。
7. **reject 路径忽略 scope vs 让 reject 也按 scope 拆**：选**忽略**。reject 的语义"让反问者闭嘴"与 scope 正交；reject 后注入全量 Q&A 给 questioner 是 RFC-056 的契约（让 questioner 看到完整上下文以理解为什么用户说 stop），按 scope 过滤会丢上下文。
8. **不引入 'both' scope**：见 §2.2 "不做"——product 复杂度不抵增量价值；用户真要双发可手动复制题文新建 cross-clarify。
9. **不 bump workflow $schema_version**：scope 是 runtime 数据 / submit 时人决策；workflow definition 不应承载这种"每个 session 都可能不同"的信息。RFC-056 的 v3→v4 是因为新增了 NodeKind；本 RFC 不新增。

## 6. 与其它 in-flight / 已落地 RFC 的关系

- **RFC-056 cross-clarify**：本 RFC 的直接基础。所有 cross_clarify_sessions / commitAnswers / triggerDesigner/QuestionerStopRerun / buildExternalFeedbackBlock / multi-source readiness 路径全部 reuse；本 RFC 仅在三处加 scope 过滤分支 + 1 个新 outcome + 1 个新 service helper（triggerQuestionerContinueRerun）。
- **RFC-056 patch 2026-05-22..25**：本 RFC 不与这 4 个 patch 冲突——它们都是 cci 继承 / cascade 跳过问题，本 RFC 不动 cci 算法 / cascade 路径。但实现时需要确认 patch-2026-05-25（questioner cascade no-skip）的合入版本——本 RFC 的 triggerQuestionerContinueRerun 必须继承该 patch 的"clarify-only 行不被 skip"语义。
- **RFC-023 self-clarify**：完全不受影响。submit body 上的 questionScopes 字段在 self-clarify 节点路径下被忽略；测试套件零退化。
- **RFC-026 inline session**：scope 不影响 session 续接。sessionModeForDesigner / sessionModeForQuestioner 字段语义不变；inline fallback warning code 不变。
- **RFC-039 ask-bias / STOP CLARIFYING**：reject 路径 reuse RFC-039 anchor + 全量 Q&A，零改动。submit 路径下 questioner cascade rerun 的 ask-bias preamble 注入条件不变（hasClarifyChannel=true 时仍注入），仅 Q&A 内容按 scope 过滤。
- **RFC-053 lifecycle hardening / CR-1 invariant**：本 RFC 不新增 lifecycle 状态转移、不新增 invariant rule。CR-1 abandoned 升级条件不变。
- **RFC-035 ux-consistency**：scope Segmented 复用公共 `<Segmented>` 组件、hint 文案复用 `.muted` 文本风格、sealed 状态只读 chip 复用 `<Chip>` / `.status-chip` 公共 class，零自写 chrome。

## 7. 风险

| 风险 | 评估 | 缓解 |
|------|------|------|
| 用户切了 scope 但提交时未感知到 hint 切换 → 误以为提交后 designer 也会跑 | 低：hint 醒目（≠ 静默） | A13 验收 + 三种文案分隔明显 |
| 用户多源场景下用快路径触发 A's questioner、随后 B 触发 designer rerun → A's questioner 二次 cascade rerun | 低：极少数组合 + 第二次 rerun 也合法（cascade 本身就是这套语义） | S5 故事 + B 测试覆盖 |
| 旧客户端不发 questionScopes、服务端默认全 designer → 用户从前端看就以为是新行为 | 低：旧前端没新 UI，用户不感知 | A7 验收 + 默认 designer 兼容 |
| question_scopes_json 列默认 NULL → External Feedback 重放（譬如 abandoned 升级 / RFC-052-style 修复脚本）能否正确 fallback | 中：fallback 必须正确（否则修复脚本会读空 scope 触发 panic） | C2 测试覆盖 + 渲染代码显式 `?? 'designer'` |
| reject + 混合 scope 的用户看到 chip 但行为按全量 → 误以为 scope 在 reject 上也生效 | 低：reject 二次确认 modal + body 文案明示"反问 agent 将不再产生问题" | S6 故事 + UI 文案不变（reject modal 不提 scope） |
| Segmented 控件在题目过多（譬如 7 题）时撑爆题目行排版 | 低：Segmented 已经在 NodeInspector sessionMode 等地方被验证可适配多行 | UI 自查 + 不刻意优化（极少超 5 题） |
| service 层 designerCount=0 快路径 race：A submit 触发快路径 + B 紧跟 submit 含 designer-scoped → readiness 检查 A 时 A 状态可能 in-flight | 低：commitAnswers 已是单事务 + ifMatchIteration 乐观锁；A status='answered' + directive='continue' + designer-scoped 题数 0 是确定结果 | DB 事务 + 单元测试 race scenario |

## 8. 后续可能的延展（v1 不做）

- 在 cross-clarify 节点 Inspector 上加"问题默认作用域"配置，让某些节点（譬如纯审计型反问者）默认 questioner，让用户少切。
- agent-multi 作为 questioner / designer 时的 scope 行为（沿用 RFC-056 §2.2 "不做"——v1 严格限 agent-single）。
- scope='both' 双发模式，譬如关键决策同时让 designer / questioner 都拿到（v1 拒绝，理由见 §2.2）。
- 按 scope 维度的 audit 视图：让用户看历史 N 轮反问中 "问 designer 的题 vs 问反问者的题" 比例分布。
- LLM 辅助预填 scope：基于题目文本预测应该是 designer 还是 questioner 给个建议（v1 不做、保留人决策）。
