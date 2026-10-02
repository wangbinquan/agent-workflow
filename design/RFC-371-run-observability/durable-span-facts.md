# 原生调用片段、续跑归属与执行泳道

状态：独立 DESIGN v3 已通过。本地业务 runNode 切片已实现，限定格式/lint 与 AST 语法检查通过；源码独立复核、官方登记、远端 CI 与正式页面验收待完成。没有本机执行 AW 测试、typecheck、build、E2E 或启动服务。AW-R03/R04/R09 与整个 RFC 保持 In Progress。

业务任务详情的每次执行可以打开工具、模型和原生子 Agent 片段。泳道使用原生起止时间；缺少时间显示未知，只有开始或结束时显示明确的开放/单点标记，不能借任务全长生成调用条。模型详情复用原贡献选择与费率快照，分别显示非缓存输入、缓存读取、缓存写入、输出以及人民币估算。没有实际关联的工具/Agent 片段显示未知，不另算一次模型调用或费用。

原生元数据通过原 Runner 与 Task 受理的 usage source 留存，沿用原来源 ACK；不新增 Token 账本或修改既有数值、覆盖规则和计费口径。每帧最多 200 个 fact/revision；schema 数值部分先独立验证，非法数字仍让原事务回滚。只有新增元数据非法时丢弃该元数据并记录固定诊断，原合法数值继续处理。旧无片段字段的数值帧保持原内容；旧已受理调用不会因重试请求带新能力而自动升级，既有受理和并发插入分支都保持原回执。

OpenCode 用独立只读 SQLite 快照读取允许的身份、名称、实际模型和原时间字段，不读工具参数、输出正文或提示。原数值采集的 500 帧快照与 fingerprint 不变。元数据限制为 128 会话、20,000 part、5,000 片段、32 层和 400ms；截断、缺来源或时间冲突均保留 partial/unknown。模型起点只有同一 message 中明确的一对 start/finish 才成立，多 finish 不猜起点。原生子 Agent 的结束时间不能由最后更新时刻推算。

新 root 只有原 root lease 已受理、真实 spawn 回执及同宿主原生创建时间证明后才能归属；原历史任务来源必须在同一任务和来源内完整有界查清。查找开始前的流元数据只留中性内存，超限或超时不制造归属。异步查找只准备内存，实际持久写入由原 Runner 在原 stdout flush 与进程回收边界完成，结束后迟到 Promise 不能写。unreaped process 不伪装成最终片段闭合。

续跑 A→B 时，旧工具 T 仍属于 A。B 只有查到原 A 的受理回执、原 source 行/条目/节点与完整创建事实，才能发布指向 A 的 prior revision；不把旧 T 复制成 B 的普通 fact，也不增加 Token/金额。A 的查询遍历同一任务的后续 carrier，因此能看到 B 补全。重复交付幂等，开放状态不能覆盖已闭合状态；冲突实际证据保留，原片段投影为未知。元数据冲突不会改变原数值。

Claude Code 使用原工具 use/result 的实际 call ID 与 ISO 时间。root result 不能批量关闭未结束的工具，assistant 消息的观测时间不能充当模型调用起点。配置根已知时固定来源命名空间；否则使用本次调用的独立来源，不与其他调用合并。仅支持真实根会话的可配对流字段，原生旁支与完整历史扫描能力不足时保持 partial。

Task 来源查询读取 ACK 后仍保留的源记录，在同一原快照使用 watermark、source 行和帧内 item 位置分页。任务/节点/受理范围变更使 cursor 失效；空页与坏帧仍前进，不跳过下一帧的第零项。接口先沿用原 Actor→Task→attempt 可见范围，才读取受理/来源。完整遍历有预算，耗尽明确 partial；本片没有建立高级大规模聚合投影，不能声称后续规模能力完成。

正式组件在既有 attempt Dialog 内按需加载，标准卡片与 stack 间距保持。选中片段进入 URL，恢复链接按同一 attempt 继续分页；返回使用卡片标题处的短 ghost 入口并恢复原触发焦点，没有长条返回、更多筛选、CSV 或关注任务卡片。新组件回归覆盖分类 Token、人民币显示、未知时长、焦点与续页；这些用例目前只写入，运行结论须来自自身提交的 hosted CI。

