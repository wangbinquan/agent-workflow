# RFC-079 Design —— Review 多文档模式技术设计

> 状态：Draft（2026-06-03）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 全部 file:line 锚点经 review 子系统逐行勘探验证（2026-06-03）。
> 设计原则：**最大化复用 review 现有运行时**（doc_versions / review_comments / 三决策 / 回滚 / iterate 回灌 / 乐观锁 / 历史版本）；唯一新数据 = 每篇 selection + approve 输出采纳子集；单文档路径**字节级零回归**。

---

## 0. 核心判定

- **不新增 NodeKind**：`NODE_KIND`（`schemas/workflow.ts:30-40`）不动，`isProcessNodeKind`（:60）不动。多文档是 review 的**运行时模式**，由 `inputSource` 上游端口 kind 驱动，节点定义层无需区分。
- **不新增表 / 状态 / 不 bump schema_version**：复用 `doc_versions`（加 3 列）+ `awaiting_review` 状态。`WORKFLOW_SCHEMA_VERSION` 保持 4（节点定义结构零变化）。
- **判模式的单一判据**：`doc_versions.item_index IS NULL` ⇒ 单文档；`NOT NULL` ⇒ 多文档成员。全栈统一。
- **关键勘探校正**：`createDocVersion`（`review.ts:613-625`）按 `(reviewNodeRunId, sourcePortName)` 取 `max(versionIndex)+1`。多文档「单 sourcePort、多 item」会让各 item 的 versionIndex 互相污染——**必须把 item_index 纳入 versionIndex 计算键**（§2.1）。这是实现期第一必查点。

---

## 1. 数据模型最小改动

### 1.1 `doc_versions` 加 3 列（`packages/backend/src/db/schema.ts:597-642`）

在 `sourceFilePath`(:631) 之后新增（全 nullable、单文档 = NULL）：

```ts
// RFC-079: 0-based item index within a multi-document review round.
// NULL on every single-document row (back-compat). Non-NULL marks a
// member of a list<path<md>> review batch; accepted-subset output sorts by it.
itemIndex: integer('item_index'),                 // nullable; single-doc = NULL
// RFC-079: per-document curation decision in multi-doc mode. Orthogonal to
// `decision` (the round-level approve/reject/iterate state). At round approve:
// accepted → output subset; not_accepted → dropped; round `decision` flips to
// 'approved' on every member row.
selection: text('selection', { enum: ['unselected', 'accepted', 'not_accepted'] }), // nullable
// RFC-079: worktree-relative path of a list<path<md>> member (stable id).
// = the line from the upstream list port. Carried into the accepted-subset
// output so downstream reads the live file. NULL on single-doc / inline rows.
itemPath: text('item_path'),                      // nullable
```

新增复合索引（追加到表 index 块 :638-641）：

```ts
itemIdx: index('idx_doc_versions_review_item').on(t.reviewNodeRunId, t.itemIndex),
```

**为什么复用 doc_versions 而非建 `selection_*` 两表**：新方向要复用 review 全套机制（选词锚定 inline 评论、commentsJson 冻结、iterate 回灌、reject 回滚、历史版本 / diff）。让**每篇文档 = 一个 doc_version**，就自动获得 `review_comments` FK、版本化、commentsJson 冻结、bodyPath 文件布局、历史 diff。两表方案反而会丢掉 inline 评论能力。**结论：加 3 列，零新表。**

### 1.2 `review_comments`：零改动

每篇 inline 评论天然经 `docVersionId` FK 挂到对应那篇的 doc_version（`schema.ts:653-677`）。多文档 = 多 docVersionId，评论自动隔离；anchor 复合键语义不变。

### 1.3 `node_runs`：零改动

`reviewIteration`（`schema.ts:440`）继续作**轮次计数**，一轮内 N 篇共享同一 review node_run 的 `reviewIteration`。`status='awaiting_review'` 复用，**不新增** `awaiting_selection`。`consumedUpstreamRunsJson`（:554）继续记 `{[sourceNodeId]: sourceRun.id}`——多文档源仍是**单个 list 上游 run**，provenance 语义不变（§8 风险 5）。

