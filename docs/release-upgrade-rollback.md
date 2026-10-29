# 发布 / 升级 / 回滚 runbook

> RFC-310 T111① 收口（2026-08-24）。此前仓内只有 `design/RFC-310-*/design.md` 的一段
> **cutover** runbook（数据迁移步骤），没有面向运维的发布回滚文档。
>
> **本文只写仓内真实存在的机制**，每条命令都能在 `packages/backend/src/cli/` 找到实现。
> 读到与源码不符的地方，以源码为准并回来改这份文档——一份过期的 runbook 比没有更危险。

本篇以**单二进制自托管 daemon** 为主。epoch-2 发布包含数据库 epoch 切换，已有 epoch-1
安装不能只换二进制再启动。CrewStation 的迁移 Job、平台切换与独立校验见
[托管部署运行手册](./crewstation-deployment.md#epoch-2-发布的数据库切换)。

---

## 0. 先记住三件事

1. **数据在 `AGENT_WORKFLOW_HOME`（默认 `~/.agent-workflow`）**。epoch 2 的 SQLite 库由
   `database-generation.json` 的 v2 pointer 选择，通常是 `databases/<generationId>/db.sqlite`；
   不要把根目录遗留的 `db.sqlite` 当作当前业务库。PostgreSQL pointer 记录目标 profile。
2. **从 epoch 1 升级必须先审阅计划、批准，再离线切换**。daemon 遇到 epoch-1、未协调的切换、
   pointer/receipt 不一致或退役 generation 会拒绝启动，避免 writer 在不确定的库上继续。
   同 epoch 的后续结构升级由原生 schema history 执行，不能拿它代替 epoch 转换。
3. **回退窗口截止于目标首次业务写入**；主动 `complete` 开始保留源库时也会关闭窗口。
   之后走前滚修复或目标备份恢复。旧二进制不接受 epoch-2 文件或 v2 pointer；仅换回旧 binary
   不会把目标库变回 epoch 1。切换源、备份、回执与历史证据不会因 `complete` 自动删除。

---

## 1. 发布（维护者）

推一个 `v*` tag 即触发 `.github/workflows/release.yml`：先建 draft release，再按 matrix 为
macOS arm64 / Linux x86_64 / Linux arm64 / Windows x86_64 构建单二进制并上传。

```bash
git tag v1.2.3 && git push origin v1.2.3
```

⚠️ 自定义中文 release note **要等 workflow 完全跑完再** edit 进去，否则
`generate_release_notes` 会覆盖（`CLAUDE.md` §工作准则）。

---

## 2. 升级（部署方）

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

### 3a. 首次业务写入前撤回 epoch 切换

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

### 3b. 首写后前滚，或从目标备份恢复

`firstLiveWriteAt` 非空、`completion-started.json` 已存在或操作已 `completed` 时，直接撤回被拒绝
（`reverse-migration-required`）。保留现状与错误证据，修复后前滚；需要恢复时使用 epoch-2
一致性备份和匹配的 binary，步骤见 [灾难恢复](./disaster-recovery.md)。

切回 epoch-1 只能在停写后使用切换前备份和对应旧 build，并明确接受备份之后事实的处置；本
发布没有反向转换器。不能把旧备份恢复称为无损 rollback。普通 epoch-2 restore 仍拒绝比 binary
更新的合同；`--no-migrate` 不会允许 epoch-1 数据绕过 converter。

未激活的失败目标可以在确认放弃后执行：

```bash
agent-workflow db migration discard <op> --confirm --json
```

discard 结束该操作并处理其目标残留，源不变；它不是清理源库、备份或迁移证据的命令。

### 3c. RFC-295 降级预检已退役（U-6）

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
