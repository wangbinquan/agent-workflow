# RFC-160 技术设计

## 单点变更

`packages/shared/src/schemas/clarify.ts:150`

```diff
- export const CLARIFY_QUESTION_SCOPE_DEFAULT = 'designer' as const
+ export const CLARIFY_QUESTION_SCOPE_DEFAULT = 'questioner' as const
```

这是全站 scope 默认的**单一事实源**。非测试消费点共 4 处，全部自动随之改变（无其它硬编码
`'designer'` 默认——已全仓 grep 确认）：

| 消费点 | 文件:行 | 翻转后行为 |
|---|---|---|
| reconcile 默认 | `shared/src/task-questions.ts:125` | 无显式 scope 的 cross 题 → `scope=questioner` → **不产 designer 条目**（`reconcileDesiredEntries` 的 designer 分支 `scope==='designer'` 不命中） |
| `resolveQuestionScope` | `shared/src/clarify.ts:521-522` | `scopes===null` / 缺键 → `questioner`；`extractDesignerFeedback` 随之只把**显式** designer 题转给设计者 External Feedback |
| 详情页 picker 初值 | `frontend/src/routes/clarify.detail.tsx:236,503,866,986` | picker 默认落「反问者」；提交、`allDesigner/allQuestioner/mixed` 分发 hint、designer 域过滤随之 |
| 常量定义 | `shared/src/schemas/clarify.ts:150` | — |

**关键点**：承接节点默认**不变**。questioner 条目承接默认＝`graph.questionerNodeId =
round.askingNodeId`（`task-questions.ts:graphForRound`）。翻默认后 cross 默认只此一条 ⇒ 承接
＝来源/提问节点，与 self 的「承接＝提问节点自己」同构——正是用户要的「处理节点默认＝本节点
/来源节点」。

## Doc-comment 校正（随行必改，否则文档撒谎）

- `schemas/clarify.ts:135-150`：`ClarifyQuestionScopeSchema` 的 JSDoc 与常量注释把 `'designer'`
  称作「Default — preserves RFC-056 behaviour byte-for-byte」/「Preserves RFC-056/058
  behaviour」。新默认是 `questioner`，改注释说明默认翻转 + 指向 RFC-160；保留「legacy NULL 行
  的回填」这层含义（见下「向后兼容」——本 RFC 有意让它一并吃新默认）。
- `clarify.ts:508-516`：`resolveQuestionScope` JSDoc 三处「returns the default 'designer'」→
  `'questioner'`。
- `frontend/CentralizedAnswerDialog.tsx:372-374` 注释「resolve every fresh cross question to the
  default 'designer' scope」→ `'questioner'`（无逻辑改动，仅注释）。

## 数据流 / 语义

- **scope 语义不变（RFC-059）**：scope 是单向「**也**送设计者」标记、不是二分路由——**反问者
  恒收全量 Q&A**。故默认改 `questioner` ＝「默认只有反问者带答案重跑消化；不额外通知设计者、
  设计者不为此题重跑」。设计者修订从「默认发生」降级为「显式选择才发生」。
- **执行拓扑**：反问者卡走 `cross-clarify-questioner-rerun`（阻塞-产出型，恒有）；设计者卡走
  `cross-clarify-answer`（修订型，仅显式 designer 时才有）。翻默认只影响「是否默认生成设计者
  卡」，两条 rerun 通路本身不变（questioner-only 轮本就是既有、已测的合法形态——见 RFC-138
  背景「questioner 行是唯一复活通道」）。

## 向后兼容：追溯收敛（用户拍板 A，无 migration）

**事实**：seal 时若客户端未送 scope（集中面板即此路径），`clarifySeal.ts:265-277` 计算
`scopesJson`——空 map 落 **NULL**（`Object.keys(mergedScopes).length > 0 ? … : null`）；
`'designer'` 只在解析期由默认补齐、**不落库**。故**已存在的已答 cross 轮 `questionScopesJson`
多为 NULL**、靠旧默认得到 designer 卡。

翻默认后，下次任意 `listTaskQuestions`（惰性 reconcile）对这些老轮：

1. `reconcileDesiredEntries` 的 `scope = scopes[qid] ?? DEFAULT` ＝ `questioner` → `desired`
   不含 designer 条目；
