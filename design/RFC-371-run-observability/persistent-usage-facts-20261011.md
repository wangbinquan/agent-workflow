# RFC-371 持久用量事实与增量汇总（2026-10-11）

状态：源码现状已核对，补充设计与实现计划；尚未实施本页的持久事实缓存，尚未签性能达标。承接用户要求“缓存到数据库、不要每次重新计算”和完整统计不漏一条的合同。CS 对应设计在 RFC-034 的 `persistent-usage-facts-20261011.md`。本页没有授权改写原始运行记录、数字停止证据或供应商账单。

## 当前重复成本

AW 已持久化 invocation、用量投影、原生采集、人民币估值，以及报告的 header、rows、counts、receipts 与传输清单。`application/completeObservationReportService.ts` 的 requestKey 仍包含全部范围、actor、taskId 和 refreshKey；`composition/completeObservationSnapshot.ts` 为新报告重新收集任务和历史 owner、解析原生 session/part/message、计算归属和 coverage、排序、汇总、再固化报告。因此“报告已经落库”不等于“新范围复用底层计算”。普通相同 reportId 的读取已经复用落库数据，本批要解决的是更换范围与源变更后的底层重算。

当前全量原范围 137 任务、595 尝试、446 调用、719 历史执行的第一次新报告实测约 14—15 秒；已撤回的两种仅优化 message model 的试验没有全报告收益，不能作为新缓存的验收。CS 当前小规模报告约 1.1 秒，不能据此保证同规模更快。

相关原实现锚点：`completeObservationCohort.ts` 保留全部原 Task 后逐任务构建；`historicalObservationSource.ts` 全部 owner/event 与原 root EOF 先于数值归属；`completeUsageWorkspace.ts` 的输入、identity、ancestry、coverage、排序和 allocations 是每报告的 private TEMP 工作空间；`completeObservationSourceRevision.ts` 将全部原 EOF/visibility 回执封入报告。新方案保持这些完整性条件。

## 三层持久数据

| 层 | 保存内容 | 原身份与失效依据 | 新范围的工作 |
| --- | --- | --- | --- |
| 原始事实索引 | 原 source namespace/generation、owner/execution/invocation、session/part/message、revision、完整原内容指纹、父子边、时间、model 与每桶 unknown/validity/coverage、原 EOF 与 watermarks | 原所有者公开来源及原物理源当前清单；parser/schema version；真实 insert/update/delete | 在已封闭事实版本上查范围和维度，无重复 JSON 投影 |
| 已归属贡献与汇总索引 | 原独占/包含规则决定的贡献、原 meter 与 valuation 版本、任务/Agent/算力/model/时间索引、分类 Token、人民币、unknown 与缺口计数、区间原段 | 依赖事实向量、coverage family、归属/估值算法版本、原冻结价格版本与 visibility revision | 聚合已算贡献；任意范围边界保留逐条精确索引 |
| 查询报告 | 新 scope-qualified snapshot 的 header、rows、counts、receipts、manifest 与分页索引 | actor/权限/范围/Task、以上封闭版本和投影版本 | 继续原完整传输和页面协议；报告可快速生成且保持独立快照 |

缓存都写在应用自己的数据库，属于可重建派生状态；不能往 OpenCode 原数据库添加业务表、触发器或改写原记录。SQLite 和 PostgreSQL 保存同样的数值字符串、原键、指纹和状态；不使用浮点累加人民币或 Token。任务、尝试、调用、记录、graph depth 和历史跨度无总量上限。每次批次/page 的内存界限只控制 I/O，始终读取至原 EOF。

原始事实缓存键至少包含 `(sourceAuthorityGeneration, sourceNamespace, recordKind, originalRecordId, originalRevisionOrFullFingerprint, parserVersion)`。多个 Task 指向同一个 root 或累计包含子会话时共用事实，贡献仍按原 coverage/ownership 算法确定；不能从各 Agent total 相加得到任务 total。每份汇总保留其全部原 meter/贡献和 receipt 索引，点击明细可完整还原。

## 准确失效与增量更新

