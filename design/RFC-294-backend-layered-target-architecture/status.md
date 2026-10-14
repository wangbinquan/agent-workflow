<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:52f0c88ae0634cf86d1861b38117fa0949f27f7d27d3b474d31390d21d4b2be1`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 2566 |
| `services/` 文件 | 298 |
| `modules/**` 文件 / 非空 context | 1942 / 18 |
| backend 值级 SCC / 全仓值级 SCC | 1 / 3 |
| `KNOWN_VIOLATIONS` | 8 |
| route→DB / transport→DB 值级边 | 0 / 0 |
| route/MCP `AppDeps` consumer 文件 | 1 |
| production ambient wiring seam | 522 |
| background work entries | 412 |
| direct native `setInterval`（call / files） | 26 / 22 |
| direct native timers（全部） | 88 |
| RFC-317 boundary census（inbound / outbound） | 313 / 46 |
| `node_runs INSERT` 站点 | 1 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 522 |
| `architectureExceptions` | 6440 |
| `backgroundJobs` | 412 |
| `crossContextImports` | 7350 |
| `facades` | 298 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 28704 |
| `mutationEntrypoints` | 2038 |
| `nodeRunInsertSites` | 1 |
| `publicSurfaces` | 1293 |
| `transactionExternalEffects` | 309 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| task-execution / infrastructure | 183 |
| task-execution / application | 157 |
| resource-catalog / infrastructure | 132 |
| task-execution / composition | 98 |
| resource-catalog / application | 80 |
| development-automation / application | 67 |
| run-observability / application | 53 |
| run-observability / infrastructure | 53 |
| collaboration / infrastructure | 48 |
| development-automation / infrastructure | 48 |
| resource-catalog / composition | 40 |
| collaboration / application | 39 |
| run-observability / domain | 37 |
| source-control / infrastructure | 36 |
| task-execution / domain | 36 |
| development-automation / domain | 34 |
| intent / application | 34 |
| integration / application | 33 |
| runtime-management / infrastructure | 33 |
| runtime-management / application | 32 |
| source-control / application | 30 |
| system-operations / application | 30 |
| system-operations / infrastructure | 30 |
| run-observability / ports | 28 |
| integration / infrastructure | 26 |
| identity-access / application | 25 |
| system-operations / composition | 21 |
| code-capability / application | 20 |
| task-execution / engine | 20 |
| integration / composition | 19 |
| development-automation / composition | 18 |
| intent / domain | 18 |
| memory / application | 17 |
| code-capability / infrastructure | 15 |
| collaboration / domain | 14 |
| digital-employee / application | 14 |
| source-control / composition | 14 |
| runtime-management / composition | 13 |
| identity-access / infrastructure | 12 |
| run-observability / composition | 12 |
| code-capability / domain | 11 |
| digital-employee / infrastructure | 11 |
| event-center / application | 11 |
| intent / infrastructure | 11 |
| resource-catalog / domain | 11 |
| source-control / domain | 11 |
| intent / composition | 10 |
| memory / domain | 10 |
| memory / infrastructure | 9 |
| collaboration / composition | 8 |
| knowledge-evolution / domain | 8 |
| development-automation / engine | 7 |
| task-execution / public | 7 |
| digital-employee / composition | 6 |
| digital-employee / domain | 6 |
| event-center / infrastructure | 6 |
| identity-access / composition | 6 |
| identity-access / public | 6 |
| memory / public | 6 |
| collaboration / public | 5 |
| digital-employee / public | 5 |
| event-center / public | 5 |
| integration / public | 5 |
| knowledge-evolution / application | 5 |
| resource-catalog / public | 5 |
| source-control / public | 5 |
| system-operations / domain | 5 |
| system-operations / public | 5 |
| code-capability / composition | 4 |
| development-automation / public | 4 |
| event-center / composition | 4 |
| event-center / domain | 4 |
| integration / domain | 4 |
| runtime-management / public | 4 |
| execution-contract / application | 3 |
| identity-access / domain | 3 |
| intent / public | 3 |
| knowledge-evolution / infrastructure | 3 |
| knowledge-evolution / public | 3 |
| runtime-management / domain | 3 |
| execution-contract / composition | 2 |
| execution-contract / public | 2 |
| intent / ports | 2 |
| knowledge-evolution / composition | 2 |
| knowledge-evolution / inbound | 2 |
| memory / composition | 2 |
| run-observability / public | 2 |
| source-control / ports | 2 |
| task-catalog / composition | 2 |
| code-capability / public | 1 |
| execution-contract / domain | 1 |
| identity-access / inbound | 1 |
| intent / inbound | 1 |
| task-catalog / application | 1 |
| task-catalog / public | 1 |
| task-execution / inbound | 1 |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext | 数量 |
| --- | --- |
| platform | 245 |
| task-execution | 74 |
| resource-catalog | 51 |
| runtime-management | 48 |
| identity-access | 38 |
| collaboration | 31 |
| workspace-insight | 31 |
| integration | 28 |
| bootstrap | 27 |
| source-control | 24 |
| development-automation | 10 |
| system-operations | 9 |
| digital-employee | 3 |
| memory | 2 |
| event-center | 1 |
| execution-contract | 1 |
| task-catalog | 1 |

## 4. Facade 账本（`facades.json`）

### 4.1 按目标 context

| targetContext | 数量 |
| --- | --- |
| task-execution | 69 |
| runtime-management | 45 |
| resource-catalog | 41 |
| workspace-insight | 31 |
| collaboration | 27 |
| platform | 25 |
| integration | 22 |
| source-control | 15 |
| identity-access | 9 |
| development-automation | 5 |
| bootstrap | 4 |
| system-operations | 3 |
| digital-employee | 2 |

### 4.2 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9-D | 98 |
| W4-E1 | 68 |
| W4-E5 | 31 |
| W4 | 27 |
| W9 | 25 |
| W4-B | 22 |
| W5 | 14 |
| W4-E8 | 5 |
| W9-E | 5 |
| W4-E9 | 2 |
| W2-D/W3/W5 | 1 |

## 5. 跨 context 边（`cross-context-imports.json`）

### 5.1 observed edges 按 role

| role | 数量 |
| --- | --- |
| legacy-outbound | 4107 |
| legacy-inbound | 2103 |
| offered-consumption | 390 |
| infrastructure-external | 365 |
| temporary-internal-debt | 113 |
| off-dag-offered | 101 |
| required-implementation | 83 |
| authority-type-only | 78 |
| external-layer-debt | 8 |
| provider-mirror | 2 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 4107 |
| legacy-inbound | 2103 |
| temporary-internal-debt | 113 |
| off-dag-offered | 101 |
| external-layer-debt | 8 |
| no-circular | 6 |
| no-util-to-upper | 2 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9 | 3518 |
| W9-D | 1147 |
| W4-E1 | 862 |
| W5 | 203 |
| W4 | 201 |
| W4-B | 189 |
| W4-E8 | 176 |
| W4-E9 | 86 |
| RFC-371 | 32 |
| W2-D/W3/W5 | 12 |
| W9-E | 8 |
| W4-E10 | 3 |
| W4-E5 | 3 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| task-execution | 313 |
| resource-catalog | 243 |
| collaboration | 122 |
| source-control | 104 |
| system-operations | 91 |
| runtime-management | 87 |
| identity-access | 65 |
| digital-employee | 51 |
| development-automation | 49 |
| integration | 27 |
| knowledge-evolution | 27 |
| memory | 23 |
| execution-contract | 22 |
| event-center | 21 |
| code-capability | 19 |
| run-observability | 17 |
| intent | 11 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 140 / 1293）

| context | 数量 |
| --- | --- |
| collaboration | 44 |
| digital-employee | 18 |
| system-operations | 16 |
| task-execution | 14 |
| code-capability | 11 |
| event-center | 8 |
| development-automation | 7 |
| identity-access | 6 |
| integration | 6 |
| source-control | 6 |
| execution-contract | 3 |
| task-catalog | 1 |

## 7. Required ports（`cross-context-imports.json` → `requiredPorts`）

### 7.1 按 status

| status | 数量 |
| --- | --- |
| active | 20 |
| declared-debt | 20 |

### 7.2 provider=0 且 consumer=0 的 required port（合计 8）

- `required:development-automation:AgentActionExecutionPort`
- `required:development-automation:DevelopmentCodeHostEffectsPort`
- `required:development-automation:MergeRequestFactsPort`
- `required:development-automation:PipelineEvidencePort`
- `required:development-automation:ReconcilerPorts-legacy-aggregate`
- `required:development-automation:RepositoryUploadPlacementPort`
- `required:development-automation:RequirementAcquisitionPort`
- `required:development-automation:RequirementInteractionPort`
