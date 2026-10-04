# 各原任务范围中的已收到分类 Token

用户已明确要求：有用量缺口仍显示实际收到的数据并标记不完整，任务、Agent、算力及其贡献不能只保留人民币却丢掉分类 Token。本修复接续已发布的总览、分类趋势、人民币与执行泳道修复，使用同一原始 Task cohort、全来源 EOF、原贡献选择和原 fold；没有额外账本或任何总量上限。

## 当前断点

`domain/completeObservationMetrics.ts` 原 allocation 已保存分类和，但有 gaps 时只输出未知状态与实际人民币。`domain/completeMetricsFold.ts` 从这种状态重建 Agent／运行时／贡献的 fold 时又丢掉原调用、记录和分类值。`CompleteObservationMetrics.tsx` 的已收到 Token 参数只从总览／趋势传入，普通 Task、attempt 与 Agent 明细没有这份数据。修复需要在原 metrics 中携带自己范围的已收到证据，不能用总览的数据填子范围。

## 同一原 fold 与资格

原 fold 增加四桶确切已知记录数；原 add／merge 每条选定贡献只计一次。新增 optional `recordedUsage` 只在 not-ready 且至少一桶有真实已知记录时存在，包含原 invocations／observedInvocations／records、四桶 string 或 null、四桶 bucketRecords 和已知分类和 total。某桶没有任何已知原记录时保持 null；已知真实零仍为零。所有计数／分类和保持 BigInt 十进制字符串。完整 ready 的原字段和原完整资格保持，not-ready 仍不产生完整 tokens／cost。

新 not-ready metrics 另携带独立 `tokenCoverage`，只包含同一原 fold 的 invocations／observedInvocations／records 与四桶 bucketRecords，不包含 Token 值或金额。即使没有任何已知桶、没有 usage 或全部歧义排除，也保留真实原调用／已观测调用／记录人口；recordedUsage 若存在，其人口与桶覆盖必须逐项等于 tokenCoverage。已知调用加无 usage 调用在父 Agent／运行时／贡献 merge 后必须为原 1/2，不得因为后者没有 received 值变成 1/1。旧无这个字段的不可变 not-ready 没有新增人口证明，往返保持原字段与未知语义；不能从费用人口或默认空 fold 虚构已核对的 Token 人口。新投影一律由原 accepted invocation 产生这份覆盖，父维度必须完整恢复后再 merge。

原选择的 ambiguous／unavailable 贡献不能成为可信数字。在同一个原 ordered-record pass 增加可选、await 的原记录质量回调，携带实际 record、quality 与 allocated：全部桶被部分重叠排除的原记录仍给原 invocation 标记 coverage-incomplete；通过既有 invocationFor 校验其归属，不能只给总体标缺口。未 allocated 的这种原记录只计一条未知人口，不贡献分类、桶记录数或金额；已 allocated 的歧义记录仍只计一次人口，原 add 传明确 qualified=false。正常被完整覆盖的 excluded 记录不增加人口、不重复计数。原选择返回的 selected／excluded／EOF／摘要保持。原 allocation 可携带 optional qualified 字段供原模型选择与模型贡献使用，旧没有这个字段的不可变 allocation 保持旧兼容语义。

仅 allocated=false 的原质量记录还在同一 awaited 回调中写入原 Task working rows 的专用临时质量 namespace，携带已校验的原 invocation、原 record/source identity、真实 localModel 或 measurement.model、quality 与原 visible 状态，不携带假定贡献或金额。这是原中间投影，不是新的来源账本。其精确行数由该同一 pass 记录，Task build 同时携带原 selected allocation 行数和这份未分配质量行数；raw originalNumericRecords 与原 source receipt 不改，正常 fully-covered excluded 不进入质量 namespace。后续 selectCompleteObservationTask 分别消费原 allocations 和这些质量行至 EOF，分别对拍原 selected 行数及原质量行数；不能误把 raw 行数当 selected 行数。模型筛选对质量行用原 modelDimensionMatch，匹配或未决时仅保留原人口和 gap、不加桶值／费用。ReportDimensions 也消费同一原质量 namespace，沿同一模型／Task membership 与 invocation 去重键加入这份未知人口，不能重复增加已有 invocation。非模型维度已经从原 invocation fold 取得质量人口，不再加一次。同一真实 model 的两条部分重叠 summary，第二条四桶全排除后，在 Task、该 model 筛选和该 model 贡献中都必须为 records=2、每桶 knownRecords=1；全部遍历与精确人口验证保持，没有全量数组。

