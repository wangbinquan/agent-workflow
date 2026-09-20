# RFC-361：Execution Contract provider 归位（W4-E9 第一刀）

- 状态：In Progress（2026-09-20 用户批准实施并提交远端）。
- 母 RFC：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W4-E9。
- 前置：W4-C/E0 与 [RFC-359](../RFC-359-database-provider-unification/proposal.md) 已完成。
- 基线：`9ba159a7f3b1688806e54f374ab30e2aca1a4bff`。

## 1. 背景与选择

Execution Contract 已有 consumer-owned resource/fixture ports，Digital Employee 也已强制注入统一 participant。
但 EC 的 `infrastructure/taskExecutionAdapter.ts` 仍直接读取 Agent/Workflow 表并导入旧 agent/workflow/scriptRun service。
这让契约校验同时拥有资源读取、工作流兼容与脚本执行机制。

本 RFC 把这条可独立交付的调用链先闭合：ResourceCatalog 提供 Agent/Workflow contract projection；TaskExecution 提供真实
Script fixture provider；EC 只负责 guide、compatibility、validation receipt 与 exact-output 判定。
这是 E9 的第一刀，可以在 Runtime Management 之外独立实施。

## 2. 用户故事与能力影响

用户保存数字员工工具或类型包时，Agent/Workflow/Script 继续得到同样的兼容性检查、真实 fixture 执行结果与错误详情。
已保存的 guide/ref、receipt 和历史工具仍可读取。Workflow schema v6 的边所声明输出继续可识别；旧版本定义仍先按现有规则归一。

本次没有新增、关闭或收缩产品能力；不新增 schema、路由、执行器种类或配置。现有 callback 型 output validator 是需要迁位的
实际功能：收进 EC 本域判定，不能在移除跨域 callback 时顺手省略验证。

## 3. 范围边界

本次完成 EC 两个 provider 的所有权、接线、旧 adapter 删除与 exact debt 对账。
Digital Employee Reaction claim/admission V1、Event Center 两种 target launch port、DE/Event HTTP public cutover、
observer 的 W9 registry 接线仍需后续独立 RFC。它们的顺序见 [plan](./plan.md)，不因本 RFC Done 而关闭整个 E9。

## 4. 验收标准

- AC-1：EC application 只依赖本域 required ports；Agent/Workflow 数据投影由 RC provider 提供，Script fixture 由 TE provider 提供。
- AC-2：EC 不再依赖 legacy agent/workflow/scriptRun service，也不直接读取其资源表；provider 无 EC→TE→EC 生产 value 环。
- AC-3：相同 guide/implementation/input 产生相同 compatibility checks、receipt 与 exact-output 结果；用户可见 wire 不变。
- AC-4：两种数据库共用同一资源投影算法；真实 Script fixture 成功、失败、超时、输出错误与清理流程有托管证据。
- AC-5：DE authoring/runtime/reaction 共用原唯一 ExecutionContractParticipant；bootstrap 只装配，不添加类型分支。
- AC-6：manifest/public entrypoint 与所有 external import 对拍；本批 IDs 消除，E9 其余债明确保留。
- AC-7：最终 exact-SHA Main CI 成功；本 RFC、母 RFC 与 STATE/index 的范围表述一致。
