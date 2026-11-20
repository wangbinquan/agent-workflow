# RFC-522 设计：数字员工与事件中心的适配器回落改为必填注入

## 1. 现状（HEAD，源码实读）

RFC-521 门登记的 5 处（`packages/backend/src/modules/` 下）：

| 文件                                                                                                  | 回落                                                                                                                                                                 | 调用方                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `digital-employee/composition.ts` 的 `composeDigitalEmployeeFromPersistence`                          | `options.inputArtifacts ?? createEmployeeInputArtifactStore(<appHome>/artifacts/employee-inputs)`；`options.programArtifacts ?? createProgramArtifactStore(appHome)` | 只有同文件的 `composeDigitalEmployee`                                                                                                     |
| `digital-employee/composition.ts` 的 `composeDigitalEmployee`                                         | `options.writerCutover ?? composeDigitalEmployeeWriterCutoverFor(db, options.writerInstallation)`                                                                    | daemon 的 `bootstrap/daemonModules/digitalEmployee.ts`（三项都传）；用例 13 个文件约 20 处调用，多数一项都不传                            |
| `event-center/composition.ts` 的 `composeEventCenterWithPorts`                                        | `options.observer ?? createUnavailableEventObserverProgram()`                                                                                                        | 只有同文件的 `composeEventCenter`                                                                                                         |
| `event-center/composition/localCustomObserverProgram.ts` 的 `selectLocalCustomObserverProgramFactory` | `selected === undefined ? createLocalCustomObserverProgramFactory() : selected`                                                                                      | `composeEventCenter`（`options.customObserverPrograms`）与 `infrastructure/customEventObserverProgram.ts`；组合根转出它，两个用例直接调用 |

- daemon 侧都已显式给出：部署选择的 `customObserverPrograms` 必填（standalone 给本机工厂，crewstation 给托管工
  厂），`bootstrap/daemonModules/integration.ts` 把它与开发员工的观察者传给
  `composeEventCenter`；`bootstrap/daemonModules/digitalEmployee.ts` 传入输入工件库、程序工件库与按安装端口装好的写入切换。回落只服务于用
  例：`composeEventCenter` 有 17 个用例文件调用（含 `tests/helpers/eventCenter.ts`），只有 2 个传了 `customObserverPrograms`、1 个传了
  `observer`。
- `ComposeDigitalEmployeeOptions.writerInstallation` 只在写入切换的回落里用到；daemon 自己用安装端口装写入切换，不传这个选项。
- `infrastructure/customEventObserverProgram.ts` 是 RFC-370 的兼容入口（生产代码不取用，`rfc376-structural-guards` 记为“只为契约用例保留”的
  文件）；它取本模块组合层的 `composeCustomEventObserverProgram`（只是转调 application 的同名函数）与
  `selectLocalCustomObserverProgramFactory`。

## 2. 机制与落位

### D1 数字员工

- `ComposeDigitalEmployeeOptions` 的 `inputArtifacts`、`programArtifacts` 与 `writerCutover` 改为必填，删去三处回落与 `writerInstallation`
  选项；`composeDigitalEmployeeFromPersistence` 直接用传入的对象。daemon 的调用不变。

### D2 事件中心

- `ComposeEventCenterOptions` 的 `observer` 与 `customObserverPrograms` 改为必填；`composeEventCenterWithPorts` 直接用
  `options.observer`，`composeEventCenter` 直接传 `options.customObserverPrograms`（`ComposeEventCenterWithPortsOptions` 不再需要单独把它改
  成必填）。
- 删除 `selectLocalCustomObserverProgramFactory`（组合根随之不再转出它；`createLocalCustomObserverProgramFactory` 照旧转出）。
- 兼容入口 `createCustomEventObserverProgram`（infrastructure）的 `programs` 改为必填，改调 application 的
  `createCustomEventObserverProgram`，不再取组合层。

### D3 用例

- `tests/helpers/eventCenter.ts` 新增 `standaloneEventCenterSelections()`：`observer` 是
  `createUnavailableEventObserverProgram()`、`customObserverPrograms` 是 `createLocalCustomObserverProgramFactory()`，正是此前缺省时造的两个
  对象；没给这两项的用例调用改为展开它。
