<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:ff5e5dd91d01763a2bb8ab2e6abf4c9aa68c34f0687b50bd753a72fd72171967`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 1973 |
| `services/` 文件 | 326 |
| `modules/**` 文件 / 非空 context | 1357 / 17 |
| backend 值级 SCC / 全仓值级 SCC | 1 / 3 |
| `KNOWN_VIOLATIONS` | 8 |
| route→DB / transport→DB 值级边 | 0 / 0 |
| route/MCP `AppDeps` consumer 文件 | 0 |
| production ambient wiring seam | 494 |
| background work entries | 369 |
| direct native `setInterval`（call / files） | 23 / 20 |
| direct native timers（全部） | 78 |
| RFC-317 boundary census（inbound / outbound） | 288 / 35 |
| `node_runs INSERT` 站点 | 2 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 494 |
| `architectureExceptions` | 5312 |
| `backgroundJobs` | 369 |
| `crossContextImports` | 6444 |
| `facades` | 326 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 26142 |
| `mutationEntrypoints` | 1949 |
| `nodeRunInsertSites` | 2 |
| `publicSurfaces` | 987 |
| `transactionExternalEffects` | 483 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| task-execution / infrastructure | 152 |
| resource-catalog / infrastructure | 139 |
| task-execution / application | 87 |
| collaboration / infrastructure | 64 |
| task-execution / composition | 56 |
| resource-catalog / application | 54 |
| development-automation / application | 50 |
| development-automation / infrastructure | 45 |
| collaboration / application | 36 |
| integration / infrastructure | 36 |
| development-automation / domain | 33 |
| resource-catalog / composition | 33 |
| task-execution / domain | 29 |
| code-capability / infrastructure | 28 |
| intent / application | 25 |
| identity-access / application | 24 |
| code-capability / application | 20 |
| integration / application | 20 |
| task-execution / engine | 20 |
| integration / composition | 19 |
| system-operations / infrastructure | 19 |
| intent / domain | 18 |
| collaboration / domain | 14 |
| development-automation / composition | 14 |
| digital-employee / application | 13 |
| digital-employee / infrastructure | 13 |
| identity-access / infrastructure | 13 |
| memory / infrastructure | 13 |
| intent / infrastructure | 12 |
| source-control / infrastructure | 12 |
| code-capability / domain | 11 |
| system-operations / application | 11 |
| memory / application | 10 |
| source-control / application | 10 |
| collaboration / composition | 9 |
| knowledge-evolution / domain | 8 |
| memory / domain | 8 |
| development-automation / engine | 7 |
| event-center / infrastructure | 7 |
| intent / composition | 7 |
| resource-catalog / domain | 7 |
| task-execution / public | 7 |
| event-center / application | 6 |
| identity-access / public | 6 |
| memory / public | 6 |
| source-control / domain | 6 |
| code-capability / composition | 5 |
| collaboration / public | 5 |
| digital-employee / composition | 5 |
| digital-employee / public | 5 |
| event-center / public | 5 |
| identity-access / composition | 5 |
| integration / public | 5 |
| resource-catalog / public | 5 |
| source-control / public | 5 |
| development-automation / public | 4 |
| integration / domain | 4 |
| knowledge-evolution / application | 4 |
| system-operations / composition | 4 |
| system-operations / public | 4 |
| digital-employee / domain | 3 |
| event-center / domain | 3 |
| identity-access / domain | 3 |
| knowledge-evolution / infrastructure | 3 |
| knowledge-evolution / public | 3 |
| runtime-management / application | 3 |
| source-control / composition | 3 |
| system-operations / domain | 3 |
| event-center / composition | 2 |
| execution-contract / application | 2 |
| execution-contract / public | 2 |
| intent / ports | 2 |
| intent / public | 2 |
| knowledge-evolution / inbound | 2 |
| runtime-management / infrastructure | 2 |
| runtime-management / public | 2 |
| source-control / ports | 2 |
| task-catalog / composition | 2 |
| code-capability / public | 1 |
| execution-contract / composition | 1 |
| execution-contract / domain | 1 |
| execution-contract / infrastructure | 1 |
| intent / inbound | 1 |
| knowledge-evolution / composition | 1 |
| memory / composition | 1 |
| runtime-management / composition | 1 |
| task-catalog / application | 1 |
| task-catalog / public | 1 |
| task-execution / inbound | 1 |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext | 数量 |
| --- | --- |
| task-execution | 193 |
| platform | 148 |
| identity-access | 52 |
| runtime-management | 45 |
| resource-catalog | 44 |
| collaboration | 30 |
| workspace-insight | 29 |
| integration | 28 |
| source-control | 28 |
| bootstrap | 8 |
| memory | 4 |
| system-operations | 4 |
| digital-employee | 1 |
| event-center | 1 |
| task-catalog | 1 |

## 4. Facade 账本（`facades.json`）

### 4.1 按目标 context

| targetContext | 数量 |
| --- | --- |
| task-execution | 126 |
| runtime-management | 40 |
| resource-catalog | 31 |
| workspace-insight | 29 |
| collaboration | 26 |
| integration | 22 |
| platform | 17 |
| source-control | 17 |
| identity-access | 14 |
| memory | 2 |
| bootstrap | 1 |
| digital-employee | 1 |

### 4.2 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W4-E1 | 125 |
| W4-E4b | 40 |
| W4-C | 31 |
| W4-E5 | 29 |
| W4 | 26 |
| W4-B | 22 |
| W5 | 16 |
| W4-E0 | 14 |
| W9 | 14 |
| W9-E | 5 |
| W4-E2 | 2 |
| W2-D/W3/W5 | 1 |
| W4-E9 | 1 |

## 5. 跨 context 边（`cross-context-imports.json`）

### 5.1 observed edges 按 role

| role | 数量 |
| --- | --- |
| legacy-outbound | 3671 |
| legacy-inbound | 1437 |
| provider-mirror | 444 |
| infrastructure-external | 414 |
| offered-consumption | 188 |
| temporary-internal-debt | 97 |
| off-dag-offered | 94 |
| authority-type-only | 67 |
| required-implementation | 27 |
| external-layer-debt | 5 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 3671 |
| legacy-inbound | 1437 |
| temporary-internal-debt | 97 |
| off-dag-offered | 94 |
| no-circular | 6 |
| external-layer-debt | 5 |
| no-util-to-upper | 2 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9 | 2847 |
| W4-E1 | 874 |
| W4-C | 409 |
| W4-E0 | 238 |
| W4 | 215 |
| W4-B | 186 |
| W5 | 148 |
| W4-E8 | 113 |
| W4-E9 | 61 |
| W4-E2 | 44 |
| W4-E4a | 44 |
| W4-E7 | 44 |
| W4-E4b | 39 |
| W4-E3 | 27 |
| W9-E | 11 |
| W2-D/W3/W5 | 7 |
| W4-E10 | 3 |
| W4-E5 | 2 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| resource-catalog | 250 |
| task-execution | 205 |
| collaboration | 126 |
| identity-access | 65 |
| system-operations | 63 |
| digital-employee | 51 |
| source-control | 45 |
| development-automation | 39 |
| knowledge-evolution | 26 |
| event-center | 22 |
| execution-contract | 22 |
| memory | 22 |
| code-capability | 19 |
| integration | 13 |
| intent | 10 |
| runtime-management | 8 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 142 / 987）

| context | 数量 |
| --- | --- |
| collaboration | 48 |
| digital-employee | 18 |
| task-execution | 15 |
| system-operations | 12 |
| code-capability | 11 |
| event-center | 8 |
| development-automation | 7 |
| source-control | 7 |
| identity-access | 6 |
| integration | 6 |
| execution-contract | 3 |
| task-catalog | 1 |

## 7. Required ports（`cross-context-imports.json` → `requiredPorts`）

### 7.1 按 status

| status | 数量 |
| --- | --- |
| declared-debt | 20 |
| active | 7 |

### 7.2 provider=0 且 consumer=0 的 required port（合计 8）

- `required:development-automation:AgentActionExecutionPort`
- `required:development-automation:DevelopmentCodeHostEffectsPort`
- `required:development-automation:MergeRequestFactsPort`
- `required:development-automation:PipelineEvidencePort`
- `required:development-automation:ReconcilerPorts-legacy-aggregate`
- `required:development-automation:RepositoryUploadPlacementPort`
- `required:development-automation:RequirementAcquisitionPort`
- `required:development-automation:RequirementInteractionPort`
