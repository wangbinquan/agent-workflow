<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:d7cd21a663d5fde3d45b5bf92bbc204ab35a92f4e365a18ff552d9b4c72f542f`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 2032 |
| `services/` 文件 | 298 |
| `modules/**` 文件 / 非空 context | 1473 / 18 |
| backend 值级 SCC / 全仓值级 SCC | 1 / 3 |
| `KNOWN_VIOLATIONS` | 8 |
| route→DB / transport→DB 值级边 | 0 / 0 |
| route/MCP `AppDeps` consumer 文件 | 0 |
| production ambient wiring seam | 501 |
| background work entries | 352 |
| direct native `setInterval`（call / files） | 22 / 19 |
| direct native timers（全部） | 77 |
| RFC-317 boundary census（inbound / outbound） | 273 / 31 |
| `node_runs INSERT` 站点 | 1 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 501 |
| `architectureExceptions` | 5167 |
| `backgroundJobs` | 352 |
| `crossContextImports` | 5809 |
| `facades` | 298 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 25932 |
| `mutationEntrypoints` | 1826 |
| `nodeRunInsertSites` | 1 |
| `publicSurfaces` | 1056 |
| `transactionExternalEffects` | 261 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| resource-catalog / infrastructure | 126 |
| task-execution / infrastructure | 115 |
| task-execution / application | 107 |
| resource-catalog / application | 76 |
| task-execution / composition | 62 |
| development-automation / application | 56 |
| collaboration / infrastructure | 47 |
| development-automation / infrastructure | 39 |
| resource-catalog / composition | 37 |
| collaboration / application | 36 |
| development-automation / domain | 34 |
| task-execution / domain | 32 |
| intent / application | 29 |
| system-operations / infrastructure | 27 |
| source-control / infrastructure | 26 |
| identity-access / application | 25 |
| integration / application | 23 |
| system-operations / application | 23 |
| integration / infrastructure | 22 |
| source-control / application | 22 |
| code-capability / application | 20 |
| task-execution / engine | 20 |
| integration / composition | 18 |
| intent / domain | 18 |
| runtime-management / application | 17 |
| code-capability / infrastructure | 15 |
| development-automation / composition | 15 |
| collaboration / domain | 14 |
| digital-employee / application | 14 |
| run-observability / domain | 14 |
| runtime-management / infrastructure | 13 |
| identity-access / infrastructure | 12 |
| run-observability / application | 12 |
| system-operations / composition | 12 |
| code-capability / domain | 11 |
| digital-employee / infrastructure | 11 |
| memory / application | 11 |
| resource-catalog / domain | 11 |
| intent / infrastructure | 10 |
| memory / domain | 9 |
| run-observability / ports | 9 |
| source-control / domain | 9 |
| collaboration / composition | 8 |
| event-center / application | 8 |
| intent / composition | 8 |
| knowledge-evolution / domain | 8 |
| run-observability / infrastructure | 8 |
| development-automation / engine | 7 |
| memory / infrastructure | 7 |
| runtime-management / composition | 7 |
| task-execution / public | 7 |
| digital-employee / composition | 6 |
| digital-employee / domain | 6 |
| identity-access / composition | 6 |
| identity-access / public | 6 |
| memory / public | 6 |
| source-control / composition | 6 |
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
| run-observability / composition | 4 |
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
| platform | 185 |
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
| legacy-outbound | 3342 |
| legacy-inbound | 1641 |
| infrastructure-external | 291 |
| offered-consumption | 207 |
| temporary-internal-debt | 89 |
| off-dag-offered | 83 |
| authority-type-only | 78 |
| required-implementation | 72 |
| external-layer-debt | 4 |
| provider-mirror | 2 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 3342 |
| legacy-inbound | 1641 |
| temporary-internal-debt | 89 |
| off-dag-offered | 83 |
| no-circular | 6 |
| external-layer-debt | 4 |
| no-util-to-upper | 2 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9 | 2782 |
| W9-D | 882 |
| W4-E1 | 679 |
| W4 | 201 |
| W4-B | 187 |
| W5 | 184 |
| W4-E8 | 145 |
| W4-E9 | 77 |
| W2-D/W3/W5 | 9 |
| RFC-371 | 8 |
| W9-E | 8 |
| W4-E10 | 3 |
| W4-E5 | 2 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| resource-catalog | 239 |
| task-execution | 223 |
| collaboration | 122 |
| system-operations | 69 |
| source-control | 67 |
| identity-access | 65 |
| digital-employee | 51 |
| runtime-management | 43 |
| development-automation | 39 |
| knowledge-evolution | 25 |
| execution-contract | 22 |
| memory | 22 |
| event-center | 21 |
| code-capability | 19 |
| integration | 14 |
| intent | 10 |
| run-observability | 4 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 136 / 1056）

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
