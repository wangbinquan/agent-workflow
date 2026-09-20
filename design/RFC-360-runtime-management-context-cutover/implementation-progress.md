# RFC-360 当前实现与接续账

本文件记录第四批候选内容。第三批发布 SHA 为 `a5e70f94d9d12d40e0b9700ff9037d5deb6092e3`；
最终验收仍须本候选提交后的 exact-SHA CI，不能沿用前一个文档基线的绿。

## 字段与不变量

| 字段组   | 当前完整形状与保持的行为                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份     | `id/name/protocol`；name/protocol 更新不可变；built-in 为普通可编辑/可删除记录，只有空表时播种                                                                  |
| 执行画像 | `model/variant/temperature/steps/maxSteps/isSandbox/extraArgs`；nullable 参数与缺省参数的区别保留；额外参数仍用 `extraArgsJson` 存储                            |
| 路径     | `binaryPath/configDirEnv/configDirName`；NULL 继承协议/当前配置，原 trim、空值和平台路径语义不变                                                                |
| 状态     | `enabled`；默认 runtime 不可停用；停用记录继续出现在管理列表、退出状态列表                                                                                      |
| 探测     | `lastProbeJson/probeFence`；row id、防重建、profile fingerprint、有效二进制与 config fence 保持原 CAS 判据                                                      |
| 审计     | `createdBy/createdAt/updatedAt`；公开 DTO 继续保留既有时间字段，存储 row 不成为新的公共读取协议                                                                 |
| 引用     | `defaultRuntime/memoryDistillRuntime/commitPushRuntime/mergeAgentRuntime/intentBuilderRuntime/changeNarrativeRuntime` 与全部 Agent 引用，删除前仍在同事务判断   |
| 选择     | `agent.runtime → defaultRuntime → opencode`，未知名 fallback、internal-agent 旧 model 兼容保留；NodeRun 首次冻结与同会话继承已接同事务 participant，等待最终 CI |

管理路由仍为既有九项：`GET /api/runtime/models`；`GET /api/runtimes`、`GET /api/runtimes/status`；
`POST /api/runtimes/probe`、`POST /api/runtimes`、`PUT /api/runtimes/:name`、
`POST /api/runtimes/:name/enabled`、`DELETE /api/runtimes/:name`、`POST /api/runtimes/:name/probe`。
所有 route descriptor、成功响应与原错误映射继续由现有 HTTP 用例锁定。

## 单一实现与事务

- `modules/runtime-management/application/runtimeRegistry.ts` 是唯一 registry 用例算法；composition 注入
  `RuntimeRegistryEffects`，application 不再导入 driver service 或自行读配置文件。
- `domain/runtimeProfile.ts` 保留 profile/receipt 的纯判据；平台路径正规化位于 `application/runtimeBinary.ts`。
- `infrastructure/runtimeRegistryPersistence.ts` 是唯一持久化实现，保留 update/inherited 的普通事务与
  enable/delete/seed 的 serializable 事务。
- `RuntimeProfileTestInvalidationInTx.invalidate` 在原事务内调用 RC 原会话 transition；原 MCP 协调器仍在提交后执行进程清理。
- `RuntimeProfileUsageReader.inspect` 在原事务内查询 Agent 名称，错误中的引用名称不变。
- inherited 更新直接把本次更新的 runtime 名单交给 RC；RC 不再反向查询 runtimes 表。

`rfc360-runtime-profile-participants.test.ts` 使用两个真实数据库，先执行真实会话写入，再故障注入；
要求 profile 与会话整行恢复。另一条在外层事务插入 Agent 后删除 runtime，要求同事务引用检查能看见该未提交行。
现有 registry/route/freeze/hot-config 测试保持；源码守卫随真实归属迁位，规则不放宽。

## 第三批：执行冻结同事务 participant（待托管验证）

`RuntimeSelectionParticipantInTx.freeze` 已由 Task composition 消费；capability 由 Task 在 live transaction 内铸造，
与本次 NodeRun、owner fence 和事务生命周期绑定。RM 从该事务读取唯一 profile，返回无 profile/path 字段的 opaque ref；
组合 adapter 将它投影到现有 NodeRun 三列快照，不新增 schema 或第二个 mint。既有 binary fallback、configDir、extraArgs、
未知协议恢复和 same-session 继承口径保留。dependent agent 的 live profile 查询未改为 task-wide freeze。

首次 dispatch 先执行现有 owner 围栏，再按 provider capability 锁 NodeRun 行，重读快照后决定是否选择，防止并发首次写互相覆盖。
已冻结行仍直接读快照，不因本次迁位新增 owner 拒绝。测试补充同事务未提交 profile 可见、真实写后回滚、并发首次选择和能力到期；
继续保留原 runtime-freeze、binary-freeze、CFG45 17 项热读取与双库适配器用例。

本批仍不关闭 T6：management registry aggregate 的其他 consumer、重复根构造和 legacy 转发入口待统一收缩。

## 第四批：消费面与启动根收缩（待托管验证）

- HTTP adapter 归入 `runtime-management/infrastructure/http`；配置路由调用 public configuration command，默认运行时停用判据归 RM application。
- 执行读取、MCP 检查与 profile DTO 切换至分组 public 合同；PG provider 复用 core registry，两个 provider 不再重建第二份 registry。
- 七个初始 owned 路径与临时 `runtimeRegistryCompatibility.ts` 均删除；旧导出只在测试 helper 中绑定真实 application，没有第二份业务实现。
- 首次派发所需 `nodeRunRuntime` 从通用 Task persistence 中移出，由 server / SQLite CLI / PostgreSQL CLI 根显式组合并注入。Task adapter 只消费 RM offered participant，不再 import RM internal composition。
- 两个零生产调用的 DB convenience wrappers 移至测试 helper，生产继续走 `resolveFrozenRuntimeWith` / `frozenRuntimeOfSessionWith` 的同一算法。
- 第三批 CI `35487858387` 暴露的 PostgreSQL 未提交快照读取改为明确使用事务句柄；快照必须已写入且外层失败后完整回滚，断言未削弱。
- composition 的未知 snapshot reference 使用独立错误名，避免把动态无效引用与依赖未装配混淆；未修改 placeholder / cross-context guard 的排除规则。

## 仍待完成

本批 source/ledger 对拍为候选证据，不能替代最终 exact-SHA CI。只有本批行为用例、完整 Main CI 与必要平台用例均成功，
才关闭 T7/T8、RFC-360 与母 RFC 的 E4b/B/D 本域条目。RFC-361/362 是独立的已批准范围，仍待实施。
