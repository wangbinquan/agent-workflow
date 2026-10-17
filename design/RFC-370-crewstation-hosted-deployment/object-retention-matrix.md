# RFC-370 对象保留与恢复矩阵（v3）

> 2026-10-16 按 [§9.2 V5/V6](./redesign-v2-20261014.md) 重写。旧版按六套 owner 发布日志、工作卷 tar 捕获描述的内容已随 v3 删除。

## 共同底座

- **一套中立发布日志** `hosted_object_publications`（system-operations 拥有，`infrastructure/crewstation/objectPublications.ts`，经 system-operations `public/participants` 提供）。行 ID 为 `sha256(JSON.stringify([owner, key]))`（无歧义元组编码，键内含分隔符也不会撞 ID）；状态 `pending → ready → releasing → released`。每一次发布生命周期有自己的 `attempt` 与 CS pin owner。
- **owner 只登记自己的引用**：批量 `publish(requests, { commit })` 在把发布标为 ready 的同一事务里执行 owner 的 `commit`，owner 在那里写自己的业务指针；pending 行永远没有 owner 引用。
- **维护**（`hostedObjectRecovery` 任务，10 分钟一次，维护 Worker 能力 `objectPublications`，单机 daemon 跳过）：先运行各 owner 的 sweep（释放不再被引用的发布）→ 处理过期 pending（用原 requestKey 无字节重放询问对象是否存在，再释放）→ 解除 releasing 行的 pin（备份释放水位保护的除外）→ released 行保留 7 天后清除。
- **备份释放水位** `backupReleaseHorizon.ts`：owner 释放的对象，只有在它存活期间不存在任何仍保留的备份时才物理解除固定。
- **源字节**：ready 后清除；不在 PostgreSQL 内联保存（大于 4 MiB 的源由 owner 重新打开，不进日志）。
- **对象引用格式**：`aw-object:v2:<owner>:<id>:<size>:<sha256>`；读取核对 ID、字节数与 SHA-256。

## owner 一览

| 对象族                          | owner（scope）                            | 业务指针                                                              | 释放时机（sweep）                                     |
| ------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| 任务端口内容                    | task-execution `task-artifact`（task id） | `hosted_task_artifacts`                                               | 任务删除 / 归档后不再被引用                           |
| 任务原始输入文件                | task-execution `task-artifact`            | `hosted_task_artifacts` + 输入清单                                    | 同上；重跑任务复用原清单                              |
| Agent 材料大文件（技能 / 插件） | task-execution `agent-material`           | CS material 固定引用                                                  | CS material 完成后释放临时发布                        |
| 节点事件归档                    | task-execution `node-event-archive`       | `hosted_node_event_archives`（prepared / ready）                      | 归档段被删除；字节由源行重新编码，不存 `pending_json` |
| 任务归档                        | task-execution                            | `hosted_task_archive_entries`（已有对象只链接不复制）                 | 归档删除                                              |
| 插件 generation                 | resource-catalog                          | `plugin_artifact_generations`                                         | 不再被固定 generation / 运行 / intent 引用            |
| 开发证据                        | development-automation                    | `development_object_artifacts`                                        | owner 证据删除                                        |
| 数字员工程序 / 输入             | digital-employee                          | 原 revision / input / case 引用                                       | owner 引用消失                                        |
| 人工评审文档                    | collaboration（`reviewObjectSweep.ts`）   | 评审 artifact 行                                                      | 评审终结后不再被引用                                  |
| 数据库备份                      | system-operations `database-backup`       | `hosted_database_backups`（单个归档对象 + 侧车 `hosted-backup.json`） | 用户删除 / 保留策略修剪；历史 30 天后清除             |

## 数据库备份与恢复（V5，C10）

- 备份 = 单机 PostgreSQL 逻辑备份格式（`aw-hosted-database-backup-v2`）的一个归档对象；**不含工作树**，托管下 `includeWorktrees` 返回 422 `hosted-backup-worktrees-unsupported`。工作区位于平台持久卷，独立于业务库存活。
- 恢复：`agent-workflow migrate` 在 CS RFC-042 给出的空目标与 `CS_DATABASE_RESTORE_REFERENCE` 下下载并校验单个归档（清单、侧车、安装、主密钥、schema、逻辑树），复用单机 PG 导入，副本状态 `empty → copying → verified → activated → finalized`；激活后各 owner 归一参与者运行（task-execution：挂起存活任务、中断运行中的节点与任务、所有未结算执行改为 `restored` 取消、在途平台恢复请求标为失败；system-operations：冻结执行权、标记其他构建中备份失败、重新采纳来源备份的 pin），finalize 清除 `first_live_write_at`。CS 校验回执 `{version:1, backupReferenceDigest, schemaDigest, complete:true, autoResumeSuspended:true}`。
- 已知限制：恢复到较旧备份后，被放弃时间线发布的对象（之后的备份与产物）不再被任何行引用，当前不回收（只占对象配额）。

## 验收证据

集中验证与实机证据见 [status.md](./status.md)。
