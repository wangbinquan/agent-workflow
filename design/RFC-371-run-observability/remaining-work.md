# RFC-371 剩余工作与关闭条件

## 2026-10-07 当前验收入口

当前发布、实际任务分类 Token / 人民币、CS 部署与新挂载修复，以及未完成的退出条件统一见[原生运行验收记录](./native-real-validation-20261007.md)。两个 RFC 保持 In Progress；已知数字显示并标记缺口，不把不完整证明当作零消耗。下文不同日期和旧 SHA 均保留为历史，不能代签当前 CI、真实任务或页面验收。

## 完整统计硬要求（2026-10-03）

用户要求漏任何一条都是严重问题。当前实现中的任务、调用、记录总量截断必须移除；不能改成更大的上限，不能返回成功的 partial 或定价小计。完整读取、同快照四桶、精确覆盖、原生 EOF、分页报告和验收以 [完整统计设计](./complete-statistics.md) 为本次实施依据，覆盖下文历史的有界统计与部分成功描述。DESIGN 已通过；生产实现和验收仍在进行中。

- [ ] 原 owner 分页到真实 EOF，单页参数不限制总量。
- [ ] 专用快照与有界临时工作区、精确覆盖选择、完整报告发布。
- [ ] 原生分页基线、修订、完成证明与可恢复补全。
- [ ] 正式页面不显示截断数字，任务/Agent/四桶/人民币同源对账。
- [ ] 超旧边界、单任务巨组、真规模、真实任务、页面和 exact-SHA CI。

