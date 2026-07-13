# RFC-177 — 技术设计

## 1. 总览

`TaskSubjectLink` 从「按冻结名链接」改为「按冻结稳定 id 链接」。id 在渲染期**不**解析
（守 RFC-099 冻结名不变量：任务负载不携带 live 资源状态）；解析发生在**用户点击后**、由
一个新的 by-id 前端路由 + ACL-gated 后端端点完成，解析成功即重定向到资源当前规范名页。

```
任务负载(冻结: workgroupId / sourceAgentId + 冻结名文案)
        │  渲染期零 lookup
        ▼
<TaskSubjectLink>  ── 文案=冻结名 ──▶  <Link to="/workgroups/by-id/$id">
        │  用户点击
        ▼
/workgroups/by-id/$id (前端路由)
        │  GET /api/workgroups/by-id/:id   ← ACL-gated（不可见→404 同不存在）
        ▼
  200 {name} → <Navigate replace to="/workgroups/$name">   （规范名页，正确资源）
  404        → 「资源不可用」态（EmptyState/ErrorBanner，与现状同形）
```

## 2. 后端

### 2.1 id 解析端点（新增）

两个只读端点，复用各自资源既有的**按查看者可见权** ACL 门（与 `GET /:name` 同一门）：

- `GET /api/workgroups/by-id/:id` → `200 { name: string }` 若存在且对查看者可见；否则
  `404`（与「不存在」**同形**，RFC-099 D1：不可见=不存在）。
- `GET /api/agents/by-id/:id` → `200 { name: string }` 或 `404`（同形）。

契约要点：
- 只回 `{ name }`（前端据此重定向到规范名页；不回整资源，避免第二处 ACL 投影面）。
- **绝不**泄漏存在性差异：不可见与不存在都是 `404`，body 同形。
- 服务层复用现有可见性判定（工作组：`getVisibleWorkgroup`/`assertWorkgroupVisible` 同款；
  代理：agents 列表/详情的同一 ACL 谓词）——不新写 ACL 逻辑（单一事实源 `resourceAcl.ts`）。

### 2.2 `TaskSummary` 补 `sourceAgentId`

列表投影缺 `sourceAgentId`（详情 `TaskSchema` 已有）。加：

- `schemas/task.ts`：`TaskSummarySchema` 增 `sourceAgentId: z.string().nullable().optional()`
  （与详情同注释；`.optional()` 向后兼容旧 fixture）。
- `services/task.ts` `rowToSummary`：`sourceAgentId: row.sourceAgentId ?? null`（镜像
  `rowToTask` 第 3043 行）。

无 migration（列已由 RFC-175 存在）。

## 3. 前端

### 3.1 by-id 解析路由（新增）

`/workgroups/by-id/$id` 与 `/agents/by-id/$id`——极薄「解析即跳转」组件：

```tsx
function WorkgroupByIdRedirect() {
  const { id } = Route.useParams()
  const q = useQuery({ queryKey: ['workgroups','by-id',id],
    queryFn: ({signal}) => api.get(`/api/workgroups/by-id/${encodeURIComponent(id)}`, undefined, signal) })
  if (q.isLoading) return <LoadingState/>
  if (q.error || q.data == null) return <EmptyState .../> // 不可用（404 同形）
  return <Navigate to="/workgroups/$name" params={{ name: q.data.name }} replace />
}
```

- 复用公共 `LoadingState` / `EmptyState` / `ErrorBanner`（禁自写 chrome，遵前端一致性铁律）。
- `replace`：不在浏览器历史留 by-id 中转项。
- agent 路由同构（`/api/agents/by-id/:id` → `/agents/$name`）。
- 两者共享一个泛型内核 `<ResourceByIdRedirect kind=…>` 以免 fork（endpoint + 目标路由参数化）。

### 3.2 `TaskSubjectLink`（改链接目标；文案不变）

`TaskSubjectFields` 增 `sourceAgentId?: string | null`（已有 `workgroupId?`）。链接分支：

| kind | 链接目标 | 文案 | 备注 |
|---|---|---|---|
| workflow | `/workflows/$id`（`workflowId`） | `workflowName ?? workflowId` | 不变 |
| workgroup | `/workgroups/by-id/$id`（`workgroupId`） | `workgroupName` | id 恒有；name 为 null→em-dash 无链接（同现状） |
| agent + `sourceAgentId` 非空 | `/agents/by-id/$id`（`sourceAgentId`） | `sourceAgentName` | 新任务 |
| agent + `sourceAgentId` 空（历史） | `/agents/$name`（`sourceAgentName`）**D3(a)** | `sourceAgentName` | 历史降级：按名（对现状零回归） |

