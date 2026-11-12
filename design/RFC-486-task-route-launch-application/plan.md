# RFC-486 实施计划

**前置**：RFC-483（Done，`8f7463f57`，Done 文档 `f6a7fadea`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后
集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                                     | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| RFC-486-T1 | application 端口：工作区参与者三件与工作组资源投影、准入端口与准入请求、上传落地端口、`TaskLaunchGuard`；`public/types` 交出 `TaskLaunchGuard`，integration 的 `ProtectedMrLaunchGuard` 改为扩展它，`launchTask.ts` 改取 | design §2 |
| RFC-486-T2 | domain：工作组运行时配置的三个构建函数迁入 `domain/workgroupRuntimeConfig.ts`，`childExecutionLaunchOperations.ts` 改取                                                                                                  | design §2 |
| RFC-486-T3 | infrastructure：`rootTaskAdmission.ts`（准入事务、`projectLaunchedTask`、活跃成员查询、提交后发布）与 `taskAutomationReceipts.ts`；工作区参与者的实现方改取端口类型                                                      | design §2 |
| RFC-486-T4 | application/launch：根启动内核、两条启动臂、路由启动操作与启动参与者四个文件；删除 `infrastructure/taskRouteLaunchOperations.ts`                                                                                         | design §2 |
| RFC-486-T5 | composition：`providerRuntime.ts` 装配准入、上传落地、授权查询、上传上限与直接启动人；`composition/taskRouteLaunch.ts` 的转出改指新位置                                                                                  | design §2 |
| RFC-486-T6 | 账本与用例：表归属债两条改键并补后继身份；越 DAG 清单销一对；文本账本与读源码的用例改指新文件（断言意图不变）；helper 补传端口；新增 RFC-486 用例并登记 guard-manifest；`counts.json` 收紧                               | design §3 |
| RFC-486-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                                                      | design §5 |

## 验收清单

- [x] AC-1 `infrastructure/taskRouteLaunchOperations.ts` 删除；启动编排在 `application/launch/`，不 import `infrastructure/**`、不收裸 `db`
- [x] AC-2 准入事务由一个 infrastructure 适配器实现，语句与次序不变；两条表归属债按后继身份改键，账本条数不变
- [x] AC-3 越 DAG 的 offered 文件对 47 → 46；减速带不升、触及的收紧到实测；task-execution 的 public 只增 `TaskLaunchGuard`
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证（2026-11-11，候选基于 `109187d5c`）

本机全程高负载（10 核；采样到的 1 分钟负载 36～96，主要是本机其他进程：Docker 虚拟机与其他 bun 进程）。验证在候选导出仓库里跑（HEAD
的树加候选路径；修复后重新同步，核对与工作树逐字相同）；对照导出仓库与 HEAD 相同（`109187d5c` 只改文档）。验证期间 `origin/main` 未
前进（一直是 `109187d5c`）。开发期按 RFC-482 的做法用字面量扫描对 HEAD 与候选核过 `tsc` 看不到的源码文本断言：真实用例里「HEAD 命中、
候选不命中」的 4 条逐条核对，1 条是另一个面的禁用清单（`rfc294-background-worker-boundary` 对 integration 守卫列的 `AbortSignal`），3 条
是本 RFC 用例自己的反向断言（integration 的守卫不再重复声明 `launchSettled`、`snapshot`、`taskCommitted`）；钉 sha256 的 fixture 不含改动的
文件。集中验证查出本 RFC 的两处问题，已修复并复验：

1. **读源码文本的用例漏改一处**：`rfc243-executor-facade` 读旧文件的文本检查首批即红。开发期改写文本引用时，把 import 该模块的文件当成已
   由 import 改写覆盖，跳过了它们里面的路径字面量；改读四个启动文件。
