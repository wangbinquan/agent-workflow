# RFC-213 — 灾难恢复（Disaster Recovery）

状态：Draft（已过 4 视角对抗设计门；`design.md` 为 v2）
作者：Claude（session 2026-07-21）
来源：`design/test-guard-audit-2026-07-21` 批评 #1「无 restore / 无 boot 完整性校验 / 无自动备份」；用户 2026-07-21 拍板纳入四层全部范围、损坏时 fail-closed。

> **设计门**：本 RFC 经 feasibility/data-loss/test-adequacy/scope-coherence 四视角对抗自审（33 findings / 7 blocker / 18 major，多条经真实 bun:sqlite 实证）。硬伤已在 `design.md v2 §10 订正账` 逐条修正——下方 AC 已随之更新（安全备份改原始拷贝、换库崩溃安全序、热恢复只暂存不自重启、版本闸比迁移身份、worktree 缩为同机增量）。

---

## 1. 背景

平台是**单 Bun 进程 daemon**，全部状态落在两处：

- **SQLite 库**：`~/.agent-workflow/db.sqlite`（WAL 模式，`synchronous=NORMAL`）——任务、node_run、工作流、代理索引、ACL、记忆、审计、recovery_events 等一切结构化状态。单文件、单副本。
- **磁盘工作区**：`~/.agent-workflow/worktrees/`（每任务一个 git worktree）、`runs/`、`iso/`、`scratch/`、`logs/`。

现状调研（`design/RFC-213-disaster-recovery/design.md §2` 有 file:line 锚点）确认：平台的**进程崩溃恢复**很成熟（孤儿 run 回收、resume/replay、tombstone GC、recovery_events 审计），但**数据灾难恢复几乎为零**：

1. **有备份、没恢复**：`services/backup.ts` 用 `VACUUM INTO` 打一个 tar.gz 快照（DB + config + skills + workflows），但**全仓没有任何 restore 路径**——写了 tar 没人读得回去。用户手里攥着一个备份包，却没有受支持的方式把 `~/.agent-workflow` 重新灌回去。
2. **起库不校验完整性**：`db/client.ts` 的 `openDb()` 从不跑 `PRAGMA integrity_check` / `quick_check`。一个损坏的 `db.sqlite` 要么在 Drizzle migrate 深处抛异常把 daemon brick 掉（无任何指引），要么静默地拿损坏数据继续服务。唯一的启动后检查是 FK-only 且 **WARN-and-continue**。
3. **备份纯手动、无调度、无轮转**：只能靠 CLI `agent-workflow backup` 或 Settings 里点按钮，没有定时、没有保留策略、没有 pre-migration 自动备份。
4. **worktree 不可恢复**：备份显式排除 `worktrees/`、`runs/`、`iso/`、`scratch/`；DB↔磁盘对账只做单向（磁盘没了 → 修 DB 行为 tombstone），没有「DB 在、worktree 丢了 → 重建」的路径。
5. **`synchronous=NORMAL`**：为吞吐牺牲了一小段掉电耐久窗口，DR 姿态下值得显式决策。
6. **数据位置只认 env**：`AGENT_WORKFLOW_HOME` 是唯一旋钮，config 里没有备份目录 / 保留 / synchronous 的任何字段。

一旦 `db.sqlite` 损坏、误删、或被半途失败的迁移写坏，用户**无自救手段**。这是生产级可用性缺口。

## 2. 目标 / 非目标

### 目标（v1，用户拍板全four层）

- **G1｜Restore**：提供与现有 backup 对称的恢复能力——CLI `agent-workflow restore <tarball>`（冷恢复，daemon 必须停）+ `POST /api/restore`（热上传 → 暂存 → 重启时应用的安全流程），把 DB / config / skills / workflows 从备份包灌回，带 schema 版本兼容校验与**恢复前自动安全备份**。
- **G2｜Boot 完整性校验（fail-closed）**：`openDb()` 起库时先跑 `PRAGMA quick_check`。损坏则**拒绝启动 daemon**，打印可操作的恢复指引（列出可用备份 + 精确的 restore 命令），绝不拿损坏库对外服务。`doctor` 同步加只读完整性体检。
- **G3｜定时备份 + 保留轮转**：daemon 内加一个备份 ticker（对齐现有 hourly GC ticker 家族），按 `backupIntervalMs` 定时 `createBackup` + 按数量/天数轮转旧包；**pre-migration 自动备份**（有 pending 迁移时先备份，botched 迁移可回滚）。全部走新 config 字段，默认保守。
- **G4｜更重的一层**：
  - **G4a｜worktree 增量捕获**：备份可选纳入**非终态任务**的 worktree 恢复物料（base commit + snapshot ref + 未提交 delta，打成 git bundle），restore 能重建这些活跃任务的工作树。
  - **G4b｜synchronous 可配置**：`sqliteSynchronous: 'NORMAL' | 'FULL'`，默认 NORMAL；DR-critical 部署可切 FULL。
  - **G4c｜WAL checkpoint 纪律**：周期性 `wal_checkpoint(TRUNCATE)` 约束 WAL 膨胀（真正的 WAL-archiving point-in-time 作为显式后续，见非目标）。

