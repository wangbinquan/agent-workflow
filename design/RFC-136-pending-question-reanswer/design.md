# RFC-136 — 技术设计：待指派问题重答

- 状态：Done（2026-07-02 交付）
- 前置阅读：`proposal.md`（含 D1–D6 决策）；RFC-128 design（seal 原语 / 控制通道 / autoStage）

## 0. 实现期补充决策（2026-07-02，随实现 gate 落定）

- **D7 重答按题显式声明（并发防线，两轮收敛）**：重 seal 放宽不是无条件的——「待指派已答」
  形态同时是 quick 通道（autoDispatchClarifyRound）seal→dispatch 两段锁 B 临界区**之间的瞬时
  中间态**，行状态上与「移出待下发回到待指派」不可区分。若无条件放开，并发双提交能在窗口里
  二次 seal → 二次 dispatch → double-mint（`rfc128-p5-bc §5.2.14 finding 1` 两测试实红为证）。
  第一轮落为路由级布尔 `allowReseal`（用户质询后拍板保留）；实现门 Codex P2 指出布尔仍留**跨
  通道**洞——面板 defer 提交落在**他人** quick 提交的窗口里时会静默覆盖 in-flight 答案。终态
  收敛为**按题声明**：请求体 `resubmitQuestionIds`（面板只声明「预填过已提交答案、用户有意修
  改」的题）→ 路由透传 `SealRoundQuestionsArgs.allowResealFor` → 服务端仅对声明且全条目待指派
  的题放行覆盖。窗口场景中面板用户以为该题是新题、不会声明 → fresh 路径 409 → 刷新可见对方
  答案，不覆盖。quick 通道从不声明（exactly-once 保持）；quick 分支带 `resubmitQuestionIds`
  被 `clarify-resubmit-requires-defer` 拒绝。
- **D8 unstage 按题级联**（用户实测「回答问题的按键又没了」触发）：cross 题 questioner+designer
  两行两张卡，只移出一张会留下「半 staged」题——重答守卫 409 + 答题池整题排除（见 D9）双死路。
  用户在看板的心智单位是**问题**而非角色行 → `stageTaskQuestion` 的 unstage 方向改为按
  `(originNodeRunId, questionId)` 级联清 `staged_at`（仅未下发行；已下发行留审计戳、echo 天然
  豁免）。stage 方向保持逐行（gate 逐行 CAS；正常路径 autoStage 本就全行同进）。
- **D9 半 staged 题不进答题池**（防御深度）：`groupAnswerableQuestions` 对 sealed 题要求该题
  **全部**条目 pending 才纳入——半 staged 题若进池等于「可编辑但服务端必 409」的死路 UI。D8
  级联后正常路径不再产生该形态；此防护兜并发窗口与历史残留。

## 1. 现状与改动总览

答案内容的 SoT 是 `clarify_rounds.answers_json`（per-question merge-write）；per-question
seal 标记在 `task_questions.sealed_at/sealed_by`（RFC-128 §7 方案 C）。提交链路：

```
CentralizedAnswerDialog (defer=true, questionIds cap)
  → POST /api/clarify/:nodeRunId/answers (routes/clarify.ts defer 分支)
    → sealRoundQuestions (services/clarifySeal.ts, 单 dbTxSync + 任务级 QUESTION-WRITE 锁 B)
      - 守卫: round 终态拒 / already-sealed 拒 (exactly-once)
      - mergeSealedAnswers → answers_json; sealed_at/staged_at (autoStage) 盖戳
      - 全 seal → round 翻 answered + park/legacy 副作用
```

改动一句话：**seal 原语放宽为「pending 未下发的 sealed 题可重 seal（覆盖）」，前端答题池
纳入这类题并预填已提交答案**。共 2 个后端触点 + 1 个前端组件 + DTO 不变。

## 2. 后端

### 2.1 `sealRoundQuestions` 重 seal 支持（services/clarifySeal.ts）

现守卫（tx 内）：

```
alreadySealed = round.status==='answered' ? 全部题 : entries 中 sealed_at 非空的题
sealingSet ∩ alreadySealed ≠ ∅ → 409 clarify-question-already-sealed
```

改为**逐题三分类**（tx 内基于重读的 entries，TOCTOU-free）：

