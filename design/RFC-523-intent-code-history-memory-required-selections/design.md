# RFC-523 设计：意图、代码历史与记忆的适配器回落改为必填注入

## 1. 现状（HEAD，源码实读）

RFC-521 门登记的 11 处（`packages/backend/src/modules/` 下）与它们的调用方：

| 位置                                                                                | 回落                                                                                                                                                                                                    | 生产调用方                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `intent/composition/apply.ts` 的 `composeIntentApplyOperations`                     | 资源会话绑定 `composeIntentApplyResourceBinding(...)`（里面再回落三件：插件工件属主、技能工件属主、ACL 归属读面，并新建一个 MCP 事务生命周期）；工件生命周期 `composeIntentApplyArtifactLifecycle(...)` | `bootstrap/daemonModules/intent.ts`：传了两个工件属主、工件内容、ACL 归属读面与工件生命周期，没传资源会话绑定——它在生产路径上由回落造 |
| 同文件的 `composeIntentApplyArtifactLifecycle`                                      | 工件内容 `createFileIntentArtifactContent(...)`；旧版技能工件的兼容绑定 `composeLegacyIntentSkillArtifactCompat()`                                                                                      | daemon 传了工件内容、没传兼容绑定；维护 worker 经恢复场景间接调用                                                                     |
| `intent/composition/applyMaintenance.ts` 的 `composeIntentApplyRecoveryScene`       | 工件生命周期                                                                                                                                                                                            | `bootstrap/maintenanceWorkerGraph.ts`：只传 `workerEffects?.intentArtifactContent`（单机部署的 worker 效果是 `null`）                 |
| `intent/composition/maintenance.ts` 的 `composeIntentMaintenanceCommandsForAppHome` | 草稿区 `createFileIntentScratchStore(...)`                                                                                                                                                              | 维护 worker 经 `composeIntentMaintenanceCommandsForDatabase` 传 `workerEffects?.intentScratch`                                        |
| `code-capability/composition/historyQueries.ts` 的 `composeCodeHistoryQueries`      | 缺省参数 `createUnboundCodeHistoryReader()`                                                                                                                                                             | `bootstrap/daemonHttpComposition.ts` 总是传入必填的读取器                                                                             |
| `memory/composition.ts` 的 `composeMemoryOperationsFor`                             | 注入查询 `composeMemoryInjectionQueriesFor(...)`                                                                                                                                                        | `bootstrap/daemonModules/memory.ts` 总是传入                                                                                          |

- `applyIntentChangeset`（同在 `intent/composition/apply.ts`）是“给我 db + appHome，替我装好资源会话与工件生命周期再跑 apply”的便捷入口，整
  个靠上述回落；只有 10 个用例文件调用它，生产代码不调。
- 维护 worker 的本机实现分两处：草稿区在 intent 的 `infrastructure/local/`（bootstrap 不得深取模块的 infrastructure），工件内容由
  `composeLocalIntentArtifacts` 的同一个工厂构造。
- 用例：`composeIntentApplyOperations` 11 个文件、恢复场景 7 个、工件生命周期 1 个、代码历史 6 个、记忆 5 个。

## 2. 机制与落位

### D1 intent apply

- `IntentApplyCompositionDependencies` 收成 `{ db, resources, artifacts, id?, now? }`：资源会话绑定与工件生命周期必填，只为回落存在的
  `appHome`、`aclIdentities`、`artifactContent`、`legacySkillArtifacts`、`pluginArtifacts`、`skillArtifacts` 删去。
- `composeIntentApplyArtifactLifecycle` 的 `content` 与 `legacySkillArtifacts` 必填（`pluginsDir` 照旧由 `appHome` 推出）。
- 新增 `composeLocalIntentArtifactContent({ appHome, pluginsDir })`：单机的工件内容（就是 `composeLocalIntentArtifacts` 原先内联的那个工厂调
  用，它改为调这个函数）。
- `applyIntentChangeset` 移到 `tests/helpers/intentApply.ts`，显式构造单机的资源会话绑定与工件生命周期（同一组工厂、同一组参数）；同一个文件
  给直接调 `composeIntentApplyOperations` 的用例提供 `composeStandaloneIntentApply({ db, appHome, aclIdentities? })`。

### D2 daemon

- `bootstrap/daemonModules/intent.ts` 显式构造：工件生命周期（工件内容取部署选择，兼容绑定取 resource-catalog 的
  `composeLegacyIntentSkillArtifactCompat()`）与资源会话绑定（`composeIntentApplyResourceBinding`：两个工件属主取部署选择，ACL 归属读面取
  resource-catalog 的持久化，MCP 事务生命周期照旧在这份装配里新建一个）。与此前回落造的对象相同。

### D3 维护 worker

