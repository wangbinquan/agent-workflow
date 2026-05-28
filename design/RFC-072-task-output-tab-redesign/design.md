# RFC-072 Task Detail "Outputs" Tab Redesign — Design（技术设计）

## 0. 现状梳理（代码锚点）

- **面板**：`packages/frontend/src/components/TaskOutputPanel.tsx`
  - `collectPorts(snapshot)` 从 workflow snapshot 收集 output-node `ports[]` + workflow-level
    `outputs[]` 的绑定，产出 `DeclaredPort {name, nodeId, portName}`。
  - 渲染：`.task-outputs__grid` 网格 → 每端口一张 `OutputCard`；正文 `<pre class="task-output-card__body">`
    被 CSS `max-height: 240px`（`styles.css:4886`）截高。
  - 复制：`OutputCard.handleCopy`（`:68`）`navigator.clipboard.writeText(value).then(...)`，
    非安全上下文 `navigator.clipboard === undefined` → 抛错静默失败。
- **数据流**：`tasks.detail.tsx:352` `<TaskOutputPanel task runs outputs />`，`outputs` 来自
  `GET /api/tasks/:id/node-runs` → `services/task.ts:getTaskNodeRuns`（`:1361` mapper 产出
  `{nodeRunId, port, value}`）。
- **kind 来源**：output port 的 kind 在 **agent** 上（`agent.outputKinds[portName]`，RFC-005 /
  RFC-060）。workflow 画布节点只存 `agentName`（`canvas/NodeInspector.tsx:1218`），**不内嵌**
  outputKinds；snapshot 因此不可靠地携带 kind。runner 在落库时**已经**解析了 kind
  （`services/runner.ts:1052` `const outputKinds = opts.agent.outputKinds`，由
  `getAgent(db, agentName)` 取活动 agent，`scheduler.ts:1067`），但当前
  `node_run_outputs` 表只存 `{nodeRunId, portName, content}`（`db/schema.ts:548`），kind 被丢弃。
- **文件值语义**：`path` / `markdown_file` kind 端口，envelope 里 agent 发送的是工作目录相对
  路径，`node_run_outputs.content` 存的就是这串相对路径（`services/envelope.ts:18`、`:347`），
  非文件内容。
- **下载路由**：`GET /api/worktree-files/:taskId/*`（`routes/worktree-files.ts`）已存在：按相对
  路径流式返回工作目录文件原始字节，含路径穿越防护 + extension→MIME 映射；鉴权走 multiAuth，
  **支持 `?token=` query 参数**（`auth/session.ts:118` `extractRawToken` 先读 `c.req.query('token')`
  再读 `Authorization: Bearer`）。
- **kind 解析器**：`packages/shared/src/kindParser.ts`：`parseKind` / `tryParseKind` 把 kind 字符串
  解析为 `ParsedKind = {kind:'base'} | {kind:'path', ext} | {kind:'list', item}`；`'markdown_file'`
  在 parse 阶段折叠为 `{kind:'path', ext:'md'}`。

## 1. 设计概览

三块改动，单 PR 内强序（schema/迁移 → runner 持久化 → API → 前端消费）：

```
后端（让 kind 流到前端）
  migration 0037  node_run_outputs 加 nullable kind TEXT 列
  schema.ts       nodeRunOutputs 加 kind 列定义
  runner.ts       落库 output 时写 kind = outputKinds?.[name] ?? null
  shared          NodeRunOutputSchema 加 kind?: string|null
  task.ts         getTaskNodeRuns mapper 输出 kind

前端（重画 Outputs tab）
  TaskOutputPanel  两栏布局 + 选中态 + copy 修复 + 文件下载
  lib/output-port       纯函数：isFileOutputKind / isSingleLinePath（可单测）
  lib/clipboard         纯函数：copyText（execCommand 回退，可单测）
  lib/worktree-download 共享：worktreeFileDownloadUrl / downloadBaseName / downloadWorktreeFile
                        （与 RFC-071 同源，单一实现，见 §3.1「与 RFC-071 协调」）
  styles.css       .task-outputs-panel 两栏命名空间（对齐 .worktree-files-panel）
  i18n             taskOutputs.* 新键 cn/en 对称
```

## 2. 后端：把 output kind 持久化并暴露

### 2.1 Migration `0037_rfc072_node_run_output_kind.sql`

