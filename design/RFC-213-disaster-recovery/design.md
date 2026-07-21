# RFC-213 — 灾难恢复 · 技术设计（v2，过设计门后重写）

配套：`proposal.md`（产品）· `plan.md`（任务分解）

> **v2 说明**：v1 经 4 视角对抗设计门（feasibility / data-loss / test-adequacy / scope-coherence，33 findings / 7 blocker / 18 major，多条经真实 bun:sqlite 实证）被判出结构性硬伤。本 v2 逐条订正。被推翻的 v1 设计与订正见 §10「设计门订正账」。

---

## 1. 概览

围绕**单 SQLite 库 + 磁盘工作区**补齐 DR 能力，落在现有 daemon/CLI/doctor/config 骨架上，尽量不动热路径。**核心订正**：备份安全网一律走**原始文件拷贝**（非 `VACUUM INTO`/`createBackup`），DB 换入走**崩溃安全序列**，热恢复**只暂存不自重启**。

## 2. 现状锚点（实现者必读，含设计门校正）

| 关注点 | 文件:行 | 现状 / 校正 |
|---|---|---|
| 唯一「业务」DB open | `db/client.ts:27-64` | WAL / `synchronous=NORMAL` / `busy_timeout=5000`；`journal_mode=WAL` 在 :32（**先于**任何完整性门）；migrate 后仅 `foreign_key_check`（WARN-only）；**无 integrity_check**。**校正**：`openDb` **不是**唯一开库点——`doctor.ts:118` 自己 `new Database(Paths.db,{readonly:true})`；`openDb` 无 config 参数（4 个 CLI caller 都不传） |
| createBackup（只读健康库） | `services/backup.ts:37-43,62,83,88,109` | 签名要 `db: DbClient`；:88 `VACUUM INTO`；:109 `listWorkflows(db)`（按**当前**schema select 所有列）。**只能对已开的健康库跑**——不能在 openDb 之前、不能对损坏库、不能对未迁移库跑 |
| 备份入口 | `cli/backup.ts:15`、`routes/backup.ts:14-19` | 都先 `openDb`；route 服务端写盘返回 `{path,sizeBytes}`，**无下载/上传对偶**（前端只 POST 后显示路径） |
| 数据路径 | `util/paths.ts:8-72` | `db.sqlite`/`worktrees/`/`backups/`/`repos/`/`secret.key`；`migrationsDir`（:70）在单二进制里**无意义**（`import.meta.dirname` 被 bake 成 `/`） |
| 单实例锁 | `util/lock.ts:2-4,53,58-61` | **不是 flock**——是 `O_CREAT|O_EXCL` PID 文件，**崩溃后残留**；活性靠 `readPidFromLock`+`isProcessAlive`；stale 锁下次 acquire 才回收 |
| 嵌入迁移计数 | `db/embed.ts`（`countEmbeddedSqlMigrations`）、`start.ts:191-199`、`doctor.ts:7,236` | 单二进制用 `countEmbeddedSqlMigrations()` / `IS_EMBEDDED`；`readdirSync(migrationsDir)` 在二进制里返回 0 |
| Drizzle 迁移判定 | `drizzle-orm/.../dialect` `Number(lastDb.created_at) < migration.folderMillis` | 按 `__drizzle_migrations(hash,created_at)` vs `_journal.json` 的 `when`（folderMillis），**不看文件数**。`when` 是**合成单调轴**（[reference_journal_when_must_be_monotonic]） |
| 启动级联 | `start.ts:70`(acquireLock) → `:196`(openDb) → `:220`(reap) → `:264`(reconcile) → `:388`(ensureCredentialsSealed) → `:583`(autoResumeOnBoot) → `:658-659`(exit) | restore-pending 须插在 **acquireLock 之后、openDb 之前**；完整性门在 openDb 内；`shutdown()` **从不 `.close()` DB** → 换库时磁盘上必有未 checkpoint 的 `-wal/-shm` |
| worktree snapshot ref | `util/git.ts:1574-1580` | `snapshotRefName(taskId,nodeRunId)` = **每 node_run 一条**，pin 在**共享源仓 odb**（`repos/`，备份**排除**！），受 `gc.ts` 删除；`snapshots/<task>` 只是**批删前缀**、不是 ref |
| 快照不含 untracked | `util/git.ts:1643`(`stash create` 无 `-u`)、`:1697`(`rollbackToSnapshot` 跑 `git clean -fd`) | resume 回滚会 `clean -fd` 删掉 untracked |
| 封印凭据 | `repoCredentials.ts:60`、`backup.test.ts:129`、`start.ts:388` | `cached_repos` URL 用 `secret.key` 封印；备份**不带** secret.key（对）；异机 restore → 封印 URL 永久解不开 |
| config schema | `shared/schemas/config.ts` | JSON blob（非列迁移）；新字段进此处 + 默认区 |
| 恢复审计 | `services/recovery.ts:18-29,67-90`（`recovery_events`） | `RecoveryEventKind` 是**封闭 union**（无 restore/pre-migration/worktree-skip）；`recordRecoveryEvent` 要 open db |
| DR 测试 harness 陷阱 | 452 文件用 `createInMemoryDb`（绕过 openDb 门）vs 9 文件用 file-based openDb | **DR 测试必须用 file-based openDb**，否则完整性门/换库全被绕过 |

