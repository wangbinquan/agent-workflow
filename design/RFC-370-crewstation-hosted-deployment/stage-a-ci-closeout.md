# RFC-370 阶段 A 集中验收与 CI 修复

## 2026-10-14 新根语料守卫登记修正

完整源码 `dba70f0fceaf12b7a4e07a724aae47ef1ff49495`／架构 `73d1e14c516ff489621a56c1fd91e52600ad388b` 已发布并验证远端同步。主 run `38487257387` 的质量作业 `115603782464` 成功。Windows run `38487257249` 终态 failure，平台套件 1662 pass／2 fail，分别是原累计使用量成员归属与原生 reader 复用 5s 超时；相关 reader／generation／readonly SQLite 三份依赖及测试从前置 `651f956df` 到本轮源码保持原 blob。此结果不代签总绿。

主 CI Ubuntu 3 job `115603782598` 暴露本轮新回归的治理遗漏：rfc370-host-root-boundaries 是 corpus scanner，却没有 floor／manifest entry。此次在原 backendUnits 语料上新增 >=2000，再原样选择四个实际 roots；新增 guard row 使用原 isCorpusScanner／corpusFloor／assertsAbsence／negativeFixtureAssertions 分类，保持原扫描、普通 business caller 负向控制和所有既有登记。主 CI Mac7 的两次 startCommand 失败仍对应原 `6849c1073`，不混为本轮问题。

共享 main 已前进到并发源码 `02f64fe78`；其已生成的 13 份 JSON／status 输出完整保留，包含实际中立 contract 的一条 28688→28689 原一次性增长声明。共同提交时保留该声明、所有既有 baseline／why 与原生成正文，只补本人的 guard row 及实际提交 provenance。原语料下限、负 fixture 与根边界三文件 43 pass。直接读取提交对象 02f64fe78，八份 canonical 输出及 status 投影完整相等、原 canonical validation 零错误；live-tree 对账读到新并发 WIP 的两次不一致保留为无效候选证据，不重跑全门。限定 lint／格式通过；精确发布和远端确切 SHA 验收另验；A-G 未签，B/M0 未开始，没有跨 session 消息。

## 2026-10-14 已批准旧账本发布及其后本人 CI 修复

两条原 holder 的有限接手已完整发布为 `d78792ca58f5d44dc0511c4c2954e99afd20b9a7`／`3e809ce90b76d3c8e0123cff82b7f89b4b3d045e`，生成物只改 4 个实际有差异的治理文件，13 份完整生成输出保持一致；生产 sourceDigest 仍为 `sha256:ac91c17ad90bee0bec7136c186cc77d268c79289820474e44881ec7542f1480d`。原账本 7→9、严格扫描 3 pass，原五条 growth 已消费退役，本次新增仅对应两条原槽的实际增长。main CI `38486154259` 已触发，未据此宣称总绿。

旧 `c4adc1975` 完成功能作业提供了本阶段其他确定责任：job `115591398567` 的新通知 deadline unref；job `115591398588` 中本阶段新 root/内部适配器导入；job `115591398904` 中资源限额中立装配与原 PG 函数的重复实现。此次候选移除等待 timer 的 unref，保留 wake latch／abort／原 drain；把实际 daemonHostExecutionBootstrap 精确登记进原 bootstrap 集合，两处 Task 适配器通过原 composition 对外装配；将逐字相同的 PG 兼容装配收敛为原中立函数别名，legacy SQLite 的原取消路径保持。原完整 native 对账 helper 只逆新增的确切 composition export；原摘要和未知变异判据保持。

新增四个实际 host roots 的边界回归与普通 business consumer 负向控制。集中诊断 9 文件 45 pass，涵盖 deadline 原 guard、实际根边界／原同文件严格 guard、真实 bootstrap／embedded／周期限额、原 PG 限额合同、真实 webhook，以及十一原完整 caller。新增根用例的只读 bootstrap 集合改为显式 string Set，修正 Bun expect 的窄字面量类型匹配；该两项复验通过。没有全仓本地 gate、没有以增加债务代替修复本阶段直接内部导入。

其余确定归属单列：`main.ts` 中两处 startCommand 调用引入于 `6849c1073`，不属于本阶段；Migrator 读数从 4/3→5/4 来自 RFC213 dev reload 测试；dev 和 observation 剩余旧 R1 导入、Bun 1.4.3 断言、development@11 对旧夹具及原统计成员失败保持原证据。用户本次例外仅为两条 holder 及其生成配套，未据此接管其它旧业务或账本。并发 `4d22bc95e` 修复保持，候选内容无关的移动不触发重复全门。backend Typecheck（8 GiB Node 堆）exit 0，限定 ESLint／Prettier／diff 检查通过；生成配套、确切源码提交及总 CI 各自验收；A-G 未签，B/M0 未开始。

