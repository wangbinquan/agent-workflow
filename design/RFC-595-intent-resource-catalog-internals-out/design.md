# RFC-595 技术设计

记号：`S/` = `packages/backend/src/`，`IN/` = `S/modules/intent/`，`RC/` = `S/modules/resource-catalog/`，`B/` = `S/bootstrap/`，`T/` =
`packages/backend/tests/`。数字取 HEAD `7dfc0423e`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：consumer 是 intent，provider 是 resource-catalog；目标 DAG 上 intent → resource-catalog 是 offered-consumption（exact public 入口）。
  改动落在 intent 的 `composition/` 与 `application/ports/`、resource-catalog 的 `composition/`、bootstrap 的四个装配点。
- **装配对（G1）**：跨模块装配只在 bootstrap（R1 与“bootstrap 唯一装配”）。intent 的三个装配函数里，resource-catalog 的四件东西改为必填入参：
  - `composeLocalIntentArtifacts` 原先收 `{ db, appHome }`、自己造插件与技能工件属主；改收 `{ appHome, resources: LocalIntentResourceArtifacts }`，与托管一族的
    `composeCrewStationIntentArtifacts(resources: HostedIntentResourceArtifacts)` 同形。`LocalIntentResourceArtifacts`（intent 声明）=
    `{ pluginArtifacts, skillArtifacts, skillArtifactCompensation }`，前两个是 resource-catalog public 的属主类型，第三个是 intent 自有的
    `PostgresqlSkillArtifactCompensation` 端口。
  - `composeLocalIntentArtifactContent` 多一个必填的 `skillArtifacts`（补偿原语）。
  - `composeIntentApplyArtifactLifecycle` 多一个必填的 `skillContentLocations`（平台的 `SkillContentLocationQuery`）。
  - resource-catalog 的 `composition/intentApply.ts` 新增 `composeLocalIntentResourceArtifacts({ db, appHome })`：用原来的三个构造（插件属主落
    `appHome/plugins`、技能属主收 `{ appHome, db }`、补偿原语）造出本机一族，与托管一族由 resource-catalog 的 `composeCrewStationResourceArtifacts` 造出对称。
  - bootstrap 的四个调用方（`standalone.ts`、`standaloneMaintenanceWorker.ts`、`maintenanceWorkerGraph.ts`、`daemonModules/intent.ts`）本来就从
    resource-catalog 的装配根取东西，改为把这几件交进去。
- **会话对（G2）**：resource-catalog 的会话类型若经它的 public 交出，会把平台的 `PersistenceTx`（事务参数）带进 public 合同，`public-surface-deviations`
  会升；所以照 S9 的先例由 consumer 声明自己驱动的形状。`IN/application/ports/intentApplyResourceSession.ts` 写引擎实际调用的七个方法与它传的值：
  预检收 intent 的清单（`IntentContextManifest`）与 shared 的 `IntentChangeset`、回 `copyOnlyTargets`；准备 / 暂存 / 提交收 resource-catalog public 的
  `VersionedIntentResourceChangesetPlan` 与 `IntentApplyArtifact`；事务尝试收平台的 `PersistenceTx`；提交回执引擎不读，写作 `Promise<unknown>`。引擎从这里取；
  `IntentApplyResourceBinding`（引擎的依赖接口）留在引擎文件里，只把会话类型改指端口。resource-catalog 的实现不改，在 bootstrap 的
  `composeIntentApplyOperations({ resources: composeIntentApplyResourceBinding(...) })` 处按结构满足端口；RFC-595 用例再加编译期断言。
- **偏离项**：无。

## 1. 改动

- 新建 `IN/application/ports/intentApplyResourceSession.ts`（会话、事务尝试与三个上下文的形状）；`IN/infrastructure/intentApplyEngine.ts` 改取它，不再
  import resource-catalog 的 infrastructure。
- `IN/composition/apply.ts`：删掉对 resource-catalog 装配根的 import；三个函数按 §0 改入参；新增 `LocalIntentResourceArtifacts`。
- `RC/composition/intentApply.ts`：新增 `composeLocalIntentResourceArtifacts`。
- bootstrap 四个调用方按 §0 交入。
- 测试里调这三个函数的地方改交入参（`rfc384`、`rfc370-intent-artifact-content` 等，按检索清单）；钉着调用参数文本的 `rfc523` 跟着改。

## 2. 门、用例与文档

- `rfc376-structural-guards` 的已知清单删两条 intent 的对；`counts.json` 的 `cross-context-internal-file-pairs` 6 → 4。
- 新增 `T/rfc595-intent-resource-catalog-internals-boundary.test.ts`，登记 guard-manifest：① intent 全部源码解析到 resource-catalog 的说明符都落在
  `public/`（带负对照）；② resource-catalog 的 `composition/intentApply` 在生产代码里只被 bootstrap 文件取（带负对照）；③ intent 的装配文件不再调那四个
  构造；④ 编译期断言：resource-catalog 的会话满足 intent 的端口、`composeLocalIntentResourceArtifacts` 的结果满足 `LocalIntentResourceArtifacts`；⑤ 行为：本机
  一族的插件属主落 `appHome/plugins`，与 `composeLocalIntentArtifactContent` 用同一个目录。

## 3. 失败模式

- **有人在 intent 里重新取 resource-catalog 的内部**：用例 ① 与跨 context 内部文件对的计数红。
- **端口与实现漂开**：bootstrap 的绑定处与用例 ④ 编译不过（CI 的 typecheck 红）。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：装配回到 bootstrap，consumer 自有端口。**C12**：RFC-595 用例 ① ② 覆盖 intent 全部源码与全部生产文件，③ ⑤ 只读两个文件，④ 编译期。
  **C13**：`cross-context-internal-file-pairs` 6 → 4。
- 余下四对：integration → task-execution 的效果能力（能力合同，暂缓）、code-capability → resource-catalog 的写入参与者（W4-E8 兼容岛并入
  development-automation 时一起处理）。
