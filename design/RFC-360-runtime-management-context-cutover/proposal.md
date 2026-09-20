# RFC-360：Runtime Management 管理与选择合同归位

- 状态：Draft（2026-09-20）；尚未批准实施。
- 母 RFC：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W4-E4b，以及本域对应的 W4-B/D。
- 前置：[RFC-359](../RFC-359-database-provider-unification/proposal.md) Done、W4-A/C/E0 Done。
- 基线：`9ba159a7f3b1688806e54f374ab30e2aca1a4bff`。

## 1. 问题与目标

当前运行时注册表已经共用一套数据库实现，但管理路由仍负责 profile 校验、探测、配置读取和结果编排；执行侧仍引用
`services/runtimeRegistry`。后续修改容易再次让设置页、CLI、任务首次 dispatch 和恢复路径获得不同的运行时参数。

本 RFC 将 profile/admin/probe/model-list 的业务编排放入 Runtime Management application，HTTP 只做解码、调用、映射；
任务通过专用 runtime selection participant 在既有 NodeRun 冻结时点取得运行时配置。继续使用 RFC-359 的中立事务与单一持久化实现。

这是 RFC-294 下一步的首个实施候选。交付范围包括本域 public 合同、真实 provider、生产 consumer、transport 与装配收缩；
仅新增接口或移动文件不能关闭本 RFC。

## 2. 用户故事

1. 管理员编辑 runtime profile、启停运行时或探测自定义二进制后，设置页和后续任务使用同一套规则与结果。
2. 用户选择自定义运行时后，模型列表来自该运行时；既有名称解析、默认值与别名行为保持一致。
3. 已开始的 NodeRun 恢复时使用原 snapshot；后续新 NodeRun 按现有规则看到 profile/config 更新。
4. SQLite 与 PostgreSQL 部署对同一输入返回相同结果、状态码和错误码。

## 3. 范围与能力影响

本次不新增产品能力，也不关闭或收缩现有能力。保留自定义 binary、profile 全字段、探测 receipt、运行时选择、模型列表、
默认值和配置热读取。保留现有操作入口与校验结果。

以下工作保留原 owner：TaskExecution 的 observed inventory/provenance、进程生命周期与 driver 协议实现；ResourceCatalog 的
MCP runtime test 完整会话状态机（W4-E6）；Realtime 既有组合；全局 DaemonContainer/后台注册表（W9）。Runtime Management
只通过本 RFC 定义的窄合同协同这些能力，不借迁位重写其行为。

## 4. 验收标准

- AC-1：runtime 管理/查询入口调用 public command/query；route 不再导入 registry service、driver 或读取完整 config。
- AC-2：profile 写入、probe receipt 与有效性判据只有一份实现；两种数据库共用同一 application 和 persistence 算法。
- AC-3：runtime selection 在既有首次 dispatch 冻结边界接线；same-session resume 复用 snapshot，新 run 按既有规则读取当前 profile。
- AC-4：管理界面的 HTTP payload/status/code、CLI 结果、默认运行时与模型别名行为保持兼容。
- AC-5：已落热配置回归与运行时 profile/试跑失效原子性测试在真实 SQLite/PostgreSQL 上通过。
- AC-6：本 RFC 认领的 consumer/import/facade exact IDs 清零；明确属于其他 wave 的项按 owner 交接，不能按目录整桶记完成。
- AC-7：bootstrap 只构造并注入同一实例；本域 adapter 与 root 收缩同时完成，新增 public 合同均有真实生产 consumer。
- AC-8：最终提交的 GitHub Main CI 终态成功；涉及实际进程适配的改动另外取得对应平台托管证据。

## 5. 下一步

批准本三件套后按 [plan](./plan.md) T1→T8 实施。RFC-361 的独立合同工作不依赖本 RFC；RFC-362 与本 RFC
共享 TaskExecution composition 时须串行接线。任何新增配置、冻结时点变更或 driver 行为变更先返回设计审议。
