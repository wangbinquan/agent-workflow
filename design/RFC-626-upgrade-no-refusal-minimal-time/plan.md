# RFC-626 实施计划

> 状态：Draft。需求见 [proposal.md](./proposal.md)，设计见 [design.md](./design.md)。
> 按仓库硬规则：批准后先完成全部实现与全部测试用例，再集中验证；不边写边测。

## 任务

| # | 内容 | 依赖 | 主要位置 |
| --- | --- | --- | --- |
| RFC-626-T0 | 复核：design §3.2～§3.4 中标「调研」的结论逐项对源码复核一遍，与文档不符的先改文档再实现；v0.19.0～v0.19.2 到 epoch-1 末版之间补的迁移（两种库）对已有行的取值要求再核一遍 | — | `design.md` |
| RFC-626-T1 | 环境前置检查：挪到登记意图之前的只读检查（`config.json`、结构识别不数行、有效数据量估算空间、PostgreSQL 能否建库、旧版搬迁操作未完成）；拒绝时不写会话记录、不建操作目录、不写分配文件、不建库 | — | `system-operations/application/epochSwitch/autoUpgrade.ts`、`domain/epochSwitch/capacity.ts`、`platform/persistence/migration/freeze/capacity.ts` |
| RFC-626-T2 | 源身份与轻量核对：内容身份各算一次，断言改用变更标记，标记不一致时回退重算；去掉三处纯重复；持久的冻结记录（发布顺序、重开；SQLite 含冻结副本，PostgreSQL 只记身份与变更标记、重开时新开快照事务）；PostgreSQL 自动模式的 scratch 拷贝不跑业务不变量检查；旧库自带外键悬空行不再让冻结失败 | — | `platform/persistence/migration/sqliteSourceReader.ts`、`postgresqlSourceReader.ts`、`freeze/sourceAccess.ts`、`offlineSourceUpgrade.ts` |
| RFC-626-T3 | 自动模式单遍编排：`direct` 开关、前置计划、计划步在同一轮运行里可重入（冻结记录与内容清单登记沿用）、执行步顺序、实际结果计划与再批准（评估与批准按批准摘要幂等复用）、收尾只做一次；转换做完之前发现候选构建或转换材料与已批准计划不同时以 `-new-run-required` 新建一轮运行 | T2 | `system-operations/application/epochSwitch/planner.ts`、`runner.ts`、`autoUpgrade.ts`、`infrastructure/epochSwitch/targetGeneration.ts`、`bootstrap/epochMigration.ts` |
| RFC-626-T4 | 转换引擎记账提速：排序键预计算、行摘要入暂存列、紧凑暂存编码、sink 免重算、规范化 JSON 键序缓存；暂存库摘要改定义并递增转换器版本 | — | `platform/persistence/migration/conversion/receipts.ts`、`engine.ts`、`staging.ts`、`platform/persistence/schema/canonical.ts`、`infrastructure/epochSwitch/conversionSink.ts` |
| RFC-626-T5 | 内容盘点：单次序列化、遍历减少系统调用、目录前缀索引 | T2 | `platform/content/inventory/manifest.ts`、`freezeInventory.ts`、`databaseTrees.ts` |
| RFC-626-T6 | 备份只做一份并直接取冻结副本，摘要在进程内复用；工件库登记与取回改用硬链接 | T3 | `platform/persistence/migration/freeze/backup.ts`、`infrastructure/epochSwitch/backupAdapter.ts`、`fileJournal.ts` |
| RFC-626-T7 | PostgreSQL：拷贝按参数上限分批；搬运口径（拷到 scratch 及回读、备份导出、备份读回不检查 JSON 文本合法性与实数是否有限，备份清单记口径）；装载批大小按库类型、单元元数据合并写、RFC-349 归档目录校验缓存；错误原因取文字的统一函数（不再出现 `[object Object]`） | T2 | `platform/persistence/migration/offlineSourceUpgrade.ts`、`postgresqlSourceReader.ts`、`postgresqlSourceExport.ts`、`legacy/postgresqlLogicalTarget.ts`、`legacy/logicalDatabaseArtifact.ts`、`freeze/backup.ts`、`target/loader.ts`、`infrastructure/epochSwitch/metaStore.ts`、`conversion/postgresqlArchiveSource.ts` |
| RFC-626-T8 | 结束任务：`prepareConversion` / `run` 拆分、`blockExecutable` 与 `settles.tasksOf`（内容规则与阻塞判定共用同一推导）、发现过程与不动点、`settlement` 合同（三个模块的 settler 与 task-execution 的级联扩展）、结束集合进入转换计划与重放 | T4 | `conversion/engine.ts`、`conversion/rule.ts`、`conversion/readSource.ts`、`modules/task-execution/infrastructure/migration/`、`modules/collaboration/infrastructure/migration/`、`modules/system-operations/infrastructure/migration/` |
| RFC-626-T9 | 新结束原因：任务停止原因的单一事实源加一种、前端原因表与中英文案、数字员工视为停止 | — | `modules/task-execution/domain/sourceTermination.ts`、`packages/frontend/src/lib/task-failure.ts`、`i18n`、`modules/task-execution/application/digitalEmployeeExecution.ts` |
| RFC-626-T10 | 封存：收集器的行级封存、目标契约失败；装载拒绝的回报、单元重试与续做时按运行记录里的完整决定原样复现；收尾处置（按目标行登记、与删除同事务、幂等）、收尾步骤返回由记录导出的处置清单、目标行数对账；追溯在有收尾处置时回放后叠加 | T4 | `conversion/receipts.ts`、`engine.ts`、`conversionSink.ts`、`target/finalize.ts`、`infrastructure/epochSwitch/validation.ts` |
| RFC-626-T11 | 逐类保留处置：design §3.4 各行的规则改动（内容；技能的隔离、封存与操作记录了结，`skill_operations` / `skill_operation_locks` 并入技能规则；缓存仓库与按地址关联；定时任务停用；运行时默认值；融合与记忆；代码历史自动确认；代理引用；悬空引用；任务属主；旧任务书；事件族切换） | T0、T10 | 各模块 `infrastructure/migration/` 与 `platform/content/migration/`、`platform/persistence/migration/archives/` |
| RFC-626-T12 | 报告：`ConversionSummary.resolutions`（转换阶段）、实际结果的计划文件合并收尾处置清单、回执、完成日志、`db migration status` 都取自计划文件 | T8、T10、T11 | `conversion/sink.ts`、`domain/epochSwitch/documents.ts`、`planDocument.ts`、`autoUpgrade.ts`、`status.ts` |
| RFC-626-T13 | 内存与磁盘：表回执流式求摘要、来源到目标的去重计数入暂存库、清单只留一份 | T4、T5 | `conversion/engine.ts`、`staging.ts`、`content/inventory/manifest.ts` |
| RFC-626-T14 | 发布版升级矩阵：为每一类处置各加一份种子（遗留未结束任务、内容与技能目录缺失、技能操作停在半途、封存样例、停用的定时任务、地址读不出的缓存仓库）与对应的映射预言条目，升级后真实启动服务；既有预言不变 | T8、T10、T11 | `scripts/release-upgrade/`、`packages/backend/tests/` 下 RFC-398 矩阵 |
| RFC-626-T15 | 文档：升级回滚手册、踩坑记录、RFC-395 / RFC-398 的修订指针 | 全部 | `docs/release-upgrade-rollback.md`、`docs/dev-gotchas.md`、`design/RFC-395-…/migration.md`、`design/RFC-398-…/proposal.md` |
| RFC-626-T16 | 集中验证与实测：全部新旧用例、参考数据 SQLite 与 PostgreSQL、M1 原始数据、新旧实现逐表对比、三处中断续做 | T1～T15 | — |
| RFC-626-T17 | 实现门（只审功能）与 CI | T16 | — |

