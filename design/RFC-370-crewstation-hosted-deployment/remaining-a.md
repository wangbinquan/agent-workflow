# RFC-370 阶段 A 剩余实施组

2026-10-02 按真实调用链作有限依赖核对。此清单用于推进已批准的 A-T2～A-T7，不改变完整 A-G、随后 B/M0～M4 的顺序，也不表示完整阶段 A 已复核通过。

| 组                  | owner 与可复用合同                                                                                                                       | 必须完成的消费者与效果                                                                                                                                                                                         | 行为 oracle                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1 启动与配置       | system-operations；DatabaseConfigurationPort、DatabaseInstallationPort、配置 query/persistence，TE 三组配置 query                        | boot/manual upgrade 的外层选择、restore-before-open、generation/安装事实、启动锁、seed 完成标记、宿主生命周期及剩余热读                                                                                        | restore 在打开数据库前；generation/provider 一致；按原时点读取，删值/失败不借旧快照；seed 失败无完成标记；关闭顺序不变                                                   |
| A2 内容             | resource-catalog、task-execution/Intent、digital-employee/development-automation 各拥有自己的合同                                        | RC 全内容能力贯穿经典目录及 boot/availability、插件内容/runtime/GC；TE 工件/prompt/scratch/归档及恢复的底层存储效果；DE 程序内容与 DA evidence range read 异步接线                                             | 原逻辑版本、digest、DB claim/事务/预览/补偿/恢复保留；字节预算、截断、续读不变；已开放编辑必须形成耐久闭环                                                               |
| A3 工作区           | source-control；preparation/journal、WorkspacePresenceQueries、maintenance effects 复用                                                  | 两条 launch lane、scratch prepare/restore、upload placement、读取/删除/恢复、终态 lifecycle revival                                                                                                            | 多仓顺序；placement 先登记再写入；重试不另起文件名；异步旧快照不能误写 tombstone；claim/生命周期原子匹配及补偿不变                                                       |
| A4 Git              | source-control 的 public participants 与 owner 效果合同                                                                                  | node/wrapper 隔离/备份/merge/recovery、commit/candidate/delivery/conflict/员工工作区、Task HTTP diff/repair、DE/DA workspace validation                                                                        | 原锁/CAS、共享/隔离、多仓 diff 顺序/标题/预算、空提交、失败 merge 保留现场、检查/修复结果不变                                                                            |
| A5 Agent 材料与执行 | runtime-management 保留 profile/协议/session 策略；task-execution 拥有 execution/ref/event/cancel；local adapter 唯一复用 managedProcess | runner、systemAgentRun、runtimeSmoke 同批迁移；普通 node、动态宿主、merge、fan-out、Intent、distill、change narrative、MCP 测试台和 diagnostics 全部消费者                                                     | 开始收据持久化早于 stdin/输出激活；保留本地 PID/binary/nonce 投影；reap 后清理，unreaped 留现场；双 runtime、fresh/resume、EOF、回调失败、timeout/abort/cleanup 分类不变 |
| A6 脚本与专用命令   | 各目的 owner 的既有 program/verification/action/baseline 等合同，复用 A5 执行机制                                                        | TE script/material/依赖环境；Event Center custom observer；DA verification；integration requirement/pipeline/approval adapter runner；runtime probe/model discovery；plugin installer；structural deep/indexer | 脚本原始输出/缓存/收据顺序；observer envelope/cursor/dedupe；verification 串行 first-failure；indexer 退化结果与输出清理不变                                             |
| A7 执行权与恢复     | system-operations 宿主执行权生命周期；复用 Task ownership/effect store 和 daemon provider frozen/resume/stop/drain/partial rollback      | scheduler/repair/kill/resume、HumanGate、事件派发/observer、Intent/distill、DEOS/DA、fusion、MCP、清理/归档/GC、boot workspace/artifact/apply 恢复，以及 HTTP 直接执行                                         | 未获执行权不启动效果；失权停新派发；原业务 owner/重试不变；部分启动失败反向 stop/drain；编辑仍可用                                                                       |
| A8 装配和完整验收   | 各 owner composition/public；共同合同、调用者与治理清单                                                                                  | 所有 selected adapter 贯穿两个 provider、server、CLI、子任务/复杂 workflow/独立测试台；清理活跃链的绕过及错误 local fallback                                                                                   | 完整 AC00、独立功能 A-G、精确 SHA 双 OS/双数据库 hosted CI；本机物理机制留在独立 local adapter，不以 FS/spawn 关键词本身判失败                                           |

最短顺序仍为 A1/A2 与 A3/A4 各 owner 收口 → A5 → A6 → A7 → A8/完整 A-G。普通 resume 等八批54路径已经发布，原失败和修复 CI 单独记录；已有合格身份/revalidation/neutral webhook admission 不另造一套合同。CS receipt、binding、ACK 与身份映射留阶段 B。

## 当前候选边界

- 普通 resume11、RC经典内容10、插件 CRUD local5、selected boot2、程序编辑读取3、DA evidence读取6、终态 revival11及 seed完成6 共54路径已发布165bb447d；修复02940128f 的主 CI47/3 failure、Windows success，完整恢复继续，不能据此关闭 A2/A-G。
- 八组48路径收口为同一发布候选：原七组40加归档内容8，所有原有限功能 PASS/指纹不变。准备工厂 public 零消费者和随后测试导入 P2 已修，历史完整保留；按八个小 source commit、官方 scoped canonical/docs、五项实际增长回执后继退役发布，正式行为待本批 hosted CI。
- 插件 CRUD/物理安装/GC 各自独立 local 包，service 准确兼容边按实际六项登记 owner RC/A-T7 退役；runtime 物化和完整调用者仍在 A2/A6。提交预览只抽 isolated index 效果；其他候选/交付/Git node/wrapper/工作区检查仍为 A4 残余。
- 任务归档内容原七路径 PASS 保留，补正既有 RFC349 的真实查询源码键后八路径独立有限 PASS；原认领/导出/恢复/删库规则、默认 local 和全部 SQL 排序断言保持，异步内容 ACK、同 claim 重试与提交后丢 ACK 回归已写。现纳入48路径 scoped canonical；真 boot roots 注入与其他 TE/RC 内容继续。system-operations 外层 boot/seed完成事实已发布；外层锁、宿主生命周期、预打开 restore 仍属 A1，A3 各 launch lane 继续。
- A5 必须覆盖材料、执行与清理全链。可选 runFn、宿主路径/命令/PID 的换名或一层 wrapper 不能代替中立执行合同。

