# Task 公有入口回归守卫登记

2026-10-06，b386d3108 的确切 CI 报告 `rfc371-native-participant-boundary.test.ts`
已存在但不在 `architecture/guard-manifest.json`。原 canonical writer 对此补充清单
只更新生产源码投影，不自动加入新守卫。此前 META14 已同步源码投影，却漏补这条登记。

本次按原 `census.ts` 的单文件纯解析结果补一条：断言旧私有 import 不存在，
不属于全语料扫描器，没有负 fixture。原213条保留为同一序列，完整清单变为214条。
守卫本身、原判据、正反断言和门槛均不改。

119b59c78 已消费的4条一次性增长登记同时退役。129项库存的顺序、基线和why
完全保持，生产源码投影沿用既有官方采数，不执行本地测试或完整AST重扫。
现有清单与实际文件逐条核对的 CI 会验证补登结果；不是 producer、CS v2、规模
或两RFC完整交付的完成声明。