### 非目标

- **完整 point-in-time recovery（PITR）/ WAL 帧归档**：G4c 只做 checkpoint 纪律；连续 WAL 归档 + 任意时刻回放是独立大特性，本 RFC 显式不做，留后续。
- **异地 / 云备份上传**：只做本地 `backups/` 目录；对象存储上传另起。
- **终态任务的 worktree 恢复**：终态任务的工作树按现状可被 GC 回收，不纳入恢复物料。
- **跨机 / 整机 worktree 恢复**（设计门新增）：worktree 的 base/snapshot 在**备份排除的** `repos/` 镜像里，跨机恢复需先把 `repos/` 镜像纳入备份 + 改 snapshot pin 为 `stash create -u`——是更大特性。G4a 只做**同机、仅未提交 delta**。异机 restore 会使封印的 `cached_repos` 凭据失效（AC-12 告警），需用户另行保管 `secret.key`。
- **daemon 自重启 / 内建 supervisor**（设计门新增）：daemon `process.exit(0)` 后不自拉起；热 restore 的自动应用依赖外部 supervisor（systemd `Restart=always` / launchd），本 RFC 只文档化、不内建。
- **多机 / 主从复制**：单机单进程模型不变。
- **加密备份**：备份继续排除 `token`/`secret.key`（RFC-204 既有约束，`backup.test.ts:129` 锁定），不引入备份加密。

## 3. 用户故事

- **US-1（DB 损坏自救）**：daemon 因断电后 `db.sqlite` 损坏，重启时不再神秘 brick，而是打印「检测到 DB 损坏；可用备份：… ；执行 `agent-workflow restore <path>` 恢复」。用户跑一条命令即恢复到最近备份。
- **US-2（误操作回滚）**：用户误删了一批资源，想回到昨天。他从 Settings 导出的备份包（或定时备份）里挑一个，`restore` 回去；恢复前系统自动把「当前状态」也备份了一份，误恢复也能再翻回来。
- **US-3（无人值守耐久）**：用户什么都不点，daemon 每天自动备份、保留最近 7 份，磁盘不会被无限增长的备份撑爆；某次升级迁移写坏了库，pre-migration 备份让他一键回到升级前。
- **US-4（活跃任务不丢）**：恢复时，正在 `running`/`awaiting_*` 的任务的工作树（含未提交改动）能随备份一起回来，而不是恢复出一堆 worktree 丢失的 interrupted 僵尸。
- **US-5（运维体检）**：用户跑 `agent-workflow doctor`，除了现有的 lifecycle 体检，还能看到 DB 完整性、最近备份时间、备份数量/占用，一眼判断 DR 姿态是否健康。

## 4. 验收标准（AC）

