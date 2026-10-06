# RFC-370 Task Root 测试类型兼容修复

`68088e057a89ac406330569a7bca958280bd7427` 的 Windows run `37536639348` 的平台功能套件（step 6）已成功，随后 Typecheck（step 15）失败。原失败保留；前轮 root selection 功能通过不能替代本轮类型门。

本次仅修三份测试：用 `Object.freeze<NodeRunPromptOperations>` 恢复 fixture 的上下文类型；receiver 比较加仅编译期的非空声明；刻意不完整的负向 profile fixture 通过 `unknown` 明确表达原不完整运行时值。原用例、断言、预算和运行时函数正文保持。

子任务选项的完整 disposition 清单新增 `workspaceExcludeProfiles: dropped-registered`，同一字段登记到原精确快照。它由每个子任务的 runtime composition 重新绑定，原继承项、去除项及字段处理算法不变。当前真实子任务 profile 回归继续验证这一接线。

本次不改生产代码，不生成新源码 census，不运行本机 AW test／typecheck／build。目标格式／lint、纯 AST／字节核对、独立功能实现门与新 exact-SHA CI 分别记录。九操作／staging 的工作区实现不纳入本次提交，完整 H7、A-G 与 CS adapters／M0～M4 继续开放。
