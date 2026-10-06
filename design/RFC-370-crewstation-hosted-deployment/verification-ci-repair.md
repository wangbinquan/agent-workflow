# 验证命令家族 CI 配套修复

`e6764009d86f7c14db25c2fd7059b9e73071ec10` 的主 CI `37460301719` 中，功能作业 `112257911350` 在新测试五处 `.value` 访问报 TS2339：`FactCell` 还包含没有 value 的分支。只为这五处添加擦除型 `Extract<FactCell<FactCellValue>, { readonly state: 'known' }>` 投影；完整原断言、预期值、实际持久结果和等待预算不变，不以替代 fixture 绕开真实数据库。

同提交的 Windows `37460301674` 已 completed/failure。作业 `112257925844` 的唯一失败是旧 MCP 完整根守卫在验证装配逆向时把 SQLite 的真实 callee `composeSqliteAppDeps` 写成 `composeSqliteApplicationDeps`。只更正该一个字面量；原三个完整函数摘要、所有其它判据和预算保持，既不删除守卫也不接受任意 callee。维护压力 CI `37460301589` 已 completed/success。主 CI 还在执行；另一个 Static scans failure 仅保留状态，没有读取、分析或修改该作业。

本片没有生产源码或原 census 规则变更；复用 e676 已生成的13份 matching 清单，不重复 census，不提前退役其增长声明。两份测试可逆恢复完整旧 AST。仅自有 format/lint 和纯 AST／字节核对，本机不运行 AW tests/typecheck/build/service；独立有限实现门、精确发布及后继 exact-SHA hosted CI 分别留证。Doctor 候选和所有并行工作完整保留，不随此片提交。阶段 A、A-G、CS adapters、M0 首次部署与 M1～M4仍未完成。
