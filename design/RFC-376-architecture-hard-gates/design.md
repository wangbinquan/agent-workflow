# RFC-376 设计：少量硬结构门 + 按需报告

基线 HEAD `b76a88e70`。`TA/` = `packages/backend/tests/architecture/`，`T/` = `packages/backend/tests/`。行号仅作定位提示。

## 1. 现状机制

- **全局 `sourceDigest`**：`TA/rfc294Canonical.ts` L4079-4096 哈希全部 backend / shared / frontend 源码加 `.dependency-cruiser.cjs`
  与 `scripts/depcheck.ts`，结果写进 8 份 canonical JSON、4 份治理 JSON 的 `canonicalProjection` 块与 status.md 第 5 行。
- **provenance pin**：`PROVENANCE_ARTIFACTS`（L220-225）由 `scripts/architecture-census.ts` L182-196 写入；N1a 用
  `merge-base --is-ancestor` 检查，需要全历史。
- **N1 计数**：`n1LedgerSpecs`（L4496-4599）把计数写进 `ledger-baselines.json`，由 T16（等于源码）、T17（相对 HEAD~1 只降，
  否则需一次性 `allowGrowth` 与下一笔退役）把守。
- **行号 id**：ambient `ambient:<file>#<callee>:<line>`（L3909-3913）、background `$setTimeout:<line>`（L3846-3847）、
  `node-runs-insert:<file>#<line>`（L3495）。
- **legacy owner 登记表**：L393-854 共 458 项，`targetContextFor`（L871-894）遇未登记文件直接抛错。
- **工作树依赖**：生成器从工作树 import `scripts/depcheck` 的 `KNOWN_VIOLATIONS`（L27）与
  `modules/task-execution/domain/codeHostRecovery`（L28-31），所以即使 census 用 `--source-ref`，工作树的未提交改动也会进入投影。

## 2. 目标形态

### 2.1 `architecture/` 目录

- **删除**（约 35.4 MB）：`mutation-entrypoints.json`、`transaction-external-effects.json`、`background-jobs.json`、
  `cross-context-imports.json`、`facades.json`、`public-surfaces.json`、`module-symbol-owners.json`、`current-report.json`、
  `ledger-baselines.json`。这 9 个文件名加入根 `.gitignore`，防止旧习惯把它们重新加回来。
- **保留并去掉投影字段**（去掉 `provenance`、`canonicalProjection`、顶层 `sourceDigest` 与条目上的 `canonical*` 字段）：
  `commons-manifest.json`（81 个 kernel，3 个 RFC-317 守卫的主题表）、`commons-debt.json`（R1 / R2 精确债务与 79 条 P3 发现）、
  `guard-manifest.json`（守卫登记表、语料下限、负例标记）。去掉投影后没有任何东西再生成它们，只在其主题变化时手改。
- **不动**：`e2e-capability-ledger.json`、`e2e-endpoint-coverage.json`、`e2e-route-coverage.json`、
  `repository-publication-call-sites.json`。
- **新增**：`counts.json`（§6）。目录从约 36.6 MB 降到约 1.1 MB。

### 2.2 生成器拆分

- `TA/rfc294Target.ts`（新）：目标常量 `TARGET_PUBLIC_CONTEXTS`、offered / required / authority 边等（原 L78-210）。所有门与
  design 对拍测试只 import 这个模块。
- `TA/rfc328TaskExecutionLedger.ts`（新）：RFC-328 用到的构造器——`TASK_EXECUTION_DURABLE_TABLES`、
  `classifyTaskExecutionAuthority`、`buildTaskExecutionAuthorityEntries`、`buildTaskExecutionControlGateways`、
  `TASK_EFFECT_OBSERVER_CALLEES`、`buildTaskOwnedEffectEntries` 以及它们对 `codeHostRecovery` 的依赖，供 `T/rfc328-architecture-guards.test.ts`
  直接使用。
- `TA/architectureReport.ts`（新）：报告生成器，从原生成器的库存构造器改造而来：
  - 只读已提交对象（复用 `scripts/lib/committed-architecture-source.ts`）；
  - `targetContextFor` 对未登记文件返回 `'unregistered'` 而不是抛错；
  - 条目 id 用 `file#enclosingSymbol#callee#ordinal`，不用行号；
  - `KNOWN_VIOLATIONS` 从所选 ref 的 `scripts/depcheck.ts` 文本解析，不 import 工作树；
  - 不 import 任何工作树生产模块；
  - 计数口径修正见 §7。
