# RFC-213 — 灾难恢复（Disaster Recovery）

状态：Draft
作者：Claude（session 2026-07-21）
来源：`design/test-guard-audit-2026-07-21` 批评 #1「无 restore / 无 boot 完整性校验 / 无自动备份」；用户 2026-07-21 拍板纳入四层全部范围、损坏时 fail-closed。

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
- **终态任务的 worktree 恢复**：终态任务的工作树按现状可被 GC 回收，不纳入恢复物料（只保 base commit 引用够溯源）。
- **多机 / 主从复制**：单机单进程模型不变。
- **加密备份**：备份继续排除 `token`/`secret.key`（RFC-204 既有约束，`backup.test.ts:129` 锁定），不引入备份加密。

## 3. 用户故事

- **US-1（DB 损坏自救）**：daemon 因断电后 `db.sqlite` 损坏，重启时不再神秘 brick，而是打印「检测到 DB 损坏；可用备份：… ；执行 `agent-workflow restore <path>` 恢复」。用户跑一条命令即恢复到最近备份。
- **US-2（误操作回滚）**：用户误删了一批资源，想回到昨天。他从 Settings 导出的备份包（或定时备份）里挑一个，`restore` 回去；恢复前系统自动把「当前状态」也备份了一份，误恢复也能再翻回来。
- **US-3（无人值守耐久）**：用户什么都不点，daemon 每天自动备份、保留最近 7 份，磁盘不会被无限增长的备份撑爆；某次升级迁移写坏了库，pre-migration 备份让他一键回到升级前。
- **US-4（活跃任务不丢）**：恢复时，正在 `running`/`awaiting_*` 的任务的工作树（含未提交改动）能随备份一起回来，而不是恢复出一堆 worktree 丢失的 interrupted 僵尸。
- **US-5（运维体检）**：用户跑 `agent-workflow doctor`，除了现有的 lifecycle 体检，还能看到 DB 完整性、最近备份时间、备份数量/占用，一眼判断 DR 姿态是否健康。

## 4. 验收标准（AC）

- **AC-1｜restore 往返**：`backup` 产出的包，经 `restore` 后 DB 内容逐表等价（任务/工作流/ACL/记忆行数与关键字段一致），config/skills/workflows 复原；`token`/`secret.key` 不被备份带走、也不被 restore 触碰（沿用现有 seal）。
- **AC-2｜restore 前自动安全备份**：restore 执行前，当前 `~/.agent-workflow` 状态被自动备份到 `backups/pre-restore-<ts>.tar.gz`；即便恢复错了包也能翻回。
- **AC-3｜schema 版本闸**：restore 一个**更旧**的包 → 恢复后自动前滚迁移到当前二进制版本，daemon 正常起；restore 一个**更新**（来自更高版本二进制）的包 → **拒绝**并明确报「不能降级」，不动现有库。
- **AC-4｜热 restore 走暂存重启**：`POST /api/restore` 上传 + 校验通过后写 `restore-pending` 标记与暂存包，触发 graceful restart；重启在**打开 DB 之前**应用恢复（swap + 完整性校验 + 迁移），清标记后继续启动。全程不在活跃 DB 上热插拔。
- **AC-5｜损坏 fail-closed**：一个被写坏的 `db.sqlite`（quick_check 失败）→ daemon **拒绝启动**、退出码非 0、stderr 打印可用备份清单 + restore 命令；**绝不**继续用损坏库服务。健康库 → quick_check 通过、零行为变化。
- **AC-6｜定时备份 + 轮转**：`backupIntervalMs>0` 时 ticker 到点产出备份；`backupRetentionCount=N` 时只保留最近 N 份（+ 不早于 `backupRetentionDays`），**永不删到 0**；`backupIntervalMs=0` 关闭调度、零副作用。
- **AC-7｜pre-migration 备份**：起库检测到 pending 迁移且 `backupOnMigration=true` 时，迁移前先产出 `backups/pre-migration-<from>-<to>.tar.gz`；无 pending 迁移则不备份。
- **AC-8｜worktree 往返（活跃任务）**：`--include-worktrees`（或对应 config）时，非终态任务的工作树 delta 随备份捕获，restore 后这些任务的 `worktreePath` 内容（含未提交改动 + snapshot ref）复原；终态任务不纳入。
- **AC-9｜synchronous 可配**：`sqliteSynchronous='FULL'` 时 `openDb` 实际下发 `PRAGMA synchronous=FULL`；默认/缺省 = NORMAL，与现状字节等价。
- **AC-10｜doctor 体检**：`doctor` 报告 DB 完整性（只读 quick_check）、最近备份时间戳、备份份数与占用；损坏库时 doctor 明确标红并给 restore 指引（只读、绝不改库）。
- **AC-11｜WAL checkpoint 纪律**：checkpoint ticker 周期性 `wal_checkpoint(TRUNCATE)`，`-wal` 文件尺寸被有效约束（测试可断言 checkpoint 调用与 WAL 尺寸回落）。

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
