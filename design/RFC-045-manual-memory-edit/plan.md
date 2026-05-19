# RFC-045 — Plan

> 配套 proposal.md / design.md。落地任务编号 `RFC-045-T1..T9`，默认单 PR。

## 任务分解

### Shared 层

- **RFC-045-T1**：`packages/shared/src/schemas/permission.ts` 在 `PERMISSIONS` 数组追加
  `'memory:edit'`；`admin` 角色自动包含；`USER_BASELINE` 不动。
  - 验收：`PermissionSchema` 接受 `'memory:edit'`；`hasPermission('admin','memory:edit')`
    返 true；`hasPermission('user','memory:edit')` 返 false；`ADMIN_ONLY_PERMISSIONS` 含
    `'memory:edit'`。
  - 测试：既有 `permission.test.ts` 自动覆盖；快照测试若 lock 了 `ADMIN_ONLY_PERMISSIONS`
    数组顺序，更新快照。
  - 依赖：无。

- **RFC-045-T2**：`packages/shared/src/schemas/memory.ts` 新增 `MemoryPatchRequestSchema` +
  导出 `MemoryPatchRequest` 类型。schema 细节见 design.md §3。
  - 验收：全空 / 单字段 / 跨字段互斥 / tag 16+1 / title 边界 / bodyMd 边界 全部测过。
  - 测试：新文件 `shared/tests/memory-patch-schema.test.ts`（约 10 case）。
  - 依赖：无。

- **RFC-045-T3**：`packages/shared/src/schemas/ws.ts` `MemoryWsMessageSchema` 增加
  `memory.updated` case（含 `memoryId` / `changedFields` / `version`）。
  - 验收：合法 case 通过；空 changedFields 拒；version<2 拒；未知 changedFields enum 拒。
  - 测试：新文件 `shared/tests/memory-ws-updated.test.ts`（约 4 case）。
  - 依赖：无。

### Backend 层

- **RFC-045-T4**：`packages/backend/src/services/memory.ts` 新增 `patchMemory(db, id, input)`
  函数。流程见 design.md §4.2（SELECT → 状态校验 → 合成 → MemorySchema 二次校验 → diff →
  UPDATE + version + WS publish）。
  - 验收：8 个 service case（design.md §8.2 第一栏）全绿；`memory-edited` log 行含
    `editedBy`（从 actor 上下文）/ `fieldsChanged`。
  - 测试：新文件 `backend/tests/memory-service-patch.test.ts`。
  - 依赖：T2。

- **RFC-045-T5**：`packages/backend/src/routes/memories.ts` 注册
  `app.patch('/api/memories/:id', requirePermission('memory:edit'), ...)`。
  - 验收：403 / 404 / 422 / 409 / 200 路径全过；RFC-046 历史快照不变量 byte-equal 锁。
  - 测试：新文件 `backend/tests/routes-memories-patch.test.ts`。
  - 依赖：T1 + T4。

- **RFC-045-T6**：`packages/backend/tests/memory-permissions.test.ts`（若不存在则新建）锁
  `memory:edit ∈ ADMIN_ONLY_PERMISSIONS`，`memory:edit ∉ USER_BASELINE`。
  - 依赖：T1。

### Frontend 层

- **RFC-045-T7**：`packages/frontend/src/components/memory/MemoryFormFields.tsx`（受控 form
  字段集合 + `useMemoryFormState` hook）。零网络调用，数据由父传入。
  - 验收：表单字段全渲染；scope 切换正确显隐 scope_id；tag chip input 支持回车/逗号添加 +
    删除；form-level zod 校验输出友好 message。
  - 测试：新文件 `frontend/tests/memory-form-fields.test.tsx`（约 8 case）。

