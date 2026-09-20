# RFC-363：Task / Source Control 启动与工作区生产切换

- 状态：Done（2026-09-20；最终托管验收通过，证据见 [acceptance.md](./acceptance.md)）。
- 母项：RFC-294 W4-E1 启动纵切、关联 B/D；W5 最小生产接缝，不关闭完整 W5。
- 前置：RFC-359 数据库共用实现、RFC-360 runtime selection、RFC-362 启动合同准备均 Done。
- 设计基线：`cae3e4ea2579bc1d13ff34008fa011d4073d8b59`；文件指纹见 [source-baseline.json](./source-baseline.json)。

## 1. 要解决的问题

RFC-362 已声明 SC offered / Task required 合同，但生产入口仍调用旧 materializer；测试里的 source/receipt Map 不能跨进程恢复，仓库组冻结、repository revision 和 reader 分页仍有明确缺口。仅增加 provider 包装不能算生产切换。

本 RFC 让任务启动、准备、重试及工作区读取实际消费这些合同。Task 保留唯一启动事务、任务状态和执行 ownership；SC 拥有仓库事实、物化和工作区物理结果。复用现有共用算法，不再按 SQLite/PostgreSQL 拆两套。

## 2. 用户行为与能力影响

| 场景                                                         | 必须保持的行为                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 普通仓库启动                                                 | 当前允许延期的入口继续展示 `__repo_prep__`，由 normal task execution 推进          |
| multipart / sourceTaskId / scratch / direct Agent、Workgroup | 保留当前入口各自的同步准备顺序；multipart 文件应用成功后才创建 Task                |
| call / fusion / DE host                                      | 保持父子关系、来源、内部目录归属、原有准备时机和失败补偿                           |
| 取消、进程重启、手动重试                                     | 保留原错误、终态和重试入口；持久化记录不能导致第二个 Task 或新的后台执行器         |
| 文件页                                                       | HTTP 字段、排序、截断、超大文件和 UTF-8 展示不变；新内部 reader 不新增下载产品能力 |

无计划关闭或收缩既有能力。原 URL、路径、资源可用性等判据原样保留；本项不开展安全规则改造。Git ref 首次解析时机不提前到 admission，不把未解析分支伪称已冻结 commit。

## 3. 范围与完成口径

承担源快照与准备记录持久化、两条 launch lane 的生产接入、Task-owned 上传准备 journal、工作区 reader 和该纵切的 adapter/root 收缩。保留旧任务恢复读路径，采用 additive schema。

不承担仓库管理全部 CRUD/cache refresh、全局 Git SCC、所有 task query/catalog、AtomicApply、NodeRun v2、Reaction、DaemonContainer。完整 E1 还须逐项核对 RFC-294 的 provenance/detail link/remaining consumer 退出项；本项不得凭启动路径完成倒签整波。

## 4. 验收标准

- AC-1：逐入口字段账、取消/重试/恢复 oracle 与旧实现对拍，覆盖 RFC-362 的 54 个 writer 字段；`launch_origin`、source termination、catalog visibility 和 runtime 首次冻结无漂移。
- AC-2：sealed/frozen source、group layout、operation/receipt 和上传 artifact 均有真实持久化与跨进程恢复判据；repository revision 不依赖 `lastFetchedAt`。
- AC-3：Task admission 与 SC snapshot 使用同一 live `DatabaseSessionTx`；Git/FS/process 全在事务外；SQLite/PostgreSQL 均验证回滚和并发重放。
- AC-4：repository-preparation 与 pre-materialized 两条 lane 编译和运行时互斥，取消/超时不产生第二个 Task/NodeRun writer 或独立 worker。
- AC-5：四个 SC offered seam 与 TaskWorkspaceReadPort 有真实 provider/consumer/root 接线；声明债只按实际生产 liveness 出账，旧 owned fallback/import/facade 清零。
- AC-6：reader 正确处理超出旧列表上限的分页、非 ASCII/二进制字节、文件消失和工作区回收；既有 HTTP wire 完全保持。
- AC-7：新旧任务并存、崩溃窗口、回滚版本下限与清理均有证据；完整 E1/W5 未关闭项逐条转交 owner。
- AC-8：最终源码 SHA 的 Main CI 终态成功；涉及 Windows Git/process 行为时补同源码原生 Windows 证据，不拿祖先或类型检查代替。

## 5. 下一步

T1–T8 已验收。启动与工作区纵切结束；按 [剩余转交](./acceptance.md#剩余-e1w5-逐项转交) 继续处理完整 E1/W5，不据本项完成关闭母 RFC。
