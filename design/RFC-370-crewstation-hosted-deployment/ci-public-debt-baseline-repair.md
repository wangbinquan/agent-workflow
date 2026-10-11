# RFC-370：公共类型条目数基线的 CI 配套补正

`02e39fee3ec2e2040dbbea8001b53e9d0dd72cb2` 已发布四路径 CI 修复，但主 CI `38125547086` 的 macOS 第 2 分片 `114429051713` 在原 RFC-317 T16 报告 `rfc294-review-unconsumed-public-symbols: 源码 143 vs 基线 141`。这是本会话遗漏了公共类型登记后的条目数基线配套；保留原失败和旧独立有限检视结果，不把它们写成完整 CI 通过。

本批只有 `architecture/ledger-baselines.json` 与本文：该账本基线 141→143，追加实际原因和本提交真实两项增长的 `allowGrowth`。原143项完整清单、原141项旧库存的字段/顺序/清偿波次不改，新增项仍仅为已发布的 `HostExecutionWriteLeaseFacts`、`HostExecutionWriteLifecycle`，均按原 W9-D 清偿。实际 public 清单的零 consumer 谓词仍与这143项集合相等；保留已批准的完整宿主写入合同，H7真实生产根消费完成后逐项销账，不把未来接入写成已有消费者。

完整基线 JSON 的其他账本、原属性和 canonicalProjection/sourceDigest/provenance 保持。RFC-317 T16 精确相等、T17 父提交比较、增长原因和一次性声明退役规则全文不改。独立功能检视同时覆盖新增增长声明与紧邻普通提交中仅移除该声明的退役内容；两个提交一并推送，最终运行在退役后的精确 SHA。增长已发生的源提交保留声明，后继不涨的提交移除声明，不补造旧提交的许可、不改写历史。

报告快照测试的两个 TS2769 与构造点差异由其原会话处理，本批保留它的并行输出，不修改或提交该文件。完整原 Windows 命令、测试、断言和预算保持。此前三个 macOS 超时的源码和预算不改，具体原因仍未建立；当前 Windows `38125547046` 已 completed/failure，完整平台测试成功后在报告快照两处类型错误停止，不能当作总绿。

本批仅做必要条目数补正与静态字节/JSON/AST 验证，不重跑 census，不在本机运行 AW 测试、类型检查、构建或服务。新 SHA 完整主 CI、完整默认 Windows、八条实际 workspace Typecheck code 0，以及相关 637 次实际用例仍需读取验收；两条流水线全绿前不继续 RFC 的下一适配层。H7三根十九 owner、A-T7/A-G、CS adapters、M0–M4 和 RFC 完成状态保持开放。
