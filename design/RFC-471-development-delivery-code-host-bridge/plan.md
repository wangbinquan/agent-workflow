# RFC-471 实施计划

**前置**：RFC-470 落地（`acb919d09`，CI 修复 `1a73472b7`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                              | 依据      |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-471-T1 | integration：`matchRepoProvider` 迁回 `domain`；绑定、MR 原始事实、认领键的组装；MR effects 收可异步的绑定        | design §1 |
| RFC-471-T2 | DA：端口类型；交付 provider 去掉绑定；三个组装函数迁入 `composition/developmentDelivery.ts`；mission 操作改收端口 | design §2 |
| RFC-471-T3 | bootstrap 接线；`services/developmentDeliveryDeps.ts` 与 DA 的 `repositoryProviderMatch.ts` 删除                  | design §4 |
| RFC-471-T4 | 用例改路径与锁；新增 RFC-471 用例；架构报告 owner 表、`R1` 账本与 guard-manifest                                  | design §5 |
| RFC-471-T5 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI      | design §7 |
| RFC-471-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                   | —         |

## 验收清单

- [x] AC-1 本文件不在、零引用；DA 与 integration 互不取内部文件；integration 的实现与 DA 端口逐项相同；MR effects 只一份
- [x] AC-2 架构计数按实测（`R1` 64 → 57、`services/` 61 → 60），越界类计数、public surface 偏差与未被消费的 public 符号不升
- [x] AC-3 受影响用例与新增用例全部通过（四个包）
- [x] AC-4 exact SHA CI：`a9207cbc0` 主 CI run 42501878538 有两格红，逐格归因见下：design/ 链接检查查出本 RFC proposal 一条指错目录的 RFC-310 链接（本 RFC 的缺陷，Done 文档提交改正）；`rfc398-start-auto-upgrade-takeover` 一例是 RFC-398 多进程接管用例的偶发红（与本 RFC 无关）；其余 67 个 job 与 windows-platform 通过

## 集中验证（2026-11-08，候选基于 `dacdc3f96`）

本机全程高负载（采样到的负载 40～72；本机另有常驻负载：一个本地虚拟机约 5.5 核、三个挂起的测试夹具进程各约 0.9 核，共 10 核）。验证都在
候选导出仓库里跑（`dacdc3f96` 的 `git archive` 加候选路径，提交后运行；修复与文档改动后重新同步，核对与 HEAD 加候选逐字相同）。集中验证查出
本 RFC 的两处问题，均已修复并复验：

1. 架构报告：DA `public/participants.ts` 转出的三个 pipeline 证据组装、`public/types.ts` 转出的 `PipelineStagingFactories` 只有本文件在用，
   本文件删除后会成为无人消费的 public 符号（322 → 324；去掉三个参与者导出后第二轮报告仍是 323，查出的是 `PipelineStagingFactories`）。
   四个名字都不再转出（DA 的 `composition.ts` 改从端口取该类型），RFC-471 用例加 AST 锁。
2. 全量 SQLite：`tests/rfc380-daemon-module-bundles` 的 repositoryCredentials bundle 键名单漏补新成员 `developmentCodeHost`，补上。

- **静态**（修复后的候选）：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（30 个改动的 TS 文件，加
  `eslint.promises.config.js` 覆盖的 14 个 src 文件）；`depcheck` 分层门通过（4423 个模块）；改动的 TS 与 RFC-471 三件套已按 prettier 格式化。
- **声明逐个比对**：见实现门。
- **全量 SQLite**（修复前的候选；导出仓库里 `bun run test:backend`，四分片，分片时限 3 小时）：四片 6594 / 6506 / 7051 / 6207 s 全部跑完，合计
  23540 pass / 127 skip / 72 fail，另有 43 条测试间未处理错误（都在有失败的文件里，是超时用例残留的异步收尾）。72 条 fail 里 70 条是超时：
  63 条撞默认 5 秒（其中 1 条是 hook）；`clarify-review-combination-scenarios` 撞用例自带的 20 秒流程时限（任务被取消）；`rfc395-v3` 撞 25 秒；
  3 条撞 30 秒（`rfc300` 真 Webhook 工作区清理、`rfc354` 嵌套帧闭包、`rfc363` 目录分页）；`epoch1-permission-text-backup` 撞 60 秒；
  `rfc376-report` 撞 300 秒。余下 2 条：导出仓库只有候选提交所致的 `rfc321` 发布账本，与上面第 2 条。
  - 复跑 177 个文件（全量里失败的 33 个文件、全部 139 个架构测试与改到的 12 个用例；修复后的候选；30 秒时限）：174 个全过（含新增的 RFC-471 用例、改到的用例与全部 139 个架构测试），合计 1672 pass / 3 fail / 4 skip（与 PostgreSQL lane 同时跑，负载
    54～72），余下 3 个文件各一例：导出里恒红的 `rfc321` 发布账本（工作树结果见下）、RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`，
    读到 `running`）与 `rfc363` 目录分页（撞自带的 30 秒）。对照：同一时刻在 RFC-470 的导出仓库（backend 树与 `dacdc3f96` 逐字相同）里跑同一
    文件（负载 54～67），`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.63 s 与 5.60 s），`rfc363` 两边都是 3 pass / 1 fail、同一例到点
    （30.63 s 与 30.64 s）。
