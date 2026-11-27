# RFC-627：CI 吞吐、分层验证与排队治理

状态：In Progress（2026-11-27，独立设计门第三轮 `PASS WITH FINDINGS`〔0 P0 / 2 P1 / 1 P2〕全部 findings 采纳修订后，用户 2026-11-27 明确回复「批准实施」）。用户 2026-11-27 要求分析 GitHub CI 耗时问题并给出优化方案，阅读诊断报告后回复「全部同意」；本 RFC 按仓内流程落档三件套、完成设计门闭环并获批准后进入 T1–T9 实施。

## 1. 背景与实测基线

2026-11-27 抓取仓库最近 300 次 GitHub Actions 运行（2026-11-25 09:09Z 至 2026-11-27 14:21Z，其中主 CI 103 次）并逐 job 拆解 3 次代表运行（空闲 run 45939395356 / `240ee338`、拥堵 run 45986840401 / `033f5faf`、run 45893307751 / `ade7e1dc`），结论是 **CI 慢主要慢在排队，而非单次执行**：

| 指标 | 现状实测 | 说明 |
| --- | --- | --- |
| 单次完整 CI 成本 | 69 个 job，约 560 runner-分钟 | 后端 44 片占 435 分钟（78%），E2E 10 片占 83 分钟（15%），前端 6 片占 24 分钟（4%），其余 8 个 job 占 18 分钟（3%） |
| 空闲执行端到端时长 | 34.4 分钟（run 45939395356） | 受 20 并发槽配额约束，560 ÷ 20 = 28 分钟理论下限 |
| 最近 91 次已完成主 CI 端到端时长 | p10 35m / 中位 80m / p90 143m / 最长 188m | 最长一次（`033f5faf`）在首个 job 启动前纯等待 128 分钟 |
| 推送频率与并发利用率 | 平均 1.8 次/小时（11-26 单日 43 次） | 平均利用率 ρ ≈ 1.8 × 28 / 60 ≈ 0.84，密集修订时 > 1，诊断时刻积压 12 个待跑 run（估 5.6 小时） |
| 纯文档提交占比 | 33 / 100（严格 Markdown 纯文档） | 仅改 `design/`、`docs/`、`STATE.md` 等，仍每次消耗 560 runner-分钟 |
| 后端重型迁移/升级家族占比 | 当前工作树约 430+ 迁移/升级及托管 PG 迁移相关文件（约 245+ 分钟双引擎包络，占全套约一半，且随并发 RFC-626 持续增长） | 最近 100 次提交中仅 11–19 次触及迁移/持久化/升级相关路径，其余 ~85% 代码提交每次空跑历史版本与迁移矩阵 |
| 后端双引擎（SQLite + PG）成本 | 1,250 个直调 `describeEachProvider` 文件（11,524 秒），另含重型迁移 PG 文件 | 对照 `backend-macos-nightly`（run 41441449152，18 片，SQLite-only，无 coverage）：全套测试合计 189.3 分钟；Ubuntu 44 片双引擎 + coverage 为 435 分钟（含约 35 分钟分片固定开销） |
| `--coverage` 本地 A/B 实测 | 6 个常规后端文件 SQLite-only：79.99s → 81.67s（+2.1%） | 常规文件插桩开销较小，但 `docs/dev-gotchas.md:603-606` 记载全树 AST 扫描在 coverage 下显著变慢，且 44 片每片另付 Codecov 上传与外部波动 |
| 主 CI 成功率与 macOS E2E 抖动 | 91 次中 43 success / 37 failure / 11 cancelled（47% 成功） | 已查明 13 次失败中 5 次出现在 `e2e-macos`（`macos-26-arm64` 3 vCPU 宿主机跑 4 个并发 Playwright worker + 4 个守护进程） |

此前 RFC-611 / 615 / 623 / 624 / 625 在「不取消任何旧 SHA、每提交全量双引擎 + coverage + 历史迁移矩阵」的约束下已基本榨干单次准备与分片优化空间（RFC-625 验收总 runner-分钟 559.2 → 561.9，端到端仍受排队支配达 188 分钟）。要根本压缩等待时间，必须调整排队策略与每次 push 的验证分层，同时用夜间全量门禁和路径感知触发守住质量下限。

