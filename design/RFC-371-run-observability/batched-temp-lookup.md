# RFC-371 原 TEMP 完整选择的批量读取

本片接续已批准的完整统计与规模验收。AW 原完整选择仍对每个冷 group/session 的 ancestry、每个四桶/session/model 分区的 coverage root 单独读原连接。CS 真实 TEMP 1201 独立 self-total 回归已证明去除同类点读可保持每条 allocation EOF；这只是实际源文和相关回归依据，不把它当成 AW 原 100000/10000000 已通过的证据。保留原失败与原规模判据。

## 平台与模块范围

在原 platform/persistence/reportWorkspace.ts 的 ReportWorkspace 及 run-observability/ports/completeWorkingRows.ts 增加必需的 getMany<T>(namespace, keys): Promise<ReadonlyMap<string,T>>。唯一 privateReportWorkspace 用原 statements.all、同一原 snapshot connection、同一 aw_report_workspace TEMP 关系完成 namespace 与确切 key 的参数化 IN 查询。SQLite 与 PG 继续通过原中立 statements 桥接，不新增方言分支、第二数值账本、迁移或另一连接。最多500个参数只是单次数据包；调用者持续拆包直到所有实际 key 读取完成，绝不是 Task、调用、祖先或总记录的统计截止。

空 key 包返回空 Map；非法/空 key、超过单包边界、原连接关闭、取消、查询或 JSON 失败仍明确失败。每个返回 key 必须属于请求包，重复物理返回不能被 Map 静默覆盖。真实没有该 key 才表示缺失；不能据一个空包推断整张关系为空。原单点 get、页面游标与写入语义不变。所有原类型化内存工作区 fixture 只补同样真实 Map 查询方法，原测试正文、人口及预算保持。

模块范围仅原 completeUsageWorkspace、completeCoverageWorkspace、原 key/分组纯 helper 与必要的小批 iterator、相应真实回归及两接口/唯一原语。原 compareCompleteUsage、coveragePrefixMaximum/AVL、native scope 资格、实际来源/path producer、report builder/发布、四桶和 CNY 不改变。

## 原 ancestry 与 native stream

提取原 groupOf/modelPartition/modelAnyProvider/treeKey 的相同 JSON 字节到本模块纯 domain helper，原排序和选择调用相同 helper。原 bind 保存的 native depth/pathDigest/parentSession 以及 legacy 递推 sha256 digest 字节必须逐字保持；不改成 CS 的祖先数组存储，不造新的路径身份。

原 retainedInput 保持 ordinal、count、cursor 与真实 EOF 核对。records 在有界100条原输入批 yield 前，仅对 legacy scope 的完整路径逐 key 预取，分包500；无 scope 的记录原样通过。不能跳过后续祖先或丢弃最后一批。

原 nativePath 仍直接消费 nativeScopes.path 的完整严格来源。仅在首轮 ancestry 验证阶段，使用有界500个原 link 的 iterator 包，在这些原 link yield 前查询同 group/session 的 ancestry；后续原 bindNativeAncestry 逐 link 比较并写原 digest，原 seen==depth+1 验证保持。开始 orderedRecords 后停止 ancestry 预取，coverage 对 nativePath 的原读取保持原样，不能在每个 bucket 为 ancestry 再读一遍来源。这个内部阶段只控制只读预取，绝不改变资格、EOF或是否执行原 bind。native path 全程不得整体 Array.from、spread、截断、定深度或补不存在的link。

ancestry cache保持4096、pending保持500，优先实际 pending 与cache，Map.has区分已证明不存在和未缓存。冷点读与每次批读都记录本地写身份，并在await后重查pending/cache；如果期间有写且已flush/淘汰，重读原关系，不允许旧缺失覆盖新路径。写身份只在该 private workspace 内用于缓存一致性，不是统计或持久数值。flush顺序、跨批祖先冲突、完整 input 第一遍在任何 allocation 前失败的行为保持。

## 原 coverage 与排序

排序输入继续使用原 raw retainedInput，不为排序重复预取ancestry。orderedRecords 的原外部 localeCompare 排序与终归并在有界100条 yield前，可预取它们将读取的root；输出顺序和原 merge 再检查保持。

