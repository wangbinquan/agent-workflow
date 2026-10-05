# RFC-370 Task 核心 CI 类型补正

Windows run 37383152628 / job 112009886282 对 bbbef9f05b57f3afd0ed1a48f5fc27db325f3db3 的 Typecheck 实际失败。本单元处理自有三个诊断：完整共同核心仍用原 RunFinalStatus 却漏了 type import；selected Task fixture 的两处 nodeRuns.values 错带 schema 中不存在的 agentName。

只补自己的原类型导入并删除两处不存在的 fixture 字段。完整类型/结果合同、生产执行函数全文、原测试断言和预算不变，保留上一提的正常分支声明。纯完整逆向 proof 在 /tmp/aw-rfc370-task-agent-ci-type-correction-inverse.json。独立有限功能门与修复提交 exact-SHA CI 分别验收，未运行本机 AW tests/typecheck/build/service。

同一日志中的三个 RFC-371 fixture 类型诊断归并行模块单独处理，不能用这三个自有修复宣告整个 Typecheck 或 CI 已绿。新工作区中的六处 Task 生产入口和完整 family 接线仍在开发，不纳入本次 CI 修复的提交或匹配人口。全部原共同核心功能证据继续有效；本单元不关闭 A-T5/A-G、CS 首部署或完整 RFC。
