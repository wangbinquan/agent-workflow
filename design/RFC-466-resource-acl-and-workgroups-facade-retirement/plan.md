# RFC-466 实施计划

**前置**：RFC-465 落地（`27ac7027a`，Done 文档 `83e179801`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中
验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                  | 依据           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| RFC-466-T1 | 五个活消费方改取 owner 合同（任务角色端口、`public/queries` / `public/types`、`AgentLaunchResourceOperations.canViewWorkflow`）       | design §1      |
| RFC-466-T2 | 调用闭包预言与完整启动门迁入 `tests/helpers/`                                                                                         | design §2      |
| RFC-466-T3 | 删除两个 facade；用例改取定义处；收回失去模块外消费方的 public 符号；精确清单、公共内核清单、账本与 guard-manifest；新增 RFC-466 用例 | design §3、§3a |
| RFC-466-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                                 | design §6      |
| RFC-466-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                                       | —              |

## 验收清单

- [x] AC-1 两个 facade 不在、零引用；六个消费方按 G1 / G2 改取；生产树里不再有 `legacyCallClosure` 与 `assertWorkflowLaunchable`；G5 的符号收回
- [x] AC-2 架构计数按实测（`R1` 96 → 86），public surface 偏差、未被消费的 public 符号与越界类计数不升
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-07，候选基于 `83e179801`）

本机全程高负载（采样到的负载 20～83；本机另有常驻负载：一个本地 Kubernetes 控制面容器约 4 核、三个挂起的测试夹具进程各约 1 核）。验证都在
候选导出仓库里跑（`83e179801` 的 `git archive` 加候选路径，提交后运行；每次修正后重新同步，核对与 HEAD 加候选逐字相同）。**集中验证查出
本 RFC 的三处问题，均已修正并复验**：

1. **`public/types` 转出 `isVisibleToAudienceSnapshot` 违反 RFC-294 W0-R 的 capability 规则**：它的入参 `ResourceAclAudienceAuthority`
   命中 capability 名称启发式（`…Authority` 类型不得穿过 `public/types` / `public/events`），`rfc294-architecture-preflight` 的 capability
   归属用例在 PostgreSQL lane 里红出 `ResourceAclAudienceAuthority leaks through public/types`（SQLite 全量里同一用例撞自带的 180 秒时限，
   跑了 686 秒）。改为从 `public/queries` 转出（与 RFC-454 / RFC-455 的纯判定同处），integration 改从那里取，RFC-466 用例加断言
   `public/types` 不导出它；实测 capability 归属清单 18 条逐条相等。
2. **`rfc359-w58-workflow-sync-preview-parity` 的源码兜底钉着改掉的那一行**（`taskRouteOperations.ts` 里的
   `canViewResource(dependencies.db, actor, 'workflow', workflow)`，两边都在 1 ms 内红）：改为同时锁注入的
   `await dependencies.canViewWorkflow(actor, workflow)` 与实现处同一条 `canViewResource(db, actor, 'workflow', workflow)`，合起来与原先
   那一条等价。
3. **facade 退役留下两个失去模块外消费方的 public 符号**（架构报告实测未被消费的 public 符号 323 → 325）：intent
   `public/operations#canAuditIntentSessions` 与 resource-catalog `public/queries#callEdgeKey`。按 RFC-294 design §3.3 当场收回（design
   §3a）：审计判定落 intent `domain/sessionAudit.ts`；已无 importer 的 intent `public/operations.ts` 删除（只挪走判定、留下这个文件，实测它会
   成为新增的不可达生产文件）；resource-catalog 里无人引用的同名副本删除；`callEdgeKey` 退出 `public/queries`。收回后未被消费的 public 符号
   323 → 322、不可达生产文件 26 → 24。

- **静态**（最终候选上复跑）：backend `tsc` 0 错；eslint `--max-warnings 0` 无告警（backend 与 `eslint.promises.config.js`，后者只覆盖
  src）；`depcheck` 分层门通过（4432 个模块）；改动的 TS 与 RFC-466 文档已按 prettier 格式化。
