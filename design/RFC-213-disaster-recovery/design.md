# RFC-213 — 灾难恢复 · 技术设计

配套：`proposal.md`（产品）· `plan.md`（任务分解）

---

## 1. 概览

围绕**单 SQLite 库 + 磁盘工作区**补齐四条 DR 能力，全部落在现有 daemon/CLI/doctor/config 骨架上，尽量不动热路径：

```
                     ┌──────────────────────────────────────────────┐
   backup（已存在）→ │ tar.gz: db(VACUUM INTO) + config + skills + wf │
                     └──────────────────────────────────────────────┘
                                     │  ▲
             restore（新，PR-1）─────┘  │  createBackup（复用；PR-3 加调度/轮转/pre-migration；PR-4a 加 worktree）
                                        │
   boot（start.ts）→ openDb → [PRAGMA quick_check 门（新，PR-2，fail-closed）] → migrate → reap/reconcile …
                                        │
   doctor → 只读 quick_check + 备份体检（新，PR-2/PR-3）
```

## 2. 现状锚点（实现者必读）

| 关注点 | 文件:行 | 现状 |
|---|---|---|
| 唯一生产 DB open | `packages/backend/src/db/client.ts:27-64` | WAL / `synchronous=NORMAL` / `busy_timeout=5000`；FK-off migrate；migrate 后仅 `foreign_key_check` 且 **WARN-only**；**无 integrity_check / user_version 门** |
| 现有备份 | `packages/backend/src/services/backup.ts:62-132` | `VACUUM INTO`（:88）打 tar.gz；排除清单在 :12-13、:102；封 secret（RFC-204） |
| 备份入口 | `cli/backup.ts`、`routes/backup.ts:9-22` | CLI + `POST /api/backup`；**无对称 restore** |
| 数据路径 | `util/paths.ts:8-64` | `db.sqlite`/`worktrees/`/`backups/`/`secret.key`；`AGENT_WORKFLOW_HOME` 是唯一位置旋钮 |
| 启动恢复级联 | `cli/start.ts:196-315`（reap :220 / reconcile :264 / autoResumeOnBoot :583） | 进程崩溃恢复成熟；DR 门要插在 openDb 处、restore-pending 要在 openDb **之前** |
| 孤儿回收 | `services/orphans.ts:34` | running/pending → interrupted；不含任何数据丢失恢复 |
| worktree GC / 对账 | `services/gc.ts:244-309` | 唯一 DB↔磁盘对账，且单向（磁盘没了→修 DB 行） |
| 健康体检 | `cli/doctor.ts:112-145` | 只读开库，报 lifecycle；**无完整性检查** |
| config 默认 | `packages/shared/src/schemas/config.ts:91,111,122`（默认 :408,:414,:417） | 有 autoResumeOnBoot / periodicOrphanReconcileMs / worktreeAutoGc；**无任何备份/DR 字段** |
| 恢复审计 | `services/recovery.ts:67-90`（`recovery_events` 表） | 已有 recordRecoveryEvent，可复用记录 DR 动作 |
| worktree snapshot ref | `util/git.ts:1574-1580`（`refs/agent-workflow/snapshots/…`） | RFC-130 crash-replay 用的每任务快照 ref，worktree 恢复物料的来源 |

## 3. PR-1｜Restore（G1）

### 3.1 服务：`services/restore.ts`

```ts
export interface RestorePlan {
  tarballPath: string
  manifest: BackupManifest        // 从包里的 manifest.json 读出
  currentMigrationCount: number   // 当前二进制的 .sql 数
  backupMigrationCount: number    // 包里记录的迁移数
  direction: 'same' | 'forward' | 'downgrade-refused'
}

/** 冷恢复：daemon 必须停（flock 已释放）。返回 applied 详情。 */
export async function restoreBackup(
  tarballPath: string,
  opts: { skipIntegrityCheck?: boolean; safetyBackup?: boolean /* 默认 true */ },
): Promise<RestoreResult>

/** 只解析 + 校验，不落盘（doctor / route 预检 / --dry-run 用）。 */
export function planRestore(tarballPath: string): RestorePlan
```

