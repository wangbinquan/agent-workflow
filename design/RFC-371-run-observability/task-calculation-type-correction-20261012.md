# RFC-371 持久计算配套的类型与查询形状修正

2026-10-12，RFC-372 会话在其获准的后端类型诊断中发现本批持久计算候选的七处位置错误。原诊断保留于 `/private/tmp/rfc372-backend-typecheck.log`；本会话没有因此运行本机 AW 测试、类型检查或构建，也不将先前有限 SOURCE 的通过解释为编译通过。

修正限四个路径。`ObservationSourceRevisionContract` 保持原 kind 与列名，只将来源集合的 TypeScript 声明由具体 55 元素元组改为 `readonly string[]`，与原 Zod 数组解析合同相容；实际 55 个来源、严格完整描述符比较、两套 SQL、迁移和触发器均不变。两个回归 matcher 展开只读数组作为等值预言，记录内容、顺序及全部断言保持。Worker 回归读取原计数表真实 `total` 字段，并将原数据库的空字符串根 parent 映射为 API 参数省略及结果中的 null；全部集合和各成员继续分页到 EOF。

原失败与修正候选分别保存。本修正须经过限定源码复核、必要原配套更新和正常精确提交，再由该 SHA 的完整 GitHub Actions 与默认 Windows 实际验证。外部诊断未执行本批新增回归；不能把这次静态修正写成测试或性能已通过。

原完整报告计时见 [批次修复后的测量](./report-stage-measurement-20261012.md)。热报告约 10.17 秒仍不达标，历史准备、关联索引、范围复用及重启指纹继续按 [已批准的持久计算设计](./persistent-calculation-cache-20261012.md) 实施；两个 RFC 保持进行中。
