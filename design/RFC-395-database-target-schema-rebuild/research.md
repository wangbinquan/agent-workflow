# RFC-395 调研证据与基线

## 1. 调研方法与范围

2026-10-21 完成前序只读审计，本次落档又在 `3fcb14dbf8ab27cf451934942ea6b9cd647077f8` 重新生成源码逻辑合同。合同 digest 与前序审计相同，数据库主体没有变化；启动装配路径已经按 RFC-393 迁入 `bootstrap/`。并发 RFC-394 的生产代码在制品不属于本 RFC，也不作为已完成设计依赖。

检查范围：SQLite / PostgreSQL schema 与迁移，provider 类型 / 查询 / logical copy，模块实际读写者，Task / NodeRun / workspace / 协作 / 资源 / 事件 / 数字员工 / 观测 / 内容与历史边界，以及本机一个 SQLite 实例的只读结构与汇总。没有执行真实迁移、VACUUM、清理或生产写入；没有连接真实 PostgreSQL 做数据验收。浏览器缓存与外部内容只研究责任边界，没有扫描用户草稿或全部文件字节。

## 2. 源码库存（本次复算）

来源：[schemaContract.ts](../../packages/backend/src/platform/persistence/schemaContract.ts) 的 `buildLogicalSchemaContract()`，不是按 `CREATE TABLE` 文本正则猜测。命令在 `packages/backend` 下：

```sh
bun -e 'import {buildLogicalSchemaContract} from "./src/platform/persistence/schemaContract"; const c=buildLogicalSchemaContract(); console.log(JSON.stringify(c,null,2))'
```

| 项目 | 数值 / 边界 |
| --- | --- |
| 逻辑合同版本 / projection | 2 / sqlite |
| source tables | 217（主 schema 214 + observation 3） |
| active / archive-only | 211 / 6（现有合同语义） |
| 列 / 外键 / CHECK / 显式索引 | 2,639 / 141 / 207 / 390 |
| `tasks` | 70 列，47 nullable |
| `node_runs` | 62 列，52 nullable；nullable 不等于全部不合理 |
| `clarify_rounds` | 25 列，13 nullable |
| `development_missions` | 41 列，30 nullable；保留其聚合，明确条件而非机械拆分 |
| SQLite SQL migrations | 260，末项 `0260_rfc374_node_run_seq.sql` |
| PostgreSQL SQL migrations | 37，末项 `0036_rfc374_node_run_seq.sql` |
| digest | `sha256:8e6510d4d0927d538692ecf22cde0b1fa9a97c733a9e044af8d9768418ecb956` |

SQL 文件数只统计目录下 `*.sql`，不把 metadata / JSON 快照文件算成迁移。目标表数量尚未编译，不能用“217 减几个旧表”宣称最终表数。

## 3. 本机物理样本（前序审计快照，非当前部署普查）

源为本机 `~/.agent-workflow/db.sqlite`，配置 provider 为 SQLite；只读审计采集于 2026-10-21。本段没有在写 RFC 时重新读取实时业务数据，不能用它代表所有用户、所有托管实例或持续变化后的当前值。

| 观测 | 解释 |
| --- | --- |
| 文件 24,688,046,080 bytes（24.69 GB） | 包含大量可复用空闲页，不是 24.69 GB 活跃业务 payload |
| page size 4,096；page count 6,027,355；freelist 5,748,255 | 空闲页 23,544,852,480 bytes，约 95.37%；非空闲分配约 1.14 GB，仍不等于精确 payload |
| 226 张物理表；`__drizzle_migrations` 272 行 | 与源码表数 / SQL 文件数不同；不能单凭这个判定迁移错误 |
| 与源码交集 213 表，额外 11 业务表 + 2 内部表，缺 4 表 | 源 fingerprint 必须读取实际结构 |
| tasks 537；node_runs 3,526 | 仅本机样本规模，不代表所有部署 |
| Task：awaitHuman 21、awaitReview 8、interrupted 60 | 89 个非终态样本应进入恢复迁移演练，不能只迁终态任务 |
| Task：done 359、failed 73、canceled 16 | 合计与 537 一致；该快照没有 running，不代表正式切换永远无活动进程 |
| task_repos 501；旧目录名与 mount_path 差异 0 | 该样本支持去重复身份；不能替代所有部署预检 |
| root / primary repo branch 差异 227 | 全部为 internal，repo branch 为空而 Task branch 非空；字段语义不同，不能当可互换值 |
| six archive tables 全空；code_work_items / code_work_rounds 各 1 | 本机历史稀疏不授权删除其他部署的非空历史 |
| development_missions 0；digital_employees 2；employee_definitions 17 | 新旧配置都有数据，不能按名字合并或默认旧模型已经没人用 |
| `foreign_key_check` 无违规 | 只证明已声明 FK 在该次检查下无违规；不是完整业务一致性或 `integrity_check` 证据 |