提交方式：只在 `main` 上，按路径提交；单个 RFC，不拆 PR。T1～T15 全部完成后才进入 T16。

## 冲突面

- `platform/persistence/migration/conversion/**` 与 `modules/system-operations/**/epochSwitch/**` 是 RFC-395 / RFC-398 的主体，
  有源码文本守卫与清单。改动的文件若在账本里，同一提交内更新账本。设计门点名会被触及的：
  - `tests/rfc398-wal-sidecar-open.test.ts` 的只读打开精确清单（T2 改动读取器的打开点）；
  - `tests/architecture/rfc395-v2-coverage.test.ts` 的「每张表唯一规则归属」与通用复制表数量（T11 把两张技能操作表从
    `conversion/generic/tables.ts` 移到技能规则，两处须同步）；
  - `tests/rfc395-v2-core-staging.test.ts` 的 Unicode 顺序断言（T4 改暂存编码与摘要）；
  - `tests/architecture/rfc395-v1-frozen-source.test.ts` 的冻结声明与文件摘要守卫——冻结的历史文件不能改，本 RFC 不碰它们；
  - 「文件恰好声明这些名字」一类的清单（例如 RFC-508 的那一份）：新增顶层声明前先看有没有。
- 57 个测试文件按现有定义重算转换摘要；T4 保持这些定义不变，暂存库摘要除外（相关用例随定义更新）。
- RFC-294 的后续波次仍在搬迁文件；提交前逐个确认路径仍在原处，遇到同一函数被并发改动时先停下问用户。
- `CONVERTER_VERSION` 递增会影响含该值的快照与种子，随 T14 一并更新。

