# RFC-627 实施计划

状态：Done（2026-11-28，T1–T9 全部完成并通过四档 hosted CI 实测验收，完整数据与保留项见 [acceptance.md](./acceptance.md)）。

## 1. 任务分解

| 任务 | 内容 | 主要改动文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-627-T1 | 实现零第三方依赖的后端分层与 LPT 分片规划器及执行包装器（导出 `isMigrationTierTest`、`core`/`migration`/`all` 互斥完备切分、含 9 个托管 PG 与 PG 迁移器测试、7 个纯 SQLite/静态 `CORE_MIGRATION_SMOKE`、shard 1 固定 `cli.test.ts` + `opencode-version.test.ts`、`timingsOut` 预清理与返回键集一致性自证） | `scripts/ci/backend-shards.ts`、`scripts/ci/plan-backend-shards.ts`、`scripts/ci/run-backend-shard.ts` | 无 |
| RFC-627-T2 | 实现零第三方依赖的变更分类与未验证区间解析脚本（复用 `isMigrationTierTest` 锁死迁移测试联动、`per_page=100` 最多 2 页 `last_green_sha` 祖先查找、`--no-renames` diff、严格 `docs-only` 白名单排除 3 个契约文档、完整 `full` 触发集含 `platform/content/migration/` 与全仓 38 个 `schema.ts` 及双引擎夹具、`links_base_sha='ALL'` fail-closed 兜底） | `scripts/ci/classify-ci-changes.ts` | T1 |
| RFC-627-T3 | 扩展 `check-design-links.ts` 支持 `AW_DESIGN_LINKS_BASE_SHA`（含 `ALL` 哨兵、`pull_request` 不可变 `head.sha` 与 `workflow_dispatch mode=auto`）；扩展 `playwright.ci.config.ts` 支持 `AW_E2E_WORKERS` 校验与覆写；更新 `scripts/ci/e2e-shards.ts` 按平台校验 `{ linux: 4, macos: 3, windows: 4 }` | `scripts/ci/check-design-links.ts`、`playwright.ci.config.ts`、`scripts/ci/e2e-shards.ts` | 无 |
| RFC-627-T4 | 更新 `workflow-source.ts`、`refresh-backend-timings.ts`、`refresh-e2e-timings.ts`、`compose-backend-timings.ts` 以支持 14-job `ci-work.yml`、`backend-full-nightly.yml`、允许对列表 `allowedSources` 严格隔离来源与 `--tier all` 双来源分派、`YAML.parse` 分片解析与非 OS-matrix `if: success()` 兼容、`core`/`all` 分档收集与按档锁定片数（16/44）禁止跨档混拼、及历史 13-job / 44-shard 兼容 | `scripts/ci/workflow-source.ts`、`scripts/ci/refresh-backend-timings.ts`、`scripts/ci/refresh-e2e-timings.ts`、`scripts/ci/compose-backend-timings.ts` | T1 |
| RFC-627-T5 | 改造全部受影响工作流：`ci.yml`（工作流级单组并发、`detect-changes`、`docs-fast-gate` 含 YAML `env: AW_TEST_PROVIDERS=sqlite` 23 后端 + 独立 shared 命令、`full-ci` 精确 `if:`、三模式 fail-closed `ci-required`）、`ci-work.yml`（16 片 SQLite `test-backend`、16 文件增强 `test-backend-postgresql` 含 `rfc359-t2c-review-decision`、`rfc615-g1-plan-stability` 与 `rfc397-owner-fenced-writes-read-committed`、条件 28 片双引擎 `test-backend-migration` 带本地 `--timings-out` 自证不上传 artifact、`e2e-macos` `AW_E2E_WORKERS=3`）、新增 `backend-full-nightly.yml`（44 片双引擎 + `--coverage` + Codecov + 完整 env）、更新 `ci-timings.yml`（双并发组 + 保留 `supported` 检查 + `?per_page=100 --paginate --jq '.artifacts[].name'` 四路分流 + `docs-only` 跳过上传）、更新 `ci-feedback.yml`（推/PR 对称纯文档 `paths-ignore`）、删除 `.github/actionlint.yaml` 并同步 `package.json`（`format:check:repo-ui`、`lint:repo-ui`） | `.github/workflows/ci.yml`、`.github/workflows/ci-work.yml`、`.github/workflows/backend-full-nightly.yml`、`.github/workflows/ci-timings.yml`、`.github/workflows/ci-feedback.yml`、`.github/actionlint.yaml`（删）、`package.json` | T1–T4 |
| RFC-627-T6 | 同步更新既有 CI 拓扑/双引擎/E2E/计时/链接守卫测试，并编写 RFC-627 专项正反回归测试（含所有禁用/拒绝/降级分支、零第三方依赖锁、路径存在性锁、schema/conversion 触发不变量锁、真实 Bun `--timings` 键集集成锁与 `CORE_MIGRATION_SMOKE` 纯度锁） | `packages/backend/tests/root-test-entrypoint.test.ts`、`rfc615-ci-calculation-admission.test.ts`、`architecture/rfc359-w8-ci-dual-engine-wiring.test.ts`、`rfc349-postgresql-hosted-evidence.test.ts`、`ci-e2e-shards.test.ts`、`ci-e2e-timing-refresh.test.ts`、`ci-backend-timing-refresh.test.ts`、`ci-design-link-selection.test.ts`、`rfc349-functional-evidence.test.ts`、`rfc627-ci-change-classification.test.ts`、`rfc627-backend-shard-planner.test.ts` | T1–T5 |
| RFC-627-T7 | 更新协作规范（多轮修订本地攒批推送）与 `codecov.yml` 过时注释 | `CLAUDE.md`、`docs/dev-gotchas.md`、`codecov.yml` | T5 |
| RFC-627-T8 | 集中验证：运行全部新增与受影响测试、prettier/eslint/typecheck/actionlint、独立功能实现门（subagent 只审功能），修完本人 findings 后提交并推送 | 全部本 RFC 文件 | T1–T7 |
| RFC-627-T9 | Hosted 实测验收：分别采集 ① 实现提交自动触发的 `mode=full`、② 一次真实纯文档提交触发的 `mode=docs-only`（验证 `ci-timings.yml` 跳过且 `ci-feedback.yml` 不空跑）、③ 一次真实非迁移提交触发的 `mode=standard`（验证 16 片核心 + 增强 PG 门禁 + macOS 3 worker E2E）、④ 手动触发 `backend-full-nightly.yml`（44 片双引擎 + coverage + Codecov + `ci-timings.yml` 收集）的真实端到端时长、排队等待、runner-分钟与分片分布；落档 `acceptance.md` 并合入首份 `.github/backend-core-test-timings.json`，将 RFC-627 置 Done | `design/RFC-627-ci-throughput-tiered-verification/acceptance.md`、`.github/backend-core-test-timings.json`、`design/plan.md`、`STATE.md` | T8 |