2026-10-02 历史证据：观测源码基线 `b339e7e06e13c7b4456cc1bf928048c7fc0262a3` 的主 CI 50/50 与九类默认定时工作流均已 completed/success，共十次有效运行、75 个成功作业。首次拒绝 POST 的原触发时序已恢复并通过 Chromium 与 WebKit；偶发 mixed report 缺失根因仍未确证，原失败和取消记录保持。详见[当前 CI 回执与边界](./ci-recovery.md#2026-10-02-原审批时序与默认-ci-矩阵复验)。CS 开发 producer、完整退出链路、最新正式页面验收及真实托管联动未完成，两 RFC 不关闭。

更新：2026-10-03。状态：In Progress。本文是当前待办入口；[plan.md](./plan.md) 各实施批次保留历史，不把历史的“尚未接入”或原型勾选直接当成当前状态。代码、精确提交 CI、实际部署和真实运行验收分别记录。未取得退出证据的任务保持未完成。

## 当前 CI 与原生片段接续（2026-10-03）

当前远端已发布 main 基线为 `d3b13937c165aa8ae0ad0d96a443f7eb88e10f4e`；本会话完整 EOF 基础源码 SOURCE31 已在本机普通提交为 `9d539605a6c35c4fb6ef223aaae8b0280445189f`，尚未推送。本批 13 原官方产物已基于该源码生成并通过全部 129 账本的纯 AST/JSON 核对，完整 META 与发布仍在接续。`d2c29c15` 及原生片段/formal trace UI 的 51 路径 SOURCE v3 属于前一阶段历史；不能将其有限 PASS 当成完整统计交付。新正式报告接口、页面、原生 v2 与规模验收尚未完成。源码有限 PASS 和本机静态生成均不代替发布 SHA 的主 CI、九种默认定时矩阵或实际页面验收；此前所有失败和取消保持，不用历史 b339 的全绿替代本批结论。

CS 的原生留存联合基线当前已发布并本机部署为 `75dd427227fc7e3f587015c37ca411904513c625`，六项精确 CI 与八组件实际 OCI 来源已核；`463f24d8` 保留为历史部署阶段。完整统计新源码仍是未发布、未接入正式接口的候选。生产开发 producer 仍 OFF，全 writer/inflight、unbound/unknown-tail 和真实联合验收继续。AW 系统/CLI/自测入口、完整归属、时间/分析/规模及正式页面剩余项不关闭。下节保留 2026-10-02 当时的链接修正状态，仅为历史记录。

## 2026-10-02 当前 CI 接续

观测文档 `e8c9d73b13bf467c2e56b9abe2d9baf2f4765797` 已上库；CI36977794334 终态 failure（42 success/8 failure）。原会话修复类型和架构登记后的 `55b1104a812c247f692f5450b6738e299d437bc1`，CI36980700296 为 failure（48 success/2 failure），只剩 RFC-370 三条固定源码链接的 GitHub blob 503 及汇总失败。共享文件中的官方 raw 地址改动完整保留；同提交内容 HTTP 200、字节与 Git 对象一致，修正版等待独立 SOURCE 与自身 hosted CI。原失败保留，尚不关闭 AW-R01。

原 b339 默认矩阵的 75 个成功作业、实际三任务四桶 Token 与人民币验收估算证明保持，不替代新提交 CI。CS 原父结束、重建接续及完整 writer/未知尾部链路仍在实施，producer 保持 OFF，不能以存储或类型通过替代产品完工；浏览器新部署验收仍需实际解锁和有效原身份会话。

## 当前已经具备的能力

正式入口位于“运行与仓库”，已有总览、任务追踪、Agent 汇总、人民币用量分析、基础泳道和采集状态。已有四桶 nullable Token、持久去重账本、执行身份和价格目录冻结、CNY 版本配置、OpenCode 原生根/子树证明及历史修订。CS 来源通过独立 usage/valuation 同步，不使用 AW 本地费率重复计价。

用户最近要求的任务名样式、柱状趋势及实际数字、卡片对齐，以及移除关注任务卡片、顶部工作流输入、“更多筛选”、CSV，已落地。旧 URL 的工作流范围提示与清除仅用于解释已有范围，不是重新增加筛选入口。

| 当前批次        | 已有证据                                                                                                                                                                                                                                                           | 还缺什么                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 页面修正        | `30f8aa1bf`、`00de070e` 已推送；对应前端、浏览器及构建功能检查已通过                                                                                                                                                                                               | 整体 CI 曾有静态扫描失败，不写成全绿                                                                                                                                                                                                                                                                                                                                     |
| 托管原生证明 v2 | `f4d02c115d999262f97794b270c8cbff9a448fc9` 已推送，独立功能门 PASS；视觉 CI [36513591563](https://github.com/wangbinquan/agent-workflow/actions/runs/36513591563) success                                                                                          | 首轮主 CI 的测试配套错误已修，最终执行验收待下行                                                                                                                                                                                                                                                                                                                         |
| v2 配套修正     | `904ccfdaa0de41d63472d1a4c251a657a32857fa` 已推送；[视觉 CI 36514863164](https://github.com/wangbinquan/agent-workflow/actions/runs/36514863164) success；主 CI 36514863155 终态 failure | 三个 capture matcher 类型错误、Node JSON 加载及一次性 allowGrowth 已随 `8c6e9a0766a1a184170dec1e9685a07b580334e5` 修正并推送；[CI 36619139778](https://github.com/wangbinquan/agent-workflow/actions/runs/36619139778) 终态 failure（46 success / 4 failure）；类型、后端及构建通过，两个浏览器分片在页面加载前读取卡片，修正及最终验证见 AW-R01；静态扫描只记录失败状态 |
| 双部署真实闭环  | 协议、双数据库和浏览器夹具已有回归                                                                                                                                                                                                                                 | 独立实际运行、CS 托管装配及实际运行不能由上述夹具替代                                                                                                                                                                                                                                                                                                                    |

源码核对锚点：[查询与 DTO](../../packages/shared/src/schemas/observationTasks.ts) 的 cohort 仍固定 `started`；[观测应用层](../../packages/backend/src/modules/run-observability/application/taskObservations.ts) 当前按调用/尝试聚合；[来源证据](./protocol-evidence.md) 明确实录、夹具和实际运行的区别。

## 下一步执行顺序

1. AW-R01 的历史 b339 主 CI 与九种原默认矩阵通过；本片原生 span 新候选仍需自身精确 hosted CI 与默认矩阵，按上方当前接续核对，保留旧链接与 e0c/fd02 失败。
2. AW-R02 与 CS RFC-034 的 CS-R01：完成 v2 跨仓同步和托管准入验证；CS-R02～05 优先补项目开发消耗。
3. AW-R03～08：补齐调用来源、树形归因、时间口径、细粒度泳道与分析。
4. AW-R09～11：异常、历史维护和规模验证。
5. AW-R12：按验收矩阵逐项收口，更新最终发布回执。

此顺序不意味着必须串行等 CI；可以继续做不依赖失败项的设计、实现和文档。不得因无关主干 SHA 变化重复启动同一候选的全量验证。

## 待办清单

### AW-R01 CI 收口〔历史矩阵通过；本片新候选待精确 hosted CI〕

- 修复提交 `edd56ebe33731cb05aa7491b292be294a3026521` 的[主 CI 36684248034](https://github.com/wangbinquan/agent-workflow/actions/runs/36684248034)50项成功；九种定时配置共25项全部成功，含[WebKit 36684326977](https://github.com/wangbinquan/agent-workflow/actions/runs/36684326977)两平台八分片、[full 36684319531](https://github.com/wangbinquan/agent-workflow/actions/runs/36684319531)四分片/覆盖对账，以及[weekly-all PG 36684345862](https://github.com/wangbinquan/agent-workflow/actions/runs/36684345862)五项。10个运行的headSha均为同一完整提交、均正常终态success；未取消或削弱门禁，本机无AW测试/构建。修复候选限定独立功能门PASS，AW-R01已满足退出条件，[完整矩阵](./ci-recovery.md#修复候选精确终态2026-09-30)。后继文档CI另外验证；AW-R02～12和两个RFC保持未完成。

- 上一完整候选 `0647dadbedd66a20b162377788e92f2c79b68f83` 的 [CI 36676635657](https://github.com/wangbinquan/agent-workflow/actions/runs/36676635657) 已50项全部success，九种定时八success；[WebKit 36676700139](https://github.com/wangbinquan/agent-workflow/actions/runs/36676700139) 7/8分片成功，Ubuntu3/4的REPO-39首轮及重试均在partial目录未删除断言失败。只等orphan阶段不能证明后续partial完成；当前修正为在同一原预算内等待两项实际删除，保留全部保护断言。上一笔单次增长声明同步退役。全部十个旧运行正常终态、无取消；新候选精确主CI和九个默认矩阵继续验证，详见[完整回执](./ci-recovery.md#第三轮终态与-repo-39-阶段等待修正)。

- 第二轮候选 `18c487f8c57743c9731b8757b31d9795d494004b` 已精确推送并取得限定静态功能门PASS。Windows36671976956终态failure，类型检查发现新mint回归任务夹具遗漏必需startedAt；补Date.now()且保留全部实际数据库断言。主CI另有canonical清单漏更新，按官方生成器补同步onPresenceConnectionState顶层归属、摘要和单次增长依据；旧主CI36671910180已46success/4failure，失败均为上述两类原因；九个定时八success（包含实际定价覆盖对账及两平台WebKit），仅Windows类型失败；18路径新修复候选独立静态功能门PASS，新精确SHA验证待运行，最新退出证据见[CI修复记录](./ci-recovery.md)。

- `8c6e9a076` 的主 CI 36619139778 已终态 failure（46 success / 4 failure）：先前的 matcher 类型、JSON 加载和归属账本问题已通过；Ubuntu/macOS 两个浏览器分片均在新平台轮次用例进入后、数据尚未渲染时读取了空卡片列表。
- 当前修正先等待夹具的全部 30 个轮次按钮渲染，再验证 1280/390px 卡片间距、末行 Dialog、边界与 Escape 焦点恢复。保持全部原有断言，未修改生产逻辑或添加固定延时；改动文件格式/lint 与独立只读功能复核 PASS。该修正已随 `ee1af6da15b827e32ea0e15557f79ccd47e2f6b9` 精确推送，后继 `fb53e21542e38e866cd508cfa6b105b50eea3895` 包含该修正且只追加 STATE/总计划文档；源码未变。其 CI 36624953215 终态 48 success / 2 failure，十个 Playwright 作业及功能检查成功。两个失败为 `Static scans (audit + actionlint + shellcheck + gitleaks)` 和 `CI required`；整体结论仍 failure，不写成全绿。
- 文档后继 `5681ca12055c654922db556aec906c9de6d19476` 自 fb53e215 只变三个观测文档，包含原加载修复且源码一致；[CI 36641142819](https://github.com/wangbinquan/agent-workflow/actions/runs/36641142819) 已终态48success/2failure。十个Playwright及功能检查全部success，失败仍仅静态扫描与`CI required`，整体failure；扫描只核元数据，外部关闭依赖不变。
- 若后续提交使 CI 被取消，记录包含候选的后继 SHA 和祖先证明，并定位失败归属，不能只写“后继已绿”。
- 核对 v1/v2 严格合同、双数据库持久同步、平台 Dialog 双向登记、390/1280px 几何和末行焦点回归。禁止通过删断言、跳过或仅重跑掩盖失败。
- 退出证据：最新精确SHA的主CI及九种定时配置全部终态成功、功能失败修复提交与复核记录。用户本轮明确要求修复AW CI与定时CI，已授权读取并修复失败日志；此前只核扫描元数据的限制保留为历史，当前以[CI修复记录](./ci-recovery.md)为准。失败或取消时不宣称整体CI成功。

### AW-R02 独立部署与 CS 托管联动〔部分实现；P0-T4、P1、AC03/09〕

- 已有显式 v2 请求、v1 兼容、换版重建原子快照、平台 capture 独立展示及完整空树的已知零判断。完成与 CS 实际路由的联合对拍：跨页、断线、重放、过期快照、版本升降、金额开放/撤回、迟到估值和历史修订。
- 校验安装、项目、任务、子任务、执行和代次完整映射；证明托管调用不再产生本地数值或费用，断网不回退本地价目表。
- 依赖：[RFC-370](../RFC-370-crewstation-hosted-deployment/plan.md) 的 Phase A A–G 及对应托管启动根/owner 适配准入。RFC-371 协议测试通过不能自行解除该门槛；只跟踪观测所需依赖，不把 RFC-370 全部工作暗并入本 RFC。
- 退出证据：两仓 SHA、CS API 版本、实际部署摘要/配置修订、同一真实执行的 CS→AW 四桶/CNY 对账、撤权后无金额缓存、断连恢复日志。

### AW-R03 调用入口与驱动覆盖〔部分实现；P0-T1/T2/T4、AC02/04/06〕

- 对单节点、多 Agent、fanout/聚合、loop、工作组回合、子任务、自动提交/合并、playground、memory 等入口逐项登记“有调用/受理身份/持久来源/可查询”的证据。六个主执行调用点已有受理接线，其余入口不能只因 purpose 枚举存在就算接通。
- OpenCode 固定版本验证根/子会话、resume、fork/clear、迟到模型、崩溃后最终补采；Claude 补实际 provider/model、最终输出、累计含子 Agent 与恢复基线证据。未知 provider 保持未定价。
- 依赖：各入口 owner 合同、固定协议样本；实际模型调用使用单独批准的验证资源。
- 退出证据：逐驱动/入口能力矩阵、真实样本及异常样本、独立/托管适用性、重放不重计与所有失败/取消消耗保留。

### AW-R04 模型、工具与原生子 Agent 片段〔尚未闭环；P2-T1、AC02/04/08〕

- 增加真实调用级 span 的持久身份、父子关系、开始/结束、实际模型、工具结果与质量；模型调用、工具、原生内部 Agent 可从尝试下钻。
- 与已有数值账本关联而不形成第二套 Token 加法；重叠父子、缺结束、仅聚合来源、旧 driver 分别降级。
- 依赖：AW-R03 的版本化能力和 owner 边界。
- 退出证据：多层子树、重复/乱序、失败/取消用例；真实可展开泳道、键盘选择和统一 Dialog；无证据的片段不绘制。

### AW-R05 任务 direct/subtree 与权限〔基础权限已有，树形范围未闭环；P0-T5、AC03/04/07〕

- 将单任务直接贡献、可见后代贡献与任务树汇总明确区分；跨任务/Agent 页面可以往返，并保留范围。
- 每个后代由任务 owner 授权，隐藏后代不能通过总额、样本数、排行或缓存泄漏；同一叶用量只归账一次。
- 依赖：执行树的稳定关联、AW-R03/04。
- 退出证据：多层子任务、跨仓共享、撤权和部分可见树的数值/缓存负测；任务、Agent、系统用途合计可解释。

### AW-R06 生命周期样本与真实窗口消耗〔当前仅 started；P1-T1、AC02/05/09〕

- 现有柱状图表示按任务开始时间选择的生命周期消耗。补独立 occurredAt 窗口消费视图，不能仅改标签。
- 跨日任务、迟到修订、累计量没有可证明发生时间时进入“时间未分配”；时区和夏令时边界一致，已有柱上精确 Token 保留。
- 依赖：完整时间来源和版本化查询/URL 合同。
- 退出证据：生命周期与窗口两套手算对拍；日桶之和、未分配池及任务贡献对齐；未知时间不按接收时间伪造历史。

### AW-R07 时间分解、关键路径与执行对比〔基础区间已有，精细分析未闭环；P1-T3/P2-T3、AC05〕

- 补真实排队、准备、人工等待、模型/工具活动区间；区分墙钟、活动并集、累计占用、业务等待，工作组回合不算技术重试。
- 有因果依赖且覆盖完整时才计算关键路径；补同口径执行对比和性能分布，保留现有分位数及样本量说明。
- 依赖：AW-R03/04 的实际时间与依赖事实。
- 退出证据：6 Agent/8 次尝试、并发/重试/等待的逐段公式对账；缺依赖不给伪精确关键路径；完成态与运行态分布分开。

### AW-R08 分析维度与可理解下钻〔分布已有，筛选链路待补；P1-T1/T2、P2-T2〕

- 第一批原受理名/运行时任务贡献的实现 v2 独立 PASS，39 路径精确推送 `df87010886452d1b88b8c236869ea51b52fcb148`；[Windows 36822983873](https://github.com/wangbinquan/agent-workflow/actions/runs/36822983873) 的新增夹具类型及 task detail 运行时成员错误已按独立 PASS 的最小设计修复并推送 `ed2cd483dc74c5f73bfba9e6530f7f64d1e09a98`；新主 CI 为 48 success / 2 failure，类型与十个浏览器分片已通过；迁移历史单用例默认预算补正、卡片几何同快照修正及最终 SHA 的九种定时配置继续验收。公共 Dialog、原范围和滚动焦点返回、双 provider/hosted 浏览器回归保留；TaskDetail 运行时组复用同一已授权原快照。名称不读可变目录，旧响应不借任务总量。[第一批设计](./runtime-contributions.md)记录范围与真实失败；`runtime` URL 只控制弹窗，服务端维度筛选与模型/用途下钻尚未完成，AW-R08 不关闭。
- 核对并补齐运行时注册项/修订、实际模型、采集来源、用途等维度的服务端筛选与任务贡献下钻；当前名称/状态/仓库查询保留。
- 通过相关图表或明细的直接操作进入范围，不恢复顶部工作流输入或“更多筛选”折叠。人民币配置复用现有入口，不再建一套价目表。
- 退出证据：URL 往返、清除范围、双语、未知名称/模型、删除档位后历史归因、分页总数与当前可见范围一致。

### AW-R09 异常与采集质量闭环〔基础状态已有，规则未闭环；P1-T4/P2-T4、AC06〕

- 对缺量、延迟、冲突、未定价、重试放大、人工等待与工具超时补规则来源、窗口、最小样本、持续时长、去重、恢复和证据下钻。
- 异常详情进入公共 Dialog/独立页；不恢复已删除的“需要关注的任务”长卡片。
- 退出证据：触发/抑制/重复/恢复以及权限测试；断连和采集迟到不冒充任务执行失败。外部通知投递不在此清单中默认启用。

### AW-R10 历史维护、重估与保留〔已有原生修订，管理闭环待补；P0-T4、P2-T2〕

- 原生迟到修订已可按原归属处理；另补受控历史回填、投影重建、价格纠错的影响预览与审计回执，禁止覆盖原始证据或悄改冻结原价。
- 明细/小时/日保留与删除语义按设计落地；30/90/365 天为设计建议，生效前明确配置与容量。权限关联和撤权不能因 rollup 失效。
- 退出证据：幂等恢复、水位与源对账、原价与重估分离、legacy 不提升完整性、删除/撤权、到期与任务可见性回归。

### AW-R11 规模、分页与大泳道〔预算未验收；AC08/09〕

- 100K 任务/10M usage 的 SQLite 与 PostgreSQL 分别测：七天 warm P95 <1s，任务概要 <500ms，首批 200 片段 <1s，初始 <300KB gzip。
- 大范围使用有界分页和可重建投影，超过 1K lanes 的虚拟行及缩放/键盘/滚动恢复验收；不能用截断后的小样本总数冒充完整平台总数。
- 退出证据：固定数据集与脚本、查询/写放大/资源预算、两 provider 报告。遵循 AW hosted-CI-only 约束，不在共享本机偷偷启动全量服务或压测。

### AW-R12 最终验收与交付〔待以上依赖；AC01～10〕

- 独立/托管、SQLite/PG 的适用组合逐项列明；真实运行与 mock/原生 SQLite 夹具分别记录。
- 正式页完成中文/英文、明/暗、390/768/1440px、长名称、空/错/部分、键盘和末行焦点、URL 返回、断连/恢复；复核卡片间距与公共样式。
- 退出证据：验收矩阵无悬空项、精确 SHA 终态 CI、部署/版本和残余限制；真实身份与资源操作的待授权项单列。全部必需项完成后才将 RFC 与目标记为 Done。

## 明确不作为本轮剩余工作

- 已取消：CSV 及异步 CSV、关注任务卡片、顶部工作流输入、“更多筛选”。历史导出方案只保留为记录。
- P3 另行细化：SLO、交付质量、OTel、长期运营报表；不因名称出现在全景里就算本轮缺陷。
- 不默认启用：外部通知、自动停止任务、自动扩缩、自动调模型、账单结算。
- 原型功能不直接复制为正式能力，必须先有对应真实来源与验收。

## 回执模板

每完成一项，在本节追加：任务 ID；实现范围；源码提交完整 SHA；独立功能门；相关测试/精确 CI URL 与终态；真实运行或夹具边界；部署版本（适用时）；未覆盖项。没有证据只更新“进行中”，不打完成勾。

## 2026-09-30 当前检查点回执

AW-R01 功能检查已通过：浏览器修复 `ee1af6da15b827e32ea0e15557f79ccd47e2f6b9` 是当前 `fb53e21542e38e866cd508cfa6b105b50eea3895` 的祖先，中间仅 STATE/总计划文档变化。精确 CI 36624953215 已终态，48成功/2失败；十个浏览器作业、类型、数值同步与功能作业通过，静态扫描及汇总失败仍是整体CI关闭依赖。没有读取扫描日志，也没有本机AW测试。

关联 CS-R02 的 Runner Stage 1 底座已精确推送 `fc491a4d6b31c6476d3222209ced880810936c3e`；独立功能门PASS，修正候选完整4226 pass/142 skip/0 fail、41路径指纹未变，首轮旧导航异步断言失败与修复历史保留。[CS CI 36640100860](https://github.com/wangbinquan/CrewStation/actions/runs/36640100860) 进行中。该提交没有开启生产开发采集：Session PG/outbox、owner固定原键与CNY价格/排空、两级正式明细尚须接通；当前本机平台仍是94aabd6d。AW-R02的托管准入、实际联合对拍和AW-R03～12仍未关闭。

## 2026-09-30 剩余工作与关联 CS 当前回执

AW 文档后继 `7bc79b8ecb0a3632dea79c705a491a12d2b9caf3` 自 `5681ca12055c654922db556aec906c9de6d19476` 只变三个观测文档，源码和加载修复保持一致。[精确 CI 36646022107](https://github.com/wangbinquan/agent-workflow/actions/runs/36646022107) 已终态 failure：48 success / 2 failure，十个 Playwright 和功能检查通过，失败仅静态扫描及 `CI required`。本轮只刷新元数据，没有读取扫描日志或运行本机 AW 测试；AW-R01 的整体关闭依赖保留。

CS 的 Session PG/outbox 底座 `1326fdd1ac3a0fdd0205bc0e4857a4423cc7df9d`、owner 稳定受理底座 `8d2e547adc3251ab3307b61b3faa5134ed08aa67` 均已精确 CI 六项成功及本机部署。当前本机版本为后者，2026-09-30T01:20:19Z 八组件 Ready=1、storage-contract=1；生产开发采集仍关闭，不能视为项目开发消耗已接通。

CS 双路径数字布局/固定元数据候选 `bc8522cb7c98a6ef308065a5b5821ce181775ad9` 已推送：独立功能门 PASS，完整 4288 pass / 142 skip / 0 fail，23 路径指纹一致；[精确 CI 36657789922](https://github.com/wangbinquan/CrewStation/actions/runs/36657789922) 与本机部署待回执。其实际原生来源证明（最终 Hook 环境与临时 HOME、复制/替换沿革）及原键持久停止（取消等待窗口、迟到 Start、重启恢复）还未实现，已单列于 CS-R02 及 development-owner 文档；后续 owner 派发/全清理屏障、consumer、两级事实和 UI 仍待共同接通。

AW-R02 仍需 RFC-370 owner 的托管准入及真实 CS→AW 对拍，不能由上述底座或测试自行关闭。AW-R03～12 与真实身份/模型授权依赖继续；不恢复 CSV、更多筛选、关注任务卡片或顶部工作流输入。两 RFC 保持 In Progress。

### AW-R01 CI 与定时配置新版本修复（2026-09-30）

用户本轮要求修复主 CI 和定时 CI，根因与全部九个定时配置、现有修正祖先和退出证据已写入[CI 修复记录](./ci-recovery.md)。fast-uri 已升 3.1.7、锁文件只更新该包；主 CI 和全部目标配置的最新版本结果仍待回执，AW-R01不提前关闭。此前只读扫描元数据的记录保留为历史，不把旧 SHA 红色运行改写成绿色。其他 AW-R02～12和 CS 剩余范围继续。

### AW-R01 第二轮 CI 根因及修正候选

ef28b3a14d3d4e536096df4fea4f9c6468104622的CI36665459531终态47success/3failure：fast-uri已消除，新增brace-expansion两主版本公告及RFC185真实PG启动前少一次调用。仅更新两条兼容主版本锁，并去掉host mint的多余nonce回读；新增双provider持久/回滚/SQL形状回归，旧三成员全部断言保留且补错误诊断。本机不跑AW测试/类型/构建/服务；独立限定复核、新SHA精确主CI及九个定时配置仍待验收，七个旧候选定时success不冒充新候选通过。详见[逐项CI修复](./ci-recovery.md#第二轮-ci-候选传递依赖与启动回读2026-09-30)，两RFC不关闭。

第二轮八路径静态复核已PASS。旧full四分片success但价格版本GET/POST未进入真实访问账本；旧WebKit在macOS趋势键盘失败，另有在线点首轮失败。追加实际浏览器CNY保存/历史/刷新旅程、原生Option+Tab遍历及同步presence生命周期/受控恢复回归；不扩大uncovered或降低任何断言。完整候选复核、新SHA主CI及全部九种定时终态仍待回执，详见[定时诊断](./ci-recovery.md#第二轮定时诊断真实价格访问与webkit生命周期)。

## 2026-09-30 AW-R01 最终关闭回执

`edd56ebe33731cb05aa7491b292be294a3026521` 精确主CI和九种原默认定时配置全部成功，共10运行/75作业；功能修复和独立复核、源提交、终态矩阵均在[CI修复记录](./ci-recovery.md#修复候选精确终态2026-09-30)。原失败历史完整保留。AW-R01关闭，其余11项AW和CS剩余范围继续；真实身份/模型/托管准入仍有独立退出条件，不把CI绿色当作真实执行验收。

### 2026-10-01 本轮 CI 修复完整终态

[最终修复精确回执](./ci-recovery.md#2026-10-01-最终修复的主-ci-与九种定时配置终态)：`a241fcf48420c363cf5c1255b4100a5dd113dd93` 的主 CI 50 项及九种原默认定时配置 25 项全部成功，10 个运行/75 作业 headSha 严格一致，含实际 full 覆盖对账、WebKit 双平台和 weekly/all PostgreSQL。独立实现 v3 PASS；原失败保留，未降低断言或性能门槛，未改 cron。九种配置是 workflow_dispatch，不冒充实际周调度；后继纯文档精确主 CI 单独验证，源码不变。原受理名/任务贡献第一批的本轮 CI 已恢复；服务端维度筛选、模型/用途下钻与其余 AW/CS 工作继续，AW-R08 及两个 RFC 不关闭。

## 2026-10-01 分类 Token 与返回入口精确 CI

`eef12e256408a54d5e52c351c23e4ebea9fdeb32` 的主 CI、Windows 与八条定时工作流的原默认手动矩阵均终态 success（十运行 / 75 作业），见 [CI 修复回执](./ci-recovery.md#分类-token--紧凑返回入口的精确-ci-收口)。返回使用公共 PageHeader.back + 小型 ghost 按钮，实机返回保留原自定义时间 / 搜索 / 状态；CI 的返回几何矩阵已通过。分类趋势夹具未知 / 部分 / 完整证据均保留。此前失败和取消历史不覆盖，九种定时配置的源码不变。AW-R02～12 与两个 RFC 继续；CS 专用档位真实分类 / 人民币验收被平台自测哨兵归属问题阻断，修复与六项 CI / 本机部署后续单独验收。

## 2026-10-01 共享主干 CI 与 CS 实采对账更新

观测回执 `993ab7ce` 的主 CI 取消 / 失败历史保留；共享 RFC-370 配套两轮修正后，`ce8a6310adb9576559f4d5100d4916635a104720` 的 主 CI 36876744628 50 项全部 success，同 SHA OpenCode 集成及 Git 协议亦 success，见 [共享后继终态](./ci-recovery.md#文档后继与共享主干-ci-的实际终态2026-10-01)。分类 / 紧凑返回的 EEF 十运行 / 75 作业证据保持独立，未以旧绿替代新 SHA。

CS `85ee9254a175848d65105d16327e00afbc47cc08` 平台自测准入修复已推送、自身六项 CI success 并本机部署；专用 revision4 的标准自测及三次真实模型分类 / 人民币 / 时间对账通过：输入 5,917、缓存读取 17,728、缓存写入 0、输出 778，总 24,423、验收人民币 ¥0.026922，任务 / Agent / 算力 / 项目 / 系统 / 趋势一致。此前系统提示 false / 412 与命令验收脚本字段误读保留；同镜像 / 同修订的新标准自测证明能力后才调用模型。项目费用政策保持隐藏，真实页面复验待解锁。这是 CS 原生业务实采，不是 CS→AW 托管装配对拍；AW-R02～12 和两个 RFC 继续。

### 2026-10-02 当前共享主干的精确 CI 边界

后继 `2d65a16f` 主 CI 为 38 success / 12 failure；原 owner 的 `a4b706b942adfc9ca16c15e329ba1f7fa97f78f8` 已推送修正，本次记录时主 CI queued、实际 schedule 视觉回归 success，见 [后续守卫回执](./ci-recovery.md#2026-10-02-共享主干后续守卫失败与修正状态)。CE8 和 EEF 的既有成功仍只证明各自候选，当前主干不能提前写成全绿。CS 六份实采回执已发布为 `e15ca72238199eb59566dccfabfea4c452cbf9e5`，其 [精确 CI 36886631033](https://github.com/wangbinquan/CrewStation/actions/runs/36886631033) 六项 success；开发生产采集关闭、托管联合对拍及页面验收等未覆盖范围继续保留。

## 2026-10-02 AW-R08 服务端维度范围设计

[维度范围与下钻设计](./dimension-drilldown.md)冻结实际模型/运行时/Agent/用途/采集来源的交集、同快照贡献口径、未知归属及 Task owner 逐条 opaque continuation。既有 runtime Dialog URL 不改作筛选，顶部不恢复更多筛选/工作流/CSV；真实任务详情保留紧凑标题旁返回。原语 census 已完成，精确独立设计门待验，本片尚未改源码。共享 Task public query 的 RFC-370 在制输出保留，发布依赖准备度独立核验；AW-R08 与两个 RFC 不提前关闭。

### AW-R08 设计 v2 的失败闭环

v1 独立设计 FAIL 原记录保留。v2 为新模型 Dialog 精确登记公共调用并扩展原返回 hook；半读预算耗尽以不带 subtotal 的未确认 Task 行与真实 owner position 原子推进；官方生成的 RFC-294 status 与 12 份 JSON 同批冻结和提交。allowlist 38 路径、源码尚未改，待 v2 独立功能门通过后实施；不把设计修订当验收完成。

### 2026-10-02 AW-R08 维度源码与回归候选

独立设计 v2 PASS 后，Task owner 逐项 opaque continuation、维度交集和贡献投影已实施；半读预算返回原授权事实的未知行并原子推进，模型范围撤掉全调用零证明。新模型 Dialog 及原返回 hook/AST 登记同批更新，真实 SQLite/PG、组件与 390/768/1440 中英明暗 hosted 浏览器回归已写入。精确格式/lint通过，无本机 AW 测试/类型/构建/服务。共享 Task 配置 owner 尚有未提交依赖，完整官方登记、最终实现门、发布和 exact-SHA CI 继续等待依赖准备；全部并行输出保留，不把这次候选记作 AW-R08 完成。详见[候选边界](./dimension-drilldown.md#v2-设计通过与源码候选2026-10-02)。

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

### 2026-10-02 CI 与原生分类消耗的最新边界

`b339e7e06e13c7b4456cc1bf928048c7fc0262a3` 的主 CI 50/50 与九类默认定时工作流全部 completed/success（十次有效运行、75 个成功作业），原失败/取消与 Windows 同 SHA 替代记录完整保留。具体链接及原审批 POST 顺序证据见 [CI 复验回执](ci-recovery.md#2026-10-02-原审批时序与默认-ci-矩阵复验)。mixed report 原根因仍未确证，不因稳定复验编造功能修复。

三个真实原生任务的新只读核对仍为 47,524 Token＝输入 36,260＋缓存读 8,832＋缓存写 0＋输出 2,432，验收费率人民币估算 ¥0.096392；没有新建任务或修改费率/可见性。Mac 当前锁屏导致最新正式页面几何/焦点验收待续，CS 旧 API 会话返回 401，待恢复同一身份后再核对最新部署；不得以旧截图/数据称为新验收。父结束作业、全部原容器退出证明、完成后重建绑定/公平恢复、正式开发 producer 及 AW/CS 托管联动仍须完成，RFC 不标 Done。

### 2026-10-02 正式页面与 CI 最新接续

实际浏览器已解锁并完成本机 AW 正式页复验。任务追踪名称为无边框文字；详情返回为标题上方的短入口，返回保留原筛选并聚焦原任务；移除项没有重新出现。真实顺序任务 `01M3VG8XWABNJ4FQ9JFXSM1G8P` 显示 19,545 = 12,941 非缓存输入 + 5,120 缓存读取 + 0 缓存写入 + 1,484 输出，验收专用 CNY 估算 ¥0.040314，两 Agent 分别 9,349 / 10,196，与原实采回执一致。费用仅为明确标记的验收配置，不代表供应商账单。截图与 AX 留存在本机临时验收文件；本轮尚未新增实际窄屏与主题证据。

`c843938a` 的 CI36985769914 终态 failure，48 success / 2 failure；Markdown 作业遇到 OpenCode 固定来源的 GitHub blob 503，另一个失败为汇总作业。官方同 SHA raw 源码已只读核对；本会话追加的引用现按 `CLAUDE.md` 改为纯文本路径与行区间，详见 [CI接续](./ci-recovery.md#2026-10-02-opencode-固定来源链接接续)。共享文档的并行来源说明保持。原失败保留，新候选仍需独立复核及自身 CI；不得以 b339 的历史 75 个成功作业替代当前提交。CS 原父退出与重建当前为本机源码/隔离 PG 验证，生产开发 producer OFF；其他 AW-R02～12 与 CS 剩余范围继续。

### 2026-10-02 当前 Promise lint 修订

`6f506e0d` 精确 CI 的文档检查已成功，但 Promise lint 失败后其他任务取消，未关闭 AW-R01。本会话仅补初始化重配返回值的明确忽略标记，保留并行 RFC-370 代码及同步旧入口/异步初始快照语义；等待本修订独立复核和自身托管 CI。默认定时矩阵的新增完整 E2E、PostgreSQL 成功与被取消历史分开登记在 [CI 修复记录](ci-recovery.md)，81d6 默认矩阵已全部终态：7次成功、3次取消，整套仍未关闭；本修订固定SHA默认矩阵及自身CI接续核对。RFC 保持进行中。

### 2026-10-02 主 CI 精确接续

原 `3bf8cc6c` 主 CI cancelled；同 SHA 九类默认定时检查已全部 success（25 成功作业）。后继 `ba47e5d24c4f8f95f27defb82545ea1766b0e7a9` 的主 CI `36997889808` failure、46/50 success：两个后端分片均由初始化 `void` Promise 无拒绝处理守卫报出，另有一个测试监听器标识的 gitleaks 误报及汇总失败。详细原错误与修订边界见 [CI 接续](./ci-recovery.md#2026-10-02-当前主-ci-的两项精确修正)。共享刷新文件的 Promise 拒绝处理输出完整保留；仅原测试行/历史指纹作精确标注，不放宽 W5 或扫描规则。本修订 SOURCE、精确远端主 CI 待完成，AW-R01 不关闭；托管实采、CS 全入口/CLI/平台测试与两 RFC 完整验收继续。

## 2026-10-02 已退出 leader 的遗留进程组清理

`9e8db61f0a96f43026e9614547e436cfb91aab61` 的 [主 CI 37012684652](https://github.com/wangbinquan/agent-workflow/actions/runs/37012684652) 已 completed/failure，44／50 作业成功。三种实际失败分别为组合根登记、Intent offered DAG 及 macOS5／6 的已退出 leader 遗留管道用例；原失败／日志完整保留。前两种架构修复由原会话通过后继 `7b64eb1f0` 等提交发布，不扩大账本或收编未交接文件。

管道用例中，原运行器在 leader exit0 后等待 1000ms，再 TERM、完整 50ms grace 与 KILL；1600ms 的孙进程存活标记实际出现。本修订仅把真正的 post-exit 管道等待收紧为 250ms，原活跃 leader 的 wall／idle timeout、TERM／KILL 顺序、完整 killGrace、无条件整组 KILL、输出缓冲与部分结果、退出码及 interrupt 策略均保持。日志本身不足以还原精确 OS 调度时序，最终修复判断交本提交完整托管 CI。

独立 DESIGN v1 的 P2／FAIL 保留：短窗口加原 650ms 等待会早于 1600ms marker 到期，只断言“文件没有出现”会使负例失去判别力。修订 v2 已独立 PASS；原用例增加实际 detached leader 的 PGID 日志、严格唯一解析与 safeInteger>0 断言，原 650ms 等待后以 `process.kill(-groupPid, 0)` 探测原整组。存活即失败，只有实际 Error.code===ESRCH 可判原组不存在，EPERM／其他异常继续抛出；原 marker 不存在和两项 <2s 断言全部保留，1600ms／650ms／10s timeout／50ms grace 不变。该观测不向后代发送额外终止信号，也不添加重试或 skip。

四路径代码／测试／文档已落地，限定格式／lint、逐字逆变换证明、独立 SOURCE 与本提交精确 CI／原默认定时配置继续验证。本机没有执行 AW test／typecheck／build／E2E／服务。两个 RFC 仍 In Progress，其他产品和跨仓验收继续。

### 2026-10-03 原生调用片段与泳道实现接续

[原生片段设计](durable-span-facts.md) 独立 DESIGN v3 PASS（原 v1/v2 FAIL 保留），本地业务 runNode 的元数据留存、原生来源扫描、旧受理能力保持、A/B 续跑原属、ACK 后 Task 来源分页、任务片段 API 与正式泳道组件已落地。模型详情复用原贡献与人民币费率，分别展示非缓存输入、缓存读、缓存写、输出；工具/原生 Agent 不重复添加 Token 或费用。未知原生时间不借任务全长，冲突证据让原片段保持 unknown；异步查找不直接写持久状态。

精确 47 路径格式/lint 通过，45 个 TS/TSX 的 AST 语法无诊断；没有本机 AW 测试、语义 typecheck、build、E2E 或服务。真实 SQLite/PG provider、原生时间/归属、帧内 cursor、水位、Actor/attempt、旧 replay、Runner 接线与组件 URL/焦点回归已经写入但尚未执行。独立 SOURCE、官方架构登记、精确远端 CI 与新正式页面验收待完成。

227c 主 CI 的 44 success / 6 fail 保留，其三个实际缺陷由原负责会话按职责提交修正；新 SHA 的验证须独立等终态，不能用原定时矩阵或旧数字对账代签。系统 Agent/smoke/CLI/自测的原受理与采集尚未闭合，CS 托管 spans 与生产开发采集的全 writer/inflight、unbound/unknown-tail 仍继续。AW-R03/R04/R09 和两个 RFC 保持 In Progress。

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

## 2026-10-03 完整 EOF 底座接续

用户要求统计不能漏任何一条。任务、调用、用量、采集分别沿原 owner 游标读到真正 EOF；单页大小、排序块、合并路数和缓存容量只限制一次传输或内存占用，不限制总体数量。新底座保留原身份，在专用原数据库快照的 TEMP 工作区内进行稳定外部排序、四桶覆盖选择和逐条派生分配，尚未切换正式接口和页面。

完整 SOURCE31 v2 已独立 PASS，原 v1 的并发 P2/FAIL 保留。内存 SQLite 的 TEMP 创建、工作和清理已全部进入原 snapshotRead 同一租约；新增真实双 provider 的并发报告、既有 owner 事务、失败/取消后续报告和临时数据隔离回归。文件路径使用实际原 WAL 文件，PG 使用原 pool 的一次 reserve。源码本地提交 `9d539605a6c35c4fb6ef223aaae8b0280445189f`，此段不证明其 hosted 行为、远端发布或正式页面已完成。

原官方 scoped census 在该 source SHA 上生成完整 13 产物，排除并保留他人 EmployeeCase/CI 在制源码；报告只读尝试和缺少 seed 增长的静态 FAIL 均保留。纯治理投影复用生成结果，仅登记五项实际增长：mutation 1826→1829、observed imports 5809→5814、exceptions 5167→5171、symbol owners 25932→26021、physical SQLite fixture 文件 319→320。原 scanner、规则、40 required SPI、304 debt、target 69、273 inbound/31 outbound、background 352、public 1056 与 ambient 501 不变。SOURCE digest `sha256:15e57a059a299e942017fa56f89c6a025ebb98955013158876b8246da9639a79`；129 原库存静态核对通过。增长回执需在匹配 canonical 提交后由正常后继提交退役。

正式报告构建、分页缓存/接口、页面切换、native v2 的完整基线与原完成证明、100K Task/10M usage、真任务四桶/人民币和新 exact-SHA CI 仍待。既有正式链路的截断仍是待修缺陷，不能称为完整统计，也不能以本次底座 SOURCE 或旧真实任务回执替代新全量验收。CS 开发 producer 保持 OFF，两个 RFC 保持 In Progress。

### 2026-10-03 全量报表正式入口与分类呈现候选

全量报告底座 SOURCE58、完整来源筛选 SOURCE6、三个正式启动根及 HTTP SOURCE6、UI v3、原始 Worker v2 和移除新增值循环的 SOURCE4 已通过有限独立功能审阅。保留此前 UI、Worker、循环检测的失败候选和回执。正式 SQLite/PG 根接入同一原始提供者的快照与 Worker；既有统计 GET 别名转到完整报告状态，未完成报告不返回数值小计。报表生成先遍历所有原始任务与来源到 EOF，再作筛选和精确整数分类累计；每页传输量和列表展示量不会截断来源集合。分类为输入、缓存读取、缓存写入、输出和总 Token；费用保持人民币，验收费率仍只代表明确标记的验证配置。

UI 保留完整报告身份和各节分页位置，任务贡献与原始调用/分配记录使用同一报告。趋势图保留实际 Token 数值并显示可键盘聚焦区间的四类精确数值；返回按钮复用公共样式。完整任务从筛选上下文打开时按任务自身整体构建，返回后恢复父级筛选、报告和页码。原正式任务弹窗的返回焦点回归保留原测试预算，修复实际任务行稍晚挂载时提前消费恢复状态的问题。新增真实原始 SQLite/PG Worker、全量筛选及 UI 回归已写入，尚未以本机测试执行来代替托管 CI。

原官方 AST 在已发布 15b31c26aff56d2a8dd3dff2afd73620b4457654 加 84 个精确候选路径上生成 13 产物，排除并保留他人的未提交来源。此次候选已修复首轮检测出的 Stage/Store 值循环，没有新增 SCC 许可。实际九项库存增长为 mutation 1837→1847、transaction callbacks 261→267、background 356→358、ambient 501→504、observed imports 5837→5915、exceptions 5191→5263、public 1060→1063、symbol owners 26136→26308、真实 Tab 调用点 20→21；原扫描规则、40 个 required SPI、304 条债务、target 69、273 inbound/31 outbound 和既有字段预算保留。sourceDigest 为 sha256:e905c2396180e79ff9021144da18caaba6ada859029e579054b9c1e2fabe3585。增长理由仅登记实际新条目，匹配 canonical 提交后的正常后继提交需退役这些一次性回执。

这批候选仍待正式发布和新 exact-SHA hosted CI，不能据源码审阅宣称线上已全量。现存原生用量 v1 的会话/步骤/parts 上限、完整基线及 durable v2 完成证明、追踪的调用/尝试和页数上限仍须落地消除；100K Task/10M usage 的实际性能、真实任务四桶/人民币与浏览器验收继续，AW 默认定时 WebKit 功能失败仍需修复。CS 786489b859062dd77a0c4278eb937882d4839f69 的 CI 37130953072 六项已全部成功，包括实机 e2e；新的 emptyDir 写入权限修复和约定八组件本机部署由必要部署依赖会话继续，实际运行版本与新任务验收待交接。两个 RFC 保持 In Progress，CS 开发 producer 保持 OFF，不把历史任务证据当作新全量验收。

### 2026-10-04 全量报告已发布，继续消除原生与追踪上限

上述 SOURCE/META 候选已通过精确共享主干发布进入 0294e8de8a8660a3170a2600f60c7876506ddf81，98 个文件的暂存和提交内容逐一匹配，推后 main 与 origin/main 为 0/0，共享 index 为空，无关在制改动保持。对应主 CI 37135042998、Windows 37135043001 和默认触发的 visual/maintenance 定时作业已启动，尚不能据启动状态宣称通过。原正式统计别名和新正式页面已进入远端源代码，实际服务版本和行为还待新 CI 与真实运行验收。

按原 RFC-317 高水守卫，在正常后继候选中仅退役匹配的九条一次性 allowGrowth，129 个库存的数值、全部规则、SPI、债务和分类判据不变；使用原 provenance 函数记录实际已发布祖先。本次退役复用原 AST 结果，无新扫描或本机 AW 测试。原生采集 durable v2、完整基线和 EOF 完成证明、执行追踪无总页数上限、真实规模及真实任务验收继续；不声明所有限制已去掉，不开启 CS 开发 producer，不关闭任何 RFC。

### 2026-10-04 完整报告的首轮 CI 缺陷修正

已发布 0294 的主 CI 37135042998 已 completed/cancelled，13 success、25 failure、12 cancelled；保留全部原失败日志，不以取消或局部成功代签通过。此次十二路径候选修复真实类型/导入/合法内部 Task 夹具、Vite 源码读取与标准断言、公共空状态/趋势 CSS，以及真实页签的唯一标识和 Tab/panel 双向关联。W29 保留全部原 normalizer，直接读取已发布 15b31/47773 证明 PG 两个新增声明、原五个 control/event body 及 SQLite deps 49；只按完整报告真实接线更新 PG 170 和两个摘要。新增 daemon-only report 选择保持三个原分支，并独立精确断言 unstarted fixture 的唯一空分支。首次审阅发现的 Tab/panel 不一致保留，后继增加实际关联断言。原业务断言、预算和治理规则不放宽。

原官方 scoped AST 只扫描 committed 47773 加这十二个冻结路径，排除并保留 prompt/memory 的未提交输出；原生成结果复用于四份 provenance 投影，不重新扫描。13 产物、129 库存静态核对通过，所有库存数值保持，无新增增长许可；sourceDigest 为 sha256:ef43059cd7a0c4a8934cf65c09265c35531432b34258794898ce7d8107ff668e。首次私有无 write 调用只输出 report、未形成完整产物，原记录保留；首次 provenance 静态失败四项也保留。没有本机 AW test/typecheck/build/service，正式行为仍待新 exact-SHA CI。

其余实际 CI 缺陷继续逐项修复：新增报告表的迁移/归档/schema 投影、原生数值映射及原生产事实接线和 E2E，不能据本批称主 CI 全绿。CS 目录权限修正 d2ab5f349d20a3d24fe564b27024b5ec4dec90e7 已发布；该提交的真实 module 10001 行用例有 65002ms hook 超时，另五作业不能代签失败，新八组件部署仍未执行。完整 native v2、追踪 EOF、100K Task/10M usage、真正任务四桶/人民币及正式浏览器验收继续，所有人口上限尚未清零，两个 RFC 均保持 In Progress。

### 2026-10-04 完整报告 CI 第二批修复与剩余上限

已发布 0b8910ab8d88fff0df68dad416169895d6fc1165 的主 CI 37139017700 已 completed/failure，26 success、24 failure；完整原失败日志和第一批失败回执保持。第二批 SOURCE25 v2 独立功能审阅通过：原始报告计数保持十进制字符串，实际写入量使用原计数行 CAS；原 visibility 前缀改用精确前缀比较，报告身份继续绑定实际有效权限与 accessRevision；Worker 异常拒绝和完整 drain 保持。真实 PostgreSQL 夹具使用原 native driver，只在三项明确 cleanup ACK 故障中注入失败，不伪造 SQL 行。五张真实派生缓存表使原 roster 变为 208 source / 202 active，六张 archive-only 名单不变；迁移头、路由、hash builder 与实际 provider 分支登记相应更新，原断言与预算保持。

首次 META v1 发现 provider-aware 构建入口目录不符原规则，原 FAIL 保留。后继实际把入口移入既有 platform/persistence，两个正式根和两个测试只改对应 import，完整保留 489919 已提交的并行 Task 输出；没有放宽 relocation matcher 或增加债务。原官方 scoped census 在 committed 489919 加冻结 SOURCE25 上生成 13 产物，四项 provenance 使用原函数派生，129 个原库存静态核对通过，零新增长许可。schema 格式化后的原机器语义和完整有序人类 ledger 通过原静态比较；私有原字节差异诊断保持，不把格式差异写成逻辑失败。没有运行本机 AW tests/typecheck/build/services，新行为仍待本次发布后 exact-SHA hosted CI。

本批修复不是“所有限制已移除”：原生 Token v1 的 session/step/part 上限、完整 durable baseline/EOF 和原 owner 高水修订协议、追踪尝试与调用页数上限、原任务/算力明细交互恢复、100K Task/10M usage 实际性能、默认及定时 CI、真实任务四桶/人民币和正式浏览器验收均继续。完整数据未能证明时必须不返回数值小计，不能以传输分页冒充人口截断。CS 9b287d488916a6029fc2a433ca3522f03fdb3aa4 的精确 CI 37139454921 六项成功；本机约定八组件部署已完成并验证实际 OCI、236 migrations 和 spool 写入，但原 10001 行测试的性能余量、新真实任务与页面验收仍待。CS 开发 producer 保持 OFF，两个 RFC 保持 In Progress。

### 2026-10-04 原生完整 EOF reader 与 Worker 底座

完整汇总修复9b0ea034805001ef910d3a13464dca9a3e9b620a已精确发布，原主CI37146254800为completed/cancelled，9 success、1 failure、40 cancelled，不能写成通过。包含它的9bdc8323a99c0de2ca955ca0945ba063ef927382主CI37146579007为completed/failure，41 success、9 failure；原prompt测试补正由其owner发布37b9a84，六项观测E2E仍由本会话修复，旧日志保持。

原生新reader在实际SQLite只读快照中以磁盘TEMP队列和part/child keyset持续到真实EOF，无session、part、step或depth人口上限。session父引用、未完成step、未知四桶/模型/时间及不可用原源保留；计数与序号保持十进制字符串，只限制一页传输量。一个冻结pending页、精确ACK游标、前后与累计摘要和完整EOF指纹用于重送，Worker承担原native数据库读取并在失败/取消后等待实际退出。额外Worker入口加入真实单二进制编译清单，原streaming-hash规则只登记实际createHash消费。

SOURCE7首次FAIL发现JSON布尔值被SQLite转成0/1，原失败保留；只用原json_type的integer/real/text读取五个token字段，布尔/null/composite保持未知。SOURCE7-v2与最后SOURCE8-v3有限独立PASS，指纹31e3b9dab7b733c46bd279f75d538a81c9ab9f5fd840c59f6e1c671d65e76a9e。新真实fixture覆盖60002 parts（50001非数字、10001数字）、1025 sessions、depth80、冻结快照/重送/ACK、不同分页边界和实际Worker；原布尔语义按同一原SQLite读取器逐桶比较。测试已写入，尚未运行新的托管CI，本机仅定向format/lint和原纯AST/JSON/字节证明。

原官方一次成功AST在committed9bdc加冻结8路径生成13产物；初次private输入缓冲不完整和report-only遗漏write均保留，不当作成功。四provenance用原函数派生，129库存原静态核对PASS；五实际增长为mutation1849→1852、background358→359、observed imports5936→5944、exceptions5281→5289、symbol owners26329→26359。原规则、所有旧债条款、SPI和target保持；matching canonical之后正常后继退役一次allowGrowth，不重复扫描。后继37b9仅peer测试/文档，不改变本批生产与原规则输入。

这是尚未接入正式producer的采集底座，不能写成最大任务/调用等所有限制已移除。原owner的完整durable baseline/page ACK、原emission冻结与全部pending revision高水/原fence、原数值来源append同事务及v2完成证明仍须实现；原v1与追踪上限尚未移除。CS新0018吞吐候选的原10001/20025断言约21.12s通过，正式SOURCE/CI/部署待。本批还需精确发布和新CI，默认及定时E2E、真实规模/模型任务/四桶人民币/浏览器等继续，开发producer OFF，两RFC In Progress。
