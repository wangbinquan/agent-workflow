# RFC-474 设计

**落在哪个 context、哪一层**：bootstrap（命令依赖与启动步骤的装配）；knowledge-evolution 与 development-automation 的 `composition`（只交付
既有实现给 bootstrap）；system-operations 的 Doctor composition；code-capability `public/types`（转出既有类型）。
**承担的演进**：W9-D 的一步——五个入口适配器（应用根的路由挂载、三个 CLI 命令、首启示例编排）不再直取模块内部，改由 bootstrap 组装后
注入，或经 owner 的 composition / public 取；`R1` 少 11 条，`cli/doctor.ts` 兼容转出退役。
**留下的债**：`services/demoSeed.ts` 仍在 `services/`（示例编排横跨 resource-catalog 与 code-capability，见 proposal §3）；其余 38 条 `R1`
见 proposal §3。

## 1. 路由挂载：knowledge-evolution `composition/routes.ts`

- 新增文件，只转出（与 code-capability RFC-439 的 `composition/routes.ts` 同形，`composition.ts` 仍是 RFC-395 审过的 schema-only 根）：
  `export { mountFusionRoutes } from '../inbound/fusionRoutes'`、`export { mountSkillProvenanceRoutes } from '../inbound/skillProvenanceRoutes'`。
- `server.ts` 的两个 import 改取 `@/modules/knowledge-evolution/composition/routes`；`Parameters<typeof mountFusionRoutes>[1]` 等类型用法不动。
- 纯转出不碰 fs / 进程 / 数据库，`composition-forbidden-import-files` 不变（code-capability 的同形文件也不在该清单里）。

## 2. `config get|set`

- `bootstrap/commandBootstraps.ts` 新增 `composeConfigCommandPersistence()`：`composeFileCliConfiguration(Paths.config)`（取
  system-operations `composition/cliConfiguration`，bootstrap 可以取 composition）。
- `main.ts` 的 `config` 分支：`await configGetCommand(rest, composeConfigCommandPersistence())` / `await configSetCommand(...)`，其余不变。
- `cli/config-cli.ts`：
  - 删掉对 system-operations 的 import 与「未传存储」的同步重载；
  - 两个处理器只收注入的存储，形状在 CLI 里按结构写明（`ConfigCommandReader { load(): Config | Promise<Config> }`、
    `ConfigCommandWriter { applyPatch(patch: unknown): Config | Promise<Config> }`——system-operations 的
    `ApplicationConfigurationPersistencePort` 两者都满足）；
  - 函数体就是原 selected 路径：`formatConfigurationRead(args, await storage.load())`；先 `parseConfigurationWrite(args)` 再
    `await storage.applyPatch({ [key]: parsedValue })`、`formatConfigurationWrite(key, updated)`。读写仍以存储本身为 `this` 调用。
- 行为：输出与错误文本不变；原默认路径的同步抛出变为拒绝，`main()` 的 `.catch` 对两者同样打印 `message`、退出 1。

## 3. `doctor`

- system-operations `composition/doctorDiagnostics.ts` 多转出 `formatDoctor`（`domain/doctorDiagnostics` 的那一个，同一函数）。
- `bootstrap/commandBootstraps.ts`：`runDoctorDiagnostics()` 改为 `runDoctorCommand()`——同样组装 `composeDoctorApplication(...)` 并 `run()`，
  返回 `{ ok: result.ok, output: formatDoctor(result) }`。
- `main.ts` 的 `doctor` 分支：`const { ok, output } = await runDoctorCommand()`，写 `output`，`!ok` 时退出 1（与原 `formatDoctor(result)` /
  `result.ok` 同值）。
- `cli/doctor.ts` 删除；11 个用例改取定义处：判定与格式化（`evaluate*`、`formatDoctor`、类型）取 `domain/doctorDiagnostics`，原生检查（`check*`）
  取 `infrastructure/local/doctorDiagnostics`。`rfc370-doctor-diagnostic-family` 的「兼容转出与定义处是同一个值」一例，改为锁 Doctor composition
  转出的 `formatDoctor` 与 domain 的是同一个值（兼容转出已不存在）。

## 4. `migration-report`

- development-automation 新增 `composition/migrationReport.ts`：`composeLegacyAssetMigrationReport(db: PersistenceDb)` 返回
  `{ analyze(now), render }`——`analyze` 是 `analyzeLegacyAssets(await collectLegacyAssets(db), now)`，`render` 就是 `printMigrationReport`。
  只读、不落库（与原 CLI 相同）。
- `bootstrap/commandBootstraps.ts` 新增 `composeMigrationReportCommandDependencies()`：`{ contract: logicalSchemaContract, analysis:
composeLegacyAssetMigrationReport }`。
- `cli/migrationReport.ts`：签名改为 `migrationReportCommand(args, deps)`，`deps` 的形状在 CLI 里写明（`contract` 与
  `analysis(db) => { analyze(now): Promise<R>; render(report: R): string }`，`R` 由传入值推出）。provider 解析、两处「未安装」拒绝、开客户端
  与 `finally` 里关运行时逐字不变（RFC-349 / RFC-395 AF-D10 锁住的形状），只把「collect → analyze → print」换成 `deps.analysis(db)`；
  `--json` 仍原样 `JSON.stringify(report, null, 2)`。
