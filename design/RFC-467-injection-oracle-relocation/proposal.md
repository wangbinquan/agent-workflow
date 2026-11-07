# RFC-467 注入预言一族迁入用例树、资源快照策略束只留外部策略（RFC-294 W9-D 第十四步）

- **状态**：In Progress（2026-11-07）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（facade 清仓：consumer 归零后删除）
- **前序**：[RFC-466](../RFC-466-resource-acl-and-workgroups-facade-retirement/proposal.md)（同一做法：只剩用例在用的生产代码原样迁入
  `tests/helpers/`）；[RFC-349](../RFC-349-postgresql-provider-one-click-migration/proposal.md)（把旧注入解析器留作行为预言）。
- **落位**：`packages/backend/tests/helpers/`；resource-catalog `infrastructure/aggregateAdapters/taskExecutionResourceSnapshots.ts`；
  `services/execution/taskExecutionResourceDependencies.ts`。

## 1. 背景

架构报告的不可达生产文件 24 个里有 6 个是同一族：task-execution `infrastructure/legacyTaskExecutionInjectionResolver.ts`（341 行，RFC-349
留下的注入解析行为预言，生产入口不可达）与只有它在 src 里 import 的五个 `services/` 文件——`agentDeps.ts`（173 行）、`mcpClosure.ts`
（76 行）、`pluginClosure.ts`（77 行）三个实现，以及 `skillBootVerify.ts`、`skillIdentityPaths.ts` 两个各 3 行的 `export *` facade（转出
resource-catalog `infrastructure/legacy/` 的定义，各记 1 条 `R1`）。

同一个预言还拖着一份「策略束」：`services/execution/taskExecutionResourceDependencies.ts` 由 bootstrap 注入 resource-catalog 的任务执行资源
快照适配器，记 5 条 `R1`。生产只读其中 6 个字段；`rowToAgent` / `rowToMcp` / `rowToPlugin` / `skillFilesRel` 四个只给预言用，而
`assertNotBuiltin`、`isSkillInjectableThisBoot` 本来就是 resource-catalog 自己的函数，绕到 `services/` 再注入回来。文件头写着这份束「只剩
真正来自外部的策略」，现状并非如此。

## 2. 目标

- **G1 预言一族离开生产树**：预言与 `agentDeps` / `mcpClosure` / `pluginClosure` 原样迁入 `tests/helpers/`（行为与断言不变，import 改取
  helper 与 resource-catalog 定义处）；`services/skillBootVerify.ts`、`services/skillIdentityPaths.ts` 删除，用例改取定义处。
- **G2 策略束只留外部策略**：束里只剩 runtime 的托管注入同名冲突两个函数、执行层的插件禁用错误码与 shared 的 `pickCallTarget`；
  resource-catalog 的适配器直接取自己的 `assertNotBuiltin`（domain）与 `isSkillInjectableThisBoot`（legacy），端口去掉这两个字段与从未被读的
  `skillFilesRel`。
- **G4 失去模块外读者的 public 符号当场收回**（RFC-294 design §3.3）：resource-catalog `public/queries` 的 `validateAgentDependencies`
  唯一的模块外读者是 `services/agentDeps`，随预言迁走后退出 public；resource-catalog 自己的 agent 应用本来就直接取定义处。
- **G3 账本下降**：`R1` 86 → 79；不可达生产文件 24 → 18；`services/` 73 → 68；`legacy-thin-facades`、`export-star-barrels`、
  `legacy-service-implementations`、`legacy-horizontal-files` 按实测下降；不新增目标 DAG 之外的边、跨 context 内部文件对、off-DAG offered
  文件对与 `module-layer-violations`；public surface 偏差与未被消费的 public 符号不升。

## 3. 非目标

- 预言本身是否退役（它们的覆盖是否已由活实现的用例承担，要逐条核对，留给后继 RFC）。
- integration 触发器资源快照适配器里同样注入的 `assertNotBuiltin`（另一份束，随 integration 的后继 RFC）。
- `services/execution/taskExecutionResourceDependencies.ts` 本身的去处（它余下的依赖都在 `services/` 与 shared，随执行层归位）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：六个文件不在 src；src / 用例 / 脚本零 import 两个 facade 与三个迁出的 `services/` 文件；预言与三个实现在 `tests/helpers/`；策略束与
  resource-catalog 端口只剩四个外部策略字段，适配器直接取 resource-catalog 自己的两个函数；`validateAgentDependencies` 不在
  resource-catalog public（G4）。
- **AC-2**：架构计数按实测（`R1` 86 → 79，账本逐条相等）；越界类计数、public surface 偏差与未被消费的 public 符号不升。
- **AC-3**：受影响用例（注入解析与依赖闭包、MCP / 插件闭包、技能启动校验、任务执行资源快照、启动与执行宿主）与新增 RFC-467 用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **迁入 `tests/helpers/`，不删**：与 RFC-466 迁调用闭包预言同理——预言是 RFC-349 有意保留的对拍基准，三个实现只剩它与它们自己的聚焦用例在用；
   挪进用例树后断言与覆盖逐字不变，生产树只剩可达代码。是否退役留给后继 RFC。
2. **resource-catalog 的适配器直接取自己的函数**：两个函数与适配器同属一个 bounded context，经 `services/` 注入只是 RFC-345 收 facade 时留下的
   绕行；没有用例注入替身（全仓核过），改为直接 import 后行为逐字相同。
3. **不推翻 RFC-375 §3 留给用户的决定**：RFC-375 §3 把「是否推翻『注入行为 oracle 七件套退役前作为 oracle 保留』」留给用户另行决定
   （RFC-376 结构守卫据此把这六个文件登记为 `RFC-375 section 4: user decision after RFC-349/RFC-359` 的保留组）。本 RFC 不退役它们：预言与
   三个实现原样保留、继续作为对拍基准，用例与断言不变，只是从生产树挪进用例树；两个技能转出只是转发定义处，删除不改变任何行为。是否退役仍由
   用户决定（可推翻：原样挪回 `src/` 即恢复）。
