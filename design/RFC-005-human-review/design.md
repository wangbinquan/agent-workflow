# RFC-005 Design — 人工评审节点 / Markdown 渲染 / 评审意见 / 历史 + Diff

> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)

## 1. 改动地图

| 文件 | 改动类型 | 摘要 |
| --- | --- | --- |
| `packages/shared/src/schemas/workflow.ts` | edit | `NODE_KIND` 加 `'review'`；`WORKFLOW_SCHEMA_VERSION` `1 → 2`；新 `ReviewNodeSchema`、agent `outputs` 元素由 `string` 扩成 `AgentOutputSpecSchema = { name, kind }`（向后兼容裸 string） |
| `packages/shared/src/schemas/agent.ts` | edit | `outputs` 字段类型升级；`outputs[i].kind` 枚举 `'string' \| 'markdown' \| 'markdown_file'` |
| `packages/shared/src/schemas/task.ts` | edit | `tasks.status` 枚举加 `'awaiting_review'`；`node_runs.status` 同步加 |
| `packages/shared/src/schemas/review.ts` | new | `ReviewDecisionSchema` / `ReviewCommentSchema` / `DocVersionSchema` + 各自 List/Create 形态 |
| `packages/shared/src/schemas/ws.ts` | edit | 新 events `review.created` / `review.decision_made` / `review.comment_added` / `review.comment_deleted` |
| `packages/shared/src/schemas/config.ts` | edit | 新增 `plantumlEndpoint?: string` + `plantumlAuthHeader?: string` |
| `packages/backend/src/db/schema.ts` | edit | (a) `tasks.status` / `node_runs.status` enum 加 awaiting_review；(b) `node_runs` 加 `reviewIteration INTEGER NOT NULL DEFAULT 0`；(c) 新表 `doc_versions` + `review_comments` |
| `packages/backend/db/migrations/0002_*.sql` | new | drizzle-kit generate 后产物 |
| `packages/backend/src/services/scheduler.ts` | edit | review 节点 ready 判定 + awaiting_review 状态转移 + reject/iterate 触发上游 rollback + sibling review 作废 + iterate 部分接受合并 |
| `packages/backend/src/services/review.ts` | new | 全部 review 业务逻辑：decision 处理、doc_version 落档、prompt 模板槽位渲染、anchor 校验、worktree mtime watch |
| `packages/backend/src/services/prompt.ts` | edit | `renderUserPrompt` 注入 `{{__review_rejection__}}` + `{{__review_comments__}}`；未引用时追加章节 |
| `packages/backend/src/services/envelope.ts`（或现有 parser 文件） | edit | port content 按 agent `outputs[i].kind` 解析：`markdown_file` 读 worktree 相对路径 |
| `packages/backend/src/services/runner.ts` | edit | 节点完成时把 review 标 awaiting_review 而不是 done（review 自己不跑 opencode） |
| `packages/backend/src/services/worktree.ts` | edit | 新增 `restoreSnapshot(stash hash)` 暴露给 review reject 流程（复用 retry 已有的实现，仅 export） |
| `packages/backend/src/routes/reviews.ts` | new | REST：`GET /api/reviews`（含 query 过滤）/ `GET /api/reviews/:nodeRunId` / `POST /api/reviews/:nodeRunId/decision` / `POST /api/reviews/:nodeRunId/comments` / `DELETE /api/reviews/:nodeRunId/comments/:commentId` / `GET /api/reviews/:nodeRunId/versions` |
| `packages/backend/src/routes/workflows.ws.ts`（或现有 ws.ts） | edit | 新增 review.* 事件 broadcast |
| `packages/backend/src/services/workflow.validator.ts` | edit | review 节点静态校验：必须有 1 个 input port + sourceNode/sourcePort 存在 + sourceNode output 端 `kind ∈ {markdown, markdown_file}` + `rerunnable_on_reject/iterate` 是 review 可达上游子集 |
| `packages/frontend/src/components/canvas/nodePalette.ts` | edit | palette 加 "Human" 分类 + review 节点条目 + 工厂 default |
| `packages/frontend/src/components/canvas/nodes/ReviewNode.tsx` | new | xyflow 节点视觉：色块表示状态（pending=灰、awaiting_review=黄、approved=绿、rejected/iterated=橙） |
| `packages/frontend/src/components/canvas/NodeInspector.tsx` | edit | 加 `review` 分支：`title` / `description` / `inputSource (nodeId, portName)` / `commentInjectTemplate` / `rerunnableOnReject` 多选 / `rerunnableOnIterate` 多选 / `rollbackFilesOnReject` switch / `rollbackFilesOnIterate` switch / `assignee`（隐藏） |
| `packages/frontend/src/routes/reviews.tsx` | new | 左栏 Reviews 全局 tab；segmented filter + 按 task 分组列表 |
| `packages/frontend/src/routes/reviews.detail.tsx` | new | 单个 review 评审页：md 渲染 + 侧栏 + 三按钮 + 历史下拉 + diff 切换 |
| `packages/frontend/src/components/review/MarkdownView.tsx` | new | GFM + shiki + KaTeX + Mermaid + 外部 PlantUML 渲染 + 选词钩子 |
| `packages/frontend/src/components/review/CommentSidebar.tsx` | new | 评审意见列表 + scroll-spy + 双向跳转 |
| `packages/frontend/src/components/review/CommentPopover.tsx` | new | 选词浮窗 + draft + 提交/取消 |
| `packages/frontend/src/components/review/DiffView.tsx` | new | 两版对比 + 标题锚滚动联动 + 粒度切换（词 jsdiff + Intl.Segmenter / 行 jsdiff / 节点 remark-AST） |
| `packages/frontend/src/components/review/PlantUmlBlock.tsx` | new | 外部端点调用 + 错误/未配置降级 |
| `packages/frontend/src/lib/review/anchor.ts` | new | 纯函数：anchor 序列化 / 反序列化 / fuzzy 重新定位（diff 视图用） |
| `packages/frontend/src/lib/review/draftStore.ts` | new | IndexedDB 草稿持久化（key = `${taskId}:${nodeRunId}:${docVersionId}:${anchorHash}`） |
| `packages/frontend/src/routes/__root.tsx` | edit | 左栏 Reviews nav + badge |
| `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts` | edit | 新增 `review.*` section 约 60 条 key |
| `design/design.md` | edit | §5 加 review 节点 schema 段；§9 节点状态机加 awaiting_review；§3 数据模型表加 doc_versions + review_comments；§11 配置表加 plantumlEndpoint |
| `STATE.md` | edit | 顶部追加 `"进行中 RFC：[RFC-005](...)"` 一行；完工时挪到"已完成 RFC"表 |
| `design/plan.md` | edit | RFC 索引追加 `RFC-005` 行（Draft → 进度更新 → Done） |