**流程（冷恢复）**：
1. **解析 manifest**：包里带 `manifest.json`（新增到 backup.ts 产物）含 `schemaVersion`、`migrationCount`、`backupKind`、`createdAt`、`appVersion`、`includesWorktrees`。老包无 manifest 时按「迁移数 = 未知，走保守前滚」降级处理。
2. **版本闸**（AC-3）：`backupMigrationCount > currentMigrationCount` → `downgrade-refused`，抛 `RestoreDowngradeError`，**不动现有库**。`<=` → 恢复后前滚。
3. **安全备份**（AC-2）：`safetyBackup !== false` → 先 `createBackup({ kind: 'pre-restore' })` 到 `backups/pre-restore-<ts>.tar.gz`。
4. **解包到临时目录** `~/.agent-workflow/.restore-staging/`。
5. **DB 原子换入**：把包内 DB 解到 `db.sqlite.incoming` → 对它跑 `PRAGMA quick_check`（除非 `skipIntegrityCheck`）→ 通过则 `rename` 覆盖 `db.sqlite` 并**删除陈旧 `-wal`/`-shm`**（换库后旧 WAL 必须清，否则 SQLite 会拿旧 WAL 叠新库 = 损坏）。
6. **config/skills/workflows 复原**：config.json 覆盖；skills/ 与 workflows/ 按包内容重铺（保留 `token`/`secret.key`/`secret` 不动——这些从不在包里）。
7. **前滚迁移**：换库后 `openDb()`（会自动 migrate 到当前版本）。
8. 记 `recovery_event(kind='restore', …)`。

### 3.2 CLI：`cli/restore.ts` + `main.ts` 注册

```
agent-workflow restore <tarball> [--dry-run] [--no-safety-backup] [--skip-integrity-check] [--yes]
```
- **flock 检查**：daemon 在跑 → 拒绝（冷恢复不能热插拔活跃库），提示先 `stop`。
- `--dry-run` → 只打印 `planRestore` 结果（版本、方向、包内容摘要）。
- 交互确认（除非 `--yes`）：破坏性操作要用户确认。

### 3.3 路由：`POST /api/restore`（热流程 = 暂存 + 重启）

热恢复**不在活跃 DB 上热插拔**（AC-4）：
1. 上传 tarball（multipart，沿用 backup 导出的对偶）。
2. 服务端 `planRestore` 预检（版本闸、包完整性）；不过关 → 400 + 原因。
3. 通过 → 把包写到 `~/.agent-workflow/.restore-pending/staged.tar.gz` + 写 `restore-pending.json`（含 manifest 摘要 + 选项）。
4. 触发 graceful shutdown（复用现有 30s 优雅停）。
5. **`start.ts` 在 `openDb()` 之前**新增一步 `applyPendingRestoreIfAny()`：见 `restore-pending.json` → 执行 §3.1 冷恢复（此刻 DB 尚未打开，安全）→ 清标记 → 继续正常启动。
6. 权限：仅 admin（沿用 backup 路由的鉴权口径）。

> 设计取舍：热 restore 的「上传→暂存→重启时应用」比「热换库」正确得多——避开活跃连接/在飞任务/WAL 一致性一整类竞态（[feedback_prefer_correct_over_minimal]）。

### 3.4 前端

Settings 已有「Export backup」按钮（`routes/backup.ts` 对偶）。加一颗「Import backup / 恢复」按钮走公共 `Dialog` + 文件选择 + 二次确认（破坏性），复用现有上传 hook；**禁止**自写 modal chrome（CLAUDE.md 前台统一原则）。

## 4. PR-2｜Boot 完整性校验（G2，fail-closed）

### 4.1 `db/client.ts`

在 `openDb()` **migrate 之前**加一步：

