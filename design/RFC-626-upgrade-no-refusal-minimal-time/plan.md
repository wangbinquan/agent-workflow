# RFC-626 实施计划

> 状态：In Progress——实现、集中验证、实现门与验收实测均已完成，待 CI（用户 2026-11-27 批准并要求完整实现；没有要求再做一轮设计检视）。需求见 [proposal.md](./proposal.md)，设计见 [design.md](./design.md)。
> 按仓库硬规则：批准后先完成全部实现与全部测试用例，再集中验证；不边写边测。

## 任务

| # | 内容 | 依赖 | 主要位置 |
| --- | --- | --- | --- |
| RFC-626-T0 | 复核：design §3.2～§3.4 中标「调研」的结论逐项对源码复核一遍，与文档不符的先改文档再实现；v0.19.0～v0.19.2 到 epoch-1 末版之间补的迁移（两种库）对已有行的取值要求再核一遍；design §3.3「自动处置之后校验必须通过」的表与十一条只读探测、全部外键逐条复核；把规则里每一处发阻塞项的调用列成清单，逐条对上 §3.4 | — | `design.md` |
| RFC-626-T1 | 环境前置检查：挪到登记意图之前的只读检查（`config.json`、结构识别不数行、有效数据量估算空间、PostgreSQL 能否建库、旧版搬迁操作未完成）；拒绝时不写会话记录、不建操作目录、不写分配文件、不建库 | — | `system-operations/application/epochSwitch/autoUpgrade.ts`、`domain/epochSwitch/capacity.ts`、`platform/persistence/migration/freeze/capacity.ts` |
| RFC-626-T2 | 源身份与核对：内容身份各算一次；同一进程内 SQLite 保持对旧库的只读连接（由自动升级会话的装配持有，源句柄借用）并比较 `PRAGMA data_version`、PostgreSQL 比较各表行数与序列值，核对不通过时回退重算；进程重启后续做时重算一次旧库身份；去掉三处纯重复；持久的冻结记录（发布顺序、重开；SQLite 含冻结副本，PostgreSQL 只记身份与行数、序列值）；PostgreSQL 自动模式的 scratch 拷贝不跑业务不变量检查；旧库自带外键悬空行不再让冻结失败 | — | `platform/persistence/migration/sqliteSourceReader.ts`、`postgresqlSourceReader.ts`、`freeze/sourceAccess.ts`、`offlineSourceUpgrade.ts`、`bootstrap/epochMigrationAuto.ts`、`bootstrap/epochMigration.ts` |
| RFC-626-T3 | 自动模式单遍编排：`direct` 开关、前置计划、计划步在同一轮运行里可重入（冻结记录沿用，盘点重做）、执行步开始时钉住计划（只写一次的 `plan-pinned.json`，此后不再重新计划）、执行步顺序、实际结果计划与再批准（评估与批准按批准摘要幂等复用）、收尾只做一次；实际结果的计划由会话的回调当场批准，执行步不返回；已钉住计划、激活回执未发布时，在分配目标库之前比较 `plan-pinned.json` 里的候选构建、转换器版本、目标契约摘要与结构摘要，不一致先把失败落进日志再走既有的新建运行，旧的新库凭已保存的代际身份退役；计划钉住之前旧库变了就在本轮目录里重新冻结；执行步与打开运行处保留比较（含规则集摘要） | T2 | `system-operations/application/epochSwitch/planner.ts`、`runner.ts`、`autoUpgrade.ts`、`infrastructure/epochSwitch/targetGeneration.ts`、`infrastructure/epochSwitch/metaStore.ts`、`bootstrap/epochMigration.ts` |
| RFC-626-T4 | 转换引擎记账提速：排序键预计算、行摘要入暂存列、紧凑暂存编码、sink 免重算、规范化 JSON 键序缓存；暂存库摘要改定义并递增转换器版本 | — | `platform/persistence/migration/conversion/receipts.ts`、`engine.ts`、`staging.ts`、`platform/persistence/schema/canonical.ts`、`infrastructure/epochSwitch/conversionSink.ts` |
| RFC-626-T5 | 内容盘点：单次序列化、遍历减少系统调用、目录前缀索引 | T2 | `platform/content/inventory/manifest.ts`、`freezeInventory.ts`、`databaseTrees.ts` |
| RFC-626-T6 | 备份只做一份并直接取冻结副本，摘要在进程内复用；工件库登记与取回改用硬链接 | T3 | `platform/persistence/migration/freeze/backup.ts`、`infrastructure/epochSwitch/backupAdapter.ts`、`fileJournal.ts` |
| RFC-626-T7 | PostgreSQL：拷贝按参数上限分批；搬运口径（拷到 scratch 及回读、备份导出、备份读回不检查 JSON 文本合法性与实数是否有限，备份清单记口径）；装载批大小按库类型、单元元数据合并写、RFC-349 归档目录校验缓存；错误原因取文字的统一函数（不再出现 `[object Object]`） | T2 | `platform/persistence/migration/offlineSourceUpgrade.ts`、`postgresqlSourceReader.ts`、`postgresqlSourceExport.ts`、`legacy/postgresqlLogicalTarget.ts`、`legacy/logicalDatabaseArtifact.ts`、`freeze/backup.ts`、`target/loader.ts`、`infrastructure/epochSwitch/metaStore.ts`、`conversion/postgresqlArchiveSource.ts` |
| RFC-626-T8 | 结束任务：`prepareConversion` / `run` 拆分、`blockExecutable` 与 `settles.tasksOf`（内容规则与阻塞判定共用同一推导）、声明了 `settles` 的规则里任何将被封存的行都让涉及的可继续任务进入结束集合、第 0 代执行代际行改由任务规则发出、发现过程与不动点、`settlement` 合同（三个模块的 settler 与 task-execution 的级联扩展）、结束集合进入转换计划与重放 | T4 | `conversion/engine.ts`、`conversion/rule.ts`、`conversion/readSource.ts`、`modules/task-execution/infrastructure/migration/`、`modules/collaboration/infrastructure/migration/`、`modules/system-operations/infrastructure/migration/` |
| RFC-626-T9 | 新结束原因：任务停止原因的单一事实源加一种、前端原因表与中英文案、数字员工视为停止 | — | `modules/task-execution/domain/sourceTermination.ts`、`packages/frontend/src/lib/task-failure.ts`、`i18n`、`modules/task-execution/application/digitalEmployeeExecution.ts` |
| RFC-626-T10 | 封存：收集器的行级封存、目标契约失败；装载拒绝的回报、单元重试与续做时按运行记录里的完整决定原样复现；引用的保留办法声明（结构里声明置空的外键加模块显式声明的置空、改指），转换时的解除引用与收尾共用；目标结构声明的种子行带不过去时以错误结束而不封存（转换与收尾两个阶段）；收尾处置（一个目标行的一处引用一条、同事务、幂等）、收尾步骤返回由记录导出的处置清单、目标行数对账；追溯在有收尾处置时回放后叠加；启动事实采集、未结束任务统计、追溯的组定位与转换读取共用读法，自动模式下跳过解不出的行；被结束任务的逐行改写留痕 | T4 | `conversion/receipts.ts`、`engine.ts`、`conversionSink.ts`、`target/finalize.ts`、`infrastructure/epochSwitch/validation.ts` |
| RFC-626-T11 | 逐类保留处置：design §3.4 各行的规则改动（内容，含与登记不符时按磁盘现状保留、登记为缺失的回执不与磁盘比对；技能的隔离、封存与操作记录了结，`skill_operations` / `skill_operation_locks` 并入技能规则；缓存仓库与按地址关联；定时任务停用；运行时默认值；融合与记忆；代码历史自动确认；代理引用；悬空引用；任务属主；旧任务书；事件族切换） | T0、T10 | 各模块 `infrastructure/migration/` 与 `platform/content/migration/`、`platform/persistence/migration/archives/` |
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
- 数字员工「回复检视意见」丢失的缺陷：已单独立项为 RFC-628 并交付（`94703d534`）。
- 激活回执已发布、切换未完成时换上目标契约不同的二进制：现在与本 RFC 之后都走不下去（要用建新库时的版本完成）。
  要让它自己走通，需要按代际登记的契约版本打开已建好的新库。