明示不动文件：

- `packages/backend/src/services/scheduler.ts` 现有 agent-single / agent-multi / wrapper-loop / wrapper-git 分支算法不动，只在 dispatch 表里加 `review`。
- RFC-003 / RFC-004 命名的 8 个 frontend 文件（canvas-connect.ts、EdgeInspector.tsx、PortHandles.tsx、syncInputDefs.ts、NodeInspector 的 input 分支、launcher 表单字段渲染）不动。
- runner.ts 处理 opencode 子进程的核心逻辑不动；只在节点状态过渡处加 review 分支。

## 2. NodeKind 扩展

```ts
// packages/shared/src/schemas/workflow.ts

export const NODE_KIND = [
  'agent-single',
  'agent-multi',
  'input',
  'output',
  'wrapper-git',
  'wrapper-loop',
  'review', // NEW
] as const

export const WORKFLOW_SCHEMA_VERSION = 2 // bump v1 → v2
```

### 2.1 ReviewNode 形态

```ts
export const ReviewNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('review'),
    position: XYSchema.optional(),

    // 必填：评审目标。input 端口在 canvas 上是 catch-all (RFC-003)，
    // 但 review 自己需要明确指向上游 (nodeId, portName)，因为 review
    // 需要知道"哪个 port 是评审目标"用于 doc_version 落档 + iterate 时
    // 只接受 target port 变动。
    inputSource: PortRefSchema,

    // UI 显示
    title: z.string().default(''),
    description: z.string().default(''),

    // 评审重跑配置（reject + iterate 各自独立）
    rerunnableOnReject: z.array(z.string()).default([]),  // 上游节点 id 列表
    rerunnableOnIterate: z.array(z.string()).default([]),

    rollbackFilesOnReject: z.boolean().default(true),
    rollbackFilesOnIterate: z.boolean().default(false),

    // 高级：覆盖框架默认的 {{__review_comments__}} 渲染模板
    commentInjectTemplate: z.string().optional(),

    // 预留：v1 不暴露 UI
    assignee: z.string().optional(),
  })
  .passthrough()
```

`rerunnableOnReject` / `rerunnableOnIterate` 默认值由编辑器在创建 review 节点时填充：reject = "input 直接上游节点 + 该上游的所有可达上游"；iterate = "input 直接上游节点"（仅 1 个 id）。校验阶段要求两者都必须是"review 通过 input 可达的上游子图节点集合"的子集。

### 2.2 Agent outputs `kind` 字段

```ts
// packages/shared/src/schemas/agent.ts

export const AgentOutputSpecSchema = z.union([
  z.string().min(1),                                  // 兼容：裸 string = name，kind 默认 'string'
  z.object({
    name: z.string().min(1),
    kind: z.enum(['string', 'markdown', 'markdown_file']).default('string'),
  }),
])
export type AgentOutputSpec = z.infer<typeof AgentOutputSpecSchema>
```

agent CRUD 接口里裸 string 仍然合法；frontend `AgentForm` 在每个 outputs chip 旁加一个 kind select（默认 string）。

### 2.3 Workflow validator 新规则

```
review-input-source-missing      review 节点 inputSource 必须指向存在的节点 + 端口
review-input-source-not-markdown 上游 port 必须 kind ∈ {markdown, markdown_file}
review-rerunnable-out-of-scope   rerunnableOnReject/iterate 元素必须是 review 可达上游子图
review-rerunnable-empty-on-reject reject 集合不可空（warning，因为默认值不会让它空）
```

## 3. DB schema

