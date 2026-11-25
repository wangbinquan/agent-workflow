# RFC-597 技术设计

记号：`S/` = `packages/backend/src/`，`DA/` = `S/modules/development-automation/`，`T/` = `packages/backend/tests/`。数字取 HEAD `eead26c45`。
生产行为不变。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：改动在 development-automation 的模块装配（`DA/composition.ts`）。11 个 provider 由别的模块实现（integration、task-execution、
  source-control，以及本模块 `composition/developmentDelivery.ts` 对代码托管与交付 provider 的组装），在 bootstrap 交入——consumer-owned port 的形状不变，
  只把装配边界从“可给可不给”收成“必须给”。
- **为什么先收装配边界、不直接拆 `ReconcilerPorts`**：目标形态是按用例拆出的必填端口（RFC-294 design §3）。`ReconcilerPorts` 还被 19 个 RFC-310 用例
  与三个夹具 helper（`rfc310Pr2Fixture`、`rfc310Pr3Fixture`、`rfc310AgentPorts`）按需直接构造，拆它要随用例一起改，另立为 W4-E8 的下一步。装配边界这一步先让生产不可能漏给 provider（F-H2-2 那类事故在编译期就被挡下），
  并去掉“不给 = 诚实 blocked”这个只在用例里存在的状态在装配上的入口。
- **为什么不用 `null` 表示“不接”**：RFC-431 的“选择显式给出、`null` 表示该部署没有”只用于部署真的没有的能力；这 11 个 provider 两种部署都有，
  `null` 只会是给用例开的口子。用例不用的 provider 改给测试替身（§1），调到就抛错。
- **偏离项**：无。

## 1. 改动

- `DA/composition.ts`：
  - 新增 `export interface DevelopmentAutomationProviders`：11 个成员都必填，注释写明各由谁组装；`DevelopmentAutomationCompositionOptions` 继承它，
    原来的 11 个可选成员删去。
  - `ReconcilerPorts` 的组装：10 个 provider 原样交入（`agentLauncher: deps.agentLauncher` 等）；冲突合并照旧在装配点补齐工作区根，去掉条件展开与
    `deps.conflictMerge!` 的非空断言。需求物化器收 `source: deps.requirementSource`。
- `T/helpers/developmentAutomation.ts`：新增 `unusedDevelopmentProviders()`，给出 11 个 provider 的测试替身——逐个端口写全方法，每个方法是
  `(): never`、调用即抛 `<provider>.<method> is not used by this test`（编译器按端口核对方法齐全，不用强转）。
- 9 个调用装配的用例文件（12 个调用点）：对象字面量在选择展开之后展开 `...unusedDevelopmentProviders()`，用例自己给的 provider 照旧写在后面覆盖。
  集中验证查出一个此前静默落到 `*-not-wired` 的用例：`rfc310-pr5-e2e-java` 第 9 轮交给 MR 照看链、第一步采集 MR 事实，用例注释说“真 collector 已装配”，
  但装配里从没给 `mergeRequestFacts`，这一轮其实停在 `collector-not-wired:merge-request`（用例只断言选中的动作）。改为给生产的 MR 事实采集
  （`composeDevelopmentMrFactsCollector`，事实源与 MR 效果共用同一个 mock GitLab 绑定，事实目标照 T109 的写法从认领行读）。
- `T/fixtures/rfc359-p0-mutations.ts` 的 `p0-9-launchers`：去掉两个启动器后交给原装配时加一次类型断言并注明——这正是 RFC-597 在编译期拒绝的遗漏，
  这个预载在运行期复现它的后果（reconciler 读到 `undefined`，照旧 `*-launcher-not-wired`）。

## 2. 门、用例与文档

- 新增 `T/rfc597-development-automation-required-providers-boundary.test.ts`，登记 guard-manifest：
  1. `DevelopmentAutomationProviders` 恰好是 11 个成员、都没有 `?`，`DevelopmentAutomationCompositionOptions` 继承它、自己不再声明这 11 个名字；
     另有编译期断言（没有可选键）。
  2. 装配文件里没有以“某个 provider 是否 `undefined`”为条件的条件表达式与 `if`，没有 `deps.<provider>!`；`ReconcilerPorts` 的组装逐个读
     `deps.<provider>`，物化器收 `deps.requirementSource`。判据带负对照。
  3. 测试替身给全 11 个 provider，每个方法被调用时抛出带名字的错误（逐个方法调用核对）。
- 计数：预计都不变（条件展开是表达式，不进 F13 的行首语句计数；回落门只认回落一侧的调用与 `new`）。

## 3. 失败模式

- **有人把某个 provider 改回可选、或 daemon 漏给**：`tsc` 报错（CI 的类型检查覆盖 `src` 与 `tests`），RFC-597 用例 ① 红。
- **装配重新按“给没给”分支**：RFC-597 用例 ② 红。
- **用例走到了没给的 provider**：替身抛错，用例按真实错误失败，而不是静默停在 `*-not-wired`。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：provider 由 bootstrap 显式交入，装配不替部署决定“缺一个也行”。**C12**：RFC-597 用例 ① ② 读模块装配文件，③ 跑替身；装配的唯一生产
  调用方由 `tsc` 全量核对。**C13**：计数不升。

## 5. 留下的

- **W4-E8 下一步**：`ReconcilerPorts` 按用例拆成必填端口，删去 reconciler 里的 `*-not-wired` 分支；直接构造端口的 RFC-310 夹具用例随之改给替身或
  真实实现。
- **装配入参其余 6 个可选成员**：`actionWorkspaceEffects`、`automationWorkspaceEffects`、`repositoryBaselines` 缺省时由 infrastructure 的 `select*` 助手造本机
  文件实现（daemon 都给，只有用例靠缺省）；`evidenceContents`、`evidenceRead`、`attemptContext` 是证据读取的覆盖（daemon 不给，RFC-429 起由
  `evidenceArtifacts` 带）。按 S12 的做法改为必填或删去覆盖，另立。