### 1.4 shared schema（`packages/shared/src/schemas/review.ts`）

- `DocVersionSchema`（:144）追加 3 个可选字段（向后兼容）：
  ```ts
  itemIndex: z.number().int().nonnegative().nullable().optional(),
  selection: z.enum(['unselected', 'accepted', 'not_accepted']).nullable().optional(),
  itemPath: z.string().nullable().optional(),
  ```
- `ReviewDetailSchema`（:291）扩展为可选携带 `documents` 数组（多文档时每篇的 summary：docVersionId / itemIndex / itemPath / title / selection / commentCount）。
- 新增 `SetDocumentSelectionSchema`（PATCH body）：`{ selection: 'accepted' | 'not_accepted' }`。
- `ReviewSummarySchema`（:266）加 `isMultiDoc: z.boolean().optional()`（后端 `COUNT(item_index NOT NULL)>0` 推导）。

### 1.5 单文档零回归保证

- 三列全 nullable、无 DB default。drizzle 生成 SQLite `ALTER TABLE ADD COLUMN`（纯增列，无 table-rebuild——`selection` enum 在 drizzle 层是应用校验，DB 侧裸 text）。
- `dispatchReviewNode` 单值路径**完全不写**这三列 → 全 NULL → 现有查询（`WHERE decision='pending'` / `buildReviewPromptContext` / `getDocVersionDetail`）字节级不变。

---

## 2. 运行时改动点

### 2.1 `dispatchReviewNode`（`review.ts:341-584`）—— list 输入归档 N 个 doc_version

在 `resolvePortContentDetailed`（`envelope.ts:302`）拿到 port 内容后，按上游端口 kind 分叉：

```
loadUpstreamPortKind → tryParseKind
  ├─ parsed.kind !== 'list'  → 现有单文档路径（review.ts:425-583 原样，零改动）
  └─ parsed.kind === 'list' && inner ∈ {path<md>, markdown} → dispatchReviewNodeMultiDoc(...)
```

`dispatchReviewNodeMultiDoc`（新私有函数）：

1. `splitListItems(content)` → 路径数组（复用 `outputKinds/list.ts:34`；**最小改动：把私有 `splitListItems` 加 `export`**）。
2. **空数组**：park 一个 0-item awaiting_review；approve 即输出空 `accepted`（与单文档空 body 对齐，不引新短路分支）。
3. 复用 `review.ts:425-545` 的 review node_run find-or-create + provenance（**不改**，consumedJson 仍 `{[sourceNodeId]: sourceRun.id}`）。
4. 对每个 `(itemIndex, itemPath)`：读 `worktree/<itemPath>` → body；调 `createDocVersion(... sourceFilePath=itemPath, itemIndex, itemPath, selection='unselected')`。
   - **必改 `createDocVersion`（:613）的 versionIndex 计算键**，加 item_index 维度：
     ```ts
     .where(and(
       eq(docVersions.reviewNodeRunId, args.reviewNodeRunId),
       eq(docVersions.sourcePortName, args.sourcePortName),
       args.itemIndex != null
         ? eq(docVersions.itemIndex, args.itemIndex)
         : isNull(docVersions.itemIndex),   // 单文档保持原行为
     ))
     ```
   - bodyPath 布局加 item 段：`runs/{taskId}/review/{reviewNodeId}/{portName}/item_{itemIndex}/v{n}.md`（`docVersionRelativePath` 加可选 itemIndex 参数，单文档不变）。
   - **标题抽取**：`extractDocTitle(body, itemPath)`（shared 纯函数）= 首个 markdown heading / 首非空行 / 文件名，落入 detail 的 documents[].title（不入库，渲染时算或缓存）。
5. park `awaiting_review`；广播 `review.created`（payload 加可选 `itemCount`，让收件箱直接知是多文档）。

