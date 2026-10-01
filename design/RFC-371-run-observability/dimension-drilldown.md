# RFC-371 维度范围与任务下钻

状态：AW-R08 第二片设计 v1 功能门 FAIL 的三项边界已修订，v2 精确设计待复核；本片源码尚未改。用户已批准继续两个 RFC 的完整实现、提交远端与 CS 本机部署。移除更多筛选、顶部工作流输入、CSV 和关注任务卡片的决定保持有效。

## 提案与原语缺口

当前原受理运行时名称、任务贡献与 Dialog 已发布；`runtime` URL 只控制 Dialog，并不是服务端过滤。模型、用途与来源分布不能直接形成任务查询范围。任务 owner 在 SQL 中先应用原 actor 可见性、删除/目录/开始时间窗口与原筛选，再分页，只有整页末尾的 opaque cursor。观测直接筛选返回的 20 条会漏后续匹配任务，空页也不能证明无任务；观测不得解析或制造 Task 的私有 cursor。

本片在 Task public query 增加与每个已授权任务同次返回的 opaque continuation，观测自己保存独立维度范围。匹配和统计仍在服务端同一授权数据库快照内；四桶与人民币只统计匹配贡献，进入任务详情继续全生命周期，返回恢复原范围。任务执行/控制入口不改变。

## 结构与有限合同

TaskExecution 的 public `TaskObservationFactsQuery.list` 返回 `positions: readonly {taskId,cursor}[]`，与 `items` 一一对应；每个 cursor 由 Task 自己按当前 query scope / startedAt / id 生成。原 `nextCursor` 和旧 API 分页语义不变。实际 provider-neutral adapter 提供此原语，观测 Task source port 只声明相同结构；bootstrap 继续仅依赖原 Task public query，不能读取 Task 私表或反向 import 观测应用层。所有提供端/替身同批更新，缺失或不匹配的 position 是合同错误，不能默认为完整或降为私有 cursor 推断。

共享 query 增加一个独立 `selection` 字符串，最多 2048 字符，解析为 strict 对象：runtime / model / agent / purpose / source 各最多一项，多项取交集。runtime 用冻结 authority、sourceId、registrationId、configurationRevision、protocol 五元；model 用实际 authority、sourceId、provider、model 四元；agent 用 agentId、agentRevision；purpose 为 task/system/playground/memory；source 是 local 或 crewstation 加原 sourceId（null 明确历史未绑定）。字段、数值与 nullable 语义严格校验，未知键/坏 JSON/错误组合返回 400。名称不属于身份，CS modelRef 只 opaque 等值，不解析供应商/型号，不查当前目录补历史名称。未知身份可按显式 null 维度进入；未知范围仍显示已知/部分/未确认。

新 schema 与类型放 shared 现有 observationTasks 文件；纯身份匹配落 `run-observability/domain/analysisDimensions.ts`；bounded scan/cursor 与贡献筛选落本 context application；真正 SQL continuation 在 Task owner infrastructure。对外只读路由、原同步账本、价格配置和权限规则复用，既无新后台 worker/HTTP 写入，也无架构例外。

## 数值选择、未知与费用

先加载任务完整受理调用和各原生/平台证据，先完成父/子覆盖与四桶贡献选取，再按维度筛选已选贡献。不能先丢掉非匹配父记录再重算叶子；否则同一树会重复计量。运行时、Agent、用途、来源由受理调用筛选；实际模型由已经解析的贡献记录筛选。同调用发生模型切换时只保留实际匹配模型贡献，不把全部调用归入默认模型。

过滤后的 `metrics`、任务行、趋势、Agent/运行时/模型/用途/来源分布均来自同一组匹配贡献；task wall/running 时间和采集积压仍是该任务全程事实，必须在界面说明，不能宣称已分摊为模型活动时间。费用仍复用原冻结 CNY 估值；CS 金额隐藏/待估值保持未知，模型/四桶选取不足原计价记录时保持现有 partial-allocation，不按 Token 比例伪算金额。