- 阶段 B 删除 `TA/rfc294Canonical.ts`、`TA/rfc294Status.ts`、`scripts/architecture-census.ts`、`scripts/architecture-status.ts`
  （先确认不再有 importer）；`scripts/lib/committed-architecture-source.ts` 保留，L33-38 的 extras 去掉已删除的测试文件。

### 2.3 报告脚本

`scripts/architecture-report.ts`（新）：

```
--source-ref <rev>   默认 HEAD，只读已提交对象
--out <dir>          默认 .architecture-report/（加入 .gitignore；不要用 Playwright 会清空的 test-results/）
--status <path>      额外输出 status 文本
--gates              打印各门当前违规集合与计数，格式为可直接粘贴的字面量，供重设基线
```

没有写入 `architecture/` 的选项、没有 `--snapshot-sha` / `--seed-ref`、不改 guard-manifest。`package.json`：
`architecture:report` 指向新脚本；`architecture:write` 保留几周作为「墓碑」——直接以非零退出并提示改用 `architecture:report`；
删除 `architecture:status`；更新 `lint:repo-ui` 与 `format:check:repo-ui` 的文件清单。`T/test-suite-policy.test.ts:521-544`
要求脚本与 workflow 中的字面路径存在，新脚本不得引用已删文件。

### 2.4 status.md

`design/RFC-294-backend-layered-target-architecture/status.md` 改为不含指标的说明：如何运行 `architecture:report`、输出位置、
以及「当前数字以最近一次 dated review 或按需生成的报告为准」。生成的报告头部带完整源 SHA 与生成时间，不与任何东西比对。

## 3. 硬结构门

### 3.1 统一形态

- 纯检测函数放在新的 `TA/rfc294Gates.ts`；每条门的测试在自己的 `describe` 下，共用一次解析的语料。
- 例外清单写在测试文件内，双向精确（未登记的违规红、过期的条目红），条目以文件对或符号根为单位，**不用行号**；每条带后继，
  同一后继的条目共用一个理由。
- 变异证明（每条门都要有）：①每个检测分支至少一个违规负例（覆盖静态、类型、动态、`export … from`、`require` 等 import 写法）；
  ②每个豁免边界至少一个合规样例；③例外清单变异：观察值对「清单少一条」报未登记、对「清单多一条假条目」报过期；④语料下限；
  ⑤登记进 `guard-manifest.json`，其 `corpusScanner` / `minCorpusFiles` / `assertsAbsence` / `negativeFixture` 字段用
  `TA/census.ts` 的函数算出（`rfc317-guard-negative-fixture` 与 `rfc317-guard-corpus-floor` 会强制）。
- 负例只用内存中的虚拟源码，不在共享工作树里制造变异文件。
- 门只读工作树源码；CI 在干净 checkout 上是权威。初始清单在阶段 B 从当时已提交的 HEAD 计算。
- 测试文件名与常量命名遵守既有守卫惯例（含 `guard` / `lock` 等字样的文件会被登记表扫描）。

### 3.2 门清单