当前切片只覆盖本地业务 runNode。系统 Agent、smoke、CLI/自测用途没有完整持久受理/来源，不能仅凭 purpose 枚举称已采集；CS 托管运行不能使用本地来源冒充平台权威，保持原平台分类数据与明确未支持的片段状态。托管 spans、CS 原生 producer 的完整 writer/inflight、unbound/unknown-tail、真实全入口采集及规模分析继续，两个 RFC 未闭合。

验证边界：47 个源码/回归/样式路径精确格式和 lint 通过；45 个 TS/TSX AST 语法无诊断，未进行语义类型检查。新回归含真实原生 SQLite 来源、Task writer 的 SQLite/PostgreSQL provider 用例、ACK 后查询、帧内分页、原错误回滚、旧受理能力保持、原 Runner wiring、A/B 归属与冲突、四桶/CNY 和组件 URL/焦点。所有测试等待远端执行，不把静态检查写成测试通过。

## 2026-10-03 补充静态登记与返回焦点候选

官方 census 原失败为三个新 legacy 适配文件未登记 owner，原日志保留。补充窄范围 DESIGN v1 因共享在制 ledger 在评审期间变化而 FAIL；v2 改用已发布 e0c42a53 的只读固定 ledger，功能方案不变，独立 DESIGN PASS。rfc294Canonical.ts 只新增 claudeCode/spanFacts.ts、opencode/spanFacts.ts、runtime/spanCapture.ts 三个 runtime-management 精确条目；移除这三行后的字节与原文件完全一致，没有规则豁免或 wildcard。该文件限定格式、lint 均通过。官方全候选输出仍待生成、合并和独立复核。

URL 恢复的尝试明细通过原实际执行行定位返回焦点；普通打开继续恢复原触发元素。新增组件回归保留原断言，无 jest-dom 未安装 matcher。最新 45 个 TypeScript/TSX 的纯 AST 解析无语法诊断，三处实际变化文件的限定格式/lint 通过；这些均不是语义类型、测试或浏览器验收，AW 本机没有运行它们。完整源码候选扩为 51 路径，SOURCE 和 hosted CI 尚待完成，两个 RFC 保持进行中。

### 2026-10-03 原生片段 SOURCE v2 失败与有界事件修正

独立 SOURCE v2 完整核对 51 候选与 52 引用，首尾均稳定，结论 FAIL；唯一 P2 为归属查询尚未返回时，pending 按调用身份覆盖之前的实际 completion，可能把相互矛盾的结束时间错误显示为已知完成。原失败回执与旧候选保留，没有运行 AW 本机测试来代签。

修正为每 root 最多 200 条不同原生观察的有界缓冲，完全相同的事件去重，归属受理后经同一原证据投影顺序处理；已完成归属的事件直接走原冲突判据。两条不同 completion 均保留，后续最终 SQLite 只留后一值也不能抹去冲突；旧数字账本、数值捕获 500 限额及 CNY 计价没有改动。新增真实临时 SQLite 的两种冲突事件顺序，以及正常 start→completion 和 205 次重复交付的正例；均为写入待 hosted CI 的回归，不宣称已运行。两个实际变化源码/回归文件限定格式、lint、纯 AST 语法解析通过；未运行语义 typecheck、build、E2E 或服务。

官方完整 13 产物已在固定 e0c42a53 + 精确 51 路径的私有只读 provider 生成，未写仓库；生成期间共享主干合法推进到 fd02ad70，故旧私有产物仅证明原基线，当前 SHA 的产物、真实增长解释、完整实现门、远端 CI 与页面验收继续。源码修正须经 SOURCE v3；CS 开发 producer 保持 OFF，两个 RFC 保持 In Progress。

### 2026-10-03 原生片段 SOURCE v3 与正式生成清单

