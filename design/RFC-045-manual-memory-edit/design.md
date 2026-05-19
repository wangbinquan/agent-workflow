# RFC-045 — Design

> 配套 proposal.md。本文给接口契约、数据流、与现有模块的耦合点、失败模式、测试策略。

## 1. 范围回顾

两条能力合一：

- (A) Create — 顶栏 `[+ New memory]`，后端零新增（沿用 `POST /api/memories` +
  `MemoryCreateRequestSchema`）。
- (B) Edit — 新 `PATCH /api/memories/:id` + 新权限位 `memory:edit` + 新 WS 事件
  `memory.updated`，覆盖 candidate / approved / archived 三态；approved 原地 `version += 1`。

## 2. 数据模型

**零 migration**：`memories` 表已具备所有必要列（`version INTEGER NOT NULL DEFAULT 1` 自
RFC-041 起就在）。

不变量：
- `version` 含义保持 RFC-041 设计——只在以下三处增长：
  1. `promoteCandidate(action='approve_and_supersede')`：取被 supersede 的所有 target 最大
     version + 1。
  2. （本 RFC 新增）`patchMemory`：当成功修改 ≥1 个字段时 `version += 1`。
  3. 其他写路径（`createManualCandidate` / 单纯 `approve` / `archive` / `unarchive`）不动
     `version`。
- `approved_at` / `approved_by_user_id`：本 RFC PATCH **不改动**。它们记的是"何时被 approve、
  谁 approve 的"，与"何时被人工编辑"是两件事；如未来要回答"上次被人改是何时"需另开 `edited_at`
  列（v1 非目标）。

## 3. Shared schemas

`packages/shared/src/schemas/memory.ts` 新增：

```ts
// 4 字段全可选；后端会拒绝"全空" body。校验逻辑与 MemoryCreateRequestSchema 一致：
// global ↔ scope_id null 互斥。
export const MemoryPatchRequestSchema = z
  .object({
    scopeType: MemoryScopeSchema.optional(),
    scopeId: z.string().nullable().optional(), // explicit null allowed for global
    title: z.string().trim().min(1).max(120).optional(),
    bodyMd: z.string().trim().min(1).max(4000).optional(),
    tags: z.array(z.string().min(1).max(40)).max(16).optional(),
  })
  .superRefine((v, ctx) => {
    // (a) 至少一个字段
    if (
      v.scopeType === undefined &&
      v.scopeId === undefined &&
      v.title === undefined &&
      v.bodyMd === undefined &&
      v.tags === undefined
    ) {
      ctx.addIssue({ code: 'custom', message: 'patch must include at least one field', path: [] })
    }
    // (b) scope_type 与 scope_id 互斥规则——只在两者同时出现时校验
    if (v.scopeType !== undefined && v.scopeId !== undefined) {
      if (v.scopeType === 'global' && v.scopeId !== null) {
        ctx.addIssue({ code: 'custom', message: 'global scope must have scopeId=null', path: ['scopeId'] })
      }
      if (v.scopeType !== 'global' && (v.scopeId === null || v.scopeId === '')) {
        ctx.addIssue({ code: 'custom', message: 'non-global scope requires scopeId', path: ['scopeId'] })
      }
    }
    // (c) scope_type 改了但 scope_id 没传 → 后端会按当前行 scope_id 验证；schema 不在这一步
    //     拒，路由层用"合成后再过 MemorySchema"二次校验，见 §4.2。
  })
export type MemoryPatchRequest = z.infer<typeof MemoryPatchRequestSchema>
```

`packages/shared/src/schemas/ws.ts` `MemoryWsMessageSchema` 增加：

```ts
z.object({
  type: z.literal('memory.updated'),
  memoryId: z.string(),
  /** Names of fields that changed in this PATCH (subset of {scopeType,scopeId,title,bodyMd,tags}). */
  changedFields: z
    .array(z.enum(['scopeType', 'scopeId', 'title', 'bodyMd', 'tags']))
    .min(1)
    .max(5),
  /** Resulting version (>= 2 — version 1 belongs to creation/approve, never to PATCH). */
  version: z.number().int().min(2),
})
```