一次调用未完整采集、实际模型未确认或整个任务调用被截断，可能影响该范围的归属。已有明确匹配贡献显示已知下界；不确定但可能匹配的任务带 `dimensionMatch=unresolved`，不借全任务数字，已知不匹配且证据完整才排除。model 过滤后零 records 必须撤掉全调用的 knownZero/emptyCostVisible 标志；只有该维度本身的肯定空证明才能为零，不能让其他模型/整树零证据生成指定实际模型。范围返回 partial / 未确认数及说明；未知任务不得被当成完整的零匹配窗口。

## 分页与预算

无 selection 的原 list / overview 行为保持。选中维度后，观测把维度去掉后才向 Task list 传原 Task query，每批最多 25；每请求最多检查 200 个已授权 Task、10,000 个 invocation、20,000 条 record 读取，沿用真正全局预算。预算约束应用在原量读取而非过滤后的少量结果；调用/记录超预算时保留 partial，不能伪造 subtotal。

维度 page cursor 是观测自有 `[version,canonical-selection-and-base-scope-digest,opaque-owner-cursor]`，不能解码里面的 Task cursor。每次处理一条真实 Task 后使用对应 owner position；满用户 page limit 时停在最后一条实际处理任务，后面的原页任务不会跳过。整页处理完则使用原 nextCursor；原 owner EOF 才是范围 EOF。维度/原 q/status/repository/workflow/timezone/window 任一改变必须拒绝旧 cursor。cursor 只推进不缓存 Task IDs，不用 get 绕过原窗口或权限。预算先耗尽可返回不足/空的部分页及续页游标，界面显示“本批已检查范围，继续加载”，不显示完整总数或空窗口结论。总览预算按已扫描任务计，不得因匹配为零而继续无界扫描。

有 selection 时，半读一个 Task 后触及 invocation/record 全局预算，必须返回该已授权 Task facts 对应的一行 `dimensionMatch=unresolved`、partial。该行不使用半读 subtotal，四桶 `hasKnown=false`、金额 null，不回填全任务 Token 或制造已知零；wall/running 与积压只作为未分摊的完整 Task facts。未确认行和该条真实 owner position 同时纳入结果，随后结束本批，下一页以新预算从后继任务开始。禁止仅推进丢弃半读任务，也禁止停在它前面使超大首任务永远耗尽预算。如果本批恰好读到真实 owner EOF，仍可返回 partial 的末行，但不能制造可续 cursor；EOF 与数值完整度分别表示。无 selection 的既有 overview 丢弃半读项语义保持。

本片不增加新 rollup，不承诺已有扫描投影达到 AW-R11 的 100K/10M P95。完整规模验收与 R11 保持单独退出条件。

## 正式交互

从现有运行时 Dialog、模型分布、Agent、用途、采集来源行直接点击“查看关联任务”进入 tasks tab 并设置 selection。分析页保留同一范围，任务标题复用任务列表链接样式，不加外框或长条返回控件。模型明细使用公共 Dialog 展示该实际模型的任务贡献，不能在页尾展开长列表；运行时 Dialog 保持既有范围/焦点/滚动。用途/来源使用同一公共卡片、TableViewport 和 spacing token。

模型 Dialog 的直接公共 Dialog 调用必须同批登记 `packages/frontend/tests/overlay-ux-inventory.test.ts` 的实际 context/count；现有 AST 扫描与调用清单双向严格相等继续生效，不删除扫描、不放宽数量。`useObservationReturn.ts` 将贡献容器识别扩展为明确的通用容器身份，同时兼容既有 runtime attribute；模型和运行时 Dialog 各按自己的容器、任务、URL 状态与范围保存 dialogBody/main/window 滚动和原触发焦点。不能误捕获另一个 Dialog 的滚动，末行进入任务后返回须恢复当前 Dialog 的位置。该 hook 和登记测试都是精确候选路径。

FilterBar 的 trailing 仅显示已选范围和逐项清除/清除范围；不增加更多筛选折叠、顶部工作流输入或 CSV。selection 独立于 `runtime`/`agent` 的旧 Dialog URL，不解释旧 URL 为新服务器筛选。改变维度回第一页、清理旧 Dialog 状态；范围加入请求、缓存 key、URL 校验、同范围返回/滚动/焦点键。任务详情的紧凑 PageHeader.back 保留，返回恢复全部 selection/原筛选/分页；趋势钻取只改时间桶而保留当前维度。旧响应不包含新增分布/匹配元数据时明确兼容未知，不能借任务总量补单维度贡献。中英文、明暗/窄屏和键盘行为同批覆盖。

