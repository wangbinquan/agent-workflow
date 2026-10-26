# RFC-395 每实例演练与切换记录（T19）

复制本模板到实例的操作证据目录，每次演练 / 正式切换各留一份。所有空格都填写实测值或“未执行：原因”；
不能把示例、源码推断、测试已编写或退出码 0 写成通过。禁止为填表启动未获批准的正式切换。
本模板的字段来自 epoch-switch CLI；平台控制面、进程和浏览器的证据另附，CLI 没有输出的量不编造。

操作说明见 `docs/release-upgrade-rollback.md`、`docs/disaster-recovery.md`、`docs/crewstation-deployment.md`。

## 1. 实例与候选

| 项目                                                | 本次记录                                                    |
| --------------------------------------------------- | ----------------------------------------------------------- |
| 实例 / 环境 / 操作者 / 审阅者                       | 待填                                                        |
| 演练或正式切换；关联演练记录                        | 待填                                                        |
| single / CrewStation；源 / 目标 provider            | 待填                                                        |
| 源 binary 完整 SHA、版本、文件 SHA-256、保留位置    | 待填                                                        |
| 候选 binary 完整 SHA、版本、文件 SHA-256、OS / 架构 | 待填                                                        |
| 源配置 / pointer 原始字节与摘要的证据路径           | 待填；原本无 pointer 也明确记录                             |
| 目标数据库 / scratch profile 名；内容根             | 待填；记录配置引用，不粘贴连接凭据                          |
| 源 key / 备份 key 的保留位置、选用哪一份            | 待填；不粘贴 key 内容                                       |
| maintenance、writer 清单与停写负责人                | 待填；包括 daemon、maintenance Worker、托管服务槽及任务助手 |
| 证据根、日志时间基准和容量                          | 待填                                                        |

epoch-1 恢复演练还记录：SQLite 备份 / 逻辑工件 / 托管备份种类、备份引用、digest、内容根、
`--restore-config` 的选择、原 skills/config 保留位置。旧备份走 `db migration restore-backup`，
不走普通 epoch-2 `restore --no-migrate` 绕过转换。

## 2. 计划、冻结源与批准材料

保存命令、stdout/stderr、退出码、开始/结束时间以及产物摘要。下面的占位符从实际输出复制：

```sh
agent-workflow db migration plan --rehearse --json
# 旧备份改用：
agent-workflow db migration restore-backup <artifact> --content-root <root> --json
# PG 目标追加 --target postgresql --target-url-env <env-name>
# 旧 PG 源需离线升级时追加 --scratch-url-env <env-name>
agent-workflow db migration status <operationId> --json
agent-workflow db migration receipt <operationId> plan --json
```

| 输出位置                                                                             | 本次值 / 原文路径                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `operationId`、`jsonPath`、`markdownPath`                                            | 待填                                     |
| `plan.digest`（完整文档）、`plan.approvalDigest`（批准材料）                         | 待填；不可互换                           |
| `plan.payload.kind`、`candidateBuild`、`converterVersion`                            | 待填                                     |
| `plan.payload.source.location/provider/epoch/generationId`                           | 待填                                     |
| `plan.payload.source.fingerprintDigest/sourceVersion/watermark/preUpgradeWatermark`  | 待填                                     |
| `plan.payload.target.provider/epoch/generationId/location/contractDigest/planDigest` | 待填                                     |
| `sourceBackupId`、`contentManifestDigest`、`backup.destination/kind/receipt`         | 待填；路径相对 `plan.payload`            |
| `bootUpgradeEffects`、`bootUpgradeEnvironmentDigest`、`bootUpgradeFactsDigest`       | 待填；保存完整列表                       |
| `conversionPlan`、`emptyTables`、`unfinishedTasks`、`estimates`                      | 待填；保存完整原文，计数不能代替链接验证 |
| `requiresOfflineUpgrade`、`validation`、`switchMethod`、`recoveryMethod`             | 待填                                     |
| `content`、`scratchProfileRef`、`restoreFiles`                                       | 待填；不存在或 null 按原样记录           |
| `retention.automaticDeletion`、`retention.compactRequiresVerifiedExport`             | 应为 false / true；记录原值              |
| `acknowledgeable`、`requiresApproval`、`guidance`                                    | 待填；这些在 plan view 外层              |

