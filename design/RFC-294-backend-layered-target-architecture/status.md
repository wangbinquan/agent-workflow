<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:af86198a233022bd8a925da50af9174794cd9c80235602e4ac55be80ab468a3f`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标                                          | 当前值   |
| --------------------------------------------- | -------- |
| backend production TS 文件                    | 1066     |
| `services/` 文件                              | 381      |
| `modules/**` 文件 / 非空 context              | 510 / 14 |
| backend 值级 SCC / 全仓值级 SCC               | 3 / 5    |
| `KNOWN_VIOLATIONS`                            | 29       |
| route→DB / transport→DB 值级边                | 15 / 2   |
| route/MCP `AppDeps` consumer 文件             | 48       |
| production ambient wiring seam                | 456      |
| background work entries                       | 272      |
| direct native `setInterval`（call / files）   | 24 / 21  |
| direct native timers（全部）                  | 72       |
| RFC-317 boundary census（inbound / outbound） | 50 / 23  |
| `node_runs INSERT` 站点                       | 2        |
| first-party unresolved import                 | 0        |

## 2. 账本分母（`manifestDenominators`）

| 账本                         | 条目数 |
| ---------------------------- | ------ |
| `ambientWiring`              | 456    |
| `architectureExceptions`     | 1693   |
| `backgroundJobs`             | 272    |
| `crossContextImports`        | 1730   |
| `facades`                    | 381    |
| `governedFieldSurfaces`      | 5      |
| `moduleSymbolOwners`         | 19402  |
| `mutationEntrypoints`        | 1086   |
| `nodeRunInsertSites`         | 2      |
| `publicSurfaces`             | 531    |
| `transactionExternalEffects` | 285    |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer                         | 数量 |
| --------------------------------------- | ---- |
| task-execution / application            | 43   |
| development-automation / application    | 38   |
| development-automation / domain         | 33   |
| development-automation / infrastructure | 28   |
| task-execution / composition            | 23   |
| task-execution / domain                 | 23   |
| collaboration / application             | 21   |
| identity-access / application           | 20   |
| task-execution / engine                 | 20   |
| collaboration / domain                  | 14   |
| development-automation / composition    | 13   |
| code-capability / domain                | 11   |
| integration / application               | 10   |
| integration / composition               | 10   |
| resource-catalog / application          | 10   |
| task-execution / infrastructure         | 10   |
| collaboration / infrastructure          | 9    |
| digital-employee / application          | 9    |
| integration / infrastructure            | 8    |
| development-automation / engine         | 7    |
| resource-catalog / infrastructure       | 7    |
| digital-employee / infrastructure       | 6    |
| event-center / application              | 6    |
| identity-access / public                | 6    |
| source-control / application            | 6    |
| source-control / domain                 | 6    |
| code-capability / application           | 5    |
| collaboration / composition             | 5    |
| collaboration / public                  | 5    |
| digital-employee / public               | 5    |
| event-center / public                   | 5    |
| resource-catalog / public               | 5    |
| task-execution / public                 | 5    |
| development-automation / public         | 4    |
| digital-employee / composition          | 4    |
| event-center / infrastructure           | 4    |
| identity-access / infrastructure        | 4    |
| integration / public                    | 4    |
| resource-catalog / domain               | 4    |
| source-control / public                 | 4    |
| event-center / domain                   | 3    |
| identity-access / domain                | 3    |
| integration / domain                    | 3    |
| source-control / infrastructure         | 3    |
| system-operations / application         | 3    |
| system-operations / public              | 3    |
| code-capability / infrastructure        | 2    |
| digital-employee / domain               | 2    |
| event-center / composition              | 2    |
| execution-contract / application        | 2    |
| execution-contract / public             | 2    |
| identity-access / composition           | 2    |
| resource-catalog / composition          | 2    |
| source-control / composition            | 2    |
| system-operations / domain              | 2    |
| system-operations / infrastructure      | 2    |
| task-catalog / composition              | 2    |
| code-capability / public                | 1    |
| execution-contract / composition        | 1    |
| execution-contract / domain             | 1    |
| execution-contract / infrastructure     | 1    |
| intent / domain                         | 1    |
| source-control / ports                  | 1    |
| system-operations / composition         | 1    |
| task-catalog / application              | 1    |
| task-catalog / public                   | 1    |
| task-execution / inbound                | 1    |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext       | 数量 |
| ------------------- | ---- |
| task-execution      | 197  |
| resource-catalog    | 76   |
| runtime-management  | 42   |
| identity-access     | 39   |
| platform            | 32   |
| collaboration       | 30   |
| source-control      | 30   |
| workspace-insight   | 29   |
| integration         | 28   |
| system-operations   | 18   |
| intent              | 17   |
| memory              | 9    |
| knowledge-evolution | 4    |
| bootstrap           | 2    |
| digital-employee    | 1    |
| event-center        | 1    |
| task-catalog        | 1    |

## 4. Facade 账本（`facades.json`）

### 4.1 按目标 context

| targetContext       | 数量 |
| ------------------- | ---- |
| task-execution      | 125  |
| resource-catalog    | 63   |
| runtime-management  | 40   |
| workspace-insight   | 29   |
| collaboration       | 26   |
| integration         | 22   |
| source-control      | 18   |
| intent              | 16   |
| identity-access     | 15   |
| system-operations   | 10   |
| memory              | 8    |
| platform            | 5    |
| knowledge-evolution | 3    |
| digital-employee    | 1    |

### 4.2 按清偿波次

| removeAfterWave | 数量 |
| --------------- | ---- |
| W4-E1           | 124  |
| W4-C            | 63   |
| W4-E4b          | 40   |
| W4-E5           | 29   |
| W4              | 26   |
| W4-B            | 22   |
| W5              | 18   |
| W4-E4a          | 16   |
| W4-E0           | 15   |
| W4-E7           | 10   |
| W4-E2           | 8    |
| W9              | 5    |
| W4-E3           | 3    |
| W2-D/W3/W5      | 1    |
| W4-E9           | 1    |

## 5. 跨 context 边（`cross-context-imports.json`）

### 5.1 observed edges 按 role

| role                    | 数量 |
| ----------------------- | ---- |
| legacy-outbound         | 1076 |
| legacy-inbound          | 489  |
| external-layer-debt     | 83   |
| offered-consumption     | 48   |
| off-dag-offered         | 11   |
| authority-type-only     | 10   |
| required-implementation | 8    |
| temporary-internal-debt | 5    |

### 5.2 exact exceptions 按 rule

| rule                    | 数量 |
| ----------------------- | ---- |
| legacy-outbound         | 1076 |
| legacy-inbound          | 489  |
| external-layer-debt     | 83   |
| no-routes-to-db         | 15   |
| off-dag-offered         | 11   |
| no-circular             | 10   |
| temporary-internal-debt | 5    |
| no-transport-to-db      | 2    |
| no-util-to-upper        | 2    |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave   | 数量 |
| ----------------- | ---- |
| W4-E1             | 793  |
| W4-C              | 155  |
| W4                | 118  |
| W4-E8             | 101  |
| W4-E0             | 96   |
| W5                | 94   |
| W9                | 89   |
| W4-E9             | 85   |
| W4-B              | 80   |
| RFC-owner-cutover | 27   |
| W4-E7             | 25   |
| W4-E4b            | 14   |
| W4-E4a            | 10   |
| W4-E10            | 4    |
| W3                | 2    |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context                | 数量 |
| ---------------------- | ---- |
| task-execution         | 129  |
| resource-catalog       | 89   |
| collaboration          | 77   |
| identity-access        | 47   |
| digital-employee       | 44   |
| system-operations      | 35   |
| source-control         | 24   |
| event-center           | 22   |
| execution-contract     | 22   |
| code-capability        | 19   |
| development-automation | 11   |
| integration            | 11   |
| task-catalog           | 1    |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 141 / 531）

| context                | 数量 |
| ---------------------- | ---- |
| resource-catalog       | 30   |
| collaboration          | 20   |
| digital-employee       | 17   |
| code-capability        | 15   |
| identity-access        | 12   |
| system-operations      | 12   |
| task-execution         | 9    |
| event-center           | 8    |
| source-control         | 6    |
| integration            | 5    |
| development-automation | 3    |
| execution-contract     | 3    |
| task-catalog           | 1    |

## 7. Required ports（`cross-context-imports.json` → `requiredPorts`）

### 7.1 按 status

| status        | 数量 |
| ------------- | ---- |
| declared-debt | 20   |
| active        | 3    |

### 7.2 provider=0 且 consumer=0 的 required port（合计 8）

- `required:development-automation:AgentActionExecutionPort`
- `required:development-automation:DevelopmentCodeHostEffectsPort`
- `required:development-automation:MergeRequestFactsPort`
- `required:development-automation:PipelineEvidencePort`
- `required:development-automation:ReconcilerPorts-legacy-aggregate`
- `required:development-automation:RepositoryUploadPlacementPort`
- `required:development-automation:RequirementAcquisitionPort`
- `required:development-automation:RequirementInteractionPort`