## 候选与并行边界

精确 allowlist 在私有候选记录。Task `public/queries.ts` 当前含 RFC-370 配置 owner 的并行在制输出；本片只加入 continuation 合同，绝不剥离其他 output。发布前等该 owner 的实际依赖提交齐全，提交整个 task-related 共享文件并如实注明并行内容/署名；不得把未提交依赖扫入本片或用 alternate index/重写文件制造干净候选。必要路径或 query 合同变化先补设计门；其他 WIP 只核指纹。

canonical 仅官方生成器从已提交 HEAD 加本片候选内存生成；不生成并行 Task 配置未提交输出的架构登记、不删除它们来实现隔离，不领取 RFC-294 wave 信用。官方生成器的 12 份 architecture JSON 与第 13 项 `design/RFC-294-backend-layered-target-architecture/status.md` 均在精确候选中，同一 sourceDigest/分母由生成器一次产出；不手抄摘要、不删除生成步骤。已有逐项一次性增长许可按精确新 owner/import 分母处理并退役，不能放宽全局守卫。共享文件或架构输出存在冲突先协调短发布临界区，普通无冲突开发继续。

## 验证与退出计划

1. 独立设计 PASS 后实现，独立实现门复核整个精确候选与参考/并行字节。Task positions 的真实 SQLite/PG 测试锁 actor 可见性、删除/目录、原范围、同 timestamp tie、每条 continuation 与原 end cursor。
2. 维度交集、历史无名/已删目录、不透明 CS 模型、跨安装同引用、默认模型不替代、同调用多模型、父/叶覆盖、未知/零、费用隐藏/恢复及原价均用真实持久 store 对账。
3. 匹配任务跨原始第 25/50 条页、page limit、空部分页、200/10K/20K 预算、全部 scope 修改拒 cursor；不可见任务不进入数字、positions 或未确认数。缺 owner position 错误明确传播。首任务单独超过 20,000 条后以无已知值的 unresolved 行保留，其后匹配任务在续页可达；余量仅 1 时半读也必须行与 position 原子推进，锁住不重复、不漏项和不伪造 EOF。
4. UI 请求参数/缓存 key、清范围、模型 Dialog 的单维度贡献、返回全部范围、末行 Dialog 焦点、中文/英文及负向断言不恢复已取消入口。hosted Playwright 在 390/768/1440 明暗下核公共间距、实际四桶、紧凑返回、URL 与键盘。
5. AW 本机只精确格式/lint和官方静态登记，不跑测试/typecheck/build/服务；精确远端主 CI 与适用原定时矩阵、真实现有任务页面范围对账分别取证。不得把只读显示夹具当真实采集。全部退出证据齐全才关闭 AW-R08；整体托管实采、细 span/树/时间、质量历史与规模继续依自己的待办。

## v1 失败与 v2 修订记录

独立 v1 设计记录保留为 FAIL，三项 P2 分别是新模型 Dialog 的现有双向登记路径遗漏、半任务预算耗尽时无法同时保证进展与不漏项、官方 RFC-294 status 生成物遗漏。v2 增加精确的 Dialog 登记测试、返回状态 hook 和官方 status 路径，定义仅授权 facts 的未知行与原 owner position 原子推进。原 35 路径扩为 38；尚无本片源码、测试、CI 或真实页面 PASS 声明，不据此关闭 AW-R08/R11 或两个 RFC。

## v2 设计通过与源码候选（2026-10-02）

独立设计 v2 已 PASS，私有回执 `observability-aw-dimension-design-review-v2.json` SHA256 `c9da6e28cd8f24de1b3c9f6c1efb06979ea3d549cc23e8a2be7294a7f51f2809`；v1 FAIL 原样保留。38 路径内的领域匹配、真实 Task 逐项 continuation、受界扫描和各维度贡献已实施，配套真实 SQLite/PG 回归、组件及 hosted 浏览器矩阵已写入。仅精确 Prettier/ESLint 已通过；没有运行 AW 本机测试、类型检查、构建或服务，源码的正式结果仍待独立实现门及 hosted CI。

