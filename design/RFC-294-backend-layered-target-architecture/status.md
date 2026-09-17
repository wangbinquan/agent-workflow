<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:a1395e6918fc4ec0efa4a1745819c07929437262ae10466c01523338fd9a4727`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 1773 |
| `services/` 文件 | 313 |
| `modules/**` 文件 / 非空 context | 1182 / 17 |
| backend 值级 SCC / 全仓值级 SCC | 1 / 3 |
| `KNOWN_VIOLATIONS` | 8 |
| route→DB / transport→DB 值级边 | 0 / 0 |
| route/MCP `AppDeps` consumer 文件 | 0 |
| production ambient wiring seam | 494 |
| background work entries | 331 |
| direct native `setInterval`（call / files） | 22 / 19 |
| direct native timers（全部） | 77 |
| RFC-317 boundary census（inbound / outbound） | 252 / 33 |
| `node_runs INSERT` 站点 | 1 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 494 |
| `architectureExceptions` | 4564 |
| `backgroundJobs` | 331 |
| `crossContextImports` | 5081 |
| `facades` | 313 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 24681 |
| `mutationEntrypoints` | 1675 |
| `nodeRunInsertSites` | 1 |
| `publicSurfaces` | 960 |
| `transactionExternalEffects` | 252 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| resource-catalog / infrastructure | 104 |
| task-execution / infrastructure | 96 |
| task-execution / application | 87 |
| resource-catalog / application | 55 |
| task-execution / composition | 54 |
| development-automation / application | 51 |
| collaboration / infrastructure | 46 |
| collaboration / application | 35 |
| development-automation / domain | 33 |
| development-automation / infrastructure | 33 |
| resource-catalog / composition | 33 |
| task-execution / domain | 31 |
| intent / application | 25 |
| identity-access / application | 24 |
| integration / infrastructure | 22 |
| code-capability / application | 20 |
| integration / application | 20 |
| task-execution / engine | 20 |
| integration / composition | 18 |
| intent / domain | 18 |
| system-operations / infrastructure | 18 |
| code-capability / infrastructure | 15 |
| collaboration / domain | 14 |
| development-automation / composition | 14 |
| digital-employee / application | 13 |
| code-capability / domain | 11 |
| system-operations / application | 11 |
| memory / application | 10 |
| source-control / application | 10 |
| identity-access / infrastructure | 9 |
| resource-catalog / domain | 9 |
| source-control / infrastructure | 9 |
| collaboration / composition | 8 |
| digital-employee / infrastructure | 8 |
| intent / infrastructure | 8 |
| knowledge-evolution / domain | 8 |
| memory / domain | 8 |
| development-automation / engine | 7 |
| intent / composition | 7 |
| memory / infrastructure | 7 |
| task-execution / public | 7 |
| event-center / application | 6 |
| identity-access / public | 6 |
| memory / public | 6 |
| source-control / domain | 6 |
| collaboration / public | 5 |
| digital-employee / composition | 5 |
| digital-employee / public | 5 |
| event-center / public | 5 |
| identity-access / composition | 5 |
| integration / public | 5 |
| resource-catalog / public | 5 |
| source-control / public | 5 |
| system-operations / composition | 5 |
| code-capability / composition | 4 |
| development-automation / public | 4 |
| event-center / infrastructure | 4 |
| integration / domain | 4 |
| knowledge-evolution / application | 4 |
| system-operations / public | 4 |
| digital-employee / domain | 3 |
| event-center / domain | 3 |
| identity-access / domain | 3 |
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
| knowledge-evolution / infrastructure | 2 |
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
| runtime-management / infrastructure | 1 |
| task-catalog / application | 1 |
| task-catalog / public | 1 |
| task-execution / inbound | 1 |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext | 数量 |
| --- | --- |
| task-execution | 184 |
| platform | 144 |
| identity-access | 44 |
| runtime-management | 44 |
| resource-catalog | 43 |
| collaboration | 30 |
| workspace-insight | 29 |
| source-control | 28 |
| integration | 27 |
| bootstrap | 8 |
| system-operations | 4 |
| memory | 3 |
| digital-employee | 1 |
| event-center | 1 |
| task-catalog | 1 |

## 4. Facade 账本（`facades.json`）

### 4.1 按目标 context

| targetContext | 数量 |
| --- | --- |
| task-execution | 117 |
| runtime-management | 39 |
| resource-catalog | 30 |
| workspace-insight | 29 |
| collaboration | 26 |
| integration | 21 |
| platform | 17 |
| source-control | 17 |
| identity-access | 14 |
| bootstrap | 1 |
| digital-employee | 1 |
| memory | 1 |

### 4.2 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W4-E1 | 116 |
| W4-E4b | 39 |
| W4-C | 30 |
| W4-E5 | 29 |
| W4 | 26 |
| W4-B | 21 |
| W5 | 16 |
| W4-E0 | 14 |
| W9 | 14 |
| W9-E | 5 |
| W2-D/W3/W5 | 1 |
| W4-E2 | 1 |
| W4-E9 | 1 |

## 5. 跨 context 边（`cross-context-imports.json`）

### 5.1 observed edges 按 role

| role | 数量 |
| --- | --- |
| legacy-outbound | 3014 |
| legacy-inbound | 1359 |
| infrastructure-external | 269 |
| offered-consumption | 160 |
| temporary-internal-debt | 92 |
| off-dag-offered | 88 |
| authority-type-only | 58 |
| required-implementation | 22 |
| provider-mirror | 16 |
| external-layer-debt | 3 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 3014 |
| legacy-inbound | 1359 |
| temporary-internal-debt | 92 |
| off-dag-offered | 88 |
| no-circular | 6 |
| external-layer-debt | 3 |
| no-util-to-upper | 2 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9 | 2312 |
| W4-E1 | 799 |
| W4-C | 327 |
| W4-E0 | 213 |
| W4 | 193 |
| W4-B | 180 |
| W5 | 154 |
| W4-E8 | 110 |
| W4-E9 | 60 |
| W4-E4a | 50 |
| W4-E7 | 48 |
| W4-E2 | 38 |
| W4-E4b | 35 |
| W4-E3 | 27 |
| W2-D/W3/W5 | 7 |
| W9-E | 6 |
| W4-E10 | 3 |
| W4-E5 | 2 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| resource-catalog | 225 |
| task-execution | 213 |
| collaboration | 122 |
| identity-access | 62 |
| system-operations | 62 |
| digital-employee | 51 |
| source-control | 44 |
| development-automation | 39 |
| knowledge-evolution | 25 |
| event-center | 22 |
| execution-contract | 22 |
| memory | 22 |
| code-capability | 19 |
| integration | 13 |
| intent | 10 |
| runtime-management | 8 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 136 / 960）

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