2. **类型转换盖住新增的必填依赖**：`rfc359-w7-task-route-conformance` 把 `{ db, configPath }` 经 `as never` 交给路由启动操作，`tsc` 看不到
   缺了端口，首批即红；改用 composition 的 `createRootTaskLaunchPorts`。按同一形状扫出 `tests/helpers/eachProviderTaskExecution.ts` 的
   `as unknown as Parameters<…>[0]`（同样没带端口），未等用例红即改用内核端口。两条教训记入 `docs/dev-gotchas.md`。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 77 个 TS 文件），promises 规则集对改动的
  26 个源码文件无告警；改动的 TS 与 RFC-486 三件套 prettier 检查通过（`architecture/*.json` 按仓库约定不进 prettier；`STATE.md` 等不跑
  prettier）。
- **RFC-486 用例**：候选上 11 / 11；对 HEAD 的代码，② 一节读不到准入适配器文件、在 describe 处报错，其余 9 条红 7 条（两条负对照两边都绿）。
- **首批**（`tests/architecture/` 全部、本 RFC 改动的用例与读启动文件文本的用例，215 个文件）：210 个通过；2 个是上面两处；
  `rfc321-repository-publication-ratchet` 是导出仓库没有真实历史（与 RFC-483、RFC-485 相同；真实仓库 10 / 10）；`rfc376-report`、`rfc400`
  撞用例自带的时限。
- **修复批**（上面两个文件与经 `eachProviderTaskExecution` 启动的 14 个，16 个文件）：15 个通过；`rfc359-w9-retry-rollback-parity` 撞文件默认的
  10 秒，放宽副本 13 / 13（见下一条）。
- **全量 SQLite**（导出仓库逐文件跑：每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带时限的照旧；
  5 个 worker）：2,928 个文件、2,913 个通过。其余 15 个都不归本 RFC：
  - 发布账本一条（`rfc321-repository-publication-ratchet`），同首批。
  - 14 个撞用例自带的时限或内部等待：`rfc376-report` 的子进程在 300 秒处被杀，`rfc376-structural-guards` 的减速带一条 20 秒，
    `clarify-review-combination-scenarios` 的三条 20 秒流程，`rfc167-dynamic-workflow-engine` 的 `settleTask` 5 秒（走 dw-confirm，不经路由
    启动），`rfc363-task-workspace-process-recovery` 的检查点 30 秒，其余 9 个是文件或单条的时限（`rfc370-committed-architecture-source`、
    `rfc400`、`epoch1-permission-text-backup`、`lifecycle-property` 与 `rfc395-*` 五个）。在只放宽时限常量的副本上全部跑完通过：连同修复批的
    `rfc359-w9`，15 个副本 369 条全过（3 个 worker；`rfc363` 照 RFC-482 另加检查点的轮询兜底）。
- **PostgreSQL**：本 RFC 不改 SQL 与事务体（准入事务逐字迁移），以 CI 的双引擎分片为证据。另把本 RFC 改写的双引擎用例、经根启动
  内核 / 路由启动操作 / 启动参与者启动任务的双引擎用例共 29 个文件接 PostgreSQL 跑（两种 provider 同进程、`--randomize`、单条 60 秒；
  3 个 worker）：676 条通过（PostgreSQL 一侧 351 条），2 条红，都不归本 RFC：
  - `rfc359-w9-retry-rollback-parity` 的 `[postgresql]` kind 矩阵一条撞文件默认的 10 秒（10.7 秒）；放宽副本 2 轮 26 / 26。
  - `rfc359-w14-legacy-mission-execution` 的 `[postgresql]` agent 一条撞 25 秒的终态回调等待。同一负载下原文件在候选与 HEAD 对照上各跑
    3 轮：候选 4 / 4、3 / 4、3 / 4，HEAD 3 / 4、4 / 4、2 / 4（HEAD 那一轮两条 PostgreSQL 用例都红），红的都是同一处等待。候选两次红的日志里
    该任务的写入撞上 owner 围栏、失败写让给并发的转移（HEAD 的红没有这一行；这行日志在 `rfc097-cancel-wins`、webhook 等通过的用例里也
    常见）；只放宽时限常量（节点 20 → 200 秒、回调 25 → 250 秒、释放等待 5 → 50 秒）的副本在候选与 HEAD 上各 2 轮 4 / 4，围栏未再出现。
    它经 `eachProviderTaskExecution` 的内核启动，内核与准入适配器对 HEAD 的差异只是端口接缝（见实现门）。
  - `single-nonroot-member-workspace` 跑满 runner 的 1,500 秒进程闹钟被截停：PostgreSQL 一侧 113 条全部跑完通过，SQLite 一侧跑到
    43 / 113（全过）；整个文件在全量 SQLite 里通过。
