# RFC-525 设计：资源目录的适配器回落改为必填注入

## 1. 现状（HEAD，源码实读）

RFC-521 门登记的 16 处（路径在 `packages/backend/src/modules/resource-catalog/composition/` 下）：

| #      | 位置                                                                             | 回落                                                                          | 生产调用方                                                                                                      |
| ------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1      | `skillContentBinding.ts` `selectSkillContentDependencies`                        | 不给绑定 → 只交出根目录（技能目录随后由下面的回落造本机实现）                 | daemon 的资源目录装配总给部署选择的绑定（`DeploymentSelections.skillContent` 必填）；装配入参可选，只有用例不给 |
| 2～7   | `skillOperations.ts` `composeSkillCatalog`                                       | 六项内容存储不给 → 本机文件实现                                               | 经 classic catalogs 取绑定的同名成员（本机与数据库两种绑定都给全）                                              |
| 8～9   | `skillVersionCommit.ts` `composeSkillVersionCommitParticipantFactory`            | 不给选择 → 本机树存储的参与者；绑定不给 `treeContent` → 本机树存储            | 融合装配总给部署选择的绑定；两种绑定都带 `treeContent`                                                          |
| 10     | `workflowOperations.ts` `composeSkillContentAvailability`                        | 不给 `versionPresence` → 本机文件实现                                         | classic catalogs 给绑定的同名成员                                                                               |
| 11     | `resourcePackageProvider.ts` `composeResourcePackageProvider`                    | 不给 `skillPackageContent` → 本机文件读取                                     | daemon 给部署选择的；资源包命令（CLI）不给，一直由回落造                                                        |
| 12、13 | `postgresqlResourcePackageCatalog.ts` `composePostgresqlResourcePackageProvider` | 不给插件 / 技能工件属主 → 本机文件属主（插件属主用给的安装器与 `pluginsDir`） | daemon 给部署选择的两个属主；资源包命令只给安装器，一直由回落造                                                 |
| 14     | `resourcePackageMaintenance.ts` `composeResourcePackageApplyMaintenance`         | 不给 `artifacts` → 本机的版本化工件恢复（可带选定的恢复内容效果）             | 维护 worker 给 `workerEffects?.resourcePackageRecovery`，单机为 `null`，一直由回落造                            |
| 15     | `pluginOperations.ts` `composePluginCatalogFromAdapters`                         | 不给安装器 → 本机安装器                                                       | daemon 给部署选择的（`DeploymentSelections.pluginInstaller` 必填）；装配入参可选，只有用例不给                  |
| 16     | `mcpProbeOperations.ts` `composeMcpProbeOperations`                              | 不给 `probeRunner` → 进程内探测（读测试接缝 `probeOptionsOverride`）          | 单机的 MCP 诊断显式交 `undefined`，托管交托管探测——单机一直由回落走进程内                                       |

`SkillContentBinding` 的内容成员是 `Required<…>`，只有 `packageContent` 与 `treeContent` 可选；本机绑定（`createFileSkillContentBinding`）与数据库绑定
（`createDatabaseSkillContent`）都给了这两项。维护场景的 `requireExclusiveRecoverySelection` 拒绝同时给工件恢复与恢复内容效果。

## 2. 机制与落位

### D1 技能内容

- `SkillContentBinding` 的 `packageContent` 与 `treeContent` 改为必填。
- `selectSkillContentDependencies(binding)` 只收必填的绑定（删去缺省根目录参数与“只交根目录”的一支）；daemon 资源目录装配的 `skillContent` 必填，只为
  回落存在的 `skillContentRoot` 删去（daemon 应用随之不再交它）。
- `composeSkillCatalog` 的六项内容、classic catalogs 的对应入参与 `composeSkillContentAvailability` 的 `versionPresence` 必填。
- `composeSkillVersionCommitParticipantFactory({ skillContent })` 的选择必填，参与者只取绑定的成员（树存储取 `binding.treeContent`）。

### D2 资源包

- `composeResourcePackageProvider` 的 `skillPackageContent` 必填。
- `composePostgresqlResourcePackageProvider` 的 `pluginArtifacts` 与 `skillArtifacts` 必填；只为回落存在的 `pluginInstaller` 与 `pluginsDir` 删去。
  资源包命令在原来回落的位置显式给出同样的本机实现（组合层转出 `createFileResourcePackagePluginArtifactOwner`、
  `createFileResourcePackageSkillArtifactOwner` 与 `createFileSkillPackageContentReader`，参数与此前回落相同：插件目录是 `<appHome>/plugins`，
  安装器是此前交给它的那一个）。
