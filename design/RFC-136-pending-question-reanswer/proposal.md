# RFC-136 — 待指派问题重答：回到待指派的已答问题允许修改答案（复用集中回答面板）

- 状态：Done（2026-07-02 用户批准 D1–D6；实现期追加 D7 allowReseal / D8 unstage 级联 /
  D9 半 staged 不进池——见 design.md §0）
- 触发：2026-07-02 用户「如果问题返回到了待指派，应该允许修改问题答案，复用之前的回答界面」
- 关联：RFC-128（集中回答面板 / per-question seal / autoStage）、RFC-133（下发 run 义务）、
  RFC-120 AC-11（「打回」——已下发问题的改答重跑，**未实现**，本 RFC 非目标但共享心智）

## 背景

RFC-128 后，问题的回答通道收敛为集中回答面板（CentralizedAnswerDialog，defer=true 控制通道）：
回答（seal）后问题经 autoStage 直接进入「待下发」，用户在看板批量下发。若用户把一个已回答的
问题「移出待下发」，它回到「待指派」相位——此时它带着已提交（sealed）的答案停在待指派，但：

1. **无处修改答案**：集中回答面板的答题池 `groupUnsealedQuestions` 只纳入 **未回答**（unsealed）
   的待指派题；/clarify 反问页对 sealed 题灰显锁定（RFC-128 P4 T10 协调灰显）。
2. **后端拒绝重提交**：seal 原语是 exactly-once——对已 sealed 的题再提交抛
   `clarify-question-already-sealed`（409，`services/clarifySeal.ts`）。

结果：答案一经提交便不可修改，除非把问题下发出去再走（尚未实现的）打回。用户在下发前发现
答案写错/想补充时没有任何出路——只能眼睁睁下发一个错误答案或永远搁置该题。

## 目标

- 处于**待指派（pending）**相位、已回答（sealed）的 clarify 问题，允许修改答案后重新提交。
- **复用集中回答面板**：已答的待指派题与未答题一并列出，预填已提交答案、可直接编辑；
  一个「提交答案」按钮同时覆盖初答与重答。
- 重答提交后与初答走**同一通道同一语义**：per-question 重 seal（覆盖旧答案）+ autoStage
  进「待下发」，之后照常批量下发。

## 非目标

- **已下发问题的打回**（processing / awaiting_confirm / done）：那是 RFC-120 AC-11 的
  reopen 流程（含 `prior_answer_snapshot_json` / `reopen_count` 审计与 re-fire），本 RFC 不实现、
  不占用其预留字段。
- **待下发（staged）题的就地修改**：用户拍板「仅待指派」——staged 语义是「已确定待下发」，
  要改先「移出待下发」回到待指派（一步既有操作）。
- **manual 问题**：无 clarify round、指令即内容（恒 sealed），修改指令不在回答界面的范畴。
- **/clarify 反问页的 sealed 解锁**：修改入口收敛在集中面板一处；反问页对 sealed 题保持
  灰显（避免双通道并发改写同一答案）。
- **改答历史审计**：用户拍板「直接覆盖」——不写 `prior_answer_snapshot_json`、不递增
  `reopen_count`（两字段保持 dormant，留给未来打回 RFC）。

## 用户故事

1. **答错了想改**：我在集中面板回答了三个问题，它们进了待下发。下发前我发现第二题选错了——
   把它移出待下发，重新打开「处理待指派问题」，第二题带着我上次的答案出现在面板里，我改掉
   选项、点提交，它重新回到待下发，和其它题一起下发。
2. **补充说明**：某题我只选了选项没写补充文本，移出待下发后在面板里补一段 customText 重新
   提交——下发时承接节点看到的是带补充的完整答案。
3. **未答与已答混合**：面板里同时有 2 个未答题和 1 个重答题，一次提交全部生效——未答题初次
   seal、重答题覆盖旧答案，三题一起进待下发。

## 验收标准

- AC-1：已 sealed 且相位为 pending 的 clarify 问题出现在集中回答面板中，初值为**已提交答案**
  （选项勾选 + customText 完整还原）；卡片有「已回答，重新提交将覆盖」类视觉提示。
- AC-2：修改后提交，`POST /api/clarify/:nodeRunId/answers`（defer=true + questionIds cap）
  成功覆盖 `clarify_rounds.answers_json` 中该题答案，条目 `sealed_at/sealed_by` 更新为本次，
  并 autoStage 进待下发（与初答一致）。
- AC-3：重答不改变轮次状态：round 已 `answered` 的保持 `answered`（不重触发翻转副作用），
  仍 `awaiting_human`（部分 seal）的不重复计数、剩余未答题不受影响。
- AC-4：范围守卫——staged / 已下发（dispatched_at 非空或相位非 pending）的 sealed 题重提交
  仍收 `clarify-question-already-sealed`（409）；未 sealed 题行为与现状字节一致（golden-lock）。
- AC-5：重答的 cross 题**沿用已提交的 scope**（designer/questioner 归属不变）；面板对重答题
  不显示 scope 切换控件——避免 reconcile 派生条目在重答时增删。
- AC-6：「处理待指派问题」入口按钮的显隐从「存在未答待指派题」放宽为「存在待指派 clarify 题
  （无论答没答）」；全部题都已下发/完成时按钮消失（现状保持）。
- AC-7：权限与现状一致（requireTaskMember：owner/collaborator/admin）；`sealed_by` 仍为
  审计列，绝不进入 agent prompt（RFC-099 prompt-isolation 约束不变）。
- AC-8：重答后下一次下发注入承接节点的是**新答案**（注入读 answers_json，天然生效——用集成
  断言锁定）。

## 显式决策（批准时请一并确认）

- D1（用户拍板）：范围仅待指派 pending；staged 先移出待下发。
- D2（用户拍板）：入口=集中面板纳入已答题预填；不做卡片逐题按钮。
- D3（用户拍板）：直接覆盖旧答案，不留快照/计数。
- D4（本 RFC 定，请确认）：重答提交后 autoStage 进待下发——与初答同语义（改完即待发，
  无需再手动「加入待下发」）。
- D5（本 RFC 定，请确认）：重答预填以**已提交答案**为基线，忽略该题遗留的 server/IDB 草稿
  （seal 后草稿不清理，陈旧草稿会污染「修改已提交答案」的心智）；编辑过程中草稿照常自动保存。
- D6（本 RFC 定，请确认）：重答题锁定原 scope（AC-5）——scope 变更会让 reconcile 增删
  designer/questioner 条目，与「只改答案内容」的意图不符，留给打回流程处理。
