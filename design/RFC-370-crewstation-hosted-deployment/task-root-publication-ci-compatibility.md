# RFC-370 Task Root 发布参与者测试定位兼容

`68088e057a89ac406330569a7bca958280bd7427` 的主 CI `37536639407` 在 backend shard 9 的功能用例 `task auto-push keeps bootstrap provider discovery instead of dropping to URL rules` 失败。原 regex 要求 `createTaskExecutionRuntimeParticipants({`，真实两个 provider 已改为 `createTaskExecutionRuntimeParticipants(bindProviderTaskRunParticipantsInput(...))`，所以旧计数得到 undefined。

本次只更新该功能用例的一处源码定位 regex，继续要求两个 provider 均调用原中立参与者工厂和完整输入 binder，原 `toBe(2)`、其余功能断言、用例和预算保持。测试文件的其他内容逐字保留。生产输入 binder 与原参与者实现不变，原旧失败保留。

本机仅目标格式／lint与纯源码／字节核对，没有 AW test／typecheck／build、新 census 或服务启动。独立功能实现门与新 exact-SHA hosted CI 分别验收；本次不含 purpose 工作区重构，不关闭完整 H7、A-G 或 CS 部署。
