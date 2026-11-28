# 发布 / 升级 / 回滚 runbook

> RFC-310 T111① 收口（2026-08-24）。此前仓内只有 `design/RFC-310-*/design.md` 的一段
> **cutover** runbook（数据迁移步骤），没有面向运维的发布回滚文档。
>
> **本文只写仓内真实存在的机制**，每条命令都能在 `packages/backend/src/cli/` 找到实现。
> 读到与源码不符的地方，以源码为准并回来改这份文档——一份过期的 runbook 比没有更危险。

本篇以**单二进制自托管 daemon** 为主。含 RFC-398 的候选版本默认在 `start` 内自动完成
epoch-1 → epoch-2 升级：停止旧版本、保留备份、换二进制后直接启动。v0.19.3 没有这条自动路径，
不能把本文当作该版本已经可用的说明。CrewStation 的迁移 Job、平台切换与独立校验见
[托管部署运行手册](./crewstation-deployment.md#epoch-2-发布的数据库切换)。

---

## 0. 先记住三件事

1. **数据在 `AGENT_WORKFLOW_HOME`（默认 `~/.agent-workflow`）**。epoch 2 的 SQLite 库由
   `database-generation.json` 的 v2 pointer 选择，通常是 `databases/<generationId>/db.sqlite`；
   不要把根目录遗留的 `db.sqlite` 当作当前业务库。PostgreSQL pointer 记录目标 profile。
2. **单机从 epoch 1 升级默认自动执行备份、转换与校验，再启动 daemon**。
   `config.json` 设置 `"autoEpochMigration": false` 时保留人工流程。自动升级**不因旧数据而拒绝**
   （RFC-626）：转换不了的数据按固定规则处置并逐条列入报告（§2）。只有环境问题（磁盘空间、旧库结构、
   配置文件、PostgreSQL 建库权限）、非自动进行中的操作、pointer/receipt 不一致或退役 generation
   才拒绝启动并给出指引。同 epoch 的后续结构升级由原生 schema history 执行。
3. **回退窗口截止于目标首次业务写入**；主动 `complete` 开始保留源库时也会关闭窗口。
   之后走前滚修复或目标备份恢复。旧二进制不接受 epoch-2 文件或 v2 pointer；仅换回旧 binary
   不会把目标库变回 epoch 1。切换源、备份、回执与历史证据不会因 `complete` 自动删除。

---

## 1. 发布（维护者）

推一个 `v*` tag 即触发 `.github/workflows/release.yml`：

1. `create-release` 仅在不存在时建 draft；重跑已公开版本不会把它改回草稿。
2. `build` 为 macOS arm64 / Linux x86_64 / Linux arm64 / Windows x86_64 构建，先上传为本次
   workflow artifact。此时不修改任何 release 资产。
3. `upgrade-gate` 使用这些候选产物和 registry 的 `gate` 集合：Linux 运行全部 SQLite、PG 与
   逐级链变体，macOS / Windows 运行 SQLite 两种变体。先执行 `registry.ts --check`，并从 GitHub
   **所有分页的已公开 release**（含 prerelease）里按语义版本顺序选择低于本 tag 的最高版本，检查登记与种子覆盖。
4. `publish` 依赖全部 build 与 upgrade-gate 成功，才以 `--clobber` 上传四个正式资产并取消草稿。
   任一门失败，新 release 保持 draft；已公开版本重跑失败时其旧资产保持原样。

```bash
git tag v1.2.3 && git push origin v1.2.3
```

⚠️ 自定义中文 release note **要等 workflow 完全跑完再** edit 进去，否则
`generate_release_notes` 会覆盖（`CLAUDE.md` §工作准则）。

**每次公开后立即登记该发布版**（完整本地 tags、`gh` 读取权限、Bun 1.4.3）：

```bash
bun scripts/release-upgrade/registry.ts --write
bun scripts/release-upgrade/registry.ts --check
# 按真实二进制录制数据，补齐种子与独立映射预言后更新覆盖账本。
bun scripts/release-upgrade/seed-ledger.ts check --write-coverage
```

将 `releases.json`、实际发布 SQL 字节、对应种子、mapping-oracle 和覆盖账本一起审阅入库。
新增迁移／epoch-2 history 版本必须同步提交种子文件与映射预言；不能以空库能启动代替数据验收。
覆盖账本必须没有失败／缺表，豁免须为对应 build 的已批准项。登记检查、种子准备、L1 转换、
L2 二进制验收各自保留证据，不能互相代签。

`release-upgrade-nightly.yml` 默认构建固定到同一 main SHA 的候选。Linux 使用 registry 的
`nightlyShards` 覆盖每个有 linux-x86_64 产物的版本；PG 变体覆盖其中支持 PG 的版本。
macOS／Windows 使用 gate 集合。手动输入 `candidate_ref`，或已有候选的
`candidate_artifact_run_id` 与 artifact prefix（二选一）；产物名为 `<prefix>-<runner>`，
其中 runner 为 `ubuntu-latest`、`macos-latest`、`windows-latest`。每片上传机器可读 summary。

最早的 v0.1.0／v0.10.0／v0.16.3 没有 Windows 发布资产；Windows gate 用原 tag 归档源码及
该 tag 指定的 Bun 版本构建，摘要明确记为 `tag-build`（证据等级 4）。这些历史构建没有原生
Windows shutdown 通道时，记录 termination，再对保留的完整 WAL 做 `quick_check` 和 checkpoint，
验证成功后才计为旧库造数完成；现代二进制使用原生 shutdown。候选启动失败签名与源码构建失败
始终是两个不同结果。

Windows 上的 tag 构建在 `realpathSync.native` 展开后的长路径下进行（windows-latest 的临时目录是 8.3 短名，
在那里 frozen install 会被拒）；仍被拒时摘要附上重新生成的 lockfile 与 tag 的增删行。这些 tag 的构建脚本编译后
按不带 `.exe` 的文件名取大小，在 Windows 上必然报 ENOENT：只有这一种失败且 `.exe` 已生成时才接受产物，并由
验证器补跑脚本跳过的 `version` 冒烟。

手动勾选 `negative_control` 使用未公开草稿 `upgrade-fixture-binaries` 留存的 v0.19.3
候选（`retained-asset`），以 v0.19.2 造数。只有造数成功、候选实际启动且非零退出，并分别命中
以下签名才算反证成功；下载失败、超时、被杀或错误发生在旧版阶段都失败：

| 变体                              | 必须出现的候选失败签名                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| SQLite 常规（保留干净 sidecar）   | `This is an epoch-1 installation`                                                        |
| SQLite 无 sidecar                 | macOS：`unable to open database file`；Linux／Windows：`This is an epoch-1 installation` |
| PG 一键迁移未 finalize + 再写一轮 | `Finish or roll back RFC-349 operation`                                                  |

macOS 版 Bun 使用系统 SQLite，只读打开缺 sidecar 的 WAL 库直接失败（S4）；Linux／Windows 版
Bun 内置的 SQLite 能打开（并在旁边建出 `-wal/-shm`），v0.19.3 于是走到与常规变体相同的 epoch-1 拒绝。

v0.17.0–v0.17.11、v0.18.0、v0.18.1 的 L2 `unsupported` 排除已由用户于 2026-10-31 批准；
仍留在夜间映射中输出带原因的 skip，L1 覆盖要求不变。运行记录应区分 `passed`、
`expected-failure`、`skipped`、`failed`。

---

## 2. 升级（部署方，默认自动）

保留旧 binary、配置、key、完整 home 与一致性数据库备份，停止旧 daemon，然后换为含 RFC-398
的候选，保持原 `AGENT_WORKFLOW_HOME` 与连接环境变量执行：

```bash
agent-workflow start
# 服务启动后检查实际数据库、数据与人工门，再登记保留期。
agent-workflow doctor
agent-workflow db migration status <op> --json
agent-workflow db migration complete <op> --json
```

`start` 自动运行备份、转换和校验，通过后才启动 HTTP 服务；无须先运行迁移命令。
`migrate` 也调用同一自动编排。大库请安排维护窗口，转换期间没有 HTTP 监听，日志持续报告进度。
中断后再 `start` 会续做同一自动会话；若父进程消失而子进程尚在迁移，新启动会等待它完成。

升级期间日志里能看到三种行（标准错误与 daemon 日志里都有）：

- 开始时一行 `[db migration] automatic database upgrade started: …`；
- 进度行 `[db migration] <阶段>: <细节> [<已处理>/<总数> <单位>] (<秒>s elapsed)`：阶段边界立即打印，
  循环内同一阶段至多每 3 秒一行。阶段依次是 `freeze`（冻结并快照源库）、`offline-upgrade`（把快照补到
  旧结构的最后一个版本）、`content-capture`（清点运行文件）、`backup`、`conversion` 与 `load`（逐表转换并写入新库，
  两者交替出现）、`validation`、`activation`。**每个阶段只走一遍**（RFC-626；此前计划与执行各走一遍，前四个阶段会出现两轮）；`freeze` 在 `offline-upgrade` 前后各打印一行，是同一遍的开始与结束；
- 存活行 `[db migration] still working (last reported: …): no new output for …, … since the upgrade started`：
  快照拷贝、完整性检查都是单条语句，执行期间无法从内部报告。`start` 进程在升级子进程连续 15 秒没有输出时打印这一行，
  之后每 30 秒一行，直到有新的进度。看到它说明升级还在进行，不是卡死。

直接运行 `agent-workflow migrate` 或 `db migration auto` 时只有前两种行：它们在同一个进程里执行转换，
单条语句执行期间打印不了东西。

#### 升级不因数据而拒绝；它自己做了哪些处置，都在报告里（RFC-626）

自动升级遇到转换不了的旧数据不再停下来等人处理，而是按固定规则处置、继续完成，并把每一条处置列出来：

| 旧数据的情形 | 升级的处置 | 报告里的行 |
| --- | --- | --- |
| **仍未结束的任务**（中断、等待评审、等待人工、运行中、排队），名下有早期版本留下的、新版本无法接着执行的记录（2026 年 7 月中旬之前创建的任务普遍如此） | 结束这个任务：状态改为已取消，原因写明是升级结束的（界面上显示「升级时结束」）；它正在等评审、等人工的节点与未答的澄清一并收尾，相关告警标为已解决。子任务随父任务一起结束 | `task ended by the upgrade: <任务 id> "<任务名>", was <原状态> (<原因代码>)` |
| 已结束的任务有同样的旧记录 | 不受影响，旧运行按只读历史保留 | — |
| 行里登记的内容文件在磁盘上不存在（家目录没有随库一起搬过来、文件被清理过） | 登记为缺失，行保留；之后打开这份内容时界面提示不存在 | `content recorded as missing: <表>(<键>) <列> -> <路径> (<状态>), task <任务 id>`（不属于任务的内容不带任务） |
| 技能目录不在磁盘上 | 技能行保留并标为隔离；把目录放回原处后重启，启动时的复核会让它恢复可用 | `row kept with a marker: skills(<id>): …` |
| 个别行本身不合法（类型不对、必填为空、指向不存在的行且该引用不可省略） | 把这一行原样封存进新库的归档，不进入业务表 | `row set aside: <表>(<键>): <代码>`（转换时封存）或 `reference <处置>: <表>(<键>) <外键> -> <被引用表>`（收尾时处置悬空引用：清空、改指，或把引用方移进归档） |
| 可以保留但带着疑点的行（例如缓存仓库的地址读不出来、引用了已删除对象的名字） | 行保留并打标记；地址读不出来的缓存仓库在新版本里显示地址不可用、不能刷新 | `row kept with a marker: <表>(<键>): <代码>` |
| 旧版本已退役功能留下的行（人工流程里需要逐项确认的那几类） | 自动确认并按确认后的方式转换 | `acknowledged for the upgrade: <代码> x <条数>` |

升级结束时打印一行汇总，之后逐条列出：被结束的任务全部列出，其余每类最多 50 条（转换时封存的行与收尾时处置的引用各算一类）；
没列全时最后一行会指出全部条目所在的迁移记录表：

```text
Decisions made by the upgrade: 37 unfinished task(s) ended; 5 content reference(s) recorded as missing; 0 row(s) set aside by the conversion; 0 dangling reference(s) resolved while finalizing (cleared, re-pointed, or with the referring row moved to the archive); 0 retired item(s) acknowledged; 0 row(s) kept with a marker.
```

完成回执的 `resolutions` 里有同样的清单（每类最多 1000 条）；`agent-workflow db migration status <op> --json` 的 `resolutions` 给出各类合计与按代码的计数。

**不想让升级替你结束任务**：升级前在旧版本的界面里把仍未结束的任务完成或取消，再停服务、换二进制。哪些任务会被结束，
可以在旧版本的库上先查（只读，旧服务运行中也可以查）：

```sh
sqlite3 "file:$HOME/.agent-workflow/db.sqlite?mode=ro" "
  SELECT t.id, t.status, t.name FROM tasks t
  WHERE t.status NOT IN ('done', 'failed', 'canceled')
    AND EXISTS (SELECT 1 FROM node_runs r WHERE r.task_id = t.id AND r.envelope_nonce IS NULL);"
```

在一份真实的 v0.19.2 库上，这条查询列出的 37 个任务正是升级结束的那 37 个；其余未结束的任务升级后状态不变。

#### 只有环境问题会让升级拒绝开始，而且在动任何东西之前

下面几类与数据量无关的问题，在登记这次升级**之前**检查，几秒内给出结果（`start` 非零退出，`db migration auto` 退出码 3）。
此时旧库没有被改动，家目录里没有新增的会话记录、操作目录或分配文件，PostgreSQL 服务器上也没有新建的库；照提示修正后再 `start` 即可：

- **磁盘空间不足**：按库里的**有效数据量**估算（不是文件大小），提示所需与可用的字节数、还差多少、在哪个目录。
  磁盘已经完全写满、连旧库都打不开时，同样按空间不足报告并给出可用字节数；
- **SQLite 旧库的结构不是任何已发布版本写出的样子**（多出或缺少表、列等对象）：列出具体对象；用旧版本恢复或移除它们；
- **`config.json` 读不出来**（不是合法的 UTF-8 / JSON、顶层不是对象、路径项不是文本）：指出文件路径与解析器的原话；
- **PostgreSQL 角色不能建库，也没有提供空库**：见 §2a。

这些检查只在一次升级即将开始时做；已经升级完的安装、续做中的会话不再重复检查（配置文件仍须能加载）。

**PostgreSQL 旧库的结构是例外**：比较结构需要一个 scratch 库，而前置检查不建库，所以 PostgreSQL 上多出或缺少对象的情形
要到冻结旧库时才报告——此时会话已经登记、目标库与 scratch 库已经建好，退出码 1，文案同样列出具体对象。
用旧版本恢复结构后再 `start`，会话带着已有的库继续，不需要清理。

转换完成后的自检若不通过，升级会撤回到旧库并停下，不会自动再试；修正后执行重试命令，见 §3a。

#### 耗时与资源参考（2026-11-27 实测，v0.19.2 → 当前 main）

| 源库 | 有效数据 | 行数 | 运行文件 | 全程 | 最大常驻内存 | 新增磁盘占用：峰值 / 完成后留存 |
| --- | --- | --- | --- | --- | --- | --- |
| v0.19.2 新装的空库（SQLite） | 4.6 MB | — | 0 | 8 秒 | — | — / 60 MB |
| 一份用了五个月的真实实例（SQLite） | 1.07 GB（文件 23 GB，其余是空闲页） | 60.9 万 | 82.8 万 | **4 分 40 秒** | **3.8 GB** | 7.4 GB / 4.3 GB |
| 同一份数据，37 个未结束的旧任务原样保留（SQLite） | 同上 | 同上 | 同上 | 5 分 23 秒 | 3.6 GB | 与上一行相同 |
| 同一份数据（PostgreSQL，带全部运行文件） | 同上 | 同上 | 同上 | **11 分钟** | 3.6 GB | 5.4 GB / 约 2.7 GB |

测试机是 10 核 macOS，测量时机器上另有负载（1 分钟平均负载 11～20）。改进之前（RFC-626 之前）同一份数据：SQLite 70 分 50 秒、
峰值内存 10.7 GB、磁盘峰值约 16 GB；PostgreSQL 76 分钟、7.4 GB。

第二行的 4 分 40 秒按阶段拆开：冻结旧库并把快照补到旧结构的最后一个版本 45 秒、清点运行文件 35 秒、备份 4 秒（冻结的快照本身就是备份）、
转换与写入新库 3 分钟、收尾与校验 10 秒、激活几秒。PostgreSQL 多出的时间主要在把旧库拷进 scratch 库并补齐结构（约 3 分钟）
与写入新库的 PostgreSQL 库。每个阶段只做一次。

据此估算维护窗口：耗时大致随有效数据量和 `runs/` 下的文件数线性增长，每 1 GB 有效数据加 80 万个运行文件，SQLite 约 5 分钟、
PostgreSQL 约 11 分钟；内存按 4 GB 预留；磁盘以升级开始前的检查为准——它按有效数据量估算（参考实例给出 8.9 GB，实际峰值 7.4 GB），
不够时在动任何东西之前就拒绝。有效数据量用
`sqlite3 db.sqlite "select (page_count - freelist_count) * page_size from pragma_page_count, pragma_freelist_count, pragma_page_size"`
查，不要看文件大小。升级结束后回执 `receipt.json` 的 `phaseTimings` 记有这一次各阶段的实际耗时。

自动模式接受并记录 `restrictions`，每项以 WARN 输出；受限制的历史仍可查看，但相关重试／恢复
可能不可用。人工流程里的 `blocks` 与可确认项在自动模式下按上表处置，不再需要人工处理；人工模式
（§2b）不变，仍逐项阻塞并等待确认。
完成回执位于 `database-migrations/auto-upgrade/sessions/<operationId>/receipt.json`，记录源
fingerprint、目标、RFC-349 收尾、保留库、限制、升级做出的处置（`resolutions`）、阶段耗时、备份位置
与回退方法。`status` 显示 `mode: auto`；自动会话的 `completed` 表示已校验，操作的
`db migration complete` 仍是验收后的独立保留登记步骤。daemon 启动即可产生首次业务写入，自动模式
通常没有可供人操作的首写前窗口。

### 2a. PostgreSQL 派生数据库、权限与历史桥接

同 provider 自动升级默认保留原连接环境变量，在同一 PG 服务器创建 `<源库名>_epoch2` 和
`<源库名>_epoch2_scratch`。后续 run／retry 使用带分配序号的新名字，不复用退役目标；长名字
会截断并带摘要。建库复制源库的 UTF8、locale provider 及相应 locale 属性（PG 15–18），
不能用服务器默认 locale 替代。实际名称以回执为准。

`database-generation.json` 里的 `env:<源变量>/<编码库名>` 指向新库；配置文件及原环境变量
不用改。`databaseName` 由 pointer 推导，不是手工配置项。`doctor`、`status`、启动日志和
`/health` 的 `database.databaseName` 显示实际库名；health 不输出 URL／用户名／密码。
外部备份、监控和数据库管理任务若按库名定位，须改为新目标。

AW 角色无建库权限时，`start` 非零退出，打印**两条完整可执行的 `CREATE DATABASE`**，分别用于
目标与 scratch，包含 `OWNER` 和源库 locale。将原样输出交给 DBA，以 superuser 逐条执行
（`CREATE DATABASE` 不能放在事务中）；保持 AW 原受限角色，再次 `start` 即继续。
不要提升 AW 角色来跳过这一步，也不要手工猜测目标库名。已有库须为空，或确属本会话的目标／
scratch；其他非空库会被拒绝。派生库被占时，可腾空／改名后再次 `start`，也可设置
`AGENT_WORKFLOW_EPOCH_TARGET_URL`／`AGENT_WORKFLOW_EPOCH_SCRATCH_URL` 指向新的空库后再次 `start`：
只要被拒的分配尚未完成准备，显式变量即接管（被拒库名仍留在分配账本中、不再复用）；已完成准备的
位置不会被换走。显式变量切换后必须持续提供，新 run／retry 必须换为新的空库。
`db migration status <op> --json` 的 `retainedDatabases` 列出本会话保留库的库名、大小、用途与 run。

源库、scratch、退役目标均保留。scratch 用于 `db migration trace … --replay`，不能在自动
升级后立即删掉；验收和保留期结束后，运维可按回执精确库名手工 `DROP DATABASE`，删除后相关
PG 源的追溯重放不再可用。

旧版一键迁移停在 `accepting-writes` 时会自动 finalize，包括已经在 PG 上写入但 manifest
尚未刷新的情况。其他未结束阶段拒绝，并要求用旧 binary 的 `db migration status|resume|cancel`
处理。自动 finalize 关闭原 RFC-349 回 SQLite 的窗口。

v0.18.18／v0.18.19 的 PostgreSQL 原始基线与后来的冻结基线不同。候选按**各自发布合同**把
PG 活跃数据及保留归档重建为 SQLite@0223 离线副本，逐表比较行数和逻辑摘要，再走冻结补迁移与
epoch 转换，最终仍写入 PG。原 PG 数据不原地修改；若不满足该 SQLite 合同的约束或摘要不等则
阻塞并报告，不删除或修饰源行。保留 RFC-349 归档以供桥接验真。

### 2b. 人工模式：计划、批准与离线切换

需要先审阅每个计划或演练首写前回退时，在 `config.json` 设置 `"autoEpochMigration": false`。
在此模式下 `start` 遇到 epoch-1 安装拒绝并给出指引，下面的人工入口和批准语义保持有效。

先保留当前 binary 的版本、完整构建 SHA / 摘要、原配置与 key，以及可用的切换前备份。
每个实例用 [RFC-395 演练模板](../design/RFC-395-database-target-schema-rebuild/rehearsal-template.md)
记录批准和结果。下面 `<op>`、`<approvalDigest>` 都从本次 CLI 输出复制。

```bash
agent-workflow version
agent-workflow status
# 以下使用 epoch-2 binary；plan 读取源并写操作证据，不切换业务库。
agent-workflow db migration plan --rehearse --json
agent-workflow db migration status <op> --json
agent-workflow db migration receipt <op> plan --json
```

`plan` 返回 `operationId`、`plan.payload`、`plan.digest`、`plan.approvalDigest`、
`jsonPath`、`markdownPath`、`acknowledgeable`、`requiresApproval` 和 `guidance`。
逐项审阅 source fingerprint/watermark、目标合同与 build、备份/内容清单、容量估计、
`blocks`、`restrictions`、`bootUpgradeEffects` 与未完任务。当前 `--rehearse` 记录的是转换 dry-run
耗时，并填入维护时间估计；它不创建并校验一个原生目标库，也不是切换批准。T19 的完整演练须
在独立实例副本实际执行 run / verify / rollback。计划有 block 时按指引处理后重做计划，不能靠
`--approve` 绕过。

需要操作者明确接受的未完旧代码工作，按计划的 item id 确认归档，保留理由和操作者：

```bash
agent-workflow db migration acknowledge <op> --item <item-id> --reason '<reason>' --by '<operator>' --json
# 每个确认项各写一个 --item（可重复）。按用户裁决须逐项确认，不提供全选。
# 命令中断后用相同的 --item / --reason / --by 重跑即可继续；撤销确认同样按原参数重跑。
agent-workflow db migration plan <op> --json
# 需要撤销确认时：
agent-workflow db migration withdraw-acknowledgement <op> --decision <decision-digest> --json
```

`acknowledge` 只解决对应的可确认项，不批准执行。`run --approve` 需要的是**材料批准摘要**
`plan.approvalDigest`，不是完整文档 `plan.digest`。限制、确认或实际转换效果发生实质变化会
要求重新批准；单纯计数或时间变化不应被当成新的材料批准。

在已批准的维护窗口执行：

```bash
agent-workflow db migration run <op> --approve <approvalDigest> --json
agent-workflow db migration status <op> --json
agent-workflow db migration receipt <op> run --json
agent-workflow db migration receipt <op> activation --json
# 只读校验不启动 daemon；先完成首写前的回退演练。
agent-workflow db migration verify <op> --json
```

`run` 负责备份、停止新准入并收敛 writer、冻结、转换、验证、准备并替换 pointer；它不启动
新 daemon。不能另起旧 writer。若在冻结后等待重新批准，继续保持停机。重启同一命令复用原
operation/run/target；源已变化时按 `status.guidance` 处理，`run <op> --new-run` 会保留旧
证据并分配新 run，须审阅新的批准材料。PostgreSQL 新 run 需要独立空目标。

SQLite → PostgreSQL 或 PostgreSQL → PostgreSQL 的计划显式指定目标环境变量名：

```bash
agent-workflow db migration plan --target postgresql --target-url-env AW_EPOCH2_TARGET_URL --json
# 旧 PostgreSQL 源若需离线升级，再提供 --scratch-url-env AW_EPOCH1_SCRATCH_URL。
```

环境变量应已指向专用空目标 / scratch，不能指回源。PostgreSQL → SQLite 不支持。

回退演练和只读验证通过、决定继续上线后，再换用本候选 binary 启动。**启动本身可能触发首写**，
不必等用户创建任务才关闭窗口。按实例验收历史、人工门、执行恢复与队列，然后收尾：

```bash
agent-workflow start
agent-workflow db migration status <op> --json
agent-workflow db migration verify <op> --json
agent-workflow db migration complete <op> --json
agent-workflow db migration receipt <op> switch --json
```

`activated` 只说明已到激活阶段；`verified` 才有校验回执，`completed` 才完成保留登记。
`receipt` 返回 `{path, json}`，其中 `json` 是回执原文；保存外层输出和内层原文。`receipt switch`
在完成前返回 verification receipt，完成后返回 completion receipt。

**同 epoch 后续升级**：`agent-workflow migration-report` 读取当前 pointer 所选库；`agent-workflow migrate` / daemon prepare
在锁内应用原生 history，SQLite 按 `backupOnMigration` 先尝试 pre-migration 备份。它不重放
`db/migrations` 的 epoch-1 链。先停止 daemon，保留备份，再换 binary、检查并启动。

---

## 3. 回滚

### 3a. 自动校验失败与 retry

首次负向验收结果落盘后即形成撤回承诺。daemon 尚未启动，自动流程执行首写前 rollback，保留
失败详情并拒绝启动；即使在记录和撤回之间断电，下次启动也先完成同一撤回，不因第二次探测碰巧
成功而继续。撤回完成后旧源仍可由旧 binary 使用；之后的普通 `start` 不会无限重试转换。

修复输出中明确指出的原因，检查备份与源仍可用，再显式重新开始：

```bash
agent-workflow db migration auto --retry --json
agent-workflow start
```

retry 新建自动会话并分配新 PG 库名，之前的证据和库保留。普通中断或源变化按状态续做，不能
把所有操作错误都当成负向验收。退出码：自动 CLI 0 为完成／无需工作，3 为拒绝／校验失败，
1 为操作错误；外层 `start` 对失败以非零码退出。参见[自动升级入口说明](./auto-epoch-migration.md)。

### 3b. 首次业务写入前撤回 epoch 切换

先检查 `status` 的 `firstLiveWriteAt` 与 `rollback.allowed/reason`，保持新 daemon 未启动：

```bash
agent-workflow db migration status <op> --json
agent-workflow db migration rollback <op> --json
agent-workflow db migration receipt <op> rollback --json
# 确认 rolled-back 后，使用记录的源 build/config 启动源实例。
```

rollback 会关闭目标写入权，再按 activation receipt 恢复原 pointer **字节**；源原来没有 pointer
则恢复为没有。它保留目标和转换元数据。中断后继续同一 rollback；不能手工复制 pointer
绕过 generation 围栏。旧备份转换的 rollback 还恢复被替换的 skills / 可选 config。

### 3c. 首写后前滚，或从目标备份恢复

`firstLiveWriteAt` 非空、`completion-started.json` 已存在或操作已 `completed` 时，直接撤回被拒绝
（`reverse-migration-required`）。保留现状与错误证据，修复后前滚；需要恢复时使用 epoch-2
一致性备份和匹配的 binary，步骤见 [灾难恢复](./disaster-recovery.md)。

切回 epoch-1 只能在停写后使用切换前备份和对应旧 build，并明确接受备份之后事实的处置；本
发布没有反向转换器。不能把旧备份恢复称为无损 rollback。普通 epoch-2 restore 仍拒绝比 binary
更新的合同；`--no-migrate` 不会允许 epoch-1 数据绕过 converter。

实际返回旧版本时：停止候选及其 writer；另外保留升级后 home、目标库与回执；按切换前备份
恢复**完整旧 home、旧 pointer（原来没有则不加入 v2 pointer）、内容文件与原 key/config**，
PostgreSQL 同时恢复／选回切换前源库及相应连接变量；使用记录的旧 binary 启动并检查业务数据。
使用旧版本自己的恢复机制，不能将 epoch-2 的 generation 目录当作旧库，也不能只把旧 binary
覆盖回去。恢复切换前备份会丢失切换后的业务写入，须明确接受这个数据水位。
PostgreSQL 返回旧版本时**选回保留下来的原源库**，不要从自动升级自己导出的那份备份恢复：它按搬运
口径导出，旧库里不合法的 JSON 文本、非有限实数原样带出，旧版本自己的恢复机制按严格口径读不进
这类值（RFC-626）。

未激活的失败目标可以在确认放弃后执行：

```bash
agent-workflow db migration discard <op> --confirm --json
```

discard 结束该操作并处理其目标残留，源不变；它不是清理源库、备份或迁移证据的命令。

### 3d. RFC-295 降级预检已退役（U-6）

`rfc295-downgrade-audit` 已随 epoch-2 激活删除，不再使用 `downgrade-audit rfc-295`。
返回 epoch 1 使用本节的首写前 switch rollback，或切换前备份与旧 build。不要把旧命令的
OK / BLOCKED 当成 epoch-2 的回退许可。

---

## 4. 备份

- **切换保留**：源库、最终一致性备份、内容 manifest、journal、确认、批准与 receipt 都保留；
  `completed` 不自动删除它们。SQLite 源在收尾时移入 `database-migrations/<op>/source/`，
  WAL / SHM 如存在也逐项保留；PostgreSQL 源保留原 profile。
- **日常备份**：`agent-workflow backup`，落 `<home>/backups/`；epoch-2 逻辑备份包含
  `epoch2-metadata.json`，携带 history restrictions、archive bytes 和 generation lineage。
- **日常轮转**：只对 `scheduled-*` / `auto-*` 按配置轮转；手动与 pre-restore / pre-migration
  备份不自动删除。它与 switch 的“保留全部操作证据”是两个范围，详见灾难恢复 §1.2。
- **内容与 key**：仍被 live / history / backup 持有的内容不能提前释放；普通备份不包含
  `secret.key`，必须另行保留原 key。旧备份 converter 的 key 选择见灾难恢复 §4。

记录版本、完整 build SHA、合同摘要、generation、备份水位和保留位置；“备份完成”之后还要
实际恢复并核对非空数据，不能只核对 tar 文件存在。

---

## 5. 不在本文范围

- **运维 dashboards / alerts**：本仓**没有**任何监控栈接线（零 Prometheus / Grafana / alert
  规则）。这类产物的形态完全取决于部署方自己的监控系统，凭空写一份等于交付一份没人会用的
  文档——RFC-310 T111② 据此登记为**不做**，需要时按实际监控栈另立 RFC。
- **集群 / 滚动发布 / 蓝绿**：单机形态是单进程自托管 daemon，不存在这些形态；CrewStation 托管形态（RFC-370）的发布、切流、回退与恢复见 [crewstation-deployment.md](./crewstation-deployment.md)。