2. reconcile 的 answered-轮清理（`taskQuestions.ts:268-284`）删除
   `dispatched_at IS NULL AND questionId NOT IN desiredDesignerIds` 的 designer 行 →
   **未下发的 designer 卡被移除**；
3. 该清理**恒守 `dispatched_at IS NULL`** → 已下发（处理中/已处理待确认/完成）的 designer 行
   **不动**。

判定：这正是用户选的「一并收敛」。恢复路径＝把反问者卡改派到设计节点（RFC-140
collapse-to-designer 重建 designer 卡 + echo 回执）。**有意行为**，本文件与 `STATE.md` 明记。

### 失败模式

- **F1**：老轮里已 staged（待下发）但未 dispatch 的 designer 卡静默消失——**有意**（用户 A）。
  文档化 + 恢复路径（改派）。因是「未下发」态，无在途 rerun 被中断、无 node_run 泄漏。
- **F2**：不影响 self 轮（self 忽略 scope）、不影响**显式** questioner 题、不影响**显式**
  designer 题（显式落库、`scopes[qid]` 命中、不吃默认）。
- **F3**：RFC-136 re-answer 保留已提交 scope（`clarifySeal.ts:265` merge 不覆盖既有键）——
  已 answered 老轮**若曾显式落 designer**，其键非 NULL，不吃新默认、不受影响；只有 NULL 的老轮
  收敛。
- **F4**：`extractDesignerFeedback`（`clarify.ts:525+`）在老轮**重派/续跑**时按新默认不再把
  NULL-scope 题转给设计者——与「设计者不再默认重跑」一致，非回归。

## 与既有模块耦合

- **RFC-137**（面板无逐题 scope picker）：面板本就不送 scope → 新默认 `questioner` 直接生效，
  **面板零改动**。
- **RFC-138 / RFC-140 collapse**：仍是 designer↔questioner 互转入口，行为不变；改派
  questioner→designer 仍重建 designer 卡（本 RFC 的显式恢复通路之一）。RFC-140 反向 collapse
  为未答题插未 seal designer 行的路径不变。
- **独立 bug 修复（本 RFC 之外，已完成）**：`collapseDesignerEntryToQuestioner` 的 seal 归一化
  加 `status==='answered'` 守卫——已修，不在本 RFC diff；与本 RFC 正交（一个改默认、一个修
  collapse 误 seal）。

## 测试策略（§必写 case）

**shared**

- `clarify-question-scope-shared.test.ts`：常量值 `toBe('questioner')`；
  `resolveQuestionScope(null, …) === 'questioner'`；`resolveQuestionScope({q:'designer'}, q)
  === 'designer'`（显式仍胜——golden-lock）。
- `task-questions-reconcile.test.ts`：无 scope 的 answered cross 轮 → 只 questioner 条目、无
  designer（AC-1）；显式 `designer` → 仍产 designer（AC-2 golden-lock）；self 轮 → 只 self
  条目（不受影响）。

**backend**

- 逐一核「默认 designer」命中集（见 `plan.md`）：靠**默认** designer 的断言翻转；**显式**设
  scope 的不动。
- 新增「追溯收敛」锁（AC-4）：seed 一条 `questionScopesJson=NULL` 的 answered cross 轮 + 一张
  **未下发** designer 行 + 一张 **dispatched** designer 行 → `listTaskQuestions`（惰性
  reconcile）后：未下发 designer 行消失、已下发 designer 行保留、questioner 行保留。

**frontend（vitest，不在根 `bun test`）**

- `cross-clarify-scope-control.test.tsx` / `cross-clarify-scope-shortcut.test.tsx`：picker 默认
  落「反问者」；显式切「设计者」仍工作；`allQuestioner` hint 为默认态。
- `centralized-answer-pane.test.tsx` / `clarify-question-handler.test.tsx`：若断言了默认
  designer 派生，随之翻。

**门禁**：`bun run typecheck && lint && test && format:check` 全绿；**binary smoke**
（`bun run build:binary`——shared 导出常量变更，按 [reference_binary_build_module_cycle] 跑一次
兜底）；前端 vitest（[project_frontend_i18n_batch]：前端测试走 vitest、不在根 bun test）。
