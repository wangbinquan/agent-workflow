# RFC-362：Task / Source Control 启动合同准备

- 状态：Draft（2026-09-20）；尚未批准实施。
- 母 RFC：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W4-E1 / W5 前置。
- 前置：W2、W4-C/E0 与 [RFC-359](../RFC-359-database-provider-unification/proposal.md) 已完成。
- 基线：`9ba159a7f3b1688806e54f374ab30e2aca1a4bff`。

## 1. 问题与目标

RFC-359 已统一 JSON/multipart、Agent/Workflow/Workgroup 的 task launch 实现及 TaskRouteOperations。
因此 E1 不再需要等待两套数据库启动链合一；下一阻塞是 Task 与 Source Control 的目的明确、可验证的启动与工作区合同。

当前仍有 legacy task helpers、scheduler assembly 和 source-control workspace/path binder。直接再做一次“大启动链迁移”会
混合资源解析、准备、恢复和 transport 改造，难以证明保留 RFC-287 的准备行为。

本 RFC 先完成**合同准备与行为 oracle**：为 E1 定义 SC offered seam、Task consumer adapter 与精确字段/恢复矩阵，
在测试装配中复用现有唯一实现验证合同。生产 writer、admission 时序、schema 和启动入口保持现状；完整生产 cutover 另立后继 RFC。

## 2. 用户故事与能力影响

使用仓库启动任务时，用户继续看到当前 `__repo_prep__` 状态、重试和取消结果；上传文件等预物化入口仍在准备完成后才建 task。
重启、取消与手动重试保留源来源、工作区处理和父子任务关系。合同准备不改变任何用户可见行为。

不新增、关闭或收缩产品能力；不在本 RFC 引入 source-fact + durable-intent 新 admission、全任务 runtime 冻结、
NodeRun v2 identity、新的 scheduler 或 SourceControl repository/cache 的整体迁位。

## 3. 验收标准

- AC-1：以当前源码列出所有启动入口、准备 lane、owned writer、recovery/cancel、字段与错误 wire，不复用 RFC-359 前的旧调用图。
- AC-2：SC offered 与 Task required 合同职责分离；跨域只传具名 refs/receipts；每个合同有明确的生产接入计划和测试 provider。
- AC-3：同一 `DatabaseSession` transaction 内解析 launch snapshot；Git/FS/process 仅在事务外执行，事务回滚用真实双库验证。
- AC-4：repository-preparation 与 pre-materialized lane 分开，现有 `__repo_prep__`、upload、retry/cancel/recovery oracle 全部保留。
- AC-5：contract 级测试通过，新增 declared-only public 项显式登记为 E1/W5 待切债务，不伪造 production liveness。
- AC-6：给出后继生产 cutover 的确切入口、文件归属、依赖、回滚及验收清单；本 RFC 完成不领取 W4-E1/W4-B/D 或 W5 完成信用。
- AC-7：最终 exact-SHA Main CI 成功；文档与 canonical declared-only 账一致，无新增运行时旁路。
