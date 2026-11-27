# RFC-625 技术设计

## 1. 落位与合同

Windows身份适配器与daemon单实例机制留在platform/execution/local，不引入模块反向依赖；缓存仅在tests/helpers，继续复用testFixtureCache；权重继续使用既有scripts/ci/compose-backend-timings。符合RFC294的中立platform机制及测试边界，不申领生产架构迁移credit。

只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

## 2. Windows 进程身份

### 2.1 判据

不替换isProcessAlive的全局合同，不重复实现libuv已做的退出状态检查。新增Windows adapter用OpenProcess查询同一handle的GetProcessTimes创建FILETIME；精确64位值以字符串保存，不转为JS浮点数；自己取得的handle在所有分支关闭。结果区分known/live、dead和unknown，权限或FFI不可用不被解释为stale。

所有平台新锁首行仍为十进制PID，第二行统一为版本化owner记录及acquisition token；Windows加入可用的创建身份，POSIX原liveness判据保持。readPidFromLock的数字API继续兼容。读取只得到PID、元数据不完整或未知版本时按legacy/unknown处理。

acquire现有wx及有限stale回收流程保持：原owner进程已死照常回收；有完整创建身份且当前同PID身份明确不同也判为旧实例；同PID同身份、不同PID真实活owner、无法判定或legacy活PID均拒绝。不能仅因PID等于process.pid就回收。

release记录本次完整owner快照，只在当前内容仍属于它时释放。adopt只允许现有两种显式入口：watch respawn的当前进程，以及自动升级已写入/验证当前实例owner后的接管；不把自动升级误限为watch。两者都验证当前PID、拒绝已知创建身份不一致并保留legacy当前进程兼容；接管写入新的acquisition token后返回新lease，旧generation的晚到release不得删除新owner。自动升级手工写PID路径改用同一owner serializer，避免接管时丢元数据。核对stop/status等owner消费者，数字展示API保持，需行动的进程判定复用同一机制。文件比较再unlink并非原子CAS，不新增这种承诺。

### 2.2 回归与诊断

纯判定回归覆盖same/different birth、精确FILETIME、unknown/legacy/malformed、真实活owner、late release和watch/自动升级接管；包含acquire旧lease→adopt新lease→旧release仍保留新owner。真实Windows测试验证当前与子进程创建身份、已退出但handle仍保留的child、确定性的“当前PID配旧创建身份”反例，保留跨进程竞争和SIGKILL回收。新增native回归加入windows-platform现有显式测试清单，预算不变。

原E2E三case、原kill/restart顺序、锁回收生产路径、150秒预算及重试保持；补旧child PID/close、新spawn PID与锁owner快照诊断，遇到未知问题保留可归因证据。测试不得直接删锁、增加sleep或重试来换通过。原事故的PID复用归因只有出现直接证据后才能确认。

### 2.3 Hosted 架构守卫后的不可变绑定修正

81a78c2 的 backend2 捕获新增 `nativeApi` 顶层 `let` 未登记。RFC546 例外已达 28 条上限，本 RFC 不增加例外、不提高上限，也不改变扫描器。API 仅封装 kernel32 固定函数，不保存 PID、进程查询 handle 或业务状态，因此改为模块导入时一次调用 `createNativeApi()`，结果由 `const` 保存，非空适配器用 `Object.freeze` 冻结；不保留可重配的模块状态或将其隐藏进闭包。

非 Windows 仍在 `dlopen` 前返回 null，Windows FFI 初始化异常仍被捕获并得到 null；原首次加载失败也会永久缓存 null，因此没有移除既有重试能力。唯一初始化时序变化是 Windows kernel32 符号绑定从第一次身份查询提前到模块导入；不在导入时打开目标进程，全部查询 handle 和 FILETIME 缓冲区仍是调用局部值。显式 API 实参仍只影响当次调用，不能替换默认绑定。构建不新增依赖，启动成本未实测，不宣称提前初始化零成本。

原 15 项身份回归（其中 4 项 Windows native）保持，既有用例补非法 PID、非 Windows 默认 unknown，以及显式 null 后默认 native 身份不变的行为断言。集中复验原 RFC546 完整守卫、身份/锁相关用例；真实 Windows 与编译后启动仍由新候选的 hosted CI 验证。

## 3. Q3/V2 不可变 manifest 复用

保留所有原test文件及--isolate，复用已设置的AW_TEST_FIXTURE_CACHE_DIR，缓存只活在一个CI job临时目录，不上传Actions cache、不跨run持久化。现有sourceManifests模块Map继续只缓存不可变值；不缓存连接、数据库、provider runtime、reader、operationRoot或cleanup。

V1Harness在getManifest的原准备点接入test-only helper。每次准备先执行原loadFrozenEpoch1History完整admission；每次install继续原完整admission。cache关闭直接执行原loadSupportedSourceManifest，不附加序列化成本。冷miss使用原builder，SQLite完整prefix和PG真实版本/catalog构造保持；直接测试production compiler的套件不走此优化。

复用materializeTestFixture的输入key、原子发布、摘要验证、取消/失败清理和副本协议。key包括已核验的冻结历史/SQL顺序/contract/released catalog、provider、PG版本与影响catalog的配置、SQLite版本/source_id/编译选项、Bun version/revision/二进制摘要、OS/arch、实际compiler/反序列化实现输入。通过完整源码闭包摘要保守失效，覆盖未跟踪/修改文件，不仅依赖Git SHA或mtime；不允许fixture同key变内容仍命中。

