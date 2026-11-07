# RFC-460 实施计划

**前置**：RFC-459 落地（`6f47af807`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                        | 依据          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-460-T1 | 调用目标选择与运行期引用解析迁入 `packages/shared/src/ref/`，shared 入口导出；删除两个 `services/` 文件                     | design §1     |
| RFC-460-T2 | 信封 nonce 的唯一实现迁入 `platform/contracts/envelopeNonce.ts`；删去 task-execution 的旧名与 `services/nodeRunMint` 的包装 | design §1     |
| RFC-460-T3 | intent 端口命名 seed 文件形状，dump 构造器改用                                                                              | design §1     |
| RFC-460-T4 | 消费方与用例改指；按路径读源码的锁、架构报告归属表、`commons-debt`、guard-manifest；新增 RFC-460 用例                       | design §2、§3 |
| RFC-460-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                       | design §6     |
| RFC-460-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                             | —             |

## 验收清单

- [x] AC-1 两个旧文件不在、零引用；三件各只有一处定义；intent dump 不再取 `services/systemAgentRun`
- [x] AC-2 架构计数按实测（`services/` 79 → 77、`R2` 23 → 17、`R1` 不变），越界类计数与 public surface 不升
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-06，候选基于 `6f47af807`，文档基于 `51af6bbf9`）

本机全程高负载（负载 30～110）。验证都在候选导出仓库里跑（`6f47af807` 的 `git archive` 加候选路径，提交后运行；RFC-459 的 Done 文档提交
`51af6bbf9` 只改 5 个文档文件，随后同步进导出仓库）。

- **静态**：`tsc`（backend、shared、frontend）0 错；eslint `--max-warnings 0` 无告警（backend 31 个、shared 4 个 TS 文件，含
  `eslint.promises.config.js`）；`depcheck` 分层门通过；改动的 TS 与 JSON 已按 prettier 格式化；登记的守卫里只碰了
  `rfc200-source-lock`（行数不变，`guard-manifest.json` 不变）。迁移前按 `docs/dev-gotchas.md` 的三种形态全仓搜两个文件名与 nonce 的
  两个旧名（含仓库根 `tests/` 与 `.github`）。