`changedFields` 让前端可以做条件 toast（"已更新 scope 与 tags"）而无需重新 fetch detail。

## 4. Backend

### 4.1 权限位

`packages/shared/src/schemas/permission.ts`：

```ts
export const PERMISSIONS = [
  // ...
  'memory:read',
  'memory:approve',
  'memory:archive',
  'memory:delete',
  'memory:write_feedback',
  'memory:edit', // ← 新增，admin only
] as const
```

`ROLE_PERMISSIONS.admin` 自动包含（`...PERMISSIONS`）。`USER_BASELINE` 不动。
`ADMIN_ONLY_PERMISSIONS` 快照测试会自动把 `memory:edit` 落入"不可发给 user"组——刷新快照即可。

### 4.2 服务层 `services/memory.ts`

新函数：

```ts
export interface PatchMemoryInput {
  scopeType?: MemoryScope
  scopeId?: string | null
  title?: string
  bodyMd?: string
  tags?: string[]
}

export interface PatchMemoryResult {
  memory: Memory
  changedFields: ReadonlyArray<'scopeType' | 'scopeId' | 'title' | 'bodyMd' | 'tags'>
}

export async function patchMemory(
  db: DbClient,
  id: string,
  input: PatchMemoryInput,
): Promise<PatchMemoryResult>
```

流程（单事务）：

1. SELECT 当前行；不存在 → `NotFoundError('memory-not-found')`。
2. 校验 status：`row.status ∈ {'superseded','rejected'}` → `ConflictError
   ('memory-terminal-status', ...)`。
3. 计算 *合成后的行*（把每个 `input.X !== undefined` 字段叠到 row 上）：
   - scope_type 给了但 scope_id 没给：保留原 scope_id（路由前端通常会一起传，但服务层做防御）。
   - 走一次 `MemorySchema.parse(synthRow)`——这一遍捕获"改成 global 但 scope_id 没清空"等
     schema 级矛盾，统一 `ValidationError('invalid-body', issues)`。
4. 比对 *合成后* 与 *原行* 的 5 字段，组装 `changedFields`：
   - tags 用"内容相同序"比对（JSON.stringify(sorted) 比对）以避免顺序差异引出虚假 change。
   - 若 `changedFields.length === 0` → 直接返回原行，`version` 不动，不写 WS。
     （视为 idempotent；route 层照旧 200。）
5. UPDATE 同一 row：set 5 字段中实际变了的 + `version = row.version + 1`；其他列保持。
6. `publish({ type: 'memory.updated', memoryId: id, changedFields, version: row.version + 1 })`。
7. SELECT 后返回 `{ memory, changedFields }`。

幂等性：`changedFields.length === 0` 的 PATCH 不计 version、不发 WS——这是最自然的"重复 save
同一表单"语义。route 层不需要单独处理。

### 4.3 路由 `routes/memories.ts`

新增：

```ts
app.patch('/api/memories/:id', requirePermission('memory:edit'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = MemoryPatchRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new ValidationError('invalid-body', 'invalid patch request', parsed.error.format())
  }
  const result = await patchMemory(deps.db, id, parsed.data)
  return c.json({ memory: result.memory, changedFields: result.changedFields })
})
```

错误码表：

| 场景 | HTTP | code |
|------|------|------|
| body 解析失败 / 全空 / 单字段越界 | 422 | `invalid-body` |
| scope_type/scope_id 合成后违反 schema | 422 | `invalid-body` |
| `:id` 不存在 | 404 | `memory-not-found` |
| status ∈ {superseded, rejected} | 409 | `memory-terminal-status` |
| 调用方无 `memory:edit` | 403 | `permission-denied`（既有中间件） |

### 4.4 既有路由不动

`POST /api/memories` 仍是 `memory:approve`（见 proposal §2.1.A）。其他路由权限位 / 状态机
零变更。

## 5. Runtime / WS 影响

### 5.1 Inject live read

