# RFC-370：公共类型条目数基线的 CI 配套补正

`02e39fee3ec2e2040dbbea8001b53e9d0dd72cb2` 已发布四路径 CI 修复，但主 CI `38125547086` 的 macOS 第 2 分片 `114429051713` 在原 RFC-317 T16 报告 `rfc294-review-unconsumed-public-symbols: 源码 143 vs 基线 141`。这是本会话遗漏了公共类型登记后的条目数基线配套；保留原失败和旧独立有限检视结果，不把它们写成完整 CI 通过。

本批只有 `architecture/ledger-baselines.json` 与本文：该账本基线 141→143，追加实际原因和本提交真实两项增长的 `allowGrowth`。原143项完整清单、原141项旧库存的字段/顺序/清偿波次不改，新增项仍仅为已发布的 `HostExecutionWriteLeaseFacts`、`HostExecutionWriteLifecycle`，均按原 W9-D 清偿。实际 public 清单的零 consumer 谓词仍与这143项集合相等；保留已批准的完整宿主写入合同，H7真实生产根消费完成后逐项销账，不把未来接入写成已有消费者。

完整基线 JSON 的其他账本、原属性和 canonicalProjection/sourceDigest/provenance 保持。RFC-317 T16 精确相等、T17 父提交比较、增长原因和一次性声明退役规则全文不改。独立功能检视同时覆盖新增增长声明与紧邻普通提交中仅移除该声明的退役内容；两个提交一并推送，最终运行在退役后的精确 SHA。增长已发生的源提交保留声明，后继不涨的提交移除声明，不补造旧提交的许可、不改写历史。

报告快照测试的两个 TS2769 与构造点差异由其原会话处理，本批保留它的并行输出，不修改或提交该文件。完整原 Windows 命令、测试、断言和预算保持。此前三个 macOS 超时的源码和预算不改，具体原因仍未建立；当前 Windows `38125547046` 已 completed/failure，完整平台测试成功后在报告快照两处类型错误停止，不能当作总绿。

本批仅做必要条目数补正与静态字节/JSON/AST 验证，不重跑 census，不在本机运行 AW 测试、类型检查、构建或服务。新 SHA 完整主 CI、完整默认 Windows、八条实际 workspace Typecheck code 0，以及相关 637 次实际用例仍需读取验收；两条流水线全绿前不继续 RFC 的下一适配层。H7三根十九 owner、A-T7/A-G、CS adapters、M0–M4 和 RFC 完成状态保持开放。

后继 `cd9613a9a2cd6439bbefa28dec69b6c056d79920` 的完整默认 Windows `38128502074` 已正式成功，26 步、四条 Typecheck code 0 及 166 次具名实际案例已核对。主 CI `38128419125` 已正式 failure：69/72 作业成功，Ubuntu 第 24 分片 `114437522136` 与 macOS 第 12 分片 `114437522205` 均在原 RFC-294 N1a `rfc294-canonical-manifests.test.ts:808` 报告同一基线内容摘要不相等，聚合 `CI required` 随之失败。已存 `sha256:afb5fe19ccefeb85e474cbd360ba431ec308e28f91cdd03c42bf81232e56246a`，完整当前 payload 应为 `sha256:e579b45f019baa03e95649c9e255a7703f5e0a50ad36a5f4ed7d6e708a929690`。这是本会话补正 baseline/why 后遗漏了内容摘要配套；原有限 PASS、失败、发布和本段之前的正文保留，不把有限检视当作完整 CI 成功。

按原 `artifactPayload` 排除 provenance/recordedAtSha 字段、按原 localeCompare 排序和带末尾换行的二空格 JSON 计算摘要，独立静态计算复现了该确切 hosted 预期。baseline/why 的改变与仅移除 allowGrowth 的后继状态都需要分别计算各自完整 payload 摘要。`currentSnapshotSha` 继续表示可达的已提交祖先，不需要额外 repin 或重跑 census。当前 RFC-371 在同一文件生成完整架构配套，已核对其完整 130 行保留本修复且其实际内容摘要相等；由于真实文件重叠，已做一次必要发布协调，等待该完整批次正常发布后再核对确切 SHA 和完整两条 CI，不单独提交其在制配套。

共享完整配套已由其原会话在 `16ba8f3668301e5a6afaf10616f25d871b2f6740` 正常发布，父提交为上述 `cd9613a9a`；本会话重新 fetch 后核对 main/origin 精确相等、索引为空。四份原 provenance artifact 的完整 payload 摘要与 recorded digest 均相等，八个祖先引用可达；完整 130 行、公共清单全部 1269 行、143 项零 consumer 身份集合及原条目数/增长判据保持。原 H/L/R/SO 与 boot 测试源码、完整默认 Windows 流程均与已消费检视的字节身份一致。主 CI `38132049327` 与自动触发的完整 Windows `38132049380` 正在运行，采用现有默认运行、零手动触发；本段不签两条 CI 总绿、637 次实际执行、后续适配或 CS 部署。

上述 `16ba8f366` 两条运行随后均正式 failure。主 CI 为 66/72 作业成功，五个功能作业失败并使 `CI required` 失败：Typecheck 的后端默认约 4 GB V8 堆触及上限后 SIGABRT/code 134；Ubuntu 28/32 与 macOS 4/12 的原 RFC-294 §A2 全文投影不相等；Ubuntu 8/32、macOS 8/12 与完整 Windows 的同一新增 temp Message 回退用例实际进入了物理查询分支。三个平台该用例分别为 27.73/44.91/107.46ms，并非超时。Static scans 作业 `114448226341` 和全部十四步正式 success，本会话只核对状态元数据，没有读取该作业原日志或扩大排障范围。原公共条目数与 provenance 的静态保持核对已通过，两条流水线总体仍红，不代签总绿。temp 夹具及整套 status 投影由其原会话按当前完整在制批次正常修复、发布；本会话仅补主 CI Typecheck 的堆设置，见[本轮 CI 修复](ci-linux-typecheck-heap.md)。原失败、正文、检视和生成历史保留。