- **架构报告**（`scripts/architecture-report.ts --gates`，候选 vs HEAD 的代码出的报告）：60 项实测与 `counts.json` 的 `max` 逐项相等，门里
  只有越 DAG 的 offered 文件对 47 → 46 一项变化；类型偏差 57、未消费 91、跨 context 内部文件对 43、`module-layer` 1、application 直接副作用
  2 不变。public surface 1,203 → 1,204（task-execution 226 → 227，即 `TaskLaunchGuard`；integration 34 不变）。mutation 入口 2,332 → 2,336：
  原来 7 个同名迁到新文件，新增 4 个是包同一组写语句的端口工厂（`createRootTaskAdmission`、`createTaskLaunchUploads`、
  `createRootTaskLaunchKernelPorts`、`createRootTaskLaunchPorts`）。跨 context import 7,646 → 7,662：删去的文件 22 条与旧工作组运行时配置
  文件 1 条，随内容拆进新文件后成了 39 条（拆出的文件各自 import legacy 的 actor、错误与平台类型，legacy 净增 16 条），其中 task-execution →
  integration 的 1 条（越 DAG 边）不再出现；integration 的守卫改取 task-execution 的 `public/types`（增减各 1）。表归属债 fixture 121 条不变，
  两条改键为 `rootTaskAdmission.ts`。
- **最终候选**：导出仓库与 HEAD 加 86 个候选路径逐字相同（12,162 个文件逐字节比对），临时副本已删。文档对账与读 guard-manifest 的
  17 个用例 178 条全过（两种 provider 同进程、默认 5 秒、`--randomize`，含 3 个 rfc317 守卫账本用例与 RFC-486 用例）。候选 3 之后只同步了
  文档（本 plan 与 `STATE.md`），代码与用例的结果沿用，架构报告不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS。逐段把 HEAD 上旧文件的各段与新位置的对应段去掉空白与注释后比对：

- **准入事务与投影**：适配器里的事务体与 `projectLaunchedTask` 与旧文件逐字相同；请求带的 `actor`、`task`、`subject`、`internal` 就是内核
  手里那份（规范化过排版的入口请求），`persistedInputs` 是上传落地改写过的同一个对象；次序仍是内核读时钟 → 适配器投影 → 事务。返回给
  `launchTask` 的 `failed` 与此前同一个表达式。
- **其余接缝**：上传落地、提交后发布、直接启动人、上传上限与授权查询各改调端口，端口由 composition 用此前同一份 db、上传内容与输入文件
  存储、配置路径与函数建出（授权查询仍是每个装配一份）；两臂、路由启动操作与启动参与者除这几处外逐字相同。
- **守卫**：`TaskLaunchGuard` 的成员是此前内核与 `launchTask` 用到的并集，integration 的守卫扩展它、只多 `id`，交入的对象不变。
- **装配**：`providerRuntime` 从 bootstrap 原样收到的启动输入里取出配置路径与两份上传存储建端口，其余字段照旧交给三个工厂；bootstrap 不改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同时补 RFC-483 plan §CI 的后继证据）；实现与验证后再提交
`refactor(backend): RFC-486 任务启动用例归 task-execution 的 application（RFC-294 W4-E1 余项）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