```sql
-- RFC-072: persist the resolved output kind alongside each parsed port value
-- so the task-detail Outputs tab can tell file-path ports (path<ext> /
-- markdown_file) from text ports without re-resolving the (possibly drifted)
-- agent definition. NULL = legacy row / kind was undeclared → treat as text.
ALTER TABLE node_run_outputs ADD COLUMN kind TEXT;
```

- 纯加列、可空、无回填、无重建——SQLite `ADD COLUMN` 安全、对既有行 NULL。
- `db/migrations/meta/_journal.json` 追加一条（当前 36 条 idx 0–35，最新文件 `0036_rfc070...`；
  本迁移文件号 `0037`，journal idx 36，实施时按既有脚本/`drizzle-kit` 生成核对）。
- `tests/upgrade-rolling.test.ts` 的 `HEAD_TOTAL_MIGRATIONS` 常量 +1（实施时读当前值再 +1）。

### 2.2 `db/schema.ts`

`nodeRunOutputs` 表对象加列：

```ts
kind: text('kind'),   // RFC-072: resolved AgentOutputKind string, NULL when undeclared/legacy
```

主键 `(node_run_id, port_name)` 不变。

### 2.3 `services/runner.ts` 持久化点（`:1081-1091`）

落库 loop 内，把已在手的 `outputKinds`（`:1052`）写进行：

```ts
for (const [name, content] of parsed.ports) {
  const kind = outputKinds?.[name] ?? null   // 字符串字面量，原样存（如 'markdown_file' / 'path<md>' / 'markdown'）
  await opts.db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: opts.nodeRunId, portName: name, content, kind })
    .onConflictDoUpdate({
      target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
      set: { content, kind },
    })
  outputsPersistedCount += 1
}
```

- **存原样字面量**（不经 `stringifyKind` 归一）：保留 agent 声明的原值，前端用 `tryParseKind`
  统一解析（`markdown_file` 与 `path<md>` parse 后等价），不在写路径引入归一耦合。
- `outputKinds === undefined`（agent 未声明任何 kind）→ 所有行 kind = NULL，与旧行为一致。
- 注意：`outputKinds` 此前在 `:1053` 是 `if (outputKinds !== undefined)` 块内的局部；持久化 loop
  在该块**之外**（`:1081`），故这里用 `opts.agent.outputKinds?.[name] ?? null` 直接取，避免
  依赖块内局部作用域。实施时确认变量可见性。

### 2.4 shared `NodeRunOutputSchema`（`packages/shared/src/schemas/task.ts:470`）

```ts
export const NodeRunOutputSchema = z.object({
  nodeRunId: z.string(),
  port: z.string(),
  value: z.string(),
  /** RFC-072: resolved AgentOutputKind string at run time; null/absent for
   *  legacy rows or ports whose agent declared no kind. */
  kind: z.string().nullable().optional(),
})
```

- `.nullable().optional()` ：旧 API 响应（无该字段）与 NULL 列都可解析，向后兼容。

### 2.5 `services/task.ts` getTaskNodeRuns mapper（`:1361`）

```ts
outputs = outRows.map((o) => ({
  nodeRunId: o.nodeRunId,
  port: o.portName,
  value: o.content,
  kind: o.kind,            // RFC-072
}))
```

## 3. 前端：Outputs tab 两栏重画

### 3.1 纯函数（抽出，单测面）

`packages/frontend/src/lib/output-port.ts`（新文件）：

```ts
import { tryParseKind } from '@agent-workflow/shared'

/** True iff the kind string denotes a single downloadable file path
 *  (path<ext>, incl. the markdown_file alias). list<path<...>> is NOT a
 *  single file in v1 → false. Null/undefined/text kinds → false. */
export function isFileOutputKind(kind: string | null | undefined): boolean {
  if (kind === null || kind === undefined || kind === '') return false
  const parsed = tryParseKind(kind)
  return parsed !== null && parsed.kind === 'path'
}

/** True iff value is a single non-empty line (a usable file path). Multi-line
 *  or empty values never get a download button even on a path kind. */
export function isSingleLinePath(value: string | null): boolean {
  if (value === null) return false
  const v = value.trim()
  return v.length > 0 && !v.includes('\n')
}
```

`packages/frontend/src/lib/clipboard.ts`（新文件）：

```ts
/** Copy text to the clipboard, falling back to a hidden <textarea> +
 *  document.execCommand('copy') when the async Clipboard API is unavailable
 *  (non-secure context: daemon over plain http on a LAN IP). Returns whether
 *  the copy succeeded. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to execCommand */
  }
  return execCommandCopy(text)
}

function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}
```