`services/memoryInject.ts::loadInjectableMemories` 在 runner 启动每个节点时实时 SELECT
`memories where status='approved' and (scope match)`，所以 PATCH 后下一次 `runNode` 自然读到
最新 title / body / scope / tags。**无需新代码**。

### 5.2 Followup attempt 继承

RFC-042 envelope-followup 路径 + RFC-046 attempt-0 sibling copy 已经保证："同一 opencode
session 的 retry 行继承 attempt 0 的 `injected_memories_json` 快照"——这条规则与本 RFC 无关。
即便 admin 在两次 retry 之间编辑了 memory，attempt N (N>0) 的 `injected_memories_json` 仍然指
向 attempt 0 时刻的快照（按 RFC-046 §设计就是这样）。design 不需要新加逻辑。

### 5.3 WS broadcaster

`services/memory.ts::publish` 是既有 `memoryBroadcaster.broadcast(MEMORY_CHANNEL, msg)`，新 case
直接复用。`useMemoryWs` hook 已经 `msg.type.startsWith('memory.')` 全量 invalidate；新事件零
hook 改动即生效。但要在 schema 显式 enum 出 `memory.updated`，否则 schema 校验测试会拒绝未知
type。

### 5.4 RFC-046 历史快照不变量

PATCH **不**改任何 `node_runs.injected_memories_json` 行。`injected_memories_json` 是 inject
那一刻的冻结快照（按 RFC-046 §design.md §3.1：捕获 verbatim 字段），后续编辑只影响**未来**的
inject，**不**回填历史。前端在 InjectedMemoriesCard 渲染时，如果当前 memory 行 version >
snapshot 行 version，可以加一条 "Updated since this attempt (now v{N})" 灰底 chip——但这是
RFC-046 follow-up，不在本 RFC 范围内。本 RFC 只确保 *后端* 不破坏这条不变量。

design 层落锁：测试 `routes-memories-patch.test.ts` 加一个 "PATCH does not touch node_runs"
case——seed 一条 attempt-0 row（含 `injected_memories_json`），PATCH 该 memory，断言
`SELECT injected_memories_json FROM node_runs WHERE id = ?` 文本 byte-equal。

## 6. Frontend

### 6.1 新组件

- `components/memory/MemoryFormFields.tsx`：受控 form 字段集合（scope_type radio / scope_id
  dropdown / title input / bodyMd textarea / tags chip input），导出 `useMemoryFormState` hook
  让 dialog 容器各自管 state。零 API 调用（dropdown 数据由父组件传入）。
- `components/memory/MemoryNewDialog.tsx`：复用 shared `<Dialog>` chrome，内嵌
  `MemoryFormFields`。Save → `api.post<{memory}>('/api/memories', payload)` → close + tab
  switch + invalidate。
- `components/memory/MemoryEditDialog.tsx`：与 `MemoryNewDialog` 共享 `MemoryFormFields`，但
  接受 `initialMemory: Memory` + `mode: 'edit'`。Save → `api.patch<{memory, changedFields}>
  ('/api/memories/:id', diff)`：
  - 前端在 client 侧也算一次 diff，仅把 *用户实际改过* 的字段上传——后端再算一遍做兜底（防止
    用户没改但点了 Save）。
  - 422 / 404 / 409 错误 banner 在 dialog 顶部渲染，不关 dialog。
  - changedFields.length === 0（后端 idempotent） → 也关 dialog，但不弹 toast，避免"我没改但
    被告知已保存"的违和感。

### 6.2 入口位置

- 顶栏：`routes/memory.tsx` `<header className="page__header">` 内右侧加 `[+ New memory]`
  按钮（admin only）。
- Approval Queue 卡片：`MemoryApprovalQueue.tsx::CandidateCard` 的 `<footer>` 最左侧加
  `[Edit]` 按钮（admin only），点开 EditDialog。Edit 与 [Reject]/[Approve] 并列；mobile
  CSS 下按钮高度一致。
