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

## 保留历史未受理调用的真实不完整状态

后继 `1752f02e868ff58ea443ed89efc1af0bb9381075` 的完整 Windows run `38178251326`、job `114585119210` 原始结果为 1393 pass、3 skip、9 fail；本片七项 Worker 用例现在实际到达公共 page 查询，暴露了 `not-ready` 状态下请求未封存数值集合的问题。原生 provider 用例通过。原始失败保留，没有本机重复执行 AW 用例。

这份夹具故意保留没有原始 invocation 受理记录的历史调用，以及无 model/time 的原记录。原报告必须保留已记录四桶和已知人民币部分估值并标记不完整，不能为测试把它改成完整报告。完整比较助手仍独立读取所有物理行与声明数量，枚举所有实际封存 section/parent，以两行公共页到真实 EOF；只有该原状态未封存的五种完整数值集合不被伪造为空页，逐项断言 header、counts、物理集合均缺省且公共接口明确拒绝。所有封存集合、质量原因、Task/attempt/dimension parent、重启、损坏、晚到写、冷/热与原无缓存 oracle 的逐行比较保持。

另增加原无缓存 Worker 的独立精确预言：input=`9007199254741028`、cacheRead=`88`、cacheWrite=`109`、output=`71`、总 Token=`9007199254741296`；output 包含原 7 次 `5 + 2 reasoning`、无 model/time 的 1 及两次已受理调用的 21。原受理费率提供的已知部分估值为人民币 `0.00015`，11 条成本记录只有原 2 条已定价，历史未知金额保持未知。数值超过 JS 安全整数仍逐字符串核对。生产封存、公共页拒绝、原夹具内容、七项案例与原预算均保持；仍待本片 SOURCE 门和后继准确 SHA 的完整 CI。

## 完整主 CI 的分页类型修复

同一 `1752f02e` 的主 CI run `38178251313` 已终态 failure；Lint job `114585119391` 的实际 backend typecheck 报告两处 `TS7022`、一处 `TS2554` 和一处 `TS2769`。原生事实根分页返回值补上原 `ReportWorkingPage<HistoricalNativeFactRoot>` 类型，原 fixture 的原生页补上原 `HistoricalNativeObservationPage` 类型；这两处只有类型标注，分页、确认、EOF、关闭和 emitted JavaScript 保持。Worker 的物理行查询使用两种 Provider 共有的零参数 `select()`，仍读取每条原物理行并核对原 section/parent 数量；封闭 section 在原合法集合验证后使用同一 `CompleteObservationSection` 类型。没有改为较小范围或跳过断言。

前两文件 v360 的有限 SOURCE 已通过并由根完整消费，不能代签这些后续类型修订。四文件修订另做有限 SOURCE，随后与原 Task 所有者串行发布；只做限定格式、lint 和纯源码保持检查，完整类型检查和用例仍以修复 SHA 的 GitHub Actions 为准。原完整主 CI 的 64 success／8 failure 及完整 Windows 的原失败均保留，仍不声明整体绿色或性能目标达成。
