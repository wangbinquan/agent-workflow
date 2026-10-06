# Task family 的确切提交 CI 修复

1538a56d9664b5658388c662db6a340d24dbaab6 的主 CI `37395936688` 和 Windows CI `37395936423` 暴露了 Task family 迁移后的断言地址和新 fixture 问题。它们不作为 A-G 或部署验收通过的证据。后继提交须取得自己的完整 hosted CI 结果。

本片修复 scheduler 对 Task 内部 composition 的导入：从已有 public commands 出口消费完整 family 的执行函数。原 RFC-339 禁止内部导入的断言不改。System family 的在制源码与其他会话的观测实现不在本片提交范围。

首个有效 scoped census 在 canonical validation 处失败，未写出任何配套产物。新增函数的直接 re-export 将完整内部 Task policy 和 family 递归带入 public surface，产生 `$depth-limit`、`extends:Omit` 与 `extends:Readonly`，与原 opaque 清单不符。失败记录保留；本片沿同一文件已有 `parkPreparedHumanGate` 的临时 legacy command 形式导出原函数值，保留原函数 identity、完整参数类型及执行行为，不增加 opaque 许可、不修改生成器。最终窄 command 合同由 A-T7 收敛；这条临时 seam 不能算 A-T7 完成。

原配置冻结读取断言改指实际 native family 装配点；六个调用的 policy 对象从第二实参读取，六次调用和 frozen identity/accounting 断言保持。三个 node 调用继续检查完整 family，并沿实际 native 装配检查 appHome 与 prompt operations 的共同绑定及 purpose 的透传。原 PostgreSQL、SQLite 整体装配 hash 与语句数保持，通过精确 AST inverse 去掉新增的 `taskAgentRunsFor: composeLocalTaskAgentRunFamilyFor` 装配字段。

继承面仅补登记不可序列化的 `taskAgentRuns` dropped 字段。两个架构清单分别登记三个已存在的 offered 引用和五个 native composition 地址，点名 A-T7 清偿；分类器、DAG、原集合相等断言与其他存量行保持。不能把漏登记解释成边已收敛，也不能修改计数掩盖实际变化。

真实双 provider drive 的新 fixture 在直接调用 driver 时显式传入两个原有零重试预算。工厂上的配置不会替代这次直接 drive 的实参；之前缺省的 followup/restart 预算实际产生了八次 attempt。单次选择、scope、compile、isolation create、failed 行和任务失败断言保持，不修改生产重试行为。

自定义 runtime fixture 的名称遵守原有小写与长度约束。配置拒绝 fixture 在触发拒绝前先安装 promise handler，再按原对象 identity 断言拒绝原因；数据库冻结字段与等待期间未 settlement 的断言保持，原超时预算不增。

后续已结束 job 的日志还暴露了类型和机械读取地址问题。本片为两个 `Object.freeze` 补上原合同的 contextual generic，Source Control 从已存在的 `AgentMaterialIntent['workspace']` 取得同一引用类型，两条 plugin identity 断言只补已存在元素的非空类型声明。原 wrapper undo 前置顺序与 commit/merge scope signal 断言分别迁移到真实多参数调用位置。内部 profile 的 observation identity 检查沿实际 `runtimeBindings.resolve(..., rt)` 与 native getter 继续检查同一 profile 的透传，不重复读取档案或修改生产归属。

Windows 原 run 已正式 cancelled，未取得通过结论。主 CI 的 macOS shard 1 还记录了既有 SC conflict fixture 的 120000ms 超时；该项仍需确切 CI 证据与原因定位，本片不会增加预算或将其宣称已解决。

本机只做自有文件格式、lint 和纯 AST/字节证明；不运行 AW 测试、typecheck、build 或服务。冻结源码经有限独立功能检视后，只按该候选执行一次原始 census，生成配套产物并检视。失败回执保留，不用在制 System 或其他会话的源码生成架构快照。
