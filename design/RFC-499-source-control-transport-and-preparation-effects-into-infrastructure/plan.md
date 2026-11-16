# RFC-499 实施计划

依赖：RFC-498（Done）；与 S12 共用模块 composition 文件（本 RFC 只删 source-control 的 `composition/repositoryPublicationTransport.ts`，把
`composition/repositoryPreparation.ts` 收成装配，改 `composition.ts` 的一条转出并删去一个零调用方的函数）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-499-T1 发布传输**：第 1～353 行原样迁入 `infrastructure/repositoryPublicationTransport.ts`，去掉只为被删函数服务的 import；删除
  composition 的文件，`composition.ts` 改从新文件转出（design D1）。
- **RFC-499-T2 仓库准备**：输入接口与两个本机工厂迁入 `infrastructure/local/repositoryPreparation.ts`；准备绑定迁入
  `infrastructure/repositoryPreparationBridge.ts`（`createRepositoryPreparationBridge`，两组 effect 必填）；`composition/repositoryPreparation.ts`
  只留装配与转出（design D2）。
- **RFC-499-T3 删除零调用方的函数**：传输文件与 `composition.ts` 的两个密钥文件解析，`composition.ts` 去掉 `node:fs`（design D3）。
- **RFC-499-T4 锁、账本与清单**：`rfc321`、`rfc349`、`rfc376`、`rfc305`、`rfc478`、`rfc447` 改指新位置；`public/queries.ts` 的注释；
  `counts.json` 收紧（design D4）。
- **RFC-499-T5 用例**：新增 RFC-499 用例并登记 guard-manifest（design §4）。
- **RFC-499-T6 集中验证**：backend `tsc`、eslint；RFC-499 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-499-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在清单列的文件声明；传输的旧文件不存在、没有文件从旧位置取名字；`composition.ts` 从新文件转出传输、不取
      `node:fs`；两个被删的函数没有声明、import 与调用；准备的装配文件只有装配与转出、没有控制流语句
- [x] AC-2 同样输入下发布会话与准备绑定各方法的返回、错误码、持久化与外部调用的次序和参数和此前一致
- [x] AC-3 新文件不取 composition（`required-ports` 的类型除外）；跨 context 边、public surface 不升；两项组合层计数收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`797bd884e` 主 CI run 43902539587 的 70 个 job 全部通过（见 §CI）

## 集中验证（2026-11-16，候选 1）

本机全程高负载（10 核；采样到的 1 分钟负载约 40～50，主要是本机其他进程）。验证在候选导出仓库里跑：HEAD `1195a6f66`（本 RFC 的落档
提交）的树加本 RFC 的 16 个路径（含删除的 `composition/repositoryPublicationTransport.ts`），核对与工作树逐字相同；对照导出仓库与 HEAD 的树
相同，验证期间 HEAD 没有前进。集中验证没有查出本 RFC 的问题，候选 1 即定稿；复跑里实测到一处不归本 RFC 的产品缺陷（`util/git.ts` 的
`runGit` 读 stdout 只等 250 毫秒，见下文），登记在 `docs/audit-backlog.md`。

