# RFC-138 技术设计

## 0. 一句话

`reassignTaskQuestion` 加一个 collapse 分支：cross 轮 designer 行 + 目标==该轮提问节点 ⇒
单事务「两表 scope 翻转 + 删未下发 designer 行」，其余路径逐字不变。零 migration、零新
端点、零 scheduler / dispatch / echo 改动。

## 1. 现状事实（实现依据，均已核对源码）

- 承接条目派生：`reconcileDesiredEntries`（`packages/shared/src/task-questions.ts:99`）——
  cross 轮每题 questioner 行恒有（`defaultTargetNodeId=graph.questionerNodeId`）；designer
  行仅当「该题已 seal ∧ directive≠stop ∧ scope==='designer'」。scope 缺省值
  `CLARIFY_QUESTION_SCOPE_DEFAULT='designer'`（`shared/src/schemas/clarify.ts:150`）。
- scope 的 SoT 是 `clarify_rounds.question_scopes_json`（reconcile 经
  `reconcileRoundEntriesTx` 读它，`services/taskQuestions.ts:193`）；seal 路径 merge-write
  它并与 `cross_clarify_sessions.question_scopes_json` lockstep 双写
  （`services/clarifySeal.ts:277-289,344-377`，有 dual-write-consistency 测试网）。
- reconcile 的 designer 下修清理只在 roundAnswered 分支跑（`taskQuestions.ts:253-269`，
  P2-2：仅删 `dispatched_at IS NULL` 行）——**partial 轮翻 scope 不会被它清**，所以 collapse
  必须自己删行（见 §2 步骤 3），不能依赖 reconcile。
- `reassignTaskQuestion`（`taskQuestions.ts:953-1021`）：canReassign（目标须 agent 节点）→
  terminal 拒绝 → manual 目标须有 run → dbTxSync 内 CAS（`dispatched_at IS NULL` 同列，
  输给并发 dispatch ⇒ 409 already-dispatched）→ 写 `override_target_node_id` + 审计戳。
- 路由 `POST /api/tasks/:id/questions/:entryId/reassign` 返回 `{ ok: true }`
  （`routes/taskQuestions.ts:125-134`）；前端两处调用（`ClarifyQuestionHandler.tsx` 反问页、
  看板 reassign mutation）均只用 onSuccess invalidate，不读 body ⇒ 加字段向后兼容。
- 双跑根因链（本 RFC 拆掉的就是这条链的成因，不改链本身）：
  cause 互斥 + auto-split（`taskQuestionDispatch.ts:396-440`）、in-flight 门
  （`assertNoInFlightDispatch`）、双账本守卫（`taskQuestionDispatch.ts:1057-1063`）。
- 整轮单目标守卫只检 roleKind='designer' 的 open 行（`taskQuestionDispatch.ts:333-366`）
  ⇒ collapse 删行后该题自动脱离此约束（AC-3 无需改守卫）。
- 注入面：`selectAgentQueue` 按 effectiveTarget 全量选取 + D9 同题去重
  （`clarifyQueue.ts:87-214,308-319`）——collapse 后该题只剩 questioner 行，一条 rerun、
  一次渲染，注入层零改动。
- RFC-136 D6：reseal 忽略客户端 scope（`clarifySeal.ts:272-288`）⇒ 翻转值经重答保持。

## 2. 接口契约与事务

### 2.1 service：`reassignTaskQuestion` 分叉

```
collapse 条件（全部满足）：
  entry.sourceKind === 'cross'
  ∧ entry.roleKind === 'designer'
  ∧ targetNodeId === round.askingNodeId        // round 由 entry.originNodeRunId 查
                                               // clarify_rounds.intermediary_node_run_id
不满足任意一条 ⇒ 走既有 override 路径（golden-lock，字节不变）。
```

前置守卫顺序不变（canReassign → terminal → manual-never-run），collapse 判定插在 CAS 事务
之前（需要一次 round 查询；round 缺失 / kind≠cross ⇒ 不满足条件，回落 override 路径）。

### 2.2 collapse 事务（一个 dbTxSync，镜像 seal 的双写纪律）

1. **CAS**：`SELECT ... WHERE id=:entryId AND dispatched_at IS NULL`（同现状同列）；
   0 行 ⇒ tx 内直接返回未更新，外层抛 409 `task-question-already-dispatched`（与现状同码，
   并发 dispatch 赢者恒胜）。
2. **tx 内重读 round 行**（不用 tx 外快照）→ merge scope：
   `question_scopes_json[entry.questionId]='questioner'`，其余键原样保留；空 map 起步时
   新建对象。同值写 `clarify_rounds` 与 `cross_clarify_sessions` 两表（lockstep；self 轮
   不可达此分支，无需 `clarify_sessions` 侧）。
3. **删行**：`DELETE FROM task_questions WHERE origin_node_run_id=:origin AND
   question_id=:qid AND role_kind='designer' AND dispatched_at IS NULL`。按 (origin, qid,
   role) 删而非按 id——同题理论上只有一条 designer 行（唯一索引 origin+question+role），
   谓词带上 dispatched_at 只为与 CAS 同语义兜底。