- **RFC-045-T8**：
  - `components/memory/MemoryNewDialog.tsx`（顶栏入口的 dialog）→ POST + close + 切 tab。
  - `components/memory/MemoryEditDialog.tsx`（行级入口的 dialog）→ PATCH + close + invalidate。
  - `routes/memory.tsx` 顶栏右侧 `[+ New memory]` 按钮（仅 admin）+ 状态管理。
  - `components/memory/MemoryApprovalQueue.tsx::CandidateCard` 加 `[Edit]` 按钮 +
    EditDialog wiring。
  - `components/memory/MemoryRow.tsx` 接受 `onEdit?` prop。
  - `components/memory/MemoryAllList.tsx` / `MemoryScopedList.tsx` / `MemoryByScopeBrowser.tsx`
    / 详情页（如有 scope-detail）传 `onEdit` + dialog 状态。
  - i18n 中英各加 design.md §6.3 的 12 key。
  - 验收：design.md §8.3 五个 frontend test 全绿；admin 看得到所有入口、user 看不到。
  - 测试：新建
    - `frontend/tests/memory-new-dialog.test.tsx`
    - `frontend/tests/memory-edit-dialog.test.tsx`
    - `frontend/tests/memory-page-new-button.test.tsx`
    - `frontend/tests/memory-row-edit-button.test.tsx`
  - 依赖：T2 + T3 + T5 + T7。

### E2E

- **RFC-045-T9**：`packages/e2e/specs/memory-manual-create-edit.spec.ts`（步骤 design.md §8.4）。
  - 依赖：T8 全部落地。

## PR 拆分建议

**默认单 PR**（commit prefix：`feat(memory): RFC-045 manual create + edit`）。

可选拆分（reviewer 要求时）：
- PR1 `feat(memory): RFC-045 backend + schema`：T1–T6（含 backend test）。
  - 风险：合并后 backend 多一个未使用的 PATCH 路由；前端旧 UI 无影响。
- PR2 `feat(memory): RFC-045 frontend + e2e`：T7–T9。
  - 依赖：PR1 已合（前端要调 PATCH）。

## 验收 checklist（PR 合并前自检）

- [ ] `bun run typecheck` 0 errors
- [ ] `bun run test` 全绿（新增 ~37 case：shared 14 / backend 13+权限 1 / frontend ~30 /
      e2e 1，合并大致 ~37 严格按 design §8 列表）
- [ ] `bun run format:check` All matched files
- [ ] `MemorySchema` 字段语义无变化（只是新增 PATCH 路径写法）
- [ ] `useMemoryWs` hook 零代码改动（已 startsWith 全量 invalidate）
- [ ] backend log 含 `memory-edited` 行可 grep
- [ ] 顶栏 `[+ New memory]` 仅 admin 可见（user 测过断言不存在）
- [ ] `[Edit]` 按钮在 candidate / approved / archived 行渲染；superseded / rejected 行不渲染
- [ ] PATCH 后下一次 `runNode` inject 读到最新 body / scope（手测 + RFC-041 既有 live-read
      路径，无需新代码）
- [ ] `node_runs.injected_memories_json` PATCH 后 byte-equal（RFC-046 历史快照不变量）
- [ ] design.md §10 度量 log 行落地
- [ ] STATE.md 顶部"进行中 RFC"指针在 RFC 启动时已加，合并时移除并在已完成 issue 表加一行
- [ ] design/plan.md RFC 索引行状态从 Draft → In Progress → Done（PR 合并后）
- [ ] CLAUDE.md `feedback_post_commit_ci_check` 流程：push 后查 GitHub Actions CI 状态

## 多人协作注意事项（CLAUDE.md 强约束）

- `design/RFC-045-manual-memory-edit/proposal.md` 是当前 session 同步改的（扩 create + edit）。
- 同期可能并行的 RFC：当前 working tree clean，但 main 上 RFC-044 / RFC-046 都已合 → 与本
  RFC 在 service / route 层无文件级冲突；唯一共享文件：
  - `packages/shared/src/schemas/memory.ts`（与 RFC-046 共享，本 RFC 加 `MemoryPatchRequest`，
    不动 `InjectedMemorySnapshot`）；
  - `packages/shared/src/schemas/ws.ts`（与 RFC-046 共享，本 RFC 加 `memory.updated` case，
    不动其他 case）；
  - `packages/backend/src/routes/memories.ts`（本 RFC 加 PATCH，不动既有 POST/GET）；
  - `packages/backend/src/services/memory.ts`（本 RFC 加 `patchMemory`，不动既有函数）；
  - `packages/frontend/src/components/memory/MemoryRow.tsx`（本 RFC 加 `onEdit?` prop，签名
    向后兼容）。
- 若另一 RFC 在 working tree 留了未追踪文件，按 CLAUDE.md "多人协作并发改动保留原则" 处理：
  - 不删别人的代码 / 文件 / 索引条目；
  - 自己的新文件按路径精确 `git add`，不用 `git add -A`；
  - commit message 只描述本 RFC 改动。