- **静态**：backend `tsc` 退出码 0、无输出（工作树，代码与候选逐字相同；`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动的
  13 个 TS 文件无告警，`eslint.promises.config.js` 的规则对改动的 6 个生产文件同样无告警；prettier：改动的 TS 与本 RFC 的三件套通过
  （`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：448 个文件
  （`tests/architecture/` 全部 140 个，以及 308 个相关用例：直接或经用例侧的辅助与夹具取到改动文件的用例、按名字与路径扫出的用例、
  按路径起子进程的夹具的使用方、直接取 4 个装配 bootstrap 文件的用例，含本 RFC 用例）。候选 4,045 条通过、4 条跳过、326 条红
  （97 个文件），对照（少本 RFC 用例）4,016 条通过、4 条跳过、342 条红（103 个文件）。
  - RFC-499 用例 13 / 13；改指新位置的锁两边都过：`architecture/rfc376-structural-guards` 221 / 221、`rfc305-architecture-lock` 15 / 15、
    `rfc349-source-control-promise-contract` 4 / 4、`rfc447` 11 / 11、`rfc478` 16 / 16；`rfc321-repository-publication-ratchet` 两边 9 / 10，
    红的是发布账本一条（账本记的提交不在导出仓库的历史里）。发布的真 smart-HTTP E2E（`rfc321-repository-publication-system-mock-e2e`）
    候选 SQLite 一例 28.1 秒通过、PostgreSQL 一例撞自带的 30 秒，对照两例都撞 30 秒，见下文放宽副本。
  - 逐文件比失败名，候选有对照之外失败名的 15 个文件共 23 条：
    - 15 条撞时限：12 条撞默认的 5 秒（PostgreSQL 11 条、SQLite 1 条，5.4～9.5 秒），3 条撞自带的时限
      （`clarify-review-combination-scenarios` 的 S-RFC074 20 秒、`rfc370-employee-input-root-bindings` 20 秒、`scheduler-cross-clarify-dispatch`
      60 秒）；
    - 3 条是前一例撞时限后 PostgreSQL 连接空闲超时、下一例的钩子撞 30 秒（`retry-cascade-kind-matrix` 两条、`rfc311-repos-page` 一条）；
    - 3 条是 `rfc363-task-workspace-process-recovery` 等子进程到检查点，30 秒没等到（两边在这个文件里各红 4 条与 7 条，停在的检查点不同）；
    - `rfc310-digital-employee-system-mock-e2e` 的 SQLite 一例开头向系统模拟服务播种时连接被重置（ECONNRESET，10.3 秒；此前两例
      PostgreSQL 撞自带的 180 秒），同文件 crewstation 一例 SQLite 通过；
    - `scheduler-audit-s17-readonly-starved-by-writer-queue` 的 SQLite 一例：断言要求三个写者里至少一对子进程的生存期重叠，这次三个写者
      先后起跑（每个跑满约 2.5 秒，第二个写者在第一个结束后 0.36 秒才起跑）；同一候选代码在全量 SQLite 里这一例通过，此前 15 次全量
      也都通过。
  - 这些文件的静态 import 闭包几乎都取到本 RFC 的路径（用例的装配辅助取整个应用），闭包不能区分，以下文的复跑为准。