1. 应用原表变更通过所有者公开的事务版本/变更页进入持久 change journal；insert/update/delete、终态、原归属/父子边、名称、原估值、价格可见性都覆盖。journal 与原写入同一事务提交；派生缓存自身写入不能推进源版本。没有完整变更合同的 owner 先做无上限完整清单核对，不把 max(updatedAt)、count 或 TTL 当准确水位。
2. OpenCode 原 `opencodeNativeStoreGeneration.ts` 的 inode/birthtime 只说明物理源是否替换，普通 WAL 写入并不改变它。相同 generation 不能直接认定旧缓存有效。新原只读 snapshot 中必须确认所有相关 session parent、message、part 原内容与完整成员清单，捕获新增、修订、删除、迟到 usage 和 reparent；使用完整原内容指纹/EOF 或供应者真实变更水位。mtime、文件大小、最大 ID、最大时间戳、旧终态都不独立构成复用证据。SQLite data_version 只在同一持续原连接内具有可比较意义；重启/换连接仍核对完整清单。
3. 未变化事实只复用原版本；新记录解析一次；修订替换该记录的当前版本并保留来源；删除写 tombstone 并移除当前成员。graph/覆盖累计变化使整个相关 coverage family 失效，按原完整算法重算该 family，再替换旧贡献。不能把新增累计值当 delta 相加，也不能用粗略旧总数减去一个可能包含子树的值。
4. 已受理执行继续使用原冻结人民币费率。费率配置变化不自动改历史 estimated cost；明确历史重估属于独立版本与审计流程。本批缓存区分原估值与重估版本。未知输入/缓存/输出仍为 unknown，known partial 继续显示且标记不完整；缺证据时不能补 0 或把旧快照宣称为当前完整统计。
5. 更新 worker 分段持久 staging、原键幂等、租约和可恢复游标；整个新事实版本到达所有源 EOF、水位/计数/指纹齐备后原子发布。并行查询只读取一个封闭版本；中断、失败、服务重启不暴露半套汇总。旧完成报告不可变，不改原 reportId/cursor/nonce 复用为新报告。
6. source replacement、原物理数据库更换、原来源恢复后的不同指纹、parser/归属规则版本变化触发明确重建；generation 不完整或源不可读仍保留原缺口，不签当前准确。缓存恢复与项目删除参加已有生命周期；删除所有受影响事实、edges、汇总及报告，不能让旧缓存绕过当前 actor 与项目准入。

## 时间范围与部署边界

更换时间范围只查询同一封闭事实版本，不全量重新采集与解析。任务 cohort 仍依据任务实际开始时间；用量 cohort 仍依据原 measurement 发生时间，两者分开。日汇总用于可证明完整的整段；任意时间、时区/DST 与不整日边界查询原 contribution 时间索引，任务数量按原 ID 去重。执行时长取原完整区间并求并集；不能累加 daily duration 或复制跨日任务数量。

独立 AW 的源为自身 Task/内置 Agent/原模型证据及物理原生数据。CS 托管 AW 只通过已批准公开合同读 CS 执行/算力用量与水位，原 authority+project+execution+meter 标识进入同一事实索引。托管导入不同时当本地模型调用和外部算力调用重复计入。托管 source 失联、watermark 尚未闭合或价格隐藏时保留原状态；不能回退本地当前模型/费率“补齐”。RFC-370 负责实际托管接线，本批不会越过其所有者直接读 CS 私有表。

## 实现与验收顺序

1. 固定现有完整统计的无缓存 oracle 与所有来源、四桶、人民币、tasks/attempts/calls、各维度、趋势、unknown、全部有序 rows/counts/receipts。先补持久事实版本、原内容指纹与失效正反例；不改旧 oracle 或降低阈值。
2. 通过现有 provider-neutral persistence 添加事实/依赖/贡献/current epoch 与 change journal，原身份仍为名称之外的原 ID。先实现重启后完整事实复用和新范围查询，再接新记录、修订/删除/迟到/coverage family 的增量发布。每一层只通过原所有者公开端口，不复制跨模块 SQL。
3. 按原生成器维护迁移清单/结构登记，保留并行文件；独立设计/源码功能门后精确提交，在 GitHub 对完整实际 SHA 验证 SQLite/PostgreSQL。AW 不运行本机测试/构建或重新启动已停止的规模 CI。一次候选对应一次发布，不为新的无关 main SHA 重复大门。
4. 用同一原数据完整验证：首次历史导入、同范围命中、全新范围、服务重启后命中、新记录增量、同 ID 修订、删除、迟到更新、parent 边变化、源替换、规则版本失效、构建中断/接管。每个场景有对应完整 oracle，原 known-zero、原 stop/closure、EOF、缺口、去重与币种断言保持；不能因 cache hit 绕过 source 当前版本核对。
5. 性能计时分别记录原来源确认/导入、事实归属、查询聚合、报告 stage/publish、请求到可见的整体耗时与缓存读取。报告实际数据量、每场景多次独立观测及 P50/P95；小窗口 SQL 快于旧版不能代签整页。当前目标 warm P95 <1s、任务明细 <500ms 等仍是原待验收目标，不能仅换加载动画宣称达标。CS 必须给出可比的数据量和相同场景实测。

执行状态：本页设计尚未源码实现；已有落库报告缓存继续正常使用。本批具体新迁移/端口/派生表与逐文件测试清单在有限设计复核后确定，必须先验证原水位和全部删除/修订来源合同，不能预设不存在的增量接口已经接好。