**awaiting-refresh / provenance（`review.ts:457-503`）**：上游 list 重生时 stale-refresh 的 `WHERE sourcePortName AND decision='pending'` 会一次 supersede 全 N 篇——**正确**（整批替换）；refresh 后 createDocVersion 循环**重建 N 篇**而非 1 篇（§8 风险 4）。

### 2.2 `submitReviewDecision`（`review.ts:1152-1493`）—— 三分支

入口先判模式（查该 round pending doc_versions，任一 `itemIndex != null` ⇒ 多文档）。**单文档分支完全不动**。多文档走新 `submitMultiDocDecision`。注意单文档当前 `dvRows ... .limit(1)`（:1184）只取一行——多文档**去 limit**，取全部 N 行 pending（§8 风险 2）。

**approve（同意 → 采纳子集 list<path<md>>）**
1. 读 round 全部 pending dv（N 篇），按 `itemIndex` 排序。
2. **全标校验**：任一 `selection='unselected'` → 409 `review-selection-incomplete`（A5）。
3. 每篇：归档其 `review_comments` → `commentsJson`（复用 :1193-1217 archive 逻辑，逐篇各跑），`decision='approved'`，保留各自 `selection`。
4. 采纳子集 = `filter(selection==='accepted').sort(itemIndex).map(itemPath)`（保序，C2）。
5. 写 `node_run_outputs`：`portName='accepted'`、`content=acceptedPaths.join('\n')`、`kind='list<path<md>>'`（§3）；`approval_meta` JSON 加 `acceptedItemIndices` / `itemCount`。
6. `transitionNodeRunStatus → done`（:1297），`resumeTask` 解锁下游。

**iterate（迭代 → 每篇评论回灌、不回滚、重开）**
1. 每篇 pending dv：归档 comments → commentsJson，`decision='iterated'`，`decisionReason = renderCommentsForPrompt(comments, { sourceFilePath: dv.itemPath })`（复用 :1643-1665，已带 File 头）。
2. 上游 rerun minting（:1355-1441）复用——rerunSet 含 `dv.sourceNodeId`（list 生产 agent），mint fresh pending；`rollbackFilesOnIterate` 默认 false（**不回滚**）。
3. **回灌多文档区分**：`buildReviewPromptContext`（:1677-1729）当前 `limit(1)` 只取单篇最近 decided dv——改为**聚合该上游全部 `decision='iterated'` 篇**的 `decisionReason`，每篇带 `### {itemPath}` 区分头，join 成单个 `comments` 字符串塞进 `ReviewPromptContext.comments`（`prompt.ts:35` 单字符串字段，**无需改 prompt schema**——区分头嵌在 markdown 里）。
4. bump `reviewIteration`、status→pending（:1474-1480 复用）→ scheduler 重跑上游 → 新 list → dispatch 重开多文档评审。

**reject（驳回 → 回退 pre_snapshot + 整批重生）**
- 几乎零改动。每篇 dv `decision='rejected'`、共享 `decisionReason=rejectReason`。
- 上游 rerun minting + `rollbackToSnapshot`（:1388-1398，`rollbackFilesOnReject` 默认 true）原样复用——回滚 list 生产上游的 worktree，整批 md 随之回退重生（C4）。
- sibling cascade（:1450）：「单 review 多 item」与「同上游多 review 节点 sibling」正交，reject 仍 always cascade 到真正 sibling review，**无需改**。

### 2.3 `prompt.ts` 评论渲染（`packages/shared/src/prompt.ts`）

- `{{__review_comments__}}` slot（:347-348）+ auto-append（:410-416）**零改动**——只消费预渲染字符串。
- 文档区分在 `services/review.ts` 侧完成：`renderCommentsForPrompt`（:1643）**已支持** `sourceFilePath → **File**: \`path\`` 头。多文档 iterate（§2.2 step 3）把每篇 render 结果 join 即可。**最小改动：`buildReviewPromptContext` 改 limit(1) → 聚合该上游全部 iterated 篇并 join。**

---

## 3. 输出端口形态（按输入 kind 切换、两形态并存）

