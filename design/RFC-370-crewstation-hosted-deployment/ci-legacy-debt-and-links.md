# RFC-370 hosted CI 的清单分类与历史引用修复

`67c1839d8771b6e1aeb09e642b7f52bb544d83d0` 的 Windows run37516996277 已正式 success。主 run37516880667 尚无终态，已完成的 Markdown job112451991833 与 Ubuntu backend shard9 job112451992504 均 failure；以下只按这两项功能日志修复，不倒写旧 run 或记录整仓绿色。

RFC-317 T23 的原逐条相等断言实际差一条：`system-operations/application/ports/daemonExecutionRuntime.ts -> @/platform/persistence/databaseProviders` 是 canonical 清单实测的 type-only 出边，但原 `outboundBoundaryEdges` 的 legacy target 前缀并不包含 `platform/`。前次投影错误地把这条 canonical 分类同时写成了 legacy R2 债务。仅退役本会话新增的这一条假 legacy 行，将 outbound baseline 48→47、总 authored rows358→357，并按原稳定 JSON 规则修正该文件的 provenance digest。原 canonical imports/exceptions/owners、其余12 matching、全部129有序账本／why、四原规则、原断言和实际生产合同不改；原356行及另一条新增 inbound 行完整保留。没有为此另跑 census。

Markdown job 实际67个502引用落在27份文档的64行。仅将日志点名的 Actions 链接转成原显示文本；无显示文本的 URL 保留 Actions run 编号。完整正文逐行逆变换对拍，历史结论、所有计划、RFC-371 并行内容及其它字节保持。旧链接失败原日志与确切位置保留，不用重跑掩盖红。

本片仅元数据和引用修复；Task 真实根选择候选另行审查、采数和发布。独立有限功能门、精确提交／推送与后续 hosted CI 分别验收。完整 Stage A、CS adapters 和 M0–M4 仍开放，AW 尚未部署 CS。