- `fresh`：未 sealed —— 走现路径，字节不变（golden-lock）。
- `reseal`：已 sealed 且该 `(originNodeRunId, questionId)` 的**所有**非 echo 条目满足
  `dispatched_at IS NULL AND staged_at IS NULL`（= 相位 pending、未进待下发）。
  - 判定用 DB 列而非派生相位：`deriveQuestionPhase` 的 pending ⇔ `dispatched_at IS NULL ∧
    staged_at IS NULL`（staged 态有 staged_at）。多角色条目（cross 的 questioner+designer 行）
    须**全部**满足——任一行已 staged/下发即整题拒绝（避免一半改一半旧）。
  - echo 条目（RFC-134，生来已下发）不参与判定也不被重答动到：echo 是只读知会卡，
    其呈现读注入面不读 seal 面。
- `rejected`：既非 fresh 也非 reseal → 409 `clarify-question-already-sealed`（错误码不变，
  message 增补「已下发/已待下发不可重答」提示）。

写入语义：

- `answers_json`：`mergeSealedAnswers` 本就是 per-question 覆盖合并——reseal 题直接覆盖
  （D3 无快照）。
- `sealed_at/sealed_by`：reseal 题**更新**为本次时间/操作者（现实现只对 `IS NULL` 盖戳，
  需对 reseal 集合改为无条件更新）。
- `staged_at/staged_by`（autoStage=true 时）：reseal 题同样盖戳（D4——重答后直接回待下发）。
  reseal 题因守卫保证 `staged_at IS NULL`，现有 IS-NULL 幂等写法天然适用。
- **round 状态与副作用抑制**（AC-3）：
  - `newSealed` 计算不因 reseal 重复计数（reseal 题本就在 alreadySealed 集合内——改造后
    fullySealed 判定用 `alreadySealed ∪ freshSealed` 与全题集比较，与现语义一致）。
  - round 已 `answered`：跳过「翻 answered」块的全部副作用（park 释放 / legacy session
    dual-write / directive 收尾 / WS answered 事件）——只更新 answers_json + 条目戳。
  - `rejectSelfQuestionerFullSeal` 守卫按现状执行于 fresh 集合（reseal 不引入新的 full-seal
    翻转，不触发该守卫）。
- `scopes`（D6）：调用方对 reseal 题**不传** scope；服务端防御——reseal 题的 scope 合并跳过
  （即便客户端传了也忽略），`question_scopes_json` 保持原值 → reconcile 派生面零变化。
- 返回值：`SealRoundQuestionsResult` 增加 `resealedQuestionIds: string[]`（向后兼容的新增
  字段；`sealedQuestionIds` 保持=本次 fresh seal 的题，老调用方语义不变）。

并发：整段仍在任务级 QUESTION-WRITE 锁 B + 单 dbTxSync 内；与并发「加入待下发」（stage，
RFC-134 D10 的 `WHERE dispatched_at IS NULL` CAS）竞争时，先提交者胜——后到的 reseal 因
tx 内重读见到 staged_at 非空而 409，后到的 stage 因 seal 不动 staged 语义照常成功。

### 2.2 路由（routes/clarify.ts defer 分支）

行为上无新分支：defer=true + questionIds cap 原样透传 `sealRoundQuestions`。仅两点：

- `questionScopes` 透传前过滤掉 reseal 题（客户端本就不发；服务端 2.1 再兜一层）。
  实现上路由无法预知 reseal 集合 → 过滤逻辑放在 2.1 服务端（路由零改动）。
- 响应体自然携带新增的 `resealedQuestionIds`（`...sealResult` 展开已覆盖）。

**API 面零新增**：无新端点、无 schema 破坏（`SubmitClarifyAnswers` 请求体不变）。

### 2.3 注入一致性（AC-8）

`buildExternalFeedbackContext` / 下发注入读 `answers_json`——重答覆盖后，下一次
`dispatchTaskQuestions` 注入的即新答案，零改动；用一条集成断言锁定（§5）。

## 3. 前端（CentralizedAnswerDialog.tsx + TaskQuestionList.tsx）

### 3.1 答题池 oracle

`groupUnsealedQuestions` 更名为 `groupAnswerableQuestions`（引用点：本组件 +
TaskQuestionList 入口按钮 + 测试），过滤规则从「pending ∧ 未 sealed ∧ 有 round」放宽为
「pending ∧ 有 round」；`CentralizedAnswerGroup` 增加 `resubmitQuestionIds: string[]`
（该轮中 sealed 的 pending 题）。dedup 规则不变（(round, questionId) 一次）；某题多角色
条目 sealed 状态理论上同轮同题一致（seal 按 (origin,question) 全条目盖戳）。

### 3.2 RoundAnswerBlock

