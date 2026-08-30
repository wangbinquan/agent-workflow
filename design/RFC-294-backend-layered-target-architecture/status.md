<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:02e5030694d81e2b6a42d471be55f58942383be5906adc7b1ca7647b24eb6fd0`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 1073 |
| `services/` 文件 | 381 |
| `modules/**` 文件 / 非空 context | 517 / 14 |
| backend 值级 SCC / 全仓值级 SCC | 3 / 5 |
| `KNOWN_VIOLATIONS` | 29 |
| route→DB / transport→DB 值级边 | 15 / 2 |
| route/MCP `AppDeps` consumer 文件 | 46 |
| production ambient wiring seam | 457 |
| background work entries | 273 |
| direct native `setInterval`（call / files） | 24 / 21 |
| direct native timers（全部） | 72 |
| RFC-317 boundary census（inbound / outbound） | 59 / 23 |
| `node_runs INSERT` 站点 | 2 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 457 |
| `architectureExceptions` | 1759 |
| `backgroundJobs` | 273 |
| `crossContextImports` | 1803 |
| `facades` | 381 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 19677 |
| `mutationEntrypoints` | 1104 |
| `nodeRunInsertSites` | 2 |
| `publicSurfaces` | 541 |
| `transactionExternalEffects` | 285 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| task-execution / application | 43 |
| development-automation / application | 38 |
| development-automation / domain | 33 |
| development-automation / infrastructure | 28 |
| task-execution / composition | 23 |
| task-execution / domain | 23 |
| collaboration / application | 21 |
| identity-access / application | 20 |
| task-execution / engine | 20 |
| collaboration / domain | 14 |
| development-automation / composition | 13 |
| code-capability / domain | 11 |
| integration / application | 10 |
| integration / composition | 10 |
| resource-catalog / application | 10 |
| task-execution / infrastructure | 10 |
| collaboration / infrastructure | 9 |
| digital-employee / application | 9 |
| intent / domain | 9 |
| integration / infrastructure | 8 |
| development-automation / engine | 7 |
| resource-catalog / infrastructure | 7 |
| digital-employee / infrastructure | 6 |
| event-center / application | 6 |
| identity-access / public | 6 |
| source-control / application | 6 |
| source-control / domain | 6 |
| code-capability / application | 5 |
| collaboration / composition | 5 |
| collaboration / public | 5 |
| event-center / public | 5 |
| resource-catalog / public | 5 |
| task-execution / public | 5 |
| development-automation / public | 4 |
| digital-employee / composition | 4 |
| digital-employee / public | 4 |
| event-center / infrastructure | 4 |
| identity-access / infrastructure | 4 |
| resource-catalog / domain | 4 |
| source-control / public | 4 |
| system-operations / public | 4 |
| event-center / domain | 3 |
| identity-access / domain | 3 |
| integration / domain | 3 |
| integration / public | 3 |
| source-control / infrastructure | 3 |
| system-operations / application | 3 |
| code-capability / infrastructure | 2 |
| digital-employee / domain | 2 |
| event-center / composition | 2 |
| execution-contract / application | 2 |
| execution-contract / public | 2 |
| identity-access / composition | 2 |
| resource-catalog / composition | 2 |
| source-control / composition | 2 |
| system-operations / domain | 2 |
| system-operations / infrastructure | 2 |
| task-catalog / composition | 2 |
| code-capability / public | 1 |
| execution-contract / composition | 1 |
| execution-contract / domain | 1 |
| execution-contract / infrastructure | 1 |
| source-control / ports | 1 |
| system-operations / composition | 1 |
| task-catalog / application | 1 |
| task-catalog / public | 1 |
| task-execution / inbound | 1 |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext | 数量 |
| --- | --- |
| task-execution | 191 |
| resource-catalog | 76 |
| platform | 47 |
| runtime-management | 42 |
| identity-access | 38 |
| collaboration | 30 |
| source-control | 29 |
| workspace-insight | 29 |
| integration | 28 |
| intent | 18 |
| memory | 9 |
| bootstrap | 8 |
| knowledge-evolution | 4 |
| system-operations | 4 |
| digital-employee | 1 |
| event-center | 1 |
| task-catalog | 1 |

## 4. Facade 账本（`facades.json`）

### 4.1 按目标 context

| targetContext | 数量 |
| --- | --- |
| task-execution | 122 |
| resource-catalog | 63 |
| runtime-management | 40 |
| workspace-insight | 29 |
| collaboration | 26 |
| integration | 22 |
| source-control | 18 |
| intent | 17 |
| platform | 17 |
| identity-access | 14 |
| memory | 8 |
| knowledge-evolution | 3 |
| bootstrap | 1 |
| digital-employee | 1 |

### 4.2 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W4-E1 | 121 |
| W4-C | 63 |
| W4-E4b | 40 |
| W4-E5 | 29 |
| W4 | 26 |
| W4-B | 22 |
| W4-E4a | 17 |
| W5 | 17 |
| W4-E0 | 14 |
| W9 | 14 |
| W4-E2 | 8 |
| W9-E | 5 |
| W4-E3 | 3 |
| W2-D/W3/W5 | 1 |
| W4-E9 | 1 |

## 5. 跨 context 边（`cross-context-imports.json`）

### 5.1 observed edges 按 role

| role | 数量 |
| --- | --- |
| legacy-outbound | 1083 |
| legacy-inbound | 550 |
| external-layer-debt | 83 |
| offered-consumption | 48 |
| required-implementation | 13 |
| authority-type-only | 12 |
| off-dag-offered | 11 |
| temporary-internal-debt | 3 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 1083 |
| legacy-inbound | 550 |
| external-layer-debt | 83 |
| no-routes-to-db | 15 |
| off-dag-offered | 11 |
| no-circular | 10 |
| temporary-internal-debt | 3 |
| no-transport-to-db | 2 |
| no-util-to-upper | 2 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W4-E1 | 799 |
| W4-C | 154 |
| W4-E0 | 127 |
| W4 | 118 |
| W4-E8 | 106 |
| W9 | 103 |
| W5 | 94 |
| W4-E9 | 85 |
| W4-B | 79 |
| RFC-owner-cutover | 27 |
| W4-E4a | 25 |
| W4-E4b | 14 |
| W4-E7 | 14 |
| W9-E | 8 |
| W4-E10 | 4 |
| W3 | 2 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| task-execution | 129 |
| resource-catalog | 89 |
| collaboration | 77 |
| identity-access | 59 |
| digital-employee | 44 |
| system-operations | 33 |
| source-control | 24 |
| event-center | 22 |
| execution-contract | 22 |
| code-capability | 19 |
| development-automation | 11 |
| integration | 11 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 140 / 541）

| context | 数量 |
| --- | --- |
| resource-catalog | 30 |
| collaboration | 20 |
| digital-employee | 17 |
| code-capability | 15 |
| system-operations | 12 |
| identity-access | 11 |
| task-execution | 9 |
| event-center | 8 |
| source-control | 6 |
| integration | 5 |
| development-automation | 3 |
| execution-contract | 3 |
| task-catalog | 1 |

## 7. Required ports（`cross-context-imports.json` → `requiredPorts`）

### 7.1 按 status

| status | 数量 |
| --- | --- |
| declared-debt | 18 |
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