```ts
// packages/backend/src/db/schema.ts (片段)

export const tasks = sqliteTable('tasks', {
  // ... existing fields ...
  status: text('status', {
    enum: [
      'pending',
      'running',
      'done',
      'failed',
      'canceled',
      'interrupted',
      'awaiting_review', // NEW
    ],
  }).notNull(),
})

export const nodeRuns = sqliteTable('node_runs', {
  // ... existing fields ...
  reviewIteration: integer('review_iteration').notNull().default(0), // NEW
  status: text('status', {
    enum: [
      'pending',
      'running',
      'done',
      'failed',
      'canceled',
      'interrupted',
      'skipped',
      'exhausted',
      'awaiting_review', // NEW
    ],
  }).notNull(),
})

// -----------------------------------------------------------------------------
// doc_versions — one row per review-target-port snapshot per review_iteration.
// -----------------------------------------------------------------------------
export const docVersions = sqliteTable(
  'doc_versions',
  {
    id: text('id').primaryKey(),                              // ULID
    taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    reviewNodeId: text('review_node_id').notNull(),           // workflow node id of the review node
    reviewNodeRunId: text('review_node_run_id').notNull(),    // node_runs.id of the review node instance (per fanout shard if multi-process)
    sourceNodeId: text('source_node_id').notNull(),           // upstream generator node id
    sourcePortName: text('source_port_name').notNull(),       // port being reviewed
    versionIndex: integer('version_index').notNull(),         // 1-based; v1 = first generation, v2 = after first reject/iterate, ...
    reviewIteration: integer('review_iteration').notNull(),   // matches node_runs.reviewIteration
    bodyPath: text('body_path').notNull(),                    // relative to ~/.agent-workflow/runs/{task}/review/...
    commentsJson: text('comments_json').notNull().default('[]'), // snapshot of review_comments at decision time; JSON array
    decision: text('decision', {
      enum: ['pending', 'approved', 'rejected', 'iterated'],
    }).notNull().default('pending'),
    decisionReason: text('decision_reason'),                  // reject reason 或 iterate comments summary
    promptSnapshot: text('prompt_snapshot'),                  // prompt actually sent when generating this version
    agentSnapshot: text('agent_snapshot'),                    // JSON: {model, variant, temperature} at generation time
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    decidedAt: integer('decided_at'),
    decidedBy: text('decided_by'),                            // currently always 'local'; reserved
  },
  (t) => ({
    reviewIdx: index('idx_doc_versions_review_run').on(t.reviewNodeRunId, t.versionIndex),
    taskIdx: index('idx_doc_versions_task').on(t.taskId),
  }),
)

// -----------------------------------------------------------------------------
// review_comments — comments attached to a specific doc_version.
// Anchor is a composite: section path + paragraph idx + char offsets + selected text +
// surrounding context + occurrence index. AI can disambiguate same-string repeats.
// -----------------------------------------------------------------------------
export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: text('id').primaryKey(),
    docVersionId: text('doc_version_id').notNull().references(() => docVersions.id, { onDelete: 'cascade' }),
    anchorSectionPath: text('anchor_section_path').notNull(),     // e.g. "## 接口设计 > ### POST endpoints"
    anchorParagraphIdx: integer('anchor_paragraph_idx').notNull(),// 0-based within section
    anchorOffsetStart: integer('anchor_offset_start').notNull(),  // char offset within paragraph
    anchorOffsetEnd: integer('anchor_offset_end').notNull(),
    selectedText: text('selected_text').notNull(),                // exact selection
    contextBefore: text('context_before').notNull(),              // ~30 chars before, for fuzzy reanchor in diff view
    contextAfter: text('context_after').notNull(),                // ~30 chars after
    occurrenceIndex: integer('occurrence_index').notNull(),       // 1-based; "第 N 次出现的 selectedText"
    commentText: text('comment_text').notNull(),
    author: text('author').notNull().default('local'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    // Soft delete supported, but UI currently does hard delete and falls into comments_json
    // snapshot of next doc_version's history.
  },
  (t) => ({
    versionIdx: index('idx_review_comments_version').on(t.docVersionId, t.anchorSectionPath),
  }),
)
```

迁移 SQL（`bun run drizzle-kit generate` 后人工 review）：

```sql
-- 0002_human_review.sql (示意，细节 drizzle 生成)
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ...; -- SQLite 不支持直接改 CHECK，需 table-rebuild
-- drizzle 会生成 __new__ table + INSERT INTO ... SELECT + RENAME
ALTER TABLE node_runs ADD COLUMN review_iteration INTEGER NOT NULL DEFAULT 0;
CREATE TABLE doc_versions (...);
CREATE TABLE review_comments (...);
CREATE INDEX idx_doc_versions_review_run ON doc_versions(review_node_run_id, version_index);
CREATE INDEX idx_doc_versions_task ON doc_versions(task_id);
CREATE INDEX idx_review_comments_version ON review_comments(doc_version_id, anchor_section_path);
```

SQLite enum 变更需要 table-rebuild；drizzle 生成的 migration 会自动处理。runner-on-test 的 in-memory DB 路径同样应用迁移，无特殊路径。

## 4. 状态机

```
                                ┌──────────────────────────────────────────────────────────┐
                                │                       review_node (per node_run row)      │
                                │                                                          │
[upstream completes; doc_v1 generated]                                                     │
        │                                                                                  │
        ▼                                                                                  │
   awaiting_review ◄──────────────────────────────────────────────────────────┐            │
        │                                                                     │            │
        │ user posts comments / draft anchored & submitted (DB writes)        │            │
        │                                                                     │            │
        ├─ user clicks "通过"  ──────────────────► done (decision=approved) ──┘──► [downstream proceeds]
        │
        ├─ user clicks "返回修改" (reject)
        │      ▼
        │  daemon: archive comments_json into doc_v1.commentsJson; mark decision=rejected
        │  daemon: rollback worktree to upstream pre_snapshot (if rollbackFilesOnReject=true)
        │  daemon: re-run rerunnableOnReject set (cascade-aware, transitive)
        │  daemon: agent prompts include {{__review_rejection__}}
        │  daemon: generate doc_v2; reset review.node_run.reviewIteration++; status=awaiting_review
        │  daemon: ALL sibling reviews of same upstream node also reset → awaiting_review (A2)
        │      ▼  (loops back)
        │
        └─ user clicks "重新生成" (iterate)
               ▼
           daemon: archive comments_json into doc_v_current.commentsJson; mark decision=iterated
           daemon: ALL submitted comments serialized via {{__review_comments__}}
           daemon: rollback only if rollbackFilesOnIterate=true (default false)
           daemon: re-run rerunnableOnIterate set
           daemon: agent generates new outputs for ALL ports
           daemon: merge ONLY target port into next doc_version; other ports retain previous values (L2)
           daemon: generate doc_v(n+1); reviewIteration++; status=awaiting_review
               ▼  (loops back, NO sibling cascade)
```

**task 顶层 status 派生规则**：

- 任一 `node_runs.status === 'awaiting_review'` → `tasks.status = 'awaiting_review'`
- 否则按现有规则（全 done → done / 有 failed → failed / 有 canceled → canceled / 有 running → running / 全 pending → pending）

