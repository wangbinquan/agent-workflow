# RFC-561 两个跨 context 的聚合读用自己的端口点名来源：系统总览与 Intent 平台清单（RFC-294 S9 第十六步）

- **状态**：Done（2026-11-24，落地 `7e5b37e36`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §3.1（目标 DAG 里 system-operations 没有任何向外的 offered 边，
  intent 只有 → resource-catalog 一条）、§3.3“port：required SPI 由 consumer 拥有”与 design §14“DAG 外的 offered 边 → 0”；做法同
  [RFC-559](../RFC-559-memory-consumer-owned-ports/proposal.md)（consumer 自有端口，bootstrap 用 owner 交出的同一个对象绑定）。

## 1. 背景

`off-dag-offered-file-context-pairs`（33 条）里有 7 条出自两个把多个 context 的结果拼成一张表的只读聚合，它们各自按名字取来源 context 的 public：

| 聚合                                                                    | 取的 public                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| system-operations `application/overview.ts`（`/api/overview` 首页计数） | resource-catalog `ResourceCatalogOverviewQuery`、source-control `RepositoryOverviewQueries`、integration `IntegrationOverviewQueries`、memory `MemoryCatalogOperations`、task-execution `TaskOverviewQuery` |
| intent `application/platformInventoryParticipant.ts`（平台清单）        | development-automation `DevelopmentConfigOperations`、digital-employee `DigitalEmployeePlatformInventoryParticipant`                                                                                        |

这七条边目标 DAG 都不画。聚合只读来源对象上的一两个方法；对象本来就是 bootstrap 从各 owner 的装配里取来交给聚合的。同一个文件里早有先例：intent 的
平台清单用自己声明的 `IntentCapabilityTemplateInventoryQueries` 点名能力模板的来源，system-operations 的 doctor 用自己声明的 `DoctorRuntimeBinaryProbe`
点名运行时探测（RFC-487）。

## 2. 目标

- **G1**：system-operations 在 `application/ports/systemOverviewSources.ts` 声明总览的五个来源端口（资源计数、仓库数、定时任务数、记忆、任务计数），
  `composeSystemOverviewQuery` 改用它们；类型只取 shared 与 identity-access 的 authority 类型。
- **G2**：intent 在 `application/ports/platformInventorySources.ts` 声明平台清单的两个来源端口（开发配置列表、数字员工清单行），
  `createIntentPlatformInventoryParticipant` 改用它们。
- **G3**：bootstrap 照旧交各 owner 的同一个对象（结构上满足这些端口，交接处由编译器检查），不改代码。
- **G4**：DAG 外的 offered 边 33 → 26；随之失去最后一个模块外读者的 public 类型撤回各自模块（未消费的 public 符号保持 0），integration 空出来的
  `public/queries.ts` 删除；精确清单与减速带随之降低，其余计数不升。
- **G5 结局不变**：同一批对象、同样的调用与同样的权限判断，`/api/overview` 的每个计数与 Intent 平台清单的每一行不变。

## 3. 非目标

- 其余 26 条 DAG 外 offered 边；其中 system-operations `composition.ts` 取 source-control 的备份准备参与者那一条留给后续（仓库凭据面随 RFC-546 一并处理）。
- 总览聚合放在哪个 context：RFC-294 design §3.4 把“跨业务统计”列为 system-operations 不跨界的内容，聚合的归属另行决定；本 RFC 只让它不再点名
  别的 context，将来搬家时只需带走一个端口文件与一个应用文件（design §4）。
- 各来源的权限判断放在哪一侧：不动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：system-operations 的总览聚合与 intent 的平台清单聚合不再取来源 context；七个来源端口由聚合方自己声明。
- **AC-2**：行为不变；各 owner 的对象满足端口由编译器检查（新用例的编译期断言与 bootstrap 的交接处）。
- **AC-3**：DAG 外 offered 边 33 → 26，精确清单（`rfc376-structural-guards`、`rfc294-review-offered-edge-dag`）与 `counts.json` 随之更新；失去模块外读者
  的 public 类型撤回各自模块、读它们的用例随改；新增 RFC-561 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
