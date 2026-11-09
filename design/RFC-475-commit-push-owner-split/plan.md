# RFC-475 实施计划

**前置**：RFC-474 落地。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证，
开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                       | 依据           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | -------------- |
| RFC-475-T1 | source-control 合同：`application/ports/workspaceChangePublication.ts`，`public/types` / `public/participants` 转出        | design §1      |
| RFC-475-T2 | source-control 用例 `application/workspaceChangePublication.ts`（runner 的 git 一半）与 domain 增补                        | design §2、§4  |
| RFC-475-T3 | source-control binder：`composition/repositoryCommit.ts`（提交 binder 移入）、`composition/workspaceChangePublication.ts`  | design §3      |
| RFC-475-T4 | task-execution 记账 `infrastructure/commitPushAttempt.ts`、commit agent `domain/commitAgent.ts`、binding 改取、public 收口 | design §5、§6  |
| RFC-475-T5 | `util/git.ts` 收子仓列表纯函数；两个 `services/` 文件删除                                                                  | design §7      |
| RFC-475-T6 | 用例与账本：受影响用例、新增 RFC-475 用例、登记守卫、`R1` 账本、发布调用点账本、owner 表、guard-manifest、注释             | design §8、§10 |
| RFC-475-T7 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾         | design §10     |

## 验收清单

- [x] AC-1 两个 `services/` 文件不在、零引用；`R1` 里没有它们
- [x] AC-2 行为不变（git 命令序列与锁区间、消息、推送结果与 `pushError`、行状态与 effect、会话 id、子仓结果；唯一的次序差见 proposal §6.3）
- [x] AC-3 架构计数按实测（`R1` 38 → 34），偏差、未被消费的 public 符号与越界类计数不升
- [x] AC-4 受影响用例与新增用例全部通过（四个包）
- [x] AC-5 exact SHA CI 全绿：`16d1f5dad` 主 CI run 42690375951 的 70 个 job 与 windows-platform run 42690376320 全部通过

## 集中验证（2026-11-09，候选基于 `7d4e6853f`）

本机全程高负载（采样到的 1 分钟负载 26～32，本机另有常驻负载）。验证都在候选导出仓库里跑（HEAD 的 `git archive` 加候选路径，提交后运行；
修复与文档改动后重新同步，核对与 HEAD 加候选逐字相同）。集中验证查出本 RFC 的两处问题，已修复并复验：

1. 计数复核：未被消费的 public 符号 322 → 323。source-control `public/participants` 转出的 `bindRepositoryGitSubworkspace` 原本唯一的模块外
   消费方是 runner 的子仓阶段，拆开后子仓工作区在模块内绑定，它在 public 上没人取了。按 RFC-294 design §3.3（没有生产 consumer 的 symbol
   不公开）撤出 public（模块内的 binder 不变），RFC-475 用例补锁它不在 public 上，design / proposal 同步；复采 322。
2. RFC-475 用例的「public surface 偏差判据对新合同不报任何一条」一例在全量与同时跑的 161 个文件首轮里撞用例自带的 120 秒（245 s、
   211 s）：它把整个 backend 加 shared 的源码交给偏差判据。判据把每个声明记在第一个走到它的 public 根下，source-control 加 shared 的语料里
   排在新根前面的根更少，全量语料会记在新根下的偏差在这里同样记在新根下（新合同只引用 shared 与 source-control 自己的类型，用例另锁
   source-control 一半不取 task-execution），所以空结果至少一样严；改为只交这部分，并加正对照（该语料确实走到 source-control 的 public 根，
   其已知偏差照常报出）与负对照（函数类型属性与守护进程 `Logger` 的探针照样报出）。复跑这一例 3.7 s，整个文件 14 / 14。

- **静态**（修复后的候选）：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 TS 文件，加
  `eslint.promises.config.js` 覆盖的 src 文件）；`depcheck` 分层门通过（4430 个模块）；改动的 TS 与 RFC-475 三件套 prettier 检查通过。
