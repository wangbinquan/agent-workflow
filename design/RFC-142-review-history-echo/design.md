# RFC-142 技术设计：评审历史信息全量回显

## 0. 改动一览

| 文件 | 改动 |
|---|---|
| `packages/shared/src/schemas/review.ts` | 新增 `ReviewRoundSummarySchema` / `ReviewRoundSummary`（轮级摘要，成员复用 `ReviewDocumentSummarySchema` + 每成员 `decision`） |
| `packages/backend/src/services/review.ts` | 新增 `listReviewRounds(db, appHome, nodeRunId)`；抽取 `buildDocumentSummary` 供 `getReviewDetail` documents 构造与轮成员构造共用（不 fork）；`getReviewDetail` 多文档已决策轮改取最高代（G4） |
| `packages/backend/src/routes/reviews.ts` | 新增 `GET /api/reviews/:nodeRunId/rounds`（`ensureReviewVisible` 同门） |
| `packages/frontend/src/components/review/ReviewDecisionInfo.tsx` | 新公共组件：决策信息块（决策 chip + 决策人 AttributionChip + 时间 + 原因行） |
| `packages/frontend/src/routes/reviews.detail.tsx` | 单文档当前/历史视图接入 `<ReviewDecisionInfo>`（替换现有 `review-detail__decider` 行）；`validateSearch` 增加 `round`；多文档分支透传 `roundKey` |
| `packages/frontend/src/components/review/MultiDocReviewView.tsx` | 新增 `historicalRoundKey` prop：历史轮只读模式（rounds query + 该轮成员导航 + 只读横幅 + 决策信息块 + 写入口全禁） |
| `packages/frontend/src/routes/reviews.tsx` | `HistoryRows` 接 `isMultiDoc`：多文档改调 `/rounds` 渲染轮行；单文档保持 `/versions` v1..vN |
| `packages/frontend/src/hooks/useTaskSync.ts` | review.\* 事件追加失效 `['reviews','rounds',nodeRunId]` |
| `packages/frontend/src/i18n/zh-CN.ts` / `en-US.ts` | 新 key（§3.4；zh-CN 的类型声明段与取值段都要加） |
| 测试 | 见 §5 |

零 migration；`doc_versions` 不加列（`round_generation` 已在，migration 0070）；agent prompt 路径零改动。

## 1. 机制现状（精确锚点）

- **decisionReason 写入**（`services/review.ts:1645-1663`）：rejected → `args.rejectReason`；
  iterated → `renderCommentsForPrompt(commentsArr, {sourceFilePath})`（与同行 `commentsJson`
  内容重复的渲染态）；approved → null。superseded 退休路径固定写 `'upstream-refreshed'` +
  `decidedBy:'system'`（`review.ts:529-543`）。
- **decisionReason 读出**：`rowToDocVersion`（`review.ts:2538`）→ `DocVersionSchema.decisionReason`
  （`shared/schemas/review.ts:159`）→ `/api/reviews/:id`（currentVersion）与
  `/api/reviews/:id/versions[/:vid]` 均已携带。前端零消费（本 RFC 前）。
- **多文档轮生成**：mint 循环给同轮每个成员盖同一 `roundGeneration`（`review.ts:624-671`），
  计数 per-(taskId, reviewNodeId, workflow-iteration) 严格单调（`loadPriorRound`
  `review.ts:880-923`，next = maxGen+1）。单个 nodeRunId 属单个 workflow iteration，故
  nodeRunId 范围内 generation 不重复。`roundGeneration` 未上 DTO（`review.ts:830-831` 注明
  internal）。pre-0070 legacy 行为 NULL。
- **versionIndex**：per `(reviewNodeRunId, sourcePortName, itemIndex)` 独立递增
  （`review.ts:766-785`）——多文档场景对「轮」无标识作用。
- **当前轮选择**（`getReviewDetail` `review.ts:1099-1138`）：pending 成员优先；否则
  `reviewIteration == max` 的全部 item 行（不看代——G4 混代点）。
- **决策写入是整轮的**：`submitReviewDecision` 对该 nodeRunId 全部 pending 行统一 set 同一
  decision（`review.ts:1605-1664`）；superseded 退休同样整组。⇒ 轮内 decision 同质是写入端
  不变量。
