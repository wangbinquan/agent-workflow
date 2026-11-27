# RFC-627 技术设计：CI 吞吐、分层验证与排队治理

## 1. 架构对齐声明（RFC-294）与无依赖脚本约束

1. **RFC-294 对齐**：本 RFC 仅修改 GitHub Actions 工作流（`.github/workflows/`、`.github/actionlint.yaml`）、CI 辅助脚本（`scripts/ci/`）、Playwright CI 配置（`playwright.ci.config.ts`）、`package.json`、`codecov.yml`、协作文档（`CLAUDE.md`、`docs/dev-gotchas.md`）与 CI 拓扑/守卫测试（`packages/backend/tests/`）。**零后端生产源码（`packages/backend/src/`）改动**，不触及任何 bounded context、不新增跨域依赖或临时 facade，完全对齐 RFC-294 总纲（不给 RFC-294 任何波次计 credit），也不与在途 RFC-626 的迁移生产代码冲突。
2. **零 `node_modules` 约束**：`detect-changes` 与 `ci-timings.yml` 均不执行 `bun install`。所有被这两个作业直接执行的脚本（`scripts/ci/classify-ci-changes.ts`、`scripts/ci/backend-shards.ts`、`scripts/ci/workflow-source.ts`、`scripts/ci/refresh-backend-timings.ts`、`scripts/ci/refresh-e2e-timings.ts`、`scripts/ci/compose-backend-timings.ts`）**只能使用 Bun 与 Node 内置模块**（例如 `import { YAML } from 'bun'`、`node:fs`、`node:child_process`），禁止 import 任何第三方包（由单测静态锁死，沿用 `rfc615-ci-calculation-admission.test.ts:125-134` 约定）。

## 2. 工作流拓扑与并发模型

### 2.1 `ci.yml` 并发与入口结构

`.github/workflows/ci.yml` 改为**工作流级并发**，彻底消除 job 级并发取消待跑 `full-ci` 后 `ci-required` 误报 `failure` 的问题：

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:
    inputs:
      mode:
        description: 'CI verification tier (full runs core + full PG migration; auto classifies diff)'
        type: choice
        options: [full, auto]
        default: full

concurrency:
  group: >-
    ${{ github.event_name == 'workflow_dispatch'
        && format('{0}-manual-{1}', github.workflow, github.run_id)
        || format('{0}-{1}', github.workflow, github.ref) }}
  cancel-in-progress: false