**实际落地（reuse-don't-touch，见 §「与 RFC-071 协调」）`packages/frontend/src/lib/worktree-download.ts`**
—— RFC-071 已在工作树（uncommitted）把 `worktreeFileDownloadUrl` / `downloadBaseName` **export**
出来；本 lib **import 它们**、只新增 `downloadWorktreeFile` 的 blob fetch+save glue，**不改对方文件**：

```ts
import { ApiError } from '@/api/client'
import { downloadBaseName, worktreeFileDownloadUrl } from '@/components/WorktreeFilesPanel'
import { getBaseUrl, getToken } from '@/stores/auth'

/** Download a worktree file through the daemon's authenticated raw-file route
 *  (RFC-005 /api/worktree-files/:taskId/*). Fetches with the Authorization
 *  header (no token in URL/history), then triggers an <a download>. */
export async function downloadWorktreeFile(taskId: string, relPath: string): Promise<void> {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(worktreeFileDownloadUrl(getBaseUrl(), taskId, relPath), { headers })
  if (!res.ok) throw new ApiError(res.status, `http-${res.status}`, res.statusText || 'download failed')
  const objectUrl = URL.createObjectURL(await res.blob())
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = downloadBaseName(relPath)
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
```

- **为何 blob fetch 而非 `<a href download>`**：`download` 属性仅对同源 URL 生效；`getBaseUrl()`
  可配置为跨源（远程 daemon），跨源时 `download` 被忽略、且 worktree-files 路由未设
  `Content-Disposition`，会内联打开而非下载。blob 方式与源无关、文件名可控、用标准 Authorization
  头（token 不进 URL 历史）。这正是仓内既有下载（评审 Markdown 导出，`routes/reviews.detail.tsx:859-871`）
  的同套 `createObjectURL + a.download` 模式。
- 大文件：output 文件通常很小；worktree-files 路由不限大小，blob 会整块入内存——v1 接受
  （非目标里已声明不做大文件流式 / 范围请求）。

#### 与 RFC-071 协调（同源下载原语，避免双份实现）

并行进行中的 RFC-071「工作目录文件下载」（`design/RFC-071-worktree-file-download/`，另一贡献者，
Draft）给 **工作目录** tab 预览区加同样的下载按钮，其 design.md §「纯函数」把
`worktreeFileDownloadUrl(baseUrl, taskId, relPath)` 与 `downloadBaseName(relPath)` 定义在
`WorktreeFilesPanel.tsx`、并写一个面板私有 `DownloadFileButton`。两 RFC 的下载机制**完全同源**
（同端点 + 同 blob 套路 + 同 basename 语义）。按 CLAUDE.md 前端统一原则「不要 fork 一份 / 不要绕开，
优先复用 / 最小扩展公共原语」，本 RFC 把这三个函数放进**共享模块 `lib/worktree-download.ts`** 而非
组件文件，供两 tab 复用。**落地顺序协调**：

- 若 **RFC-071 先合**：实现 RFC-072 时把已落在 `WorktreeFilesPanel.tsx` 的
  `worktreeFileDownloadUrl` / `downloadBaseName` **上提**到 `lib/worktree-download.ts`，
  `WorktreeFilesPanel` 改为从该 lib import（最小重构、不改其行为 / 测试断言），`TaskOutputPanel`
  也从该 lib import。
- 若 **RFC-072 先合**：本 RFC 建好 `lib/worktree-download.ts`，RFC-071 实现时直接 import，不再在
  `WorktreeFilesPanel.tsx` 内重定义。
- 任一情况都**只有一份** URL 构造 / basename / blob 下载逻辑。实施前若发现对方已落地，按
  CLAUDE.md「同一文件混了多人改动可以一起 commit、绝不删别人的代码」处理，必要时停下来与用户对齐
  （[feedback_dont_delete_others_code_for_ci]）。

### 3.2 `TaskOutputPanel.tsx` 重写

保持 `collectPorts` 不变（仍返回 `DeclaredPort[]`）。组件层改造：

```
TaskOutputPanel(task, runs, outputs)
  ports = collectPorts(task.workflowSnapshot)        // 同现状
  if ports.length === 0 → return null                // 同现状（无声明输出，tab 不渲染该面板）
  valueByRunPort: Map<`${runId}:${port}`, value>     // 同现状
  kindByRunPort:  Map<`${runId}:${port}`, kind|null> // 新增，来自 outputs[].kind
  latestRunByNodeId: Map                             // 同现状
  对每个 port 解析 {value, kind}（latestRun 命中→取值/kind；未命中→value=null,kind=null）
  selectedIndex: useState(0)                          // 默认第一个
  布局：
    <div class="task-outputs-panel">
      <div class="task-outputs-panel__list" role="listbox">
        每个 port 一个 <button role="option" aria-selected=...>（端口名 + 绑定副标）
      </div>
      <div class="task-outputs-panel__detail">
        <OutputDetail port value kind taskId />
      </div>
    </div>
```

