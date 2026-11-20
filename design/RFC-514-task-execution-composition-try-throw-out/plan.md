# RFC-514 实施计划

依赖：RFC-513；与 S12 共用模块 composition 文件（本 RFC 只改 task-execution `composition/` 下的 3 个文件；装配入口不变）。按 CLAUDE.md 文首硬
规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-514-T1 归位**：新增 `engine/task/driveTaskRun.ts` 与 `application/dynamicWorkflowOperations.ts`；`application/taskRunSelection.ts` 增
  `createTaskRunConfigurationReferences`，`application/digitalEmployeeExecution.ts` 增 `cancelAndReadTask`（design D1）。
- **RFC-514-T2 composition 只装配**：三个组合文件改为调用新位置（design D2）。
- **RFC-514-T3 账本与锁**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`）；`rfc423` 的 throw 账本与 try 豁免、t19b 的占位账本
  同步改（design D3）。
- **RFC-514-T4 用例**：新增 RFC-514 用例（design §4）。
- **RFC-514-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend 分片。
- **RFC-514-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的位置声明；三个组合文件不再有 `try` / `throw`；装配入口与导出的名字、签名不变
- [x] AC-2 同样输入下驱动、回收与三处 fail-closed 的行为、错误与时机和此前一致
- [x] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-task-execution` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI 除本 RFC 漏改的一条源码守卫外全绿（`efdff656e` 补正后 70 / 70；逐格归因见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 24～42，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`fda04702a`）的树相同。集中验证查出本 RFC 的一处缺陷（三个用例没随迁移改），修正后复验了相关范围：

- **缺陷与修正**（候选 1 = `fda04702a` 的树加本 RFC 的 14 个路径）：三个按原文或结构钉着被迁代码的用例只在候选一边红，按文件路径的预查没有找
  到它们（design §5 补记）：
  - `architecture/rfc408-task-control-plane` 与 `rfc332-task-engine-contracts` 经 `source()` 一类辅助函数读组合文件原文，钉着驱动入口那一行
    `runTask(createTaskRunPorts(opts, topology, runtimeComponents))`（前者 2 例：活语料与负对照的锚点）；
  - 本会话 RFC-510 的用例钉着 `application/taskRunSelection.ts` 交出的名字与 import（2 例）。
  - 修正：改为钉新位置、意图不变：绑定把按需构造端口的闭包交给 `driveTaskRun`、驱动在端口上跑控制面（`rfc408` 增 `driveTaskRun` 的归属与一例
    负对照：驱动不再跑控制面会被认出）；RFC-510 用例记入新名字与两条类型 import。候选 2 只差这三个用例文件与 guard-manifest 里两条的行数，复
    验见下文。
- **静态**：候选 1 与候选 2 的 backend `tsc` 都退出码 0、无输出；eslint `--max-warnings 0`：7 个生产文件（另过 promises 配置）与改动的 7 个
  用例无告警；prettier：改动的 TS、两个 JSON 账本与本 RFC 的三件套通过。
- **首批**（候选 1；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对照同时、同样跑法）：174 个文件。其中
  `tests/architecture/` 全部 140 个，另 34 个：按名字、路径与错误串扫出的用例、读 `taskEngineApplication.ts` 原文的
  `rfc164`、`rfc167`、`process-node-concurrency` 与 `rfc266`、`rfc294-architecture-preflight` 与本 RFC 用例。
  - 两边都跑完：候选 1,854 条通过、49 条红，对照 1,852 条通过、38 条红；本 RFC 用例 13 / 13（只在候选一边）。逐文件比失败名，候选多出的红除
    上面的 5 例外都是时限（`rfc164-workgroup-engine` 与 `rfc310-digital-employee-authoring` 的 PostgreSQL 一半撞 5 秒与钩子时
    限，`rfc319-endpoint-coverage`、`rfc400-collaboration-task-participants` 各 1 条 5 秒，`rfc294-architecture-preflight` 的允许清单一例撞
    自带 60 秒）；对照多出的同样都是时限。
  - 经驱动入口与三处 fail-closed 对拍的用例在候选一边通过：`rfc408-port-bindings` 4 / 4（不带动态工作流操作的 `dw-generate` 仍抛原文错
    误）、`rfc410-port-bindings` 5 / 5、`rfc243-executor-facade` 25 / 25、`rfc396-execution-result`
    8 / 8、`rfc473-execution-outcome-and-resource-sessions` 12 / 12，`rfc423-composition-assembly-only` 3 / 3、t19b 两个用例各
    3 / 3、`rfc266-task-fanout-pools` 9 / 9。
- **复验**（候选 2；默认时限放宽到 60 秒、与对照同时，其余同首批）：22 个文件，候选 356 条、对照 343 条通过（对照没有本 RFC 用例）：修正的
  `rfc408-task-control-plane` 4 / 4、`rfc332-task-engine-contracts` 9 / 9 与 RFC-510 用例 12 / 12，本 RFC 用例 13 / 13，读 guard-manifest 的
  三个普查用例全过；驱动任务的 `rfc164-workgroup-engine` 73 / 73、`rfc310-digital-employee-authoring`
  52 / 52、`rfc359-w8-runtime-participants-conformance` 11 / 11、`rfc370-port-artifact-bindings`
  18 / 18、`rfc383-daemon-employee-automation-bundles` 24 / 24 等两边全过。两边各余 2 条相同的红：`rfc400-collaboration-task-participants`
  撞自带的 30 秒，`rfc167-dynamic-workflow-engine` 的 dw-confirm 批准一例在用例自己的等待后读到 `running`（期望 `failed`），对照同
  样；`rfc294-architecture-preflight` 两例的自带时限与 `rfc376-report` 两边相同，交给 CI 的 backend 分片。
