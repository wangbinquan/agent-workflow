# RFC-372 五表增量的共享发布范围

> 2026-10-12。用户已明确授权本次共享文件与发布协调，五个新增文件和五个共享文件已正式交接并冻结。对方候选发布仍待完成；本会话没有执行 staging、commit、push 或实际产品库迁移。

## 范围和前置

本次五张表属于 collaboration：session、node、node revision、command receipt、snapshot。它们没有自动打开脑图或续跑任务的副作用。对应 schema/迁移/owner 的独立功能源码检视 PASS，不能据此认定测试、CI、M1 或整个 RFC 完成。

SQLite 0246 与 PostgreSQL 0022 明确继承 RFC-371 的 0245/0021。共享文件当前包含双方内容，完整保留才能构成候选；不得通过抽掉另一方 hunk、改写已有编号或修改共享索引制造单方干净提交。正式临界区需要先约定一个执行 staging/commit/push 的会话，冻结其确切文件并检查空索引。

本会话贡献的独立文件：

- `packages/backend/src/db/clarifyMindmap.ts`
- `packages/backend/db/migrations/0246_rfc372_mindmap_workspace.sql`
- `packages/backend/db/migrations/meta/0246_snapshot.json`
- `packages/backend/db/postgresql-migrations/0022_rfc372_mindmap_workspace.sql`
- `packages/backend/db/postgresql-migrations/meta/0022_rfc372_mindmap_workspace.upgrade.json`

与对方共享或依赖同一先序链的文件：

- `packages/backend/src/db/schema.ts`：本次五表导出与 factory import；保留对方 observation 导出及 import。
- `packages/backend/src/platform/persistence/schemaContract.ts`：本次五个逻辑表与 collaboration owner；保留对方三表及 owner。
- `packages/backend/db/migrations/meta/_journal.json`：保留对方 idx 244／tag 0245，追加本次 idx 245／tag 0246。
- `packages/backend/tests/rfc349-postgresql-schema.test.ts`：238→243 active 表，新增精确五表断言，保留对方全部 observation 断言。
- `packages/backend/tests/upgrade-rolling.test.ts`：244→246 entries，明确 0245 与 0246 各自增量。

对方原 0245 SQL/快照、0021 SQL/upgrade metadata，以及 observationCalculations/observationSourceRevisions 等依赖由其原任务负责；本会话不把这些文件擅自收编为自己的 allowlist。当前实际共同候选若需同一提交，应由双方核对完整范围与全部贡献归属后再提交。

## 迁移碰撞恢复证据

生成器按 journal idx 选择了已由另一迁移使用的 0245 文件前缀，覆盖其未提交的 snapshot。先保全生成结果到 `/private/tmp/rfc372-migration-number-collision/`，再将本次五表迁移顺延为 0246。没有修改原 RFC-371 SQL，也没有从 HEAD 重写共享文件。

独立差分验证：

- 0244：241 表，identity `ea94625c-6c85-442d-b488-88644e9a33a5`。
- 0245：244 表，identity `ed42e055-0425-4940-a293-e688514ddb29`；仅原三表增量，旧表对象完全相同。
- 0246：249 表，identity `83c17389-93b0-4fb9-807b-8a713d573d11`；仅脑图五表增量，原 244 表及其他 metadata 完全相同。
- prevId 链顺序正确；0246 等于保全的完整生成结果；journal 相对保全的生成版本仅改本次 tag。
- PostgreSQL 0022 的 predecessor、from/to contract、SQL 和 SQLite migration hash 均匹配；原 0021 不改写。
- 249 总表减去 6 个 archive-only 表得到 243 active；SQLite journal 为 246 条。

并行会话后续找到 v385 生成前完整备份，当前 0245 与其逐字节一致：804661 bytes，SHA-256 `dc23ba56b994173a4aa10e91458cf3516285343b4d91c52c2f42a8e71e0e0372`。独立十文件 SOURCE 报告见 [schema-source-review-20261012.md](reviews/schema-source-review-20261012.md)，报告 SHA-256 为 `09d1d6367243272b76012f95ce53549f101da95592b6a045e3e1a37dc5286cb8`。该报告只涵盖五表基础及其迁移依赖。本会话未应用实际产品库迁移，未执行 AW tests/typecheck/build/service/browser。后续候选的托管 exact-SHA CI、必要配套生成和发布检视分别验收。
