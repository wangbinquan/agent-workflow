# RFC-629：CI 冷启动修复、重复扫描与夹具去重及跨 OS 分层验证

状态：In Progress（2026-11-28；用户 2026-11-27 审阅 RFC-627 后续诊断报告与能力权衡后明确回复「都做，你自己推进完成」；现完成三件套落档并进入独立功能设计门检视）。

## 1. 背景与实测基线

RFC-627 将常态 `mode=standard` 成本从 ~560 runner-分钟压至 **248.00 runner-分钟**（另加并行的 `ci-feedback.yml` **~6.5 分钟** = **254.5 runner-分钟**），墙钟从 80 分钟中位压至 **21 分 23 秒**，纯文档压至 **1 分 53 秒**。对 RFC-627 之后的托管运行（`CI` run `46089416710`、`46085767786`、`backend-full-nightly` run `46091340641`）及本地冷启动逐项剖析，发现仍有显著且高确定性的优化空间：

| 瓶颈项 | 现状实测（`mode=standard` / `full`） | 根因 |
| --- | --- | --- |
| **后端 DB 测试 2 秒断崖** | Core 1,474 个 1–5s 文件占 58.24m（60.5%）；1,395 个 DB 文件中位 2,117ms（非 DB/AST 中位仅 124ms） | ① `persistenceHead()` 调 `persistenceHistory()` 读盘解析并 SHA-256 校验全部 105 文件 / 93 MB（含 **60 个 61 MB PG catalog 随后全部丢弃**），本机实测 **684.5ms vs 仅读 head 15.6ms（43×）**；② `eachProvider.ts` 顶层无条件导入 `migration-freeze`（仅 8/1,255 文件使用）与 PG 运行时；③ 每隔离文件从零建 300 KB SQLite 基线（62.6ms vs 7ms） |
| **Full/Nightly PG 每文件建库与快照** | 1,120 个 `describeEachProvider` 文件在 Full 上比 Core 多 **+127 分钟** | 每文件经 TCP 重放 527 KB DDL 并逐表循环 ~180 次 `SELECT json_agg(t)` 拍快照，未复用 PG `TEMPLATE` 库与静态快照 |
| **发布升级 mock 重复编译** | 68 个 `release-upgrade-matrix-*` + ~10 个 `rfc626-release-upgrade-*` | `helpers/releaseUpgrade/daemon.ts` 每次 `bun build --compile` 同一 1 行入口（~100 MB），未接入 `AW_TEST_FIXTURE_CACHE_DIR` |
| **极端慢测与重复静态扫描** | `rfc294-architecture-preflight` 单文件 **124.7s**；`rfc376-report` 55.1s；`rfc376-structural-guards` 37.3s；61+ 个 RFC-4xx/5xx/6xx 扫描器 176s+；9 个 `ts.createProgram` 69s；2 个硬编码 30s 睡眠 62.6s；134 个非登录测试算 OWASP Argon2id（596s） | `rfc294Gates.ts` 的 `resolveUnit()` 对 3,459 单元做 $O(N^3)$ 线性查找；60+ 守卫重复全仓 AST 遍历；`rfc400` 把全部 1,700 文件作为 `createProgram` 根；`passwords.ts` 模块加载急切算 Argon2id；`userFixture.ts` 每次重复哈希；`rfc319`/`rfc361` 缺可注入超时参数 |
| **E2E 跨 OS 与内部排队** | E2E 占 `standard` **90.4m（36.5%）**；`e2e-macos shard 3/3` 先排队 **4m 17s** 再跑 **13m 40s**，卡死 21m 23s 墙钟 | 首波同时发 31 个 job 挤爆 20-runner 配额；117 个可运行 PR spec 中 **98 个**是纯浏览器 UI/API（27 个不开浏览器），仅 **19 个**涉及 OS 进程/锁/git/路径/脚本/跨平台快捷键；`auth-isolation` 等多处同配置重复启停 daemon |
| **前端 Windows 重复与纯 Node 守卫** | `test-frontend` 占 **25.4m**（Ubuntu 8.8m + **Windows 16.6m**） | 894 个前端测试中 **0 个**检查 `process.platform`（仅 `e2e-harness.test.ts` 启子进程）；80.6% 提交不碰前端/shared 却跑 6 片全量；260+ 纯 Node 源码守卫仍在 `happy-dom` + `i18n` 下运行 |
| **流水线重复与冷扫** | `ci-feedback.yml` **6.5m** 100% 重复 `lint`（7m 11s）；`scans` **3m 0s**；`test-backend-postgresql` **9m 20s**；`build-binary` 串行编 4 个产物且 Windows 白装 `opencode` | `lint` 未缓存非类型感知 ESLint 与 `.tsbuildinfo`；`depcheck.ts` 串行；`scans` 用 `fetch-depth: 0` 每 push 全扫 7,634 次提交 + Docker 拉 `shellcheck`；`test-backend-postgresql` 在 4 核上串行跑 16 文件 + 34 个 P0 进程 |