scheduler 每次 node 状态过渡完都重新跑一次 task-level 派生（已有的 `recomputeTaskStatus(taskId)` 加一个 awaiting_review 分支）。

## 5. doc_versions 文件系统布局

```
~/.agent-workflow/runs/{task-id}/review/{review-node-id}/{port-name}/
├── v1.md                            # generation #1
├── v2.md                            # after first reject or iterate
├── v3.md
└── ...
```

review 节点是 multi-process fanout 时（每个 shard 一个 review 实例），加一层 shard_key：

```
.../review/{review-node-id}/{shard-key-slug}/{port-name}/v{n}.md
```

`bodyPath` 字段存形如 `runs/{task-id}/review/{review-node-id}/{port-name}/v{n}.md`（相对 `app home`）。

清理：跟随现有 `~/.agent-workflow/runs/{task-id}/` 路径走 GC，无单独清理周期。

## 6. Anchor 模型与精确定位

```ts
// packages/frontend/src/lib/review/anchor.ts

export interface CommentAnchor {
  /** Breadcrumb path of headings, e.g. "## 接口设计 > ### POST endpoints" */
  sectionPath: string
  /** 0-based paragraph index within the deepest section */
  paragraphIdx: number
  /** Char offsets within the paragraph's source markdown */
  offsetStart: number
  offsetEnd: number
  /** Exact selected source text */
  selectedText: string
  /** ~30 chars left / right of selection in source markdown */
  contextBefore: string
  contextAfter: string
  /** 1-based: which occurrence of selectedText this is, when scanning the FULL document */
  occurrenceIndex: number
}

export function makeAnchor(md: string, range: SelectionRange): CommentAnchor { ... }
export function findOccurrenceIndex(md: string, selected: string, offsetStart: number): number { ... }
export function reanchorInVersion(anchor: CommentAnchor, newMd: string): { offsetStart: number; offsetEnd: number } | null { ... }
```

`reanchorInVersion` 用于 diff view 左侧渲染旧评审意见在新版本上的（可能的）位置；多策略 fallback 顺序：

1. 优先：`sectionPath + paragraphIdx + selectedText + occurrenceIndex` 精确命中。
2. 次选：`sectionPath + contextBefore + selectedText + contextAfter` 模糊命中。
3. 最弱：只 `selectedText + occurrenceIndex` 在全文档定位。
4. 全部失败 → 标 `orphan` 不展示在新版本上，但仍在左侧旧版本里可见。

**AI prompt 注入时**（重跑 agent），`{{__review_comments__}}` 渲染成：

```
## 评审意见 (review iteration 3)

### 意见 1
**位置**: ## 接口设计 > ### POST endpoints，第 2 段
**选中原文** (第 2 次出现的 "order_status"):
> 上下文前: "...status fields. The "
> 选中: "order_status"
> 上下文后: " enum should include..."
**评审意见**: 枚举值需要包含 partially_refunded

### 意见 2
...
```

这种格式让 agent 看到的"选中是哪一次"和"前后文是什么"，足以精确定位重名片段。`{{__review_rejection__}}` 渲染成单一段落"拒绝原因：…"。

## 7. envelope 解析（kind 分支）

```ts
// envelope.ts 现有 parseEnvelope 之后增量
function resolvePortContent(rawContent: string, kind: AgentOutputKind, worktreePath: string): string {
  if (kind === 'markdown_file') {
    const rel = rawContent.trim()
    // path traversal 防护
    const abs = path.resolve(worktreePath, rel)
    if (!abs.startsWith(worktreePath + path.sep) && abs !== worktreePath) {
      throw new EnvelopeError('markdown_file path escapes worktree')
    }
    return fs.readFileSync(abs, 'utf8')
  }
  return rawContent
}
```

`kind = 'string'` 或 `'markdown'` 时直接用 envelope 内容；只有 `'markdown_file'` 走 read-file 分支。

**Followup（已落地）：源文件路径上行至 doc_versions + iterate prompt。** `dispatchReviewNode` 现在调用 `resolvePortContentDetailed`，同时拿到 body 与 worktree 相对的源文件路径；后者写入 `doc_versions.source_file_path`（migration `0003_bizarre_doctor_octopus.sql` 增的 nullable 列）。`submitReviewDecision` iterate 分支把它传给 `renderCommentsForPrompt`，渲染成 `**File**: \`<path>\`` 一行置于 `### Comment 1` 之前，最终随 `{{__review_comments__}}` 进入上游节点的迭代提示词，让 agent 知道要改哪个文件。`markdown` / 内联 body 端口列保持 NULL，渲染器跳过该 header。同时把绝对路径放宽（`isAbsolute(trimmed)` 不再硬拒，只要 containment check 通过即可）以匹配 agent cwd 即 worktree 时输出的绝对路径。

envelope 解析本身**不需要改**（K2）：md 里出现伪 `<port>` 不会破坏外层 `<workflow-output>` 解析，因为代码块里的 `<port>` 不会出现在 envelope 之外的根层。RFC-005 不动这条逻辑，但加测试矩阵：

```ts
// tests/envelope-parse-md-edge-cases.test.ts
- md 含 ```backtick code block 里的 <port> → 解析为 envelope 一部分（注：md 内容包含 <port> 字面量字符串是合法的）
- md 含连续两个 <workflow-output>...</workflow-output>（罕见但合法）→ 最后一个胜出
- md 含未闭合的 <port name=...>（截断 envelope）→ 报错
- md 含 <port> 不在 <workflow-output> 包裹下 → 忽略
- md 是 markdown_file 形态，内容是裸路径 "./design/v1.md" → 读取该文件
```

## 8. prompt 模板注入

```ts
// prompt.ts renderUserPrompt 新增

interface ReviewContext {
  reviewIteration: number
  rejection?: string                    // 设置 → 渲染 {{__review_rejection__}}
  comments?: ReviewCommentForPrompt[]   // 设置 → 渲染 {{__review_comments__}}
  iterateTargetPort?: string            // L2: tell agent which port is being iterated; 渲染 {{__iterate_target_port__}}
}