## 2. 验证与验收清单

- [x] **设计门**：由本 session 派生只读 subagent 独立检视三件套（只审功能，禁止碰安全），历经三轮检视（第一轮 5 P0/5 P1/3 P2、第二轮 2 P0/2 P1/2 P2、第三轮 `PASS WITH FINDINGS` 0 P0/2 P1/1 P2），全部 findings 均已逐条核实并修订。
- [x] **用户审批**：向用户呈交 RFC-627 摘要与能力影响清单，2026-11-27 获明确回复「批准实施」后进入 T1–T7 实现。
- [x] **集中功能验证（T1–T7 全部完成后一次性执行）**：
  - [x] `bun run format:check:repo-ui`、`bun run lint:repo-ui`、改动文件 `prettier`/`eslint`、`depcheck` 与 `typecheck`（本 RFC 全部改动文件零错误）全部通过。
  - [x] `actionlint` 校验全部 `.github/workflows/*.yml` 零错误（已删除 `.github/actionlint.yaml` 豁免）。
  - [x] 所有新增与更新的后端 CI 测试文件（`rfc627-*`、`root-test-entrypoint`、`rfc615-ci-calculation-admission`、`rfc359-w8-ci-dual-engine-wiring`、`rfc349-postgresql-hosted-evidence`、`rfc349-functional-evidence`、`ci-e2e-shards`、`ci-backend-timing-refresh`、`ci-e2e-timing-refresh`、`ci-design-link-selection`、`ci-workflow-path-filters`、`test-suite-policy`、`rfc-index-status-drift`、`rfc317-*`）在 `--isolate` 下全部通过。
  - [x] `docs-fast-gate` 的 23 个后端文件（190 pass / 0 fail）与 2 个 shared 文件（19 pass / 0 fail，经 `--filter @agent-workflow/shared`）全部真实执行并通过。