共享 Task public query 含 RFC-370 配置 owner 的在制出口，其未提交依赖尚未准备好；本片没有剥离这些内容或代提交。官方 canonical 最终生成与完整候选冻结须在其相关依赖真实上库后进行，不能把未提交配置代码作为本片静态分母。开发、CS 精确 CI/部署及不依赖此条件的复核继续。AW-R08、AW-R11 和两个 RFC 仍未完成；原定时矩阵、现有真实任务的只读范围对账和页面验收均继续。

### AW-R08 源码复核 v1 失败与 v2 补正

独立源码复核 v1 为 FAIL，原回执 `observability-aw-dimension-source-review-v1.json` SHA256 `b9684778b15aff88f349e6fc273e53331ab7877607e7b61a14acb081c6b57913` 保留。第一项 P2 是父子夹具已使用不同已知模型却仍断言覆盖扣除；修订为未知模型父汇总覆盖已知模型子项，同时另加两个明确不同模型互不扣除、原人民币分别完整计价的反例。生产覆盖规则不改。

第二项 P2 是完整数字记录尚不能证明原生采集已闭合。维度判断现在同时保留持久 native/turn/revision 采集缺口，可能匹配的任务留作未确认，不借全任务 Token 或金额。新增本地缺证明、历史无采集契约和 CS 实际缺前轮投影的持久回归；原证明/前轮真正补齐后才允许排除非匹配模型。普通估值原因不替代采集覆盖判据。精确格式/lint通过；这些 AW 回归只写入，等待 hosted CI，不冒充本机执行通过。v2 继续独立源码复核；共享依赖、官方架构登记、最终实现门、远端 CI 和真实页面仍待完成，AW-R08 与两个 RFC 保持进行中。

### AW-R08 源码复核 v2 失败与 v3 补正

独立源码 v2 仍为 FAIL，原回执 `observability-aw-dimension-source-review-v2.json` SHA256 `860a1923714e78c448ed5f49be16b9f39b5bac7f03cef0dfaa78d20651c75b3d` 保留。v3 复用原 Token 完整度的覆盖判据，仅排除已证明空树自身的费用隐藏/待估值原因；真正 native、轮次、修订缺口仍未确认。增加来源、用途、Agent 修订、运行时和交集的实际持久零证明/隐藏人民币下钻断言，Token 保持完整已知零，金额保持未知；指定实际模型仍不能继承全树零。

CS 缺前轮回归的 scoped usage 现在明确四桶覆盖水位为实际 turnIndex=1，以原严格 schema 和真实投影持久化进入缺轮/后补齐断言，不放宽解析或伪造闭合。本片仍只有精确格式/lint；没有本机 AW 测试/typecheck/build/服务，也未完成共享依赖、官方生成登记、完整实现门、远端 CI 或真实页面验收。v3 源码继续独立复核，v1/v2 失败不覆盖，AW-R08 和整体 RFC 不关闭。

### AW-R08 源码 v3 PASS、共享依赖与官方登记（2026-10-02）

限定源码 v3 的独立功能复核已 PASS，回执 observability-aw-dimension-source-review-v3.json SHA256 dcf2b9cb0a5cd75b8b4ce5081ce80f123fb1c11cf61b8793f6e2fc5700af29a5；v1/v2 原 FAIL 保留。该通过只覆盖源码与回归内容，不当作 hosted 执行或完整发布门。

RFC-370 配置与后续来源查询由其原 owner 自行提交，包含观测 positions 的 Task 公共接口完整保留；截至 e3b656a10e2bae30c2c51994d565bbcc649efed6 两边 main 同步、共享索引为空。原 owner 的并行源码与架构登记准备好后，官方架构生成器基于真实已提交 HEAD 加本片精确候选运行；13 个登记产物全部生成、exit=0，生成期间 HEAD稳定。使用官方治理投影，无临时例外、无替代 checkout/index，也没有改其他会话文件。完整38路径候选仍待最终独立复核、精确上库及 hosted CI。