对每个 `plan.payload.blocks`、`restrictions`、`operatorDecisions` 留一行，不仅留总数：

| 类型 / id / code | table / key / task / run（以实际对象为准） | 原因和证据 | 处理 / 保留的限制 | 审阅者 / 时间 |
| ---------------- | ------------------------------------------ | ---------- | ----------------- | ------------- |
| 待填             | 待填                                       | 待填       | 待填              | 待填          |

```sh
agent-workflow db migration acknowledge <operationId> --item <item-id> --reason '<reason>' --by '<operator>' --json
agent-workflow db migration plan <operationId> --json
# 撤销旧确认时：
agent-workflow db migration withdraw-acknowledgement <operationId> --decision <decision-digest> --json
```

当前 `plan --rehearse` 仅记录 dry-run 耗时并填入维护时间估计，不创建/校验原生演练目标。
完整演练使用独立实例副本实际执行 run / verify / rollback，记录其耗时。

`acknowledge` 不是执行批准；不可确认的 block 不能靠 `run --approve` 通过。冻结后出现新的材料差异，
保留新旧计划与批准链，并重新审阅。每次批准记录实际 `plan.approvalDigest`、人、理由、时间；
`status.journal.payload.approvals` 是持久批准链，保持其顺序和 digest，不只抄最后一项。

## 3. 阶段、耗时与中断恢复

```sh
agent-workflow db migration run <operationId> --approve <approvalDigest> --json
agent-workflow db migration status <operationId> --json
agent-workflow db migration receipt <operationId> run --json
agent-workflow db migration receipt <operationId> activation --json
agent-workflow db migration verify <operationId> --json
```

`status` 的实际字段：`operationId/kind/phase/status/sourceProvider/targetProvider/targetGenerationId/runId/updatedAt`、
`failure`、`journal`、`validation`、`firstLiveWriteAt`、`rollback.allowed/reason`、`guidance`，
等待批准时还有 `approval`。保存全部对象；不要只凭 `phase` 或 shell 退出码判成功。

阶段表中“前 / 后”是故障演练结果及重启证据路径；非生产演练才注入故障。CLI 没有通用 `--fault` 参数。
自动注入由 Q-3 / V3 测试承担，实例级进程或平台故障由 T18/T19 执行方在维护环境实施。

| 阶段                | 前中断 / 后中断结果 | `checkpoints[].committedAt` / wall clock | 耗时 / 日志 |
| ------------------- | ------------------- | ---------------------------------------- | ----------- |
| discovered          | 待填                | 待填                                     | 待填        |
| planned             | 待填                | 待填                                     | 待填        |
| backed-up           | 待填                | 待填                                     | 待填        |
| quiescing           | 待填                | 待填                                     | 待填        |
| frozen              | 待填                | 待填                                     | 待填        |
| converting          | 待填                | 待填                                     | 待填        |
| validated           | 待填                | 待填                                     | 待填        |
| activation-prepared | 待填                | 待填                                     | 待填        |
| activated           | 待填                | 待填                                     | 待填        |
| verified            | 待填                | 待填                                     | 待填        |
| completed           | 待填                | 待填                                     | 待填        |

checkpoint 位于 `status.journal.payload.checkpoints`；同阶段可能多项，不能把它误作一张自动耗时表。
记录外部 wall clock 得到停写总时长、转换时长、校验时长与恢复耗时，注明计算方法。