- `composeResourcePackageApplyMaintenance` 的 `artifacts` 必填，删去 `recoveryEffectsFactory` 与它的冲突检查；新增
  `composeLocalResourcePackageArtifactRecovery({ db, appHome, pluginsDir, recoveryEffectsFactory?, log? })`，构造与此前回落相同（选定的恢复内容效果照
  旧经 `selectedResourcePackageRecoveryEffects` 取）。维护 worker 先照旧做冲突检查（组合层转出 `requireExclusiveRecoverySelection`），再取
  `workerEffects?.resourcePackageRecovery ?? composeLocalResourcePackageArtifactRecovery(…)`，两处调用传同一个日志器。

### D3 插件与 MCP 探测

- `composePluginCatalogFromAdapters` 的 `installer` 必填（daemon 一支本来就给）。
- `composeMcpProbeOperations` 的 `probeRunner` 必填；`mcpProbeOperations.ts` 新增 `createInProcessMcpProbeRunner()`：每次探测时读测试接缝再调
  `probeMcp`，与此前回落相同。单机的 MCP 诊断显式选它。

### D4 用例与测试助手

- `tests/helpers/resourceCatalog.ts`（新）：按此前回落逐项构造单机选择（只在用例没给时造），供直接调用技能目录、资源包与维护场景的用例使用。
- tsc 列出的调用逐处改为显式给出；钉旧形状与回落原文的锁随改（按被删的名字、选项与回落原文片段全仓扫描；改共享测试助手时不盖掉用例经展开
  传入的同名值）。

### D5 门与锁

- RFC-521 门删去 16 条登记，适配器回落 51 → 35；`SUCCESSORS` 删去 resource-catalog。计数降的收紧到实测；新增 RFC-525 用例并登记 guard-manifest。

## 3. 清单（退出门）

| 名字                                                                                                                                                              | 之后 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `selectSkillContentDependencies` 的缺省根目录参数、`skillContentRoot`、`pluginInstaller` 与 `pluginsDir`（资源包 provider）、`recoveryEffectsFactory`（维护场景） | 删去 |
| `createInProcessMcpProbeRunner`、`composeLocalResourcePackageArtifactRecovery` 与三个本机资源包实现的组合层转出                                                   | 新增 |

## 4. 用例

新增 `packages/backend/tests/rfc525-resource-catalog-required-selections-boundary.test.ts`，登记 guard-manifest：

- ① 选项必填：逐个钉住各入口的入参成员（可选标记一并钉），`SkillContentBinding` 的两项必填。
- ② bootstrap 不取 resource-catalog 的 infrastructure；删去的选项在生产代码里不再出现（语料下限 3,000，先按名字文本筛、给语料用例时限）。
- ③ 装配处的显式构造逐处钉住：资源包命令的三个本机实现与参数、维护 worker 的选择与冲突检查、单机 MCP 诊断的进程内执行器。
- ④ 行为：进程内执行器每次探测时读测试接缝；测试助手只在没给时构造、给了原样交出。
- ⑤ 负对照。

## 5. 失败模式

- **改变构造时机或参数**：本机实现在原来回落发生的位置、用同一组参数构造。
- **按原文钉住旧形状的锁、共享测试助手盖掉用例的值**：RFC-524 的两条教训（`docs/dev-gotchas.md`），按名字、选项与回落原文片段扫描，改助手前跑经它
  传入被改项的用例。
- **移走或删去后成为不可达文件、未消费符号**：架构报告对照。

## 6. 取舍（可推翻）

1. **内容绑定的两项改为必填**，不在组合层保留“绑定缺树存储就造本机的”：两种绑定本来都给。
2. **冲突检查留在维护 worker 的选择处**：两项都给仍然报错，组合层不再收第二个选项。
3. **进程内执行器是一个具名的选择**，不是“没给执行器”的含义。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只装配；单机选择经组合层交出，bootstrap 选择。
- **C11**：public 不变。
- **C12**：RFC-525 用例覆盖全部生产文件里的同名选项与 bootstrap 的取用；RFC-521 门覆盖全部组合层。
- **C13**：计数不升，降的收紧到实测；适配器回落 51 → 35。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 1 项第五步；resource-catalog 的组合层不再替调用方造适配器。
- **留下**：bootstrap 里的单机选择（资源包命令的本机实现、维护 worker 的 `?? composeLocal…`）与维护 worker 的单机效果一并收进 `bootstrap/standalone.ts`
  （另立后继）；第 1 项余下各步：task-execution（16）、source-control（19）。
