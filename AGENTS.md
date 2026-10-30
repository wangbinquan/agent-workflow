# Repository agent instructions

- Before starting work, read `CLAUDE.md` and `STATE.md`, then follow the current repository guidance in those files.

## RFC 开发与多 session 协作硬规则（用户 2026-10-12 明令）

以下规则适用于本仓所有模型与 session，必须执行，不得自行豁免；与仓内旧流程、历史 RFC、`STATE.md` 或经验文档冲突时，以本节为准。

1. **先完成全部开发和测试用例编写，再集中进行功能验证。** 按已批准 RFC 的完整需求清单完成全部生产实现、接线和测试用例，再进入测试执行、功能验收、端到端验证和实现门。设计阶段的需求研究与设计门照常进行。不得自行把完整需求缩成若干小批次，写一部分代码就反复跑测试、门禁、浏览器验收或实现门，以验证循环代替剩余开发。开发期间只做必要的读码、语法与格式静态自查；不得借“自查”提前进行功能验证。集中验证发现本人缺陷后，修复并复验相关范围；候选内容未变时复用已有有效结果，不因 HEAD 前进或他人的无关提交反复重跑全量验证。
2. **禁止发送跨 session 信息。** 不得向其他独立 session / chat / thread 发消息、派活、催办、请求确认或协调发布；不得借助 `send_message_to_thread`、`SendMessage`、代理转发或其他渠道绕过。需要用户决定的阻塞只在当前会话说明，不能以“协调”为理由联系另一个 session。
3. **允许合并提交他人的修改，禁止回退他人的代码。** 提交上库允许完整保留并一起提交其他 session 的现有修改，包括共享文件中的修改及必要的关联文件；不得为剥离归属、制造干净树或让 CI 变绿，删除、覆盖、回滚、暂存移走或先撤掉再补回他人的代码。仍须明确本次提交的路径清单、检查共享 index，按路径提交；不能把未知暂存项或无关在制品不经核对一并扫入。提交说明与实际共同贡献者归属必须覆盖所提交的全部实质内容，交接时说明含有并发产出。
4. **CI 红了先归因，再由责任 session 修复。** 依据失败 job / step / 日志、确切提交差异与相关依赖判断根因；本 session 引入的问题由本 session 修复，其他 session 引入的问题保留失败证据并等待其自行修复，禁止代改、催办或回退对方代码。不能仅凭“由我 push”、失败文件名或 RFC 前缀判断责任；归属不明时在当前会话说明依据不足，不擅自认领。等待期间继续不受影响的工作，优先事件驱动等待，避免高频查询与重复验证；共享 CI 未绿时如实报告，不冒充整体通过。

## Commit attribution

- When an AI coding agent materially contributes to a commit, append a standard Git co-author trailer using the actual agent or model name and its provider's noreply email:
  `Co-Authored-By: <agent-or-model-name> <provider-noreply-email>`
- For Claude Fable 5, use exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Replace every placeholder with the contributing session's real values. Do not hard-code one vendor, product, model, or email for all agents, and do not attribute a commit to an agent that did not materially contribute.
- If multiple agents materially contributed to one commit, add one non-duplicated `Co-Authored-By` trailer per contributing agent.
- Do not add an agent co-author trailer to a human-only commit.
- After committing and before pushing, verify the trailer with `git show -s --format=%B HEAD`. If a required trailer is missing, fix it before push; do not rewrite already-pushed shared history solely to add or change attribution.