缺少的 4 表：`hosted_object_publications`、`hosted_task_archive_entries`、`hosted_workspace_commands`、`node_run_seq_allocations`。样本 `node_runs` 61 列，没有 seq。

额外 11 张业务表当时都为空：`cs_event_source_transitions`、`cs_event_source_transports`、`development_object_uploads`、`hosted_archive_object_links`、`hosted_archive_objects`、`hosted_database_backup_objects`、`hosted_database_backup_workspaces`、`hosted_restored_execution_holds`、`hosted_schema_write_window`、`hosted_workspace_retentions`、`plugin_generation_installations`。它们必须有显式处置，不能在 logical export 中悄悄遗漏。

## 4. 主要源码证据与裁决

行号是本次基线的定位提示；后续实施以符号与实际读写者为准。

| 问题 | 证据 | 设计裁决 |
| --- | --- | --- |
| 非 Workflow 任务需要假宿主 | `packages/backend/src/db/schema.ts` `tasks`（约 1099）；workgroup/launch.ts（`packages/backend/src/modules/resource-catalog/infrastructure/legacy/workgroup/launch.ts`） `ensureWorkgroupHostWorkflow`（151）；[taskRouteLaunchOperations.ts](../../packages/backend/src/modules/task-execution/infrastructure/taskRouteLaunchOperations.ts) Agent / Workgroup launch | 是 NOT NULL 和旧执行表示的问题；`workflow_id` 当前不是实际 FK，不误诊成外键限制 |
| 主仓镜像与目录双身份 | schema `task_repos`（约 2024）；`worktree_dir_name` 注释；`tasks` 主仓字段 | 单一挂载权威，API 投影保兼容 |
| 回滚双形态 | [nodeRollback.ts](../../packages/backend/src/services/nodeRollback.ts) `planNodeRunRollbackTargets` | 统一 per-repo checkpoint，保留无快照的真实语义 |
| 排序回退与角色多义 | [nodeRunOrder.ts](../../packages/shared/src/nodeRunOrder.ts)；[buildNodeRunMintRecord.ts](../../packages/backend/src/modules/task-execution/application/buildNodeRunMintRecord.ts)；[nodeRunMintParticipant.ts](../../packages/backend/src/modules/task-execution/infrastructure/nodeRunMintParticipant.ts) | 保留 seq allocator；补齐 role / generation / selected / provenance 后退出运行时回退 |
| supersession 两处表达 | [domain/nodeRunSupersession.ts](../../packages/backend/src/modules/task-execution/domain/nodeRunSupersession.ts)、infrastructure/nodeRunSupersession.ts（`packages/backend/src/modules/task-execution/infrastructure/nodeRunSupersession.ts`） | 先保留现有 shard 包含关系语义，再统一选择合同；不能用简单 MAX 替代 |
| 澄清整包修改 | [clarifyRounds.ts](../../packages/backend/src/modules/collaboration/infrastructure/clarifyRounds.ts) 答案 / attribution / draft 更新；[seal.ts](../../packages/backend/src/modules/collaboration/infrastructure/clarify/seal.ts) | 只对独立编辑状态关系化；问题 snapshot 与 round 不拆成大材料系统 |
| 资源扫描与注释漂移 | [resourceRefs.ts](../../packages/backend/src/modules/resource-catalog/infrastructure/legacy/resourceRefs.ts) 约 435 的 LIKE + parse；[ref/codecs.ts](../../packages/shared/src/ref/codecs.ts) 与 Agent schema | 当前 Agent 引用落库是 ID；保留便携导入名称和 Workflow call 的有意名称选择语义 |
| 从 SQLite 投影全部 provider | `packages/backend/src/db/providerSchema.ts`（I-b 已删除）、`packages/backend/src/db/query.ts`（II-b O 已删除，见文末路径更正）、[postgresqlDatabaseClient.ts](../../packages/backend/src/platform/persistence/postgresqlDatabaseClient.ts)、[postgresqlSql.ts](../../packages/backend/src/platform/persistence/postgresqlSql.ts) | 显式合同 + 原生 provider，不让业务类型伪装成 SQLite |
| owner / JSON heuristic | schemaContract 的 `ownerFor`（400）、`codecFor`（503）、`postgresqlType`（约 532） | owner 显式声明；现有 JSON 文本命名推断不完整，不能据其统计宣称全部 JSON 已识别 |
| 内容形态 | [nodeRunPrompt.ts](../../packages/backend/src/modules/task-execution/application/nodeRunPrompt.ts) 小 prompt inline 阈值；[databaseSkillTrees.ts](../../packages/backend/src/modules/resource-catalog/infrastructure/databaseSkillTrees.ts) UTF-8 / base64；schema `hosted_object_publications`（4353） | inline 是合理策略；统一内容引用，演进已有发布账本，去除正常 DB 的文本编码补丁 |
| Apply codec 兼容 | [intentApplyArtifactLifecycle.ts](../../packages/backend/src/modules/intent/infrastructure/intentApplyArtifactLifecycle.ts)；schema 两个 apply 表（约 5698 / 5780） | 机制归一、场景幂等与事务边界保留 |
| writer drain | [writerCutoverPersistence.ts](../../packages/backend/src/modules/digital-employee/infrastructure/writerCutoverPersistence.ts) | 新目标无长期 legacy-draining；有效家族事件路由必须保留 |
| 现 logical copy 不会拆合表 | [postgresqlLogicalTarget.ts](../../packages/backend/src/platform/persistence/postgresqlLogicalTarget.ts) 约 579 同列插入；[postgresqlMigrationSequence.ts](../../packages/backend/src/platform/persistence/postgresqlMigrationSequence.ts) V8 约 832 | 新增显式 transform + row disposition；V8 的 append 限制是当前工具能力，不是 PostgreSQL 引擎限制 |

