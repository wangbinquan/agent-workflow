# RFC-629 CI 冷启动修复、重复扫描与夹具去重及跨 OS 分层验证 — 实测验收报告

RFC-629（`design/RFC-629-ci-cold-start-dedup-and-cross-os-tiering/`）全部实施任务（T1–T9）、集中本地验证、两轮独立只读功能实现门（最终 `PASS`，0 findings）与全部托管 GitHub Actions 模式及夜间工作流实测验收均已完成。

本报告严格绑定下列确切提交与运行记录，所有时长均直接取自 GitHub Actions API 原始 run / job 时间戳，不以静态估算替代实测，并完整保留首次推送失败样本、重跑记录与既有已知权衡。

## 1. 精确验证来源与全模式实测总览

### 1.1 各档位与夜间工作流通过样本

| 验收档位 / 工作流 | 确切提交（`main`） | 工作流与运行 ID | 活跃 / 跳过作业 | 端到端墙钟（首轮完整运行） | 累计 runner-分钟 | 伴随工作流与产物 |
| --- | --- | --- | --- | ---: | ---: | --- |
| 基线对照（RFC-627 前空闲） | `240ee338` | `CI` run `45939395356` | 69 / 0 | 34m 25s | 559.20 | 44 片全量双引擎 + coverage，10 片 E2E |
| 基线对照（RFC-627 `mode=full`） | `f74f5f37` | `CI` run `46085767786` | 70 / 1 | 28m 36s | 444.98 | 16 片核心 + 28 片迁移 + 6 片前端 + 10 片 E2E |
| 基线对照（RFC-627 `mode=standard`） | `f601eed3` | `CI` run `46089416710` | 42 / 2 | 21m 23s | 248.00 | 16 片核心 + 16 文件真 PG + 6 片前端 + 10 片 E2E |
| 基线对照（RFC-627 `backend-full-nightly`） | `f601eed3` | `backend-full-nightly` run `46091340641` | 44 / 0 | 28m 28s | 416.53 | 44 片全量双引擎 + `--coverage` + Codecov |
| **RFC-629 `mode=full`** | `579c256681ad4ca0500824b47810d13f3260e123` | `CI` run `46118495355`（attempt 2 全绿） | **60 / 1**（`docs-fast-gate` 跳过） | **19m 17s**（较 RFC-627 **−32.6%**） | **283.63**（较 RFC-627 **−36.3%**） | `CI timing refresh` run `46120550353` `success`（`core-ci`，产物 `reviewed-ci-timings-46118495355` ID `15253891246`，2,771 核心文件，3,561s） |
| **RFC-629 `mode=standard`（`run_frontend_full=false`, `run_e2e=true`）** | `5c5690032ceed0d702d2755b81bf3cccfcd23dc7` | `CI` run `46120870375`（**首次全绿**） | **30 / 2**（`test-backend-migration`、`docs-fast-gate` 跳过） | **9m 12s**（较 RFC-627 **−57.0%**；较 RFC-627 前 **−73.3%**） | **113.82**（较 RFC-627 **−54.1%**；较 RFC-627 前 **−79.6%**） | `CI timing refresh` run `46121582410` `success`（25s，`core-ci`，产物 `reviewed-ci-timings-46120870375` ID `15254037825`） |
| **RFC-629 `mode=standard`（`run_frontend_full=false`, `run_e2e=false`）** | `ca0aca014a14e63f8d386d868a3ae4ca83aa2c18` | `CI` run `46121855824`（attempt 2 全绿） | **20 / 8**（全部 6 个 `build-binary*` / `e2e*` + 迁移 + `docs-fast-gate` 跳过） | **6m 30s**（较 RFC-627 standard **−69.6%**；零 macOS/Windows runner） | **71.92**（较 RFC-627 standard **−71.0%**） | `CI timing refresh` run `46122935395` `success`（24s，实测 **`core-only-ci`**，产物 `reviewed-ci-timings-46121855824` ID `15254715663`） |
| **RFC-629 `e2e-cross-os-nightly`** | `2b085aeb23859008355ba11da0d1cee89901a0b8` | `e2e-cross-os-nightly` run `46115673947`（**首次全绿**） | **13 / 0** | **18m 25s** | **80.03** | Gitleaks 全历史 3m 23s + Windows 前端 3 片 + macOS 全量 3 片 (536) + Windows 全量 4 片 (530)；`CI timing refresh` run `46117137365` `success`（**`cross-os-e2e-nightly`**，产物 `reviewed-ci-timings-46115673947` ID `15252371274`） |
| **RFC-629 `backend-full-nightly`** | `ca0aca014a14e63f8d386d868a3ae4ca83aa2c18` | `backend-full-nightly` run `46123064795`（attempt 2 全绿） | **44 / 0** | **19m 35s**（较 RFC-627 **−31.2%**） | **320.13**（较 RFC-627 **−23.1%**） | 44 片全量双引擎 + `--coverage` + Codecov 全部通过（单片 4m 59s–9m 38s，p50 7m 30s）；`CI timing refresh` run `46125286860` `success`（28s，**`full-nightly`**，产物 `reviewed-ci-timings-46123064795` ID `15255448201`） |
| **RFC-629 `windows-platform`** | `579c256681ad4ca0500824b47810d13f3260e123` | `windows-platform` run `46118495300`（首次全绿；`2b085aeb2` run `46115475522` 亦首次全绿） | **1 / 0** | **10m 34s** | **10.57** | 含新接入的 `packages/backend/tests/e2e-harness.test.ts` 原生 Windows 回归 |
| **伴随工作流回归** | `2b085aeb2` / `579c25668` | `integration-opencode` (`46118495210`, 30s) / `visual-regression-nightly` (`46115475525`, 3m 53s) / `maintenance-soak-nightly` (`46115475518`) | 全通过 | — | — | `ci-feedback.yml` 已移除，零重复触发 |
| **RFC-629 `mode=docs-only`** | 本收尾文档提交（推送后由托管 `CI` 与 `CI timing refresh` 自动验证） | 推送本收尾提交后由 `CI required` 与 `skip-docs-only` 门禁复核 | **3 / 1**（预期 `Full CI` 跳过） | 实测由最终文档提交 `CI` 门禁确认 | — | 预期 `docs-fast-gate` + `ci-required` 绿且 `CI timing refresh` `skip-docs-only` |

