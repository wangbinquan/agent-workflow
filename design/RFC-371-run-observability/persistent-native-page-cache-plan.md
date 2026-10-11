# RFC-371 原生数值页持久缓存：第一批实现计划

状态：有限功能设计门 v319 已通过并由 root 完整消费；第一批源码和真实 provider/Worker 用例已准备，待有限实现门、准确提交的托管 CI 与正式页面耗时验收。实施记录见 `persistent-native-page-source-implementation-20261012.md`。承接 `persistent-usage-facts-20261011.md`，先减少更换范围时重复解析 OpenCode 数值页的成本。第一批不宣称已经完成全部增量汇总、重启后快速命中或 warm P95 <1s。

## 保留的原合同

`historicalObservationSource.ts` 仍先遍历全部可见 owner、event、原 parent 与 root 的完整 EOF，再归属、去重和汇总。任务、尝试、调用、root、part、父子深度和总页数都不设置截断。原数字输入、缓存读取、缓存写入、输出、冻结人民币估值、unknown 和 coverage 都由原算法决定。历史原生引用仍为 `historical-observed`，不生成 accepted invocation、停止回执、进程结束或物理释放证明。

保留 Runtime 的 `HistoricalNativeUsageQuery` 与同步 `HistoricalNativeObservationReader` 公共合同。每次真正的原生读取继续使用原 root 的独立只读 BEGIN、TEMP 队列、分页、ACK 和 EOF COMMIT；不把多个 root 改成一个原生事务，不改 `opencodeReportConnections.ts` 的关闭与异常路径。缓存保存原页输出中的数值、model、父子元数据与回执，不读取或保存 conversation/tool 正文，不改 OpenCode 表或触发器。

## 原连接的变更证明