```

行为保证：
- **Push / PR 同 ref 排队上限**：无 `queue: max`，GitHub Actions 原生保持「最多 1 个 `in_progress` + 1 个最新 `pending`」。运行中的 run 绝不取消；被更新提交取代的 `pending` run 在启动任何 job 前被整体取消为 `cancelled`，`ci-required` 不运行，既不产生假绿也不产生假红。
- **手动 `workflow_dispatch` 独立组**：以 `run_id` 隔离，默认 `mode=full`，可随时对任意单个 SHA 执行完整验证而不打断或被 push 队列取消。
- **删除 `.github/actionlint.yaml`**：移除 `queue: max` 后不再需要上游 actionlint 临时忽略规则，删除 `.github/actionlint.yaml` 并同步移除 `package.json` 的 `format:check:repo-ui` 中的 `.github/actionlint.yaml` 项及 `root-test-entrypoint.test.ts` 的对应断言。
- **辅助 `ci-feedback.yml` 同步忽略纯文档**：在 `.github/workflows/ci-feedback.yml` 的 `push` 与 `pull_request` 上添加完全一致的 `paths-ignore`（`STATE.md`、`CLAUDE.md`、`AGENTS.md`、`README.md`、`README.zh-CN.md`、`design/**/*.md`、`docs/**/*.md`、`proposal/**/*.md`），所有字面文件与目录前缀均存在于仓库，满足 `ci-workflow-path-filters.test.ts` 与 `root-test-entrypoint.test.ts:903-923` 推/PR 宽度一致约束。

### 2.2 `detect-changes` 作业与 `scripts/ci/classify-ci-changes.ts`

新增 `detect-changes` 作业（`runs-on: ubuntu-latest`，`timeout-minutes: 5`，`permissions: { actions: read, contents: read }`）：

- **执行环境**：
  1. `actions/checkout@v5`，配置 `fetch-depth: 200` 与 `filter: blob:none`（直接锚定不可变 `$GITHUB_SHA`，不向移动的 `origin main` 漂移，且仅取提交/树对象，不拉历史 blob，耗时数秒）。
  2. `oven-sh/setup-bun@v2`（`bun-version: '1.4.3'`，遵循 `root-test-entrypoint.test.ts:309-324` 全仓版本锁）。
  3. 运行 `bun scripts/ci/classify-ci-changes.ts`，注入 `GH_TOKEN: ${{ github.token }}`、`GITHUB_EVENT_NAME`、`GITHUB_EVENT_PATH`、`GITHUB_REPOSITORY`、`GITHUB_SHA`、`GITHUB_RUN_ID`、`AW_DISPATCH_MODE: ${{ inputs.mode }}`，输出 `mode`、`base_sha`、`links_base_sha`、`reason` 至 `$GITHUB_OUTPUT`。

- **未验证对比基点解析**：
  1. `workflow_dispatch` 且 `AW_DISPATCH_MODE != 'auto'`（含默认 `'full'`）：直接返回 `mode=full, base_sha='', links_base_sha='ALL'`。
  2. `pull_request`：直接使用不可变端点 `pull_request.base.sha` → `pull_request.head.sha`（若任一对象不在 200 深度内，按不可变 SHA 执行 `git fetch --no-tags --filter=blob:none --depth=1 origin <sha>`）。
  3. `push`（以及 `workflow_dispatch` 且 `AW_DISPATCH_MODE == 'auto'`）：通过 `gh api` 查询 `repos/{repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100`（最多翻 2 页 = 200 条 completed run，防止高峰期的 `cancelled`/`failure` 占满前 30 条导致误降级），按时间倒序筛选 `conclusion == 'success'`、`head_repository.full_name == repo`、`id != current_run_id`，取第一个满足 `git merge-base --is-ancestor <sha> <GITHUB_SHA>` 的 `head_sha` 作为 `base_sha`。
     - 说明：当在已绿 `HEAD` 上手动触发 `workflow_dispatch mode=auto` 时，若找到的 `base_sha == GITHUB_SHA` 则 diff 为空并按 fail-closed 规则降级为 `mode=full`（宁可多跑，绝不空过）。
  4. **Fail-closed 兜底**：以下任一情况一律判定为 `mode=full, base_sha='', links_base_sha='ALL'`：
     - API 调用失败、200 条内无绿灯祖先、历史分叉/强推导致非祖先、两提交距离超过 200 次提交、`git diff` 退出非 0、或变更路径列表为空。

- **路径 diff 与三档分类规则（纯函数，全量单测覆盖）**：
  - 使用 `git diff --name-only -z --no-renames <base_sha> <head_sha>`（显式禁用重命名折叠，确保“源码改名为 `.md`”同时暴露旧源码路径与新文档路径）。
  - **`docs-only`**：变更列表非空，且**所有**路径均满足严格 Markdown 白名单：
    - 根文档精确匹配：`STATE.md`、`CLAUDE.md`、`AGENTS.md`、`README.md`、`README.zh-CN.md`；
    - 目录 Markdown：`design/**/*.md`、`docs/**/*.md`、`proposal/**/*.md`，但**显式排除**以下 3 个受代码/vitest 契约约束的文档：
      1. `design/RFC-395-database-target-schema-rebuild/table-mapping.md`（被 `rfc395-r1-target-contract.test.ts` 作为表映射契约读取 → 归 `full`）；
      2. `design/RFC-349-postgresql-provider-one-click-migration/schema-contract.md`（被 `architecture/rfc349-schema-contract.test.ts:274-285` 校验 digest 与表清单 → 归 `full`）；
      3. `docs/crewstation-automation.md`（被前端 vitest `packages/frontend/tests/rfc370-v3-hosted-access.test.tsx:180-186` 校验 → 归 `standard`）；
    - 拒绝任何包含 `.` / `..` 路径段或控制字符的异常路径。
    - `evidence/**`、`design/**/*.json`、`packages/**/*.md`、`e2e/**/*.md`、`.github/**` 均**不在**白名单内。
  - **`full`**：非 `docs-only`，且**任一**路径命中以下规则之一（单测对全部字面路径与目录前缀执行仓库存在性校验，且从构造上锁死不变量 `∀ f ∈ migration: classify([f]) === 'full'`）：
    - **自动联动全部 `migration` 档测试文件**：直接调用 `scripts/ci/backend-shards.ts` 导出的 `isMigrationTierTest(path)`（同为零依赖模块），确保修改任何一个被划入 `migration` 档的测试文件必触发 `mode=full`，绝不会因落在 `standard` 而跳过该测试；
    - 持久化与迁移核心目录/Schema：
      - `packages/backend/src/platform/persistence/`
      - `packages/backend/src/platform/content/migration/`（11 个内容迁移生产文件）
      - `packages/backend/src/platform/contracts/migrationDecision.ts`
      - `packages/backend/src/modules/system-operations/`（涵盖 `application/epochSwitch/`、`domain/epochSwitch/`、`infrastructure/epochSwitch/`、`composition/` 及全部 `databaseMigration*` / `autoUpgrade*` / `schema*` / `sqliteMigrationSafetyBackup`）
      - `packages/backend/src/db/`、`packages/backend/db/`
      - 正则 `^packages/backend/src/(?:modules|platform)/[^/]+/(?:infrastructure/)?migration/`（同时涵盖模块与平台迁移目录）
      - 正则 `^packages/backend/src/(?:modules|platform)/[^/]+/(?:composition|infrastructure/persistence)/schema\.ts$`（涵盖全仓全部模块与平台 38 个 `schema.ts`）
    - 引导与 CLI 迁移入口：
      - `packages/backend/src/bootstrap/` 下迁移/持久化相关文件：`conversionRules.ts`、`persistenceSchema.ts`、`persistenceHead.ts`、`persistenceBaseline.ts`、`migrate.ts`、`historyRestrictions.ts`、`targetColumnDestinations.json`、`targetSchemaRoster.json`、`daemonProviderBootstrap.ts`、`daemonProviderMigrationAdmission.ts`，以及前缀 `epochMigration` / `autoUpgrade`
      - `packages/backend/src/cli/` 下库与迁移命令：`epochMigration.ts`、`epochMigrationLegacy.ts`、`database.ts`、`dbCompact.ts`、`migrationReport.ts`、`backup.ts`、`restore.ts`
    - 迁移/双引擎测试夹具、脚本与契约文件：
      - `packages/backend/tests/release-upgrade`、`packages/backend/tests/helpers/releaseUpgrade/`、`packages/backend/tests/migration-freeze.ts`
      - `packages/backend/tests/helpers/eachProvider.ts`、`packages/backend/tests/helpers/testDatabase.ts`、`packages/backend/tests/helpers/epoch1Protocol/`、`packages/backend/tests/helpers/epoch2`（前缀）、`packages/backend/tests/helpers/epochMigrationReachability.ts`
      - 正则 `^packages/backend/tests/(?:helpers/)?.*(?:rfc395|rfc398|rfc625|rfc626)`
      - `scripts/release-upgrade/`、`scripts/schema-history.ts`、`.github/scripts/release-upgrade.ts`
      - `evidence/`
      - `design/RFC-395-database-target-schema-rebuild/table-mapping.md`、`design/RFC-349-postgresql-provider-one-click-migration/schema-contract.json`、`design/RFC-349-postgresql-provider-one-click-migration/schema-contract.md`
    - CI 拓扑、测试根配置与依赖锁：
      - `.github/workflows/ci.yml`、`.github/workflows/ci-work.yml`、`.github/workflows/backend-full-nightly.yml`、`.github/workflows/ci-timings.yml`、`.github/scripts/ci-postgresql-service.sh`、`scripts/ci/`
      - `package.json`、`bun.lock`、`bunfig.toml`
  - **`standard`**：其余所有代码/前端/E2E/测试/脚本变更。
  - 正常计算出有效 `base_sha` 时，`links_base_sha = base_sha`；降级兜底时 `links_base_sha = 'ALL'`。

- **数学不变量验证（防止排队合并漏测）**：
  - 因工作流级并发 `cancel-in-progress: false`，任意待跑 run 启动 `detect-changes` 时，前一个 run 必然已终态。
  - 若上一绿灯提交为 `G`，所有 `G..HEAD` 之间被取消或失败的提交改动完整包含在 `git diff --no-renames G HEAD` 中：任一夹杂代码提交破坏 `docs-only` 全称条件强制升档；任一夹杂迁移提交命中 `full` 存在条件强制升档；连续 `docs-only` 绿灯提交不改变任何非文档文件，代码树与 `G` 逐字节等价。

### 2.3 `docs-fast-gate` 作业（`ci.yml` 内）

当 `needs['detect-changes'].result == 'success' && needs['detect-changes'].outputs.mode == 'docs-only'` 时运行（`runs-on: ubuntu-latest`，`timeout-minutes: 10`，`permissions: { contents: read }`）：

1. `actions/checkout@v5` + `oven-sh/setup-bun@v2`（`1.4.3`）+ Bun 包缓存 + `bun install --frozen-lockfile`。
2. 离线本地链接全量检查：`lycheeverse/lychee-action@v2`（`v0.24.2`，`args: --offline --no-progress --verbose 'design/**/*.md'`，`fail: true`）。
3. 变更文档外链检查：`bun scripts/ci/check-design-links.ts`，传入 `AW_DESIGN_LINKS_BASE_SHA: ${{ needs['detect-changes'].outputs.links_base_sha }}` 与 `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`。
   - `check-design-links.ts` 扩展规则：
     - 若 `AW_DESIGN_LINKS_BASE_SHA === 'ALL'`：等同于 `--all`（全检全部 `design/**/*.md` 外链，绝不因兜底回退到 `event.before` 漏检被覆盖文档提交）；
     - 若 `AW_DESIGN_LINKS_BASE_SHA` 为合法 40 位十六进制 SHA：按事件解析不可变 `head` 端点——`pull_request` 取 `payload.pull_request.head.sha`（严禁取合成 merge commit `GITHUB_SHA`，保留 `ci-design-link-selection.test.ts:56-65` 不可变端点契约）、`push` 取 `payload.after`（缺省回退 `GITHUB_SHA`）、`workflow_dispatch` 取 `GITHUB_SHA`，以 `{ base: AW_DESIGN_LINKS_BASE_SHA, head }` 替代 `designLinkRange(eventName, payload)`；
     - 非法非空值直接抛错（fail-closed）；未设置时保持原逻辑不变。
4. **文档契约测试（分两步执行，规避 `bunfig.toml` 根目录静默跳过）**：
   - **步骤 4a（23 个后端文档契约文件）**：在仓库根运行 `bun test --isolate` 并通过步骤级 YAML `env: { AW_TEST_PROVIDERS: sqlite }` 显式声明（同时在 `rfc359-w8-ci-dual-engine-wiring.test.ts` 显式登记 `ci.yml:docs-fast-gate`，不用 inline 命令前缀绕过 `providerOverrides` 审计），显式列出以下 23 个文件（无 PG 依赖，总计 ~30s）：
     - `packages/backend/tests/rfc-index-status-drift.test.ts`
     - `packages/backend/tests/docs-node-kind-coverage.test.ts`
     - `packages/backend/tests/docs-runbook-command-guard.test.ts`
     - `packages/backend/tests/docs-implementation-parity.test.ts`
     - `packages/backend/tests/rfc276-runtime-hardening-deprecation.test.ts`
     - `packages/backend/tests/rfc271-ac-coverage.test.ts`
     - `packages/backend/tests/rfc284-env-flags-registry.test.ts`
     - `packages/backend/tests/rfc254-windows-e2e-exclusions.test.ts`
     - `packages/backend/tests/rfc310-ac-evidence-index.test.ts`
     - `packages/backend/tests/rfc321-repository-publication-ratchet.test.ts`
     - `packages/backend/tests/rfc349-functional-evidence.test.ts`
     - `packages/backend/tests/review-dispatch-cci.test.ts`
     - `packages/backend/tests/rfc473-execution-outcome-and-resource-sessions.test.ts`
     - `packages/backend/tests/rfc474-entry-adapter-bootstrap-assembly.test.ts`
     - `packages/backend/tests/rfc475-commit-push-owner-split.test.ts`
     - `packages/backend/tests/rfc476-task-delete-and-review-queue-owners.test.ts`
     - `packages/backend/tests/rfc477-rollback-limits-launch-preflight-owners.test.ts`
     - `packages/backend/tests/rfc478-task-service-retirement.test.ts`
     - `packages/backend/tests/architecture/rfc294-design-parity.test.ts`
     - `packages/backend/tests/architecture/rfc317-architecture-ledgers.test.ts`
     - `packages/backend/tests/architecture/rfc317-stale-assertion-invariants.test.ts`
     - `packages/backend/tests/architecture/rfc326-review-tool-route-guard.test.ts`
     - `packages/backend/tests/architecture/rfc546-module-singleton-exceptions.test.ts`
   - **步骤 4b（2 个 shared 文档契约文件，独立命令）**：因为 `bunfig.toml` 固定 `[test] root = "packages/backend/tests"`，在仓库根直接把 `packages/shared/tests/*.test.ts` 传给 `bun test` 会被静默跳过（0 用例执行且 exit 0）；因此单独执行：
     `bun run --filter @agent-workflow/shared test -- tests/config-rfc300.test.ts tests/webhook-vars-rfc263.test.ts`
     并由守卫测试验证步骤 4a/4b 所列文件全部存在且 shared 命令使用 `--filter @agent-workflow/shared`。

### 2.4 `full-ci` 精确触发条件与 `ci-required` 门禁合同（Fail-Closed）

- `full-ci` 调用条件：`needs: [detect-changes]`，`if: ${{ needs['detect-changes'].result == 'success' && (needs['detect-changes'].outputs.mode == 'standard' || needs['detect-changes'].outputs.mode == 'full') }}`（精确枚举两种代码模式，避免异常/空 `mode` 浪费一次全矩阵运行），`with: { run_migration_full: ${{ needs['detect-changes'].outputs.mode == 'full' }}, links_base_sha: ${{ needs['detect-changes'].outputs.links_base_sha }} }`（比较表达式向 `type: boolean` 输入传递原生布尔值，兼容运行时与 `actionlint`）。
- `ci-required` 保持名称 `CI required`、`if: ${{ always() }}`、`runs-on: ubuntu-slim`、`timeout-minutes: 5`，`needs: [detect-changes, docs-fast-gate, full-ci]`。

Bash 门禁判定表（任一项不符立即 `failed=1`）：

| `CI_MODE` | `detect-changes` | `docs-fast-gate` | `full-ci` | 原 13 组门禁 | `test-backend-migration` |
| --- | --- | --- | --- | --- | --- |
| `docs-only` | `success` | `success` | `skipped` | （不校验，因 `full-ci` 为 `skipped`） | （不校验） |
| `standard` | `success` | `skipped` | `success` | 全部 `success` | `skipped` |
| `full` | `success` | `skipped` | `success` | 全部 `success` | `success` |
| 其他任何值/空 | 立即失败（`invalid CI_MODE`） | — | — | — | — |

## 3. `ci-work.yml` 后端分层、分片规划与降耗设计

### 3.1 `workflow_call` 输入与输出

`ci-work.yml` 保持 `on: workflow_call` 唯一触发器，新增两个可选输入：
- `run_migration_full`（`type: boolean`, `default: true` — 默认 `true` 保守兜底）
- `links_base_sha`（`type: string`, `default: ''` — 传给 `docs` 作业的 `AW_DESIGN_LINKS_BASE_SHA`）

`outputs` 在原 13 组基础上增加 `test-backend-migration`，共 14 组（均沿用 `fromJSON(toJSON(jobs['<id>'])).result`）。

### 3.2 确定性后端分层与 LPT 分片规划（`scripts/ci/backend-shards.ts` / `plan-backend-shards.ts` / `run-backend-shard.ts`）

所有文件数量均在运行时动态扫描，不在生产逻辑中写死文件总数：

1. **全集发现**：递归扫描 `packages/backend/tests` 下全部匹配 `^packages/backend/tests/(?:[^/]+/)*[^/]+\.(?:test|spec)\.ts$` 的文件（排序去重；与 `refresh-backend-timings.ts:47` 规则完全一致）。
2. **互斥完备两档切分（`core ∩ migration = ∅` 且 `core ∪ migration = all`）**：
   - **`CORE_MIGRATION_SMOKE`（固定留在 `core` 的 7 个纯 SQLite / 纯静态迁移冒烟文件，不含任何双引擎/PG 测试）**：
     1. `packages/backend/tests/release-upgrade-matrix-55-v0_19_2-sqlite.test.ts`（59.7s）
     2. `packages/backend/tests/release-upgrade-matrix-56-v0_19_3-sqlite.test.ts`（28.8s）
     3. `packages/backend/tests/rfc398-auto-upgrade-resume-intent.test.ts`（98.4s）
     4. `packages/backend/tests/rfc398-auto-upgrade-resume-phase-frozen.test.ts`（127.0s）
     5. `packages/backend/tests/rfc395-r1-target-contract.test.ts`（3.5s）
     6. `packages/backend/tests/rfc395-schema-equivalence.test.ts`（2.9s）
     7. `packages/backend/tests/rfc395-v3-plan-document.test.ts`（0.7s）
     （由单测断言这 7 个文件全部存在于源码树，且**无一调用** `describeEachProvider` / `describeQ3PhaseBoundary` / `describeV1Providers` / `describeV2Providers` / `describeV3Providers` / `describeV3CrossProvider` / `describeRfc398Postgresql` —— 确保在 `mode=full` 下无任何 PG 测试被扣除。）
   - **`migration`（完整重型、双引擎迁移/升级及托管 PG 迁移恢复集，当前工作树约 439 文件，含全部 Q3、V1/V2/V3、RFC-395/398/626、PG 升级与托管 PG 集成套件）**：
     由统一导出函数 `isMigrationTierTest(path)` 判定——匹配以下任一规则且不在 `CORE_MIGRATION_SMOKE` 内：
     - `^packages/backend/tests/release-upgrade-matrix-`
     - `^packages/backend/tests/rfc398-`
     - `^packages/backend/tests/rfc395-`
     - `^packages/backend/tests/rfc626-`
     - `^packages/backend/tests/rfc625-source-manifest-native\.test\.ts$`
     - `^packages/backend/tests/rfc349-postgresql-logical-target-finalization\.test\.ts$`
     - `^packages/backend/tests/rfc349-database-migration-coordinator\.integration\.test\.ts$`
     - `^packages/backend/tests/rfc359-t19h-postgresql-migration-sequence\.test\.ts$`
     - `^packages/backend/tests/rfc359-w8-migrator-conformance\.test\.ts$`
     - `^packages/backend/tests/rfc359-w8-logical-source-conformance\.test\.ts$`
     - `^packages/backend/tests/rfc359-t19h-logical-backup-restore\.test\.ts$`
     - `^packages/backend/tests/rfc370-m0-hosted-postgresql\.integration\.test\.ts$`
     - `^packages/backend/tests/rfc370-m3-hosted-database-restore\.integration\.test\.ts$`
     - `^packages/backend/tests/rfc370-v3-hosted-standby-boot\.integration\.test\.ts$`
     - `^packages/backend/tests/rfc370-v3-hosted-write-window\.integration\.test\.ts$`
     - `^packages/backend/tests/rfc374-node-run-seq-migration\.test\.ts$`
     - `^packages/backend/tests/rfc602-code-history-index-upgrade\.test\.ts$`
     - `^packages/backend/tests/epoch1-permission-text-backup\.test\.ts$`
     - `^packages/backend/tests/skill-identity-migration\.test\.ts$`
     - `^packages/backend/tests/skill-legacy-op-upgrade\.test\.ts$`
     - `^packages/backend/tests/upgrade-rolling\.test\.ts$`
     - `^packages/backend/tests/fusion-provenance-repair\.test\.ts$`
     - `^packages/backend/tests/rfc370-skill-identity-content\.test\.ts$`
   - **`core`（常规后端集，当前工作树约 2,759 文件）**：`all \ migration`。任何新添加的非迁移测试文件默认自动归入 `core`。
   - **`all`（全量集，用于 `backend-full-nightly.yml`）**：完整扫描全集（当前工作树约 3,198 文件）。
3. **固定置顶分片（消除 N−1 片 `opencode` 安装开销）**：
   - `SHARD_1_PINNED_FILES = ['packages/backend/tests/cli.test.ts', 'packages/backend/tests/opencode-version.test.ts']`。
   - 在 `tier == 'core'` 与 `tier == 'all'` 时先将这两个文件置入 shard 1 并累加权重，再对剩余文件按权重降序（同权重按路径字典序）执行确定性 LPT 装箱。
   - 单测锁死：① exact-once 分片（并集 = 目标集、两两无交集）；② `cli.test.ts` 与 `opencode-version.test.ts` 恒落 shard 1；③ 任何调用 `describeQ3PhaseBoundary` / `describeV1Providers` / `describeV2Providers` / `describeV3Providers` / `describeV3CrossProvider` / `describeRfc398Postgresql` 的测试文件（除 `architecture/` 静态检测外）严格满足 `∈ migration`（即 `∉ core`）；④ 任何将全部用例仅受 `includes('postgresql')` 或 `.filter(... === 'postgresql')` 门控的纯 PG 测试文件（除 `architecture/` 静态检测外）必须满足 `∈ migration ∪ TEST_BACKEND_POSTGRESQL_FILES`，绝不允许仅停留在 SQLite-only 的 `core` 通道而缺失真 PG push 门禁覆盖。
4. **权重来源与未测文件默认权重**：
   - `tier == 'core'`：优先读 `.github/backend-core-test-timings.json`（若不存在或某文件未测，回退读 `.github/backend-test-timings.json`；皆无则默认 `10_000` ms）。
   - `tier == 'migration'` 与 `tier == 'all'`：读 `.github/backend-test-timings.json`（未测默认 `30_000` ms）。
5. **执行包装器 `scripts/ci/run-backend-shard.ts`**：
   - 接收 `--tier <core|migration|all> --shard=<N/M> --seed=<seed> --timings-out=<path> [--coverage]`（统一用 `=` 形式并与 `rfc349` 守卫对齐）。
   - **防残留合并与漏跑自证**：spawn 前先 `rmSync(timingsOut, { force: true })`（Bun `--update-timings` 在无 `--shard` 时会合并既有文件）；执行 `Bun.spawn(['bun', 'test', '--isolate', '--randomize', '--seed=' + seed, ...coverageFlags, '--timings=' + timingsOut, '--update-timings', ...files])`；若 `bun test` 退出码为 0，读取 `timingsOut` 并校验其 `files` 键集与本片规划的 `files` 逐项完全一致（不符则打印差异并退出 1）。

### 3.3 四个后端作业的具体配置

| 作业 | 位置与触发 | 分片数与预算 | Provider 与 PG | `--coverage` / Codecov | `opencode` | 环境与计时 artifact |
| --- | --- | --- | --- | --- | --- | --- |
| `test-backend` | `ci-work.yml`（每次代码 push） | **16 片**，Ubuntu，15m | `AW_TEST_PROVIDERS: sqlite`（无 PG 容器） | 无 | 仅 `matrix.shard == 1` | `RUN_GIT_NETWORK: '1'`、`RUN_CHAOS: '1'`、`AW_TEST_FIXTURE_CACHE_DIR`、seed；上传 `backend-core-timings-${{ matrix.shard }}`（内含 `backend-core-timings.json`） |
| `test-backend-postgresql` | `ci-work.yml`（每次代码 push） | **1 片**，Ubuntu，15m | 真 PG 17（`start rfc357`），**不设 `AW_TEST_PROVIDERS`**，同时设 `RFC357_DATABASE_URL` 与 `AW_TEST_POSTGRESQL_URL` | 无 | 无 | 16 文件（含真实双引擎评审/任务/ACL/查询计划与 G1 稳定/READ COMMITTED 并发写锁/最新 PG 升级）+ `rfc359-p0-mutations`；无计时 artifact |
| `test-backend-migration` | `ci-work.yml`（仅 `inputs.run_migration_full`） | **28 片**，Ubuntu，15m | 真 PG 17（`start awtest`），**不设 `AW_TEST_PROVIDERS`** | 无 | 无 | `RUN_GIT_NETWORK: '1'`、`RUN_CHAOS: '1'`、`AW_TEST_FIXTURE_CACHE_DIR`、seed；仍传 `--timings-out="$RUNNER_TEMP/backend-migration-timings.json"` 做本片键集完整性本地自证，但**不上传计时 artifact**（统一消费 nightly 产出的 `.github/backend-test-timings.json`，避免无消费上传） |
| `test-backend-full` | 新建 `backend-full-nightly.yml`（`0 2 * * *` + `workflow_dispatch`） | **44 片**，Ubuntu，15m | 真 PG 17（`start awtest`），**不设 `AW_TEST_PROVIDERS`** | **开启** `--coverage --coverage-reporter=lcov` + Codecov 上传 | 仅 `matrix.shard == 1` | `RUN_GIT_NETWORK: '1'`、`RUN_CHAOS: '1'`、`AW_TEST_FIXTURE_CACHE_DIR=$RUNNER_TEMP/aw-test-fixtures`、seed、`shell: bash`、bun `1.4.3`；上传 `backend-full-timings-${{ matrix.shard }}`（内含 `backend-full-timings.json`） |

容量与余量测算（基于当前工作树实盘 3,198 文件与 `.github/backend-test-timings.json` 3-run 最大包络）：
- `test-backend`（16 片，SQLite-only）：约 2,759 文件按 3-run 双引擎最大包络 LPT 装箱约 14.2m/片，按保守 0.62× SQLite 折算最长片约 **8.8m** + ~0.5m 准备 = **~9.3m**（15m 预算的 62%），单次代码 push 后端成本预计 ~95–120 runner-分钟（原 435 runner-分钟，降 ~73%）。
- `test-backend-postgresql`（1 片，真 PG 17 双引擎）：原 5 个 `rfc357` / `rfc359-engine-capabilities` 文件（13.2s）+ `scripts/rfc359-p0-mutations.ts`（仓内实测 `ci-cf4f93cc8.json` 约 **85s**）+ 11 个真实双引擎/PG 专属代表文件（导出为常量 `TEST_BACKEND_POSTGRESQL_FILES`，共 16 文件）：
  1. `packages/backend/tests/rfc359-each-provider-harness.test.ts`（13.7s）
  2. `packages/backend/tests/rfc311-perf-guards.test.ts`（94.9s — 同进程双引擎查询计划对拍）
  3. `packages/backend/tests/architecture/rfc359-w5-composition-root-route-surface.test.ts`（5.4s — 同进程双引擎路由面对拍）
  4. `packages/backend/tests/rfc359-w6-t26-postgresql-plan-audit.test.ts`（88.8s — PG 执行计划审计）
  5. `packages/backend/tests/rfc359-w8-migration-lock-scope.test.ts`（5.1s — PG 迁移锁作用域）
  6. `packages/backend/tests/rfc615-g1-plan-stability.test.ts`（6.3s — PG G1 计划稳定性，纯 PG `.filter(... === 'postgresql')` 用例）
  7. `packages/backend/tests/rfc397-owner-fenced-writes-read-committed.test.ts`（23.5s — PG `READ COMMITTED` 并发写锁与 40001 重放，含 `.filter(... === 'postgresql')` 专属段）
  8. `packages/backend/tests/tasks.test.ts`（37.5s — 核心任务双引擎 CRUD）
  9. `packages/backend/tests/rfc359-t2c-review-decision.test.ts`（7.6s — 真实 `describeEachProvider` 评审决定双引擎命令，替代原纯 SQLite 的 `review-state-machine.test.ts`）
  10. `packages/backend/tests/rfc099-acl-endpoints-matrix.test.ts`（98.1s — 核心 ACL 双引擎矩阵）
  11. `packages/backend/tests/release-upgrade-matrix-56-v0_19_3-postgresql.test.ts`（36.6s — 最新正式版 PG 升级冒烟）
  合计测试约 **430.7s（7.2m）** + P0 变异 ~85s（1.4m）+ 准备 ~45s ≈ **~9.4 分钟**（15m 预算的 63%）。保留 `if grep -q "(skip).*real PostgreSQL"` 显式防空跑断言。
- `test-backend-migration`（28 片，真 PG 17 双引擎）：当前工作树约 439 文件（含并发 RFC-626 新增的 65 个文件，其中 63 个尚未进入既有计时文件，按 30s 未测默认权重计）按 LPT 装箱均值约 **9.7m** + ~0.8m 准备 = **~10.5m**（15m 预算的 70%；待首次 `backend-full-nightly` 刷新 RFC-626 实测权重后进一步均衡）。

### 3.4 macOS E2E 稳定性调优（`e2e-macos`）

- `playwright.ci.config.ts` 读取可选整数环境变量 `AW_E2E_WORKERS`（须为 1–8 整数，非法值抛错），设置时覆盖 `workers`；更新顶部注释。
- `.github/workflows/ci-work.yml` 的 `e2e-macos` 作业设置 `AW_E2E_WORKERS: '3'`（匹配 `macos-26-arm64` 3 vCPU）。Linux、Windows 与本地 `playwright.config.ts` 保持 `workers: 4`。
- `scripts/ci/e2e-shards.ts` 将 `assertE2ERuntimeSelection` 的硬编码 `config.workers !== 4` 改为按平台查表 `EXPECTED_E2E_WORKERS = { linux: 4, macos: 3, windows: 4 }`，校验 `config.workers !== EXPECTED_E2E_WORKERS[plan.platform] || config.fullyParallel`（保持严格 fail-closed：Linux/Windows 非 4 仍红，macOS 非 3 红）。同步更新 `packages/backend/tests/ci-e2e-shards.test.ts`。

## 4. `ci-timings.yml` 与计时脚本演进

1. **触发与独立并发组**：
   - `on.workflow_run`: `workflows: [CI, backend-full-nightly]`，`types: [completed]`。
   - `collect.if` 允许 `conclusion == 'success'`、同仓、`head_branch == 'main'`，且 `(workflow_run.name == 'CI' && (event == 'push' || event == 'workflow_dispatch')) || (workflow_run.name == 'backend-full-nightly' && (event == 'schedule' || event == 'workflow_dispatch'))`。
   - 并发组按来源拆分：`group: ci-timing-refresh-${{ github.event.workflow_run.name }}`，`cancel-in-progress: true`（防止 `CI` 完成取消正在进行的 `backend-full-nightly` 收集）。
2. **先探测 artifact 再按来源/版本分流（兼容旧 SHA 且避免 `docs-only` 红）**：
   - 保留既有 `steps.source.outputs.supported` 前置检查以兼容 pre-RFC-611 旧 SHA；随后在下载与上传前调用 `gh api "repos/{repo}/actions/runs/{id}/artifacts?per_page=100" --paginate --jq '.artifacts[].name'`（显式按行输出 artifact 名称，杜绝默认 30 条分页跨页拼接多段 JSON 导致 `JSON.parse` 崩溃），统计三类前缀数量：`backend-test-timings-*`（历史 44 片 `CI`）、`backend-core-timings-*`（新 16 片 `CI`）、`backend-full-timings-*`（新 44 片 `backend-full-nightly`）与 `e2e-test-timings-*`，输出 `collection_mode`（`skip-docs-only` / `legacy-ci` / `core-ci` / `full-nightly`）：
     - **`skip-docs-only`**（`CI` 且后端与 E2E 计时 artifact 均为 0；或历史 `backend-test-timings-*` 且 `workflow_run.event != 'push'`——旧脚本仅接受 `push`）：直接打印说明，**跳过下载、跳过刷新、跳过 `actions/upload-artifact@v6`**（避免 `if-no-files-found: error` 报红），作业退出 0。
     - **`legacy-ci`**（`CI` 且 `workflow_run.event == 'push'` 且含 `backend-test-timings-*`，历史 SHA）：不传 `--tier`，使用旧位置参数命令 `bun scripts/ci/refresh-backend-timings.ts "$RUNNER_TEMP/measured-backend" "$SOURCE_RUN" "$RUNNER_TEMP/timing-review/backend-test-timings.json"` + `refresh-e2e-timings.ts` + 上传。
     - **`core-ci`**（`CI` 且含 `backend-core-timings-*`）：运行 `bun scripts/ci/refresh-backend-timings.ts --tier core ... backend-core-test-timings.json` + `refresh-e2e-timings.ts` + 上传。
     - **`full-nightly`**（`backend-full-nightly` 且含 `backend-full-timings-*`）：运行 `bun scripts/ci/refresh-backend-timings.ts --tier all ... backend-test-timings.json`（**不**运行 `refresh-e2e-timings.ts`）+ 上传。
     - 若出现不合法组合（如 `CI` 有 E2E 无后端、或 `backend-full-nightly` 缺失 artifact），立即失败（fail-closed）。
3. **脚本契约演进（`workflow-source.ts`、`refresh-backend-timings.ts`、`refresh-e2e-timings.ts`、`compose-backend-timings.ts`）**：
   - `assertSuccessfulTimingSource` 接收显式允许对列表 `allowedSources: readonly { workflowName: 'CI' | 'backend-full-nightly'; allowedEvents: readonly string[] }[]`（杜绝跨来源与跨事件非法组合，如 `CI` + `schedule`）：
     - `refresh-e2e-timings.ts` 固定传 `[{ workflowName: 'CI', allowedEvents: ['push', 'workflow_dispatch'] }]`（绝不接受 `backend-full-nightly` 或 `schedule`）；
     - `refresh-backend-timings.ts` 接收可选 `--tier <core|all>`（CLI 省略时默认 `'all'`，与 `compose-backend-timings.ts` 一致）：
       - `--tier core` 固定传 `[{ workflowName: 'CI', allowedEvents: ['push', 'workflow_dispatch'] }]`，并对称校验源为新 `ci-work.yml`、`test-backend` 为 **16 片**且带 `AW_TEST_PROVIDERS: sqlite`、`backend-core-timings-<n>/backend-core-timings.json`（严格拒绝历史 44 片双引擎 `CI` 源或单体 `ci.yml` 误传给 `--tier core`）；
       - `--tier all` 传 `[{ workflowName: 'backend-full-nightly', allowedEvents: ['schedule', 'workflow_dispatch'] }, { workflowName: 'CI', allowedEvents: ['push'] }]`，并按 `run.name` 严格分派：
         - `run.name === 'backend-full-nightly'` → `resolveNightlyBackendSource`（`test-backend-full`、44 片、无 `AW_TEST_PROVIDERS: sqlite`、`backend-full-timings-<n>/backend-full-timings.json`）；
         - `run.name === 'CI'`（历史双引擎 `CI` 源）→ `resolveCiWorkSource`（`test-backend`、保留历史提交自身的源片数且严禁 `AW_TEST_PROVIDERS: sqlite`、`backend-test-timings-<n>/backend-test-timings.json`，拒绝将新 16 片 SQLite `CI` 源误当 `all` 源；多源合成时再由 `compose-backend-timings.ts` 统一锁定 `sourceShards === 44`）。
   - `workflow-source.ts` 解析 `ci-work.yml` 同时接受历史 13-job 集合与新 14-job 集合（严格集合相等，仍拒绝未知 job），并新增 `resolveNightlyBackendSource` 解析 `.github/workflows/backend-full-nightly.yml`（校验仅含 `test-backend-full`）。
   - `refresh-backend-timings.ts` 改用 `YAML.parse`（`import { YAML } from 'bun'`）读取目标作业（`test-backend` 或 `test-backend-full`）的 `matrix.shards` 与上传步骤条件：`assertSafeBackendTimingUploads` 对非 OS-matrix 的 `test-backend-full` 允许精确 `if: success()`，对 OS-matrix 的 `test-backend` 允许 `if: success() && matrix.os == 'ubuntu-latest'`，均严格拒绝 `failure()` / `always()` 或缺失 `success()`；按 `--tier <core|all>` 复用 `scripts/ci/backend-shards.ts` 过滤 `expectedFiles` 与 `readBackendTimingTarget(tier)`，**CLI 入口亦改用 `readBackendTimingTarget(tier).files` 执行投影**（避免 `--tier core` 将 `migration` 文件误记为 `unmeasured`）；在 provenance 中写入 `tier: 'core' | 'all'`。
   - `compose-backend-timings.ts` 新增 `--tier <core|all>` 参数（CLI 默认 `'all'` 以兼容旧调用），将 `tier` 传入 `loadBackendTimingSource` 与 `readBackendTimingTarget(tier)`；按档严格锁定分片数（`core` 必须 `sourceShards === 16`，`all` 必须 `sourceShards === 44`，拒绝残缺片数或跨档混拼），允许 `sourceWorkflowPath` 为 `.github/workflows/ci.yml`、`.github/workflows/ci-work.yml` 或 `.github/workflows/backend-full-nightly.yml`。

## 5. 协作规范更新（C）

在 `CLAUDE.md` §工作准则与 `docs/dev-gotchas.md` 新增条目：
- 同一 RFC 的多轮文档修订（例如设计门第 1～N 轮修改）应先在本地 `main` 上连续 commit，待阶段收敛后再执行一次 `git fetch && git merge && git push`，避免逐轮推送纯文档或半成品修订频繁触发 CI。说明这与「本地 `main` 不得落后于 `origin/main`」不冲突（本地领先推送前先同步远端即可）。

## 6. 既有测试与守卫同步清单

1. `packages/backend/tests/root-test-entrypoint.test.ts`：更新工作流级并发断言（移除 `queue: max` 与双 lane、删除 `.github/actionlint.yaml` 断言、反转单 group 负控）、更新 `ci.yml` 4 作业与 `ci-work.yml` 14 作业列表、`ci-feedback.yml` 纯文档 `paths-ignore`、将 `--coverage` / Codecov 断言迁至 `backend-full-nightly.yml`、更新 `test-backend`（16 片）与 `test-backend-migration`（28 片）与 `backend-full-nightly`（44 片）矩阵及 `ci-timings.yml` 分组断言。
2. `packages/backend/tests/rfc615-ci-calculation-admission.test.ts`：更新工作流级并发、4 入口作业、14 `ci-work` 作业、`CI required` Bash 脚本对 `docs-only` / `standard` / `full` 三模式全部合法与非法组合的真实执行测试，以及扩展零第三方依赖检查涵盖 `classify-ci-changes.ts` 与 `backend-shards.ts`。
3. `packages/backend/tests/architecture/rfc359-w8-ci-dual-engine-wiring.test.ts`：显式允许 `ci-work.yml:test-backend` 与 `ci.yml:docs-fast-gate` 使用 `AW_TEST_PROVIDERS=sqlite`，同时重构 `hasUbuntuPostgresWiring`（保留严格顺序与完整负夹具强度）闭环锁死 `ci-work.yml:test-backend-postgresql`、`ci-work.yml:test-backend-migration` 与 `backend-full-nightly.yml:test-backend-full` 均完整接入真 PG 17 且无 `AW_TEST_PROVIDERS` 收窄；仍拒绝任何未登记的 Ubuntu `AW_TEST_PROVIDERS` 注入。
4. `packages/backend/tests/rfc349-postgresql-hosted-evidence.test.ts` 与 `packages/backend/tests/helpers/rfc349PostgresqlHostedEvidence.ts`：更新 `test-backend`（16 片）、`test-backend-migration`（28 片）与 `backend-full-nightly`（44 片）矩阵，对齐 `--shard=${{ matrix.shard }}/${{ matrix.shards }}` 入口命令与 `backend-full-nightly` 全量回归归属，验证 `opencode-ai@latest` 安装在 `shard == 1` 且 `cli.test.ts` 被 `backend-shards.ts` 锁定在 shard 1。
5. `packages/backend/tests/ci-e2e-shards.test.ts` 与 `packages/backend/tests/ci-e2e-timing-refresh.test.ts`：验证按平台预期 worker（`{ linux: 4, macos: 3, windows: 4 }`，含负控）以及 E2E 计时源接受 `CI` `push`/`workflow_dispatch` 且拒绝 `backend-full-nightly`。
6. `packages/backend/tests/ci-backend-timing-refresh.test.ts` 与 `packages/backend/tests/ci-design-link-selection.test.ts`：覆盖 `core` / `all` / legacy 三路收集、`docs-only` 干净跳过、按档精确片数（16/44）与禁止跨 tier 混拼、`AW_DESIGN_LINKS_BASE_SHA`（含 `ALL` 哨兵、`pull_request` 不可变 `head.sha` 与 `workflow_dispatch mode=auto`）及历史 13-job / 44-shard 兼容。
7. `packages/backend/tests/test-suite-policy.test.ts`、`packages/backend/tests/rfc349-functional-evidence.test.ts`、`packages/backend/tests/ci-workflow-path-filters.test.ts`：核验 `RUN_CHAOS: '1'`、`RUN_GIT_NETWORK: '1'`、后端命令前缀与 `ci-feedback.yml` 新增 `paths-ignore` 全部通过。
8. **新增回归测试**：
   - `packages/backend/tests/rfc627-ci-change-classification.test.ts`：全覆盖 `classify-ci-changes.ts` 的 `docs-only` / `standard` / `full` 判定、排队合并跨多提交累计 diff、重命名展开（源码改名 `.md` 必不判 `docs-only`）、`evidence/` / `design/*.json` / `table-mapping.md` / `schema-contract.md` / `docs/crewstation-automation.md` 排除、全部字面触发路径/目录存在性校验、**不变量 `∀ f ∈ migration: classify([f]) === 'full'`**、200 条分页与 API/git 异常/空 diff fail-closed 降级 `full`。
   - `packages/backend/tests/rfc627-backend-shard-planner.test.ts`：全覆盖 `backend-shards.ts` 与 `run-backend-shard.ts` 的 `core ∩ migration = ∅`、`core ∪ migration = all`、`CORE_MIGRATION_SMOKE` 全存在且零 PG helper 引用、全仓 PG 迁移 helper 测试严格 `∈ migration`、全仓纯 PG 测试（全部用例仅受 `includes('postgresql')` 或 `.filter(... === 'postgresql')` 门控）严格 `∈ migration ∪ TEST_BACKEND_POSTGRESQL_FILES`（零无真 PG 门禁兜底的漏网文件）、`cli.test.ts` / `opencode-version.test.ts` 恒落 shard 1、确定性 LPT 分片 exact-once、`timingsOut` 清理与键集一致自证、以及 `playwright.ci.config.ts` 的 `AW_E2E_WORKERS` 正反边界测试。

## 7. 风险与回滚

- **风险 1：`test-backend` 16 片首次运行使用旧双引擎权重缩放**。缓解：LPT 装箱下约 2,759 文件即使双引擎包络也仅 ~14.2m/片，SQLite-only 实测约 6–9m/片（15m 预算 ~62%）；首轮绿灯后由 `ci-timings.yml` 自动生成真实 SQLite 权重 `.github/backend-core-test-timings.json` 并合入。
- **风险 2：`detect-changes` 查询 GitHub Actions API 遇短暂 5xx 或限流**。缓解：明确 fail-closed 为 `mode=full, links_base_sha=ALL`，绝不误走 `docs-only` 或漏检外链与迁移矩阵。
- **风险 3：`e2e-macos` 改为 3 worker 后个别重片耗时接近预算**。缓解：按实测模型最重片约 11.8m（59% 预算），若 hosted 实测超 15m 可单行调整 `AW_E2E_WORKERS` 与表值，不影响其余改动。
- **风险 4：与在途 RFC-626 并发**。缓解：零改动 `packages/backend/src/`；`rfc626-*` 全部 65+ 测试、平台内容迁移（`platform/content/migration/`）及全部模块/平台 `schema.ts` 均已纳入 `migration` 集与 `full` 触发集，且 `test-backend-migration` 扩至 28 片（按 30s 未测默认权重计均值 ~9.7m + 0.8m 准备 = ~10.5m，70% 预算），RFC-626 提交仍完整运行全量双引擎迁移验证。
- **整体回滚**：改动集中在 `.github/`、`scripts/ci/`、`playwright.ci.config.ts` 与测试守卫，可单提交回滚，且随时可用 `workflow_dispatch`（默认 `mode=full`）强制跑完整验证。

## 8. 设计门修订记录

### 第一轮（2026-11-27，独立只读 subagent，只审功能，结论：FAIL — 5 P0 / 5 P1 / 3 P2）

全部 13 条意见逐条对源码核实属实，已全量采纳修订进 `proposal.md` / `design.md` / `plan.md`：

- **P0-1**（`e2e-shards.ts:242-251` 硬锁 `workers === 4` 会使 `e2e-macos` 必红）：改为按平台校验 `{ linux: 4, macos: 3, windows: 4 }` 并同步 `ci-e2e-shards.test.ts`（§3.4、§6、plan T3/T6）。
- **P0-2**（`bunfig.toml` 根配置导致根 `bun test` 静默跳过 2 个 `packages/shared/tests/*`）：在 `docs-fast-gate` 拆出独立 `bun run --filter @agent-workflow/shared test -- ...` 命令（§2.3）。
- **P0-3**（`ci-timings.yml` 与计时脚本四处断点）：按 `(workflowName, allowedEvents)` 隔离来源、拆分为 `ci-timing-refresh-${{ github.event.workflow_run.name }}` 双并发组、按 API artifact 前缀四路分流（`skip-docs-only` 跳过上传、`legacy-ci` 兼容旧无 `--tier` CLI、`core-ci`、`full-nightly`），并将 `refresh-backend-timings.ts` 改为 `YAML.parse` + tier 过滤与独立文件名约定（§4、plan T4/T5）。
- **P0-4**（`mode=full` 漏跑 2 个 Q3 双引擎冒烟及 ~30 个核心迁移/升级 PG 测试，含并发 RFC-626）：`CORE_MIGRATION_SMOKE` 严格限定为 7 个纯 SQLite/静态文件（单测锁死无 PG helper），扩充 `migration` 集纳入全部 `rfc395-*` / `rfc398-*` / `rfc626-*` / `release-upgrade-matrix-*` 及相关 PG 迁移测试，使 `core ∩ migration = ∅`、`core ∪ migration = all`，`test-backend` 调为 16 片、`test-backend-migration` 调为 26 片（§3.2、§3.3）。
- **P0-5**（`classify-ci-changes.ts` `full` 触发路径遗漏 `system-operations`、`src/db/`、`bootstrap/`、`cli/` 及 13 模块 `schema.ts` 等）：已全量补齐并逐一核实路径存在，加存在性单测锁（§2.2、§6）。
- **P1-1**（漏排 `schema-contract.md` / `docs/crewstation-automation.md` 及 12 个文档契约测试）：已排除两份特殊文档，并将 23 个后端 + 2 个 shared 共 25 个文档契约测试全部纳入 `docs-fast-gate`（§2.2、§2.3）。
- **P1-2**（`review-state-machine.test.ts` 为纯 SQLite，P0 变异实测 ~85s）：替换为真实双引擎 `rfc359-t2c-review-decision.test.ts` 并修正耗时测算为 ~8.9m（§3.3）。
- **P1-3**（`detect-changes` 分页/浅克隆 ref/setup-bun/`AW_DESIGN_LINKS_BASE_SHA=ALL` 兜底）：已改 `per_page=100` 最多 2 页、`checkout@v5` `fetch-depth: 200` + `filter: blob:none`、显式 `setup-bun 1.4.3` + `GH_TOKEN` + 精确 `full-ci` `if:`、以及 `links_base_sha='ALL'` 哨兵（§2.2、§2.3、§2.4）。
- **P1-4**（漏列同步测试文件、`run-backend-shard.ts` 防残留合并与全集自证、`backend-full-nightly.yml` 环境变量完整规格）：已全部补齐（§3.2、§3.3、§6、plan T3/T4/T5/T6）。
- **P1-5**（`compose-backend-timings.ts` 禁止跨 tier 混拼；删除无消费的 `backend-migration-timings-*` 上传）：已补齐（§3.3、§4）。
- **P2-1 / P2-2 / P2-3**：为 `ci-feedback.yml` 补齐推/PR 对称纯文档 `paths-ignore`（§2.1、proposal §3 #8）；明确 `workflow_dispatch mode=auto` 在已绿 HEAD 降级 `full` 并修正 plan T9 验收方式；统一实盘动态计数口径与零第三方依赖硬约束（§1、§3.2）。

### 第二轮（2026-11-27，独立只读 subagent，只审功能，结论：FAIL — 2 P0 / 2 P1 / 2 P2）

全部 6 条意见逐条核实属实并全量采纳修订：

- **P0-1**（`full` 触发集漏掉 9 个 `migration` 档测试文件、`platform/content/migration/`、6 个平台 `schema.ts`、`migrationDecision.ts`、`dbCompact.ts`、共享双引擎夹具与 `bunfig.toml`）：`classify-ci-changes.ts` 改为直接复用 `isMigrationTierTest(path)` 从构造上锁死 `∀ f ∈ migration: classify([f]) === 'full'`，正则扩展至 `(?:modules|platform)`，并补齐全部 18 个已验证存在的源码/夹具/配置路径（§2.2、§6）。
- **P0-2**（4 个托管 PG 集成测试与 5 个 PG 迁移器/逻辑源/备份恢复/升级测试仍滞留 `core` 致 `mode=full` 漏跑或跑 0 用例）：全部 9 个文件并入 `migration` 档，并新增静态守卫禁止全用例包在 `includes('postgresql')` 的纯 PG 文件落入 `core`（§3.2、§6）。
- **P1-1**（`gh api --paginate` 跨页 JSON 拼接崩、`assertSuccessfulTimingSource` 单对象签名与 `--tier all` 双来源矛盾、`compose-backend-timings.ts` 缺 `--tier` 与按档锁定片数 16/44）：改为 `?per_page=100 --paginate --jq '.artifacts[].name'`、允许对列表 `allowedSources` 按 `run.name` 严格分派并拒绝新 16 片 SQLite 源误作 `all`、为 `compose-backend-timings.ts` 与 `readBackendTimingTarget(tier)` 补 `--tier <core|all>` 并按档锁死 16/44 片（§4）。
- **P1-2**（`check-design-links.ts` 在 `pull_request` 下用 `GITHUB_SHA` 合成 merge commit 作为 `head`）：改为按事件解析不可变 `head` 端点（`pull_request` 恒取 `payload.pull_request.head.sha`）（§2.3）。
- **P2-1 / P2-2**：按当前工作树实盘 3,198 文件（含并发 RFC-626 新增 65 文件）将 `test-backend-migration` 由 26 片扩至 28 片留足 15m 余量；`docs-fast-gate` 改为 YAML `env: { AW_TEST_PROVIDERS: sqlite }` 并显式登记进 `rfc359-w8`；明确 `test-backend-migration` 仍传 `--timings-out` 做本地键集自证；明确 `assertSafeBackendTimingUploads` 兼容非 OS-matrix 的 `if: success()`（§2.3、§3.3、§4、§6）。

### 第三轮（2026-11-27，独立只读 subagent，只审功能，结论：PASS WITH FINDINGS — 0 P0 / 2 P1 / 1 P2）

零 P0 阻断；余下 2 项 P1 与 1 项 P2 核实属实并已全部采纳修订：

- **P1-1**（`rfc615-g1-plan-stability.test.ts` 以 `.filter(... === 'postgresql')` 门控、在 SQLite-only 下跑 0 用例且未入任何 PG push 门禁）：将其（6.3s）并入 `test-backend-postgresql`（14 → 15 文件，总计 ~9.0m / 60% 预算），并把纯 PG 静态守卫扩展至覆盖 `.filter(... === 'postgresql')` 写法（§3.2、§3.3、§6）。
- **P1-2**（纯 PG 守卫不变量表述与 `rfc359-w6-t26-postgresql-plan-audit` / `rfc359-w8-migration-lock-scope` 归属自相矛盾）：明确不变量为「迁移/Q3/V1-V3/RFC-398 helper 测试严格 `∈ migration`；全用例受 `includes('postgresql')` 或 `.filter(... === 'postgresql')` 门控的纯 PG 测试严格 `∈ migration ∪ TEST_BACKEND_POSTGRESQL_FILES`」（§3.2、§6）。
- **P2-1**（`refresh-backend-timings.ts` `--tier core` 对称校验、CLI 投影目标与 `legacy-ci` 仅限 `push` 事件）：全部明确写入 §4。
