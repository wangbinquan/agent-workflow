# RFC-474 入口适配器经 bootstrap 装配：CLI 命令、路由挂载与首启示例不再直取模块内部（RFC-294 W9-D 第二十一步）

- **状态**：In Progress（2026-11-08）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 业务实现按 owner 归位、越界边收口）
- **前序**：[RFC-427](../RFC-427-entry-root-command-assembly/proposal.md)（命令依赖在 `bootstrap/commandBootstraps.ts` 装配，入口只解析参数、
  选部署、分派）；[RFC-393](../RFC-393-cli-bootstrap-separation/proposal.md)（`cli/` 与 `bootstrap/` 互不 import）；RFC-439 / RFC-384（模块
  inbound 路由经本模块 composition 交给应用根挂载）；[RFC-370](../RFC-370-crewstation-hosted-deployment/proposal.md)（config CLI 的 selected 存储、
  首启示例的安装完成标记、Doctor 诊断族迁入 system-operations，留下待「bootstrap 注入」收口的兼容边）；RFC-353 T8 / T9（fusion 与技能来源
  追溯路由迁入 knowledge-evolution inbound）。
- **落位**：bootstrap（`bootstrap/commandBootstraps.ts`、`bootstrap/daemonApplication.ts`）组装并注入；knowledge-evolution 新增
  `composition/routes.ts`、development-automation 新增 `composition/migrationReport.ts`（都只交付既有实现）；system-operations 的 Doctor
  composition 多交付一个既有的格式化函数；code-capability 新增 `public/types.ts`（转出既有的示例参与方类型）；`cli/doctor.ts` 删除。

## 1. 背景

`R1`（非模块文件取模块内部）余 49 条，其中 11 条出在五个入口适配器上。账本里写的退役条件都是「由 bootstrap 注入、经 owner 的 composition
或 public 合同收口，不加目录或 bootstrap 豁免」：

1. **路由挂载**：应用根 `server.ts` 直取 knowledge-evolution 的两个 inbound 路由挂载 `mountFusionRoutes` / `mountSkillProvenanceRoutes`
   （2 条）。应用根只能取模块的 public 与 composition；其余模块的 inbound 路由（如 code-capability、intent、event-center）都经各自
   composition 交给 `server.ts`，knowledge-evolution 是唯一剩下的。
2. **`config get|set`**：`cli/config-cli.ts` 取 system-operations `composition/cliConfiguration` 的文件配置存储与端口类型（2 条）。`main.ts`
   只走「未传存储就自己组装文件存储」的默认路径；RFC-370 A1 加的「传入 selected 存储」重载只有用例在调。
3. **`doctor`**：`cli/doctor.ts`（22 行）是 RFC-370 把 Doctor 诊断族迁进 system-operations 后留下的兼容转出——转出 `domain/doctorDiagnostics`
   的三个类型与五个判定 / 格式化函数、`infrastructure/local/doctorDiagnostics` 的七个原生检查（3 条）。生产上只有 `main.ts` 取其中的
   `formatDoctor`（doctor 本身由 bootstrap 的 `runDoctorDiagnostics()` 组装运行），其余 11 个消费方都是用例。
4. **`migration-report`**：`cli/migrationReport.ts` 直调 development-automation 的 `application/migrationAnalyzer`（分析与人读渲染）和
   `infrastructure/migrationAssets`（读 legacy 行）（2 条）。
5. **首启示例**：`services/demoSeed.ts` 取 code-capability `composition/demoSeed` 的参与方类型，并调 system-operations
   `composition/installationSeedCompletion` 自己选单机完成标记（2 条）。唯一生产调用方是 bootstrap 的 `daemonApplication.ts`（启动步骤
   `demo-seed`），另两个参与方它已经从 owner composition 装好传进来。

## 2. 目标

- **G1 路由挂载**：knowledge-evolution 新增 `composition/routes.ts` 转出两个路由挂载（与 code-capability RFC-439 的 `composition/routes.ts`
  同形），`server.ts` 改取它。
- **G2 config**：bootstrap 组装文件配置存储，`main.ts` 交给 `configGetCommand` / `configSetCommand`；CLI 处理器只收注入的存储（所需的形状
  在 CLI 里按结构写明），不再自己组装、不再取 system-operations。
