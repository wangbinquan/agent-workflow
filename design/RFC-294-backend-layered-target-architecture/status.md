<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:bd3417c2067f801ea3b3e653795b3d377d396e53ff14a36fd948dba400506973`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 1875 |
| `services/` 文件 | 354 |
| `modules/**` 文件 / 非空 context | 1243 / 16 |
| backend 值级 SCC / 全仓值级 SCC | 2 / 4 |
| `KNOWN_VIOLATIONS` | 8 |
| route→DB / transport→DB 值级边 | 0 / 0 |
| route/MCP `AppDeps` consumer 文件 | 0 |
| production ambient wiring seam | 493 |
| background work entries | 365 |
| direct native `setInterval`（call / files） | 24 / 21 |
| direct native timers（全部） | 78 |
| RFC-317 boundary census（inbound / outbound） | 404 / 12 |
| `node_runs INSERT` 站点 | 2 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 493 |
| `architectureExceptions` | 6028 |
| `backgroundJobs` | 365 |
| `crossContextImports` | 6231 |
| `facades` | 354 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 25580 |
| `mutationEntrypoints` | 1906 |
| `nodeRunInsertSites` | 2 |
| `publicSurfaces` | 934 |
| `transactionExternalEffects` | 476 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| resource-catalog / infrastructure | 135 |
| task-execution / infrastructure | 129 |
| task-execution / application | 83 |
| collaboration / infrastructure | 65 |
| task-execution / composition | 53 |
| resource-catalog / application | 52 |
| development-automation / application | 50 |
| development-automation / infrastructure | 45 |
| collaboration / application | 36 |
| integration / infrastructure | 36 |
| development-automation / domain | 33 |
| resource-catalog / composition | 31 |
| code-capability / infrastructure | 28 |
| identity-access / application | 24 |
| task-execution / domain | 24 |
| code-capability / application | 20 |
| integration / application | 20 |
| task-execution / engine | 20 |
| integration / composition | 19 |
| system-operations / infrastructure | 19 |
| memory / infrastructure | 15 |
| collaboration / domain | 14 |
| development-automation / composition | 14 |
| digital-employee / application | 13 |
| digital-employee / infrastructure | 13 |
| identity-access / infrastructure | 13 |
| intent / infrastructure | 12 |
| code-capability / domain | 11 |
| source-control / infrastructure | 11 |
| system-operations / application | 11 |
| intent / domain | 9 |
| source-control / application | 9 |
| collaboration / composition | 7 |
| development-automation / engine | 7 |
| event-center / infrastructure | 7 |
| event-center / application | 6 |
| identity-access / public | 6 |
| intent / composition | 6 |
| memory / public | 6 |
| source-control / domain | 6 |
| task-execution / public | 6 |
| code-capability / composition | 5 |
| collaboration / public | 5 |
| digital-employee / composition | 5 |
| digital-employee / public | 5 |
| event-center / public | 5 |
| identity-access / composition | 5 |
| integration / public | 5 |
| memory / application | 5 |
| resource-catalog / domain | 5 |
| resource-catalog / public | 5 |
| source-control / public | 5 |
| development-automation / public | 4 |
| integration / domain | 4 |
| intent / application | 4 |
| system-operations / composition | 4 |
| system-operations / public | 4 |
| digital-employee / domain | 3 |
| event-center / domain | 3 |
| identity-access / domain | 3 |
| runtime-management / application | 3 |
| source-control / composition | 3 |
| system-operations / domain | 3 |
| event-center / composition | 2 |
| execution-contract / application | 2 |
| execution-contract / public | 2 |
| intent / public | 2 |
| memory / composition | 2 |
| runtime-management / infrastructure | 2 |
| runtime-management / public | 2 |
| source-control / ports | 2 |
| task-catalog / composition | 2 |
| code-capability / public | 1 |
| execution-contract / composition | 1 |
| execution-contract / domain | 1 |
| execution-contract / infrastructure | 1 |
| runtime-management / composition | 1 |
| task-catalog / application | 1 |
| task-catalog / public | 1 |
| task-execution / inbound | 1 |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext | 数量 |
| --- | --- |
| task-execution | 204 |
| platform | 125 |
| identity-access | 52 |
| resource-catalog | 45 |
| runtime-management | 45 |
| collaboration | 30 |
| workspace-insight | 29 |
| integration | 28 |
| source-control | 28 |
| intent | 19 |
| memory | 9 |
| bootstrap | 8 |
| system-operations | 4 |
| knowledge-evolution | 3 |
| digital-employee | 1 |
| event-center | 1 |
| task-catalog | 1 |

## 4. Facade 账本（`facades.json`）

### 4.1 按目标 context

| targetContext | 数量 |
| --- | --- |
| task-execution | 127 |
| runtime-management | 40 |
| resource-catalog | 32 |
| workspace-insight | 29 |
| collaboration | 26 |
| integration | 22 |
| intent | 18 |
| platform | 17 |
| source-control | 17 |
| identity-access | 14 |
| memory | 8 |
| knowledge-evolution | 2 |
| bootstrap | 1 |
| digital-employee | 1 |

### 4.2 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W4-E1 | 126 |
| W4-E4b | 40 |
| W4-C | 32 |
| W4-E5 | 29 |
| W4 | 26 |
| W4-B | 22 |
| W4-E4a | 18 |
| W5 | 16 |
| W4-E0 | 14 |
| W9 | 14 |
| W4-E2 | 8 |
| W9-E | 5 |
| W4-E3 | 2 |
| W2-D/W3/W5 | 1 |
| W4-E9 | 1 |

## 5. 跨 context 边（`cross-context-imports.json`）

### 5.1 observed edges 按 role

| role | 数量 |
| --- | --- |
| legacy-outbound | 3896 |
| legacy-inbound | 1536 |
| external-layer-debt | 398 |
| offered-consumption | 120 |
| temporary-internal-debt | 106 |
| off-dag-offered | 84 |
| authority-type-only | 63 |
| required-implementation | 28 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 3896 |
| legacy-inbound | 1536 |
| external-layer-debt | 398 |
| temporary-internal-debt | 106 |
| off-dag-offered | 84 |
| no-circular | 6 |
| no-util-to-upper | 2 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W4-E1 | 2497 |
| W4-C | 914 |
| W9 | 515 |
| W4-E0 | 369 |
| W4 | 355 |
| W4-B | 278 |
| W5 | 241 |
| W4-E4a | 218 |
| W4-E8 | 197 |
| W4-E9 | 164 |
| W4-E2 | 96 |
| W4-E4b | 76 |
| W4-E7 | 65 |
| W4-E3 | 18 |
| W9-E | 10 |
| RFC-owner-cutover | 8 |
| W4-E10 | 7 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| resource-catalog | 241 |
| task-execution | 186 |
| collaboration | 125 |
| identity-access | 66 |
| system-operations | 63 |
| digital-employee | 51 |
| development-automation | 39 |
| source-control | 37 |
| intent | 31 |
| event-center | 22 |
| execution-contract | 22 |
| code-capability | 19 |
| integration | 13 |
| memory | 10 |
| runtime-management | 8 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 149 / 934）

| context | 数量 |
| --- | --- |
| collaboration | 48 |
| digital-employee | 18 |
| task-execution | 16 |
| system-operations | 12 |
| code-capability | 11 |
| event-center | 8 |
| development-automation | 7 |
| source-control | 7 |
| identity-access | 6 |
| integration | 6 |
| intent | 6 |
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
