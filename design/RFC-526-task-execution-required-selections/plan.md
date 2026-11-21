# RFC-526 实施计划

依赖：RFC-525。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-526-T1 启动恢复与数字员工执行**：执行恢复工厂与程序工具源必填，删去数字员工执行的 `appHome`（design D1）。
- **RFC-526-T2 操作配置**：daemon 交给驱动参与者；提交排除模式与可执行文件冻结只取给的配置，删去按 `configPath` 造本机实现的两支（design D2）。
- **RFC-526-T3 启动配置**：按 `kind` 显式装配两支（design D3）。
- **RFC-526-T4 节点提示、端口工件与删除效果**：内容必填、组合层转出本机内容实现、单机部署显式构造；删去内部的 `select*`，调用方的选择必填
  （design D4）。
- **RFC-526-T5 provider 运行期与归档**：排除档案与归档必填、旧版一支的提示与工件必填；维护 worker 显式给归档内容（design D5）。
- **RFC-526-T6 工作区存在性**：生命周期持久化的存在性必填；维护 worker、任务取消与人审停靠显式给出（design D6）。
- **RFC-526-T7 用例与测试助手**：测试助手；tsc 列出的调用逐处改；钉旧形状与回落原文的锁随改（design D7）。
- **RFC-526-T8 门与账本**：RFC-521 门删 16 条登记、`SUCCESSORS` 删 task-execution；计数降的收紧到实测；新增 RFC-526 用例并登记 guard-manifest。
- **RFC-526-T9 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、按被删的名字、选项与回落原文扫出的用例、按被改文件的路径筛出读取其源码
  的用例、经改动的测试助手传入被改项的用例与全部 `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语
  料交给 CI 的 backend 分片。
- **RFC-526-T10 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 16 处回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 19 条
- [x] AC-2 daemon、维护 worker 与单机部署得到的对象不变；改取部署选择的路径不查询存在性；用例给出的选择与此前缺省相同
- [x] AC-3 bootstrap 不深取 task-execution 的 infrastructure；public surface 不升；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 53～114，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同（212 个路径）；对照
导出仓库与 HEAD（`931582bfb`）的树相同。开发期按 `tsc` 列出的调用逐处改为显式给出（145 个文件用 AST 脚本改，其余手改）。集中验证查出本人三类
缺陷，修正并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 207 个 TS 文件无告警，改动的 34 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest、`counts.json` 与本 RFC 的三件套通过。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker）：306 个文件——`tests/architecture/` 全部 142 个、
  改动过的用例、经改动的测试助手传入被改项的用例与 preflight。候选 3,947 条通过、131 条红，对照 3,934 条通过、130 条红（对照没有本 RFC 用例）；
  红的绝大多数是默认 5 秒的时限。逐文件比失败名，候选多出的断言失败在四个文件：
  - `rfc370-node-run-prompt-bindings` 与 `rfc370-port-artifact-bindings` 按 AST 钉单机装配的实参，钉的仍是不给内容、由回落造的旧形状；
  - `rfc376-structural-guards` 的 `KNOWN` 与 preflight 的文件对清单仍列着已删的跨上下文文件对（生命周期持久化取 source-control 组合层的本机
    存在性）。

  本人缺陷，随改：两条锁改钉单机显式给出的内容（`createFileNodeRunPromptContent(join(appHome,'runs'))` 与
  `createFilePortArtifactContent(appHome)`），评审一处改钉必填的读取选择；两份清单删去这一对。

- **复验首批**（放宽到 60 秒、各 3 个 worker，与对照同时）：首批候选多出失败的 19 个文件。两边各 659 条通过、2 条红——两个 rfc370 锁文件各一条
  PostgreSQL 钩子在新建的库上撞 60 秒，两边相同；这两个文件在预热过的库上再跑，两边都 33 / 33。preflight 的文件对用例另按名字筛出单跑，两边通过。
  候选多出的其余红在 60 秒下全部通过（`commit-push-runner`、`cross-clarify-service`、`rfc128-p5-d-autodispatch`、`rfc193-wrapper-review`、
  `rfc328-codehost-attempt-ledger`、`rfc333` 两个、`rfc359` 的 W12 / W3 / W4 / W7 / W8 五个、`rfc370-m1-boot-recovery`、`rfc374`、`rfc381`、
  `rfc386`），两边逐条相同。
- **第二批**（60 秒、各 3 个 worker）：261 个文件——按被改文件的路径筛出、读其源码的用例与其余测试助手用户的五分之一抽样（222 个），读操作配置、
  前两份清单没排进的 20 个用例，加上复验的 19 个文件。候选 3,485 条通过、30 条红，对照 3,484 条通过、24 条红。候选多出的断言失败在三个文件：
  - `api-task-injected-memories`（8 条）与 `rfc182-room-execution`（2 条）：`taskNodeRunsProjection` 的依赖类型仍把 `nodeRunPrompts` 留成
    可选，实现却已改为必填核对（`requireNodeRunPromptOperations`），`tsc` 看不出没给的调用；
  - `rfc328-architecture-guards` 的 `crossContextProviderBridges` 仍列着已删的那一对。

  本人缺陷，随改：依赖类型改为必填，`tsc` 列出的 19 处调用（9 个用例文件）显式给出与此前缺省相同的提示操作
  （`composeNodeRunPromptOperations(createFileNodeRunPromptContent(Paths.runsDir))`），本 RFC 用例钉住这一项不是可选；`rfc328` 删去这一对。
  候选多出的其余红是用例自带的时限（`rfc370-employee-input-root-bindings` 的 20 秒、`rfc395-af2-daemon-wiring` 的 30 秒），两边撞时限的用例
  互有出入（对照另有 `rfc164-workgroup-core`、`rfc359-w4-d6c-adapters` 与 `rfc098` 一条的 60 秒钩子）。两边相同的红：用例自带的时限与钩子（`rfc098` 的
  60 秒钩子、`rfc370-selected-task-root-configuration` 与 `tasks-multipart` 的 30 秒、`rfc395-boot-runtime-config` 的 90 秒钩子），与本机环境
  （`scheduler-clarify-inline` 的 PostgreSQL 夹具在两边同样建不起来、`rfc321-repository-publication-ratchet` 要可达的 git 历史，导出仓库没有）。

- **第三批**（60 秒、各 2 个 worker）：95 个文件——直接导入被改生产模块、前两批没跑的 92 个用例，加上修正后的 `api-task-injected-memories`、
  `rfc182-room-execution` 与本 RFC 用例。候选 1,100 条通过、25 条红，对照 1,096 条通过、15 条红。修正后的三个文件在候选一边 8 / 8、4 / 4、
  14 / 14。候选多出的红：`api-task-output-kind` 6 条（同一缺陷的第九个文件，它跑在这处修正同步进导出仓库之前）；`rfc370-repository-git-workspace`
  一条（`git push` 撞用例自带的 3 秒 git 时限，推送结果为失败）；`lifecycle-property` 与 `review-detail-render-rfc158` 各多两条用例自带的时限
  （15 秒与 30 秒的钩子，两边都撞）。两边相同的红都是用例自带的时限（`scheduler-clarify-dispatch` 的 20 秒、`rfc395-task-subject-target` 的
  90 秒钩子）；对照另有 `rfc370-task-archive-content` 一条 20 秒。
- **终验**（最终候选；60 秒、各 3 个 worker，与对照同时）：50 个文件（对照 49 个）——调用 `taskNodeRunsProjection` 的 13 个用例（含修正的 9 个与
  本 RFC 用例）、按被改的任务路由操作文件的路径筛出读其源码的 28 个用例、`rfc328-architecture-guards`、读 guard-manifest 与 `counts.json` 的
  账本用例（`rfc317` 的三个与 `rfc479`）、preflight 全文件，加上前几批候选多出时限红的 3 个文件。候选 669 条通过、2 条红，对照 655 条通过、
  2 条红（对照没有本 RFC 用例的 14 条）：两边唯一的红是 preflight 同样两条用例自带的时限（180 秒与 60 秒，本机分别跑了约 761 秒与 195 秒）；
  其中 public surface 偏差一条读的报告项，两份架构报告逐条相同（`publicSurfaceDeviations` 56 / 56）。`api-task-output-kind` 6 / 6、
  `rfc328-architecture-guards` 7 / 7、`rfc370-employee-input-root-bindings` 5 / 5、`rfc370-repository-git-workspace` 8 / 8、
  `rfc395-af2-daemon-wiring` 18 / 18，两边相同。
  第三批两边都撞时限的 4 个文件（`lifecycle-property`、`review-detail-render-rfc158`、`rfc395-task-subject-target`、
  `scheduler-clarify-dispatch`）再以单个 worker（两边同时，负载约 42～48）各跑一次：仍然都是用例自带的时限，两边互有多少（候选 35 条通过、
  15 条红，对照 34 条通过、16 条红）；第三批候选多出的 `review-detail-render-rfc158` 两条这次在候选一边通过、在对照一边红。各批两边相同的红
  在 HEAD 的 CI 上都通过（`931582bfb` 的主 CI run 44852957372 第 1 次 70 / 70）。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份；之后的生产改动只有投影依赖的那一处类型）：60 项实测里只有
  `cross-context-internal-file-pairs` 18 → 17，已按实测收紧；task-execution 组合层控制流 11 → 11（只是行号）；public surface 的条目与预算不变；
  跨上下文导入 7,512 → 7,517——删去 2 条（端口工件组合层取 `@/util/paths`、生命周期持久化取 source-control 组合层的本机存在性），新增 7 条，都是
  bootstrap 取组合层（单机的节点提示与端口工件、维护 worker 的归档与工作区存在性、daemon 的任务执行组合层）与 public 合同的类型导入；
  各模块符号属主只少了被删的三个 `select*`。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/` 与 `docs/`，按词边界）：`selectNodeRunPromptOperations`、
  `selectPortArtifactOperations` 与 `selectedTaskDeletionEffects` 只在钉它们不存在的锁、注释、RFC-480 的已撤符号清单与 `docs/dev-gotchas.md`
  里；backend 以外的包与脚本不调用本 RFC 改动的入口（frontend 与 shared 只在注释里提到 node-runs 投影）。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，全过（40 / 40）。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **daemon 得到的对象不变**：启动恢复、数字员工执行的程序工件源、provider 运行期的排除档案与归档、任务路由的提示与删除效果、评审与端口工件路由
  的读取此前就总是部署选择的，删去的只是没给时的那一支；HTTP 装配与会话装配的参与者绑定多带一份部署选择的工作区存在性。