- **AC-1｜restore 往返**：`backup` 产出的包，经 `restore` 后 DB 内容**逐表**等价——测试须在 backup 与 restore 之间**改动 live DB**（多表插/删），再断言 restore 把状态还原到备份（从 `sqlite_master` **动态枚举全部表** count + 内容 hash，非 cherry-pick 少数表）；config/skills/workflows 复原；`token`/`secret.key`/`secret` 不被备份带走、也不被 restore 触碰。
- **AC-2｜restore 前自动安全备份（原始拷贝，fail-closed）**：restore 执行前，当前 DB 以**原始文件拷贝**（`rawCopyDb`，非 VACUUM/createBackup——耐损坏、不开库）存到 `backups/pre-restore-<ts>.tar.gz`；**安全备份失败即中止 restore**、原库一字节不动（除非 `--no-safety-backup`）。
- **AC-3｜schema 版本闸（迁移身份）**：按**迁移身份**（备份 `__drizzle_migrations` 末条 `(hash,created_at)` vs 当前二进制 `_journal.json` 的 `when`，用 `countEmbeddedSqlMigrations()` 处理单二进制）判定：**更旧**包 → 前滚且**旧库播种行跨前滚存活**（不只「起库」）；**更新/发散**包（`created_at > 二进制 maxFolderMillis`）→ **拒绝**、不动现有库。
- **AC-4｜热 restore 只暂存、下次启动应用**：`POST /api/restore` 校验通过后写 `.restore-pending`（暂存包 + marker），触发 graceful shutdown 并响应**「已暂存，将在 daemon 下次启动时应用」**（daemon **无自重启**——自动应用需 supervisor）。下次 `start` 在 **acquireLock 之后、openDb 之前**应用恢复（崩溃安全 swap + 完整性校验 + 迁移），严格幂等消费 marker。
- **AC-5｜损坏 fail-closed（页级 fixture）**：**header 完好、深层页损坏**的 `db.sqlite`（quick_check 失败）→ daemon **拒绝启动**、退出码非 0、stderr 打印可用备份清单 + restore 命令；truncate/篡改 header 的库走归一 catch 同样拒起。健康库零行为变化。
- **AC-6｜定时备份 + 轮转**：`backupIntervalMs>0` 到点产出；保留规则 **KEEP iff 最近 N 份 ∪ 新于 D 天，DELETE 仅当双不满足**，只轮转 scheduled/auto、**永不删到 0**、有总量上限；`backupIntervalMs=0` 时**推进假时钟数 tick 后零备份文件 + 无 timer 句柄**；备份 ticker 有重入门（慢备份双 tick 只跑一次）。
- **AC-7｜pre-migration 备份（原始拷贝、绑版本）**：起库检测到 pending 迁移且 `backupOnMigration=true` → 迁移前 **`rawCopyDb`**（**绝不** `listWorkflows`/VACUUM——新二进制 schema select 旧库必 `no such column`）产出绑 `appVersion` 的 `pre-migration-<from>-<to>.tar.gz`，可配 `restore --no-migrate` 回滚（需先换回旧二进制）；无 pending 则不备份。
- **AC-8｜worktree 往返（同机、活跃任务、增量）**：`--include-worktrees` 时，非终态任务 worktree 的**未提交 delta + untracked**随备份捕获（base/snapshot 本机镜像已有，不打 bundle）；restore 只对 **worktreePath 缺失**的非终态任务重建、**首次 resume 跳过 clean/reset**（否则 `git clean -fd` 会删 untracked）；worktree **在但与恢复行不符**→ 先 `git stash -u` 安全存 + 标 `needs-manual-review`、禁 auto-resume；终态任务不纳入。**跨机整机恢复非目标。**
- **AC-9｜synchronous 可配**：`sqliteSynchronous='FULL'`（由 start.ts 线程进 openDb）→ `PRAGMA synchronous` 读回 2(FULL)；默认 = NORMAL，与现状字节等价。
- **AC-10｜doctor 体检（正确只读断言）**：`doctor` 用自己的 `{readonly:true}` 连接跑 quick_check + 报最近备份时间/份数/占用；损坏标红给 restore 指引。守卫断言**连接以 readonly 打开且写抛**（非 byte-equality——integrity_check 本不写、无鉴别力）。
- **AC-11｜WAL checkpoint 纪律**：`walCheckpointIntervalMs>0` 周期 `wal_checkpoint(TRUNCATE)`，`-wal` 尺寸被约束。
- **AC-12｜异机凭据告警**：restore 后若 `cached_repos` 有用本机 `secret.key` 解不开的封印 URL（异机恢复）→ doctor/UI **响亮告警「重录凭据」** + recovery_event；文档写清 restore 默认同机。

## 5. 测试策略摘要

见 `design.md §7`。每条 AC 至少一条行为测试，且每个新守卫/失败路径必做**变异实证**（把保护逻辑写反 → 对应测试必红）。重点必写：
- restore 往返逐表等价 + seal 不泄漏；
- 损坏库 fail-closed（构造 quick_check 失败的库文件，断言 daemon 拒起 + 指引文案 + 退出码）；
- schema 版本闸（旧包前滚 / 新包拒绝）；
- 热 restore 暂存重启（标记文件在打开 DB 前被消费）；
- 轮转永不删到 0 + interval=0 零副作用；
- pre-migration 备份仅在有 pending 迁移时触发；
- worktree delta 往返（活跃任务复原 / 终态不纳入）；
- synchronous 配置真实下发；
- doctor 只读体检不改库。

## 6. 风险与回滚

- **restore 是破坏性操作**：以「恢复前自动安全备份 + 冷恢复默认 + 热恢复走暂存重启」三重护栏兜底；任何 swap 都是「temp 文件 → 完整性校验 → 原子 rename」，失败保留原库。
- **迁移前滚风险**：pre-migration 备份 + 前滚失败即回滚到 pre-migration 包。
- **worktree 捕获体量**：只捕获非终态任务 + 只存 delta/bundle（不存整库对象），并对单任务体量设上限、超限记 recovery_event 跳过而非撑爆备份。
- **fail-closed 误伤**：quick_check 极少假阳；仍提供 `--skip-integrity-check`（带响亮告警）逃生舱，避免完整性检查本身把可救的库锁死在门外。