```ts
// PRAGMA quick_check 比 integrity_check 快一个量级，足以抓结构损坏。
const rows = raw.query('PRAGMA quick_check(1)').all() as { quick_check: string }[]
const ok = rows.length === 1 && rows[0]!.quick_check === 'ok'
if (!ok && !opts.skipIntegrityCheck) {
  throw new DbCorruptionError(dbPath, rows.map(r => r.quick_check))
}
```
- 新增 `DbCorruptionError`（携带 dbPath + 前若干条错误行）。
- `openDb` 加 `opts.skipIntegrityCheck?: boolean`（默认 false）；对应 CLI/env 逃生舱（AC-5 风险项）。
- **打开阶段的 SQLITE_CORRUPT**：`new Database(path)` 或第一条 PRAGMA 就可能抛 `SQLITE_CORRUPT`/`SQLITE_NOTADB`；用 try/catch 归一成 `DbCorruptionError`。

### 4.2 `cli/start.ts` fail-closed 出口

`openDb` 抛 `DbCorruptionError` → start.ts 顶层捕获 → 打印：
```
✖ 数据库损坏，daemon 拒绝启动（不拿损坏库对外服务）。
  库: ~/.agent-workflow/db.sqlite
  quick_check: <前几条>
  可用备份（最近在前）:
    1) backups/auto-2026-07-21T... .tar.gz   (2h ago, schema 104)
    2) ...
  恢复: agent-workflow restore backups/<pick>.tar.gz
```
→ `process.exit(非0)`。**不写 recovery_events**（库不可写）——改写 stderr + 一个 `logs/` 崩溃标记文件。

### 4.3 `cli/doctor.ts`

`checkLifecycleHealth` 旁加 `checkDbIntegrity`（只读开库、`quick_check`、绝不改库）+ `checkBackups`（最近备份时间/份数/占用）。doctor 恒不 fail-exit（只报告），但损坏时标红 + 给 restore 指引。

## 5. PR-3｜定时备份 + 保留轮转（G3）

### 5.1 config 新字段（`shared/schemas/config.ts`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `backupIntervalMs` | `0`（关） | >0 时 ticker 到点自动 `createBackup({kind:'scheduled'})` |
| `backupRetentionCount` | `7` | 只保留最近 N 份自动/定时备份（手动导出的不算入轮转，见下） |
| `backupRetentionDays` | `30` | 同时不删早于 N 天内应保留的；两条取「都满足才删」 |
| `backupOnMigration` | `true` | 起库检测到 pending 迁移 → 迁移前先备份 |
| `sqliteSynchronous` | `'NORMAL'` | PR-4b |
| `walCheckpointIntervalMs` | `0`（关） | PR-4c |

默认全部「不改变现状」：`backupIntervalMs=0` 表示默认不自动备份（保守，避免给现有安装凭空长东西）；`backupOnMigration=true` 是唯一默认开的——因为迁移前备份是最高 ROI 的安全网，且只在真有 pending 迁移时触发。

> 迁移会加 config 字段：按 [reference_new_column_breaks_frozen_migration_tests] / migration 家族规矩处理——本 RFC 不新增 DB 列（config 是 JSON blob，不走列迁移），但**若** PR-4a 需要 recovery_events 之外的表则单列迁移并遵守 statement-breakpoint / journal `when` 单调 / 全量套件跑绿。

### 5.2 备份 ticker：`services/backupScheduler.ts`

对齐 `services/gc.ts` 的 hourly ticker 与 `orphanReconcile.ts` 的循环写法：
- `startBackupScheduler(db, cfg)`：`backupIntervalMs>0` 才起；到点 `createBackup` + `pruneBackups`。
- **重入保护**：`let running=false` 门（同 memoryDistillScheduler 修法），一次备份没跑完不叠下一次。
- `pruneBackups(dir, {count, days})`：只轮转 `kind ∈ {scheduled, auto}` 的包；**手动 export 与 pre-restore/pre-migration 包不参与自动删除**（它们是用户显式或安全网产物）；**永不删到 0**（AC-6）——即便超期，至少留最新一份。