- 文案恒为冻结名（D2）。badge / `.task-workflow-cell` / em-dash 降级逻辑不变。
- workgroup `workgroupName` 为 null（冻结配置损坏）时：em-dash 文案 + 无链接（保持现状；
  不因「id 有」就渲一个文案为破折号的链接）。

## 4. 耦合点

- `components/TaskSubjectLink.tsx`（唯一渲染点，列表+详情自动一致）。
- `schemas/task.ts` `TaskSummarySchema` + `services/task.ts` `rowToSummary`（补 sourceAgentId）。
- `routes/workgroups.ts` + `routes/agents.ts`（新增 by-id 端点）。
- 前端路由注册（新增两条 by-id 路由 + 泛型内核组件）。
- 复用：资源 ACL 可见性谓词（`resourceAcl.ts`）、`LoadingState/EmptyState`、TanStack `<Navigate>`。

## 5. 失败模式

| 场景 | 行为 |
|---|---|
| id 指向查看者不可见的资源 | 端点 404（同不存在）→ by-id 路由「不可用」态。不泄漏存在性。 |
| id 指向已删资源 | 同上 404 → 「不可用」态（诚实反映已删）。 |
| 工作组 `workgroupName` 为 null（配置损坏）但 id 有 | em-dash 文案、无链接（现状保持）。 |
| 历史 agent `sourceAgentId` 为 null | D3(a)：按名链接（`/agents/$name`），与 `6907d6ef` 现状一致。 |
| by-id 解析网络错误 | by-id 路由 error 态（ErrorBanner）。 |
| 渲染期是否 lookup？ | **否**。渲染零网络；解析只在点击后。ACL 冻结名不变量守住。 |

## 6. 与 ACL 不变量的关系（守住）

- 任务负载（list/detail）**不新增**任何 live 资源字段：仍只有冻结的 `workgroupId` /
  `workgroupName` / `sourceAgentId` / `sourceAgentName`。id 是随机 ULID，不暴露资源名/状态。
- 当前名只在**用户主动点击并有可见权**时、经 ACL-gated 端点披露给该查看者本人——不进任务
  负载、不广播给无可见权协作者。故不回退 RFC-099「冻结名不 live-join」不变量。
- 链接文案与 URL 可短暂不一致（文案=冻结旧名，跳转落到当前名页）——有意为之：文案守 ACL
  + 与聊天室一致，跳转守正确性。

## 7. 测试策略（必写）

**前端 `TaskSubjectLink`（RTL 行为，扩充现有 `task-subject-link.test.tsx`）**
- 工作组任务 → `href = /workgroups/by-id/<workgroupId>`、文案=组名、badge；无 `__workgroup_host__` 泄漏。
- agent 任务（有 sourceAgentId）→ `href = /agents/by-id/<sourceAgentId>`、文案=agent 名、badge。
- agent 任务（无 sourceAgentId，历史）→ `href = /agents/<name>`（D3a）。
- workflow 任务 → `/workflows/<id>` 不变。
- 工作组 name 为 null → em-dash、无 link。
- `badge=false`（详情元信息）→ 裸链接、无 badge。

**前端 by-id 路由（RTL + mock fetch）**
- 解析成功 → `<Navigate>` 到 `/workgroups/$name`（断言落地路由/参数）。
- 404 → 「不可用」态、不跳转。
- 泛型内核对 agents 同构一遍。

**后端**
- `GET /api/workgroups/by-id/:id`：可见→`{name}`；不可见→404 同形；不存在→404。
- `GET /api/agents/by-id/:id`：同上。
- `rowToSummary` 投影 `sourceAgentId`（扩 `tasks-list-workgroup-name.test.ts` 或新测）。

**source-lock 更新**
- 现有 `task-subject-link.test.tsx` / `tasks-workflow-name.test.ts` / `tasks-workgroup-badge.test.ts`
  中断言旧链接目标（`/workgroups/$name`、`/agents/$name`）的用例，改为新 by-id 目标 + D3a 分支。

**门槛**：五门全绿 + 无新 migration（不触发 journal-count 锁）。

## 8. 备选与取舍

- **前端列表自解析（零后端）**：by-id 路由改为拉 `GET /api/workgroups`（ACL 已过滤）扫 id→name。
  省两个端点，但 O(n)+多传列表；rare 点击场景可接受。**否决**：语义不如专用端点清晰、且列表大时浪费。
- **后端读时按 id 投影当前名（Option 3）**：已被用户否决（回退 ACL 不变量）。
- **纯文本去链接（Option 2）**：已被用户否决（失去跳转入口）。
