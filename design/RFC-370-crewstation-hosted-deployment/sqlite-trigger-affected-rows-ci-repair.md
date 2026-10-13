# SQLite 触发器参与写入后的受影响行数修复

## 已定位的问题

主 CI `38218462107` 的确切提交 `134603ad5658c0a45ebbc4a12881cf504e9b75e9` 中，多处原有更新失败。Ubuntu 12/32 的 Agent rename 在 `affectedRows(result) !== 1` 处报 `resource-operation-stale`；Ubuntu 1/32 的用户更新在相同判据处报 `user-access-stale`，Ubuntu 16/32 的已有账户资料同步也回滚。它们的 PostgreSQL 对应路径没有同一计数回归。

主 CI 和 Windows 均固定使用 Bun `1.4.0`。该版本的 `src/jsc/bindings/sqlite/JSSQLStatement.cpp` 在 prepared statement 的 run 中以执行前后 `sqlite3_total_changes` 的差值填写 `changes`；Drizzle `bun-sqlite` session 将原生 `.run()` 结果直接返回。已发布迁移 0245 给 `agents`、`users` 等原表增加事务内修订触发器，单个原表更新同时产生一行修订写入。因此总变化数不能作为原 SQL 直接命中的行数。

问题位于 SQLite 驱动边界的结果语义。原有业务层“必须恰好一行”的更新判据应保留。计算缓存、修订表、已发布迁移及累计使用量业务继续由其原会话维护；本修复只恢复数据库结果合同。

## 实现合同

在 `packages/backend/src/db/client.ts` 的两个原 SQLite 创建点 `openDb()`、`createInMemoryDb()` 中各安装一次内部 prepared-statement 结果适配。复用同一原生连接，覆盖 Drizzle 实际使用的 `prepare` 和 `query` 两入口；缓存原生 statement 对应的包装对象，保留 query 的复用身份。原有语句守卫、迁移顺序和慢语句观测继续执行原正文。

包装的 `run` 同步调用原方法，原方法抛出的错误直接传播。原 `changes` 为零时直接返回原结果，使未命中更新、读取语句和 DDL 保持零，避免读取到上一条写语句的 `changes()`。原总变化数大于零时，在返回之前同步读取同一连接上的 `SELECT changes()`，用其直接行数替换结果的 `changes`；保留原 `lastInsertRowid` 和其余结果字段。中间不等待、不写数据库、不切连接，也不重新执行原 SQL。SQLite 的直接行数排除触发器和外键级联的额外写入，仍保留真正直接命中多行的数量。

原生 statement 的其他方法仍绑定原 receiver，属性读取仍使用原对象，以保留原生私有字段访问、`all/get/values`、列信息、参数信息和 finalize 的行为。适配为 db client 的内部实现，不新增业务层 API，不对 `affectedRows()` 做截断或放宽。

## 必须覆盖的回归

新增限定的真实 SQLite 数据库用例，并通过两个原创建点分别验证：

- 一行更新加触发器副写仍返回直接行数 1，原表数据和修订副写均实际存在；两行更新返回 2，不能把多行结果压成 1。
- 未命中条件的更新返回 0，且不产生修订副写；已成功写入后的读取和 DDL 仍返回 0。
- insert 保留原生 `lastInsertRowid`；delete 排除外键级联的子表行数，同时子表删除实际发生。
- 事务回滚保留原数据和副写的一致性；原 SQL 错误仍抛出；包装对象和原生读取方法仍可正常复用。

已有 Agent rename、账户资料更新及业务更新的 hosted 用例继续作为端到端回归判据，不改其原有断言。受影响行数的 provider 中立入口和 PostgreSQL 驱动保持原正文。

## 门槛与证据边界

先对本设计做独立功能检视，再落限定实现与回归用例，完成独立实现检视及必要的源码清单同步后精确上库。仅执行限定格式、lint、纯语法解析和必要的清单生成；不在本机运行 AW test、typecheck、build、服务或 E2E。测试只由 GitHub 的确切提交执行。

本片的退出条件是新提交的主 CI 与默认完整 Windows 终态均 success。当前源代码推导和检视不能代签修复实际通过，也不能关闭 H7、CS adapter、部署或 M0～M4。RFC-370 的后续实施继续等待总流水线全绿。

## 2026-10-12 既存候选自身缺陷与现行执行边界

原 SOURCE-R1 是有效、稳定 FAIL，唯一 P2 为本会话新增固定 probe 被公开 exact-SQL `query().finalize()` 或 `clearQueryCache()` 失效后，将已成功写入报告为失败；正式失败与根消费记录保留。当前只修正这项自身缺陷：提前绑定原 native query，每次正写后重新取得有效的 query-owned probe，直接读取标量并保留 number 行数，仍早于旁观者副写且不经过外层观测。零结果、原 lastInsertRowid、异常、业务 SQL 与 PostgreSQL 正文保持。

