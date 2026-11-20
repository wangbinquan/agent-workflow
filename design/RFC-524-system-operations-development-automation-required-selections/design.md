# RFC-524 设计：系统运维与开发自动化的适配器回落改为必填注入

## 1. 现状（HEAD，源码实读）

RFC-521 门登记的 16 处（路径在 `packages/backend/src/modules/` 下）：

| #      | 位置                                                                                            | 回落                                                                                                                     | 生产调用方                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | `system-operations/composition.ts` `prepareDatabasePreOpenRecovery`                             | 不给 `recovery` → 本机文件的打开前恢复                                                                                   | 没有（只有 `rfc370-database-pre-open-recovery` 调用；`rfc394-start-sequence` 对它的 spy 没有被调用的路径）                                  |
| 2、3   | 同上 `composeLocalSystemOperations`                                                             | 不给 `databaseConfig` → 读 `Paths.config`；不给 `providerRuntime` → `resolveDatabaseProviderRuntimeForRestore`           | `backup` / `restore` 命令根都给 provider 运行期、都不给配置——配置一直由回落读                                                               |
| 4      | `system-operations/composition/daemonDatabase.ts` `prepareDaemonDatabaseProviderForBoot`        | 不给 `installation` → 本机文件准备                                                                                       | daemon 把部署选择的 `databaseInstallation`（单机为 `null`）写成 `=== null ? undefined :` 再交入                                             |
| 5、6   | `system-operations/composition/daemonHostLifecycle.ts` 的两个 `select*`                         | 不给宿主 → 本机宿主生命周期；不给运行期查询 → 读 daemon 信息文件                                                         | daemon 启动给开发叠加层的宿主或 `undefined`，开发重载总给 `undefined`；运行期查询生产路径总给（应用与 HTTP 装配的入参里可选，只有用例不给） |
| 7      | `system-operations/composition/databaseMigration.ts` `composeDatabaseMigrationModule`           | 不给 `configuration` → `configPath ?? Paths.config` 的本机配置文件                                                       | daemon 会话给 `configPath: Paths.config`；CLI 的 `composeLocalDatabaseMigrationOperations` 都不给                                           |
| 8      | `system-operations/composition/installationSeedCompletion.ts`                                   | 不给 → `Paths.demoSeedMarker` 的本机标记                                                                                 | 唯一的调用（daemon 应用的演示种子）不给参数                                                                                                 |
| 9      | `system-operations/composition/manualDatabaseMigration.ts` `prepareManualDatabaseMigration`     | `options` 缺省为 `{ kind: 'file' }`，`file` 一支不给 `configuration` → 本机配置文件                                      | `migrate` 命令不给选项时走缺省；托管入口给 `selected`                                                                                       |
| 10、11 | `development-automation/composition.ts` `composeDevelopmentAutomation`                          | 不给 `evidenceArtifacts` → `new EvidenceStore(<appHome>/evidence)`；不给 `admissionLookup` → `createAdmissionLookup(db)` | daemon 都给                                                                                                                                 |
| 12     | `development-automation/composition/evidenceStaging.ts` `composeRequirementMaterializerContent` | 不给 `documentCommands` → 本机文件写入器（同一函数里不给 `staging` → 本机暂存，门没有单独登记）                          | daemon 给部署选择的暂存与写入器（`RequirementPurposeSelection` 里两者必填）                                                                 |
| 13     | `development-automation/composition/developmentDelivery.ts` `composeDevelopmentPipelineDeps`    | 不给暂存 → 旧版本机流水线证据桥（`infrastructure/local/legacyPipelineEvidence.ts`）                                      | 生产调用都给暂存；没有用例调用单参数形态                                                                                                    |
| 14     | `development-automation/composition/digitalEmployeePlatformWorkItems.ts`                        | 不给 `evidenceArtifacts` → 首次使用时在所选工作区效果的根目录下建 `EvidenceStore`                                        | daemon 给                                                                                                                                   |
| 15、16 | `development-automation/composition/missionInputUploads.ts`                                     | `blobs ?? artifacts ?? lazyEvidenceBlobs(appHome)`（首次上传时建 `EvidenceStore`）                                       | daemon 给 `artifacts`；没有用例调用它（只有读原文的锁）                                                                                     |

`EvidenceStore` 的构造会建 `blobs/` 与 `bundles/` 目录，所以“装配时建”与“首次使用时建”要分开保留。`@/config` 的 `loadConfig` 就是本机配置
文件实现用的同一个函数（`createFileDatabaseConfiguration(path).read` 即 `loadConfig(path).database`）。

## 2. 机制与落位

### D1 system-operations：命令与迁移入口