| 特别故障                                | 首次结果、重启与不变量证据                                                  |
| --------------------------------------- | --------------------------------------------------------------------------- |
| unit 行写入但 receipt 尚未提交          | 整个 native 事务回滚；重启无多余 ID / 无单独已提交行                        |
| receipt 提交后响应丢失                  | 同 unit 重放一次结果，行数、链接、run/generation 身份及摘要不变             |
| object 上传后 owner 引用未提交          | publication 仍 pending；重启复用对象；未 ready 不可引用；无重复外部 effect  |
| pointer / 平台配置已切而 admission 未开 | 保持维护；观察到唯一目标；重启不开第二个 writer；保存各 writer generation   |
| 首次目标业务提交后 kill / restart       | 首写标记与业务行共同保留；rollback 必拒；重启不重复派发；前滚或恢复目标备份 |
| restore 每次 skills/config 移动后中断   | 源备份原字节不变；逐步重放 apply / rollback；原配置与技能精确恢复           |

`--new-run` 用于明确放弃旧 run 后的新候选，不能用来掩盖同一 run 的重放错误。记录新的 runId、
targetGenerationId、批准材料与被保留的旧目标；PG 必须给独立空目标。丢弃操作需明确
`db migration discard <operationId> --confirm --json`，保存 rollback 类 receipt，源与证据保留。

## 4. 校验、回执与首写前撤回演练

| 校验                                                        | 实际值 / 证据                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| source 冻结前后 fingerprint/watermark；源不变               | 待填                                                          |
| 目标 catalog admission / validation.checks / probes         | 待填；保存失败 code、table/key，不只统计行数                  |
| row disposition 守恒 / FK / 输入消费链接 / allocator 高水位 | 待填；含非空历史样本                                          |
| `trace` 可解释的源键、限制与 archive                        | 待填；记录 table、canonical tagged key、phase                 |
| history-only 的限制实际挡住恢复 / retry                     | 待填                                                          |
| `receipt plan/run/activation/switch/rollback`               | 各自 stdout、外层 path、内层 json 原文与 digest；未产生写原因 |
| 目标 pointer 与 activation receipt 的 generation/digest     | 待填                                                          |
| `firstLiveWriteAt`、`rollback.allowed/reason`               | 待填                                                          |

`receipt --json` 返回 `{path, json}`；`json` 是字符串，先保留原字节，再解析。`receipt switch`
在 complete 前后可能分别是 verification / completion receipt，两份均保留，不覆盖旧文件。

```sh
agent-workflow db migration status <operationId> --json
agent-workflow db migration rollback <operationId> --json
agent-workflow db migration receipt <operationId> rollback --json
```

撤回演练必须在首次业务写入及 complete 开始前完成，保持新 daemon 未启动。记录：目标关闭写权、
恢复原 pointer 精确字节（或原本不存在）、原 source build/config 可用、旧 writer 恢复、目标退役、
skills/config 原字节、源和备份仍在。演练后的正式切换使用新 operation / 独立目标并重新批准。
若已首写，记录拒绝 `reverse-migration-required`，改做目标备份恢复演练；不人工退回旧 pointer。

## 5. T18/T19 的外部执行步骤

这些是执行任务编号，不是已存在的自动化 Job；每项附实际证据或明确阻塞。Q-3 编写阶段全部未执行。

| 编号        | 执行内容 / 成功条件                                                                                                                                                                                                        | 证据                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| T18-binary  | Linux/macOS/Windows 候选 binary 新装、非空旧库拒绝、v2 pointer 拒绝旧 binary、维护 Worker、真实 driver 导入与重启；CI `build-binary`、`build-binary-macos`、`build-binary-windows` 和各平台 e2e 是基础，另补 epoch fixture | 待填 exact SHA / Job / OS / stdout       |
| T18-parity  | 固定旧 binary 完整 SHA 与 sha256、候选 binary；运行 `rfc395-q1-dto-parity` 的 gated lane，SQLite 与 PG 目标分别核对五组 API，strict parse；允许差异仅 design 登记项                                                        | 待填；环境见下                           |
| T18-browser | 真实浏览器在旧实例填未提交澄清草稿；保持同 origin/profile，切换后恢复草稿、部分提交、追加与封口；检查历史链接、下载 / 导出及任务目录                                                                                       | 待填；IndexedDB mock 不算本项            |
| T18-journey | 非空源覆盖五类主体与两种数字员工实现；执行→人工门→切换→决定/恢复→完成→retry/工作区 rollback→历史/导出；single 的 SQLite / PG 及 hosted PG 分别完成                                                                         | 待填任务/run/gate/receipt ID             |
| T18-hosted  | 平台真实 freeze、control artifact 持久化、全新 scratch Job 重建、migrate plan/run、实际配置切换、独立 verify、所有 writer 同代与 admission 开关；重启继续原远程执行而非重派发                                              | 待填 Job / freeze / platform observation |
| T19-restore | 本实例 epoch-2 一致性备份恢复；另验证 epoch-1 SQLite/逻辑/hosted 备份经 converter；key、归档、限制、lineage、binary内容与非空业务关系均核对                                                                                | 待填                                     |
| T19-cutover | 正式切换、maintenance 总时长、首写前 rollback drill、首次写入后的 restart / forward recovery、complete 与保留清单                                                                                                          | 待填                                     |

