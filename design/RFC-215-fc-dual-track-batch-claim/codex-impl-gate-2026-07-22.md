# Codex Adversarial Review

Target: branch diff against 87e1d3fd
Verdict: needs-attention

NO-SHIP：批处理在协议验收前已合并代码，崩溃恢复又把 host done 错当成逐卡成功；此外还存在取消竞态、缺失 agent 热循环和只读成员误派。现有测试没有覆盖这些跨层失败顺序。

Findings:
- [high] 协议失败重试发生在 canonical merge 之后，会重复落入无效批次的副作用 (packages/backend/src/services/workgroupRunner.ts:2374-2389)
  触发路径：batch host 执行完成后，scheduler 已将隔离 worktree 合入 canonical；此处才校验 wg_task_results，并在缺卡、误发或协议错误时重跑整批。每次失败尝试的文件副作用因此已经落库，后续重试会再次执行并再次合并。预算耗尽时，代码还会把已报卡结算、缺卡回 open，但缺卡对应的部分代码可能已在 canonical，造成任务状态与仓库内容分裂；非幂等操作可能重复或冲突。
  Recommendation: 把 host 执行与 canonical merge 拆开，在协议完整性和逐卡结果验收通过后才合并。若无法拆分卡级文件增量，应采用批次原子语义：无效或缺卡的尝试整批丢弃。增加真实 git worktree 集成测试，验证部分/畸形输出不会改变 canonical，成功重试只产生一次变更。
- [high] 崩溃恢复把 host done 等同于所有批卡 done，绕过协议与失败结果 (packages/backend/src/services/workgroupRunner.ts:419-438)
  恢复路径只要发现关联 node run 为 done，就将仍为 running 的 assignment 全部改成 done。工作组 host 又明确不持久化 declared outputs，因此若进程在 host 完成后、解析 wg_task_results 或逐卡结算前崩溃，恢复时无法判断缺卡、畸形协议或卡片自报 status=failed，却会把整批卡标成成功且没有 resultMessageId，直接绕过重试预算并可能错误完成父任务。
  Recommendation: 持久化独立的批协议验收及逐卡结算 checkpoint/outbox；node run done 不能作为 assignment done 的充分条件。逐卡结算必须可重入且幂等。加入故障注入测试：分别在 host done 后、每条结果消息后和每次 assignment CAS 后重启，并覆盖缺卡、畸形输出和显式 failed 结果。
- [high] 缺失 agent 的 adopted batch 仍可形成无预算热循环 (packages/backend/src/services/workgroupRunner.ts:2162-2193)
  agent 不存在时，此分支只处理本轮新领取的 cards，没有终结 adoptedRunId。若澄清恢复或其他路径留下 pending 的 batch host row，engine 每个 pass 都会再次 adopt 同一行；此分支反复发布 batch skipped，即使卡片已失败，pending host row 仍不前进。相邻 message 路径对缺失 agent 也直接 return，未读 mention/fc_initial 同样缺少持久进展。运行中删除 agent 是可达状态，因而 20e9e73a 的热循环收敛并不完整。
  Recommendation: 统一处理 fresh/adopted batch、message 和 initial wake 的成员缺失：一次性终结 adopted host row，并将任务转为明确的 failed、awaiting_human 或 unavailable 状态；或者禁止删除仍被活动 workgroup 引用的 agent。补测 pending batch 澄清恢复后删除 agent，以及缺失 agent 的未读 mention/fc_initial，断言 pass 数、消息数和 host row 均有界。
- [high] 忽略 dispatched→running CAS 失败会在取消成功后继续执行并合并卡片 (packages/backend/src/services/workgroupRunner.ts:2259-2271)
  批次 host mint 后逐卡 CAS 到 running，但返回值被忽略，本地对象仍无条件改为 running。若用户取消在 mint 与 CAS 之间获胜，路由会成功把 dispatched 卡改为 canceled，此批却仍把它写入 prompt、执行并最终合并副作用；结算还可能发布幽灵结果。重试路径更新 nodeRunId 时也只按 id 匹配，可能污染已取消或重新认领的卡。
  Recommendation: 把 CAS false 视为所有权丢失并从实际执行批次移除；host shardKey 和 prompt 只能基于成功转为 running 的卡重建，空批应终结。重试更新必须同时约束 status、assignee 和预期旧 nodeRunId。增加屏障并发测试：mint 后、CAS 前取消，断言卡片不进入 prompt、不产生结果且 canonical 无该卡副作用。
- [medium] 只读回退按“当前空闲集合”判断，会在可写成员忙时把卡误派给只读成员 (packages/backend/src/services/workgroupWake.ts:335-345)
  代码先排除 task-busy 成员形成 idleAll，再在其中寻找 writable；只要可写成员正在运行或等待而只读成员空闲，writable 就为空，随后回退到 idleAll。于是混合 roster 并非“全员只读”也会把开放卡分给只读成员，重现角色误派并消耗 attempt_count；若最终失败耗尽，父任务还可能按 drained 收尾。
  Recommendation: 回退条件必须基于 roster 全体是否存在可写成员，而不是过滤 busy 后的 idle 子集；只要 roster 中有可写成员但其暂忙，就保持卡片 open。全员只读应进入显式、可解释的停驻状态或要求用户确认。补测“可写成员忙＋只读成员闲＋存在 open 卡”。
- [low] clarify askerKey 仍手工拆解 batch key，六消费点单源承诺未兑现 (packages/shared/src/schemas/workgroup.ts:381-385)
  这里通过 startsWith 和 split(':')[1] 手解 batch key，没有调用 parseBatchShardKey。它会接受单源 parser 拒绝的畸形值，并在编码格式演进时独立漂移，可能令澄清预算、停止或恢复使用错误成员键。
  Recommendation: 改为调用共享 parser 或提供统一的 batchMemberKey helper，并增加源码守卫，禁止 codec 模块之外出现 batch key 的手工 startsWith、split 或拼接。

Next steps:
- 先修复执行、协议验收、merge、逐卡结算之间的持久化边界，再处理其余并发问题。
- 补齐真实 worktree、崩溃注入、取消屏障、缺失 agent 和混合只读 roster 的回归测试。
- 重跑 RFC-215 同族测试及仓库完整门禁后重新进行实现门审查。

Codex session ID: 019f8759-4f47-76e1-b190-c4e6ac8fced1
Resume in Codex: codex resume 019f8759-4f47-76e1-b190-c4e6ac8fced1
