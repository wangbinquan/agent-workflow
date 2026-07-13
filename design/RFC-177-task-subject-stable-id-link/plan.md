# RFC-177 — 任务分解

单 PR（小、零 migration）。前缀 `fix(app): RFC-177 …`。

## 子任务

### RFC-177-T1 — 列表投影补 `sourceAgentId`（后端）
- `schemas/task.ts`：`TaskSummarySchema` 增 `sourceAgentId`（nullable optional，注释同详情）。
- `services/task.ts` `rowToSummary`：`sourceAgentId: row.sourceAgentId ?? null`（镜像 rowToTask:3043）。
- 测试：扩 `tasks-list-workgroup-name.test.ts`（或同族）断言 `listTasks` 行带 `sourceAgentId`。
- 依赖：无。

### RFC-177-T2 — by-id 解析端点（后端）
- `routes/workgroups.ts`：`GET /api/workgroups/by-id/:id` → `{name}` | 404（同形），复用现有可见性门。
- `routes/agents.ts`：`GET /api/agents/by-id/:id` → `{name}` | 404，复用 agent 可见性门。
- 服务层：若无现成「按 id + 可见权取一」helper，则加最薄一层，复用 `resourceAcl.ts` 谓词（不新写 ACL）。
- 测试：可见→name；不可见→404 同形；不存在→404；跨用户 ACL。
- 依赖：无。

### RFC-177-T3 — by-id 前端路由（前端）
- 泛型内核 `components/ResourceByIdRedirect.tsx`（或 `routes/` 内）：参数化 endpoint + 目标路由，
  `useQuery` 解析 → `<Navigate replace>`；loading→`LoadingState`；404/err→`EmptyState`/`ErrorBanner`。
- 注册 `/workgroups/by-id/$id`、`/agents/by-id/$id` 两路由。
- 测试（RTL+mock fetch）：解析成功跳规范名页；404→不可用态；两资源各一遍。
- 依赖：T2（运行期），但路由注册可先行；typecheck 需目标名路由已存在（`/workgroups/$name` 等已存在）。

### RFC-177-T4 — `TaskSubjectLink` 按 id 链接（前端）
- `TaskSubjectFields` 增 `sourceAgentId?`。
- 链接目标改按 §设计表：workgroup→`/workgroups/by-id/$id`；agent 有 id→`/agents/by-id/$id`；
  agent 无 id（历史）→`/agents/$name`（D3a）；workflow 不变；文案恒冻结名；em-dash/badge 不变。
- 依赖：T1（列表 row 带 sourceAgentId）+ T3（by-id 路由存在，`to=` 才能 typecheck 过）。

### RFC-177-T5 — source-lock 测试更新（前端）
- `task-subject-link.test.tsx`：断言新 by-id 目标 + D3a 分支 + 无锚点泄漏 + 文案=冻结名。
- `tasks-workflow-name.test.ts` / `tasks-workgroup-badge.test.ts`：若断言旧 `/workgroups/$name`
  等目标，改为新目标（或改锁「委托组件」层）。
- 依赖：T4。

### RFC-177-T6 — 门禁 + Codex 实现门
- 五门全绿（typecheck/lint/前端 vitest/后端 bun test/format）+ build smoke。
- 确认零新 migration（不动 journal-count 锁）。
- Codex 实现门复核（隔离审本 PR commit）；折 findings。
- 依赖：T1–T5。

## PR 拆分
单 PR（T1–T6）。改动面小且互相耦合（链接目标 ↔ 路由 ↔ 投影字段），拆分反增协调成本。

## 验收清单
- [ ] 工作组任务链接经 `workgroupId` 解析，改名后落当前名页；已删/不可见→not-found 同形。
- [ ] 单代理任务（有 sourceAgentId）经 id 解析；历史（无 id）按 D3a 按名链接、不误识别、不 5xx。
- [ ] 链接文案恒为冻结名；任务负载不新增 live 资源字段（ACL 不变量守住）。
- [ ] `TaskSummary` 带 `sourceAgentId`；列表 + 详情行为一致。
- [ ] by-id 端点：可见→name、不可见/不存在→404 同形。
- [ ] 五门全绿、零新 migration、Codex 实现门折清。

## 备注（RFC 卫生）
- 编号 **RFC-177**（176 已被 `workgroup-goal-directive` 占用）。
- 无需新 migration：`tasks.source_agent_id`（RFC-175）+ `tasks.workgroup_id`（RFC-164）已具备。
- 承接 `6907d6ef`（主体不再泄漏锚点）+ `1c26b56d`（P2 取舍注释存档）——本 RFC 把 P2 从「存档」升为「真修」。
