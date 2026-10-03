# RFC-370 独立功能评审记录

2026-10-01。按 `CLAUDE.md` 的双门及 `docs/dev-gotchas.md` 的独立子代理备选执行；openai-codex 插件工具本会话未提供。评审均在既有 primary checkout/main 按精确路径只读完成，未创建隔离 checkout，未运行本机 AW 测试、类型检查、构建或服务。仅审功能；正式行为、完整 A-G 和实际 CS 联合验收单独记录。

## 已提交源码 CI 数量补正候选（2026-10-02）

并行 E2E 失败 lineage 诊断已发布 bbb545851a5dc4c5328ff005a82b196cdedf5d28，main/origin 精确同步。官方 census 的源码输入与治理 seed 都是已提交 HEAD；原40候选和归档8候选全部排除且指纹保持。其未发布生成证据保留，未来源提交前重新生成，不把五项待发布许可写成已消费退役。

确切 CI36955843850 的纯数量元数据为既有项实际17、基线16。生成器保留此旧基线，因此只将该 scalar16→17并按原协议登记一项一次性增长回执；官方 provenance helper 同步正文 hash。四份实际治理候选中，其余三份只有现有 provenance 变化；ledger 在逆变换此唯一数量和回执、移除 provenance 后与 HEAD 全文数据相等。全部其他数量、登记正文、规则、源码和断言保持。候选独立有限功能检视后按短临界区发布、后继精确退役，再验证 exact-SHA hosted CI；E2E 的既有 mixed_summary 缺失报告继续，历史 failure 不改记绿色，无本机 AW test/typecheck/build/service，不关闭 A-G/RFC。

## 任务归档内容七路径有限实现门（2026-10-02）

`/root/intent_functional_gate` 完整复读七路径，有限 PASS，末次有序指纹 `4d9650ac2082344a27779947ee3830d9cff079601ed8d888be12f6e632bdb344`。TaskArchiveContentPort 接受所选引用和 sync/Promise 内容效果，独立 local 包持有原文件机制；共享协调器保留全部 AW 归档规则，composition 选择能力，旧 factory/constants 出口保持。只逆变换精确 IO/参数/await 后，原协调器38个声明及 sweep3声明的全部非 trivia token 相同；原 legacy restore 函数只改名称后同样完全一致。该证据只加载 TypeScript parser 和源码，不执行 AW 应用/数据库/测试/服务。

新的真实双 provider 回归覆盖三处完成屏障（JSONL、manifest、最终移动），等待时在线行/claim/审计原状，完成后同 claim 结算；append 拒绝后重建 JSONL，最终移动已完成但 ACK 丢失时由正式内容继续恢复且不重复导出。2001条事件按原 `[2000,1]` 分批并保持全部顺序，legacy runs/logs 两次恢复先等完成再判断丢弃。屏障位于所选方法内，成员调用保留 this，finally 释放并收完操作；默认文件机制与既有归档规则兼容。目标格式/lint通过；未跑本机 AW test/typecheck/build/service，正式行为交发布后的 hosted exact-SHA CI。

后续必要下游沿读发现 RFC349 的 PROVABLY_NULL_FREE 键仍定位旧工厂文件，而 finishedAt 查询原体已移到 taskArchiveContentCoordinator.ts。仅把这个键定位到真实实现，原 why 与全部判据/断言不变；`/root/intent_functional_gate` 扩为八路径复读有限 PASS，末次指纹 `31c06684b6c2028f4604e6906c9bee7f4bed2663ffd505427412d7f0f2b7e116`，原七路径字节与 PASS 保留。独立全文比较确认唯一键替换；实际中立 db 类型、PG/provider 与 maintenance worker 可达新查询，原 lte(finishedAt, cutoff) 排除 NULL 的规则保持。

