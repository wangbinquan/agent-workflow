# A-T5：runtime smoke 共同核心

沿用已批准的 [实际入口接线设计](./agent-invocation-factory.md)。本增量提取整个既有 smoke 行为，并提供消费选中 preparation 的正常入口；不是完整 Agent 单元、真根贯穿或 A-G 完成证据。

`task-execution/application/runtimeSmoke.ts` 保留原 nonce 提示词、逐行协议解析、session reset 判据、输出预算、错误分类顺序和现场释放规则。`services/runtimeSmoke.ts` 保留现有三份公开合同及原 `buildSmokePlan`，只装配原生 workspace／driver／完整材料，并委托这个共同核心。原生入口、选中入口没有各自的 stream／timer／classify 算法。

`composition/runtimeSmoke.ts` 的 `runPreparedRuntimeSmoke` 要求调用者提供选中的 preparation 和 runtime binding。它提交一次完整材料 intent：原 persona、提示词、有序 profile、workspace／run-content／runtime 引用和原 extraArgs；不读取全局 driver、Paths 或物理目录。compiled handle 只在原位置 bind，一次执行使用该编译的 material 身份。

保留原失败边界：workspace prepare 在材料 catch 外；材料失败释放同一 workspace；late bind 失败仍在该 catch 外。ownerless effect 使用原 timeout 和 TERM grace，不新增持久 Task receipt。spawn failure 按原分支释放，unreaped 或 cleanup-failed 保留现场；正常分类完成后才释放。nonce、session／reset 完整性和协议事件共同决定 conforms，已有网络、登录和模型调用分类保持原先后关系。

新增实际选中入口回归包含双协议、完整 intent 与引用身份、一次编译／绑定、workspace／compiler／binding 错误边界、unreaped／cleanup-failed 保留、释放失败原错误、缺省 profile／空 extraArgs 省略、model 缺省时才追加原默认模型诊断、缺 nonce、网络分类顺序及未完成 session reset。原原生子进程用例仍使用现有入口及预算；它们和新用例的正式执行均交给确切 SHA 的 GitHub CI。本机只做目标 format／lint 与纯 AST 对拍。

结构对拍从实际共同核心反向还原原完整业务函数，保留字面量、操作符、声明 flags 和 type-only 事实；同时核对原生前置读取顺序、完整绑定、完整 `buildSmokePlan`、三份公开合同及原分类常量。只迁移源码位置的原读取用例和 Windows 登记随本增量同步，不删除原功能断言或改预算。

RM management、全部启动根、Task／System 正常 purpose、retention reader、脚本／专用 command、authority／恢复仍按原接线设计逐项推进。`runtimeDiagnosticTestDependencies.smokeRuntime` 继续是显式 fixture；生产选中 capability 使用独立字段，不能用 fixture 的存在性语义冒充正常接线。当前没有 CS 生产 adapter 或 AW-in-CS 部署。
