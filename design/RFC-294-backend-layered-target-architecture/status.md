<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:2f9da6919c9eebab26f881d811992595fd62efb46598e021826df46181ac6dc9`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 2240 |
| `services/` 文件 | 298 |
| `modules/**` 文件 / 非空 context | 1652 / 18 |
| backend 值级 SCC / 全仓值级 SCC | 1 / 3 |
| `KNOWN_VIOLATIONS` | 8 |
| route→DB / transport→DB 值级边 | 0 / 0 |
| route/MCP `AppDeps` consumer 文件 | 0 |
| production ambient wiring seam | 504 |
| background work entries | 361 |
| direct native `setInterval`（call / files） | 22 / 19 |
| direct native timers（全部） | 78 |
| RFC-317 boundary census（inbound / outbound） | 295 / 36 |
| `node_runs INSERT` 站点 | 1 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 504 |
| `architectureExceptions` | 5719 |
| `backgroundJobs` | 361 |
| `crossContextImports` | 6469 |
| `facades` | 298 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 26891 |
| `mutationEntrypoints` | 1893 |
| `nodeRunInsertSites` | 1 |
| `publicSurfaces` | 1169 |
| `transactionExternalEffects` | 267 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| task-execution / infrastructure | 142 |
| resource-catalog / infrastructure | 129 |
| task-execution / application | 127 |
| resource-catalog / application | 77 |
| task-execution / composition | 75 |
| development-automation / application | 61 |
| collaboration / infrastructure | 47 |
| development-automation / infrastructure | 44 |
| resource-catalog / composition | 37 |
| collaboration / application | 36 |
| source-control / infrastructure | 35 |
| task-execution / domain | 35 |
| development-automation / domain | 34 |
| run-observability / application | 33 |
| source-control / application | 30 |
| intent / application | 29 |
| runtime-management / application | 28 |
| system-operations / infrastructure | 27 |
| identity-access / application | 25 |
| run-observability / domain | 25 |
| integration / application | 23 |
| runtime-management / infrastructure | 23 |
| system-operations / application | 23 |
| integration / infrastructure | 22 |
| run-observability / infrastructure | 21 |
| code-capability / application | 20 |
| task-execution / engine | 20 |
| integration / composition | 18 |
| intent / domain | 18 |
| run-observability / ports | 17 |
| code-capability / infrastructure | 15 |
| development-automation / composition | 15 |
| collaboration / domain | 14 |
| digital-employee / application | 14 |
| identity-access / infrastructure | 12 |
| source-control / composition | 12 |
| system-operations / composition | 12 |
| code-capability / domain | 11 |
| digital-employee / infrastructure | 11 |
| memory / application | 11 |
| resource-catalog / domain | 11 |
| source-control / domain | 11 |
| intent / infrastructure | 10 |
| memory / domain | 9 |
| collaboration / composition | 8 |
| event-center / application | 8 |
| intent / composition | 8 |
| knowledge-evolution / domain | 8 |
| development-automation / engine | 7 |
| memory / infrastructure | 7 |
| run-observability / composition | 7 |
| runtime-management / composition | 7 |
| task-execution / public | 7 |
| digital-employee / composition | 6 |
| digital-employee / domain | 6 |
| identity-access / composition | 6 |
| identity-access / public | 6 |
| memory / public | 6 |
| collaboration / public | 5 |
| digital-employee / public | 5 |
| event-center / infrastructure | 5 |
| event-center / public | 5 |
| integration / public | 5 |
| resource-catalog / public | 5 |
| source-control / public | 5 |
| system-operations / public | 5 |
| code-capability / composition | 4 |
| development-automation / public | 4 |
| integration / domain | 4 |
| knowledge-evolution / application | 4 |
| runtime-management / public | 4 |
| system-operations / domain | 4 |
| event-center / domain | 3 |
| execution-contract / application | 3 |
| identity-access / domain | 3 |
| knowledge-evolution / public | 3 |
| event-center / composition | 2 |
| execution-contract / composition | 2 |
| execution-contract / public | 2 |
| intent / ports | 2 |
| intent / public | 2 |
| knowledge-evolution / inbound | 2 |
| knowledge-evolution / infrastructure | 2 |
| run-observability / public | 2 |
| source-control / ports | 2 |
| task-catalog / composition | 2 |
| code-capability / public | 1 |
| execution-contract / domain | 1 |
| identity-access / inbound | 1 |
| intent / inbound | 1 |
| knowledge-evolution / composition | 1 |
| memory / composition | 1 |
| runtime-management / domain | 1 |
| task-catalog / application | 1 |
| task-catalog / public | 1 |
| task-execution / inbound | 1 |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext | 数量 |
| --- | --- |
| platform | 214 |
| task-execution | 74 |
| resource-catalog | 51 |
| runtime-management | 48 |
| identity-access | 38 |
| collaboration | 31 |
| workspace-insight | 31 |
| integration | 28 |
| source-control | 24 |
| bootstrap | 22 |
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
| legacy-outbound | 3682 |
| legacy-inbound | 1847 |
| infrastructure-external | 316 |
| offered-consumption | 290 |
| temporary-internal-debt | 95 |
| off-dag-offered | 83 |
| authority-type-only | 78 |
| required-implementation | 72 |
| external-layer-debt | 4 |
| provider-mirror | 2 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 3682 |
| legacy-inbound | 1847 |
| temporary-internal-debt | 95 |
| off-dag-offered | 83 |
| no-circular | 6 |
| external-layer-debt | 4 |
| no-util-to-upper | 2 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9 | 3099 |
| W9-D | 1022 |
| W4-E1 | 736 |
| W5 | 204 |
| W4 | 201 |
| W4-B | 187 |
| W4-E8 | 157 |
| W4-E9 | 77 |
| RFC-371 | 12 |
| W2-D/W3/W5 | 11 |
| W9-E | 8 |
| W4-E10 | 3 |
| W4-E5 | 2 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| task-execution | 279 |
| resource-catalog | 240 |
| collaboration | 122 |
| source-control | 101 |
| system-operations | 69 |
| identity-access | 65 |
| runtime-management | 57 |
| digital-employee | 51 |
| development-automation | 39 |
| knowledge-evolution | 25 |
| execution-contract | 22 |
| memory | 22 |
| event-center | 21 |
| code-capability | 19 |
| integration | 14 |
| run-observability | 12 |
| intent | 10 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 136 / 1169）

| context | 数量 |
| --- | --- |
| collaboration | 44 |
| digital-employee | 18 |
| task-execution | 14 |
| system-operations | 12 |
| code-capability | 11 |
| event-center | 8 |
| development-automation | 7 |
| source-control | 7 |
| identity-access | 6 |
| integration | 5 |
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