本门只覆盖 A2 归档内容切面，真 boot-root 注入另批，不关闭完整 A2/A-G/RFC。原七组40候选指纹不变，现有 scoped canonical 不纳入归档八路径。并行补正后的 e4d7dba7d/[CI36955843850](https://github.com/wangbinquan/agent-workflow/actions/runs/36955843850) completed/failure、46 success/4 failure，数量判据和 mixed_summary 上下文缺失保持真实失败记录，完整恢复继续。

## 七组40路径冻结候选与修复 CI 终态（2026-10-02）

六路径修复已连同 scoped canonical/唯一许可退役发布为 `02940128ffd4918b19b998a23a5e27650d6d097b`。其 [CI36951130717](https://github.com/wangbinquan/agent-workflow/actions/runs/36951130717) completed/failure，47 success/3 failure；原五类错误相关作业已通过，macOS/backend4 与 Ubuntu/backend16 为同一既有架构守卫失败，另为汇总。该项只读取失败状态与源码位置；原断言保持，完整恢复继续。同 SHA [Windows36951130688](https://github.com/wangbinquan/agent-workflow/actions/runs/36951130688) completed/success。原失败与有限门均不改记全绿。

journaled preparation 原七路径 `a256a3c48fcd5df6d54ca8383211d61d6642ba0302777a6a748e92458fbb5e58` 有限 PASS 保留。官方清单发现本候选新增 RepositoryPreparationEffectFactory public 转出口没有生产消费者；移除它后六路径 `6cddeac77ba53045d947e7fe4e6728e2402bb064c129489da5a31cfe63bc6856` 首门 FAIL/P2，唯一 finding 为测试仍导入已无的 public 类型。只把测试 import 改到实际 application/ports 合同后，`/root/rfc370_design_gate` 复读六路径有限 PASS，指纹 `158d28d35c88b7f6f46052b1ea8896b8183b790f658ae4529513124b0009a49d`；其余五文件不变，public 文件与 HEAD 相同。原 async factory/receiver/prepare/replay/补偿重试/幂等行为及所有断言保留，不扩张零消费者账本。

提交预览 index 六路径由 `/root/task_config_functional_gate` 有限 PASS，首读 `6d53d01d1d99df3dcf61b7a74d610abc05d21053427f28a686b8bdd42b667f62`，补正原 binder 捕获时点后末次 `5e2022324378b36f331c02079aea79e2bd414a0e27a666161ca142d3edd7e7ac`。RepositoryPreviewIndexPort 提供绑定 scope 和 async withIndex，AW 原 read-tree→prepare selection→diff/receipt/错误仍在 application；独立 local adapter 保留原临时目录、index 覆盖、逐次 env、signal/timeout、literal reset 和 finally。composition 的默认/所选能力均接线，原输入绑定值不会因 bind 后替换而漂移。新增所选获取/释放屏障、first-failure/原错误传播/this/no fallback 与真实 Git index/options/清理回归，原 RFC308 全断言保持。必要消费者和源码 oracle 已沿读；该门不代表完整 Git/工作区远程切面或 A4/A-G。

以上六路径与原员工local4/插件安装6/GC3/附件5/终态真根10 共七组40路径，清单顺序指纹逐项复核且无交集。官方 scoped HEAD 加此40路径，原规则不变；public1045、TE value SCC 空，imports5627→5660、exception4991→5023、owner25671→25685、entry1792→1795、background338→339。插件两条目标路径按实际 type/value import/export 登记六条 R1（261→267），owner RC、A-T7 退役；五项实际增长许可待发布后精确退役。正式行为交该批发布后的 exact-SHA hosted CI；现无本机 AW 测试/类型检查/构建/服务，无 CS adapter 或部署，不关闭完整 A-G/RFC。

## 最新 CI 恢复与后续插件有限候选（2026-10-02）

八批发布 tip `165bb447dc0a8bc4f8e0e8ce9698512791a7477d` 的主 [CI36948285794](https://github.com/wangbinquan/agent-workflow/actions/runs/36948285794) 已 completed/failure，43 success/7 failure；同 SHA 的 [maintenance36948285743](https://github.com/wangbinquan/agent-workflow/actions/runs/36948285743) completed/success。失败为 Typecheck 一项、Ubuntu/backend4/11/14、macOS/backend3/6 五分片与汇总；日志已按功能失败收齐，有限 PASS 不代表该发布全绿。

首三个修复由 `/root/rfc370_design_gate` 有限 PASS，指纹 `4c7eaa0d2632b4133c036cf347b9fc7f66c063c022012ef46593582034c6078a`：作者查询 const 保存同一 implementation 引用以贯穿 async closure；evidence 夹具创建真实 user 并取得 `admitted.actor`，运行时收尾；移除无人消费的两个新增 type-only public 出口，应用合同、所选 composition 和实际 availability 回归保持。该版 public1047→1045，其他计数不变，不扩张零 consumer 债务表。

完整日志另证实 SO 合同只漏 public/participants.ts 精确目录名（原 offender 判据已通过），及 TE default presence 从 SC 大 barrel 导入造成真实 value SCC。已扩为六路径候选：目录预言追加实际文件；新增 SC narrow composition 精确转发原 file factory，TE 默认导入选择该入口。修复指纹 `1dbabb1f3d7aca6c99160c543b06b55c2df77434c6bb9d745e754e374500f512`，`/root/rfc370_design_gate` 六路径有限 PASS，原三路径字节不变。已实际沿读 SC barrel→workspaceMaterializer→gc→systemWorkspaceGc→TE participants→sqliteTaskExecutionContext→TE persistence 的环，叶子只有 node:fs 值依赖。scoped 官方语料显示 TE value SCC 空，唯一新增 owner 是 narrow composition 文件，owner25670→25671；其他计数保持，原 scanner/零 SCC 判据/债务和所有业务断言不放宽。唯一实际 owner 增长按原账本协议登记/后继退役；正式结果待修复 exact-SHA CI。

员工附件首五路径 `058092151c2c287e75e783d3d95d4fe37976296e584a1359e0a5289303c3d439` 有限 FAIL/P2：intake.kind=body 携两附件会在 selected presence 前被真实 schema 拒绝。只改为 body-and-files 后 `/root/intent_functional_gate` 五路径有限 PASS，指纹 `6e58a90cae2156824101b1a06856fb0acb377d0977084592ddbe1317fc66d6e4`；其余四路径不变。hasBlob 与 copyBlobTo 接受 sync/Promise，实际 Case admission 顺序 await existence，工作区逐一等 copy 完成后写库；原 Git 交付断言保持，屏障 fail-fast、finally 释放并收完。必要完整 authoring/schema/codec/upload/claim/模块/provider 已沿读，正式行为待该候选发布后 hosted CI。此五路径及其他新候选全部排除六路径修复 canonical，不关闭完整 H6/A-G。

终态 presence 启动根首十路径 `302f45b09a1c7bfff8787fc5539e46393488d95b7b9881ff09af22705ad42c50` 有限 FAIL/P2：新 provider missing 夹具错误期望 false；真实 lifecycle 先写回收事实再报 workspace-pruned/410。仅修新断言、保留 failed/revision7/prunedAt300，补事件1/0后，`/root/task_config_functional_gate` 复读十路径有限 PASS，指纹 `742c05082112c3341c674569f0f6367ab69162a8da702cc6d59e08c3a7c7f0c9`。实际 selected query 贯穿 SQLite/PG persistence、route/human-gate、备用 DE 与长驻协调器，已有 aggregate 优先。新双 provider 真 provider factory 和原 lifecycle 回归同用所选查询，等待无写入／true／false／reject／收尾均核对。完整 W29 归一化三根保留167/48/65语句及顺序，去除新增精确 binding 后所有非 trivia token 相同（仅排除格式尾逗号），六 factory 原体和 start 全源也对拍；原四 INSERT 站点三列判据不动，仅 services/task 行号跟随2466→2472。正式行为待发布后 hosted CI；该门有未发布 narrow SC 配套依赖前提，不关闭完整 H3/A-G/RFC。

`3ac730f84c9430459efb6d8fe72a6db9f5e8a1ed` 的 [CI36945626088](https://github.com/wangbinquan/agent-workflow/actions/runs/36945626088) 已 completed/success，50/50 作业成功，headSha 逐字核对。三个平台观测 E2E 和原 macOS multipart 分片均通过。后者没有修改预算，其旧单次停滞原因未确证；原失败历史保留。八批54路径冻结候选的正式功能仍交其发布后 exact-SHA CI，不借修复基准全绿关闭这些候选或 A-G。

插件物理安装首四路径有限 FAIL/P2，指纹 `b2dc5269af7d59809e18eaf3881bdb6ad9f9354c81852abf45cfaf3aa12e7122`：两个既有源码 oracle 仍读旧 service，无法在移动后取得原 prefix/timeout 判据。只更正实际源码路径，原断言不减；补齐两路径后的六路径由 `/root/rfc370_design_gate` 复读有限 PASS，指纹 `2aeb9d575016c57df92a7e2b81713b5e0794e047bb778270a66eb3f543d71e51`（清单顺序）。全部物理安装原体移入 RC 独立 local 包，service 精确兼容出口与 class/cache identity、动态 Paths、原安装规则保持；纯文本原体对拍与目标格式/lint通过。实际兼容入边须随本候选后续 canonical 登记，未冒称零跨域耦合。

generation GC 三路径由 `/root/task_config_functional_gate` 有限 PASS，指纹 `4938db7c871cbcc569ab134d9227186c6cf5713b98c1f3cacc263bf32863e98b`（清单顺序）。preflight、工厂和接口原体逐字保持，动态 Paths、读取时点、引用保护、删除顺序及 fallback 不变；run/start/tick 业务仍原位。composition 四个准确出口与原 service 工厂兼容入口保持，worker/真实 GC 合同和 source guard 已沿读。该候选依赖前述未发布物理安装 local 包，二者均排除八批54路径 canonical；无本机功能测试，正式行为待各自发布后的 hosted CI。本有限门不关闭完整 H6/A-G。

## 设计门

首轮 `/root/rfc370_design_gate` 只读审查 proposal、design、plan、seam-assessment、rfc035-storage 及所引用的实际 AW/CS 合同。结论 FAIL，一项 P2：同 producer 绑定一个 endpoint 无法保留既有同 provider 多 endpoint 的规则和观测范围。具体输入为 GitLab endpoint A/B 分别处理 repo A/B，迁到共享 producer 后单绑定会漏掉一个 source；AW 原 schema 只对 urlToken 唯一，观测键包含 endpoint。

已补正 H8 来源配置与一对多路由绑定；逻辑事件回执冻结完整目标集合（包括空集合），每目标独立受理和恢复，跨订阅新 delivery 复用同一集合，路由修改不扩充旧事件。第二轮指出 MR 受理已提交但 observation 尚未持久化时不能完成目标；已明确 admitted／pending-publication 与持久待发布输入、稳定 key、两类 observe 回执补齐，再标 completed。改稿已由同一独立评审者复读并给设计门 PASS，无剩余可构造失败输入；审查 design blob `1e8674e12d442fe677f637cbed22b5cbc766d3f7`、proposal blob `13a3d0745ccbc13b9ab7d0d07e41137a1508f923`。此结论仅覆盖设计，不代表 A-G 或部署。以下八项纳入 B-T5 正式回归和实际链路验收：

1. 同 producer 的两个不同 repo 分别进入两个 endpoint。
2. 同 repo 显式绑定两个 endpoint，各保留一次观测和各自规则。
3. 一个目标成功、另一个失败，仅恢复未完成目标。
4. 接收提交后丢 ACK、ACK 后重启，完整目标集合不变。
5. 两个订阅为同 eventId 产生不同 deliveryId，每个 endpoint 只受理一次。
6. 接收后新增、删除或编辑 route，旧 event 重投沿用原集合和 binding revisions；已删除 source 保留终态原因。
7. 空集合事件接收后新增 route，旧 event 不触发；历史补发属于显式业务 replay。
8. MR 受理后未 observe、第一类 observe 已提交而第二类未提交、observe 已提交但目标回执未记录时崩溃；重启补足相同 observation key，保留既有 MR 受理及各 endpoint 去重。

CS 当前合同核对点为 `85ee9254a175848d65105d16327e00afbc47cc08`；RFC035 关键合同相对已记录 `35cf5a47` 未变。平台已有验收不作为 AW 联合验收。

## Intent 内容与 scratch 候选实现门

`/root/intent_functional_gate`：PASS，限定未发布的 21 个源代码/测试路径，基准 `ce8a6310adb9576559f4d5100d4916635a104720`；评审候选指纹 `9872857c3af575cad239efb57f590aea66aa42872be66194aef7ca6005c410aa`。无可构造失败输入的功能 finding。

已读全部候选及必要生产 composition、journal codec、SQL persistence、shared schema 和原 provider 回归。确认先 journal 后 stage，逐项 await owner/content/completion；提交前两层补偿、提交后 committed 重试、原 metadata/version 判据、旧整批 unmark→顺序发布→事务收尾、boot active journal 和 scratch 等待/计数/标记。新真库夹具符合原 schema，屏障在 finally 释放。两个启动根及维护 worker 的默认文件接线已核对；完整 H6 尚未覆盖，正式行为待本批 exact-SHA CI。

## 任务操作配置候选实现门

`/root/task_config_functional_gate`：PASS，限定未发布的 14 个源代码/测试路径，同一基准；评审候选指纹 `602107a187bf78f4106795cd021ed221647be59b154357dc26bd1775e3454b53`。无可构造失败输入的功能 finding。

确认六处 mint 冻结原位 await，commit patterns 按次热读和复制；默认文件/失败回退保持，所选 query 失败不读本机配置；driver 每次重新绑定能力，child launch/resume 经同一 driver，能力不进入继承 run-config。真双 provider/双 runtime mint 与 persistence 回归及原源码锁已核对。新测试尚未完整驱动 TaskEngine，接线结论来自源码追踪；正式行为待该批 exact-SHA CI。此结果不能关闭全 H1 或 A-G。

## Intent 配套 CI 修复实现门

`/root/intent_functional_gate`：有限 PASS，限定十个修复源码／回归路径，基准 `2d65a16f5152936ec93de1f0fd362a671e89e44d`；指纹 `0d4f07c55550bf65b272e2301105777479819fc1e25d1a8154d54e86155dc536`。工件数据仍从 types 出口，两个 owner capability 从 participants 出口；publication 的参数直接派生于现有中立事务 callback，create/update 都传入原 reserved transaction，没有影子事务或内容效果迁入事务。移动函数及类型依赖登记按新路径更新，两个原工厂改名后语料为66／62，原零孪生／生产消费者规则与自变异 fixture 保持。

原发布 `2d65a16f5` 的 [CI 36882578362](https://github.com/wangbinquan/agent-workflow/actions/runs/36882578362) 已 completed/failure、38 success／12 failure（含汇总 job），不能用此前有限静态 PASS 替代正式结果。六类兼容遗漏分别为 capability 出口、事务参数强转、移动函数路径、两个工厂改名后的两份计数，以及下沉合同的类型依赖登记。修复仅目标格式／lint与官方 scoped census，无本机 AW 测试、类型检查、构建或服务。正式类型、原行为与新回归继续以修复 exact-SHA CI 为准；此门不关闭 H6、A-G 或 RFC。

## Intent 修复正式 CI 回执（2026-10-02）

修复 `a4b706b942adfc9ca16c15e329ba1f7fa97f78f8` 的 run36886742257已因并行文档 push cancelled，48 success／1 cancelled／1 failure；未冒称该 SHA 全绿。包含修复的后继 `8d7e078e31527a3b70c5058af9fb25c4b23ff1f4` 的 [CI36890491336](https://github.com/wangbinquan/agent-workflow/actions/runs/36890491336) 已 completed/success、50/50作业 success，headSha逐字核对。修复是该 SHA 祖先，之间只增加 RFC371 两份文档，修复候选源码不变。原失败与取消记录保留。

## 任务配置33路径修订候选实现门（2026-10-02）

`/root/task_config_functional_gate`：有限范围 PASS，基准 `8d7e078e31527a3b70c5058af9fb25c4b23ff1f4`，候选33个精确源码／测试路径，完整指纹 `5fbce71b8f1e51b518c75c5cd93f99d02e00a965dbd5d2940b89c919713ddcb1`（按路径排序，每项路径+NUL+完整字节+NUL，SHA256）。此前18路径 operation/background 候选也已有限 PASS；本轮完整重读其接线，不借此前 PASS 代替新内容。

本轮首读发现一项 P2：selected source 删除 optional 配置或分段读取失败时，fresh 缺省字段经 spread 重新带回 boot 值。现 selected 配置独立进入运行漏斗，保留宿主 binary override／configPath／memory participant；双 provider 的四组带 boot 配置删值与独立失败回归已补。新增回归的 binaryOverride 初写字符串不符 readonly string[] 合同，已改数组；复读后无剩余可构造功能 finding。

评审范围为33路径及必要 provider、child lifecycle、execution context、配置 schema/file reader、启动 binder 与双 provider harness，未评审并行 RFC371 或 Intent 内容。六处 binary freeze 原位 await、commit 数组热读复制、每次 driver/child 注入，launch 原三次独立读取/catch、zero/filter、同步兼容入口与 HTTP upload await 保持。coordinator 在 attach 后读取配置，拒绝时报告并释放；等待取消后不准备或 dispatch。BG startup/tick/drain 与实际消费方 Promise 合同吻合。新回归使用真实 persistence/context/module，效果 fake 明确，不作为完整 TaskEngine 验收。

仅目标格式/lint、官方 scoped census 和原三个策略投影 AST runtime token 对拍；没有本机 AW test/typecheck/build/service。正式行为继续等待本批 exact-SHA hosted CI，此门不关闭全 H1、A-G 或 RFC。

## 任务配置 CI 配套修复实现门（2026-10-02）

首三路径独立复核有限 PASS，基准 `dd94236a4cdbf08ad41881332db55e94316bcfe6`，指纹 `10f1bdc0c7224010364994a0b603d407de313a003450549a5236dd6318ea2977`：完整 SchedulerDriverPort 夹具、保留并行 RFC371 的 Task positions 配套实现、单独的双 provider 分页合同回归。其后 CI 后端报告四种旧登记/源码锚点遗漏，扩为7源码/测试加 commons-debt 的8路径完整候选；由 `/root/task_config_functional_gate` 复读，有限 PASS，最终指纹 `020420e179a2ff3b19e5e8ea687f24eb5017ecc428381c2ee4422db71f1d04ee`，原三路径内容未变。

确认实际 driver 四方法与原 helper 合同；positions 使用原 [1,scope,startedAt,id] 游标格式与降序 tie-break，原 filter/factory/get/nextCursor 保持，空返回也完整。新增回归使用真实双 provider 表，逐项同时间继续、窗口变化、空 cohort 可断言。所有依赖在基准已存在，无未发布实现依赖。当前 Task owner companion 文件包含此前并行6行输出，完整保留，未纳入其他 RFC371 的未完成功能。

RFC108/287 只改变实际 policy 源位置并保持字段/类型原断言；RFC048 保持唯一解析点/唯一 spread/逐次读取及 selected/legacy 两臂；RFC359 的856、2462对应实际 insert 起始行，四站点、三必需列及 scanner/fixture 不变。commons-debt 原条目未改，新增五条 actual value:static-import，canonical ID 与四份 sourceDigest 逐项对上，inbound255→260，没有扫描豁免。正式类型与行为继续交修复 exact-SHA CI；没有本机 AW test/typecheck/build/service。本门不关闭全 H1、A-G 或 RFC。

终态 CI36924136910 为41 success／9 failure；新增三测试配套后，完整11路径候选再次由 `/root/task_config_functional_gate` 独立有限 PASS。最终指纹 `9ca7a28d5e0f93b101c3856d59ca8f0eed49128a7aeb2b5ca59230d358401c7f`，原八路径内容保持。RFC287锁 owner 导出类型／reader 返回类型与 legacy ReturnType 两字段；RFC332在真实 continuation/effect 开始时触发 barrier，全部未结算／顺序／释放断言保持；RFC363只设完整历史用例20秒上限，迁移实现及完整性／拒绝断言无改动。H3六路径在制不纳入本门与本次发布。正式结果继续等待修复 exact-SHA CI。

## H3 工作区维护有限实现门（2026-10-02）

独立首门 FAIL/P2：recovery 先枚举旧终态行，异步 exists 待回执时前台恢复／取消／finalize 开始新清理认领；物理目录已删但 ACK 未成，旧 heal 仅核对 pruned=null 可提前写完成。该失败输入保留，不把首门改写为通过。

六路径修正后 `/root/intent_functional_gate` 有限 PASS，指纹 `51e83940efeca6a06c7ef9b3fe2b939ef3c18b0df45ba449ff3c3a1100e010c6`。已沿读 Node adapter、Drizzle store、terminal claim／persistence、双 provider harness、既有消费者与四处生产装配。heal 原子检查 pruning/pruned、终态、deleted、worktreePath、lifecycleEventRevision，两个应用调用点传实际快照。真实双 provider、两实例 ACK success/failure 回归会捕获移除 pruning 条件，异步 false／异常回归会捕获遗漏 await；同步默认 Node 装配兼容。只有效果，不移走 AW 业务或恢复决定。未运行本机 AW 测试／类型检查／构建／服务，正式结果待确切 SHA CI。该门不涵盖恢复存在检查另批、完整 H3、A-G 或 CS 联合验收。

任务配置修复确切 SHA `c028b22c4a9a5281aa9013d4fac058c343f3a4f3` 的 [CI36928636248](https://github.com/wangbinquan/agent-workflow/actions/runs/36928636248) 已 completed/success，50/50作业 success，headSha 已核对；原 dd 修复前失败保留。工作区维护候选现在另批发布，其行为等待新的 exact-SHA hosted CI。

## H3 恢复预检存在查询有限实现门（2026-10-02）

`/root/task_config_functional_gate` 有限 PASS，十路径指纹 `ada4b1d9492b69d8aae8bd62ba362ca97d64eadd4fa81664e5b2d3f12c049e15`。沿读现 recovery/query/workgroup composer、SC public 与 file adapter、双 provider harness；await false/reject、多仓顺序及 this 接线正确，原409/410/错误传播保留。PG 原166语句只追加唯一 preflight presence binding 的全体 AST 对拍通过，W29 无放宽、SQLite 两摘要不变；未运行本机功能测试。该门不涵盖普通任务共用 lifecycle resume admission、完整H3、A-G或CS联合验收，下一批继续。

## H3 普通 resume 有限实现门（2026-10-02）

`/root/task_config_functional_gate` 对十一路径有限 PASS，完整指纹 `0d867898de6af0ebef9b3b838b0f72d9bc6f1af588fd2582cb9488734cd52217`。已完整读取普通 lifecycle admission、实际 provider/runtime/root/路由、schema、rollback 与测试调用链；所选实例沿真实普通 resume 和工作组使用，await/this/短路/phase 优先拒绝及异常正确，能力不进入 ChildResumeRuntime。新双 provider 回归以实际 route/runtime 验证等待期间和拒绝后的 intent/owner/revision 不变，停在既有 source-closed admission，不冒称完整 AgentTaskEngine 执行。完整 bootstrap AST 对拍与167语句守卫对应；尚未发布，完整 H3/A-G 未通过。

## H6 经典目录内容与存在事实有限实现门（2026-10-02）

`/root/intent_functional_gate` 十路径有限 PASS，指纹 `de242672ed852f5b19ea0c1d91a993196945416e8d49d253c8723c6fa7f48bd8`。首读两处确定回归为 D15 旧单行 import oracle 与新历史内容断言错误使用 version；现分别匹配实际四行导入、真实 versionIndex 和 content.bodyMd，其他断言保留。旧 finding 保留，不以首读未结束状态冒称 PASS。

完整候选及 boot、原创建/版本状态机、local 内容实现、workflow/validator/schema/authority/双 provider/三个实际 bootstrap 已读。query 保留 this、等待/错误传播与查询前后 boot gate；classic 转发原六内容端口，workflow 使用同一 availability。真实 selected root 创建/内容/历史/重装及 present/missing/unavailable 屏障和 DB 不变回归符合原 schema。尚未发布，本机没有功能测试；该门不关闭 H6 全量/A-G。

## H6 插件 local adapter 有限实现门（2026-10-02）

`/root/task_config_functional_gate` 四路径有限 PASS 指纹 `23cbffea3669a538e90f1c0c89f8c36911e128c13911e7b1800a72f6a01aac89`；首读的旧 createLegacyPluginInstaller 源码 oracle 已改为实际 local import/default selection，并保留全部其他合同断言。原四路径只覆盖新工厂的 CRUD/spec 重装/并发创建/GC，未把旧 wrapper 下的升级/OCC/补偿计入其证据。

随后补入真实升级/OCC/补偿测试使用的 helper，原四路径内容不动，五路径有限集成 PASS，末次指纹 `a1990aba074e48ba16de846f2cd2c72b7d6ef64c8dd0c432d266921b8240298c`。helper 每次 install/check 以当时三项 options 选择实际 local installer，原 hooks、repository、authority 和断言保持。默认空 options 不预冻 Paths；原错误分类和 generation cleanup 捕获保持，file 来源不清理。复用已有 PluginInstallerPort，没有另一份发布状态机或 CS 实现。尚未发布，无本机 AW test/typecheck/build/service；正式结果交确切 SHA CI，不关闭完整 H6/H4/H5/A-G。

## H1 启动安装能力选择有限实现门（2026-10-02）

`/root/rfc370_design_gate` 两路径有限 PASS，指纹 `1b4c2bdfd1fc574dad5487ba5a1d5f77d87655d702f838861680e32afb3c25a4`。所选 boot 输入只需 config、contract、configuration、installation，直接等待原 prepareDatabaseInstallation；不创建 file adapter、不加载默认 history，失败不回退文件分支。三处 CLI/main 旧消费者与最后公开重载的 PreparedFileDatabase 形状保持。七类原时序、错误和 generation oracle 分别覆盖 application 与真实 boot-composition 入口，全部原断言保留。

两候选完整文件及 installation application、两个 port、file adapter、generation/history/provider runtime 和相关 source oracle 已独立读取，无可构造功能 finding。另以纯 AST/类型擦除对拍确认去除唯一新增 selected 分支后，原 file runtime body 完全一致，摘要 `83baf6f003c27a3967fad510471ae26b1c61bebaadf213a72e560c6b9daa5d72`。首次临时证明脚本字符串换行错误已经修正，其失败未计为通过；未运行本机功能测试/类型检查/构建/服务。尚未发布，正式行为交确切 SHA hosted CI；外层锁、seed、宿主生命周期及完整 H1/A-G 仍未完成。

## H6 程序内容异步读取有限实现门（2026-10-02）

`/root/intent_functional_gate` 三路径有限 PASS，指纹 `c474477105a683cb7fc7ae9920440c8d24dc6109cf33f621799af246b7d04bdb`（allowlist 顺序）。复用已有 ProgramArtifactPort 与 DE module 的所选实例；自动升级及实际工具编辑读取逐项 await，保留 this、缺失／错误传播及原 source/digest/参数业务投影。新真实双 provider 的工具创建和编辑 query 使用 opaque content ref，等待期间及失败后工具数据库不变；仅执行能力使用显式 test effect，未冒称程序执行验收。

完整三文件和原 module/composition、schema、local adapter、两个调用点及双 provider harness 已独立复读，无剩余可构造功能 finding。目标格式/lint通过；尚未发布，没有本机 AW test/typecheck/build/service。正式结果待确切 SHA hosted CI，不关闭完整 H6/A-G。

## H6 流水线证据所选内容有限实现门（2026-10-02）

`/root/task_config_functional_gate` 六路径有限 PASS，指纹 `a7f91a49129236390bf04da24b17da460c0953b7f633f578327087fe6b488061`（allowlist 顺序）。DA application 拥有 EvidenceContentQueries，原 file text/range 效果移入独立 local adapter，module 只选择一次。实际任务 detail 与日志 operation 等待同一实例，原 manifest/schema/member 查验、4MiB clamp、UTF-8／截断／nextOffset 与 404 语义保持。

原 RFC310 range/HTTP 全部断言保留；新真实双 provider 的 mission/composition 回归覆盖 selected text/range 的 this、pending、missing、错误、clamp 与续读，等待和失败不改数据库。评审沿读实际 operations/module/route contract/harness，fixture 的 OCC 返回已修为实际 ok/revision 形状。该门范围只含证据读面，材料化、upload、archive 等余项仍持续；无本机 AW test/typecheck/build/service，尚未发布，正式行为待确切 SHA hosted CI。完整 H6/A-G 未关闭。

## H3 终态复活所选存在事实有限实现门（2026-10-02）

`/root/rfc370_design_gate` 十一路径有限 PASS，指纹 `a5e099827121d97c4ba0b0aa7da7b1ea6c827d69f48deede5ffa89d4f145cf7d`（allowlist 顺序）。runtime lifecycle required WorkspacePresenceQueries，async exists 保留 this、异常不回退；human-gate 和 recovery aggregate 复用同一 lifecycle，默认 file 只在 composition。原 phase／410、owner、guard、companion、事务和提交后事件顺序保持。

await 期间路径、生命周期 revision、清理、删除或来源状态变化时，成功复活和缺失回收均按原快照及当前生命周期判据拒绝，不误写。新真实双 provider 回归覆盖等待／true／false／reject／receiver／上述状态交错；旧五测试原行为判据保持，只补构造依赖和两个实际 composition 源码锚点。全部十一文件及必要 port、schema、交易与 legacy writer 已独立读取。本有限结论依赖调用者实际注入所选 presence；真实 boot roots 贯穿仍为下一步，不冒称完整 H3/A-G。无本机 AW test/typecheck/build/service，尚未发布。

## H1 安装示例完成事实有限实现门（2026-10-02）

`/root/intent_functional_gate` 六路径有限 PASS，指纹 `56602f31f27784262eca3e6b9f356a7048c9b07bfdc80d26565cd81ed543f1f9`（allowlist 顺序）。SO owner port/public、独立 file adapter 和 per-call composition default 将原 marker 效果分离；原两个 seed owner 和全部 sample input 不变。所选完成事实可异步，读取完成后才进入 owner，两个 owner 全成才写并等待 ACK；this 保持，read/write 错误原传播、owner 错误原 nonfatal retry。

新双 provider 真实 owner/schema 测试覆盖等待、写入时机、部分失败、marker 错误及幂等重试；原 RFC307/345/349 删除不重建与默认文件行为保留。两个真实 standalone 启动入口继续兼容 wrapper，该有限门不包括整个 H1/authority。marker 的 exact compatibility 入边单独登记 why/owner/A-T7 退役，原 scanner 不变。无本机 AW test/typecheck/build/service，尚未发布。

## CI 观测夹具类型修复有限实现门（2026-10-02）

CI36940613451 的 functional static job110631445644 仍报三处后端 test 类型错误，原失败保留。`/root/task_config_functional_gate` 对一份完整共享 RFC371 测试文件的九行修正有限 PASS，指纹 `cf45fd86d01f17482585ce32d291dcfcd16c4598c659e39338d529f91e411b18`。两个 unresolved matcher 的值／缺行失败条件等价，完整 capture fixture 补 sourceId/sourceCursor/resolutions 并用 satisfies；实际读取链前两字段不消费，resolutions 空数组等于原缺值回退。生产代码、预算、分页和数值判据不变，并行内容完整保留。

已精确发布并同步 `0120088f8557ef7357b69e0d0294dd5575d3c842`，只含该一文件；本机只作目标格式/lint，正式恢复等待其 hosted exact-SHA CI，未冒称全绿。

## CI 观测范围 URL 修复有限实现门（2026-10-02）

0120088f8 的 CI36942147693 已终态45 success/5 failure；类型检查已通过，三个平台观测 E2E 的主题前置失败与一项 macOS multipart clone timeout 保留。Windows trace 的实际错误是 router 拒绝 object-valued selection；所安装 TanStack 1.169.2 的 JSON-first search 对可解析 JSON string 再序列化，API transport 则仍传单份 JSON。

单文件首次候选 `70b572cb91f3b481a80505f3fd85076b79910a8c3ca72c24617560598a5cf6d7` 有限 FAIL：两处后续 page URL 断言也需按 router 层解码。保留该 finding 后，只修初始编码与两处页面 URL 解码，API 解码和全部范围/交叉模型/清除/主题/语言/键盘/Dialog/尺寸期望值不动；修正指纹 `2f47dfe1c7a4cb579a0e077b49ec69d993ce9e1cc75df9e91b0c30b995db92fb` 经 `/root/task_config_functional_gate` 有限 PASS及目标格式/lint通过。上库同步 `3ac730f84c9430459efb6d8fe72a6db9f5e8a1ed`，完整共享文件含原并行输出；macOS clone 失败未冒称已修、不抬 timeout，正式恢复等 CI36945626088。

## H3 journaled preparation 所选效果工厂有限实现门（2026-10-02）

初始六路径指纹 `fdea36675050fbf5882df1737abe1312acbe2c16207fbf685b61304c773523f6` 有限 FAIL/P2：participant 展开 effects 会丢 receiver 与 prototype 方法。保留 finding，显式转发两个方法到原实例，新增原型实例真实双 provider 回归。修正七路径指纹 `a256a3c48fcd5df6d54ca8383211d61d6642ba0302777a6a748e92458fbb5e58` 经 `/root/rfc370_design_gate` 有限 PASS及目标格式/lint通过。

factory 在 operation read 后等待，prepare 与 compensation 用同一 effects；原 assertCurrent 前后、running/close、journal CAS、checkpoint/replay/补偿失败重试与幂等回执保持。local 原物理 factory/schema 逐体对拍，默认十四字段绑定不变。该批尚未发布，排除54路径 canonical；其他 launch lane/scratch/sourceSeal、真实 roots 和完整 H3/A-G继续。

## H6 员工内容 local 实现落位有限实现门（2026-10-02）

四路径指纹 `fbfeabc42bf912d39e13f556cd7eaf9d12d15981b2d79ecaa4a51eac297b4da7` 经 `/root/intent_functional_gate` 有限 PASS及目标格式/lint通过。两种既有 program/input 物理实现原体移入各自 infrastructure/local；只变 factory 名称及 type-only import深度，旧入口准确具名 alias。实际所选 port、composition/三个根/既有真实回归不变；同步read/null/error、immutable digest、异步put、回读/复制顺序保持。尚未发布、排除54路径 canonical，input 的异步hasBlob/copy与消费者接线属下一步。无本机AW test/typecheck/build/service，不冒称完整H6/A-G。

## 2026-10-02 RFC-370 八组48路径发布候选

journaled preparation6、员工local4、插件安装6、generation GC3、附件异步完成5、终态 presence 真根10、提交预览 index6、归档内容8，共48个不同源码/回归路径；八组原有限功能 PASS 和完整指纹均保持，首门 findings 与所有历史 CI failure/cancelled 保留。按八个源码小提交、官方 scoped canonical/docs及五项已消费增长回执的后继退役发布，正式行为交本批 exact-SHA hosted CI。

官方规则及语料算法逐字保持，只纳入已提交 HEAD 加48候选：entry1792→1797、background338→339、imports5627→5661、exception4991→5024、owner25671→25691；公共出口1045、TE零 value SCC保持。六项真实插件 R1 兼容记录完整沿用此前证据，owner resource-catalog、A-T7 selected roots/legacy callers退役；现有292项记录完整保持，不扩大目录或规则。五项增长按原协议一次登记，在匹配 canonical commit 后退役。

归档 coordinator/legacy sweep 的原业务及SQL顺序、异步导出/manifest/move ACK、同 claim恢复和重试保持，RFC349仅定位真实查询源码；默认local位于独立包，真实root选择贯穿仍属A8。其他A1～A8、完整A-G、CS独立adapter及M0～M4继续，尚无AW-in-CS部署证据。仅目标格式/lint、源码/AST/JSON证明与官方scoped生成，无本机AW test/typecheck/build/service。下方所有并行输出与历史完整保留。

## RFC-370 已发布插件 facade 的 CI 清单补正（2026-10-02）

已发布 d5b266c893d07694d5f9c19b24e3642ba6473d19 的主 CI36966192393 终态 cancelled：42 success、3 failure、5 cancelled；不是通过。Ubuntu 后端8/16的实际失败是原 thin-facade 精确清单漏了已变为精确转出口的 services/pluginInstaller.ts；Lint/Typecheck/Format 作业在 Format check 因归档回归样式失败，另有汇总失败。Windows36966192408 failure 是该归档事件夹具的 text 被推断为 string。并行会话已发布69afa48c29234399b58dba3c463ad7068e3d7969，保留原事件值及批次/顺序断言，只加 as const 和对应格式；本候选不重复改该文件。maintenance36966192417、git-protocols36966192415均已终态 success，不能替代主 CI。

本批唯一源码变化为 RFC294 的 thin-facade 精确预期在 maintenanceState 与 protocol 之间补 pluginInstaller.ts。canonical facade 记录已为 thin-facade，旧服务源码只有原接口精确转出口；除这一行外，测试全文逐字等于变更前，所有分类、原断言、扫描规则及 canonical 正文保持。目标格式/lint和纯字节证明通过；/root/rfc370_design_gate 对唯一源码给有限功能 PASS，首末指纹 f32079215f31f791e6ab2435180ff68979e01a6434df38c15dc3f46226f7648c 相同，范围仅此预期/真实 facade，不能替代正式 CI。发布后 exact-SHA hosted CI 单独记录。未运行本机 AW test/typecheck/build/service。候选工作区13路径仍是独立在制，未夹带入本次修复；不关闭 A-G、CS adapter、部署或 RFC，所有历史失败与取消记录保持。

## 候选工作区与启动前恢复24路径有限交付（2026-10-02）

已发布修复 b339e7e06e13c7b4456cc1bf928048c7fc0262a3：主 [CI36969850886](https://github.com/wangbinquan/agent-workflow/actions/runs/36969850886) completed/success，50/50；同 SHA [Windows36970559143](https://github.com/wangbinquan/agent-workflow/actions/runs/36970559143) completed/success，1/1。d5b266c8 的 cancelled 42/3/5、Windows failure 和默认 Windows36970426040 的 cancelled 均保留，不冒称这些旧 run 全绿。原 mixed report 丢失原因仍未确证；本次成功不把它改写成已修原因。

A4 候选工作区13路径由 /root/task_config_functional_gate 有限 PASS，有序指纹 d4be4543ef93d4d5e643d4266ce382d5bbcc47f12d89dcd5323672ba9663a33b。所选 factory/session/workspace 接收 opaque references，独立 local 包持有原 clone、FS、模式/digest、Git scope 和 import 机制。AW 原 stage/derive/commit、排序/过滤/首错、消息/receipt 与 idempotence 保留；lineage digest 按原需求顺序异步读取，import ACK 后才收尾，workspace→session 释放完成才返回，DA 真消费者 finally 等 cleanup 后写 verification 事实。原三组9/4/8个回归断言保持，旧cleanup调用等待完成；新10个所选能力用例和双 provider cleanup 两例已写。共享 tree-identity helper原体保持，整个 push 部分与基准逐字一致；不把 push/node/wrapper/其他Git或完整A4记完成。

A1 启动前恢复11路径由 /root/intent_functional_gate 有限 PASS，有序指纹34de018343c3d0814c8aa4e27d2846050d29fe5374ecfb7428ffba4f8462aafc。中立 DatabasePreOpenRecoveryPort<THistory> 与共享准备层等待 history→generation，之后独立 restore phase；原穷举表的SQLite/PG决定保持，读取失败在实际CLI原restore catch之外。默认路径逐次读取，原post-recovery工厂仍在restore时bare-call；原pendingRestore物理body仅 ./restore import改为等价绝对路径，独立local存放，service的10个value/type兼容出口保持。实际CLI/composition其余声明逆变换token一致；三个oracle仅真实facade、已迁出类型债、表位置注释变化。新12功能例覆盖3ACK、receiver/sync、6kind/provider组合、opaque history、no fallback与错误阶段，finally释放收完。完整安装/人工恢复/外层锁/seed/宿主生命周期与全A1仍继续。

官方 census 只纳入已提交HEAD加上述24路径，原工具/扫描/语料规则保持。entry1803（原1797）、background342（339）、imports5686（5661）、required-port liveness38（37）、exception5048（5024）、owner25720（25691）；public1045、implementation SCC空保持。新增 required SPI 有真实共享consumer、file provider及composition三方owner绑定。原298条边界条款的owner/why/退役规定保留；仅按原口径增加pendingRestore→SO local的实际value/type两项R1，inbound267→269、outbound31不变，A-T7退役。六项真实增长按原协议一次登记，匹配canonical发布后后继退役，不扩大目录/规则。

按两个source小提交、scoped canonical/docs及六项消费回执后继退役发布，正式行为仍以本批exact-SHA hosted CI为准。只有目标格式/lint、纯源码/AST/JSON证明及官方生成，没有本机AW test/typecheck/build/service。有限源码门、已有修复CI与新批正式CI各自记账；A1～A8/完整A-G、CS独立adapter、M0～M4继续，尚无AW-in-CS部署，不关闭RFC。


## 24路径批次的六路径 CI 补正（2026-10-02）

发布24路径的末尾SHA为64bf703622b6a7899df8a82a9e4b1dec13185d33：源码13路径28a1d3973ef060507dcce7cc1db5be8bdfa1ef52、源码11路径4bfa7cae183eba91bebbd725d77a2c7399ea7fae、canonical a5a2a8a6456e7bfd4e6b7b2f1da7ecb94231ec75、六项消费回执后继退役。发布时main/origin精确同步、foreignDrift为空；文档唯一末尾空行补正有限delta PASS，原metadata门结论复用。原13/11路径有限PASS保留，原始24路径字节指纹不冒充下面类型补正后的指纹。

该SHA [Windows36976027391](https://github.com/wangbinquan/agent-workflow/actions/runs/36976027391) completed/failure、1失败；[主CI36976027404](https://github.com/wangbinquan/agent-workflow/actions/runs/36976027404) completed/cancelled、50作业中38成功/7失败/5取消。五个后端失败分片分别为Ubuntu5/6/9及macOS2/3；另外是Typecheck与CI required。失败、取消与原历史完整保留，不能以之前b339的成功替代本批验收。并行e8c9d73b13bf467c2e56b9abe2d9baf2f4765797仅含RFC371两个文档，已同步、源码候选不变；其CI36977794334也不记本批通过。

类型补正三路径：DatabaseProvider从真实platform owner/schemaContract纯类型reexport取值；五处expect<实际fixture类>(this)消除polymorphic this的TS2769，同时严格相等receiver、目标、顺序及所有运行主体保持。两处TS2305及五处TS2769日志逐项归因。/root/intent_functional_gate独立字节逆变换有限PASS，有序指纹b5d58435046f765ba6be12fa40bc7413cd87367ec357d44a5cd8735a8f46897f。

功能/fixture补正三路径：旧storage trait及DatabaseStorageShape在14个真实providerTraits消费者中已无实际读取，旧完整性检查只靠已迁出CLI注释命中；删除未使用类型/三个storage声明及其旧type文档，所有真实provider决策保持，原完整性测试仅删除这项已移除字段的两处断言，其他语料/规则/判据保持。macOS的RFC368 P2-2用例在固定50ms后仍见executionRef null，现等待事务持久化执行身份之后的真实launchBehavior进入，保持planned/execution-1/cancel原断言与原预算；finally释放held launch并await dispatch收完，不声称生产取消逻辑损坏。/root/task_config_functional_gate有限PASS，有序指纹3a9b47d632be3ff1fb972a9879fd7b3a6ac2a1cb3d0ae964eac4b0458cb0c631。六路径联合指纹b86da2d6ecaca2366c57e76780c655fc2910d86852708ad3ee47995929ff8596。

另外两项实际清单补正：provider-specific business dependency已因pendingRestore物理迁出而由24降23，仅该baseline及原因同步、并行nativeUsage说明和所有原条款保留；RFC321 exact Git fetch文件清单只增加实际fileRepositoryCandidateEffects路径，逆删这一行即旧ledger逐字相等，其他列表/记录和整个原扫描/断言规则保持。没有恢复旧注释凑consumer，也没有扩大语料或规则。

官方scoped census仅纳入HEAD加上述六路径，四个官方工具字节保持。imports5686→5687、exception5048→5049为正确解析的纯类型owner边，依原协议只登记两项真实增长，在匹配canonical提交后后继退役；owner25720→25719为删除未使用alias，entry1803、background342、liveness38、public1045及implementation SCC空保持。没有新边界豁免；非RFC294仅上述24→23数量变化。按两个source小提交、canonical/docs、两回执后继退役发布，正式行为等待后继exact-SHA hosted CI。

只做目标格式/lint、只读纯源码/字节/JSON证明及官方生成，没有本机AW测试、类型检查、构建或服务。原mixed report丢失原因仍未确证。完整A1～A8/A-G、CS独立adapter及M0～M4继续，无AW-in-CS部署，不关闭RFC。

## 2026-10-02 RFC035 固定来源链接的 CI 修正

修正tip `55b1104a812c247f692f5450b6738e299d437bc1` 已上库并精确同步；Windows36980819374 completed/success、1/1，headSha一致。主CI36980700296已completed/failure、48success／2failure／0cancelled；仅Markdown link check及CI required聚合失败，其余作业全部成功，不能记全绿。失败日志只列 rfc035-storage.md 的三个CS固定版本blob URL，均为503；PUBLIC仓库/精确提交已由GitHub API核对，三个相同SHA/路径的raw内容URL实时HEAD200。

本次只替换这三个来源链接，完整正文经反向替换逐字等价；保留全部合同/事实/固定SHA与路径。没有改checker、接受状态、重试、预算或CI其他步骤；新确切SHA正式CI另验，原失败和取消记录保留。配置叶层14路径有限PASS与selected根/真实双provider新用例独立在制，均不纳入本次文档提交或canonical；所有数值/规则/源码不动。无本机AW test/typecheck/build/service；完整A-G、CS adapter和M0～M4尚未完成，RFC保持进行中。

## 2026-10-02 所选live配置与排空有限门

五组源门均仅源码/必要功能下游复核，不替正式hosted CI，也不关闭完整A1/A7/A8/A-G：

- 叶层14：dbfb8db829287e32bf7e6f6089d9e820dad9078fa08f2744cc81efe984dd943e，有限PASS。9生产文件与4旧测试精确逆变换全文保持；六类purpose读取支持Promise并在原点等待。新增memory准入ACK和terminal三例，原双provider回归保留。
- 所选根6：9ecee8b6918f0099f0ac12584a22daef9f8984b9880c00190bf2986e604d5611，有限PASS。同一实例传入实际PG/SQLite daemon app及两个HTTP根，重装读取nextConfig；新真实双provider发现热读、schedule三段ACK前无写/launch及失败无file fallback。W29四摘要按原纯AST生成，原167/48/65/4 counts及全部规则保持。
- 周期原语2：e5773754335375ab1f872f2d0cf4daf7973e0f4409a0fbecd95ca4071f87f5de，有限PASS。active覆盖原完整then/catch/finally，stop保留准入tick并禁止rearm，awaitIdle等其结算。两新fake-timer用例、旧测试全文保持；onError回归回调同步，异步错误链的其余等待只有源码证据。
- 仓库刷新2：首门e32c42c13b850b84e72c9a6b899a193709cab6ea71efe3e50531fb7bf6dbd2d0为FAIL/P2：拒绝的hot read使drain跳过已准入tick。修正56bc21f94d69c8f961ef5cfef05bfadcf92b73a9be90146d056887cb4a46e594有限PASS；先allSettled所有读取，再job.awaitIdle，reconfigure仍原样传播错误。四个真实双provider例覆盖初始ACK、receiver、hot读取、latest重配、stop后late ACK、拒绝与tick共同排空；原刷新政策、SQL及同步bool兼容保持。
- 备份排空2：首门1e3e05651cbb719cc79488baf09882a4906e1df0e4dcf674ab2e756e4270cad8为FAIL/P2：同步provider回调可在active登记前开始drain。修正8f3c75fdf9630c374ff60c627bd8b5b6c2bddb32fcd94ed007adad3ab5aa7c64有限PASS；微任务进入callback前先登记active。三个ACK例覆盖成功/失败、重入stop/drain、原wake；精确逆变换保持旧production全文，retention/Wal政策不改。

26路径有序联合指纹e5fa1807c6fc5e3fe4ed6e5a9e8ad4fc857b464aa4f48a31923856cd8fbadb94。scoped canonical只有四项实际增长：entry1803→1805、imports5687→5689、exception5049→5051、owner25719→25723；public1045、background342、liveness38及implementation SCC空保持。增长按原协议一次登记/匹配canonical后继退役；全部扫描规则和边界条款保持。

e4d6f5b2 [CI36984501133](https://github.com/wangbinquan/agent-workflow/actions/runs/36984501133) cancelled、27 success/2 failure/21 cancelled，三个CS raw来源通过，失败是RFC371既有OpenCode来源503及aggregate；不记全绿。并行三个文档c843938a完整承接，其[CI36985769914](https://github.com/wangbinquan/agent-workflow/actions/runs/36985769914)已completed/failure、48成功/2失败，失败仅OpenCode来源503及聚合。原55b1104a主48/2失败、同SHA Windows1/1成功全部保留。本批实际执行以发布后精确SHA主CI及Windows为准。

17路径metadata首门另有文档事实P2：c843 CI在复核期间刚进入终态，新增节的“待终态”已按精确回执修正；该finding和原候选指纹f162d6ecbbbbdd592d10d583f7083e8b060176f8991e6268a1366a697aeadbdc保留。独立单文档CI引用修正有限PASS，指纹32ba3a45fec8988daf421e3bb9a64bb4d45d00ab91f9d92158bae8c0e6a32fdf；按CLAUDE原规则把同固定提交/路径/行号的OpenCode blob超链接改成文本引用，逆变换旧全文逐字一致，原RFC371输出全部保持，不改任何事实、checker或预算。该文档以另一个小commit同批发布，正式恢复仍待本批exact-SHA CI。

## 所选配置读写真根与后台排空有限实现门（2026-10-02）

所选配置读写绑定9路径与通知ACK2路径分组独立有限PASS，完整11路径互不重叠。ACK首门指纹4964cf6701d9373c6bc7fc2d416ecbe549473e4bc30dc9663b782147d5017a55的FAIL/P2保留：合法旧void回调隐含返回number也曾被当作异步；现只收真实thenable，原三组回归完整保留并补typed void的number/null兼容例。修正两路径指纹4d5ce8e541ad00b7b47bd9e85e7711081dd9352a27116179accbfff6b93797ae；九路径指纹213ea64f2d241e6f4e9898bdccb3bcf83b46790bdb04f610a828fcdb5ab708f8。

三个真实start/PG/SQLite根选择一次binding；selected同一persistence receiver供live query与Settings commands，逻辑通知key无需本机路径，旧query-only显式注入保持兼容。Settings原校验/probe fence/失效/保存/通知/日志/对账/池容量顺序保留；真实双provider HTTP用例覆盖held write及held hot-apply ACK、GET/discovery一致、读写失败500及本地config全文不变。CLI维护在原时点读所选query，TE background/idle/batch贯穿，backup/refresh启动await、同实例stop/drain。PG queued Intent读所选源，SQLite剩余resume及runtime/迁移/宿主切面仍继续，不把本批记成完整A1/A7/A8。

三完整composition body的严格局部逆变换恢复原W29摘要；只增加一个binding声明，PG167→168、SQLite48→49，API65/EC4保持，原phase/lifetime判据保留。官方scoped census只取HEAD加11路径，四原规则逐字保持：imports5689→5692、原exception投影5051→5054、owner25723→25726；实际八条边替换五条，三个owner为新文件/type/factory。entry1805、background342、public1045、required-port liveness38及implementation SCC空保持。三项增长按既有协议登记，canonical发布后后继退役，不新增边界条款或豁免。

前批26源码及17配套已按七个小提交发布并精确同步7170360814136a31c494fe380092d5d7655dde8d；原OpenCode文本引用以并行81d6d54f的三个完整共享文档承载，不另外提交旧单文档快照。其Windows [36990563985](https://github.com/wangbinquan/agent-workflow/actions/runs/36990563985)已completed/success 1/1、headSha严格一致；主CI36990280728的2026-10-02T09:44:39+00:00读取快照为queued、非终态，不能用该快照断言最终通过或失败；终态另记，全部旧failure/cancelled保留。只有限定format/lint、源码/AST/JSON证明和官方生成，无本机AW test/typecheck/build/service。完整A1～A8/A-G、独立CS adapters、M0～M4持续；尚无AW-in-CS部署，不关闭RFC。


## 2026-10-02 手动迁移所选入口有限门

四路径由 /root/intent_functional_gate 独立有限PASS，有序指纹02890cdb5dce0365f295189d8df6dd91e25b8054385710f5e498ca40a475b8a3。首三路径指纹5ea5eae062623f5b1b89ae283f3f502c72b5e4eb89c7e6a93f5be81bdf31d791的FAIL/两个P2完整保留：cli.test.ts原prepare入口字符串失效；PG current generation缺失其必需manifest，合法输入会落入夹具抛错的readMigration分支。修正仅更新旧test一个入口锚点，逆变换全文相同；新PG夹具经原纯phase machine到finalized，generation schema核对合法并引用相同manifest，真实readMigration/resolveRecoverySource有receiver和合同断言。原八例ACK、错误优先级及释放收尾判据保持。

实际CLI选择SO窄composition，selected从同一configuration初读并将同实例交恢复，installation使用现中立合同；异步读/准备/安装释放/provider close逐步ACK才返回。default file仍原Paths、migration folder和provider准备；CLI从provider声明到输出/finally的完整尾部与旧版本逐字相同，穷举mapped runtime沿现DatabaseProvider扩展。没有CS实现或local fallback。

官方生产语料仅HEAD加不变的两条生产候选，另两条是回归；原sourceDigest只含生产source，修正test不改变生产projection。四原规则逐字保持，三项实际增长各为5：imports5692→5697、原exception5054→5059、owner25726→25731；六条实际边替换一条，五owner为新file/private runtime/两used type/prepare factory。其余ledger数量及原value SCC集合不变；public1045、entry1805、background342、required-port liveness38保持。两条真实CLI R1 type/value替换旧direct边，inbound269→270，owner SO、A-T7退役；全部其他条款保留。原governance projector核对条目/回执相同，三增长receipt依原协议匹配canonical后后继退役，不改scanner或目录规则。

前批96eb71db5dcaadbc2c0c0aa6bfe59cedb5e234ed的[Windows36993443952](https://github.com/wangbinquan/agent-workflow/actions/runs/36993443952)已completed/success 1/1、headSha核对一致；其主CI36993377294尚未取得终态回执，不替本批CI。7170360814136a31c494fe380092d5d7655dde8d的[主CI36990280728](https://github.com/wangbinquan/agent-workflow/actions/runs/36990280728)已completed/cancelled，19success/1failure(CI required聚合)/30cancelled；原带时间非终态快照继续作为历史保留，不能改记成功。

只有目标format/lint、源码/字节/JSON证明和官方生成，无本机AW test/typecheck/build/service。正式验证仍待本批exact-SHA CI；完整A1～A8/A-G、CS独立adapter及M0～M4持续，无AW-in-CS部署，不关闭RFC。

## 2026-10-02 人工迁移、运行时所选配置与 CI 断言接续

前批 96eb71db5dcaadbc2c0c0aa6bfe59cedb5e234ed 的 [主 CI36993377294](https://github.com/wangbinquan/agent-workflow/actions/runs/36993377294) 已 completed/cancelled：42 success、7 failure、1 cancelled；同 SHA [Windows36993443952](https://github.com/wangbinquan/agent-workflow/actions/runs/36993443952) completed/success 1/1。四个后端失败分别指向两处已滞后的源断言：memory-distill 仍查本地 loadConfig，W29 将所选诊断工厂误查成 direct call。现对应真实每 tick 所选 read 和两根的 phase/unstarted 工厂调用，原工厂数、timeout/四旋钮及同 configuration 参数断言保留。Lint 的 submoduleRefresh.ts:244 已由并行 3bf8cc6c6364773f251b4fae9ea0399b2be349c8 显式 void 修复；其三个完整文件已同步承接，不归入本批源码提交。原失败/取消及 717 的主取消 19/1/30 全部作为历史保留；不能将 Windows 或有限源码门记成主 CI 全绿。

人工迁移四路径有限 PASS 02890cdb5dce0365f295189d8df6dd91e25b8054385710f5e498ca40a475b8a3 及首门两个 P2 完整保留。运行时真实根四路径另由 /root/task_config_functional_gate 有限 PASS，指纹 400cb6451c7747f95c587b96adbf12d90cf23385af848dd8249d5d5aafdd35f1：PG/SQLite runtime-management 的 current 每次调用同一所选 configuration.read，probe fence 与 Settings 共用 applicationConfiguration.notificationKey；默认文件 binding 的 key 保持原 configPath，沿现 KeyedSerialQueue。双 provider 真实 HTTP 夹具覆盖 held read ACK、热切默认 runtime、unsaved probe 使用所选路径及读取失败无回退。两生产文件完整逆变换和 W29 原数量 168/49/65/4 保持；W29 此前只两 digest 变化，新 CI 工厂查找修正单独记账，不改原生命周期规则。

旧人工迁移 17 路径 metadata 在 96eb 冻结候选获得有限 PASS 78b9b1cf03e87ae6f3df9dc041d60d8265938ef011141b13e5fea240d5417c98。HEAD 前进未取消该门；后继 canonical 基于 3bf8cc6 的完整已提交源码加本批九个不同源码/回归路径重生，四原生成规则逐字保持。运行时 binding 与两个 oracle 未新增受控数量，仍只有人工迁移三项实际各 +5：imports 5692→5697、原 exception 投影 5054→5059、owner 25726→25731；entry1805、background342、public1045、required-port liveness38 及原 value SCC 集合保持。两项 CLI 实际 R1 替换一旧边、inbound270/outbound31 及 SO/A-T7 退役条件不变。三条既有 growth receipt 不重复登记，须在匹配 canonical 提交后仅退役这三条。后继 17 路径属于有限 delta 门，正式验证交发布后的 exact-SHA CI。

仅运行目标格式/lint、纯源码/AST/JSON证明和官方 scoped census，没有本机 AW test/typecheck/build/service。SQLite queued Intent、runtime legacy boot、配置 CLI/doctor、外层锁/宿主生命周期及其余 A1～A8 继续；完整 A-G 尚未关闭。独立 CS adapters 和 B/M0～M4 保持批准的顺序，尚无 AW-in-CS 部署，不关闭 RFC。所有旧正文、并行输出及 gate/CI 历史完整保留。

## 2026-10-02 Runtime legacy 与配置 CLI 的 A1 增量

两组共七个不同源码/回归路径分别获有限独立功能 PASS。Runtime legacy 三路径指纹 7300f41bb3aa9b1cae5a325beeee5c9f4bc7f646afcf6e05f6e6e8f1c832d5d3：复用既有 RuntimeLegacyConfigurationPort，start 只选择一次并将同一 receiver 传至 PG/SQLite 初次及 target 重装配；默认文件工厂保持 lazy，原 seed/backfill 后的 guard 读取时点和旧字段拒绝/未读到时的既有安装判据保持。双 provider 三例覆盖 held ACK、每次 boot 当前 raw 内容及所选读取失败不借另一文件；两生产文件全文逆变换一致。

配置 CLI 四路径指纹 ebb45d221e89268c2a728b20a30c53e8d233fbad816659b07e5d7882c72e1645：复用 SO ApplicationConfigurationPersistencePort，经独立 cliConfiguration composition 选择本机默认。原单参数调用保持同步结果与同步抛错；selected 读写返回 Promise，等同一 receiver 的 load/applyPatch ACK，不借本机文件。get 的整份 JSON/单键输出、set 的 JSON-first 解析与格式政策完整保留；持久化工厂只有同步返回类型推导/satisfies 改动，runtime 正文逆变换一致。六例覆盖 held 读写、当前值、一次 patch、无关并发设置、错误及同步兼容；main 调用和原 cli.test.ts 全文字节不变。

官方 scoped canonical 仅已提交 ba47e5d24c4f8f95f27defb82545ea1766b0e7a9 加这七路径，四原生成规则逐字保持。实际新增三条 symbol import：raw port type 与 config CLI 的既有 persistence type/used file factory；imports 5697→5700、原 exception 投影 5059→5062。六个 owner 是五个私有已用 CLI helper 与一个 SO composition file，25731→25737。entry1805、background342、public1045、required-port liveness38 与原空 value SCC 保持。只给实际 CLI type/value 两项 R1 记账，inbound270→272、outbound31；原 bootstrap 列表、条款和所有旧记录保持，owner SO、A-T7 退役。三项真实 growth receipt 一次登记，匹配 canonical 提交后另行退役，不把新切面作为规则豁免。

截至本节候选冻结，上一批 ba47 的 [主 CI36997889808](https://github.com/wangbinquan/agent-workflow/actions/runs/36997889808) 尚未取得终态回执；同 SHA [Windows36998073470](https://github.com/wangbinquan/agent-workflow/actions/runs/36998073470) 已 completed/success 1/1，headSha 严格一致。前批 96eb 的主取消42/7/1、Windows成功及更早717取消19/1/30等原历史完整保留；不能把有限源码门或 Windows 记成主 CI 全绿。正式行为以发布后的 exact-SHA hosted CI 为准。

只有目标 format/lint、纯源码/AST/JSON证明与官方 scoped 生成，无本机 AW test/typecheck/build/service。doctor 配置、SQLite queued Intent、外层启动锁与宿主生命周期、安装/恢复剩余入口及其他 A1～A8 持续，完整 A-G 尚未关闭。独立 CS adapters 和 B/M0～M4 仍按批准顺序推进，尚无 AW-in-CS 部署，不关闭 RFC。下方/既有全文、并行输出及全部 gate/CI 历史完整保留。

## 2026-10-02 CI 终态接续与 doctor 配置读取

上一批 ba47e5d24c4f8f95f27defb82545ea1766b0e7a9 的主 CI36997889808 已 completed/failure：46 success、4 failure、0 cancelled；同 SHA Windows36998073470 completed/success 1/1。旧节的未终态快照作为当时冻结事实完整保留，不改写失败历史。两个后端失败作业 mac1/110809149232、Ubuntu5/110809148997 都只有 RFC359-W5 unattended void 数量多出 services/submoduleRefresh.ts:1。原 reconfigure 的返回值为 boolean|Promise<boolean>；此前 lint 修正的裸 void 被原守卫识别。本次只接住调用结果，对 Promise 分支加拒绝处理和原日志风格，同步返回/抛错、initial/revision/排空与其余完整正文保持。单路径有限 PASS d0a74e255a74706796fee2bab1ad3f4c8c9e4f5da21471913495386db36a399f，原 W5 scanner、账本、负夹具和数量全部不变，无类型压制或检查放宽。

doctor 配置三路径修正后有限 PASS ab326f13a63d3d70b4b6085786c09f8a52b3789960d74ce687517ec6f8b1e398。复用既有 ApplicationConfigurationQueries，独立 SO doctorConfiguration composition 提供 lazy 默认，真实 doctor root 将同一 selected receiver 传给三处配置读取。selected 等待读取 ACK，忽略本机配置存在性，不借本机文件；默认缺文件/已加载/schema和原 Error 文案保持。首门 d461b32c7d794aceb2850c101725ed3a4942c2c3e26cb50d507ac9c2851071dc 的 FAIL/P2 保留：非 Error 拒绝曾使 catch 再抛错或返回 undefined，现转成 String 诊断；null/string/undefined/42 四例回归已补。原六例、双用途失败早退及真实 root AST绑定保持；十步纯逆变换恢复原完整文件，其他诊断正文未改，未执行整个 doctor。

七路径 source 和17路径 metadata 的首 PASS 498cd3b9b88e739edc89b6c4f0c4b6e4ae5a4f11851ed7e998c5195e2421a84a 保留，后继先纳入单路径 CI 修正，数量不变，再纳入已通过的 doctor 三路径。最终官方 scoped 输入为已提交 ba47 加11个不同 source/test路径，四原生成规则逐字保持。总 imports5697→5702、原 exception5059→5064、owner25731→25739；doctor 实际增加 purpose factory value/public query type 两边及 composition file/used factory 两 owner。entry1805、background342、public1045、required-port liveness38及原空 implementation SCC保持。实际新 R1 共三个：CLI type/value 两项、doctor factory value 一项，inbound270→273/outbound31，SO owner/A-T7退役明确；原 bootstrap 列表、条款及所有旧记录保持。原三条未消费 growth receipt 的理由完整保留并追加 doctor 的实际增量解释，没有重复新登记；匹配最终 canonical 提交后另行退役。

按 CI修正1、raw legacy3、config CLI4、doctor3 四个 source小提交，再配套 canonical/docs和三项回执后继退役。17路径后继仅做有限 delta复核，不取消或复跑已完成的旧门；正式行为等待新 exact-SHA hosted CI，不把 ba47 或 Windows记成主 CI全绿。只运行目标 format/lint、纯源码/AST/JSON证明及官方 scoped生成，无本机 AW test/typecheck/build/service；原文档格式告警只来自既有历史空行和原 generated renderer，新增节已符合格式，未整篇改写历史。

SQLite queued Intent、外层锁/宿主生命周期、安装恢复剩余入口、doctor其他目的能力及其余 A1～A8 继续，完整 A-G 尚未关闭。CS独立 adapter 与 B/M0～M4保持批准顺序，尚无 AW-in-CS部署，不关闭 RFC。全部原正文、并行输出、首门 findings及 gate/CI历史完整保留。

## 2026-10-02 doctor 回归的 Windows 编译补正

前批28个不同文件已按六个小提交发布，main/origin 精确同步7b3bf7f4574671ac4d71cfa5e3a1c3ff52eb6313；三条已消费 growth receipt在匹配canonical之后退役，所有数量/原理由与并行正文保持。该 SHA的 Windows37004034478已 completed/failure 0/1，实际功能作业110828029081失败于backend typecheck：rfc370-doctor-configuration-bindings.test.ts:196的expected message仍是string|undefined，Bun expect重载要求string。shared/frontend typecheck在同一日志成功。同SHA主CI37003820059已completed/cancelled：26 success、3 failure、21 cancelled；maintenance37003820306已completed/success 1/1。两项回执分别保留，不把maintenance或旧SHA的成功记为主CI全绿。

本次五路径首候选1ab123f968db3dcd69fb1a72c9494476876635719c9234d3d39f115370cee873的有限FAIL/P2保留：四份新增节仍把已完成回执写成等待。这里只校正这四段终态；三行源码补正独立有限PASS 57562e19d4b18ea44a67c89bdc8d59aa0dcb75342d2d2a2097566b161ddc1649保持，不重跑未变源码门。

唯一源码增量是该既有测试的显式控制流判据：原toBeDefined断言后，若没有原load错误消息则立即抛出夹具失败，随后message被收窄成string。原load调用/默认错误文案比较、全部断言与预算保持；删除这三行即恢复发布测试全文字节，不改任何生产实现或用类型断言压制错误。正式修复仍交新exact-SHA hosted CI。

官方production corpus、两份sourceDigest附加输入、四条生成规则及12份canonical JSON均与7b已提交内容逐字一致；此测试/记录补正不改sourceDigest、数量或增长回执，不重复生成canonical。只做目标format/lint、纯源码/字节证明与有限独立功能门，无本机AW test/typecheck/build/service。并行未提交改动完整保留，原Windows失败、doctor首FAIL/P2、所有旧gate/CI历史保留。queued Intent及完整A1～A8/A-G、CS独立adapter、M0～M4继续，尚无AW-in-CS部署，不关闭RFC。

## 2026-10-02 queued Intent admission 与 scratch 工作区效果选择

两组15个不同源码/回归路径已分别获得有限独立功能 PASS：queued Intent 七路径指纹 `113035adc56532b65ed9b7e3fdf7dee952c862ceacd55d772472f65bf091c888`；scratch 八路径指纹 `c3a95e67571a3152d7891cd0c245978ef40ea91528e40bd6ad21d83c9fe4ecab`。未变源码门复用，不随 HEAD 移动取消或重跑。本门仅覆盖 queued admission lifetime 和 scratch 效果选择，不覆盖已派发 turn 的完整执行 lifetime、完整 launch lane 或全部 A3。

Intent application 拥有冻结通知缓冲、按原政策去重、激活后读取当前 selected configuration、stop admission fence 与 drain ACK；同一 purpose composition 贯穿 SQLite/PG 真根，并首先登记为 provider runtime factory。冻结时不读配置、不启动效果；stop 后不再准入，未准入 IDs 可按原回滚重装配重试，已经准入的 Promise 及错误报告 ACK 排空后才可重启。PG 使用准入时获得的配置，不另读一次。原后台 oracle 仅修改真实工厂接线判据；W29 原168 statements、8 phase blocks 保持，原 PG digest `ac88a77b30ad4f6f4259301edb7af568661583514efc37073f2a11a18eb6a112` 按实际接线更新为 `d636c6a8a0459df274ddce6850cc6ac15313e45a2103f0da911e4f61df690d07`，没有放宽原规则或数量。

SC 将既有七类 workspace facts 原样移入 application 并保留旧 type 出口；原 materializer 全部 runtime tokens 不变。独立 file scratch adapter 承接原 prepare/cleanup 物理调用和本机路径恢复判据，owner composition 保留原 pre/post fence 及 version/task/kind envelope 判据。TE 真实 journal 在原位置 await selected restore，prepare/restore/cleanup 使用同一 receiver，opaque workspace 引用可恢复；原 record-before-act、补偿、错误、重试、清理 ACK 与 admission 顺序保持。真实 journal 的双 provider 夹具覆盖 held ACK、重放、失败补偿及 envelope 拒收；既有文件 scratch 回归完整保留，未在本机执行测试。

官方 scoped census 只纳入已提交 `fc52e3beb91ce987bccab19f1333bbc2a3d91e7a` 加上述15路径，四条原生成/扫描规则逐字保持。实际数量：entry1805→1807（两个已用 factory）；imports5702→5706、原 exception5064→5068（四条实际 symbol edge）；owner25739→25752（20个真实新增、7个原样迁移类型的旧 owner 移除）。background342、public1045、required-port liveness38 与原 implementation SCC 集合保持。原 boundary scanner 没有新增 R1/R2；273 inbound/31 outbound、全部原 owner/reason/退役条款和 bootstrap 列表保持。四项真实 growth receipt 按原协议一次登记，匹配 canonical 提交后另行退役，不扩大规则或目录豁免。

前批 doctor 编译补正已按两提交发布至 `fc52e3beb91ce987bccab19f1333bbc2a3d91e7a`。该 SHA [主 CI37007544133](https://github.com/wangbinquan/agent-workflow/actions/runs/37007544133) 已 completed/failure：48 success、2 failure；功能失败是 Windows shard4 的 mixed wrappers + humans E2E，另一个为 required 汇总作业，原失败保持并继续处理。人工 [Windows37007607865](https://github.com/wangbinquan/agent-workflow/actions/runs/37007607865) 被后继请求取消，日志没有新的 TypeScript 错误，不能记为通过；同 SHA 定时后继 [Windows37008086312](https://github.com/wangbinquan/agent-workflow/actions/runs/37008086312) 已 completed/success 1/1，单独记账。所有更早失败/取消及首门 findings 完整保留，不能将 Windows 或有限源码 PASS 写成主 CI 全绿。

按 queued7、scratch8 两个 source 小提交、17路径 canonical/docs 和四项消费回执后继退役发布；正式行为仍交新 exact-SHA hosted CI。只做目标 format/lint、纯源码/AST/JSON证明及官方 scoped 生成，无本机 AW test/typecheck/build/service。A1 启动安装配置桥接、外层锁/宿主生命周期、其他 A2～A8/完整 AC00/A-G 继续；完整 A-G 后再实施独立 CS adapters，B/M0先部署再逐项 M1～M4。尚无 AW-in-CS 部署，不关闭 RFC；全部旧正文和并行输出保持。


## 2026-10-02 数据库启动 binding、完整 queued 装配与 nested handoff

A1 启动数据库桥接四路径有限独立 PASS，指纹 `e989a838079f640633994e9600213d8b58fe9bd113541fbf41eff37b263d067a`：同一 ApplicationConfigurationBinding 提供数据库配置 purpose，lazy read/write 使用同一个 persistence receiver，write 仅 patch database 并等待 ACK。StartOptions 独立选择 installation；默认 file 分支仍调用原 prepareDatabaseInstallation 和 local adapter。两个既有生产文件的有限逆变换恢复旧全文，原参数、pre-open restore、backup callback 和错误正文保持。旧 query-only override 仍保留文件数据库行为；六个回归覆盖 held activation/release ACK、独立设置、失败无回退及恢复读取时点，未在本机运行。

上一批已按四提交发布至 `9e8db61f0a96f43026e9614547e436cfb91aab61`。[主 CI37012684652](https://github.com/wangbinquan/agent-workflow/actions/runs/37012684652) 已 completed/failure：44 success、6 failure；四个后端失败分别复现同两类接线问题——SQLite 新增 nullable intentDispatchDeps holder、Intent composition 引入 SO offered DAG 外边；另一个 macOS 分片失败为既有 local-gate-runner 的 post-exit descendant marker 断言，及 required 汇总失败。五份功能作业日志单独留档，不将原未变 runner 的一次失败写成已修复，新批 CI 继续验证。人工 [Windows37012958481](https://github.com/wangbinquan/agent-workflow/actions/runs/37012958481) 已 completed/success 1/1；同 SHA 先行 [Windows37012684548](https://github.com/wangbinquan/agent-workflow/actions/runs/37012684548) completed/cancelled 1/1，分别保留。更早失败和取消完整保持。

两处接线问题在四路径候选有限独立 PASS，指纹 `7bcc7c077538bdebc85d2d731813b923f772337455d4f195acd69791f6fd5235`：Intent 使用自己所需 reader 的结构合同，删除 SO offered import；SQLite 维护前只创建纯 ID inbox，完整 const 依赖就绪后才连接原 frozen queued lifetime，再由原 provider 首项启动。删除新增 nullable holder 及未装配 throw；原占位守卫、offered DAG、债务条目及 queued application 全文逐字保持。新增 cold notification transfer、去重、重复连接拒收和 selected ACK 回归；真实根 oracle 只迁到实际 notification/full binding 接线，原一实例和首项注册判据保持。root 的完整有限逆变换恢复上述 A1 已 PASS root，其他 A1 三路径逐字不变；七个不同源码/回归路径以组合门覆盖发布，指纹 `b5a7be880643b757ff2022c737b8c80e1344c57edb6f1c187628e82ddc28c081`，不冒称另一次全量门。

nested Git/loop wrapper 将原 TaskScopeOutcome.handoff 逐层传回：真实 interrupted ledger ACK 后才发布控制信号；不终结 wrapper 行或抹掉 progress，重入同 frame/runId。scope 冻结新准入，等待已准入 ACK；已确认 handoff 后的普通 rejection 排空后原样抛出，同时冻结 autoCommitPush synthetic。原全局 NodeStepOutcome/legacy result 五分支不变，非 handoff 异常、取消及 processUnreaped 政策保持。九路径第三候选有限独立 PASS，指纹 `7f317488e1b2c2d8d981f5edb4f04e6bc43d156bf4b383d2acb784d350da9254`；首候选 `e28c79c77d5d055c0501bdff9b575143ca17c870df154ee3c637e7099ac4bef7` FAIL/P2 的异常未排空及 synthetic 继续准入、第二候选 `dcee5c92e094891333644d1e28fe0218acaa11f125eacdfb1bf4912a667db16b` FAIL/P2 的 readonly 夹具赋值，全部保留并已有限修正，屏障和原断言不变。原 E2E 定义与断言保持。

官方 scoped census 只纳入已提交 9e8db61f 加本批16个不同源码/回归路径，四条原生成规则保持。实际 entry1807→1808（一个已用纯 inbox factory）；imports5706→5707、原 exceptions5068→5069（三条真实 root symbol edge 新增、旧 preparation value 和 Intent-to-SO type 两条删除）；owner25752→25762（十项真实 owner 新增）。background342、public1045、required-port liveness38 及 implementation SCC 集合保持。原 boundary scanner 无新增 R1/R2，273 inbound/31 outbound、全部原 reason/退役条款和 bootstrap 列表保持；四项真实增长按原协议一次登记，匹配 canonical 提交后另行退役。

按两个 source 小提交（wrapper 九路径、启动及完整装配七路径）、17路径 canonical/docs 和四项消费回执后继退役发布；全部旧正文与并行输出保持。只做目标 format/lint、纯源码/字节证明和官方 scoped 生成；无本机 AW test/typecheck/build/service。正式修复交新 exact-SHA hosted CI。有限门只覆盖本批，外层宿主锁/生命周期及其他 A1～A8/完整 AC00/A-G 持续推进；完整 A-G 后才实施独立 CS adapters，B/M0 先实际部署，再逐项 M1～M4。尚无 AW-in-CS 部署，不关闭 RFC。


## 2026-10-02 归档真实根接线与 nested handoff 回归夹具补正

A2 归档真实根九路径有限独立 PASS，指纹 `f9a5659c85fb50b3a0158e9d1d56157959c7eca2159335106bbe7effc7750136`。TaskArchiveContentBinding 将所选 content 与三个逻辑根一起传入 StartOptions、provider session、SQLite/PG runtime 和 standalone HTTP。composition 冻结所选根，调用者的 now、retention、maxTrees、actor 和 preview 仍由原协调器裁定。SQLite daemon HTTP 优先复用 boot 同一 command；PG 原共享实例接线保持。原协调器、local content、temp sweep 和 route 完整字节不变；27 项有限逆变换恢复八个旧文件全文。五组新增行为回归覆盖双 provider helper、manual、held recovery ACK、失败无本地回退及真 HTTP manifest ACK/claim 保留。W29 只按真实接线修改两项摘要，原 168/49/65 statements、8 phase blocks 及所有原判据/预算保持。

前批已发布至 `1ed4061c3e10bbabd4e690126e7a3eaebd8217d6`，精确 main/origin 同步；其 [Windows37021105289](https://github.com/wangbinquan/agent-workflow/actions/runs/37021105289) completed/failure 0/1。该 SHA [主 CI37020545454](https://github.com/wangbinquan/agent-workflow/actions/runs/37020545454) 的本批冻结功能快照为 42 success、3 failure、4 非终态，并非全套终态结论。类型检查两个 OS 都指出 rfc370-wrapper-gate-handoff.test.ts:521 的 tasks fixture 缺 workflowId/inputs/startedAt；Ubuntu3 与 macOS5 的同一真实双库回归失败于 workflow_id NOT NULL。四份功能作业日志已单独保存；既有 runner 本次已通过对应原断言，没有改写前次一次失败的原因。其余任务和主 CI 的最终结论另行记录，旧失败/取消及 gate findings 全部保持。

单路径 CI 夹具补正有限独立 PASS，指纹 `445fe558e475c284dca90a0b44add96dee5f8eb376d5b34e5705c36549b30e67`；只插入真实 workflow row、workflowId/inputs/startedAt 三项必填字段及 workflow import；原 handoff/interrupted/progress/frame/resume 断言、预算和全部生产代码保持。三项有限逆变换恢复原测试全文，不用类型压制或放宽原 schema。正式修复仍以新 exact-SHA hosted CI 为准，不将有限源码门或部分作业通过记为主 CI 全绿。

官方 scoped census 只纳入已提交 1ed4061c 加归档九路径，四条原生成规则保持。实际 imports5711（原5707）、原 exceptions5073（原5069）仅来自四条真实 bootstrap type edge；owner25763（原25762）只新增一个已消费的 archive binding owner。entry1808、background342、public1045、required-port liveness38 及 implementation SCC 集合保持。原 boundary scanner 无新增 R1/R2，273 inbound/31 outbound、全部原 reason/退役条款和 bootstrap 列表保持；三项真实增长按原协议一次登记，匹配 canonical 提交后另行退役。

按 CI 夹具单路径、归档九路径、17路径 canonical/docs 和三项消费回执后继退役及时发布；旧正文和并行输出保持。仅运行目标 format/lint、纯源码/AST/字节证明及官方 scoped 生成，无本机 AW test/typecheck/build/service。后台 Worker 的 archive content 接线仍在 A2/A7，其他内容及 A1～A8/完整 AC00/A-G 持续；完整 A-G 后才实施独立 CS adapters，B/M0 先实际部署再逐项 M1～M4。尚无 AW-in-CS 部署，不关闭 RFC。

## 2026-10-02 技能完整存储真实根与 HTTP 回归夹具补正

技能完整选择八路径首门 `58773cdefc01365ca8afd7e2f64a33838e429952ce15556dc491e9568b1a6428` FAIL/P2 保留：直接展开合法原型 getter bundle 会丢失 capability 并启用 file 默认。owner 的 selectSkillContentDependencies 现显式读取全部11项能力及一次 rootReference，五个真实 classic/boot 调用展开该冻结投影；同一 binding 贯穿 StartOptions、provider session/recompose、SQLite/PG 和 standalone HTTP。undefined 保持原 file 默认，原叶层状态机完整字节不变。

修正八路径有限独立 PASS `80c9b1f5c8529376cbca39db7930a0faf418121114a5830b54bc301cdc979cad`；28项有界逆变换恢复五个旧文件全文，七个叶层 SHA 保持。原 own-field 双provider HTTP、publish ACK、操作锁/row/phase、boot snapshot ACK、读取失败判据及每例20秒预算保留，新增无own字段的12原型getter夹具。W29只变真实PG/SQLite两个摘要，168/49/65 statements、8 phase及全部原规则/预算不变。首版一次scoped投影随其FAIL保存为无效未发布记录，真实源码补正后只执行一次新R2投影。

前批 `1ed4061c3e10bbabd4e690126e7a3eaebd8217d6` 主 [CI37020545454](https://github.com/wangbinquan/agent-workflow/actions/runs/37020545454) 已 completed/cancelled：44成功、4失败、2取消，旧非终态快照保留。当前已发布 `2b91d76c4ab10f2efe1b11bff506ad17da4ced29` 精确同步；[Windows37025412186](https://github.com/wangbinquan/agent-workflow/actions/runs/37025412186) completed/failure 0/1；主 [CI37024745598](https://github.com/wangbinquan/agent-workflow/actions/runs/37024745598) 本批冻结快照为in_progress、43成功、3失败、1取消、2非终态，非全套终态结论；完成等待曾被GitHub504中断，已重新接入同一run。四份功能作业日志明确归档新回归的Response或Promise类型错误及等待诊断消费原body；生产归档接线及原wrapper断言保持。

两测试路径夹具补正有限独立 PASS `49910a7755dd1d46fec20a847bb5db9837b63e27f2f91eef5c9cb5ba3b69926b`：Promise.resolve保留同一次HTTP请求，诊断读取clone而保留原body给JSON断言；技能同类写法同步补正，getter fixture的receiver按eslint改延后const，原assertions/预算保持。五项有界逆变换恢复两份before全文；其他七个技能路径逐字保持。八路径原PASS与此次一项重叠fixture增量形成技能最终组合指纹 `952de1db48e1240cad8e06f76b17839f8ae56b7b4b26b05b63067b875072b808`，不冒称另一次全量门。

原四条生成规则及production语料规则保持；两fixture均不在sourceDigest的src语料或两个额外输入内，因此不重复R2 census。实际六条bootstrap value/type边使imports5711→5717、exceptions5073→5079，五个真实composition owner使25763→25768。entry1808、background342、public1045、required-port liveness38、target69及implementation SCC保持；原boundary scanner无新增R1/R2，273 inbound/31 outbound及原全部条款/reason/退役条件保持。三项真实增长一次登记，匹配canonical提交后另行退役。

按归档CI单路径、技能八路径、17路径canonical/docs及三回执后继退役及时发布；旧正文及并行输出完整保持。只做目标format/lint、纯源码/AST/字节证明及原官方scoped生成，无本机AW test/typecheck/build/service；正式行为交新exact-SHA hosted CI。其他内容与A1～A8/完整AC00/A-G继续；完整A-G后编写独立CS adapters，B/M0先实际部署，再逐项M1～M4。尚无AW-in-CS部署，不关闭RFC。

## 程序与证据读取真实根20路径组合门（2026-10-03）

首轮20路径 `3cbb94c59f652d15f9f6ea5cd5529b52187fdf54aebe6e1e82fce3e1b13f648a` 有限 FAIL/P2 两项保留：证据 prototype getter 的 expect(this).toBe(receiver) 有多态 this 类型冲突；程序读取预期漏掉实际 kind/program 和 builtin runtimeProfileRef，严格比较在 readEntered 前失败。生产代码不因此改写。两夹具增量 `84c3f38be879b911baa8cd66e0438aee710ddacdd9898712083fce3f6eaccf06` 由 /root/intent_functional_gate 有限 PASS：三处 expect<EvidenceReadBinding> 保持原 receiver 身份断言；独立 expectedRead 值保留六字段严格 toEqual。2项有界逆变换、4次替换恢复首轮两文件全文，其他18文件逐字保持。

20路径最终组合指纹 `ae7d8ffabdb9d18d9e58c03c90a9f9572ff99411ea45305ac772e187b511d97e`，由原20路径其余18项审查与两夹具增量组成 PASS，不声称另跑全量门。实际 start options/session/recompose、PG/SQLite daemon和standalone HTTP传入同一 employeePrograms/evidenceRead receiver。ProgramArtifactPort为既有 DE 合同；DA complete read binding只包含内容/文档/下载三面，不包含写入。五处文档读取等待同一 readText ACK，JSON parse/schema判断留原业务 owner；下载等待 open/openAll/open(range)，inclusive byte range及原 HTTP 输出保持，合法 prototype getter/方法不丢 this。原 partial evidenceContents override保持。

双 provider 真实 HTTP 回归覆盖 program put/read ACK、精确refs、missing409/failure500和DB row；证据 own/prototype binding、文档/打开/流三段held ACK、manifest与bytes/headers、固定/开放/后缀/钳制range、416无stream、missing/invalid/schema/rejection、missing membership无open及DB row。另有 materializer消费者与真实 file adapter回归，所有每例20秒预算保留；ACK诊断只读同一次响应的clone，不消费原JSON body。39项有界逆变换、41次实际替换恢复10份旧文件全文，8份叶层控制 SHA 保持。原 W29 只有 PG `547a7cc5…→5fb5aa8e…`、HTTP mounts `9aa32ce7…→a64272f5…` 两摘要变化，168/49/65数量、8phase、SQLite/event摘要及原规则保持。

官方 scoped census只执行一次：已提交76c564b加20路径，四原生成规则 SHA不变。实际入口1808→1810、imports5717→5723、exceptions5079→5085、owner25768→25780；仅两已用local工厂被原create前缀算法计入入口，六真实bootstrap type边，以及五文件/七符号owner。background342、public1045、required-port liveness38、target69、implementation SCC保持；无新增R1/R2，273 inbound/31 outbound、原每条reason/退役条件/bootstrap列表完整保持。四项真实growth一次登记，匹配canonical提交后退役。

前批54f技能交付、2b旧归档终态、54f主取消41/2/7与Windows failure0/1、76单路径 matcher有限PASS和Windows success1/1详见 [STATE](../../STATE.md) 新节。76主CI37034403145尚未取得终态；所有旧FAIL/取消和冻结快照保持，有限源码门与Windows不替代主CI结论。仅目标format/lint、纯源码/AST/JSON/字节证明及原scoped生成，无本机AW test/typecheck/build/service。DA写入/import/materialize、其他A1～A8/完整A-G、独立CS adapters与B/M0～M4持续，尚无AW-in-CS部署。

## A1 宿主/CI 与 A2 文档写入组合候选的有限功能门（2026-10-03）

28 路径 source fingerprint `193a0c97303944b793cf098ff2faa89946dd8592cca6f5ca50a54033d94d5fc0`，由两个有限门组合为 PASS：

- 宿主/CI 首 21 路径 `21118e772d16645dd3cd23119869570a87f7e7fa979158163347855c129bcb1a` 首门 FAIL/P2：fast control.close ACK 可使 shutdown 在已受理 publishReady 完成前 terminate。保留原 finding；仅 start 与真实监听回归两路径 R2 `d9dfef3cc9ae3a0930a878519545870379c530d943de6f8d7884c0d6c54a5ee1` PASS。其他 19 路径 SHA 逐一不变，组合 21 路径 `e8f9d78d39b1456922dd73585ac105a5a9c3c433529b5f8690b599cf39b4b05f` PASS，没有重跑完整 21 路径门。
- A2 七路径文档写入 `ad092e01f31dfabf524f8fef605604bc7c8941fd33ca4b2f300111b7c899cf38` 独立有限 PASS。原 EvidenceStore 物理正文、形状、五处 canonical JSON/budget 和业务引用语义保持；等待 writer ACK、prototype receiver/this、同步/异步/failure/默认字节/预算及 staging finally cleanup 回归已写，未本机运行。实际启动注入与其余内容能力不在此 PASS 范围。

原 49 个定位段逆变换恢复 13 个 HEAD 旧整文件；R2 14 个定位段恢复两路径首候选整文件，再组合前述证明恢复原 HEAD；文档写入七个定位段恢复两个旧整文件。原控制路径、W3 shutdown/listener 判据、严格 range 字节和 RFC-310 deep import 原规则保持。W29 原 pure projection 一次生成后保留 PG 168/8 phase、SQLite 49、HTTP mount 65 等既有数量，仅反映两处真实 receiver wiring 字符串；不重跑、不改测试预算。

精确 `227cfacc488b2150c62e0dc0bc28e032dfcd24f8` 主 [CI37038117741](https://github.com/wangbinquan/agent-workflow/actions/runs/37038117741) completed/failure（44 success、6 failure），[Windows37038361399](https://github.com/wangbinquan/agent-workflow/actions/runs/37038361399) completed/failure 0/1。六份功能日志确定 QuestionSetV1 类型、range 返回全 21 字节和三个 forbidden deep type imports；本批修复真实实现/夹具/根类型导出，未放宽 manifest、原字节匹配或边界规则。76c564b 的主 CI37034403145 已 cancelled（41 success、8 cancelled、1 aggregate failure）；其 Windows37034643759 success，不等于该 SHA 整套绿色。旧非终态与失败正文不改写。

原 scoped census/原 boundary 各一次、原规则哈希不变、commons-debt 304 条及 273/31 完整保持，boundary added 空，target 69 和 implementation SCC 空不变。实际六项 ledger 增量为 1810→1813、5723→5735、38→39、5085→5096、1045→1047、25780→25802；matching canonical commit 消费后按原 helper 退役六回执。新增 DaemonHostLifecyclePort 有真实 native provider/启动消费者，但原 SO application/root composition 规则仅得到 `declared-debt`（W4-E7），不能写 active binding；该真实 A1/A8 余项继续。

独立 METADATA 门只审新 17 路径候选及六回执退役脚本；不再重审已 PASS SOURCE。未执行 AW 本机 test/typecheck/build/service，正式行为与全仓结论待本批 exact-SHA hosted CI。所有旧 gate/CI 历史、并行输出保持；完整 AC00/A1～A8/A-G 未完成，CS adapters 与 AW-in-CS 实际部署未开始。

## RFC-370 类型出口增量与原 active SPI 恢复（2026-10-03）

首版 SOURCE28 `193a0c97303944b793cf098ff2faa89946dd8592cca6f5ca50a54033d94d5fc0` 与 METADATA17 `d1b498319866d70f916ac8bf32fd071eba0a447e2d741046ce59818dc8589377` 有限 PASS 保留，但未发布。原清单将 DE ProgramArtifactPort 的 from-type 再导出算作同路径第二次 composition binding，造成 active→declared-debt。仅 DE composition 一路径把出口改为 `export type { ProgramArtifactPort }`，复用原有 type import，整文件逆变换一致；单路径增量有限 PASS `38ca0e5cd13d8c8bc8af390afa963c82fe58600af080993f94966d7581c95443`。其余 27 路径逐字未变，复用原 PASS 组成 SOURCE28 `8ded9a42418055aa1674d4fb31360855f4a6ae66cdbe2781b20eddda68924dc1`，不重开 SOURCE 全量门。

实际源码变化后只执行一次新 R2 scoped census/boundary，保留首版生成记录；观察边和 exceptions 逐项与首版相同，六实际增量仍为 1810→1813、5723→5735、38→39、5085→5096、1045→1047、25780→25802。ProgramArtifactPort 恢复 active 且只有一个 composition binding；required 汇总现为 18 active/21 declared-debt（原 HEAD 18/20），宿主新增 SPI 仍 declared-debt/W4-E7。新 sourceDigest `sha256:8c56bbb82686cd2fbc2be56d46cf794bc5f8a5ec664a2645ccaae5b1d7d9d884`；四原规则、304 条 debt、273/31、target 69、implementation SCC 空保持，boundary added 空。六回执只更新本会话精确未发布记录，在匹配 canonical commit 后一次退役；没有替他人移除回执。

首版新节与全部旧正文/并行内容/门和 CI 历史完整保留。R2 METADATA 只检视实际变更的投影和新增记录；只做目标 format/lint、纯源码/AST/JSON/字节证明与原 scoped 生成，无 AW 本机 tests/typecheck/build/service。正式行为仍待新 exact-SHA hosted CI。完整 A1/A2/A3～A8/AC00/A-G 与后续独立 CS adapters、B/M0～M4 持续；尚无 AW-in-CS 实际部署，不关闭 RFC。

## 2026-10-03 宿主 application、document writer 全根与 CI 守卫迁移

12 路径有限 SOURCE PASS `f493a18e5ff395a70d576e97fe15da31624de2e096e4609e2084398d8250dc7b`。SO application 真正拥有原 ready/control/shutdown 协调，root 仅传入选定 host、listener/application stop 和 authority release。原正常关闭顺序、shutdown 后禁止 ready、startup failure/退出回调和同一 receiver 保持；已准入 readiness 先排空，再等最终 withdrawal ACK、orderly releaseAuthority ACK 后 terminate。同步 unexpected-exit release 单独保留。新增 held readiness/final withdrawal/release ACK 回归使用 prototype host；原真实 Bun listener 回归与 native adapter 完整字节不变。30 个定位片段逆变换恢复九份旧文件，七份控制 SHA 不变；有限门未运行回归。

EvidenceDocumentCommands 由 DA composition type 出口进入 StartOptions、provider session 首装及重装配、SQLite/PG daemon、standalone HTTP 和 provider helper，同一选定 writer 到达 requirementMaterializer。没有额外展开丢失 prototype receiver。双 provider 真 HTTP answers 回归分别覆盖 own/prototype writer：保存 ACK 未到时 response/refs/mission 保持；ACK 后使用逻辑 object 引用和原答案字节，replay409且仅写一次，staging 未产生。叶层 EvidenceStore、materializer 和 local writer 全文不变。W29 原 PG 168、SQLite49、HTTP65 statements/8 phases/全部原预算不变，唯一 PG digest `33a8816962bba878d2c1ed552273b5bac43b9f330f0f65fafcd2c3b5b6d24b11` 按实际 writer 接线变为 `7ad9d218a924daf8a641a70c88b17866fe86a36e7257261a68d244bf1cd07c95`；其余 digest 保持。

已发布 e0c42a53 的 [主 CI37050645456](https://github.com/wangbinquan/agent-workflow/actions/runs/37050645456) completed/failure（44 success/6 failure）。五个失败后端功能作业日志单独留档，功能失败均为旧结构守卫：W5无人接管 Promise 实际下降6→3、startup 新真实监听器测试调用1、RFC254仍断言旧 start 中的本机 control/removal。required 汇总失败另记，不将这些失败或有限 PASS 写成 main 通过。[Windows37050766328](https://github.com/wangbinquan/agent-workflow/actions/runs/37050766328) completed/success 1/1，独立于 main。

三测试有限增量 PASS `430fd59c328c035fa1268b82e7526eda61090259062728795fd885370e73bb53`。W5 仅高水位6→3，原类型扫描/负例/断言不变；原三 shutdown callback 现由 native adapter `.catch(callbacks.onFailure)` 接管。startup 不增加扫描豁免，仅登记真实 fixture 的唯一 `serveDaemon` 调用，原 production 单一调用保持。RFC254 T7 两功能断言钉住 native 控制监听器启动/close、application await close、signals/control 同一 request、withdraw 和唯一 shutdown/bootstrap stop。测试其他完整段落不变；五个定位片段恢复三个 before 全文字节。原12路径 SHA 保持，15路径组合 `d00525b2a6b937195b3acbf572a0643996dcc9d440cb9908442b359fa5ef9fcf` 复用原门和此增量，不重开全量门。正式行为交后续 exact-SHA hosted CI。

原 scoped census/boundary 各一次，四原规则不变；三个补正测试位于生产 src 语料及 `.dependency-cruiser.cjs`/`scripts/depcheck.ts` 两额外输入之外，不重复 census。actual entry+1为真实 runDaemonHostApplication，由 composeDaemonHostApplication 根调用；import+4为其 start value 和三 roots 的 writer type edge；exceptions+4为同四边，owner+4为 application file/options/run 和 root factory。39 required ports 中宿主由原应用消费者/唯一 composition/native provider 判据成为 active，汇总19 active/20 declared-debt。304原 debt 条款、273 inbound/31 outbound、target69、implementation SCC空、background342、ambient500、public1047、所有旧理由/退役条件保持；boundary added空。四增长按原协议一次登记，匹配 canonical commit 后一次退役，不扩大规则。sourceDigest `sha256:23a114c3710b4a2d04f4a6de85bc18de8b9a7ae8b39c5f0f39db8efa8549c98f`。

所有旧正文、首 FAIL findings、旧 CI 终态及并行 span 输出完整保持。只做目标 format/lint、纯源码/AST/JSON/字节证明及原 scoped 生成，无 AW 本机 test/typecheck/build/service。本门仅此批；A1 raw PID lock/authority 和 A2 intake/import/materialize/其他物理效果、A3～A8/AC00/完整 A-G 继续。独立 CS adapters、B/M0～M4 和 AW-in-CS 实际部署均未开始，不关闭 RFC。

## 2026-10-03 本批 METADATA 归因增量补正

首门 METADATA17 指纹 `d98265ceefccd4dfc7e8d952e9918fddc0ef0a947263a78176008d480589bbdc` 有限 FAIL/P2 保留：新 entry +1 的回执和本批新节误写为 composeDaemonHostApplication；原清单相对 before 的唯一新增 mutation entry 实为 runDaemonHostApplication，后者由该已消费的 composition root 调用。仅修正这两处本会话新归因文字，原数量、全部扫描规则、SOURCE15 和其他15个 metadata 路径逐字不变；不重复 census、growth registrar 或 SOURCE 全量门。增长首登记证明保留，四项仍按相同数量在匹配 canonical 后一次退役。其余首门已核对项复用，只检视两路径有限增量，正式行为仍待新 exact-SHA hosted CI；完整 RFC 和部署继续。

## 2026-10-03 启动租约及 CI 守卫的有限交付

SOURCE14 首候选 `28535e5a3b30b442d15105f6e2ac3fc4ad120b43b283946953b81ebc74153740` 有限 FAIL/两个 P2 保留：新root oracle用了错误的准备工厂名，acquire ACK后的diagnostics getter/host选择不在release lifetime内。只修三个路径，有限R2 PASS `2caa8655a9ebe56a8f89dc4d7174e278df9974f5c690a29fd8a561ad1b6bc8a6`；四定位段恢复三份首候选全文，其他11路径和7控制逐字保持，形成组合SOURCE14 PASS `8ccd6aa4ca93efd3090e8ff0b7df6704704c00a62c87966b203effc35eee15db`，未重开全量门。新增prototype getter同步失败回归等待held release ACK后返回同一原Error；原断言/预算保持。

同一neutral lease经start/session/recompose及PG/SQLite recovery proof真实绑定。native adapter的获取/错误/开发接管算法在明确的options替换后恢复原完整body，PID只留默认native诊断和原本机proof兼容。selected acquisition/receipt失败无本机回退；boot失败/release失败分别可观察。W29只更新PG body摘要为 `f16eeb4203b530e19ddfb255365443423980bbfff913c874533ff8cc7485410a`，168/49/65 statements、8 phase、SQLite/HTTP/event digest和原规则保持；R2三路径未触及projection输入，复用该唯一回执。启动claim不替代完整A7执行权、远程运行检查或重启恢复。

已发布fd02的主CI37056660544终态46 success/4 failure，同SHA Windows37056797584 success1/1。实际三个失败backend jobs111002929614、111002929704、111002930044定位：startup调用表5行/基线4；初始bootstrap源码窗口700字节截断；macOS全文件同步读扫描8029ms超原5000ms预算。两个测试路径有限PASS `a45693cdc22fa7158224d629ccf5763996f3177769d7a67163708260f14e0cc8`，七定位段恢复完整before：完整且唯一await bootstrap AST跨度2039字符仍用原regex；全文件/SELF/regex/逐行诊断/默认5s保持，64项Promise.all读取后按原顺序收齐，读失败仍使测试失败，新增行号和HTTP/fileURLToPath兼容fixture。真实startup fixture行完整保留，仅按实际基线4→5登记增长。两组复用形成SOURCE16组合PASS `28e7219be0ef2ffca9d622f59b23c88fb21fcd6dd81018577807990261694acc`，正式运行等新exact-SHA hosted CI，原FAIL/失败历史保留。

官方scoped census只含HEAD fd02加本批16路径，四原规则按committed HEAD读取；peer Canonical三条span owner WIP在内存排除，文件未改。原census/boundary各只执行一次，sourceDigest `sha256:98461efc25aafde03970cd25c3067dc9a41bb27a946a67b253ea7ffc83560356`。实际七增长：entry1814→1817（runDaemonStartupWithLease/native factory/TE converter）；background342→344（原分类器记录receipt reader/converter）；imports5739→5756（18新增/1替换）；required39→40（new startup SPI active，原39条逐字保持，20 active/20 declared-debt）；exceptions5100→5115（16新增/1替换）；owner25806→25819（14新增/1旧CLI owner退役）；startup调用基线4→5。每项why对应实际entry/edge，七receipt匹配canonical提交后一次退役。304条debt全文、273/31、target69、public1047、ambient500、implementation SCC空及unresolved first-party空保持；boundary added空。

只做目标format/lint、纯源码/AST/JSON/字节证明和原生成，无本机AW test/typecheck/build/service。四份文档仅新增独立格式节，删除新增节即恢复旧全文；全部并行输出、首门findings及CI历史保持。此门仅覆盖本批，完整A1～A8/AC00/A-G继续，随后CS独立adapters、B/M0实际部署和M1～M4，尚无AW-in-CS部署，不关闭RFC。

## 2026-10-03 异步运行上下文与员工输入根的组合有限门

SOURCE15 `51c1c3e596fc26b57bb5cc2a22b31d20d090e6beb720a02a0bf60d00fb896680` 由 `/root/intent_functional_gate` 独立有限 PASS。AttemptContextStorePort 移到专属 application port，原 save 合同保持，load 允许同步或异步；native factory 整体提取至独立 local adapter，原默认同步返回类型与 bytes/error 语义保持，旧入口保留兼容 type/value 出口。pipeline manifest、mission candidate、pipeline repair、agent collection 四个真实读取消费者均 await，两个实际 manifest/repair 上层消费者也 await。composition 懒选 `deps.attemptContext ?? createAttemptContextStore(evidence)`，完整 prototype receiver 保持；start/session/recompose、PG、SQLite 与 standalone HTTP 转发同一所选对象。其他 EvidenceStore 能力仍在原链中，不能宣称已移除全部物理依赖。

35 个定位段恢复11个旧文件全文，四个新路径在原文件之外；七个原控制不变。新增回归覆盖 prototype/this、held load ACK、JSON/null/error、默认同步 byte roundtrip 和双 provider 实际 action 的 save→launch、load→fetch 及失败顺序。W29 只据真实 PG 变化登记摘要，原168/49/65 statements、八 phases 和全部旧判据/预算保持。没有本机运行这些回归。

员工输入根 SOURCE7 `1443b38ace07944d607ad141247acd3217e79b69f86d8db5cf1908bf1ce500ab` 由同一独立评审者有限 PASS。复用既有完整 EmployeeInputArtifactPort，原 required-ports、local 实现、上传协调器、runtime presence 和 DA workspace materializer 全文作为八控制保持。三个真实根懒选一次完整对象；六个 DE intake/DA workspace 绑定均消费相同 receiver，StartOptions/session、两 provider 和 standalone HTTP 传递一致，provider HTTP helper 的精确 Pick 扩展一个字段。新 HTTP 用例覆盖双 provider、prototype putFile、原临时文件内容、held capture ACK 前不新增 upload 行、保存成功的逻辑引用/sha/bytes/pending、失败500且账本不增、无 native root 创建；finally 释放并等待 pending。仅按新增ID取行，不依赖SQL默认排序。AST 同时核对真实显式和 shorthand 绑定。

17 个定位段恢复六个 before 旧全文。共享四个 root/W29 文件在内存逆变换员工增量后逐字还原 SOURCE15，其他11个 SOURCE15 文件不变；合并18个不同路径，15个控制，组合有限 PASS `e0d025860e64c0606f6f2860a6a31df0880af9900ef0cd76fd0e9dcf1daff68e`。从 d2c29c15 承接已发布观测 aa6e75a4 后，候选/控制/任务 baseline 均逐字保持，复用两门，无重复全量检视。最终 W29 PG 摘要 `88af21051d13025a6509089c57140e9a4516d96b477f3cc36883153285a39e2c`；SQLite `693f1a5d7237bf015a4979bd136aa1567f5be76fa981a3f7efc8c9b5b018b83e`、HTTP mounts `721134ff7a05878e8595f124a015aef992bcf059f309b94b8ac437c36d16d379`、event `08f37a0d92c9ec7f81a354e138d1bd5e18ffed631e3a676ed1120eb5eecb0c0c`，原结构/规则/预算保持。

上一批 d2c29c15 的 [主 CI37062367239](https://github.com/wangbinquan/agent-workflow/actions/runs/37062367239) completed/success，50/50；同 SHA [Windows37062367334](https://github.com/wangbinquan/agent-workflow/actions/runs/37062367334) completed/success，1/1。前次 fd02 失败与原修复记录全部保留。这是上一批终态证据，本批行为交新 exact-SHA hosted CI。

官方 scoped 输入为已提交 aa6e75a4 加18个已通过源码/测试路径，原四规则逐字保持，已发布观测和三条 runtime owner 属于已提交基线。census 与 boundary 各只执行一次，boundary added 空；sourceDigest `sha256:1f74f2fed6ed4b527f53de0264804b780142f0afd4d0d0b3f14e2a1b93cf77f8`。实际 imports5778→5784 为两合同各三个 bootstrap type edge；exceptions5136→5142 为相同六边；owner25901→25903 为新专属 port file/type、local file/factory 四 owner 减旧 port declaration/factory 两 owner。mutation entry 只随 native factory 换位置，1823不增长。原345后台、501 ambient、1053公共面、40个 required SPI 全文及20 active/20 declared-debt、304条 debt 全文、273/31、target69、implementation SCC空和 unresolved first-party空保持。DA 专属 application port 不在原 required SPI 分类集合内，不冒称新增 active 登记；员工输入复用原合同，不更改分类器。三个实际 growth receipt 一次登记，匹配 canonical commit 后一次退役，理由对应真实 entry/edge。

四份文档只加独立格式节，删除新节即恢复旧全文；全部旧门、CI、失败历史及并行输出保持。只做目标 format/lint、纯源码/AST/JSON/字节证明和原 scoped 生成，无本机 AW test/typecheck/build/service。本门只覆盖这18路径，不关闭完整 A2/A8、A1～A8/AC00/独立完整 A-G。随后独立 CS adapters、B/M0实际部署和 M1～M4 持续；尚无 AW-in-CS 部署，不关闭 RFC。

## 2026-10-03 Mission 捕获/插件安装真根的有限 source 和 metadata

首轮 SOURCE9 `7cf8c591e860555725d9ccc3a69edff55405e20b86cb9530a41106d05c5eb1d9` FAIL，两项 P2 为 PG call 对象重复字段（TS1117）、SQLite HTTP 漏透传。三路径 R2 独立 PASS `94d3cc13828a20e860ead3880e6073708caecb9ceee226d7ca5c9d2279ccfc62`，其他六路径和八控制逐字不变，组成九路径 PASS `7c310363c13f5d98ba4110bc7f87df0c62c3d05b04d3ddcbe791620ffea34759`；不重开全量门。R1 26 段恢复七份原全文，R2 四段恢复三份 R1 全文；新 AST 逐个定位真实 PG/SQLite HTTP call，字段唯一且 receiver/值正确，替换原失效的字符串计数。

复用现有完整 MissionInputBlobPersistence 和 PluginInstallerPort，在 start/session/recompose、PG、SQLite HTTP、standalone HTTP 根选择同一个 prototype receiver，undefined 保持原 lazy native factory。原上传 application/persistence/route 和插件 application/local installer/schema 全文保持。两新增双 provider HTTP 回归覆盖 capture/install 持有 ACK 时无新增行、成功精确 SHA/字节或 cachedPath/version、失败无行/无 native 回退、临时上传收尾，以及同一 installer 的 checkForUpdate 参数/响应；每例20秒预算保持。

七旧路径：RC composition/pluginOperations、DA composition/missionInputUploads、cli/start、cli/postgresqlDaemonApplication、server、tests/helpers/providerHttpApplication、rfc359-w29-unstarted-application-composition；新增 rfc370-mission-input-capture-roots、rfc370-plugin-installer-roots 两回归。bare type export 复用原 type import/port 和原 composition 分类，不引入同职责 port。

W29 只更新三个真实投影：PG `36e4a61ba4567df6a25dee461b55b9ea28bd23e318adda618922732279e658ea`、SQLite `5b5a40d3535a03cd89bdb12a59774af909be9b6f6040d74cf0f68c03c225ca9f`、mount `985ed49e7da779b358ff58f3a9d74c8a77595e0eb2ad538405904e1940312cc5`；R2未变其PG/server输入，复用一次projection。原168/49/65 statements、8phase、event digest及全部原断言/预算保持。

原官方 scoped census/boundary 各一次；imports5784→5790、exceptions5142→5148，只新增三根的两 existing type 共六条边。40 原 required SPI 全文（20 active/20 declared-debt）、entry1823、owner25903、public1053、background345、ambient501、全部 metrics、304 原 debt 条款、273/31、target69 和 implementation SCC 空保持。14 ambient 行地址只随真实 source 行号移动，语义 multiset 保持。sourceDigest `sha256:4626f1c7d9de8c924798d48e360e0b690020a61b6ee3cf4b035b2622f92571ea`；两真实增长在匹配 canonical commit 后一次退役。四新文档段落逆变换恢复原全文。无 AW 本机 tests/typecheck/build/service，只做目标 format/lint、纯源码/AST/JSON/字节证明与原 scoped 生成。

上一批 b7c37804 主 [CI37070701985](https://github.com/wangbinquan/agent-workflow/actions/runs/37070701985) completed/cancelled（22 success、18 failure、10 cancelled），[Windows37070910393](https://github.com/wangbinquan/agent-workflow/actions/runs/37070910393) completed/failure 0/1。功能日志确认并行观测夹具 TS2345、runtime/runner 原断言、观测路由合同/MCP、测试引擎账本和前台样式/重试入口回归；Markdown 五项历史 run 链接为 GitHub502。owner 的两路径类型修正已发布1538a380，九候选/八控制/四规则不受影响，复用 source 门并基于此精确同步 SHA 生成；其余观测回归已协调 owner 接续。旧失败/取消保持，不将成功片段记为全套绿，正式行为等待新 exact-SHA hosted CI。

完整 A2 继续 evidence intake/import/materialization/验证输出、resource-package/runtime 插件与 GC、TE/DE 内容/recovery和worker archive；A3/A4 两 LaunchLane/全部workspace/Git，A5完整执行链，A6全部purpose，A7authority/worker/remote orphan恢复，A8全roots/AC00和独立完整A-G持续。随后独立CS adapters、B/M0先实际部署，再逐项M1～M4。尚无 AW-in-CS 部署，不关闭RFC；旧正文、全部门/CI历史及并行输出保持。

## 2026-10-03 证据完整能力 SOURCE24 与有限登记

SOURCE24 首轮 `d11853a87eb2650d6cff3daeedfade4dd888d5bb538b28845b00bebfe9f6067e` FAIL：同一物理 seed 在新增 await 窗口重放会重复物化/rename，以及新增 mode 判据遗漏原 Windows 分支。两路径 R2 `9bea70b062bc5003855d54f9b9550ad08662dbb29bb3cfc2be9ac47f3edcc7c6` 独立 PASS：复用原 KeyedSerialQueue，以 seedsRoot+planDigest 的实际物理地址串行发布并在持锁后重查；失败释放、后继重建，原 win32 判据恢复。其余 22 路径和 8 控制不变，组成 SOURCE24 PASS `e3b2d0095d7bcab431c2e3587023bade8efe76904129847ae928f065343b4bba`；保留首轮 FAIL，未重跑已完成全量 source 门。155 段逆变换恢复 19 份原全文及 native 迁移原文；10 个实际 root call 的新字段唯一、选中 receiver 正确，原 9 个核心 native 方法 token 逐字保持。

复用既有 MissionInputBlobPersistence、evidence content/document/download/context 完整合同，新增 EvidenceArtifactPort 只补逻辑 blob/bundle 物化和存在性 effects。原 EvidenceStore/native class 与 helper 全文迁至 infrastructure/local，旧入口保持兼容导出；选中的 complete prototype receiver 沿 start/session/recompose、PG、SQLite HTTP 和 standalone HTTP 根传入 DA、DE pipeline 与 Mission。原调用方的 staging、receipt、digest 和验证业务规则保留；等待所选物化、adopt 和 JSON 写入 ACK 后再发布 durable 引用，失败保持原错误语义并清理暂存。

新增功能回归覆盖 native 二进制/context/download 合同、hold-ACK adopt、materialize saved/throw/missing 与暂存收尾、三类同地址 seed 重放，以及双 provider 真 HTTP capture/JSON-answer 的 hold ACK、成功精确 bytes/digest/业务行、失败无 durable 新引用或 native 回退。原 rfc310 journey 改用 adapter-owned native 路径闭包，原 missing/status/range 判据保持；mode 新判据保留原 Windows 分支。这些运行回归只交 hosted CI，源级证明不冒充实测。

W29 只更新实际组装投影：PG `a61af5377abfbfd19dd6e13b1986abd2b3b1c0d307edfa399fc510355a0fb3a3`、SQLite `5b5a40d3535a03cd89bdb12a59774af909be9b6f6040d74cf0f68c03c225ca9f`、mount `cf7937d74c15bc6c833082b79e3259bd5f2c06f264e7c92f530322ef907408f9`。一次实际 projection 的原168/49/65 statements、8 phase、event digest `08f37a0d92c9ec7f81a354e138d1bd5e18ffed631e3a676ed1120eb5eecb0c0c` 及其余判据/预算保持；R2未变根与投影输入，复用原结果。

本批原 scoped census 与边界报告各一次；imports5790→5794、exceptions5148→5152（3 条 EvidenceArtifactPort bootstrap type 边与 1 条既有 KeyedSerialQueue value 边），owner25903→25907（3 旧 native owner 迁移，7 新位置 owner，净增 4）。entry1823、public1053、background345、ambient501、全部 40 required SPI 全文（20 active/20 declared-debt）、304 原 debt 条款、273/31、target69、implementation SCC 空和 unresolved 空保持。13 ambient 地址只随真实行号移动，语义 multiset 保持；moduleFiles1469→1471、backendProductionFiles2026→2028，仅本批两个 DA source 文件。sourceDigest `sha256:954ca22d88be78bbb544504040a5d39d052e84e7558288fdc19b74e468f04bcf`。只登记 3 个真实 inventory 增长，匹配 canonical commit 后退役；后续自有 RC/SC/Worker WIP 与并行 EOF 统计均从本候选原统计中排除，保留现场文件。四独立新文档段落经逆变换恢复原全文，四条原规则未变。

此前 f3eedc6aa9cd380dbcc6b32b83be1f58da591752 的主 [CI37074418502](https://github.com/wangbinquan/agent-workflow/actions/runs/37074418502) completed/failure，50 项为 33 success/17 failure；[Windows37074493098](https://github.com/wangbinquan/agent-workflow/actions/runs/37074493098) completed/success，1/1。已保留原失败功能日志和归属，不能据部分 green 关闭。并行观测 owner 的源码1873e606、canonical cf83e1c5、正常退役655d1e8b已发布并交接共享窗口；同步0/0后复用完全未变的24+8 source 门，以655d1e8b原分类生成本批登记。owner追踪其 exact-SHA CI，本批运行行为等发布后的新 exact-SHA hosted CI；没有运行 AW 本机 tests/typecheck/build/service，已做定点 format/lint、纯源码/AST/JSON/字节证明与原 scoped 生成。

完整 A2 仍需 resource-package/runtime 插件与 GC、TE/DE 内容/recovery、全部 worker archive 和其它读取/物化链；A3/A4 两 LaunchLane/全部 workspace/Git，A5 完整执行链，A6 全部 purpose，A7 authority/worker/remote orphan 恢复，A8 全 roots/AC00 和独立完整 A-G 持续。只有完整 A-G 通过后编写独立 CS adapters；B/M0 先实际部署，再逐项 M1～M4。当前尚无 CS production adapter 或 AW-in-CS 实际部署，不关闭 RFC；原正文、门/CI 历史和全部并行输出保留。

## SOURCE28：workspace / package / Worker 的有限功能门（2026-10-03）

Worker 有限 DESIGN v2 PASS；SOURCE26 首轮 FAIL 的 `SOURCE26-P2-1`（重复 drain 可能早于 PostgreSQL pool close）由 R2 SOURCE4 PASS 修复。原始 boundary collector 随后发现三条新 helper 到 module-internal composition 的类型引用；保留第一次生成和失败，未改 `BOOTSTRAP_FILES`、规则或债务条款。R3 经有限 DESIGN/SOURCE3 审查，将同一完整类型经现有 exact `public/types` 入口重导出；三个改动文件生成的 runtime JavaScript 与前版完全相同。组合 SOURCE28 指纹 `bdee22293f4fa32d75e1bb7728ada62cf18be3d64ca1498b6790a84df7996452`。

本批完成两个 provider 的 workspace tree/file 内容选择、资源包 skill/plugin/export 完整 owner 接线，以及 maintenance Worker 内重建的三类完整效果（archive、包恢复、plugin GC）。所选对象的原 receiver、逻辑引用、ACK 与失败语义贯穿实际装配入口；CLI 初始和替换 session 传递同一完整选择。重复 drain 共用包含 heartbeat、效果 dispose 和 provider close 的完整关闭 Promise，不能提前发出 drained。

已编写 hosted 回归：两个 provider 的真实 workspace HTTP 读取与 metadata/full bytes、真实资源包 prepare/commit/export 的选择与 ACK；真实 Worker 的 factory/collect/dispose、fault drain 后 pause 的重复真实消息，以及编译后二进制 Worker 的效果重建。实际 call object、receiver、条件分支和初始/替换 session 有逐调用 AST 证据；原 native workspace 内容 helper 整段不变。没有运行本机 AW tests/typecheck/build/services。

原始 scoped census 为实际 SOURCE28 候选执行一次，排除并保留 RFC-371 的 4 个 tracked 和 15 个 untracked 源码 WIP。实际投影：mutation 1823→1826、background 345→352、observed imports 5794→5809、exceptions 5152→5167、public surfaces 1053→1056、symbol owners 25907→25932。6 个 native content helper owner 完整迁移，4 个既有 timer 仅变更行号，15 个 ambient 条目仅变更行号（501 总数和语义不变）；supervisor 的 phase 字段由原 collector 对 `effectsBootstrap` 文本重新投影，原生命周期不变。原 40 required SPI、69 target edges、304 债务条款和 273 inbound / 31 outbound 保持，新增 boundary 违规为 0。新增生产文件 4 个，source-control 文件净增 2 个；值循环及未解析 first-party 依赖未增加。仅登记这 6 项实际数量增长的一次性回执，并在 canonical commit 后按原语义退役。Source digest `sha256:d7cd21a663d5fde3d45b5bf92bbc204ab35a92f4e365a18ff552d9b4c72f542f`。

CI 修复提交 `3ff61d9eba0b129953d09d966235d7a2b3ca633c` 的主 CI `37087805975` 为 50/50 success，Windows `37087878452` 的第二次 attempt 为 1/1 success。保留第一次 attempt 的三个既有 code-intel 5000 ms timeout；未放宽断言或时间预算。该 CI 仅证明修复提交，本批 SOURCE28 的正式 whole-repository 结论待发布后的 exact-SHA CI。

完整 A1–A8/A-G 仍开放。本批不等于其他 Worker 效果、execution authority、workspace/Git、物化快照、执行流和全部装配入口的闭合。后续先实施已通过有限 DESIGN v2 的 EmployeeCase 完整效果范围，再继续剩余中性切面；CS adapter、B/M0 实际部署和 M1–M4 验收尚未实施。
