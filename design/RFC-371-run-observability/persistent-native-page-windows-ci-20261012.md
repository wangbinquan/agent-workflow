# RFC-371 原生页缓存的 Windows CI 修复（2026-10-12）

状态：保留原始失败，修复本批测试夹具；尚未由后继 GitHub CI 签通过。缓存生产实现、原生数值解析、完整报告断言、用例时间预算均不改变。

原始被测提交为 `ca6f8417e3c4903966e72d21f89264b7756b6586`，源码提交为 `4037254b5865adeacfcbaae4789f83eab682c1ae`。Windows run `38171413874`、job `114564630142` 的本片失败为 provider 1 项、Worker 7 项。其他 Task 夹具和迁移快照格式失败由各自原所有者处理；不把部分修复签为整条 CI 通过。

## 完整数据夹具应明确提供 reasoning

`opencodeUsagePass.ts` 的原解析要求 output 和 reasoning 均有有效计数才可求输出桶；缺 reasoning 时输出必须保留 unknown。`rfc371PersistentNativeFactFixture.ts` 的 zero、no-model-or-time、outside 三个原记录没有提供 reasoning，而既有精确断言分别要求输出为 0、1、1。冷页与无缓存原页已完全相等，额外完整性断言正确暴露了夹具并不完整。

只给这三条明确用来验证完整输出的夹具记录提供实际 `reasoning: 0`，其余原计数、83 个原 step、84 个原 session、模型和时间缺口均保持。既有 Token、人民币、原页面、EOF、深度、记录数和全部报告 section 等价断言不降低。另增加真正缺 reasoning 的记录，要求无缓存、冷缓存与实际禁止原始重新打开的热缓存均保留 output=null 及 `native-token-bucket-unknown`；不能通过生产补零来修用例。

## 关闭后的 Windows SQLite 文件释放

七项 Worker 失败都落在 `rfc371OriginalWorkerFixture.ts` 的 `db.$client.close()` 后 `rmSync(appHome)`，实际错误为 EBUSY。这发生在测试夹具收尾，仍可能掩盖更早的断言异常，因此后继 CI 必须真正运行原七项断言后才能签通过。

平台原 Windows 数据库交换边界 `platform/persistence/sqlite/systemProviderRestore.ts` 已明确在 close 后、删除文件前调用 `Bun.gc(true)`，使刚关闭的 bun:sqlite 物理句柄完成 finalization。本片只在本测试夹具的 SQLite 正常关闭和建库异常关闭两处复用相同的 win32 收尾方式；没有删除业务资源、改变产品停止协议、添加测试重试或放宽时间预算。真实 Worker 的原 stop/drain、观察器关闭和原数据库关闭仍先执行。

本机只执行限定 lint/format，原失败日志保留。本片还要经过有限源码功能检视与精确路径提交，最终以同一后继实际 SHA 的主 CI、完整 Windows CI 和原报告回归结果决定。暖报告约 11 秒的性能缺口仍未解决，不能把本片 CI 夹具修复当作性能目标通过。

## 主 CI 的全部实际集合与迁移头配套

同一提交的 Ubuntu backend shard 28（job `114564631254`）再次报告上述完整夹具漏 reasoning；backend shard 29（job `114564631372`）的 SQLite 与 PostgreSQL 七项 Worker 回归都在全局读取 `quality-tasks` 时提前抛出 `Original quality reason is required`。Windows 的 EBUSY 收尾曾覆盖这一较早异常。原生产协议明确要求数据质量明细按原原因 parent 读取，该拒绝判据保持。

Worker 完整比较助手改为从实际已封存 `observation_report_counts` 枚举全部 section/parent 集合，独立遍历原 `observation_report_rows` 校验每集合数量，再以原公共接口的小页分页到实际 EOF；全局空集合也继续读取。原无 parent 的质量明细请求另断言必须拒绝，所有原因、Task、attempt、dimension 父集合也进入冷/热/无缓存及重启/损坏/晚到写比较。只规范原报告命名空间和原 snapshot receipt ID，保留其他数值、缺口、模型、归属和每行内容。原七项案例、全部已有 matcher 和 60 秒预算不降低。

macOS backend shard 7（job `114564631265`）的旧升级用例仍要求 journal head 243，而已发布的 `0244` 增加了原生事实根与分页表。将其标题与精确断言同时改为 244，历史冻结升级目标、toy task 和迁移 `when` 严格递增判据保持。Ubuntu backend shard 27（job `114564631384`）指出公开的 `HistoricalNativeVersionObserver` 没有显式外部消费者；原平台装配已经创建并实际调用其 sample/close 生命周期，本片用同一公开 participants 类型标注实际 observer，消除隐式推断，不新增绕过或未消费例外。原工厂、实际方法调用、失效重建和关闭协议保持。

其他 Task 夹具、旧 caller 源码预言和 `0244_snapshot.json` 格式由原所有者保留并修复。共享原架构配套与发布只在本片有限 SOURCE 检视通过后协调，任何部分绿色、旧 SHA 结果或源码检视均不代签后继全 CI。