## 2026-10-14 两处旧装配计数接手授权

用户已明确批准原预览中的两条 `COMPOSITION_ROOT_PLACEHOLDER_DEBT`：`cli/dev.ts: holder=1` 和 `modules/run-observability/composition/completeObservationReports.ts: holder=1`。原完整测试扫描器和严格相等断言保持，原实际源码保持；两文件从失败提交 `3472c9fc2` 到已发布 `c4adc1975` 的 blob 一致。生成配套将该账本 7→9，按新提交记录准确 provenance，并退役已消费的一次性增长声明。

前一轮源码 `7f3244667e2f6e4ca77428773bf164cf7a2b3ef3`／配套 `c4adc1975a6d94f0f21a91d7e7ac535582e2848b` 已远端同步；独立完整功能门最终 PASS／0 findings。主 CI `38483477606` 的类型、lint、格式、shared/system mock 作业 `115591398071` 成功；Windows `38483477689` 终态 failure，平台套件 1657 pass／1 fail，新增 Memory before/after COMMIT、原 runtime identity、webhook 实际 owner、三个 native 正文及 P12 原完整 caller 均通过。Windows 唯一套件失败是既有增量累计使用量成员归属，不以局部通过签整体总绿。

当前另已按真实提交归因：前端基础设施断言仍要求 Bun 1.4.0，而并发 `91f2bd982` 把正式 workflow 升为 1.4.3；旧员工 Case 夹具仍请求 development@10，前置 `651f956df` 正式 package 已为 @11，相关生产和夹具在本阶段原 blob 保持。其余原 CI 尚按 job/step、确切 diff 和依赖核对，未自动接手范围外代码。两条旧装配账本的新发布及确切 CI 另行验收；阶段 A／A-G 仍未签，B/M0 未启动。无跨 session 消息。

## 2026-10-14 授权修复与完整实现门结果

用户已明确授权接手限定历史 CI 修复，并授权本任务内只读审阅完整阶段 A。原实现门返回 1 个 P1、2 个 P2；三个 finding 和材料失败清理尾项均已修复，原审阅者必要续审结论为 PASS／0 findings。该结论只代表当前源码候选的独立功能门，不能代签 A-G、GitHub 总绿或 CS 部署。没有跨独立 session 消息。

- webhook 的所选宿主 fast path 只唤醒 Event Center 原 owner，同一 polling lifetime 串行消费和排空；native 立即消费保持。两处 daemon 装配显式选择 host 模式，真实 HTTP 入站覆盖 resource-only、standby、激活、失权、原在途 ACK 和 idle wake。
- Memory 补问显式携带原 retained material reference，跨轮保持同一材料 generation，各轮 executionRef 仍独立。journal 提交前／后中断均可冷恢复原补问；续接检查尚未成功时，准备失败清理不会删除同路径替代材料。真实 System family 失败链回归覆盖 marker、seed 内容和未发执行。
- 原 runtime observation identity 三字段进入原 durable context；冷补问还原原身份和 model，不重新解析当前配置。旧记录缺字段仍兼容；当前 profile 改名、revision 和 model 改变后的请求与真实 System observation owner row 均核对原身份。
- 限定旧 CI 修复使用 Bun.Subprocess 的 signalCode 合同、两个原 root 的有限精确逆变换及样式计数 155→154。原 whole-source／whole-body 指纹没有改写；原变异、未知后缀和完整调用者断言保留。既有 dev／clarify inverse 现在同时识别绝对、相对和 Windows 文件名。
- 确切旧主 CI `38465814183`／job `115532229852` 暴露本阶段新增的 provider-name 分支；原根现在比较所选 owner 与实际 runtime 的 provider／generation。三条真实根入口拒绝回归及原 provider 分支守卫通过，未抬高预算或登记品牌豁免。

集中诊断有效结果：backend Typecheck 通过（原 Node 默认堆 4 GiB OOM 是无效执行；8 GiB 的同命令 exit 0）；Memory 业务恢复／P12／System root 3 文件 29 pass；原 System caller／polling／Event Center 4 文件 46 pass；材料 generation 两条定向用例 2 pass；真实根／provider 守卫／三个原 native 正文／P12 最后 11 pass。此前 webhook 3、journal 8、bounded owner 11 的有效结果复用。新增 webhook／Memory 用例已登记 Windows 专项。未运行全仓本地 gate；双 provider 和完整流水线最终以发布后确切 SHA GitHub 为准。