- **shared 包用例**（导出仓库里 `bun test`）：2344 pass / 0 fail。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4825～5403 s 全部跑完，合计 23475 pass / 127 skip /
  47 fail，另有 36 条测试间未处理错误。46 条是超时（17 个文件；45 条撞默认 5 秒，`rfc363` 目录分页一条撞自带的 30 秒），36 条未处理错误
  全出在其中 12 个超时文件里；另 1 条是导出仓库只有候选提交所致的 `rfc321`。
  - 失败的 17 个文件逐个复跑（30 秒时限）：15 个全过，合计 198 pass / 2 fail，余下两例仍是 RFC-167 dw-confirm 的 `approve`（自带 5 秒
    `settleTask`）与 RFC-363 目录分页（自带 30 秒）——与 RFC-458、RFC-459 集中验证时余下的两例相同。对照：同一时刻在 RFC-459 的导出仓库里
    跑同一文件，`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.59 s 与 5.69 s，负载 31～43）；`rfc363` 两边都是 4 pass / 0 fail（各 29 s，
    负载 30～42）。
- **导出仓库接 PostgreSQL 真库**：一条 lane 260 个文件（全部架构测试；改动的 9 个用例文件；提及调用目标选择、运行期引用、信封 nonce、
  seed 文件形状或这些消费方文件的用例；live opencode 集成用例只在 integration-opencode workflow 里跑）：243 个文件全过，合计 3168 pass /
  55 fail / 4 skip。17 个文件失败，全是超时（负载 60～80；多数撞默认 5 秒，`rfc384` 意图包一条撞自带的 15 秒、`rfc395-gate-open-v2` 一条
  撞自带的 20 秒）。
  - 复跑这 17 个文件（30 秒时限）：14 个全过，合计 378 pass / 4 fail，余下 `rfc374` 节点运行序号两例（30 秒）、`rfc384` 一例（自带 15 秒）、
    `rfc395-gate-open-v2` 一例（自带 20 秒）。对照：同一时刻在 RFC-459 的导出仓库里跑同一文件（负载 70～110），`rfc374` 两边都是
    14 pass / 2 fail、同两例到点（30.00 / 30.34 s 与 30.00 / 30.42 s）；`rfc384` 两边都是 11 pass / 1 fail、同一例到点（15.43 s 与 15.34 s）；
    `rfc395-gate-open-v2` 两边都是 25 pass / 0 fail。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures）；
  PostgreSQL 等 1 分钟负载降到 30 以下、5 分钟降到 40 以下再跑（开跑时 20 / 38），17 个阶段全部符合预期（0 failures）；两次运行前后
  127 个受保护源文件的哈希一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，
  加 RFC-460 用例）：在最终文档上 99 pass / 0 fail。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c459 → c460）：`services/` 79 → 77 个 TS 文件；
  `legacy-horizontal-files` 200 → 198、`legacy-service-implementations` 74 → 72、facade 清单 80 → 78、后端生产文件 3196 → 3195（删去 2 个、
  platform 新增 1 个；shared 多 2 个，生产文件总数 4051 → 4052）、跨 context import 7974 → 7965、写入口 2355 → 2352（`services/ref/runtimeRef.ts`
  的 3 条随文件出了后端）；`R1-inbound-module-internals` 99 不变、`R2-outbound-module-to-legacy` 23 → 17（账本与实测相等）；public surface
  不变（新导出在 shared 与 platform）；其余 counts 都不变：off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context 内部文件对 48、off-DAG offered
  文件对 55、`module-layer-violations` 1、不可达生产文件 26、没有跨 context 消费方的 public 符号不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的声明逐个比对（TypeScript AST 取顶层声明，`6f47af807` 的原位置对工作树的新位置）：调用目标选择 3 个、运行期引用解析 7 个，共
  10 个逐字相同（`runtime.ts` 只改了 import：shared 入口换成同包的 `./ast`、`./codecs`、`./resolution` 与 `../schemas/agent`，取到的是同一批
  声明）；信封 nonce 的函数体 `return randomBytes(8).toString('hex')` 与 task-execution 原实现相同，RFC-200 的说明原样带过去；
- 留在原处的 21 个源文件（backend 19、shared 2）里 239 个顶层声明逐字未变；8 处差异都是预期的：dump 构造器的两处与端口的 `seedFiles` 换成端口命名的
  `IntentSystemSeedFile`（结构相同）、工作组宿主账本的一次调用改名为 `generateEnvelopeNonce`、四处函数体内注释的现状路径；task-execution
  的 `generateNodeRunEnvelopeNonce` 与 `services/nodeRunMint` 的 `generateEnvelopeNonce` 按设计删除；
- 消费方只换说明符、不换名字（nonce 两个旧名统一成 `generateEnvelopeNonce`）：intent、memory、task-execution 与 `services/` 都改取 shared
  或 platform，没有新增模块之间的边（`R1` 99 不变，`R2` 只少不多）；
- shared 入口新增的 10 个导出名在 shared 与 frontend 里没有同名，`depcheck` 分层门通过（shared 内 `ref/runtime.ts` → `schemas/agent` 不成环）。

## CI（AC-4）

- `a4831eda5`：exact SHA 主 CI run 42321998955 首轮全绿（70 个 job）；同 SHA 的 windows-platform run 42321998956 与 integration-opencode run 42321998967 通过。

## PR / 提交

单个提交：`refactor(backend): RFC-460 调用目标选择、运行期引用解析与信封 nonce 出 services/（RFC-294 W9-D 第七步）`。走私有 index、按路径
清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
