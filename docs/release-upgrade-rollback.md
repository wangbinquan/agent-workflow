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
2. **单机从 epoch 1 升级默认自动执行计划、备份、转换与校验，再启动 daemon**。
   `config.json` 设置 `"autoEpochMigration": false` 时保留人工流程。存在 blocks、需逐项确认的
   旧代码工作、非自动进行中的操作、pointer/receipt 不一致或退役 generation 时仍拒绝启动并
   给出指引。同 epoch 的后续结构升级由原生 schema history 执行。
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

自动模式接受并记录 `restrictions`，每项以 WARN 输出；受限制的历史仍可查看，但相关重试／恢复
可能不可用。`blocks` 和可确认项必须按指引人工处理，不会被自动确认。
完成回执位于 `database-migrations/auto-upgrade/sessions/<operationId>/receipt.json`，记录源
fingerprint、目标、RFC-349 收尾、保留库、限制、阶段耗时、备份位置与回退方法。`status` 显示
`mode: auto`；自动会话的 `completed` 表示已校验，操作的 `db migration complete` 仍是验收后的
独立保留登记步骤。daemon 启动即可产生首次业务写入，自动模式通常没有可供人操作的首写前窗口。

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
