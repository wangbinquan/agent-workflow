# RFC-370 A2：端口产物内容效果

状态：Design candidate。本节在已批准的阶段 A 范围内实施；独立设计门和源码门记录后才记本批通过。完整 AC00/A-G、CS adapters 和 M0–M4 仍开放。

## 现状和范围

`services/portArtifacts.ts` 同时拥有 RFC-193 归档规则、同步文件操作及三级读取回退。唯一生产写入者是 `services/runner.ts`；读取者是 `routes/port-artifacts.ts` 和 `collaboration/infrastructure/review.ts`。其余生产消费者只使用纯 codec、相对路径和必达清单函数。归档必须在全部端口验证完成之后、输出引用入库之前完成；评审必须在原 mutation lock 内读完内容才创建 doc versions 或 park。

本批将这些业务规则迁入 Task Execution application/domain，文件操作迁入 `task-execution/infrastructure/local/filePortArtifactContent.ts`，由 `composition/portArtifacts.ts` 选择。`services/portArtifacts.ts` 仅委托 exact public commands/queries/types。跨域 review 只消费 public 读取合同；原分类规则和债务扫描判据不修改。

## 中立合同

`application/ports/portArtifactContent.ts` 定义完整 `PortArtifactContentEffects` receiver：

| 方法 | 输入和结果 | 责任 |
| --- | --- | --- |
| prepareArchive | taskId/nodeRunId/portName → void 或 Promise | 建立所选归档命名空间，空 items 也调用 |
| reference | 同一命名空间、item index、扩展名 → opaque string | 解释引用编码只在 adapter；native 保留原编码 |
| size | WorkspaceFileReference → number 或 Promise | 源字节大小 |
| copy | 同一 source/reference → void 或 Promise | 原字节归档、等待写入完成 |
| readPrefix | source/maxBytes → Uint8Array 或 Promise | 8KiB 二进制采样和文本前缀 |
| write | reference/bytes → void 或 Promise | 截断文本及原警告尾部 |
| linkTarget | source → inside relativePath/outside/none 或 Promise | 仅返回中立工作区目标信息 |
| readArchive / existsArchive | taskId/reference → bytes/null 或 boolean，可异步 | 所选归档读取和元数据查询 |
| readWorkspace / existsWorkspace | WorkspaceFileReference → bytes/null 或 boolean，可异步 | 所选工作区回退 |

`WorkspaceFileReference` 使用 opaque `workspaceRef`、`relativePath`，保留可选 generation/version；应用不解析物理根。当前 native binding 与 SC 原 opaque workspace string 的本地编码兼容。完整生成代、版本和远端工作区生命周期接线由 A3/A7 继续，不能据此关闭 H3。

`PortArtifactOperations` 提供 async archive/read；读取面另暴露 `PortArtifactReader`。选择只有整个 receiver 为 undefined 才构造 native；显式 null、缺方法或部分 effects 拒绝，不能逐方法混入文件默认。方法在所选原 receiver 上执行，支持冻结的 class 实例、private/prototype state 和标准 await thenable 语义。工厂构造时不读写文件；IO 在请求驱动后发生。raw effects 只由 bootstrap/composition 装配，不作为用户配置或子任务可继承字段。

## 一份规则和同步兼容

Application 用一个迭代的 effect-yield policy 描述 archive/read。内部 request 只保存待调用函数；同步解释器只由 native compatibility composition 使用，异步解释器逐个等待并把同步抛错/异步拒绝送回 policy。没有递归串联或第二份本地/远端业务实现。

保留 archive_json v1、item 顺序、源大小、扩展名、阈值、8KiB NUL 采样、文本截断警告、超限二进制 file:null、symlink 必达清单及原 metadata-failure 忽略语义。同 nodeRunId 的原 native 重试覆盖行为保持。读取保留 archive→指定 workspace→missing、legacy repo 前缀、inline content、meta 零文件字节 IO、数字 only 只读指定 item，以及 API MIME/截断头/404 和评审的原占位行为。内容读取失败仍经原回退；归档写入失败仍沿 runner 原环境故障路径，不能变成 envelope followup。

原 `archivePortArtifacts`、`readPortArtifact`、`readInsideRoot`、`existsInsideRoot` 和其它 helper 的同步签名/结果保持。旧 archive helper 显式传入的 sourceAbs 可与 root/sourcePath 不同；native compatibility 将 source 对象映射到其原绝对位置，只有 file adapter 解释它，不把 sourceAbs 加入中立 DTO。原 native helper 函数体/纯 helper 可迁位，不能删除旧行为用例。

## 所有生产接线

CLI 初始/replacement session、PG daemon 和 standalone HTTP 在各自 appHome namespace 选择一次完整 operations，并同时交给 runtime writer、下载 reader 及 collaboration factory。HTTP 显式预选 operations 优先于 raw effects；旧单独 mount fixture 未传 reader 时在其原请求时刻读取 Paths.root，保持现有惰性环境绑定。PG HTTP port-artifacts mount 必须收到与 runtime 相同的对象。

