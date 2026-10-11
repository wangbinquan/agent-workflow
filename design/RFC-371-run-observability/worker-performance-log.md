# 原报告 Worker 的性能诊断日志接回

完整统计仍慢，需要原产品的分阶段耗时。`load-performance-` 是已经实现的显式诊断入口；普通报告不启用诊断。2026-10-11 的原报告 `f6c2d538-c082-48b4-b615-02ddc2f0b2b8` 已封存且 65 个 API 页实际 EOF，137 个任务、595 次尝试、446 次调用、四桶 Token 及 ¥4.078952 与原报告保持；HTTP 创建至观测为 14,174.681 ms，仍不达标。

原 `observationReportWorker` 是独立 Bun isolate，父 daemon 对 logger 的文件配置不会传入。现有 performance observer 的默认 emitter 只调用该 isolate 的 `createLogger`；其默认 logFile 为 null。原 daemon 日志因而没有这次诊断，不能把缺少日志解释为阶段耗时为零。读取原用户终端的工具不可用，不为获取诊断去重启正常 `bun dev`。

有限修复只在原 Worker 收到 `kind=start` 且 refreshKey 以 `load-performance-` 开头时，使用其已有 appHome 设置原 `logs/daemon.log`。路径与原 daemon、既有 spool 的本机目录一致；不新增 IPC 或公开字段，不修改 Task、来源、页数、计费、完整人口或报告状态。日志初始化失败只丢弃诊断，仍执行原报告工作与原错误处理。普通报告及原 native-history Worker 不增加文件日志。

在既有双 provider 原 Worker 测试里保留所有旧 case/断言/预算，新增实际原 SQLite 与 max=1 PostgreSQL Worker 回归：普通报告不生成诊断文件；明确诊断报告保留真实原四桶、人民币、完整人口并写入与其 reportId 对应的原阶段和操作；日志目录不可创建仍完成真实报告。仅 hosted exact-SHA 执行测试，没有本机 AW 测试、typecheck、build 或尺度压测。独立有限实现门、原静态架构配套、精确发布与 CI 均另验，不能以这项日志修复代签性能达标。
