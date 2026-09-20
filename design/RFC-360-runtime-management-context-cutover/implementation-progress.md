# RFC-360 当前实现与接续账

本文件记录第二批候选内容。第一批发布 SHA 为 `09f35c78561a706f8a44585ce108785b8fb34c27`；
最终验收仍须本候选提交后的 exact-SHA CI，不能沿用前一个文档基线的绿。

## 字段与不变量

| 字段组   | 当前完整形状与保持的行为                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份     | `id/name/protocol`；name/protocol 更新不可变；built-in 为普通可编辑/可删除记录，只有空表时播种                                                                |
| 执行画像 | `model/variant/temperature/steps/maxSteps/isSandbox/extraArgs`；nullable 参数与缺省参数的区别保留；额外参数仍用 `extraArgsJson` 存储                          |
| 路径     | `binaryPath/configDirEnv/configDirName`；NULL 继承协议/当前配置，原 trim、空值和平台路径语义不变                                                              |
| 状态     | `enabled`；默认 runtime 不可停用；停用记录继续出现在管理列表、退出状态列表                                                                                    |
| 探测     | `lastProbeJson/probeFence`；row id、防重建、profile fingerprint、有效二进制与 config fence 保持原 CAS 判据                                                    |
| 审计     | `createdBy/createdAt/updatedAt`；公开 DTO 继续保留既有时间字段，存储 row 不成为新的公共读取协议                                                               |
| 引用     | `defaultRuntime/memoryDistillRuntime/commitPushRuntime/mergeAgentRuntime/intentBuilderRuntime/changeNarrativeRuntime` 与全部 Agent 引用，删除前仍在同事务判断 |
| 选择     | `agent.runtime → defaultRuntime → opencode`，未知名 fallback、internal-agent 旧 model 兼容保留；NodeRun 首次冻结与同会话继承尚待 T5 切换                      |

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
- `RuntimeProfileUsageParticipantInTx.inspect` 在原事务内查询 Agent 名称，错误中的引用名称不变。
- inherited 更新直接把本次更新的 runtime 名单交给 RC；RC 不再反向查询 runtimes 表。

`rfc360-runtime-profile-participants.test.ts` 使用两个真实数据库，先执行真实会话写入，再故障注入；
要求 profile 与会话整行恢复。另一条在外层事务插入 Agent 后删除 runtime，要求同事务引用检查能看见该未提交行。
现有 registry/route/freeze/hot-config 测试保持；源码守卫随真实归属迁位，规则不放宽。

## 尚未完成

1. T5：TaskExecution 首次派发/恢复经 RM offered selection participant 在同一事务程序冻结，保留唯一 mint 与 17 项热配置。
2. T6：逐调用点切 grouped public contracts，删除 `services/runtimeRegistry.ts` 和 `platform/runtime-registry/**` 短期转发，
   收口 production bootstrap 唯一实例。八条临时 R1 边均属于本任务的兼容转发，不是交给其他 RFC 的永久债。
3. 完整 source→ledger / ledger→source 对拍、最终托管行为验收和 RFC-294 E4b/B/D 关闭，须等以上调用链实际完成。
4. RFC-361 的资源与 Script fixture provider、RFC-362 的 Task/SC 合同验证仍是独立的已批准工作，尚未获得完成信用。

## 第三批：执行冻结同事务 participant（待托管验证）

`RuntimeSelectionParticipantInTx.freeze` 已由 Task composition 消费；capability 由 Task 在 live transaction 内铸造，
与本次 NodeRun、owner fence 和事务生命周期绑定。RM 从该事务读取唯一 profile，返回无 profile/path 字段的 opaque ref；
组合 adapter 将它投影到现有 NodeRun 三列快照，不新增 schema 或第二个 mint。既有 binary fallback、configDir、extraArgs、
未知协议恢复和 same-session 继承口径保留。dependent agent 的 live profile 查询未改为 task-wide freeze。

首次 dispatch 先执行现有 owner 围栏，再按 provider capability 锁 NodeRun 行，重读快照后决定是否选择，防止并发首次写互相覆盖。
已冻结行仍直接读快照，不因本次迁位新增 owner 拒绝。测试补充同事务未提交 profile 可见、真实写后回滚、并发首次选择和能力到期；
继续保留原 runtime-freeze、binary-freeze、CFG45 17 项热读取与双库适配器用例。

本批仍不关闭 T6：management registry aggregate 的其他 consumer、重复根构造和 legacy 转发入口待统一收缩。