4. 审计：`log.info('designer entry collapsed to questioner scope', {taskId, entryId,
   originNodeRunId, questionId, actorUserId})`（D4——不在 questioner 行上伪造改派戳）。

### 2.3 路由

响应扩展为 `{ ok: true, action: 'override' | 'collapsed-to-questioner' }`（service 返回
判别值；现前端不读 body，向后兼容）。不加新端点。

### 2.4 前端

- `ClarifyQuestionHandler.tsx`（反问页）与看板 reassign mutation：onSuccess 读 `action`，
  `collapsed-to-questioner` 时 toast i18n 文案「该题改由提问节点承接（反问者）」；
  invalidation 既有（`task-questions` 等）已足够让 designer 卡消失。
- 选择器仍列全部 agent 节点（含提问节点），不加特殊标记（v1 保持简单；文案在 toast 层）。

## 3. 并发与失败模式

- **vs `dispatchTaskQuestions`**：双向都是既有机制——collapse 的 CAS 在 `dispatched_at`
  同列上（输 ⇒ 409）；dispatch 的 in-tx `stillNull` 复核发现行被删 ⇒ `ConcurrentClaim`
  整批回滚零脏（`taskQuestionDispatch.ts:562-585`）。无新窗口。
- **vs `sealRoundQuestions`（重答 / 补 seal）**：两写方对 `question_scopes_json` 都是
  「tx 内读-改-写 merge」，bun:sqlite 单写串行 ⇒ 无丢失更新；reseal 按 D6 忽略客户端
  scope ⇒ 不回翻。seal 侧 reconcile 因 scope=questioner 不再 desire 该题 designer 行。
- **vs 并发 reassign 同一行**：行被 collapse 删除后，后到者 `loadEntry` 404（可接受：
  条目已不存在）。
- **partial 轮**（该题 sealed、整轮未 answered）：designer 行存在即可 collapse；
  reconcileRoundEntriesTx 的 roundAnswered 清理不适用，本事务自己删行（§1 第三条）。
- **stop 轮**：designer 行本就不存在（reconcile 抑制）⇒ 分支不可达。
- **manual / self**：sourceKind 守卫直接回落 override 路径；self 轮无 designer 行，
  防御性不可达。
- **questioner 行已被 move 改派到 X**：collapse 照做；该题由 X 承接 + echo 补投提问节点
  （RFC-134 既有），仍单份投递（D5，不特判）。
- **崩溃恢复**：单 tx 原子——要么全成（翻转 + 删行），要么全无；无中间态。

## 4. 数据与兼容

- 零 migration：`question_scopes_json` 两表既有列；删行为 DML。
- 零 API 破坏：响应加可选字段；请求体不变。
- 历史数据不追溯（forward-only）：已双跑的历史轮不修。
- `question_scopes_json` 从 NULL 变为含单键 map 与 RFC-137「NULL 全默认 designer」读取面
  兼容（读方全默认兜底，写方 merge 保留其余键的缺省态不受影响——缺省题依然不在 map 里）。

## 5. 测试策略（随实现同 commit 落）

后端（新 `rfc138-reassign-to-asker-collapse.test.ts`）：

1. collapse 正路径：翻转后两表 scope 相等且该题 ='questioner'、designer 行删除、
   questioner 行（含其 staged/override/审计列）逐字节不变、响应 action 正确。
2. golden-lock：改派到第三节点 ⇒ 写 override、无删行、scope 不动（现测试网之外再断一次
   两表 scope 为 NULL/原值）。
3. 混轮下发（AC-3）：q1 collapse、q2 留设计节点 ⇒ dispatch 无 multi-target 409；设计节点
   注入块含 q2 不含 q1。
4. 单次投递（AC-2）：collapse 后 autoDispatch/board dispatch 全链 ⇒ 提问节点仅一条
   `cross-clarify-questioner-rerun` rerun；`buildClarifyQueueContext` 渲染该题恰一次；
   全程无第二条 `cross-clarify-answer` mint。
5. 边界拒绝：已下发 designer 行 ⇒ 409 already-dispatched（分支前 CAS）；manual 条目
   目标==某 agent 节点仍走 manual 路径；terminal（done）仍 409。
6. 不复活（AC-6）：collapse 后 `listTaskQuestions`（内含 lazy reconcile）与 RFC-136
   reseal 后均无该题 designer 行、scope 保持 questioner。
7. 并发缩影：collapse 与 dispatch 竞争同一行——先 dispatch 后 collapse ⇒ 409；
   （dispatch 侧 ConcurrentClaim 已有 rfc120/128 测试网覆盖，不重复造整批竞态）。

前端（vitest）：

8. 反问页 handler / 看板选择器选提问节点 ⇒ mutation 发出、成功后失效刷新（mock 数据翻转
   后 designer 卡消失）、toast 文案出现（i18n zh/en 两键）。

源码级兜底：

9. 文本断言 collapse 分支必须同写两表（防止未来只写 clarify_rounds 漂移 dual-write）；
   若既有 dual-write-consistency 网可直接覆盖则以行为断言替代。