## 验收清单

实测都用同一个最终二进制（实现门修复与 design §9.11 的修订之后构建），参考数据是 design §1 那份真实 v0.19.2 实例
（文件 24.7 GB、有效数据 1.07 GB、537 个任务、82.8 万个运行文件），机器是 10 核 macOS，1 分钟平均负载 11～20（另有一个本地 Kubernetes 集群常驻）。
内存取 `/usr/bin/time -l` 的最大常驻集（偏高的口径，见 design §9.9），GB 均为十进制。

- [x] 1 不拒绝：M1（37 个旧任务原样未结束）自动升级成功（5 分 23 秒）；恰好这 37 个任务变为已取消、原因 `ended-by-upgrade`；
  各状态的任务数与手工预处理过的那份完全相同（等人工 1、等评审 2、已取消 53、完成 359、失败 73、中断 49），两个等评审的任务仍在等评审。
  与预处理那份的升级结果逐表对比，只差这 37 个任务的行（tasks 37、node_runs 25、clarify_rounds 16、lifecycle_alerts 19、execution_legacy_evidence 62）。
  「等评审的正常任务能继续」在发布版矩阵种子上验证（`rfc626-release-upgrade-settled-tasks-*`：升级后批准并完成）。
- [x] 2 内容与技能缺失不拒绝：只有库与配置的家目录（没有运行文件、没有技能目录）自动升级成功：4 个任务结束、483 条内容登记为不存在、
  15 行技能与版本保留并标为隔离，都列在报告里。PostgreSQL 只有库绑定的家目录同样成功（第 7 项）。
  「放回目录后恢复」在矩阵种子上验证（`rfc626-release-upgrade-skills-*`：新版本启动后从版本快照补回目录，复核后重新可用）。