`OutputDetail`：

```
header：port.name + 绑定 <code>nodeId.portName</code>
actions：
  「复制」btn btn--sm  → copyText(value)，成功 setCopied(true) 1.5s；value===null → disabled
  「下载」btn btn--sm  → 仅当 isFileOutputKind(kind) && isSingleLinePath(value) 时渲染
                        → downloadWorktreeFile(taskId, value.trim())  // basename 内部派生
                        → downloading 态禁用防重复点；失败 setError(可见提示)
body：<pre class="task-outputs-panel__pre">
  value===null → muted pending… ；value==='' → muted (empty) ；否则 value
```

- `taskId` 需传入 `OutputDetail`：`TaskOutputPanel` 已有 `task` prop → `task.id`。
- 选中态：左列 `is-selected`，沿用 `.worktree-files-tree__row.is-selected` 视觉风格（新命名空间
  内复刻 `color-mix(accent 18%)`）。

### 3.3 CSS（`styles.css` 新命名空间，对齐 `.worktree-files-panel`）

```css
.task-outputs-panel { display:grid; grid-template-columns:minmax(220px,320px) 1fr;
  gap:var(--space-3); height:100%; min-height:0; }
.task-outputs-panel__list { display:flex; flex-direction:column; gap:2px;
  border-right:1px solid var(--border); padding-right:var(--space-2);
  overflow:auto; min-height:0; }
.task-outputs-panel__option { /* 复用 .worktree-files-tree__row 的形态 */ ... is-selected ... }
.task-outputs-panel__detail { display:flex; flex-direction:column; gap:var(--space-2);
  min-height:0; overflow:auto; }
.task-outputs-panel__detail-header { display:flex; justify-content:space-between; align-items:flex-start; gap:var(--space-3); }
.task-outputs-panel__actions { display:flex; gap:var(--space-2); }
.task-outputs-panel__pre { flex:1; margin:0; padding:var(--space-3); white-space:pre-wrap;
  word-break:break-word; overflow:auto; background:var(--bg);
  border:1px solid var(--border); border-radius:var(--radius-md);
  font-family:ui-monospace,...; font-size:var(--font-sm); }
```

- 删除/弃用旧 `.task-outputs__grid` + `.task-output-card*`（含 `max-height:240px`）。grep 守门锁
  `max-height: 240px` 与 `.task-outputs__grid` 不再出现在 src。

### 3.4 i18n（`i18n/{en-US,zh-CN}.ts` `taskOutputs` 块，cn/en 对称）

新增：
- `taskOutputs.download` = `Download` / `下载`
- `taskOutputs.downloadFailed` = `Download failed` / `下载失败`
- `taskOutputs.empty` 复用 `common.empty`；pending 复用现有 `taskOutputs.pending`
- （可选）`taskOutputs.selectHint`（左列为空时一般不会出现，因 ports.length===0 整面板不渲染）

复制按钮文案复用 `common.copy` / `common.copied`（已存在）。

## 4. 与现有模块的耦合点 / 失败模式

- **多仓（RFC-066）**：worktree-files 路由用 `task.worktreePath`（多仓为父目录）解析相对路径；
  output 文件路径相对该 cwd，与 runner 写入语义一致 → 多仓自然 work。
- **kind 漂移**：持久化的是 run 时刻 agent 的 kind，比"前端再去读活动 agent"更真实；agent 后续
  改了 outputKinds 不影响历史任务展示。
- **旧行 NULL**：`kind` 列对升级前行为 NULL → `isFileOutputKind(null)===false` → 无下载按钮、
  纯文本展示（AC-9）。
- **下载失败**：文件被 GC / 路径不存在 → 路由 404（`worktree-file-not-found`）→ `downloadWorktreeFile`
  抛错 → 详情区可见错误（AC-6）。
- **路径穿越**：完全交给既有路由的 lexical containment 防护，前端不自行拼绝对路径。
- **复制不可用**：`copyText` 两级回退后仍失败（极少数浏览器禁用 execCommand）→ 返回 false →
  按钮不显示「已复制」，可加一行 muted 失败提示（可选，不阻塞 AC-4 主路径）。
