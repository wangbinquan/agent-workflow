# RFC-370 阶段 A 集中验收与 CI 修复

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
