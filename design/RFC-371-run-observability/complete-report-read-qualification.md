# RFC-371 完整报告读取资格复用

本补充落实既有已批准的完整统计与原规模验收，保持当前 API、任务/调用全人口、四桶 Token、人民币估值、部分已知事实和原分页 EOF；不新增采样、人口上限或估算替代。设计门先完成，随后实现和独立功能检视；原失败不改写为通过。

## 已确认的问题

原 SHA `65431b1de2bf664bfb24065e96e26e00a981d63b` 的原完整规模 run `37379238745` 使用 100,000 任务、10,000,000 条用量。完整报告已产出后，100 次读取的 status P95 为 4033.20 ms，首末页 P95 为 8233.53 / 8127.94 ms，未通过原 500 ms 要求。实际日志中，`assertCompleteReportIntegrity` 每次重复四张完整派生关系的物理 COUNT，以及每个 section/parent 的相关 COUNT。page admission 与读取重复该核对。原 self-total 场景四小时未完成，临时空间最高约 78.9 GB；它是单独的选择/工作区问题，本补充不得把它记作已修复。

当前原回归会在 ready 后删除一条 allocations 行，随后 status/page 都必须拒绝，并且原持久报告状态仍是 ready。不能直接省掉完整物理核对，也不能用原 manifest 自证当前行仍在。

## 层次与数据流

只改 run-observability infrastructure 原派生报告 cache/read/integrity，以及该原表的双 provider 追加迁移。application、现有 Actor/task/cost 可见性核对、原 usage/capture/source/price 数值账本和 worker 的完整产出保持。

在新增的派生关系 `observation_report_retained_revisions` 为每个原 report id 保留一个不透明 TEXT 修订，主键与 cascade 外键均指向原 `observation_reports.id`。它仅标识四张原派生关系是否在发布后改变，不记录 Token、金额、任务数量，不是第二数值账本。修订行缺失或修订为空表示没有记录到发布后的改变，只能触发冷态完整核对，不能据此直接取得资格。旧报告不批量补造资格或更改原 report/manifest；原父表没有 document 列，也不修改 report、progress、updated_at 或其他现有列来夹带修订。

SQLite/PostgreSQL 在原 `observation_report_pages / rows / counts / receipts` 的 INSERT、UPDATE、DELETE 使用同事务触发器，父报告非 building 时插入或替换其修订。UPDATE 改 report_id 必须同时使原父和新父的旧资格失效；同一父只需一次失效。PostgreSQL 使用各事件独立的 AFTER STATEMENT 触发器与实际 transition tables，合并该语句的旧、新 report id 并去重、排序，按真实父 id 取得同一父报告的 FOR UPDATE 锁，再判断该锁定行当前是否 building；判断与 publish 对同一父行的实际更新串行化。不能读取旧 building 快照后跨 publish 提交而漏记失效。该锁定检查按语句中的不同父执行，不能把原 500 行批次变成每行重复锁定。SQLite 使用原单写者事务中的行触发器；UPDATE 的新旧 id 相同时只执行一次修订写。building 原批量写不生成新修订，发布后第一读取仍全量核对。实际事务回滚同时回滚修订，不更改 updated_at、lease、state 或原 manifest。父表删除的 cascade 不创建或恢复父报告，不对不存在的父插入修订。

修订使用 provider 原生不透明随机身份（SQLite lower(hex(randomblob(16)))，PostgreSQL gen_random_uuid()::text）；其功能只作相等判断，不经 Number、计数器或时间截断。追加迁移与实际双 provider 完整 schema/升级证据一起登记，不改历史迁移或旧摘要。

## 实际 schema 与迁移接线

原 PostgreSQL 序列只有 V1 普通 index、V2 整张新 active KEEP 关系、V3 具名 CHECK 与对应 enum 替换，尚无给现有关系加列或投影本功能触发器的声明。前版的父表加列不能直接落入这些原语；本版改用整张新派生关系，不拓宽现有列变化规则。

为新关系添加闭合的 `retained-output-revision` schema 声明：指定本关系的 report id／修订列、原父关系及其 id／state 列、building 值，以及原四张派生关系及其 report id 列。声明附着在新关系的 provider schema 元数据中；原 `schemaContract` 仅对这张新关系投影对应可序列化字段，历史关系不补空字段。它不接受任意 SQL，不在 application 或其他领域增加 provider 分支。新增声明与原完整表列、主键、外键、KEEP disposition、owner、retention、consumer 一起进入当前逻辑摘要。

原 `postgresqlSchema` 需要增加由该闭合声明确定生成的 function／trigger statement 类别，在所有 table／index／constraint 之后、metadata 之前输出本功能原生函数和十二个事件触发器；真实物理关系名仍由原 contract/provider table 投影取得。原 V2 `createPostgresqlAdditiveUpgrade`／replay 已按完整新关系与新 plan statements 重放，但当前 projector 尚未实现此声明。本功能必须实现这个有限投影，再用原 V2 helper 生成确切新增关系、函数、触发器和 contract row；不能将手写 SQL 伪装为 index，不能给历史 step 加字段或放宽旧 statement 逐字相等规则。旧 V1/V2/V3 contract 不含新关系，投影出的全部旧字节、历史摘要和根 SQL 必须保持。