## 2. 目标与非目标

### 目标

1. **消除无界排队积压**：同 ref 排队深度封顶为「1 个运行中 + 1 个最新待跑」，运行中的 run 不被取消；常态端到端从 80 分钟中位压至 15–35 分钟量级（最终以 hosted 实测为准，不以静态模型冒充结果）。
2. **纯文档提交分钟级收敛**：严格 Markdown 纯文档提交走快速通道，跳过 69-job 全矩阵（同时 `ci-feedback.yml` 对同类纯文档提交跳过空跑），仅运行链接检查与 25 个文档契约测试（23 后端 + 2 shared），在 ~1.5–2 分钟内完成并通过 `CI required`；且在发生排队合并时绝不漏测被覆盖的代码提交。
3. **大幅压缩常规代码提交的后端成本**：非迁移/持久化代码提交运行核心后端测试集（动态扫描全集扣除重型迁移/升级集，保留 7 个纯 SQLite/静态迁移冒烟；SQLite-only、无 coverage、16 分片、仅 shard 1 装 `opencode`）+ 增强型真 PostgreSQL 双引擎冒烟门禁（`test-backend-postgresql`，16 文件含真实双引擎评审/任务/ACL/查询计划稳定/READ COMMITTED 并发写锁/最新 PG 升级 + P0 变异），预计常规代码 push 总 runner-分钟从 ~560 降至 ~220–240（降幅 > 55%）。
4. **保持迁移/持久化与全量双引擎质量网**：触及迁移/持久化/schema/CI/依赖锁/任意迁移测试文件的提交自动提升为 `full` 模式（额外跑 28 片真 PG 双引擎完整迁移矩阵，覆盖全部 430+ 迁移/升级与托管 PG 恢复双引擎文件，零遗漏）；新增每日 `backend-full-nightly.yml` 跑全套后端文件的完整双引擎 + `--coverage` + Codecov，确保任何跨引擎或覆盖率问题在 24 小时内暴露，并支持 `workflow_dispatch` 对单 SHA 随时补跑完整验证。
5. **降低 macOS E2E 过载失败率**：将 `e2e-macos` 的 Playwright worker 从 4 调至 3（并同步 `e2e-shards.ts` 按平台校验），匹配 `macos-26-arm64` 3 vCPU 硬件，不缩减用例与分片数。
6. **固化团队协作提交习惯**：在 `CLAUDE.md` 与 `docs/dev-gotchas.md` 写入多轮文档/设计修订本地攒批后推送的约定。

### 非目标

- **不引入自托管 runner 或付费 larger runner**：涉及外部账号权限与费用，作为后续独立扩容选项保留，不在本 RFC 范围。
- **不做基于静态 import 图的细粒度后端 test-impact 选择**：调研实证后端测试中有 1,069 个（约 34%）通过 `fs` 读源码（756）、全树扫描（145）或起子进程（168）验证，对静态 import 图不可见；优先采用零漏报风险的路径分层（`docs-only` / `standard` / `full`），后续若仍有需要再另立 RFC。
- **不删除任何测试文件、断言或生产能力**，不放宽单测或 job 超时预算，不把失败或超时改写成成功。
- **不修改后端生产源码（`packages/backend/src/`）**，避免与在途 RFC-626（迁移引擎重构）产生任何冲突。

## 3. 能力影响清单（强制逐项确认）

依据 `CLAUDE.md` §RFC workflow 第 7 条，以下 8 项调整会收缩或变更「每次 push」上的既有 CI 门禁行为，并分别给出替代防线、延时/覆盖权衡及仓内既有源码判据（`file:line`）：

