# RFC-528 设计：维护 worker 的单机效果收进单机 profile

## 1. 现状（HEAD，源码实读）

维护 worker 的效果由 RFC-399 的描述符协议选择（`bootstrap/maintenanceWorkerEffects.ts`）：

- 部署 profile 的 `maintenanceEffectsBootstrap`：托管给 `composeCrewStationMaintenanceDescriptor(...)`（`bootstrap/crewstationMaintenance.ts`），单机给
  `null`（`bootstrap/standalone.ts`）。daemon 会话把它交给 worker 宿主；worker 线程有描述符时按它加载托管效果模块（托管效果自己开数据库连接），
  按描述符的 `capabilities` 取效果族，没有描述符时 `effects` 为 `undefined`（`platform/background/maintenanceWorkerRuntime.ts`）。
- `MaintenanceWorkerEffectsSelections` 的 12 个成员全可选。托管描述符列 11 族（除 `resourcePackageRecoveryContent`，它与
  `resourcePackageRecovery` 互斥、只有用例选）；用例经同一协议只选一两族（`rfc370-maintenance-worker-real-effects`、
  `rfc370-v9-maintenance-worker-entry`、`rfc370-m2-resource-artifact-wiring` 与夹具 `rfc370-compiled-maintenance-effects-probe`），其余靠回落。

`bootstrap/maintenanceWorkerGraph.ts` 里有单机对应的 7 族，回落构造 9 处：

| 族                        | 回落（没给时）                                                                                                                                                                                                                         | 位置                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `contentStore`            | `createLocalRuntimeContent(client, appHome)`                                                                                                                                                                                           | 图：任务执行持久化                                    |
| `taskArchive`             | `{ content: createFileTaskArchiveContent() }`                                                                                                                                                                                          | 图：归档维护命令                                      |
| `resourcePackageRecovery` | `composeLocalResourcePackageArtifactRecovery({ db, appHome, pluginsDir, recoveryEffectsFactory: 选的恢复内容, log })`；先核对两项互斥                                                                                                  | `resourcePackageArtifactRecovery`，两个适配器各调一次 |
| `workspaceMaintenance`    | `composeLocalScratchWorkspaceEffects(准备输入)`、`composeLocalRepositoryPreparationEffects(准备输入)`、`createNodeWorkspaceMaintenanceFilesystem({ appHome, isMaterializingTask, invalidateWorkspacePath: invalidateCallGraphIndex })` | 图：工作区维护命令的工厂（构造时调一次）              |
| `pluginGenerationGc`      | `createPluginGenerationFilesystemGcPort(join(appHome, 'plugins'))`                                                                                                                                                                     | 图                                                    |
| `intentScratch`           | `composeLocalIntentScratch({ appHome })`                                                                                                                                                                                               | 图                                                    |
| `intentArtifactContent`   | `composeLocalIntentArtifactContent({ appHome, pluginsDir: join(appHome, 'plugins') })`                                                                                                                                                 | 图                                                    |

另有：内容维护（`composeWorkerContentMaintenance`，两个适配器各调一次）按 `effects?.contentStore?.policy.externalKind ?? 'local-file'` 决定是否带本机
文件传输（本机内容存储的外部类型就是 `local-file`）。准备输入是 `{ taskPorts: composeSourceControlTaskPorts(client), db: client, appHome }`。托管
独有的 4 族——`databaseWrites`、`eventsArchive`、`databaseBackups`、`objectPublications`——没有单机对应，没给就是没有。worker 的工作区存在性
（`createFileWorkspacePresenceQueries()`）两种部署相同，不是单机默认值。

约束：`composeMaintenanceWorkerGraph` 的函数体不许有 `if` / `switch` / 条件表达式（RFC-389 的中立图锁，`??` 不算分支）；回落是惰性的（托管不构造
本机实现，同一把锁钉住插件代际回收那一处是 `??` 的右侧）。读 `maintenanceWorkerGraph.ts` 源码的用例 18 个（RFC-389、RFC-523、RFC-525～527
等的锁）。

## 2. 机制与落位

### D1 单机 profile 的 worker 部分

- 新增 `bootstrap/standaloneMaintenanceWorker.ts`，导出 `standaloneMaintenanceWorkerEffects`：7 族各一个构造函数，入参是 worker 的作用域
  `{ db, appHome, log }`（资源包恢复另收选中的恢复内容），函数体就是上表的回落，同一组工厂、同一组参数（各工厂照旧从模块组合层取）。
- 不放进 `bootstrap/standalone.ts`：worker 线程只取它要的装配，`standalone.ts` 带着 daemon 全部单机选择（12 个模块的 32 处组合层
  导入），worker 用不到。两个文件一起构成单机 profile，`standalone.ts` 头注释指向 worker 部分。

### D2 一次选择

- `bootstrap/maintenanceWorkerEffects.ts` 增 `resolveMaintenanceWorkerEffects(selected, standalone, scope)`，返回 `MaintenanceWorkerEffects`：7 族必有
  （各取 `selected?.X ?? standalone.X(scope)`，资源包恢复先照旧核对两项互斥，日志器照旧按适配器——PostgreSQL 不带、SQLite 带
  `intentMaintenance`），托管独有的 4 族原样转交（可选）。
