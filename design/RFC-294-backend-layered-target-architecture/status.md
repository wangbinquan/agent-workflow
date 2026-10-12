<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:7abc33f785cf93c72c2c248470d40a3e53c9543a5476efb2b830a9d1dead7ab8`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 2503 |
| `services/` 文件 | 298 |
| `modules/**` 文件 / 非空 context | 1896 / 18 |
| backend 值级 SCC / 全仓值级 SCC | 1 / 3 |
| `KNOWN_VIOLATIONS` | 8 |
| route→DB / transport→DB 值级边 | 0 / 0 |
| route/MCP `AppDeps` consumer 文件 | 0 |
| production ambient wiring seam | 508 |
| background work entries | 385 |
| direct native `setInterval`（call / files） | 24 / 20 |
| direct native timers（全部） | 82 |
| RFC-317 boundary census（inbound / outbound） | 322 / 46 |
| `node_runs INSERT` 站点 | 1 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 508 |
| `architectureExceptions` | 6231 |
| `backgroundJobs` | 385 |
| `crossContextImports` | 7122 |
| `facades` | 298 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 28250 |
| `mutationEntrypoints` | 2011 |
| `nodeRunInsertSites` | 1 |
| `publicSurfaces` | 1283 |
| `transactionExternalEffects` | 284 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| task-execution / infrastructure | 180 |
| task-execution / application | 157 |
| resource-catalog / infrastructure | 132 |
| task-execution / composition | 98 |
| resource-catalog / application | 78 |
| development-automation / application | 67 |
| run-observability / application | 51 |
| collaboration / infrastructure | 48 |
| development-automation / infrastructure | 48 |
| run-observability / infrastructure | 45 |
| resource-catalog / composition | 40 |
| collaboration / application | 39 |
| source-control / infrastructure | 36 |
| task-execution / domain | 36 |
| development-automation / domain | 34 |
| integration / application | 32 |
| run-observability / domain | 32 |
| runtime-management / application | 32 |
| runtime-management / infrastructure | 31 |
| intent / application | 30 |
| source-control / application | 30 |
| system-operations / infrastructure | 30 |
| system-operations / application | 29 |
| integration / infrastructure | 26 |
| run-observability / ports | 26 |
| identity-access / application | 25 |
| code-capability / application | 20 |
| task-execution / engine | 20 |
| integration / composition | 19 |
| development-automation / composition | 18 |
| intent / domain | 18 |
| system-operations / composition | 18 |
| code-capability / infrastructure | 15 |
| collaboration / domain | 14 |
| digital-employee / application | 14 |
| source-control / composition | 14 |
| runtime-management / composition | 13 |
| identity-access / infrastructure | 12 |
| run-observability / composition | 12 |
| code-capability / domain | 11 |
| digital-employee / infrastructure | 11 |
| intent / infrastructure | 11 |
| memory / application | 11 |
| resource-catalog / domain | 11 |
| source-control / domain | 11 |
| event-center / application | 10 |
| intent / composition | 9 |
| memory / domain | 9 |
| collaboration / composition | 8 |
| knowledge-evolution / domain | 8 |
| memory / infrastructure | 8 |
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
| resource-catalog / public | 5 |
| source-control / public | 5 |
| system-operations / domain | 5 |
| system-operations / public | 5 |
| code-capability / composition | 4 |
| development-automation / public | 4 |
| event-center / composition | 4 |
| event-center / domain | 4 |
| integration / domain | 4 |
| knowledge-evolution / application | 4 |
| runtime-management / public | 4 |
| execution-contract / application | 3 |
| identity-access / domain | 3 |
| intent / public | 3 |
| knowledge-evolution / public | 3 |
| runtime-management / domain | 3 |
| execution-contract / composition | 2 |
| execution-contract / public | 2 |
| intent / ports | 2 |
| knowledge-evolution / inbound | 2 |
| knowledge-evolution / infrastructure | 2 |
| memory / composition | 2 |
| run-observability / public | 2 |
| source-control / ports | 2 |
| task-catalog / composition | 2 |
| code-capability / public | 1 |
| execution-contract / domain | 1 |
| identity-access / inbound | 1 |
| intent / inbound | 1 |
| knowledge-evolution / composition | 1 |
| task-catalog / application | 1 |
| task-catalog / public | 1 |
| task-execution / inbound | 1 |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext | 数量 |
| --- | --- |
| platform | 233 |
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
| legacy-outbound | 3975 |
| legacy-inbound | 2026 |
| offered-consumption | 381 |
| infrastructure-external | 355 |
| temporary-internal-debt | 112 |
| off-dag-offered | 102 |
| required-implementation | 83 |
| authority-type-only | 78 |
| external-layer-debt | 8 |
| provider-mirror | 2 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 3975 |
| legacy-inbound | 2026 |
| temporary-internal-debt | 112 |
| off-dag-offered | 102 |
| external-layer-debt | 8 |
| no-circular | 6 |
| no-util-to-upper | 2 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9 | 3366 |
| W9-D | 1114 |
| W4-E1 | 843 |
| W5 | 203 |
| W4 | 202 |
| W4-B | 187 |
| W4-E8 | 175 |
| W4-E9 | 83 |
| RFC-371 | 32 |
| W2-D/W3/W5 | 12 |
| W9-E | 8 |
| W4-E10 | 3 |
| W4-E5 | 3 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| task-execution | 306 |
| resource-catalog | 243 |
| collaboration | 123 |
| source-control | 104 |
| system-operations | 89 |
| runtime-management | 87 |
| identity-access | 65 |
| digital-employee | 51 |
| development-automation | 49 |
| integration | 27 |
| knowledge-evolution | 25 |
| memory | 23 |
| execution-contract | 22 |
| event-center | 21 |
| code-capability | 19 |
| run-observability | 17 |
| intent | 11 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 143 / 1283）

| context | 数量 |
| --- | --- |
| collaboration | 44 |
| system-operations | 19 |
| digital-employee | 18 |
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
