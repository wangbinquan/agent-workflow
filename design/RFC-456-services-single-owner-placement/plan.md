# RFC-456 实施计划

**前置**：RFC-455 落地（`519d9372a`，Done 文档 `36a4b0be4`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后
集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                             | 依据          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-456-T1 | task-execution 5 个文件按层迁入（domain / application / infrastructure / composition）；TE `composition.ts` 再导出三个进程级钩子 | design §1、§2 |
| RFC-456-T2 | `daemonGeneration` 进 `platform/execution`，`managedPeriodicJob` 进 `platform/background`                                        | design §1、§2 |
| RFC-456-T3 | resource-catalog 4 个纯件进 `domain`；`pluginGenerationGc` 包装并入 RC `composition/pluginGenerationGc.ts`，装配根直取           | design §1、§2 |
| RFC-456-T4 | collaboration 的 e2e 屏障迁入它的 `infrastructure`；停机控制通道迁入 `platform/execution/local`，system-operations 与 CLI 改取   | design §1、§2 |
| RFC-456-T5 | 用例 import 改指、按路径读源码的锁、架构报告归属表、`commons-debt` 账本、guard-manifest；新增 RFC-456 用例；文档现状路径         | design §3     |
| RFC-456-T6 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                            | design §6     |
| RFC-456-T7 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                                  | —             |

## 验收清单

- [x] AC-1 14 个文件迁出 `services/`、零引用；装配根不取任何模块的 `infrastructure/`
- [x] AC-2 架构计数按实测（`services/` 107 → 93、`R1` 下降、`R2` 不升），越界类计数不升
- [x] AC-3 受影响用例与新增用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-06，候选基于 `36a4b0be4`）

本机全程高负载（负载 43～94）。验证都在候选导出仓库里跑（`36a4b0be4` 的 `git archive` 加候选路径，提交后运行）；集中验证中的修复
同步进导出仓库后，核对 106 个候选路径与 guard-manifest 与工作树逐字节相同。

- **静态**：`tsc`（backend）0 错；eslint `--max-warnings 0` 无告警；改动的 TS 与 JSON 已按 prettier 格式化；`guard-manifest.json` 刷新
  受影响的 5 个守卫的行数。