- [x] 3 封存与其它处置：A4～A10 各类处置都有一份矩阵种子（`tests/fixtures/release-upgrade/rfc626/`，8 类、两种库，映射预言 `rfc626/oracle.json`），
  结果与 proposal §5 一致；本地跑 SQLite，PostgreSQL 以 CI 为准。
- [x] 3a 升级后能启动：每一份矩阵种子升级后真实启动服务并完成一项代表操作；最终二进制把新装的 v0.19.2 空库升级后启动服务并完成全部启动步骤。
  真实数据的副本上**没有启动服务**：配置里开着定时任务、自动续跑与工作区回收，还带真实凭据，启动会对真实仓库产生动作，而没有安全模式开关；
  这几份改用逐表对比与只读核对。
- [x] 4 环境前置：配置不是 JSON 0.6 秒；多一张表 3.7 / 4.0 秒（列出该表）；空间不够 4.1 秒（所需 24,952,013 字节、可用 9,584,640 字节、目录）；
  磁盘完全写满 0.5 秒（锁文件写不出，按空间不足拒绝并给出可用字节数）；PostgreSQL 角色不能建库 1.6 秒（给出两条完整的 `CREATE DATABASE`，
  服务器上没有新建的库）。退出码都是 3，家目录里只多出空的 `database-migrations/auto-upgrade/`，没有会话记录、操作目录或分配文件。
  结构识别不数行（`rfc626-source-precheck`）。**偏离**：PostgreSQL 旧库的结构比较要一个 scratch 库，前置检查不建库，所以 PostgreSQL 上结构不符要到冻结时才报
  （此时会话已登记、目标与 scratch 库已建好，退出码 1），见 design §9.9；用户文档已写明。
- [x] 5 耗时：SQLite **4 分 40 秒**（280.5 s，原 70 分 50 秒）；PostgreSQL **10 分 58 秒**（658.1 s，原 76 分 05 秒）；日志里每个阶段只走一遍
  （冻结 45 s、清点 35 s、备份 4 s、转换与写入 3 分钟、收尾与校验 10 s）。新装的空库 8 秒。