- 新增 `tests/helpers/digitalEmployeeSelections.ts` 的 `standaloneDigitalEmployeeSelections({ db, appHome })`：此前缺省时的三个对象（同一组
  工厂与参数）；没给全的用例调用改为展开它，已给的照旧。
- 直接测 `selectLocalCustomObserverProgramFactory` 的两处改为直接用本机工厂（“没给就选本机”已不存在；“给了就原样用”由必填选项本身保证）。

### D4 门与后继

- RFC-521 门删去这 5 条登记，`ADAPTER_FALLBACKS` 83 → 78，`SUCCESSORS` 删去 digital-employee 与 event-center。
- 余下各步按改动面从小到大重排：第三步 intent、code-capability、memory（11）；第四步 system-operations、development-automation（16）；第五步
  resource-catalog（16）；第六步 task-execution（16）；第七步 source-control（19）。source-control 放最后：它的 `select*` 助手接在
  task-execution 的运行选项上，`repositoryCommit.ts` 的本机 git 分支连着路径绑定，宜在 task-execution 一步之后。门里的后继标签随之改。

## 3. 清单（退出门）

- 上表 5 处回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 78 条，`SUCCESSORS` 不含 digital-employee 与 event-center。
- `ComposeDigitalEmployeeOptions` 的 `inputArtifacts` / `programArtifacts` / `writerCutover` 与 `ComposeEventCenterOptions` 的
  `observer` / `customObserverPrograms` 是必填属性；`writerInstallation` 选项与 `selectLocalCustomObserverProgramFactory` 在生产代码里没有声
  明。
- `event-center/infrastructure/` 不取本模块的组合文件。

## 4. 用例

- RFC-521 门（登记表与总数随 D4 改）锁住回落不再出现。
- 新增 `packages/backend/tests/rfc522-employee-and-event-center-required-selections-boundary.test.ts`，登记 guard-manifest：① 两个选项接口里
  这 5 个属性存在且不带 `?`（语法树），`writerInstallation` 不在 `ComposeDigitalEmployeeOptions` 里；② 全部生产文件（下限 3,000）里没有
  `selectLocalCustomObserverProgramFactory` 的声明，`event-center/infrastructure/` 的 import 不指向组合层；③ 两个测试助手给出的对象与此前缺
  省时一致（数字员工的输入工件库落在 `<appHome>/artifacts/employee-inputs`，事件中心的观察者拒绝运行、自定义观察者工厂是本机实现）；带负对
  照。
- 既有用例照旧覆盖行为：数字员工的编写、运行与内容用例，事件中心的观察、投递与自定义观察者用例（经测试助手给出同样的单机选择）。

## 5. 失败模式

- **用例漏给**：选项必填后 `tsc` 直接报错，不会在运行期才缺。
- **行为走样**：测试助手构造的对象与此前缺省时的工厂调用逐个相同（同一工厂、同一参数）；daemon 侧不改。
- **按原文钉住的锁**：按被删的名字与回落原文全仓搜用例（`grep -l` 列出全部命中文件逐个看，不截断），已列入 D3；集中验证再按名字扫一遍。

## 6. 取舍（可推翻）

1. **单机选择放测试助手，不新增生产导出**：daemon 的 standalone 部署早已显式构造这些对象；新增“本机选择”生产导出只会多一个只给用例用的入口。
2. **`observer` 必填、用例显式给空实现**：空实现让没接观察者的装配在运行期拒绝；必填后由调用方明说，daemon 照旧给开发员工的观察者。
3. **兼容入口改调 application**：它本来只是转调；改后不再取组合层，契约用例照旧。
4. **后继按改动面重排**：先做小的、链路已查清的模块，把与 task-execution 运行选项相连的 source-control 放到最后。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层不再替调用方造适配器；单机默认值只在 standalone 部署（与测试助手）里。
- **C11**：event-center 组合根少转出一个助手；public 不变。
- **C12**：RFC-522 用例读全部生产文件；RFC-521 门覆盖全部模块的组合层。
- **C13**：计数不升；适配器回落 83 → 78。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 1 项第二步：digital-employee 与 event-center 的适配器回落清零。
- **留下**：78 处适配器回落，按 D4 的次序由五步后继清偿；S12 的第 3～6 项另立后继。