| # | 被收缩/变更的既有能力 | 原行为与源码依据 | 新行为与替代防线 | 风险与权衡 |
| --- | --- | --- | --- | --- |
| 1 | **每个 push SHA 拥有独立完整 CI 终态**（替代 RFC-611 队列策略） | `.github/workflows/ci.yml:16-20` 双 lane（`run_number` 奇偶）+ `queue: max` + `cancel-in-progress: false`；锁定于 `packages/backend/tests/root-test-entrypoint.test.ts:165-249`、`packages/backend/tests/rfc615-ci-calculation-admission.test.ts:36-41` | 改为工作流级单并发组（`CI-${{ github.ref }}`；`workflow_dispatch` 独立组 `CI-manual-${{ github.run_id }}`），`cancel-in-progress: false`，移除 `queue: max`。运行中的 run 完整跑完；被更新提交覆盖的待跑（pending）run 被 GitHub 取消为 `cancelled`（不触发 `ci-required`，无假红/假绿）。删除 `.github/actionlint.yaml`。 | 红灯归因从单 SHA 变为两个已完成 run 之间的提交区间；需要精确定位时用 `workflow_dispatch`（默认 `mode=full`）对任意单 SHA 补跑。 |
| 2 | **纯文档提交运行完整 69-job CI 与 `CI required` 全绿判定** | `.github/workflows/ci.yml:22-77` 与 `packages/backend/tests/rfc615-ci-calculation-admission.test.ts:86-101` 要求 13 组门禁无一 `skipped` | 新增 `detect-changes` 作业（以 `main` 上最近一次 `CI` 绿灯祖先 SHA 为对比基点，防止被覆盖的代码提交漏测），仅当整个未验证区间全部落在严格 Markdown 白名单（见 design §2.2）时进入 `docs-only` 模式，运行 `docs-fast-gate`（lychee 离线全量 + 区间外链 + 23 后端 + 2 shared 共 25 个文档契约测试）；`CI required` 显式校验 `(mode, 各作业结果)` 闭集组合，未知模式或任何非预期 `skipped`/`failure`/`cancelled` 仍 fail-closed 退出 1。 | `design/` 下的 `.json` 契约文件、`table-mapping.md`、`schema-contract.md`、`docs/crewstation-automation.md`、`evidence/**`、`packages/**/*.md`、`e2e/**/*.md` 均**不**在白名单内，修改它们仍走代码路径。 |
| 3 | **每次 push 全量后端测试在真 PostgreSQL 上双引擎运行**（替代 RFC-359 §11.2 及 §11.3 #11） | `.github/workflows/ci-work.yml:233-346` 全部 44 片启 PG 17 且不设 `AW_TEST_PROVIDERS`；锁定于 `packages/backend/tests/architecture/rfc359-w8-ci-dual-engine-wiring.test.ts:231-289`、`design/RFC-359-database-provider-unification/design.md:747-790` | 常规代码 push 的 `test-backend`（16 片）显式设 `AW_TEST_PROVIDERS: sqlite`，不再每片起 PG 容器。替代防线三层：① 每次代码 push 必跑增强版 `test-backend-postgresql`（真 PG 17、不设 `AW_TEST_PROVIDERS`，含 `rfc357` 5 文件 + `rfc359-p0-mutations` + 11 个核心双引擎对拍/计划审计与稳定/并发写锁/锁域/任务/评审/ACL/最新 PG 升级文件（共 16 文件））；② 触及迁移/持久化/schema/依赖/迁移测试路径的 push 自动进入 `full` 模式，跑全部 430+ 迁移/升级/托管 PG 文件的双引擎矩阵；③ 每日 `backend-full-nightly.yml`（02:00 UTC + 手动触发）跑全套后端文件双引擎。 | 不在每提交 PG 冒烟集内、且改动未触及迁移/持久化路径的纯 PG 行为差异，发现延迟从即时变为 ≤ 24 小时（与 `backend-macos-nightly.yml`、`e2e-full-nightly.yml` 同一 SLA）。 |
| 4 | **每次非迁移 push 运行重型历史迁移/升级双引擎矩阵** | `.github/workflows/ci-work.yml:334` 每次 push 运行全部迁移/升级套件（含 `release-upgrade-matrix-*`、`rfc398-*`、`rfc395-*`、`rfc626-*` 及相关 PG 迁移与托管 PG 恢复测试共约 430+ 文件，占总时长近一半） | 标准非迁移 push 中，`test-backend` 保留 7 个纯 SQLite/静态迁移冒烟文件且 `test-backend-postgresql` 保留最新 v0.19.3 PG 升级；其余全部重型与双引擎/纯 PG 迁移文件在 `mode=full`（触及迁移/持久化/schema/证据/CI/锁文件/任一迁移测试文件）时于 `test-backend-migration`（28 片、真 PG 双引擎）全量运行，并每日随 `backend-full-nightly.yml` 全量运行（`release-upgrade-nightly.yml` 每日 `start` 模式照旧）。 | 非迁移模块意外破坏旧版本历史迁移路径时，在当日夜间或下一次 `full` 触发时暴露（≤ 24h）。 |
| 5 | **每次 push 采集后端 `--coverage` 并上传 Codecov** | `.github/workflows/ci-work.yml:334,348-360` 每片加 `--coverage --coverage-reporter=lcov` 并上传 Codecov；锁定于 `packages/backend/tests/root-test-entrypoint.test.ts:379-389,551-558` | 每次 push 的 `test-backend` 与 `test-backend-migration` 移除 `--coverage` 与 Codecov 上传，整体迁至每日 `backend-full-nightly.yml`（44 片、双引擎 + `--coverage --coverage-reporter=lcov` + Codecov）。 | Codecov 覆盖率报告由逐提交更新改为每日更新（不影响任何阻断门禁，原上传即为 `fail_ci_if_error: false`）。 |
| 6 | **全部后端分片都安装 `opencode-ai@latest`** | `.github/workflows/ci-work.yml:258-269` 每片运行 `bun install -g opencode-ai@latest`；锁定于 `packages/backend/tests/rfc349-postgresql-hosted-evidence.test.ts:211-230` | 调研证实全套后端测试中仅 `packages/backend/tests/cli.test.ts:183-193` 硬依赖真实 `opencode`（`packages/backend/tests/opencode-version.test.ts:33-46` 机会性探测）。`backend-shards.ts` 将这两个文件固定分配至 shard 1，仅在 `matrix.shard == 1` 安装 `opencode-ai@latest`；`build-binary` 三平台编译产物 `doctor` 冒烟不变。 | 无测试覆盖损失；若未来新增硬依赖真实 `opencode` 的测试文件，需在 `backend-shards.ts` 的 shard 1 清单登记（否则在非 shard 1 上会显性报错）。 |
| 7 | **macOS E2E 并发 worker 数 4 → 3** | `playwright.config.ts:70` 全局 `workers: 4`；`scripts/ci/e2e-shards.ts:242-251` 锁死全平台 `workers === 4`；`e2e-macos` 运行在 3 vCPU 的 `macos-26-arm64` 上 | `ci-work.yml` 的 `e2e-macos` 注入 `AW_E2E_WORKERS: '3'`，由 `playwright.ci.config.ts` 读取覆写 `workers`；`scripts/ci/e2e-shards.ts` 改为按平台精确校验 `{ linux: 4, macos: 3, windows: 4 }`；Linux/Windows 与本地 `playwright.config.ts` 保持 4，分片数（3/3/4）、文件集合、用例数、重试策略与 20 分钟超时不变。 | 理论串行缩放下限从 9.2m 变为 11.8m（预算 20m，59%），但消除 3 vCPU 宿主机 4 worker 过载导致的超时抖动（实测曾达 14–17m 并频繁超时失败）。 |
| 8 | **纯文档提交触发辅助 `CI feedback` 工作流** | `.github/workflows/ci-feedback.yml:5-10` 无 `paths-ignore`，纯文档提交仍每次运行 4–5 分钟 `format:check` / `lint` / `typecheck`（该检查仅扫 `packages/`、`e2e/`、`scripts/`、`.github/`） | 在 `ci-feedback.yml` 的 `push` 与 `pull_request` 同步添加严格纯文档 `paths-ignore`（与 `docs-only` 范围对齐，仅忽略不参与 `format:check`/`lint`/`typecheck` 的 `design/**/*.md`、`docs/**/*.md`、`proposal/**/*.md`、`STATE.md`、`CLAUDE.md`、`AGENTS.md`、`README.md`、`README.zh-CN.md`）。 | `CI feedback` 为非阻断 advisory 工作流；混合提交（同时含代码与文档）照常触发，无信号损失。 |