- **架构报告**（`scripts/architecture-report.ts`，候选 1 与对照各出一份；候选 2 只改用例与 guard-manifest）：
  - 60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的 `max`）：`composition-control-flow-task-execution` 17 → 11，少掉的 6 条
    正是迁走的两处 `throw`、一处 `try` 与三处分支；没有新增。
  - 生产文件 4,127 → 4,129（两个新文件）；跨 context import 7,508 不变（`@/util/errors` 的一条随取消读回从组合文件移到 application）；模块符
    号归属 32,443 → 32,449；报告的变更入口一节多两条（只是报告，没有计数或门以它为据）。
  - public surface 与偏差不变；其余各节逐项相同。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，按词边界）：四个新名字只出现在新
  位置、三个组合文件、本 RFC 用例、随迁移改的锁（`rfc408`、`rfc332`、`rfc423`、`rfc266`、t19b 与 RFC-510 用例）、`counts.json` 的说明与本
  RFC 的文档里；两条错误串除新位置外只在按错误串断言的 `rfc408-port-bindings`、t19b 的说明与本 RFC 用例里。
- **收口文档**：plan、design 与 `STATE.md` 定稿后（含 `docs/dev-gotchas.md` 的一条补记），在工作树里重跑读这几处文档与 RFC 索引的 6 个用例
  （与 RFC-513 相同），全过（33 / 33）。

## CI（AC-4）

- `6be6ac4e3`（实现，父提交是 `fda04702a`）：exact SHA 主 CI run 44644049015 的 70 个 job 第 1 次运行 68 个通过。backend 分片 10/44 红，是本
  RFC 的缺陷：`rfc098-write-lock-registry` 的源码守卫用正则钉着驱动入口迁出前的原文（括号与点都转义），迁移前按字面原文的预查没搜到
  它；`CI required` 只因它红；未重跑。补正提交 `efdff656e`（只改这条用例：守卫改钉 `engine/task/driveTaskRun.ts`，意图不变）：主 CI run
  44657983510 的 70 个 job 第 1 次全部通过（含分片 10/44）。其间的后继提交 `3502d3875`、`6c1d87747` 与 `c5a6c2aeb` 的分片 10/44 红的都是这同
  一条用例。
- 本 RFC 的落档提交 `fda04702a`（只改文档）：主 CI run 44637250026 的 70 个 job 第 1 次全部通过，未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：由脚本按 HEAD 原行切片生成，再用脚本按词法单元比对（注释也比，只忽略换行与缩进）：驱动的注释块（HEAD
  `taskEngineApplication.ts` 第 277～282 行）、`try` 与它的注释、上下文分支与 `finally` 的骨架都在 `engine/task/driveTaskRun.ts` 连续出现，
  替换只有 design D1 列出的 `opts.` → `input.` 与端口闭包；动态工作流的 fail-closed（第 196～198 行）、配置引用的登记表、找回与登记
  （`localTaskRunSelection.ts` 第 57、62～66、69～73 行）、取消读回的 404 映射（`digitalEmployeeExecution.ts` 第 141～142 行）逐个相同；两个
  增名字的 application 文件原有的内容原样保留（`digitalEmployeeExecution.ts` 只在文件头注释后增一条 import）。
- **时机与次序**：端口仍在 `try` 里、执行上下文内、控制面启动时构造；执行上下文仍先核对再进入；无论成功、抛错还是端口构造抛错，`finally` 都
  先回收写锁、再回收扇出池登记；动态工作流的 fail-closed 仍在 `dw-generate` 构造端口时判断；配置引用仍按每次登记的新冻结引用找回、找不回即
  抛；取消仍在每次取消时装配取消步骤、取消完成后再读回。错误类型、错误串与 404 映射不变。
- **装配入口与交出的对象**：`driveTaskEngineApplication`、`createTaskRunPorts`、`composeLocalTaskRunSelection` 等的名字、入参与返回类型不
  变；`infrastructure/taskExecutionRuntimeParticipants.ts` 仍从组合文件取 `driveTaskEngineApplication`（`rfc359-w8` 钉的 import 不改）。
- **账本与锁**：`counts.json` 一项收紧到实测（与架构报告一致）；guard-manifest 登记新用例（537 行，`assertsAbsence: true`）、`rfc423` 与
  RFC-510 用例两条的行数随改动更新；`rfc423` 的 throw 账本清空、try 豁免去掉，t19b 的占位账本销一条；`rfc408`、`rfc332`、`rfc266` 与
  RFC-510 用例随迁移改钉新位置，断言意图不变。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-514 任务执行组合层余下的 try / throw 迁出 composition（RFC-294 S10 第二十一步）`。走私有 index、按路径清单提交，在共享发
布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