- [x] 6 资源：最大常驻内存 SQLite 3.76 GB、PostgreSQL 3.60 GB、M1 3.56 GB（原 10.7 / 7.4 GB）；SQLite 新增磁盘占用峰值 7.37 GB、完成后留存 4.28 GB
  （原约 16 / 7.7 GB）；前置检查对参考数据给出的所需空间 8.85 GB（design §9.11 第 6 项把两个系数调高之后；调之前是 7.14 GB，低于实测峰值）。
  PostgreSQL 与 M1 两次的磁盘读数无效（运行期间机器上别的进程在写盘、释放空间），以 SQLite 这次与之前两版二进制的读数为准（峰值 7.20～7.37 GB、留存 4.12～4.28 GB）。
- [x] 7 PostgreSQL `tasks` 1000 行、2000 行升级成功：最终二进制在 1037 个任务、只有库绑定（没有运行文件与技能目录）的家目录上升级成功，新库里 1037 个任务（4 个任务结束、483 条内容登记为不存在、15 行技能保留打标记）；2037 个任务由实现门修复之前构建的二进制验证成功。原先 937 个任务就会失败（单条语句超过 65535 个参数）
- [x] 8 结果一致：映射预言全部通过（发布版矩阵与 RFC-398 既有预言）；参考数据新旧实现逐表对比——PostgreSQL：旧实现的结果库与最终二进制的结果库
  248 张业务表相同，只有三处与内容无关的差异（`skills`、`skill_versions` 的 `content_ref_json` 里的家目录路径，`code_history_archives.created_at`）；
  SQLite：实现门修复之前构建的二进制与旧实现逐表对比，结论相同（248 张相同、同样三处差异）；最终二进制与实现门修复之后构建的第一版逐表对比，
  只差 `code_history_archives.created_at`。SQLite 上实现门修复前后的两版之间没有直接对比（旧实现的 SQLite 结果库随测试目录被清理）；
  PostgreSQL 上是最终二进制直接与旧实现对比。
- [x] 9 中断续做：在冻结之后、转换中途、校验之后三处杀掉进程再执行 `migrate`，都完成，结果与不中断的一致（实现门修复之前构建的二进制）；
  最终二进制在转换中途杀掉再启动，在同一会话、同一代际上完成，与不中断的结果逐表对比只差升级时刻相关的列（结束时刻、告警解决时刻等）。
- [x] 10 人工流程既有用例全部通过：@@FULL_SUITE@@
- [ ] 11 发布版升级矩阵 L1 / L2 通过，CI 全绿
- [x] 设计门第一轮处置完成（design §9.1：1 项 P0、8 项 P1、4 项 P2，全部采纳）
- [x] 设计门第二轮处置完成（design §9.2：无 P0，5 项 P1、4 项 P2，全部采纳）
- [x] 设计门第三轮处置完成（design §9.3：无 P0，5 项 P1、3 项 P2，全部采纳）
- [x] 设计门第四轮处置完成（design §9.4：无 P0，3 项 P1、2 项 P2，全部采纳）
- [x] 设计门第五轮处置完成（design §9.5：1 项 P0、3 项 P1、2 项 P2 与遗留的 1 项，全部采纳）
- [x] 设计门第六轮处置完成（design §9.6：无 P0，3 项 P1、2 项 P2，全部采纳）
- [x] 设计门第七轮（subagent）处置完成（design §9.7：无 P0，3 项 P1、9 项 P2，全部采纳；未再复核）
- [x] 实现前复核（T0）完成（design §9.8：18 项与设计不符或未覆盖，正文已修订）
- [ ] 设计门复核通过——没有做：七轮都判不通过，最后一轮的修订没有再复核；用户 2026-11-27 批准进入实现，没有要求再检视一轮
- [x] 实现门处置完成（design §9.10：四个只审功能的 subagent 都判通过，无 P0 / P1，19 项 P2 全部处置；之后验收实测中的六处修订见 §9.11）