已有真实原生任务按模型、运行时修订、来源、用途及交集在当前候选接口做只读核对，145项一致；三个闭合原生样本为 input 36,260 / cacheRead 8,832 / cacheWrite 0 / output 2,432，总47,524，验收人民币 ¥0.096392。较宽时间范围还包含原失败/部分验收，已知77,833 Token / ¥0.165830且完整度仍为partial，未把未采集调用当成零。任务贡献、分页EOF、趋势四桶和费用冻结互相对齐；filter echo按原合同是规范JSON字符串，首次验收脚本误用对象比较的原失败回执保留，修正比较后无源码变化。没有新模型调用、身份切换或本机AW测试/类型/构建/服务启动；实际新Dialog页面仍待当前锁屏解除。AW-R08与整体RFC尚未关闭。

### AW-R08 最终清单 v1 FAIL 与精确生成 v4（2026-10-02）

最终复核 v1 FAIL 已保留：原静态输入代理没有覆盖官方文件系统读点，漏了 `dimensionTasks.ts`、`analysisDimensions.ts`、`ObservationDimensionDetails.tsx`，且共享清单被另一个会话的 RFC-370 scope 再次生成。源码 v3 PASS 和真实只读 145 项对账仍有效；没有把旧清单成功退出当作最终候选通过。

RFC-370 owner 已明确暂停共享清单/Git 发布，让 RFC-371 先完成短发布窗口；其 11 个 resume 源文件全部保留，本提交不收编。修正仅显式提供“已提交 e3b656a + 本片 25 路径”的内存文件系统视图，不建 checkout、不改 index、不读入并行未提交源文件；官方 AST/投影/来源摘要/状态渲染逻辑仍使用同一源码。私有静态生成 v3 和带实际增长登记的 v4 均退出 0，尚未运行 AW 本机测试、typecheck、build 或服务。

完整生产语料为 2760 个文件，`sourceDigest=sha256:08703d62600043c1d2f33d719d8f1a21c2ef47ab48f859905282733bca005a01`，包含三个新文件。相对提交基线真实增长只有 observed imports 5613→5615、canonical exceptions 4982→4984、module symbol owners 25623→25648；两条现有 Actor/hash 边及三个文件的实际 owner 符号按 RFC-317 登记一次性 RFC-371 `allowGrowth` 理由，没有增加 wildcard、depcheck 豁免或 wave credit。后继提交须按实际增长/不增长清理一次性许可，不能带着 stale permit 抄旧清单。

13 份官方输出与三份本 RFC 补充将作为最终候选 v2 再独立复核；精确 SHA hosted CI、正式 Dialog 的实机几何/焦点验收仍待完成，AW-R08 和 RFC-371 不标 Done。既有失败、并行漂移、只读窗口的部分覆盖，以及更早的实际模型验收历史均保留。

### AW-R08 最终清单 v2 FAIL 与来源摘要刷新（2026-10-02）

完整 2760 语料、13 份输出、真实 +2/+2/+25 增长及一次性 RFC 许可均已独立核对；v2 仍 FAIL，因为四份治理文件保留了旧 `provenance.contentDigest`。原官方入口仅在显式 `--snapshot-sha` 时刷新来源摘要，静态生成退出 0 不能替代这个条件。完整 v2 FAIL 已保留，源码 v3 PASS 没有撤销。

静态生成 v5 使用同一官方 AST/投影入口与固定 `--snapshot-sha e3b656a10e2bae30c2c51994d565bbcc649efed6`，保留各自原 `originSha`，正式输出日志明确 provenance pinned。2760 及 `sourceDigest=sha256:08703d62600043c1d2f33d719d8f1a21c2ef47ab48f859905282733bca005a01` 保持；四项 payload 摘要另用独立 JSON 计算对拍全部一致。此 SHA 是当前已提交的生成基线，尚未把工作树称为已发布提交。

修正后的完整候选 v3 将独立复核后精确提交、推送并等待本 SHA hosted CI。正式浏览器几何/焦点和整体 RFC 的其他条目仍继续；不把原静态失败、部分覆盖或未定价当零，生产开发采集不因此开启。
