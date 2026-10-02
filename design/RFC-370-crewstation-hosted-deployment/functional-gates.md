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
