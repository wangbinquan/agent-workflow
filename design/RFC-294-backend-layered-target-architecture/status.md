<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:ba53578de21b90873e876bd3d4ca6613b22afa438f62442d0e305dbfb7aa9623`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 1830 |
| `services/` 文件 | 291 |
| `modules/**` 文件 / 非空 context | 1283 / 17 |
| backend 值级 SCC / 全仓值级 SCC | 1 / 3 |
| `KNOWN_VIOLATIONS` | 8 |
| route→DB / transport→DB 值级边 | 0 / 0 |
| route/MCP `AppDeps` consumer 文件 | 0 |
| production ambient wiring seam | 494 |
| background work entries | 332 |
| direct native `setInterval`（call / files） | 22 / 19 |
| direct native timers（全部） | 76 |
| RFC-317 boundary census（inbound / outbound） | 253 / 31 |
| `node_runs INSERT` 站点 | 1 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 494 |
| `architectureExceptions` | 4809 |
| `backgroundJobs` | 332 |
| `crossContextImports` | 5399 |
| `facades` | 291 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 24949 |
| `mutationEntrypoints` | 1724 |
| `nodeRunInsertSites` | 1 |
| `publicSurfaces` | 1015 |
| `transactionExternalEffects` | 254 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| resource-catalog / infrastructure | 108 |
| task-execution / infrastructure | 106 |
| task-execution / application | 99 |
| resource-catalog / application | 63 |
| task-execution / composition | 59 |
| development-automation / application | 51 |
| collaboration / infrastructure | 46 |
| resource-catalog / composition | 36 |
| collaboration / application | 35 |
| development-automation / domain | 33 |
| development-automation / infrastructure | 33 |
| task-execution / domain | 31 |
| identity-access / application | 25 |
| intent / application | 25 |
| integration / infrastructure | 22 |
| code-capability / application | 20 |
| integration / application | 20 |
| source-control / infrastructure | 20 |
| task-execution / engine | 20 |
| integration / composition | 18 |
| intent / domain | 18 |
| system-operations / infrastructure | 18 |
| source-control / application | 16 |
| code-capability / infrastructure | 15 |
| collaboration / domain | 14 |
| development-automation / composition | 14 |
| digital-employee / application | 14 |
| runtime-management / application | 13 |
| code-capability / domain | 11 |
| memory / application | 11 |
| resource-catalog / domain | 11 |
| system-operations / application | 11 |
| identity-access / infrastructure | 9 |
| memory / domain | 9 |
| runtime-management / infrastructure | 9 |
| source-control / domain | 9 |
| collaboration / composition | 8 |
| digital-employee / infrastructure | 8 |
| event-center / application | 8 |
| intent / infrastructure | 8 |
| knowledge-evolution / domain | 8 |
| development-automation / engine | 7 |
| intent / composition | 7 |
| memory / infrastructure | 7 |
| task-execution / public | 7 |
| digital-employee / domain | 6 |
| identity-access / public | 6 |
| memory / public | 6 |
| collaboration / public | 5 |
| digital-employee / composition | 5 |
| digital-employee / public | 5 |
| event-center / infrastructure | 5 |
| event-center / public | 5 |
| identity-access / composition | 5 |
| integration / public | 5 |
| resource-catalog / public | 5 |
| runtime-management / composition | 5 |
| source-control / public | 5 |
| system-operations / composition | 5 |
| code-capability / composition | 4 |
| development-automation / public | 4 |
| integration / domain | 4 |
| knowledge-evolution / application | 4 |
| runtime-management / public | 4 |
| source-control / composition | 4 |
| system-operations / public | 4 |
| event-center / domain | 3 |
| execution-contract / application | 3 |
| identity-access / domain | 3 |
| knowledge-evolution / public | 3 |
| system-operations / domain | 3 |
| event-center / composition | 2 |
| execution-contract / composition | 2 |
| execution-contract / public | 2 |
| intent / ports | 2 |
| intent / public | 2 |
| knowledge-evolution / inbound | 2 |
| knowledge-evolution / infrastructure | 2 |
| source-control / ports | 2 |
| task-catalog / composition | 2 |
| code-capability / public | 1 |
| execution-contract / domain | 1 |
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
| platform | 180 |
| task-execution | 74 |
| resource-catalog | 51 |
| runtime-management | 41 |
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
| resource-catalog | 41 |
| runtime-management | 38 |
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
| W9-D | 91 |
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
| legacy-outbound | 3182 |
| legacy-inbound | 1438 |
| infrastructure-external | 279 |
| offered-consumption | 188 |
| temporary-internal-debt | 91 |
| off-dag-offered | 86 |
| authority-type-only | 76 |
| required-implementation | 53 |
| external-layer-debt | 4 |
| provider-mirror | 2 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 3182 |
| legacy-inbound | 1438 |
| temporary-internal-debt | 91 |
| off-dag-offered | 86 |
| no-circular | 6 |
| external-layer-debt | 4 |
| no-util-to-upper | 2 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9 | 2612 |
| W9-D | 762 |
| W4-E1 | 650 |
| W4 | 201 |
| W4-B | 183 |
| W5 | 173 |
| W4-E8 | 130 |
| W4-E9 | 79 |
| W2-D/W3/W5 | 8 |
| W9-E | 6 |
| W4-E10 | 3 |
| W4-E5 | 2 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| resource-catalog | 234 |
| task-execution | 214 |
| collaboration | 122 |
| source-control | 66 |
| identity-access | 62 |
| system-operations | 62 |
| digital-employee | 51 |
| development-automation | 39 |
| runtime-management | 32 |
| knowledge-evolution | 25 |
| execution-contract | 22 |
| memory | 22 |
| event-center | 21 |
| code-capability | 19 |
| integration | 13 |
| intent | 10 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 136 / 1015）

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
| declared-debt | 21 |
| active | 12 |

### 7.2 provider=0 且 consumer=0 的 required port（合计 9）

- `required:development-automation:AgentActionExecutionPort`
- `required:development-automation:DevelopmentCodeHostEffectsPort`
- `required:development-automation:MergeRequestFactsPort`
- `required:development-automation:PipelineEvidencePort`
- `required:development-automation:ReconcilerPorts-legacy-aggregate`
- `required:development-automation:RepositoryUploadPlacementPort`
- `required:development-automation:RequirementAcquisitionPort`
- `required:development-automation:RequirementInteractionPort`
- `required:digital-employee:ReactionExecutionPortV1`