- **seed（D5）**：reseal 题初值 = `round.answers` 中该题（`selectedOptionIndices` +
  `customText` 还原；`selectedOptionLabels` 由提交时按选项重建，seed 留空即可——与现
  server-draft seed 同法）；**跳过** server draft / IDB draft 对 reseal 题的覆盖（fresh 题
  草稿逻辑不变）。编辑中的 draft 自动保存照旧（对 reseal 题也写——协作提示仍工作）。
- **UI**：reseal 题的 wrapper 加一条轻提示（`.muted` 行 + i18n key
  `taskQuestions.answerPaneResubmitHint`「已回答——重新提交将覆盖原答案」）；cross 的 scope
  segmented 控件对 reseal 题**不渲染**（D6，显示只读 scope 文本）。
- **提交聚合**：`RoundSubmission.questionIds` 含 reseal 题（questionIds cap 语义不变）；
  `questionScopes` 只收集 fresh cross 题的 scope。
- 键盘导航（flattenCentralizedNavKeys）零改动——池子变大后自然覆盖 reseal 题。

### 3.3 入口按钮（TaskQuestionList.tsx）

`groupAnswerableQuestions(entries).length > 0` 即显（AC-6）；`deferred` 恒 true
（RFC-132 PR-F）不变。

### 3.4 /clarify 反问页

零改动（非目标）：`lockedQuestionIds` 对 sealed 题保持灰显；重答只在集中面板。

## 4. 失败模式

| 场景 | 行为 |
| --- | --- |
| 重答提交与并发 stage 竞争 | 锁 B + tx 内重读：后到者 409（`task-question-already-…`/`clarify-question-already-sealed`），前端 ErrorBanner + invalidate 刷新看板（现有模式） |
| 重答提交与并发批量下发竞争 | dispatch 在锁 B 内盖 dispatched_at；后到的 reseal 409（守卫 2.1）——不会出现「下发中途换答案」 |
| 多角色条目部分已 staged | 整题 409（2.1 全条目判定），不产生半新半旧 |
| round 已 answered 的重答 | 只改 answers_json + 条目戳，副作用块全跳过（AC-3）；WS 走既有 task-questions invalidation |
| 客户端对 reseal 题误传 scope | 服务端忽略（D6 防御），scope 保持原值 |
| reseal 题恰在他人面板中同时编辑 | 与现状同：last-write-wins（RFC-099 draft 协作模型），提交以先到者 seal 为准、后到者 409 后刷新可见新答案 |

## 5. 测试策略（Test-with-every-change）

**后端（bun test）** `packages/backend/tests/rfc136-reanswer.test.ts`：

1. pending sealed 题重 seal：answers_json 覆盖、sealed_at/By 更新、autoStage 盖 staged_at、
   `resealedQuestionIds` 返回。
2. staged sealed 题重 seal → 409（守卫）；下发后（dispatched_at 非空）→ 409。
3. cross 多角色条目一行已 staged → 整题 409。
4. round=answered 的重答：status 保持 answered、无重复翻转副作用（park/WS/legacy 断言）。
5. awaiting_human 部分 seal 轮：重答不影响剩余未答题计数；fresh+reseal 混合提交一次成功。
6. reseal 题传 scope 被忽略（question_scopes_json 不变、reconcile 派生条目零增删）。
7. golden-lock：纯 fresh 提交路径行为与现状字节一致（复用既有 seal 测试全绿即锁）。
8. AC-8 集成：重答→stage→dispatch，注入 prompt 含新答案不含旧答案。

**前端（vitest）** 扩展 `centralized-answer-pane.test.tsx` + `task-question-list.test.tsx`：

1. `groupAnswerableQuestions` oracle：sealed pending 纳入 + `resubmitQuestionIds` 正确；
   staged/processing/done 仍排除；manual 仍排除。
2. 面板渲染：reseal 题预填已提交答案（选项勾选 + customText）；resubmit 提示在场；
   cross reseal 题无 scope segmented（fresh 题有）。
3. seed 优先级：reseal 题忽略 server draft（fixture 同时给 draft 与 answers，断言用 answers）。
4. 提交体：fresh+reseal 混合 → 一次 POST，questionIds 含两者、questionScopes 只含 fresh。
5. 入口按钮：全 sealed pending（无 unsealed）也显示；全部下发后消失。

## 6. 兼容与迁移

零 migration（无新列——`prior_answer_snapshot_json` / `reopen_count` 保持 dormant）；
零 API 破坏（请求体不变、响应体新增可选字段）；i18n 新增 1 key（zh + en）。
`groupUnsealedQuestions` 更名属包内导出（frontend 内部 + 测试），无外部消费者。
