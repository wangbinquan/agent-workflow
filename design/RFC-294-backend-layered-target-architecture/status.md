<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->

# RFC-294 架构现状（生成）

- 数据来源：`architecture/current-report.json` 及同批 canonical manifests（sourceDigest `sha256:b66298b7f477d8fe32ef1c4408d15122c08c211a3db0808bd438b14f6136bf60`）
- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。
- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。

## 1. 核心指标（`current-report.json` → `metrics`）

| 指标 | 当前值 |
| --- | --- |
| backend production TS 文件 | 2310 |
| `services/` 文件 | 271 |
| `modules/**` 文件 / 非空 context | 1743 / 18 |
| backend 值级 SCC / 全仓值级 SCC | 0 / 0 |
| `KNOWN_VIOLATIONS` | 0 |
| route→DB / transport→DB 值级边 | 0 / 0 |
| route/MCP `AppDeps` consumer 文件 | 0 |
| production ambient wiring seam | 512 |
| background work entries | 367 |
| direct native `setInterval`（call / files） | 15 / 13 |
| direct native timers（全部） | 78 |
| RFC-317 boundary census（inbound / outbound） | 295 / 42 |
| `node_runs INSERT` 站点 | 1 |
| first-party unresolved import | 0 |

## 2. 账本分母（`manifestDenominators`）

| 账本 | 条目数 |
| --- | --- |
| `ambientWiring` | 512 |
| `architectureExceptions` | 6288 |
| `backgroundJobs` | 367 |
| `crossContextImports` | 7164 |
| `facades` | 271 |
| `governedFieldSurfaces` | 5 |
| `moduleSymbolOwners` | 27395 |
| `mutationEntrypoints` | 2004 |
| `nodeRunInsertSites` | 1 |
| `publicSurfaces` | 1173 |
| `transactionExternalEffects` | 281 |

## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）

### 3.1 `modules/**` 文件按 context / layer

| context / layer | 数量 |
| --- | --- |
| task-execution / infrastructure | 151 |
| resource-catalog / infrastructure | 137 |
| task-execution / application | 136 |
| task-execution / composition | 103 |
| resource-catalog / application | 78 |
| development-automation / application | 62 |
| source-control / infrastructure | 55 |
| collaboration / infrastructure | 51 |
| development-automation / infrastructure | 51 |
| system-operations / infrastructure | 48 |
| resource-catalog / composition | 42 |
| collaboration / application | 39 |
| task-execution / domain | 35 |
| integration / application | 34 |
| development-automation / domain | 32 |
| source-control / application | 32 |
| intent / application | 30 |
| integration / infrastructure | 28 |
| system-operations / application | 28 |
| identity-access / application | 25 |
| development-automation / composition | 23 |
| runtime-management / infrastructure | 23 |
| runtime-management / application | 22 |
| integration / composition | 21 |
| source-control / composition | 20 |
| task-execution / engine | 20 |
| code-capability / application | 18 |
| intent / domain | 18 |
| system-operations / composition | 18 |
| identity-access / infrastructure | 17 |
| collaboration / domain | 15 |
| digital-employee / application | 15 |
| code-capability / infrastructure | 13 |
| runtime-management / composition | 12 |
| digital-employee / infrastructure | 11 |
| memory / application | 11 |
| source-control / domain | 11 |
| event-center / application | 10 |
| intent / composition | 10 |
| intent / infrastructure | 10 |
| resource-catalog / domain | 10 |
| code-capability / domain | 9 |
| collaboration / composition | 9 |
| memory / domain | 9 |
| knowledge-evolution / domain | 8 |
| run-observability / application | 8 |
| digital-employee / composition | 7 |
| event-center / infrastructure | 7 |
| integration / domain | 7 |
| memory / infrastructure | 7 |
| task-execution / public | 7 |
| development-automation / engine | 6 |
| digital-employee / domain | 6 |
| identity-access / composition | 6 |
| identity-access / public | 6 |
| memory / public | 6 |
| collaboration / public | 5 |
| event-center / composition | 5 |
| integration / public | 5 |
| resource-catalog / public | 5 |
| source-control / public | 5 |
| system-operations / domain | 5 |
| system-operations / public | 5 |
| code-capability / composition | 4 |
| development-automation / public | 4 |
| digital-employee / public | 4 |
| event-center / domain | 4 |
| event-center / public | 4 |
| knowledge-evolution / application | 4 |
| runtime-management / public | 4 |
| execution-contract / application | 3 |
| identity-access / domain | 3 |
| intent / public | 3 |
| knowledge-evolution / public | 3 |
| run-observability / domain | 3 |
| execution-contract / composition | 2 |
| execution-contract / public | 2 |
| intent / ports | 2 |
| knowledge-evolution / inbound | 2 |
| knowledge-evolution / infrastructure | 2 |
| run-observability / infrastructure | 2 |
| run-observability / public | 2 |
| runtime-management / domain | 2 |
| source-control / ports | 2 |
| task-catalog / composition | 2 |
| code-capability / public | 1 |
| execution-contract / domain | 1 |
| identity-access / inbound | 1 |
| integration / inbound | 1 |
| intent / inbound | 1 |
| knowledge-evolution / composition | 1 |
| memory / composition | 1 |
| run-observability / composition | 1 |
| run-observability / inbound | 1 |
| task-catalog / application | 1 |
| task-catalog / public | 1 |
| task-execution / inbound | 1 |