原 fold 重建先从新 tokenCoverage 恢复原调用、记录与桶覆盖，再从存在的 received 恢复实际 nullable 四桶，不用不完整总值恢复为完整。ready fold 的每桶原记录数可从同一 ready records 恢复。旧不带新覆盖的 not-ready 仍保持未知；旧不可变摘要／趋势中的独立 recordedUsage 继续严格按原形状读取，不重写旧 reportId。新 metrics 的 received 用同一 fold 输出，总览／趋势旧兼容字段只在原记录均有四桶值、原旧资格也满足时同时输出；两份数据必须一致，不再单独累加。

人民币沿用已发布的原 costCoverage／recordedCost。未知或歧义记录仍在原人口分母，不能计价；只有实际已定价、完整原贡献可加金额。原 visible／hidden 状态保持，未知不补零。原 raw numericRecords inventory、来源 receipt 和最终页面 count 保持；选定贡献人口允许小于 raw population（正常去重），每个 received 人口必须不超过实际原范围人口。不能用 raw 行数等于 selected 行数作条件而把已知贡献再次全抹掉，也不能绕过原完整原行、摘要、source snapshot、seal／digest／page／CAS。

## 明细与旧缓存

Task、attempt／泳道、跨任务 Agent、运行时、用途、来源及 dimension-task 使用各自同一原 fold。完整子范围保持完整资格，不完整子范围显示自己的已收到分类。模型重建也使用 allocation 的原 qualified 标记；受限 calls／captures／模型集合边界保持，不借此显示未核对人口。

完整报告 fact qualification 严格核 nullable 桶、bucketRecords 与 records、已知分类和、调用覆盖、原范围人口以及 recordedCost 关系；损坏衍生页仍拒绝，不能退回任意 partial 数值。服务与 SPA 私有 scope 版本同步升级以生成新报告，既有 reportId 继续不可变。

`CompleteTokens` 优先读同一 metrics 的 received，旧总览／趋势参数仅兼容旧报告。分类值逐桶保留未知；短“不完整”与原调用覆盖、记录覆盖可见。Task／Agent 明细复用正常 detail-grid，缩小缺口提示，不再用大警告框遮住实际值。保持标准卡片间距、原返回／弹窗焦点、泳道、柱状图与中英文文案。

## 验证与范围

回归保留原完整总量未知、全部原行／分页 EOF、损坏拒绝、旧大整数与原预算；新增真实选择／原报告页核对已知＋缺调用、nullable 桶／真实零、部分定价／hidden／零真实人民币、全部四桶重叠排除原 owner 传播、原正常覆盖去重、merge／roundtrip／Agent／运行时／Task／attempt 一致以及旧 reportId 与新 scope。无 usage／全桶 null／全桶歧义三个范围在 metrics 往返后分别保留真实 invocation／observed／records；同一 Agent 的已知＋无 usage 核到 1/2。同模型部分重叠的原 summary、未知真实 model 的未决筛选、正常 fully-covered excluded 分别对拍原 allocation 与质量 EOF、人口、分类和及费用，禁止补值或丢分母。AW 不运行本机 tests／typecheck／build，以有限静态检查、独立功能检视、精确 SHA hosted CI 和原服务正式浏览器验收为准。

本修复不关闭 native owner 持久页 ACK 与生产接线、历史 before／采集上限、真实 100K Task／10M usage 及 RFC 剩余工作。