- **红文件放宽默认时限复跑**（首批任一边红过的 106 个文件里，除报告类的 `rfc376-report`（见下文放宽副本）外的 105 个；默认时限放宽到
  60 秒、看门狗 3,000 秒，其余同首批）：候选 1,361 条通过、87 条红（33 个文件），对照 1,363 条通过、85 条红（31 个文件）。
  - 首批候选多出的 23 条：21 条候选通过（19 条两边都过，含 S-17 那一例；`rfc363-task-workspace-process-recovery` 的 2 条对照红），余下 2 条
    两边都红——`clarify-review-combination-scenarios` 的 S-RFC074（自带的 20 秒）与 `rfc363-task-workspace-process-recovery` 的一条（检查点），
    见下文放宽副本。
  - 这一轮候选多出的失败名 11 条（8 个文件），对照多出的 9 条（6 个文件）：
    - 候选 8 条撞时限：`rfc098-wrapper-stale-redispatch` 一条撞自带的 20 秒（对照 18.0 秒通过）；`scheduler-cross-clarify-dispatch` 的
      PostgreSQL 3 条撞自带的 60 秒（对照在这个文件另红一条，同样 60 秒）；`scheduler-wrapper-fanout-e2e` 的 PostgreSQL 一条撞默认的 60 秒
      （75.0 秒，对照 52.9 秒通过）；`scheduler-wrapper-scope-dependencies` 的 SQLite 一条撞自带的 30 秒（两边在这个文件各红 10 条，对照多出的
      也是撞 30 秒的一条）；`scheduler` 的 PostgreSQL 一条撞自带的 60 秒（77.4 秒，对照 42.7 秒通过）；`rfc311-perf-guards` 的 PostgreSQL 一条
      是钩子撞 30 秒（这一例候选在首批 9.6 秒通过）。
    - 候选 2 条是 `rfc363-task-workspace-process-recovery` 等子进程到检查点，30 秒没等到（两边在这个文件各红 9 条与 11 条，停在的检查点不同）。
    - 候选 1 条是 `single-nonroot-member-workspace` 的 SQLite 一例：准备在 `git worktree add` 上失败（`fatal: invalid reference:`，引用是空串），
      准备绑定的 `space()` 只是重放落库的失败。根因在本 RFC 不碰、两边逐字相同的 `util/git.ts`：`runGit` 带 signal 时在子进程退出后只给读
      stdout 250 毫秒，读不完就回落为空串、退出码照旧，基准解析的 `rev-parse --verify` 成功却被读成空输出（成功时它必然打印对象名）。
      对照在同一文件红的 PostgreSQL 一例（`ref '(default)' not found`）与同一回落落在解析步骤的形态相符；这个文件的其余用例两边都过，
      全量 SQLite 里 113 / 113。登记在 `docs/audit-backlog.md`。
    - 对照多出的 9 条：撞时限 4 条（`lifecycle-property` 15 秒、发布 E2E 的 SQLite 一例 30 秒、`scheduler-cross-clarify-dispatch` 60 秒、
      `scheduler-wrapper-scope-dependencies` 30 秒），`rfc363-task-workspace-process-recovery` 的检查点 4 条，以及上面
      `single-nonroot-member-workspace` 的一例。
  - 两边红在同样用例的 76 条：下文的放宽副本覆盖 24 条；其余 52 条里 48 条是 PostgreSQL 变体（调度器各用例 32 条、`rfc311-perf-guards`
    8 条、`lifecycle-property` 3 条、员工系统模拟 E2E 两例、`rfc359-w9-retry-rollback-parity`、`rfc384-daemon-intent-bundle` 与
    `rfc396-mr-bridge` 各一条），都撞用例自带的时限或钩子（或前一例超时的连带），它们的 SQLite 变体在全量 SQLite 或同时 A/B 里候选都
    通过；余下 4 条是 `rfc311-perf-guards` 跨引擎对比的汇总（PostgreSQL 一侧没跑完）、`rfc359-w6-t26-postgresql-plan-audit` 的钩子
    （600 秒）、`rfc354-nested-loop-frames` 一条（自带的 20 秒，全量 SQLite 里候选通过）与发布账本。本机这个负载下 PostgreSQL 一侧的这些
    红不作证据，以 exact SHA CI 为准。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的时限照旧；
  清单按耗时从慢到快排，3 个 worker）：2,943 个文件、2,930 个通过（23,935 条通过、127 条按环境跳过）；其余 13 个文件 16 条红，都不归本 RFC：
  - 三个报告类用例撞自带时限：`rfc294-architecture-preflight` 60 / 180 秒、`rfc376-report` 300 秒、`rfc370-committed-architecture-source`
    150 秒，见下文放宽副本。
  - 余下 10 个与对照同时、同样跑法 A/B（各 2 个 worker）：候选 67 条通过、16 条红，对照 66 条通过、17 条红。
    - `lifecycle-property` 两边都过（全量里红在自带的 15 秒）。
    - 6 个两边红在同样的用例：发布账本一条（`rfc321-repository-publication-ratchet`）；撞自带时限的发布 E2E 的 SQLite 一例（30 秒）、
      `clarify-review-combination-scenarios` 的 S-RFC074（20 秒）、`rfc300-webhook-workspace-cleanup-e2e` 与 `rfc354-nested-frames-closure`
      （各 30 秒）；`rfc167-dynamic-workflow-engine` 的 approve 一条（`settleTask` 等满 5 秒时任务仍是 running）。
    - 3 个两边红的用例不同：`rfc363-preparation-process-recovery`（候选红的 4 条都在对照红的 5 条里；它与 crash worker 的静态 import 闭包
      只取到本 RFC 只改注释的 `public/queries.ts`）、`rfc363-workspace-content`（候选通过，对照撞自带的 30 秒）与
      `rfc363-task-workspace-process-recovery`（候选多出 2 条、对照多出 1 条，都是等子进程到检查点 30 秒没等到；它的 crash worker 取到
      准备绑定、本机 effect 与装配）。
  - 静态 import 闭包（含按路径起的夹具）取到本 RFC 改动代码的 556 个文件里 549 个通过（取到准备绑定的 375 个里 370 个、取到发布传输的
    550 个里 544 个）；红的 7 个是上面两边红在同样用例的 5 个（发布 E2E、`clarify`、`rfc300`、`rfc354-nested-frames-closure`、`rfc167`）、
    `rfc363-task-workspace-process-recovery` 与 A/B 两边都过的 `lifecycle-property`。前 6 个的放宽副本见下文。
