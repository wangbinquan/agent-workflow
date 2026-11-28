# RFC-627 CI 吞吐、分层验证与排队治理 — 实测验收报告

RFC-627（`design/RFC-627-ci-throughput-tiered-verification/`）全部实施任务（T1–T9）、集中本地验证、独立功能实现门（只读 subagent，`PASS WITH FINDINGS` 0 P0 / 3 P1 / 2 P2 全部修复复验）与四档托管 GitHub Actions 实测验收均已完成。

本报告严格绑定下列确切提交与运行记录，所有时长均直接取自 GitHub Actions API 原始 run / job 时间戳，不以静态模型替代实测，也不隐藏初始失败运行、E2E 重试或尚未在高峰拥堵期观测到的限制。

## 1. 精确验证来源与四档实测总览

### 1.1 四档通过样本（全部首次 workflow attempt 全绿）

| 验收档位 | 确切提交（`main`） | 工作流与运行 ID | 活跃 / 跳过作业 | 端到端墙钟（初始等待） | 累计 runner-分钟 | 伴随工作流与产物 |
| --- | --- | --- | --- | ---: | ---: | --- |
| 基线对照（空闲，RFC-625 前） | `240ee338` | `CI` run `45939395356` | 69 / 0 | 34m 25s（2s） | 559.20 | 44 片后端双引擎 + coverage，10 片 E2E |
| 基线对照（拥堵，RFC-625） | `033f5fa` | `CI` run `45986840401` | 69 / 0 | 3h 07m 48s（2h 08m 35s） | 561.85 | 最近 91 次主 CI 中位 80m / p90 143m / 最长 188m |
| **`mode=full`** | `f74f5f370f581e41285aa7746ef67b5cdbc243d5` | `CI` run `46085767786` | **70 / 1**（`docs-fast-gate` 跳过） | **28m 36s**（6s） | **444.98**（−20.4%） | `CI feedback` run `46085767676` `success`；`CI timing refresh` run `46088340261` `success`（29s，`core-ci` 模式，产物 `reviewed-ci-timings-46085767786` ID `15240006952`） |
| **`mode=docs-only`** | `44a1284ea465bc259db92474e0b3fd7a1e558717` | `CI` run `46088552576` | **3 / 1**（`Full CI` 跳过） | **1m 53s**（3s） | **1.68**（**−99.7%**） | `CI feedback` **0 次触发**（`paths-ignore` 跳过）；`CI timing refresh` run `46088727578` `success`（26s，`skip-docs-only` 模式，零下载/零上传） |
| **`mode=standard`** | `f601eed3c2cf732061f90c066b6fefef95c250b1` | `CI` run `46089416710` | **42 / 2**（`test-backend-migration` 与 `docs-fast-gate` 跳过） | **21m 23s**（2s） | **248.00**（**−55.7%**） | `CI feedback` run `46089416582` `success`；`CI timing refresh` run `46091278899` `success`（21s，`core-ci` 模式，产物 `reviewed-ci-timings-46089416710` ID `15241222384`） |
| **`backend-full-nightly`** | `f601eed3c2cf732061f90c066b6fefef95c250b1` | `backend-full-nightly` run `46091340641`（`workflow_dispatch`） | **44 / 0** | **28m 28s**（3s） | **416.53** | 44 片全量双引擎 + `--coverage` + Codecov 全部通过；`CI timing refresh` run `46093762080` `success`（26s，`full-nightly` 模式，产物 `reviewed-ci-timings-46091340641` ID `15242213016`） |

> 口径说明：累计 runner-分钟为各活跃作业从首真实 step 启动到 job 完成耗时之和（与 RFC-624/625 同口径，不是 GitHub 计费倍率分钟）。在 `f601eed3c` 上，全仓后端测试共 **3,144** 个文件（`packages/backend/tests/` 3,137 个 + `packages/backend/src/` 7 个），精确互斥切分为 **2,768** 个 `core` 文件 + **376** 个 `migration` 文件。

### 1.2 变更分类器与门禁实证

托管日志逐项核验结果：

