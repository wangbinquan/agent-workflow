# RFC-213 — 灾难恢复 · 任务分解

配套：`proposal.md` · `design.md`

PR 拆分：4 个 PR，可独立交付、递增。每个 PR 自带测试并跑绿 `typecheck && lint && test && format:check` + 单二进制 build smoke（[reference_binary_build_module_cycle]）+ push 后查 CI（[feedback_post_commit_ci_check]）。

---

## PR-1｜Restore（G1，AC-1/2/3/4）

- **T1** `services/backup.ts`：备份包新增 `manifest.json`（`schemaVersion`/`migrationCount`/`kind`/`createdAt`/`appVersion`/`includesWorktrees`）。老包无 manifest 时 restore 走保守降级。→ 扩 `backup.test.ts` 断言 manifest 存在且字段正确。
- **T2** `services/restore.ts`：`planRestore`（解析 + 版本闸，纯函数化可测）+ `restoreBackup`（安全备份→解包→DB quick_check→原子 rename + 清 -wal/-shm→config/skills/wf 复原→前滚迁移→recovery_event）。
- **T3** `cli/restore.ts` + `main.ts` 注册：`restore <tarball> [--dry-run|--no-safety-backup|--skip-integrity-check|--yes]`；flock 检查拒绝热恢复。
- **T4** `routes/restore.ts` + `server.ts` 挂载：`POST /api/restore`（admin）→ 预检 planRestore → 写 `.restore-pending/`（staged.tar.gz + restore-pending.json）→ 触发 graceful restart。
- **T5** `cli/start.ts`：`applyPendingRestoreIfAny()` 排在 `openDb()` **之前**；消费标记 → 冷恢复 → 清标记。
- **T6** 前端 Settings：「恢复 / Import backup」按钮走公共 `Dialog` + 上传 + 破坏性二次确认（复用现有 hook；不自写 chrome）。
- **T7** 测试：`rfc213-restore-roundtrip.test.ts`（往返逐表等价 + seal 不泄漏，AC-1）、版本闸旧包前滚/新包拒绝（AC-3）、`rfc213-pending-restore.test.ts`（暂存重启时序，AC-4）、安全备份存在（AC-2）。**变异实证**：失败模式表 #1/#3/#4。
- **依赖**：无（可先落）。

## PR-2｜Boot 完整性校验 + doctor（G2，AC-5/10）

- **T8** `db/client.ts`：`DbCorruptionError` + migrate 前 `PRAGMA quick_check`；`openDb(opts.skipIntegrityCheck)`；开库/首 PRAGMA 的 SQLITE_CORRUPT try/catch 归一。
- **T9** `cli/start.ts`：顶层捕获 `DbCorruptionError` → 打印可用备份清单 + restore 指引 → 退出码非 0；写 `logs/` 崩溃标记（库不可写，不进 recovery_events）。env/CLI `--skip-integrity-check` 逃生舱（响亮告警）。
- **T10** `cli/doctor.ts`：`checkDbIntegrity`（只读 quick_check，绝不改库）+ `checkBackups`（最近时间/份数/占用）；损坏标红给指引。
- **T11** 测试：`rfc213-boot-integrity.test.ts`（构造损坏库 → 拒起 + 文案 + 退出码；健康库零变化，AC-5）、`rfc213-doctor-dr.test.ts`（doctor 只读、库字节不变，AC-10）。**变异实证**：失败模式表 #2/#9。
- **依赖**：PR-1 的备份清单渲染复用（弱依赖；可并行，指引文案里引用 restore 命令）。

## PR-3｜定时备份 + 保留轮转 + pre-migration（G3，AC-6/7）

