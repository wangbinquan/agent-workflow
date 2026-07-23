# 暂缓的 PR-3a impl-gate 迁移（0115）

PR-3a 实现门修复的**代码**已合入 `7bf9b4dc`；但其配套迁移（终态/dynamic 任务的 R4-1 quarantine backfill）**暂缓未提交**——因并发 RFC-225 session 占了迁移号 0114 但未提交，我的 0115 与 `_journal.json` 缠住，干净提交会 journal 断链。

**无存量下这条迁移是 no-op**（PR-3a 已加 going-forward 冻 agentId + 运行期 sentinel fail-closed，只有"迁移前就存在的旧任务"才需 backfill）。

## 恢复步骤（RFC-225 的 0114 落 origin/main 后）
1. 确认 origin/main 迁移最大号（应含 RFC-225 的 0114）。
2. 把本目录的 `0115_...sql` 复制到 `packages/backend/db/migrations/`，**重编号**为下一个可用号（0115 或更高）。
3. 同步 `meta/_journal.json`（idx 递增、`when` 接合成轴 = 上条 +86400000）。
4. 把 `migration-0115-...test.ts` 复制到 `packages/backend/tests/` 并按新号改名。
5. `upgrade-rolling.test.ts` 计数 +1。
6. 跑全量 backend `bun test` + `build:binary`，绿后提交。