- `composeIntentApplyRecoveryScene` 收成 `{ db, artifacts, now?, log? }`（工件生命周期必填）；`composeIntentMaintenanceCommandsForAppHome`
  与 `ForDatabase` 的草稿区必填，只为回落存在的目录名选项删去。
- intent 组合层新增 `composeLocalIntentScratch({ appHome, directoryName? })`（单机草稿区，目录名缺省仍是 `INTENT_SCRATCH_DIRNAME`）。
- `bootstrap/maintenanceWorkerGraph.ts` 显式给出：托管效果在时取托管的，单机时取 intent 的两个单机选择。这两
  处“`workerEffects?.x ?? 单机选择`”留在 bootstrap 里，等维护 worker 的单机效果整体收成一份时一起清（§8）。

### D4 code-capability 与 memory

- `composeCodeHistoryQueries` 的第三个参数必填；`composeMemoryOperationsFor` 的 `injectionQueries` 必填。daemon 不改；用例显式给出此前缺省的
  对象（未绑定的读取器、按 db 装的注入查询）。

### D5 门与锁

- RFC-521 门删去 11 条登记，`ADAPTER_FALLBACKS` 78 → 67，`SUCCESSORS` 删去 intent、code-capability 与 memory。
- 按被删的名字、选项与回落原文全仓搜用例（`grep -l` 列出全部命中文件，不截断），钉旧形状的锁随改；新增 RFC-523 用例并登记 guard-manifest。

## 3. 清单（退出门）

- 上表 11 处回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 67 条，`SUCCESSORS` 不含 intent、code-capability 与 memory。
- `IntentApplyCompositionDependencies` 只含 `db`、`resources`、`artifacts`、`id`、`now`；工件生命周期的 `content` / `legacySkillArtifacts`、
  恢复场景的 `artifacts`、维护命令的 `scratch`、`composeMemoryOperationsFor` 的 `injectionQueries` 是必填属性，`composeCodeHistoryQueries`
  的第三个参数没有缺省值。
- 生产代码里没有 `applyIntentChangeset` 的声明；bootstrap 不取 intent 的 `infrastructure/`。

## 4. 用例

- RFC-521 门（登记与总数随 D5 改）锁住回落不再出现。
- 新增 `packages/backend/tests/rfc523-intent-code-history-memory-required-selections-boundary.test.ts`，登记 guard-manifest：① §3 的选项形状
  （语法树：必填、删去的选项不在、第三个参数没有缺省值）；② 全部生产文件（下限 3,000，先按名字文本筛再解析，给足时限）里没有
  `applyIntentChangeset` 的声明，bootstrap 不取 intent 的 infrastructure；③ daemon 与维护 worker 的显式构造用的是此前回落的同一组工厂（语法
  树钉住 `bootstrap/daemonModules/intent.ts` 与 `bootstrap/maintenanceWorkerGraph.ts` 的调用），测试助手同样；带负对照。
- 既有用例照旧覆盖行为：intent apply、恢复与维护，代码历史与记忆的用例（经测试助手给出同样的对象）。

## 5. 失败模式

- **漏给**：选项必填后 `tsc` 报错，不会在运行期才缺。
- **行为走样**：显式构造与此前回落逐个对照（同一工厂、同一参数；MCP 事务生命周期照旧每份装配新建一个）；维护 worker 的托管路径不变。
- **按原文钉住的锁**：见 D5；集中验证再按名字扫一遍。

## 6. 取舍（可推翻）

1. **资源会话绑定在 daemon 里显式构造**：它不是部署选择，是跨模块的装配（resource-catalog 的会话、intent 的工件属主），本就该在工厂图里构造
   并注入；回落把它藏在了 intent 的组合层。
2. **`applyIntentChangeset` 移到测试助手**：只有用例调用；留在组合层就得在模块里构造单机实现。
3. **维护 worker 先显式取单机选择**：worker 的单机效果整体收成一份要动五个模块的维护入口，另立后继；本步只把 intent 两处挪到 bootstrap。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层不再替调用方造适配器；跨模块的装配在 bootstrap 显式完成。
- **C11**：intent 组合层少一个便捷入口、多两个单机选择；public 不变。
- **C12**：RFC-523 用例读全部生产文件；RFC-521 门覆盖全部模块的组合层。
- **C13**：计数不升；适配器回落 78 → 67。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 1 项第三步：intent、code-capability 与 memory 的适配器回落清零。
- **留下**：67 处适配器回落（system-operations / development-automation、resource-catalog、task-execution、source-control）；维护 worker 的
  单机效果仍是 `null` 加各处的 `workerEffects?.x ?? 单机实现`（bootstrap 两处 intent 的、以及其他模块经它落到组合层回落的），宜另立一个后继
  把 standalone 的 worker 效果显式构造成一份，再清其余模块经 worker 落下的回落。