## 2. 目标与非目标

### 目标

1. **零质量防护下降的纯提速与去重（Track A）**：
   - 修复 `persistenceHead()` / `readSchemaHistoryFiles()` 全历史与 60 个废弃 PG catalog 冷加载缺陷（顺带加速生产 `main.ts` 启动）；
   - 懒加载 `eachProvider.ts` / `testDatabase.ts` 并经 `AW_TEST_FIXTURE_CACHE_DIR` 复用序列化 SQLite 基线、PG 模板库 + 静态快照与 `installMockRuntime` 编译产物；
   - 修复 `rfc294Gates.ts` $O(N^3)$ 线性扫描、`rfc376-structural-guards` 重复计算、预计算 `passwords.ts` 常量哑哈希、缓存测试夹具 `userFixture.ts` 密码哈希、消除 2 处 30s 硬编码睡眠并并发化 `rfc254-stub-differential` 与批量种子 `rfc311`；
   - 将重复全仓扫描的 RFC-4xx/5xx/6xx 守卫与 `ts.createProgram` / `rfc294-review-module-layer-rules` / `rfc395-d4-mint-order-boundary` 合并为共享语料/共享 Program 扫描（零断言减少，同步更新 `architecture/guard-manifest.json`）；
   - 将纯 Node 前端测试迁入 Vitest `source-guards` 项目，合并 E2E 中同配置重复 `startDaemon()` 并收紧 `rfc396-*` 过慢轮询；
   - 下线重复的 `ci-feedback.yml`，为 `lint` 补齐非类型感知 ESLint + `.tsbuildinfo` 缓存与并行化，将 `scans` 改为增量 `gitleaks`（全历史入 nightly）+ 原生 `shellcheck`，将 `test-backend-postgresql` 16 文件 + P0 变异在单机内并行化，并行化 `build-binary` 四产物并去掉 Windows 无用 `opencode` 安装，调整 `test-backend` core 分片 16 → 12。
2. **路径感知跳过与跨 OS 分层验证（Track B）**：
   - `detect-changes` 基于最近绿灯祖先累计 diff 输出 `run_frontend_full`、`run_e2e` 与 `gitleaks_base_sha`（全部 fail-closed）：非前端/非 shared 提交仅运行全部 19 个跨包前端契约测试（1 job ~20s）；纯 `packages/backend/tests/`（+ 纯文档）提交跳过 `build-binary*` 与 `e2e*`。
   - **跨 OS E2E 分层**：每次 push 在 Linux 照旧运行全部 121 个 PR spec（3 片），在 macOS（2 片 × 3 worker）与 Windows（2 片 × 4 worker）运行 19 个 `OS_CORE_E2E_SPECS` 敏感/核心主链路；新增每日 `e2e-cross-os-nightly.yml` 在 macOS（3 片）与 Windows（4 片）运行完整 PR 档 E2E、在 Windows 运行完整 3 片前端测试，并在 Ubuntu 运行全历史 `gitleaks`。
   - **Windows 前端迁入 nightly**：`ci-work.yml:test-frontend` 仅保留 Ubuntu；唯一触及 OS 进程的 `packages/frontend/tests/e2e-harness.test.ts` 接入 `windows-platform.yml` 在真实 Windows 上每改动/每日运行。
3. **综合目标**：将 `mode=standard` 总成本从 254.5 runner-分钟压至 **~100–125 runner-分钟**，首波并发压至 **≤ 20** 消除内部排队，墙钟从 **21m 23s 压至 ~9–12 分钟**；同时显著压缩 `mode=full` 与 `backend-full-nightly` 耗时（最终一切以托管实测 `acceptance.md` 为准）。

### 非目标