M0 只要求 H1/H2 和已开放编辑所需 H6、明确的未就绪能力状态；未就绪执行/效果 worker 不启动。此策略缩小的是 B/M0 适配范围，完整阶段 A 的退出门仍保留。M1 的首个任务闭环同时交付执行权、取消和重启对账。

## 候选工作区与启动前恢复24路径有限交付（2026-10-02）

已发布修复 b339e7e06e13c7b4456cc1bf928048c7fc0262a3：主 [CI36969850886](https://github.com/wangbinquan/agent-workflow/actions/runs/36969850886) completed/success，50/50；同 SHA [Windows36970559143](https://github.com/wangbinquan/agent-workflow/actions/runs/36970559143) completed/success，1/1。d5b266c8 的 cancelled 42/3/5、Windows failure 和默认 Windows36970426040 的 cancelled 均保留，不冒称这些旧 run 全绿。原 mixed report 丢失原因仍未确证；本次成功不把它改写成已修原因。

A4 候选工作区13路径由 /root/task_config_functional_gate 有限 PASS，有序指纹 d4be4543ef93d4d5e643d4266ce382d5bbcc47f12d89dcd5323672ba9663a33b。所选 factory/session/workspace 接收 opaque references，独立 local 包持有原 clone、FS、模式/digest、Git scope 和 import 机制。AW 原 stage/derive/commit、排序/过滤/首错、消息/receipt 与 idempotence 保留；lineage digest 按原需求顺序异步读取，import ACK 后才收尾，workspace→session 释放完成才返回，DA 真消费者 finally 等 cleanup 后写 verification 事实。原三组9/4/8个回归断言保持，旧cleanup调用等待完成；新10个所选能力用例和双 provider cleanup 两例已写。共享 tree-identity helper原体保持，整个 push 部分与基准逐字一致；不把 push/node/wrapper/其他Git或完整A4记完成。

A1 启动前恢复11路径由 /root/intent_functional_gate 有限 PASS，有序指纹34de018343c3d0814c8aa4e27d2846050d29fe5374ecfb7428ffba4f8462aafc。中立 DatabasePreOpenRecoveryPort<THistory> 与共享准备层等待 history→generation，之后独立 restore phase；原穷举表的SQLite/PG决定保持，读取失败在实际CLI原restore catch之外。默认路径逐次读取，原post-recovery工厂仍在restore时bare-call；原pendingRestore物理body仅 ./restore import改为等价绝对路径，独立local存放，service的10个value/type兼容出口保持。实际CLI/composition其余声明逆变换token一致；三个oracle仅真实facade、已迁出类型债、表位置注释变化。新12功能例覆盖3ACK、receiver/sync、6kind/provider组合、opaque history、no fallback与错误阶段，finally释放收完。完整安装/人工恢复/外层锁/seed/宿主生命周期与全A1仍继续。

官方 census 只纳入已提交HEAD加上述24路径，原工具/扫描/语料规则保持。entry1803（原1797）、background342（339）、imports5686（5661）、required-port liveness38（37）、exception5048（5024）、owner25720（25691）；public1045、implementation SCC空保持。新增 required SPI 有真实共享consumer、file provider及composition三方owner绑定。原298条边界条款的owner/why/退役规定保留；仅按原口径增加pendingRestore→SO local的实际value/type两项R1，inbound267→269、outbound31不变，A-T7退役。六项真实增长按原协议一次登记，匹配canonical发布后后继退役，不扩大目录/规则。

按两个source小提交、scoped canonical/docs及六项消费回执后继退役发布，正式行为仍以本批exact-SHA hosted CI为准。只有目标格式/lint、纯源码/AST/JSON证明及官方生成，没有本机AW test/typecheck/build/service。有限源码门、已有修复CI与新批正式CI各自记账；A1～A8/完整A-G、CS独立adapter、M0～M4继续，尚无AW-in-CS部署，不关闭RFC。

## 2026-10-02 所选配置与排空实施增量

已形成五组26路径有限独立PASS候选：叶层14、真实根6、周期2、仓库刷新2、备份2。两项首门FAIL/P2、修正和回归详见functional-gates，全部旧政策/counts/断言保持。A1的同一所选query贯穿双provider/daemon/HTTP和本批purpose读；awaitIdle及仓库刷新异步配置支撑后续CLI stop/drain。settings耐久写、剩余热读/后台真接线、宿主生命周期、完整A1/A7/A8/A-G继续，尚无CS生产adapter或AW-in-CS部署。

scoped canonical只纳入26路径、原规则保持；四项实际增长依原协议登记并在matching canonical后继退役。按五个小source提交及配套及时发布，正式功能验证交本批exact-SHA hosted CI和Windows，不运行本机AW test/typecheck/build/service。e4d6f5b2主CI已cancelled 27/2/21，CS三来源已通过，另一RFC来源503及聚合失败保留；并行c843938a三文档完整保留，其CI已completed/failure、48成功/2失败（OpenCode来源503及聚合），原失败保留。完整B/M0～M4顺序和RFC退出条件保持。

17路径metadata首门另有文档事实P2：c843 CI在复核期间刚进入终态，新增节的“待终态”已按精确回执修正；该finding和原候选指纹f162d6ecbbbbdd592d10d583f7083e8b060176f8991e6268a1366a697aeadbdc保留。独立单文档CI引用修正有限PASS，指纹32ba3a45fec8988daf421e3bb9a64bb4d45d00ab91f9d92158bae8c0e6a32fdf；按CLAUDE原规则把同固定提交/路径/行号的OpenCode blob超链接改成文本引用，逆变换旧全文逐字一致，原RFC371输出全部保持，不改任何事实、checker或预算。该文档以另一个小commit同批发布，正式恢复仍待本批exact-SHA CI。

## 2026-10-02 所选配置耐久写与后台真根增量

A1本批完成三个真实根的同一配置binding透传，Settings及live query使用同一selected persistence receiver和逻辑通知key；旧query-only覆写保持。A7增量接通backup/refresh真实stop/drain、维护初始读取、TE background/idle/batch所选query。通知2与根9分组有限PASS、原同步兼容P2保留并修复，真实双provider HTTP及held write/hot ACK/失败不改文件回归已写；源证明不替正式运行。

SQLite queued Intent、runtime注册表/迁移、boot/manual外层选择、锁及宿主生命周期仍属A1/A7；其余A2～A8及完整AC00/A-G持续，不以本批关闭全部配置或执行权。scoped canonical与三项真实增长按原规则发布/后继退役，正式行为等新exact-SHA CI；717的Windows已success，主CI非终态快照另记，原失败/取消保持。独立CS adapters及M0～M4仍按完整A-G后的顺序实施，无AW-in-CS部署；不运行本机AW test/typecheck/build/service，不关闭RFC。


## 2026-10-02 A1 手动迁移入口增量

四路径所选手动准备已有限独立PASS，指纹02890cdb5dce0365f295189d8df6dd91e25b8054385710f5e498ca40a475b8a3；原CLI prepare后完整正文保持，所选configuration/installation与default file分支明确，双provider ACK/receiver及原close错误优先级回归已写。首门两个P2及FAIL保留，旧CLI oracle只迁真实入口锚点，PG合法current/manifest/source路径完整。正式验证仍以本批exact-SHA hosted CI为准；前批Windows96eb success1/1和旧717主CI取消19/1/30分别留档。

完整A1仍含SQLite queued Intent、runtime/legacy配置真根、外层宿主锁/生命周期及安装/人工恢复其余入口；其他A2～A8与完整A-G不被本批有限PASS关闭。三项原projection数量各+5与实际CLI两R1替换一旧边按原协议记账，其他规则/条款不变。CS独立adapter、M0～M4继续，无AW-in-CS部署，无本机AW test/typecheck/build/service。

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

## 程序与证据读取真实根的接续（2026-10-03）

20路径组合有限PASS `ae7d8ffabdb9d18d9e58c03c90a9f9572ff99411ea45305ac772e187b511d97e`，实际三根统一传入既有ProgramArtifactPort和complete evidence read binding。文档五消费者/下载流已等待所选ACK，原prototype receiver、JSON/schema、membership及200/206/416/range语义保持；首轮两P2、两fixture后继PASS与原全文/W29证明见 [功能门](./functional-gates.md) 新节。官方scoped投影实际entry+2/imports+6/exceptions+6/owner+12，其余数量/原条款/SCC/liveness保持，四growth匹配canonical后退役。

本批仍不关闭A2：EvidenceStore写入/import、requirement materialize、DE输入文件的逻辑捕获/物化、全部TE/RC恢复仍须完整接入。A1外层宿主/锁/执行权，A3/A4全工作区/Git消费者及A5～A8继续；完整A-G后实施独立CS adapters，B/M0先部署再逐项M1～M4。前批2b/54f真实失败取消和76matcher修复的Windows成功/主CI未终态见 [STATE](../../STATE.md)。尚无AW-in-CS部署，不关闭RFC；原正文/并行输出与全部门/CI历史保持，仅目标静态检查和原scoped生成，无本机AW test/typecheck/build/service。

## 2026-10-03 本批宿主/JSON 写入后的实际余项

28 路径组合 SOURCE 有限 PASS `193a0c97303944b793cf098ff2faa89946dd8592cca6f5ca50a54033d94d5fc0`；host 首门 shutdown P2、两路径 R2 PASS 与其他 19 路径不变证据完整保留，doc-write 七路径独立 PASS。此次仅收口下列有限切面，不代表完整 A 阶段完成。

- A1/A8：本批 native lifecycle/query 已实际接入三 roots、会话重装配和 HTTP，ready/withdraw ACK 及 shutdown draining 有真实回归。原 DaemonHostLifecyclePort 仍是 declared-debt（W4-E7），SO application 协调/根 composition、raw PID lock、托管租约执行权和退出恢复语义继续；local PID 只作诊断，不能作为远程执行身份。
- A2/A8：五 JSON 文档消费者 await selected EvidenceDocumentCommands，原 domain 形状/默认 local import cleanup 保持。实际启动 root writer 注入、其他 EvidenceStore intake/import/materialize、上传、验证、工作区证据引用、下载及 blob 写入的完整逻辑能力仍需逐一迁移；不能用这五处 JSON 写入宣称全面对象存储接入。
- A3/A4：工作区/Git 的全部消费者、两 LaunchLane、prepare/candidate effects 与清理仍按原矩阵收口。A5 的提交、durable receipt、事件游标、消息/取消及终态清理须整条效果链完成；A6 全 purpose 命令、A7 所有 worker/authority 和直接 HTTP、A8 全 roots/AC00 继续，完成后独立完整 A-G。

227cfacc 主 CI37038117741 已 failure（44/6），Windows37038361399 failure 0/1；本批真实 QuestionSetV1 类型、range stream inclusive end 和 DE composition-root type export 修复保持原精确断言/manifest。76c564b 主 CI37034403145 已 cancelled（41 success、8 cancelled、1 aggregate failure），Windows37034643759 success。只交付新 exact-SHA hosted CI 证据才能确认本批正式行为；旧待终态文字作为历史保持。

原 28 路径 scoped census 与 boundary 各执行一次；entry +3/import +12/SPI +1/exception +11/public +2/owner +22 为实际投影，SPI 不冒领 active。304 原 debt 条款整组逐字相同，273/31、target 69、implementation SCC 空和四规则不变，boundary added 空；匹配 canonical commit 后六增长回执一次退役。无 AW 本机 test/typecheck/build/service；并行 span 输出不纳入本批投影或提交。

CS 独立 adapters、B/M0 与 AW-in-CS 真实部署均未开始。保持先完成平台中立 A1～A8 和独立完整 A-G，再在 CS 先部署 M0、增量 M1～M4 的既定顺序；RFC 继续，未达到最终关闭条件。

## RFC-370 类型出口增量与原 active SPI 恢复（2026-10-03）

首版 SOURCE28 `193a0c97303944b793cf098ff2faa89946dd8592cca6f5ca50a54033d94d5fc0` 与 METADATA17 `d1b498319866d70f916ac8bf32fd071eba0a447e2d741046ce59818dc8589377` 有限 PASS 保留，但未发布。原清单将 DE ProgramArtifactPort 的 from-type 再导出算作同路径第二次 composition binding，造成 active→declared-debt。仅 DE composition 一路径把出口改为 `export type { ProgramArtifactPort }`，复用原有 type import，整文件逆变换一致；单路径增量有限 PASS `38ca0e5cd13d8c8bc8af390afa963c82fe58600af080993f94966d7581c95443`。其余 27 路径逐字未变，复用原 PASS 组成 SOURCE28 `8ded9a42418055aa1674d4fb31360855f4a6ae66cdbe2781b20eddda68924dc1`，不重开 SOURCE 全量门。

实际源码变化后只执行一次新 R2 scoped census/boundary，保留首版生成记录；观察边和 exceptions 逐项与首版相同，六实际增量仍为 1810→1813、5723→5735、38→39、5085→5096、1045→1047、25780→25802。ProgramArtifactPort 恢复 active 且只有一个 composition binding；required 汇总现为 18 active/21 declared-debt（原 HEAD 18/20），宿主新增 SPI 仍 declared-debt/W4-E7。新 sourceDigest `sha256:8c56bbb82686cd2fbc2be56d46cf794bc5f8a5ec664a2645ccaae5b1d7d9d884`；四原规则、304 条 debt、273/31、target 69、implementation SCC 空保持，boundary added 空。六回执只更新本会话精确未发布记录，在匹配 canonical commit 后一次退役；没有替他人移除回执。

首版新节与全部旧正文/并行内容/门和 CI 历史完整保留。R2 METADATA 只检视实际变更的投影和新增记录；只做目标 format/lint、纯源码/AST/JSON/字节证明与原 scoped 生成，无 AW 本机 tests/typecheck/build/service。正式行为仍待新 exact-SHA hosted CI。完整 A1/A2/A3～A8/AC00/A-G 与后续独立 CS adapters、B/M0～M4 持续；尚无 AW-in-CS 实际部署，不关闭 RFC。

## 2026-10-03 宿主 application 与 writer 全根后的余项

本批 SOURCE12 有限 PASS `f493a18e5ff395a70d576e97fe15da31624de2e096e4609e2084398d8250dc7b` 收口 host application/唯一 composition 和 document writer 的根选择。旧九全文与七控制 SHA保持；宿主 required SPI由原规则成为 active，汇总19 active/20 declared-debt。该 liveness 只证明真实消费/提供/装配，不代表锁/执行权、所有内容或完整 A-G 完成。

- A1/A7：raw PID lock、启动唯一权、boot proof/恢复、托管租约及直接 HTTP authority 尚未中立化；保持 ACK 后退出，PID仅诊断，服务重启不得批量中断远程任务。
- A2/A8：JSON document writer 已贯穿所有 roots 和 provider 重装配；其余 EvidenceStore intake/import、materialize、上传、验证、工作区证据及 blob 输出仍需逻辑引用和独立效果链；不能以本批答案存储宣称整个对象存储接入。
- A3～A8：两 LaunchLane 和全部 workspace/Git 消费者；A5 submit/durable receipt/cursor/message/cancel/terminal cleanup 全链；A6所有purpose命令，A7全部worker/authority，A8 AC00/所有roots，继续完成后独立完整 A-G。

e0c42a53 main37050645456 completed/failure（44/6），Windows37050766328 success1/1，原失败完整保留。三测试 CI 守卫补正有限 PASS `430fd59c328c035fa1268b82e7526eda61090259062728795fd885370e73bb53`：实际 void count6→3、新真实 serve fixture调用1、RFC254两功能断言迁实际owner；规则/其他段落不变。复用12门组成SOURCE15 `d00525b2a6b937195b3acbf572a0643996dcc9d440cb9908442b359fa5ef9fcf`，尚待新 exact-SHA hosted CI，不冒称正式通过。原scoped生成只一次，四真实增长及原条款/数量保护见 [功能门](./functional-gates.md)，无本机AW runtime检查。

CS独立adapters、B/M0和实际AW-in-CS部署仍未开始。先中立A1～A8及独立完整A-G，再CS M0实际部署、逐项M1～M4；旧正文、所有门/CI历史和并行输出保持，不关闭RFC。

## 2026-10-03 启动租约后的余项

A1本批收口外层startup claim及neutral recovery receipt：同一selected lease贯穿真实roots/重装配，失败等待release ACK，默认native获取/错误/proof保持。首门两个P2、R2和组合14路径有限PASS见 [功能门](./functional-gates.md)。完整A7仍须托管执行权、所有worker/直接HTTP authority与remote orphan重启对账；不能以本机启动锁释放协议代替。

fd02主CI37056660544失败46/4、Windows37056797584成功1/1保留；两个CI测试修正有限PASS并纳入16路径，七实际账本增长按原协议登记/匹配提交后退役。只做静态检查、纯证明和原scoped生成，正式行为待新exact-SHA CI。原304条debt、四规则及peer span/UI输出保持。

A2其余evidence intake/blob/capture/import/materialize/上传/验证及TE/RC恢复，A3/A4两LaunchLane和所有workspace/Git，A5完整执行链，A6所有purpose，A7执行权恢复，A8全roots/AC00与独立完整A-G继续。随后CS独立adapter、B/M0实际部署再M1～M4；无AW-in-CS部署，不关闭RFC。

## 2026-10-03 上下文与员工输入真根后的余项

本批有限收口 AttemptContextStorePort 的异步读取全链和独立 native adapter、员工输入完整对象在 start/session、PG、SQLite 与 standalone HTTP 根的选择。三根各复用同一个员工输入 receiver 到 intake/materialization；其他 EvidenceStore 能力和物理 workspace 实现仍在原链，不能将本批等同整个对象存储或完整 A2/A8 完成。原40个 required SPI 全文保持，DA 专属 port 不改变原登记分类。

上一批 d2c29c15 的主 CI37062367239 success50/50、Windows37062367334 success1/1确认原修复；本批SOURCE18有限PASS，正式行为待新 exact-SHA hosted CI。新增长只为六 bootstrap type edges/对应exceptions和净增两 owner；原304条 debt、273/31、target69、四规则及已发布观测全文保持。无本机 AW test/typecheck/build/service；旧 CI 和所有门历史保留。

剩余 A2：RC 插件完整 CRUD/materialization/GC，TE 内容/prompt/scratch/archive/recovery 全消费，DA evidence intake/blob/capture/import/materialize/上传/验证/输出，DE 逻辑内容与工作区物化效果；A1 配置/安装/恢复其他读点也须按原矩阵核完。A3/A4 两 LaunchLane 与所有 workspace/Git；A5 submit/durable receipt/cursor/message/cancel/materials/terminal cleanup；A6 所有 purpose 命令；A7 worker/authority/直接HTTP/remote orphan 重启对账；A8 全 roots/AC00；随后独立完整 A-G 继续。CS重启应保留远程 task/receipt，不能批量按 native orphan 规则中断或取消。

CS独立adapter及B/M0、M1～M4和实际 AW-in-CS 部署尚未开始。保持中立 A1～A8/完整 A-G 后写各层独立 CS adapters，在 CS先部署M0，再逐项收编能力；RFC持续，不关闭。

## 2026-10-03 Mission 捕获/插件目录真根后的余项

复用现有完整 MissionInputBlobPersistence 和 PluginInstallerPort，在 start/session/recompose、PG、SQLite HTTP、standalone HTTP 根选择同一个 prototype receiver，undefined 保持原 lazy native factory。原上传 application/persistence/route 和插件 application/local installer/schema 全文保持。两新增双 provider HTTP 回归覆盖 capture/install 持有 ACK 时无新增行、成功精确 SHA/字节或 cachedPath/version、失败无行/无 native 回退、临时上传收尾，以及同一 installer 的 checkForUpdate 参数/响应；每例20秒预算保持。

首轮 SOURCE9 `7cf8c591e860555725d9ccc3a69edff55405e20b86cb9530a41106d05c5eb1d9` FAIL，两项 P2 为 PG call 对象重复字段（TS1117）、SQLite HTTP 漏透传。三路径 R2 独立 PASS `94d3cc13828a20e860ead3880e6073708caecb9ceee226d7ca5c9d2279ccfc62`，其他六路径和八控制逐字不变，组成九路径 PASS `7c310363c13f5d98ba4110bc7f87df0c62c3d05b04d3ddcbe791620ffea34759`；不重开全量门。R1 26 段恢复七份原全文，R2 四段恢复三份 R1 全文；新 AST 逐个定位真实 PG/SQLite HTTP call，字段唯一且 receiver/值正确，替换原失效的字符串计数。

完整 A2 继续 evidence intake/import/materialization/验证输出、resource-package/runtime 插件与 GC、TE/DE 内容/recovery和worker archive；A3/A4 两 LaunchLane/全部workspace/Git，A5完整执行链，A6全部purpose，A7authority/worker/remote orphan恢复，A8全roots/AC00和独立完整A-G持续。随后独立CS adapters、B/M0先实际部署，再逐项M1～M4。尚无 AW-in-CS 部署，不关闭RFC；旧正文、全部门/CI历史及并行输出保持。

上一批 b7c37804 主 [CI37070701985](https://github.com/wangbinquan/agent-workflow/actions/runs/37070701985) completed/cancelled（22 success、18 failure、10 cancelled），[Windows37070910393](https://github.com/wangbinquan/agent-workflow/actions/runs/37070910393) completed/failure 0/1。功能日志确认并行观测夹具 TS2345、runtime/runner 原断言、观测路由合同/MCP、测试引擎账本和前台样式/重试入口回归；Markdown 五项历史 run 链接为 GitHub502。owner 的两路径类型修正已发布1538a380，九候选/八控制/四规则不受影响，复用 source 门并基于此精确同步 SHA 生成；其余观测回归已协调 owner 接续。旧失败/取消保持，不将成功片段记为全套绿，正式行为等待新 exact-SHA hosted CI。

原 scoped 投影只新增六 bootstrap type edges 及对应 exceptions；原40SPI/20active/20debt、304debt/273/31、target69、其余数量/metrics/SCC及四规则保持。详见 [功能门](./functional-gates.md) 的本批有限记录。

## 2026-10-03 证据完整能力后的 A 余项

复用既有 MissionInputBlobPersistence、evidence content/document/download/context 完整合同，新增 EvidenceArtifactPort 只补逻辑 blob/bundle 物化和存在性 effects。原 EvidenceStore/native class 与 helper 全文迁至 infrastructure/local，旧入口保持兼容导出；选中的 complete prototype receiver 沿 start/session/recompose、PG、SQLite HTTP 和 standalone HTTP 根传入 DA、DE pipeline 与 Mission。原调用方的 staging、receipt、digest 和验证业务规则保留；等待所选物化、adopt 和 JSON 写入 ACK 后再发布 durable 引用，失败保持原错误语义并清理暂存。

SOURCE24 首轮 `d11853a87eb2650d6cff3daeedfade4dd888d5bb538b28845b00bebfe9f6067e` FAIL：同一物理 seed 在新增 await 窗口重放会重复物化/rename，以及新增 mode 判据遗漏原 Windows 分支。两路径 R2 `9bea70b062bc5003855d54f9b9550ad08662dbb29bb3cfc2be9ac47f3edcc7c6` 独立 PASS：复用原 KeyedSerialQueue，以 seedsRoot+planDigest 的实际物理地址串行发布并在持锁后重查；失败释放、后继重建，原 win32 判据恢复。其余 22 路径和 8 控制不变，组成 SOURCE24 PASS `e3b2d0095d7bcab431c2e3587023bade8efe76904129847ae928f065343b4bba`；保留首轮 FAIL，未重跑已完成全量 source 门。155 段逆变换恢复 19 份原全文及 native 迁移原文；10 个实际 root call 的新字段唯一、选中 receiver 正确，原 9 个核心 native 方法 token 逐字保持。

完整 A2 仍需 resource-package/runtime 插件与 GC、TE/DE 内容/recovery、全部 worker archive 和其它读取/物化链；A3/A4 两 LaunchLane/全部 workspace/Git，A5 完整执行链，A6 全部 purpose，A7 authority/worker/remote orphan 恢复，A8 全 roots/AC00 和独立完整 A-G 持续。只有完整 A-G 通过后编写独立 CS adapters；B/M0 先实际部署，再逐项 M1～M4。当前尚无 CS production adapter 或 AW-in-CS 实际部署，不关闭 RFC；原正文、门/CI 历史和全部并行输出保留。

本批原 scoped census 与边界报告各一次；imports5790→5794、exceptions5148→5152（3 条 EvidenceArtifactPort bootstrap type 边与 1 条既有 KeyedSerialQueue value 边），owner25903→25907（3 旧 native owner 迁移，7 新位置 owner，净增 4）。entry1823、public1053、background345、ambient501、全部 40 required SPI 全文（20 active/20 declared-debt）、304 原 debt 条款、273/31、target69、implementation SCC 空和 unresolved 空保持。13 ambient 地址只随真实行号移动，语义 multiset 保持；moduleFiles1469→1471、backendProductionFiles2026→2028，仅本批两个 DA source 文件。sourceDigest `sha256:954ca22d88be78bbb544504040a5d39d052e84e7558288fdc19b74e468f04bcf`。只登记 3 个真实 inventory 增长，匹配 canonical commit 后退役；后续自有 RC/SC/Worker WIP 与并行 EOF 统计均从本候选原统计中排除，保留现场文件。四独立新文档段落经逆变换恢复原全文，四条原规则未变。

此前 f3eedc6aa9cd380dbcc6b32b83be1f58da591752 的主 [CI37074418502](https://github.com/wangbinquan/agent-workflow/actions/runs/37074418502) completed/failure，50 项为 33 success/17 failure；[Windows37074493098](https://github.com/wangbinquan/agent-workflow/actions/runs/37074493098) completed/success，1/1。已保留原失败功能日志和归属，不能据部分 green 关闭。并行观测 owner 的源码1873e606、canonical cf83e1c5、正常退役655d1e8b已发布并交接共享窗口；同步0/0后复用完全未变的24+8 source 门，以655d1e8b原分类生成本批登记。owner追踪其 exact-SHA CI，本批运行行为等发布后的新 exact-SHA hosted CI；没有运行 AW 本机 tests/typecheck/build/service，已做定点 format/lint、纯源码/AST/JSON/字节证明与原 scoped 生成。

原 A 余项及全部功能门历史继续有效，详见 [功能门](./functional-gates.md) 的本批有限记录。

## SOURCE28 后的实际状态（2026-10-03）

本批完成两个 provider 的 workspace tree/file 内容选择、资源包 skill/plugin/export 完整 owner 接线，以及 maintenance Worker 内重建的三类完整效果（archive、包恢复、plugin GC）。所选对象的原 receiver、逻辑引用、ACK 与失败语义贯穿实际装配入口；CLI 初始和替换 session 传递同一完整选择。重复 drain 共用包含 heartbeat、效果 dispose 和 provider close 的完整关闭 Promise，不能提前发出 drained。

Worker 有限 DESIGN v2 PASS；SOURCE26 首轮 FAIL 的 `SOURCE26-P2-1`（重复 drain 可能早于 PostgreSQL pool close）由 R2 SOURCE4 PASS 修复。原始 boundary collector 随后发现三条新 helper 到 module-internal composition 的类型引用；保留第一次生成和失败，未改 `BOOTSTRAP_FILES`、规则或债务条款。R3 经有限 DESIGN/SOURCE3 审查，将同一完整类型经现有 exact `public/types` 入口重导出；三个改动文件生成的 runtime JavaScript 与前版完全相同。组合 SOURCE28 指纹 `bdee22293f4fa32d75e1bb7728ada62cf18be3d64ca1498b6790a84df7996452`。

workspace content 完整读取和三类 Worker 效果已有中性选择入口，资源包已有完整 owner 的真实根接线；其余 A1/A2/A3/A4/A5/A6/A7/A8 项仍按本清单执行。EmployeeCase 的 8 操作/6 binder/3 checkpoint 已有有限 DESIGN v2 PASS，尚未实施，不以设计通过代替能力完成。

原始 scoped census 为实际 SOURCE28 候选执行一次，排除并保留 RFC-371 的 4 个 tracked 和 15 个 untracked 源码 WIP。实际投影：mutation 1823→1826、background 345→352、observed imports 5794→5809、exceptions 5152→5167、public surfaces 1053→1056、symbol owners 25907→25932。6 个 native content helper owner 完整迁移，4 个既有 timer 仅变更行号，15 个 ambient 条目仅变更行号（501 总数和语义不变）；supervisor 的 phase 字段由原 collector 对 `effectsBootstrap` 文本重新投影，原生命周期不变。原 40 required SPI、69 target edges、304 债务条款和 273 inbound / 31 outbound 保持，新增 boundary 违规为 0。新增生产文件 4 个，source-control 文件净增 2 个；值循环及未解析 first-party 依赖未增加。仅登记这 6 项实际数量增长的一次性回执，并在 canonical commit 后按原语义退役。Source digest `sha256:d7cd21a663d5fde3d45b5bf92bbc204ab35a92f4e365a18ff552d9b4c72f542f`。

CI 修复提交 `3ff61d9eba0b129953d09d966235d7a2b3ca633c` 的主 CI `37087805975` 为 50/50 success，Windows `37087878452` 的第二次 attempt 为 1/1 success。保留第一次 attempt 的三个既有 code-intel 5000 ms timeout；未放宽断言或时间预算。该 CI 仅证明修复提交，本批 SOURCE28 的正式 whole-repository 结论待发布后的 exact-SHA CI。

完整 A1–A8/A-G 仍开放。本批不等于其他 Worker 效果、execution authority、workspace/Git、物化快照、执行流和全部装配入口的闭合。后续先实施已通过有限 DESIGN v2 的 EmployeeCase 完整效果范围，再继续剩余中性切面；CS adapter、B/M0 实际部署和 M1–M4 验收尚未实施。

## 2026-10-03 Employee case workspace effects SOURCE18 接续状态

本批中性切面是 SC Employee case 内容/Git，而不是 CS 生产适配。14 方法完整 scope 通过工厂选择，native 实现置于本层独立 local adapter；8 个原业务操作保留原布局、digest、Git 参数和业务裁决。源码证明核对 38 个原机制调用、10 个 Git 有序投影、两份 DA owner 的完整 AST 逆投影，以及 6 个实际 binder 的参数词法作用域。3 个 checkpoint 消费点支持完成类型并等待 ACK。

SOURCE17/SOURCE1 的独立功能检视均 PASS；真实双 provider held checkpoint 与真实 Worker 用例仅编写，尚待精确 SHA hosted run。d3 的 31/19/50 主 CI 终态、Windows 失败/取消和 maintenance 成功分别保留，四项确定回归已修正，PG Worker 根因未确认。新诊断显式保留 ready/active/completed/degraded/drained 事件，并使 degraded boot-drain 不能产生成功结论。

后续 DA 冻结产物读写与树快照仍有原生机制：原调用 census 已记录，下一切面需逐项保留原文件事实、读取形式、复制选项、顺序与 digest，并在内容/close 确认后再推进原持久化状态。Action/LaunchLane、其他 workspace/Git、执行与 Worker authority、A8 装配和完整 A-G 仍继续；CS adapter 和实际 M0 部署尚未开始。

本批原 classifier 的实际投影为：mutation 1829→1830、observed imports 5814→5817、architecture exceptions 5171→5174、symbol owners 26021→26031；只登记对应的 4 个正常增长回执。background 352、public surfaces 1056、304 条原债务、40 个 required SPI 和 69 个 target edges 不变，新增边界为 0。原 13 个产物由原生成器生成一次；其余 6217 个非本批源文件读取真实已提交基线字节。


## 2026-10-03 DA baseline 有限收口后的剩余范围

DA RepositoryBaselineEffects 的有限 DESIGN 与 SOURCE16 均 PASS，SOURCE 指纹 `67e296f121682683c51ba5af88fe6525ab3900a9a492838773e7deb2b8c51ef5`。完整 acquire/readHead/bindFileReader/close 生命周期复用原 BaselineFileReader、BaselineStat 和 SC Git outcome；两个 head resolver、上传上下文及三个 owner 由八个真实装配点传入同一 selected factory。原 SHA、Git binary cat-file/Bun.file/stream hash/finally rm 正文与 DB mapper 保持；每次 stat 使用独立 scope 并等待 close ACK，未提供选择时才使用独立本机 adapter。完整 receiver、held ACK、失败和 body/close 聚合回归已写，尚须 hosted 运行。

Worker cause 诊断的有限 DESIGN/SOURCE2 均 PASS，SOURCE 指纹 `1e854c0d42f7ca45121558c69c454ed2edfbc949a391f66453e7bfcb2e402b77`。生产改动只在实际 private errorMessage 中保留外层信息并依序附加 cause，循环有界；原查询、状态、ACK、provider 选择、close、重试和时间预算不变。这只让真实 PostgreSQL init 失败可见，根因仍未确认，不能称为修复完成。

官方 scoped census 仅使用已提交 `68bc1ce54007de881d65bb271c4b6b4fe787a591` 加本批 18 个冻结 source/test 路径，6220 个非本批源码读精确 committed bytes。四个原生成规则、所有并行输出完整保留；边界新增为 0。实际 mutation 1830→1832、observed imports 5817→5821、原 exception 投影 5174→5177、public surfaces 1056→1057、symbol owners 26032→26041；三条 native value 边和原 SHA owner 完整迁移，三个 Worker timer 与十四项 ambient 仅变行号，background 352/ambient 501 保持。40 required SPI、304 debt、69 target edges 和空 implementation SCC 保持。五项实际增长只登记一次，匹配 canonical commit 后由正常后继提交退役；source digest `sha256:64db696518fea6ecb66262efa6197a64a7682598ff12acd1808f891325a41f6b`。

前批 `12c82946bf43f5bd6ed82c3d086a4f2a8b662781` 主 CI `37098130275` 已 completed/failure（35 success、15 failure、50 jobs），Windows `37098130258` failure，maintenance `37098130248` success。三个纯测试修正另已推送 `68bc1ce5`；其主 CI `37101610276` 在本节冻结快照仍 in_progress，未取得全绿终态。全部旧失败、取消和首门修正保留。本批正式行为仍以发布后 exact-SHA hosted CI 为准；本机只作原 census、纯源码/AST/JSON证明及目标 format/lint，没有 AW test/typecheck/build/service。

完整 A1–A8/AC00/A-G 尚未关闭。下一项继续 DA workspace 原 protected/business snapshot 与验证效果，随后完成其余内容、工作区/Git、执行、命令和执行权切面；CS 独立 adapters 与 B/M0 实际部署、M1–M4 仍按已批准顺序实施，尚无 AW-in-CS 部署，不关闭 RFC。


## 2026-10-03 DA workspace 有限收口后的剩余范围

DA workspace 完整效果切面的有限 DESIGN PASS 指纹 `5171146df940948a8cc2e265a08f1358b9cef9708c1c0e486067b39b940fda06`。原 SOURCE19 指纹 `aa3f369a5df7d1d1c738052e872850bacbb6f80b07bbdac7e22a2872a94cad24` 的首次 FAIL/P2 完整保留：真实 Case 成功夹具缺少 ReactionRound 外键父行。只在新增测试补齐合法 round，并明确 native 字节值比较；单路径 SOURCE-R2 PASS 指纹 `6cc20311c3076d90c0e60dbf7b60d0283ea7df4f707d81d3e55cb1639202f37d`，其余18路径、9控制、5原证据未变。合成19路径 SOURCE 完整通过指纹 `1595b66a6ff5b103f9536c87834dd0e439859e0310749e6ac4bd7746e42cd70d`，不把首次 FAIL 改写为 PASS。

完整 factory 的 resolve/parent/acquire 与 scope 的12项操作由同一 selected receiver 执行；默认独立 local adapter 保留原 Node 操作，显式选择只用完整选择。protected/business snapshot、workspace validation、初始上传/输入材料、冲突/冻结平台工件与 hydration 全部串行等待操作和 close ACK；原 digest、DTO、判断与持久化顺序保留。Agent orchestrator 的 capture/validate 两处等待完成，九个真实 CLI/PG/HTTP binder 贯穿同一工厂；CLI 三份配置与 HTTP 测试 helper 同步。原84个物理操作及其参数、18个完整 CPU/DB 函数、两个 owner 的全部持久化调用、旧validator断言与预算均有一次成功的纯源码/AST逆向证明；W29 仅按原 normalizer 更新实际 PG 与 HTTP mount 投影，SQLite/events 和原168/49/65计数、八PG phase不变。

官方 scoped census 只读已提交 `dcdc249ff50bac893edbf8c19b6ad12cd264e0b6` 加本批19冻结路径，6223项非本批源码读该基准的精确 committed bytes，排除并保留并行7项源码 WIP（1 tracked、6 untracked）。四个原规则保持，边界新增为0。实际 mutation1832→1833、observed imports5821→5824、原 exception投影5177→5180、symbol owners26041→26057；三个实际根只新增工厂类型引用，原行和退休说明保持，16个实际 owner新增。13项ambient仅变行号，background352/ambient501、public1057、40 required SPI、304 debt、69 target edges和空implementation SCC保持。四项实际增长登记一次，matching canonical commit 后以正常后继提交退役；source digest `sha256:0f079fea01a5169edbb0c51157a4e230ae267e8ace337f966f46f9942749f305`。

前批 `13e72ad8326a85add6f5c73532a33848458288ac` 主 CI `37103290740` 已 completed/failure（47 success、3 failure、50 jobs），Windows `37103290747` 与 maintenance `37103290722` 均 completed/success。两个真实失败分片为 macOS 原报表数据库文件判据和 Ubuntu 的四个真实 PG Worker用例；聚合失败另计。真实 Worker cause 已显示查询 `agent_workflow.maintenance_runs` relation不存在，原时间预算未改。并行原报表文件修正 `c5cba4ee` 与配套 `c01f1dec` 完整保留；本会话两个 Worker fixture 文件另已精确发布 `dcdc249f`，通过完整 DESIGN/SOURCE-R2（原 env 类型 FAIL保留），从调用时的已定义环境值启动实际 source Worker；生产 Worker/runtime/协议/DDL未变。该 SHA 主 CI `37107720458` 已启动，创建回执状态为 pending，尚未取得全绿终态；不能称 Worker 修复已验收。本批正式行为仍交发布后 exact-SHA hosted CI。本机只做原 census、纯源码/AST/JSON证明和目标 format/lint，无 AW test/typecheck/build/service。

完整 A1–A8/AC00/A-G 继续：内容与恢复、其余工作区/Git、完整 Agent 材料/执行/清理、专用命令和执行权仍须逐组接线与完整功能复核。CS 独立 adapters 与 B/M0真实部署、M1–M4按批准顺序实施，尚无 AW-in-CS部署，不关闭RFC。


## 2026-10-03 DA workspace CI 修正后的剩余范围

精确 `6942511731dcaaf501756671e5dc99cc9d28efbd` 主 CI `37109647129` 已 completed/failure（44 success、6 failure、50 jobs）；四个 backend 分片的两个失败各在 Linux/macOS 复现，typecheck 与 required 聚合另计。Windows `37109837274` completed/failure，maintenance `37109647139` completed/success。失败证据保留，未把旧成功或重跑当成本批通过。前次 `dcdc249ff50bac893edbf8c19b6ad12cd264e0b6` 的主 CI `37107720458` 已 completed/success（50/50），四个原真实 PostgreSQL Worker 用例及 compiled Worker 加载均通过；这是 Worker fixture 修复自己的证据。

本次仅三个文件：原 guarded exists 的两项非空断言只恢复闭包类型；新 DA launch 夹具提供完整 adopt，并 stashing 与原 launchDirect 冻结一致的 Add feature/do the thing 内容；旧 EvidenceStore default 断言精确映射到 selected factory.resolve，并额外断言真实完整 factory binding。原 guard、内容/持久化顺序、所有既有断言和时间预算保留。有限 DESIGN PASS `a7c672dd90607d764261f912d6f03be79668251f78d1100a3471fbaffdba4e9d`，SOURCE PASS `8192ee83b0afe0d3ff280ae0c18ae256a5bdc755751d57eab9588e25e24297f3`；三份全文件原字节逆向证明、11控制稳定、原预算/断言保留已完成。本批行为仍须新 exact-SHA hosted CI，无本机 AW 测试、类型、构建或服务。

原官方 scoped census 只读已提交 `6942511731dcaaf501756671e5dc99cc9d28efbd` 加本批3冻结路径，所有非本批源码精确读取 committed bytes，排除并保留并行 WIP。12 JSON 与 status 使用四个原规则；全部 inventory 行、账本、原债务、required SPI、target edges 与 metrics 完整保持，不新增 growth 回执。只更新原精确源码投影及 provenance，source digest `sha256:4028cc01a4a986f8b89b20d8a6613b927bff01ea0122b763031999b4248efc1d`。四份手写文档以增量保留全文，status 仅原 renderer生成。

完整 A1–A8/AC00/A-G 仍开放。下一组继续资源包恢复的存储效果；CS 独立 adapters、B/M0 真实部署、M1–M4 按已批准顺序实施。尚无 AW-in-CS 部署，不关闭 RFC。