root key 枚举必须包括四桶、自己/全部祖先、cover/overlap模型分区和原 summary 写入分区；native会话从原完整nativePath异步流读取，不物化整条路径。原 markSummary/hasSummaries 的 request-only快捷路径保留：确切证明组内无summary时不额外访问coverage或native祖先；有summary时使用原实际key。summary查询仍走原关系与缓存，不把预取视为覆盖结论。

保持 coverage.root 的首次真实 empty EOF与首次point证明。已证整张roots为空且未setRoot时无需bulk；任何setRoot即时撤销empty证明。其余批读只填有界cache，验证原tree身份，真实缺失用原{tree,id:null}表示。cache/dirty写优先，批读或冷点读等待期间发生写时，旧返回不得覆盖本地或已经flush/evict的新root。原node读取、AVL、allocateId与500行写入flush保持。

每条record的四桶判定、即时rememberSummary/setRoot/save、未知桶与未知/已知 provider-model 分区仍由原完整选择执行。预取只是原连接读取合并；不能计算预聚合、第二计数、随机样本、结果小计或略过任何root/record。迭代取消、consumer提前停止和实际预取异常必须关闭原iterator并传播，不能声称到达EOF。

## 验收与发布

新增实际 SQLite/PG snapshot getMany 回归：同namespace确切key、空包、未知key、跨原500包、原写后读、关闭/取消、查询失败与同连接回滚。新增真实完整选择的1201同组独立self-total，按全部原identity bitmap、四桶及allocation EOF对账，测原getMany/point调用以证明生产路径接线。覆盖known/unknown provider/model、未知桶、同批后来的summary覆盖旧缺失、原summary shortcut、超过4096淘汰、深 legacy祖先与 native流超过500link、跨input批冲突、await期间写/flush/evict、排序/输入EOF错误、取消/失败关闭。

所有已有fixture只补新必需原语，不改原assertion、人群、skip、retry或5000/20000/60000/120000ms预算。原原生source/深度/完整路径回归保持；native流测试必须用实际来源或原真实严格source控制，不把它当legacy数组。

先有限独立DESIGN，再实现/有限SOURCE及一次原scoped census/META；已有Schema CI修复独立发布，不混入其冻结候选。AW本机不运行tests/typecheck/build/压测，真实执行在确切SHA hosted CI。仅生产修复发布后运行原full-report/self-total两项，固定100000Task/10000000usage、同组10000000self-total、240分钟、100读样本、P95<500ms、原独立EOF/bitmap、160M四桶Token及人民币500元，真实OS资源采样全部保持。任何未完成或失败不记通过。

本片不关闭默认producer、CS v2数字消费者/before-final/seal、CLI/算力自测、CS托管实际联动或两个RFC退出条件。独立门只审功能，不扩展其他工作。

## 原正式后台通道接线补充

DESIGN20-R1 有效有限 PASS 保留。实际 required 原语还必须穿过已有 completeWorkingScope 与 observationReportChannel 两个类型化转发层，不能只在直接 TEMP 回归可用。Task scope 的 getMany 仍执行原 check(namespace)，仅转发 original.getMany，释放后与跨原 scope 的行为同原 get。原 live namespace 集与 release／清理算法不变。

原 ObservationReportRequest 增加 get-many-working 的 namespace／确切 keys 数据包；原 observationReportChannel 用同一 request identity、pending／取消／关闭生命周期提交，原 observationReportWorkerHost 在已保留 snapshot.workspace 上分派 getMany，结果通过原 postMessage response 返回 Map。不是第二个存储、连接、worker、查询账本或可选降级。原 read／write／get／page／clear 与所有消息时序和失败边界保持。需要验证真实 worker 的 Map 传递、原 Task scope 后的完整选择实际使用新原语，并保留原报告与 snapshot 的所有断言和预算。

这四个机械转发／协议文件与对应原 scope／worker 回归是同一必需原语的接线范围。先只补验本节和这些原 control，不重复已审20份设计；生产实现仍等待这个补充设计门通过。
