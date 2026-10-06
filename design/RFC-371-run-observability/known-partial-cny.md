# 已知的部分人民币估值仍需显示

此修复属于已批准的 AW RFC-371、CS RFC-034，用于落实用户“已有数据仍显示，只标记不完整”的要求。原正式完整报告已显示采集缺口下的完整已定价记录，但仍丢弃一条记录内部已算出的 partial 人民币金额：AW allocation 先过滤 completeness，两个 fold 再只累计 complete。缺失部分桶或部分费率时，用户仍看不到这条记录实际已有的人民币估值。

## 同一个账本与精确资格

继续使用原 usage ledger、原 allocation、accepted price、模型、费率版本、usageRevision 和 CNY pico 整数。不给未观测桶补零，不按总量比例折算，不造供应商账单，不创建另一份金额表。普通定价和原 complete 统计的数值不变。

AW local allocation 使用当前分配 contribution 在原 value 入口算出的 priced known amount，包括 completeness=partial；它已按原受理价重新计算分配。AW platform 和 CS 只在全部 allocation contribution 等于原 contribution、valuation usageRevision 相同且 availability=priced 时保留原金额。不能将平台整条估值分摊到被父节点覆盖后的部分 allocation。歧义或 unavailable coverage 不分配任何金额。原费用显示状态继续由现有同一范围规则决定。

full cost 必须有四桶已知且估值 complete。partial cost 保留实际已算出的金额，但完整估值仍不成立；至少有一个真实已知 Token 桶才形成部分金额的记录资格，全部桶未知不能由 amount=0 变成已定价证据。真实已知零桶且金额零必须显示 ¥0（不完整）。

## 不把部分记录冒充完整已定价记录

保留 pricedRecords 的现有完整记录意义。新增可选 partiallyPricedRecords 十进制字符串，不重复统计一条记录；fully priced + partially priced <= 原 records。没有 partial 的旧格式、旧 immutable report 和精确深相等断言保留原形，输出不额外加入零字段。新 fold 内部用 BigInt 累计，并把两类实际金额只加一次。

recordedCost 与 costCoverage 对相同 records / pricedRecords / partiallyPricedRecords 保持一致。partial 非零时 recordedCost 可以在 pricedRecords=0 下存在，但 cost 总计保持 null、state 保持 unpriced 或 not-ready。Token 四桶和覆盖分母保持原人口；AW 已有“完整定价记录不得超过任一已知桶记录”的资格约束仍保留。partial <= records - priced，且已知桶人口至少能提供 full 的四桶加每个 partial 的一个真实已知桶。恢复 fold、任务/Agent/运行时/项目/模型/趋势合并均保留两类金额与记录数。

## 缓存与页面

只推进现有请求缓存能力键：AW scope-metrics/7 → /8，CS executionFactsVersion 3 → 4。数据 generation、sourceRevision、公开 projectionVersion 和旧报告不改写。相同来源修订的新请求生成新报告，原报告仍按原 id 返回原 immutable 内容。

复用原人民币卡片和金额组件。partial 非零时，覆盖说明同时显示“完整估值 N 条、部分估值 M 条，共 R 条”，金额显示已记录／不完整。原 zh/en 同步；不添加新卡片，不恢复更多筛选、CSV 或关注任务。页面与 API 都显示 CNY。

## 实现落位与验收

原有 run-observability / observability bounded context：application 原 allocation 资格，domain 原 fold / fold restore / 原事实资格，shared/contracts 追加可选字段，原 report service 推进已有 cache key，原 UI 与词条增加两种记录说明。无新增跨上下文内部依赖或临时 facade。

保留全部旧完整、缺口、金额不可显示、陈旧修订、歧义、partial allocation、真实零、旧缓存不可变和大整数断言。将“partial valuation 仅丢弃其金额”的旧断言拆成独立旧无估值／陈旧路径与新的已知部分金额回归，而完整总价继续为 null 的原断言保持。新增真实 SQLite / PostgreSQL 报告与 cache 回归：输入已知、缓存／输出未知的原记录沿用原受理价得到金额；单条 partial、混合 complete+partial+unpriced、任务/维度/趋势、EOF 续页、restart / replay 不重复、原公开报告不可变、缺口状态与分母一致。AW 仅 GitHub exact-SHA CI 执行测试；CS 专用非生产 PG 定向与最终同一候选一次完整门。正式本机页面核对金额、四桶、记录说明和窄屏布局，CS 只部署经过 exact-SHA CI 的已提交代码。

本文件为功能设计，尚未宣称实现、测试或发布完成；N3 正在运行的 CS 完整候选保持不变，CS 实现后续再接续。

## AW 实现与检查记录（2026-10-06）

AW 已按本设计接入原 allocation、fold／restore、事实资格与已有人民币组件。新 optional partial 计数只有非零时输出；原 complete 资格、四桶、原价格与金额、未知与不可显示状态保持。服务和实际前端报告 hook 的能力键同时为 scope-metrics/8；旧报告 id、原 projectionVersion=2 与来源修订不改写。

独立设计门有效 PASS；实现 SOURCE22-v3 也为有效 PASS，P1／P2 均为零，22 项实际 EOF 首末指纹稳定。v1／v2 在必要源定义和客户端缓存补齐前没有终态 PASS；公共维度页签回归已按原 runtimes／agents 两个实际 section 分别遍历 EOF。新增双 provider 的 137 条真实 partial 数据验证任务、趋势、维度、重建和新缓存能力；输入 9,453、已记录估值 ¥0.009453、完整估值 0 条、部分估值 137 条，同时保留原缺口状态。这里描述的是已提交候选的回归断言，尚不冒称 hosted 测试已经执行成功。

自有 TypeScript／TSX 的 format 和 lint 已通过。遵照仓库约束没有运行 AW 本机测试、类型检查或构建；最终功能执行以本片新 exact-SHA GitHub CI 为准。旧 21bc CI 的功能架构失败仍保留，相关并行修复由原任务负责，未收编其在制文件。CS 同设计实现、自动刷新修复、原生消费接线、正式页面与规模验收仍继续；两个 RFC 不标记完成。