owner 校正的直接读写证据还包括：`code-capability/infrastructure/capabilityTemplatePersistence.ts`、`capabilityParamRead.ts`；`development-automation/infrastructure/developmentConfigPersistence.ts` / `assignmentStore.ts`；`resource-catalog/infrastructure/workgroupPersistence.ts`；`runtime-management/infrastructure/runtimeRegistryPersistence.ts`；`knowledge-evolution/infrastructure/fusionRepository.ts`；`memory/infrastructure/*`；`integration/infrastructure/scheduledTaskPersistence.ts`。不能将现有 contract 的默认 `resource-catalog` 或前缀分类当成最终架构事实。

## 5. 外部原始资料

- SQLite 文档列出普通 ALTER 的适用范围和其他复杂结构变更的重建步骤。本 RFC 的拆表 / 类型与约束整理选择独立目标库，是结合仓内全局变更范围作出的设计推断，不是 SQLite 强制所有迁移只能离线。[SQLite ALTER TABLE](https://sqlite.org/lang_altertable.html)
- 删除数据留下空闲页，文件不会必然立即缩小；`VACUUM INTO` 能产生保留逻辑数据的紧凑副本。空闲页比例不能证明当前业务内容膨胀，也不能把 VACUUM 当 schema 重构。本次没有执行它。[SQLite VACUUM](https://sqlite.org/lang_vacuum.html)
- PostgreSQL `jsonb` 支持结构化处理与索引，但不保留空白、对象键顺序及重复键。带原文摘要 / 字节合同的内容必须另存原值，不能统一转 jsonb。[PostgreSQL 18 JSON Types](https://www.postgresql.org/docs/18/datatype-json.html)

## 6. 结论的限制

本 RFC 是源代码与一个本机快照支持的阶段目标设计，不是生产部署普查。正式迁移前仍须对每个真实实例重新 fingerprint、预检、演练和审批操作计划；特别是非空 PostgreSQL、活动进程、外部内容完整性、托管切换与备份恢复，没有由本次文档得到通过证据。

> 更正（2026-10-23，RFC-395 II-a）：上文 `legacy/workgroup/launch.ts` 已删除（宿主快照与工作组运行配置的生产实现在 `packages/backend/src/modules/task-execution/infrastructure/workgroupRuntimeConfig.ts`）；`infrastructure/nodeRunSupersession.ts` 已删除（SQL 形态在 `packages/backend/src/modules/task-execution/infrastructure/runSelection/oracle/supersessionSql.ts`）。两处原链接改为纯文本路径，以免链接检查指向不存在的文件。

### 2026-10-23 路径更正（RFC-395 II-b O）

`packages/backend/src/db/query.ts` 已删除；Drizzle helpers 直接从 `drizzle-orm` 导入，中立句柄类型位于 `packages/backend/src/platform/persistence/persistenceDb.ts`，任务可见性判据位于 `packages/backend/src/modules/task-execution/infrastructure/taskAuthorization.ts`。上文旧地址及行号保留为当时记录，不再作为现行源码入口。