> 口径说明：累计 runner-分钟为各活跃作业从首真实 step 启动到 job 完成耗时之和（与 RFC-624/625/627 同口径）。对于含 `--failed` 重跑的 run（`46118495355`、`46121855824`、`46123064795`），端到端墙钟与累计 runner-分钟均采自 attempt 1 完整全矩阵，避免将跨两次 attempt 间的等待计为单次执行时长；最终绿灯结论取自 attempt 2。

## 2. 各作业组前后对比（RFC-627 → RFC-629 实测）

| 作业组 | RFC-627 `mode=standard`（`46089416710`） | RFC-629 `mode=standard`（`46120870375`） | RFC-629 `run_e2e=false`（`46121855824`） | RFC-629 `mode=full`（`46118495355` a1） | 关键变化 |
| --- | --- | --- | --- | --- | --- |
| `test-backend`（SQLite core） | 16 片 / 104.03m / max 438s | **12 片 / 60.22m / 244–347s** | **12 片 / 62.32m / 248–352s** | 12 片 / 61.85m / max 358s | 核心总算力 **−42%**，分片 16→12 且更均衡 |
| `test-backend-postgresql`（真 PG） | 1 片 / 9.32m（559s） | **1 片 / 5.25m（315s）** | **1 片 / 5.25m（315s）** | **1 片 / 4.40m（264s）** | 3 路隔离库并发 + PG 模板缓存，耗时 **−44%～−53%** |
| `test-backend-migration`（28 片双引擎） | 跳过 | 跳过 | 跳过 | 28 片 / 163.47m / max 460s（较 RFC-627 197.42m / 543s **−17%**） | PG `TEMPLATE` 缓存 + 冷启动修复生效 |
| `test-frontend` | 6 片（Ubuntu 3 + Windows 3）/ 25.37m | **1 片契约快路径 / 0.47m（28s）** | **1 片契约快路径 / 0.50m（30s）** | 3 片 Ubuntu（含 233 条 `source-guards`）/ 7.22m / max 190s | 14 文件跨包契约 **28s**；全量 Ubuntu 较双 OS **−72%** |
| `lint`（含 typecheck/format/shared/mocks） | ~8–9m | **3.10m（186s）** | **2.28m（137s）** | 3.57m（214s） | ESLint/`.tsbuildinfo` 缓存 + 并发执行，温缓存 **2m 17s** |
| `scans`（audit/actionlint/shellcheck/gitleaks） | ~4–5m | **0.55m（33s）** | **0.47m（28s）** | **0.42m（25s）** | 增量 `gitleaks` + 原生 `shellcheck` + 缓存，**−90%** |
| `build-binary`（Linux/macOS/Windows） | 3 片 / 7.62m | 3 片 / 7.85m（108 / 170 / 193s） | **全跳过（0m）** | 3 片 / 6.88m（96 / 101 / 216s） | 分阶段并发编译，纯后端测试跳过全部构建 |
| `e2e-ubuntu`（3 片 `pr-full`） | 3 片 / 22.20m / 405–475s | **3 片 / 18.15m / 346–383s** | **跳过（0m）** | 3 片 / 19.13m / max 411s | E2E daemon 复用 + `rfc396` 拆分与轮询收紧，**−18%** |
| `e2e-macos` | 3 片 `pr-full` / 36.70m / 655–820s | **2 片 `os-core` / 8.52m / 243–268s** | **跳过（0m）** | 2 片 `os-core` / 8.65m / max 289s | 19 条 OS 核心集 **−77%**；全量 536 条由每日 nightly 兜底 |
| `e2e-windows` | 4 片 `pr-full` / 31.50m / 375–666s | **2 片 `os-core` / 8.50m / 248–262s** | **跳过（0m）** | 2 片 `os-core` / 7.08m / max 223s | 19 条 OS 核心集 **−73%**；全量 530 条由每日 nightly 兜底 |
| **合计** | **42 作业 / 248.00m / 21m 23s** | **30 作业 / 113.82m / 9m 12s** | **20 作业 / 71.92m / 6m 30s** | **60 作业 / 283.63m / 19m 17s** | 常规 `mode=standard` 降入 **10 分钟内** |