- **本 RFC 的问题，已修**（全量 SQLite 与 PostgreSQL lane 都查出，tsc / eslint 看不见）：`clarify-inline-fallback` 的「每个回退原因都在
  `decideResumeSessionId` 里」一例按分段路径（`'src', 'services', 'sessionModeFallback.ts'`）读旧文件，文件删除后 ENOENT；同一处也让
  `test-suite-policy` 的「用例在模块作用域读的源码路径都在」红。迁移前全仓搜的是 `services/<名>` 与 import 说明符，分段写法漏网。改指
  `modules/task-execution/domain/sessionModeFallback.ts`；随后按文件名本身（带引号的 `'<名>'` / `'<名>.ts'`，前 8 行内出现 `'services'`
  或 `'execution'` 段）全仓复搜 14 个文件名，再无漏网。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4732～5344 s 全部跑完，合计 23444 pass / 127 skip /
  46 fail，另有 29 条测试间未处理错误。43 条是超时（19 个文件；41 条撞默认 5 秒，RFC-294 预检的能力归属一例撞自带的 180 秒、RFC-363
  目录分页撞自带的 30 秒），29 条未处理错误全出在其中 12 个超时文件里，是超时用例被拆除后仍在跑的异步尾巴；另 3 条是上面本 RFC 的
  问题（两条，同一原因）与导出仓库只有候选提交所致的 `rfc321`。
  - 修复同步后，失败的 21 个文件（19 个超时文件加修过的 2 个）逐个复跑（30 秒时限）：19 个全过，合计 231 pass / 2 fail。余下两例都撞
    用例自带的墙钟等待：RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`）与 RFC-363 目录分页（自带 30 秒）。对照：同一时刻在
    RFC-455 的导出仓库里跑同一文件，失败的是同一例（6.0 s 与 6.1 s；30.58 s 与 30.54 s），其余用例两边都过（这两例 RFC-455 集中验证时
    也是如此）。
- **导出仓库接 PostgreSQL 真库**：第一条 lane 439 个文件（全部 139 个架构测试；改动的 35 个用例文件；提及 14 个文件、其导出名或其
  消费方文件的用例）：373 个文件全过，合计 5214 pass / 239 fail / 4 skip。66 个文件失败：64 个只有超时（237 例；负载 85～94 下，除
  `lifecycle-property` 3 例撞自带的 15 秒、`review-detail-render-rfc158` 1 例撞自带的 20 秒外都撞默认 5 秒，含 2 例前后置钩子）；上面本 RFC
  的问题（修复前跑到）；`rfc321`（同上）。
  - 修复后复跑失败的 65 个文件（`rfc321` 除外；30 秒时限）：63 个全过，合计 1049 pass / 4 fail，4 例都撞用例自带的时限：
    `review-detail-render-rfc158` 的 R2b（自带 20 秒）与 `lifecycle-property` 的属性测试三例（自带 15 秒）。对照：同一时刻在 RFC-455 的导出
    仓库里跑同一文件，`review-detail-render-rfc158` 两边都是 5 pass / 1 fail（同一例）；`lifecycle-property` 本 RFC 4 pass / 2 fail、RFC-455
    3 pass / 3 fail（负载 94，到点的都是自带 15 秒的属性测试，失败的用例随运行变化）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures），
  PostgreSQL 17 个阶段全部符合预期（0 failures；等负载降到 35 以下再单独跑）；两次运行前后 127 个受保护源文件的哈希一致、导出仓库
  工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，
  加 RFC-456 用例）：在最终文档上 99 pass / 0 fail。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c455 → c456；集中验证的修复只动用例与文档，`src/` 未变）：
  `services/` 107 → 93 个 TS 文件；`legacy-horizontal-files` 228 → 214、`legacy-service-implementations` 102 → 88、facade 清单 108 → 94；
  `R1-inbound-module-internals` 119 → 108、`R2-outbound-module-to-legacy` 27 不变（账本与实测相等）；public surface 1487 不变、偏差数
  不变；其余 counts 都不变：off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context 内部文件对 48、off-DAG offered 文件对 55、
  `module-layer-violations` 1、不可达生产文件 27、直接 `setInterval` 站点 14。报告里「没有跨 context 生产消费方的 public 符号」320 → 322：
  task-execution 的 `public/queries#freezeRuntimeBinaryConfiguration` 与 `public/participants#TaskExecutionError` 此前唯一的外部消费方
  就是迁走的 `services/execution/runtimeConfigFreeze.ts` 与 `services/humanGateContinuationEffects.ts`，迁入 task-execution 后成了同
  context 消费（该数不设门；收窄 public 留给 public surface 的清理波次，见 design §4）。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的声明逐个比对（TypeScript AST 取顶层声明，`36a4b0be4` 的原位置对工作树的新位置）：14 个文件的 70 个顶层声明逐字相同（其中
  `runPluginGenerationGc` 与 `DEFAULT_GRACE_MS` 并入 RC `composition/pluginGenerationGc.ts`，旧文件的 `createPluginGenerationFilesystemGcPort`
  是对 composition 同名再导出的恒等转发，删去后消费方直取那一份——新用例恒等断言）；留在原处、只改了 import 的 29 个文件的 316 个顶层
  声明逐字未变，唯一的文本差异是 `services/daemonCadence.ts` 一行注释里的路径；
- 消费方改指只换 import 路径、导入名不变：生产 27 个文件（四个装配根文件的 `DAEMON_GENERATION`、两个维护装配取 RC composition、
  `cli/stop.ts` 与 system-operations 三个本机适配器取 `platform/execution/local/controlListener`、resource-catalog / collaboration /
  source-control / task-execution 内部取同模块新位置），用例侧 29 个文件同样只换路径，按路径读源码的锁改指新位置；
- 进程级状态仍只有一份：子任务预算与终态等待的登记表、守护进程代际都是模块加载时建一次的单例，旧文件删除后全仓只剩一条 import 路径；
  装配根取到的三个钩子经 TE `composition.ts` 再导出，就是 `infrastructure` 那一份（新用例恒等断言），装配根零 import 任何模块的
  `infrastructure/`；
- `runtimeConfigFreeze` 改取 `'../composition'`：解析到 `modules/task-execution/composition.ts`（文件优先于同名目录），与迁移前取
  `@/modules/task-execution/composition` 是同一模块，加载环与迁移前相同；
- e2e 编译期屏障按全局 define（`AW_E2E_BUILD`）生效，与文件位置无关；4 个 e2e spec 只改注释里的源码锚点，行号不变（迁移不加文件头）；
- 集中验证查出的问题（见上）已修并复验。

## PR / 提交

单个提交：`refactor(backend): RFC-456 services/ 单一 owner 的零散实现归位（RFC-294 W9-D 第三步）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
