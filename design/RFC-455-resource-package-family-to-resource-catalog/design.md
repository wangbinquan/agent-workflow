# RFC-455 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`RC/` = `S/modules/resource-catalog/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 只剩到期删除的一跳 facade——实现文件按 owner 归位。本 RFC 承担 resource-catalog 独占的资源包一族
  （RFC-345 T6 未收口的「parse / inspect / preview / apply / receipt / export 组织到 `resource-catalog/application/package`」）。
- 层：算法层进 `application/package`（经 `ports.ts` 的读端口取数据，不取 infrastructure）；被 application 与 infrastructure 共用的纯件
  进 `domain`；只被 bootstrap 用的两个装配绑定进 `composition`。
- 不新增目标 DAG 之外的边：一族只取 shared、`util`、`auth` 的类型、本模块与 identity-access 的 public 类型（`application/package/ports.ts`
  已有同样的 `CommandContext` 类型取用，不在 off-DAG 清单里）；intent 取修订摘要走 resource-catalog `public/queries`（intent →
  resource-catalog 是给出的边）。
- 不新增 public surface 偏差：`public/queries` 只新增 `mcpOperationConfigHashOf(mcp: Mcp): string` 与
  `pluginOperationConfigHashOf(plugin: Plugin): string`（shared 类型）。

## 1. 文件去向

| 原位置                                                                                                                       | 新位置                                             | 说明                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `L/bundle/provider.ts`                                                                                                       | `RC/domain/bundlePlan.ts`                          | 依赖规划与回执合同（纯）；原子应用（infrastructure）与算法层都用                                                                       |
| `L/mcpOperationRevision.ts`                                                                                                  | `RC/domain/mcpOperationRevision.ts`                | MCP 操作修订摘要（`node:crypto` + shared）                                                                                             |
| `L/pluginOperationRevision.ts`                                                                                               | `RC/domain/pluginOperationRevision.ts`             | 插件操作修订摘要                                                                                                                       |
| `L/resourcePackage/{closure,commit,export,importPermissions,parse,preview,requirements,secretInputs,serialize,skillTree}.ts` | `RC/application/package/` 同名                     | 算法层，函数体原样                                                                                                                     |
| `L/resourcePackage/providerReadPort.ts`                                                                                      | `RC/application/package/packageDocument.ts`        | 只留 `resourcePackageDocumentOf`；两个端口类型与 `ports.ts` 的同名合同逐字段相同，迁入后只留 ports 那一份                              |
| `L/resourcePackage/executionAdapter.ts`                                                                                      | `RC/composition/resourcePackageExecution.ts`       | `createPostgresqlResourcePackageExecutionAdapter`；bootstrap 改取                                                                      |
| `L/resourcePackage/pluginInstallerAdapter.ts`                                                                                | `RC/composition/resourcePackagePluginInstaller.ts` | 包着 `RC/infrastructure/local/filePluginInstallation` 的安装绑定；bootstrap 改取                                                       |
| `RC/infrastructure/legacy/skill-zip.ts` 的 decode 段                                                                         | `RC/domain/zipArchive.ts`                          | `ZIP_LIMITS`、`ZipEntryRef` 等与 `decodeZip` 及其私有校验（fflate + `util/errors` + shared 的上限，纯）；skill-zip 其余部分改取 domain |

## 2. 消费方改指

- **模块内**：原子应用场景适配器（`RC/infrastructure/resourcePackageAtomicApply.ts`）改取 `application/package` 与 `domain/bundlePlan`；
  MCP 诊断（`RC/composition/crewstationMcpDiagnostics.ts`、`RC/infrastructure/local/mcpDiagnosticsEffects.ts` 的动态 import）改取
  `domain/mcpOperationRevision`；skill-zip 改取 `domain/zipArchive`；算法层里 closure / export / preview 的 `isVisibleRow` 从
  `L/resourceAcl` 转出改取 `RC/domain/resourceAccess`（声明处）。
- **跨模块**：intent `application/manifest.ts` 改取 resource-catalog `public/queries`。
- **bootstrap**：`commandBootstraps.ts`、`daemonHttpComposition.ts`、`standalone.ts` 改取 `RC/composition` 的两个文件。
- **用例**：经旧路径取的用例改取新位置（含 `rfc238-mcp-runtime-test-service` 的动态 import、按路径片段读源码的
  `rfc271-export-closure-authz` / `rfc271-capability-removal`）；`decodeZip` / `ZIP_LIMITS` 等从 skill-zip 取的用例改取 `domain/zipArchive`。

## 3. 用例

- **新用例** `T/rfc455-resource-package-family.test.ts`：16 个旧文件不存在、`S/` 与用例零引用（census AST，别名与相对路径都认，带负对照）；
  `services/resourcePackage/`、`services/bundle/` 目录不存在；`decodeZip` 只有一份定义；读端口只有 `ports.ts` 一份声明；算法层与
  domain 的新文件不取任何 `infrastructure/`、不取 `services/`；resource-catalog `public/queries` 的两个修订摘要就是 domain 那一份；
  修订摘要对同一 MCP / 插件与 shared 的 `*OperationConfigHashWith` + sha256 一致。
- **随迁的守卫表**：`T/rfc345-resource-acl-facade-retirement.test.ts` 删去三条 `isVisibleRow` 边；架构报告的 legacy 归属表删去 16 个文件；
  `rfc401-resource-write-participants` 的路径夹具、`rfc238` 与 `rfc271` 的源码读取改指新位置；guard-manifest 刷新行数。
- **账本**：`commons-debt.json` 的 `R1`（`parse.ts → legacy/skill-zip`、`pluginInstallerAdapter.ts → local/filePluginInstallation`）与 `R2`
  （原子应用、MCP 诊断、intent 清单取这一族）按实测销账；finding 的证据锚保留原路径（历史记录）。
- 文档：`docs/resource-bundles.md`、`docs/audit-backlog.md` 里描述现状的路径改指新位置，带日期的历史记录不动。

## 4. 留下的债

- application/package 里与 `ports.ts` 结构相近但不完全相同的合同类型（`ImportDecision` / `HumanMemberMapping` / `PackageSecretInput` 等）
  两套并存：执行适配器在 composition 里做结构转换，合并随 RFC-294 S7「资源写入栈合一」。
- `services/resourceAcl.ts`（RFC-345 T9 兼容转出）还有 task-execution、knowledge-evolution、integration、collaboration 与 `services/` 的
  消费方，不在本 RFC。

## 5. 失败模式

- 漏改的消费方：tsc 兜底（旧文件删除后取不到）；用例经新用例的零引用断言兜底；按路径片段读源码的锁按 RFC-454 的 dev-gotchas 条目全仓
  搜文件名本身。
- 删光目录：`services/resourcePackage/`、`services/bundle/` 会变空——导出仓库同步脚本已会删掉变空的目录（RFC-454 实撞）；搜用例里
  `readdirSync` 扫这两个目录的写法。
- 新增越界：`module-layer-violations`（application / domain 取 infrastructure）、off-DAG、跨 context 内部文件对与 public surface 偏差的
  精确清单兜底。

## 6. 测试策略

迁移所涉用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
