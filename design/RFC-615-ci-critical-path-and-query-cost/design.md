# RFC-615 技术设计

## 1. 所有权与架构

历史行桥优化属于platform/persistence的纯机制；G1 SQL属于task-execution/infrastructure既有查询实现。均不新增跨context依赖、composition实现或模块级持久缓存，符合RFC-294。测试产物缓存仅在tests/helpers，CI排队及来源解析在.github/workflows和scripts/ci。本RFC不改变生产迁移协议或历史工件。

## 2. 历史行桥

提取appendLogicalTablesPayload保留新增表、KEEP、位置、计数等所有校验；正常迁移appendLogicalTables仍计算原digest，epoch-2行桥只比较payload，去掉随后立刻被丢弃的中间hash。每次同步桥解析创建fresh canonical fragment scope，并以局部WeakMap复用合同/去索引表投影。结束或抛错恢复外层scope；不信任输入digest、不跨调用复用，不跳过任何edge或终点/archive合同核验。

回归覆盖相同对象/相同digest在两次调用之间原地变更列、codec、rationale、edge、disposition、顺序和计数，外层旧cache不能污染解析；既有epoch1工件hash/byte-identical canonical/旧桥拒绝边界保持。原13次解析仍在一个5秒用例中。

## 3. G1查询与证据

将root_prefix_lookup中同一task的两次相关标量查询改为physical_prefix与matches的唯一键单次JOIN，physical_prefix只投影id/startedAt。matches仍不整体物化，prefix/fallback、祖先上下文、descendant/child counts、facets、cursor和受限actor准入条件保持。

原rfc311性能门仍测现有未主动维护语料，保留200/500规模、全部provider/路径、9样本、50倍/250ms阈值与180秒预算。不能仅先VACUUM让原有冷态不再受检。新增计划/等价用例覆盖冷态与显式VACUUM ANALYZE后、custom/generic模式；SQLite也必须通过原语义/计划守卫。

G1打印按运行顺序的原始样本。异常诊断在PG fixture清理前采集真实SQL/参数及可取得的EXPLAIN(ANALYZE,BUFFERS,SETTINGS,FORMAT JSON)、版本/计划设置/统计信息。跨provider比较可能在SQLite后跑时才发生，因此PG侧必须提前保存异常证据；诊断受原case剩余预算约束，失败只记录，不能覆盖或改变性能断言。未知hosted机制保持未知，不将JIT/统计信息写成已确诊原因。

## 4. 测试准备缓存

CI backend每个job在RUNNER_TEMP下拥有自己的AW_TEST_FIXTURE_CACHE_DIR，由step写入GITHUB_ENV（runner上下文不用于job.env）。不跨job/run持久化；普通本地未设环境继续原冷路径。

共享小型缓存原语按完整输入key检查manifest/产物大小/摘要，以原子锁竞争，同文件系统唯一staging完整构建并校验，最后rename发布目录。等待有界、异常清理仅操作自己的token/staging；不按mtime偷锁，失败/取消不发布有效entry。每case使用copy而非hard link。记录hit/miss、构建/复制耗时。

compiled mock保持原来每case真实`bun build --compile`路径。本轮验证过缓存候选后撤回：完整热helper调用约225.65ms且增加模块加载，旧编译片段一次诊断约114.31ms，没有足够的净收益证据。样本环境key不完全相同，不能作为精确因果差值或hosted预测；因此不将该缓存接线、额外TypeScript依赖或输入hash/copy成本带入CI，也不降低校验强度换取命中速度。原测试编译覆盖保留。

RFC398 SQLite：每次仍loadFrozenEpoch1History校验provenance；key包括已验证SQL/journal顺序及内容、构造/compatibility实现、Bun/SQLite版本与source_id/编译选项、PRAGMA和格式版本。模板经真实冻结迁移构建、checkpoint并关闭；完整保留迁移种子（含一次构建产生的随机revision）。case复制后才加blocked行、config/hooks并运行真实start/auto/SIGKILL/恢复。副本后续写入隔离；不缓存PG真实基线、release逐迁移效果检查或生产catalog编译。

## 5. 计算队列与required门

将原69个工作作业原样放入ci-work.yml（仅workflow_call），ci.yml保留push/PR/dispatch入口和原CI名称。父workflow的full-ci调用作业使用原ref/run_number奇偶两lane、queue:max、cancel-in-progress:false；子workflow不重复加同组concurrency。相对uses从同一commit读取子workflow，GITHUB_SHA/run_id/artifacts均属于原运行。计算调用结束即释放lane。

子workflow逐项以`fromJSON(toJSON(jobs['id'])).result`输出原13组结果，不增加runner汇总作业。JSON往返保留原值，避开[runner #2495](https://github.com/actions/runner/issues/2495)报告的直接result空输出问题；也兼容[actionlint #343](https://github.com/rhysd/actionlint/issues/343)尚未补齐的类型定义，不新增lint忽略。拓扑守卫逐项固定表达式。父CI required仍always执行，先验证full-ci调用result，再逐项要求原13组output为success；空值/failure/cancelled/skipped一律失败。它在计算concurrency之外，使用适合纯Bash的ubuntu-slim，仍为5分钟预算。ubuntu-slim共享账号并发模型，不将其宣称为独立预留容量。

门禁工作数、测试命令、原矩阵/预算/coverage/provider/grep不变；只有计算分组发生移动。计时刷新脚本从来源SHA解析父+同commit子workflow，兼容RFC611旧单文件来源，未知拓扑拒绝。所有读取ci.yml工作作业的既有守卫迁为读取计算定义，新增完整父子接线守卫；required唯一名字保持，分支保护不改。

依据：[可复用workflow支持job concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)、[jobs.result及workflow outputs](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#jobs-context)、[同commit相对调用](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)、[ubuntu-slim限制](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#single-cpu-runners)。

## 6. 验证与发布

先完成全部生产/CI/夹具实现和测试，再集中运行相关纯函数/真实SQLite+PG/原始编译升级流程/跨进程竞争用例、静态检查、actionlint和独立复核。不启动重复全量本地gate。原69工作作业与required判定做正负拓扑验证；hosted真实回归确认相对workflow输出、完整测试集合、失败聚合、artifact来源与队列释放。每个候选只做必要验证，后续无关HEAD变化复用证据。