- 在每个数据库适配器打开客户端之后调一次（两种适配器都要用数据库建恢复与内容维护），结果随适配器交给图；图的函数体只读
  `adapter.effects.X`，不再有 `?.` / `??` 回落与本机构造。`databaseWrites` 在开客户端之前就要用，照旧直接取选中的。
- 惰性不变：托管描述符给了的族不调单机构造；单机（没有描述符）每族构造一次，构造时机与此前同处于图的装配期、任何作业运行之前（工作区维护命令
  的工厂在构造时调一次，单机的准备、草稿区与维护文件系统此前在那里造，现在在选择处造）。
- 内容维护按选好的内容存储判断：`effects.contentStore.policy.externalKind === 'local-file'`（单机给本机内容存储，外部类型就是 `local-file`）。

### D3 托管描述符列全

- 生产的托管描述符必须列出 7 族里托管给的那几族（资源包恢复给 `resourcePackageRecovery`）：用例钉住 `composeCrewStationMaintenanceDescriptor` 的
  `capabilities` 含全部 7 族，托管 worker 不会混入单机实现。用例经协议只选一两族照旧可用——没给的族取单机 profile 的，与此前回落相同。

### D4 用例与锁

- 读 `maintenanceWorkerGraph.ts` 源码、钉本机构造位置的锁改指 `standaloneMaintenanceWorker.ts` 或选择处（RFC-389 中立图锁的惰性一条改钉选择处；
  RFC-523 / 525～527 钉的维护 worker 本机效果改钉单机 worker 部分）；按被改文件的路径筛出读其源码的全部用例逐个核对（RFC-525），按 AST 钉装配实参
  的锁逐个核对（RFC-526）。

## 3. 清单（退出门）

| 名字                                                                                                      | 之后                         |
| --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 图与两个适配器里的 9 处本机构造、`resourcePackageArtifactRecovery` 里的回落、内容维护的 `?? 'local-file'` | 删去（移进单机 worker 部分） |
| `bootstrap/standaloneMaintenanceWorker.ts` 的 `standaloneMaintenanceWorkerEffects`                        | 新增                         |
| `resolveMaintenanceWorkerEffects`、`MaintenanceWorkerEffects`                                             | 新增                         |
| `MaintenanceWorkerEffectsSelections`、描述符协议                                                          | 不变                         |

## 4. 用例

新增 `packages/backend/tests/rfc528-standalone-maintenance-worker-effects-boundary.test.ts`，登记 guard-manifest：

- ① `maintenanceWorkerGraph.ts` 不调上表的 9 个本机构造；对描述符原样选择的读取只剩选择本身与 PostgreSQL 客户端的写屏障（`databaseWrites`）；
  单机 worker 部分每族恰好构造一次、实参与此前回落相同（按 AST 钉）。
- ② 选择：两个适配器各选一次；7 族逐族是 `selected?.X ?? standalone.X(scope…)`（`??` 的右侧只在没给时求值，即惰性，同 RFC-389 钉插件代际
  回收那一处的写法），托管独有的 4 族原样转交；资源包恢复的互斥核对的实参改钉选择处（RFC-513、RFC-525 的锁随改）。
- ③ 生产的托管描述符的 `capabilities` 含全部 7 族；单机 worker 部分恰好给出这 7 族的构造；worker 线程的两个入口按值导入求闭包，不到达
  `bootstrap/standalone.ts`。
- ④ 负对照。

## 5. 失败模式

- **改变构造时机或参数**：单机构造搬到选择处，实参逐个按 AST 对照此前的回落（含按适配器不同的日志器）；同在装配期、任何作业运行之前。
- **托管构造了本机实现**：选择逐族惰性（单机构造只在 `??` 的右侧），用例按语法树钉住每族的写法。
- **漏改读源码的锁**：按被改文件的路径筛出读其源码的全部用例（RFC-525 教训）。
- **worker 线程拉进 daemon 的单机选择**：用例钉住 worker 一侧不导入 `standalone.ts`。

## 6. 取舍（可推翻）

1. **单机 worker 部分单列一个文件，而不是放进 `standalone.ts`**：worker 线程不应加载 daemon 的单机选择；单机 profile 由两个文件构成，RFC-294 plan
   第 1 项的措辞随之写成“单机 profile（`bootstrap/standalone.ts` 与维护 worker 的单机部分）”。
2. **描述符只选一部分族时，没给的取单机 profile 的**，而不是要求描述符列全：托管效果自己开数据库连接，要求用例的描述符列全就要让每个用例的效果模块
   另开连接造本机实现；生产的托管描述符列全由用例钉住，托管不会混入本机实现。
3. **选择在适配器里、打开客户端之后做**：数据库相关的单机构造要用 worker 的客户端；图的函数体保持没有分支。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层不变；bootstrap 的 worker 图只装配，单机默认值在单机 profile。
- **C11**：public 不变。
- **C12**：RFC-528 用例覆盖 worker 一侧的全部本机构造与选择；RFC-389 的中立图锁照旧。
- **C13**：计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 1 项余项里维护 worker 的一半：单机 worker 的默认值只在单机 profile，worker 只选一次。
- **留下**：daemon 一侧按托管能力是否为 `null` 选本机实现的几处（仓库镜像、数据库安装、子仓刷新）随 S12 第 6 项（部署选择合同改为每模块一份类型化
  的适配器集合）处理；S12 的第 3～5 项。