- 不删除任何既有测试断言、不放宽单测或 job 超时阈值、不引入自托管或付费 larger runner。
- 不合并已被专有守卫锁死按分片隔离的文件族（`rfc398-auto-upgrade-resume-*`、`release-upgrade-matrix-*`、`rfc395-q3-phase-*`），也不强行合并 551 个小型 `describeEachProvider` 文件（待冷启动根因修完后再评估剩余边际收益）。
- 不在前端改动时跳过 `test-backend`（审计证实 30 个后端测试直接读取 `packages/frontend/`）。

## 3. 能力影响清单（强制逐项确认）

依据 `CLAUDE.md` §RFC workflow 第 7 条，以下 6 项会变更「每次 push」上的既有 CI 门禁行为（其余 Track A 项均为零门禁收缩的纯提速/去重），用户 2026-11-27 已在阅读等价方案后回复「都做，你自己推进完成」：

| # | 被收缩/变更的既有能力 | 原行为与源码依据 | 新行为与替代防线 | 风险与权衡 |
| --- | --- | --- | --- | --- |
| 1 | **每次 push 在 macOS 与 Windows 运行全部 121/120 个 PR 档 E2E spec** | `.github/workflows/ci-work.yml:776-808`、`scripts/ci/refresh-e2e-timings.ts:17,49-93`（3/3/4 拓扑全跑 PR 档） | 每次 push：Linux（3 片）仍跑全部 121 个 PR spec；macOS（2 片 × 3 worker）与 Windows（2 片 × 4 worker）按 `scripts/ci/e2e-shards.ts` 导出的 `OS_CORE_E2E_SPECS`（19 个 OS 敏感/进程/锁/git/路径/脚本/主链路 spec）运行；新增每日 `e2e-cross-os-nightly.yml`（04:30 UTC + `workflow_dispatch`）在 macOS（3 片）与 Windows（4 片）运行全套 PR 档 E2E，并接入 `ci-timings.yml` 刷新跨 OS 完整权重。 | 98 个纯浏览器 UI/API spec 上的 macOS/Windows 专属差异发现延迟从即时变为 ≤ 24h（与 `backend-macos-nightly`、`e2e-full-nightly` 同 SLA）；19 个 OS 敏感 spec 与 Linux 全套仍每次 push 阻断。 |
| 2 | **每次 push 在 Windows 运行完整 3 片 `test-frontend`** | `.github/workflows/ci-work.yml:411-442`、`packages/backend/tests/root-test-entrypoint.test.ts:603-612` | `ci-work.yml:test-frontend` 仅保留 Ubuntu（与 2026-10-14 移除 macOS 前端同口径）；全部 894 个前端测试中唯一的 OS 进程测试 `packages/frontend/tests/e2e-harness.test.ts` 接入 `windows-platform.yml`（随 `e2e/harness.ts` 或该测试变更及每日运行）；完整 3 片 Windows 前端 Vitest 迁入每日 `e2e-cross-os-nightly.yml`。 | 0 个其他前端测试检查 `process.platform`；Windows 上 Vitest/happy-dom 专属差异由每日 nightly 兜底（≤ 24h）。 |
| 3 | **非前端/非 shared 提交运行完整 3 片 Ubuntu `test-frontend`** | `.github/workflows/ci-work.yml:411-442` 每次非 docs 提交均跑 3 片全部 ~897 个前端文件 | `detect-changes` 按最近绿灯祖先累计 diff 输出 `run_frontend_full`（fail-closed 默认 `true`）；当累计变更完全不触及前端/shared/根构建与 lint/CI 配置时，`test-frontend` 运行 1-job 快速前端契约通道，执行全部 19 个读取前端外部（`packages/backend/`、`e2e/`、`docs/`）的跨包前端测试（由新增结构守卫锁死零漏列）。 | `test-frontend` 仍每次必绿；纯前端测试仅在触及前端/shared/根配置或手动 `workflow_dispatch mode=full` 时跑全量。 |
| 4 | **纯后端测试文件（+ 纯文档）提交构建三平台二进制并跑全部 E2E** | `.github/workflows/ci-work.yml:560-808` 每次非 docs 提交均运行 `build-binary*` + `e2e*` | `detect-changes` 按最近绿灯祖先累计 diff 输出 `run_e2e`（fail-closed 默认 `true`）；仅当累计变更 100% 落在严格匹配 `BACKEND_TEST_PATH_PATTERN` 的后端测试文件（`packages/backend/tests/**/*.test.ts*`，不含 `helpers/`、`fixtures/`、`migration-freeze.ts`）或严格 Markdown 纯文档白名单且非手动 `mode=full` 时，`run_e2e=false`，跳过 `build-binary*` 与 `e2e*`，`ci-required` 精确断言其均为 `skipped`，`ci-timings.yml` 核对 `e2e` 结论为 `skipped` 后走 `core-only-ci` 仅刷新后端 core 权重。 | 生产源码、共享测试 helper/fixture、前端、shared、system-mocks、e2e、脚本、工作流均未改动，编译产物与 E2E 逐字节等同上一绿灯祖先；任一生产/共享 helper/构建文件改动即自动 `run_e2e=true`。 |
| 5 | **每次 push 并行触发独立 `ci-feedback.yml`** | `.github/workflows/ci-feedback.yml` 每次非 docs push/PR 重复跑 `format:check` + `lint` + `typecheck` | 删除 `.github/workflows/ci-feedback.yml`（原 RFC-611 是在 `queue: max` 排队 80–188m 时期设立的快速反馈旁路；RFC-627 后 `ci-work.yml:lint` 在 2–6s 启动并加速至 ~3m，已完全覆盖且为阻断门禁）。 | 消除 ~6.5 runner-分钟重复消耗与 1 个首波并发槽占用，无信号损失。 |
| 6 | **每次 push 在 `scans` 中做全历史 `gitleaks`（7,634 次提交）** | `.github/workflows/ci-work.yml:451,490` 用 `fetch-depth: 0` 每次全历史扫 | `scans` 改为 `fetch-depth: 200` + `gitleaks detect --source . --log-opts="${BASE_SHA}..HEAD"`（基于最近绿灯祖先 `base_sha`，`base_sha` 不可用或不可达时 fail-closed 退回 unshallow 全历史扫）；每日 `e2e-cross-os-nightly.yml` 运行完整 `fetch-depth: 0` 全历史 `gitleaks`。 | 每次 push 仍扫描全部新增与队列合并提交，无新密钥漏检；历史提交规则库升级导致的回溯告警在 ≤ 24h nightly 暴露。 |

