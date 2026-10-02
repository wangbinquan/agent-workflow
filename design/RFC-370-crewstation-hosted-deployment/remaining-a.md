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
