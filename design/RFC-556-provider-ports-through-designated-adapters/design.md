# RFC-556 技术设计

落在 task-execution、resource-catalog（provider 的指定 adapter 与 infrastructure）与 integration、runtime-management（required-ports 交出端口类型）四个
bounded context；另改 RFC-294 的目标 DAG（design §3.1 的 Mermaid 与 `tests/architecture/rfc294Target.ts`）、几份精确清单、`architecture/counts.json`
与新增一个 RFC-556 用例。数字取 HEAD `2263968b9`。不改行为。

## 1. 改动

| 位置                                                                                                   | 做法                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| integration `composition/required-ports.ts`                                                            | 加类型转出 `WebhookTaskExecutionParticipant`（来自 `application/ports/webhookExecution`）                                               |
| integration `composition/webhookDispatch.ts`                                                           | 删去同名类型转出（生产代码没有读者；唯一的读者是测试助手 `tests/helpers/webhookTaskExecution.ts`，改从 required-ports 取）              |
| runtime-management `composition/required-ports.ts`                                                     | 加类型转出 `RuntimeProfileUsageReader`（来自 `application/ports/runtimeProfileParticipants`）                                           |
| task-execution `application/adapters/task-catalog-adapter.ts`                                          | 转出它已按类型取到的 `TaskCatalogSource`                                                                                                |
| task-execution `infrastructure/taskCatalogSources.ts`、`infrastructure/taskExecutionCatalogSources.ts` | `TaskCatalogSource` 改从 adapter 取                                                                                                     |
| task-execution `application/adapters/integration-adapter.ts`（新）                                     | 按类型取 integration 的 `WebhookTaskExecutionParticipant`，声明 `TaskExecutionTriggerParticipant`（原样挪自 `taskExecutionTrigger.ts`） |
| task-execution `infrastructure/taskExecutionTrigger.ts`、`composition/providerRuntime.ts`              | `TaskExecutionTriggerParticipant` 改从 adapter 取                                                                                       |
| resource-catalog `application/adapters/runtime-management-adapter.ts`                                  | 按类型转出 runtime-management 的 `RuntimeProfileUsageReader`                                                                            |
| resource-catalog `infrastructure/adapters/runtimeProfileParticipants.ts`                               | `RuntimeProfileUsageReader` 改从 adapter 取                                                                                             |
| RFC-294 design §3.1 的 Mermaid、`rfc294Target.ts` 的 `REQUIRED_CONTEXT_EDGES`                          | 同批加 `TE -. "implements WebhookTaskExecutionParticipant" .-> INTEG` 与 `RC -. "implements RuntimeProfileUsageReader" .-> RM`          |

门的口径与 RFC-555 相同：`crossContextInternalPairs` 不计 `application/adapters/*-adapter` 按类型取别的 context `composition/required-ports` 的边，架构
报告把它记为 required-implementation。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 与 `rfc294-architecture-preflight` 的跨 context 内部文件对删去四条；`counts.json` 的
  `cross-context-internal-file-pairs` 14 → 10；`rfc328-architecture-guards` 的 provider-bridge 债务删去三条；`rfc294-design-parity` 的 design 边总数
  106 → 108；`rfc423-composition-assembly-only` 里 `TaskExecutionTriggerParticipant` 的归属改为新 adapter。
- 新增 `tests/rfc556-provider-ports-designated-adapter-boundary.test.ts`，登记 guard-manifest：① task-execution 与 resource-catalog 的生产文件里，取
  integration / task-catalog / runtime-management 非 public 文件的只有各自的指定 adapter，且只按类型取 `composition/required-ports`（带负对照）；
  ② 两个 required-ports 交出端口，adapter 转出或声明 provider 用的类型；③ 目标 DAG 有这两条虚线边。

## 3. 失败模式

- **adapter 以外的文件取 consumer 的内部**：RFC-556 用例与跨 context 内部文件对的精确清单都会红。
- **端口签名改了**：provider 的实现按端口类型标注，编译期报错。

## 4. 取舍（可推翻）

1. **adapter 转出端口类型、provider 的 infrastructure 从 adapter 取**：provider 与 consumer 合同的接触面收在每对 context 一个文件里；合同变了，adapter
   是吸收差异的地方。实现本身留在 infrastructure（数据库查询、启动参与者），不为了挪而挪。
2. **同名转出而不是另起别名**（`TaskExecutionTriggerParticipant` 除外，它本来就是 task-execution 自己的实例化别名）：读者按端口名就能认出合同。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：端口事实源在 consumer 的 required-ports，provider 只经指定 adapter 取。**C11**：四个 context 的 public 都不变。**C12**：RFC-556 用例覆盖。
  **C13**：跨 context 内部文件对 14 → 10，其余计数不升；目标 DAG 多两条虚线 required 边，与 design 的 Mermaid 同批（`rfc294-design-parity` 锁两边一致）。