- All / by-scope / scope-detail：`MemoryRow` 接受 `onEdit?: () => void` prop，在 actions slot
  前部插入 `[Edit]` 按钮（仅 status ∈ {candidate, approved, archived}）。父组件
  `MemoryAllList` / `MemoryScopedList` / scope-detail 负责传 `onEdit` 与 dialog 状态。

### 6.3 i18n key（中英各加）

```
memory.action.new           "+ New memory"        / "+ 新建记忆"
memory.action.edit          "Edit"                / "编辑"
memory.newDialogTitle       "New memory"          / "新建记忆"
memory.editDialogTitle      "Edit memory"         / "编辑记忆"
memory.form.scopeType       "Scope"               / "作用域"
memory.form.scopeId         "Scope target"        / "作用域目标"
memory.form.title           "Title"               / "标题"
memory.form.bodyMd          "Body (markdown)"     / "正文（markdown）"
memory.form.tags            "Tags"                / "标签"
memory.form.tagsHint        "Comma or enter to add (max 16)" / "逗号/回车分隔，最多 16 个"
memory.form.scopeIdGlobal   "(global — no target)" / "（global — 无目标）"
memory.form.errBodyEmpty    "Body cannot be empty" / "正文不能为空"
memory.form.errTagsTooMany  "Too many tags (max 16)" / "标签超出上限（16 个）"
memory.error.terminalStatus "This memory is in a terminal state and cannot be edited" /
                            "该记忆已是终态，不可编辑"
```

### 6.4 useMemoryWs

无需改 hook 逻辑——`startsWith('memory.')` 已经覆盖 `memory.updated`。但要给 `MEMORY_QUERY_KEYS`
加 `detail` 时已经处理；当前 `memoryId` 抽取分支已经覆盖"`memoryId` 字段在 msg 上"路径，
`memory.updated` 也带 `memoryId` 因此 detail invalidation 也工作。

## 7. 失败模式

| 场景 | 处理 |
|------|------|
| 网络中断时 admin 点 Save | API client 抛 NetworkError → dialog ErrorBanner 渲染、不关 dialog；admin 可重试。 |
| 并发：admin A 点 Approve、admin B 同时点 Edit 改 body | 后端 PATCH 走单事务、SELECT-then-UPDATE 不加行锁（SQLite WAL + 短事务通常 ms 级）。如果 PATCH 落在 promote 之前 → 修的是 candidate 行 → promote 时模板看到改过的内容（OK）。如果 PATCH 落在 promote 之后 → 修的是 approved 行 → version 从 1 → 2（OK）。若 A 的 promote 把 row 写成 superseded（极小概率，且 supersede 链的 target 必须是 approved），B 的 PATCH 在 step 2 命中 `memory-terminal-status` 409；前端 banner 提示，admin 刷新页面即可。 |
| admin 把 scope_type 改成 global 但忘改 scope_id | superRefine + 合成校验在路由层 422；dialog 顶部 banner 高亮 scope_id 字段。 |
| admin 把 tags 减成 16+1 条 | superRefine 422，dialog 顶部 banner。 |
| 后端 5xx | dialog 顶部 generic error，admin 重试。inject 路径不受影响（live read 容错）。 |
| WS broker 偶发掉包 | 列表会在 30s focus-refetch 兜底；admin 切 tab 也强制 invalidate。 |
| RFC-046 InjectedMemoriesCard 历史快照 与 PATCH 后的当前行不一致 | 这是设计的预期（"看到 session 当时用了哪个版本"）。本 RFC 不修；如需 UI 提示由 RFC-046 follow-up 加。 |

## 8. 测试策略

### 8.1 Shared

- `shared/tests/memory-patch-schema.test.ts`：
  - 全空 → 拒；
  - 仅 title → 接受；
  - scope_type=global + scope_id="x" → 拒；
  - scope_type=global + scope_id=null → 接受；
  - tags 17 条 → 拒；
  - title 0 字符 → 拒；
  - bodyMd 5000 字符 → 拒；
  - 未知字段（`{title:"x", foo:"bar"}`）→ zod 默认 strip，接受（路由层只读已知字段）。