| 模式 | 输入 kind | 输出端口 | content | kind 列 |
|---|---|---|---|---|
| 单文档 | `markdown` / `path<md>` | `approved_doc` + `approval_meta` | body 或 path 串 | `null` / `markdown_file`（`review.ts:1256` 已对） |
| 多文档 | `list<path<md>>` | `accepted` + `approval_meta` | 采纳路径 `\n` join | `list<path<md>>`（镜像输入） |

- approve 分支据 `itemIndex IS NULL` 决定写 `approved_doc`（单）还是 `accepted`（多）；两者互斥（一个 review 节点要么单要么多，由上游 input kind 决定）。
- **validator 输出端口推导（`workflow.validator.ts:290-299`，case 'review'）**：当前固定声明 `approved_doc`+`approval_meta`。改为据 inputSource 上游 kind——list → 声明 `accepted`(`list<path<md>>`)+`approval_meta`；否则 `approved_doc`+`approval_meta`。validator 已有 `agentByName` / outputKinds 访问（:757-764）。
- **放开 list 拒绝（`workflow.validator.ts:765-770`）**：当前 `review-input-list-kind-not-supported` 无条件拒 list。改为：list inner ∈ {path<md>, markdown} → **放行（多文档入口）**；inner 非 markdownish → 新 code `review-input-list-item-not-markdown`。
- **下游 wrapper-fanout 衔接**：`accepted:list<path<md>>` 是标准 list 端口，`fanout.ts:66-106` `getShardSourcePort` + boundary BFS 直接消费、按路径 `keyOf` 一条一 shard，**零 fanout 改动**；`splitListItems` 同源。

---

## 4. 前端改动点

### 4.1 `routes/reviews.detail.tsx`（多文档三栏，单文档零回归）

- **判据**：`detail.documents != null && documents.length > 0` ⇒ 多文档；否则现有 `currentVersion` 单文档双栏（**零回归，三栏只在多文档分支挂载**）。
- 三栏：`grid-template-columns: 240px minmax(0,1fr) {collapsed?32:280}px`。左栏新组件 `components/review/ReviewDocumentList.tsx`：每行 `title` + `StatusChip`（`unselected=neutral / accepted=success / not_accepted=danger`）+ 点击 `setSelectedDoc`，粘性头 `Documents (N)`，未决项视觉标记，`J/K` 跳上下 / 下一未决。
- 切换：`selectedDocId` state（同步 URL `?doc=`）。当前篇 body+comments 走对应 doc detail；非当前篇懒加载（复用现有 `GET /api/reviews/:nodeRunId/versions/:versionId` 拿 body+comments）。
- 选词 popover（:280-314）guard：仅当前篇可编辑；`draftStore` key 已含 `docVersionId`（`lib/review/draftStore.ts:9`）天然隔离；scroll-spy（:542-647）在 `selectedDocId` 变时 reset `activeCommentId` + observer.disconnect（§8 风险）。
- **逐篇采纳条**：右上「采纳(A) / 不采纳(R)」→ `PATCH /api/reviews/:nodeRunId/documents/:docVersionId/selection` 乐观更新。复用 `.btn .btn--sm` / `Form`(`TextArea`)。
- **三决策按钮**（复用 `DecisionDialog` :413-516）：approve 在多文档下校验全标，否则 disabled + 提示；iterate/reject POST body 不变。复用 `Dialog`。

### 4.2 `routes/reviews.tsx` 收件箱标识

`ReviewSummary` 加 `isMultiDoc`；行内 badge（`StatusChip kind=info`）+ tooltip「多文档评审」。复用现有 data-table 行结构，不自写 chrome。

### 4.3 复用公共组件（CLAUDE.md 强制）

`Dialog` / `StatusChip` / `Form`(`Field`/`TextArea`) / `Prose`+`MermaidBlock`+`PlantUmlBlock`（零新渲染代码） / `EmptyState` / `ErrorBanner` / `LoadingState` / `.btn` 体系 / `useResizable` / `useTaskSync`。**禁止**自写 modal / 原生 input / 自写 CSS。

### 4.4 WS 事件