- `main.ts`：`migrationReportCommand(Bun.argv.slice(3), composeMigrationReportCommandDependencies())`。
- 用例 `rfc395-af1-cli-selection` 改传 bootstrap 组装的依赖。

## 5. 首启示例

- code-capability 新增 `public/types.ts`（不用 `public/participants.ts`：RFC-453 把该路径连同它装的代码评审产物参与方一起迁去
  workspace-insight，并锁住它不复活）：转出 `application/demoSeed` 的 `CodeCapabilityDemoSeedParticipant` 与它返回的
  `CodeCapabilityDemoSeedReceipt`（两个闭合的结构类型，public surface 偏差不变）。
- `services/demoSeed.ts`：参与方类型改取 code-capability `public/types`；不再 import system-operations composition；
  `DemoSeedParticipants.completion` 改为必填，`seedDemoContent` 把它直接交给原 `offerDemoContent`（函数体不动）。
- `bootstrap/daemonApplication.ts` 的 `demo-seed` 启动步骤：在步骤里调 `composeInstallationSeedCompletion()`（单机文件标记，仍是每次启动
  调用时选，不在模块加载时选）作为 `completion` 传入。
- 用例 `rfc307-demo-seed` 的 `seed()` 同样在调用时组装完成标记；其余三个用例本就自带 `completion`。

## 6. 用例、账本与清单

- **改 import / 调用**：§2–§5 列出的用例（`cli`、`rfc370-cli-configuration-bindings`、11 个 doctor 用例、`rfc395-af1-cli-selection`、
  `rfc307-demo-seed`）。`rfc370-cli-configuration-bindings` 的「单机命令保持同步」一例改为「bootstrap 组装的文件存储经同一处理器读写、错误
  以拒绝给出」。断言的输出与错误文本不变。
- **账本**：`architecture/commons-debt.json` 销 11 条 `R1`，基线 49 → 38；`tests/architecture/architectureReport.ts` 的 owner 表删 `cli/doctor.ts`
  一条；`architecture/guard-manifest.json` 刷新改到的登记守卫文件行数。
- **workflow**：`windows-platform.yml` 两份路径过滤里的 `cli/doctor.ts` 换成 doctor 命令的新装配处 `bootstrap/commandBootstraps.ts`。

## 7. 失败模式

- 漏改某个 `cli/doctor` 消费方 → tsc 报错；路径字面量与 workflow 过滤由 RFC-474 用例锁。
- bootstrap 忘了注入 → 类型上 `configGetCommand` / `migrationReportCommand` 的依赖与 `completion` 都是必填，tsc 报错。
- 完成标记在模块加载时选 → 测试 home 与启动时的 home 不一致；RFC-474 用例锁 `composeInstallationSeedCompletion()` 在启动步骤体内调用。
- 新 composition 文件取了 fs / 数据库 → `composition-forbidden-import-files` 计数升；计数复核与 `rfc376` 守卫报出。

## 8. 测试策略

新增 `tests/rfc474-entry-adapter-bootstrap-assembly.test.ts`：

1. `cli/doctor.ts` 不在；backend 的 src / 用例 / 脚本零 import 它（`preProcessFile`，带负对照）；四个包、e2e、仓根脚本与 `.github/workflows`
   里没有指着它的路径字面量（注释不算，带负对照）；`design/` 与 `docs/` 的 Markdown 相对链接不指着它（带负对照）。
2. census 的 `R1` 里没有五个入口文件的边；负对照：同一规则把 `cli/` 文件取 system-operations composition 的合成样例判为 `R1`。
3. 路由：knowledge-evolution `composition/routes` 的导出名恰为两个、与 inbound 的是同一函数；`server.ts` 从它取。
4. 入口装配：`main.ts` 把 `composeConfigCommandPersistence()`、`composeMigrationReportCommandDependencies()` 交给两个处理器，doctor 分支取
   `runDoctorCommand()`；三个 CLI 文件不取任何 `@/modules/`；Doctor composition 转出的 `formatDoctor` 与 domain 的是同一函数；
   development-automation 的 `render` 就是 `printMigrationReport`。
5. 首启示例：`services/demoSeed.ts` 不取任何 composition；code-capability `public/types` 的导出名恰为两个类型（`public/participants.ts` 仍不在）；`daemonApplication` 的
   `demo-seed` 步骤体内调 `composeInstallationSeedCompletion()` 并作为 `completion` 传入。
6. `windows-platform.yml` 路径过滤里的每个具体文件都在。

行为由既有用例照常覆盖（都改为走注入）：`cli`（config 读写、`formatDoctor` 报告）、`rfc370-cli-configuration-bindings`（selected 与单机存储）、
doctor 族用例、`rfc395-af1-cli-selection`（报告拒绝未安装库、跟 SQLite 指针）、`rfc307-demo-seed` / `rfc370-installation-seed-completion` /
`rfc395-demo-template-only`（示例与完成标记）、`rfc349-fusion-route-provider` / `rfc353-fusion-inbound`（路由）。
集中验证按 RFC-473 的做法：导出仓库里全量 SQLite、改动闭包的 30 秒复跑与 PostgreSQL lane、P0、shared / frontend / system-mocks、文档用例与计数复核。