const BUILTIN_REVIEW_TOKENS = [
  '__review_rejection__',
  '__review_comments__',
  '__iterate_target_port__',
] as const
```

行为：

- agent 模板 `{{__review_*__}}` 显式引用 → 占位被 framework 替换。
- 模板未引用 → framework 自动在 user prompt 末尾追加章节（与既有"未引用 port 追加章节"机制同构）。
- review 节点 `commentInjectTemplate` 字段非空 → 覆写 framework 默认的 comments 渲染（高级用户专属）。

未触发 review 重跑时（首次生成），三个槽位都填空字符串，模板里 `{{__review_*__}}` 渲染为空。

## 9. iterate 部分接受 + sibling 作废 的实现

**iterate 部分接受**（L2）：scheduler 在 iterate 触发的重跑完成后，进入"merge"阶段：

```ts
async function mergeIterateResult(params: {
  reviewNodeRunId: string
  targetPortName: string
  upstreamNodeRunId: string  // 新一次 upstream run 的 node_run_id
}): Promise<void> {
  const newOutputs = await getNodeRunOutputs(upstreamNodeRunId)  // 新跑出的全部 port
  const prevDocV = await getLatestDocVersion(reviewNodeRunId, targetPortName)
  const prevOutputs = await getNodeRunOutputs(prevDocV.upstreamNodeRunId)  // 上一版的全部 port

  // 只把 target port 用新值；其它 port 用上一版的值。
  // 写入 node_run_outputs：UPDATE 旧 upstreamNodeRunId 的 portName=target 行的 content 为 newOutputs[target]
  // 其它 port 保持不变。 (新的 upstreamNodeRunId 行本身仍存在；仅 reviewer 视角的"被评审 port"
  // 由本次 iterate 的新内容更新；下游消费这个 port 时按"最新 iterate 后的合并值"取。
}
```

具体落库形态：iterate 触发的 upstream 重跑产生一个新 node_runs 行 + 一组 node_run_outputs 行；framework 在 merge 时**只把 target port 的最新内容更新到 review 节点这条逻辑链路上的下游消费视图**。下游通过 `getResolvedPortValue(reviewNodeRunId, portName)` 取值，该函数实现：

```ts
async function getResolvedPortValue(reviewNodeRunId: string, portName: string): Promise<string> {
  // review_iteration 序列里，target 端口取最新值，其它端口取最近一次完整 generation 时的值
  const docV = await getLatestDocVersion(reviewNodeRunId, portName)
  if (portName === docV.sourcePortName) return readFile(docV.bodyPath)
  // 非 target port：找该 reviewNodeRun 关联 source node 的最近一次 generated upstream node_run，取其 port output
  return getPortFromOriginalGeneration(docV)
}
```

**sibling 作废**（A2）：reject 完成上游重跑后，scheduler 找出同一上游 node 关联的所有 review 节点实例（按 node_id 一一对应），把它们的 `node_runs.status` 重置回 `awaiting_review`，`review_iteration` +1，并把当前未提交的（理论上是历史的提交 comments）归档进 doc_version；新 doc_version_v(n+1) 落档。

iterate 触发的重跑**不做 sibling 作废**——iterate 只在 target port 上推进版本，其它 port 框架根本没合并新值，所以 sibling review 看到的内容没变，状态不动。

## 10. UI 架构

### 10.1 路由 + 左栏 nav

```
/                       (已有) 
/agents                 (已有)
/skills                 (已有)
/workflows              (已有)
/tasks                  (已有)
/reviews                NEW — 全局 Reviews 列表
/reviews/:nodeRunId     NEW — 单个 review 评审页
/settings               (已有，加 Rendering tab)
```

`__root.tsx` 左栏 nav 加 "Reviews" 项 + 未读数 badge（从 `useQuery(['reviews','pending-count'])` 拉，每 30s 刷新或 WS 推到）。

### 10.2 review 评审页结构

```
+-------------------------------------------------------------+
| Header: title • status chip • [对比 v(n-1)] [历史 v1..v(n-1)▼]
+-------------------------------------------------------------+
|                                          | Comments sidebar |
|  Markdown rendering area                 |                  |
|  - GFM tables / lists / code / katex     |  [v3 awaiting]   |
|  - mermaid svg (client)                  |  Comment 1 ▸     |
|  - plantuml svg (external endpoint)      |  Comment 2 ▸     |
|  - selection → CommentPopover            |  Comment 3 ▸     |
|                                          |  ...             |
|  [worktree changed banner if applicable] |                  |
|                                          |                  |
+-------------------------------------------------------------+
| Footer: [通过 A] [返回修改 R] [重新生成 I]  • 草稿 N 条     |
+-------------------------------------------------------------+
```

diff view 模式下顶部多一行 toggle "对比版本: v(n-1) ⇄ v(n)" + 粒度切换 "词 / 行 / 节点"（`Ctrl+1/2/3`），主区分左右两列。

### 10.3 Markdown 渲染管线

```ts
// MarkdownView.tsx (简化)
const md = remark()
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkParse)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeKatex)
  .use(rehypeShiki, { theme: themeFromAppearance() })
  .use(rehypeMermaid)   // custom plugin: client-side renders ```mermaid blocks
  .use(rehypePlantuml)  // custom plugin: ```plantuml → <PlantUmlBlock src={code}/>
  .use(rehypeReact, { components: { ... } })