旧 `3472c9fc2` 主 CI 为 failure，72 jobs 中有 39 个失败，不能称为总绿。旧 job `115532230349` 的剩余两处占位计数在 `cli/dev.ts` 与原 completeObservationReports；其实际源码变化不属于本阶段，保留证据并按 AGENTS 等原责任修复。未将这两项自动并入本次限定历史例外。并发 RFC-371 在制文件保持，已提交的并发 main 祖先完整保留；最终 canonical 从本次提交的 Git source-ref 统一生成。

当前尚余完整提交及架构配套、远端同步和新确切 SHA 总 CI 终态验收。阶段 A／A-G 仍待 GitHub 总绿，B/M0 未启动，AW 尚未部署 CS。

2026-10-14。本文件记录候选和确切证据，不能替代 GitHub 总绿、独立 Codex 实现门或实际 CS 部署。

## 后续确切 CI 缺陷收口

完整源码及首轮修复已经发布；`1f1e9bd3805e0004a6c85ca926863f3ce42fef04` 的原源码 inverse 组合配套发布为 `1ab87945287e8506adde15a549b6976000da83e4`。对应主 CI `38459523717` 尚未终态，默认 Windows `38459523776` 已失败，不能签阶段 A 完成。

本轮候选修正本任务新增的异步拒绝链：Intent 启动、冷恢复和原预约激活各自在调用点观察拒绝，原失败仍由同一 turn 记录、报告并向 drain 暴露，不重复通知、不确认未知结果。Memory journal 的材料类型来自其 required System family 的 Task public 合同，取消直接 runtime-management 类型边；owner 的 token key 复用已存在的 Task public 合同。embedded MCP 构造结果由一次完成的 promise 转交、清理动作当场登记；webhook controller 由同作用域完整 const 构造。

同步补齐三份真实 CLI 装配入口分类、执行／Memory 原恢复 HTTP 合同清单、event-center 的实际宿主装配导入、Memory 稳定 ID 算子，以及 Fusion 异步定时器、信号回调和 employee descriptor 的原测试适配。组合根清单显式登记新文件的一次性双 family 安装和五处原工作 lifetime 状态；前者是本 RFC 设计中已记录的构造环，后者用于保留原 pause tickets、blocked Memory owner 和未 drain frame，不把它们宣称为已拆除的依赖。

候选定向诊断：Intent 原主回执／恢复、embedded 实际根、双 family bootstrap 和 employee input 四文件 SQLite 合计 24 pass，Fusion 相关三项 3 pass；HTTP 合同与 Event Center 清单两文件 18 pass。Promise 拒绝链／Memory offered DAG／微算子通过；同组仅余原 `cli/dev.ts` 和完整 report composition 的两处计数差。模块边界仅余先前 observation projection 的三条导入差。单引擎清单另补原 embedded AppDeps／DbClient 真实 SQLite 根，保留 open 记录，不编造文件名豁免；相关八项通过。变更 TS 的语法及 lint／格式检查通过；Bun 执行 backend Typecheck 仅报告先前五处 signalCode 和当前并发 RFC-371 测试两处错误，没有本轮候选文件的错误。原完整摘要／负向断言均保留；这些结果不代签全仓 CI。

阶段 A 剩余三项收口：本轮缺陷与架构配套完整提交；独立实现门；对应发布 SHA 的主流水线和默认 Windows 全绿并签 A-G。既有 CI 阻塞修复预览和独立子代理仍等用户答复，没有应用预览、启动代理或向其他会话发消息。阶段 B / M0 不提前启动。

- 完整生产及用例源码：`b9b27bfd84e0b39dac6b6f7dd76eee78343cc511`。
- 对应 canonical 投影：`1e085af8e14bb6b7657fd6be9402f88ff78276d3`。
- 该 SHA 主 CI `38442493702`、默认 Windows `38442493555` 均终态 failure。
- 本次只修复依据失败 job/step/实际依赖确定属于 RFC-370 的问题，保留相关共享文件的并发产出及范围外 WIP，无跨 session 消息。

## 生产修复

宿主关闭先关闭执行准入，等待原 owner 正常 stop/drain，退休 authority 的原 write epoch，再进入 provider close。实际 beforeCloseProvider 不再在 core queue 内等待回调同一 session queue。资源 serving、普通暂停的原取消策略、原业务回执和未知执行的显式物理恢复均保持。

