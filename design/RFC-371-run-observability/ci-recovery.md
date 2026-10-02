# RFC-371 CI 与定时工作流修复记录

更新：2026-10-02。本页属于 AW-R01 的 CI 接续与历史关闭证据；两 RFC 的产品剩余范围继续按 remaining-work.md 实施。用户本轮明确要求修复 AW CI 和定时 CI，因此本轮读取失败步骤与日志定位根因；此前仅记录扫描元数据的历史保留。

## 2026-10-02 当前后继检查与固定源码链接修复

观测文档提交 `e8c9d73b13bf467c2e56b9abe2d9baf2f4765797` 的[主 CI36977794334](https://github.com/wangbinquan/agent-workflow/actions/runs/36977794334) completed/failure，42 success/8 failure；其中并行已发布源码的类型和架构登记问题由原会话自行提交修复。其后继 `55b1104a812c247f692f5450b6738e299d437bc1` 的[主 CI36980700296](https://github.com/wangbinquan/agent-workflow/actions/runs/36980700296) completed/failure，48 success/2 failure：功能、类型、架构和浏览器作业通过，只有设计链接检查及 CI 汇总失败。两份原日志均保留，不能称这两个 SHA 全绿。

剩余三条错误来自 RFC-370 的 CrewStation 固定提交 `35cf5a475979cbf74fb324230173f55b4e1a0a75` 源码链接，GitHub blob 页面返回 503。该相关共享文件已由并行输出改为同提交、同路径的官方 raw.githubusercontent.com 地址；本会话完整保留这些改动并逐条核对 HTTP 200、返回字节与该 Git 对象一致，再按标准格式整理。未改变检查规则或接受 503，修正版仍须自身 hosted CI 终态。公开源码校验回执在 `/private/tmp/observability-aw-ci-primary-sources-v1.json`。

`b339e7e06e13c7b4456cc1bf928048c7fc0262a3` 的原默认矩阵 10 个有效运行、75 个成功作业仍只属于该 SHA；后继变化不重写这些历史证明，也不免除新提交主 CI。无本机 AW 测试、类型检查、构建或服务；两个 RFC 继续 In Progress，完整剩余范围见 [remaining-work.md](./remaining-work.md)。

## 2026-10-02 原审批时序验收历史

`d185ebfe8332c9951e1ad6416a9a2447417b2931` 的[主 CI 36961953982](https://github.com/wangbinquan/agent-workflow/actions/runs/36961953982) 已 completed/success，50/50 作业成功；同一 SHA 的[默认 WebKit 36962140176](https://github.com/wangbinquan/agent-workflow/actions/runs/36962140176) 已 completed/success，Ubuntu/macOS 八分片均成功。该 SHA 包含 `bbb545851a5dc4c5328ff005a82b196cdedf5d28` 的 mixed workflow 失败 lineage 诊断与 RFC-370 会话修复的精确 composition 17/16 数量基线；正式规则与强度保持。其他八种默认定时配置此前的成功回执分别属于其记录的 SHA，不能写成全部在 d185ebfe 重新运行。

原 `e4d7dba7` 的 Chromium 与 `02940128` 的 WebKit 曾出现 mixed summary 缺少聚合报告；原失败保留。d185ebfe 的通过不能证明报告丢失根因已修复。诊断曾在首次 review 拒绝 POST 前增加一次 NodeRun GET，这可能改变实际触发时序。本次将相同的首轮 draft_review 身份断言移到原拒绝结果等待之后，复用既有 afterRejectRuns，不添加 GET、延时、重试或预算；所有失败 lineage/outputs、原流程、writer 次数、Prior Output、报告和最终审批断言保持。这个候选只恢复原触发顺序，仍须其精确 hosted CI 与默认 WebKit 验证，不作为业务修复。

无本机 AW 测试、类型检查、构建或服务。完整产品与 CS 托管实机联动仍按 remaining-work.md 的 owner 依赖推进，两个 RFC 仍 In Progress。

## 2026-10-02 并行归档测试的 Windows 类型修复

`d5b266c893d07694d5f9c19b24e3642ba6473d19` 的 [Windows36966192408](https://github.com/wangbinquan/agent-workflow/actions/runs/36966192408) completed/failure：backend Typecheck 在 `tests/rfc370-task-archive-content.test.ts:340` 报 TS2769，2,001 条事件夹具的 `kind: 'text'` 被 Array.from 回调推断为 string，与实际 nodeRunEvents.kind 严格枚举不匹配。该路径已经由原会话提交；本次只为这个字面量加 `as const`，实际事件、2,000+1 分批、顺序与原全部断言保持，不修改归档实现或其他会话在制品。目标格式/lint与独立 SOURCE 后交 hosted CI/Windows 默认流程核验，无本机 AW 类型检查或测试。

原审批时序恢复提交 `064abf30a75096295192a84785ba952224831138` 已精确推送；其 [CI36967523680](https://github.com/wangbinquan/agent-workflow/actions/runs/36967523680) 单独记录，若后继触发自动取消，保留状态及祖先证明，不能冒充该 SHA 通过。d185ebfe 的全绿仅属于它本身，当前后继须重新验证。

## 首轮基线与根因

- 当前基线 `f3bfc548fb25edfa95994e262730186820148f03`。[提交 CI 36658830125](https://github.com/wangbinquan/agent-workflow/actions/runs/36658830125) 终态 failure，48 success/2 failure。失败源是 dependency audit gate 的两条 fast-uri high 公告，CI required 随之失败；其余功能检查通过。
- 根清单已有 fast-uri 3.1.6 覆盖；本轮改为 **3.1.7** 并以 Bun lockfile-only/ignore-scripts 生成锁文件。仅该覆盖值、包版本及其完整性摘要变化。官方 [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) 和 [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g) 均列 3.1.7 为修复版本。本轮不增加公告豁免，不降低严重度或必需检查。
- 三类红色定时运行都在旧 `904ccfdaa0de41d63472d1a4c251a657a32857fa`：WebKit [36578655269](https://github.com/wangbinquan/agent-workflow/actions/runs/36578655269) 与 full E2E [36566313981](https://github.com/wangbinquan/agent-workflow/actions/runs/36566313981) 在 Node 加载 JSON 夹具时失败；空 route-hit artifact 与覆盖对账拒绝是前置失败的后果。Windows [36571611662](https://github.com/wangbinquan/agent-workflow/actions/runs/36571611662) 是三处 capture union matcher 的 TS2769。
- 上述 JSON filesystem 读取与 capture kind 显式收窄已经随 `8c6e9a0766a1a184170dec1e9685a07b580334e5` 合入，并已确认是当前 main 的祖先；本轮不重复改写或削弱测试。旧 SHA 的红色记录不伪改为绿，新版本的定时配置必须实际运行验证。

## 本轮必须核对的工作流

| 工作流                    | 频率（UTC）  | 本轮退出要求                                      |
| ------------------------- | ------------ | ------------------------------------------------- |
| maintenance-soak-nightly  | 每日 05:00   | 原 full 模式、默认规模和资源预算通过              |
| e2e-full-nightly          | 每日 06:00   | 四分片与 RFC-319 覆盖账本对账成功，route-hit 完整 |
| windows-platform          | 每日 06:15   | Windows 实际表面、类型、构建等全部成功            |
| e2e-webkit-nightly        | 每日 07:00   | 两平台各四分片全部成功                            |
| integration-opencode      | 每日 07:30   | 固定工作流默认协议集成成功                        |
| git-protocols-e2e         | 每日 08:00   | 既定 Git 协议矩阵全部成功                         |
| evidence-soak-nightly     | 每日 08:30   | 原默认证据规模与预算成功                          |
| visual-regression-nightly | 每日 09:00   | 原视觉矩阵通过，不批量接受差异                    |
| postgresql-evidence       | 每周日 03:30 | weekly/all 默认矩阵成功，真实 PG 证据完整         |

九个工作流保留现有 schedule、workflow_dispatch、权限、测试强度与失败汇总。本轮将复用该候选自动触发的等价运行，仅对缺少等价运行的工作流从 main 手动触发，逐个记录实际 headSha、run ID 和终态；不在本机运行 AW 测试、构建、类型检查或服务。每周 PG 最近 [36309246936](https://github.com/wangbinquan/agent-workflow/actions/runs/36309246936) 在 `a53425b87bc6fa124d74829c278f52059ca04c93` 成功，仍需本轮新版本验证。

## 当前状态与关闭边界

观测源码基线 `b339e7e06e13c7b4456cc1bf928048c7fc0262a3` 的主 CI 和九类原默认定时配置已全部 completed/success，共十次有效运行、75 个成功作业；这是历史矩阵通过，当前链接修正版仍待精确 hosted CI。精确矩阵及已恢复的原审批 POST 时序见[最新终态回执](#2026-10-02-原审批时序与默认-ci-矩阵复验)。mixed report 原根因仍未确证，下方原失败、取消与中间候选历史完整保留。分类 Token、人民币估算的新只读核对已记录；最新正式页面、CS 完整父结束链路与开发 producer、真实托管联动仍继续，两个 RFC 保持 In Progress。本次后继纯文档提交的精确主 CI 另验。

## 第二轮 CI 候选：传递依赖与启动回读（2026-09-30）

`ef28b3a14d3d4e536096df4fea4f9c6468104622` 的 [CI36665459531](https://github.com/wangbinquan/agent-workflow/actions/runs/36665459531) 终态 failure：47 success/3 failure。fast-uri 两条公告已消除；扫描又发现 brace-expansion 的两条高危公告分别影响锁住的1.1.18和5.0.9，已按官方 [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7)、[GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) 修复范围，在现有位置保持主版本升为1.1.20与5.0.11，仅两个版本/完整性摘要变化。npm注册表的dependencies与现有条目一致，frozen lockfile-only/ignore-scripts可解析；这只是锁文件核对，不是本机测试或CI通过。package.json没有新增直接依赖、豁免或跨主版本覆盖。

Ubuntu后端9/16分片的RFC185真实PG fan-out只调用两名成员，但任务最终ok。同一时间PG在host participant的post-insert nonce SELECT和assignment CAS上反复40001；十次事务预算耗尽会把尚未启动的卡片记为failed，领队允许这种终态聚合。夹具在runHostNode入口立即记录，没有等待采样问题。日志缺少派单ID和最后卡片错误，尚不能唯一还原漏掉成员的全部十次重试；不把相关性冒充唯一根因。

本批最小减冲突修正：在TaskExecution自身host participant用既有随机nonce生成器生成值，经既有mint overrides.envelopeNonce随行写入，成功后直接返回，去掉多余node_runs回读；公共mint类型、事务隔离、重试预算和失败收场规则不变。新增双provider真实并发三run、receipt与持久nonce一致、回滚后新尝试和实际SQL录制回归；旧三成员完整执行断言不变，只补卡片/run/系统错误诊断。新用例会确定性拦住这次不必要的回读，真实并发效果与完整三成员执行仍须新SHA hosted CI。

旧候选九个定时工作流均已终态。七个success：maintenance36665773019、Windows36665778557、OpenCode36665783652、Git36665786505、evidence36665789813、visual36665459576、weekly PG36665792231，均为上述完整SHA。full36665775717与WebKit36665780868为failure，诊断及增量候选见下节。本批改变依赖和启动代码，旧绿色不能直接关闭新候选；按新提交重新验证主CI及九个目标配置，不取消正在执行的定时矩阵。全部必要终态前AW-R01保持未完成。

CS原键持久停止源码bebb3d9b3b2a879a8e8ecf9b56b818fc912b15b7的精确CI36665601664六项success，2026-09-30T04:11:33Z本机八组件Ready=1、storage-contract=1、公开登录页HTTP200。它只完成停止底座；完整开发采集/owner清理/consumer/两级事实UI仍未关闭，生产开发采集OFF。两RFC继续，真实身份/模型验收没有执行。

## 第二轮定时诊断：真实价格访问与WebKit生命周期

[full E2E 36665775717](https://github.com/wangbinquan/agent-workflow/actions/runs/36665775717) 的四个Playwright分片全部success，失败在RFC319覆盖对账：新增的 `GET/POST /api/observability/pricing/runtimes/:registrationId/versions` 没有真实访问。本批在既有RFC371浏览器文件补 actual daemon CNY 定价旅程：保存价格版本201、读取历史200、刷新后同一持久版本/价格、零价与未定价分别显示，并核对运行时配置修订/模型未被价格保存修改。没有mock定价路由，不改uncovered账本或覆盖门禁。

[WebKit 36665780868](https://github.com/wangbinquan/agent-workflow/actions/runs/36665780868) 只有macOS 4/4分片失败，终态 **1 failed + 1 flaky**，不能只描述成重跑成功。RFC371趋势图首轮/重试均在键盘末柱焦点失败；macOS Safari默认Tab只遍历文本控件，已有 `e2e/ux-consistency.spec.ts` 使用原生Option+Tab。本批沿用同一平台/浏览器判据，所有柱仍通过真实按键依次到达，增加每一步焦点断言，宽窄屏末柱可视与截图断言保持；不程序化focus末柱绕过键盘路径。

WG-35人类owner在线点首轮计数0，重试success。该夹具默认真实session，owner来自同一 `/auth/me`；PresenceDot对确定离线也画点，因此0代表unknown而非未在线。首轮仅有视频/error-context，成功重试trace无WS帧，不能唯一确认此次CI的失水化原因。源码存在可以受控覆盖的时序缺陷：断线render的passive effect可在新open+snapshot后清空唯一快照。本批用共享socket可选同步生命周期回调在断线/新订阅尚未连接时reset，移除presence旧connected passive reset；权限失败关闭及认证代次守卫保留。新增真实hook/共享socket重连回归，在布局阶段交付新open、可选snapshot后再允许旧effect执行，分别验证最新已知值保留、无新快照仍unknown、迟到旧帧不覆盖、新连接断开回unknown。原WG-35全部断言保持，不加固定等待或更改重试/预算。

依赖/PG启动原八路径已独立静态功能复核PASS，定时增量随完整候选继续复核；这些测试未在本机执行，新SHA hosted主CI、真实full覆盖对账及两平台WebKit矩阵全部成功前，不声称已解决全部失败。

## 第二轮发布后：Windows必需字段补正

完整12路径候选已独立静态功能复核PASS，并以 `18c487f8c57743c9731b8757b31d9795d494004b` 精确推送，提交前后主分支与远端一致、四个并行resource-catalog路径未改动。[Windows 36671976956](https://github.com/wangbinquan/agent-workflow/actions/runs/36671976956) 终态failure：新 `rfc369-workgroup-mint-receipt.test.ts` 的任务夹具漏填必需 `startedAt`，TS2769在执行功能测试前拒绝。本批补 `startedAt: Date.now()`，不放宽类型，也不改变三个兄弟mint、实际持久nonce、SQL回读禁止或回滚重试断言。

主CI已结束的macOS后端6/6除两个夹具NOT NULL失败，还报两条canonical精确生成投影失败。沿用官方生成器，源码仅在内存读取已提交main与本任务候选，未建立其他checkout或改动并行来源。新增顶层onPresenceConnectionState符号导致归属分母25510→25511；同步13份生成/治理/状态产物、sourceDigest sha256:60f3075ecd59dc84e313b9a2c78ebb35c65aaa8ee6245e3848f40d6c23716dd9及四份内容寻址provenance。唯一allowGrowth按原规则精确解释这一个新增符号，下一笔无增长提交须退役；不增加架构违规、豁免或放宽生成相等检查。

同一SHA的主CI36671910180已终态46success/4failure：Lint+Typecheck、macOS后端6/6、Ubuntu后端8/16及required；日志逐项确认类型/NOT NULL时间遗漏与canonical投影是全部根因。九种定时配置八success，Windows类型失败；完整E2E36671974233的四分片和覆盖对账、WebKit36671979603的两平台各四分片均成功。原全部十个运行正常跑到终态，没有取消。新候选仍须实际执行全部原有矩阵，不修改schedule、重试、规模或预算。本机AW门禁未运行，AW-R01保持未完成。

第三轮18路径独立静态功能门PASS：首尾冻结hash匹配，2721份提交生产源码独立重算摘要匹配，四份治理内容摘要匹配，仅新增onPresenceConnectionState这一归属条目。原测试与严格投影/增长过期判据保持；没有本地AW测试或服务。发布前只更新旧矩阵完整终态回执，生产和13生成产物内容不变。

## 第三轮终态与 REPO-39 阶段等待修正

完整源码 `0647dadbedd66a20b162377788e92f2c79b68f83` 已精确推送。原十个运行均正常结束，未取消；主 CI 全部50项成功，九个定时配置八成功，只有 WebKit 的 Ubuntu 3/4 分片失败。

| 工作流                    | exact-SHA run                                                                         | 终态                            |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| CI                        | [36676635657](https://github.com/wangbinquan/agent-workflow/actions/runs/36676635657) | success，50项                   |
| maintenance-soak-nightly  | [36676691371](https://github.com/wangbinquan/agent-workflow/actions/runs/36676691371) | success                         |
| e2e-full-nightly          | [36676694347](https://github.com/wangbinquan/agent-workflow/actions/runs/36676694347) | success，四分片及真实覆盖对账   |
| windows-platform          | [36676697214](https://github.com/wangbinquan/agent-workflow/actions/runs/36676697214) | success                         |
| e2e-webkit-nightly        | [36676700139](https://github.com/wangbinquan/agent-workflow/actions/runs/36676700139) | failure，7/8分片成功            |
| integration-opencode      | [36676703066](https://github.com/wangbinquan/agent-workflow/actions/runs/36676703066) | success                         |
| git-protocols-e2e         | [36676706170](https://github.com/wangbinquan/agent-workflow/actions/runs/36676706170) | success                         |
| evidence-soak-nightly     | [36676709321](https://github.com/wangbinquan/agent-workflow/actions/runs/36676709321) | success                         |
| visual-regression-nightly | [36676711965](https://github.com/wangbinquan/agent-workflow/actions/runs/36676711965) | success                         |
| postgresql-evidence       | [36676714930](https://github.com/wangbinquan/agent-workflow/actions/runs/36676714930) | success，原 weekly/all 五项矩阵 |

失败用例是 `e2e/rfc319-ops-events-and-repo-sweeps.spec.ts` 的 REPO-39。首轮与重试均在孤儿工作树消失后，立即检查半成品镜像目录还存在而失败；不能靠旧版本的绿色或再跑一次关闭。实际 `platform/background/maintenanceJobRunner.ts` 定义 worktree→iso→scratch→orphan→partial，每阶段完成后以持久 cursor、resumeAfterMs=25 续跑。`source-control/application/workspaceMaintenance.ts` 分别调用异步目录移除；orphan 消失只证明这一阶段的目标已删除，不能作为后续 partial 完成的屏障。日志与代码支持测试观察了允许存在的中间状态；尚未用日志唯一还原当时 worker 的具体排队时长。

本批只修真实 daemon E2E 的等待条件：在原330秒总体 poll/420秒用例预算内，同时等待孤儿工作树和半成品镜像目录消失，随后保留锚定任务、未到龄目录、正常镜像必须存在以及半成品确实消失的全部断言。既不直接调用 GC，也不改变生产调度、重试、超时、分片或用例选择。补正旧 GC 路径和启动相位注释。生产源码与 canonical census 不变；25511 高水位保持，按过期规则只退役上一提交已消费的单条 allowGrowth，并用原官方函数更新 ledger 内容寻址 provenance。

新精确候选的主 CI 与九种定时原默认矩阵仍待实际终态。AW-R01 保持进行中；本机未运行 AW 测试、构建、类型检查或服务，四个并行 resource-catalog 文件完整保留。CS 实际来源底座 `d01ba8223fc08c8b2b70ee4db859e560c2151668` 的 [CI 36682129650](https://github.com/wangbinquan/CrewStation/actions/runs/36682129650) 六项已全部成功，本机部署另记，生产开发采集仍 OFF，两 RFC 不关闭。

## 修复候选精确终态（2026-09-30）

源码修复提交 `edd56ebe33731cb05aa7491b292be294a3026521` 已推送，限定六路径独立功能门 PASS；主 CI 及九种定时配置全部终态 **success**，共 10 个运行、75 个作业全部成功，AW-R01 退出条件已满足。本轮九种定时配置从 main 以原 workflow_dispatch 默认参数运行，覆盖与原定时相同的 full/weekly-all 和既定两平台/分片矩阵；没有修改 schedule、权限、重试、超时或必需检查，也没有取消旧候选运行。以下每个运行的 headSha 均严格等于该完整提交。

| 工作流                    | 精确运行                                                                              | 成功作业 |
| ------------------------- | ------------------------------------------------------------------------------------- | -------- |
| CI                        | [36684248034](https://github.com/wangbinquan/agent-workflow/actions/runs/36684248034) | 50 / 50  |
| maintenance-soak-nightly  | [36684316158](https://github.com/wangbinquan/agent-workflow/actions/runs/36684316158) | 1 / 1    |
| e2e-full-nightly          | [36684319531](https://github.com/wangbinquan/agent-workflow/actions/runs/36684319531) | 5 / 5    |
| windows-platform          | [36684323276](https://github.com/wangbinquan/agent-workflow/actions/runs/36684323276) | 1 / 1    |
| e2e-webkit-nightly        | [36684326977](https://github.com/wangbinquan/agent-workflow/actions/runs/36684326977) | 8 / 8    |
| integration-opencode      | [36684331034](https://github.com/wangbinquan/agent-workflow/actions/runs/36684331034) | 2 / 2    |
| git-protocols-e2e         | [36684335151](https://github.com/wangbinquan/agent-workflow/actions/runs/36684335151) | 1 / 1    |
| evidence-soak-nightly     | [36684338781](https://github.com/wangbinquan/agent-workflow/actions/runs/36684338781) | 1 / 1    |
| visual-regression-nightly | [36684342388](https://github.com/wangbinquan/agent-workflow/actions/runs/36684342388) | 1 / 1    |
| postgresql-evidence       | [36684345862](https://github.com/wangbinquan/agent-workflow/actions/runs/36684345862) | 5 / 5    |

主 CI 包含静态扫描、类型、构建、双 provider 后端与十个浏览器分片及 CI required；full E2E 包含四个分片和实际 route-hit 覆盖对账，WebKit 的 Ubuntu/macOS 各四分片成功，PostgreSQL 为原 weekly/all 五项矩阵。REPO-39 已在原330秒 poll/420秒用例预算内共同等待孤儿工作树和半成品镜像删除，保留锚定、未到龄及正常镜像的所有保护断言。Windows 必需时间夹具、Node JSON 加载、真实价格版本访问、原生键盘及 presence 生命周期等修正均包含在该提交祖先；依赖公告已按兼容修复版本处理，一次性增长按原失效规则退役，未新增豁免或降低检查强度。

只提交本任务精确路径，并行 resource-catalog 四个路径完整保留；本机没有运行 AW 测试、类型检查、构建或服务。后继只写回本页、STATE、plan、remaining-work 四份文档；对应精确文档提交 CI 另外验证，不把文档变化当作重新执行九个源码矩阵的理由。

此回执只关闭 AW-R01。AW-R02～12 与 CS 的 owner派发/清理、消费者、两级正式开发明细及真实联合验收继续，两个 RFC 保持 In Progress。CS 已部署源码 d01ba8223 的六项 CI 成功；b0f17691 仅发布已复核的消费者设计和剩余文档，未启用生产开发采集。

## 2026-10-01 新运行时贡献批次的 CI 回归

此前 `edd56ebe` 的主 CI 与九种定时配置成功回执保持不变。新功能提交 `df87010886452d1b88b8c236869ea51b52fcb148` 出现新的真实失败，不能以此前成功代替本批验证：

| 工作流                    | 精确运行                                                                              | 原终态与根因                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| CI                        | [36822841154](https://github.com/wangbinquan/agent-workflow/actions/runs/36822841154) | 41 success / 7 failure / 2 cancelled，后继 push 自动取消；类型与任务详情字段缺失，macOS 另有几何测量失败 |
| e2e-full-nightly          | [36822977430](https://github.com/wangbinquan/agent-workflow/actions/runs/36822977430) | failure，4/4 分片读取缺失的 runtimes；覆盖对账拒绝不完整分片                                             |
| e2e-webkit-nightly        | [36822981198](https://github.com/wangbinquan/agent-workflow/actions/runs/36822981198) | failure，两平台 4/4 同一字段缺失，六个其他分片成功                                                       |
| windows-platform          | [36822983873](https://github.com/wangbinquan/agent-workflow/actions/runs/36822983873) | failure，新增 fixture 判别类型与 TaskDetail 成员类型错误                                                 |
| postgresql-evidence       | [36822986709](https://github.com/wangbinquan/agent-workflow/actions/runs/36822986709) | success，原 weekly/all 五项；workflow_dispatch，未冒称实际周定时触发                                     |
| visual-regression-nightly | [36822841163](https://github.com/wangbinquan/agent-workflow/actions/runs/36822841163) | success，一项                                                                                            |
| integration-opencode      | [36822841353](https://github.com/wangbinquan/agent-workflow/actions/runs/36822841353) | success，两项                                                                                            |

类型与真实任务详情返回已由独立 PASS 的 `ed2cd483dc74c5f73bfba9e6530f7f64d1e09a98` 修复，其主 CI [36825750653](https://github.com/wangbinquan/agent-workflow/actions/runs/36825750653) 已终态 failure（48 success / 2 failure）：上述类型与所有十个浏览器分片已成功，唯一功能失败是 macOS 后端迁移历史用例超过隐式 5 秒预算，另一项为 CI required 汇总。消除卡片 helper 两次 boundingBox 之间的测量缺口：一次 evaluate 同步读取全部矩形、标题、公共间距和溢出；保留所有相邻对的 16px 标准/原容差、可见尺寸、宽窄屏及焦点断言。首轮 macOS 69px 的具体移动来源未被 trace 证明，不将其写成已经确认的产品布局 bug。

最终修复提交将验证主 CI 和全部九种原定时配置，沿用 full、WebKit 双平台、Windows、真实覆盖对账、2 GiB evidence soak、原维护与 weekly/all PG 默认矩阵。只有精确 SHA 的终态成功才能收口，不改 cron、并发取消策略或隔离，不降低性能门槛或删减矩阵/断言；迁移历史完整性单用例预算补正如下。本机继续不运行 AW 测试、类型检查、构建或服务；四个并行 skill 文件保留。完整 AW/CS RFC 仍继续。

### 完整迁移历史用例的明确预算

`ed2cd483` 的 macOS 后端 3/6 在 `rfc349-postgresql-migration-history.test.ts` 报 5772.89ms、`this test timed out after 5000ms`。源码正向用例先完整 load，再 verify 原 historical plan，再 verify 被清空 statement 的非法 plan；每次都扫描/重放完整历史并核对当前 projection，因此该用例包含三轮完整校验，而不是单条 SQL 或性能门禁。

仅此一条功能完整性用例给出 20 秒上限，正向 contractDigest/planDigest/statementCount 与非法 plan 的漂移拒绝断言原样保留；同文件其他六个用例、真实 PG 性能门槛及全部 workflow 预算不变。不通过重跑旧 SHA、跳过或取暖缓存宣称修复。该测试修正与几何快照修正共同提交，最终精确 SHA 的主 CI 和九种定时配置另取终态回执。

## 2026-10-01 最终修复的主 CI 与九种定时配置终态

修复提交 `a241fcf48420c363cf5c1255b4100a5dd113dd93` 的主 CI 与九种原默认定时配置全部终态 success，共 10 个运行、75 个作业成功；每个运行的 headSha 严格相同。主 CI 50 项，full E2E 四分片加真实覆盖对账 5 项，WebKit Ubuntu/macOS 八分片，weekly/all PostgreSQL 5 项，以及 Windows、维护、2 GiB evidence、Git 协议、OpenCode 集成和视觉矩阵均成功。九种定时配置通过 workflow_dispatch 验证原默认矩阵；不冒充本周实际 cron，未改 schedule、并发策略、重试或必需检查。本机无 AW 测试/类型检查/构建/服务；并行 resource-catalog 四路径保留。完整终态收齐于 `2026-10-01T08:14:44.687116Z`。

| 工作流                    | 精确运行                                                                              | 成功作业 |
| ------------------------- | ------------------------------------------------------------------------------------- | -------- |
| CI                        | [36830019349](https://github.com/wangbinquan/agent-workflow/actions/runs/36830019349) | 50 / 50  |
| maintenance-soak-nightly  | [36830637589](https://github.com/wangbinquan/agent-workflow/actions/runs/36830637589) | 1 / 1    |
| e2e-full-nightly          | [36830649443](https://github.com/wangbinquan/agent-workflow/actions/runs/36830649443) | 5 / 5    |
| windows-platform          | [36830662133](https://github.com/wangbinquan/agent-workflow/actions/runs/36830662133) | 1 / 1    |
| e2e-webkit-nightly        | [36830675518](https://github.com/wangbinquan/agent-workflow/actions/runs/36830675518) | 8 / 8    |
| git-protocols-e2e         | [36830703968](https://github.com/wangbinquan/agent-workflow/actions/runs/36830703968) | 1 / 1    |
| integration-opencode      | [36830689834](https://github.com/wangbinquan/agent-workflow/actions/runs/36830689834) | 2 / 2    |
| evidence-soak-nightly     | [36830717909](https://github.com/wangbinquan/agent-workflow/actions/runs/36830717909) | 1 / 1    |
| visual-regression-nightly | [36830731440](https://github.com/wangbinquan/agent-workflow/actions/runs/36830731440) | 1 / 1    |
| postgresql-evidence       | [36830745031](https://github.com/wangbinquan/agent-workflow/actions/runs/36830745031) | 5 / 5    |

卡片 helper 的同步快照保留公共 16px 标准、全部相邻对/可见尺寸/溢出以及宽窄屏、长列表、公共 Dialog 和焦点断言；未确认的首轮 53px 位移来源仍未作产品根因结论。迁移历史完整性只有含三轮 load/verify 的单用例使用 20 秒预算，其他六条用例、真实 PG 性能门槛和所有 workflow 预算不变。修复经独立实现 v3 PASS，再精确提交七路径并推送，远端同步；原失败没有删除，也没有取消、重跑或绕过旧失败来收口。

这一回执只完成本轮 CI 修复；AW-R08 服务端维度筛选、模型/用途下钻及两个 RFC 剩余实施继续。后继只提交本页、runtime-contributions、remaining-work、plan 与 STATE 五份文档，精确主 CI 单独验证；源码/工作流不变，不重复调度已成功的九种矩阵。

## 2026-10-01 分类 Token 与返回入口之后的定时修正

分类提交 `b446e48f8db0c0fc5e2bfb7c22c8f5e5e010ab3d` 的十个运行均已终态，整体未通过：主 CI 被后继 push 取消，Windows 类型失败；完整夜间的第 4 分片和覆盖对账失败，WebKit 夜间也有失败分片并被后继运行取消。历史成功的 `a241fcf4` 不能替代新候选回执。标题精确查询已由 `f512dc321932e6be0b3453dfc6cc1b69c9bb9dd9` 修正，并行 `7e33d3d415dbbe672eb9445be4020bb593cdff17` 补齐自己的类型和显式零推理夹具；不据此宣告整个 CI 成功。

当前三项可定位配套修正：

- [完整夜间 36853166930](https://github.com/wangbinquan/agent-workflow/actions/runs/36853166930) 的趋势只读夹具改了正数 Token，却继承真实空区间的四个 `hasKnownBuckets=false`，因此详情正确显示未观测。夹具现在显式提供同四类的证据位；保留第一个完整值断言，并检查第二个部分值及第三个全未观测区间，不改变产品的未知语义。
- [Windows 36857497630](https://github.com/wangbinquan/agent-workflow/actions/runs/36857497630) 的两条失败同源于 RFC-370 机械搬迁：原 `skillMigrateOp.ts` 的 `.dev`／`.ino` 比较已移入 `fileSkillIdentityContentStore.ts`，守卫仍登记旧路径。本次只搬迁原有两个各 1 次的许可，规则、总许可次数、反例和过期检查不变。
- 同一完整夜间的 WG-32 在准备已交付卡片时遇到引擎短暂持有 durable owner 的 409。只在测试准备阶段对 `task-execution-stale-owner` 重试，沿用房间消息夹具的 40 次／250ms 有限上限，其他拒绝立即失败；真实 UI 交付、两次取消确认、终态拒绝码和终态状态断言保留。

返回入口修复已单独提交为 `aac0aa3243fef404f60842fc19ec7b36e9ca0236`，本机实际页面已见紧凑的标题前返回按钮且返回保留查询上下文。本修正仅四个测试／文档路径；本机只做精确格式与 lint，完整主 CI、九种原默认定时配置以及返回几何矩阵仍由最终提交的 hosted CI 验证。不修改 cron、并发、性能预算或业务围栏，不重跑旧失败冒充修复。

## 分类 Token / 紧凑返回入口的精确 CI 收口

提交 `eef12e256408a54d5e52c351c23e4ebea9fdeb32`（包含分类 Token、精确标题查询、机械搬迁夹具和 `aac0aa324` 紧凑返回入口）已完成十个精确运行：75 个作业均为 success，headSha 全部一致。两条由 push 触发，八条定时工作流按原默认矩阵 workflow_dispatch 验收；不冒充已经等待 cron 自动触发。

| 工作流                    | 实际触发          | 精确运行                                                                              | 成功作业 |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------- | -------- |
| CI                        | push              | [36862619605](https://github.com/wangbinquan/agent-workflow/actions/runs/36862619605) | 50 / 50  |
| e2e-full-nightly          | workflow_dispatch | [36862922051](https://github.com/wangbinquan/agent-workflow/actions/runs/36862922051) | 5 / 5    |
| e2e-webkit-nightly        | workflow_dispatch | [36862927689](https://github.com/wangbinquan/agent-workflow/actions/runs/36862927689) | 8 / 8    |
| evidence-soak-nightly     | workflow_dispatch | [36862938467](https://github.com/wangbinquan/agent-workflow/actions/runs/36862938467) | 1 / 1    |
| git-protocols-e2e         | workflow_dispatch | [36862932820](https://github.com/wangbinquan/agent-workflow/actions/runs/36862932820) | 1 / 1    |
| integration-opencode      | workflow_dispatch | [36862911235](https://github.com/wangbinquan/agent-workflow/actions/runs/36862911235) | 2 / 2    |
| maintenance-soak-nightly  | workflow_dispatch | [36862916934](https://github.com/wangbinquan/agent-workflow/actions/runs/36862916934) | 1 / 1    |
| postgresql-evidence       | workflow_dispatch | [36862944587](https://github.com/wangbinquan/agent-workflow/actions/runs/36862944587) | 5 / 5    |
| visual-regression-nightly | workflow_dispatch | [36862906433](https://github.com/wangbinquan/agent-workflow/actions/runs/36862906433) | 1 / 1    |
| windows-platform          | push              | [36862619599](https://github.com/wangbinquan/agent-workflow/actions/runs/36862619599) | 1 / 1    |

主 CI 的中英文 / 明暗主题 / 1280 与 390 宽度返回矩阵和全夜间趋势证据位、WG-32 真实 UI 路径均通过；Windows guard 保留原两条各一次许可。原失败与取消历史继续保留，未降低预算、删除断言或更改定时配置。源代码候选不再重跑已通过矩阵；本页后继仅为文档，其精确主 CI 单独记录。

该回执关闭本次 CI 修复与按钮几何验收，AW-R02～12 / CS 联动、服务端维度和其他 RFC 剩余事项仍继续，不宣告整个观测能力完成。

## 文档后继与共享主干 CI 的实际终态（2026-10-01）

观测回执两文档提交 `993ab7ce694988536ecf600d9e4a874901e5ea41` 的 [主 CI 36871878934](https://github.com/wangbinquan/agent-workflow/actions/runs/36871878934) 被后继 push 取消，作业为 35 success / 6 failure / 9 cancelled，不能写成绿色。可定位失败属于共享 RFC-370 配套：不存在的 `buildPackagePreview` 导出、两个类型文本改变后的 AST digest、旧 reader 三参数断言。原 owner 随 `13f5b8e3` 修正，其 [CI 36874167121](https://github.com/wangbinquan/agent-workflow/actions/runs/36874167121) 为 34 success / 4 failure / 12 cancelled，另暴露测试 opId 不符合 `op-<n>` 与崩溃夹具未等待实际派发边界；失败历史保留。

原 owner 继续提交 `ce8a6310adb9576559f4d5100d4916635a104720`，保留断言并改为合法 op-1 和实际 crashBoundary。该 SHA 的 [主 CI 36876744628](https://github.com/wangbinquan/agent-workflow/actions/runs/36876744628) 50 / 50 completed / success；[OpenCode 集成 36878130169](https://github.com/wangbinquan/agent-workflow/actions/runs/36878130169) 与 [Git 协议 36880609673](https://github.com/wangbinquan/agent-workflow/actions/runs/36880609673) 同 SHA 也 success。独立只读诊断保留五类具体根因，没有由观测会话改写并行源码或降低守卫。

分类 / 紧凑返回源码的十运行 / 75 作业成功证据仍绑定 `eef12e25`；这条 CE8 共享主干回执不冒充九种定时配置都在 CE8 重跑。两文档回执在 CE8 祖先中，原取消 / 失败、原默认调度和 EEF 矩阵保持。

## 2026-10-02 共享主干后续守卫失败与修正状态

共享 RFC-370 后继 `2d65a16f5152936ec93de1f0fd362a671e89e44d` 的 [主 CI 36882578362](https://github.com/wangbinquan/agent-workflow/actions/runs/36882578362) 终态 failure，38 success / 12 failure。Ubuntu 1/16 的实际失败是 `rfc294-architecture-preflight.test.ts` 的 capability ownership 精确登记对比多出一项；数据库竞争反例输出中的 ERROR 不是这一分片的失败根因。同 SHA 的 [evidence soak 36885455310](https://github.com/wangbinquan/agent-workflow/actions/runs/36885455310) success，不能替代主 CI。

原 owner 已提交 `a4b706b942adfc9ca16c15e329ba1f7fa97f78f8` 的参与者合同及 CI 登记修正；[主 CI 36886742257](https://github.com/wangbinquan/agent-workflow/actions/runs/36886742257) 在本次记录时 queued，尚无成功结论。同 SHA 实际 schedule 触发的 [视觉回归 36887644155](https://github.com/wangbinquan/agent-workflow/actions/runs/36887644155) 已 success。观测会话保留并行源码及原失败，不重复启动本机测试或已通过的 EEF 定时矩阵；新主干精确终态继续跟进。

## 2026-10-02 明细下钻候选 CI 回归

`c2c96cef469ce550529a52fbeefaa89a952f0417` 的明细下钻源码已精确提交上库，原源级 v3 和完整集成 v4 静态功能回执保留。[主 CI 36938431472](https://github.com/wangbinquan/agent-workflow/actions/runs/36938431472) 整体终态 cancelled，`CI required` 为 failure，不能算通过。前端 Ubuntu 3/3 实际为 2504 pass、2 fail，均在观测回归内；后继的并行架构修复与账本许可退役仍由其 owner 负责，未收编其在制源码。

两处修正保留原验证：读取失败后返回完整空页的夹具明确 `nextCursor: null`，与真实 EOF 合同一致；有续页的空批次仍必须显示“本批尚未确认匹配任务”，已有单独断言不变。模型贡献 Dialog 进入整任务明细时，等待真实任务标题加载后再判断返回行为；顶部返回按钮在加载期间已存在，不能充当数据就绪信号。没有固定延时、删测试、跳过或更改生产逻辑。精确格式与 lint 已通过；本机未运行 AW 测试、构建或服务。新的精确提交主 CI 与适用定时矩阵、真实页面 Dialog 验收仍待，两个 RFC 保持 In Progress。

## 2026-10-02 原审批时序与默认 CI 矩阵复验

当前代码基线 `b339e7e06e13c7b4456cc1bf928048c7fc0262a3` 包含观测明细、原审批 POST 时序恢复 `064abf30`、归档夹具枚举与格式修正 `69afa48c`，以及原 owner 的薄 facade 精确清单修正。主 CI 和九类现有默认定时工作流已全部 completed/success，共十次有效运行、75 个成功作业；未降低预算、删除断言或修改调度。

| 工作流                        | Run                                                                                   | 成功作业 |
| ----------------------------- | ------------------------------------------------------------------------------------- | -------- |
| CI                            | [36969850886](https://github.com/wangbinquan/agent-workflow/actions/runs/36969850886) | 50/50    |
| maintenance-soak-nightly.yml  | [36970414480](https://github.com/wangbinquan/agent-workflow/actions/runs/36970414480) | 1/1      |
| e2e-full-nightly.yml          | [36970420107](https://github.com/wangbinquan/agent-workflow/actions/runs/36970420107) | 5/5      |
| windows-platform.yml          | [36970559143](https://github.com/wangbinquan/agent-workflow/actions/runs/36970559143) | 1/1      |
| e2e-webkit-nightly.yml        | [36970432899](https://github.com/wangbinquan/agent-workflow/actions/runs/36970432899) | 8/8      |
| integration-opencode.yml      | [36970439090](https://github.com/wangbinquan/agent-workflow/actions/runs/36970439090) | 2/2      |
| git-protocols-e2e.yml         | [36970445195](https://github.com/wangbinquan/agent-workflow/actions/runs/36970445195) | 1/1      |
| evidence-soak-nightly.yml     | [36970451369](https://github.com/wangbinquan/agent-workflow/actions/runs/36970451369) | 1/1      |
| visual-regression-nightly.yml | [36970456678](https://github.com/wangbinquan/agent-workflow/actions/runs/36970456678) | 1/1      |
| postgresql-evidence.yml       | [36970464478](https://github.com/wangbinquan/agent-workflow/actions/runs/36970464478) | 5/5      |

Windows 首次同 SHA 默认运行 `36970426040` 为 cancelled，保留原回执；采用同 SHA、没有参数输入的替代 `36970559143` 成功终态。原 `064abf30` 主 CI 因已发布归档夹具的格式与 facade 清单而 failure，`69afa48c` 主 CI 被后继 push 取消且仍有 facade 清单失败；这些记录均保留，不写成绿色。

mixed report 原丢失根因仍未确证。复验已恢复最初的 reject POST 顺序，原 run 身份断言移到既有 afterReject 查询后，不新增 GET、等待、重试或预算。原失败诊断、修订 frame、writer3 输入、fanout 汇总及最终审批断言保持；本矩阵证明该实际原时序通过 Chromium 与 WebKit，不冒充缺失根因的功能修复。

新只读读取再次核对三个已执行的原生验收任务：输入 36,260、缓存读 8,832、缓存写 0、输出 2,432，总计 47,524 Token，人民币估算 ¥0.096392；仅使用已授权的验收专用费率，不代表供应商账单。正式新页面的剩余实机几何/焦点验收因 Mac 锁屏继续等待，CS 当前 API 会话亦已过期，未切换身份或开启项目费用可见性。CS 原父结束/物理证明/恢复/开发采集以及 AW/CS 托管联动仍继续，两个 RFC 保持 In Progress。

本次后继只更新回执文档，源码候选不重复跑已通过的默认矩阵；文档提交的精确主 CI 单独跟踪。

## 2026-10-02 OpenCode 固定来源链接接续

`c843938ae1e1103d6d78ec2f4f9f2e1ec31c0560` 的 [CI36985769914](https://github.com/wangbinquan/agent-workflow/actions/runs/36985769914) 终态 failure，48 success / 2 failure。三条 CS 固定源码 raw 链接已通过；Markdown 作业 110770777970 的唯一报错为 RFC-371 分类文档中 OpenCode 固定提交的 GitHub blob 503，第二个失败为汇总作业。

共享分类文档中并行会话保留的文件路径、行区间及固定 SHA 完整保留。官方同 SHA 的 raw 源码只读核验返回 HTTP 200，实际 getUsage 已核对；`81d6d54f` 曾追加可读链接，其限定文档复核没有覆盖仓库 `CLAUDE.md` 的强制引用规则。现仅将本会话追加段落改为纯文本 `packages/opencode/src/session/session.ts:321-379` 与同一固定 SHA；Token 口径和原断言不变。没有增加豁免、放宽 HTTP 接受状态或修改工作流配置。自身 hosted CI 仍需回执，AW-R01 当前接续未关闭。