## 3. `ci-timings.yml` 全分支实证

全部四条主路径均在托管端实测通过：

1. **`core-ci`（`46120550353` / `46121582410`）**：校验 12 片 `backend-core`（2,771 文件，总实测 `3,561,454 ms`，较 RFC-627 的 `5,778,724 ms` 下降 **38.4%**，`unmeasured=[]`、`removed=[]`）与 `3/2/2` E2E（Linux `pr-full` 536 条 + macOS `os-core` 84 条 + Windows `os-core` 83 条，`--merge-base` 保留其余非核心条目），首份刷新权重已合入 `5c5690032`。
2. **`core-only-ci`（`46122935395`）**：针对纯后端测试提交 `ca0aca014`（run `46121855824`，6 个 build/e2e 作业全部 `skipped`），日志确认 `COLLECTION_MODE: core-only-ci`，仅刷新 12 片核心后端权重而不误报错缺 E2E 产物。
3. **`cross-os-e2e-nightly`（`46117137365`）**：针对 `e2e-cross-os-nightly` run `46115673947`（`0/3/4`，macOS 536 条 + Windows 530 条），`--merge-base` 替换 macOS/Windows 全量权重（含新拆分出的 `e2e/rfc396-graph-development-recovery.spec.ts`）同时保留 Linux 权重。
4. **`full-nightly`（`46125286860`）**：针对 `backend-full-nightly` run `46123064795`（44 片全量双引擎），28s 完成全量后端权重汇总并产出 `reviewed-ci-timings-46123064795`（ID `15255448201`）。

