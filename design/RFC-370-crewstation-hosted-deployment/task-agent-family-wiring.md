# RFC-370 Task 执行族与生产入口接线

承接已批准的完整 Task 共同核心及 SOURCE-R2。这个单元完成真实消费者接线，仍属于阶段 A，不包含 CS 生产 adapter。旧 native API 保留自己的显式 compatibility 入口；正常 Task 使用完整选中的 family，不按成员回退到 native。

## 实际入口与选择位置

完整源码普查共有六处 Task `runNode` 调用：`composition/nodeMechanics.ts` 的 workgroup host、merge resolver、普通 agent node；`composition/wrapperMechanics.ts` 的 shard、aggregator；`services/scheduler.ts` 的 commit-message/repair agent。此前“五处”只统计了前两文件，遗漏第六处；所有六处和同一算法的重试、恢复、工作组调用都必须迁移，不能按旧清单给完成结论。

Task bootstrap 选择一个完整 `TaskAgentRunFamily`，provider runtime 在每次 drive（包括 child）绑定该 family。`BoundRunTaskOptions` 必选，不把 family 序列化进 child 配置。SQLite、PG、start、provider 重装及现直接 fixture 的组合路径显式选择；正常调用层不调用 native compatibility，也不在缺成员时从 `Paths`、registry 或 process 重建。旧直接测试入口可以明确选择完整 local family，不让测试命令字段代替生产选择。

family 为一次调用打开 `TaskAgentRunPurpose`，接收 task/nodeRun 身份、Source Control 工作区和 mount 引用、Runtime Management 冻结运行绑定以及 Resource Catalog 的有序内容引用。原 Task 业务 policy 仍完整传递。正常调用不再传 appHome、worktreePath、skills 的物理 sourcePath、plugin locator、binaryOverride、runtimeBinary、prompt/archive native factory；这些字段仅属于所选 local adapter 或旧 compatibility API。原业务 template 值、Agent/依赖/MCP 声明、profile/config 可选性、观测、timeout/cancel/retry/clarify/output 规则保持。

## 内容与材料 owner

Resource Catalog 将已授权冻结 snapshot 转成 `AgentMaterialSkill`/`AgentMaterialPlugin` 内容引用，保留原资源顺序、name、version、options、enabled、project/managed 区分及原失败位置；Task 应用只保存这些声明和引用。local adapter 私有解释原技能目录、plugin runtimeSpecifier 和 reader，不能把原 path/read 函数塞入正常业务 policy。旧 resolver 的兼容入口和原测试继续保留原 native 形状；正常 per-task cache 使用新的必选引用投影能力，保持首次授权读取后的不可变快照。

Source Control 解释 working/mount 引用，Task-owned内容能力负责 prompt、artifact、输出读取；Runtime Management 解释冻结 runtime 绑定和 run-content 引用。local material compiler 得到这三个 owner 的完整 native content receiver，一次 `compile(intent)` 调用原实际 `buildOpencodeNativeMaterial` 或 `buildClaudeNativeMaterial`，绝不先调用 legacy `driver.buildSpawn` 再编译一次。protocol/evidence/execute/content 全部取自同一选中族，材料的 raw plan 留在 local composition 内。

family/purpose 的构造不进行 IO、材料编译或提前调用 runtime lookup。core 继续先等待原 envelope nonce，再在原 selectMaterial 位置选择该 protocol 的 local definition；mount 读取/计算仍在原材料 try 外，保持原错误身份；完整资源读取/compile 仍在原 catch 内。原 invocation late bind、命令/env snapshot、late evidence、diagnostic 和 cleanup receiver、必选 task-effect participant、durable receipt-before-activation 顺序保持。输出校验与归档使用同一 purpose 的不透明工作区引用。

内置 merge/commit Agent 继续执行原 synthetic resolver：显式零资源，新增管理资源声明仍按原错误拒绝，不能为接线改成隐式 catalog 读取。workgroup host 保持原输出投影，fanout 保持 shard/aggregate 隔离、并发、失败和 join 语义，普通节点保留 session/clarify/retry。

## 实施与验证

先交付 owner 内容引用投影及 local 完整 family，再一次接通六处消费者和所有正常组合根。任何尚未迁完的调用者明确保持开放，不将未消费的 factory 记为完整切面。必要时按可发布内容分批，保持共同核心唯一算法、所有既有能力和 compatibility 出口。

原功能/源码锁跟随实际实现地址，原 assertions、classifier、严格等式和预算不变；新 normal/local 用例覆盖六种实际入口、双 runtime/双 provider、完整引用及有序 profiles、一次 compile/bind、nonce 后选择、独立 mount/compile 错误位置、receipt/activation、取消/恢复、validation/archive 同引用及内置零资源。根级替换用例应证明真实 Task drive 消费选中 family，不能仅 mock 未消费函数。测试由 hosted exact-SHA CI 执行，本机只做 scoped format/lint 和有限纯字节/AST证明。

实现门及匹配登记完成后继续 System/smoke/retention/RC-MCP/脚本/authority 尚未闭合的真实根，再做 A-G；A-G 前不开始 B 生产 adapter。CS M0 首次部署、M1～M4和完整 RFC 验收仍然开放。
