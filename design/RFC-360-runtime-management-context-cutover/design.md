# RFC-360 技术设计

## 1. 当前源码与目标落位

源码基线为 proposal 所列 SHA；以下路径均相对仓库根目录。

| 当前事实                                                                                                 | 目标 owner / 层                               | 本次动作                                                         |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `packages/backend/src/routes/runtimes.ts` 直接编排 registry、config、driver、smoke                       | runtime-management/application                | 抽出按用例分组的 command/query，route 保留 HTTP codec            |
| `packages/backend/src/routes/runtime.ts` 编排模型列表与名称/别名解析                                     | runtime-management/application + domain       | 原判据整体迁入，保留原输出与 502 映射                            |
| `packages/backend/src/services/runtimeRegistry.ts` 组合 profile、选择与写入                              | runtime-management/domain/application         | 拆纯判据、用例与 public DTO；删除已无 consumer 的 legacy surface |
| `packages/backend/src/platform/runtime-registry/infrastructure/runtimeRegistryPersistence.ts` 已双库合一 | runtime-management/infrastructure             | 原算法归位；共用 `DatabaseSession`，不复制 provider 分支         |
| `packages/backend/src/services/runtimeSmoke.ts` 与 `services/runtime/*` 提供 probe/driver mechanism      | infrastructure adapter / 既有 mechanism owner | 注入窄 effect port；driver 协议实现不作为本批搬迁目标            |
| `packages/backend/src/services/execution/runtimeConfigFreeze.ts` 和任务 runtime participants             | task-execution + RM offered participant       | 保留已有冻结时点，替换 legacy registry/config 依赖               |
| `modules/runtime-management/composition.ts` 当前只组合 realtime                                          | runtime-management/composition                | 新增独立管理/选择装配，保持 realtime 原实例与功能                |

RFC-294 design §3.5 的 runtime ownership 与 §4.3 的异步事务合同是上位约束。业务源码依赖 application-owned ports；
public 只导出调用合同与 DTO；infrastructure 依赖实际 driver/DB/config；bootstrap 不持有 profile 选择分支。

## 2. 合同分组

下列为待实施的目标名称，不是已经存在的 API。每组不超过五个方法，避免把当前 registry mega-interface 原样改名。

| public / required 合同            | 方法                            | 输入 / 输出与 owner                                                         |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `RuntimeProfileCommands`          | create/update/setEnabled/remove | 既有完整 profile 字段、当前调用上下文；返回现有管理 DTO/receipt             |
| `RuntimeProfileQueries`           | list/get/status                 | 同现有 runtime 管理查询语义；不暴露存储 row                                 |
| `RuntimeDiagnosticCommands`       | probe                           | 既有 probe input → typed smoke/probe receipt；保存前与保存后探测共用判据    |
| `RuntimeModelQueries`             | list                            | runtime name、refresh → 当前模型列表结果                                    |
| `RuntimeSelectionParticipantInTx` | freeze                          | RFC-294 已定义 capability + selection → `Promise<FrozenRuntimeRef>`         |
| `RuntimeProbeEffectPort`          | probe                           | RM-owned resolved probe request → typed receipt；实际进程 effect 在事务外   |
| `RuntimeModelDiscoveryPort`       | list                            | 已解析 profile/binary facts → typed model result                            |
| `RuntimeManagementConfigPort`     | current                         | 管理/probe 所需配置的具名投影；不传 configPath 或完整 config 给 application |
| `RuntimeProfileUsageReader`       | inspect                         | 删除/停用涉及的具名引用投影，按现有判据提供完整引用集合                     |

profile 字段清单以当前 `RuntimeProfile`、Create/Update body 与 registry parser 三方对拍为准，至少覆盖 model、variant、
temperature、steps、maxSteps、isSandbox、extraArgs、binaryPath、configDirEnv、configDirName、enabled 与 probe metadata。
T1 冻结所有可写/只读/nullable/default 字段，保留额外现存字段；不能把此处列举当作裁剪 DTO 的白名单。

`RuntimeManagementConfigPort.current()` 每次按当前用例所需时点读取；不能在 boot 捕获一次后永久缓存。
profile 选择只迁位现有默认值、override、未知 name fallback、internal-agent 兼容逻辑。

## 3. 数据流和事务

管理写路径：HTTP/CLI → public command → domain validation → application repository/transaction → DTO。
探测路径：decode → 同一 domain validation → config/probe target snapshot → 外部 probe → receipt compare/store → response。
现有 config fence 与 profile fingerprint 比较保留；旧 probe 在 profile 编辑后完成，不能覆盖新 target 的状态。

