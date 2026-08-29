# RFC-342 实施计划 — Memory scope move 事务正确性

状态：In Progress（2026-08-29；本地候选完成，发布/hosted CI 未执行）。

## 1. 任务

### T0 — live source 与口径（Done）

- [x] 在 shared `main` 同步到 `69eaf95488c86c5190fd7ff1360cf272b7826979`；
- [x] 对照 RFC-294 P0-A、memory route/service/schema/injection/ACL；
- [x] 采用 candidate-only Move；approved/archived 返回 409；
- [x] 与 RFC-341/W3 协调 `server.ts`、migration 编号、schema 与 generator 临界区。

### T1 — content-only PATCH（Done）

- [x] shared schema 只保留 title/body/tags，并显式拒绝 scope keys；
- [x] service 再做 own-property 拒绝，不能由内部 caller 绕过 wire；
- [x] observer/log 移到 transaction 返回后；
- [x] route/service/schema/rollback tests 已写。

### T2 — trusted Move command（Done）

- [x] strict `MemoryMoveRequest` + expected version；
- [x] factory-minted direct `CommandContext` 与 opaque authority 解析；
- [x] route 从当前认证 principal 铸 context，不接 Actor/permission payload；
- [x] `server.ts` 只加一处 identity-access bootstrap wiring。

### T2b — existing UI consumer cutover（Done）

- [x] `MemoryEditDialog` 把 candidate scope 差异提交到 `POST /move`，generic PATCH 只带内容；
- [x] scope+content 同时变化时 Move 在前，content PATCH 在后；第二步失败时强制 memory cache refetch；
- [x] approved/archived scope 控件冻结并显示 candidate-only 说明；
- [x] pure command-plan、Move-only、Move→PATCH 顺序与 scope-freeze tests 已写。

### T3 — transaction、ACL 与 durable event（Done）

- [x] 同一 `dbTxSync` 重读 active account/grants、memory、old/new targets；
- [x] agent/workflow write-grant 判据与 repo/group/global bypass 判据；
- [x] 写前二次读取 target、authority 与 memory；
- [x] `(id,version)` CAS + candidate-only/no-op policy；
- [x] migration `0221`、journal idx 220、Drizzle schema 与同事务 receipt insert；
- [x] WS 只在 commit 后发布。

### T4 — proof corpus（Implemented）

- [x] old/new scope owner/read/write/foreign/bypass/PAT matrix tests 已写；
- [x] stale/status/target missing/no-op tests 已写；
- [x] target delete、authority drift、memory drift、after-write rollback tests 已写；
- [x] durable receipt 与 ghost WS assertions 已写；
- [x] move→promote→old/new prompt injection audience test 已写；
- [x] migration constraint test 已写。

### T5 — local lightweight validation（Done）

- [x] shared typecheck；
- [x] exact P0-A ESLint `--max-warnings 0`；
- [x] exact Prettier；
- [x] frontend typecheck；
- [x] migration SQL 用系统 SQLite fresh create + valid insert smoke；
- [x] backend typecheck（RFC-341 收口其在制诊断后全绿）；
- [x] 按项目约定不跑本地 Bun test/gate，以最终 exact-SHA hosted CI 为准。

### T6 — publication / hosted closeout（Pending）

- [ ] 与 RFC-341 协调 canonical generator 和 publication critical section；
- [ ] fetch/sync，确认 shared index 与 exact allowlist；
- [ ] 用户授权后才可 exact-stage/commit/push；
- [ ] 核验 remote ancestry 与 exact-SHA required CI；
- [ ] hosted migration + backend suites 成功后更新 RFC-294 P0-A 为 Done。

## 2. 当前 candidate allowlist

- `packages/shared/src/schemas/memory.ts`
- `packages/shared/tests/memory-patch-schema.test.ts`
- `packages/backend/src/modules/identity-access/application/operationContext.ts`
- `packages/backend/src/modules/identity-access/public/participants.ts`
- `packages/backend/src/services/memory.ts`
- `packages/backend/src/routes/memories.ts`
- `packages/backend/src/server.ts`
- `packages/backend/src/db/schema.ts`
- `packages/backend/db/migrations/0221_rfc342_memory_scope_move_events.sql`
- `packages/backend/db/migrations/meta/_journal.json`
- `packages/backend/tests/memory-service-patch.test.ts`
- `packages/backend/tests/routes-memories-patch.test.ts`
- `packages/backend/tests/rfc342-memory-scope-move.test.ts`
- `packages/backend/tests/migration-0221-rfc342-memory-scope-move-events.test.ts`
- `packages/frontend/src/components/memory/MemoryEditDialog.tsx`
- `packages/frontend/src/components/memory/MemoryDialogShell.tsx`
- `packages/frontend/src/components/memory/MemoryFormFields.tsx`
- `packages/frontend/src/i18n/en-US.ts`
- `packages/frontend/src/i18n/zh-CN.ts`
- `packages/frontend/tests/memory-edit-dialog.test.tsx`
- 本 RFC 三件套、`design/plan.md`、`STATE.md` 与 RFC-294 successor note