具体key使用`rfc395-source-manifest`及`bun-jsc-v1`格式。历史身份包含chain/head digest、每version的plan/contract digest与sqliteThrough、SQLite tag/hash/folderMillis顺序摘要；两个released根的tag、contract、plan、sqlite-receipts、catalog与provenance取实际文件摘要。实现闭包保守枚举backend/src与shared/src全部实际文件、helper本身/testFixtureCache、bun.lock、相关package manifests及tsconfig.base/backend/shared三份实际解析配置，按相对路径/内容摘要有序聚合，包含未跟踪文件。Bun二进制/OS/arch和SQLite version/source_id/compile_options两provider都纳入；PG另纳入server_version_num/major、server_encoding、lc_collate、lc_ctype和完整有序pg_settings（仅排除随机application_name）。计算键前在同一保留连接执行no-op PL/pgSQL DO，先注册真实compiler需要的延迟模块配置；初始化也计入整体期限，避免首次compiler执行后新增设置造成无谓miss。源码闭包约31.7MB，完整hash/复制/反序列化都纳入实测，不能只报告裸命中；同一isolate可复用已求取环境身份Promise，每次install冻结校验仍执行。

SupportedSourceManifest包含大量共享contract/catalog引用，直接JSON会重复展开。采用Bun1.4.3已提供且保留对象引用的bun:jsc serialize/deserialize，序列化ABI由Bun身份及格式版本纳入key。产物只有plain数据；完整原始结果保留，禁止只缓存head或删历史项。每次materialize后反序列化为调用方独立对象图，临时副本始终清理；原缓存对象不接受case写入。校验格式、provider/chain/head身份与原始builder结果对应。所有alias、codecCorrections、journal、source ID/顺序及catalog保持。

原90秒beforeAll与40秒case预算保持；整个prepare从admission/key/hash之前开始共享90秒截止时间，materialize只取得剩余预算，不能使用通用helper默认120秒。截止后即使builder晚到也不能发布产物；cache关闭仍直接走原builder，不计算cache key或序列化。取消信号在构建阶段边界检查；不向production新增测试缓存分支。集中验证保存cold/warm/off端到端时间、artifact体积及build调用数，若完整热调用没有净收益则撤回接线，不以只测deserialize替代完整成本。

回归包括：原生SQLite/PG完整结果对等、共享引用保留但不同materialize对象独立、cache hit不跳admission、history/provider/PGmajor/生成器/Bun身份变化失效、损坏与失败/取消处理、真正跨isolate缓存命中；原生成器测试与每例DB行/DDL隔离继续。case数量/身份及11阶段×双provider×前后×switch/restore=88case保持。

## 4. 44片权重

初次发布使用既有严格source加载器验证790/45925598806、9cb/45933650528、240/45939395356完整44份原始计时和全绿attempt，按文件取实测max，不对任一值扣除预计缓存收益。790的3128文件与后两轮3130文件通过真实新增来源闭合；新增回归当时无历史数据，明确列为unmeasured并保留原生fallback。

初次三源模型对3130原路径的max包络708.067秒，另加历史最大测试外差额63.562秒约771.629秒；20%敏感性为913.242秒，不能承诺900秒内必过。模型只辅助选择，最终用完整CI实测。保留44片、15分钟、随机顺序、文件隔离、后端LCOV采集与原CodeCov上传配置、PostgreSQL job和13项required，不修改collector准入标准、不使用红run部分数据拼权重。

3aa7b03 / 45966117958 完整69/69成功后，取得全部44份原始计时，追加一次有界数据刷新：来源改为9cb/45933650528、240/45939395356、3aa/45966117958，仍逐文件取真实max；覆盖目标689be5398的3134文件，无unmeasured或removed。四个先前缺测文件各只有3aa一个有效绿色样本，不能描述为三次观测上界。正式CLI产物与独立预览逐字节相同，发布为5f46ad9；未修改分片算法、测试或workflow。

同一3134文件成本向量下，新分配的最长片由715.131降至697.056秒；用3aa实际成本反事实重分配为710.069降至697.056秒。新尾片35包含18文件，其中六个resume文件共622.712秒，不是一个不可拆分的697秒文件。132个来源job的最大已观测额外耗时为64.197秒；叠加后761.253秒距原900秒预算余138.747秒，只是描述性模型余量，不是未来上界。全局预测收益仅13–18秒。5f46ad9完整CI实际失败，立即后继033f5fa在保留本任务29份内容后69/69成功；其尾部相对3aa没有继续改善。模型、全部负结果与实际对照见[验收记录](./acceptance.md)，不能把后继通过视为5f超时根因已修复。

## 5. 集中验证与验收来源

完整实现/回归先写齐，随后独立功能实现门和定向集中验证。Windows native结果由现有Windows平台workflow提供，真实三平台E2E由完整主CI提供；本机无Windows不能冒充验证。使用主树，不运行重复完整本地gate，不因无关HEAD前进取消/重复候选验证。

性能主对照固定240完整CI，790/9cb作为背景来源；530红run只记录失败，不能冒充完整基线。比较原Q3/V2同文件池、新回归成本、全部backend文件、job P95/max、case retry、runner分钟、队列与总墙钟，准确区分原始观测与排程估计。hosted失败先看step/log与候选diff归因，保持原门禁。