新增 Runtime 所有的原生源版本观察器，按 `opencodeUsageDatabasePath(process.env)` 选择原文件，使用 `opencodeNativeStoreGeneration.ts` 的原 dev/ino/birthtime 身份与一个持续的只读 SQLite 连接。只有在这个连接的前后采样之间，`PRAGMA data_version` 才能比较；SQLite 官方合同见 [PRAGMA data_version](https://www.sqlite.org/pragma.html#pragma_data_version)。观察连接不执行 BEGIN 或源写入，root 的原读事务仍独立。

版本证明为 `{nativeSource, sourceGeneration, connectionEpoch, revisionToken, parserVersion}`。连接首次打开生成新的 `connectionEpoch`；同一连接发现 data_version 改变时旋转 `revisionToken`。原文件替换、缺失后重建、连接关闭/错误、服务 pause/stop、进程重启都销毁旧证明。打开前后与每次采样前后核对原物理身份；不把不同连接的整数、mtime、大小、count、max ID/时间、旧终态或 TTL 当作内容未变化证明。

观察器由原 `observationReportBuild` 装配创建，延迟打开，生命周期参加原报告 worker 的 stop/drain；resume 延迟建立新连接和新 epoch。SQLite 与 PostgreSQL 的应用持久库均使用这个 Runtime 原生观察器；应用库的 provider 不改变外部 OpenCode 源的物理类型。源不可读时关闭旧证明并走现有原生读取/真实缺口路径。

## 应用库的派生页与原子发布

新增两张 provider-neutral 派生表，和完整报告表一样不作为业务用量权威：

| 表                              | 原键与内容                                                                                          | 完整条件                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `observation_native_fact_roots` | cacheKey；上述完整证明；rootSessionId；原 identity、initialCursor、页数、最终 digest、EOF 与 issues | 原全部页面处理与 ACK 成功，原 reader 成功关闭；同一证明覆盖读取前后；state=sealed |
| `observation_native_fact_pages` | root cacheKey + 原 cursor；原 ordinal、nextCursor、完整数值 page、payload/cumulative digest         | 唯一原 cursor；原序号连续、摘要链和 EOF/counts 完整；不能只验证表有多少行         |

cacheKey 包含所有证明字段、原 referenceId 和 rootSessionId；同一物理 root 的不同原引用不能覆盖彼此的 identity/摘要链，不同 parser/page 协议版本不能混用。按原 cursor 点查页面，不靠固定宽度 ordinal 或总人口上限。完整原页验证使用 Runtime 提供的原数值页/摘要规则，不另写一套更宽松 parser。header 的缺失、building 状态、缺页、循环、顺序/身份/摘要/EOF 不匹配均使该 cache 失效，不能返回空页或已知零。

Worker 的原应用 snapshot 只读派生表；冷读在原 TEMP workspace 中暂存原页。完整读取后，将原页与封闭根写入原 `appHome/operations/observation-reports/<reportId>/<ownerHash>` 下独立的有界传输 spool，带有总页数、根数和全清单摘要。每批只限制内存/I/O，传输全部原记录到 EOF。该 spool 沿用报告的原目录生命周期，不添加独立输入库。

平台在 Worker 返回、原 SQLite/Pg snapshot 及 reservation 完全释放后，才通过应用的 provider-neutral writer 导入派生页。每个 root 的全部页面和 sealed header 在同一原事务发布；中断回滚或未 sealed 根不能命中。导入前后重新核对持续源证明；证明变化的旧 epoch 不再成为当前缓存输入。缓存不为“整个原生人口已闭合”提供替代证明，每个新报告仍从所有者完整原 root 清单开始；没有缓存的任何 root 均完整读取原源。

## 命中、源变更与损坏的行为

私有 `HistoricalObservationSources` 可增加一个 `nativeFacts` participant，提供异步的原页读取与派生 staging。它仅由 Worker 在同一应用原 snapshot 上装配；Runtime 原同步 reader 公共接口不变。历史采集器把原 reader 包装为私有 async page source，按相同顺序进行页面检查、原记录归属、receipt 暂存和 ACK。缓存页走同一归属算法，保留原 identity、ordinal、payload/cumulative digest、scan position、EOF、issue，命中不是新增统计记录。

每个构建开始取得持续源证明。使用过缓存的构建返回后必须再次验证同一证明；发生原 WAL 更新、schema 变更、reparent、同 ID 修订、删除、新 message/part 或迟到 usage 时，丢弃这个构建的未发布 spool/TEMP 输出，并完整重建一次，关闭缓存读取。缓存损坏也触发同一无缓存重建。重建使用新原应用 snapshot 和全部原源 EOF，不能在已污染的旧 workspace 中拼接补齐。仅允许一次无缓存回退，避免源持续更新导致循环重试；无缓存回退沿用原逐 root snapshot 语义，不宣称整个 OpenCode 库的所有 root 同时处于一个事务。

无缓存构建期间如果原内容持续变动，正常报告沿用原完整读取、冲突和缺口处理；只有持续证明前后相同、完整 EOF/ACK/close 成功的根才能发布为可命中的缓存。不存在有效证明时仍做原完整统计。取消、租约丢失、数据库 generation 改变或真实源读取失败沿用原失败处理，不转成空统计。

每次 stop/pause 在所有在途 Worker/导入结束后关闭源观察连接；resume 的新 epoch 首次执行完整原读取。第一批通过持久页消除连续服务期间的重复 JSON 投影，但重启后的首次原证明仍必须全量建立。后续原内容指纹索引和 coverage family 贡献缓存才能复用重启后的解析结果并达成全范围汇总目标，不能把第一批短期热命中代签后续要求。

缓存生命周期只清理派生状态；原 reportId、数字用量、冻结价格和原停止证明保持原合同。只允许清理已不再使用的旧 epoch 或未发布 spool。Task/project 的当前 owner 清单和 visibility 始终先于 root 命中；Task 删除不会因旧数值页缓存重新出现在结果中。共享 root 的缓存是原源事实，不能按某个 Task 删除而使其他仍引用它的 Task 漏数；原 owner 引用 EOF 与派生事实回收需在随后贡献层的原生命周期接线中完成。

## 文件与验证范围

1. Runtime 增加原生持续版本观察器及其 composition/public participant；保持原 native reader 文件、SQL 和所有旧用例不变。新真实 SQLite WAL 用例覆盖：同连接未变、另外连接 insert/update/delete/DDL/reparent/迟到 usage、源替换、missing→created、close/reopen、证明前后变化，不能用假的 counter 代替原 data_version 合同。
2. `db/observationNativeFacts.ts` 与 `db/schema.ts` 增加两个派生表；用原生成器维护 SQLite migration/meta 与 PostgreSQL baseline/journal，两个 provider 的约束和 EOF 行为保持相同。
3. run-observability 增加私有 nativeFacts 端口、原页验证/读取/staging/传输/导入；`historicalObservationSource.ts` 只替换原页面来源的装配点，保留所有 root、步骤、记录、unknown、原 receipt 和原 ACK 的顺序。新 provider 用例必须遍历所有原页并逐项对拍 identity、steps、四桶、model、issues、EOF、counts 和摘要，不只比较 total。
4. 原 `observationReportProtocol`/Worker/Host 和 `observationReportBuild` 接入证明、私有 fact spool、release 后 writer 和一次无缓存回退；结果发给 HTTP 前仍是原 `CompleteObservationBuildResult`，没有页面协议或筛选变化。测试覆盖两 provider、Worker 正常退出/异常/取消、snapshot release 在 writer 前、compiled worker entry、在途源更新、坏缓存与失败回退、不暴露半套缓存。
5. 两个原 CLI 装配点和报告 worker lifecycle 接上 stop/drain 后关闭观察器；测试覆盖 pause/resume/stop、旧 epoch 不被重用，不能为新 observer 放任守护连接泄漏。
6. 保持原固定范围 oracle：137 任务、595 尝试、446 调用、719 历史执行、2,630,923 Token，四桶 1,189,241/1,255,680/0/186,002，已知人民币 ¥4.078952，全部有序 rows/counts/receipts 与原缺口。实测冷读、热新范围、源更新回退、重启冷建立，并分别报告原读取/页复用/归属/传输/发布与请求到可见的整体耗时；不拿局部缓存耗时冒充整页 <1s。

本批只有在有限设计门和实现门完成后才精确提交；AW 不跑本机测试、构建、E2E 或停止过的 observability-scale。所有新旧用例由准确提交的 GitHub Actions 执行。原 token/CNY 数据、所有源 EOF、任务所属与原名字、概览卡片/趋势/泳道 UI 都保持现有正式合同。