- **冻结评论读取**：`getDocVersionDetail`（`review.ts:1224-1252`）pending 行读 live 表、
  已决策行 parse `commentsJson`（损坏兜底空数组，`parseArchivedComments`）。多文档历史轮
  逐篇正文+评论**直接复用**该端点，无需新读取路径。
- **列表展开**（`reviews.tsx:233-309`）：调 `/versions` 平铺渲染 v{versionIndex} 行。
  `ReviewSummary.isMultiDoc`（`shared/schemas/review.ts:322`）已存在。
- **WS 失效**（`useTaskSync.ts:57-59`）：review.\* 事件失效 detail / list / pending-count 三个
  key；versions / rounds 不在其中（versions 靠展开时挂载刷新，维持现状）。

## 2. 决策

- **D1 决策信息块显示规则**（用户拍板「详情视图」）：viewed 版本 `decision !== 'pending'` 时
  渲染。内容 = 决策 chip + 决策人（`decidedBy` 非 null 且非 `'system'` 时 AttributionChip；
  `'system'` 显示「系统」文本）+ `decidedAt` 本地化时间 + 原因行。原因行仅两类：
  rejected → `decisionReason` 原文（pre-b 空值行显示占位「未记录」）；superseded →
  `decisionReason === 'upstream-refreshed'` 映射 i18n 固定文案，未知值原样显示（向前兼容）。
  **iterated 不显示 decisionReason**——它是 `renderCommentsForPrompt` 的渲染态，与页面已展示的
  冻结评论逐字重复，重复展示只制造「这是另一份意见」的错觉。
- **D2 组件化**：决策信息块做成 `components/review/ReviewDecisionInfo.tsx` 公共组件（遵循
  前台一致性强制原则），单文档详情（当前 + 历史）与多文档轮视图三处复用；替换现有
  `review-detail__decider` 行（该行只有决策人 chip，是本块的真子集）。
- **D3 轮端点与 roundKey**：新端点 `GET /api/reviews/:nodeRunId/rounds` 返回
  `ReviewRoundSummary[]` 升序（旧→新）。分组键：`roundGeneration` 非 NULL 行按
  `(reviewIteration, roundGeneration)`，roundKey=`g{roundGeneration}`；NULL（legacy）行按
  `reviewIteration` 归并为一轮，roundKey=`i{reviewIteration}-legacy`。排序：legacy 轮在前
  （按 reviewIteration 升序），generation 轮在后（按 roundGeneration 升序）——0070 之后所有
  mint 都带 generation，legacy 行时间上必然更早。roundKey 对前端是**不透明字符串**。
  单文档评审（无 itemIndex 行）返回 `[]`（前端 isMultiDoc=false 也不会调用）。
- **D4 轮级字段派生**：`decision` 取成员首个非 pending 决策（写入端整轮同质，见 §1；异质是
  数据损坏，防御取首个 + `log.warn`）；`decisionReason` 仅 rejected（成员共享同一
  rejectReason，取首个）与 superseded（固定 `'upstream-refreshed'`）非 null——iterated 轮级
  为 null（意见分散在各篇冻结评论）；`decidedAt/decidedBy/decidedByRole` 取成员中 `decidedAt`
  最大的行；`createdAt` 取成员最小 `createdAt`；`isCurrent` = 该轮含 pending 成员，或无任何
  pending 轮时排序最后的轮（与 G4 修复后的 `getReviewDetail` 选择一致，测试锁一致性）。
  成员条目 = `ReviewDocumentSummary`（复用既有 schema/构造，含 title/selection/stale/
  commentCount）+ `decision`（成员级，供历史轮 UI 标注 superseded 等）。成员**不带**
  decisionReason（iterated 的渲染态重复，见 D1）。
- **D5 G4 修复**：`getReviewDetail` 多文档「已决策轮」改为：先 `reviewIteration == max`，再在
  其中取 `roundGeneration == max`（NULL 视为 -∞，仅当该 iteration 全为 legacy 行时整组选中
  ——legacy 数据行为不变）。refresh 留下的 superseded 旧代不再与新代混屏。
- **D6 路由与回落**：`validateSearch` 增加 `round?: string`，与既有 `version` 并存；多文档
  分支消费 `round`（`version` 忽略，维持现状），单文档分支消费 `version`（`round` 忽略）。
  未知 roundKey（rounds 结果里查无此 key）→ `window.alert` + `navigate replace` 回当前轮，
  逐字对齐 RFC-013 未知 version 的处理（`reviews.detail.tsx:151-167`）。`?round=` 指向
  isCurrent 轮时等价于无参（渲染当前交互视图，不进历史只读态）——列表页对当前轮本就发空
  search，此规则仅兜住手输 URL。