- **放宽副本**（候选与对照同时，按首批的跑法、各 2 个 worker；默认时限与用例自带的时限都放宽到 1,500 秒，`settleTask` 与等上游起跑这类
  正向等待一并放宽，反向的“上游完成前不得起跑”探针照旧，其余逐字；`scheduler-wrapper-fanout-e2e` 没有自带的时限，原文件照跑）：14 个文件
  两边都全过（各 194 / 194）。
  - 三个报告类用例：`rfc376-report` 16 / 16（候选 723 秒、对照 543 秒；byte-identical 那一例 715 / 535 秒，超出自带的 300 秒）、
    `rfc294-architecture-preflight` 14 / 14（424 / 591 秒）、`rfc370-committed-architecture-source` 2 / 2（那一例 278 / 291 秒，超出自带的
    150 秒）。
  - 全量 SQLite 里两边红在同样用例、取到本 RFC 代码的 5 个与 `rfc363-task-workspace-process-recovery`：发布 E2E 2 / 2（SQLite 一例候选
    28.9 秒、对照 38.9 秒）、`clarify-review-combination-scenarios` 18 / 18（S-RFC074 16.6 / 27.7 秒）、`rfc300-webhook-workspace-cleanup-e2e`
    2 / 2（30.3 / 33.2 秒）、`rfc354-nested-frames-closure` 1 / 1（31.2 / 34.5 秒）、`rfc167-dynamic-workflow-engine` 29 / 29（`settleTask` 的
    等待 5 → 50 秒）、`rfc363-task-workspace-process-recovery` 16 / 16（检查点等待、SIGKILL 定时器与单条时限都放宽）。
  - 复跑里候选多出撞时限的 5 个文件：`scheduler` 43 / 43（超出自带 60 秒的候选 5 例、对照 4 例，最长 115.4 / 110.4 秒）、
    `scheduler-cross-clarify-dispatch` 17 / 17（超出 60 秒的候选 4 例、对照 5 例，最长 107.9 / 107.6 秒）、
    `scheduler-wrapper-scope-dependencies` 18 / 18（PostgreSQL 8 例两边都超出自带的 30 秒，最长 79.7 / 71.3 秒）、
    `scheduler-wrapper-fanout-e2e` 12 / 12（最长 57.9 / 56.6 秒）、`rfc098-wrapper-stale-redispatch` 4 / 4（最长 13.9 / 15.8 秒）。
  - `rfc363-task-workspace-process-recovery` 的 PostgreSQL prepared-before-upload 一例候选用了 445 秒（对照 16.4 秒）。这个用例只凭
    `fs.watch` 发现 worker 写下的 `ready.json`、没有轮询兜底，本机 fseventsd 忙时事件会晚到或丢失（`docs/dev-gotchas.md`，RFC-482 实撞）。
    另存一份插桩副本两边同时跑这一例，PostgreSQL 与 SQLite 各重复 5 次，两边都 10 / 10：第一个 worker 写出 `ready.json` 用 3.9～12.3 秒、
    恢复的 worker 1.8～5.0 秒，两边相同；目录事件比轮询看到文件晚 0.2～9.7 秒，两边都有。首批到复跑里两边“检查点 30 秒没等到”、每轮停在的
    检查点不同，与这个延迟相符。
  - 跑完删除副本，两个导出仓库恢复干净。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内，与对照只差两项（= 新的
  `max`）：
  - `composition-control-flow-source-control` 198 → 148：少掉的 50 条正是两个文件的全部（传输 32 条，含被删函数里的 1 条；准备 18 条），
    没有新增，保留的装配文件 0 条。
  - `composition-forbidden-import-files` 14 → 12：少掉 `composition.ts` 与传输文件，没有新增。
  - 生产文件 4,099 → 4,101（backend 3,235 → 3,237：删一个、增三个）。
  - 跨 context import 7,504 → 7,505：context 对 135 → 135，没有新的符号。不同 context 之间的边不升：source-control → 非模块代码
    12 → 12（拆成两个文件后 `SecretBox` 与 `PersistenceDb` 两个类型各多取一次，被删函数少取两次 `createSecretBoxFromKey`），→ identity-access
    1 → 1。多出的一条在 source-control 内部：本机文件以 type-only 取 `composition/required-ports`，报告把 infrastructure 实现 required SPI
    的 import 记作 required-implementation 边（托管的 `crewstation/repositoryPreparation.ts` 等 11 个文件同样记），原先在 composition 文件
    里取它不记。
  - public surface 1,195 → 1,195（一条使用方边随 import 换成新文件）；模块符号归属 32,366 → 32,367（名字随内容迁到 infrastructure，两个
    被删函数少两条，三个新文件各多一条文件项、删掉的传输文件少一条）；变更入口 2,345 → 2,346（传输的一项随内容换成新文件；准备绑定的
    实现离开 composition 后在 infrastructure 记为一项，报告不把 composition 文件计入变更入口）；其余各节逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 67 处，都是
  预期的：取保留的装配文件的 import 26 处（bootstrap 4 个、用例与夹具 22 个），source-control 内取新位置的 import 6 处，改指新位置的锁
  7 处，RFC-321 锁断言两处文件不含被删函数名的 2 处，名字相近、无关的 `resolveCodeHostConnectionsFromKeyFile` 4 处，其余 22 处是 RFC-499
  用例的常量与负对照。传输的旧路径只出现在 RFC-499 用例的负对照里。`design/`、`docs/` 与 `STATE.md` 里没有指向旧位置的链接；提到它们的
  是 RFC-294、RFC-321、RFC-370、RFC-380、RFC-395、RFC-428、RFC-431、RFC-432、RFC-447、RFC-478 等的记述（当时的锚点），不改。
