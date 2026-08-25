# RFC-326 技术设计 —— 评审门的 MCP / API 完整面（v4，三轮设计门后）

> 配套：[proposal.md](./proposal.md)（拍板 D1–D8、取舍 P1–P18、验收 AC-1…35、设计门记录 §8）、[plan.md](./plan.md)。
> 引用一律写成纯文本 `path:line`。凡两轮设计门指出的行号 / 错误码错位，本版已逐处改正。

## 0. 一句话

在 `modules/collaboration` 种下第一片 domain 纯函数——**把「引文 + 第几次 + 章节」解析成 RFC-005 复合锚点**——让两个既有写端点接受简化锚点与打包提交，把评审决策的全部持久状态收进一个数据库事务；网页高亮器改为按源文偏移映射（含 Shiki 代码块）；`mcp/tools.ts` 的 `GATE_TOOLS` 为 `/api/reviews/*` 的每条路由配上具名工具。零迁移、零新端点。

## 1. 落位与架构对齐（CLAUDE.md §RFC workflow 第 8 条）

| 触及                   | 今天在哪                                                                                                                                                       | RFC-294 目标位置                                                                                                          | 本 RFC 怎么做                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 评审锚点解析（新）     | —                                                                                                                                                              | `collaboration` 上下文（RFC-294 design `:552`：`SubmitReviewDecision` / `GetGateView` / `ListPendingGateSummaries` 归它） | **新建** `packages/backend/src/modules/collaboration/domain/reviewAnchor.ts`（零依赖纯函数，只 import `@agent-workflow/shared`）+ `public/queries.ts`（导出 `resolveReviewAnchor`）+ `public/types.ts`（请求 / 结果类型；只放字面量对象 / 联合 / 数组，无 `Record` / `unknown` / 函数类型——`rfc294-architecture-preflight` 与 `rfc317-module-boundary` 的 public 形状规则）。顶层只有 `domain` / `public`，满足 RFC-317 T24 形状守卫（`census.ts:55-65`）；`public/` 允许只放五个 exact 名字的子集（`census.ts:460-462`） |
| 字符串出现计数         | `services/review.ts:138-160`、`frontend/lib/review/anchor.ts:21-32`（自述「镜像后端」）、`components/prose/rehypeWrapAnchors.ts:188-195`（第三份，且重叠语义） | shared 通用纯函数（两端消费者、同一失败合同）                                                                             | **新建** `packages/shared/src/textOccurrences.ts`：`findAllOccurrences`（不变语义）+ `forEachOccurrence(haystack, needle, visit)`（单遍非重叠迭代，回调返回 `false` 可提前终止；解析器用它**一次扫描**同时完成精确计数、候选收集与目标定位）；三处改为 import / re-export                                                                                                                                                                                                                                                 |
| 评审应用服务           | `services/review.ts`（legacy 横向层，3.5k 行）                                                                                                                 | `modules/collaboration/application/`                                                                                      | 只在既有函数上加可选入参、前置校验与事务化；经 `@/modules/collaboration/public/queries` 引用解析器（`census.ts:263-269,308-310`：public 路径不是 R1 债务；裸 `@/modules/collaboration` 才是）；**不迁移**（§14 债务）                                                                                                                                                                                                                                                                                                     |
| 生命周期 / 铸行 / 成员 | `services/lifecycle.ts`、`services/nodeRunMint.ts`、`services/taskCollab.ts`                                                                                   | platform / task-execution engine                                                                                          | 补同步 `…Tx` 变体（`transitionNodeRunStatusTx`、`mintNodeRunTx`、`hasActingMembershipTx`），异步版本改为包装它们（§6.2 的守卫约束）                                                                                                                                                                                                                                                                                                                                                                                       |
| 成员端点               | `routes/tasks.ts:373-396` → `services/taskCollab.ts:224-339`                                                                                                   | —                                                                                                                         | `updateTaskMembers` 的临界区进 `withTaskReviewMutationLock(taskId)`（P13）                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MCP 工具表             | `packages/backend/src/mcp/tools.ts`（inbound adapter，经 `Dispatcher` 打路由表）                                                                               | `adapters/inbound/mcp/`                                                                                                   | 只加表项与逐工具审计解析器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 网页高亮               | `components/prose/{rehypeWrapAnchors.ts,Prose.tsx,CodeBlock.tsx}`、`components/review/ReviewDocPane.tsx`                                                       | —                                                                                                                         | 源文偏移模式（§9）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Wire 契约              | `packages/shared/src/schemas/review.ts`                                                                                                                        | 不变                                                                                                                      | 可选字段扩展 + 长度上限                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

不新增 cross-context import、不新增 facade；MCP 仍然「REST 的子集」（`tests/rfc247-mcp-server.test.ts` 头注释的三条主张继续成立）。

## 2. 锚点解析纯函数

### 2.1 类型（`modules/collaboration/public/types.ts`）

```ts
/** 调用方给的简化定位。三个字段全可选；全空 = 整篇级意见（锚到标题行）。 */
export interface ReviewAnchorRequest {
  quote?: string // 正文里逐字出现的一段文字（匹配前 trim；不做大小写 / 空白归一）。≤ 4000 字
  occurrence?: number // 1-based 全文序号（= 落库 occurrenceIndex = 候选编号 = 网页序号）
  section?: string // 标题文字（不含 #）、带 # 的单段（### Auth）或整串面包屑 `## A > ### B`；trim 后精确匹配。≤ 500 字
}

export interface ReviewAnchorCandidate {
  occurrence: number // 全文序号
  sectionPath: string
  offsetStart: number
  contextBefore: string // ≤ 30 字，仅提示
  contextAfter: string
}

/** not-found 时的近似建议：sourceText 是原文切片（供逐字复制），带位置。 */
export interface ReviewAnchorSuggestion {
  sourceText: string
  offsetStart: number
  sectionPath: string
}

export type ReviewAnchorErrorCode =
  | 'review-anchor-empty-document'
  | 'review-anchor-not-found'
  | 'review-anchor-ambiguous'
  | 'review-anchor-occurrence-out-of-range'
  | 'review-anchor-section-not-found'
  | 'review-anchor-occurrence-not-in-section'
  | 'review-anchor-crosses-heading'
  | 'review-anchor-budget-exceeded'

export type ReviewAnchorWarning =
  | 'quote-in-code-block'
  | 'quote-spans-blocks'
  | 'quote-has-no-rendered-projection'

export type ReviewAnchorResolution =
  | { ok: true; anchor: ReviewCommentAnchor; warnings: ReviewAnchorWarning[] }
  | {
      ok: false
      code: ReviewAnchorErrorCode
      message: string // 已含最多 10 条候选 / 建议的人类可读文本（主键在前，上下文在后）
      candidates: ReviewAnchorCandidate[] // 最多 50 条
      total: number // 精确总数（可能 > candidates.length）
      truncated: boolean
      suggestions: ReviewAnchorSuggestion[] // not-found 时最多 5 条，其余为空数组
    }