- **D7 历史轮只读语义**：`historicalRoundKey` 命中历史轮时，MultiDocReviewView 的文档导航列表
  数据源从 `detail.documents` 切到该轮 `members`；首篇不再来自 detail.currentBody，全部成员
  统一走 `/versions/:vid` 懒加载（已决策行返回冻结评论——§1 读取路径现成）；`awaiting` 强制
  按 false 处理且额外 `historical` 旗标隐藏 accept/not_accept 按钮与轮级决策按钮（现状
  `readonly={!awaiting}` 只覆盖评论写入）；顶部渲染只读横幅（复用 `.readonly-banner` 样式）
  + `<ReviewDecisionInfo>`；selection 以只读 chip 呈现该轮当时选择。
- **D8 WS**：`useTaskSync` review.\* 失效追加 `['reviews','rounds',nodeRunId]`——决策/新轮
  mint 后打开中的轮列表自动刷新。versions key 维持现状不加（本 RFC 不扩大既有行为面）。
- **D9 轮号展示**：UI 轮号 = 排序后 1-based 序号（「第 n 轮」）。`reviewIteration` 可跳变
  （US-2 再评审）、`roundGeneration` 数值无语义，均不适合直接示人；序号才与评审员的心智
  （第几次送审）一致。roundKey 仅进 URL。

## 3. 接口契约

### 3.1 `ReviewRoundSummarySchema`（shared/schemas/review.ts）

```ts
export const ReviewRoundMemberSchema = ReviewDocumentSummarySchema.extend({
  decision: DocVersionDecisionSchema,
})
export const ReviewRoundSummarySchema = z.object({
  roundKey: z.string(),                    // 'g{gen}' | 'i{iter}-legacy'，前端不解析
  reviewIteration: z.number().int().nonnegative(),
  roundGeneration: z.number().int().positive().nullable(),
  decision: DocVersionDecisionSchema,      // 轮级（写入端同质不变量）
  decisionReason: z.string().nullable(),   // 仅 rejected / superseded 非 null（D4）
  decidedAt: z.number().int().nullable(),
  decidedBy: z.string().nullable(),
  decidedByRole: z.enum(['owner', 'user', 'admin']).nullable(),
  createdAt: z.number().int(),             // min(member.createdAt)
  isCurrent: z.boolean(),
  members: z.array(ReviewRoundMemberSchema), // itemIndex 升序
})
```

### 3.2 端点

`GET /api/reviews/:nodeRunId/rounds` → `ReviewRoundSummary[]`（升序，旧→新）

- 门：`ensureReviewVisible`（403 `task-not-visible`；nodeRunId 不存在 404
  `node-run-not-found`）——与 `/versions` 逐字同门。
- 单文档评审 → `[]`（200）。多文档但 doc_versions 为空 → `[]`。
- 纯函数核心：`groupDocVersionRounds(rows: DocVersion[]): RoundGroup[]`（分组 + 排序 + 轮级
  字段派生，**不做 IO**）导出供单测；`listReviewRounds` 负责查行、调分组、逐成员
  `buildDocumentSummary`（读 body 提 title / 数评论——pending 行 live 表、已决策行
  `parseArchivedComments(commentsJson).length`，与 `getDocVersionDetail` 的评论源选择一致）。

### 3.3 前端

- `ReviewDecisionInfo`：props `{ decision, decisionReason, decidedAt, decidedBy, decidedByRole,
  user? }`——内部按 D1 规则渲染；不发请求（用户 lookup 由调用方 `useUserLookup` 提供，与现状
  decider 行一致）。
- `MultiDocReviewView`：新增可选 prop `historicalRoundKey?: string`；内部
  `useQuery(['reviews','rounds',nodeRunId])`（enabled: 历史模式或需要 isCurrent 判定时）。
- `HistoryRows`（reviews.tsx）：新增 prop `isMultiDoc: boolean`；true 时改调 rounds query
  渲染轮行（第 n 轮 + 轮决策 chip + 文档数 + 时间 + Open→`?round=`，isCurrent 轮 Open 发空
  search），false 时行为不变。

