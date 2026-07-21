# RFC-213 — 灾难恢复 · 任务分解（v2，过设计门后）

配套：`proposal.md` · `design.md`（v2 §10 有 v1→v2 订正账）

PR 拆分：**5 个 PR**（设计门把 v1 的 PR-1 拆成 1a 冷 / 1b 热，因热恢复依赖不存在的自重启语义）。每个 PR 自带测试并跑绿 `typecheck && lint && test && format:check` + 单二进制 build smoke（[reference_binary_build_module_cycle]）+ push 后查 CI（[feedback_post_commit_ci_check]）。DR 测试**一律 file-based openDb**，禁 `createInMemoryDb`（否则完整性门/换库被绕过）。

---

## PR-0｜地基：rawCopyDb + manifest + RecoveryEventKind（AC 前置）

- **T1** `services/rawDbSnapshot.ts`：`rawCopyDb(destTarball, {checkpoint?})` —— best-effort `wal_checkpoint(TRUNCATE)` 后**字节拷贝** `db.sqlite`(+`-wal`/`-shm`)，耐 `SQLITE_CORRUPT`、不开库、不 select；写 manifest（`kind`/`appVersion`/末条 `__drizzle_migrations(hash,createdAt)` 如可读）。
- **T2** `services/backup.ts`：`createBackup` 产物加同结构 `manifest.json`（scheduled/manual 用；健康库）。扩 `backup.test.ts` 断言 manifest + 排除清单（token/secret.key/secret 恒不在，含 rawCopy 包）。
- **T3** `services/recovery.ts`：`RecoveryEventKind` union 加 `restore`/`pre-migration`/`worktree-skip`；注明 restore 事件在换库后重开的 db 上写。
- **依赖**：无（最先落）。

## PR-1a｜冷恢复 CLI（G1 核心，AC-1/2/3）—— 可独立交付

- **T4** `services/restore.ts`：
  - `planRestore`（读 manifest + **迁移身份**版本闸：`countEmbeddedSqlMigrations()`/`IS_EMBEDDED` 取二进制 `maxFolderMillis`，比备份末 `createdAt`；`>` → downgrade 拒绝，前缀匹配 → forward，等 → same）——**非纯函数**（读嵌入资产）。
  - `restoreBackup`：§3.1 安全备份（`rawCopyDb`，失败 fail-closed 除非 `--no-safety-backup`）→ 解包到 `db.sqlite.incoming`（同 fs）→ incoming quick_check → fsync+close → **先 unlink -wal/-shm → rename → fsync 目录**（§3.3 崩溃安全序，保留 tarball 至 rename 成功）→ config/skills/wf 复原 → 前滚 `openDb`（或 `--no-migrate`）→ recovery_event。
  - `kind=pre-migration` 包绑 appVersion：二进制不符则拒绝前滚（提示先换回旧二进制）。
- **T5** `cli/restore.ts` + `main.ts`：`restore <tarball> [--dry-run|--no-safety-backup|--no-migrate|--skip-integrity-check|--yes]`；**活性检查用 `readPidFromLock`+`isProcessAlive`（`util/lock.ts`）**，stale/dead-pid 放行，仅 LIVE pid 拒绝。
- **T6** 测试（file-based openDb）：`rfc213-restore-roundtrip.test.ts`（backup→**改 live 多表**→restore→全表 count+hash 等于备份，AC-1；变异：注释 swap→红）、版本闸旧包前滚+**播种行存活**/新包拒绝（AC-3）、`rfc213-swap-stale-wal.test.ts`（live 有未 checkpoint WAL→swap 异库→**跳过 -wal unlink**→旧帧叠新库→红）、`rfc213-safety-backup.test.ts`（安全备份失败→中止、live 字节不变；损坏 incoming→拒绝、原库不动）。
- **依赖**：PR-0。

## PR-1b｜热恢复路由（G1 · 依赖 restart 语义，独立 PR）