- **G3 doctor**：`cli/doctor.ts` 删除。bootstrap 的 doctor 入口一并交出检查结果与要打印的报告；`formatDoctor` 经 system-operations 的 Doctor
  composition 交给 bootstrap；11 个用例改取定义处。
- **G4 migration-report**：development-automation 新增 `composition/migrationReport.ts`，在所给客户端上组装「读 legacy 行 → 分析 → 人读渲染」；
  bootstrap 把它与 schema 合同一起交给 CLI 处理器。CLI 仍自己解析 provider、开关运行时（RFC-349 / RFC-395 AF-D10 锁住的形状）。
- **G5 首启示例**：完成标记由 bootstrap 在启动步骤里组装后传入（`completion` 必填）；code-capability 的示例参与方类型经新增的
  `public/types.ts` 取（RFC-453 已退役并锁住该模块的 `public/participants.ts`）。
- **G6 账本**：`R1` 49 → 38（按实测销账）。public surface 只增 code-capability 的两个类型（都有消费方）；public surface 偏差、未被消费的
  public 符号、跨 context 内部文件对、off-DAG、`composition-forbidden-import-files`、`module-layer-violations` 不升。

## 3. 非目标

- 五个入口之外的 `R1`：`services/task.ts`（9）、`services/systemAgentRun.ts`（5）、`services/commitPushRunner.ts`（4）、运行时驱动一族（9）、
  `services/runtimeSmoke.ts`（4）、`services/nodeRollback.ts`（3）、`services/reviewMutationCoordinator.ts`（2）、`services/taskDelete.ts`（2）。
- `services/demoSeed.ts` 的归属：示例编排横跨 resource-catalog 与 code-capability，system-operations 到两者都不是 offered 边。本 RFC 只收它
  的两条越界边，文件留在 `services/`。
- knowledge-evolution `inbound/fusionRoutes` 取 task-execution `inbound/directTaskInitiator` 的那条 `module-layer-violations`。
- 命令与启动行为：输出、退出码、错误文本、provider 解析、doctor 检查项与示例内容逐字不变。

## 4. 用户可见变化

无（命令输出、退出码与错误文本不变）。

## 5. 验收标准

- **AC-1**：五个入口文件不再取模块内部（`R1` 里没有它们）；`cli/doctor.ts` 不在、零引用（import、路径字面量、workflow 路径过滤、Markdown 链接）。
- **AC-2**：行为不变——两个路由与原挂载是同一个函数；`config get|set` 的输出与错误同原（文件存储改由 bootstrap 注入）；doctor 打印同一份
  报告、同一退出码；`migration-report` 两种输出同原、未安装库时的拒绝报文不变；首启示例的完成标记仍在每次启动调用时选（单机文件标记）。
- **AC-3**：架构计数按实测（`R1` 49 → 38），账本逐条相等；偏差、未被消费的 public 符号与越界类计数不升。
- **AC-4**：受影响用例与新增 RFC-474 用例全部通过；四个包的用例都跑。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **doctor 的报告经 system-operations composition 交给 bootstrap，不开进 public**：`formatDoctor` 的签名带 `DoctorResult` 一族类型，开进
   public 要连带转出它们；doctor 本就由 bootstrap 组装运行（RFC-427），报告文本跟结果由同一个入口交出最短。
2. **单机 `config get|set` 改走与 selected 同一条异步路径**：RFC-370 为了不改动当时的默认命令留下同步重载；默认存储改由 bootstrap 注入后，
   处理器只收注入的存储。`main.ts` 本就 `await`，`main()` 的错误出口把同步抛出与拒绝一样处理，输出与退出码不变；保留同步形状要按存储的
   返回值分叉，没有用户可见的收益。
3. **migration-report 的 provider 解析留在 CLI**：RFC-349 / RFC-395 AF-D10 锁住「CLI 报告自己解析 provider、未安装时拒绝且不建库」，本 RFC
   只把 development-automation 的分析换成注入。
4. **首启示例的完成标记必填**：唯一生产调用方是 bootstrap；「可选参数 + 内部默认」正是那条越界边。
5. **knowledge-evolution 路由经 composition 转出**（与 RFC-439 同形），不登记 bootstrap 例外，也不改 census 规则。