- **声明逐个比对**（最终候选，`83e179801` 对工作树）：迁出的两段代码 6 个声明 0 差异；改动的 12 个生产文件里 227 个顶层声明逐字未变、
  12 处预期差异（见实现门）；删去的声明只有 intent 审计判定（迁入 domain，说明与函数体逐字相同）与 resource-catalog 的无人引用副本。
- **全量 SQLite**（第一版候选，即上面三处修正之前；导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：5709～6394 s 全部跑完，
  合计 23498 pass / 127 skip / 69 fail，另有 38 条测试间未处理错误（全在其中 15 个超时文件里）。66 条是超时（31 个文件）：58 条撞默认 5 秒；
  5 条撞用例自带的 30 秒（`rfc354` 嵌套帧闭包、`rfc363` 目录分页、`rfc395` 内联行流式暂存与 epoch-1 备份、`rfc300` webhook 工作区清理）；
  `rfc354` 循环套循环一条撞 20 秒；`rfc376-report` 撞 300 秒；以及上面第 1 处的 capability 归属用例。其余 3 条：上面第 2 处、导出仓库只有
  候选提交所致的 `rfc321`、组合场景 S-RFC074（20 秒后读到 `canceled`）。RFC-466 用例（第一版）通过。
  - 复跑 91 个文件（最终候选；33 个失败文件——导出里恒红的 `rfc321` 除外——加 58 个后续修正波及的用例：RFC-466 用例；读
    resource-catalog / intent public 入口源码、取数字员工工具连接、intent 会话审计、调用闭包 helper 与 `resourceDefaults` 的用例；读
    guard-manifest 的三个账本用例与改到的守卫；30 秒时限）：89 个全过（含修正后的 W58、`rfc294-architecture-preflight` 与 RFC-466 用例），合计 1143 pass / 2 fail（负载 20～66），余下
    RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`，读到 `running`）与 `rfc363` 目录分页（撞自带的 30 秒）——与 RFC-462～465
    复跑后余下的两例相同。对照：同一时刻在 RFC-465 的导出仓库里跑同一文件（负载 23～25），`rfc167` 两边都是 28 pass / 1 fail、同一例到点
    （5.50 s 与 5.45 s），`rfc363` 两边都是 3 pass / 1 fail、同一例到点（30.42 s 与 30.42 s）。
- **导出仓库接 PostgreSQL 真库**（第一版候选）：一条 lane 309 个文件（全部架构测试；改动的用例；评审、工作流同步、工作组、资源 ACL、
  调用工作流、数字员工工具连接、融合路由、MCP 测试台等取改动件或其消费方的用例）：260 个文件全过，合计 3724 pass / 206 fail / 4 skip
  （与全量 SQLite 同时跑）。RFC-466 用例 9 / 9 通过。49 个文件失败：46 个只有超时；另 3 个是上面第 1、2 处（修正前的版本）与 MCP 测试台
  `rfc238-mcp-runtime-test-service`（6 例：3 例撞默认 5 秒、2 例用例自带的轮询等待到点、1 例读到中间态 `ending`）。
  - 复跑 77 个文件（最终候选；49 个失败文件加 lane 里 28 个后续修正波及的文件；30 秒时限，接在 SQLite 复跑之后）：76 个全过（含修正后的 `rfc294-architecture-preflight`、W58、RFC-466 用例与 MCP 测试台那个文件），合计 1507 pass / 3 fail，余下
    `lifecycle-property` 的 PostgreSQL 一侧 3 例撞用例自带的 15 秒（同文件 SQLite 一侧 3 例全过；复跑期间负载一度升到 66）。对照：同一
    时刻在 RFC-465 的导出仓库里跑同一文件（负载 25），两边都是 3 pass / 3 fail、同样 3 例撞 15 秒。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，第一版候选，两引擎分开跑）：SQLite 17 个阶段全部符合预期
  （0 failures）；PostgreSQL 等负载降到 23.4 / 38.5 才放行，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件的哈希
  一致、导出仓库工作树干净。三处修正改到的文件都不在 P0 的受保护文件之内。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，加 RFC-466
  用例）：12 个文件全过，合计 100 pass / 0 fail（负载 24～26；`rfc376-report` 16 / 16，75.8 s）
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c465 → c466 最终候选）：`R1-inbound-module-internals`
  96 → 86、`R2-outbound-module-to-legacy` 0 → 0（账本与实测相等）；`export-star-barrels` 6 → 5、`legacy-thin-facades` 6 → 5、
  `legacy-service-implementations` 70 → 69、`legacy-horizontal-files` 196 → 194、不可达生产文件 26 → 24（`legacyCallClosure` 与
  `services/workgroups.ts`）、`services/` 的 TS 文件 75 → 73、后端生产文件 3193 → 3190；public surface 1501 → 1496（新转出
  `isVisibleToAudienceSnapshot`，收回 intent `public/operations.ts` 的五个与 `callEdgeKey`）、偏差 94 不变，未被消费的 public 符号
  323 → 322；跨 context import 记录 7953 → 7886、模块符号归属 32279 → 32269、facade 记录 76 → 74、写入口清单 2353 → 2351（facade 的
  `updateResourceAcl` 别名与迁出的完整启动门）；跨 context 内部文件对 47、off-DAG offered 文件对 55、`module-layer-violations` 1、
  off-DAG 值边 0、平台 → 模块 0 不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（TypeScript AST 取顶层声明，`83e179801` 对工作树）：迁出的两段代码逐字未变（`legacyCallClosure` 的全部顶层声明与
  `assertWorkflowLaunchable` / `LaunchableWorkflow`，6 个声明 0 差异，只有 import 行改取定义处）；改动的 12 个生产文件里 227 个顶层声明逐字
  未变，12 处差异都是预期的：评审写路径的 `assertActingMember` 改取参数里的任务角色端口（`assertDecisionAdmissible` 把端口传进去）、
  `AgentLaunchResourceOperations` 新增 `canViewWorkflow` 与它的行形状、实现转交原来那一个 `canViewResource(db, actor, 'workflow', …)`、
  路由 / 同步依赖与预览 / 前置门两个函数的依赖各加 `canViewWorkflow` 并把两处判定改为调它、`providerRuntime` 装配它并登记进
  `ProviderRouteOperationsAssembled`。删去的声明只有两处：intent 的 `canAuditIntentSessions` 迁入 `domain/sessionAudit.ts`（说明与函数体逐字
  相同，入参换成等价的结构类型）、resource-catalog `resourceDefaults.ts` 里无人引用的同名副本；删除的 intent `public/operations.ts` 余下四个
  类型转出在 src / 用例 / 脚本里没有 importer。
- 行为：可见性判定逐字同一条——同一个 `canViewResource`、同一个库句柄（bootstrap 用同一个 `db` 装配启动资源与 provider runtime）；任务角色
  端口由 resource-catalog 以同一个 `resolveTaskRole` 实现；integration / knowledge-evolution 取到的是同一个函数对象（RFC-466 用例断言）。
  迁入用例树的两段代码只被用例调用（无生产调用方，`legacyCallClosure` 生产不可达）。
- 账本：`R1` 96 → 86（实测，与账本逐条相等，`R2` 0）；public surface 偏差实测 94 不变、capability 归属清单 18 条逐条相等；public surface
  1501 → 1496（新转出 1 个、收回 6 个）、未被消费的 public 符号 323 → 322；commons-manifest 的 `resourceacl-ts` 内核改指 resource-catalog
  的四个文件；guard-manifest 刷新改到的守卫文件行数。

## CI（AC-4）

- `b29152824`：exact SHA 主 CI run 42401552131 首轮全绿（70 个 job），windows-platform run 42401552097 通过。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 6 个 Done 文档文件，含 `docs/dev-gotchas.md` 的三条经验）的导出仓库上重跑上述文档用例：12 个文件全过，合计 100 pass / 0 fail（负载 14～18），读文档的两个用例在最终文本上复跑通过。

## PR / 提交

单个提交：`refactor(backend): RFC-466 退役 resourceAcl 与 workgroups 兼容 facade（RFC-294 W9-D 第十三步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