- **T7** `routes/restore.ts` + `server.ts`：**新** multipart 上传端点（admin）→ `planRestore` 预检 → 写 `.restore-pending/`（staged.tar.gz + restore-pending.json）→ 触发 graceful shutdown → 响应**「已暂存，下次启动应用」**（不宣称完成）+ surface restart-required banner。
- **T8** `cli/start.ts`：`applyPendingRestoreIfAny()` 插在 **acquireLock 后、openDb 前**；严格幂等序（swap→migrate→event→删 tarball→**最后**清 marker）；boot 见 marker-在-tarball-无 = 已消费（清 marker 继续，**不** fail-closed）。
- **T9** 前端 Settings：**新**「恢复 / Import backup」按钮走公共 `Dialog` + 文件选择 + 破坏性二次确认（无现成上传对偶可复用，新建 flow）。
- **T10** 文档：`docs/` 写清热恢复需 supervisor（systemd `Restart=always`/launchd）自动应用，否则手动 `start`。
- **T11** 测试：`rfc213-pending-restore.test.ts`（file-based openDb；断言**首个 openDb 连接看到的已是恢复后 schema/内容**——非仅 marker 消费；marker-在-tarball-无=已消费继续）。**变异**：applyPendingRestore 挪到 openDb 后→首连接见旧库→红。
- **依赖**：PR-1a。

## PR-2｜Boot 完整性 + doctor（G2 fail-closed，AC-5/10/12）

- **T12** `db/client.ts`：`DbCorruptionError` + migrate 前 `quick_check`；`openDb(opts:{skipIntegrityCheck?,synchronous?})`（start.ts 线程传，**不** loadConfig 于 client）；`new Database`/首 PRAGMA 的 SQLITE_CORRUPT 归一 catch。
- **T13** `cli/start.ts`：顶层捕获 → 打印备份清单 + restore 指引 → 退出码非 0；`logs/` 崩溃标记；`--skip-integrity-check` 逃生舱。
- **T14** `cli/doctor.ts`：`checkDbIntegrity`（自己 `{readonly:true}` 开库 quick_check）+ `checkBackups` + **T18 的**异机凭据告警（AC-12）。
- **T15** 测试：`rfc213-boot-integrity.test.ts`（**页级损坏 fixture**：header 完好 + 深层页翻字节 → 抛/拒起，AC-5；变异去门→静默开库红。**另**：truncate/header-clobber 走归一 catch 单列）、`rfc213-doctor-dr.test.ts`（断言**连接 readonly + 写抛**，非 byte-equality，AC-10）。
- **依赖**：PR-0（备份清单渲染）。

## PR-3｜定时备份 + 轮转 + pre-migration（G3，AC-6/7）

- **T16** `shared/schemas/config.ts`：`backupIntervalMs`(0)/`backupRetentionCount`(7)/`backupRetentionDays`(30)/`backupOnMigration`(true)/`sqliteSynchronous`('NORMAL')/`walCheckpointIntervalMs`(0) + 默认区 + zod。
- **T17** `services/backupScheduler.ts`：interval>0 才起 + 重入门；`pruneBackups`（**KEEP iff 最近N ∪ 新于D，DELETE 仅双不满足**，只 scheduled/auto、永不删到 0、总量上限）。与 GC/orphan ticker 并列注册。
- **T18** pre-migration：start.ts migrate 前（有 pending 且 `backupOnMigration`）→ **`rawCopyDb`**（绝不 select）→ 绑 appVersion 的 pre-migration 包。
- **T19** 测试：`rfc213-backup-retention.test.ts`（轮转规则 + 手动/pre-* 不动 + 永不删到 0 + **interval=0 推进假时钟零文件+无 handle** + **慢备份双 tick 只一次**，AC-6）、`rfc213-pre-migration-backup.test.ts`（仅 pending + 用 rawCopyDb；变异换回 createBackup→加列场景 `no such column` 红，AC-7）。
- **依赖**：PR-0。