```

- **SVG 净化**：mermaid 客户端渲染 + PlantUML 远端 SVG 都走 `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })`。
- **图片**：相对路径解析时拼 `${API_BASE}/api/worktree-files/${taskId}/${relativePath}`，后端新 endpoint 做 path traversal 校验后 stream worktree 文件。
- **代码块**：高亮走 shiki（已是同步函数式 API，与 RFC-001 的 model select 走的同一栈）。

### 10.4 选词 → CommentPopover

```ts
// 监听 mouseup + Selection API；过滤选区跨标题情况（F2）
function onSelectionChange() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return
  const range = sel.getRangeAt(0)
  if (rangeStradlesHeading(range)) return  // 跨标题忽略
  // 计算 anchor，弹 popover
  const anchor = makeAnchor(md, computeRangeInSource(range, md))
  openPopover(anchor, sel.getBoundingClientRect())
}
```

popover：textarea + 提交 / 取消按钮；提交触发 `POST /api/reviews/:nodeRunId/comments`；草稿绑定 IndexedDB key（见 §11）；关闭浮窗（点外 / 按 Esc）= 草稿留住（IndexedDB 持久化）但 popover 收起。

### 10.5 CommentSidebar scroll-spy

```ts
// 主区 IntersectionObserver 监听 anchor 元素；最高位入视的 anchor → 高亮 + 自动滚 sidebar
useEffect(() => {
  const observer = new IntersectionObserver((entries) => {
    const top = entries.filter(e => e.isIntersecting).sort((a,b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
    if (top) setActiveCommentId(top.target.dataset.commentId)
  }, { rootMargin: '-20% 0px -60% 0px' })
  // ...
}, [comments])
```

反向（点 sidebar → 跳 md）：`scrollIntoView({ behavior: 'smooth', block: 'center' })` + 2s 背景色高亮。

### 10.6 Diff View

```ts
// DiffView.tsx (简化)
function DiffView({ left, right, granularity, onScrollSync }: Props) {
  const leftHeadings = useHeadings(left.md)
  const rightHeadings = useHeadings(right.md)
  // 标题锚 → 计算双侧滚动锁
  // granularity ∈ 'word' | 'line' | 'block' → 不同 diff 算法
}
```

粒度算法：

- **word**: `jsDiff.diffWordsWithSpace(a, b)`，CJK 用 `Intl.Segmenter` 预切词后再 diff
- **line**: `jsDiff.diffLines(a, b)`
- **block**: 用 `remark` 把两侧 parse 成 AST，按 paragraph / heading / list-item 节点 diff（粒度最粗）

滚动锁：左右各维护 heading 锚 map，左侧 scroll 触发 → 找当前 viewport 顶部最近的 heading slug → 右侧 scrollTo 同 slug 元素位置。

## 11. 草稿持久化

```ts
// draftStore.ts (IndexedDB via idb-keyval 风格，避免重型 lib)
const DB = 'agent-workflow-drafts'
const STORE = 'review-drafts'

interface DraftKey { taskId: string; nodeRunId: string; docVersionId: string; anchorHash: string }
function draftKey(k: DraftKey): string { return `${k.taskId}:${k.nodeRunId}:${k.docVersionId}:${k.anchorHash}` }

async function getDraft(k: DraftKey): Promise<string | null>
async function setDraft(k: DraftKey, text: string): Promise<void>
async function deleteDraft(k: DraftKey): Promise<void>
async function listDrafts(forNodeRunId: string): Promise<{ key: string; text: string }[]>
```

`anchorHash` = sha1(`sectionPath + selectedText + offsetStart`) 截取 8 字符；保证关 tab 再开能命中同一选区。

提交评审成功 → 删 draft；点取消 → 删 draft；popover 关闭但未提交 → 保留 draft。

approve 时 `listDrafts(nodeRunId)` 检测 > 0 → modal "还有 N 条未提交评论"。

## 12. PlantUML 外部端点

```ts
// PlantUmlBlock.tsx
async function fetchSvg(source: string, endpoint: string, authHeader?: string): Promise<string> {
  // Try GET kroki-style first
  const deflated = pako.deflateRaw(new TextEncoder().encode(source))
  const encoded = base64url(deflated)
  const url = `${endpoint.replace(/\/$/, '')}/plantuml/svg/${encoded}`
  try {
    const r = await fetch(url, { headers: authHeader ? { Authorization: authHeader } : {} })
    if (r.ok) return await r.text()
  } catch { /* fall through */ }
  // POST raw source as fallback (plantuml-server / kroki both accept)
  const r2 = await fetch(`${endpoint.replace(/\/$/, '')}/plantuml/svg`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...(authHeader ? { Authorization: authHeader } : {}) },
    body: source,
  })
  if (!r2.ok) throw new Error(`plantuml render failed: ${r2.status}`)
  return await r2.text()
}
```

UI 状态机：`未配置 endpoint` → 直接 `<pre>` + muted 提示；`pending` → spinner；`success` → `dangerouslySetInnerHTML={ DOMPurify.sanitize(svg) }`；`error` → toast + `<pre>` 源码。

Settings 新 tab "Rendering"：`plantumlEndpoint` text input + `plantumlAuthHeader` text input + "测试连通性"按钮 (POST test source "@startuml\nA->B\n@enduml")。

## 13. WS 事件

```ts
// shared/schemas/ws.ts (新增 events)

export const ReviewCreatedEventSchema = z.object({
  type: z.literal('review.created'),
  taskId: z.string(),
  nodeRunId: z.string(),
  reviewNodeId: z.string(),
  docVersionId: z.string(),
  versionIndex: z.number().int(),
  createdAt: z.number().int(),
})

export const ReviewDecisionMadeEventSchema = z.object({
  type: z.literal('review.decision_made'),
  taskId: z.string(),
  nodeRunId: z.string(),
  decision: z.enum(['approved', 'rejected', 'iterated']),
  reviewIteration: z.number().int(),
})

export const ReviewCommentAddedEventSchema = z.object({
  type: z.literal('review.comment_added'),
  nodeRunId: z.string(),
  docVersionId: z.string(),
  comment: ReviewCommentSchema,
})