- **`mode=full`（run `46085767786`，job `140794843344`）**：自动跳过前一次失败的 `41407582`，锚定 `main` 上最近一次绿灯祖先 `94703d534e540aaa3ac9b333299cef5e185fa436`，在 39 个变更文件中命中 `.github/workflows/backend-full-nightly.yml`，输出 `mode=full`。
- **`mode=docs-only`（run `46088552576`，job `140803784941` / `140803961345`）**：锚定 `f74f5f37`，1 个变更文件（`design/RFC-627-ci-throughput-tiered-verification/plan.md`）全部匹配严格 Markdown 白名单，输出 `mode=docs-only`；`docs-fast-gate`（64s）真实执行 Lychee 离线全量 + 1 份变更文档外链检查、23 个后端文档契约测试（**190 pass / 0 fail**，39.85s）与 2 个 `@agent-workflow/shared` 文档契约测试（**19 pass / 0 fail**，186ms）；`CI required` 3s 通过。
- **`mode=standard`（run `46089416710`，job `140806575714` / `140806720142` / `140806720289` / `140806720499`）**：锚定 `44a1284e`，2 个新增计时文件（`.github/backend-core-test-timings.json` 与 `.source.json`）不在纯文档白名单也不触发 `full`，输出 `mode=standard`；`test-backend-postgresql` 真实执行 16 文件（**423 pass / 0 fail**，367.16s）+ P0 变异校验（总 job 9m 19s）；日志确认仅 `shard 1/16` 安装了 `opencode-ai@1.19.6`，`shard 2/16` 起不再安装 `opencode`。

## 2. 分组成本与分片分布

### 2.1 `CI` 各作业组耗时拆解（单位：作业数 / 累计 runner-分钟 / 单片 min–med–max 秒）

| 作业组 | `mode=full`（`46085767786`） | `mode=standard`（`46089416710`） | `mode=docs-only`（`46088552576`） |
| --- | --- | --- | --- |
| `Classify CI verification tier` | 1 / 0.48m / 29s | 1 / 0.47m / 28s | 1 / 0.57m / 34s |
| `Docs fast gate` | 跳过 | 跳过 | 1 / 1.07m / 64s |
| `test-backend`（16 片 SQLite core） | 16 / 101.13m / 275–378.5–491s | **16 / 104.03m / 290–418–438s** | 跳过 |
| `test-backend-postgresql`（16 文件真 PG） | 1 / 11.48m / 689s | 1 / 9.32m / 559s | 跳过 |
| `test-backend-migration`（28 片真 PG 双引擎） | 28 / 197.42m / 333–420.5–543s | 跳过 | 跳过 |
| `test-frontend`（Ubuntu 3 + Windows 3） | 6 / 30.07m / 169–303.5–420s | 6 / 25.37m / 151–266–350s | 跳过 |
| `build-binary`（三平台） | 3 / 8.18m / 100–186–205s | 3 / 7.62m / 101–166–190s | 跳过 |
| `e2e-ubuntu`（3 片，4 workers） | 3 / 21.07m / 370–414–480s | 3 / 22.20m / 405–452–475s | 跳过 |
| `e2e-macos`（3 片，**3 workers**） | 3 / 35.15m / 508–659–942s | 3 / 36.70m / 655–727–820s | 跳过 |
| `e2e-windows`（4 片，4 workers） | 4 / 30.95m / 381–459.5–557s | 4 / 31.50m / 375–424.5–666s | 跳过 |
| 其余（`lint`、`static-scans`、`perf`、`docs-links`、`ci-required`） | 5 / 9.05m | 5 / 10.80m | 1 / 0.05m（`ci-required` 3s） |
| **合计** | **70 作业 / 444.98m / 墙钟 28m 36s** | **42 作业 / 248.00m / 墙钟 21m 23s** | **3 作业 / 1.68m / 墙钟 1m 53s** |

关键观察：

1. **首份 `core` 计时权重落地立竿见影**：`46085767786` 时尚无 `.github/backend-core-test-timings.json`，16 片 `core` 尾部为 491s（8m 11s）；从 `46085767786` 采集 2,768 文件实测权重并合入 `f601eed3c` 后，`46089416710` 的 16 片分布收紧至 **min 290s / med 418s / max 438s（7m 18s）**，中位与最大片仅差 20 秒，距 15 分钟上限留出超过一半余量。
2. **`mode=migration` 与 `backend-full-nightly` 均留足余量**：28 片真 PG 迁移双引擎在 `46085767786` 全数落在 333–543s（5m 33s–9m 03s）；`backend-full-nightly`（`46091340641`）44 片全量双引擎 + `--coverage` + Codecov 全部落在 **437s min / 582.5s med / 698s P95 / 704s max（11m 44s）**，总墙钟 28m 28s，单片距 15 分钟上限至少留余 3m 16s；shard 1/44 日志确认 `./codecov upload-coverage --flag backend-shard-1` 成功入队。
3. **`ci-timings.yml` 四路分流全部闭环**：
   - `46088340261`（`core-ci`）：2,768 / 2,768 文件、`5,778,724 ms`、`unmeasured=[]`、`removed=[]`（已合入 `.github/backend-core-test-timings.json`）。
   - `46088727578`（`skip-docs-only`）：识别零 artifact，跳过下载与上传并绿灯结束。
   - `46091278899`（`core-ci`）：2,768 / 2,768 文件、`5,885,013 ms`、`unmeasured=[]`、`removed=[]`（digest `sha256:d14e7e9dd0e94ec89397ca19a28286f04d32fee7392fc6abd71b5df68d141457`）。
   - `46093762080`（`full-nightly`）：3,144 / 3,144 文件、`23,080,136 ms`、`unmeasured=[]`、`removed=[]`（digest `sha256:53963293b7a3555cade24e46111464735b28fa9a2b6444d3983059b2308d7212`），且只产出 `backend-test-timings.json`（不触发 E2E 刷新）。

