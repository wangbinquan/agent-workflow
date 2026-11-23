# RFC-541 技术设计

## 1. 现状（HEAD `2f685c9e4`，源码实读）

- **登记表**（`platform/background/maintenanceWorkerEffects.ts`）：模块级 `const effectModules = new Map<…>()`；`registerMaintenanceWorkerEffectModule(
specifier, load)` 写表，`importMaintenanceWorkerEffectModule(specifier)` 查表、查不到 `import(specifier)`；`openMaintenanceWorkerEffectsScope(input)`
  的加载器取 `input.importModule ?? importMaintenanceWorkerEffectModule`。
- **两个 Worker 入口**（单二进制的显式入口，`tests/architecture/rfc294Gates.ts` 与 `scripts/build-binary.ts` 列着）：
  - 单机根 `bootstrap/maintenanceWorker.ts`：一条语句 `runMaintenanceWorker({ composeGraph: composeMaintenanceWorkerGraph, openEffectsScope:
openMaintenanceWorkerEffectsScope })`（`rfc389-maintenance-worker-root` 钉“入口是薄的”）。
  - 托管入口 `bootstrap/maintenanceWorkerEntry.ts`：先 `registerMaintenanceWorkerEffectModule('aw:crewstation-maintenance', () =>
import('./crewstationMaintenance'))`，再 `import './maintenanceWorker'` 跑共用的根；托管部署的效果描述符（`crewstationMaintenance.ts`）带
    `workerEntry` 指向它，监工据此选入口。
- **用例**：`rfc370-v9-maintenance-worker-entry` 直接调登记与加载函数，并钉托管入口的 `import './maintenanceWorker'`；`rfc370-maintenance-worker-effects`
  等以 `importModule` 注入效果模块。

## 2. 机制与落位

落在 platform/background（效果作用域的加载器）与 bootstrap（两个 Worker 根）；不新增跨上下文依赖。

### D1 加载器随作用域交进来

- `maintenanceWorkerEffects.ts` 删去模块级表、`registerMaintenanceWorkerEffectModule` 与 `importMaintenanceWorkerEffectModule`；
  `openMaintenanceWorkerEffectsScope` 的加载器取 `input.importModule`，没给时按模块名 `import(specifier)`（与此前查不到表时同义）。

### D2 托管入口是自己的薄根

- `maintenanceWorkerEntry.ts` 不再登记、也不再 import 单机根：它自己调一次 `runMaintenanceWorker({ composeGraph: composeMaintenanceWorkerGraph,
openEffectsScope })`，`openEffectsScope` 把输入连同托管的加载器交给 bootstrap 的 `openMaintenanceWorkerEffectsScope`——`aw:crewstation-maintenance`
  映射到 `import('./crewstationMaintenance')`（照旧按需加载），其余按模块名 import。单机根不变。

### D3 用例与锁

- 新增 `tests/rfc541-maintenance-worker-effect-modules-boundary.test.ts`，登记 guard-manifest：① 平台效果文件顶层没有 `let` 与集合、架构报告的
  模块级可变单例判据为空；生产代码不再引用删去的名字；两个 Worker 根各调一次 `runMaintenanceWorker(`，托管根的作用域带把
  `aw:crewstation-maintenance` 映射到 CrewStation 效果模块的加载器（语料下限 3,000）；② 行为：作用域用交进来的加载器、没给时按模块名 import；
  ③ 带负对照。
- `rfc370-v9-maintenance-worker-entry` 改为钉托管根的形状（自己调运行时、映射符号名、不 import 单机根）与平台作用域的缺省加载；census 与架构报告
  里描述托管入口“登记效果模块”的注释随改。

## 3. 清单（退出门）

| 名字                                                                                              | 之后                                                        |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `effectModules` / `registerMaintenanceWorkerEffectModule` / `importMaintenanceWorkerEffectModule` | 删去；`openMaintenanceWorkerEffectsScope({ importModule })` |
| 托管入口的 `import './maintenanceWorker'`                                                         | 托管入口自己调 `runMaintenanceWorker(…)`                    |

## 4. 用例

- ① ～ ③ 见 D3；既有用例覆盖效果作用域的注入、生命周期与两种部署的效果选择（`rfc370-maintenance-worker-effects`、
  `rfc528-standalone-maintenance-worker-effects-boundary`、`rfc389-maintenance-worker-root` 等）。

## 5. 失败模式

- **托管根漏了映射**：托管部署的描述符名 `aw:crewstation-maintenance` 会被当作模块名 import 而失败，Worker 初始化报错。RFC-541 用例钉托管根的
  映射，变异验证兜底。
- **两个根分叉**：两个根各写一份运行时调用，图与运行时仍是同一份（`composeMaintenanceWorkerGraph`、`runMaintenanceWorker`），只有效果加载器不同。

## 6. 取舍（可推翻）

1. **托管入口自己做根而不是让单机根收参数**：单机根按 `rfc389` 保持一条语句的薄根；托管入口本来就是托管部署的组合根，把自己的加载器交给运行时
   比在 Worker 线程里写一张全局表直接，也不再靠 import 顺序配合。
2. **映射写在托管入口里而不是另起文件**：加载器只有托管入口用，照旧按需加载 CrewStation 的效果模块；新文件还要登记进 census 的 bootstrap 清单。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合（两个 Worker 根）把加载器交给运行时。**C11**：各模块 public 不变。**C12**：RFC-541 用例覆盖。**C13**：计数不升，模块级可变单例
  51 → 50。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第九步（维护 Worker 的效果模块登记，1 条）。
- **留下**：其余 50 条（可迁移的登记与绑定 14 条；凭据 / 访问 / 完整性相邻的 9 条；进程级缓存与计数器 27 条须经用户确认是否保留并修订
  §14 口径）。
