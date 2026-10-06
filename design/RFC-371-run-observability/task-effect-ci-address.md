# 已迁移 Task 执行函数的 CI 地址

提交 `e24de73a3ab0b12c99998b70bd5e3904e5be003a` 的主 CI `37390522481` 在 Ubuntu shard 16 与 macOS shard 4 均报告同一个实际失败：RFC-328 的执行函数登记仍要求 `services/runner.ts#runNode`，该文件已是原出口兼容转发。实际函数及 `localExecution.effect.submit` 位于 `modules/task-execution/application/taskAgentRun.ts#runNode`。

只将原登记和对应缺 observer 的负例迁至实际函数地址，原 callable、方法集合、断言、预算及生产行为保持。失败日志与终态保留，功能执行由修正提交的 exact-SHA GitHub Actions 验证；本机仅精确格式与 lint，不执行 AW 测试、类型检查、构建或服务。完整原生采集和两个 RFC 仍在进行中。