- [x] **实现门**：由本 session 派生只读 subagent 独立检视完整实现与测试（只审功能，禁止碰安全），结论 `PASS WITH FINDINGS`（0 P0 / 3 P1 / 2 P2）；已全部核实并修复 3 项 P1（补齐 `conversion.ts`/`*Schema.ts`/`fixtures/release-upgrade/`/`fixtures/shipped-migrations/`/`content/inventory/`/`historyRestriction.ts` 全量触发与结构不变量守卫、实证并新增真实 Bun 1.4.3 `--timings` 含 0 用例纯 PG 文件集成用例、`planBackendShards` 与 `runBackendShard` 空分片 fail-closed）及 2 项 P2（`ci-timings.yml` 收紧 `skip-docs-only` 为零 artifact + POSIX `grep -Ec`、`plan-backend-shards.ts` `--output` 缺参校验与文档口径同步）。
- [x] **Hosted 实测验收**：
  - [x] 实现提交本身自动触发 `mode=full` 并在主 CI 全绿通过（SHA `f74f5f370f581e41285aa7746ef67b5cdbc243d5`，`CI` run `46085767786` 70/70 首次全绿、端到端 28m 36s、444.98 runner-min；`CI feedback` run `46085767676` 成功；`ci-timings` run `46088340261` 29s 产出首份 2,768 文件 `backend-core-test-timings.json`，`unmeasured=[]`）。
  - [x] 后续一次纯文档提交触发 `mode=docs-only` 绿灯通过（SHA `44a1284ea465bc259db92474e0b3fd7a1e558717`，`CI` run `46088552576` 3/3 首次全绿、端到端 1m 53s、1.68 runner-min〔−99.7%〕，实跑 Lychee + 23 后端 190 pass + 2 shared 19 pass；`ci-timings` run `46088727578` 以 `skip-docs-only` 干净跳过；`ci-feedback` 0 次触发）。
  - [x] 一次非迁移提交验证 `mode=standard` 全绿通过（SHA `f601eed3c2cf732061f90c066b6fefef95c250b1` 合入首份核心计时权重，`CI` run `46089416710` 42/42 首次全绿、端到端 21m 23s、248.00 runner-min〔−55.7%〕；16 片 SQLite 核心全在 4m 50s–7m 18s 且仅 shard 1 装 `opencode`；16 文件真 PG 门禁 423 pass / 9m 19s；macOS 3-worker E2E 三片 10m 55s–13m 40s 零重试；`ci-timings` run `46091278899` 21s `core-ci` 通过）。
  - [x] 手动触发 `backend-full-nightly.yml` 验证 44 片全量双引擎 + `--coverage` + Codecov 与 `ci-timings.yml` 收集通过（SHA `f601eed3c2cf732061f90c066b6fefef95c250b1`，run `46091340641` 44/44 首次全绿、端到端 28m 28s、416.53 runner-min、单片 7m 17s–11m 44s；`ci-timings` run `46093762080` 26s `full-nightly` 产出 3,144 文件完整计时且不刷新 E2E）。
  - [x] 将完整 exact-SHA、实测数据、初始负样本（`41407582` / `46079919995`）与剩余风险如实写入 [acceptance.md](./acceptance.md) 并关闭 RFC-627。

## 3. 设计门记录

- **第一轮（2026-11-27，只读 subagent，只审功能）**：`FAIL`（5 P0 / 5 P1 / 3 P2）。逐条核实源码后全部采纳修订（处置见 `design.md §8`）。
- **第二轮（2026-11-27，只读 subagent，只审功能）**：`FAIL`（2 P0 / 2 P1 / 2 P2）。逐条核实源码后全部采纳修订（处置见 `design.md §8`）。
- **第三轮（2026-11-27，只读 subagent，只审功能）**：`PASS WITH FINDINGS`（0 P0 / 2 P1 / 1 P2）。已采纳全部 3 项（`rfc615-g1-plan-stability.test.ts` 并入 `test-backend-postgresql` 至 15 文件、修正纯 PG 守卫为 `∈ migration ∪ TEST_BACKEND_POSTGRESQL_FILES`、补齐 `refresh-backend-timings.ts` `--tier core` 对称校验与投影口径，处置见 `design.md §8`），设计门收口完成，待用户批准。