### 5.3 pre-migration 备份

`openDb()`（或 start.ts migrate 前）：若 `backupOnMigration` 且**存在 pending 迁移**（`.sql` 数 > 库内已应用数）→ 迁移前 `createBackup({kind:'pre-migration', from, to})`。无 pending 则跳过（AC-7）。此备份走**原始文件拷贝**而非 VACUUM INTO（迁移前的库可能正处于要被改的状态；直接 copy `db.sqlite`+`-wal` 更快且忠实）——但 copy 前先 `wal_checkpoint(TRUNCATE)` 把 WAL 落盘再拷。

## 6. PR-4｜更重的一层（G4）

### 6.1 G4a — worktree 增量捕获

- backup 加 `includeWorktrees`（CLI `--include-worktrees` / config `backupIncludeWorktrees`，默认 false）。
- 只捕获**非终态任务**（status ∈ running/pending/awaiting_review/awaiting_human/interrupted）的 worktree：对每个这类任务的 `worktreePath`，生成
  - `git bundle` of base commit + `refs/agent-workflow/snapshots/<task>`（`util/git.ts:1574` 的快照 ref）；
  - 一份**未提交 delta**（`git -C <wt> diff` + untracked 打包，或直接 tar 工作树的非 .git 变更）。
- 存进备份包 `worktrees/<taskId>/{bundle, delta.patch, untracked.tar}`。
- **单任务体量上限** `maxWorktreeBundleBytes`（默认如 64 MiB）：超限 → 跳过该任务 + 记 recovery_event（不撑爆包）。
- restore 侧：对每个捕获的任务，若其 DB 行仍在且 worktreePath 缺失 → `git worktree add` 回 base + apply bundle/ref + apply delta + 释放 untracked。终态任务不重建（proposal 非目标）。

### 6.2 G4b — synchronous 可配

`openDb()`：`PRAGMA synchronous = ${cfg.sqliteSynchronous}`（默认 NORMAL = 现状字节等价，AC-9）。文档写清 NORMAL vs FULL 的耐久/吞吐取舍。

### 6.3 G4c — WAL checkpoint 纪律

`services/backupScheduler.ts`（或独立 `walMaintenance.ts`）：`walCheckpointIntervalMs>0` 时周期 `PRAGMA wal_checkpoint(TRUNCATE)`，约束 `-wal` 膨胀（AC-11）。真正的连续 WAL 归档 PITR 不做（非目标）。

## 7. 失败模式与测试策略（每条必带变异实证）

