# MCP 家族正式 CI 回归配套修复

4a16c26f39e00b03715c0a191e191cec56e53ef9 的 Windows 平台 CI 37434929678 正式 failure：450 pass、3 skip、1 fail。失败的是新 opaque boot recovery fixture；它把 `requestDigest` 写为四字符 `boot`，不符合原迁移 0125 的 64 字符小写十六进制合同。在任何恢复行为前，真实 SQLite 插入即失败。本次只用现有 SHA256 计算该 fixture 的 digest；不改持久化、schema、恢复行为、原测试名、断言或预算。

同一 SHA 的 macOS shard5 job112174654323 正式 failure：3141 pass、2 skip、1 fail。原 RFC-364 source oracle 仍在普通 application 寻找 `recordSpawn`，该唯一写入已随完整 MCP 家族搬到 native owner。本次只把这一断言对准真实 local infrastructure 的同一持久化方法，并增加普通 application 显式选择 `captureTurnStart` 的断言。原 settle、capture 顺序及其他全部断言保持；不新增第二写入或改变应用策略。

本片为两个测试和此说明的有限功能修复。使用完整原测试 AST 逆向证明，自有 format/lint 与独立功能检视；正式行为只交后继 exact-SHA hosted CI。本机不运行 AW tests/typecheck/build/service，不因测试修复重复生产 census。4a 主 CI 尚未终结，两个实际失败与 Static scans 状态保留；不读取或分析 Static scans，不称整套 CI 通过。

Script WIP、并行 RFC-371 内容均排除本次发布。阶段 A、CS adapter 以及 M0 首次部署与 M1–M4 仍继续，RFC 不关闭。
