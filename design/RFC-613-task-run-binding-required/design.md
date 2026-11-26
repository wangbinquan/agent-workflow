# RFC-613 技术设计

记号：`S/` = `packages/backend/src/`，`TE/` = `S/modules/task-execution/`，`T/` = `packages/backend/tests/`。数字取 HEAD `1d4faeac5`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：
  - 合同与桥接留在 `TE/composition/localTaskRunSelection.ts`。
  - 旧直绑迁为 `T/helpers/legacyTaskRunDriveBinding.ts`。
- **裁定一：驱动绑定是 provider 运行期的必填入参**。两种部署的 bootstrap 都给；没有生产调用方给四个工厂。联合类型改为只含绑定的接口，选择分支删去。
  函数名 `bindProviderTaskRunParticipantsInput` 保留：RFC-388 与 RFC-321 的锁按名字钉着唯一组合根的这处调用。
- **裁定二：桥接导出、不复制**。旧直绑与单机选择用的是同一段桥接（配置引用、内容接收者的映射）。把它导出为 `createLocalTaskRunConfigurationBridge`，
  测试助手取用，不在用例侧再写一份会漂的副本。
- **裁定三：接收者语义随旧直绑退出生产**。旧分支把 provider 运行期的入参当作工厂的 `this`；这是旧直绑为夹具留的兼容，没有夹具读它（全仓只有
  `rfc370-workspace-exclude-selected` 的一条用例断言过）。助手里工厂以助手的入参为接收者；那条用例改为验证每次驱动的工厂调用顺序与内容归属。
- **偏离项**：无。

## 1. 改动

| 位置                                             | 改动                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `TE/composition/localTaskRunSelection.ts`        | `ProviderTaskRunBindingSelection` 改为必填绑定的接口；新增 `LocalTaskRunFamilyFactories`；桥接导出；删去旧直绑与选择分支 |
| `T/helpers/legacyTaskRunDriveBinding.ts`         | 新增：`LegacyTaskRunComposition` 与 `composeLegacyTaskRunDriveBinding`（自生产迁来，改用导出的桥接）                     |
| `T/helpers/eachProviderTaskExecution.ts`         | 旧直绑一支改为交 `taskRunBinding: composeLegacyTaskRunDriveBinding({...})`                                               |
| `T/helpers/taskExecutionTestTopology.ts` 等 3 处 | 改从测试助手取旧直绑                                                                                                     |
| `T/rfc370-workspace-exclude-selected.test.ts`    | 接收者用例改写（裁定三）                                                                                                 |
| `T/rfc370-port-artifact-bindings.test.ts`        | 逐次驱动的 archive 归属那行文本锁改读测试助手                                                                            |
| `T/rfc510-…-boundary.test.ts`                    | 这个文件的导出与控制流形状随之改                                                                                         |
| `architecture/counts.json`                       | `composition-control-flow-task-execution` 10 → 9                                                                         |

## 2. 用例

- 新增 `T/rfc613-task-run-binding-required-boundary.test.ts`，登记 guard-manifest：
  1. **合同**：`taskRunBinding` 必填（编译期断言）；`ProviderTaskRunBindingSelection` 是接口不是联合；这个文件没有控制流，也没有旧直绑的名字。
  2. **迁出**：`src/` 里没有 `composeLegacyTaskRunDriveBinding`、`LegacyTaskRunComposition`、`nodeRunPromptsFor`、`portArtifactsFor`（语料下限 3,000）。
  3. **行为**：给了完整绑定时原样交回入参；绑定不完整时报 `Task provider requires a complete run binding`。
  4. **负对照**：判据认得出伪造组合文件里的分支与旧名字。
- 原用例经测试助手照旧覆盖：`rfc370-task-run-root-selection`、`rfc370-workspace-exclude-selected`、`rfc359-w8-runtime-participants-conformance`、
  经 `eachProviderTaskExecution` / `taskExecutionTestTopology` 驱动任务的用例。

## 3. 失败模式

- **有人把绑定改回可选、加回选择分支**：`tsc`（编译期断言）、RFC-613 用例与结构门（计数超过 max）红。
- **有人把旧直绑放回 `src/`**：RFC-613 用例 ② 红。

## 4. 对 RFC-294 刷新后规则的对账

- **S12 第 1 项**：生产代码不为用例留默认分支。**C12**：RFC-613 用例跑函数、读源码、扫全部生产文件。**C13**：计数降、不升。