- **导出仓库接 PostgreSQL 真库**：清单 424 个文件（全部 139 个架构测试；改到的用例；经用例 helper 的 import 闭包取到改动的生产文件或按路径读
  它们的用例）。第一条 lane（修复前的候选、默认 5 秒、与全量 SQLite 同时跑，负载 46～72）跑到 119 个文件时停下：39 个全过，80 个失败几乎都是
  `beforeEach/afterEach` hook 撞 5 秒及其后的连接被关——这个负载下默认时限的本地 PostgreSQL 结果不作证据，改用 30 秒时限在修复后的候选上重跑。
  重跑的范围：清单里 import 闭包能到 PostgreSQL 引擎选择（`tests/helpers/eachProvider.ts` 与三个 PostgreSQL harness）或直接读 URL 环境变量的
  246 个文件（第一条 lane 已通过的 39 个里，本 RFC 改到的 3 个用例照样重跑，其余 36 个不重跑——它们与修复后候选的差别只有类型层面的改动、
  一条转出语句与用例 / 文档；修复时改到的 `rfc294-architecture-preflight` 补进来）；其余 143 个文件不碰 PostgreSQL（有没有 URL 跑的都是同一份），
  由 SQLite 覆盖。246 个文件里 240 个全过（239 个跑到了 `[postgresql]` 用例，余 7 个的用例不分引擎），合计 3786 pass / 11 fail（前段与 SQLite 复跑
  同时跑，负载 21～72）。余下 6 个文件 11 例都是用例自带的计时到点或负载下的先后断言：RFC-167 dw-confirm 的 `approve`（自带 5 秒
  `settleTask`）、`scheduler-audit-s04` 两例（自带 20 秒）、`scheduler-audit-s17` 一例（只读节点没能赶在第一个写节点完成前起跑）、
  `scheduler-clarify-inline` 与 `scheduler-rfc040-wrapper-await` 各三例（自带 15 秒，到点后连接被关）、`scheduler-default-retries` 一例（自带
  4 秒）。对照：同一时刻在 RFC-470 的导出仓库里（另一个库）逐个跑这 6 个文件（负载 24～33），每一对结果相同——`rfc167` 两边 28 pass / 1 fail、
  `s04` 两边 2 / 2、`s17` 两边全过、`clarify-inline` 两边 9 / 1、`default-retries` 两边 8 / 1、`rfc040` 两边 8 / 2，失败的是同一批用例、到点的是
  同一个计时。
- **后加改动的闭包**：修复改到的 DA `composition.ts`、`public/types.ts`、`public/participants.ts` 让 import 闭包多出 30 个用例，在修复后的候选上
  补跑（SQLite 27 个，另 3 个架构测试已在上面的复跑里；其中能到 PostgreSQL 的 13 个再跑 PostgreSQL；30 秒时限）：SQLite 27 个全过
  （244 pass）；PostgreSQL 13 个全过（146 pass，每个文件都跑到了 `[postgresql]` 用例；负载约 70）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures）；PostgreSQL 等负载降到 29.4 / 32.0
  才放行，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件的哈希一致、导出仓库工作树干净。
- **其他包**（修复前的候选）：shared 2344 pass；frontend（`test:frontend:gate`）871 个文件 7361 pass；system-mocks 108 pass / 3 fail，3 条都是真
  Git smart HTTP 用例撞默认 5 秒（负载约 50；该包不 import 后端代码，本 RFC 也不改它），30 秒时限复跑：111 / 111 全过（修复后的候选，负载约 25）。修复后改到的文件没有被这三个
  包按路径读（e2e 只取 DA 未改的 `composition/employeeTypePackage`）。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等，加 RFC-471 用例）：12 个文件全过（106 pass；导出仓库与 HEAD 加候选逐字相同）
