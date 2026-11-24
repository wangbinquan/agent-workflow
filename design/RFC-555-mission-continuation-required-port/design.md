# RFC-555 技术设计

落在 development-automation（Mission 续接的实现）与 integration（required-ports 交出端口类型）两个 bounded context；另改 RFC-294 的目标 DAG
（design §3.1 的 Mermaid 与 `tests/architecture/rfc294Target.ts`）、两份精确清单、`architecture/counts.json` 与新增一个 RFC-555 用例。
数字取 HEAD `a74820d0b`。不改行为。

## 1. 改动

| 位置                                                                          | 现状                                                          | 做法                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| integration `composition/required-ports.ts`                                   | 只交出 `IntegrationTriggerSnapshotFactory`                    | 加一条类型转出 `CodeHostEventContinuationPort`（来自 `application/ports/codeHostEventResponse`）                                                           |
| development-automation `application/adapters/integration-adapter.ts`（新）    | —                                                             | `missionCodeHostEventContinuation(store)`：按类型取 integration 的端口；match / consume 原样挪来，依赖 `MissionPersistence` 的三个方法与 domain 的唤醒规则 |
| development-automation `infrastructure/missionCodeHostEventContinuation.ts`   | 逻辑与数据库绑定；返回类型取 integration 的 application/ports | 只留 `createMissionCodeHostEventContinuation(db)`：用 `createMissionPersistence(db)` 绑定 adapter；不再取 integration                                      |
| RFC-294 design §3.1 的 Mermaid、`rfc294Target.ts` 的 `REQUIRED_CONTEXT_EDGES` | —                                                             | 同批加虚线边 `DA -. "implements CodeHostEventContinuationPort" .-> INTEG`                                                                                  |
| `rfc310-pr7b-reopen-generation` 读源码的断言                                  | 读 infrastructure 文件里的唤醒判定与记录                      | 改读 adapter（逻辑挪到那里）                                                                                                                               |

bootstrap（`daemonModules/integration.ts`）与 development-automation composition 的转出都不变。门的口径：`crossContextInternalPairs` 不计
`application/adapters/*-adapter` 按类型取别的 context `composition/required-ports` 的边（`tests/architecture/rfc294Gates.ts` 的
`crossContextInternalPairs`），架构报告把它记为 required-implementation。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 与 `rfc294-architecture-preflight` 的跨 context 内部文件对删去这一条；`counts.json` 的
  `cross-context-internal-file-pairs` 15 → 14。
- 新增 `tests/rfc555-mission-continuation-required-port-boundary.test.ts`，登记 guard-manifest：① development-automation 的生产文件里取 integration
  非 public 文件的只有 `application/adapters/integration-adapter.ts`，且只按类型取 `composition/required-ports`（带负对照）；② required-ports 交出这个
  端口，adapter 实现它，infrastructure 只做绑定；③ 目标 DAG 有这条虚线边。

## 3. 失败模式

- **adapter 以外的文件取 integration 的内部**：RFC-555 用例与跨 context 内部文件对的精确清单都会红。
- **端口签名改了**：adapter 按端口类型标注，编译期报错。

## 4. 取舍（可推翻）

1. **required-ports 加指定 adapter，而不是 development-automation 自己再声明一份同形**：RFC-294 design §3.5 把 required 接口的事实源定在 consumer
   的 `composition/required-ports.ts`；同形的第二份声明会多出一个事实源。RFC-399 已有同样的落法。
2. **逻辑挪进 application/adapters，而不是让 adapter 只做类型包装**：续接逻辑只用 Mission 的存储端口与 domain 的唤醒规则，本就属于 application；
   infrastructure 只剩数据库绑定。
3. **不取 integration 的 public**：development-automation → integration 不是 offered 边，换过去只会多一条 DAG 外的 offered 边。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：端口事实源在 integration 的 required-ports，实现在 development-automation 的指定 adapter，infrastructure 只做绑定。**C11**：两个 context
  的 public 都不变。**C12**：RFC-555 用例覆盖。**C13**：跨 context 内部文件对 15 → 14，其余计数不升（`off-dag-offered-file-context-pairs` 不变）；
  目标 DAG 多一条虚线 required 边，与 design 的 Mermaid 同批（`rfc294-design-parity` 锁两边一致）。