原 `postgresqlLogicalTarget.prepare` 只安装 bootstrap／table／metadata，原 `finalizeSchema` 在全部 chunk 的实际行／摘要验证后才安装 index／constraint。本功能的 function／trigger 也在同一个 finalizeSchema 事务中、约束之后安装，成功后才记录原 schema_migrations 与 verified stage；不在 prepare 或 copyChunk 安装。这样已发布报告及修订行按原完整 source bytes 导入，导入不会额外制造修订行、造成 chunk 冲突或改变原行摘要。新库正常 bootstrap 和原旧库 upgrade 仍执行完整 plan。finalize 失败回滚并按原持久阶段重试；不能提前激活未安装原生实现的目标，也不新增 disable-trigger、session bypass 或缩减复制表的途径。

SQLite 在原 journal 链尾追加新关系与十二个事件触发器，预期迁移链与原 PostgreSQL V2 新 edge 同步登记。SQLite 与 PostgreSQL 的实际原生实现均由相同声明的有限 renderer 生成并纳入版本化产物；不会依赖一次启动临时安装 trigger。单独验证新库、旧库追加升级、重新打开、原逻辑迁移／恢复、cascade、rollback 与批量写，然后由 hosted exact-SHA CI 验收。该投影和迁移尚未实现，本文件不能据设计门通过而宣称上线。

## 读取与重建

原 cache 实例持有已成功的完整物理核对收据。收据键含 report id、数据库 generation、owner、requestKey、实际 report/manifest 字节身份及实际 retained_output_revision。只有在同一原 snapshot 内重读当前父报告，确认内容身份和修订仍相同，才复用对应物理资格。旧 cache.get 传入的报告不代替该 snapshot 中实际父行。

首次和进程重启后，只有实际当前发布修订为空、身份完整时才执行原四表 COUNT、原所有 section/parent 的 declared/actual/total/物理行核对；全部原条件通过后才记资格。非空修订明确表示该份发布后的派生内容改变，立即使用原错误，不能因为行数相同就给改写的内容重新资格。报告内容、owner/generation/requestKey 等与实际当前父行不同也先拒绝。失败既不记资格，也不在 status/page 把原 ready 持久状态修改为 failed；错误继续使用原 `Complete report retained output differs from its original seal; refresh`。

显式 start/refresh 才能通过原 cache.ensure/claim 构建路径重建这个损坏的派生报告：在原完整 write transaction 中锁定实际父、取得新 owner、转 building，再清理原四张派生关系及旧修订、重置完整 progress，随后原 worker 重新遍历全部原 source。cache.ensure 对存在非空修订的已发布报告也使用这一原重建路径，不能继续把损坏的 ready 当作可复用结果。只有原完整 publish 验收通过才清理本次修订并发布。恢复一条旧行本身不清空修订，不能绕过重新构建；一切源数值账本保持。该行为不改变原 status/page 错误后 cache.get 仍为 ready 的回归条件。

每次读取仍执行当前原 Actor、task 人口与 cost 可见性功能。这里仅复用派生关系已完成的物理核对；不得缓存权限、源数据变化、任务人口或价格可见性结论，不修改任何源 population/计数/EOF。资格收据可以按实际 cache 生命周期清理；丢失收据只导致重新全量核对，绝不遗漏报告行或限制统计。

不在 SQLite snapshot transaction 内等待外部 single-flight，也不把 provider-specific 连接/PRAGMA 作为 application 分叉。并发冷读取可各执行原核对；仅有效的原当前 snapshot 结果可登记。

## 功能验收与原判据

- 原 ready 后删一行用例、原所有完整报告 provider 用例、既有部分已知四桶/CNY 与 source gap 用例逐字保留，原预算保持。
- 两 provider 分别覆盖四张表发布后的 insert/update/delete，以及 report_id 转移；每次原 warm status/page 均不能复用失效资格。同计数的 document 内容改写也必须拒绝，恢复原行仍须原显式完整重建。
- 实际 rollback、不相关 report 的写入、building 批次与跨 publish 的同计数文档写交错、旧报告冷读、cache 重启、owner/generation/manifest 改变、同一 snapshot 的实际当前父内容均覆盖；不将内部计时 mock 作为性能通过。
- SQL 记录证明未改修订的后继读取不再发全量派生 COUNT；原源人口/可见性读取仍执行。直接数据改变能被真实触发器发现，不能只测 cache.stage 自己改写修订。
- PostgreSQL 实际 transition table 批次、跨 publish 同一父锁、旧新两父确定顺序、原逻辑 schema 新关系的 V2 重放，以及全部历史产物的逐字保持均有独立证据。原四表的建造人口、500 行批次、断言和时间预算保持。
- 原规模保持 100,000 / 10,000,000、100 次样本、原 500 ms P95、完整 unique bitmap/四桶/人民币/首末页/全 EOF、资源与时间预算；仅修正生产读取机制后重跑确切 SHA。冷态完整核对仍测量并公开，不能隐藏冷态延迟。

独立设计/实现功能门均只审功能，不扩展任何安全工作。本补充并不完成 native 默认 producer、CS 数值 v2、完整联合验收或两个 RFC 的其他未完成项。