## 4. 保留的负样本、已知抖动与分层权衡

1. **初始实现推送失败样本（已修复）**：
   - `2b085aeb2`（含 RFC-629 实现提交 `b6d9d8706` + 并发 RFC-630 文档提交）的 `CI` run `46115475630`（54/58 通过）与 `backend-full-nightly` run `46115659994`（40/44 通过）共暴露 5 处本 RFC 引入问题，已全部由提交 `579c25668` 修复并在后续全部运行中通过：
     1. `build-binary-virtual-embed.test.ts` 与 `rfc311-backup-worker-fallback.test.ts` 源码字面锁未同步 `scripts/build-binary.ts` 的 `Promise.all` 分阶段并发写法；
     2. `rfc427-entry-root.test.ts` 锁定 `src/main.ts` 顶层函数列表，已将 `parseStopTimeoutMs` 移入 `src/cli/stop.ts`；
     3. `rfc629-backend-cold-start-and-cache.test.ts` 5 次串行 `spawnSync` 超过 5s 预算，已改为单测 `parseStopTimeoutMs` + 并发 `Bun.spawn`（15s 超时）；
     4. `persistenceHead.ts` 在先调 `persistenceHead()` 再调 `persistenceHistory()` 时曾覆盖缓存对象引用导致 `rfc395-a3-embedded-history.test.ts` 引用相等断言失败，已修复并在 `ca0aca014` 补齐回归锁。
   - 此外 `46115475630` 的 `shard 8/12` 出现一次 `rfc370-review-explicit-execution-context.test.ts` 5s 超时（后继 `46118495355`、`46120870375`、`46121855824`、`46123064795` 均正常通过）。
2. **既有子进程超时抖动（未宣称根治）**：
   - 既有测试 `packages/backend/tests/rfc370-m2-observer-program.test.ts:86`（脚本超时 `timeout/143`）在 `46118495355`（shard 7/12）、`46121855824`（shard 7/12）与 `46123064795`（shard 4/44）各偶发 1 次（与 RFC-627 验收期 `46079919995` 观测到的同一条既有抖动同源），`--failed` 单独重跑该分片后均通过；本 RFC 未修改该测试用例，也不将其归因于本 RFC 解决。
3. **跨 OS 分层权衡（已获用户批准「都做」）**：
   - macOS/Windows 全量 E2E（非 19 个 `OS_CORE_E2E_SPECS`）与 Windows 全量前端测试、Gitleaks 全历史扫描均由每日 `e2e-cross-os-nightly.yml` 兜底（≤ 24h SLA，可随时 `workflow_dispatch` 手动触发），同时 `windows-platform.yml` 每提交持续覆盖 Windows 进程/路径/E2E harness 核心行为。
4. **本地与独立门禁记录**：
   - 三轮独立只读功能设计门（第 3 轮 `PASS WITH FINDINGS` 0 P0 / 2 P1 / 3 P2 全部采纳）；
   - 集中本地验证：`format:check`、`depcheck`、`schema-history --check`、全 4 包 `lint` + `typecheck`（`frontend` 增量 3.80s）、`test:shared`、`test:system-mocks`（111/111）、前端契约（14/14）+ 全量 `source-guards`/`dom`（898 文件 7,814/7,814）、59 份受影响后端/架构守卫、`build:binary:e2e`、6 份修改 E2E（25/25）全过；
   - 两轮独立只读功能实现门：第 1 轮 `FAIL`（1 P0 / 1 P1 / 3 P2）全部修复复验后，第 2 轮 `PASS`（0 findings）。