| # | 失败/行为 | 测试（`packages/backend/tests/`） | 变异实证 |
|---|---|---|---|
| 1 | restore 往返逐表等价 + seal 不泄漏 | `rfc213-restore-roundtrip.test.ts`：backup→restore→逐表 count/关键字段 equal；断言包内无 token/secret.key，restore 不触碰现有 secret | 把 restore 的 DB swap 注释掉 → count 不等 → 红 |
| 2 | 损坏 fail-closed | `rfc213-boot-integrity.test.ts`：构造 quick_check 失败的库文件（截断/篡改 header）→ openDb 抛 DbCorruptionError；start 顶层退出码非 0 + 指引文案；健康库通过零变化 | 去掉 quick_check 门 → 损坏库静默开库 → 断言「应抛」红 |
| 3 | schema 版本闸 | 同 restore 套件：旧包（migrationCount 小）→ 恢复后前滚起库；新包（migrationCount 大）→ RestoreDowngradeError、原库不动 | 把 direction 判断写反 → 新包被接受 → 红 |
| 4 | 热 restore 暂存重启 | `rfc213-pending-restore.test.ts`：写 restore-pending.json + staged.tar.gz → applyPendingRestoreIfAny 在 openDb 前消费、清标记、库被换 | 把 applyPendingRestore 挪到 openDb 之后 → 在已开库上换 → 断言消费时序红 |
| 5 | 轮转永不删到 0 + interval=0 零副作用 | `rfc213-backup-retention.test.ts`：造 N+3 个 scheduled 包 → prune 后剩 N；只 1 个也不删；手动/pre-* 包不被轮转；interval=0 时 scheduler 不起 | 把「永不删到 0」保护删掉 → 单包被删 → 红 |
| 6 | pre-migration 仅 pending 时触发 | `rfc213-pre-migration-backup.test.ts`：有 pending 迁移 → 产出 pre-migration 包；无 pending → 不产出 | 去掉 pending 判断 → 无迁移也备份 → 红 |
| 7 | worktree delta 往返 | `rfc213-worktree-capture.test.ts`：活跃任务 worktree 带未提交改动 → backup(--include-worktrees) → 删 worktree → restore → 内容+delta 复原；终态任务不纳入；超限跳过记 event | 把「只捕获非终态」改成「全捕获」→ 终态任务被纳入 → 红 |
| 8 | synchronous 真实下发 | `rfc213-sqlite-synchronous.test.ts`：cfg FULL → 开库后 `PRAGMA synchronous` 读回 2(FULL)；默认 → 1(NORMAL) | 把 PRAGMA 写死 NORMAL → FULL 配置失效 → 红 |
| 9 | doctor 只读体检 | `rfc213-doctor-dr.test.ts`：损坏库 → doctor 标红 + restore 指引 + **库未被改**（前后字节一致）；健康库 → 报最近备份/份数 | 让 doctor 用可写连接跑 integrity_check → 断言「库字节不变」红 |
| 10 | 结构守卫：备份排除清单不回退 | 扩 `backup.test.ts`：断言 token/secret.key/secret 恒不在包内（已存在的锁 :129 复用/加强） | 从排除清单删掉 secret.key → 包内出现 → 红 |

> 复用现有：`tests/backup.test.ts`（VACUUM 有效性 + 排除锁）、`rfc130-crash-replay.test.ts`（snapshot ref 语义）、`rfc108-orphan-reconcile.test.ts`、`integration-chaos/chaos-scenarios.integration.test.ts`。

## 8. 与现有模块的耦合点

- **`openDb` 是唯一生产开库点**：完整性门 + synchronous + pre-migration 全部挂这里，天然覆盖 daemon/CLI/doctor（doctor 用只读变体）。**不新增第二个开库路径**（避免 flag-audit 家族的「半截注册表」病）。
- **`createBackup` 复用**：PR-3/PR-4a 只加 `kind` 与 `includeWorktrees` 参数 + manifest 产物，不 fork 备份逻辑。
- **`start.ts` 启动级联**：`applyPendingRestoreIfAny()` 必须排在 `openDb()` **之前**；完整性门在 `openDb` 内；backup scheduler 与现有 GC/orphan ticker 并列注册（同生命周期）。
- **config 单一事实源**：新字段进 `shared/schemas/config.ts` + 默认区；前端 Settings 若要暴露则走既有 Form 原语。
- **recovery_events 复用**：所有 DR 动作（restore/pre-migration/worktree-skip）记 `recordRecoveryEvent`，与现有崩溃恢复审计同表。

## 9. 分期与「最合理」取舍

- restore 的**热流程走暂存重启**而非热换库——正确性远高于省事（[feedback_prefer_correct_over_minimal]）。
- 完整性用 **quick_check** 而非 integrity_check——够抓结构损坏、快一个量级，boot 门可接受。
- 轮转**不碰手动/安全网包**——用户显式产物与 pre-restore/pre-migration 是最后的救命稻草，绝不自动删。
- worktree 只捕获**非终态 + 只存 delta/bundle + 单任务上限**——DR 价值集中在「在飞的活儿别丢」，同时不让备份体量失控。
- G4c 只做 **checkpoint 纪律**，PITR 显式留后续——避免把一个能落地的 RFC 拖成无限工程。