- `hooks/useTaskSync.ts:40-55` 已订阅 `review.*` 并 invalidate `['reviews','detail',nodeRunId]`——多文档**复用同一套**（同一 nodeRunId 承载 N 篇）。
- 新增 `review.selection_changed`（`schemas/ws.ts` 加一条）：payload `{nodeRunId, docVersionId, selection}`，多 tab 同步逐篇采纳；`useTaskSync` 加一个 invalidate 分支。

---

## 5. schema / 版本

- **不新增 NodeKind**（§0）。
- **review 节点 schema（`ReviewNodeSchema` :61）**：可不加字段——多/单文档由 inputSource 上游 kind 自动决定。**可选**加 `outputPortName?: z.string()`（默认 `accepted`，仅多文档用）供改名，v1 可省。
- **`schema_version` 不 bump**（保持 4）：review 节点定义结构零变化，多文档纯属运行时 + DB 列扩展。相比早期 curation 草案（加 NodeKind 必须 4→5）的重大简化。
- **migration**：`bun run db:generate` 出 `doc_versions` ADD COLUMN ×3 + 一个 index，纯增列无 rebuild，daemon 启动自动 migrate。

---

## 6. 失败模式

| 失败 | 行为 |
|---|---|
| review 输入是 list 但 inner 非 markdownish | validator `review-input-list-item-not-markdown`（launch 前拦） |
| 上游 list 为空 | park 空 round；approve 输出空 `accepted`；下游 fanout 空 list 直接 done（A9） |
| 某 itemPath 文件缺失 | list handler 已校验文件存在（resolve 阶段报错）；若 dispatch 时缺失，该篇 body 占位告警、selection 可标 not_accepted，不卡整轮 |
| approve 有未标篇 | 409 `review-selection-incomplete`（前端按钮本就 disabled，双保险，A5） |
| 对非 awaiting / 已决 round 再操作 | 沿用现有 review 乐观锁 `review-iteration-mismatch` 409 |
| daemon 重启时 node_run 处 awaiting_review | review 既有 `orphanReap: leave-alone`，状态存活，人回来继续 |
| 上游 list 重生 | 整批 N 篇 superseded + 重建 awaiting_review（A8） |
| worktree awaiting 期间外部改 | 采纳子集 `accepted` 输出指向 live 文件，下游读改后内容；显示用归档 doc_version body。worktree-changed banner 属 RFC-005 S8，本 RFC 设计负债（非阻塞） |

---

## 7. 测试策略

**shared 纯函数（最易断言面）**
- `computeAcceptedSubset(docVersions)` = `filter(selection==='accepted').sort(itemIndex).map(itemPath).join('\n')`（保序 + 仅采纳，C2）。
- `isMultiDocReviewInput(kind)`：list inner markdownish 判定（§3 validator 放开规则）。
- `extractDocTitle(body, path)`：首 heading / 首非空行 / 文件名（A6）。
- `DocVersionSchema` 向后兼容：单文档行（三新字段缺省）仍 parse。

**backend**
- migration：`doc_versions` 三列 + index 存在（建表 + 源码断言 B5）。
- `dispatchReviewNode` 多文档：list → splitListItems → N 行 doc_version（itemIndex 0..N-1 / selection unselected / itemPath / versionIndex 各自 v1）。
- **C1 单文档零回归**：markdown / path<md> 仍走原路径，三列全 NULL，`approved_doc`/`approval_meta` 字节级不变。
- approve 子集保序（C2）；approve 未全标 409；写 `accepted` 端口 kind 正确。
- **C3 iterate 评论回灌带文档区分**：两篇各评论 → prompt 含两个 `### itemPath` 区块、不串篇、不回滚。
- **C4 reject 回退仍生效**：reject → `rollbackToSnapshot` 被调用 + 上游 mint fresh pending。
- selection PATCH：落 selection 列、awaiting 校验、不 bump reviewIteration、WS `review.selection_changed`。
- provenance：list 上游重生 → 整批 superseded + 重建。