T18-parity 还须在旧实例保留延后准备与物化失败的非空任务，分别采集 GET、列表、重试前后与引用计数，
在目标侧逐字段比较。现有 Q-1 默认 fixture 是一个已完成任务及其历史门，不能把它单独作为这些
工作区边界的完整验收；按矩阵 W.P03/W.P04 的布局补录旧、新响应和操作日志。

Q-1 lane 当前入口 `packages/backend/tests/rfc395-q1-dto-parity.test.ts`，需要
`RFC395_Q1_T18=1`、`RFC395_Q1_REPOSITORY`、`RFC395_Q1_OLD_BINARY`、`RFC395_Q1_NEW_BINARY`、
`RFC395_Q1_OLD_ARTIFACT`（包含 commit/sha256）、`RFC395_Q1_TARGET=sqlite|postgresql`，PG 另设
`RFC395_Q1_TARGET_URL_ENV`。`RFC395_Q1_OLD_COMMIT` 在 T18 必须固定完整源 SHA，不能把滚动的
`origin/main` 当作可重复的来源。执行命令由 T18 安排，本模板不宣称该 lane 默认在 CI 执行。

## 6. 上线收尾与保留

```sh
agent-workflow start
agent-workflow db migration status <operationId> --json
agent-workflow db migration verify <operationId> --json
agent-workflow db migration complete <operationId> --json
agent-workflow db migration receipt <operationId> switch --json
```

hosted 用 `agent-workflow migrate` 的 action=complete；记录 `CS_DATABASE_MIGRATION_PLAN` / `RECEIPT`
原行、Job 身份和平台观察。service 启动可能立即产生首写；complete 开始也会关闭撤回窗口。

| 保留对象                                                                                  | digest / generation / watermark | 实际位置 / 保管人 | 校验及恢复证据 |
| ----------------------------------------------------------------------------------------- | ------------------------------- | ----------------- | -------------- |
| 原源库（SQLite main/WAL/SHM 或 PG profile）                                               | 待填                            | 待填              | 待填           |
| 最终一致性备份与 key 引用                                                                 | 待填                            | 待填              | 待填           |
| 内容 manifest、被引用 bytes、备份 pin                                                     | 待填                            | 待填              | 待填           |
| 计划、确认、批准链、journal、所有 run/activation/verification/completion/rollback receipt | 待填                            | 待填              | 待填           |
| archive、history restrictions、generation lineage                                         | 待填                            | 待填              | 待填           |
| 被替换 skills/config、旧 run/失败目标                                                     | 待填                            | 待填              | 待填           |
| 原/新 binary 及 config                                                                    | 待填                            | 待填              | 待填           |

`status.journal.payload.completion.retained` 原文：待填。没有自动删除；任何后续人工清理另行记录，
不得根据 complete 成功推断旧源或备份已可删。日常 scheduled/auto 备份轮转不等于 switch 证据保留策略。

最终结论：未执行 / 通过 / 阻塞（填写一种）。未闭合项、恢复选择、实测维护时长、批准人及证据索引：待填。