SOURCE v2 的唯一 P2 已按实际事件顺序修正，完整 v3 独立功能审查为 PASS：51 候选、61 引用首尾稳定，46 路径继承、5 路径重审，无新增 P1/P2。查询归属回包之前保留最多 200 个不同原始观察，同一事件去重；矛盾 completion 的两个顺序、最终 SQLite 只剩最后一条、正常 start→completion 与 205 次重复均有新回归。只做目标 format/lint 与纯 AST，没有运行 AW 本机测试、类型检查、构建或服务；新回归行为仍交远端 CI 验证，原 FAIL 保留。

固定已发布 `d2c29c15c2e65dfc447ea5f7ae99bac8c6bc77bd` 加精确 51 路径，只读 provider 的原官方 census 一次生成 13 产物，候选和引用保持，未纳入其他未提交源码。SOURCE digest 为 `sha256:0c055d81bc6a485593c8bc3d13c8451f22b6ed211b692efaaf980f7cabf81bd6`；production 2,828（backend 2,024／frontend 643／shared 161），legacy 557／module 1,467，symbol/root 25,901。原四项生成规则和字段预算计算方式不变；两项既有合同随新增字段更新派生数值：ObservationTaskQueries leaf/union 为 169/58→205/76，TaskObservationFactsQuery 为 60/32→75/38。完整 owner/edge、debt 与波次判据保持，新增三个已批准的精确 runtime helper 登记。

实际八项增长依原 RFC-317 机制各登记一次：mutation 1,817→1,823、background 344→345、ambient 500→501、observed imports 5,756→5,778、exceptions 5,115→5,136、facades 295→298、public 1,047→1,053、symbols 25,819→25,901。增长来自实际采集/查询工厂、限时读取 timer、正式 spans GET、原边分类、两个公共工厂与四种 capture 类型、三个 helper 及新符号；没有增加数值 usage writer 或放宽规则。原 pure governance projection 复用这一次 census，只给这八项实增条目投影具名 why 和原 provenance；其他十二产物逐字相同，没有重跑 census。回执必须在匹配 canonical 提交之后由原机制立即退役。

旧 e0c 的私有产物、report-only 修正及原 SOURCE v1/v2 历史保留；只读生成和源码有限 PASS 不替代完整实现门、新发布 SHA 的 hosted CI 或正式页面验收。本片只补本地业务 runNode 的原生片段；system/smoke/CLI 全入口、CS hosted 联合链路、原生层级完整性和全部剩余工作继续，两个 RFC 仍 In Progress，CS 开发 producer 保持 OFF。

### 实现门 v4 文案修正（2026-10-03）

完整限定实现门 v4 的唯一 P2 是许可理由及发布说明把派生字段预算误写为不变；原 FAIL 与逐文件回执保留。当前只修正该许可 why、用原 provenance 函数重算 ledger 摘要，并列出上述两项实际数字。另 12 份生成产物和全部 48 代码路径逐字未变；纯治理投影复用原 census，未重跑 scanner 或本机测试。窄增量复核、新发布及精确 hosted CI 继续，不关闭 RFC 或开启 CS 开发 producer。

### 已发布候选与 Windows 类型修正（2026-10-03）

完整实现门 v5 已通过，65 路径发布于 `7135c4092bea766742a637a2d998312633811cd0`；随后的 `aa6e75a4cfb35ec0a80b9f2466d6f6d9ee0c514b` 只按原机制退役精确八条增长许可，其他计数、理由和产物保持。推送后 main/origin 精确一致、索引为空。主 CI 与九类原默认定时配置均在 aa6 上验收，不能据此提前宣称全部通过。

[Windows 定时 CI 37068423865](https://github.com/wangbinquan/agent-workflow/actions/runs/37068423865) 的 Typecheck 实际失败：片段来源回归把允许历史 `sourceId=null` 的已受理响应类型，当成要求新来源 ID 的受理请求传入 store。修正该夹具为直接由原 `AcceptObservationInvocationSchema` 创建请求，保留相同输入与全部分页、ACK、归属断言；生产合同、旧响应兼容性与 CNY 均未放宽。这是单一回归文件的类型修正，没有运行 AW 本机测试或类型检查；限定检查、独立功能复核、新提交及 hosted CI 仍须完成。原失败回执保留，两个 RFC 继续 In Progress。
