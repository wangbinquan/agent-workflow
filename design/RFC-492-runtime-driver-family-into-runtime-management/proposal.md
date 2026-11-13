# RFC-492 运行时驱动一族整族迁入 runtime-management infrastructure（RFC-294 §4.7 运行时驱动一族第五步）

- **状态**：Done（2026-11-13，落地 `1e732c7cc`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.7（运行时驱动一族归 runtime-management
  infrastructure；先把经 `services/` 取驱动的其他 context 换成 runtime-management 的端口或装配，再整族迁入）与 design §3.1（context DAG、
  bootstrap 唯一装配）、§9.2（适配器落 `modules/<context>/infrastructure/`）。
- **前序**：[RFC-487](../RFC-487-runtime-family-forbidden-consumers/proposal.md)、[RFC-488](../RFC-488-local-mcp-diagnostic-execution-port/proposal.md)、
  [RFC-489](../RFC-489-run-family-providers-bound-by-bootstrap/proposal.md)、[RFC-491](../RFC-491-te-runtime-family-decoupling/proposal.md)
  （Done）——一族之外只剩 runtime-management 与 bootstrap 用它。

## 1. 背景

运行时驱动一族是 `services/` 里最大的一块遗留：`services/runtime/**`（36 个文件，含 opencode 插件的 `.mjs`）、
`services/execution/{agentInjection,workspaceBoundary,taskExecutionResourceDependencies}.ts` 与 `services/driverLease.ts`，共 40 个，占
legacy 服务实现 46 个里的 40 个。RFC-487～RFC-491 之后：

- 一族之外 import 它的生产文件只剩 runtime-management 的 16 个（材料、探测、注册表、静态事实、启动清单读取等）与 bootstrap 的 2 个
  （启动自检；交给 resource-catalog 的资源策略束）。
- 一族自己只取 shared、`util/`、`platform/persistence`、`embed.generated`、runtime-management 自己（public、application、infrastructure）与
  resource-catalog 的 `public/`；runtime-management → resource-catalog 在目标 DAG 上。整族迁入不新增任何跨 context 的边。

另有两个文件名义上在一族里、实际不是运行时驱动：

- `services/execution/taskExecutionResourceDependencies.ts`：bootstrap 交给 resource-catalog 任务执行绑定的策略束（运行时的托管注入同名
  冲突判定加 shared 的调用目标选择），把不同 owner 的函数拼成 consumer 的端口，是 bootstrap 的装配工作。
- `services/driverLease.ts`：RFC-108 的驱动租约兼容夹具。RFC-328 之后没有生产使用方，只有 RFC-108 的单元用例在用，架构门禁止生产代码
  import 它，也登记为不可达生产文件。

## 2. 目标

- **G1 一族迁入 `modules/runtime-management/infrastructure/drivers/`**：`services/runtime/**` 原样保留内部结构（注册表与类型、opencode 与
  claudeCode 两个驱动目录、插件），`agentInjection.ts` 与 `workspaceBoundary.ts` 同入；文件内容只改 import 路径。
- **G2 runtime-management 自己的使用方改取模块内路径**：16 个生产文件。
- **G3 bootstrap 经 composition 取**：启动自检与托管注入同名冲突判定由 runtime-management 的 `composition/runtimeDrivers.ts` 交出；资源策略
  束改由 bootstrap 组装（`bootstrap/taskExecutionResourceDependencies.ts`）。
- **G4 驱动租约夹具移出生产**：`services/driverLease.ts` 迁入 `tests/helpers/`。
- **G5 跟随的守卫与配置**：RFC-282 的按运行时围栏（eslint）、单二进制构建的插件目录、三份 workflow 的路径过滤、架构账本与各用例里的
  路径改指新位置；描述现行契约的文档（`docs/OPENCODE_CONFIG.md`、`docs/env-flags.md`）同步。
- **G6 账本与锁**：计数随之销账、收紧；新增 RFC-492 用例。

## 3. 非目标

- 驱动对象按部署形态拆分（静态声明与本机进程效果分开）、驱动内部的重构与改名。
- `services/` 余下的 6 个文件：git 一族 3 个（W5）、`codeRoundContract.ts`、`digitalEmployeeAgentTemplates.ts`、`demoSeed.ts`。
- 任何行为变化；接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/runtime/`、`services/execution/` 不再有文件，`services/driverLease.ts` 不在生产树；一族在 runtime-management 的
  `infrastructure/drivers/`；生产代码只有 runtime-management 自己的文件 import 它，bootstrap 经 runtime-management 的 composition。
- **AC-2**：同样输入下行为与此前一致：单二进制从新位置嵌入 opencode 插件，启动自检、资源策略束与托管注入同名冲突判定是同一组函数，
  按运行时围栏对别名与相对写法照旧拦截，三份 workflow 在新位置的改动上照旧触发。
- **AC-3**：legacy 服务实现 46 → 6；legacy 横向文件 165 → 125；不可达生产文件 16 → 15；`commons-debt.json` 的 inbound 边 9 → 0；跨
  context 内部文件对、越 DAG 的值边与 offered 文件对不升；public surface 不增；减速带不升、触及的收紧到实测。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（含单二进制构建与 e2e；环境性红格逐格归因、如实记录）。
