# 观测快照回归的 CI 类型修复（2026-10-11）

`6c7e42c76bd3049782d228ee2f3f250b7df7d136` 的 Windows run `38124323037` 在 Typecheck 失败。观测回归 `rfc371-report-snapshot-file.test.ts` 的两个 `ReportWorkspace.get<T>` 调用没有指定文档类型，导致 Bun `expect(...).toEqual(...)` 的重载将期望值推导为 `undefined`（TS2769）。

给这两个原调用补 `typeof a` 泛型实参。该实参编译后擦除，原 SQL、25 次其他查询预热、全部文档、缓存准备与执行计数、重复插入失败、事务和清理断言均保留。没有运行时代码、统计口径或人口变化；不生成架构摘要新候选。

同一失败步骤还包含 RFC-370 的两处类型错误，其负责人已在 `02e39fee3` 独立修复；本修复保留该提交。旧 run 的 failure 保留，后续包含本修复的准确 SHA 必须单独等待正式 CI 终态。AW 继续按仓库要求只使用 hosted CI，不运行本地 Bun 测试或类型检查。

同一原测试增加准备语句回归后，两个 `new Database` 表达式触发 W5-T19f 的原单引擎构造人口守卫。将两次建库统一调用同一 `openOriginalReportDatabase(filename)` 原构造夹具；每个用例仍独立创建并关闭原路径上的实际 SQLite 文件，两次实际建库及全部原 SQL、断言、预算保持。原守卫、账本、配额与产品构造点均不改。有限实现门与新准确 SHA 的 CI 分别核对，不把未完成流水线记绿。