## 3. PR-1a｜冷恢复 CLI（G1 核心，AC-1/2/3）

### 3.1 安全备份 = 原始文件拷贝（订正 blocker #1/#3、major #5/#7）

**不复用 `createBackup`**（它要开库 + VACUUM INTO，对损坏/未迁移库必炸）。新增：

```ts
// services/rawDbSnapshot.ts —— 不开库、耐损坏的原始拷贝
export function rawCopyDb(destTarball: string, opts?: { checkpoint?: boolean }): void
```
- 若库健康且能开：先 `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 落盘（best-effort，损坏则跳过）。
- **字节拷贝** `db.sqlite` + `db.sqlite-wal` + `db.sqlite-shm`（存在才拷）进一个 tar.gz，带 manifest（含 `kind`、`appVersion`、原始 `__drizzle_migrations` 末条 `(hash,created_at)` 如可读）。
- **耐损坏**：字节拷贝对 `SQLITE_CORRUPT` 免疫（不解析内容），既做安全网也留 forensics。
- **fail-closed 语义**（AC-2）：pre-restore 安全备份**失败**（如磁盘满 / 拷贝 IO 错）→ **中止 restore**、原库一字节不动、报可操作错误；仅当用户显式 `--no-safety-backup` 才越过。拷贝后校验非零尺寸（+ 能开则 quick_check）再进 swap。

### 3.2 版本闸 = 迁移身份（订正 major：count 不可靠）

`planRestore` 比较**迁移身份**而非文件数：
- 备份 manifest 记录备份库 `__drizzle_migrations` 末条 `(hash, createdAt)`。
- 当前二进制的迁移轴：`IS_EMBEDDED ? countEmbeddedSqlMigrations()` 对应的 `_journal.json` `when` 集（嵌入资产），否则解压后的 `_journal.json`；取 `maxFolderMillis`。
- 判定：
  - `backup.lastCreatedAt > binary.maxFolderMillis` → **downgrade/divergence** → `RestoreDowngradeError`，不动库（AC-3 拒绝）。
  - `<=` 且备份末 hash 是二进制迁移序列的前缀 → `forward`（恢复后前滚）。
  - 相等且 hash 一致 → `same`。
- `planRestore` **不是纯函数**（要读嵌入迁移资产）——去掉 v1「纯函数」措辞。

### 3.3 崩溃安全 DB 换入（订正 blocker #2、major #10）

严格序列（`restoreBackup` 内）：
1. 解包到 `db.sqlite.incoming`（与 `db.sqlite` **同一文件系统**，都在 appHome）。
2. 对 incoming 跑 `PRAGMA quick_check`（除非 `--skip-integrity-check`）；失败 → `RestoreIntegrityError`，原库不动。
3. `fsync(incoming)` 后 close 其句柄。
4. **先 `unlink db.sqlite-wal` 和 `db.sqlite-shm`**（旧库的未 checkpoint WAL 必须先清，否则 SQLite 按 salt 校验后把旧帧按页号叠到新文件上 = 静默损坏，且可能**通过** quick_check）。
5. `rename(incoming → db.sqlite)`（同 fs 原子）。
6. `fsync` 包含目录。
7. config/skills/workflows 复原（保留 `token`/`secret.key`/`secret` 不动）。
8. **保留 staged tarball 直到 rename 成功**——rename 前崩溃可从 pending 标记重新驱动，绝不留半换状态。

### 3.4 前滚 / pre-migration 回滚模式（订正 blocker #7）

- restore 默认恢复后 `openDb()` 前滚到当前二进制。
- **`restore --no-migrate`**（restore-as-is）：不前滚，供「回到升级前」——配合**先回退二进制**（单二进制升级后不能自动降级）。
- `kind=pre-migration` 的包**绑定 appVersion**：restore 它时若运行二进制 != 备份 appVersion，**拒绝前滚**并提示「先换回旧二进制再 `restore --no-migrate`」，否则前滚只会把炸库的迁移重放一遍。

### 3.5 CLI（订正 major：真实锁机制）

```
agent-workflow restore <tarball> [--dry-run|--no-safety-backup|--no-migrate|--skip-integrity-check|--yes]
```
- **活性检查用真实机制**：`readPidFromLock(Paths.lock)` + `isProcessAlive(pid)`（`util/lock.ts`）——**stale/dead-pid 锁视为「没在跑」放行**（崩溃后正是要 restore 的时刻，绝不能被残留 PID 文件误拒）；仅当 LIVE pid 持锁才拒绝。
- 交互确认（破坏性），`--yes` 跳过。

## 4. PR-1b｜热恢复路由（G1 · 依赖 restart 语义，独立 PR）

### 4.1 订正 blocker #6：daemon 无自重启

`shutdown()` 只 `process.exit(0)`（`start.ts:659`），无 supervisor、无 `restart` 子命令、仓里无 systemd/launchd unit。所以**不能**「触发 graceful restart 自动应用」。

**重构后的热流程**（AC-4 改写）：
1. `POST /api/restore`（admin）上传 tarball（**新** multipart 端点 + 前端文件选择，非「复用」不存在的对偶）。
2. 服务端 `planRestore` 预检（版本闸 + incoming quick_check）；不过 → 400。
3. 通过 → 写 `.restore-pending/`（staged.tar.gz + restore-pending.json）+ 触发 graceful shutdown。
4. 响应明确：**「已暂存；将在 daemon 下次启动时应用」**——不宣称已完成。surface 现有「restart required」banner（`docs/troubleshooting.md:59` 既有模式）。
5. 文档写清：自动应用需把 daemon 跑在 supervisor（systemd `Restart=always` / launchd）下；否则用户手动 `start` 完成。

### 4.2 start.ts 应用 pending（订正 major：严格幂等序）

`applyPendingRestoreIfAny()` 插在 **acquireLock 之后、openDb 之前**（保证恰一个进程消费）：
- 顺序：durable swap（§3.3）→ 前滚 migrate → recordRecoveryEvent → **删 staged tarball** → **最后**清 marker（单次 fsync）。
- 幂等：boot 见 **marker 在但 tarball 没了** = 已消费 → 清 marker + 继续（**绝不** fail-closed 在它上面，否则半消费 = 永久起不来）。

## 5. PR-2｜Boot 完整性校验 + doctor（G2，fail-closed，AC-5/10）

### 5.1 `db/client.ts`（订正 minor：openDb 非唯一开库点 + 不在 client 里 loadConfig）

- migrate **之前**加 `PRAGMA quick_check`；`DbCorruptionError`（带 dbPath + 前若干行）。
- `openDb(opts: { skipIntegrityCheck?, synchronous?: 'NORMAL'|'FULL' })`——**由 start.ts 线程传入**，**不**在 `db/client.ts` 里 `loadConfig`（避免单二进制 init 环，[reference_binary_build_module_cycle]）。
- **归一 catch**：`new Database` / 首条 `PRAGMA journal_mode=WAL`（`client.ts:32`，先于门）就可能抛 `SQLITE_CORRUPT`/`SQLITE_NOTADB`，try/catch 归一成 `DbCorruptionError`。
- **注意（订正 blocker #4）**：截断/篡改 header 的库在 `journal_mode=WAL` 处就抛（走归一 catch，**不经** quick_check 门）；**只有 header 完好、深层 b-tree 页损坏**的库才走到 quick_check。故 quick_check 门的行为覆盖必须用**页级损坏 fixture**（见 §7 #2）。

### 5.2 `start.ts` fail-closed 出口

顶层捕获 `DbCorruptionError` → 打印可用备份清单（`rawCopyDb` 家族 + createBackup 包都列）+ 精确 restore 命令 → `process.exit(非0)`；库不可写 → 不写 recovery_events，改写 stderr + `logs/` 崩溃标记。`--skip-integrity-check` 逃生舱（响亮告警）。

### 5.3 `doctor.ts`（订正 blocker #5：readonly 的正确断言）

`checkDbIntegrity`：`new Database(Paths.db,{readonly:true})` 跑 quick_check（doctor 保持自己的只读开库）+ `checkBackups`（最近时间/份数/占用）。损坏标红给指引。**只读性守卫**（AC-10）：断言连接以 `{readonly:true}` 打开且**写操作抛**（byte-equality 对 integrity_check 无鉴别力——它本就不写，见 §7 #9）。

## 6. PR-3｜定时备份 + 保留轮转 + pre-migration（G3，AC-6/7）

### 6.1 config 新字段（`shared/schemas/config.ts`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `backupIntervalMs` | `0`（关） | >0 时 ticker 到点 `createBackup({kind:'scheduled'})`（健康运行库，VACUUM INTO 合法） |
| `backupRetentionCount` | `7` | 保留最近 N 份 scheduled/auto |
| `backupRetentionDays` | `30` | 见下明确规则 |
| `backupOnMigration` | `true` | 有 pending 迁移 → 迁移前 `rawCopyDb`（**非** createBackup） |
| `sqliteSynchronous` | `'NORMAL'` | PR-4；由 start.ts 线程进 openDb |
| `walCheckpointIntervalMs` | `0`（关） | PR-4 |

默认全部不改现状（`backupIntervalMs=0`）。

### 6.2 备份 ticker：`services/backupScheduler.ts`

- `startBackupScheduler`：interval>0 才起；重入门 `running=false`。
- **保留规则（订正 minor：count/days 矛盾）**：**KEEP 一个包 iff 它在最近 N 份内 OR 新于 D 天**；**只有同时不满足两条才 DELETE**；只轮转 `kind∈{scheduled,auto}`；手动/pre-restore/pre-migration 不参与；**永不删到 0**；加总量/尺寸上限兜「磁盘不无限长」。

### 6.3 pre-migration 备份（订正 blocker #7-adjacent、major #6）

start.ts migrate 前（openDb 内检测到 pending）：`backupOnMigration && 有 pending` → **`rawCopyDb`**（纯 DB 字节，**绝不** `listWorkflows`/VACUUM——用新二进制 schema select 旧库必 `no such column`）→ `pre-migration-<from>-<to>.tar.gz`（绑 appVersion，供 §3.4 回滚）。无 pending 则跳过（AC-7）。

## 7. 失败模式与测试策略 v2（每条必带变异实证；DR 测试一律 file-based openDb，禁 createInMemoryDb）

| # | 行为 | 测试 | 变异实证（订正后） |
|---|---|---|---|
| 1 | restore 往返**逐表**等价 | `rfc213-restore-roundtrip.test.ts`：backup → **在 live DB 插/删多表行**（制造与备份的差异）→ restore → 从 `sqlite_master` **动态枚举全部 44 表**、逐表 count + 内容 hash 等于备份 | 注释掉 DB swap → 因 live 已被改动 → 表 hash 不等 → 红（订正：v1 无改动则 swap 空操作也绿） |
| 2 | 损坏 fail-closed（**页级** fixture） | `rfc213-boot-integrity.test.ts`：构造 **header 完好、深层 b-tree 页翻字节** 的库 → openDb 抛 DbCorruptionError；start 退出码非 0 + 指引 | 去掉 quick_check 门 → 该页损坏库**静默开库** → 断言「应抛」红（订正 blocker #4：truncate/header fixture 走不到门） |
| 2b | 归一 catch | 同套件：truncate / header-clobber 库 → 在 `journal_mode=WAL` 处归一成 DbCorruptionError | 去掉归一 catch → 抛原始 SQLITE_* → 断言类型红 |
| 3 | 版本闸（身份） | 旧包（末 created_at 小）→ 前滚 + **旧库播种行跨前滚存活**（逐表 count，订正：不只「起库」）；新包（created_at 大）→ RestoreDowngradeError 原库不动 | 把方向判定写反 → 新包被接受 → 红 |
| 4 | -wal/-shm 清理 | `rfc213-swap-stale-wal.test.ts`：live DB **有未 checkpoint WAL 帧** → swap 进不同备份库 | **跳过 -wal/-shm unlink** → 下次 openDb 旧帧叠新库 → 数据不符/quick_check 失败 → 红（订正 major #10：无此测试则清理是静默空操作） |
| 5 | 安全备份失败中止 | `rfc213-safety-backup.test.ts`：令 rawCopyDb 失败（目标不可写）→ restore 早中止、**live db.sqlite 字节不变**、无半换 | 去掉 fail-closed → 无安全网继续 swap → 断言 live 未变红 |
| 5b | 损坏 incoming 拒绝 | 同套件：tarball 内 DB 页级损坏 → RestoreIntegrityError、原库字节不变 | 去掉 incoming quick_check → 损坏库被换入 → 红 |
| 6 | 热 restore 暂存重启序 | `rfc213-pending-restore.test.ts`（**file-based openDb**）：断言**第一个 openDb 连接看到的 schema/内容已是恢复后的**（订正 minor：仅「marker 消费」end-state 不能证明 before-openDb 时序）+ marker-present/tarball-missing = 已消费继续 | 把 applyPendingRestore 挪到 openDb 之后 → 首连接看到旧库 → 红 |
| 7 | 轮转规则 + interval=0 + 重入 | `rfc213-backup-retention.test.ts`：KEEP=最近N∪新于D、DELETE=双不满足、手动/pre-* 不动、永不删到 0；**interval=0 推进假时钟数个 tick 后零备份文件 + 无 timer 句柄**；**慢 createBackup 双 tick 只跑一次** | 删「永不删到 0」→ 单包被删红；删重入门 → 两次并发备份红；删 interval=0 守卫 → 出现备份文件红 |
| 8 | pre-migration 仅 pending + rawCopy | `rfc213-pre-migration-backup.test.ts`：有 pending → 出 pre-migration 包（**用 rawCopyDb**，不 select）；无 pending → 不出 | 去掉 pending 判断红；把 rawCopy 换回 createBackup → 加列迁移场景 `no such column` 红 |
| 9 | doctor 只读 | `rfc213-doctor-dr.test.ts`：损坏库 doctor 标红 + 指引；断言**连接 readonly**（写抛），非 byte-equality | 把连接改成可写 → 写不抛 → 只读断言红（订正 blocker #5：byte-equality 对 integrity_check 无鉴别力） |
| 10 | synchronous 真实下发 | `rfc213-sqlite-synchronous.test.ts`：cfg FULL → `PRAGMA synchronous` 读回 2；默认 → 1 | 写死 NORMAL → FULL 失效红 |
| 11 | 排除清单不回退 | 扩 `backup.test.ts`：token/secret.key/secret 恒不在任何包（含 rawCopy 包） | 从排除删 secret.key → 出现红 |

## 8. 与现有模块的耦合点（订正 §8）

- **DB 开库有两个真实入口**：业务 `openDb`（daemon/CLI）+ doctor 自己的只读 `new Database`。完整性门 + synchronous 进 `openDb`（opts 线程，**start.ts 传**）；doctor 走自己的 `checkDbIntegrity` 只读。**不**声称「单一开库点」。
- **备份两族**：健康运行库 → `createBackup`（VACUUM INTO，scheduled/manual）；损坏/未迁移/pre-* → `rawCopyDb`（字节拷贝）。二者共用 manifest 结构。
- **start.ts 顺序硬约束**：`acquireLock → applyPendingRestoreIfAny → openDb(整性门, synchronous) → reap → …`。
- **`recordRecoveryEvent`**：`RecoveryEventKind` union 加 `restore`/`pre-migration`/`worktree-skip`（T-task）；restore 事件在**换库后重开的 db**上写。
- **config 单一事实源**：新字段进 `shared/schemas/config.ts`；start.ts 读并线程进 openDb / scheduler。

## 9. PR-4｜更重的一层（G4，AC-8/9/11）——**worktree 部分显著缩范围**

### 9.1 G4b — synchronous 可配（低风险，先落）
`openDb` `PRAGMA synchronous=${opts.synchronous ?? 'NORMAL'}`（AC-9）。

### 9.2 G4c — WAL checkpoint 纪律
`walCheckpointIntervalMs>0` 时周期 `wal_checkpoint(TRUNCATE)`（AC-11）。真正 WAL 归档 PITR 仍非目标。

### 9.3 G4a — worktree 恢复（订正 major×3：**缩为同机 + 仅未提交 delta，去掉 bundle**）

设计门证明 v1 的「bundle base+snapshot」不可行：base/snapshot 在**备份排除的** `repos/` 镜像里；bundle root-reachable base = 整仓历史（爆 64MiB 上限，每任务被跳过）；异机无镜像可 `worktree add`。故 G4a **缩范围为同机恢复**：
- 只捕获**非终态任务** worktree 的**未提交 delta**（`git -C <wt> diff`）+ **untracked**（tar）——base/snapshot 本机镜像已有，不打 bundle。
- **untracked 存活订正**：resume 的 `rollbackToSnapshot` 会 `git clean -fd` 删 untracked（`stash create` 无 `-u`）。二选一：(a) restore 重建的 worktree **首次 resume 跳过 clean/reset**；(b) 另改 snapshot pin 为 `stash create -u`（更大，跨 RFC-130，谨慎）。v1 取 (a)。
- **不覆盖已存在 worktree（订正 major：避免吞掉更新的活）**：restore 只对 worktreePath **缺失**的非终态任务重建；若 worktree **在但与恢复行不符**（HEAD/stash mismatch）→ 先对现 worktree `git stash -u` 安全存 + 标 task `needs-manual-review`，**禁止** auto-resume 往不匹配的树上 reset。
- **异机凭据 brick（订正 major）**：restore 后 doctor/UI 检出 `cached_repos` 用本机 `secret.key` 解不开的行 → **响亮告警「重录凭据」** + recovery_event。文档：restore 默认**同机**；异机需用户另行保管 secret.key。

> 若用户要**跨机** worktree/整机恢复，需先把 `repos/` 镜像纳入备份 + 改 snapshot `-u`——那是更大特性，本 RFC 显式**不做**，作为后续（proposal 非目标已列）。

## 10. 设计门订正账（v1 → v2）

| v1 硬伤（设计门） | v2 订正 |
|---|---|
| pre-restore/pre-migration 用 `createBackup`（VACUUM INTO，要开健康库） | **`rawCopyDb` 原始字节拷贝**，耐损坏、不开库、不 select |
| swap：rename 后删 -wal（崩溃窗口 stale WAL 叠新库，可过 quick_check） | **先删 -wal/-shm → 再 rename → fsync 目录**，保留 tarball 至 rename 成功 |
| 热 restore「触发 graceful restart 自动应用」 | daemon **无自重启**：**只暂存 + banner**，supervisor 才自动应用；拆 PR-1b |
| pre-migration 备份可回滚，但 restore 强制前滚 → 重放炸库迁移 | **`--no-migrate` + 绑 appVersion + 拒绝错版本前滚** |
| 版本闸比 `.sql` 文件数（二进制里 =0，且 Drizzle 按 created_at） | **比迁移身份 `(hash,created_at)` vs `when`**，用 `countEmbeddedSqlMigrations()` |
| flock「已释放」判活 | **PID 文件 + isProcessAlive**，stale 放行 |
| AC-5 用 truncate/header fixture（走不到门，测试 vacuous） | **页级损坏 fixture** 才有门覆盖；truncate 归一 catch 单列 |
| AC-10 byte-equality 断只读（integrity_check 不写，无鉴别力） | 断**连接 readonly + 写抛** |
| AC-1 无改动往返（swap 空操作也绿） | **backup 后改 live 再 restore** + 全表 hash |
| restore-pending 消费序未定 | **acquireLock 后 openDb 前 + 严格幂等**，marker-在-tarball-无=已消费 |
| G4a bundle base+snapshot（在排除的 repos/；爆上限；异机无镜像） | **同机 + 仅未提交 delta+untracked**，不 bundle |
| G4a untracked 被 rollback `clean -fd` 删 | 重建树**首次 resume 跳过 clean** |
| 纯 DB restore + 更新 worktree → auto-resume 回滚吞未提交活 | mismatch → `stash -u` + `needs-manual-review`，禁 auto-resume |
| 异机 restore 封印凭据永久解不开 | doctor 响亮告警 + 文档同机 |
| 「openDb 是唯一开库点」 | 事实错（doctor 自开）；门进 openDb opts、doctor 自带 |
| recordRecoveryEvent kind 不在 union | 加 union + 换库后 db 写 |