Memory journal 持久化 versioned canonical-json base64 封套。PostgreSQL 的 JSON 校验无法表示 escaped NUL；封套保存原 canonical JSON 字节，两 provider 解码后继续原严格业务 schema。旧 plain JSON 仍可读取及比较，未替换原 job/attempt/round/receipt identity；原终态及 prompt NUL 用例保持。稳定候选 ID 改用 ulid 2.4 的真实 factory PRNG 合同，不把 ACK 重试当成新候选。

Intent 在原异步调用前一次捕获 retained owner 与 forget 方法；恢复尾部复用该原对象。未激活 helper 的夹具保持原预约／nonce／预算，在下一实际激活后继续；已发输出 ACK 丢失只继续原尾部。Memory 原协议恢复的第二 helper 若 prepared ACK 丢失，必须根据已保存原 prepared reference 显式恢复后才允许新 active owner 继续，不能凭第一轮已知输出推断第二 helper 未执行。

## 有效候选诊断

本机只复现 GitHub 失败的相关范围，未运行全仓 local gate。第一集中诊断发现缺陷，修复后复验相应范围，不用后继无关 SHA 重跑全量。

| 范围                                                           | 当前有效结果             | 边界                                                                                    |
| -------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| native shell/runtime/resource 和原启动重试                     | frontend 七文件 108 pass | 不是完整 E2E                                                                            |
| Intent 原主 ACK 丢失及原预约冷恢复                             | SQLite 8 pass            | 双 provider 最终以 hosted 为准                                                          |
| actual activation / embedded root / Memory original business   | SQLite 35 pass           | 同组的旧材料夹具另行修复                                                                |
| MCP selected lifecycle / true original child recovery          | SQLite 23 pass           | 沙箱禁止 ps 时不能拿 command-mismatch 当机制失败；正常宿主权限完成本用例的原 child 排空 |
| stored MCP query / selected webhook preparation / boot / owner | SQLite 五文件 48 pass    | 未代表全仓结果                                                                          |

## 责任证据与开放门

本任务之前确切源码 `651f956dfcb1be90f6a1d9d6086f9139f2215e53` 的主 CI `38429501809`，job `115407653250`，已经报 `tests/cli.test.ts` 四处 signalCode `number | Signals | null` 对 `string | null` 不兼容。本轮 TSC 在修正 RFC-370 类型后只剩这些及 `scripts/rfc359-p0-mutations.ts` 同类错误。两个范围外文件没有被本次修改。

本次 immutable Git source 复算进一步确认：P12 inverse 在前置 `651f956df` 与当前候选均为 `cli/start.ts` 186448 bytes 对原摘要 185817、`cli/postgresqlDaemonApplication.ts` 131154 对 130746；本轮 stage A delta 移除后差值逐字一致。两个原完整摘要没有被改动。这是残余差已在本轮实现之前存在的直接证据，不能按本次 push 归属。

原 whole-source oracle 的有限 stage A inverse 只还原本次新增 owner/recovery/resource/Fusion wiring，保留并发 native fact / reporting hooks，再交给先前明确 inverse。不得改原完整摘要、删除负向变异或把已有并发变动吸进 RFC-370 的白名单；剩余摘要差保留，按原提交归因。

Codex 功能评审能力在当前环境未提供；CI 检查工具不等于独立代码评审，未登记实现门 PASS。阶段 A 保持待验收，B/M0 尚未开始。下一次完整提交后必须核对确切 SHA 主 CI／Windows，终态全绿及 A-G 取得才进入 CS adapters。

## 确切 CI 及 inverse 组合收口

`448eebf333fed279e132f4978827882417666a52` 与配套 `7bb2d73b631f9f1062a54420323201b439626942` 已 push 并确认 main/origin 同步。该 SHA 主 CI `38455536876` 在运行；Windows `38455536849` 已 failure。Typecheck job `115497168566` 仅余原先五处 signalCode 类型错误；frontend shard 3 job `115497168981` 的两项失败在报告返回展示，backend shard 7 job `115497168905` 的六项失败在 RFC-371 累计数值。归属依据原改动／依赖核对，不按文件名认领。

本任务新 inverse 的 anchor 不能抢先把相邻原 report projection 的变异归为自己的片段。修正先组合已有 dev/clarify/native-fact inverse，再逆阶段 A；新增片段逐字匹配仍不可缺，必要时从另一侧唯一定位，未知邻接内容保留给原 oracle。SO／W29／System root 的相关 57 项通过，原完整指纹、原负向断言与并发接线均未改。

既有 CI 阻塞的修复预览仅保存临时目录；等待用户明确例外于 AGENTS 第 4 条后才可应用。独立审阅子代理也等待授权，没有因等待超时自行启动。当前工具未提供独立实现门，未签 A-G、CI 总绿或部署完成。