- **`composeLocalSystemOperations`**：`databaseConfig` 与 `providerRuntime` 必填。`backup` 命令根在原来读配置的位置（`try` 里、取到 provider 之
  后）读 `loadConfig(Paths.config).database` 交入；`restore` 命令根本来就先读一次配置去解析 provider，把同一次读到的配置一并交入（此前组合层里
  对同一个文件再读一次）。
- **`composeDatabaseMigrationModule`**：`configuration` 必填，删去 `configPath` 一支；`composition/databaseMigration.ts` 转出本机配置文件的实现
  `createFileDatabaseConfiguration`。daemon 会话给 `createFileDatabaseConfiguration(Paths.config)`；CLI 的 `composeLocalDatabaseMigrationOperations`
  （本身就是单机装配）显式给同一个。
- **`prepareManualDatabaseMigration`**：`options` 必填，`file` 一支的 `configuration` 必填；`migrate` 命令不给选项时在调用处显式给
  `{ kind: 'file', configuration: createFileDatabaseConfiguration(Paths.config) }`（读取仍在准备里、同一时机）。
- **演示种子的完成标记**：`composeInstallationSeedCompletion(selected?)` 改为 `composeLocalInstallationSeedCompletion()`，不再收参数（唯一的生产
  调用本来就不给），每次调用时取 `Paths.demoSeedMarker`。
- **组合层的打开前恢复**：没有生产调用方，原样移到 `tests/helpers/systemOperations.ts`；`DaemonDatabasePreOpenRecoveryPort` 随之移去；
  `rfc394-start-sequence` 对它的 spy 删去（没有被调用的路径）。application 的同名用例与 `applyLocalEpoch2PendingRestore` 不变。

### D2 system-operations：daemon

- **数据库准备**：`prepareDaemonDatabaseProviderForBoot` 的入参改为按 `kind` 区分的两支——`{ kind: 'selected', configuration, installation, file }`
  与 `{ kind: 'file', configuration, file }`，各自调用与此前相同的准备；daemon 按部署选择 `databaseInstallation` 是否为 `null` 显式选一支，删去
  `=== null ? undefined :` 的转换。
- **宿主生命周期与运行期查询**：删去 `selectDaemonHostLifecycle` 与 `selectDaemonRuntimeQueries`，`composition/daemonHostLifecycle.ts` 转出
  `createNativeDaemonHostLifecycle`。daemon 启动写 `development?.daemonHost ?? createNativeDaemonHostLifecycle({…})`（开发叠加层与本机宿主的选择
  留在 bootstrap，参数不变）；开发重载缺省的 `createHost` 直接建本机宿主。
- **daemon 应用与 HTTP 装配**：`daemonRuntime` 必填，删去只为回落存在的 `daemonInfoPath`；会话照旧把 daemon 宿主作为运行期查询交入。

### D3 development-automation

- **`composeDevelopmentAutomation`**：`evidenceArtifacts`、`admissionLookup`、`requirementStaging` 与 `evidenceDocumentCommands` 必填。需求物化器
  的内容直接取 application 的 `selectedRequirementMaterializerContent({ staging, documentCommands })`（核对与错误原文不变）；
  `composeRequirementMaterializerContent` 只剩这次核对，删去（`composition/evidenceStaging.ts` 的转出不变）。
- **开发交付**：`composeDevelopmentPipelineDeps` 删去单参数的旧版重载与 `PipelineEvidenceExecution` 类型。旧版流水线证据桥此后在生产代码、用例、
  e2e 与脚本里都没有使用方，连同 `composition/pipelineEvidence.ts` 的转出一并删去。
- **平台工作项**：`evidenceArtifacts` 必填，交给 application 的 `evidenceStore` 直接返回它。
- **任务输入上传**：只收必填的 `artifacts`（daemon 本来给的就是它），删去 `blobs` 与只为回落存在的 `appHome`；懒建证据库的 `lazyEvidenceBlobs`
  没有使用方，删去。

### D4 用例与测试助手

- **`tests/helpers/systemOperations.ts`**（新）：`composeStandaloneLocalSystemOperationsSelection(contract)` 按此前回落的次序读配置、解析
  provider 运行期；移来的打开前恢复。
- **`tests/helpers/developmentAutomation.ts`**（新）：`composeStandaloneDevelopmentAutomationSelections({ db, appHome, … })` 只在用例没给时逐项构
  造（证据库在装配时建；准入查询；写入器与暂存按解析出的证据库与 `<appHome>/evidence/staging` 建，与此前相同；用例给了暂存时写入器照给的原样
  交出）；`composeStandalonePlatformWorkItemEvidence({ appHome, automationWorkspaceEffects })` 首次使用时才在所选工作区效果的根目录下建证据库，与
  此前相同。
- tsc 列出的调用逐处改为显式给出；用例里给 `configPath` 的改给 `createFileDatabaseConfiguration(configPath)`；给 `installation` 的数据库准备加
  `kind: 'selected'`、不给的加 `kind: 'file'`；测试 HTTP 装配给 `daemonRuntime: createFileDaemonRuntimeQueries({ infoPath })`（原来的信息文件路
  径）。

