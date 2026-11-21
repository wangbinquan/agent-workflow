# RFC-527 实施计划

依赖：RFC-526。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-527-T1 选择助手**：四个 `select*` 的选择必填、只做核对（排除档案的选择没有调用方，删去）；task-execution 的消费方随之必填，只服务用例的两个入口移进测试助手；工作区改动
  发布只为“没给工厂”存在的 `bindPoliciesToWorkspace` 删去（design D1）。
- **RFC-527-T2 排除档案**：单机选择自己构造本机档案工厂（design D2）。
- **RFC-527-T3 员工案例、冲突合并与候选交付**：effect 必填；本机候选工厂带夹具会话；部署选择的两项改为必填、单机给本机实现，daemon 删去四处
  `null` → `undefined`（design D3）。
- **RFC-527-T4 镜像与手动刷新**：拆成本机与托管两个组合入口，bootstrap 按部署选择显式选；登记方式改为显式 `kind`（design D4）。
- **RFC-527-T5 准备与维护**：两组 effect 与维护文件系统必填，维护 worker 单机时显式给本机实现（design D5）。
- **RFC-527-T6 提交绑定**：删去预览索引的回落，没有作用域时预览要求给出索引（design D6）。
- **RFC-527-T6b 托管能力与 CrewStation 事件入口**：输入文件留存、任务恢复与 webhook 入口的 CrewStation 事件入口的消费方改取可空值、显式判
  `null`，daemon 删去另三处 `null` → `undefined`（design D9）。
- **RFC-527-T7 用例与测试助手**：测试助手；tsc 列出的调用逐处改；钉旧形状与回落原文的锁随改（design D7）。
- **RFC-527-T8 门与账本**：RFC-521 门删 19 条适配器登记、三处按 `option` 登记，`SUCCESSORS` 清空；计数降的收紧到实测；新增 RFC-527 用例并登记
  guard-manifest（design D8）。