Runtime participants 输入增加 factory，bound options 增加 required operations；原 SQLite/PG 兼容 composition 补完整 native factory。三个真实 runNode 调用传入该对象，runner 使用逻辑 workspace reference 并 await archive ACK 后才更新 archiveJsonByPort、规范化 outputs、必达清单及数据库输出。原 workgroup-host 不持久化输出等判据保持。

Collaboration factory 将所选 reader 注入私有 review dispatch 参数；普通 scheduler 和 repair 都消费该 factory，不新增数据库或公开 dispatch raw dependencies。直接 legacy review fixture 通过 exact public compatibility selection 保持原 appHome/scopeRoot。应用只传原 containing scope binding，不自行选择 task root。

## 回归与有限退出

保留所有原测试断言、名称和预算；仅真实迁位的 source locator、薄 facade 清单、实际 source digest/声明数和父子字段分类允许按本批事实更新，不修改原 normalize/scanner 判据。包括 RFC-193 module/API/force-include/wrapper-review、RFC-254 产物数据定位、RFC-284 原函数迁位定位、W8/W12 runtime fixtures、T20 不继承效果对象和 W29 未激活装配的真实快照。

新增功能覆盖：opaque archive 与 workspace 引用，真实异步 receiver 下的逐项顺序、meta 零读/only、归档丢失及拒绝回退、UTF-8/二进制原字节和截断、空集合/重试、原 sourceAbs 兼容、frozen/private receiver、同步/异步错误及 held ACK。新增双 provider 真实 runner 验证 archive ACK 前没有输出入库、评审 ACK 前没有 doc versions/park，下载 ACK 前无响应；真实 roots/factory 的 reader/writer 同一对象以 AST 和功能接线覆盖。测试编写但不在本机执行；正式行为和全仓结果由发布后的 exact-SHA hosted CI 判定。

本批完成后继续其它 A2 内容/恢复、A3–A8 及完整独立 A-G；随后才编写各 owner 的 CS adapter，M0 先真实部署，再逐步 M1–M4。

## 设计门 R2：归档故障的诊断边界

首门 P2 保留：所选 effects 合法的任意同步异常或异步拒绝原因可能无法 String 转换，旧 runner catch 会再次抛错并进入 runtime-spawn-failed。runner 原归档 catch 增加局部不抛错的诊断转换：正常 Error/string 等沿用原文案；诊断转换本身失败时固定返回 `unavailable error description`，继续原 `port-artifact-archive-failed` 环境故障路径。归档错误仍不设置 envelope followup failureCode，不清零既有 tokenUsage，不改 exitCode 或其它状态/取消/清理顺序。

新增双 provider 的真实 runner 回归分别让选定 copy/write 拒绝 `Object.create(null)` 和具有 throwing Symbol.toPrimitive 的原因，断言归档故障文案、原已采集 usage/exitCode、无输出行、无错误归类到 runtime-spawn-failed；同时保留正常 native Error/sync throws、写 ACK 前无输出入库及成功后引用持久化。只改这一归档诊断边界，不扩展其它 runner 错误面。


## 设计门 R3：原生字节查询兼容边界

原生成器在任何清单写入前失败，具体为把旧 `readInsideRoot` 的 Buffer 和兼容请求的 `extends Omit` 暴露为新公共 opaque 引用；原规则和十四项名单不扩张。NativeReadPortArtifactOptions 改为明确的八个原字段，保持字段类型、readonly、可选性和行为。单纯用 inline import 类型绑定 Buffer 会触发原 consistent-type-imports 规则，其未发布候选和 lint 失败保留，不沿用该形式。

`readInsideRoot`／`existsInsideRoot` 是根目录字节读取与存在查询的原生机制，没有 Task 状态或归档业务规则。两函数连同原 Buffer 同步签名和完整函数体迁入 `platform/content/local/rootFileQueries.ts`；task-execution 的 file content adapter 消费这两个物理查询。原 services/portArtifacts 兼容出口直接转导该 platform native 包，保持旧函数身份和 Buffer 全 API；跨业务模块的 public queries 仅转导原中立 readPortArtifact、Reader 及纯 helper，不发布物理根查询。platform 机制不是另一个 bounded context 的内部 API，也不添加 facade、业务规则或 CS 实现。

已有读取、引用／namespace、阈值和 fallback 政策仍只在原 application policy 中；native helper 移动不改变所选 eleven-method receiver、工厂零 IO 或任何 ACK 顺序。两处原源码地址夹具只跟随 helper 的实际迁位，原断言、名称、预算和函数体保持。新增 legacy 兼容回归通过 service 与 native 机制的函数身份、Buffer 类型赋值及 equals／toString 字节行为锁住原合同。