## 3. 保留的负样本、E2E 重试与未尽风险

为确保验收结论客观诚实，完整保留以下观测与限制：

1. **首次实现提交失败样本（必须保留）**：`SHA 414075820a75eee18dee9795eef711d168d06a04` / `CI` run `46079919995`（`mode=full`，端到端 26m 39s，66 success / 4 failure / 1 skipped；对应 `ci-timings` run `46082522386` 按预期 skipped）：
   - **本 RFC 自身缺陷 1 处（已修）**：`shard 1/16` 中 `rfc627-ci-change-classification.test.ts:194` 报 `stale configured path: evidence/`，原因是本地存在未入库的空目录 `evidence/` 而 CI 干净检出中不存在。提交 `f74f5f370` 已移除 `evidence/` 并把存在性守卫改为基于 `git ls-files`，后继全绿通过。
   - **偶发冷机超时 2 处（未声称根治）**：`shard 8/16` 的 `rfc253-script-snippets.test.ts:144` 与 `shard 12/16` 的 `rfc370-m2-observer-program.test.ts:86` 均出现 5,000ms 子进程冷启动超时（`exitCode: 143`）。两者在后继 `46085767786` 与 `46089416710` 均正常通过；未改动其用例与超时预算，也不将其归因于本 RFC 修复。
2. **macOS E2E 3-worker 与重试现状**：
   - 在连续 3 次运行（`46079919995`、`46085767786`、`46089416710`）中，`e2e-macos` 全部 **9/9 片首次通过**、零作业超时，且在 `46089416710` 上 **macOS 零重试**（单片 10m 55s / 12m 07s / 13m 40s）。但 `46085767786` 的 `shard 3/3` 曾达 15m 42s（占 20 分钟预算 79%）并含 1 条重试（`macos/e2e/rfc372-mindmap.spec.ts`），仍需长期观察，不能宣称 macOS E2E 抖动完全清零。
   - `46089416710` 含 2 条非 macOS 重试（`linux/e2e/focus-ring-clip.spec.ts`、`windows/e2e/rfc298-webhook-task-source-link.spec.ts`）；`ci-timings` 按原严准入规则自动跳过 E2E 权重刷新，保留既有权重。
3. **高并发拥堵队列实测尚待日常流量检验**：本次四档验收按顺序在低竞争时段执行（初始等待 2–6s），未在生产 `main` 上人为制造连续并发 push 洪水；工作流级并发去 `queue: max` 后的排队取消行为与被覆盖提交累计区间防漏测逻辑由 `rfc627-ci-change-classification.test.ts` 与 `root-test-entrypoint.test.ts` 回归锁定，并在 `46085767786` 实证跳过失败祖先 `41407582` 锚定 `94703d53`。真实高峰期中位/p90 墙钟改善效果需结合后续数周运行持续观察。
4. **分层验证的既有权衡（已在 `proposal.md §3` 获用户批准）**：不在 16 文件 `test-backend-postgresql` 冒烟内且改动未触及 `full` 触发路径的纯 PG 行为差异，以及逐提交 Codecov 覆盖率刷新，均由每日 `backend-full-nightly.yml` 兜底（≤ 24 小时 SLA），并可随时经 `workflow_dispatch` 对单 SHA 触发 `mode=full`。

## 4. 本地与独立门禁摘要

- **本地集中验证**：`format:check:repo-ui`、`lint:repo-ui`、改动文件 `eslint` / `prettier`、`depcheck`、脚本严格 `tsc --noEmit`、`actionlint` v1.7.12（删去 `.github/actionlint.yaml` 后全工作流零告警）、25 个 `docs-fast-gate` 文档契约测试、以及全部 14 组受影响与新增后端 CI 测试（`--isolate`）均通过。
- **独立功能设计门**：三轮只读 subagent 检视（第三轮 `PASS WITH FINDINGS` 0 P0 / 2 P1 / 1 P2 全部采纳）后于 2026-11-27 获用户批准实施。
- **独立功能实现门**：只读 subagent 检视全量改动与测试，结论 `PASS WITH FINDINGS`（0 P0 / 3 P1 / 2 P2），全部 5 项均已修复、补测并合入后通过全部四档托管验收。