- **操作配置不变**：此前每次提交与每次冻结都由回落按运行参数的 `configPath` 造本机配置文件实现；daemon 的运行参数与驱动参与者用的是同一个
  `configPath`（两种部署都是 `Paths.config`），现在 daemon 构造一次交给唯一的驱动入口，驱动参与者把它并进每次驱动（根任务、子任务、续跑）的参数
  与运行族的绑定。这个实现每次读取时才 `loadConfig`，不缓存，读到的与此前相同；没给配置的路径（用例）照旧只用运行参数里的排除模式。
- **启动配置不变**：三处读取按调用方选的 `kind` 分支，`selectedQueries` 照旧由 `kind` 推出，返回的形状不变。
- **单机部署与维护 worker 不变**：单机的节点提示与端口工件用此前缺省的根目录（`<appHome>/runs`、`appHome`）显式构造；维护 worker 的归档在单机（效
  果为 `null`）时是此前缺省的本机内容、不带根目录，托管照旧取效果里的绑定；它的任务持久化与人审闭包显式给本机文件存在性（此前回落造的同一个）。
- **改取部署选择的几条路径不查询存在性**：存在性只在 `allowTerminal` 且从终态转到非终态（复活）时查询；任务取消的目标是终态 `canceled`，人审停靠从
  运行态转入等待人审，都不是复活转移。单机部署两者是同一种本机文件存在性；托管部署此后在这几条路径上也拿到自己的存在性。