| ID | 门 | 现状 | HEAD 计数 | 实现 |
| --- | --- | --- | --- | --- |
| G1 | depcheck：`no-circular` 与 `KNOWN_VIOLATIONS` 双向；route / transport→DB、services→routes、util→upper、auth→services | 已有（lint 与 `T/depcheck-gate.test.ts`） | KNOWN 7（RFC-377 后为 0）；后端 / 全仓值级 SCC 1 / 3；route / transport→DB 0 / 0 | 保留。把 T20（cruiser `@ledger` 标记 ↔ `KNOWN_VIOLATIONS`）与「`KNOWN_VIOLATIONS` 不含 no-routes/transport-to-db 条目」移入 `depcheck-gate.test.ts`，补每条规则的路径正则负例。新门一律写成 bun 测试而不是 cruiser 规则，使 `KNOWN_VIOLATIONS` 保持「趋向 0」的含义 |
| G2 | context 值级依赖无环且 ⊆ design §3.1 DAG | 无（只有常量检查） | 30 个值级 context 对；2 个 SCC：{collaboration, memory, resource-catalog, task-execution}、{development-automation, integration}；16 个 DAG 外值级对 | 模块 → 其他模块的值边（任意语法与目标路径）。断言 SCC 集合等于 `KNOWN_CONTEXT_VALUE_SCCS`（双向）、DAG 外值级对等于清单（双向）、目标 DAG 本身无环。注意 offered ∪ required 边含 {event-center, identity-access} 环，虚线边必须保持 type-only |
| G3 | 跨 context 只经 public 精确入口 | 有，但由账本支撑（preflight） | 100 个文件对（102 个 kind/syntax 键）、54 个文件 | 原地改造 `T/rfc294-architecture-preflight.test.ts` 为文件内清单。豁免通道：`application/adapters/*-adapter` 对 `composition/required-ports` 的 type-only 引用；删除 0 使用的 `infrastructure/postgresql*`→`composition` 通道 |
| G4 | 观察到的 offered 边 ⊆ DAG | 有（文件内） | 63 个文件→context 对 | 保留 `TA/rfc294-review-offered-edge-dag.test.ts`，import 改为 `rfc294Target.ts` |
| G5 | `platform/**` 不 import `modules/**` | 无 | 8 个文件、49 个（文件, 目标）对，其中 5 个文件 20 对是值级 | 任何边类与语法；49 对入清单 |
| G6 | application 无直接 FS / 进程 / 网络效果 | 无 | 3 个文件：`intent/application/maintenance.ts`（`node:fs`）、`knowledge-evolution/application/fusionOrchestration.ts`（`node:fs`）、`integration/application/repositoryEndpointDiscovery.ts`（全局 `fetch`） | 禁止的值 import：`node:fs`（含 `/promises`）、`child_process`、`net`、`http`、`https`、`http2`、`dgram`、`tls`、`dns`、`worker_threads`、`cluster`、`bun:sqlite`；禁止的调用：`Bun.spawn` / `spawnSync` / `$` / `file` / `write` / `connect` / `listen` / `serve`、全局 `fetch`、`new WebSocket`、`process.kill` / `exit` / `chdir` |
| G7 | 模块内分层（design §3 常驻规则 1～3、8） | 部分（`TA/rfc294-review-module-layer-rules.test.ts`） | 既有规则 0；新增：domain 的 `child_process` / fs 变体 0；application → composition（不含对 `required-ports` 的 type-only）1（`knowledge-evolution/application/fusionOrchestration.ts` → `source-control/composition`）；模块 `inbound/**` → `@/db` 0；inbound → 他 context 内部 1（`knowledge-evolution` 的 fusion 路由 → `task-execution/inbound/directTaskInitiator`） | 扩展既有测试；对 `composition/required-ports` 的 21 处 type-only 引用豁免（design §2 本身把它放在那里） |
| G8 | composition 禁止 drizzle / schema / fs / `child_process` / 原生 SQL | 无 | 22 个文件（7 个 drizzle+schema、17 个 `node:fs`、0 个 SQL），多为 RFC-370 的 `taskImage*` / `crewstation*` | 范围：`composition/**`（不含 `required-ports.ts`）与 `composition.ts`；另禁止 `@/db/*`、`bun:sqlite` 与经 `export *` 再导出 drizzle / schema 的桶。必须基于 AST（`legacyDevelopmentProgramUpgrade.ts` 只在模板字符串里出现 `node:child_process`） |
| G9 | 业务层零部署模式分支 | 无 | 6 个文件 8 处：`cli/start.ts`（`executionHost`）、`server.ts` 两处 `?? 'standalone'`、`embed.ts`、`platform/http/executionAvailability.ts`（字面量）、`system-operations/application/ports/executionAuthority.ts` 与 `integration/application/ports/crewStationEventInbox.ts`（厂商字面量类型） | 范围：模块 domain / application / engine / inbound / public、`platform/**`（不含 `platform/crewstation/**`）、routes / mcp / ws、入口根（`main.ts`、`server.ts`、`embed.ts`、`cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`cli/dev.ts`）。标记：读 `AW_DEPLOYMENT_MODE`；以 `===` / `!==` / `case` / `??` / `\|\|` 与 `'standalone'` / `'crewstation'` 比较；对 `deploymentMode` / `executionHost` / `deployment` 的比较；`application/ports` 中的此类字面量类型；import `@/cli/deployment` 或 `@/bootstrap/*`。允许：选择点（今天的 `cli/deployment.ts`，以后的 bootstrap）、`main.ts` 调用它、只做穷尽检查 / 抛错的栅栏。复用 `TA/rfc359-w5-t19-provider-branch` 的判别式逻辑 |
| G10 | `node_runs` 唯一 INSERT 站点 | `T/rfc098-node-run-mint-grep-guard.test.ts` | 1 | 保留 |
| G11 | design DAG 与常量对拍 | 在 canonical 测试里 | — | 移到新的 `TA/rfc294-design-parity.test.ts`；对内存中的 design 文本做变异负例：加一条边、删一条边、改 context 名、删 IA 行。同步更新 RFC-294 design.md L9-12 的机读约定（不再指向 canonical 测试） |
| C6 | 不新增 `export *` 转出 drizzle、schema 或模块内部的桶 | 无 | 30 个文件（1 个 drizzle/schema 桶、29 个 services 门面再导出模块内部） | 现存 30 个入清单，只能减少 |
| C8 | 不新增直接 `setInterval` | 无 | 23 处、20 个文件（RFC-375 删除后会减少） | 现存站点以「文件 + 外围符号」入清单，只能减少 |
| C9 | `architecture/` 只放允许的文件 | 无 | — | 允许清单即 §2.1 保留与新增的 8 个文件 |
| G14 | 生产文件从入口可达 | 无 | RFC-375 删除后只剩其保留清单 | 入口与图规则同 RFC-375 design §1（`scripts/build-binary.ts` 的入口、值 / 类型 / 字面量动态 import / Worker URL 边、`@/` 与 workspace 包解析）；仍不可达的文件入清单（带理由与后继），只能减少 |

推迟：G12（两种 provider 生命周期作业 id 清单一致）属 S2a 退出门——今天两份清单顺序不同（PG 侧还追加了托管后台 owner），
现在钉住会把 RFC-370 热文件 `cli/start.ts` 的文本写死。C7（零 consumer public 符号）只进报告。

## 4. 测试与守卫迁移

### 4.1 `TA/` 下的文件

| 文件 | 处置 |
| --- | --- |
| `census.ts` | 保留（所有门与元守卫的内核）；阶段 B 更新 L1237-1238 关于 HEAD~1 的陈旧注释 |
| `rfc294Canonical.ts` | 阶段 B 删除（拆分见 §2.2） |
| `rfc294Status.ts` | 阶段 B 删除；status 文本由 `architectureReport.ts` 生成 |
| `capabilityLedger.ts`、`frontendRouteCoverage.ts`、`routeHitLedger.ts`、`routeMatch.ts`、`cascadeClosure.ts`、`postgresqlSurface.ts`、`rfc329McpSurfaceLedger.ts` | 保留（非 RFC-294；`rfc329` 失去 ledger-baselines 计数钉，自身精确性不变） |
| `rfc294-canonical-manifests.test.ts` | 阶段 B 删除；其中 design 对拍（L151-164）移到 G11；RFC-328 效果 / code-host / authority 闭包（L450-544）改为 `T/rfc328-architecture-guards.test.ts` 的直接断言；`toPublicError` 行为与冻结的 `define*` 定义（L624-684）原样移到 platform errors / background 单测；「`KNOWN_VIOLATIONS` 不含 no-transport-to-db」（L686-689）移到 depcheck-gate；其余（N1a / N1b、不透明引用、治理字段、RFC-363 封印、外键闭包、facade / owner 摘要形状、`node_runs` 分母、RFC-317 子集投影、校验器变异、owner 登记表）删除 |
| `rfc294-review-module-layer-rules.test.ts` | 保留并扩展为 G7 |
| `rfc294-review-offered-edge-dag.test.ts` | 保留为 G4，阶段 B 改从 `rfc294Target.ts` import |
| `rfc294-review-public-consumer-ledger.test.ts` | 阶段 B 删除（C7 进报告） |
| `rfc294-review-status-projection.test.ts` | 阶段 B 删除 |
| `rfc317-architecture-ledgers.test.ts` | 删除 provenance 部分（L227-258 与 provenance 字段断言），其余保留 |
| `rfc317-guard-corpus-floor.test.ts`、`rfc317-guard-negative-fixture.test.ts` | 保留（「每条门能红」的机械执行） |
| `rfc317-ledger-highwater.test.ts` | 阶段 B 删除；T20 移到 depcheck-gate |
| `rfc317-module-boundary.test.ts` | 保留 R1 / R2 / R3 / T25 规则；去掉 commons-debt 投影依赖；基线计数改为文件内手维护或删除 L101-103、L128-130 |
| `rfc317-identity-dispatch`、`rfc317-lifecycle-origin-neutrality`、`rfc317-acl-mounter-type-neutrality` | 保留（主题表来自 commons-manifest） |
| 其余 15 个 `rfc317-*`、6 个 `rfc319-*`、`rfc326` / `rfc329` / `rfc334` / `rfc349`（3 个）/ `rfc371-v2`、29 个 `rfc359-*` | 保留；只失去 ledger-baselines 计数钉，引用 T17 / ledger-baselines 的注释阶段 B 更新 |

### 4.2 `TA/` 以外

| 文件 | 处置 |
| --- | --- |
| `T/rfc294-architecture-preflight.test.ts` | 阶段 B 改造为 G3：跨 context 用文件内 100 个文件对清单；public 偏离用文件内精确清单；删除 god-surface 预算；保留 T13 与全部负例 |
| `T/rfc328-architecture-guards.test.ts` | 阶段 B 把 L607-618 的 `buildCanonicalArtifacts` + `validateCanonicalArtifacts` 改为直接断言：authority `unknown == []`、4 类 authority、6 种 control 子类型、必填字段、code-host 绑定校验（用 `rfc328TaskExecutionLedger.ts`） |
| `T/rfc332-task-engine-contracts.test.ts` | 删除 L247-329 依赖生成器的用例（登记表、波次投影、exception 来源） |
| `T/rfc346-system-operations-contracts.test.ts` | 阶段 B：删除 L324-380 登记表 / 波次用例；L382-431 required port 活性改为直接 import 扫描 |
| `T/rfc339-wrapper-runtime-cutover.test.ts` | 删除 L375-405 读已提交 JSON 的用例 |
| `T/rfc321-repository-publication-ratchet.test.ts` | 阶段 B：删除 L225-235 的 ledger-baselines 断言 |
| `T/rfc370-committed-architecture-source.test.ts` | 阶段 B：保留（AC-4 的证据），修正 L15-22 中已删测试的路径与 import |
| `T/depcheck-gate.test.ts` | 扩展：T20、`KNOWN_VIOLATIONS` 不含 route/transport-to-db、每条规则的路径正则负例 |
| `T/helpers/rfc349FunctionalEvidence.ts`（L250-279）与 `T/rfc349-functional-evidence.test.ts` | `schema-canonical-and-provenance` 证据中按标题引用的两个 canonical 测试改指新门 |
| `T/rfc098-node-run-mint-grep-guard.test.ts` | 保留（G10） |
| 约 25 个只在注释里提到 guard-manifest 下限的前后端守卫 | 不动 |

## 5. CI

- `.github/workflows/ci.yml` 的 `test-backend`（L136-145）与 `.github/workflows/backend-macos-nightly.yml`（L42-47）：删除
  `fetch-depth: 0`、`filter: blob:none` 与相关注释——只有 N1a、rfc317 的 SHA 断言（已容忍浅克隆）与 T17 需要历史，三者都被删除。
- `scans` 作业（L422-426）的 `fetch-depth: 0` 是 gitleaks 需要的，保留。
- lint 中的 `bun run depcheck` 保留。不新增 workflow；新门是普通 bun 测试，随既有分片运行。

## 6. 计数文件 `architecture/counts.json`

```json
{
  "schemaVersion": 1,
  "note": "RFC-294 design §13.1 减速带，不是门。measured <= max 即通过；下降不需要改；抬高 max 必须在同一提交，且 reason 含 max=<N>。无 provenance、无过期、无历史比较。",
  "counts": {
    "depcheck-known-violations": { "max": 0, "reason": "max=0: RFC-377 清零" }
  }
}
```

- 条目（初值在阶段 B 从 HEAD 计算）：depcheck known-violations、backend-value-scc、repo-value-scc、route-to-db、transport-to-db；
  context-value-sccs、context-value-pairs-off-dag、cross-context-internal-file-pairs、off-dag-offered-file-context-pairs；
  platform-to-modules-file-pairs、deployment-mode-branch-sites、application-direct-effect-files、composition-forbidden-import-files、
  module-layer-violations、node-runs-insert-sites；export-star-barrels、direct-setinterval-sites、unreachable-production-files；
  legacy-service-implementations、legacy-thin-facades、legacy-horizontal-files。
- 检查放在门测试文件里，用与门相同的检测函数：id 双向一致（未知或缺失都红）；measured > max 红；reason 不含 `max=<N>` 红；
  measured < max 只打印提示（可用 `architecture:report --gates` 输出新值后手工收紧）。不与 HEAD~1 比较。
- `/architecture/` 在 `.prettierignore` 中，计数文件不受格式门约束。

## 7. 报告计数口径修正

- **模块级可变单例**：原 ambient 512 条中 485 条（94.7%）是 `registerRoute` / `registerOperationRoute` 一类路由注册。改为按定义计：
  导出的 set / bind / reset / register / configure / install 函数中会修改模块状态的（现约 31 个、25 个非 bootstrap 文件，其中 12 个
  是仅测试用的 reset），加上顶层 `let`（42 个、31 个文件）；排除路由 / 操作注册、`routes/registry.ts`、
  `platform/operations/catalog.ts` 与 bootstrap 文件。
- **后台作业**：原 background 392 条 ≈ 307 条按名字匹配（其中 76 条是常量、schema 或对象）+ 87 处 timer 调用。改为：provider
  session handle id、`define*` 定义、`setInterval` 站点与自我重排的 `setTimeout` 循环；不计常量、类型、schema 与助手函数。

## 8. 文档

- `docs/dev-gotchas.md`：给只为旧账本机制存在的 32 个小节（约 754 行）各加一行「历史（RFC-376 起不再适用）」横幅，不改写正文、
  不对 `docs/` 跑 prettier；混合小节只标注账本部分为历史。小节清单以实施时的标题检索为准（census / allowGrowth / provenance /
  snapshot-sha / N1a / N1b / T17 / ledger-baselines / 投影 / 导出树等主题）。
- RFC-294：`proposal.md`（L12-14、L20 等提到 status.md 生成与重采触发器处）、`design.md`（L7、L9-12 的机读约定、§13.3 过渡、§14）、
  `plan.md`（§1 口径、§3 S4 小节写明初始清单按阶段 B 计算、§6 冲突矩阵中「生成器」一行）、`test-hardening.md` L34（preflight 角色）。
- `docs/audit-backlog.md` 中把 T72 当作现行的条目标为历史。
- `scripts/depcheck.ts` L31-39 提到「T17 不能涨」的注释改为指向 `counts.json`（RFC-377 落地后该文件的 KNOWN 部分已由其改写，
  阶段 B 只改这段注释）。
- CLAUDE.md / AGENTS.md 不含 census 指令，不需要改。

## 9. 两阶段交付与并发

共享工作树上，其他会话（当前是 RFC-370）仍按旧制度提交「pin the projection」：它们运行工作树里的 census 脚本与生成器，
并 `git add architecture/ design/RFC-294-…/status.md`。若本 RFC 的破坏性改动长时间停在工作树里，会让它们的 census 失败，
或把本 RFC 的删除误纳入它们的提交。因此分两阶段：

- **阶段 A（可与 RFC-375 / RFC-377 并行）**：只新建文件，外加修改下列「安全」测试文件：`T/rfc332-task-engine-contracts.test.ts`、
  `T/rfc339-wrapper-runtime-cutover.test.ts`、`T/helpers/rfc349FunctionalEvidence.ts`、`T/rfc349-functional-evidence.test.ts`、
  `T/depcheck-gate.test.ts`、`TA/rfc317-architecture-ledgers.test.ts`、`TA/rfc294-review-module-layer-rules.test.ts`、
  `TA/rfc317-module-boundary.test.ts`。阶段 A 中新门的初始清单按当时 HEAD 计算，阶段 B 重算。
- **阶段 B（RFC-375 / RFC-377 已提交后，在安静窗口内一次完成）**：其余全部改动——删除与改造 `TA/` 的旧测试、preflight /
  offered-edge / rfc328 / rfc346 / rfc321 / rfc370-committed-source 的改造、`architecture/**` 的删除与去投影、`counts.json`、
  guard-manifest 登记、`.gitignore`、`package.json`、CI workflow、`scripts/*`、status.md 与文档；最后用
  `architecture:report --gates --source-ref HEAD` 重算全部清单与计数。
- **阶段 A 禁止修改的「危险集」**：根目录 `architecture/**`；RFC-294 `status.md`；`TA/rfc294Canonical.ts`、`TA/census.ts`、
  `TA/rfc294Status.ts`；`scripts/architecture-census.ts`、`scripts/architecture-status.ts`、`scripts/lib/committed-architecture-source.ts`、
  `scripts/depcheck.ts`；`.dependency-cruiser.cjs`；`packages/backend/src/**`（含 `codeHostRecovery.ts`）；`package.json`、
  `.github/workflows/**`、`.gitignore`、`.prettierignore`；`docs/**` 与 RFC-294 文档；以及 RFC-370 自 2026-10-14 起改过、或
  RFC-375 / RFC-377 要改的测试文件（`T/rfc294-architecture-preflight.test.ts`、`TA/rfc294-review-offered-edge-dag.test.ts`、
  `T/rfc328-architecture-guards.test.ts`、`T/rfc346-system-operations-contracts.test.ts`、`TA/rfc317-ledger-highwater.test.ts`、
  `T/rfc321-repository-publication-ratchet.test.ts`、`TA/rfc294-canonical-manifests.test.ts`、
  `TA/rfc294-review-public-consumer-ledger.test.ts`、`TA/rfc294-review-status-projection.test.ts`、
  `T/rfc370-committed-architecture-source.test.ts`）。
- **阶段 B 的安静窗口**：开始前 `git status --porcelain` 确认上述危险集里没有他人未提交改动、HEAD 等于 `origin/main`；
  有则等待或在当前会话报告，不碰他人改动。阶段 B 内先做非破坏性的改造，最后才删除 census / 生成器与 `architecture/` 文件，
  随即验证并提交，缩短窗口。提交用逐文件路径清单（目录 pathspec 会把他人改动一并暂存）。
- **落地后**：投影提交不再需要；`architecture:write` 墓碑、`.gitignore`、C9 门让旧习惯显式失败而不是静默写回。

## 10. 失败模式与回滚

- 隐藏在 canonical 校验里的保护丢失 → §4 的改造清单逐条执行，AC-5 的直接断言兜底。
- 例外清单在新门下静默增长 → 双向精确清单 + `counts.json` reason 约束 + 新增例外须在 RFC design 中列为偏离并经用户确认。
- 本地共享工作树上的假红（门读工作树）→ 以 CI 为准；基线只从已提交对象计算。
- 回滚：本 RFC 只改测试 / 脚本 / CI / 文档，可整笔 `git revert`；被删除的 JSON 可从 git 历史恢复，但恢复旧制度需要重新跑旧 census。

## 11. 测试策略

- 每条门按 §3.1 的五项变异证明；`counts.json` 检查的负例：超过 max、未知 id、缺失 id、reason 不含 `max=<N>`。
- 报告：对一个已知提交运行 `architecture:report --source-ref <sha>` 两次，输出逐字相同；工作树有无关改动时输出不变（证明只读已提交
  对象）；报告不 import 工作树中的 `scripts/depcheck` 与生产模块（源码断言）。
- `T/rfc370-committed-architecture-source.test.ts` 继续证明「从已提交对象重建」。
- 集中验证：`TA/` 全目录、§4.2 的全部测试、`depcheck`、三包 typecheck、改动文件 lint / prettier。

## 12. 与 RFC-294 目标架构的对齐

本 RFC 实施 RFC-294 D9 修订与 §13 治理模型，承担 W0-R 的模型修订；不涉及任何 bounded context 的生产代码。留下的债：G12（S2a）、
C7 报告化、G6 / G7 的扩展范围、各门例外清单中的存量（由各自后继清偿）。无偏离项。