- **逐项比对**：见实现门。
- **全量 SQLite**（修复前的候选；导出仓库里 `bun run test:backend`，四分片，分片时限 3 小时）：四片 8415 / 8316 / 8904 / 7726 s 全部跑完，
  合计 23564 pass / 127 skip / 101 fail，另有 55 条测试间未处理错误（都在有失败的文件里，是超时用例残留的异步收尾）。101 条 fail 里 95 条是
  超时：79 条撞默认 5 秒、6 条撞 30 秒、2 条撞 20 秒、2 条撞 40 秒，10 / 60 / 120 / 150 / 180 / 300 秒各 1 条（其中一条是上面第 2 处问题）；
  余下 6 条：导出仓库只有候选提交所致的 `rfc321` 发布账本，以及同一批文件里超时之后的连带失败（`rfc354` 场景环境已被收走、
  `single-nonroot-member-workspace` 拿到空 ref、`rfc310` system-mock 两例连接被重置、`scheduler-envelope-followup-integration` 库已关闭）。
  - 复跑 209 个文件（全量里有失败的 56 个文件、全部 139 个架构测试、改到与新增的 21 个用例；修复后的候选；30 秒时限）：204 个全过，合计
    2042 pass / 5 fail / 4 skip（与 PostgreSQL lane 同时跑），包括新增的 RFC-475 用例 14 / 14、`commit-push-runner` 21 / 21、
    `commit-push-core` 19 / 19、RFC-210 子仓四个文件、`rfc370-repository-git-workspace`、`rfc205-git-credential`、`rfc328-architecture-guards`、
    `scheduler-commit-push` 与上面那 6 条连带失败所在的文件。余下 5 个文件各一例：导出里恒红的 `rfc321` 发布账本（工作树结果见下）、
    `rfc400-collaboration-task-participants` 一例与 `rfc300-webhook-workspace-cleanup-e2e` 一例撞 30 秒、RFC-167 dw-confirm 的 `approve`（自带
    5 秒 `settleTask`）与 `rfc363` 目录分页（30 秒）。对照：同一时刻在与 HEAD 逐字相同的导出仓库里跑这 4 个文件（两边各两路）：`rfc400` 与
    `rfc300` 两边都全过；`rfc167` 两边都是 28 pass / 1 fail、同一例到点（6.06 s 与 6.10 s），`rfc363` 两边都是 3 pass / 1 fail、同一例到点
    （30.72 s 与 30.64 s）。RFC-474 的验证里这两例同样两边到点。
- **导出仓库接 PostgreSQL 真库**（修复后的候选，30 秒时限）：清单 606 个文件（经用例 helper 的 import 闭包取到改动的生产文件的 471 个用例、
  全部 139 个架构测试与改到的用例），其中 import 闭包能到 PostgreSQL 引擎选择（`tests/helpers/eachProvider.ts` 与三个 PostgreSQL harness）或
  直接读 URL 环境变量的 248 个文件都跑；其余 358 个文件不碰 PostgreSQL，由 SQLite 覆盖。248 个文件里 230 个全过，合计 3735 pass / 34 fail /
  4 skip（三路并行，与 SQLite 复跑同时跑）。余下 18 个文件 34 例都是撞时限（用例自带的 4～180 秒计时、30 秒默认、`rfc359-w6-t26` 的
  `beforeEach` 600 秒）以及超时之后库已关闭的连带失败。对照：同一时刻在与 HEAD 逐字相同的导出仓库里跑这 18 个文件（两边各两路、各用两个
  库）：15 个文件两边逐例相同——10 个文件两边失败的用例逐一相同（`lifecycle-property`、`rfc311-perf-guards`、`scheduler-default-retries` 各
  3 例，`scheduler-audit-s04-git-wrapper-cumulative-diff`、`scheduler-rfc040-wrapper-await`、`scheduler-wrapper-scope-dependencies`、`tasks`
  各 2 例，RFC-167 `approve`、`rfc359-w6-t26`、`rfc359-w9-retry-rollback-parity` 各 1 例），5 个文件（`rfc300`、`rfc310` system-mock、
  `rfc359-w26`、`scheduler-audit-s05`、`scheduler-envelope-followup-integration`）两边都全过；`scheduler-audit-s17` 对照一侧多一例 `[sqlite]`
  到点；`scheduler-boundary-fanout-concurrency` 与 `scheduler-clarify-inline` 本 RFC 一侧各多一例到点（用例自带的 30 秒与 15 秒；两边这两例
  耗时相近：37.2 s 通过与 38.2 s 到点、20.9 s 通过与 20.3 s 到点——报告的耗时含钩子，时限只计用例体）。这两个文件不走 commit&push（用例里
  没有任何 commit-push 配置），再跑一对：`scheduler-boundary-fanout-concurrency` 两边都全过（81.9 s 与 80.1 s）；`scheduler-clarify-inline`
  本 RFC 一侧 9 / 1、对照 10 / 0，到点的那例在第一对里两边都到点，这次两边耗时 19.0 s 与 18.3 s，其余 9 例两边相差都在 0.7 s 以内、互有快慢。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，候选导出的干净克隆，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures）；
  PostgreSQL 第一次（等负载降到 30.6 / 38.8 才放行）15 个变异阶段全部符合预期、变异前的正向运行 26 / 26，变异后的正向运行两例撞 bun 默认
  5 秒（RFC-359 T2a 问题派发 5.42 s、T2b 澄清决定 5.50 s；变异前同一份源码上两例 1.55 s 与 1.22 s；两例都不走 commit&push），lane 因此判
  失败。同一时刻在本 RFC 的克隆与与 HEAD 逐字相同的导出仓库里各跑一次同一条正向命令（同一组用例、默认时限，各用一个库）：两边都 26 / 26，
  两例耗时 2.79 s 与 2.73 s、1.80 s 与 1.85 s。第二次（负载 28.5 / 29.8 放行）17 个阶段全部符合预期（0 failures，变异前后的正向运行都是
  26 / 26）。三次运行前后 127 个受保护源文件的哈希一致、克隆的工作树干净。
