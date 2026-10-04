# 原始 step 身份缺失不能证明零消耗

在 `opencodeUsagePass.ts` 的原始 part 读取处，`step-start` 或 `step-finish` 的 `message_id` 是空字符串或 SQL NULL 时，读取器在推进该行前具名拒绝，并关闭这次原始快照。原来的开始／完成 delta 分支只保存有效 message 身份，导致畸形开始消失，无步骤 EOF 错失原有 `native-step-unfinished` 证据。

真实原始 SQLite 回归覆盖两种缺失身份与未完成开始、单独完成、成对开始／完成的六种组合。有效开始／完成、四桶归一、原快照、分页 ACK、完整 EOF、60 秒总体量测试与 30 秒实际 Worker 测试的断言和时间预算均保留。AW 不运行本机 test、typecheck、build 或 service；新用例行为仍待确切提交的 hosted CI。

此修复仅属于未接入 producer 的完整读取器基础。持久 before baseline、原 owner emission/revision/source ACK、正式 producer 切换、历史补全、全部旧采集上限移除和真实模型任务验收仍未完成，不据此宣称正式统计已完整。
