# RFC-371 原生数值分页缓存实施候选

本批承接已通过有限设计门的 `persistent-native-page-cache-plan.md`，实现持续原生源版本观察、完整数值页存储和真实 Worker 接线。当前为源码候选：尚未通过本批实现门、准确提交的 GitHub Actions 或正式页面性能验收，不能据此宣称加载耗时达标、重启后缓存命中或整个 RFC 完成。

Runtime 用独立持续的只读连接观察原 OpenCode SQLite 文件。证明包含原物理 generation、connectionEpoch、revisionToken 与 parserVersion；只比较同一连接的实际 `PRAGMA data_version`。外部写入、同 ID 修改、删除、reparent、DDL、迟到 usage、原文件更换、缺失重建、关闭以及动态路径变化都必须失效。原 `HistoricalNativeUsageQuery`、同步 reader、root 独立读事务、分页、ACK 和 EOF 合同保持。

run-observability 的私有异步页源在原应用 snapshot 内按原 cursor 点查派生完整页；冷读仍通过原 reader 和原归属算法。数值页保留四桶、model、identity、位置、摘要链、issues 与完整 EOF，不缓存 conversation/tool 正文。新增两个 provider-neutral 表仅为可重建派生页：SQLite 原生成迁移为 `0244_rfc371_native_fact_pages`，PostgreSQL 原追加为 `0020_rfc371_native_fact_pages`。原 schema contract 的 source/active 为 241/235，六张 archived 表保持。没有修改历史迁移或既有价格、accepted usage 和停止证据。

Worker 返回前关闭原 native reader 并封闭独立有界 spool。平台等待原 snapshot/reservation 释放后才用原应用 writer 导入；每个根在同一真实事务中校验并发布全部页与 sealed header。使用过缓存时，构建及导入后再核对持续证明；缓存损坏或源更新丢弃未发布报告并在新原应用 snapshot 中完整无缓存重建一次。这里的两次构建预算限制重试，不限制任何任务、调用、根或原记录人口。stop/drain 后关闭观察连接，resume 使用新 epoch。

新用例实际构造 OpenCode/WAL 文件并执行原 reader 的全部页面，不用假的版本 counter。两个真实 AW provider 分别覆盖冷热完整页对拍、深子会话、多传输包、大整数、零值、缺 model/时间、五类坏缓存、未 ACK 最终页、根回滚、实际 spool 包损坏、取消导入以及外部更新。真实 Worker 用例逐页遍历全部 25 个输出 section，核对原四桶与冻结人民币费用；只规范原 report namespace 和 application snapshot receipt ID 两个明确的临时字段。PostgreSQL fixture 的真实 poolMax=1 在缓存页实际 SELECT 时提交原 SQLite 更新，验完整新 snapshot 回退；SQLite 分支在其原 Worker 读入口前提交更新。生命周期用例验新 epoch 冷建立和随后热复用，不把两个 provider 的边界混称同一个在途时刻。

测试源码账本只新增两处实际 `new Database` 调用点：原 OpenCode fixture 一处、持续版本观察用例一处，均沿用原 `real-file-database` 分类。所有旧条目、规则、断言与预算保持，派生存储和 Worker 行为仍走两个真实 AW provider。本机只做本批文件的格式、零警告 lint 和纯语法解析；不执行 AW 测试、typecheck、build、E2E 或已停止的 observability-scale。用例运行证据由准确提交的托管 CI 补齐。

两个 CLI 共享装配文件中的 writer/closeBuild 接线须完整保留并行 RFC-370 Task 输出及它的依赖，不单独发布不完整共享根。第一批之外的贡献级增量汇总、旧 epoch 回收、重启后内容证明、完整尺度/首屏 P95、CS 原 B 收尾与配额恢复等仍单独验收。固定原范围的 137 任务与 2,630,923 Token、四桶 1,189,241/1,255,680/0/186,002、已知人民币 ¥4.078952 是后续实测 oracle，当前源码检查不是该 oracle 已通过的证据。

## 2026-10-12 原正式 API 的首次与再次计算

使用原本机服务、已批准身份和固定 `from=1790990013929`、`to=1791594813929`、`Asia/Shanghai`，调用原完整报告 API。新首次报告 `8736b07a-1930-4165-9d60-b864128e1b40` 和再次报告 `2ef5e452-c8f1-4d5d-ac34-dfee168bf8b6` 均逐集合分页至真实 EOF；65 次分页覆盖原所有报告集合、维度任务和质量任务。两次的全部 summary、counts 与所有完整集合逐字段等于原 `fe75f22b-5b89-49e4-b225-87df2e3e9284`，没有不同集合。四桶、人民币估值和原缺口保持。费用沿用明确标记的验收费率，不代表供应商账单。

请求到观察到完整事实分别为 16,310.603 / 10,983.252 ms（客户端状态轮询间隔一秒）；原记录为 13,960.633 ms。原日志确认首次 `sourceRoots=2315/sourcePages=1849/cachedRoots=0`，再次 `cachedRoots=1834/cachedPages=1849/sourceRoots=481/sourcePages=0`。再次的原生采集阶段 963.86 ms；任务明细构造 1163.14 ms、历史归属 2114.87 ms，整体仍未达到首屏或 warm P95 目标。481 个原读取失败或不存在的根继续原缺口处理，没有伪造空根来提高命中率。

本次是未发布候选的实际产品 API 核对，不是本机测试、缓存候选的 hosted CI 或完整性能验收。不同范围、源更新、新进程冷建立、多次 P50/P95、同规模和完整增量贡献继续；原观测 CI 元数据修正提交 `77033f619e9c6839c6de9f23e791ed81ae99a577` 的主 CI 38159007086 已确切 72/72 成功，该结果不代签尚未提交的缓存源码。

首轮源码检视发现验收 fixture 把不存在的 `missing` 根当作空根，原读取器实际报 `Native root unavailable`。后继用真实 `empty` 会话和原 NULL 创建时间覆盖空根，冷热 reader 与持久 header 均保留 NULL；另保留真正缺失根的失败回归，验证不发布任何伪造派生页。原冻结首轮和失败结论保留，后继仍须独立有限检视。