- **其他包**（修复后的候选）：shared 209 个文件 2344 pass；frontend（`test:frontend:gate`）871 个文件 7361 pass；system-mocks 30 秒时限
  21 个文件 111 / 111 全过。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略等，加 RFC-475 用例）：最终候选上 11 个文件全过（87 pass；导出仓库与 HEAD 加候选逐字相同）。
- **计数复核**（`scripts/architecture-report.ts` 在导出仓库的提交上采数，修复后的候选，c474 → c475）：`R1-inbound-module-internals` 38 → 34、
  `R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`legacy-horizontal-files` 177 → 175、`legacy-service-implementations` 58 → 56
  （两个 `services/` 文件），其余 19 项闸门计数逐项不变；后端生产文件 3183 → 3188（新增七个、删两个）；跨 context import 记录 7753 → 7746、
  模块符号归属 32238 → 32253、变更入口清单 2347 → 2348（runner 的 `runCommitPush` 拆成 source-control 的 `publishWorkspaceChanges` 与
  task-execution 的 `runCommitPush` 两条）；public surface 1495 → 1505（新增 12 个：10 个合同类型、参与方类型与 binder；撤出 2 个：
  source-control 的 `bindRepositoryGitSubworkspace`、task-execution `public/queries` 的 `repositoryPublicationOrdinal`）；偏差 94、未被消费的
  public 符号 322 逐条相等；task-owned effect 清单 10 条（commit&push 一条只换路径到 `infrastructure/commitPushAttempt.ts`），authority 108、
  gateway 6 不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- source-control 用例与 runner 原文（第 338～771 行与其后的私有函数）逐行比对：差异只有字段改名（`params.*` → `request.*`）、提交 binder 与
  子仓 binder 改由 `deps` 注入、写锁由释放函数改成 `acquire()` → `release()`、`finalize` 改为只组装结果（不再 `await`）、两处会话 id 赋值移到
  task-execution；git 命令与参数、锁区间、错误文本（含 `CommitAgentUnreapedError`）、五处日志的消息与字段逐字不变。11 处 `finalize` 全部是
  `return`；写锁区间里只有暂存、`diff --numstat`、`diff --stat`、`diff` 四个失败出口，即 proposal §6.3 记的次序差（本地提交的锁只括
  `commitPrepared`，其后的失败出口原本就在锁外）。
- task-execution 记账与 runner 原文（第 155～336 行）逐行比对：工作区绑定、mint、effect observer、`beforeAct`、结果与状态写、`succeed`
  逐字相同，状态判定同一张表；会话 id 规则相同（取最后一个已回收的生成进程的非空 id，`processUnreaped` 那次不记）；挪到 mint 之后的
  `identityEnv` 是纯函数；binder 里的 `requireRepositoryGitWorkspaceScope` 收到的就是 `bindRepositoryGitWorkspace` 刚铸的工作区，不会拒；
  意外异常与原来一样直接抛出、不结算 effect（observer 只有 `beforeAct` / `succeed` 两处调用，与原来相同）。
- 合同：请求的 14 个字段在用例里都被取用；消息作者、写锁、日志都是闭合接口，日志字段闭合在五处日志实际用到的键上。
- 删除的 `shouldConsiderCommit`、`parseCommitMessageFromEnvelope` 在 HEAD 上没有生产消费方（只有用例），`isCommitPushNodeId` 移入用例 helper；
  `rfc200-source-lock` 原先锁那个只有用例调用的信封解析函数按 nonce 取信封（`extractLastEnvelope(stdout, envelopeNonce)`），函数删除后改锁
  调度器从 commit agent run 的消息端口取输出（`result.outputs[ports.commitAgent.messagePort]`；该 run 的提示词仍带 `envelopeNonce`，同一用例照锁）。
- 账本：`R1` 38 → 34（实测与账本逐条相等，`R2` 0）；发布调用点账本的三处调用点与 fetch / ls-remote 清单改指 source-control 用例；
  `rfc328-architecture-guards` 的 effect 边界改指 `commitPushAttempt.ts`（act 名 `publish`），补一例删掉 observer 或 act 即报红；RFC-412 退役
  清单加入两个 `services/` 文件；guard-manifest 的行数随登记守卫刷新。

## CI（AC-5）

- `16d1f5dad` 主 CI run 42690375951：70 个 job 全部通过（「CI required」绿）。
- windows-platform push run 42690376320（路径过滤命中 `application/ports/commitPush.ts` 与 `composition/commitPushBinding.ts`）通过；本次
  提交没有触发其他 push workflow。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 5 个 Done 文档文件）的导出仓库上重跑上述文档用例：11 个文件全过（87 pass）。

## PR / 提交

单个提交：`refactor(backend): RFC-475 自动提交推送按 owner 拆开：git 发布归 source-control、提交行记账归 task-execution（RFC-294 W9-D 第二十二步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