- **计数复核**（`scripts/architecture-report.ts` 在导出仓库的提交上采数，c470 → c471）：`R1-inbound-module-internals` 64 → 57、
  `R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`legacy-service-implementations` 62 → 61、`legacy-horizontal-files` 182 → 181、
  `services/` 的 TS 文件 61 → 60、facade 记录 62 → 61、后端生产文件 3180 → 3181（删两个、新增三个）；跨 context import 记录 7819 → 7804、
  模块符号归属 32230 → 32236、写入口清单 2351 → 2348、public surface 1497 → 1493；偏差 94、未被消费的 public 符号 322、capability 归属清单 18
  逐条相等；跨 context 内部文件对 43、off-DAG offered 文件对 55、不可达生产文件 18、`module-layer-violations` 1、off-DAG 值边 0、平台 → 模块 0
  不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（TypeScript AST 取顶层声明，`dacdc3f96` 对工作树）：迁回 integration domain 的 `matchRepoProvider` 与六个私有辅助逐字相同；
  `composeDevelopmentPipelineDeps` 与原 `buildDevelopmentPipelineDeps` 除名字外逐字相同；`composeDevelopmentDeliveryDeps` /
  `composeDevelopmentMrFactsCollector` 与原函数只差签名（注入的端口）与「取绑定再调 integration」那几行（换成注入的原始事实，绑定缺失仍是
  `code-host-connection-missing` 与原文案、事实采集的四条错误文案逐字不变），映射、投影与摘要的行逐字相同；`composeDevelopmentCodeHostBinding`
  与交付 provider 原来的 `resolveBinding` 只差取远端 URL 的两行（改经 `repositories.resolve`，即同一个 `resolveRepository`）；
  `composeRepositoryCodeHostClaimKeys` 与 `resolveRepoClaimKey` 同一段计算；交付 provider 的接口只少 `resolveBinding`。改动的 11 个生产文件里
  53 个顶层声明逐字未变，13 处差异都是本 RFC 的改动（装配根接线、两处 `Pick`、mission 操作的两个端口、provider 去掉绑定与两个参数、绑定解析可异步）；
  DA `public/participants.ts` 只少了 pipeline 证据那条转出语句，`public/types.ts` 只少了 `PipelineStagingFactories` 一个转出名，DA `composition.ts`
  只改了取它的那行 import。
- 行为：MR effects 合成一份后，三个方法的成功与失败对象与原实现逐字相同（integration 的 MR 函数每个失败出口都只构造 `ok` / `code` / `detail`；
  `reply` 被调函数只读四个入参字段）；DA 拿到的原始快照就是 `collectMergeRequestFacts` 返回的那个对象，`snapshotRef` 不变；装配根给 DA 的仍是同一个
  交付 provider，事件观察者用的绑定与原 `resolveDevelopmentRepoBinding` 同一段计算。
- 用例：改到的用例只改 import 路径、构造参数与读源码锁的位置，断言不动；`rfc321` 对 integration 的组装补的否定锁与原锁同一意图；
  `tests/rfc380-daemon-module-bundles` 的 bundle 键名单补上新成员 `developmentCodeHost`（冻结、完整、被动、每会话一份的断言不变）。
- 账本：`R1` 64 → 57（实测与账本逐条相等，`R2` 0）；public surface 偏差 94 逐条相等（`rfc294-architecture-preflight` 登记改名一条：同一个开放类型
  改由 `assertEvidenceStagingFactory` 先触到）、capability 归属清单 18 逐条相等；未被消费的 public 符号 322 不变、public surface 1497 → 1493；
  guard-manifest 刷新五个守卫文件的行数。

## CI（AC-4）

- `a9207cbc0` 主 CI run 42501878538：70 个 job 里 67 个通过，两格红，「CI required」汇总格随之红——
  1. **Markdown link check（design/）**：本 RFC proposal 第 6 行的 RFC-310 链接写成了不存在的 `RFC-310-digital-employee/`（实际目录是
     `RFC-310-rule-driven-development-digital-employee/`）。本 RFC 的缺陷（集中验证没有覆盖 design/ 的相对链接），Done 文档提交改正。
  2. **Backend tests（ubuntu-latest shard 41/44）**：`rfc398-start-auto-upgrade-takeover`「N read no active; C registers; P dies; N acquires
     after takeover」184.6 s 后 barrier / readiness 到点，子进程（真 `src/main.ts`）的 stderr 是 `JSON Parse error: Unable to parse JSON string`。
     同一文件前两例（同样起真 daemon、走同一套装配）在这次 run 里通过；父提交 `dacdc3f96` 的主 CI run 42480858762 同一分片、同一用例通过
     （28.45 s）；本地全量 SQLite 里该文件通过；本 RFC 改的是代码托管桥的装配（启动时只建闭包、不读 JSON）。判为与提交内容无关的多进程
     时序偶发红，用例属 RFC-398，未改、未重跑，如实记录。
- 同一 run 的 shard 40/44 里，RFC-470 Done 文档提交那格红的 `rfc398-postgresql-provisioning` 用例通过（108.08 s）。
- windows-platform push run 42501878336 与 maintenance-soak-nightly push run 42501878188 通过。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 5 个 Done 文档文件）的导出仓库上重跑上述文档用例：12 个文件里 11 个全过（105 pass）；`rfc376-report` 只读提交里的源码（不读这 5 个文档），这一轮在负载约 40 下撞用例自带的 300 秒
  （两份报告已逐字相同，到点后被杀的是随后的 `git show`），沿用 Done 文档改动前同一份代码上的通过结果（12 个文件 106 pass）。

## PR / 提交

单个提交：`refactor(backend): RFC-471 开发交付的代码托管桥归 integration：services/developmentDeliveryDeps 退役（RFC-294 W9-D 第十八步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