## 4. 用户故事与验收标准

1. **纯文档提交快速通过**：开发者仅修改严格 Markdown 文档白名单中的文件并推送到 `main`，在没有未验证代码提交夹杂其中的情况下，`CI` 自动走 `docs-only` 快速通道，在数分钟内完成链接检查与 25 个文档契约测试（23 后端 + 2 shared，均真实执行），`CI required` 报告 `success`，且 `CI feedback` 不空跑。
2. **排队合并绝不漏测代码或迁移改动**：当代码提交 C2 在排队中被后续纯文档提交 D3 覆盖时，D3 的 `detect-changes` 以 `main` 上最近一次 `CI` 绿灯祖先 SHA 为起点计算累计变更，识别出 C2 的代码改动，自动升级为 `standard`（若 C2 触及迁移/持久化/schema 路径则升级为 `full`），绝不错误走入 `docs-only`。
3. **无界排队消失**：连续推送多次提交时，工作流级并发保证同一分支最多 1 个运行中 + 1 个最新待跑；运行中的 run 不被取消，被覆盖的待跑 run 干净终止为 `cancelled`（不运行 `ci-required`，不制造假红或假绿）。
4. **单 SHA 完整验证按需可达**：任何时候通过 `workflow_dispatch`（默认 `mode=full`）触发 `CI`，均使用独立并发组运行完整 `full` 模式（核心 16 片 + 迁移双引擎 28 片 + 真 PG 门禁 + 前端 + 构建 + 三平台 E2E），不与常规 push 队列互相取消。
5. **标准代码提交成本大幅下降且守住真 PG 信号**：非迁移代码提交运行 16 片 SQLite 后端核心测试（仅 shard 1 装 `opencode`，无 PG 容器启动，无 `--coverage`）+ 16 文件增强版 `test-backend-postgresql`（真 PG 17 + 同进程 SQLite/PG 对拍 + 真实双引擎评审/任务/ACL/查询计划稳定/READ COMMITTED 并发写锁/最新 PG 升级 + P0 变异）+ 前端 + 构建 + E2E，每个后端分片留足 15 分钟预算余量。
6. **迁移/持久化改动自动触发双引擎全量迁移验证**：修改迁移引擎、平台内容迁移、持久化层、任意模块/平台 schema 定义、系统运维升级路径、双引擎测试夹具、任一迁移测试文件、证据目录、CI 配置或依赖锁文件时，`detect-changes` 自动输出 `mode=full`，`test-backend-migration`（28 片，真 PG 17 双引擎）全量运行全部重型及双引擎/纯 PG 迁移测试（含全部 Q3、RFC-395/398/626 及托管 PG 恢复套件），`CI required` 强制校验其 `success`。
7. **每日全量双引擎与覆盖率闭环**：`backend-full-nightly.yml` 每日 02:00 UTC（及手动触发）在 Ubuntu 上以 44 片运行全套后端文件的双引擎测试 + `--coverage --coverage-reporter=lcov` + Codecov 上传，并产出完整全量计时 artifact。
8. **计时收集兼容与无噪音**：`ci-timings.yml` 按来源工作流拆分并发组（互不取消），遇到 `docs-only` 绿灯 run 时干净跳过下载/刷新/上传而不报错；遇到新 `CI` 绿灯 run 时产出 `backend-core-test-timings.json` 与 `e2e-test-timings.json`；遇到 `backend-full-nightly` 绿灯 run 时产出 `backend-test-timings.json`（不触发 E2E 刷新）；历史 13-job / 44-shard `CI` 提交继续可兼容收集。
9. **Fail-closed 与负向覆盖完整**：`classify-ci-changes.ts`、`backend-shards.ts`、`run-backend-shard.ts`、`e2e-shards.ts`、`ci-required` 门禁脚本、双引擎接线守卫与计时合成器的每一条拒绝/禁用/降级分支均有单测与负夹具覆盖。
10. **托管实测如实验收**：完整实现并合入后，分别采集并记录 `full`、`standard`、`docs-only` 三种模式及 `backend-full-nightly` 的真实 hosted 端到端时长、runner-分钟、排队时长与分片分布，单独写进 `acceptance.md`，不以静态预估代替实测。