- **删去的都没有生产使用方**：三个内部 `select*` 的回落一支、provider 运行期旧版一支的缺省提示与工件（daemon 总给运行绑定）、数字员工执行的 `appHome`；
  task-execution infrastructure 的核对照旧在原来的位置做（改为直接调 application 的 `require*`）。
- **用例的选择与此前缺省相同**：自动改写在原来回落的位置给同一个工厂与参数；共享助手只在用例没给时造，且放在用例的展开之前（`withO2Closure` 的读取取
  用例自己的 app home）；直接装 provider 运行期的助手像 daemon 一样交操作配置；任务路由操作的 node-runs 投影的 19 处用例
  调用给的是此前回落造的同一个（`Paths.runsDir` 下的提示文件），route 操作在生产里总把自己的交入。
- **账本与锁**：RFC-521 门删去 16 条登记，适配器回落 35 → 19，`SUCCESSORS` 删去 task-execution；`counts.json` 一项按实测收紧（跨上下文内部文件对
  18 → 17：生命周期持久化不再取 source-control 组合层的本机存在性）；钉旧形状与回落原文的锁随改（`rfc143-runtime-driver-capability`、
  `rfc370-v4-program-tools`、`rfc510-…` 的组合层转出与核对调用表，按 AST 钉单机装配实参的 `rfc370-node-run-prompt-bindings` 与
  `rfc370-port-artifact-bindings`）；`rfc376-structural-guards` 的 `KNOWN`、preflight 的文件对清单与 `rfc328-architecture-guards` 的
  `crossContextProviderBridges` 同删这一对；guard-manifest 登记新用例，改动过的条目行数按各条原有的计法随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-525 转 Done）；实现与验证后再提交
`refactor(backend): RFC-526 任务执行的适配器回落改为必填注入（RFC-294 S12 第七步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。
推送后按 exact SHA 跟 CI。