### D5 门与锁

- RFC-521 门删去 16 条登记，适配器回落 67 → 51；`SUCCESSORS` 删去两个模块。
- 钉旧形状的锁随改（逐条见 plan），删除的旧版证据桥在 `rfc376-structural-guards` 与 `rfc294-review-offered-edge-dag` 的条目随删；计数降的收紧到
  实测。新增 RFC-524 用例并登记 guard-manifest。

## 3. 清单（退出门）

| 名字                                                                                                                                                                                                                                                                        | 之后                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `selectDaemonHostLifecycle`、`selectDaemonRuntimeQueries`、`composeInstallationSeedCompletion`、`composeRequirementMaterializerContent`、`lazyEvidenceBlobs`、`composeLegacyDevelopmentPipelineEvidence`、`LegacyPipelineEvidencePort`、`DaemonDatabasePreOpenRecoveryPort` | 生产代码里不再声明                           |
| 组合层的 `prepareDatabasePreOpenRecovery`                                                                                                                                                                                                                                   | 只在测试助手里（application 的同名用例不变） |
| `composeLocalInstallationSeedCompletion`、`createNativeDaemonHostLifecycle` 与 `createFileDatabaseConfiguration` 的组合层转出                                                                                                                                               | 新增                                         |
| `daemonInfoPath`（应用与 HTTP 装配）、`configPath`（迁移模块）、`blobs` 与 `appHome`（任务输入上传）                                                                                                                                                                        | 选项删去                                     |

## 4. 用例

新增 `packages/backend/tests/rfc524-system-operations-development-automation-required-selections-boundary.test.ts`，登记 guard-manifest：

- ① 选项必填：逐个钉住各入口的入参成员（可选标记一并钉）。
- ② §3 清单的名字在全部生产文件（下限 3,000）里不再声明，组合层的打开前恢复只在测试助手里（先按名字文本筛、给语料用例时限）。
- ③ bootstrap 不取两个模块的 infrastructure。
- ④ 装配处的显式构造逐处钉住：daemon 按部署选择选数据库准备的一支、两处本机宿主、会话的迁移配置、两个命令根的配置与 provider、`migrate`
  的本机选项、daemon 的任务输入上传。
- ⑤ 行为：数据库准备按 `kind` 调用各自的准备（托管一支不碰本机文件）；测试助手只在没给时构造、给了原样交出，平台工作项的证据库首次使用前不建
  目录。
- ⑥ 负对照：可选成员、深取 infrastructure 与转回 `undefined` 的写法都会被识别。

## 5. 失败模式

- **改变读取时机**：配置读取放在原来回落发生的位置；`restore` 根合并为一次读取（同一文件、相邻两次读取）。
- **改变构造时机**：证据库的“装配时建 / 首次使用时建”在测试助手里分别保留。
- **按原文钉住旧形状的锁**：按被删的每个名字与选项全仓搜（RFC-514 的教训），逐条随改。
- **删除的文件成为账本里的陈旧条目**：同提交删去。

## 6. 取舍（可推翻）

1. **数据库准备用 `kind` 两支，不拆成两个函数**：启动顺序的用例与发布升级的测试助手包着、spy 着这一个入口；手动迁移已经用同样的 `kind` 选项。
2. **运行期查询必填到应用与 HTTP 装配**，不把回落上移到 bootstrap：生产路径本来就总给，只有测试助手用回落。
3. **种子标记改名为 `composeLocalInstallationSeedCompletion`**：唯一的调用只取本机标记，名字照实说。
4. **删除旧版流水线证据桥与懒建证据库**：两者都没有使用方，删除优于保留。
5. **任务输入上传保留 `artifacts` 这个名字**：daemon 本来就这么给，钉 daemon 绑定的锁不用改。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只装配；单机选择经组合层交出，bootstrap 选择。
- **C11**：public 不变。
- **C12**：RFC-524 用例覆盖全部生产文件里的同名声明与 bootstrap 的取用；RFC-521 门覆盖全部组合层。
- **C13**：计数不升，降的收紧到实测；适配器回落 67 → 51。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 1 项第四步；system-operations 与 development-automation 的组合层不再替调用方造适配器；S12 点名的“把可空选择转回 `undefined`”
  在 daemon 的数据库准备处删去。
- **留下**：bootstrap 里的单机选择（开发叠加层与本机宿主、`migrate` 的本机选项、两个命令根的配置读取）与维护 worker 的单机效果一并收进
  `bootstrap/standalone.ts`（另立后继）；两个模块 infrastructure 里的 `select*` 助手；第 1 项余下各步：resource-catalog（16）、task-execution（16）、
  source-control（19）。
