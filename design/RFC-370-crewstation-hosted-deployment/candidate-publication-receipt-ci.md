# Candidate publication 的 logical effect receipt CI 补正

2026-10-05，基准 `6521ab0ffc20df0f5dbbb08ca92ebab451d614ac`。此批只有新增测试的回执形状补正和记录，不关闭 A-G，也不含 CS adapter 或部署。

`9e327500b7b08d4b42ea7b4e5fb4548ac99e110e` 的 [CI 37219704832](https://github.com/wangbinquan/agent-workflow/actions/runs/37219704832) 终态 cancelled：10 个作业成功、36 个取消、2 个失败。除聚合门外，唯一失败在 macOS shard 4 的 `commit-push-runner.test.ts` 新增 close ACK 测试。日志里实际 pushed 和 commitSha 均存在，但被原持久化合同包装在 `lastAttemptReceipt` 中；测试错误地断言平铺字段。此结果保留为失败，不视为整体通过。

原 `taskExecutionEffectPersistence.ts` 在聚合 attempt 后写入 `{ v: 1, appliedAttemptNo, priorAmbiguityCount, lastAttemptReceipt }`。测试据此核对完整外层字段和原内部 pushed／commitSha，attemptNo 直接取实际持久行，不改变生产回执合同。close ACK 前仍必须 running／open 且没有 receipt；close 拒绝后仍不允许 node／effect 提前结算，真实 bare Git、双 provider、所有原断言和时间预算保持。只有一条注释和一个 expect 内容变化，反向替换后整份测试逐字等于原文。

基准的 [Windows 37220626642](https://github.com/wangbinquan/agent-workflow/actions/runs/37220626642) 已成功；[主 CI 37220500802](https://github.com/wangbinquan/agent-workflow/actions/runs/37220500802) 单独等待。新修复提交的确切 SHA 仍需正式 hosted CI。目标格式／lint 与纯字节证明独立记录，没有本机 AW 测试、typecheck、build 或 service，没有 canonical 重采或新增增长许可。执行／材料、执行权／恢复及全部阶段 A 收口仍继续，后续 M0 首次部署与 M1～M4 不能据此关闭。