### 3.4 i18n key（zh-CN / en-US 双份；zh-CN 类型声明段 + 取值段）

`reviews.decisionInfo.rejectReason`（复用语义同 `rejectReasonLabel`，但独立 key 避免对话框
文案耦合）、`reviews.decisionInfo.supersededReason`、`reviews.decisionInfo.reasonMissing`、
`reviews.decisionInfo.decidedAt`、`reviews.decisionInfo.systemDecider`、
`reviews.roundLabel`（`第 {{n}} 轮`）、`reviews.roundHistoryHeader`、`reviews.roundDocCount`、
`reviews.historicalRoundBanner`、`reviews.backToCurrentRound`、`reviews.unknownRound`。

## 4. 数据流

```
展开列表行(isMultiDoc)
  → GET /rounds → 轮行(第n轮·决策chip·N篇·时间·Open)
     Open(历史轮) → /reviews/$id?round=g7
       → MultiDocReviewView(historicalRoundKey='g7')
           rounds query 校验 key → members 导航列表
           每篇: GET /versions/:vid → 正文 + 冻结评论(commentsJson) → ReviewDocPane(readonly)
           横幅(只读·第n轮·决策) + ReviewDecisionInfo(轮级)
单文档详情(当前/历史) → 既有 detail / versions/:vid payload（decisionReason 已在）
  → ReviewDecisionInfo(版本级)
```

## 5. 失败模式

- 成员 body 文件缺失 → title/正文占位（沿用 documents 构造与 `readDocVersionBody` 的
  try/catch 行为，不 500）。
- `commentsJson` 损坏 → `parseArchivedComments` 已兜底空数组（`review.ts:1272-1284`）。
- 未知 roundKey → alert + replace 回当前轮（D6）。
- 轮内 decision 异质（写入端不变量被外力破坏）→ 取首个非 pending + `log.warn`（D4），UI 不崩。
- rejected 但 decisionReason 为 null（`rejectReason` 可选的历史数据）→ 原因行显示「未记录」
  占位（D1）。
- legacy（NULL generation）与新代混存 → legacy 按 iteration 独立成轮排前（D3），不与
  generation 轮互相污染。

## 6. 测试策略

后端（bun:test，新文件 `rfc142-review-rounds.test.ts` + `getReviewDetail` 回归入既有文件）：

1. `groupDocVersionRounds` 纯函数：两代两轮分组升序；legacy NULL 行按 iteration 归并 +
   排前；同 iteration 两代（refresh）分两轮；轮级 decision/decisionReason/decidedAt 派生
   （rejected 共享原因、iterated 轮级 null、superseded 固定值）；isCurrent（含 pending 轮 /
   全决策时末轮）；成员 itemIndex 升序。
2. `/rounds` 端点：多文档 2 轮全字段断言；单文档 `[]`；不存在 nodeRunId 404；任务不可见
   403 `task-not-visible`（对齐 `/versions` 的 ACL case）。
3. commentCount 来源：已决策成员计 `commentsJson`、pending 成员计 live 表。
4. **G4 回归（先红后绿）**：refresh 造出同 iteration 两代 → `getReviewDetail.documents` 只含
   最高代成员、无重复 itemIndex；旧代在 `/rounds` 里独立成 superseded 轮。

前端（vitest，`packages/frontend/tests/`）：

5. `review-decision-info.test.tsx`：rejected 显示原因全文；superseded 显示系统文案 + 「系统」
   决策者；iterated 显示决策人/时间、无原因行；pending 不渲染；reason 缺失显示「未记录」。
6. `reviews-detail-decision-info.test.tsx`：单文档历史 `?version=` 视图与当前视图（已决策）
   都渲染决策信息块（数据来自既有 payload，断言无新请求）。
7. `reviews-list-rounds-expand.test.tsx`：isMultiDoc 行展开渲染轮行 + Open 链接带
   `?round=`（当前轮空 search）；单文档行仍 v1..vN。
8. `multidoc-historical-round.test.tsx`：`?round=` 历史轮——无 approve/iterate/reject、无
   accept/not_accept 按钮、评论只读；渲染该轮成员 + 冻结评论 + 只读横幅 + 决策信息块；
   未知 roundKey alert 后回当前轮。

角色断言优先 `getByRole`/`findByRole`；testid 走公共组件既有 `data-testid` 模式。