真实 launch 范围是 nodeMechanics 三处与 wrapperMechanics fanout shard／aggregator 两处，共五处，均传入同一 selected PortArtifactOperations。原 SOURCE36 四项 P2 已由 SOURCE4 修复；这次只补字节机制和类型表示，不重开已完成的其余源码范围。原生成失败、三路径 type 候选和 lint 失败全部保留；新 SOURCE、原 scoped 生成及有限 metadata 门完成后才发布，不等同完整 A2／A-G／RFC 或部署验收。


## 2026-10-04 端口归档内容切面的有限接线

SOURCE36 首次四项 P2 FAIL 原样保留；有限 SOURCE4 修复了 fanout 两处所选 operations 漏传、任意 Error.message 转换、真实 Agent.outputKinds 夹具和 Windows 原路径 oracle，独立复核 PASS。随后原 canonical 首次生成在任何清单写入前发现 Buffer 与 extends:Omit 两项 opaque 不匹配，17 份元数据保持；中间 inline import 类型的 lint FAIL 同样保留。原规则和 opaque 名单不改。

独立 DESIGN-R3 与 SOURCE8 PASS 后，readInsideRoot/existsInsideRoot 两项完整 native 函数移到 platform/content/local/rootFileQueries.ts，旧 service 继续准确转出口并保留 Buffer|null API；中立 public 只保留 reader、DTO 和纯 helper。NativeReadPortArtifactOptions 显式保留原八字段。原函数 AST、所有旧断言/名称/预算及其它控制文件保持。SOURCE37 最终组合指纹为 658707166cb805a6f25d1fc5ddafdad689cf56e3c9f90459c7befb44f8a1b1dd；这是有限源码组合，不是完整 A-G。

归档与读取由 TE application/domain/composition 拥有，完整 11 方法 content factory 与 operations/reader 只在 undefined 时选 native 默认，保留 frozen/prototype/private receiver；constructor 零 IO。同步 native 兼容和异步路径共用一套 policy；2MiB、8192 字节 NUL 样本、truncation notice、archive v1/meta/only、legacy 与原覆盖行为保持。writer ACK 后才推进 runner 的 maps/outputs/roster/数据库写入，任意拒绝原因保留原诊断与回退。所有五处 runNode 消费点、ordinary/repair review 和 SQLite initial/replacement、PG、独立 HTTP 根共享所选实例；原 mutation lock 与原数据库 AST 不变。

R2 原生成器基于已提交 335cc5333ae3883bd8f9b457c3253add552809d9、冻结 37 个 owned 源码及四份 exact committed 原规则执行一次；非 owned 源码均来自该提交，三个并行观测源码 WIP 与一个新观测测试被保留并排除。实际 sourceDigest 为 sha256:8374c61a4f7114855af3604e243c664db5827232894f00bdfb6800e1ee913323。新增 6 个生产文件（5 TE、1 platform），只按实际五项投影增长登记：mutation 1852→1857、observed imports 5944→5983、exception projection 5289→5323、public surfaces 1075→1101、owners 26376→26410；匹配 canonical 发布后的后继提交再正常退役回执。原 129 项有序手写库存/why 保持，不新增库存或债务条款。原规则仅销账 service portArtifacts→private taskArtifactPathQueries 的一条消失 type R1，其余 302 条记录全文保持；40 required SPI、69 target edges、空 implementation SCC 保持。原 guard 仅随 owned canonical 测试总行数 893→894 更新，业务写点与 transaction/effect 记录仅实际 id/line 投影。

前次 prompt 夹具提交 eef2874b53a073dd19faac654d890a41397a6d88 的 exact 主 CI37151693012 已 completed/cancelled（4 success、1 aggregate failure、42 cancelled），不记为通过。包含修复的后继 57f6c29303a17a2a6b28db5966da1f9bc69b1548 主 CI37151884308 completed/failure（37 success、12 failure、1 cancelled）；其 Ubuntu6 job111287352004 内本批 15 个 prompt binding 用例全 PASS。其余原生观测/W5/R1/超时失败按完整日志归属交由并行 owner 接续，整套 CI 未通过。当前归档批次尚待发布后的 exact-SHA hosted CI；本机无 AW test/typecheck/build/service，只有限 format/lint 和纯 AST/JSON/字节/census 证明。

完整 RFC-370/A1–A8/AC00/A-G 仍开放。A2 runtime 物化、A3 workspace/upload/restore、A4 node/wrapper Git/commit/delivery/conflict/repair、A5 logical materials 与 submit/inspect/events/message/cancel/收据先于激活/reap、A6 purpose commands、A7 authority/recovery 和 A8 全根装配继续；随后独立 CS adapters，先 B/M0 实际部署，再 M1–M4 逐步收编。当前没有 AW-in-CS 部署或验收，不能用有限 PASS 关闭阶段 A 或 RFC。


R3 夹具位置的准确说明：两个 native helper 共用 RFC284 的一个 pa 源码读取定位，该定位整体迁到 platform native queries；另一个 realpathSync/warn factory 源码定位继续留在 filePortArtifactContent。原 R2/R3 设计全文不改写，所有原断言保留。