export const ReviewCommentDeletedEventSchema = z.object({
  type: z.literal('review.comment_deleted'),
  nodeRunId: z.string(),
  commentId: z.string(),
})
```

复用现有 `/ws/workflows` 频道（每 task 一个 WS 链接订阅 task 子事件）。前端 `useReviewWs(nodeRunId)` 自动重连 / since-id 续传。

## 14. REST endpoints

```
GET    /api/reviews                                            list (filter: status / taskId / nodeId)
GET    /api/reviews/pending-count                              { count: N }
GET    /api/reviews/:nodeRunId                                 review 详情 + 当前 doc_version + comments
GET    /api/reviews/:nodeRunId/versions                        所有 doc_versions（用于历史下拉）
GET    /api/reviews/:nodeRunId/versions/:versionId             特定版本 md + comments snapshot
POST   /api/reviews/:nodeRunId/decision                        { decision: 'approve'|'reject'|'iterate', reason?, comments? }
POST   /api/reviews/:nodeRunId/comments                        { anchor, commentText }
DELETE /api/reviews/:nodeRunId/comments/:commentId
GET    /api/worktree-files/:taskId/*                           图片资源 stream（限 worktree 内 + 仅 GET + path traversal 防护）
POST   /api/render/plantuml                                    可选：服务端代理（v2，不在本 RFC 实现）
```

`POST /decision`：

```ts
{
  decision: 'approve' | 'reject' | 'iterate',
  // reject 必填
  rejectReason?: string,
  // approve 时如果 sidebar 有 draft 由前端先 force-drop（前端先调 DELETE draft 然后 POST decision）
}
```

返回：

```ts
{
  ok: true,
  // approve 时附带 task / 下游节点的新状态变化（用于乐观更新）
  taskStatus?: TaskStatus,
  triggeredNodeRunIds?: string[],
}
```

并发安全：`POST /decision` 使用乐观锁 `If-Match: <review_iteration>`，daemon 检查当前 review_iteration 不变才接受（多 tab 同时点决策时第二次返 409）。

## 15. 失败模式

| 触发 | 结果 |
| --- | --- |
| 上游 generator 产出 envelope 缺 target port | review 节点直接 failed（不进 awaiting_review），task 失败；原因 = "review target port {x} missing from upstream output" |
| markdown_file path 越出 worktree | envelope 解析报错，节点 failed |
| markdown_file 路径文件不存在 | 同上 |
| 用户点 reject 但 reason 为空 | 前端拦截不发；后端再校验 reason.trim().length > 0 |
| 用户点 iterate 但 sidebar 无评审意见 | 前端 modal "无评审意见，确定要重新生成吗？"；确认后照走（{{__review_comments__}} 渲染为空） |
| reject 重跑过程中 daemon 重启 | task 状态被记为 `interrupted`（沿现有路径），resume 后从 review 节点重新跑上游（review_iteration 已 +1，新 doc_version 占位但未完成） |
| 用户两 tab 都点 approve（race） | 第二个返 409；UI 提示"该评审已被另一个会话处理"，刷新页面 |
| commentInjectTemplate 含未知占位符 | 渲染时占位保留（i18n / variable resolver 默认 skipOnVariables），不报错；test 锁这个行为 |
| Settings plantumlEndpoint 配错（404） | 单条 plantuml 块 fallback；其它 md 部分正常渲染；不阻断评审 |
| reviewable upstream 是 multi-process fanout，部分 shard 失败 | 失败 shard 的 review 实例不创建；成功 shard 的 review 正常 awaiting_review；用户可对成功的 shard 单独决策 |
| iterate 后 agent 没输出 target port | merge 阶段检测到 → review 节点 failed，原因 "iterate produced no content for target port {x}" |
| review_comments 表 anchor 反序列化失败（schema 漂移） | review 详情接口跳过这条 + log warning；不让一条坏 comment 拖垮整个 review |
| 用户在 awaiting_review 期间 cancel task | task → canceled；review_comments 保留作为 doc_version 历史；UI 仍可只读查看 |
| daemon restart 期间 review 是 awaiting_review | 重启后 status 不变（不写 interrupted 这一专属状态），UI 顶部提示"daemon 已重连"即可继续审 |

## 16. 测试策略

按 CLAUDE.md `test-with-every-change`。

### Backend

- `tests/review-schema-migration.test.ts` — 旧 v1 DB（实际 SQLite 文件）跑 0002 migration → 表存在 / 字段类型对 / 索引存在 / 旧 task / node_runs 数据无丢失。
- `tests/review-state-machine.test.ts` — awaiting_review 状态转移 5 case：(1) upstream done → review awaiting_review；(2) approve → done + 下游 ready；(3) reject → upstream rollback + review_iteration++ + status=awaiting_review；(4) iterate → upstream re-run + review_iteration++ + 仅 target port 推进；(5) sibling 作废。
- `tests/review-prompt-injection.test.ts` — `{{__review_rejection__}}` / `{{__review_comments__}}` / `{{__iterate_target_port__}}` 都正确渲染；未引用时追加章节；commentInjectTemplate 覆写生效。**源代码层兜底**：grep `"__review_rejection__"` 在 prompt.ts；grep `"__review_comments__"` 同；防止 rename。
- `tests/review-anchor-disambiguation.test.ts` — 锁定 anchor 在同串多次出现时的 occurrence_index 正确写入 prompt；AI 拿到的 prompt 不会有歧义。**顶部注释链回本 RFC**：B2 anchor precision contract。
- `tests/review-iterate-partial-merge.test.ts` — agent 输出 portA + portB + portC 三 port，iterate 评 portA；merge 后 review 节点下游消费 portA=new、portB=v_old、portC=v_old。**顶部注释**：L2 partial-merge contract。
- `tests/review-sibling-invalidation.test.ts` — 同 upstream node 三 review 节点都 approved，reject 其中一个 → 全部回到 awaiting_review。**顶部注释**：A2 sibling cascade。
- `tests/envelope-parse-md-edge-cases.test.ts` — markdown / markdown_file kind 解析；path traversal；md 内含伪 `<port>` 不破坏 envelope 解析（§7）。
- `tests/review-validator.test.ts` — 5 个新规则各 1 case + happy path 1 case。
- `tests/review-comments-crud.test.ts` — 提交 / 删除 / list；archived comments_json 跟 doc_version 走。
- `tests/review-multi-process-fanout.test.ts` — per-shard review 实例创建 + 分别 awaiting_review。
- `tests/review-loop-nesting.test.ts` — wrapper-loop 内的 review 节点；每个 iteration 独立 doc_version；exit_condition 命中 approve 时退出。
- `tests/review-decision-409.test.ts` — 同 review_iteration 两次 decision 第二次返 409。

backend total +25。

### Frontend

- `tests/lib-review-anchor.test.ts` — `makeAnchor` / `findOccurrenceIndex` / `reanchorInVersion` 共 8 case，含同串重名 / 跨段落 / 模糊 fallback 链 / orphan。
- `tests/lib-review-draft-store.test.ts` — IndexedDB 持久化往返 + 多 anchor 共存 + delete + listDrafts。3 case。
- `tests/MarkdownView.test.tsx` — mermaid 渲染 / katex 渲染 / GFM table 渲染 / plantuml 未配置时 fallback / 图片相对路径解析；6 case。
- `tests/CommentSidebar.test.tsx` — 排序按位置 / scroll-spy 当前 anchor 高亮 / 双向点击跳转 / delete 按钮 / 历史只读样式。4 case。
- `tests/DiffView.test.tsx` — 词级 / 行级 / 节点级三档切换 + 标题滚动联动。3 case。
- `tests/reviews-tab.test.tsx` — 全局列表 segmented filter / 按 task 分组 / 未读 badge 数。3 case。
- `tests/plantuml-block.test.tsx` — endpoint 未配置 / GET 失败 fallback 到 POST / POST 也失败显示错误；3 case。
- `tests/review-detail-route.test.tsx` — 三按钮点击触发对应 POST / approve 时 draft 数 > 0 弹 modal / reject 弹只读 rerunnable list modal / WS 事件实时更新 sidebar；4 case。

frontend total +34。

### e2e

- `e2e/review.spec.ts` 一个测：fixture 用 stub-opencode 返三种 envelope（第 1 次 v1、第 2 次 v2-after-reject、第 3 次 v3-after-iterate），跑完一条 input → designer(review-enabled) → reviewDesign 的工作流，全链路 approve 路径 + reject 路径 + iterate 路径 串成一条 spec。

## 17. 与既有 RFC 的关系

- **RFC-001**：Settings tab 加 "Rendering"（plantuml endpoint）同 Runtime 风格走 `useTabState`，无组件改造。
- **RFC-002**：AgentForm 把 `outputs` ChipsInput 升级支持 `kind` select；裸 string 仍接受（兼容老 agent）。
- **RFC-003**：review 节点的输入端走 catch-all handle，沿用 RFC-003 的 `translateInboundConnection`。
- **RFC-004**：review 节点不参与 launcher 表单字段，不动 `syncInputDefs`；validator 加 review 规则但不影响 input-key 规则。

## 18. v2 / 后续延展点（明示推迟）

- 多用户评审 / 角色分配（`assignee` schema 字段已留）。
- 评审线程 / 回复 / 提及。
- 部分 port 重生（agent 显式只重生 target port，不重生其它）。
- 服务端 PlantUML 代理（`POST /api/render/plantuml`，便于跨网段部署）。
- 评审决策上限 `max_iterations`。
- worktree 锁 / 防外部修改。

## 19. 风险登记

| 风险 | 缓解 |
| --- | --- |
| schema v2 migrator 在 SQLite enum table-rebuild 路径上有 bug | 用 drizzle-kit generate 而不是手写；migration test 覆盖 1 个真实 v1 文件库迁到 v2 + 数据完整性断言 |
| iterate "merge" 语义 agent 不听话（拒绝重输出非 target port） | 框架在 merge 时仅看 target；agent 输出可被框架完全忽略——不依赖 agent 配合 |
| PlantUML 外部端点泄漏文档源码 | UI 显式提示"将向 {host} 发送源码"；默认空配置；Settings 文档化 |
| 评审 anchor 在大文档（几万字）上重锚开销 | reanchor 仅在 diff view 触发（用户主动），不在主渲染路径；性能可接受 |
| draft IndexedDB 在多浏览器 / 多设备不同步 | 显式只本地、不上服务器；可接受（v1 单用户） |
| review_comments 表无 cleanup 周期 | 跟随 task 删除级联；archived comments_json 是 doc_version 的一部分，task 删 → doc_version 删 → 文件删 |
| envelope 解析的 markdown_file 路径漏洞 | path.resolve 后必须 startsWith(worktreePath + sep)；测试覆盖 ../../etc/passwd / 绝对路径 / symlink escape 三种攻击向量 |
| WS 事件丢失导致 sidebar / 状态不同步 | 复用现有 WS since-id 重连机制；每次接 WS 重连后 refetch `GET /api/reviews/:nodeRunId` 兜底 |
| PlantUML 端点慢导致 UI 卡 | fetch 走 Promise.race + 10s timeout；超时 fallback 源码 |
| 选词跨标题边界 / 多 paragraph 锚定漂移 | F2 限制选区不跨标题；anchor + occurrence_index 足以单义；重锚链 4 层 fallback |

## 20. 一句话契约

> **review 节点是 workflow DAG 上的人工 gate：上游产出 markdown port → review 进 `awaiting_review` → 人审给出 approve/reject/iterate 三选一 → 框架按 review 节点上预先配置的回滚集合 + 模板槽位重跑或放行，每轮变动落 `doc_versions` 不可变历史 + `review_comments` 复合 anchor，AI 重跑时收到无歧义意见列表。**
