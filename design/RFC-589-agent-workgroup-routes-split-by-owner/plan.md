# RFC-589 实施计划

依赖：RFC-588。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-589-T1 拆分与搬迁**：两个文件迁入 `RC/inbound/http/`，两个启动端点迁入 `TE/inbound/http/` 的两个启动绑定（design §1）。
- **RFC-589-T2 连接**：两个 composition 转出挂载函数，`server.ts` 的 `agents`、`workgroups` 两步各按序挂两个绑定。
- **RFC-589-T3 门、用例与文档**：归属表、`counts.json`、钉着旧路径的用例、按候选报告撤回的 public 符号；新增 RFC-589 用例并登记（design §3）。
- **RFC-589-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-589-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两个旧路径不存在、没有说明符再解析到它们；四个新文件合起来与原来两个文件只差 import、依赖接口的拆分、端点的位置与可见性小函数
- [x] AC-2 代理与工作组的相关路由用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 58 → 56；未消费 public 符号保持 0（32 个符号随之撤回）；DAG 之外的边与跨 context 内部文件对不增加；新增
      RFC-589 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `7ff4408d4`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint（58 个 TS 文件）与 promises 配置（37 个 `src` 文件）无告警；改动的 TS、RFC 文档与两个 JSON 账本 prettier 通过。开发期
  的静态自查查出一处：语法树搬迁工具只搬导出的声明，`public/types` 里 7 个只服务被搬合同的未导出小类型留在原处（tsc 报 import 不到、eslint 报未用），
  已连同问题码要的 `PluginDisabledErrorCode` import 一并移进 `application/agents/queryContracts.ts`。
- **逐字比对**（脚本）：代理启动端点（原文件里连续 82 行）逐字出现在代理启动绑定里；工作组启动端点（56 行）只改了一行注释指针（“see routes/agents.ts”
  → “see the agent launch binding”）；两个资源目录绑定与“原文件减去启动端点”相比，只差 import（含撤回之后改从 `application/` 取的类型）、依赖接口里的
  `taskLaunch` 与两条转出。
- **撤回推算**（design §3，在实现后的候选报告上算）：第一份候选报告里 resource-catalog 的未消费 public 符号 0 → 6、task-execution 0 → 2；按 public 类型
  引用算到不动点共 32 个。撤回之后复算，各模块的未消费计数都回到 0。
- **候选导出**（撤回之后，候选已提交）：选出 783 个用例文件，782 个在候选导出里跑——7494 条里红 7 条，各在一个文件里，都是**本人缺陷**：钉着被撤回符号的
  声明位置或 `routes/` 文件数的用例没跟着改（`rfc305` 的 identity-access 消费者清单、`rfc345` 两处声明位置、`rfc439` 的非空下限、`rfc550` 的正对照、
  `rfc552` 的 public/operations 逐名清单、`rfc569` 的闭合声明清单）。逐个改正后在候选导出里复跑这 7 个、`rfc376-structural-guards` 与 RFC-589 用例
  （9 个文件、313 条）全部通过，读 guard-manifest 的 23 个用例文件（243 条）全部通过；`rfc321`（要 git 历史）在主树里 10 / 10。
- **注册顺序**（脚本）：代理资源目录绑定的 14 条注册、工作组的 10 条注册（含操作目录绑定）里，没有能匹配 `POST /api/agents/:id/tasks` /
  `POST /api/workgroups/:id/tasks` 的模式，也没有中间件。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：六种都被认出——旧代理路径上重新出现一跳转出（RFC-589 用例与 `rfc376-structural-guards` 都红）；
  测试 helper 经 `import type` 取旧工作组路径；资源目录的代理绑定重新取 task-execution 的 public（RFC-589 用例与 `rfc294-review-offered-edge-dag` 都红）；
  代理启动端点注册回资源目录绑定；`server.ts` 的 `agents` 一步漏挂启动绑定；`workgroups` 一步把启动绑定挂到资源目录绑定之前。复原后导出无残留。
- **架构报告**（候选对照 `7ff4408d4`）：60 个计数里只有 `legacy-horizontal-files` 变了（58 → 56）；未消费 public 符号 0；public 面 837 → 805；跨 context
  import 7651 → 7663——四个绑定原来在 `routes/`（legacy → legacy）取 `@/auth/actor`、`@/routes/registry` / `operationRoute`，现在是模块 → legacy，加上两个
  启动绑定对 resource-catalog public 的取用（DAG 允许的 offered-consumption）；DAG 之外的已提供边由 `rfc294-review-offered-edge-dag` 在候选导出里核对通过。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **端点逐字**：两个启动端点逐字迁入（见集中验证的比对）；处理逻辑、权限声明（`tasks:execute`）、`executionGroup`、错误码与响应一行未改。
2. **可见性小函数**：两个启动绑定各带一份，与资源目录绑定里的那份同码同文（`agent-not-found` / `workgroup-not-found`，看不见与不存在同形）。
3. **挂载与注册顺序**：`agents`、`workgroups` 两步各先挂资源目录的绑定、再挂启动绑定，两者收同一个对象（`server.ts` 的输入类型为两个依赖接口的交集，
   启动绑定要的 `queries.get`、`authorityFor`、`taskLaunch` 都在里面）；资源目录绑定里没有能抢先匹配启动路径的路由或中间件；与别的挂载步骤的相对顺序
   不变。
4. **撤回**：32 个符号只改类型的来源（7 个未导出小类型随之移动、仍不导出），运行时无变化。
5. **鉴权元数据**：`rfc247` 用例确认两个启动端点仍只声明 `tasks:execute`（用例改为同时挂两个启动绑定，断言不变）。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