- **token in blob fetch**：用 Authorization 头，不把 token 放进 URL；对齐 `api` client 既有做法。

## 5. 测试策略（test-with-every-change）

### shared（`packages/shared/tests/`）
- `node-run-output-kind-schema.test.ts`：`NodeRunOutputSchema` 接受带 `kind` 字符串 / `kind:null` /
  无 `kind`（向后兼容）三形态；`kind` 为非字符串时拒绝。

### backend（`packages/backend/tests/`）
- `migration-0037-output-kind.test.ts`：跑迁移后 `node_run_outputs` 含 `kind` 列、可空、既有行 NULL。
- `runner-output-kind-persist.test.ts`：一个声明 `markdown_file` 端口的 agent done 后，对应
  `node_run_outputs` 行 `kind==='markdown_file'`（或 agent 声明的原字面量）；未声明 kind 的端口
  行 `kind===null`；`getTaskNodeRuns` 把 `kind` 透到 API 响应。
- `upgrade-rolling.test.ts`：`HEAD_TOTAL_MIGRATIONS` +1。

### frontend（`packages/frontend/tests/`）
- `output-port.test.ts`：`isFileOutputKind`（`markdown_file`/`path<md>`/`path<*>`→true；
  `string`/`markdown`/`signal`/`list<string>`/`list<path<md>>`/null/''→false）、`isSingleLinePath`
  （单行非空 true；空 / 多行 / null false）。
- `worktree-download.test.ts`（与 RFC-071 共用该 lib 的测试）：`worktreeFileDownloadUrl`（根级 /
  嵌套 / base 带尾斜杠 / 含空格 & 特殊字符逐段编码）、`downloadBaseName`（根级 / 嵌套 / 空串回退
  `'download'`、尾斜杠、反斜杠）。若 RFC-071 已落地同名测试，合并而非重写。
- `clipboard.test.ts`：mock `navigator.clipboard` 缺失 → 走 execCommand 路径（mock
  `document.execCommand` 返回 true）；clipboard 可用 → 走 `writeText`；两路径返回值正确。
- `task-output-panel.test.tsx`：
  - 渲染左列全部声明端口、默认选中第 0 个、点选切换右侧详情；
  - 复制按钮点击调用 `copyText`（mock）并显示「已复制」；value=null 时禁用；
  - 文件 kind（`markdown_file`，单行路径值）出现「下载」按钮、点击调用 `downloadWorktreeFile`
    （mock）并传 `(taskId, relPath)`；非文件 kind / 多行值无下载按钮；下载失败显示就地错误；
  - pending / empty 占位；
  - `collectPorts` 既有单测（如已有）保持绿。
- `task-output-panel-source-guards.test.ts`：源码守门——`TaskOutputPanel.tsx` 不再含
  `max-height: 240px` 相关旧卡片正文样式锚点（实际锚点在 styles.css）、`styles.css` 不再含
  `.task-outputs__grid`；`TaskOutputPanel` 复制路径经由 `copyText`（不直接裸调
  `navigator.clipboard.writeText`）；`.task-outputs-panel` 两栏类存在。

### gate
- `bun run typecheck && bun run test && bun run format:check` + `bun run lint` 全绿；
- push 后按 [feedback_post_commit_ci_check] 立即查 GitHub Actions（含 e2e）。

## 6. 决策记录

- **D1**：kind 走"持久化进 `node_run_outputs`"而非"前端读活动 agent 解析"——更真实（run 时刻）、
  localized、未来可复用；代价是一条 additive nullable 迁移。
- **D2**：下载走 blob fetch + Authorization 头，复用既有 worktree-files 原始路由，不新增后端路由、
  不加 `Content-Disposition`。
- **D3**：v1 仅单文件 `path<ext>` 出下载按钮；`list<path<...>>` 留作后续。
- **D4**：两栏布局复刻 `.worktree-files-panel` 形态但用 `.task-outputs-panel` 独立命名空间（不耦合
  两 feature 的 CSS），token 一致保证视觉统一。
- **D5**：copy 修复抽 `lib/clipboard.copyText`，可单测 + 全站复用（其它地方未来要复制也走它）。

## 7. PR 拆分

单 PR：`feat(backend,frontend): RFC-072 task output tab redesign`。后端 5 处小改 + 1 迁移与前端
强耦合（前端消费 `kind`），合在一个 PR 内顺序落地；不拆分。若 reviewer 要求，可按
"PR-A 后端 kind 持久化 / PR-B 前端重画"二拆，但默认单 PR。
