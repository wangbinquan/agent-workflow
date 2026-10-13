# RFC-370 阶段 A 集中验收与 CI 修复

2026-10-14。本文件记录候选和确切证据，不能替代 GitHub 总绿、独立 Codex 实现门或实际 CS 部署。

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
