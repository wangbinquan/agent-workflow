# N2 Node caller 接线后的 CI 源码断言修复

N2 源码提交 `cf50bc330dd0cb7d73095da26f8862dcb4db80ca` 的主流水线
`37885361029` 与 Windows 流水线 `37885361045` 暴露同一处测试接线过期。
macOS shard 7/12、Ubuntu shard 15/32 和 Windows 的完整作业日志都显示
`rfc371-invocation-wiring.test.ts` 的
`native model preparation uses final spawn env and local numeric retries avoid replaying stdout`
用例在 `expect(retries).toBe(1)` 处得到 `0`。

原断言只匹配 `opts.persistence.nodeExecution.appendEvents`。N2 已将实际调用接到
`selectTaskNodeExecutionWrites(opts.persistence, 'issuedResults').appendEvents`，
因此原计数器没有识别实际的观察数据修订批次。

修复使用 TypeScript AST 识别选择函数上的 `appendEvents` 调用，再明确要求选择函数只有
`opts.persistence` 与 `'issuedResults'` 两个参数。原有空 `events` 批次、
`opts.nodeRunId`、唯一 `observations` 简写属性、local authority 与 `unreaped`
条件、最终环境、normalizer 次数以及 `retries === 1` 断言全部保留；原测试预算不变。
其余用例和生产代码不改。

本批只做必要 CI 排障。局部格式、语法与原文件差异核对不代表运行用例通过；
发布后必须取得包含此修复的确切提交的主流水线与 Windows 全部成功，并核对原失败用例
及新 Node caller 用例的实际作业结果，再继续 RFC 实现。

当前状态：实现检视与新确切提交的完整 CI 待验收。完整 H7、A-G 和 CS 部署尚未完成。