- **RFC-527-T9 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、按删去的名字、选项与回落原文扫出的用例、按被改文件的路径筛出读取其源码
  的用例、经改动的测试助手传入被改项的用例与全部 `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语
  料交给 CI 的 backend 分片。
- **RFC-527-T10 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 退出门里第 1 项的一条达成（“单机默认值只留在
  `bootstrap/standalone.ts`”由单机选择收拢的后继承担）。

## 验收清单

- [x] AC-1 回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 0 条、`SUCCESSORS` 为空；bootstrap 不再把部署选择的 `null` 转回 `undefined`
- [x] AC-2 daemon、维护 worker 与单机部署得到的对象不变；单机候选推送照旧带夹具会话；用例给出的选择与此前缺省相同
- [x] AC-3 bootstrap 不深取 source-control 的 infrastructure；public surface 不升；计数不升
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 40～47，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同（终验时 156 个路径）；
对照导出仓库与 HEAD（`c088b5060`）的树相同。开发期按 `tsc` 列出的调用逐处改为显式给出（AST 脚本按规则补必填成员与本机实现，其余手改）。集中验证
查出本人六类缺陷，修正并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 149 个 TS 文件无告警，改动的 48 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest、`counts.json` 与本 RFC 的三件套通过（154 个文件）。`tsc` 在第二轮还查出一处调用没给 webhook 入口的
  `crewStationEvents`（`rfc437-integration-webhook-family`），随改。
- **首批**（60 秒、5 个 worker）：475 个文件——`tests/architecture/` 全部 142 个、改动过的用例、直接导入被改生产模块或被改测试助手的用例、
  读被改文件源码的锁。候选 5,363 条通过、34 条红（21 个文件）。逐文件读失败，本人缺陷在七个文件：
  - `rfc515-composition-assembly-only`：没有作用域时预览索引的核对写成了组合层里的 `throw`（组合层只装配）；
  - `rfc431-standalone-selections`：部署选择的必填 / 可空分区仍是 51 / 11；`rfc511`：清单名字的个数仍是删去排除档案核对之前的 11；
  - 本 RFC 用例：扫全部 bootstrap 文件的“把部署选择的 `null` 转回 `undefined`”查出 HTTP 装配里还有一处——部署选择的 CrewStation 事件入口
    （integration 的 `composeWebhookIngressTransport` 把没给当作单机），正是 S12 第 1 项点名的写法；
  - `rfc370-candidate-publication-effects` 与 `rfc370-conflict-workspace-effects`：两条用例仍钉“请求带的 Git 钩子各读一次”，本 RFC 已删去请求上的
    `runGit`（操作照旧成功，钩子读了 0 次）；
  - `rfc370-workspace-upload-bindings`：补必填成员的 AST 脚本给整体写入替身的调用也补上了上传内容工厂，两者同时给照旧被拒，替身无从使用；同样
    的调用在 RFC-363 的进程中断预言（子进程夹具）里，首批按 import 选用例，没有选到 spawn 它的 `rfc363-task-workspace-process-recovery`。

  本人缺陷，随改：核对移进 application（`requireRepositoryPreviewIndex`）；两份清单按实测改；HTTP 装配原样交入 CrewStation 事件入口的部署选择，
  `composeWebhookIngressTransport` 的 `crewStationEvents` 改为可空、必给（design D9；用例照旧扫全部 bootstrap）；两条钩子用例改钉本 RFC 的合同
  （Git 走本机 effect 构造时给的执行器，请求上的执行器一次也不读）；工作区上传的写入方改为二选一的联合类型（design D1、§6 第 4 条），两处整体写入
  替身只给替身，用例以 `@ts-expect-error` 钉住类型拒绝两者。选用例的缺口随补（`docs/dev-gotchas.md`）：在 `tests/` 里按 import 求传递闭包、并把
  以字符串引用的 `.ts` 夹具当作依赖，找出还有 231 个用例经未改的测试助手或夹具到达被改项而没跑（多数经 HTTP 应用助手到 `standalone.ts`），并入
  终验。其余 14 个文件的红见“首批红的对照”。

- **第二批**（60 秒）：164 个读被改文件源码、首批没跑的用例。候选 1,811 条通过、7 条红（6 个文件），6 个文件在对照一边跑：4 个两边相同——
  `rfc321-repository-publication-ratchet` 要可达的 git 历史（导出仓库没有）、`rfc370-employee-input-root-bindings` 与
  `rfc370-evidence-artifact-root-bindings` 撞用例自带的 20 秒时限、`rfc370-m3-hosted-database-restore.integration` 约 130 秒后的断言；另 2 个只在候选
  一边撞 20 秒时限（`rfc370-mission-input-capture-roots`、`rfc370-plugin-installer-roots`），并入终验。
- **首批红的对照**（对照导出仓库，60 秒、3 个 worker）：其余 14 个红文件里 13 个两边都红、红的同类——用例自带的时限（`rfc376-report` 300 秒、
  preflight 180 秒、`rfc310-digital-employee-system-mock-e2e` 与 `rfc311-perf-guards` 的 PostgreSQL 一支 180 秒与 30 秒钩子、`rfc359-w6-t26` 600 秒
  钩子、`rfc395-task-subject-target` 90 秒钩子、`rfc400` 与 `rfc321-repository-publication-system-mock-e2e` 30 秒、`rfc370-task-archive-content`
  20 秒、`lifecycle-property` 15 秒、`rfc359-w9` 10 秒、`scheduler` 60 秒），`rfc167-dynamic-workflow-engine` 两边同一条断言（本机环境）；
  `rfc396-mr-bridge` 只在候选一边撞 30 秒时限，两边同时各以 1 个 worker 再跑：同一条用例（PostgreSQL 一支的交接恢复）两边都撞 30 秒时限，
  各 73 条通过、1 条红。preflight 的 public surface 偏差一条自带 60 秒时限、本机要约 225 秒，两边都只撞时限；按同一语料与同一组助手在用例外
  另算：对照 56 条偏差对 56 条清单、候选 54 对 54，都没有未登记与陈旧。
- **终验**（60 秒、5 个 worker）：439 个文件——全部 142 个 `tests/architecture/`、读被改文件源码的锁、修正涉及的用例（含进程中断预言
  `rfc363-task-workspace-process-recovery`）与 webhook 入口的用例在修正后重跑，加上按传递闭包补出的 223 个用例（另 8 个在中止的一轮里先过，之后
  webhook 入口的改动落在它们的装配路径上，在最终的树上重跑，全过，676 条）。这一轮跑在只差 `uploads.ts` 一处注释与文档的候选上，其后的重跑与
  A/B 跑在最终的树上。本 RFC 直接相关的用例全过：RFC-527 用例 17 / 17、`rfc370-workspace-upload-bindings` 11 / 11、两条钩子用例 11 / 11 与
  26 / 26、`rfc437` 37 / 37、`rfc370-m3-event-inbox` 28 / 28、进程中断预言与第二批只在候选一边撞时限的两个文件。387 个文件通过；跑到中途本机的
  Docker 重启，测试用的 PostgreSQL 收到 fast shutdown（14:32:52 UTC），之后开始与正在跑的 34 个文件连不上库，重建数据库后在最终的树上重跑，27 个
  通过。其余的红按对照归因：3 个与首批的对照相同（`rfc376-report`、preflight、`rfc310`）；断库前跑完的另 15 个红文件在对照一边与候选的重跑同时
  跑，7 个两边都红、红的同类，4 个两边都过（`rfc099-ws-acl-filter` 600 毫秒的收帧窗口、`rfc238` 2 秒的轮询时限、`rfc398-health-database` 与
  `scheduled-tasks-run-now` 60 秒的钩子），4 个只在候选一边撞时限；这 4 个与重跑里仍红的 7 个在两边同时、按同样的顺序各以 2 个 worker 再跑：
  6 个两边都红、红的同类（撞时限的具体用例略有不同），5 个两边都过；每个文件两边的用时相近、快慢互有（相差最多的是
  `scheduler-rfc040-wrapper-await`：对照 199 秒、候选 216 秒）。两边都红的 16 个文件都是用例自带的时限：
  上面 3 个，`rfc257-webhook-ingress` 限流一条的 30 秒、`rfc370-selected-task-root-configuration` 30 秒、`rfc384-daemon-intent-bundle` 15 秒、
  `scheduler-audit-s05` 30 秒、`scheduler-audit-s17` 20 秒、`scheduler-clarify-inline` 15 秒与钩子、`scheduler-wrapper-scope-dependencies` 30 秒，
  `tasks` 的 PostgreSQL 一支等仓库准备落定的 5 秒（两边都是 56 条通过、2 条红，SQLite 一支同样的两条通过）、`scheduler-clarify-dispatch` 20 秒、
  `scheduler-rfc040-wrapper-await` 15 秒与钩子、`scheduler-audit-s04` 20 秒、`scheduler-default-retries` 4～24 秒、
  `rfc370-committed-architecture-source` 150 秒。各批两边相同的红在 HEAD 的 CI 上都通过（`c088b5060` 的主 CI run 44886605498 第 1 次 70 / 70）。
- **架构报告**（`scripts/architecture-report.ts`，最终的树与对照各出一份）：60 项实测里只有三项变化，均已按实测收紧——source-control 组合层控制流
  9 → 6（冲突合并不再按请求选本机夹具、候选绑定只按操作宿主分一次支、镜像一支改由 bootstrap 选）、task-execution 组合层控制流 11 → 10（只服务
  用例的排除档案选择移进测试助手）、public surface 偏差 56 → 54（仓库 git 工作区选择的 `legacyRunGit`、排除档案选择本身）；跨上下文导入
  7,517 → 7,518——删去 6 条（被删的本机助手与 `commitPushAttempt` 取 `@/util` 的类型），新增 7 条，都是 bootstrap 取 source-control 组合层
  （单机候选与冲突合并、两支镜像、维护 worker 的本机准备与维护文件系统）；各模块符号属主只有删去与新增的名字。最终的树与较早的一份候选相比只有
  integration 组合层一处分支的行号随新增的注释下移一行（webhook 入口的改动只改类型）。
- **旧位置全仓扫描**（最终的工作树；全部包、`e2e`、`scripts`、`architecture/` 与 `docs/`，按词边界）：`selectWorkspaceExcludeProfileFactory`、
  `readLocalAppHome`、`NativeGitFixture`、`composeRepositoryMirrors`、`bindPoliciesToWorkspace` 与 `remoteRegistration` 只在 RFC-527 用例里（钉它们
  不再出现）；`requireWorkspaceExcludeProfileFactory` 与 `legacyRunGit` 另只在用例与测试助手的注释里；`composeTaskWorkspaceExcludeProfilesFor` 与
  `applyUploadsToWorktree`（连同只为后者存在、随它移走的 `isNativeUploadResult`）只在测试助手、夹具与它们的用户里，`applyUploadsToWorktree` 另在
  生产代码的注释里（backend 两个文件，shared 的 `uploadNaming.ts` 一处）。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，全过（40 / 40）。

## CI（AC-4）

- `49c302647`（实现，父提交是 `c088b5060`）：exact SHA 主 CI run 44919244054 的 70 个 job 第 1 次运行 68 个通过，未重跑。红的两格：backend
  分片 41/44 是 `rfc412-port-bindings` 的 2 条（TypeError“Repository Git requires a complete workspace factory”）——本人缺陷：用例经没改的
  `commitPushBinding.ts` 调到改为必填的 `selectRepositoryGitWorkspaceFactory`，状态以强转伪造、没给仓库 git 工作区，`tsc` 看不出；集中验证按
  tests 侧的传递闭包选用例、不穿过 `src/`，没选到它。补正提交给出此前缺省的本机工厂；`CI required` 随之红。同一提交触发的 windows-platform
  （run 44919243958）红同样的 2 条；maintenance-soak-nightly（run 44919243948）、integration-opencode（run 44919552472）、git-protocols-e2e
  （run 44921318599）、evidence-soak-nightly（run 44923919921）与 Release upgrade nightly（run 44919305280）通过。
- `1551dda63`（用例补正，父提交是 `49c302647`）：exact SHA 主 CI run 44925747013 的 70 个 job 第 1 次运行 68 个通过（含 design/ 的链接检查），
  backend 分片 41/44 通过；backend 分片 39/44 在测试步骤里撞 job 的 15 分钟上限被取消——取消前 0 条红，正跑
  `rfc398-auto-upgrade-resume-rollback-pointer-restored`；同一分片在父提交上 7 分 19 秒全过、这条约 60 秒，本提交只改一个用例与文档，属 runner
  环境——`CI required` 随之红；同一提交触发的 windows-platform（run 44925746976）通过；未重跑。
- 后继证据：`07d6542d3`（RFC-528 落档，只改文档，父提交是 `1551dda63`）的主 CI run 44928972265 里 backend 的 45 个 job 全过（含分片 39/44
  与 41/44）；红的只有 macOS e2e 分片 3/4 在测试步骤里撞 job 的时限被取消（同一分片在 `49c302647` 上 17 分 33 秒通过）与随之红的
  `CI required`，属 runner 环境。
- 本 RFC 的落档提交 `c088b5060`（只改文档；同一提交记下 RFC-526 转 Done）：主 CI run 44886605498 的 70 个 job 第 1 次全部通过（含 design/ 的链接
  检查与 `CI required`）；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **daemon 得到的对象不变**：员工案例工作区、隔离工作区、git 工作区、工作区读取与上传内容此前就总是部署选择的，删去的只是没给时的那一支；仓库
  准备的两组 effect 与工作区维护文件系统在 daemon 一直给部署选择的。
- **单机的候选交付与冲突合并不变**：此前部署选择是 `null`、装配转回 `undefined`，绑定按请求造本机 effect；生产里没有调用方在请求上带 `runGit`
  （HEAD 上读它的只有这几支回落本身），造出的就是缺省执行器的本机 effect。现在单机选择用同一组工厂与参数构造一次
  （`createLocalRepositoryCandidateEffects()`、`createFileConflictMergeWorkspaceEffects()`）；这些 effect 不持有请求状态（每个用例自己开会话），
  构造一次与按请求构造等价。推送从工厂取夹具会话，与此前回落一支的 `createFileRepositoryPublicationFixtureSession(remoteUrl, runGit)` 相同；给了
  步骤工厂的用例替身照旧不带。托管选择是操作宿主，整段在卷里跑，两支都不经过。
- **镜像不变**：HTTP 装配按 `repositoryRemote === null` 显式选本机或托管一支；本机一支登记为 `mirror-cache`，手动刷新与仓库组走本机镜像缓存的刷新，
  与此前“没有远端登记”时相同；托管一支的登记与刷新取部署选择的远端，与此前给了 `remote` 时相同。
- **维护 worker 不变**：worker 效果为 `null`（单机）时显式给本机的准备 effect、草稿区 effect 与维护文件系统，参数与此前回落相同（前两者取
  `taskPorts`、`db`、`appHome`，维护文件系统取 `appHome`、`isMaterializingTask` 与 `invalidateCallGraphIndex`）；托管照旧取效果里的。
- **提交预览**：没有作用域时 `preview` 要求给出索引，核对在 application（`requireRepositoryPreviewIndex`）；生产没有读提交预览的调用方，报错只有用例
  能走到，调用 `preview()` 的四个用例都给了索引或作用域。进程内的提交用例照旧是没有托管提交操作时的主路径。
- **托管能力与 CrewStation 事件入口不变**：消费方此前把没给当作没有这项能力，现在同样判 `null`；daemon 原样交入部署选择（单机 `null`、托管给能力）。
  webhook 入口单机照旧是开放直连的入口、托管照旧交 CrewStation 事件入口，`server.ts` 照旧以可选链挂载。
- **工作区上传的写入方**：路由启动只给部署的上传内容工厂（与此前相同），进程中断预言只给整体写入替身；两者都给照旧被运行期拒绝。
- **单机的排除档案不变**：回落一支的代码原样移进 `composeLocalWorkspaceExcludeProfiles`，照旧每次绑定按应用根目录读配置。
- **删去的都没有生产使用方**：`legacyRunGit` 与请求上的 `runGit`、排除档案的选择与核对、`readLocalAppHome`、`bindPoliciesToWorkspace`（生产总为真）、
  提交推送执行依赖的 `runGit`、维护命令只为回落存在的三项；只服务用例的 `composeTaskWorkspaceExcludeProfilesFor` 与 `applyUploadsToWorktree` 移进
  测试助手。
- **用例的选择与此前缺省相同**：自动改写在原来回落的位置给同一个工厂与参数；共享助手只在用例没给时造。
- **账本与锁**：RFC-521 门删去 19 条登记、`repositoryCommit.ts` 的三处按 `option` 登记，适配器回落 19 → 0、`SUCCESSORS` 清空；`counts.json` 三项
  按实测收紧（source-control 组合层控制流 9 → 6、task-execution 组合层控制流 11 → 10、public surface 偏差 56 → 54）；钉旧形状与回落原文的锁随改
  （`rfc431-standalone-selections` 的必填 / 可空分区 51 / 11 → 53 / 9、`rfc433` 的单机可空项 5 → 3、`rfc511` 的清单 11 → 10、`rfc510` 的组合层
  选择、`rfc499` 的准备装配、`rfc512` 的镜像组合文件、`rfc390` 的中立 HTTP 绑定名单、`rfc446` / `rfc447` / `rfc451` 的镜像登记方式，以及两条
  钩子用例改钉本 RFC 的合同）；guard-manifest 登记 RFC-527 用例，改动过的条目行数按各条原有的计法随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-526 转 Done）；实现与验证后再提交
`refactor(backend): RFC-527 源代码管理的适配器回落改为必填注入（RFC-294 S12 第八步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff /
push。推送后按 exact SHA 跟 CI。