### 3.2 legacy backend 文件按目标 context（迁移 backlog）

| targetContext | 数量 |
| --- | --- |
| platform | 208 |
| task-execution | 70 |
| resource-catalog | 51 |
| runtime-management | 45 |
| identity-access | 36 |
| workspace-insight | 31 |
| bootstrap | 30 |
| integration | 27 |
| source-control | 24 |
| collaboration | 21 |
| system-operations | 9 |
| development-automation | 7 |
| digital-employee | 3 |
| memory | 2 |
| event-center | 1 |
| execution-contract | 1 |
| task-catalog | 1 |

## 4. Facade 账本（`facades.json`）

### 4.1 按目标 context

| targetContext | 数量 |
| --- | --- |
| task-execution | 65 |
| runtime-management | 42 |
| resource-catalog | 41 |
| workspace-insight | 31 |
| integration | 21 |
| platform | 21 |
| collaboration | 17 |
| source-control | 15 |
| identity-access | 7 |
| bootstrap | 4 |
| system-operations | 3 |
| development-automation | 2 |
| digital-employee | 2 |

### 4.2 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9-D | 93 |
| W4-E1 | 64 |
| W4-E5 | 31 |
| W4-B | 21 |
| W9 | 21 |
| W4 | 17 |
| W5 | 14 |
| W9-E | 5 |
| W4-E8 | 2 |
| W4-E9 | 2 |
| W2-D/W3/W5 | 1 |

## 5. 跨 context 边（`cross-context-imports.json`）

### 5.1 observed edges 按 role

| role | 数量 |
| --- | --- |
| legacy-outbound | 4057 |
| legacy-inbound | 1987 |
| offered-consumption | 377 |
| infrastructure-external | 325 |
| off-dag-offered | 120 |
| temporary-internal-debt | 118 |
| required-implementation | 92 |
| authority-type-only | 80 |
| external-layer-debt | 6 |
| provider-mirror | 2 |

### 5.2 exact exceptions 按 rule

| rule | 数量 |
| --- | --- |
| legacy-outbound | 4057 |
| legacy-inbound | 1987 |
| off-dag-offered | 120 |
| temporary-internal-debt | 118 |
| external-layer-debt | 6 |

### 5.3 exact exceptions 按清偿波次

| removeAfterWave | 数量 |
| --- | --- |
| W9 | 3416 |
| W9-D | 1154 |
| W4-E1 | 793 |
| W5 | 228 |
| W4-B | 206 |
| W4 | 201 |
| W4-E8 | 176 |
| W4-E9 | 87 |
| W9-E | 8 |
| W2-D/W3/W5 | 7 |
| RFC-371 | 6 |
| W4-E10 | 3 |
| W4-E5 | 3 |

## 6. Public surface（`public-surfaces.json`）

### 6.1 public symbol 按 context

| context | 数量 |
| --- | --- |
| task-execution | 295 |
| resource-catalog | 245 |
| source-control | 108 |
| system-operations | 83 |
| collaboration | 77 |
| identity-access | 65 |
| runtime-management | 65 |
| development-automation | 49 |
| digital-employee | 35 |
| integration | 26 |
| knowledge-evolution | 24 |
| execution-contract | 22 |
| memory | 22 |
| event-center | 20 |
| code-capability | 19 |
| intent | 12 |
| run-observability | 5 |
| task-catalog | 1 |

### 6.2 零生产 consumer 的 public symbol 按 context（合计 115 / 1173）

| context | 数量 |
| --- | --- |
| task-execution | 28 |
| collaboration | 13 |
| digital-employee | 13 |
| system-operations | 12 |
| code-capability | 11 |
| source-control | 8 |
| development-automation | 7 |
| event-center | 7 |
| identity-access | 7 |
| integration | 5 |
| execution-contract | 3 |
| task-catalog | 1 |

## 7. Required ports（`cross-context-imports.json` → `requiredPorts`）

### 7.1 按 status

| status | 数量 |
| --- | --- |
| active | 21 |
| declared-debt | 13 |

### 7.2 provider=0 且 consumer=0 的 required port（合计 1）

- `required:development-automation:ReconcilerPorts-legacy-aggregate`