## 4. 验收标准

1. **生产与核心后端冷启动显著下降且零语义偏差**：`persistenceHead()` 仅加载并校验 head 工件与所需 PG catalog（`verifyHistoryVersion` 不跳过，非预期文件仍报错）；`scripts/schema-history.ts --check` 继续校验全历史链与全部 60 个 PG catalog；`passwords.ts` 预计算哑哈希仍以 OWASP 2024 参数走真 `Bun.password.verify` 且 `rfc103-login-timing.test.ts` 全过。
2. **跨进程测试缓存与 PG 模板库安全隔离**：`AW_TEST_FIXTURE_CACHE_DIR` 中的 SQLite 基线、PG 模板库 + 静态快照与 `installMockRuntime` 二进制均带完整内容摘要键、原子发布、越界/缺失 fail-closed 与单测覆盖（含禁用缓存、坏摘要、模板缺失 `3D000` 安全降级与 `55006` 退避负用例）。
3. **重复扫描合并零漏报**：共享 `rfc624-migration-reference-guard.test.ts` 与共享 `ts.Program` 守卫保留每条独立规则、语料下限与负夹具，同步更新 `architecture/guard-manifest.json`，全部 `rfc317-*` / `rfc376-*` / `rfc294-*` 架构守卫全绿。
4. **流水线门禁与计时收集全路径 fail-closed**：`classify-ci-changes.ts`、`ci-required`、`e2e-shards.ts`、`refresh-e2e-timings.ts`、`refresh-backend-timings.ts`、`run-postgresql-gate.ts`、`ci-timings.yml` 的每一条新分支与负夹具均有回归单测，且兼容历史 `16/44` 后端与 `3/3/4`、`3/4/4` E2E 提交。
5. **托管实测如实验收**：完成实现并推送后，分别实测验收 `mode=full`、`mode=standard`（含 `run_frontend_full=false`、`run_e2e=false` 与完整 `standard`）、`mode=docs-only`、`backend-full-nightly.yml`、`e2e-cross-os-nightly.yml`、`windows-platform.yml` 与对应 `ci-timings.yml` 全部分支，如实记录 exact SHA、run ID、墙钟、runner-分钟、分片分布与任何负样本/重试于 `acceptance.md`。