注册表目前在 profile 修改事务内联动 MCP test session 状态。迁位时必须与 ResourceCatalog 共同提供 tx-bound
`RuntimeProfileTestInvalidationInTx.invalidate` participant，保留同一 live transaction 的失效写入；实现复用当前逻辑。
删除/停用的引用判据也在原事务范围内通过 `RuntimeProfileUsageReader` 读取，不改为事务前的快照检查。该 required reader 明确接收 transaction，不冒充 opaque capability；
RC-owned invalidation participant 与 RM selection participant 则由各自唯一工厂创建，并保留 private brand、freeze 与实例登记。
这个薄 participant 是本 RFC 的必要接缝，不扩大为 W4-E6 的完整会话迁移，也不能改为提交后的异步通知。

任务路径：TaskExecution 首次 dispatch → task-owned runtime selection capability → RM participant → frozen ref →
TaskExecution NodeRun snapshot。它仍使用唯一 nodeRun mint 与 RFC-359 transaction program，不能新建第二条 mint。
如需同时支持现有同步 compatibility consumer 与 async consumer，沿用同一 program 的 `driveSync/driveAsync`，
不能把 async callback 传入 `dbTxSync`，不能复制两份业务事务体。

任务 policy/config 与 profile snapshot 是不同东西：保留当前启动/恢复时读取配置及 NodeRun 冻结规则；
`rfc319-cfg45-default-runtime-hot-read` 的 17 项热读取是底线。不得把 task launch 改成一次冻结整个 task 的 runtime profile。

## 4. 拆分与共享路径

新增或归位的核心文件在 `modules/runtime-management/{domain,application,public,infrastructure}`。
迁移 registry persistence 时，先迁唯一实现，再逐调用点切换；短期 re-export 必须登记 exact consumer，最后删除。
生产 driver mechanism 留在现有路径直到其 owner wave 迁位；本 RFC 通过 adapter 引用，并登记存续原因。

共同修改面为 `server.ts`、`cli/daemonProviderBootstrap.ts`、`modules/task-execution/composition/providerRuntime.ts`、
`modules/task-execution/infrastructure/taskExecutionRuntimeParticipants.ts` 与 RC runtime-test participant。
实现前先以当前 import/callsite 确认精确文件；与 RFC-361/362 的公共根接线分批完成，不并发修改这些文件或 Git index。

## 5. 失败与恢复矩阵

| 场景                                                 | 保持的结果                                         |
| ---------------------------------------------------- | -------------------------------------------------- |
| 停用默认 runtime、删除最后一个/仍被引用 runtime      | 当前 DomainError/status/code，不新增不同入口的判据 |
| probe 期间 profile/config 改变                       | 旧 receipt 不成为新 profile 的有效探测结果         |
| profile 更新后 MCP 试跑会话失效写失败                | profile 与会话变化共同回滚，SQLite/PG 相同         |
| config 更新后新任务/重试                             | 按现有时点读取新值；零值与省略值含义保持           |
| same-session resume                                  | 不重新选择已经冻结的 profile                       |
| model discovery 失败、自定义 name 与 claude 别名同名 | 保留当前解析优先级与 HTTP 错误 wire                |
| bootstrap/recovery                                   | 管理实例唯一；无 provider 专属备用业务实现         |

## 6. 验证与退出

复用 `runtime-registry.test.ts`、`runtime-routes-registry.test.ts`、`runtime-routes.test.ts`、`runtime-freeze.test.ts`、
`runtime-internal-agent-runtime.test.ts`、`runtime-smoke.test.ts`、`rfc103-launch-config-passthrough.test.ts`、
`rfc319-cfg45-default-runtime-hot-read.test.ts`、`rfc359-w4-d28b-runtime-registry-conformance.test.ts`。
新增测试只补 adapter parity、旧 receipt 竞争与首次 dispatch/恢复边界等真实缺口，DB 用例使用
`tests/helpers/eachProvider.ts` 的真实两库 harness。HTTP 与 CLI 结果使用相同 golden。

architecture 验证 public production liveness、route 负扫描、唯一实例和本批 exact debt 消除。
保留 RFC-297 TaskExecution observed inventory/provenance 的原测试；不因把 profile 移到 RM 而迁走这类数据所有权。
本 RFC 不改 schema/wire，不需要数据回滚；代码回滚只能回到兼容的同一数据库实现，不能复活 provider twins。