**frontend**
- 多文档 detail reducer：逐篇 selection、approve 门控 disabled（存在 unselected）、J/K 当前篇内导航。
- 收件箱 `isMultiDoc` badge（`findByRole` 锚定）。
- 源码层兜底：`ReviewDocumentList` 用 `StatusChip`/`Prose`，三栏只在多文档分支，不出现自写 modal / 原生 select。
- WS `review.selection_changed` → invalidate（hook 单测 + 源码断言）。

**e2e（可选，PR 末评估）**
- `e2e/review-multidoc.spec.ts` 覆盖 S1（stub-opencode 返 `list<path<md>>` + 写 N 个 md → 逐篇采纳 → 同意 → 下游解锁）。

**门槛**：`bun run typecheck && bun run test && bun run format:check` 全绿；push 后按 [feedback_post_commit_ci_check] 立即查 CI（含 build smoke + Playwright）。

---

## 8. 风险与决策门（实现期必查）

1. **`createDocVersion` versionIndex 计算键**（高危）：必须把 itemIndex 纳入 max 计算键（§2.1），否则多 item 同 sourcePort versionIndex 互相污染。单文档用 `isNull(itemIndex)` 保原语义。
2. **`submitReviewDecision` 的 `.limit(1)`**（:1184）：单文档只取一行；多文档必须先判模式再去 limit、取全 N 行。误用会只决策一篇、其余永久 pending、task 卡死。
3. **乐观锁 `reviewIteration` 多文档语义**（:1171）：一个 review node_run 一个 `reviewIteration`，N 篇共享。逐篇 selection PATCH **不 bump**（走独立端点、不校验 iteration），只 round 级 approve/reject/iterate 才 bump。
4. **awaiting-refresh 重建循环**（:457-503）：stale-refresh supersede 全 N 篇是正确行为，但 refresh 后 createDocVersion 必须**循环重建 N 篇**而非 1 篇——漏循环会丢文档。
5. **provenance `consumedUpstreamRunsJson`**：多文档仍是**单个 list 上游 run**（非 fanout 多 shard），`{[sourceNodeId]: sourceRun.id}` 语义**正确不变**。须在文档写清，避免与「review in fanout」（N shard 各 run）混淆。
6. **空 list**：park 空 round + approve 空集，不引新短路。
7. **selection 列无 DB default**：单文档 NULL；多文档 dispatch 显式写 `'unselected'`，避免污染单文档查询。
8. **iterate 不回滚 vs reject 回滚**：`rollbackFilesOnIterate` 默认 false、`rollbackFilesOnReject` 默认 true（`schemas/review.ts:95-97` 现有默认）多文档直接继承；确保 iterate 分支不误调 `rollbackToSnapshot`（仅 reject 分支调，:1388）。

---

## 9. 考虑过但否决的方案（设计 rationale，保留历史）

**方案 A（早期草案，已否决）：新建 `curation` NodeKind + `selection_sets`/`selection_items` 两表 + `awaiting_selection` 状态，纯过滤门、不继承 review 副作用。**
否决理由：与用户最终意图冲突——用户要的是 review 全套体验（选词锚定 inline 评论 / iterate 回灌 / reject 回退）作用到多篇文档上，而非「只整篇 accept/reject 的纯过滤」。方案 A 要么丢失 inline 评论能力，要么把 review 的评论 / 回灌 / 回滚机制在新节点里重写一遍（大量重复 + 长期漂移）。改动面：新 NodeKind 6+ 处落点 + 2 新表 + 新状态 + schema bump + 一套新路由/UI。

**方案 B（本 RFC，采纳）：扩展 review 为多文档运行时模式。**
改动面：3 个 nullable 列 + 几处运行时分叉 + validator 放开 + 前端三栏分支。复用 review 全部机制，单文档零回归，无新 NodeKind / 表 / 状态 / schema bump。**显著更小、与现有评审体验天然一致。**

> 早期草案目录 `RFC-079-list-curation-gate` 已（在 commit 前）重命名为本目录 `RFC-079-review-multi-document`；curation 方案作为本节 rationale 保留，不另立 Superseded 文件。