- **收口文档**：plan、`STATE.md` 与 `docs/audit-backlog.md` 定稿后，候选导出仓库同步到 HEAD `1195a6f66` 的树加本 RFC 的 19 个路径（16 个
  代码路径与这三份文档），读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、`docs-runbook-command-guard`、
  `rfc-index-status-drift`、`rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `797bd884e`（实现，父提交是 `1195a6f66`）：exact SHA 主 CI run 43902539587 的 70 个 job 全部通过（第 1 次里 macOS 的 Playwright e2e 分片 1/4 与 4/4、第 2 次里 1/4 没有分到 runner 就被取消：注记 `The job was not acquired by Runner of type hosted even after multiple attempts`、0 个步骤，归 runner 容量、与提交无关，判据见 `docs/audit-backlog.md` 的同形条目；只重跑没分到 runner 的作业，第 3 次全部通过）；同一推送按路径触发的 windows-platform run 43902539725（1 个 job）通过。
- 本 RFC 的落档提交 `1195a6f66`（只改文档）：主 CI run 43829729267 的 70 个 job 全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **传输**：脚本比对新文件（去掉两行文件头注释）与 HEAD 原文件第 1～353 行，差异只有 import 的 3 行变 1 行——去掉只为被删函数服务的
  `createSecretBoxFromKey`、`readFileSync` 与 `join`；`createRepositoryPublicationTransport` 与 7 个私有辅助函数逐字不变。21 个导入名逐个
  解析到文件，与 HEAD 取自同样的文件。
- **本机 effect 工厂**：新文件的正文与 HEAD 第 44～90 行逐字相同；9 个导入名取自同样的文件。
- **准备绑定**：新文件的正文与 HEAD 第 92～374 行相比只有 design D2 的改动——函数名、两组 effect 的 `?` 去掉、两个常量直接取输入
  （原来的两处 `?? composeLocal…(input)`）；34 个导入名里 33 个取自同样的文件，余下的 `RepositoryPreparationInput` 原先在同一文件声明、
  现在取自本机文件。绑定里不再整体传 `input`（原来只有两处回落这样传；`materialize(input)` 是内层方法自己的参数），改为装配处交展开的
  副本不影响取值；装配的调用方都交普通对象（没有 getter），daemon 的 `preparationInput` 是对象字面量。
- **装配**：`composeRepositoryPreparation` 的输入类型不变；回落的判据、本机工厂的入参（原 `input`）与次序（先 scratch 后准备）逐字；
  日志与参与方的构造是纯的（design D2），先后不可观察。26 个使用方不改，`tsc` 0 错。
- **`composition.ts`**：只有 3 处——两条 import、传输的转出改指新文件、删去零调用方的 `resolveRepositoryTransportCredentialsFromKeyFile`；
  其余逐字。两个被删函数全仓零调用方（RFC-499 用例 ① 覆盖）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-498 转 Done 提交 `a0e2c551c` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-499 源代码管理的发布传输与仓库准备的 effect 实现归 infrastructure（RFC-294 S10 第六步）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