- `shared/tests/memory-ws-updated.test.ts`：
  - schema 接受新 `memory.updated` case；
  - `changedFields` 为空数组 → 拒（min(1)）；
  - `changedFields` 含未知 enum 值 → 拒；
  - `version=1` → 拒（min(2)）。

### 8.2 Backend

- `tests/memory-service-patch.test.ts`：
  - candidate 行 PATCH title → version 1 → 2，WS broadcast；
  - approved 行 PATCH bodyMd → version bumped；approved_at / approved_by_user_id 不变；
  - archived 行 PATCH scope_type → 成功；
  - PATCH 没改任何字段 → version 不动，WS 不广播；返回值 changedFields=[]；
  - terminal status (superseded / rejected) → 409 `memory-terminal-status`；
  - 不存在 id → 404 `memory-not-found`；
  - 合成后违反 schema → 422 `invalid-body`；
  - source_kind / supersedes_id 等"系统列"PATCH 中带也被忽略（schema 拒未知字段，下不到 SQL）。
- `tests/routes-memories-patch.test.ts`：
  - permission：非 admin → 403；
  - 422 / 404 / 409 各 case；
  - 成功路径返回 `{ memory, changedFields }`；
  - **不变量锁**：PATCH 后 `SELECT injected_memories_json FROM node_runs` 文本 byte-equal
    （RFC-046 历史快照不被回填）。
- `tests/memory-permissions.test.ts`：
  - `ADMIN_ONLY_PERMISSIONS` 快照含 `memory:edit`；
  - `USER_BASELINE` 不含。

### 8.3 Frontend

- `tests/memory-edit-dialog.test.tsx`：
  - render 一个 approved memory → 4 字段预填；
  - 改 title 然后 Save → PATCH 请求 body 只含 title；
  - 把 scope_type 改成 global → scope_id 自动置空且禁用；
  - tags 输入 17 个 → form 校验阻止 submit；
  - 422 响应 → ErrorBanner 渲染、dialog 不关；
  - 成功响应 → dialog close + invalidateQueries。
- `tests/memory-new-dialog.test.tsx`：
  - 空表单 → Save 按钮 disabled；
  - 选 agent scope → 显示 agent 下拉；
  - Save 成功 → close + 路由切到 Approval Queue tab。
- `tests/memory-row-edit-button.test.tsx`：
  - approved / archived / candidate 行渲染 Edit 按钮；
  - superseded / rejected 行不渲染 Edit。
- `tests/memory-page-new-button.test.tsx`：
  - admin → 按钮可见；
  - user → 按钮不存在。

### 8.4 E2E

- `e2e/memory-manual-create-edit.spec.ts`：
  1. admin login → 顶栏点 `[+ New memory]`；
  2. 填表 scope=global / title / body / tags=["a","b"] / Save；
  3. Approval Queue tab 看到候选；
  4. 点 [Edit]，把 scope 改成 agent + 选某 agent → Save；
  5. 卡片刷新成 agent scope；
  6. 点 Approve → All tab 看到已批准 + scope=agent。

## 9. PR 拆分 / Risk

默认**单 PR**（plan.md §拆分建议同步）。理由：

- backend 与 frontend 完全自洽（PATCH 路由 + WS schema + dialog 三件），中间无 staged rollout
  价值；
- 不涉及 migration，没有"先发 schema 再发代码"的时序；
- e2e 覆盖端到端，无需中间状态。

若 reviewer 嫌单 PR diff 太大，可拆 (a) shared+backend 一个 PR（含 schema + service + route +
ws + 所有 backend test），(b) frontend 一个 PR（含 dialog + 入口 + e2e）。两者无强依赖，
backend 先合不会破坏前端旧行为（仅多一个未使用的路由）。

## 10. 度量

无运行时埋点新增——edit 频次可从 backend log 的 `memory-edited` 行抓（含 `editedBy` /
`fieldsChanged`，便于后续看"哪几个字段最容易被改"指导 distiller prompt 优化）。
