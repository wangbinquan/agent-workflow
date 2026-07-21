# 灾难恢复（备份与恢复）

本文面向运维 / 自部署用户，覆盖 agent-workflow 的备份、恢复、启动完整性检查与恢复后处置（RFC-213）。

平台的全部状态落在 `~/.agent-workflow/`（可用 `AGENT_WORKFLOW_HOME` 改位置）两处：

- **SQLite 库** `db.sqlite`（WAL 模式）——任务、工作流、代理、ACL、记忆、审计等一切结构化状态；
- **磁盘工作区** `worktrees/`（每任务一个 git worktree）、`repos/`（源仓镜像）、`runs/`、`logs/`。

备份产物统一是 `~/.agent-workflow/backups/` 下的 `.tar.gz`，内含 `manifest.json`
（种类、产生它的二进制版本、迁移身份），恢复时的版本闸靠它判定。

**备份永远不含 `secret.key` 与 `token`**。`secret.key` 是仓库凭据的加密钥匙——请与备份一起
**单独**保管（见 [异机恢复](#4-异机恢复与凭据)）。

---

## 1. 备份

### 1.1 手动备份：`agent-workflow backup`

```bash
agent-workflow backup [--include-worktrees]
```

产出 `backups/agent-workflow-<时间戳>.tar.gz`，内容：

| 内容            | 说明                                             |
| --------------- | ------------------------------------------------ |
| `db.sqlite`     | `VACUUM INTO` 一致性快照                         |
| `config.json`   | daemon 配置                                      |
| `skills/`       | 完整技能目录（文件系统是技能的事实源）           |
| `workflows/`    | 每个工作流一份 YAML（可移植形式；DB 里同样有）   |
| `manifest.json` | 种类 / 二进制版本 / 迁移身份（恢复版本闸的依据） |
| `worktrees/`    | 仅 `--include-worktrees` 时（见下）              |

不包含：`secret.key`、`token`、`repos/`、`runs/`、`logs/`，默认也不含 `worktrees/`。

该命令自己打开数据库（顺带应用 pending 迁移），daemon 在不在跑都能执行。
Settings 页的「导出备份」按钮（`POST /api/backup`）等价，但**不带** worktrees。

#### `--include-worktrees` 及其限制

把**非终态**任务（`running` / `pending` / `awaiting_review` / `awaiting_human` /
`interrupted`）的 worktree 一并捕获，供恢复后重建。注意三条硬限制：

- **整树捕获**：打包的是 worktree 的完整工作树（只排除 `.git`），**包含 `.gitignore`
  忽略物**（`node_modules/`、构建产物等）。
- **单任务 64 MiB 上限**：超限的任务被**跳过**（不捕获、不失败），只落 daemon 日志。
  大仓 + 依赖装满的 worktree 很容易超限。
- **tar 失败逐任务跳过**：某个 worktree 打包失败（如 agent 正在其中写文件）只跳过该任务，
  不会让整次备份失败。

### 1.2 自动定时备份与轮转

`config.json`（或 `agent-workflow config set <key> <value>`）里的 RFC-213 键，全部默认保守
（不改变既有安装的行为）：

| 键                        | 默认       | 含义                                                                 |
| ------------------------- | ---------- | -------------------------------------------------------------------- |
| `backupIntervalMs`        | `0`（关）  | >0 时 daemon 每隔该毫秒数自动 `createBackup`（scheduled 种类）并轮转 |
| `backupRetentionCount`    | `7`        | 轮转规则里的「最近 N 份」                                            |
| `backupRetentionDays`     | `30`       | 轮转规则里的「新于 D 天」                                            |
| `backupMaxTotalBytes`     | `0`（关）  | 可轮转集合的总字节上限；超出时从最旧开始删到装下                     |
| `backupOnMigration`       | `true`     | 启动检测到 pending 迁移时先做 pre-migration 原始拷贝备份             |
| `sqliteSynchronous`       | `'NORMAL'` | `PRAGMA synchronous`；掉电耐久性要求高的部署可切 `'FULL'`            |
| `walCheckpointIntervalMs` | `0`（关）  | >0 时周期执行 `wal_checkpoint(TRUNCATE)` 约束 `-wal` 膨胀            |

**轮转规则**（每次定时备份 tick 后执行）：

- 只轮转文件名为 `scheduled-*` / `auto-*` 的包（**可轮转集**）；**手动备份
  （`agent-workflow-*`）与 `pre-restore-*` / `pre-migration-*` 永不自动删除**，需要手工清理。
- **KEEP 当且仅当：在最近 N 份内，或新于 D 天**；两条都不满足才删除。
- `backupMaxTotalBytes > 0` 时，对上一步存活下来的可轮转集再做总量收敛：超出上限就从最旧
  开始删，直到装下（至少留 1 份）。上限**只管可轮转集**，manual / pre-\* 不计入也不受其约束。
- **永不删到 0**：整个 `backups/` 目录至少留下最新的 1 个包。
- 定时备份有重入保护：上一次备份还没做完时到点的 tick 直接跳过。

`backupIntervalMs=0`（默认）时完全不起 ticker，也不做任何轮转——手动备份的清理始终是你的事。

### 1.3 pre-migration 自动备份

`backupOnMigration=true`（默认）时，daemon 启动发现数据库的迁移进度落后于当前二进制
（即本次启动会应用新迁移），会在迁移**之前**做一次**原始字节拷贝**备份：

- 产物：`backups/pre-migration-<旧迁移轴>-<新迁移轴>-<时间戳>.tar.gz`；
- 用 `rawCopyDb`（直接拷 `db.sqlite` + `-wal`/`-shm` 字节），不解析内容——旧 schema 的库
  新二进制根本 SELECT 不动，也可能已经损坏，字节拷贝对两者都免疫；
- best-effort：备份失败只记日志，**不阻塞启动**；
- manifest 里绑定了产生它的二进制版本（见 [版本闸](#211-版本闸语义)）。

一次升级把库写坏时，用它回滚：先换回旧二进制，再
`agent-workflow restore backups/pre-migration-....tar.gz --yes --no-migrate`。

### 1.4 WAL checkpoint 纪律

`walCheckpointIntervalMs > 0` 时 daemon 周期执行 `PRAGMA wal_checkpoint(TRUNCATE)`，
把 WAL 帧折进主库文件并截断 `-wal`，避免长期运行下 `-wal` 无界膨胀。默认关（0）。

---

## 2. 恢复

### 2.0 什么时候需要恢复：启动完整性检查（fail-closed）

daemon 每次启动都会对 `db.sqlite` 跑 `PRAGMA quick_check`（打不开 / 首个 PRAGMA 就抛错的
文件同样按损坏处理）。**检测到损坏时拒绝启动**（退出码非 0），并在 stderr 打印：

- 损坏详情（quick_check 前几行）；
- `backups/` 下可用备份清单（最新在前，最多列 5 个）；
- 精确的恢复命令：`agent-workflow restore <最新备份>`；
- 最后一招（不安全）：`AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK=1 agent-workflow start`
  ——跳过完整性门强行启动。只用于「quick_check 误报但库其实还能读」的抢救场景，
  正常情况请走 restore。

`agent-workflow doctor` 里的 `db integrity` 项跑的是同一检查（只读，不动库文件）。

### 2.1 冷恢复：`agent-workflow restore`

```text
usage: agent-workflow restore <tarball> [--yes] [--stage] [--dry-run]
                              [--no-safety-backup] [--no-migrate] [--skip-integrity-check]
```

**冷恢复要求 daemon 已停**（`agent-workflow stop`）。恢复期间进程会持有 daemon 的
单实例锁，杜绝「恢复到一半 daemon 被拉起」的竞态；崩溃后残留的过期锁（进程已死）不会
挡住恢复，但**活着的 daemon 会**——那种情况用 `--stage`（见 2.2）。

行为分层：

- 不带 `--yes` / `--stage`：**只打印恢复计划**（包种类、方向、双方迁移身份）就停下，
  不改任何东西；
- `--dry-run`：同上，且显式声明 dry-run。这两种只读形态在 daemon 运行中也允许执行；
- `--yes`：真正执行（**破坏性**，覆盖当前数据）。

一次 `--yes` 恢复按以下顺序执行（任何一步拒绝都发生在动到现有数据**之前**）：

1. 解包 + 读 manifest，**版本闸**判定（见 2.1.1）；`downgrade` 直接拒绝。
2. 合并包内 DB 的 WAL 帧，对包内 DB 跑 `quick_check`——**损坏的备份不会被换入**
   （除非 `--skip-integrity-check`）。
3. **恢复前安全备份（fail-closed）**：
   - `backups/pre-restore-<时间戳>.tar.gz` —— 当前 `db.sqlite` 的**原始字节拷贝**
     （耐损坏，正是为了「当前库已坏」的场景）；
   - `backups/pre-restore-fs-<时间戳>.tar.gz` —— 当前 `config.json` + `skills/`
     （这两样会被恢复覆盖 / 删除重建，且 skills 的事实源就是文件系统）。
   - **安全备份失败即中止整个恢复**，当前数据一字节不动。误恢复之后想反悔，就用这两个包
     再 restore 回来。
4. 崩溃安全换库：先删当前库的 `-wal`/`-shm`（否则旧 WAL 帧会按页号叠进新库造成静默损坏），
   再原子 `rename` 换入，再 fsync 目录。
5. 复原 `config.json` 与 `skills/`（`secret.key`、`token` 不被触碰）。
6. 前滚迁移到当前二进制（`--no-migrate` 时跳过），随后：
   - 把所有非终态任务标记 `auto_recovery_suspended`（见 [第 3 节](#3-恢复后的状态)）；
   - 若备份含 worktrees，则重建磁盘上已缺失的活跃任务 worktree；
   - 写入一条 `restore` 种类的 recovery_event 审计。

成功后打印方向、是否前滚、安全备份路径与各组件复原情况。

#### 2.1.1 版本闸语义

版本闸比较的是**迁移身份**：备份库最后一条已应用迁移的 `created_at`，对比当前二进制
迁移日志（`_journal.json`）的最大 `when`。

- 备份**更新**于二进制（`downgrade`）→ **拒绝**，现有数据不动。备份是新版本二进制做的，
  旧二进制没有对应 schema 的代码——先升级二进制，或挑更旧的备份。
- 备份**更旧**（`forward`）→ 接受，恢复后自动前滚迁移到当前二进制。
- 相同（`same`）→ 接受，无需前滚。
- 无 manifest 的老备份按 `forward` 处理。

`pre-migration` 种类的包额外**绑定产生它的二进制版本**：拿着它在**不同版本**的二进制上
做「恢复 + 前滚」会被拒绝——前滚只会把当初炸库的那次迁移重放一遍。正确姿势是先换回旧
二进制再 `--no-migrate` 恢复。这里比较的版本就是 `agent-workflow version` 的输出
（release 二进制 = 构建时的 git tag；开发环境 = `0.0.0-dev`；可用环境变量
`AGENT_WORKFLOW_VERSION` 覆盖）——拿不准某个备份配哪个二进制时，对着两边的 `version`
输出与 manifest 里的 `appVersion` 核对。

#### 2.1.2 逃生舱 flag：什么时候用、代价是什么

| flag                     | 适用场景                                                          | 风险                                                                       |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `--no-migrate`           | pre-migration 回滚（先换回旧二进制）；或想保持备份原样再观察      | 库停在旧 schema：**当前（新）二进制起不动它**，必须配套旧二进制使用        |
| `--no-safety-backup`     | 磁盘空间不足以再放一份安全备份，且你**确定**当前数据可弃          | 误恢复无法反悔——当前 DB / config / skills 的最后状态直接丢失               |
| `--skip-integrity-check` | 唯一的备份 quick_check 不过、但内容大体可读，两害相权取其轻的抢救 | 把明知损坏的库换入线上；该 flag 会贯通到恢复后的首次开库（那道门同样跳过） |

### 2.2 热暂存恢复（daemon 运行中）：`--stage` / Settings 上传

daemon 在跑时不能冷换库，改为「**暂存，下次启动时应用**」：

- **CLI**：`agent-workflow restore <tarball> --stage`（daemon 运行中执行是安全的）；
- **API**：`POST /api/restore`（admin-only，multipart 字段 `file` 上传 tar.gz）；
- **UI**：Settings 页「从备份恢复…」按钮（走同一 API），成功后显示
  「已暂存，重启 daemon 生效」。

三条入口都会先做**完整的入口校验**（与启动时真正应用的校验同深度）：包里必须有
`db.sqlite`、WAL 可合并、`quick_check` 通过（CLI 可用 `--skip-integrity-check` 越过，
该选择会随暂存一起生效）、且不是 downgrade。**坏包在门口就被拒绝**，daemon 保持健康——
不会出现「暂存了个坏包、每次启动都炸」的自锁。

校验通过后，包被拷进 `~/.agent-workflow/.restore-pending/`（`staged.tar.gz` + 标记文件）。
**daemon 不会自动重启**——重启它才会生效：

```bash
agent-workflow stop && agent-workflow start
# 或交给 supervisor（见第 5 节）
```

下次启动时，暂存的恢复在**拿到单实例锁之后、打开数据库之前**应用（流程同冷恢复，含安全
备份与前滚），恢复回来的 `config.json` 在同一次启动即生效。应用是严格幂等的：中途崩溃后
再启动不会重复应用。

**查看 / 取消暂存**（目前仅 API，Settings 界面只有上传入口）：

```bash
# 查看：pending = 当前暂存（请求时间 / 包大小 / 附带选项）；failed = 历史失败隔离目录
curl -H "Authorization: Bearer <admin token>" http://127.0.0.1:8720/api/restore/pending

# 取消（解除武装）
curl -X DELETE -H "Authorization: Bearer <admin token>" http://127.0.0.1:8720/api/restore/pending
```

#### 暂存失败的自愈与取证

启动时应用暂存恢复失败（理论上入口校验已挡掉绝大多数；剩余如磁盘满、恢复瞬间的 IO 错）
**不会砖掉启动**：整个 `.restore-pending/` 会被改名隔离为

```text
~/.agent-workflow/.restore-pending.failed-<时间戳>/   # 内含 error.txt（失败原因）+ 原暂存包
```

然后 daemon 用**未被触碰的原库**正常启动。失败详情通过 `GET /api/restore/pending` 的
`failed` 数组可见；隔离目录不会自动清理，取证后手工删除即可。只有极端的文件系统级异常
（连隔离改名都失败）才会拒绝启动，此时 stderr 会给出 `rm -rf ~/.agent-workflow/.restore-pending`
的手工解除指引。

---

## 3. 恢复后的状态

### 3.1 非终态任务被挂起（mismatch-protect）

恢复回来的任务行是**备份时刻**的，而磁盘上的 worktree 是**当前**的——两者可能已经不符。
为防止自动恢复循环把一棵**更新的** worktree 静默回滚到**过时的**快照，restore 会把所有
非终态任务（`running` / `pending` / `awaiting_review` / `awaiting_human` / `interrupted`）
标记为 `auto_recovery_suspended`：

- 自动 resume / 自动修复对这些任务**不再生效**；
- **手工 resume 是知情选择**：resume 会照常把重跑节点回滚到它的 pre-run 快照
  （包括 `git clean -fd` 清掉未跟踪文件）——动手前先确认 worktree 里没有你要留的东西；
- `agent-workflow doctor` 的 `lifecycle` 行会显示被挂起（quarantined）的任务数；任务详情
  页也会露出恢复审计横幅。

### 3.2 worktree 重建（同机、仅备份含 worktrees 时）

仅当备份带 `--include-worktrees` 捕获过 worktrees 时，restore 会对满足**全部**条件的任务
重建工作树：任务仍在（恢复后的）DB 里、状态非终态、其 `worktreePath` 在磁盘上**缺失**、
且源仓镜像（`repos/` 下）仍在本机。重建方式：从镜像 `git worktree add` 检出任务分支，再把
捕获的工作树内容覆盖上去。

- **已存在的 worktree 绝不覆盖**（现场的活可能比备份新）；
- 重建出来的树定位是**供查看 / 手工抢救**（把没提交的活捡回来）；resume 依旧走正常回滚
  语义，不会因为这棵树是重建的而有任何特殊化；
- 源仓镜像不在（典型：异机恢复）时跳过并记录原因。

---

## 4. 异机恢复与凭据

备份**不含 `secret.key`**（有意为之——备份文件外泄不应连带凭据泄漏）。仓库凭据
（`cached_repos` 里的 `url_enc`）是用本机 `secret.key` 加密封存的，因此把备份恢复到
**另一台机器**后这些凭据**解不开**：

- `agent-workflow doctor` 的 `repo credentials` 项会**响亮报错**（`secret.key` 缺失，或
  N 条凭据解密失败），不会让你在克隆神秘失败时抓瞎；
- **处置二选一**：
  1. 把旧机的 `~/.agent-workflow/secret.key` 一并迁移到新机同路径（权限保持 0600），或
  2. 在新机上对相关仓库重新发起接入、重新录入凭据。

worktree 重建同样默认**同机**（依赖 `repos/` 镜像与既有快照）；异机恢复后活跃任务的
工作树无法重建，只能靠重新克隆 + 手工处理。

**建议**：把 `secret.key` 当作与备份包同级的资产，异地保管（但不要和备份包放在同一个
存储桶 / 同一份归档里）。

---

## 5. supervisor 建议（systemd 示例）

热暂存恢复「重启后生效」的最后一步可以交给 supervisor 完成。systemd 单元示例：

```ini
[Unit]
Description=agent-workflow daemon
After=network.target

[Service]
ExecStart=/usr/local/bin/agent-workflow start
Restart=on-failure
RestartSec=2
# 交给 daemon 自己的 30s 优雅停机
TimeoutStopSec=45
User=youruser
Environment=AGENT_WORKFLOW_HOME=/home/youruser/.agent-workflow

[Install]
WantedBy=multi-user.target
```

说明：

- **暂存恢复在启动早期应用**（拿锁之后、开库之前），supervisor 只要把进程拉起来，恢复就
  自动完成；`systemctl restart agent-workflow` 即「使暂存生效」。
- **失败自愈不会造成重启死循环**：暂存包应用失败会被隔离进 `.restore-pending.failed-*`，
  下一次启动用原库正常起——同一个坏包不会被反复重试。
- 但**数据库损坏的 fail-closed 是确定性的非 0 退出**：`Restart=on-failure` 下 systemd 会
  重试到 start-limit（默认 10 秒 5 次）后停住并标记 failed。这是预期行为——此时需要人工
  `journalctl -u agent-workflow` 查看指引并执行 restore，而不是让 supervisor 无限重启。
- `agent-workflow stop` / SIGTERM 触发 30 秒优雅停机；`TimeoutStopSec` 给足余量。

**备份异地存放**：`backups/` 在数据同一块盘上——盘挂了备份陪葬。用 cron / systemd timer 把
`~/.agent-workflow/backups/` 定期 rsync / rclone 到异地（对象存储、NAS、另一台机器），并把
`secret.key` 按第 4 节单独保管。恢复时把 tar.gz 拉回本地任意路径即可
（`restore` 接受任意路径的 tarball）。

---

## 6. 已知限制

- **worktree 捕获是整树快照**：包含 `.gitignore` 忽略物（`node_modules/`、构建缓存等），
  大仓 worktree 很容易超过单任务 64 MiB 上限而被跳过（仅落日志）；且**未提交的删除**在
  重建时会被复活——重建 = 分支检出（被删文件回来）+ 捕获内容覆盖（覆盖不了「不存在」）。
- **manual / pre-restore / pre-migration 备份不参与任何自动轮转**（`backupMaxTotalBytes`
  也不管它们），长期运行请定期手工清理 `backups/` 下这些前缀的旧包。
- **定时备份不含 worktrees**：`--include-worktrees` 只在手动 CLI 备份上可用；Settings
  「导出备份」与定时备份都不带。
- **restore / pre-migration 的 recovery_event 暂无独立 UI 告警面**：实例级恢复审计目前
  只落数据库（任务详情页的恢复横幅只覆盖任务级事件）；恢复后的体检以
  `agent-workflow doctor` 为准。
- **热暂存的查看 / 取消**：Settings 备份卡片会显示已暂存恢复的状态条（时间 /
  大小 / 取消按钮）与最近一次失败残留；等价的 API 为
  `GET` / `DELETE /api/restore/pending`（admin）。

---

## 7. 日常体检速查

```bash
agent-workflow doctor
```

与灾难恢复相关的检查项：

| 项                 | 语义                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `db integrity`     | 对 `db.sqlite` 只读 `quick_check`；损坏则 doctor 失败并给出 restore 指引    |
| `backups`          | 信息项：备份数量 / 最新时间 / 总占用；一眼判断「最近一次备份是什么时候」    |
| `repo credentials` | 封存凭据是否可用本机 `secret.key` 解开；异机恢复 / 丢 key 会在这里响亮报错  |
| `lifecycle`        | 信息项：interrupted / awaiting-\* / 被挂起（quarantined）任务数与未关告警数 |

建议在每次恢复完成后、以及例行巡检时各跑一次。