## PR-4｜synchronous + WAL checkpoint + worktree（G4，AC-8/9/11）

- **T20** G4b：`openDb` `PRAGMA synchronous=${opts.synchronous}`。`rfc213-sqlite-synchronous.test.ts`（读回 PRAGMA，AC-9；变异写死 NORMAL→红）。
- **T21** G4c：checkpoint ticker（`walCheckpointIntervalMs>0`，TRUNCATE）+ 测试（AC-11）。
- **T22** G4a（**缩范围：同机 + 仅未提交 delta+untracked，无 bundle**）：`backup --include-worktrees` 捕获非终态任务 `git diff`+untracked（单任务上限，超限记 event 跳过）；`restore` 只对 worktreePath **缺失**的非终态任务重建、**首次 resume 跳过 clean/reset**；worktree 在但 mismatch → `git stash -u`+`needs-manual-review`+禁 auto-resume。`rfc213-worktree-capture.test.ts`（同机往返活跃复原/终态不纳入/mismatch 不覆盖/超限跳过，AC-8；变异全捕获→终态纳入红）。
- **依赖**：PR-1a（restore 骨架）、PR-3（backup 参数化）。G4a 最重、最后落，可再拆子 PR。

---

## 全局验收清单

- [ ] AC-1 restore 往返（改 live 后全表 hash 还原）
- [ ] AC-2 安全备份原始拷贝 + 失败 fail-closed
- [ ] AC-3 版本闸（迁移身份 + 旧包行存活 / 新包拒绝）
- [ ] AC-4 热 restore 只暂存 + 下次启动幂等应用
- [ ] AC-5 损坏 fail-closed（页级 fixture + 归一 catch）
- [ ] AC-6 定时备份 + 轮转（KEEP/DELETE 规则 + interval=0 零文件 + 重入）
- [ ] AC-7 pre-migration rawCopyDb（仅 pending + 绑版本）
- [ ] AC-8 worktree 同机增量往返（缺失才重建 / mismatch 保护 / 首次跳 clean）
- [ ] AC-9 synchronous 可配真实下发
- [ ] AC-10 doctor 只读断言（readonly + 写抛）
- [ ] AC-11 WAL checkpoint 纪律
- [ ] AC-12 异机凭据告警
- [ ] 每个新守卫/失败路径已变异实证（写反 → 对应测试必红）
- [ ] DR 测试全部 file-based openDb（非 createInMemoryDb）
- [ ] 实现门每 PR 跑 Codex review（配额恢复后，[feedback_codex_review_after_changes]）
- [ ] 单二进制 build smoke + push 后 CI 三绿

## 风险登记（含设计门补充）

- restore 破坏性 → 安全备份（原始拷贝，失败 fail-closed）+ 冷恢复默认 + 热走暂存 + **崩溃安全 swap（先删 -wal → rename → fsync）**。
- 完整性门假阳 → `--skip-integrity-check` 逃生舱；页级 fixture 保证门有真覆盖。
- pre-migration 回滚 vs 强制前滚 → `--no-migrate` + 绑 appVersion 拒错版本前滚。
- 版本闸 → 比迁移身份非文件数；单二进制用 `countEmbeddedSqlMigrations()`。
- 热恢复无自重启 → 只暂存 + 文档 supervisor；拆 PR-1b。
- worktree → 同机 + delta + 单任务上限 + mismatch 保护 + 首次跳 clean（保 untracked）。
- 异机 → 封印凭据失效告警（AC-12）+ 文档同机。
- config 字段 → JSON blob 不走列迁移；若引入新表遵守 statement-breakpoint / journal `when` 单调 / 全量套件（[reference_migration_statement_breakpoint] / [reference_journal_when_must_be_monotonic] / [feedback_full_suite_after_migration]）。
- 共享树并发 → 索引登记（plan.md/STATE.md）精确 pathspec 单步提交，避让并发 RFC-211 收尾（[feedback_shared_index_commit_race]）。
