<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:05937043840ae09bf4da3a2e1a69da9eecf1c7817b4b08c841542379ce2b1959`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 1016 |
| `services/` 文件 | 378 |
| `modules/**` 文件 / 非空 context | 463 / 12 |
| backend 值级 SCC / 全仓值级 SCC | 3 / 5 |
| `KNOWN_VIOLATIONS` | 31 |
| route→DB / transport→DB 值级边 | 15 / 2 |
| route/MCP `AppDeps` consumer 文件 | 48 |
| production ambient wiring seam | 456 |
| background work entries | 267 |
| direct native `setInterval`（call / files） | 24 / 21 |
| direct native timers（全部） | 72 |
| RFC-317 boundary census（inbound / outbound） | 52 / 23 |
| `node_runs INSERT` 站点 | 2 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 456 |
| `architectureExceptions` | 1462 |
| `backgroundJobs` | 267 |
| `crossContextImports` | 1504 |
| `facades` | 378 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 18991 |
| `mutationEntrypoints` | 1027 |
| `nodeRunInsertSites` | 2 |
| `publicSurfaces` | 405 |
| `transactionExternalEffects` | 281 |

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
| development-automation / composition | 12 |
| code-capability / domain | 11 |
| task-execution / infrastructure | 10 |
| collaboration / infrastructure | 9 |
| integration / application | 9 |
| digital-employee / application | 8 |
| integration / composition | 8 |
| integration / infrastructure | 8 |
| development-automation / engine | 7 |
| digital-employee / infrastructure | 6 |
| event-center / application | 6 |
| identity-access / public | 6 |
| source-control / application | 6 |
| source-control / domain | 6 |
| code-capability / application | 5 |
| collaboration / composition | 5 |
| collaboration / public | 5 |
| event-center / public | 5 |
| task-execution / public | 5 |
| development-automation / public | 4 |
| digital-employee / public | 4 |
| event-center / infrastructure | 4 |
| identity-access / infrastructure | 4 |
| source-control / public | 4 |
| digital-employee / composition | 3 |
| event-center / domain | 3 |
| identity-access / domain | 3 |
| integration / domain | 3 |
| integration / public | 3 |
| source-control / infrastructure | 3 |
| code-capability / infrastructure | 2 |
| digital-employee / domain | 2 |
| event-center / composition | 2 |
| execution-contract / application | 2 |
| execution-contract / public | 2 |
| identity-access / composition | 2 |
| source-control / composition | 2 |
| task-catalog / composition | 2 |
| code-capability / public | 1 |
| execution-contract / composition | 1 |
| execution-contract / domain | 1 |
| execution-contract / infrastructure | 1 |
| intent / domain | 1 |
| source-control / ports | 1 |
| task-catalog / application | 1 |
| task-catalog / public | 1 |
| task-execution / inbound | 1 |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext | 数量 |
| --- | --- |
| task-execution | 200 |
| resource-catalog | 77 |
| runtime-management | 42 |
| identity-access | 38 |
| collaboration | 30 |
| source-control | 30 |
| workspace-insight | 29 |
| integration | 28 |
| platform | 27 |
| system-operations | 18 |
| intent | 16 |
| memory | 9 |
| knowledge-evolution | 4 |
| bootstrap | 2 |
| digital-employee | 1 |
| event-center | 1 |
| task-catalog | 1 |

## 4. Facade 账本（`facades.json`）

### 4.1 按目标 context

| targetContext | 数量 |
| --- | --- |
| task-execution | 128 |
| resource-catalog | 64 |
| runtime-management | 40 |
| workspace-insight | 29 |
| collaboration | 26 |
| integration | 22 |
| source-control | 18 |
| intent | 15 |
| identity-access | 14 |
| system-operations | 10 |
| memory | 8 |
| knowledge-evolution | 3 |
| digital-employee | 1 |

### 4.2 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W4/W9 | 360 |
| W5 | 18 |

## 5. 跨 context 边（`cross-context-imports.json`）

### 5.1 observed edges 按 role

| role | 数量 |
| --- | --- |
| legacy-outbound | 979 |
| legacy-inbound | 363 |
| external-layer-debt | 75 |
| offered-consumption | 64 |
| temporary-internal-debt | 15 |
| required-implementation | 8 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 979 |
| legacy-inbound | 363 |
| external-layer-debt | 75 |
| no-routes-to-db | 15 |
| temporary-internal-debt | 15 |
| no-circular | 10 |
| no-transport-to-db | 2 |
| no-util-to-upper | 2 |
| no-services-to-routes | 1 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W4/W9 | 1353 |
| W5 | 61 |
| RFC-owner-cutover | 27 |
| W4/W5 | 15 |
| W3 | 2 |
| W4 | 2 |
| W4-A | 1 |
| W9 | 1 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| task-execution | 129 |
| collaboration | 77 |
| identity-access | 45 |
| digital-employee | 44 |
| source-control | 24 |
| event-center | 22 |
| execution-contract | 22 |
| code-capability | 19 |
| development-automation | 11 |
| integration | 11 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 207 / 405）

| context | 数量 |
| --- | --- |
| collaboration | 46 |
| digital-employee | 30 |
| identity-access | 30 |
| task-execution | 29 |
| code-capability | 19 |
| source-control | 18 |
| event-center | 17 |
| execution-contract | 7 |
| integration | 6 |
| development-automation | 4 |
| task-catalog | 1 |

## 7. Required ports（`cross-context-imports.json` → `requiredPorts`）

### 7.1 按 status

| status | 数量 |
| --- | --- |
| declared-debt | 20 |
| active | 3 |

### 7.2 provider=0 且 consumer=0 的 required port（合计 8）

- `required:development-automation:AgentActionExecutionPort`
- `required:development-automation:DevelopmentCodeHostEffectsPort`
- `required:development-automation:MergeRequestFactsPort`
- `required:development-automation:PipelineEvidencePort`
- `required:development-automation:ReconcilerPorts-legacy-aggregate`
- `required:development-automation:RepositoryUploadPlacementPort`
- `required:development-automation:RequirementAcquisitionPort`
- `required:development-automation:RequirementInteractionPort`