/** 同一请求内多条引文共用的文档模型（按篇缓存）；对调用方不透明。 */
export interface ReviewAnchorDocument {
  readonly body: string /* + 私有索引 */
}
```

`public/queries.ts` 导出：`buildReviewAnchorDocument(body): ReviewAnchorDocument`（一次线扫）与 `resolveReviewAnchor(doc, request, budget?): ReviewAnchorResolution`。返回值而不抛错；服务层把 `ok:false` 翻成 `ValidationError(code, message, { candidates, total, truncated, suggestions })`（422）。

### 2.2 文档模型（一次线扫，三处共用）

只做本函数需要的最小 markdown 结构，不引入 remark。`buildReviewAnchorDocument` 逐行扫描产出：

- `lines[]`：每行 `start` 偏移（按**原文**计算；切行用 `/\r?\n/`，行文字去尾 `\r`——偏移不能因规范化错位）。
- **围栏区间**：开启 `^ {0,3}(`{3,}|~{3,})`（记字符与长度），关闭须同字符、长度 ≥ 开启、缩进 ≤ 3；未闭合延伸到文末。围栏内的行不参与标题 / 块判定。
- **标题**：ATX——行首 0–3 空格后的 `#` 串**长度 1–6 且后接空白或行尾**（先验开头串，再单独剥去尾部可选的 `#` 串；`#######` / `####### x` 不是标题）；`# #` 这类去标记后为空的标题**仍是标题边界**但不做整篇级目标。Setext——上一行非空段落文字 + `^ {0,3}(=+|-+)[ \t]*$`（`=` 为 1 级、`-` 为 2 级；`-` 行若上一行为空则是分隔线）。引用块 / 列表内的 `#` 行**不**视为标题（近似）。
- **面包屑**：遇到 L 级标题时 `levels[L] = text` 并清空更深层；位置 P 的 `sectionPath` = P 之前（含 P 所在标题行本身）各层已设值按 `'#'.repeat(lvl) + ' ' + text` 用 `' > '`（带空格）连接。
- **顶层块**：块边界 = 空行 | 标题行 | 围栏开 / 闭 | 分隔线（`^ {0,3}([-*_][ \t]*){3,}$`）。块类型：`code` / `blockquote`（首行 `>`）/ `list`（首行 `^\s*([-*+]|\d+[.)])\s+`）/ `table`（首行 `|`）/ `hr` / `html`（首行 `<`）/ `paragraph`。
- **paragraphIdx**：最近一个前置标题之后、引文所在块之前的顶层块里，类型 ∈ {`paragraph`, `code`, `blockquote`} 的个数（其余计 0）；引文落在标题行上为 0；无任何标题时**首块不计**（对齐前端 `anchor.ts:76-109`）。
- **不渲染区间**：链接 / 图片目标 `](…)`、HTML 注释 `<!-- … -->`、链接引用定义行——用于 `quote-has-no-rendered-projection` 警告（网页 P18 会保持未定位）。
- 行首偏移有序数组 + 标题 / 围栏区间数组 ⇒ 任一偏移的 `sectionPath` / `paragraphIdx` / 是否在围栏 / 是否跨标题都用**二分**求得，命中数与文档长度解耦。

### 2.3 解析步骤

1. `doc.body.trim() === ''` ⇒ `review-anchor-empty-document`。
2. `quote` 缺省 ⇒ **整篇级**：目标 = 第一个去标记后非空的 ATX / Setext 标题的**源文文字**；无标题 ⇒ 第一个非空行（trim）。令 `quote` = 该文字，`occurrence` = 目标所在那一次出现的全文序号（按偏移相等取），跳到第 7 步。
3. 用 `forEachOccurrence(body, quote, …)` **一次**非重叠扫描：对每个命中 `(k, offset)`（k 为全文序号）二分求 `sectionPath` / `inSection`，同时维护 `total`（精确）、`candidates`（候选集合的前 50 条：给了 `section` 时只收章节内的，否则全部；存满只停止收集、不停止扫描）与**目标命中**（`occurrence` 指定的第 k 处，或候选集合恰为 1 时的那一处）——所以 `occurrence = 1001` 与「唯一命中在后部章节」都正确；累计扫描字符数计入 `budget`（默认 64 MiB / 请求），超出 ⇒ `review-anchor-budget-exceeded`。`total === 0` ⇒ `review-anchor-not-found`：`suggestions` = 最多 5 条按「大小写不敏感」或「空白折叠」命中的 `{ sourceText, offsetStart, sectionPath }`，message 附「匹配是精确的，请从 get_review 正文复制」。
4. 给了 `section` ⇒ `inSection(m) := section 等于面包屑任一段（去 # 前缀或不去）或整串`。无任何命中在章节内 ⇒ `review-anchor-section-not-found`，`candidates` 列各命中的 `sectionPath`（去重）。
5. 选择：给了 `occurrence` ⇒ 越界（`< 1` 或 `> total`）⇒ `review-anchor-occurrence-out-of-range`（message 带上限）；给了 `section` 且第 `occurrence` 处不在章节内 ⇒ `review-anchor-occurrence-not-in-section`（candidates = 章节内命中的全文序号）；否则选中。未给 `occurrence`：候选集 = 给了 `section` 时章节内的命中，否则全部；候选数 = 1 ⇒ 选中；> 1 ⇒ `review-anchor-ambiguous`（candidates 按全文序号，最多 50 条；`total` / `truncated` 如实）。
6. 跨标题：选中范围 `[start, end)` 内若含任一**标题行的行首**（用 §2.2 同一份扫描结果）⇒ `review-anchor-crosses-heading`。
7. 组装：`offsetStart = start`、`offsetEnd = start + quote.length`、`selectedText = quote`、`contextBefore = body.slice(max(0, start-30), start)`、`contextAfter = body.slice(end, end+30)`、`occurrenceIndex` = 全文序号、`sectionPath` / `paragraphIdx` 按 §2.2；`warnings`：与围栏相交 ⇒ `quote-in-code-block`；跨块边界 ⇒ `quote-spans-blocks`；整体落在不渲染区间 ⇒ `quote-has-no-rendered-projection`。

### 2.4 错误表（服务层映射，全部 422）

| code                                      | message 要点                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `review-anchor-empty-document`            | 文档没有正文可锚                                                                                                               |
| `review-anchor-not-found`                 | 引文不在正文里；逐条 `suggestion k · <sectionPath> · @offset · "sourceText"`；提示逐字复制                                     |
| `review-anchor-ambiguous`                 | 出现 N 次（truncated 时注明）；逐条 `occurrence k · <sectionPath> · @offset`，上下文只作提示；提示传 `occurrence` 或 `section` |
| `review-anchor-occurrence-out-of-range`   | 只有 N 处                                                                                                                      |
| `review-anchor-section-not-found`         | 列出可选章节                                                                                                                   |
| `review-anchor-occurrence-not-in-section` | 该章节内的全文序号是 …                                                                                                         |
| `review-anchor-crosses-heading`           | 引文跨越标题行                                                                                                                 |
| `review-anchor-budget-exceeded`           | 本次请求扫描预算用尽；缩短引文或减少条数                                                                                       |

MCP 侧 `toolError`（`mcp/server.ts:131-146`）只透传 message 并经 `redactErrorText`——`util/redact.ts` 的 `SENSITIVE_KV_RE` 会把 `token: string` 这类字段名改写成 `token=***`，所以**候选 / 建议以 `occurrence` / `sectionPath` / `offsetStart` 为主键**并排在前面，上下文与 `sourceText` 只是提示，message 尾注明「文本片段可能被脱敏，引文请从正文复制」；`details`（REST）保持原文。

### 2.5 与前端 DOM 算法的差异（只影响提示词与归档排序，不影响高亮）

`sectionPath` / `paragraphIdx` 只进 `renderCommentsForPrompt` 与 `commentsForDocVersion` 排序（`services/review.ts:1625-1645`）；网页高亮改用偏移（§9）：

- 前端 `computeSectionPath`（`anchor.ts:40-68`）每层取第一次遇到的标题，在「`## A` → `### A1` → `## B`」下得到 `## B > ### A1`；本函数按语义清空更深层，得到 `## B`。
- 前端标题文字取 `textContent`，本函数取源文；`section` 匹配按源文文字。
- 引用块 / 列表内的标题在网页里渲染成 `<hN>`，本函数不视为章节标题。

## 3. 锚点规范化（`services/review.ts:187-276,287-293`，P5）

`recomputeOccurrenceIndex` 新增**策略 0**：若 `offsets.includes(anchor.offsetStart)` 且该处 `body.slice(offsetStart, offsetEnd) === selectedText` 且上下文（非空侧）匹配 ⇒ 直接采信该出现。其后既有策略 1 / 2 / 3 不变（legacy 兼容路径，G2 已划界）。

`canonicalizeAnchor` 返回的锚点**同时**把 `offsetStart/End` 修正为所选出现的偏移，落库行从此自洽（`body.slice(offsetStart, offsetEnd) === selectedText` 且 `findAllOccurrences(...).indexOf(offsetStart) + 1 === occurrenceIndex` 恒成立）。

服务端解析的锚点（§2）**不经**重算：只做一致性断言（不成立 ⇒ 抛 `Error`，编程错误，500）。`AnchorValidationError extends ValidationError`（422，P6）；`findAllOccurrences` 改为从 `@agent-workflow/shared` re-export（导出名不变）。

## 4. Wire 契约（`packages/shared/src/schemas/review.ts`）

### 4.1 `POST /api/reviews/:nodeRunId/comments`

```ts
export const ReviewAnchorRequestSchema = z.object({
  quote: z.string().trim().min(1).max(4000).optional(),
  occurrence: z.number().int().positive().optional(),
  section: z.string().trim().min(1).max(500).optional(),
})
export const SubmitReviewCommentSchema = z
  .object({
    commentText: z.string().min(1).max(50_000),
    docVersionId: z.string().optional(),
    anchor: ReviewCommentAnchorSchema.optional(),      // 网页路径，不变
    quote / occurrence / section                       // 扁平化的 ReviewAnchorRequestSchema 字段
  })
  .refine(anchor 与 quote/occurrence/section 不同时出现)
  .refine(无 quote 时不得带 occurrence / section)      // P9
export const ReviewCommentCreatedSchema = ReviewCommentSchema.extend({ warnings: z.array(z.enum([...])) })
```

老客户端只传 `anchor` ⇒ 行为不变（除 §3 的偏移修正）。

### 4.2 `POST /api/reviews/:nodeRunId/decision`

```ts
export const ReviewBatchSelectionSchema = z.object({
  docVersionId: z.string().min(1),
  selection: z.enum(['accepted', 'not_accepted']),
})
export const SubmitReviewDecisionSchema = z.object({
  decision, rejectReason?, reviewIteration,                       // 不变
  comments: z.array(SubmitReviewCommentSchema).max(200).optional(),
  selections: z.array(ReviewBatchSelectionSchema).max(500).optional(),
}).refine(rejected ⇒ rejectReason 非空)
  .refine(selections 的 docVersionId 不重复)                       // 重复 ⇒ 422，零效果
export const SubmitReviewDecisionResponseSchema = z.object({
  ok: z.literal(true), taskId, reviewIteration, resumeRequired,
  commentsAdded, commentsSkippedAsDuplicate, selectionsApplied,   // int
  resume: … 可选（不变）
})
```

### 4.3 Body 上限（P10）

把 `routes/resourcePackages.ts:80-113` 那段「`Content-Length` 存在且无 `transfer-encoding` 时：畸形 / 非安全整数 / 超限 ⇒ 413；合法则**删掉该头**再交给 Hono `bodyLimit` 按真实字节计数」的包装抽成 `routes/verifiedBodyLimit.ts`（`verifiedBodyLimit({ maxSize, onError })`），两个写路由作为额外 handler 传给 `registerRoute`（`routes/registry.ts:218-226` 接受 `...handlers`；不能用 `app.use` 精确路径，会触发 `rfc317-route-gate-exemptions`）。`resourcePackages.ts` 改为消费同一个包装（顺手收敛）。

## 5. `addReviewComment`（`services/review.ts:1934-1995`）

`AddReviewCommentArgs`：保留 `anchor?: ReviewCommentAnchor`，新增 `anchorRequest?: ReviewAnchorRequest`，**恰好一个**（都缺 / 都有 ⇒ 编程错误抛 `Error`）；既有测试调用点不变（P16）。`addReviewCommentUnlocked`：

1. `assertReviewRoundWritable`（不变）。
2. 取本 run 全部 pending 行；`mode = resolveReviewRoundMode(rows)`（`:1195-1203`）。`mode !== 'single'` 且缺 `docVersionId` ⇒ `ValidationError('review-doc-version-required')`（含单篇轮）；给了 `docVersionId` 但不在 pending 行里 ⇒ `NotFoundError('doc-version-not-found')`（与 `setDocumentSelectionUnlocked:2890-2895` 同码）。
3. 读正文；`anchorRequest` ⇒ `buildReviewAnchorDocument` + `resolveReviewAnchor`，`ok:false` ⇒ `ValidationError(code, message, details)`；`anchor` ⇒ `canonicalizeAnchor`（§3）。
4. 插行 + `emitReviewCommentAddedEvent`（`:3410-3423`，`task:${taskId}` 频道）不变；返回值附 `warnings`。

## 6. 决策路径事务化（D6；`submitReviewDecision`，`:2370-2375` 外壳 / `:2378-2857` 主体）

### 6.1 四段式

```
withReviewNodeMutationLock(nodeRunId) →
  ┌ 准备段（异步可用，只读 + 纯计算 + 文件读取；任何失败零写入、零外部效果）
  │  run / task（含 ownerUserId、sourceTerminationFence）/ pending 行 / 迭代号 / 状态 / 多文档模式；policy；
  │  预检 A（外部效果前的短读）：run 仍 awaiting_review；reviewIteration 未变；task 非 done/canceled；
  │      actor 给出时 hasActingMembership + resolveTaskRole ⇒ 否则 403 not-task-member；
  │      RFC-303 围栏：目标状态（pending / done）在 sourceTerminationFence 下可进入 ⇒ 否则 409 task-source-terminal-*（用 lifecycle.ts **导出**的纯判据 `assertNodeRunSourceTerminationAdmission`——今天是私有函数 `:65-75`，本 RFC 导出它，prepare 与 `…Tx` 原语共用同一份，不复制判据）；
  │  批：selections 逐条校验目标（本 run、pending、itemIndex 非空、未决）；
  │      comments 逐条定位目标篇、按篇缓存文档模型、resolveReviewAnchor / canonicalizeAnchor；
  │      effectiveDvs = 现有 pending 行叠加批 selections（selection、selectionStale=false）——
  │      多文档模式判定、allDocumentsDecided 预判、采纳子集（indices / bodies / paths / archive / meta）**全部只读 effectiveDvs**；
  │  approve：读 approved_doc 正文 / 采纳正文（FS）、upstreamPortArchiveJson（DB 读）、组装两份输出 payload；
  │  reject / iterate：解析 workflowSnapshot、找 review 节点、rerun 集、各上游 pickFreshestRun、nextRetryIndex、
  │      级联判定（iterateSiblingCascadeApplies）、兄弟行与其 pending 版本；预铸 buildMintNodeRunValues（id / nonce 在此确定）。
  ├ 外部效果段（仅 reject / iterate 且 rollbackFlag）：
  │  getTaskWriteSem(taskId).run(rollbackNodeRunWorktrees(...)) → rolledBack 结果表。
  ├ 事务段 dbTxSync(db, tx => { … })（同步；bun:sqlite 单连接，事务内无并发交错）
  │  0. 再读 run / task：状态、迭代号、终态、围栏与预检 A 相同；actor 给出时 hasActingMembershipTx + resolveTaskRole；
  │  1. selections：逐条 update docVersions(selection, selectionStale=false) WHERE id AND reviewNodeRunId AND decision='pending' AND itemIndex IS NOT NULL；
  │     `.run().changes === 0` ⇒ 409 review-doc-decided；
  │  2. comments：逐条 insert reviewComments；去重键 (docVersionId, offsetStart, offsetEnd, selectedText, commentText) 命中既有 live 行 ⇒ 跳过并计数；
  │  3. 归档：逐篇 tx.select 该篇 live 意见（含刚插入的，排序同 commentsForDocVersion）→ update docVersions(decision / decisionReason /
  │     decidedAt / decidedBy(Role) / commentsJson) WHERE decision='pending' → 0 行 ⇒ 409 review-decision-conflict；delete reviewComments；
  │  4a. approved：upsert nodeRunOutputs ×2（payload 来自准备段的 effectiveDvs）；transitionNodeRunStatusTx(approve-review, finishedAt)；
  │  4b. reject / iterate：对每个 rerun 上游：setNodeRunStatusTx(canceled, marker, rolledBack, supersededByReview…) + mintNodeRunTx(tx, 预铸值)；
  │      级联：兄弟 pending 版本 update 为 rejected(system) + setNodeRunStatusTx(pending, reviewIteration+1)；
  │      自身 transitionNodeRunStatusTx(iterate-review | reject-review, reviewIteration = next)。
  └ 提交后效果段
     emitReviewSelectionChanged ×n、emitReviewCommentAddedEvent ×n、emitReviewDecisionEvent；
     enqueueDistillJob（best-effort、吞错，N10 / P14——它自带 `memory_distill_jobs` 写入与 `distill.queued` 广播）；返回结果（含计数）。路由层照旧 resumeTask。
```

事务段是评审持久状态**唯一**的提交点：`doc_versions` / `review_comments` / `node_runs` / `node_run_outputs` / merge state（`abandonSupersededMergeStates`）都在其中；蒸馏行是第二笔独立写入（今天亦然）。

### 6.2 新增 / 改动的原语与守卫约束

| 原语                                                         | 位置                                                        | 说明                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transitionNodeRunStatusTx({ tx, nodeRunId, event, extra })` | `services/lifecycle.ts`（`transitionNodeRunStatus:133` 旁） | 同一张 RFC-053 转移表的同步版本；**异步版改为 `dbTxSync(db, tx => transitionNodeRunStatusTx(...))` 的纯包装、自身不再直写**——`tests/lifecycle-grep-guard.test.ts:146-172` 把 `services/lifecycle.ts` 的 `node_runs.status` 直写钉在 `KERNEL_DIRECT_WRITES = 3`，新增写点必须带 `rfc053-allow-direct-status-write` 标记（5 行内）且总数不变；内核注释（`:163-166`）同步改写                |
| `mintNodeRunTx(tx, args)`                                    | `services/nodeRunMint.ts:253` 旁                            | 把 `mintNodeRun` 事务体抽出：`abandonSupersededMergeStates({ db: tx, … })`（已接受 `DbTxSync`，`lifecycle.ts:946-997`）+ `tx.insert(nodeRuns).values(values).run()`；异步版包装它。**不新增 `.transaction(` 调用站点**（`scheduler-audit-s10-async-transaction-decorative.test.ts:177-214` 的 `RAW_TRANSACTION_SITES` 精确账本）                                                          |
| `hasActingMembershipTx(tx, taskId, userId)`                  | `services/taskCollab.ts:101` 旁                             | 同一条查询的 `.all()` 版本；`resolveTaskRole`（`services/resourceAcl.ts:671-680`）已是纯函数，需要 `tasks.ownerUserId`                                                                                                                                                                                                                                                                    |
| `updateTaskMembers` 进锁                                     | `services/taskCollab.ts:224-339`                            | 锁边界精确到：**锁内**——重读 task 行（取新鲜的 `ownerUserId`，不用路由排队前的快照）、重新授权、计算 `prevOwner`、既有 `dbTxSync`、捕获广播受众快照；**锁外**——`triggerRevalidationAndWait` 与广播（`taskCollab.ts:325-339`）。路由仍先读 task 做 404，但授权以锁内重读为准。锁是非重入 FIFO（`reviewMutationCoordinator.ts:28-46`），生产代码里没有已持锁再调 `updateTaskMembers` 的路径 |
| `SubmitReviewDecisionArgs`                                   | `services/review.ts:2242`                                   | 增 `actor?: Actor`（P16 契约：缺省 = 受信内部调用方，跳过成员复验；路由必传，测试锁住）、`comments?`、`selections?`                                                                                                                                                                                                                                                                       |
| `verifiedBodyLimit`                                          | `routes/verifiedBodyLimit.ts`（新）                         | §4.3                                                                                                                                                                                                                                                                                                                                                                                      |

### 6.3 回滚为什么在事务前，以及诚实的残留形态

`rolledBack` 要写进被取消行的 `rolled_back` 列与 marker 后缀（`:2718-2760`），它是回滚的**结果**；放事务后就得再补一笔更新，而且回滚失败时行已写着 `-rollback`；放事务后还会与 `resumeTask` 的实时调度竞争工作树写锁（`routes/reviews.ts:314-318` 的 RFC-092 路径会立即派发新铸的 pending 行）。所以回滚在事务前，但**只在预检 A 全部通过之后**（P13）——撤权 / 围栏 / 迭代号 / 终态都拦在任何 git 操作之前。

**残留形态（与今天不同，如实记录）**：今天归档先于回滚，中途失败 ⇒ 文档已 `iterated` 而 run 仍 awaiting，后续只能重发同一决策；本设计回滚先于事务，事务失败 ⇒ 工作树已回到上游 `preSnapshot`、文档仍 `pending`。若此时改为 **approve** 一个 `path<md>` 文档，发布的是工作树路径（`:2560-2564`），下游读到的是回滚后的内容。修复路径：**重发 iterate / reject**（回滚幂等）。这条写进 §12 与工具描述，并由 AC-17「回滚后事务抛错」用例锁住形态。

### 6.4 并发

- 评审互斥锁（按 task FIFO）仍在最外层：同任务的 add / update / delete / selection / decision / cancel（`task.ts:3780`、`scheduler.ts:9949`、`applySourceTerminationEffect.ts:75`）以及**成员变更**（P13）串行。
- 事务第 0 步的再读把「锁外发生的并发决策」收进提交点；成员变更进锁后，US9 的两种顺序都有明确线性化点，不存在「已回滚再 403」。
- `resumeTask` 仍由路由在返回后调用（`routes/reviews.ts:299-330` 的分类吞错不变）；取消的终态钩子 `sealOpenHumanGatesForTask` 在同一把锁下运行（`lifecycle.ts:675-685` → `terminalSweep.ts:61-145`），不触碰 `doc_versions`。

## 7. 路由层（`routes/reviews.ts`）——零新端点

- `POST /comments`：新 schema；`anchor` 存在 ⇒ 传 `anchor`，否则 `anchorRequest: { quote, occurrence, section }`。
- `POST /decision`：透传 `comments` / `selections` 与 `actor`。
- 两条路由挂 `verifiedBodyLimit`。其余 **9** 条路由零改动；`RouteMeta` 全部不变，`tests/contracts/registry.ts:749-761`（11 条 review 条目，无 body fixture）、`architecture/e2e-endpoint-coverage.json` 不需要动。

## 8. MCP 工具（`mcp/tools.ts` `GATE_TOOLS`）

| 工具                                  | 档              | 入参                                                                        | 分发                                                            | 审计                   | 描述要点（英文，> 40 字）                                                                                                                     |
| ------------------------------------- | --------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_pending_gates`                  | 读              | —                                                                           | 不变                                                            | `{kind:'human-gates'}` | 不变                                                                                                                                          |
| `list_reviews`（新）                  | 读              | `status?` `taskId?` `workflowId?` `limit?`                                  | `GET /api/reviews`                                              | `{kind:'reviews'}`     | 找某任务 / 工作流的评审，含已决                                                                                                               |
| `get_review`                          | 读              | `nodeRunId`                                                                 | `GET /api/reviews/:id`                                          | `{kind:'reviews', id}` | 多文档时 `currentBody` 只是第一篇，其余用 `get_review_document`；`reviewIteration` 要回传                                                     |
| `get_review_document`（新）           | 读              | `nodeRunId` `docVersionId`                                                  | `GET …/versions/:vid`                                           | `{kind:'reviews', id}` | 任一篇 / 任一历史版本的正文 + 当时意见                                                                                                        |
| `list_review_history`（新）           | 读              | `nodeRunId`                                                                 | `GET …/versions` + `GET …/rounds` 合并为 `{ versions, rounds }` | `{kind:'reviews', id}` | 历史版本与多文档轮次                                                                                                                          |
| `add_review_comment`（新）            | `tasks:execute` | `nodeRunId` `commentText` `quote?` `occurrence?` `section?` `docVersionId?` | `POST …/comments`                                               | `{kind:'reviews', id}` | 引文逐字复制（可含标记）；无引文 = 整篇级；歧义时错误里给候选（全文序号）；多文档必须带 `docVersionId`；落在链接目标 / 注释里的引文网页不高亮 |
| `update_review_comment`（新）         | `tasks:execute` | `nodeRunId` `commentId` `commentText`                                       | `PATCH …/comments/:cid`                                         | 同上                   | 只能改自己的（owner / bypass 例外）                                                                                                           |
| `delete_review_comment`（新）         | `tasks:execute` | `nodeRunId` `commentId`                                                     | `DELETE …/comments/:cid`                                        | 同上                   | 同上                                                                                                                                          |
| `set_review_document_selection`（新） | `tasks:execute` | `nodeRunId` `docVersionId` `selection`                                      | `PATCH …/documents/:vid/selection`                              | 同上                   | 多文档专用；不推进任务                                                                                                                        |
| `submit_review`                       | `tasks:execute` | 既有 + `comments?[]` `selections?[]`；`decision: ReviewDecisionKindSchema`  | `POST …/decision`                                               | 同上                   | 打包语义：任一无效整体拒绝、全部在一个事务里；多文档 approve 要求全部采纳已定；`rejected` 需 `rejectReason`；事务失败后请重发**同一**决策     |

实现细节：

- 所有 id 经 `enc()`（`tools.ts:63-77`）编码（AC-27）。
- `McpToolDef` 增可选 `audit?: (args) => { kind: string; id?: string }`；`mcp/server.ts:84-100` 两处 `audit?.(…)` 改为优先取 `tool.audit?.(args)`（P7）。
- `submit_review` 入参用 `satisfies Record<keyof z.input<typeof SubmitReviewDecisionSchema>, ZodTypeAny>`（**required** `Record`）。
- `GET /api/reviews/pending-count` 进守卫的 `EXEMPT_REVIEW_ROUTES`（P11；命中 `rfc317-ledger-highwater.test.ts:301` 的账本命名规则，同批进 `ledger-baselines.json`）。
- 未授权工具不注册（`server.ts:43-50`，D8）：硬调 ⇒ SDK JSON-RPC 错误 `Tool <name> not found`；`describe_capabilities.toolsUnavailable` 列缺点。
- `describe_capabilities` / `toolsFor` / `GET /api/docs/api` 零改动自动覆盖新工具（`services/apiDocs.ts:101`）。

## 9. 网页高亮的偏移模式（D5）

### 9.1 前提（2026-08-25 用本仓 react-markdown 10.1.0 的同一条插件链实测 + 源码依据）

`mdast-util-to-hast/lib/state.js:327-338` 把 mdast 节点的 `position` 复制到 hast；文本节点由此带源文 `position.start.offset / end.offset`：段落、标题、行内代码（`handlers/inline-code.js:17-30`，节点区间**含反引号**、值不含）、转义（`order\_status` → 值 `order_status`）、实体（`&amp;` → `&`，`mdast-util-from-markdown` 解码进同一文本节点）、表格单元、列表项、引用块内文字、GFM 自动链接均有。**无位置**：围栏代码文字（`handlers/code.js:29-48`）、KaTeX 输出（`rehype-katex/lib/index.js:133`）、段间 `\n`、autolink 的 `#`、硬换行 `\n`、脚注引用 / `↩`、任务列表分隔、**GitHub alert 多行首段**（`remark-github-blockquote-alert/lib/index.js:25-29,55-63`）。react-markdown 每次渲染新建 processor 且不剥离位置（`lib/index.js:176-178,270-272`）。

### 9.2 数据流

- `AnchorWrapInput` 增 `offsetStart` / `offsetEnd`（`rehypeWrapAnchors.ts:32-39`）；`ReviewDocPane.tsx:212-220` 的 `proseAnchors` 一并投影这两个字段并传 `mode: 'source-offset'`；`Prose` 把 `body` 作为 `sourceBody` 传给插件，插件 memo 依赖改为 `[anchors, body]`（`Prose.tsx:67-105`），`Prose` 外包 `React.memo`。
- 非评审调用方（`anchors` 缺省 / 空）零改动：插件仍只在 `anchors.length > 0` 时挂载（`prose-anchors-prop.test.tsx:22-30` 的 byte-identical 锁继续成立）。
- `MarkdownDiffView.tsx:88-98` 直接调用插件的上一版路径显式 `mode: 'text'`（merged 文档 ≠ 锚定源），`strictOccurrence` / `excludeClasses` / `tableGuard` 语义不变。

### 9.3 算法（`mode: 'source-offset'`）

1. **自洽判据（P17）**：`consistent := body.slice(offsetStart, offsetEnd) === selectedText && findAllOccurrences(body, selectedText).indexOf(offsetStart) + 1 === occurrenceIndex`；只满足前半 ⇒ 取第 `occurrenceIndex` 次出现的偏移作为范围（服务端规范化是权威）；前半都不满足（selectedText 不在源文）⇒ 文本模式。序号核对只扫描到 `offsetStart` 为止（native `indexOf` 循环，按 `(body, selectedText)` 记忆化）；服务端已保证新行自洽，这一步只对 legacy 行真正生效。
2. **一次建索引**（每个 body / 每次渲染一次，不按锚点重复）：收集带位置的文本节点段 `{node, srcStart, srcEnd, valueToSrc}`，按 `srcStart` 排序；对每段用**分词感知的单调对齐**求 `valueToSrc[i]`（值第 i 个字符对应的源偏移）：同时走 `src = body.slice(srcStart, srcEnd)` 与 `value`——字符相等则同进；`src` 处于反引号 / `\` 转义 / 实体（`&name;` / `&#n;` / `&#xh;`：命名实体用 `decode-named-character-reference`——它今天只是 react-markdown 的传递依赖，bun 隔离布局下前端包解析不到，**本 RFC 把它加进 `packages/frontend/package.json` 直接依赖**；数值实体自行解码）时把整个记号作为一个单元消费并与解码后的值字符配对；其余不等 ⇒ 记该值字符为**未映射**并只进 `src`。对齐结束后 `value` 仍有未映射尾巴 ⇒ 这些字符不参与高亮（**绝不整段包裹**）。
3. **投影**：每个锚点按 `[offsetStart, offsetEnd)` 二分找相交段，在 `valueToSrc` 上求 `[from, to)`，跨段自然产生多个 `<mark>`（既有能力）。
4. **无相交带位置片段**时：
   - 范围落在 §2.2 的不渲染区间（链接目标 / HTML 注释 / 引用定义）⇒ **保持未定位**（P18），侧栏照常显示；
   - 范围落在围栏代码（`code` 元素的位置区间包含它）⇒ 把相对代码内容的 `{start, end, commentId}` 写进 `<code>` 的 `properties['data-anchor-ranges']`（JSON），由 §9.4 渲染；
   - 范围落在 KaTeX 输出（`.katex` 子树）⇒ **保持未定位**（公式不高亮，G5）——KaTeX 输出带 1px 裁切的 `<annotation>` 原始 TeX，窗口匹配会命中这段隐藏文本；
   - 其它无位置**可见**节点（alert 首段 / 脚注 / 硬换行）⇒ 只在**相邻两个带位置片段之间**的渲染文本窗口内做非重叠文本匹配；窗口内无命中 ⇒ 未定位。
5. **文本模式**（历史锚点 selectedText 不在源文、或显式 `mode:'text'`）：既有匹配逻辑，计数改用 shared `findAllOccurrences`（非重叠，C4）。

### 9.4 围栏代码块（P15）

`makeCode`（`CodeBlock.tsx:36-68`）在扁平化前读取 `rest['data-anchor-ranges']`：

- 范围先归一化为**互不交叉的原子段**（交叉的 `[a,b)` / `[c,d)` 拆成 `[a,c) [c,b) [b,d)`，包含关系保留为嵌套），每段 `data-comment-id` = 起点最早的意见、`data-comment-ids` = 全部覆盖它的意见——Shiki 4 对交叉范围抛 `intersect`（`@shikijs/core/dist/index.mjs:313-328`）；纯文本回退用同一份原子段。
- `ShikiPre`：`hl.codeToHtml(source, { …, decorations: segments.map(r => ({ start: r.start, end: r.end, tagName: 'mark', properties: { class: 'comment-anchor', 'data-comment-id': r.commentId } })) })`（Shiki 4.0.2 `@shikijs/types/dist/index.d.mts:99-115`）；范围先按 `source.replace(/\n$/, '')` 修剪并裁到边界内；`useEffect` 依赖加入 ranges 的稳定序列化。
- 纯文本回退（不支持的语言 / 高亮未就绪）：按范围切片渲染 `<mark>` 子节点而不是单一字符串。
- mermaid / plantuml：不高亮（图表）。
- 侧栏 / 滚动联动按 `data-comment-id` 查找 `mark`，对 Shiki 输出同样成立。

### 9.5 复杂度

索引每次渲染建一次 O(渲染文本长度)；每锚点投影 O(log 段数 + 覆盖字符数)。1 MiB 单段正文 + 200 锚点 ≈ 一次 1 MiB 对齐 + 200 次二分，与 markdown 解析同量级；P17 的序号核对是 O(Σ offsetStart) 的原生 `indexOf` 扫描（按 `(body, selectedText)` 记忆化）。T17 用桩计数锁机制（不断言墙钟）：对齐只跑一次；对 body 的出现扫描次数 ≤ 锚点数且每次止于该锚点的 `offsetStart`。

## 10. 数据流

```
本地 Claude Code / opencode（PAT）
   │ tools/call submit_review {nodeRunId, decision:'iterated', reviewIteration, comments:[…], selections:[…]}
   ▼
POST /api/mcp ─ buildMcpServer ─ tool.handler ─ Dispatcher（AsyncLocalStorage 注入 actor）
   ▼
POST /api/reviews/:id/decision（routeMetaGate: tasks:execute → ensureReviewMember → verifiedBodyLimit → schema）
   ▼
submitReviewDecision（评审互斥锁）
   准备段：预检 A + resolveReviewAnchor（collaboration domain）+ effectiveDvs + 输出 payload + 预铸行
   外部段：工作树回滚（仅 reject/iterate + rollbackFlag）
   事务段：dbTxSync —— 再检 / selections / comments / 归档 / 输出 / 状态 CAS / 铸行 / 级联
   提交后：WS（task:${taskId}）事件 → 网页评审页实时刷新；distill 入队（独立写入）
   ▼
路由 resumeTask（不变）→ 上游重跑，提示词含全部意见
```

## 11. 耦合点与不变量

- **单一授权面**：工具不碰 `services/*`，只分发到路由；新工具无例外。
- **作答权**：路由 `ensureReviewMember` + 预检 A + 事务内复验；非成员 ⇒ 403 `not-task-member`（`services/taskCollab.ts:135-138`）；成员变更与评审写入同锁。
- **乐观锁**：`reviewIteration` 仍是决策的并发护栏；事务内再读一次。
- **提示词回灌**：`renderCommentsForPrompt` 不变。
- **生命周期守卫**：`lifecycle.ts` 直写计数不变（§6.2）；s10 事务站点账本不变。
- **RFC-247 守卫**：`rfc247-mcp-server.test.ts:317-378` 自动覆盖新工具。
- **RFC-317 守卫**：模块形状 / R1 / R2 对 `modules/collaboration` 成立；新守卫进 `guard-manifest.json`；`EXEMPT_REVIEW_ROUTES` 进 `ledger-baselines.json`。

## 12. 失败模式

| 场景                                                                                                                         | 行为                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 引文不存在 / 歧义 / 越界 / 不在章节 / 跨标题 / 空文档 / 预算用尽                                                             | 422 + 候选 / 建议（§2.4）；MCP 文本含主键                                                       |
| 多文档省略 `docVersionId`                                                                                                    | 422 `review-doc-version-required`（C1）                                                         |
| `docVersionId` 非本 run pending 成员                                                                                         | 404 `doc-version-not-found`                                                                     |
| 打包中第 k 条意见无效                                                                                                        | 422，`details.index = k`，零写入（准备段）                                                      |
| 打包 selection 指向非本 run / 已决 / 单文档                                                                                  | 404 `doc-version-not-found` / 409 `review-doc-decided` / 409 `review-not-multi-doc`，零写入     |
| 多文档 approve 采纳不齐（按 effectiveDvs 预判）                                                                              | 409 `review-selection-incomplete`，零写入                                                       |
| 迭代号过期 / run 非 awaiting / 任务 done·canceled                                                                            | 409 `review-iteration-mismatch` / `review-not-awaiting` / `task-terminal`，零写入、零外部效果   |
| RFC-303 围栏关闭                                                                                                             | 409 `task-source-terminal-closed` / `task-source-terminal-merged`（预检 A），零写入、零外部效果 |
| 撤权                                                                                                                         | 预检 A 或事务第 0 步 403 `not-task-member`；成员变更与决策同锁，不存在「已回滚再 403」          |
| 准备段确定性失败（`workflow-snapshot-corrupt` 422、`review-node-missing-from-snapshot` 422、`doc-version-body-missing` 404） | 零写入、零外部效果                                                                              |
| 事务段失败（I/O、并发决策 `review-decision-conflict` 409）                                                                   | 全部回滚；若已回滚工作树则保持回滚态（§6.3 残留），重发同一决策                                 |
| 蒸馏入队失败                                                                                                                 | 决策已提交、成功返回；日志 warn（今天亦然）                                                     |
| 令牌只读                                                                                                                     | 写工具不在 `tools/list`；硬调 ⇒ SDK unknown-tool                                                |
| 请求体超 1 MiB（含低报 / 畸形 `Content-Length`）/ 字段超限                                                                   | 413 / 422                                                                                       |

## 13. 测试策略（CLAUDE.md §Test-with-every-change；全部随实现同批落地）

| 文件                                                                                                                           | 锁什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/tests/text-occurrences.test.ts`（新）                                                                         | 非重叠计数、空 needle、CJK；`forEachOccurrence` 的单遍迭代与提前终止                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/backend/tests/rfc326-review-anchor-domain.test.ts`（新；**不放** `tests/architecture/`，那里的每个文件都是登记守卫） | AC-1…AC-8：唯一命中 / 歧义候选（全文序号、截断 + 精确 total）/ occurrence 校验（含单次越界；`occurrence = 1001` 成功；唯一命中在后部章节时 `section` 命中）/ section 三种错误 / not-found 结构化建议 / 跨标题 / 空文档 / 整篇级（ATX、Setext、含标记标题、标题文字先出现在段落里、`# #` 跳过、无标题）/ 四反引号嵌套围栏 / `~~~` / 未闭合围栏 / 缩进与 tab 与尾 `#` 的 ATX / `#######` 非标题 / 引用块内 `#` 不算标题 / CRLF / 面包屑清层 / paragraphIdx 各块类 / 上下文截断 / 三种 warnings / 1 MB 单字引文的截断与预算 / 同请求 200 条共用文档模型（桩计数建模一次） |
| `packages/backend/tests/rfc326-anchor-canonicalize.test.ts`（新）                                                              | AC-9 / AC-10：策略 0；偏移修正；设计门 F2 周期性表格用例；服务端锚点不一致 ⇒ 500                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/backend/tests/rfc326-review-comment-simplified-anchor.test.ts`（新）                                                 | AC-11 / 12 / 13 / 16：双形态互斥、长度上限、413（诚实超限 / 低报 / 畸形 / chunked）、多文档必填（含单篇轮）、404、422、`warnings`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/backend/tests/rfc326-review-decision-batch.test.ts`（新）                                                            | AC-14 / 15：打包 iterate 提示词含全部意见；从全部 `unselected` 起步的 selections + approved 输出两行逐字等于打包后子集、stale 清零；重复 `docVersionId` 的 selections ⇒ 422 零效果；每类校验失败后**六表 dump + WS 事件计数**与调用前逐字节相等                                                                                                                                                                                                                                                                                                                        |
| `packages/backend/tests/rfc326-review-decision-transaction.test.ts`（新）                                                      | AC-17 / 18 / 19 / 20：事务计数桩恰好一次；蒸馏桩抛错决策仍成功；归档后注入失败 / 事务内抛错 / 回滚后抛错 ⇒ 六表回滚、事件 0；`…Tx` 与异步版对全部受影响行（含退役 merge state）与错误码等价；`rollbackFlag=true` 的撤权竞态两种顺序（工作树逐字节未动）；来源围栏关闭 + `rollbackFlag=true` ⇒ 回滚桩未被调用；`updateTaskMembers`：排队中携带旧 owner 的请求在锁内重读后被拒、WS 重验在锁释放后才开始；既有 `review-decision-full-asserts` / `review-multidoc*` / `review-iterate-*` / `review-refresh-supersede` / `review-cancel-concurrency` 全绿（重构等价）       |
| `packages/backend/tests/rfc326-tx-primitives-equivalence.test.ts`（新）                                                        | T7 三个 `…Tx` 原语与异步版等价；`lifecycle-grep-guard` / s10 账本数字不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/backend/tests/rfc326-mcp-review-tools.test.ts`（新）                                                                 | AC-21 / 22 / 23 / 24 / 25 / 27：工具表与档；逐工具真实分发（`createDispatcher` + RFC-005 stub 夹具；`submit_review` 三种决策各一例且携带 comments + selections）；只读令牌 `tools/list` 不含写工具、硬调 unknown-tool；ambiguous 与 not-found 脱敏后文本含主键；三类 id 的 `../` 编码；审计三种形态；路由传 `actor` 的锁                                                                                                                                                                                                                                               |
| `packages/backend/tests/architecture/rfc326-review-tool-route-guard.test.ts`（新，进 `guard-manifest.json`）                   | AC-23 反向 / AC-31：`allRouteMeta()` 的 `/api/reviews*` ⟷ `GATE_TOOLS` 分发路径双向相等（`EXEMPT_REVIEW_ROUTES` 显式）；negative fixture；AC-34 的 RFC-247 plan 标注 grep                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/backend/tests/architecture/rfc317-module-boundary.test.ts`（沿用）                                                   | AC-33                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/backend/tests/rfc247-api-docs.test.ts`、`rfc247-token-audit.test.ts`（改）                                           | AC-26 / AC-25                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/backend/tests/architecture/rfc319-capability-ledger.test.ts`（改）                                                   | `total === rows.length` + findings 行必填键 / 枚举校验                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/frontend/tests/rehype-wrap-anchors-offset.test.tsx`（新）                                                            | AC-28 / 29：用真实 `Prose`（同 §9.1 插件链）——行内代码 / 转义 / 七种实体 / 跨节点 / 跨段 / 含标记标题 / 存量行按序号 / 链接目标与 HTML 注释保持未定位 / alert 首段窗口回退 / 围栏代码（`await` Shiki 完成后的最终 DOM 与纯文本回退；交叉 / 包含 / 相邻 / 跨行四种范围）/ 公式范围零 `<mark>` 且侧栏条目仍在 / mermaid 无 / 非重叠计数 / diff 视图文本模式不变 / `ReviewDocPane` 意见不变换正文后高亮更新 / 对齐只跑一次                                                                                                                                                |
| `packages/frontend/tests/*anchor*`（沿用）                                                                                     | `findAllOccurrences` 改 re-export 后照跑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `e2e/rfc326-mcp-review-tools.spec.ts`（新，PR 档）                                                                             | AC-30 / 32：真实 daemon + `POST /api/auth/pats` + JSON-RPC 打 `POST /api/mcp`：US1、US2、US3（含坏引文零写入）、US6、US8（标题 / 反引号 / 代码块三处 `mark` 位置）                                                                                                                                                                                                                                                                                                                                                                                                     |
| `architecture/e2e-capability-ledger.json` + RFC-319 `findings.json` + `findings.md` + `e2e-endpoint-coverage.json`（改）       | 新能力行按各自 schema + `total`；e2e 命中的 `uncovered` 端点同批销账                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

变异实证（`docs/dev-gotchas.md` §结构守卫必做变异实证）：①解析器 `occurrenceIndex` 改成过滤后序号 → AC-2 红；②策略 0 去掉 → F2 用例红；③事务段第 3 步归档改回事务外 → AC-17 红；④删一个门工具 → 守卫红；⑤`AnchorValidationError` 改回裸 `Error` → AC-16 红；⑥对齐改成直接减法 → 行内代码 / 实体用例红；⑦`updateTaskMembers` 去掉锁 → AC-20 撤权用例红；⑧`effectiveDvs` 改回旧行 → AC-15 子集用例红。每条在 `plan.md §3` 记录还原后的绿。

## 14. 偏离项与债务登记

| 项                                                    | 性质                              | 处置                                                                                  |
| ----------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `services/review.ts` 应用服务仍在 legacy 层           | RFC-294 未完成的迁移              | 本 RFC 只种 domain + public 一片；`services/review.ts` 经 public 引用，不产生 R1 债务 |
| 蒸馏入队在决策事务之外                                | 既有语义，D6 范围澄清             | N10 / P14；AC-17 锁住「独立写入、失败不影响决策」                                     |
| 回滚先于事务的残留形态                                | 本 RFC 引入（换掉今天的半决策态） | §6.3 如实记录 + AC-17 用例 + 工具描述提示重发                                         |
| `sectionPath` / `paragraphIdx` 前后端两套近似         | 既有                              | 网页高亮不再消费它们                                                                  |
| 公式 / 图表不高亮；alert 首段等无位置节点只做窗口回退 | 渲染管线限制                      | §9.1 列出清单；`docs/dev-gotchas.md` 沉淀                                             |
| 任务工具审计行 `resourceKind` 为空                    | 既有                              | 登记 `docs/audit-backlog.md`                                                          |
| RFC-247 `plan.md` T18 打勾但评论未落地                | 流程债                            | 落地后回写；教训进 `docs/dev-gotchas.md`                                              |
| 网页选词的 `offsetStart` 仍是启发式                   | 既有                              | §3 服务端修正 + P17 按序号定位兜底；根治留给「前端源文解析」                          |