- **T12** `shared/schemas/config.ts`：新增 `backupIntervalMs`(0)/`backupRetentionCount`(7)/`backupRetentionDays`(30)/`backupOnMigration`(true) + 默认区；zod 校验。
- **T13** `services/backupScheduler.ts`：`startBackupScheduler`（interval>0 才起 + 重入门）+ `pruneBackups`（只轮转 scheduled/auto、不碰手动/pre-*、**永不删到 0**）。在 `start.ts` 与 GC/orphan ticker 并列注册。
- **T14** pre-migration 备份：`openDb`/start.ts migrate 前，`backupOnMigration && 有 pending 迁移` → 先 `wal_checkpoint(TRUNCATE)` 再原始拷贝成 `pre-migration-<from>-<to>.tar.gz`。
- **T15** 测试：`rfc213-backup-retention.test.ts`（轮转剩 N、永不删到 0、手动/pre-* 不动、interval=0 零副作用，AC-6）、`rfc213-pre-migration-backup.test.ts`（仅 pending 时触发，AC-7）。**变异实证**：失败模式表 #5/#6。
- **依赖**：T1 的 backup kind/manifest。

## PR-4｜更重的一层（G4，AC-8/9/11）

- **T16** G4b：`db/client.ts` `PRAGMA synchronous = ${cfg.sqliteSynchronous}`（默认 NORMAL）。测试 `rfc213-sqlite-synchronous.test.ts`（读回 PRAGMA，AC-9）。**变异**：写死 NORMAL → FULL 失效红（表 #8）。
- **T17** G4c：`walCheckpointIntervalMs` 字段 + checkpoint ticker（TRUNCATE）。测试断言 checkpoint 调用 + WAL 尺寸回落（AC-11）。
- **T18** G4a：`services/backup.ts` `includeWorktrees` → 捕获非终态任务的 bundle+delta+untracked（单任务上限、超限记 event 跳过）；`services/restore.ts` 重建活跃任务 worktree。测试 `rfc213-worktree-capture.test.ts`（活跃往返 / 终态不纳入 / 超限跳过，AC-8）。**变异**：改成全捕获 → 终态被纳入红（表 #7）。
- **依赖**：PR-1（restore 骨架）、PR-3（backup 参数化）。G4a 最重，可最后落或按需拆子 PR。

---

## 全局验收清单

- [ ] AC-1 restore 往返逐表等价 + seal 不泄漏
- [ ] AC-2 restore 前自动安全备份
- [ ] AC-3 schema 版本闸（旧前滚 / 新拒绝）
- [ ] AC-4 热 restore 暂存重启（openDb 前应用）
- [ ] AC-5 损坏 fail-closed（拒起 + 指引 + 退出码非 0）
- [ ] AC-6 定时备份 + 轮转（永不删到 0 / interval=0 零副作用）
- [ ] AC-7 pre-migration 备份（仅 pending 时）
- [ ] AC-8 worktree 往返（活跃复原 / 终态不纳入）
- [ ] AC-9 synchronous 可配真实下发
- [ ] AC-10 doctor 只读 DR 体检
- [ ] AC-11 WAL checkpoint 纪律
- [ ] 每个新守卫/失败路径均已变异实证（写反 → 对应测试必红）
- [ ] 设计门：写完 RFC 文档先跑 Codex review（配额恢复后，[feedback_codex_review_after_changes]）；实现门每 PR 再跑一次
- [ ] 单二进制 build smoke + push 后 CI 三绿

## 风险登记

- restore 破坏性 → 三重护栏（安全备份 + 冷恢复默认 + 热走暂存重启 + 原子 swap）。
- 完整性门假阳误伤 → `--skip-integrity-check` 逃生舱。
- 迁移前滚失败 → pre-migration 包回滚。
- worktree 体量 → 只非终态 + delta + 单任务上限。
- config 字段迁移 → config 是 JSON blob 不走列迁移；若引入新表则遵守 statement-breakpoint / journal `when` 单调 / 全量套件（[reference_migration_statement_breakpoint] / [reference_journal_when_must_be_monotonic] / [feedback_full_suite_after_migration]）。
- 共享树并发 → 索引登记（plan.md/STATE.md）用精确 pathspec 单步提交，避开并发 session 的 RFC-211 收尾（[feedback_shared_index_commit_race]）。