原十个双工厂案例保留，新增 alias-finalize、cache-clear 和 cached-probe bigint 三项真实数据库回归，静态登记预期为每平台 26 次，尚未执行。测试注册移入 `tests/helpers/rfc370SqliteAffectedRowsCases.ts`，由默认完整 Windows 已选择的原 `rfc349-daemon-provider-runtime-session.test.ts` 显式调用一次；原 session 测试正文保留，不改共享 workflow 在制品。原本会话未追踪的 standalone test 已迁移，冻结 R1 原件保持。

本候选仍未发布，也没有新的功能门、census 或实际测试通过记录。遵守今日 `CLAUDE.md` / `AGENTS.md` 硬规则：CI 先按提交和依赖归因，他人引入的回归由其原会话修复，不再接管；不发送跨 session 信息。当前修正自身已写候选并保留历史，不据此替他人业务签收或恢复未获总绿的 RFC 生产推进。后续实现门集中进行，不再逐个小切面反复开门。

## 2026-10-12 共享发布、实际回归与本会话遗漏

上述 SQLite 实现、十三个双工厂案例及原 session 注册已完整保留，并随共享提交 `95ec4a8ee9698792c148d6cadf4d241db73474d9` 上库；本次起始核对的 `fdbaec7b68251a4e1dd8d8d5b4a6c3ffd8200d01` 仍含同一实现。上节“未发布／尚未执行”是当时快照，不是当前状态。共享发布还含 RFC-371／RFC-372 的独立产出，不转移其 CI 责任。

包含同一 SQLite 实现的 `c166c340aa9438ae23cba1806f9dd90cc78a7b63` 已有实际 hosted 回归：Ubuntu job `114846823233`、macOS job `114846823133`、默认 Windows job `114846820454` 分别完整出现十三案例 × 两工厂的 26 次 pass，共 78 次，包含原 finalize／cache-clear／bigint 回归。只证明这些具体用例通过，各 job 和总 CI 仍存在其它失败。

该 SHA 的 macOS job `114846823077` 在原单引擎清单检查处失败，日志 1368／1386 明确多出 `helpers/rfc370SqliteAffectedRowsCases.ts: 1`。这份夹具由本会话新增，遗漏精确登记是本会话的 CI 配套缺陷。本次只新增这一条和就近理由，原 `$client` 机械分类已覆盖其真实裸驱动操作；原扫描器、全部 344 条记录、sanction 判据、OPEN_MIGRATION_DEBT 两条和 EXEMPT 一条保持。高水位对应行从 344 调整为 345，按原规则登记并在紧邻无增长后继退役一次声明；内容摘要随原 canonical JSON 规则同步，不运行新生产 census。

同一批两项带 RFC-370 名称的启动根失败均报 `task-launch inverse unreviewed statement: observationReports`；提交差异显示后续新增 observation projection 实参改变了完整原语句。格式失败的三份文件也来自该增量。它们不因名称、共同提交或本会话负责过 push 而归入本片，相关原证据保留，不修改其他会话生产或测试，也不发送跨 session 信息。

本片只补齐自身登记遗漏并记录已发生的 hosted 证据；没有新增实现门、本机 AW test／typecheck／build／服务／E2E。起始核对的主 CI `38261966315` 当时尚未终态，后继确切 SHA 的完整主 CI和默认完整 Windows仍须核对，不恢复尚未获总绿的 RFC 生产推进。准备发布期间，并行架构配套已完整提交到 `304c4108c84d46ef3e8b5d82d49cb4cd530249da`，包含本会话追加的 STATE 记录；本片在其新账本上只合入自身的一行，保留全部并行配套和来源，不重复提交已上库的 STATE。

## 2026-10-13 本会话登记修复的 hosted 结果

精确登记已提交为 `9fabf705fd79c14f4597aa57737ebc723159d829`，紧邻的声明退役为 `861833a65718a2b7bf0efbe7b666b257cbb5b287`；推送后 fetch 核对 main／origin 同步。后者主 CI `38267051133` 的 macOS job `114871730683` 实际日志 3358～3365 完整出现原 T19f 八项 pass，含精确调用点数、排序／去重、完整分类、open 数量、语料下限及原负夹具。该分片另有三项失败，不以目标八项 pass 代签整个分片。Ubuntu job `114871730439` 的原 T17 相邻提交／增长／过期检查也实际 pass，登记和紧邻声明退役的自身 CI 缺陷据此闭合。

同 SHA 默认 Windows `38267051045`／job `114871728604` 正式 failure；平台步骤实际 1492 pass／3 skip／14 fail，本片十三案例 × 两工厂的 26 次仍全部 pass。原日志 2227／2260 和两条实际 Worker 失败明确报 `membership is not defined`，指向历史准备增量将原 membership 函数改名后仍使用旧名称；其余启动根失败保留 observationReports 的新实参及完整旧根长度差异。当前格式失败仍仅为三份观测增量文件，Markdown 失败指向另一 RFC 的 schema-source-review 文档。按实际源差分归因并保留完整原日志，不因测试或日志中出现 RFC-370 就接管其它会话代码。

完整主 CI仍在观察，已出现其它失败；总绿前不继续 RFC 生产实施。此段仅记录真实 hosted 结果，不运行本机 AW、不另开实现门或重采生产 census。全 H7、A-G、独立 CS adapter、实际 M0 部署及 M1～M4均未完成。