## 后续（不属于本 RFC）

- 数据库层的批量通道（`COPY`、模板建库、跨库直拷）与大表的流式转换（不经暂存库）。记账开销去掉之后再评估收益。
- 人工模式的三段式重复处理。
- 产品既有缺口：已取消的任务不会关掉未解决的卡住告警、工作组房间仍接受对已取消任务的派单操作、
  评审页对已结束任务仍显示决定按钮（提交被 409 拒绝）。升级结束任务时前两项里只处理了告警。
- 观察到但属于 v0.19.2 自身的行为：它的「搬到 PostgreSQL」会因 `user_permission_grants.permission` 的个别取值与
  没有事件的 `committed_event_aggregate_heads` 行而失败（本机真实数据上各遇到一次）。v0.19.2 已发布，无法修改。
- 数字员工「回复检视意见」丢失的缺陷：本 RFC 之后单独修。

## 验收清单

（集中验证后逐项填写证据）

- [ ] 1 不拒绝：M1 原始数据自动升级成功，37 个任务为已取消并带原因，其余任务状态不变，等评审的正常任务能继续
- [ ] 2 内容与技能缺失不拒绝：M3 数据自动升级成功，内容登记为不存在、缺目录的技能为隔离并列入报告；放回目录后恢复
- [ ] 3 封存与其它处置：A4～A10 各一份旧库，结果与 proposal §5 一致
- [ ] 3a 升级后能启动：每一份升级后的库都能启动服务并通过健康检查
- [ ] 4 环境前置：四种情况 10 秒内退出，文案具体，家目录里没有新增的会话记录、操作目录、分配文件，PostgreSQL 上没有新建的库；结构检查不做全表计数
- [ ] 5 耗时：参考数据 SQLite ≤ 6 分钟、PostgreSQL ≤ 15 分钟；各步骤各出现一次
- [ ] 6 资源：峰值内存 ≤ 4 GB；新增磁盘占用峰值 ≤ 8 GB、留存 ≤ 5 GB；前置检查给出的所需空间 ≤ 10 GB
- [ ] 7 PostgreSQL `tasks` 1000 行、2000 行升级成功
- [ ] 8 结果一致：映射预言全部通过；参考数据新旧实现逐表对比无差异（proposal §5 A 组除外）
- [ ] 9 中断续做：三处位置
- [ ] 10 人工流程既有用例全部通过
- [ ] 11 发布版升级矩阵 L1 / L2 通过，CI 全绿
- [x] 设计门第一轮处置完成（design §9.1：1 项 P0、8 项 P1、4 项 P2，全部采纳）
- [x] 设计门第二轮处置完成（design §9.2：无 P0，5 项 P1、4 项 P2，全部采纳）
- [x] 设计门第三轮处置完成（design §9.3：无 P0，5 项 P1、3 项 P2，全部采纳）
- [ ] 设计门复核通过
- [ ] 实现门处置完成
